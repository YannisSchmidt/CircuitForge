/**
 * Level-0 logic engine.
 *
 * The digital part of a flattened circuit is evaluated with four-state logic
 * (0 / 1 / X / Z) **bit-parallel**: 32 input vectors are propagated per pass, one
 * bit per vector, so a 32-row truth table costs the same as a single simulation.
 * This is the tier-0 filter of the synthesis pipeline and the exhaustive
 * validation engine ("exhaustive for small circuits").
 *
 * What it models, precisely:
 *   - ideal gates with the function stored by the netlist lowerer (buffer, not,
 *     and, nand, or, nor, xor, xnor), any number of inputs, plus tristate
 *     buffers with a shared enable;
 *   - D flip-flops (edge, optional asynchronous reset, optional initial value),
 *     transparent latches, multiplexers, demultiplexers and decoders;
 *   - unknown (X) and high-impedance (Z) propagation: a Z input to a gate reads
 *     as X, two drivers that disagree give X, an undriven net is X, two tristate
 *     drivers on one bus resolve to the one that is enabled and to X when both
 *     are on.
 *
 * What it does **not** model (documented, and reported through the graph):
 *   - analogue elements: they are counted and skipped, and never influence a
 *     logic value here. Use the electrical solver (level 1) for those;
 *   - propagation delay / rise / fall / setup / hold: those live in `timing.ts`
 *     (event-driven with real delays). This engine is symmetric in time: it
 *     computes the *settled* value long after every transient has died out.
 */

import { Kind } from '../core/kinds.js';
import { profiler } from '../util/profiler.js';
import { CircuitForgeError, warn, type Diagnostic } from '../core/labels.js';
import type { FlatNetlist } from '../sim/netlist.js';
import { DFF_SLOTS, GATE_SLOTS, MUX_SLOTS, NODE_STRIDE } from '../sim/paramslots.js';

export const LOGIC_FN = {
  BUF: 0,
  NOT: 1,
  AND: 2,
  NAND: 3,
  OR: 4,
  NOR: 5,
  XOR: 6,
  XNOR: 7,
  /** TRISTATE is a *kind* in the netlist; the value exists for symmetry. */
  TRISTATE: 8,
  /** Level-0 sources: a constant one and a constant zero, no input. */
  CONST_HIGH: 9,
  CONST_LOW: 10,
} as const;

export type LogicKind = 'gate' | 'tristate' | 'dff' | 'latch' | 'mux' | 'demux';

export interface LogicElement {
  /** Slot of this element inside `LogicGraph.elements`. */
  index: number;
  /** Element index in the flat netlist. */
  element: number;
  kind: LogicKind;
  /** Gate function (LOGIC_FN) for gate-like elements. */
  fn: number;
  /** Input nets (node indices): the data inputs for every kind. */
  inputs: number[];
  /** Output nets: gates/mux → [Y]; demux → [Y0..Yn-1]; dff → [Q, QN]. */
  outputs: number[];
  /** Tristate enable net, -1 when the element is not a tristate. */
  enable: number;
  /** Clock net (dff) / enable net (latch), -1 otherwise. */
  clk: number;
  /** Setup time of a register (seconds): 0 for combinational elements. */
  setup: number;
  /** Asynchronous reset net, -1 when absent. */
  rst: number;
  rstLow: boolean;
  falling: boolean;
  /** 0 = initial low, 1 = initial high, 2 = unknown. */
  initial: number;
  /** Select nets (mux/demux), least significant first (`selects[0]` = S0). */
  selects: number[];
  /** Decoder mode: the outputs are the decoded address and the input is an enable. */
  decoder: boolean;
  channels: number;
  activeLow: boolean;
  /** Nominal propagation delays (seconds); used by the timing engine. */
  tphl: number;
  tplh: number;
  /** Topological level (0 = driven only by registers / primary inputs). */
  level: number;
  /** Instance index in the flat netlist, for reporting. */
  instance: number;
  /** Reference designator, for reporting. */
  ref: string;
}

export interface LogicGraph {
  netlist: FlatNetlist;
  /** Number of nets (nodes) of the flat netlist. */
  netCount: number;
  elements: LogicElement[];
  /** Number of drivers per net (0 = undriven). */
  driverCount: Int32Array;
  /** Input port nets. */
  inputs: number[];
  /** Output port nets. */
  outputs: number[];
  /** Net names, path-qualified, for reports. */
  netName: (node: number) => string;
  /** Elements that could not be levelled (they sit in a combinational loop). */
  loopElements: LogicElement[];
  stats: {
    gates: number;
    sequential: number;
    levels: number;
    /** Non-digital elements that were ignored (they cannot drive logic). */
    ignoredElements: number;
    /** Elements in a combinational loop. */
    loops: number;
  };
  diagnostics: Diagnostic[];
}

const DIGITAL_KINDS = new Set<number>([
  Kind.LogicGate,
  Kind.LogicBuf,
  Kind.TriState,
  Kind.DFlipFlop,
  Kind.DLatch,
  Kind.Mux,
  Kind.Demux,
]);

/**
 * Build the level-0 view of a netlist: the digital elements, the nets they touch
 * and a topological level for each element. Register outputs start a new level,
 * so feedback through a register is legal and only purely combinational feedback
 * counts as a loop.
 */
export function buildLogicGraph(nl: FlatNetlist): LogicGraph {
  const diagnostics: Diagnostic[] = [];
  const params = nl.params;
  const nodes = nl.nodes;
  const elements: LogicElement[] = [];
  let ignoredElements = 0;

  for (let e = 0; e < nl.elementCount; e++) {
    const kind = nl.kind[e];
    if (!DIGITAL_KINDS.has(kind)) {
      ignoredElements++;
      continue;
    }
    const o = nl.paramOffset[e];
    const nc = nl.nodeCountPerElement[e];
    const n = nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nc);
    const instance = nl.instIndex[e];
    const ref = nl.instances[instance]?.ref ?? `#${e}`;
    const common = {
      index: elements.length,
      element: e,
      enable: -1,
      clk: -1,
      setup: 0,
      rst: -1,
      rstLow: false,
      falling: false,
      initial: 0,
      selects: [] as number[],
      channels: 0,
      decoder: false,
      activeLow: params[o + GATE_SLOTS.activeLow] > 0.5,
      tphl: 0,
      tplh: 0,
      level: 0,
      instance,
      ref,
    };
    if (kind === Kind.LogicGate || kind === Kind.LogicBuf || kind === Kind.TriState) {
      const inputCount = nc - 1;
      const raw: number[] = [];
      for (let i = 0; i < inputCount; i++) raw.push(n[i]);
      const isTristate = kind === Kind.TriState;
      // A tristate's last input is the enable, not a data input of the function.
      const dataInputs = isTristate ? raw.slice(0, Math.max(1, raw.length - 1)) : raw;
      elements.push({
        ...common,
        kind: isTristate ? 'tristate' : 'gate',
        fn: isTristate ? LOGIC_FN.TRISTATE : params[o + GATE_SLOTS.fn],
        inputs: dataInputs,
        outputs: [n[nc - 1]],
        enable: isTristate ? raw[raw.length - 1] ?? -1 : -1,
        tphl: params[o + GATE_SLOTS.tphl],
        tplh: params[o + GATE_SLOTS.tplh],
      });
      continue;
    }
    if (kind === Kind.DFlipFlop) {
      elements.push({
        ...common,
        kind: 'dff',
        fn: LOGIC_FN.BUF,
        inputs: [n[0]],
        outputs: [n[3], n[4]],
        clk: n[1],
        rst: n[2],
        rstLow: params[o + DFF_SLOTS.resetLow] > 0.5,
        falling: params[o + DFF_SLOTS.falling] > 0.5,
        initial: params[o + DFF_SLOTS.initial],
        setup: Math.max(0, params[o + DFF_SLOTS.setup]),
        tphl: params[o + DFF_SLOTS.tckq],
        tplh: params[o + DFF_SLOTS.tckq],
      });
      continue;
    }
    if (kind === Kind.DLatch) {
      elements.push({
        ...common,
        kind: 'latch',
        fn: LOGIC_FN.BUF,
        inputs: [n[0]],
        outputs: [n[2]],
        clk: n[1],
        initial: params[o + DFF_SLOTS.initial],
      });
      continue;
    }
    // Mux:      [I0..I(ch-1), S.., Y]
    // Demux:    [IN, S.., Y0..Y(ch-1)]
    const channels = Math.max(1, Math.round(params[o + MUX_SLOTS.channels]));
    const selectBits = Math.max(1, Math.round(params[o + MUX_SLOTS.selectBits]));
    const mode = Math.round(params[o + MUX_SLOTS.mode]);
    const isDemux = mode === 1 || mode === 2;
    const dataCount = isDemux ? 1 : channels;
    const dataNets: number[] = [];
    for (let i = 0; i < dataCount; i++) dataNets.push(n[i]);
    const selects: number[] = [];
    for (let i = 0; i < selectBits; i++) selects.push(n[dataCount + i]);
    const outStart = dataCount + selectBits;
    const outputs: number[] = [];
    if (isDemux) {
      for (let i = 0; i < channels && outStart + i < nc; i++) outputs.push(n[outStart + i]);
    } else {
      outputs.push(n[outStart]);
    }
    elements.push({
      ...common,
      kind: isDemux ? 'demux' : 'mux',
      decoder: mode === 2,
      fn: LOGIC_FN.BUF,
      inputs: dataNets,
      selects,
      channels,
      outputs,
      tphl: params[o + MUX_SLOTS.tphl],
      tplh: params[o + MUX_SLOTS.tplh],
    });
    continue;
  }

  // ---- drivers per net ------------------------------------------------------
  const netCount = nl.nodeCount;
  const driverCount = new Int32Array(netCount);
  const driversOf = new Map<number, LogicElement[]>();
  for (const el of elements) {
    for (const out of el.outputs) {
      if (out < 0 || out >= netCount) continue;
      driverCount[out]++;
      let list = driversOf.get(out);
      if (!list) driversOf.set(out, (list = []));
      list.push(el);
    }
  }

  // ---- topological levels ---------------------------------------------------
  // A register output is the start of a new level: its value comes from the
  // previous tick, which is exactly what makes feedback legal.
  // A constant-level element (fn 9/10) has no input: it is a start point of the
  // combinational cloud, so nothing may be levelled before it.
  const seqOutput = new Uint8Array(netCount);
  for (const el of elements) {
    if (el.kind === 'dff' || el.kind === 'latch') for (const out of el.outputs) if (out >= 0) seqOutput[out] = 1;
  }

  const depsLeft = new Map<LogicElement, number>();
  const dependents = new Map<LogicElement, LogicElement[]>();
  for (const el of elements) depsLeft.set(el, 0);
  for (const el of elements) {
    if (el.kind === 'dff' || el.kind === 'latch') continue;
    const readNets = el.inputs.concat(el.selects, el.kind === 'tristate' ? [el.enable] : []);
    const seenDrivers = new Set<LogicElement>();
    for (const net of readNets) {
      if (net < 0 || net >= netCount || seqOutput[net]) continue;
      for (const driver of driversOf.get(net) ?? []) {
        if (driver === el || driver.kind === 'dff' || driver.kind === 'latch') continue;
        if (seenDrivers.has(driver)) continue;
        seenDrivers.add(driver);
        let list = dependents.get(driver);
        if (!list) dependents.set(driver, (list = []));
        list.push(el);
        depsLeft.set(el, (depsLeft.get(el) ?? 0) + 1);
      }
    }
  }

  let frontier: LogicElement[] = [];
  for (const el of elements) if ((depsLeft.get(el) ?? 0) === 0) frontier.push(el);
  let level = 0;
  let processed = 0;
  while (frontier.length > 0) {
    const next: LogicElement[] = [];
    for (const el of frontier) {
      el.level = level;
      processed++;
      for (const dep of dependents.get(el) ?? []) {
        const left = (depsLeft.get(dep) ?? 0) - 1;
        depsLeft.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    frontier = next;
    level++;
  }
  const loopElements = elements.filter((el) => (depsLeft.get(el) ?? 0) > 0);
  if (loopElements.length > 0) {
    // Unlevelled elements sit in a pure combinational loop. The settled value of
    // such a loop is not defined by the design; the level-0 engine evaluates it
    // with a bounded fixed point and says so.
    for (const el of loopElements) el.level = level;
    diagnostics.push(
      warn('CF7002', `combinational loop through ${loopElements.length} logic element(s)`, {
        hint: 'Break the loop with a register (D flip-flop): a combinational loop has no settled value.',
      }),
    );
  }

  const ports = nl.ports ?? [];
  return {
    netlist: nl,
    netCount,
    elements,
    driverCount,
    inputs: ports.filter((p) => p.direction !== 'output').map((p) => p.node),
    outputs: ports.filter((p) => p.direction === 'output' || p.direction === 'bidirectional').map((p) => p.node),
    netName: (node: number) => nl.nodeNames[nl.nodeName[node] - 1] ?? `#${node}`,
    loopElements,
    stats: {
      gates: elements.filter(
        (el) => el.kind === 'gate' || el.kind === 'tristate' || el.kind === 'mux' || el.kind === 'demux',
      ).length,
      sequential: elements.filter((el) => el.kind === 'dff' || el.kind === 'latch').length,
      levels: level,
      ignoredElements,
      loops: loopElements.length,
    },
    diagnostics,
  };
}

/** One-line human-readable summary of a logic graph. */
export function logicSummary(g: LogicGraph): string {
  const s = g.stats;
  const loop = s.loops ? `, ${s.loops} element(s) in a combinational loop` : '';
  const ignored = s.ignoredElements ? `, ${s.ignoredElements} non-digital element(s) ignored at this level` : '';
  return `${s.gates} logic element(s), ${s.sequential} register(s), ${s.levels} level(s)${loop}${ignored}`;
}

/** Throw a structured error when a circuit has nothing digital in it. */
export function requireLogic(g: LogicGraph): void {
  if (g.elements.length === 0) {
    throw new CircuitForgeError(
      'CF7003',
      'the circuit has no digital element: the level-0 engine has nothing to evaluate',
      [
        warn('CF7003', 'no gate, register, multiplexer or tristate buffer found', {
          hint: 'Level 0 evaluates digital building blocks; for an analogue circuit use the electrical solver (level 1).',
          data: { ignoredElements: g.stats.ignoredElements },
        }),
      ],
    );
  }
}

const ALL = 0xffffffff;
const B32 = 32;

/**
 * Bit-parallel four-state logic simulator, 32 vectors per pass.
 *
 * Planes per net: `ones` (bit = logic high), `x` (bit = unknown), `z` (bit = high
 * impedance). A bit that is neither 1 nor X is 0 — so the three planes are
 * independent bit masks, never a single encoded value. Registers hold their own
 * state: a tick settles the combinational cloud and then updates every register
 * from the settled values (the standard "delta cycle" model; metastability and
 * races are the business of `timing.ts`).
 */
export class LogicVectorSim {
  readonly graph: LogicGraph;
  readonly diagnostics: Diagnostic[] = [];
  private netOnes: Uint32Array;
  private netX: Uint32Array;
  private netZ: Uint32Array;
  /** Bits of a net that already have a non-Z driver (Z tracking for buses). */
  private seen: Uint32Array;
  private extDriven: Uint8Array;
  private elOnes: Uint32Array;
  private elX: Uint32Array;
  private elZ: Uint32Array;
  private regOnes: Uint32Array;
  private regX: Uint32Array;
  private clkLevel: Uint32Array;
  private clkKnown: Uint8Array;
  /** Elements by topological level, including the loop level at the end. */
  private byLevel: LogicElement[][] = [];
  private readonly loopIterations: number;
  private reportedMultiple = new Set<number>();
  /** Number of vectors evaluated (ticks × 32). */
  ticks = 0;

  constructor(graph: LogicGraph, opts: { loopIterations?: number } = {}) {
    this.graph = graph;
    const n = graph.netCount;
    this.netOnes = new Uint32Array(n);
    this.netX = new Uint32Array(n);
    this.netZ = new Uint32Array(n);
    this.seen = new Uint32Array(n);
    this.extDriven = new Uint8Array(n);
    const m = Math.max(1, graph.elements.length);
    this.elOnes = new Uint32Array(m);
    this.elX = new Uint32Array(m);
    this.elZ = new Uint32Array(m);
    this.regOnes = new Uint32Array(m);
    this.regX = new Uint32Array(m);
    this.clkLevel = new Uint32Array(m);
    this.clkKnown = new Uint8Array(m);
    this.loopIterations = opts.loopIterations ?? 16;
    for (let i = 0; i < graph.elements.length; i++) {
      const el = graph.elements[i];
      el.index = i;
      (this.byLevel[el.level] ?? (this.byLevel[el.level] = [])).push(el);
    }
    this.reset();
  }

  /** Reset every net to X and every register to its initial value. */
  reset(): void {
    this.netOnes.fill(0);
    this.netX.fill(ALL);
    this.netZ.fill(0);
    this.seen.fill(0);
    this.elOnes.fill(0);
    this.elX.fill(0);
    this.elZ.fill(0);
    this.clkLevel.fill(0);
    this.clkKnown.fill(0);
    this.reportedMultiple.clear();
    this.ticks = 0;
    for (const el of this.graph.elements) {
      if (el.kind !== 'dff' && el.kind !== 'latch') continue;
      if (el.initial === 1) {
        this.regOnes[el.index] = ALL;
        this.regX[el.index] = 0;
      } else if (el.initial === 2) {
        this.regOnes[el.index] = 0;
        this.regX[el.index] = ALL;
      } else {
        this.regOnes[el.index] = 0;
        this.regX[el.index] = 0;
      }
    }
  }

  /**
   * Drive a net with a complete 32-vector pattern: bit `i` of `ones` is vector i,
   * bit `i` of `unknown` marks vector i as unknown. The pattern replaces whatever
   * the net held, and it wins over every internal driver.
   */
  drive(net: number, ones: number, unknown = 0): void {
    if (net < 0 || net >= this.graph.netCount) return;
    this.extDriven[net] = 1;
    this.netOnes[net] = ones >>> 0;
    this.netX[net] = unknown >>> 0;
    this.netZ[net] = 0;
    this.seen[net] = ALL;
  }

  /** Stop driving a net: it becomes undriven (X) again. */
  release(net: number): void {
    if (net < 0 || net >= this.graph.netCount) return;
    this.extDriven[net] = 0;
    this.netOnes[net] = 0;
    this.netX[net] = ALL;
    this.netZ[net] = 0;
    this.seen[net] = 0;
  }

  /**
   * Convenience for single-vector work (tests, interactive stepping): drive
   * **vector `vector`** of a net to `value`, and every other vector to 0. The
   * whole plane is replaced, so the call is deterministic whatever the net held
   * before. Use `drive()` for a full 32-vector pattern.
   */
  setVector(net: number, vector: number, value: 0 | 1 | 'X' | 'Z' = 0): void {
    const bit = (1 << (vector & 31)) >>> 0;
    if (value === 'X') this.drive(net, 0, bit);
    else if (value === 'Z') {
      this.drive(net, 0, 0);
      this.netZ[net] = bit;
    } else this.drive(net, value === 1 ? bit : 0, 0);
  }

  /**
   * Run `ticks` clock cycles. One tick is:
   *   1. settle the combinational cloud at the current register state,
   *   2. let every edge-triggered register sample its settled D input,
   *   3. settle again so the nets (and therefore the caller) see the new state.
   * No edge is detected on the first tick: the clock level found at t = 0 is the
   * initial level, not a transition.
   */
  run(ticks = 1): void {
    // Instrumented as one phase: the profiler is what answers "where does the
    // simulator spend its time", and a clocked run is the unit a user thinks in.
    const h = profiler.begin('logic.run');
    for (let t = 0; t < ticks; t++) {
      this.settle();
      this.updateRegisters();
      this.ticks++;
      this.settle();
    }
    h.end(ticks);
  }

  /**
   * Evaluate the combinational cloud in level order until it is settled.
   *
   * Every net that an element drives is cleared first, so a second `settle()`
   * after an input change is a clean re-evaluation (no stale values, no false
   * "several drivers" reports).
   */
  settle(): void {
    const h = profiler.begin('logic.settle');
    // Element evaluations, counted as they happen: the honest throughput unit for
    // level 0, since one settle() passes over each level's elements once.
    let evals = 0;
    const graph = this.graph;
    for (let net = 1; net < graph.netCount; net++) {
      if (graph.driverCount[net] === 0 || this.extDriven[net]) continue;
      this.seen[net] = 0;
      this.netOnes[net] = 0;
      this.netX[net] = 0;
      this.netZ[net] = 0;
    }
    // Register outputs are sources of the combinational cloud.
    for (const el of graph.elements) {
      if (el.kind !== 'dff' && el.kind !== 'latch') continue;
      this.elOnes[el.index] = this.regOnes[el.index];
      this.elX[el.index] = this.regX[el.index];
      this.elZ[el.index] = 0;
      this.mergeOutputs(el);
    }
    const loops = graph.loopElements;
    const mainLevels = loops.length > 0 ? this.byLevel.length - 1 : this.byLevel.length;
    for (let lvl = 0; lvl < mainLevels; lvl++) {
      const list = this.byLevel[lvl];
      if (!list) continue;
      for (const el of list) {
        if (el.kind === 'dff' || el.kind === 'latch') continue;
        this.evaluate(el);
        evals++;
      }
      for (const el of list) {
        if (el.kind === 'dff' || el.kind === 'latch') continue;
        this.mergeOutputs(el);
      }
    }
    // Combinational loops: bounded fixed point (documented approximation).
    for (let i = 0; i < this.loopIterations && loops.length > 0; i++) {
      for (const el of loops) {
        this.evaluate(el);
        evals++;
      }
      for (const el of loops) this.mergeOutputs(el);
    }
    for (const el of graph.elements) {
      if (el.kind !== 'dff' || this.clkKnown[el.index]) continue;
      // First observation of a clock: this is the power-on level, not a
      // transition. An edge is a change seen *between* two register updates.
      this.clkLevel[el.index] = this.readOnes(el.clk);
      this.clkKnown[el.index] = 1;
    }
    h.end(evals);
  }

  private readOnes(net: number): number {
    if (net < 0 || net >= this.graph.netCount) return 0;
    return this.netOnes[net];
  }

  /** Reading a net for a logic gate: Z reads as X (a floating input is unknown). */
  private readX(net: number): number {
    if (net < 0 || net >= this.graph.netCount) return ALL;
    return (this.netX[net] | this.netZ[net]) >>> 0;
  }

  private evaluate(el: LogicElement): void {
    const i = el.index;
    let ones = 0;
    let x = 0;
    let z = 0;
    switch (el.kind) {
      case 'gate':
      case 'tristate': {
        if (el.kind === 'tristate') {
          const dOnes = this.readOnes(el.inputs[0] ?? 0);
          const dX = this.readX(el.inputs[0] ?? 0);
          const enOnes = this.readOnes(el.enable);
          const enX = this.readX(el.enable);
          const enabled = (el.activeLow ? ~enOnes : enOnes) >>> 0;
          const on = (enabled & ~enX) >>> 0; // bits where the buffer is definitely on
          const off = (~enabled & ~enX) >>> 0; // bits where it is definitely off
          ones = (dOnes & on) >>> 0;
          z = off;
          x = ((dX | enX) & ~off) >>> 0;
          break;
        }
        const fn = el.fn;
        const count = el.inputs.length;
        if (count === 0) {
          // Constant sources (fn 9 = high, fn 10 = low, anything else = unknown).
          if (fn === LOGIC_FN.CONST_HIGH) {
            ones = ALL;
            x = 0;
          } else if (fn === LOGIC_FN.CONST_LOW) {
            ones = 0;
            x = 0;
          } else {
            ones = 0;
            x = ALL;
          }
          break;
        }
        if (fn === LOGIC_FN.BUF || fn === LOGIC_FN.NOT) {
          ones = this.readOnes(el.inputs[0]);
          x = this.readX(el.inputs[0]);
          if (fn === LOGIC_FN.NOT) ones = ~ones >>> 0;
          break;
        }
        // Four per-vector masks, computed bit-parallel:
        //   all1 = every input is definitely 1   any1 = some input is 1
        //   all0 = every input is definitely 0   any0 = some input is 0
        // A bit that is neither definitely 1 nor definitely 0 is X.
        let all1 = ALL;
        let any1 = 0;
        let all0 = ALL;
        let any0 = 0;
        let anyX = 0;
        let parity = 0;
        for (let k = 0; k < count; k++) {
          const v1 = this.readOnes(el.inputs[k]);
          const vx = this.readX(el.inputs[k]);
          const def1 = (v1 & ~vx) >>> 0;
          const def0 = (~v1 & ~vx) >>> 0;
          all1 &= def1;
          any1 |= def1;
          all0 &= def0;
          any0 |= def0;
          anyX |= vx;
          parity ^= def1;
        }
        all1 >>>= 0;
        any1 >>>= 0;
        all0 >>>= 0;
        any0 >>>= 0;
        anyX >>>= 0;
        parity >>>= 0;
        switch (fn) {
          case LOGIC_FN.AND:
            ones = all1;
            x = ~all1 & ~any0;
            break;
          case LOGIC_FN.NAND:
            // The NAND is 1 as soon as one input is definitely 0.
            ones = any0;
            x = ~any0 & ~all1;
            break;
          case LOGIC_FN.OR:
            ones = any1;
            x = ~any1 & ~all0;
            break;
          case LOGIC_FN.NOR:
            ones = all0;
            x = ~all0 & ~any1;
            break;
          case LOGIC_FN.XOR:
            // An unknown input always makes the parity unknown (sound and simple).
            ones = parity;
            x = anyX;
            break;
          case LOGIC_FN.XNOR:
            ones = ~parity;
            x = anyX;
            break;
          default:
            ones = 0;
            x = ALL;
        }
        x >>>= 0;
        ones = (ones & ~x) >>> 0;
        break;
      }
      case 'mux': {
        const channels = Math.max(1, el.channels);
        const unknown = this.selectUnknown(el);
        let o = 0;
        let xx = 0;
        // An unknown select bit makes the output unknown: the selected channel is
        // not decidable, so the value is X (never a lucky guess).
        const usable = ~unknown >>> 0;
        for (let c = 0; c < channels; c++) {
          const hit = this.channelMask(el, c, channels);
          if (hit === 0) continue;
          const dataOnes = this.readOnes(el.inputs[c] ?? 0);
          const dataX = this.readX(el.inputs[c] ?? 0);
          o |= hit & dataOnes & usable;
          xx |= hit & (dataX | ~usable);
        }
        ones = o >>> 0;
        x = (xx | (unknown & ~o)) >>> 0;
        break;
      }
      case 'demux': {
        const channels = Math.max(1, el.channels);
        // A decoder has no data to route: the same net is the enable of the whole
        // decoded word, exactly as in the electrical model (elements.ts).
        const dOnes = this.readOnes(el.inputs[0] ?? 0);
        const dX = this.readX(el.inputs[0] ?? 0);
        const unknown = this.selectUnknown(el);
        // Every output is *driven*: the library model puts a conductance to
        // ground on each one and injects the data only on the selected output, so
        // an unselected output is a hard 0 — not high impedance.
        ones = dOnes >>> 0;
        x = (dX | unknown) >>> 0;
        this.demuxCurrent.set(el, { ones, x, unknown, channels });
        this.elOnes[i] = (ones & ~x) >>> 0;
        this.elX[i] = x >>> 0;
        this.elZ[i] = 0;
        return;
      }
      default:
        break;
    }
    this.elOnes[i] = (ones & ~x) >>> 0;
    this.elX[i] = x >>> 0;
    this.elZ[i] = z >>> 0;
  }

  /** Per-bit mask of vectors whose select word contains an unknown bit. */
  private selectUnknown(el: LogicElement): number {
    let unknown = 0;
    for (const sel of el.selects) unknown |= this.readX(sel);
    return unknown >>> 0;
  }

  /**
   * Bit mask of the vectors that select channel `c`, derived directly from the
   * select planes (no per-vector loop): select bit b is its own net, so its
   * `ones` plane is already the per-vector condition `sel_b == 1`.
   * `selects[]` is least significant first, matching the node layout (S0 first).
   */
  private channelMask(el: LogicElement, c: number, channels: number): number {
    if (channels <= 1) return ALL;
    const bits = Math.ceil(Math.log2(channels));
    let hit = ALL;
    // selects[0] is the first select net of the element (S0), which is the least
    // significant bit of the channel number — verified against the reference
    // decoder (S0 = 1 selects Y1), see tests/analysis/logic.test.ts.
    for (let b = 0; b < bits; b++) {
      const net = el.selects[b] ?? -1;
      const plane = this.readOnes(net);
      const want = (c >> b) & 1;
      hit &= want ? plane : ~plane;
    }
    return hit >>> 0;
  }

  private demuxCurrent = new Map<LogicElement, { ones: number; x: number; unknown: number; channels: number }>();

  private mergeOutputs(el: LogicElement): void {
    if (el.kind === 'demux') {
      const state = this.demuxCurrent.get(el);
      const channels = state?.channels ?? Math.max(1, el.channels);
      for (let c = 0; c < el.outputs.length; c++) {
        const hit = this.channelMask(el, c, channels);
        const unknown = state?.unknown ?? 0;
        // Selected vectors carry the data, the others are driven low; a vector
        // with an unknown select is unknown on every output.
        const dataMask = (hit & ~unknown) >>> 0;
        const ones = ((state?.ones ?? 0) & dataMask) >>> 0;
        const x = ((state?.x ?? 0) | (unknown & hit) | (hit & 0)) >>> 0;
        this.merge(el.outputs[c], ones, x, 0);
      }
      return;
    }
    const ones = this.elOnes[el.index];
    const x = this.elX[el.index];
    const z = this.elZ[el.index];
    this.merge(el.outputs[0], ones, x, z);
    if ((el.kind === 'dff' || el.kind === 'latch') && el.outputs.length > 1 && el.outputs[1] !== el.outputs[0]) {
      this.merge(el.outputs[1], ~ones >>> 0, x, z);
    }
  }

  /**
   * Merge one element output into a net. Vectors already driven by a non-Z driver
   * cannot be overwritten: a second driver that disagrees is reported once and
   * turns the vector into X (that is how a real bus conflict looks at level 0).
   */
  private merge(net: number, ones: number, x: number, z: number): void {
    if (net < 0 || net >= this.graph.netCount) return;
    if (this.extDriven[net]) return; // an external port drive wins
    const contributes = ~z >>> 0;
    if (this.seen[net] === 0) {
      this.netOnes[net] = (ones & contributes) >>> 0;
      // Z stays Z on the net (a floating bus reads as Z); a *gate* reading that
      // bit sees X through readX().
      this.netX[net] = (x & contributes) >>> 0;
      this.netZ[net] = z >>> 0;
      this.seen[net] = contributes;
      return;
    }
    const fresh = (contributes & ~this.seen[net]) >>> 0;
    const clash = (this.seen[net] & contributes & (this.netOnes[net] ^ ones)) >>> 0;
    this.netOnes[net] = ((this.netOnes[net] & ~fresh) | (ones & fresh)) >>> 0;
    this.netX[net] = (this.netX[net] | (x & contributes) | clash) >>> 0;
    this.netZ[net] = (this.netZ[net] & z) >>> 0;
    this.seen[net] = (this.seen[net] | contributes) >>> 0;
    if (clash !== 0 && !this.reportedMultiple.has(net)) {
      this.reportedMultiple.add(net);
      this.diagnostics.push(
        warn('CF7001', `net ${this.graph.netName(net)} is driven by outputs that disagree: its level-0 value is X`, {
          hint: 'Several drivers on one net is only meaningful for tristate buses, where the others must be off.',
        }),
      );
    }
  }

  /** Advance every register by one tick from the settled values. */
  private updateRegisters(): void {
    for (const el of this.graph.elements) {
      const i = el.index;
      if (el.kind === 'dff') {
        const clkOnes = this.readOnes(el.clk);
        const clkX = this.readX(el.clk);
        const prev = this.clkLevel[i];
        // No edge on the very first evaluation: the level seen then is the
        // power-on level of the clock, not a transition.
        const edge = this.clkKnown[i]
          ? (((el.falling ? ~clkOnes & prev : clkOnes & ~prev) & ~clkX) >>> 0)
          : 0;
        let done = false;
        if (el.rst >= 0) {
          const rstOnes = this.readOnes(el.rst);
          const rstX = this.readX(el.rst);
          const asserted = (el.rstLow ? ~rstOnes : rstOnes) >>> 0;
          const active = (asserted & ~rstX) >>> 0;
          if (active !== 0) {
            this.regOnes[i] = (this.regOnes[i] & ~active) >>> 0; // asynchronous reset → 0
            this.regX[i] = (this.regX[i] & ~active) >>> 0;
            done = true;
          }
        }
        if (!done && edge !== 0) {
          const dOnes = this.readOnes(el.inputs[0]);
          const dX = this.readX(el.inputs[0]);
          this.regOnes[i] = ((this.regOnes[i] & ~edge) | (dOnes & edge)) >>> 0;
          this.regX[i] = ((this.regX[i] & ~edge) | (dX & edge)) >>> 0;
        }
        // The level seen *now* becomes the reference for the next tick: an edge
        // is a transition between two register updates.
        this.clkLevel[i] = clkOnes;
        this.clkKnown[i] = 1;
      } else if (el.kind === 'latch') {
        const enOnes = this.readOnes(el.clk);
        const enX = this.readX(el.clk);
        const transparent = (enOnes & ~enX) >>> 0;
        const dOnes = this.readOnes(el.inputs[0]);
        const dX = this.readX(el.inputs[0]);
        this.regOnes[i] = ((this.regOnes[i] & ~transparent) | (dOnes & transparent)) >>> 0;
        this.regX[i] = ((this.regX[i] & ~transparent) | (dX & transparent)) >>> 0;
      }
    }
  }

  // ---- reading results ------------------------------------------------------

  /** Planes of a net: bit i of each mask corresponds to vector i. */
  planes(net: number): { ones: number; x: number; z: number } {
    return { ones: this.netOnes[net] ?? 0, x: this.netX[net] ?? ALL, z: this.netZ[net] ?? 0 };
  }

  /** Value of one net for one vector: 0, 1, 'X' or 'Z'. */
  sample(net: number, vector: number): 0 | 1 | 'X' | 'Z' {
    const bit = 1 << (vector & 31);
    const { ones, x, z } = this.planes(net);
    if (x & bit) return 'X';
    if (z & bit) return 'Z';
    return ones & bit ? 1 : 0;
  }

  /** Value of a net as a 32-character string (vector 31 first). */
  word(net: number): string {
    let s = '';
    for (let i = B32 - 1; i >= 0; i--) s += String(this.sample(net, i));
    return s;
  }

  /** Counts per value over the 32 vectors, for reporting. */
  histogram(net: number): { zero: number; one: number; x: number; z: number } {
    const { ones, x, z } = this.planes(net);
    let zero = 0;
    let one = 0;
    let unknown = 0;
    let high = 0;
    for (let i = 0; i < B32; i++) {
      const bit = 1 << i;
      if (x & bit) unknown++;
      else if (z & bit) high++;
      else if (ones & bit) one++;
      else zero++;
    }
    return { zero, one, x: unknown, z: high };
  }
}
