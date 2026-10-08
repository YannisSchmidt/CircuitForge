/**
 * Static timing analysis (STA) of a level-0 logic graph.
 *
 * The engine computes, for every net, the worst-case arrival time of a rising
 * and of a falling transition, starting from primary inputs (time 0) and from
 * register outputs (time = clock-to-Q of the register). From that it derives:
 *
 *   - the critical path, as the *actual chain of elements* (not just a number),
 *     with the per-element delay that was used;
 *   - the bound on the clock period for a synchronous design:
 *     `period >= tckq + tcomb.max + setup`;
 *   - the worst combinational delay for a purely combinational circuit.
 *
 * Honest scope (this is what the report says, always):
 *   - delays are the ones **declared by each element** (`tphl` / `tplh`, and
 *     `tckq` + `setup` for registers). The engine never invents a delay: if a
 *     model declares 0, the element contributes 0 and is listed as
 *     `idealDelays`. A path made only of such elements is a *lower bound*;
 *   - no wire delay, no load-dependent delay, no slew degradation, no clock
 *     tree skew, no hold analysis, no false-path or multi-cycle exceptions;
 *   - unateness is the classic one: buf/and/or/tristate are positive unate,
 *     not/nand/nor negative unate, xor/xnor/mux/demux non-unate (both
 *     polarities are considered, which is conservative);
 *   - a combinational loop has no finite arrival time: the elements in a loop are
 *     excluded and reported, never silently assigned a made-up delay.
 */

import { LOGIC_FN, type LogicElement, type LogicGraph } from './logic.js';
import { warn, type Diagnostic } from '../core/labels.js';

export type EdgeKind = 'rise' | 'fall';

export interface TimingElementDelay {
  /** Worst-case propagation delay, low→high output transition (seconds). */
  tplh: number;
  /** Worst-case propagation delay, high→low output transition (seconds). */
  tphl: number;
}

/**
 * Supply the delay of an element. The default model reads the delays that the
 * netlist carries (they come from the component parameters), so a designer can
 * change them without touching the engine.
 */
export type TimingModel = (el: LogicElement, edge: EdgeKind) => number;

/** Per-element delay from the netlist parameters (the default model). */
export const declaredTimingModel: TimingModel = (el, edge) => (edge === 'rise' ? el.tplh : el.tphl);

export interface TimingPathStep {
  /** Element on the path (null for the start of the path). */
  element: LogicElement | null;
  /** Net entering this step. */
  fromNet: number;
  /** Net leaving this step. */
  toNet: number;
  /** Transition of the output of this step. */
  edge: EdgeKind;
  /** Delay contributed by this step (seconds). */
  delay: number;
  /** Arrival time at the output of this step, relative to the start (seconds). */
  arrival: number;
  /**
   * True when the delay of this element comes from a declaration of zero (an
   * ideal, instantaneous model) — the total is then a lower bound.
   */
  ideal: boolean;
}

export interface TimingPath {
  /** Chain of steps, start → end. */
  steps: TimingPathStep[];
  /** Total delay (seconds); equals the arrival time of the last step. */
  delay: number;
  /** Net the path starts on (a primary input or a register output). */
  startNet: number;
  /** Net the path ends on (a register D input or a primary output). */
  endNet: number;
  /** How the path starts. */
  startKind: 'input' | 'register';
  /** What the path ends on. */
  endKind: 'register' | 'output' | 'internal';
  /** Number of elements on the path. */
  stages: number;
  /** Number of elements on the path whose declared delay is 0. */
  idealStages: number;
  /** Setup time that must be added at the end (register to register path). */
  setup: number;
}

export interface TimingReport {
  /** Worst-case arrival time per net, rising output transition (s). */
  arrivalRise: Float64Array;
  /** Worst-case arrival time per net, falling output transition (s). */
  arrivalFall: Float64Array;
  /** Longest combinational path in the design. */
  criticalPath: TimingPath | null;
  /** Longest path that starts at a register output and ends on a register D. */
  criticalRegisterPath: TimingPath | null;
  /**
   * Lower bound of the synchronous clock period:
   * max over registers of (arrival(D) + setup). Null for a circuit without
   * registers (there is no clock to constrain).
   */
  clockPeriod: number | null;
  /** Lower bound of the maximum clock frequency, 1/clockPeriod, or null. */
  maxFrequency: number | null;
  /** Worst arrival at a primary output (combinational delay), or null. */
  combinationalDelay: number | null;
  /** Elements whose declared delay is 0 for both edges (ideal / not modelled). */
  idealDelays: LogicElement[];
  /** Elements that declare a delay only for one edge. */
  partialDelays: LogicElement[];
  /** Nets with no finite arrival (undriven, or fed only by a loop). */
  danglingNets: number[];
  diagnostics: Diagnostic[];
}

const NEG_INF = -Infinity;

/**
 * Remove the binary accumulation error of the max-plus relaxation.
 *
 * Arrival times are sums of declared gate delays, and 0.2 ns + 0.4 ns is not
 * exactly 0.6 ns in binary floating point: an eight-stage path reported as
 * 6.399999999999999 ns is that artefact, not a measurement. No model in the
 * library declares a delay finer than a picosecond, so rounding the relaxed
 * arrivals to the nearest picosecond cannot change which path is the longest,
 * and it keeps the numbers a report quotes equal to the numbers it prints.
 */
const PS = 1e-12;
function quantize(seconds: number): number {
  return seconds > NEG_INF && Number.isFinite(seconds) ? Math.round(seconds / PS) * PS : seconds;
}

/** Unateness of a gate function: how an input transition maps to an output one. */
export function gatePolarity(el: LogicElement): 'positive' | 'negative' | 'non-unate' {
  switch (el.kind) {
    case 'gate':
      switch (el.fn) {
        case LOGIC_FN.BUF:
        case LOGIC_FN.AND:
        case LOGIC_FN.OR:
          return 'positive';
        case LOGIC_FN.NOT:
        case LOGIC_FN.NAND:
        case LOGIC_FN.NOR:
          return 'negative';
        default:
          return 'non-unate'; // xor / xnor
      }
    case 'tristate':
      return 'positive'; // the data path is a buffer; the enable is handled as a control
    case 'mux':
    case 'demux':
      return 'non-unate';
    default:
      return 'non-unate';
  }
}

/**
 * Worst-case arrival times over the combinational cloud of a logic graph.
 *
 * `opts.model` replaces the delay model (for a technology-specific study);
 * `opts.clockToQ` overrides the register clock-to-Q used as the start time of
 * register outputs; `opts.setup` overrides the register setup used at the end of
 * a register-to-register path.
 */
export function analyzeTiming(
  graph: LogicGraph,
  opts: { model?: TimingModel; clockToQ?: (el: LogicElement) => number; setup?: (el: LogicElement) => number } = {},
): TimingReport {
  const model = opts.model ?? declaredTimingModel;
  // A register's clock-to-Q is stored as its propagation delay: output Q starts
  // `tckq` after the active clock edge.
  const clockToQ = opts.clockToQ ?? ((el: LogicElement) => Math.max(el.tplh, el.tphl));
  // Setup time declared by the capturing register itself (DFF_SLOTS.setup).
  const setupOf = opts.setup ?? ((el: LogicElement) => Math.max(0, el.setup));
  const netCount = graph.netCount;
  const rise = new Float64Array(netCount).fill(NEG_INF);
  const fall = new Float64Array(netCount).fill(NEG_INF);
  // Predecessor links for path reconstruction: for each net and each edge, the
  // element and input net that produced the arrival.
  const prevEl = new Int32Array(netCount * 2).fill(-1);
  const prevNet = new Int32Array(netCount * 2).fill(-1);
  const prevEdge = new Uint8Array(netCount * 2); // 0 = rise at the predecessor, 1 = fall
  const startKind = new Uint8Array(netCount * 2); // 0 = none, 1 = input, 2 = register

  const diagnostics: Diagnostic[] = [];
  const idealDelays: LogicElement[] = [];
  const partialDelays: LogicElement[] = [];
  for (const el of graph.elements) {
    if (el.kind === 'dff' || el.kind === 'latch') continue;
    const hasRise = el.tplh > 0;
    const hasFall = el.tphl > 0;
    if (!hasRise && !hasFall) idealDelays.push(el);
    else if (!hasRise || !hasFall) partialDelays.push(el);
  }
  if (idealDelays.length > 0) {
    diagnostics.push(
      warn(
        'CF7101',
        `${idealDelays.length} logic element(s) declare no propagation delay (0 s): the timing report is a lower bound`,
        {
          hint: 'Set tphl/tplh on the component instances (or use a cell library that declares them) for a physical timing budget.',
          data: { elements: idealDelays.slice(0, 8).map((el) => el.ref) },
        },
      ),
    );
  }

  // ---- start points ---------------------------------------------------------
  for (const net of graph.inputs) {
    if (net <= 0 || net >= netCount) continue;
    rise[net] = 0;
    fall[net] = 0;
    startKind[net * 2] = 1;
    startKind[net * 2 + 1] = 1;
  }
  for (const el of graph.elements) {
    if (el.kind === 'gate' && el.inputs.length === 0) {
      // A constant source drives its net from t = 0, with no delay of its own.
      const out = el.outputs[0];
      if (out > 0 && out < netCount) {
        rise[out] = 0;
        fall[out] = 0;
        startKind[out * 2] = 1;
        startKind[out * 2 + 1] = 1;
      }
      continue;
    }
    if (el.kind !== 'dff' && el.kind !== 'latch') continue;
    const t = Math.max(0, clockToQ(el));
    for (const out of el.outputs) {
      if (out <= 0 || out >= netCount) continue;
      // Q rises after the clock edge; QN falls. Both start the same path length
      // for the sake of the period bound, so the same time is used for both.
      rise[out] = t;
      fall[out] = t;
      startKind[out * 2] = 2;
      startKind[out * 2 + 1] = 2;
    }
  }

  // ---- sweep in topological order ------------------------------------------
  const loopSet = new Set<LogicElement>(graph.loopElements);
  const byLevel: LogicElement[][] = [];
  for (const el of graph.elements) {
    if (el.kind === 'dff' || el.kind === 'latch' || loopSet.has(el)) continue;
    (byLevel[el.level] ?? (byLevel[el.level] = [])).push(el);
  }
  const arrive = (net: number, edge: EdgeKind): number =>
    net <= 0 || net >= netCount ? NEG_INF : edge === 'rise' ? rise[net] : fall[net];

  for (const list of byLevel) {
    if (!list) continue;
    for (const el of list) {
      const polarity = gatePolarity(el);
      let inRise = NEG_INF;
      let inFall = NEG_INF;
      let bestRiseNet = -1;
      let bestFallNet = -1;
      const readNets = el.inputs.concat(el.selects);
      for (const net of readNets) {
        const r = arrive(net, 'rise');
        if (r > inRise) {
          inRise = r;
          bestRiseNet = net;
        }
        const f = arrive(net, 'fall');
        if (f > inFall) {
          inFall = f;
          bestFallNet = net;
        }
      }
      if (el.kind === 'tristate' && el.enable >= 0) {
        const r = arrive(el.enable, 'rise');
        if (r > inRise) {
          inRise = r;
          bestRiseNet = el.enable;
        }
        const f = arrive(el.enable, 'fall');
        if (f > inFall) {
          inFall = f;
          bestFallNet = el.enable;
        }
      }
      // The output transition that a given input transition can cause depends on
      // the unateness of the element.
      let outRise = NEG_INF;
      let outFall = NEG_INF;
      let riseFrom: { net: number; edge: EdgeKind } | null = null;
      let fallFrom: { net: number; edge: EdgeKind } | null = null;
      const tplh = Math.max(0, model(el, 'rise'));
      const tphl = Math.max(0, model(el, 'fall'));
      if (polarity === 'positive') {
        if (inRise > NEG_INF) {
          outRise = inRise + tplh;
          riseFrom = { net: bestRiseNet, edge: 'rise' };
        }
        if (inFall > NEG_INF) {
          outFall = inFall + tphl;
          fallFrom = { net: bestFallNet, edge: 'fall' };
        }
      } else if (polarity === 'negative') {
        if (inFall > NEG_INF) {
          outRise = inFall + tplh;
          riseFrom = { net: bestFallNet, edge: 'fall' };
        }
        if (inRise > NEG_INF) {
          outFall = inRise + tphl;
          fallFrom = { net: bestRiseNet, edge: 'rise' };
        }
      } else {
        const worst = Math.max(inRise, inFall);
        const from = inRise >= inFall ? { net: bestRiseNet, edge: 'rise' as EdgeKind } : { net: bestFallNet, edge: 'fall' as EdgeKind };
        if (worst > NEG_INF) {
          outRise = worst + tplh;
          outFall = worst + tphl;
          riseFrom = from;
          fallFrom = from;
        }
      }
      for (const out of el.outputs) {
        if (out <= 0 || out >= netCount) continue;
        if (outRise > rise[out]) {
          rise[out] = outRise;
          prevEl[out * 2] = el.index;
          prevNet[out * 2] = riseFrom?.net ?? -1;
          prevEdge[out * 2] = riseFrom?.edge === 'fall' ? 1 : 0;
          startKind[out * 2] = 0;
        }
        if (outFall > fall[out]) {
          fall[out] = outFall;
          prevEl[out * 2 + 1] = el.index;
          prevNet[out * 2 + 1] = fallFrom?.net ?? -1;
          prevEdge[out * 2 + 1] = fallFrom?.edge === 'fall' ? 1 : 0;
          startKind[out * 2 + 1] = 0;
        }
      }
    }
  }

  // One quantisation pass over the relaxed arrivals, before anything reads them:
  // paths, the clock period and the combinational delay are all derived from here,
  // so this is the single place the rounding has to happen.
  for (let net = 1; net < netCount; net++) {
    rise[net] = quantize(rise[net]);
    fall[net] = quantize(fall[net]);
  }

  // ---- reconstruct a path backwards ----------------------------------------
  const elementByIndex = (i: number): LogicElement | null => (i >= 0 && i < graph.elements.length ? graph.elements[i] : null);
  const buildPath = (endNet: number, endEdge: EdgeKind, endKind: TimingPath['endKind'], setup: number): TimingPath | null => {
    const key = (net: number, edge: EdgeKind): number => net * 2 + (edge === 'fall' ? 1 : 0);
    let net = endNet;
    let edge = endEdge;
    const steps: TimingPathStep[] = [];
    let guard = 0;
    let start = net;
    let startIsInput = startKind[key(net, edge)] === 1;
    while (guard++ < graph.elements.length + 2) {
      const elIndex = prevEl[key(net, edge)];
      if (elIndex < 0) break;
      const el = elementByIndex(elIndex);
      if (!el) break;
      const fromNet = prevNet[key(net, edge)];
      const fromEdge: EdgeKind = prevEdge[key(net, edge)] === 1 ? 'fall' : 'rise';
      const delay = Math.max(0, model(el, edge));
      const arrival = (edge === 'rise' ? rise[net] : fall[net]) - (fromNet > 0 && fromNet < netCount ? (fromEdge === 'rise' ? rise[fromNet] : fall[fromNet]) : 0);
      steps.push({
        element: el,
        fromNet,
        toNet: net,
        edge,
        delay,
        arrival,
        ideal: delay === 0,
      });
      start = fromNet;
      startIsInput = startKind[key(fromNet, fromEdge)] === 1;
      net = fromNet;
      edge = fromEdge;
    }
    if (steps.length === 0) return null;
    steps.reverse();
    // Recompute arrivals from the start so the numbers are cumulative and exact.
    let acc = 0;
    for (const step of steps) {
      acc = quantize(acc + step.delay);
      step.arrival = acc;
    }
    const idealStages = steps.filter((s) => s.ideal).length;
    return {
      steps,
      delay: acc,
      startNet: start,
      endNet,
      startKind: startIsInput ? 'input' : 'register',
      endKind,
      stages: steps.length,
      idealStages,
      setup,
    };
  };

  // ---- pick the critical path ----------------------------------------------
  const candidates: { path: TimingPath; score: number }[] = [];
  const isRegisterInput = new Map<number, LogicElement>();
  for (const el of graph.elements) {
    if (el.kind === 'dff' || el.kind === 'latch') isRegisterInput.set(el.inputs[0], el);
  }
  for (const [net, reg] of isRegisterInput) {
    const setup = Math.max(0, setupOf(reg));
    if (rise[net] > NEG_INF) {
      const p = buildPath(net, 'rise', 'register', setup);
      if (p) candidates.push({ path: p, score: rise[net] + setup });
    }
    if (fall[net] > NEG_INF) {
      const p = buildPath(net, 'fall', 'register', setup);
      if (p) candidates.push({ path: p, score: fall[net] + setup });
    }
  }
  for (const net of graph.outputs) {
    if (net <= 0 || net >= netCount) continue;
    if (rise[net] > NEG_INF) {
      const p = buildPath(net, 'rise', 'output', 0);
      if (p) candidates.push({ path: p, score: rise[net] });
    }
    if (fall[net] > NEG_INF) {
      const p = buildPath(net, 'fall', 'output', 0);
      if (p) candidates.push({ path: p, score: fall[net] });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const registerCandidates = candidates.filter((c) => c.path.endKind === 'register');
  const criticalPath = candidates[0]?.path ?? null;
  const criticalRegisterPath = registerCandidates[0]?.path ?? null;

  let clockPeriod: number | null = null;
  for (const [, reg] of isRegisterInput) {
    const setup = Math.max(0, setupOf(reg));
    const d = reg.inputs[0];
    if (d <= 0 || d >= netCount) continue;
    const worst = Math.max(rise[d], fall[d]);
    if (worst <= NEG_INF) continue;
    const period = quantize(worst + setup);
    if (clockPeriod === null || period > clockPeriod) clockPeriod = period;
  }
  if (clockPeriod === null && criticalRegisterPath) {
    clockPeriod = quantize(criticalRegisterPath.delay + criticalRegisterPath.setup);
  }

  let combinationalDelay: number | null = null;
  for (const net of graph.outputs) {
    if (net <= 0 || net >= netCount) continue;
    const worst = Math.max(rise[net], fall[net]);
    if (worst <= NEG_INF) continue;
    if (combinationalDelay === null || worst > combinationalDelay) combinationalDelay = worst;
  }

  const danglingNets: number[] = [];
  for (let net = 1; net < netCount; net++) {
    if (rise[net] > NEG_INF || fall[net] > NEG_INF) continue;
    if (graph.driverCount[net] > 0) danglingNets.push(net);
  }
  if (danglingNets.length > 0) {
    diagnostics.push(
      warn('CF7102', `${danglingNets.length} net(s) have no finite arrival time (undriven, or fed only by a combinational loop)`, {
        hint: 'An undriven net reads X at level 0; a loop has no arrival time at all.',
        data: { nets: danglingNets.slice(0, 8).map((n) => graph.netName(n)) },
      }),
    );
  }

  return {
    arrivalRise: rise,
    arrivalFall: fall,
    criticalPath,
    criticalRegisterPath,
    clockPeriod,
    maxFrequency: clockPeriod && clockPeriod > 0 ? 1 / clockPeriod : null,
    combinationalDelay,
    idealDelays,
    partialDelays,
    danglingNets,
    diagnostics,
  };
}

/** Human-readable one-liner of the critical path (used by the CLI and reports). */
export function describePath(path: TimingPath | null, netName: (net: number) => string): string {
  if (!path) return 'no path';
  const chain = path.steps.map((s) => `${s.element?.ref ?? '?'}(${formatSeconds(s.delay)})`).join(' → ');
  return `${formatSeconds(path.delay)} from ${netName(path.startNet)} → ${chain} → ${netName(path.endNet)}`;
}

function formatSeconds(s: number): string {
  if (s === 0) return '0';
  if (Math.abs(s) < 1e-9) return `${(s * 1e12).toFixed(2)} ps`;
  if (Math.abs(s) < 1e-6) return `${(s * 1e9).toFixed(3)} ns`;
  if (Math.abs(s) < 1e-3) return `${(s * 1e6).toFixed(3)} µs`;
  return `${(s * 1e3).toFixed(3)} ms`;
}
