/**
 * Circuit analyzer: what is wrong, what is wasteful and what is risky — with the
 * measurement that justifies every statement.
 *
 * Design rules of this module (they are the point of the whole project):
 *
 *   1. Every finding carries the evidence that produced it: the net, the element
 *      chain, the measured number. No "looks slow", no invented score.
 *   2. A check that cannot be performed honestly is reported as *not run* rather
 *      than passed. `report.constraints` has three states: pass, fail, and
 *      `pass: null` (not measurable, with the reason).
 *   3. Findings never claim more than the analysis did: each one states the scope
 *      of its own check, and the report repeats the global scope in `notes`.
 *
 * Cost: every check is linear in the size of the netlist. The indexes the checks
 * share (fan-out, element→instance, net→instances, DC adjacency) are built once.
 *
 *   CF8001 critical path            CF8011 instability risks
 *   CF8002 clock bound              CF8012 register state / self-hold
 *   CF8003 unused component         CF8013 clock net problem / gated clock
 *   CF8004 dead logic               CF8014 timing constraint violation
 *   CF8005 redundant input          CF8015 slow zones
 *   CF8006 combinational loop       CF8016 hot zones
 *   CF8007 high fan-out             CF8017 power hogs
 *   CF8008 duplicate components     CF8018 constraint violation
 *   CF8009 structural redundancy    CF8019 unused port / silent output
 *   CF8010 floating analogue node   CF8020 digital/analogue level crossing
 */

import { Kind, KIND_NAME } from '../core/kinds.js';
import { Severity, info, warn, error, type Diagnostic } from '../core/labels.js';
import type { ComponentSpec, Library } from '../core/library.js';
import type { Circuit } from '../core/circuit.js';
import type { ChipLibrary } from '../core/chip.js';
import { flatten, nodeNameAt, type FlatInstance, type FlatNetlist } from '../sim/netlist.js';
import { NODE_STRIDE, elementThermalNode } from '../sim/paramslots.js';
import type { CircuitSimulator } from '../sim/solver.js';
import { LOGIC_FN, buildLogicGraph, logicSummary, type LogicElement, type LogicGraph } from './logic.js';
import { analyzeTiming, describePath, type TimingReport } from './timing.js';
import { resolveTimingModel, type DelayTable, type TimingModelSet } from './tech.js';
import { circuitStats, fmtNs, type CircuitStats, type InstanceStats, type SpecStats } from './stats.js';

export type FindingCategory =
  | 'structure'
  | 'connectivity'
  | 'timing'
  | 'power'
  | 'thermal'
  | 'reliability'
  | 'constraints';

export interface FindingSubject {
  type: 'component' | 'net' | 'zone' | 'port' | 'circuit';
  name: string;
  /** Stable id (component id / net id / port name) for a UI to select the object. */
  id?: string | number;
  /** Hierarchy path, when the subject is a component. */
  path?: string;
}

export interface Finding {
  code: string;
  category: FindingCategory;
  severity: Severity;
  /** One line: what was found. */
  title: string;
  /** What was measured, and how. */
  detail: string;
  subject?: FindingSubject;
  /** The numbers behind the finding (measured, or derived from the structure). */
  metrics?: Record<string, number | string>;
  /** The actual chain / list that justifies the finding. */
  evidence?: string[];
  recommendation?: string;
  /** What this check did not look at. */
  scope?: string;
}

export interface Zone {
  path: string;
  name: string;
  specId: string;
  instances: number;
  elements: number;
  worstArrival: number | null;
  power: number | null;
  maxTemperature: number | null;
}

/**
 * Limits the analyzer is asked to check a design against.
 *
 * Named for the layer it belongs to: the optimizer has its own `DesignConstraints`,
 * with different fields and a different job (bounding a search rather than judging a
 * finished circuit), and one name for two different things is how a caller ends up
 * passing the wrong one.
 */
export interface AnalysisConstraints {
  maxInstances?: number;
  maxElements?: number;
  maxHierarchyDepth?: number;
  maxLogicLevels?: number;
  maxFanout?: number;
  /** Longest allowed combinational delay (s). */
  maxDelay?: number;
  /** Required minimum clock frequency (Hz). */
  minFrequency?: number;
  maxPower?: number;
  maxTemperature?: number;
  forbiddenSpecs?: string[];
  requiredPorts?: Array<{ name: string; direction?: string; width?: number }>;
  requireGround?: boolean;
  requireReset?: boolean;
}

export interface ConstraintResult {
  name: string;
  limit: number | string;
  measured: number | string | null;
  unit: string;
  /** true = within the limit, false = violated, null = could not be measured. */
  pass: boolean | null;
  reason?: string;
}

export interface AnalyzeOptions {
  lib?: Library;
  /** Solved simulator: the only source of measured power and temperature. */
  sim?: CircuitSimulator | null;
  timing?: TimingReport | null;
  graph?: LogicGraph | null;
  /**
   * Which delay model the timing analysis uses: `'declared'` (default) uses the
   * delays the models declare; `'illustrative'` uses the documented T1 table;
   * any `DelayTable` or `TimingModelSet` can be passed instead.
   */
  timingModel?: 'declared' | 'illustrative' | DelayTable | TimingModelSet;
  constraints?: AnalysisConstraints;
  /** Fan-out above which a net is reported (default 8). */
  highFanout?: number;
  /** How many zones the slow/hot/power rankings report (default 5). */
  topZones?: number;
  /** Names of checks to skip: 'timing' | 'unused' | 'structure' | 'loops' | … */
  skip?: string[];
}

export interface AnalyzeReport {
  name: string;
  fingerprint: string;
  ms: number;
  findings: Finding[];
  counts: { errors: number; warnings: number; infos: number };
  stats: CircuitStats;
  instances: InstanceStats[];
  specs: SpecStats[];
  timing: {
    criticalPath: {
      delay: number;
      stages: number;
      idealStages: number;
      startNet: string;
      endNet: string;
      startKind: string;
      endKind: string;
      setup: number;
      chain: string[];
    } | null;
    clockPeriod: number | null;
    maxFrequency: number | null;
    combinationalDelay: number | null;
    danglingNets: number;
    idealElements: number;
    /** One-line description of the critical path (from `analysisToText`). */
    description: string | null;
  };
  zones: { slow: Zone[]; hot: Zone[]; power: Zone[] };
  constraints: ConstraintResult[];
  /** Delay model that produced the timing numbers, and what it means. */
  timingModel: { id: string; name: string; description: string };
  summary: string;
  notes: string[];
  diagnostics: Diagnostic[];
}

const DEFAULT_HIGH_FANOUT = 8;
const DEFAULT_TOP_ZONES = 5;
const NS = 1e9;

const DIGITAL_KINDS = new Set<number>([
  Kind.LogicGate,
  Kind.LogicBuf,
  Kind.TriState,
  Kind.DFlipFlop,
  Kind.DLatch,
  Kind.Mux,
  Kind.Demux,
]);

/** Element kinds that conduct at DC, i.e. can tie two nodes to the same potential. */
const DC_PATH_KINDS = new Set<number>([
  Kind.Resistor,
  Kind.Inductor,
  Kind.Potentiometer,
  Kind.Transformer,
  Kind.NtcThermistor,
  Kind.Varistor,
  Kind.Diode,
  Kind.Led,
  Kind.Photodiode,
  Kind.Bjt,
  Kind.Mosfet,
  Kind.Jfet,
  Kind.Relay,
  Kind.VoltageSource,
  Kind.CurrentSource,
  Kind.Vcvs,
  Kind.Vccs,
  Kind.Ccvs,
  Kind.Cccs,
  Kind.NoiseSource,
]);

/** Kinds the electrical level models (used for the level-crossing check). */
const ANALOG_KINDS = new Set<number>([...DC_PATH_KINDS, Kind.Capacitor, Kind.Switch, Kind.PushButton]);

const GATES = new Set<number>([
  LOGIC_FN.BUF,
  LOGIC_FN.NOT,
  LOGIC_FN.AND,
  LOGIC_FN.NAND,
  LOGIC_FN.OR,
  LOGIC_FN.NOR,
  LOGIC_FN.XOR,
  LOGIC_FN.XNOR,
]);

function fnName(fn: number): string {
  switch (fn) {
    case LOGIC_FN.BUF:
      return 'BUFFER';
    case LOGIC_FN.NOT:
      return 'NOT';
    case LOGIC_FN.AND:
      return 'AND';
    case LOGIC_FN.NAND:
      return 'NAND';
    case LOGIC_FN.OR:
      return 'OR';
    case LOGIC_FN.NOR:
      return 'NOR';
    case LOGIC_FN.XOR:
      return 'XOR';
    case LOGIC_FN.XNOR:
      return 'XNOR';
    case LOGIC_FN.TRISTATE:
      return 'TRISTATE';
    case LOGIC_FN.CONST_HIGH:
      return 'CONST 1';
    case LOGIC_FN.CONST_LOW:
      return 'CONST 0';
    default:
      return `FN${fn}`;
  }
}

function elementLabel(el: LogicElement): string {
  if (el.kind === 'dff') return `${el.ref} DFF`;
  if (el.kind === 'latch') return `${el.ref} LATCH`;
  if (el.kind === 'mux') return `${el.ref} MUX${el.channels}`;
  if (el.kind === 'demux') return `${el.ref} ${el.decoder ? 'DECODER' : 'DEMUX'}${el.channels}`;
  if (el.kind === 'tristate') return `${el.ref} TRISTATE`;
  return `${el.ref} ${fnName(el.fn)}${el.inputs.length > 1 ? `/${el.inputs.length}` : ''}`;
}

function kindLabel(kind: number): string {
  return KIND_NAME[kind] ?? `KIND_${kind}`;
}

function formatPower(watts: number): string {
  const abs = Math.abs(watts);
  if (abs >= 1) return `${watts.toFixed(3)} W`;
  if (abs >= 1e-3) return `${(watts * 1e3).toFixed(3)} mW`;
  if (abs >= 1e-6) return `${(watts * 1e6).toFixed(3)} µW`;
  if (abs >= 1e-9) return `${(watts * 1e9).toFixed(3)} nW`;
  if (abs === 0) return '0 W';
  return `${watts.toExponential(3)} W`;
}

// ---------------------------------------------------------------------------
// Shared indexes
// ---------------------------------------------------------------------------

interface Indexes {
  /**
   * Logic consumer terminals per net. Every input-like terminal counts — inputs,
   * enable, clock, reset and select pins — so this array is the same quantity as
   * `CircuitStats.fanout`, and the CF8007 threshold and the reported fan-out can
   * never disagree. A clock net that drives thirty registers therefore *is* a
   * high fan-out net; the finding explains that this is a structural observation,
   * since the engine has no load model to say what it costs.
   */
  fanout: Int32Array;
  /**
   * Nets that at least one element *reads* (any input-like terminal, including
   * clock/reset/select). This is the "is it used at all?" map: a clock port has a
   * fan-out of zero by definition but is obviously used.
   */
  consumed: Uint8Array;
  /** Logic elements grouped by instance index. */
  elementsByInstance: LogicElement[][];
  /** Component instance indices touching each net (all element kinds). */
  netInstances: Map<number, number[]>;
  /** DC adjacency (node → neighbouring nodes through DC-conducting elements). */
  dcAdjacency: Map<number, number[]>;
  /** Cache: instance path → path of its top-level ancestor. */
  zonePathCache: Map<string, string>;
}

function buildIndexes(nl: FlatNetlist, graph: LogicGraph | null): Indexes {
  const fanout = new Int32Array(Math.max(1, nl.nodeCount));
  const consumed = new Uint8Array(Math.max(1, nl.nodeCount));
  const elementsByInstance: LogicElement[][] = Array.from({ length: nl.instances.length }, () => []);
  if (graph) {
    for (const el of graph.elements) {
      if (el.instance >= 0 && el.instance < elementsByInstance.length) elementsByInstance[el.instance].push(el);
      for (const n of el.inputs) if (n > 0 && n < fanout.length) fanout[n]++;
      if (el.enable > 0 && el.enable < fanout.length) fanout[el.enable]++;
      if (el.clk > 0 && el.clk < fanout.length) fanout[el.clk]++;
      if (el.rst > 0 && el.rst < fanout.length) fanout[el.rst]++;
      for (const s of el.selects) if (s > 0 && s < fanout.length) fanout[s]++;
      for (const n of el.inputs) if (n > 0 && n < consumed.length) consumed[n] = 1;
      for (const n of [el.enable, el.clk, el.rst, ...el.selects]) if (n > 0 && n < consumed.length) consumed[n] = 1;
    }
  }

  const netInstances = new Map<number, number[]>();
  const dcAdjacency = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    if (a <= 0 || b <= 0 || a === b) return;
    let la = dcAdjacency.get(a);
    if (!la) {
      la = [];
      dcAdjacency.set(a, la);
    }
    la.push(b);
  };
  for (let e = 0; e < nl.elementCount; e++) {
    const inst = nl.instIndex[e];
    const count = nl.nodeCountPerElement[e];
    const conductive = DC_PATH_KINDS.has(nl.kind[e]);
    const nodes: number[] = [];
    for (let k = 0; k < count; k++) {
      const node = nl.nodes[e * NODE_STRIDE + k];
      if (node <= 0) continue;
      nodes.push(node);
      let list = netInstances.get(node);
      if (!list) {
        list = [];
        netInstances.set(node, list);
      }
      if (!list.includes(inst)) list.push(inst);
    }
    if (conductive) {
      for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) if (i !== j) link(nodes[i], nodes[j]);
    }
  }

  return { fanout, consumed, elementsByInstance, netInstances, dcAdjacency, zonePathCache: new Map() };
}

function netName(nl: FlatNetlist, node: number): string {
  return nodeNameAt(nl, node);
}

interface CheckContext {
  nl: FlatNetlist;
  graph: LogicGraph | null;
  timing: TimingReport | null;
  sim: CircuitSimulator | null;
  stats: CircuitStats;
  instances: InstanceStats[];
  specs: SpecStats[];
  idx: Indexes;
  opts: AnalyzeOptions;
  findings: Finding[];
  zones: Zone[];
  zonesSlow: Zone[];
  zonesHot: Zone[];
  zonesPower: Zone[];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** CF8001 / CF8002 — the critical path and the clock bound, with the chain. */
function checkTiming(ctx: CheckContext): void {
  const { timing, nl } = ctx;
  if (!timing || !ctx.graph || ctx.graph.elements.length === 0) return;
  const path = timing.criticalPath;

  if (path) {
    const chain: string[] = [];
    for (const step of path.steps) {
      const from = netName(nl, step.fromNet);
      const to = netName(nl, step.toNet);
      if (!step.element) {
        chain.push(`start ${from} (${path.startKind})`);
        continue;
      }
      const ideal = step.ideal ? ' [declared 0 ns]' : '';
      chain.push(
        `${elementLabel(step.element)}: ${from} → ${to}  +${(step.delay * NS).toFixed(3)} ns (arrival ${(step.arrival * NS).toFixed(3)} ns, ${step.edge})${ideal}`,
      );
    }
    const scopeBits: string[] = [];
    if (path.idealStages > 0) scopeBits.push(`${path.idealStages}/${path.stages} element(s) declare a zero delay, so the total is a lower bound`);
    if (timing.partialDelays.length > 0) scopeBits.push(`${timing.partialDelays.length} element(s) declare a delay for one edge only`);
    push(ctx, {
      code: 'CF8001',
      category: 'timing',
      severity: Severity.Info,
      title: `Critical path: ${fmtNs(path.delay)} over ${path.stages} stage(s) → ${netName(nl, path.endNet)}`,
      detail:
        `The longest declared-delay chain runs from ${netName(nl, path.startNet)} (${path.startKind}) to ${netName(nl, path.endNet)} (${path.endKind}). ` +
        'Delays are the ones declared by each element (tphl/tplh); there is no wire delay, no load-dependent delay and no slew model.',
      subject: { type: 'net', name: netName(nl, path.endNet), id: path.endNet },
      metrics: {
        delayNs: Number((path.delay * NS).toFixed(4)),
        stages: path.stages,
        idealStages: path.idealStages,
        setupNs: Number((path.setup * NS).toFixed(4)),
      },
      evidence: chain,
      recommendation: path.idealStages > 0 ? 'Some elements declare a zero delay: set tphl/tplh on those models to get a usable number.' : undefined,
      scope: scopeBits.length > 0 ? scopeBits.join('; ') : 'Declared-delay static timing, single corner, no wire or load effects.',
    });
  }

  if (timing.clockPeriod !== null) {
    const regPath = timing.criticalRegisterPath;
    const chain: string[] = [];
    if (regPath) {
      for (const step of regPath.steps) {
        if (!step.element) {
          chain.push(`start ${netName(nl, step.fromNet)} (register clock-to-Q)`);
          continue;
        }
        chain.push(`${elementLabel(step.element)}: → ${netName(nl, step.toNet)}  +${(step.delay * NS).toFixed(3)} ns (arrival ${(step.arrival * NS).toFixed(3)} ns)`);
      }
    }
    push(ctx, {
      code: 'CF8002',
      category: 'timing',
      severity: Severity.Info,
      title: `Clock bound: period ≥ ${fmtNs(timing.clockPeriod)} (≤ ${((timing.maxFrequency ?? 0) / 1e6).toFixed(3)} MHz)`,
      detail:
        'Lower bound of the synchronous clock period, `t_ckq + t_comb.max + t_setup`, taken over every register-to-register path. ' +
        'It is a bound for the *declared* delays only: no clock skew, no clock-tree delay, no jitter, no hold analysis.',
      subject: regPath ? { type: 'net', name: netName(nl, regPath.endNet), id: regPath.endNet } : undefined,
      metrics: {
        clockPeriodNs: Number((timing.clockPeriod * NS).toFixed(4)),
        maxFrequencyMHz: Number(((timing.maxFrequency ?? 0) / 1e6).toFixed(3)),
      },
      evidence: chain,
      scope: 'Setup-only bound. Hold time, clock skew and jitter are not modelled.',
    });
  }
}

/** CF8003 / CF8004 — components and logic that cannot affect anything. */
function checkUnused(ctx: CheckContext): void {
  const { nl, graph, idx } = ctx;
  const unused = ctx.instances.filter((i) => i.unused && i.elements > 0);
  // Grouped by component type: a design that leaves nine buffers unread should
  // get one finding with nine pieces of evidence, not nine findings.
  const bySpec = new Map<string, InstanceStats[]>();
  for (const inst of unused) {
    const list = bySpec.get(inst.specId) ?? [];
    list.push(inst);
    bySpec.set(inst.specId, list);
  }
  for (const [specId, list] of [...bySpec.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const digital = list.filter((i) => i.logicElements > 0);
    const analogue = list.filter((i) => i.logicElements === 0);
    const parts: string[] = [];
    if (digital.length > 0) parts.push(`${digital.length} whose logic output reaches no consumer and no port`);
    if (analogue.length > 0) parts.push(`${analogue.length} wired only to private nets, so no current can flow`);
    push(ctx, {
      code: 'CF8003',
      category: 'structure',
      severity: Severity.Warning,
      title: `Unused components: ${list.length} × ${specId}`,
      detail:
        `${list.length} instance(s) of ${specId} have no observable effect: ${parts.join('; ')}. ` +
        'They still cost their declared delay, and their power if the circuit is simulated electrically.',
      subject: { type: 'component', name: list[0].ref, id: list[0].id, path: list[0].path },
      metrics: { instances: list.length, elements: list.reduce((a, i) => a + i.elements, 0), types: bySpec.size },
      evidence: list.slice(0, 10).map((i) => `${i.ref} @ ${i.path} (${i.elements} element(s), fan-out ${i.fanout})`),
      recommendation: 'Delete them, or wire their output where it is observed.',
      scope:
        'Structural. Dead logic can be intentional (the word lines of ROM words that hold no 1, outputs a top-level sheet does not use): ' +
        'the finding says "nothing reads this", not "this is a bug".',
    });
  }

  if (!graph || graph.elements.length === 0) return;
  const dead = graph.elements.filter((el) => el.outputs.every((out) => idx.consumed[out] === 0 && !isPortNet(nl, out)));
  if (dead.length === 0) return;
  const byInstance = new Map<number, LogicElement[]>();
  for (const el of dead) {
    const list = byInstance.get(el.instance) ?? [];
    list.push(el);
    byInstance.set(el.instance, list);
  }
  push(ctx, {
    code: 'CF8004',
    category: 'structure',
    severity: Severity.Info,
    title: `Dead logic: ${dead.length} element(s) whose output is read by nobody`,
    detail:
      'These elements evaluate, but nothing downstream consumes them: they are computed work no observer can see. ' +
      (ctx.stats.fanout ? `Circuit-wide, ${ctx.stats.fanout.dangling} driven net(s) have no consumer at all. ` : '') +
      'Intentional cases exist (a ROM word line for a word that holds no 1, an output the sheet does not use) — the finding reports what is unread, not why.',
    metrics: { elements: dead.length, instances: byInstance.size },
    evidence: [...byInstance.entries()]
      .slice(0, 10)
      .map(([inst, list]) => `${nl.instances[inst]?.path ?? '?'}: ${list.length} element(s) — ${list.slice(0, 3).map((el) => netName(nl, el.outputs[0])).join(', ')}`),
    recommendation: 'Remove the dead cone, or connect it to an output or a probe.',
    scope: 'Level-0 connectivity. Nets that end on a root port count as observed.',
  });
}

function isPortNet(nl: FlatNetlist, net: number): boolean {
  return nl.ports.some((p) => p.node === net);
}

/** CF8005 — inputs of one element that cannot change its output. */
function checkRedundantInputs(ctx: CheckContext): void {
  const { graph, nl } = ctx;
  if (!graph) return;
  const doubled: string[] = [];
  const absorbed: string[] = [];
  const neutral: string[] = [];

  for (const el of graph.elements) {
    if (el.kind === 'dff' || el.kind === 'latch') continue;

    // 1. the same net on several inputs of one element
    const seen = new Map<number, number>();
    for (const inp of el.inputs) {
      if (inp <= 0) continue;
      seen.set(inp, (seen.get(inp) ?? 0) + 1);
    }
    for (const [net, n] of seen) {
      if (n > 1) {
        doubled.push(`${elementLabel(el)} reads ${netName(nl, net)} ${n} times (x AND x = x, x XOR x = 0)`);
        break;
      }
    }
    if (seen.size !== el.inputs.length) continue; // already reported as doubled

    // 2. an input tied to a constant that absorbs or neutralises the output
    if (el.kind !== 'gate' || !GATES.has(el.fn) || el.fn === LOGIC_FN.BUF || el.fn === LOGIC_FN.NOT) continue;
    const isAnd = el.fn === LOGIC_FN.AND || el.fn === LOGIC_FN.NAND;
    const isOr = el.fn === LOGIC_FN.OR || el.fn === LOGIC_FN.NOR;
    if (!isAnd && !isOr) continue;
    const absorbing = constantOnNet(ctx, el.inputs, isAnd ? 0 : 1);
    const neutralNet = constantOnNet(ctx, el.inputs, isAnd ? 1 : 0);
    if (absorbing !== null) {
      absorbed.push(`${elementLabel(el)}: constant ${isAnd ? '0' : '1'} on ${netName(nl, absorbing)} forces ${netName(nl, el.outputs[0])}`);
    } else if (neutralNet !== null && el.inputs.length === 2) {
      neutral.push(`${elementLabel(el)}: constant ${isAnd ? '1' : '0'} on ${netName(nl, neutralNet)} — the other input alone decides the output`);
    }
  }

  if (doubled.length > 0) {
    push(ctx, {
      code: 'CF8005',
      category: 'structure',
      severity: Severity.Info,
      title: `Redundant inputs: ${doubled.length} element(s) are wired to the same net more than once`,
      detail:
        'Two terminals of the same element are on one net. For every two-input function the duplicated term is algebraically redundant ' +
        '(x AND x = x, x OR x = x, x XOR x = 0), so the element is a buffer, a constant driver or an inverter in disguise.',
      metrics: { elements: doubled.length },
      evidence: doubled.slice(0, 10),
      recommendation: 'Replace the element with the simpler function it actually implements.',
      scope: 'Structural, from the element function table. The netlist is not rewritten.',
    });
  }
  if (absorbed.length > 0) {
    push(ctx, {
      code: 'CF8005',
      category: 'structure',
      severity: Severity.Info,
      title: `Constant-driven outputs: ${absorbed.length} gate(s) have a constant input`,
      detail:
        'An AND with a 0 (or an OR with a 1) has a constant output, so every consumer of that gate reads a constant. These gates are where constant ' +
        'propagation would simplify the circuit — a real optimization the analyzer only *reports* (the optimizer is what rewrites).',
      metrics: { gates: absorbed.length },
      evidence: absorbed.slice(0, 10),
      recommendation: 'Collapse the cone to a constant driver, or remove the tie keeping it constant.',
      scope: 'Structural constant propagation over the level-0 graph.',
    });
  }
  if (neutral.length > 0) {
    push(ctx, {
      code: 'CF8005',
      category: 'structure',
      severity: Severity.Info,
      title: `Redundant inputs: ${neutral.length} two-input gate(s) whose second input never matters`,
      detail:
        'A constant 1 on an AND (or a constant 0 on an OR) is the neutral element: the other input alone decides the output, so the gate is a buffer ' +
        'or an inverter with an extra pin.',
      metrics: { gates: neutral.length },
      evidence: neutral.slice(0, 10),
      recommendation: 'Collapse the gate to the single-input function it implements.',
      scope: 'Two-input gates only; wider gates are left alone.',
    });
  }
}

/** Net driven by a `logic_high` / `logic_low` element, or null. */
function constantOnNet(ctx: CheckContext, nets: number[], value: 0 | 1): number | null {
  const graph = ctx.graph!;
  const want = value === 1 ? LOGIC_FN.CONST_HIGH : LOGIC_FN.CONST_LOW;
  for (const n of nets) {
    for (const el of graph.elements) {
      if (el.fn === want && el.outputs.includes(n)) return n;
    }
  }
  return null;
}

/** CF8006 — combinational loops, reported as the actual chain. */
function checkLoops(ctx: CheckContext): void {
  const { graph, nl } = ctx;
  if (!graph || graph.loopElements.length === 0) return;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const el of graph.loopElements) {
    union(el.index, el.index);
    for (const n of [...el.inputs, ...el.outputs]) if (n > 0) union(el.index, 1_000_000 + n);
  }
  const groups = new Map<number, LogicElement[]>();
  for (const el of graph.loopElements) {
    const root = find(el.index);
    const list = groups.get(root) ?? [];
    list.push(el);
    groups.set(root, list);
  }
  for (const [, elements] of groups) {
    const nets = new Set<number>();
    for (const el of elements) for (const n of [...el.inputs, ...el.outputs]) if (n > 0) nets.add(n);
    push(ctx, {
      code: 'CF8006',
      category: 'reliability',
      severity: Severity.Error,
      title: `Combinational loop over ${elements.length} element(s)`,
      detail:
        'These elements form a cycle with no register in it. A combinational loop has no defined value: it can oscillate, settle at an analogue level between the ' +
        'logic thresholds, or depend on the order of evaluation. The engine excludes them from the level assignment and does not invent an arrival time for them.',
      subject: { type: 'net', name: netName(nl, [...nets][0]), id: [...nets][0] },
      metrics: { elements: elements.length, nets: nets.size },
      evidence: elements
        .slice(0, 10)
        .map((el) => `${elementLabel(el)}: ${el.inputs.map((n) => netName(nl, n)).join(',')} → ${el.outputs.map((n) => netName(nl, n)).join(',')}`),
      recommendation: "Break the cycle with a register, or make the loop's value irrelevant to the observed outputs.",
      scope: 'Digital elements only: an analogue feedback network (e.g. an RC oscillator) is legal and is not reported here.',
    });
  }
}

/** CF8007 — nets with a large fan-out. */
function checkFanout(ctx: CheckContext): void {
  const { graph, nl, idx } = ctx;
  if (!graph || graph.elements.length === 0) return;
  const threshold = ctx.opts.highFanout ?? DEFAULT_HIGH_FANOUT;
  const ranked: Array<[number, number]> = [];
  for (let n = 1; n < idx.fanout.length; n++) if (idx.fanout[n] > threshold) ranked.push([n, idx.fanout[n]]);
  if (ranked.length === 0) return;
  ranked.sort((a, b) => b[1] - a[1]);
  const interesting = new Set(ranked.slice(0, 5).map(([n]) => n));
  const consumers = new Map<number, LogicElement[]>();
  for (const el of graph.elements) {
    const nets = [...el.inputs, el.enable, el.clk, el.rst, ...el.selects];
    for (const n of nets) {
      if (!interesting.has(n)) continue;
      const list = consumers.get(n) ?? [];
      list.push(el);
      consumers.set(n, list);
    }
  }
  for (const [net, count] of ranked.slice(0, 5)) {
    const list = consumers.get(net) ?? [];
    const byRef = new Map<string, number>();
    for (const el of list) byRef.set(el.ref, (byRef.get(el.ref) ?? 0) + 1);
    push(ctx, {
      code: 'CF8007',
      category: 'structure',
      severity: Severity.Warning,
      title: `High fan-out: ${netName(nl, net)} drives ${count} input(s)`,
      detail:
        `One driver feeds ${count} input terminals (threshold ${threshold}). Every input-like terminal is counted, the clock, reset and select pins included, ` +
        'because the netlist has no load model: the electrical level adds no input capacitance and the timing model does not stretch a delay with its load, so this is a ' +
        '*structural* observation — what it costs would need a load model this engine does not claim to have.',
      
      subject: { type: 'net', name: netName(nl, net), id: net },
      metrics: { fanout: count, consumers: byRef.size, threshold },
      evidence: [`${netName(nl, net)} ← ${[...byRef.keys()].slice(0, 12).join(', ')}${byRef.size > 12 ? `, +${byRef.size - 12} more` : ''}`, ...[...byRef.entries()].slice(0, 8).map(([ref, n]) => `${ref}: ${n} input(s)`)],
      recommendation: 'Insert a buffer tree, or reduce the sharing. If the net is a clock, drive it from a dedicated clock buffer rather than from logic.',
      scope: 'Logic-level fan-out count over every input-like terminal. No capacitance, drive-strength or clock-tree model.',
    });
  }
}

/** CF8008 / CF8009 — duplicate components and structurally redundant logic. */
function checkDuplicates(ctx: CheckContext): void {
  const { graph, nl, idx } = ctx;
  // Duplicates are only meaningful *within one sheet*: two identical gates that
  // belong to two different instances of the same chip are the same hardware used
  // twice, which is the point of hierarchy, not a mistake.
  const groups = new Map<string, InstanceStats[]>();
  for (const inst of ctx.instances) {
    if (inst.elements === 0) continue;
    const raw = nl.instances[inst.index];
    const params = Object.keys(raw.params ?? {})
      .sort()
      .map((k) => `${k}=${String((raw.params as Record<string, unknown>)[k])}`)
      .join(',');
    const inputs = idx.elementsByInstance[inst.index]
      .flatMap((el) => [...el.inputs, ...el.selects].map(String))
      .join(',');
    const key = `${raw.parent}|${inst.specId}|${inst.bits}|${params}|${inputs}`;
    const list = groups.get(key) ?? [];
    list.push(inst);
    groups.set(key, list);
  }
  // One finding per sheet, listing the groups: a ROM full of shared product terms
  // should produce one item to act on, not one item per group.
  const bySheet = new Map<string, Array<InstanceStats[]>>();
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    // The same instance appearing twice (a vector instance iterated twice) is not a duplicate.
    if (new Set(list.map((i) => i.index)).size < 2) continue;
    const sheet = nl.instances[list[0].index].parent;
    const key = String(sheet);
    const arr = bySheet.get(key) ?? [];
    arr.push(list);
    bySheet.set(key, arr);
  }
  for (const [, sheetGroups] of bySheet) {
    const instances = sheetGroups.reduce((a, g) => a + g.length, 0);
    const wasted = sheetGroups.reduce((a, g) => a + g.length - 1, 0);
    const sheetPath = nl.instances[sheetGroups[0][0].index].path.split('/').slice(0, -1).join('/') || '(top sheet)';
    push(ctx, {
      code: 'CF8008',
      category: 'structure',
      severity: Severity.Info,
      title: `Duplicate components: ${instances} instance(s) in ${sheetPath} could be ${instances - wasted}`,
      detail:
        'Within one sheet, these instances have the same type, the same parameter values and the same bit width, and are wired to the same inputs, so they compute exactly ' +
        'the same outputs. One of each group can drive every consumer. Instances in *different* sheets are never grouped: using the same chip twice is hierarchy, not duplication.',
      subject: { type: 'component', name: sheetGroups[0][0].ref, id: sheetGroups[0][0].id, path: sheetGroups[0][0].path },
      metrics: { instances, removable: wasted, groups: sheetGroups.length },
      evidence: sheetGroups
        .slice(0, 8)
        .map((g) => `${g.length} × ${g[0].specId}: ${g.slice(0, 6).map((i) => i.ref).join(', ')}`),
      recommendation: 'Keep one instance per group and fan its output out — or check that the duplication is not a copy/paste mistake.',
      scope: 'Structural equality of parameters and input nets within one sheet, not of computed values.',
    });
  }

  if (!graph) return;
  const bySignature = new Map<string, LogicElement[]>();
  for (const el of graph.elements) {
    if (el.kind === 'dff' || el.kind === 'latch') continue;
    if (el.fn === LOGIC_FN.CONST_HIGH || el.fn === LOGIC_FN.CONST_LOW) continue;
    const sig = [el.kind, el.fn, el.inputs.join(','), el.selects.join(','), el.enable, el.channels, el.decoder ? 1 : 0].join('|');
    const list = bySignature.get(sig) ?? [];
    list.push(el);
    bySignature.set(sig, list);
  }
  let redundant = 0;
  const evidence: string[] = [];
  for (const [, list] of bySignature) {
    if (list.length < 2) continue;
    if (new Set(list.map((el) => el.outputs.join(','))).size < 2) continue; // one element reported twice
    redundant += list.length - 1;
    if (evidence.length < 10) {
      const sheet = nl.instances[list[0].instance]?.path ?? '?';
      evidence.push(`${list.slice(0, 4).map(elementLabel).join(' ≡ ')} in ${sheet} → ${list.slice(0, 4).map((el) => netName(nl, el.outputs[0])).join(', ')}`);
    }
  }
  if (redundant === 0) return;
  push(ctx, {
    code: 'CF8009',
    category: 'structure',
    severity: Severity.Info,
    title: `Redundant logic: ${redundant} element(s) recompute a value that already exists`,
    detail:
      'These elements have the same function and the same inputs as another element, but drive a different net: the circuit computes the same sub-expression twice. ' +
      'Sharing the first output keeps the function identical. (A ROM implemented as a full AND/OR plane is the classic case: every product term of an n-bit address ' +
      'repeats 2^(n-2) times.)',
    metrics: { redundantElements: redundant },
    evidence,
    recommendation: 'Share the first output, or let the optimizer try (common-subexpression elimination is one of its moves).',
    scope: 'Structural equivalence over the logic graph (same function, inputs and selects).',
  });
}

/** CF8010 — analogue nets with no direct-current path to the reference. */
function checkFloatingAnalog(ctx: CheckContext): void {
  const { nl, idx } = ctx;
  // A purely digital design has no electrical reference to lose: the reference
  // warning is only meaningful once something conducts a current.
  let hasAnalogElement = false;
  for (let e = 0; e < nl.elementCount; e++) if (ANALOG_KINDS.has(nl.kind[e])) { hasAnalogElement = true; break; }
  if (!nl.hasGroundReference && hasAnalogElement) {
    push(ctx, {
      code: 'CF8010',
      category: 'connectivity',
      severity: Severity.Warning,
      title: 'The circuit has no ground reference',
      detail:
        'No ground symbol ties a net that any other component uses. Node 0 of the solver is then a reference the solver itself holds down with its gmin conductance: ' +
        'the operating point it reports is relative to nothing, and a connected circuit (e.g. one described by node-to-node voltages only) is what the numbers actually mean.',
      metrics: { groundSymbols: 0, nodes: nl.nodeCount },
      recommendation: 'Add a ground component to the net that is meant to be 0 V.',
      scope: 'Presence of a ground symbol on a shared net.',
    });
    return;
  }
  const reachable = new Uint8Array(nl.nodeCount);
  const stack: number[] = [nl.groundNode];
  reachable[nl.groundNode] = 1;
  while (stack.length > 0) {
    const node = stack.pop()!;
    const neighbours = idx.dcAdjacency.get(node);
    if (!neighbours) continue;
    for (const other of neighbours) {
      if (other > 0 && other < nl.nodeCount && !reachable[other]) {
        reachable[other] = 1;
        stack.push(other);
      }
    }
  }
  const floating: number[] = [];
  for (const [node, instances] of idx.netInstances) {
    if (node <= 0 || reachable[node]) continue;
    // Only report nets where at least one element is analogue (a digital-only net
    // with no DC path is normal and is covered by the level-0 checks).
    const analogue = instances.some((i) => {
      const stat = ctx.instances[i];
      return stat?.elementKinds.some((k) => ANALOG_KINDS.has(k.kind));
    });
    if (analogue) floating.push(node);
  }
  if (floating.length === 0) return;
  floating.sort((a, b) => a - b);
  push(ctx, {
    code: 'CF8010',
    category: 'connectivity',
    severity: Severity.Warning,
    title: `${floating.length} analogue net(s) have no direct-current path to the reference`,
    detail:
      'Walking the elements that conduct at DC (resistors, diodes, transistors, sources, closed switches — not capacitors) from the ground node, these nets are unreachable. ' +
      'Their absolute potential is undefined: the solver needs gmin to produce any answer, and that answer is only as physical as gmin is small.',
    metrics: { floatingNets: floating.length, nodes: nl.nodeCount },
    evidence: floating.slice(0, 10).map((n) => netName(nl, n)),
    recommendation: 'Add a DC path (a resistor to ground, or a proper reference).',
    scope: 'Reachability through DC-conducting elements; no numerical conditioning included.',
  });
}

/** CF8011 — what could make the operating point unstable or ill-defined. */
function checkInstability(ctx: CheckContext): void {
  const { nl, sim } = ctx;
  const pairs = new Map<string, string[]>();
  for (let e = 0; e < nl.elementCount; e++) {
    if (nl.kind[e] !== Kind.VoltageSource && nl.kind[e] !== Kind.Vcvs) continue;
    const a = nl.nodes[e * NODE_STRIDE];
    const b = nl.nodes[e * NODE_STRIDE + 1];
    if (a < 0 || b < 0) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const list = pairs.get(key) ?? [];
    list.push(ctx.instances[nl.instIndex[e]]?.ref ?? `element ${e}`);
    pairs.set(key, list);
  }
  for (const [key, list] of pairs) {
    if (list.length < 2) continue;
    const [a, b] = key.split('|').map(Number);
    push(ctx, {
      code: 'CF8011',
      category: 'reliability',
      severity: Severity.Error,
      title: `Parallel voltage sources between ${netName(nl, a)} and ${netName(nl, b)}`,
      detail:
        'Two voltage-defined elements share both terminals and neither has a series resistance: the branch currents are set only by the (ideal) source resistances, ' +
        'so the nodal system is singular. The solver reports that as a singular matrix rather than inventing a current split.',
      subject: { type: 'net', name: netName(nl, a), id: a },
      metrics: { sources: list.length },
      evidence: list.map((ref) => `${ref} between ${netName(nl, a)} and ${netName(nl, b)}`),
      recommendation: 'Give each source its own series resistance, or merge them.',
      scope: 'Structural: ideal voltage-defined elements sharing a node pair.',
    });
  }
  if (!sim) return;
  const requested = sim.opts.gmin;
  const used = sim.gminUsed();
  if (used > requested * 10 + 1e-18) {
    push(ctx, {
      code: 'CF8011',
      category: 'reliability',
      severity: Severity.Warning,
      title: `The operating point needed gmin = ${used.toExponential(2)} S`,
      detail:
        `The requested gmin is ${requested.toExponential(2)} S. A much larger gmin means the nodal system was (nearly) singular without help: gmin is a numerical ` +
        'shunt that is NOT part of the circuit, so the reported voltages are only as physical as that shunt is small.',
      metrics: { gminUsed: used, gminRequested: requested },
      recommendation: 'Find the floating node or the shorted source that made the system singular (see CF8010/CF8011 findings).',
      scope: 'Taken from the last solve performed by the supplied simulator.',
    });
  }
}

/** CF8012 / CF8013 — register state and clock nets. */
function checkRegisters(ctx: CheckContext): void {
  const { graph, nl, idx } = ctx;
  if (!graph) return;
  const unknownState: LogicElement[] = [];
  const selfHold: LogicElement[] = [];
  const noClock: LogicElement[] = [];
  const gatedClock: LogicElement[] = [];
  for (const el of graph.elements) {
    if (el.kind !== 'dff' && el.kind !== 'latch') continue;
    if (el.initial === 2) unknownState.push(el);
    if (el.outputs.length > 0 && el.inputs.length > 0 && el.outputs[0] === el.inputs[0]) selfHold.push(el);
    if (el.kind !== 'dff') continue;
    if (el.clk < 0) continue;
    // A clock can legitimately come from a port (the harness drives it); only a
    // clock net with neither a driver nor a port is dead.
    if (graph.driverCount[el.clk] === 0 && !isPortNet(nl, el.clk)) {
      noClock.push(el);
      continue;
    }
    const driver = graph.elements.find((e) => e.outputs.includes(el.clk));
    if (!driver) continue;
    const combinational = driver.kind === 'mux' || driver.kind === 'demux' || driver.kind === 'tristate' || (driver.kind === 'gate' && GATES.has(driver.fn) && driver.fn !== LOGIC_FN.BUF && driver.fn !== LOGIC_FN.NOT);
    if (combinational) gatedClock.push(el);
  }
  void idx;
  if (unknownState.length > 0) {
    push(ctx, {
      code: 'CF8012',
      category: 'reliability',
      severity: Severity.Warning,
      title: `${unknownState.length} register(s) have no modelled power-up state`,
      detail:
        'These registers are declared with `initial: unknown`, which is the honest default: a real flip-flop powers up in a state that depends on the silicon. ' +
        'The level-0 engine therefore starts them at X. A design whose behaviour depends on that X is non-deterministic on real hardware too.',
      metrics: { registers: unknownState.length },
      evidence: unknownState.slice(0, 10).map((el) => `${elementLabel(el)} → ${el.outputs.map((n) => netName(nl, n)).join(', ')}`),
      recommendation: 'Add a reset that reaches every register whose initial state matters, or fix the state if the hardware really guarantees it.',
      scope: 'Static: power-up races are not simulated.',
    });
  }
  if (noClock.length > 0) {
    push(ctx, {
      code: 'CF8013',
      category: 'connectivity',
      severity: Severity.Warning,
      title: `${noClock.length} register(s) have an undriven clock input`,
      detail: 'Their clock net has no driver at all, so they never latch a value: they are dead state.',
      metrics: { registers: noClock.length },
      evidence: noClock.slice(0, 10).map((el) => `${elementLabel(el)} CLK ← ${netName(nl, el.clk)}`),
      recommendation: 'Drive the clock, or delete the register.',
      scope: 'Level-0 connectivity.',
    });
  }
  if (gatedClock.length > 0) {
    push(ctx, {
      code: 'CF8013',
      category: 'timing',
      severity: Severity.Warning,
      title: `${gatedClock.length} register(s) are clocked through combinational logic`,
      detail:
        "The clock input of these registers comes from a gate rather than from a clock source, a port or another register's output. The static timing analysis " +
        'assumes a clean clock edge on every register and cannot see the skew, glitch or duty-cycle distortion a gated clock introduces: the CF8002 clock bound does not apply to them.',
      metrics: { registers: gatedClock.length },
      evidence: gatedClock.slice(0, 10).map((el) => `${elementLabel(el)} CLK ← ${netName(nl, el.clk)}`),
      recommendation: 'Use a register with an enable input, or a proper latch-based clock gate.',
      scope: 'Structural classification of the clock driver; no clock-tree analysis.',
    });
  }
  if (selfHold.length > 0) {
    push(ctx, {
      code: 'CF8012',
      category: 'structure',
      severity: Severity.Info,
      title: `${selfHold.length} register(s) hold their value (D wired to their own Q)`,
      detail:
        'These registers feed their own D input, so they latch the same value back forever: a constant with a clock. If the intent was "load when enabled", the ' +
        'enable multiplexer is missing.',
      metrics: { registers: selfHold.length },
      evidence: selfHold.slice(0, 10).map((el) => `${elementLabel(el)} D = Q = ${netName(nl, el.outputs[0])}`),
      recommendation: 'Add the load-enable multiplexer if a load was intended.',
      scope: 'Structural (D and Q on the same net).',
    });
  }
}

/** CF8014 — timing constraints, from the STA bound. */
function checkTimingConstraints(ctx: CheckContext): void {
  const { timing, nl } = ctx;
  const c = ctx.opts.constraints;
  if (!timing || !c) return;
  if (c.minFrequency !== undefined && timing.maxFrequency !== null && timing.maxFrequency < c.minFrequency) {
    push(ctx, {
      code: 'CF8014',
      category: 'constraints',
      severity: Severity.Error,
      title: `Timing constraint violated: ${(timing.maxFrequency / 1e6).toFixed(3)} MHz < required ${(c.minFrequency / 1e6).toFixed(3)} MHz`,
      detail: `The declared-delay bound allows at most ${(timing.maxFrequency / 1e6).toFixed(3)} MHz (period ≥ ${fmtNs(timing.clockPeriod)}), but the design must run at ${(c.minFrequency / 1e6).toFixed(3)} MHz.`,
      metrics: { maxFrequencyMHz: timing.maxFrequency / 1e6, requiredMHz: c.minFrequency / 1e6 },
      evidence: timing.criticalRegisterPath ? [describePath(timing.criticalRegisterPath, (n) => netName(nl, n))] : undefined,
      recommendation: 'Shorten the critical register-to-register path (see CF8001/CF8002).',
      scope: 'Declared delays only.',
    });
  }
  if (c.maxDelay !== undefined && timing.combinationalDelay !== null && timing.combinationalDelay > c.maxDelay) {
    push(ctx, {
      code: 'CF8014',
      category: 'constraints',
      severity: Severity.Error,
      title: `Delay constraint violated: ${fmtNs(timing.combinationalDelay)} > ${fmtNs(c.maxDelay)}`,
      detail: 'The longest declared-delay chain from a primary input to a primary output exceeds the constraint.',
      metrics: { combinationalDelayNs: timing.combinationalDelay * NS, limitNs: c.maxDelay * NS },
      evidence: timing.criticalPath ? [describePath(timing.criticalPath, (n) => netName(nl, n))] : undefined,
      scope: 'Declared delays only.',
    });
  }
}

/** Zone grouping: the top-level block every instance belongs to. */
function buildZones(ctx: CheckContext): void {
  const { nl, graph, sim, idx } = ctx;
  const byPath = new Map<string, Zone>();
  const zoneOfPath = (path: string): Zone => {
    let zone = byPath.get(path);
    if (zone) return zone;
    const top = nl.instances.find((i) => i.path === path);
    zone = {
      path,
      name: top ? `${top.ref} ${top.specId}` : path,
      specId: top?.specId ?? '?',
      instances: 0,
      elements: 0,
      worstArrival: null,
      power: sim ? 0 : null,
      maxTemperature: null,
    };
    byPath.set(path, zone);
    return zone;
  };

  // top-level ancestor of every instance path, memoised
  const zonePath = (inst: FlatInstance): string => {
    let cached = idx.zonePathCache.get(inst.path);
    if (cached) return cached;
    let current = inst.path;
    for (;;) {
      const slash = current.lastIndexOf('/');
      if (slash < 0) break;
      const parent = current.slice(0, slash);
      if (!nl.instances.some((i) => i.path === parent)) break;
      current = parent;
    }
    idx.zonePathCache.set(inst.path, current);
    return current;
  };

  const zoneOfInstance = new Map<FlatInstance, Zone>();
  for (const inst of nl.instances) {
    const zone = zoneOfPath(zonePath(inst));
    zone.instances++;
    zone.elements += inst.elementCount;
    zoneOfInstance.set(inst, zone);
  }

  if (graph && ctx.timing) {
    const arrival = mergeArrival(ctx.timing);
    for (const el of graph.elements) {
      const zone = zoneOfInstance.get(nl.instances[el.instance]);
      if (!zone) continue;
      for (const out of el.outputs) {
        if (!Number.isFinite(arrival[out])) continue;
        zone.worstArrival = zone.worstArrival === null ? arrival[out] : Math.max(zone.worstArrival, arrival[out]);
      }
    }
  }
  if (sim) {
    const power = sim.powers();
    for (let e = 0; e < nl.elementCount; e++) {
      const zone = zoneOfInstance.get(nl.instances[nl.instIndex[e]]);
      if (!zone) continue;
      const p = power[e];
      if (Number.isFinite(p)) zone.power = (zone.power ?? 0) + p;
      if (nl.thermalNodeCount > 0) {
        const th = elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params);
        if (th >= 0 && th < nl.thermalNodeCount) {
          const t = nl.thermalTemperature[th] - 273.15;
          zone.maxTemperature = zone.maxTemperature === null ? t : Math.max(zone.maxTemperature, t);
        }
      }
    }
  }

  const all = [...byPath.values()];
  const top = ctx.opts.topZones ?? DEFAULT_TOP_ZONES;
  ctx.zones = all;
  ctx.zonesSlow = all
    .filter((z) => z.worstArrival !== null && z.worstArrival > 0)
    .sort((a, b) => (b.worstArrival ?? 0) - (a.worstArrival ?? 0))
    .slice(0, top);
  ctx.zonesHot = all
    .filter((z) => (z.power ?? 0) > 1e-9)
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0))
    .slice(0, top);
  ctx.zonesPower = all
    .filter((z) => (z.worstArrival ?? 0) > 0)
    .sort((a, b) => (b.worstArrival ?? 0) * (b.power ?? 1) - (a.worstArrival ?? 0) * (a.power ?? 1))
    .slice(0, top);
}

function mergeArrival(timing: TimingReport): Float64Array {
  const n = timing.arrivalRise.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(timing.arrivalRise[i] ?? -Infinity, timing.arrivalFall[i] ?? -Infinity);
  return out;
}

/** CF8015 / CF8016 / CF8017 — the zone rankings. */
function checkZones(ctx: CheckContext): void {
  const { slow, hot } = { slow: ctx.zonesSlow, hot: ctx.zonesHot };
  if (slow.length > 0) {
    push(ctx, {
      code: 'CF8015',
      category: 'timing',
      severity: Severity.Info,
      title: `Slowest zone: ${slow[0].name} at ${fmtNs(slow[0].worstArrival)}`,
      detail:
        'Worst declared-delay arrival time per top-level block. Blocks are ranked by the arrival of their last output: a measurement of the declared delays on the ' +
        'actual paths, not a hotspot estimate.',
      metrics: Object.fromEntries(slow.map((z) => [z.name, Number((z.worstArrival! * NS).toFixed(4))])),
      evidence: slow.map((z) => `${z.name} (${z.path}): ${fmtNs(z.worstArrival)}, ${z.elements} element(s)`),
      recommendation: 'Attack the first block: its critical path is the one in CF8001.',
      scope: 'Declared delays, static timing, single corner.',
    });
  }
  if (hot.length > 0) {
    const total = hot.reduce((a, z) => a + Math.max(0, z.power ?? 0), 0);
    push(ctx, {
      code: 'CF8016',
      category: 'power',
      severity: Severity.Info,
      title: `Hottest zone: ${hot[0].name} at ${formatPower(hot[0].power ?? 0)}`,
      detail:
        'Dissipated power per top-level block, summed from the per-element power the device models reported for the supplied solution. ' +
        `The ranking covers the ${hot.length} block(s) that dissipate anything (${formatPower(total)} of gross dissipation across them; a block with a supply in it can show a smaller net figure).`,
      metrics: Object.fromEntries(hot.map((z) => [`${z.name} (W)`, Number((z.power ?? 0).toExponential(4))])),
      evidence: hot.map((z) => `${z.name} (${z.path}): ${formatPower(z.power ?? 0)} over ${z.elements} element(s)`),
      scope: 'Measured from one operating point; switching-dependent power needs a transient.',
    });
  }
  // Dissipation is a signed quantity: a supply *delivers* power, so the net sum
  // over a circuit is ~0 by conservation and is useless as a denominator. The
  // share is taken against the gross dissipation (Σ max(P,0)), and components
  // below a nano-watt are noise, not findings.
  const POWER_FLOOR = 1e-9;
  const gross = ctx.instances.reduce((a, i) => a + Math.max(0, i.power ?? 0), 0);
  const hogged = ctx.instances
    .filter((i) => (i.power ?? 0) >= POWER_FLOOR)
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0))
    .slice(0, 5);
  if (hogged.length === 0) return;
  const share = gross > 0 ? (hogged[0].power ?? 0) / gross : 0;
  push(ctx, {
    code: 'CF8017',
    category: 'power',
    severity: Severity.Info,
    title: `Power hog: ${hogged[0].ref} (${hogged[0].specId}) dissipates ${formatPower(hogged[0].power ?? 0)} (${(share * 100).toFixed(1)} % of the ${formatPower(gross)} dissipated)`,
    detail:
      'The five largest per-component dissipations of the supplied solution. The share is measured against the gross dissipation (the sum of the positive ' +
      'per-element powers, since a source reports negative absorbed power).',
    subject: { type: 'component', name: hogged[0].ref, id: hogged[0].id, path: hogged[0].path },
    metrics: Object.fromEntries(hogged.map((i) => [`${i.ref}@${i.path} (W)`, Number((i.power ?? 0).toExponential(4))])),
    evidence: hogged.map(
      (i) => `${i.ref} ${i.specId} @ ${i.path}: ${formatPower(i.power ?? 0)}${i.temperature !== null ? `, ${i.temperature.toFixed(2)} °C` : ''}`,
    ),
    recommendation: 'Reduce its current or its voltage drop, or spread the dissipation over more components.',
    scope: 'DC operating point of the supplied solution.',
  });
}

/** CF8019 — ports that are never read, and output ports nobody drives. */
function checkPorts(ctx: CheckContext): void {
  const { nl, graph, idx } = ctx;
  if (!graph) return;
  const unusedInputs: string[] = [];
  const silentOutputs: string[] = [];
  for (const port of nl.ports) {
    if (port.direction === 'input' && idx.consumed[port.node] === 0) unusedInputs.push(`${port.name} (${port.width} bit${port.width > 1 ? 's' : ''})`);
    if (port.direction === 'output' && graph.driverCount[port.node] === 0) silentOutputs.push(port.name);
  }
  if (unusedInputs.length > 0) {
    push(ctx, {
      code: 'CF8019',
      category: 'structure',
      severity: Severity.Info,
      title: `${unusedInputs.length} input port(s) are never read`,
      detail: 'The port exists on the symbol, but no element inside the circuit consumes its net.',
      metrics: { ports: unusedInputs.length },
      evidence: unusedInputs.slice(0, 12),
      recommendation: 'Remove the port, or use it.',
      scope: 'Level-0 connectivity of the flattened netlist.',
    });
  }
  if (silentOutputs.length > 0) {
    push(ctx, {
      code: 'CF8019',
      category: 'connectivity',
      severity: Severity.Warning,
      title: `${silentOutputs.length} output port(s) have no driver`,
      detail: 'Nothing inside the circuit drives these output nets: the port reads X at level 0, and floats at level 1.',
      metrics: { ports: silentOutputs.length },
      evidence: silentOutputs.slice(0, 12),
      recommendation: 'Drive the port, or remove it.',
      scope: 'Level-0 connectivity.',
    });
  }
}

/** CF8020 — nets shared by the logic level and the electrical level. */
function checkMixedLevels(ctx: CheckContext): void {
  const { nl, graph, idx } = ctx;
  if (!graph) return;
  const digitalNets = new Set<number>();
  for (const el of graph.elements) for (const out of el.outputs) digitalNets.add(out);
  const crossing = new Map<number, string[]>();
  for (const [node, instances] of idx.netInstances) {
    if (node <= 0 || !digitalNets.has(node)) continue;
    for (const i of instances) {
      const stat = ctx.instances[i];
      if (!stat) continue;
      if (stat.logicElements > 0) continue;
      if (!stat.elementKinds.some((k) => ANALOG_KINDS.has(k.kind))) continue;
      const list = crossing.get(node) ?? [];
      if (!list.includes(stat.ref)) list.push(stat.ref);
      crossing.set(node, list);
    }
  }
  if (crossing.size === 0) return;
  push(ctx, {
    code: 'CF8020',
    category: 'connectivity',
    severity: Severity.Info,
    title: `${crossing.size} net(s) cross between the logic level and the electrical level`,
    detail:
      "A digital output also reaches an analogue element. The level-0 engine drives the net as 0/1 through the gate's output resistance, while the electrical solver " +
      'treats the same net as a node: the two levels agree only if the gate voltage model matches the analogue domain. It is reported so the assumption is visible — ' +
      'a mixed circuit is exactly what the two levels are for.',
    metrics: { nets: crossing.size },
    evidence: [...crossing.entries()].slice(0, 10).map(([net, refs]) => `${netName(nl, net)} ← ${refs.join(', ')}`),
    scope: 'Structural detection of shared nets.',
  });
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

function evaluateConstraints(ctx: CheckContext): ConstraintResult[] {
  const c = ctx.opts.constraints;
  if (!c) return [];
  const { nl, stats } = ctx;
  const out: ConstraintResult[] = [];
  /** Constraints whose violation is reported by a check of its own. */
  const covered = new Set<string>();
  const add = (name: string, limit: number | string, measured: number | string | null, unit: string, pass: boolean | null, reason?: string): void => {
    out.push({ name, limit, measured, unit, pass, reason });
  };

  if (c.maxInstances !== undefined) add('maxInstances', c.maxInstances, nl.instances.length, 'components', nl.instances.length <= c.maxInstances);
  if (c.maxElements !== undefined) add('maxElements', c.maxElements, nl.elementCount, 'elements', nl.elementCount <= c.maxElements);
  if (c.maxHierarchyDepth !== undefined) add('maxHierarchyDepth', c.maxHierarchyDepth, stats.hierarchyDepth, 'levels', stats.hierarchyDepth <= c.maxHierarchyDepth);
  if (c.maxLogicLevels !== undefined) {
    const levels = stats.logic ? stats.logic.levels : null;
    add('maxLogicLevels', c.maxLogicLevels, levels, 'levels', levels === null ? null : levels <= c.maxLogicLevels, levels === null ? 'the circuit has no logic level' : undefined);
  }
  if (c.maxFanout !== undefined) {
    const max = stats.fanout ? stats.fanout.max : null;
    add('maxFanout', c.maxFanout, max, 'inputs', max === null ? null : max <= c.maxFanout, max === null ? 'no logic fan-out was computed' : undefined);
  }
  if (c.maxDelay !== undefined) {
    covered.add('maxDelay');
    const d = ctx.timing ? ctx.timing.combinationalDelay : null;
    add('maxDelay', (c.maxDelay * NS).toFixed(3), d === null ? null : (d * NS).toFixed(3), 'ns', d === null ? null : d <= c.maxDelay, d === null ? 'no input-to-output combinational path was analysed' : undefined);
  }
  if (c.minFrequency !== undefined) {
    covered.add('minFrequency');
    const f = ctx.timing ? ctx.timing.maxFrequency : null;
    add('minFrequency', (c.minFrequency / 1e6).toFixed(3), f === null ? null : (f / 1e6).toFixed(3), 'MHz', f === null ? null : f >= c.minFrequency, f === null ? 'the circuit has no register, so it has no clock bound' : undefined);
  }
  if (c.maxPower !== undefined) {
    // A power budget is a budget on what the circuit *burns*: the gross
    // dissipation Σ max(P,0). The net sum over a circuit that conserves energy
    // is ~0, so comparing that would make every circuit pass.
    const p = stats.electrical.totalDissipated;
    add(
      'maxPower',
      String(c.maxPower),
      p === null ? null : p.toExponential(4),
      'W',
      p === null ? null : p <= c.maxPower,
      p === null ? 'no solved simulator was supplied (power cannot be measured without one)' : 'measured on the gross dissipation of the solved operating point',
    );
  }
  if (c.maxTemperature !== undefined) {
    const t = stats.thermal ? stats.thermal.maxTemperature : null;
    add(
      'maxTemperature',
      String(c.maxTemperature),
      t === null ? null : t.toFixed(2),
      '°C',
      t === null ? null : t <= c.maxTemperature,
      t === null ? (stats.thermal ? 'the thermal network was not solved' : 'the circuit has no thermal network') : undefined,
    );
  }
  if (c.requireGround) {
    // The reference node of the solver is always 0; what is checked here is that
    // the *design* has a ground symbol tying that reference down.
    const has = nl.hasGroundReference;
    add('requireGround', 'yes', has ? 'yes' : 'no', '', has);
    covered.add('requireGround');
  }
  if (c.requireReset) {
    const graph = ctx.graph;
    if (!graph) add('requireReset', 'yes', 'unknown', '', null, 'the circuit has no logic level');
    else {
      const regs = graph.elements.filter((el) => el.kind === 'dff' || el.kind === 'latch');
      const missing = regs.filter((el) => el.rst < 0);
      add('requireReset', 'yes', `${regs.length - missing.length}/${regs.length}`, 'registers', missing.length === 0);
      covered.add('requireReset');
      if (missing.length > 0) {
        push(ctx, {
          code: 'CF8018',
          category: 'constraints',
          severity: Severity.Warning,
          title: `Reset constraint violated: ${missing.length} register(s) have no reset`,
          detail: 'The constraints require every register to have a reset input. These registers do not.',
          metrics: { registers: regs.length, withoutReset: missing.length },
          evidence: missing.slice(0, 10).map(elementLabel),
          scope: 'Declared reset pins in the netlist.',
        });
      }
    }
  }
  if (c.requiredPorts && c.requiredPorts.length > 0) {
    const missing = c.requiredPorts.filter((want) => {
      const port = nl.ports.find((p) => p.name === want.name);
      if (!port) return true;
      if (want.direction && port.direction !== want.direction) return true;
      if (want.width !== undefined && port.width !== want.width) return true;
      return false;
    });
    add('requiredPorts', `${c.requiredPorts.length} port(s)`, `${c.requiredPorts.length - missing.length}/${c.requiredPorts.length}`, 'ports', missing.length === 0);
    covered.add('requiredPorts');
    if (missing.length > 0) {
      push(ctx, {
        code: 'CF8018',
        category: 'constraints',
        severity: Severity.Error,
        title: `Missing port(s): ${missing.map((m) => m.name).join(', ')}`,
        detail: 'The circuit must expose these ports (name, direction and width are all checked) and does not.',
        metrics: { missing: missing.length, required: c.requiredPorts.length },
        evidence: missing.map((m) => `${m.name} (${m.direction ?? 'any'}, ${m.width ?? 'any'} bit)`),
        scope: 'Port table of the flattened netlist.',
      });
    }
  }
  if (c.forbiddenSpecs && c.forbiddenSpecs.length > 0) {
    const present = ctx.instances.filter((i) => c.forbiddenSpecs!.includes(i.specId));
    add('forbiddenSpecs', c.forbiddenSpecs.join(', '), present.length, 'instances', present.length === 0);
    covered.add('forbiddenSpecs');
    if (present.length > 0) {
      push(ctx, {
        code: 'CF8018',
        category: 'constraints',
        severity: Severity.Error,
        title: `Forbidden component(s) present: ${[...new Set(present.map((i) => i.specId))].join(', ')}`,
        detail: 'The constraints exclude these component types from the design.',
        metrics: { instances: present.length },
        evidence: present.slice(0, 10).map((i) => `${i.ref} ${i.specId} @ ${i.path}`),
        scope: 'Instance list of the flattened netlist.',
      });
    }
  }
  // Any other violated constraint is still a finding: a constraint that fails
  // silently in a table would let a design pass unremarked.
  for (const r of out) {
    if (r.pass !== false || covered.has(r.name)) continue;
    push(ctx, {
      code: 'CF8018',
      category: 'constraints',
      severity: Severity.Error,
      title: `Constraint violated: ${r.name} = ${r.measured ?? 'n/a'}${r.unit ? ` ${r.unit}` : ''} (limit ${r.limit}${r.unit ? ` ${r.unit}` : ''})`,
      detail: 'A design constraint supplied with this analysis is not satisfied by the circuit as it stands.',
      metrics: { limit: `${r.limit}${r.unit ? ` ${r.unit}` : ''}`, measured: `${r.measured ?? 'n/a'}${r.unit ? ` ${r.unit}` : ''}` },
      recommendation: 'Either change the design or relax the constraint — the report states which one it measured, so the choice is explicit.',
      scope: 'Measured on the flattened netlist (and on the solved operating point for the electrical constraints).',
    });
  }
  return out;
}

function push(ctx: CheckContext, f: Finding): void {
  ctx.findings.push(f);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Analyse a flattened netlist. See the module header for the checks it runs. */
export function analyzeNetlist(nl: FlatNetlist, options: AnalyzeOptions = {}): AnalyzeReport {
  const t0 = Date.now();
  const skip = new Set(options.skip ?? []);
  const notes: string[] = [];

  let graph: LogicGraph | null = options.graph ?? null;
  if (graph === null && !skip.has('logic')) {
    for (let e = 0; e < nl.elementCount; e++) {
      if (DIGITAL_KINDS.has(nl.kind[e])) {
        graph = buildLogicGraph(nl);
        break;
      }
    }
  }
  const model = resolveTimingModel(options.timingModel);
  let timing: TimingReport | null = options.timing ?? null;
  if (timing === null && graph && graph.elements.length > 0 && !skip.has('timing')) {
    timing = analyzeTiming(graph, { model: model.model, clockToQ: model.clockToQ, setup: model.setup });
  }

  const { stats, instances, specs } = circuitStats(nl, { graph, timing, sim: options.sim ?? null, lib: options.lib, skipLogic: graph === null });
  const ctx: CheckContext = {
    nl,
    graph,
    timing,
    sim: options.sim ?? null,
    stats,
    instances,
    specs,
    idx: buildIndexes(nl, graph),
    opts: options,
    findings: [],
    zones: [],
    zonesSlow: [],
    zonesHot: [],
    zonesPower: [],
  };

  if (!skip.has('timing')) checkTiming(ctx);
  if (!skip.has('unused')) checkUnused(ctx);
  if (!skip.has('structure')) checkRedundantInputs(ctx);
  if (!skip.has('loops')) checkLoops(ctx);
  if (!skip.has('fanout')) checkFanout(ctx);
  if (!skip.has('duplicates')) checkDuplicates(ctx);
  if (!skip.has('floating')) checkFloatingAnalog(ctx);
  if (!skip.has('instability')) checkInstability(ctx);
  if (!skip.has('registers')) checkRegisters(ctx);
  if (!skip.has('ports')) checkPorts(ctx);
  if (!skip.has('mixed')) checkMixedLevels(ctx);
  if (!skip.has('constraints')) checkTimingConstraints(ctx);
  buildZones(ctx);
  if (!skip.has('zones')) checkZones(ctx);
  const constraints = skip.has('constraints') ? [] : evaluateConstraints(ctx);

  const order: Record<Severity, number> = { [Severity.Error]: 0, [Severity.Warning]: 1, [Severity.Info]: 2 };
  const findings = ctx.findings.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code) || a.title.localeCompare(b.title));

  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const f of findings) {
    if (f.severity === Severity.Error) counts.errors++;
    else if (f.severity === Severity.Warning) counts.warnings++;
    else counts.infos++;
  }

  notes.push(`Analysed ${nl.instances.length} component(s), ${nl.elementCount} element(s) and ${nl.nodeCount} net(s) at ${stats.hierarchyDepth} level(s) of hierarchy.`);
  if (graph && graph.elements.length > 0) notes.push(`Level 0: ${logicSummary(graph)}.`);
  if (timing) {
    notes.push(
      `Timing model ${model.id} (${model.name}): ${model.description} No wire delay, no load-dependent delay, no clock skew, no hold analysis.`,
    );
  }
  if (options.sim) notes.push('Power and temperature were measured on the operating point of the supplied simulator.');
  else if (stats.thermal) notes.push('The circuit has a thermal network, but no solved simulator was supplied: temperatures are not reported.');
  notes.push('The analyzer reads the flattened netlist only: it never rewrites the design.');

  const diagnostics: Diagnostic[] = [];
  if (graph) diagnostics.push(...graph.diagnostics);
  if (timing) diagnostics.push(...timing.diagnostics);
  diagnostics.push(...nl.diagnostics);

  return {
    name: nl.name,
    fingerprint: nl.fingerprint,
    ms: Date.now() - t0,
    findings,
    counts,
    stats,
    instances,
    specs,
    timing: {
      criticalPath:
        timing && timing.criticalPath
          ? {
              delay: timing.criticalPath.delay,
              stages: timing.criticalPath.stages,
              idealStages: timing.criticalPath.idealStages,
              startNet: netName(nl, timing.criticalPath.startNet),
              endNet: netName(nl, timing.criticalPath.endNet),
              startKind: timing.criticalPath.startKind,
              endKind: timing.criticalPath.endKind,
              setup: timing.criticalPath.setup,
              chain: timing.criticalPath.steps.map((s) =>
                s.element ? `${elementLabel(s.element)} +${(s.delay * NS).toFixed(3)} ns → ${netName(nl, s.toNet)}` : `start ${netName(nl, s.fromNet)} (${timing!.criticalPath!.startKind})`,
              ),
            }
          : null,
      clockPeriod: timing ? timing.clockPeriod : null,
      maxFrequency: timing ? timing.maxFrequency : null,
      combinationalDelay: timing ? timing.combinationalDelay : null,
      danglingNets: timing ? timing.danglingNets.length : 0,
      idealElements: timing ? timing.idealDelays.length : 0,
      description: timing && timing.criticalPath ? describePath(timing.criticalPath, (n) => netName(nl, n)) : null,
    },
    zones: { slow: ctx.zonesSlow, hot: ctx.zonesHot, power: ctx.zonesPower },
    constraints,
    timingModel: { id: model.id, name: model.name, description: model.description },
    summary: buildSummary(nl, stats, findings, counts, timing),
    notes,
    diagnostics,
  };
}

/** Flatten a circuit and analyse it (the convenience entry point). */
export function analyzeCircuit(
  circuit: Circuit,
  lib: Library,
  chips: ChipLibrary,
  options: AnalyzeOptions & { flatten?: Parameters<typeof flatten>[3] } = {},
): AnalyzeReport {
  const nl = flatten(circuit, lib, chips, options.flatten ?? {});
  return analyzeNetlist(nl, { lib, ...options });
}

/** The analysis as structured diagnostics (console, CLI, GUI problems panel). */
export function reportToDiagnostics(report: AnalyzeReport): Diagnostic[] {
  return report.findings.map((f) => {
    const target = f.subject ? { type: f.subject.type, id: f.subject.id ?? f.subject.name, name: f.subject.name } : undefined;
    const message = `${f.title} — ${f.detail}`;
    if (f.severity === Severity.Error) return error(f.code, message, { target, hint: f.recommendation, data: f.metrics });
    if (f.severity === Severity.Warning) return warn(f.code, message, { target, hint: f.recommendation, data: f.metrics });
    return info(f.code, message, { target, data: f.metrics });
  });
}

/** Human-readable report (the CLI prints exactly this). */
export function analysisToText(report: AnalyzeReport, opts: { verbose?: boolean } = {}): string {
  const lines = report.summary.split('\n');
  if (opts.verbose) {
    for (const f of report.findings) {
      lines.push('');
      lines.push(`[${f.severity.toUpperCase()}] ${f.code} ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.metrics && Object.keys(f.metrics).length > 0) lines.push(`  measured: ${Object.entries(f.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      for (const e of f.evidence ?? []) lines.push(`  · ${e}`);
      if (f.recommendation) lines.push(`  → ${f.recommendation}`);
      if (f.scope) lines.push(`  scope: ${f.scope}`);
    }
  }
  if (report.constraints.length > 0) {
    lines.push('');
    lines.push('Constraints:');
    for (const c of report.constraints) {
      const verdict = c.pass === null ? 'NOT MEASURED' : c.pass ? 'pass' : 'FAIL';
      lines.push(`  ${c.name}: limit ${c.limit}${c.unit ? ` ${c.unit}` : ''}, measured ${c.measured ?? 'n/a'} → ${verdict}${c.reason ? ` (${c.reason})` : ''}`);
    }
  }
  lines.push('');
  lines.push(...report.notes.map((n) => `· ${n}`));
  return lines.join('\n');
}

function buildSummary(
  nl: FlatNetlist,
  stats: CircuitStats,
  findings: Finding[],
  counts: { errors: number; warnings: number; infos: number },
  timing: TimingReport | null,
): string {
  const lines: string[] = [];
  lines.push(`Analysis of ${nl.name} (fingerprint ${nl.fingerprint})`);
  lines.push('');
  lines.push(`${stats.instances} component(s), ${stats.distinctSpecs} type(s), ${stats.elements} element(s), ${stats.nets} net(s), hierarchy depth ${stats.hierarchyDepth}.`);
  if (stats.logic) lines.push(`Level 0: ${stats.logic.summary}.`);
  if (stats.fanout) lines.push(`Fan-out: max ${stats.fanout.max}, average ${stats.fanout.average.toFixed(2)}, ${stats.fanout.dangling} net(s) with no consumer.`);
  if (timing && timing.criticalPath) lines.push(`Critical path: ${fmtNs(timing.criticalPath.delay)} over ${timing.criticalPath.stages} stage(s), ending on ${nodeNameAt(nl, timing.criticalPath.endNet)}.`);
  if (timing && timing.clockPeriod !== null) lines.push(`Clock bound: period ≥ ${fmtNs(timing.clockPeriod)} (≤ ${((timing.maxFrequency ?? 0) / 1e6).toFixed(3)} MHz).`);
  if (stats.timing && stats.timing.combinationalDelay !== null) lines.push(`Combinational delay (input → output): ${fmtNs(stats.timing.combinationalDelay)}.`);
  if (stats.electrical.totalDissipated !== null) {
    // The net sum of the absorbed powers is ~0 by construction (Kirchhoff), so it
    // is never the number a user wants: report the *gross* dissipation, and say
    // how much the sources delivered to feed it.
    const delivered = stats.electrical.totalSupplied !== null ? ` (sources deliver ${formatPower(stats.electrical.totalSupplied)})` : '';
    // "above 1 nW" is part of the statement: leakage in the fW range is measured
    // too, and counting it as a dissipating element would overstate the circuit.
    lines.push(
      `Dissipation: ${formatPower(stats.electrical.totalDissipated)} in ${stats.electrical.dissipatingElements} element(s) above 1 nW${delivered}.`,
    );
    const supplied = stats.electrical.totalSupplied;
    const dissipated = stats.electrical.totalDissipated;
    if (supplied !== null && dissipated !== null) {
      const imbalance = supplied - dissipated;
      const scale = Math.max(supplied, dissipated, 1e-12);
      if (Math.abs(imbalance) / scale > 1e-2) {
        lines.push(
          `Power balance: sources deliver ${formatPower(supplied)} but modelled loads absorb ${formatPower(dissipated)} — the totals do not close, so read them as measurements, not as a budget.`,
        );
      }
    }
  }
  if (stats.thermal && stats.thermal.maxTemperature !== null) lines.push(`Hottest junction: ${stats.thermal.maxTemperature.toFixed(2)} °C (ambient ${stats.thermal.ambient} °C).`);
  lines.push('');
  lines.push(`${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.infos} information item(s).`);
  if (findings.length > 0) {
    lines.push('');
    for (const f of findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code} ${f.title}`);
  }
  return lines.join('\n');
}

export { fmtNs, kindLabel, elementLabel };
