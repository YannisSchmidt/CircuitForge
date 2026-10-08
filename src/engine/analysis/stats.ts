/**
 * Per-component and per-circuit statistics, computed from what was *measured*.
 *
 * The rule of this module: a number is reported only when something computed it,
 * and every number says where it came from. A statistic that would require a
 * model the engine does not have (a die area, a price, a failure rate) is not
 * invented — the field simply does not exist, or is `null` with the reason.
 *
 * Sources
 *   - structure      the flat netlist (instances, elements, nets, hierarchy);
 *   - logic          the level-0 graph (gates, registers, levels, fan-out);
 *   - timing         the static timing analysis (arrival times per net);
 *   - electrical     a solved `CircuitSimulator` (per-element power);
 *   - thermal        the level-3 network of that netlist (junction temperatures).
 *
 * `power` / `temperature` are `null` unless a solved simulator is passed: a
 * circuit that was never solved has no power, and reporting 0 W would be a lie.
 */

import { KIND_NAME, Kind } from '../core/kinds.js';
import { NODE_STRIDE, elementThermalNode } from '../sim/paramslots.js';
import { nodeNameAt, type FlatInstance, type FlatNetlist } from '../sim/netlist.js';
import { buildLogicGraph, logicSummary, type LogicElement, type LogicGraph } from './logic.js';
import type { TimingReport } from './timing.js';
import type { CircuitSimulator } from '../sim/solver.js';

export interface ElementKindCount {
  kind: number;
  name: string;
  count: number;
}

export interface InstanceStats {
  index: number;
  id: number;
  ref: string;
  path: string;
  specId: string;
  chipRef?: string;
  depth: number;
  bits: number;
  /** Physical elements this instance produced (a vector instance produces `bits`). */
  elements: number;
  elementKinds: ElementKindCount[];
  /** Elements of the logic graph that belong to this instance. */
  logicElements: number;
  /** Output terminals (per lane) that drive at least one consumer. */
  drivenOutputs: number;
  /** Input terminals (per lane) with no driver at all. */
  floatingInputs: number;
  /** Total number of consumers of this instance's outputs (logic fan-out). */
  fanout: number;
  /** Worst signal arrival time at any of its outputs (s), or null if not on a logic path. */
  worstArrival: number | null;
  /** Dissipated power (W), or null when the netlist was not solved. */
  power: number | null;
  /** Highest device temperature (degC), or null when there is no thermal network. */
  temperature: number | null;
  /**
   * True when the component cannot affect anything: no output of its logic
   * elements reaches a consumer or a port (digital), or every net it touches is
   * touched by no other component (analogue — no current can flow).
   */
  unused: boolean;
  /** True when the component only touches private nets (analogue isolation). */
  isolated: boolean;
}

export interface SpecStats {
  specId: string;
  name: string;
  category: string;
  /** Number of instances (physical components after vector expansion). */
  instances: number;
  /** Number of instances that produce no observable effect. */
  unusedInstances: number;
  elements: number;
  elementKinds: ElementKindCount[];
  worstArrival: number | null;
  totalPower: number | null;
  maxTemperature: number | null;
  hierarchyDepths: number[];
  /** Worst propagation delay declared by one element of this type (s), if digital. */
  declaredDelay: number | null;
}

export interface FanoutBucket {
  /** Bucket lower bound (inclusive); the last bucket is open-ended. */
  from: number;
  to: number | null;
  nets: number;
}

export interface CircuitStats {
  name: string;
  fingerprint: string;
  // --- structure ----------------------------------------------------------
  instances: number;
  distinctSpecs: number;
  specIds: string[];
  /** Deepest instance nesting (1 = only top-level components). */
  hierarchyDepth: number;
  nets: number;
  ports: number;
  elements: number;
  branches: number;
  models: number;
  /** Transistors synthesised by gate expansion (0 when gates stay behavioural). */
  expandedTransistors: number;
  elementKinds: ElementKindCount[];
  // --- logic (level 0) ----------------------------------------------------
  logic: {
    gates: number;
    sequential: number;
    levels: number;
    loops: number;
    ignored: number;
    summary: string;
  } | null;
  fanout: {
    /** Maximum number of consumers of one net (logic view). */
    max: number;
    average: number;
    /**
     * Driven nets that no element reads and no port observes. A net that only
     * ends in an output port is *used* (it is the result of the circuit), so port
     * nets are excluded — otherwise every output of every circuit would be
     * reported as dangling.
     */
    dangling: number;
    histogram: FanoutBucket[];
  } | null;
  // --- timing -------------------------------------------------------------
  timing: {
    /** Worst arrival time over all nets (s), null when nothing was analysed. */
    worstArrival: number | null;
    worstNet: string | null;
    criticalPathDelay: number | null;
    clockPeriod: number | null;
    maxFrequency: number | null;
    combinationalDelay: number | null;
    idealStages: number;
  } | null;
  // --- electrical / thermal ----------------------------------------------
  electrical: {
    /**
     * Net power over every element (W), null when not solved: it is ~0 for a
     * circuit that conserves energy (a source reports negative absorbed power),
     * so it is a conservation check, not a consumption figure.
     */
    totalPower: number | null;
    /** Gross dissipation (Σ max(P,0), W) — what the circuit actually burns. */
    totalDissipated: number | null;
    /** Gross supply (Σ max(−P,0), W) — what the sources deliver. */
    totalSupplied: number | null;
    /** Number of elements that dissipated more than 1 nW. */
    dissipatingElements: number | null;
    analogElements: number;
    /** Elements whose kind has no electrical model (digital-only netlist). */
    digitalElements: number;
  };
  thermal: {
    nodes: number;
    maxTemperature: number | null;
    ambient: number;
  } | null;
  /** Wall-clock cost of producing these statistics. */
  ms: number;
  notes: string[];
}

export interface StatsOptions {
  /** Logic graph to reuse (built when omitted and the netlist has digital elements). */
  graph?: LogicGraph | null;
  /** Timing report to reuse. */
  timing?: TimingReport | null;
  /** Solved simulator: the only source of power and temperature. */
  sim?: CircuitSimulator | null;
  /** Skip building the logic graph (structure only). */
  skipLogic?: boolean;
  /** Reuse a previously computed instance table (avoid a second pass). */
  instances?: InstanceStats[];
}

const NS = 1e9;
const HISTOGRAM_EDGES = [0, 1, 2, 4, 8, 16, 64];

/** Kinds the level-0 engine understands (mirrors `logic.ts`). */
const DIGITAL_KINDS = new Set<number>([
  Kind.LogicGate,
  Kind.LogicBuf,
  Kind.TriState,
  Kind.DFlipFlop,
  Kind.DLatch,
  Kind.Mux,
  Kind.Demux,
]);

function kindName(kind: number): string {
  return KIND_NAME[kind] ?? `KIND_${kind}`;
}

/**
 * Fan-out per net in the logic graph: how many element input terminals read it.
 * Buses count one per lane, which is what the level-0 engine evaluates.
 */
function logicFanout(graph: LogicGraph): Int32Array {
  const fanout = new Int32Array(graph.netCount);
  for (const el of graph.elements) {
    for (const n of el.inputs) if (n >= 0 && n < fanout.length) fanout[n]++;
    if (el.enable >= 0 && el.enable < fanout.length) fanout[el.enable]++;
    if (el.clk >= 0 && el.clk < fanout.length) fanout[el.clk]++;
    if (el.rst >= 0 && el.rst < fanout.length) fanout[el.rst]++;
    for (const s of el.selects) if (s >= 0 && s < fanout.length) fanout[s]++;
  }
  return fanout;
}

/** Worst arrival over rise and fall, per net; `null` where no time was computed. */
function worstArrivalPerNet(timing: TimingReport | null | undefined): Float64Array | null {
  if (!timing) return null;
  const n = timing.arrivalRise.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = timing.arrivalRise[i];
    const f = timing.arrivalFall[i];
    const a = Number.isFinite(r) ? r : -Infinity;
    const b = Number.isFinite(f) ? f : -Infinity;
    out[i] = Math.max(a, b);
  }
  return out;
}

/**
 * Per-instance statistics. The map from elements to instances comes from the
 * netlist's own provenance (`instIndex`), never from name matching.
 */
export function instanceStats(nl: FlatNetlist, opts: StatsOptions = {}): InstanceStats[] {
  const graph = opts.graph === undefined ? (opts.skipLogic ? null : buildGraphIfDigital(nl)) : opts.graph;
  const arrival = worstArrivalPerNet(opts.timing ?? null);
  const sim = opts.sim ?? null;
  const power = sim ? sim.powers() : null;
  const thermal = sim && nl.thermalNodeCount > 0 ? nl.thermalTemperature : null;

  // --- elements per instance ------------------------------------------------
  const elementCount = new Int32Array(nl.instances.length);
  const perKind = new Map<number, Map<number, number>>();
  for (let e = 0; e < nl.elementCount; e++) {
    const inst = nl.instIndex[e];
    if (inst < 0 || inst >= nl.instances.length) continue;
    elementCount[inst]++;
    let kinds = perKind.get(inst);
    if (!kinds) {
      kinds = new Map();
      perKind.set(inst, kinds);
    }
    const k = nl.kind[e];
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }

  // --- logic elements per instance, and per-net fan-out ---------------------
  const logicPerInstance = new Int32Array(nl.instances.length);
  const fanoutOf = graph ? logicFanout(graph) : null;
  if (graph) {
    for (const el of graph.elements) {
      if (el.instance >= 0 && el.instance < logicPerInstance.length) logicPerInstance[el.instance]++;
    }
  }

  // --- per-instance arrival, fan-out, floating inputs -----------------------
  const worst = new Float64Array(nl.instances.length).fill(-Infinity);
  const instanceFanout = new Int32Array(nl.instances.length);
  const floating = new Int32Array(nl.instances.length);
  const drivenOutputs = new Int32Array(nl.instances.length);
  const deadInstances = new Uint8Array(nl.instances.length).fill(1);

  if (graph && arrival) {
    for (const el of graph.elements) {
      const inst = el.instance;
      if (inst < 0 || inst >= nl.instances.length) continue;
      for (const out of el.outputs) {
        if (!Number.isFinite(arrival[out])) continue;
        if (arrival[out] > worst[inst]) worst[inst] = arrival[out];
      }
      for (const out of el.outputs) {
        const f = fanoutOf ? fanoutOf[out] : 0;
        instanceFanout[inst] += f;
        if (f > 0) deadInstances[inst] = 0;
        if (f > 0) drivenOutputs[inst]++;
      }
      for (const inp of el.inputs) {
        if (graph.driverCount[inp] === 0) floating[inst]++;
      }
    }
  }

  // A port of the root circuit is an observer: an instance driving one is used.
  const rootPortNets = new Set<number>(nl.ports.map((p) => p.node));
  if (graph) {
    for (const el of graph.elements) {
      for (const out of el.outputs) {
        if (rootPortNets.has(out) && el.instance >= 0 && el.instance < nl.instances.length) {
          deadInstances[el.instance] = 0;
        }
      }
    }
  }

  // --- analogue isolation: a component whose every terminal is on a net that
  // --- no other component touches can never carry current.
  const netOwner = new Map<number, number>();
  const isolated = new Uint8Array(nl.instances.length);
  for (let e = 0; e < nl.elementCount; e++) {
    const inst = nl.instIndex[e];
    const count = nl.nodeCountPerElement[e];
    for (let k = 0; k < count; k++) {
      const node = nl.nodes[e * NODE_STRIDE + k];
      if (node <= 0) continue;
      const owner = netOwner.get(node);
      if (owner === undefined) netOwner.set(node, inst);
      else if (owner !== inst) {
        isolated[owner] = 1; // shared with somebody: not isolated
        isolated[inst] = 1;
      }
    }
  }

  const out: InstanceStats[] = nl.instances.map((inst: FlatInstance, i): InstanceStats => {
    const kinds = perKind.get(i);
    const elementKinds: ElementKindCount[] = kinds
      ? [...kinds.entries()].map(([kind, count]) => ({ kind, name: kindName(kind), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      : [];
    let p: number | null = null;
    if (power) {
      p = 0;
      for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) p += power[e];
    }
    let t: number | null = null;
    if (thermal) {
      let hottest = -Infinity;
      for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) {
        const th = elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params);
        if (th >= 0 && th < thermal.length) hottest = Math.max(hottest, thermal[th]);
      }
      t = hottest === -Infinity ? (nl.ambient ?? 25) : hottest - 273.15;
    }
    return {
      index: i,
      id: inst.id,
      ref: inst.ref,
      path: inst.path,
      specId: inst.specId,
      chipRef: inst.chipRef,
      depth: inst.depth,
      bits: inst.bits,
      elements: elementCount[i],
      elementKinds,
      logicElements: logicPerInstance[i],
      drivenOutputs: drivenOutputs[i],
      floatingInputs: floating[i],
      fanout: instanceFanout[i],
      worstArrival: Number.isFinite(worst[i]) ? worst[i] : null,
      power: p,
      temperature: t,
      isolated: isolated[i] === 0 && elementCount[i] > 0,
      unused: (graph !== null && logicPerInstance[i] > 0 && deadInstances[i] === 1) || (isolated[i] === 0 && elementCount[i] > 0),
    };
  });
  return out;
}

/** Aggregate the instance table by component type. */
export function specStats(instances: InstanceStats[], lib?: { get(id: string): { name: string; category: string } | undefined }): SpecStats[] {
  const bySpec = new Map<string, SpecStats>();
  for (const inst of instances) {
    let agg = bySpec.get(inst.specId);
    if (!agg) {
      const spec = lib?.get(inst.specId);
      agg = {
        specId: inst.specId,
        name: spec?.name ?? inst.specId,
        category: spec?.category ?? 'unknown',
        instances: 0,
        unusedInstances: 0,
        elements: 0,
        elementKinds: [],
        worstArrival: null,
        totalPower: null,
        maxTemperature: null,
        hierarchyDepths: [],
        declaredDelay: null,
      };
      bySpec.set(inst.specId, agg);
    }
    agg.instances++;
    if (inst.unused) agg.unusedInstances++;
    agg.elements += inst.elements;
    if (inst.worstArrival !== null) {
      agg.worstArrival = agg.worstArrival === null ? inst.worstArrival : Math.max(agg.worstArrival, inst.worstArrival);
    }
    if (inst.power !== null) agg.totalPower = (agg.totalPower ?? 0) + inst.power;
    if (inst.temperature !== null) {
      agg.maxTemperature = agg.maxTemperature === null ? inst.temperature : Math.max(agg.maxTemperature, inst.temperature);
    }
    if (!agg.hierarchyDepths.includes(inst.depth)) agg.hierarchyDepths.push(inst.depth);
    for (const k of inst.elementKinds) {
      const existing = agg.elementKinds.find((x) => x.kind === k.kind);
      if (existing) existing.count += k.count;
      else agg.elementKinds.push({ ...k });
    }
  }
  for (const agg of bySpec.values()) {
    agg.hierarchyDepths.sort((a, b) => a - b);
    agg.elementKinds.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  return [...bySpec.values()].sort((a, b) => b.instances - a.instances || a.specId.localeCompare(b.specId));
}

/**
 * Level-0 graph of a netlist, or null when the netlist has no digital element.
 * Building it is cheap (one pass) and it is what makes fan-out, levels and
 * arrival times available to the statistics.
 */
function buildGraphIfDigital(nl: FlatNetlist): LogicGraph | null {
  for (let e = 0; e < nl.elementCount; e++) if (DIGITAL_KINDS.has(nl.kind[e])) return buildLogicGraph(nl);
  return null;
}

export interface CircuitStatsResult {
  stats: CircuitStats;
  instances: InstanceStats[];
  specs: SpecStats[];
  graph: LogicGraph | null;
}

/** Whole-circuit statistics. See the module header for what each field means. */
export function circuitStats(
  nl: FlatNetlist,
  opts: StatsOptions & { lib?: { get(id: string): { name: string; category: string } | undefined } } = {},
): CircuitStatsResult {
  const t0 = Date.now();
  const notes: string[] = [];
  const graph = opts.graph === undefined ? (opts.skipLogic ? null : buildGraphIfDigital(nl)) : opts.graph;
  const instances = opts.instances ?? instanceStats(nl, { ...opts, graph });
  const specs = specStats(instances, opts.lib);

  // --- elements by kind -----------------------------------------------------
  const kindMap = new Map<number, number>();
  let analogElements = 0;
  let digitalElements = 0;
  for (let e = 0; e < nl.elementCount; e++) {
    const k = nl.kind[e];
    kindMap.set(k, (kindMap.get(k) ?? 0) + 1);
    if (DIGITAL_KINDS.has(k)) digitalElements++;
    else if (k !== Kind.Ground && k !== Kind.Port) analogElements++;
  }
  const elementKinds: ElementKindCount[] = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, name: kindName(kind), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // --- hierarchy depth ------------------------------------------------------
  let hierarchyDepth = 0;
  for (const inst of nl.instances) hierarchyDepth = Math.max(hierarchyDepth, inst.depth);

  // --- logic ----------------------------------------------------------------
  let logic: CircuitStats['logic'] = null;
  let fanout: CircuitStats['fanout'] = null;
  if (graph && graph.elements.length > 0) {
    logic = {
      gates: graph.stats.gates,
      sequential: graph.stats.sequential,
      levels: graph.stats.levels,
      loops: graph.stats.loops,
      ignored: graph.stats.ignoredElements,
      summary: logicSummary(graph),
    };
    const fo = logicFanout(graph);
    let max = 0;
    let total = 0;
    let usedNets = 0;
    let dangling = 0;
    const histogram: FanoutBucket[] = [];
    for (let i = 0; i < HISTOGRAM_EDGES.length; i++) {
      histogram.push({ from: HISTOGRAM_EDGES[i], to: i + 1 < HISTOGRAM_EDGES.length ? HISTOGRAM_EDGES[i + 1] - 1 : null, nets: 0 });
    }
    // Nets a port observes are uses of the net, exactly as an element input is.
    const portNets = new Uint8Array(fo.length);
    for (const p of nl.ports) if (p.node > 0 && p.node < portNets.length) portNets[p.node] = 1;
    for (let n = 0; n < fo.length; n++) {
      const f = fo[n];
      if (graph.driverCount[n] === 0) continue; // undriven nets are not a fan-out
      usedNets++;
      total += f;
      if (f > max) max = f;
      if (f === 0 && !portNets[n]) dangling++;
      for (let b = histogram.length - 1; b >= 0; b--) {
        if (f >= histogram[b].from) {
          histogram[b].nets++;
          break;
        }
      }
    }
    fanout = { max, average: usedNets ? total / usedNets : 0, dangling, histogram };
  }

  // --- timing ---------------------------------------------------------------
  let timing: CircuitStats['timing'] = null;
  const arrival = worstArrivalPerNet(opts.timing ?? null);
  if (opts.timing) {
    let worstArrival: number | null = null;
    let worstNet: string | null = null;
    for (let n = 0; n < arrival!.length; n++) {
      if (!Number.isFinite(arrival![n])) continue;
      if (worstArrival === null || arrival![n] > worstArrival) {
        worstArrival = arrival![n];
        worstNet = nodeNameAt(nl, n);
      }
    }
    timing = {
      worstArrival,
      worstNet,
      criticalPathDelay: opts.timing.criticalPath ? opts.timing.criticalPath.delay : null,
      clockPeriod: opts.timing.clockPeriod,
      maxFrequency: opts.timing.maxFrequency,
      combinationalDelay: opts.timing.combinationalDelay,
      idealStages: opts.timing.criticalPath ? opts.timing.criticalPath.idealStages : 0,
    };
  }

  // --- electrical / thermal -------------------------------------------------
  const sim = opts.sim ?? null;
  let totalPower: number | null = null;
  let totalDissipated: number | null = null;
  let totalSupplied: number | null = null;
  let dissipatingElements: number | null = null;
  if (sim) {
    const p = sim.powers();
    totalPower = 0;
    totalDissipated = 0;
    totalSupplied = 0;
    dissipatingElements = 0;
    for (let e = 0; e < nl.elementCount; e++) {
      const v = p[e];
      if (Number.isFinite(v)) {
        totalPower += v;
        if (v > 0) totalDissipated += v;
        else totalSupplied -= v;
        if (v > 1e-9) dissipatingElements++;
      }
    }
    // A solved operating point must close: what the sources deliver is what the
    // modelled loads absorb. When it does not, say so instead of presenting a
    // total as if it were measured: logic output stages have no modelled supply,
    // and a floating node is solved on the *voltage* tolerance, so its leakage
    // current (and every power computed from it) is not converged.
    const imbalance = totalSupplied - totalDissipated;
    const scale = Math.max(totalSupplied, totalDissipated, 1e-12);
    if (scale > 1e-12 && Math.abs(imbalance) / scale > 1e-2) {
      notes.push(
        `power balance: sources deliver ${fmtW(totalSupplied)} but ${fmtW(totalDissipated)} is absorbed by modelled loads ` +
          `(${((imbalance / scale) * 100).toFixed(1)} % mismatch). Per-element values are measured; the total is not a closed budget.`,
      );
    }
  } else {
    notes.push('power is not reported: no solved simulator was supplied (pass `sim` to measure it)');
  }
  const thermal = nl.thermalNodeCount > 0
    ? {
        nodes: nl.thermalNodeCount,
        maxTemperature: sim ? sim.maxTemperature() : null,
        ambient: nl.ambient ?? 25,
      }
    : null;
  if (nl.thermalNodeCount > 0 && !sim) notes.push('temperature is not reported: the thermal network was not solved');

  const stats: CircuitStats = {
    name: nl.name,
    fingerprint: nl.fingerprint,
    instances: nl.instances.length,
    distinctSpecs: specs.length,
    specIds: specs.map((s) => s.specId),
    hierarchyDepth,
    nets: nl.nodeCount,
    ports: nl.ports.length,
    elements: nl.elementCount,
    branches: nl.branchCount,
    models: nl.modelCount,
    expandedTransistors: nl.expandedTransistors,
    elementKinds,
    logic,
    fanout,
    timing,
    electrical: { totalPower, totalDissipated, totalSupplied, dissipatingElements, analogElements, digitalElements },
    thermal,
    ms: Date.now() - t0,
    notes,
  };
  return { stats, instances, specs, graph };
}

/** The worst arrival time of an element's outputs, in seconds (null if unknown). */
export function elementArrival(el: LogicElement, timing: TimingReport | null): number | null {
  if (!timing) return null;
  let worst = -Infinity;
  for (const out of el.outputs) {
    worst = Math.max(worst, timing.arrivalRise[out] ?? -Infinity, timing.arrivalFall[out] ?? -Infinity);
  }
  return Number.isFinite(worst) ? worst : null;
}

/** Format a duration for a report: ns with 3 decimals (the ns is the natural unit). */
export function fmtNs(seconds: number | null): string {
  if (seconds === null) return 'n/a';
  const ns = seconds * NS;
  // Pick the unit that keeps the number readable; the unit is always printed, so
  // a value can never be read in the wrong scale.
  if (Math.abs(seconds) >= 1) return `${ns.toExponential(3)} ns`;
  if (Math.abs(seconds) >= 1e-3) return `${(seconds * 1e3).toFixed(4)} ms`;
  if (Math.abs(seconds) >= 1e-6) return `${(seconds * 1e6).toFixed(4)} µs`;
  if (Math.abs(ns) >= 1) return `${ns.toFixed(3)} ns`;
  return `${ns.toFixed(4)} ns`;
}

/** Compact watt formatting for notes (the analyzer has its own display helper). */
function fmtW(w: number): string {
  const a = Math.abs(w);
  if (a === 0) return '0 W';
  if (a >= 1) return `${w.toFixed(3)} W`;
  if (a >= 1e-3) return `${(w * 1e3).toFixed(3)} mW`;
  if (a >= 1e-6) return `${(w * 1e6).toFixed(3)} uW`;
  if (a >= 1e-9) return `${(w * 1e9).toFixed(3)} nW`;
  return `${w.toExponential(3)} W`;
}
