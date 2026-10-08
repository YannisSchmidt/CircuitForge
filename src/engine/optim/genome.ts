/**
 * The design space a search moves in: a **logic network genome**.
 *
 * A genome is a flat, topologically ordered list of two-input functions plus a
 * choice of which node drives each output bit. It is deliberately *not* an
 * architecture template: a template search can only pick among the ideas its
 * author had, while a network genome can build a ripple-carry chain, a carry
 * look-ahead tree, or something nobody wrote down — which is what makes
 * "architecture generation" from a behavioural spec a real search instead of a
 * lookup.
 *
 * The representations are chosen so that every genome *is* a legal circuit:
 *
 *   - refs are 0..inputs-1 for primary inputs, `inputs + k` for the output of
 *     node k, and CONST0/CONST1 for constants;
 *   - a node may only reference a lower-numbered node, so the list is always
 *     topological and the built circuit always has a valid evaluation order;
 *   - `canonicalize()` drops nodes that are unreachable from an output and
 *     renumbers what is left, so two genomes that describe the same network hash
 *     the same and hit the same cache entry.
 *
 * Every operation is a pure function of (genome, rng): the same seed replays the
 * same search, bit for bit.
 */

import { Rng } from '../util/rng.js';
import { fnv1a64Hex } from '../util/hash.js';
import type { Circuit } from '../core/circuit.js';
import { CircuitBuilder } from '../core/build.js';
import type { Library } from '../core/library.js';
import type { ChipLibrary } from '../core/chip.js';
import type { ParamBag } from '../core/library.js';
import type { DesignSpec } from './spec.js';
import { bitName, inputBits, outputBits } from './spec.js';

/** Constant-zero reference. */
export const CONST0 = -1;
/** Constant-one reference. */
export const CONST1 = -2;

/** Node functions, in a stable order (the index is what the genome stores). */
export const GENOME_FNS = ['BUF', 'NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR', 'MUX'] as const;
export type GenomeFnName = (typeof GENOME_FNS)[number];

/** Arity of each function (MUX = data 0, data 1, select). */
export const FN_ARITY: readonly number[] = [1, 1, 2, 2, 2, 2, 2, 2, 3];

/** How many refs a function reads. */
export function fnArity(fn: number): number {
  return FN_ARITY[fn] ?? 2;
}

export const FN = {
  BUF: 0,
  NOT: 1,
  AND: 2,
  NAND: 3,
  OR: 4,
  NOR: 5,
  XOR: 6,
  XNOR: 7,
  MUX: 8,
} as const;

export interface GenomeNode {
  fn: number;
  /** First input (data 0 for MUX). */
  a: number;
  /** Second input (data 1 for MUX). */
  b: number;
  /** Select, for MUX only. */
  c: number;
}

export interface LogicGenome {
  /** Number of input bits (from the specification). */
  inputs: number;
  /** Number of output bits (from the specification). */
  outputs: number;
  nodes: GenomeNode[];
  /** ref driving output bit k. */
  out: number[];
}

export interface GenomeLimits {
  /** Hard cap on node count; a search that ignores this produces unbuildable designs. */
  maxNodes: number;
  /** Target node count a random genome is drawn around. */
  seedNodes: number;
}

export const DEFAULT_LIMITS: GenomeLimits = { maxNodes: 220, seedNodes: 16 };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function randomRef(rng: Rng, inputs: number, nodesSoFar: number, allowConst: boolean): number {
  // Constants are legal but should not dominate: weight them low.
  if (allowConst && rng.chance(0.06)) return rng.chance(0.5) ? CONST0 : CONST1;
  const span = inputs + nodesSoFar;
  return rng.int(span);
}

export function emptyGenome(inputs: number, outputs: number): LogicGenome {
  return { inputs, outputs, nodes: [], out: new Array(outputs).fill(CONST0) };
}

/** A random legal genome for the given specification size. */
export function randomGenome(spec: DesignSpec, rng: Rng, limits: GenomeLimits = DEFAULT_LIMITS): LogicGenome {
  const inputs = inputBits(spec);
  const outputs = outputBits(spec);
  const target = Math.max(outputs, Math.min(limits.maxNodes, Math.round(limits.seedNodes * rng.range(0.5, 1.6))));
  const nodes: GenomeNode[] = [];
  for (let i = 0; i < target; i++) {
    const fn = rng.int(GENOME_FNS.length);
    nodes.push({
      fn,
      a: randomRef(rng, inputs, nodes.length, true),
      b: randomRef(rng, inputs, nodes.length, true),
      c: randomRef(rng, inputs, nodes.length, true),
    });
  }
  const out: number[] = [];
  for (let k = 0; k < outputs; k++) out.push(randomRef(rng, inputs, nodes.length, false));
  return canonicalize({ inputs, outputs, nodes, out });
}

/**
 * A genome that starts "almost right" for an addition-like spec: the classic
 * sum/carry pair per bit, wired with the spec's bit numbering. Seeds matter: an
 * evolutionary search with a fair starting point finds small adders in seconds,
 * and a bad seed is not a defect of the search.
 */
export function seededGenome(spec: DesignSpec, rng: Rng): LogicGenome {
  const inputs = inputBits(spec);
  const outputs = outputBits(spec);
  const nodes: GenomeNode[] = [];

  if (spec.name.startsWith('adder_') || spec.name.startsWith('alu_slice_')) {
    const bits = /\d+/.exec(spec.name)?.[0];
    const n = bits ? Number(bits) : 4;
    // Bit numbering: A0..A(n-1), B0..B(n-1), CI (for the adder).
    const aBit = (i: number) => i;
    const bBit = (i: number) => n + i;
    const ci = spec.name.startsWith('adder_') ? 2 * n : null;
    let carry: number = ci === null ? CONST0 : ci;
    for (let i = 0; i < n; i++) {
      const a = aBit(i);
      const b = bBit(i);
      // sum = (a XOR b) XOR carry
      const axb = nodes.length + inputs;
      nodes.push({ fn: FN.XOR, a, b, c: CONST0 });
      nodes.push({ fn: FN.XOR, a: axb, b: carry, c: CONST0 });
      void axb;
      // carry = (a AND b) OR (carry AND (a XOR b))
      const ab = nodes.length + inputs;
      nodes.push({ fn: FN.AND, a, b, c: CONST0 });
      const cx = nodes.length + inputs;
      nodes.push({ fn: FN.AND, a: carry, b: axb, c: CONST0 });
      const co = nodes.length + inputs;
      nodes.push({ fn: FN.OR, a: ab, b: cx, c: CONST0 });
      carry = co;
    }
  } else {
    // Generic seed: a small random net, then repair by mutation in the search.
    return randomGenome(spec, rng);
  }

  // Wire the outputs in order: for an adder, [S(n-1..0), CO]; for an ALU slice,
  // the low bits are the sum and the output bit `n` is the carry.
  const out: number[] = [];
  const start = inputs;
  // Sum bit i is node 5i + 1 (the second XOR of each bit slice).
  for (let i = 0; i < outputs - 1 && i < Math.floor(nodes.length / 5); i++) out.push(start + 5 * i + 1);
  out.push(start + nodes.length - 1); // the last carry
  while (out.length < outputs) out.push(CONST0);
  return canonicalize({ inputs, outputs, nodes, out });
}

// ---------------------------------------------------------------------------
// Canonicalisation, keys
// ---------------------------------------------------------------------------

/**
 * Structural well-formedness of a genome, checked before anything is built.
 *
 * A reference that points past the end of the node list, or forward to a node not
 * yet defined, is not a design: it has no circuit. Reporting it here (tier 0)
 * rather than letting `genomeToCircuit` clamp or throw keeps the reason specific,
 * and it is what stops a malformed genome from being scored as if it were a
 * candidate.
 *
 * @returns a list of defects; empty means the genome is well formed.
 */
export function genomeDefects(g: LogicGenome): string[] {
  const defects: string[] = [];
  if (!Number.isInteger(g.inputs) || g.inputs < 0) defects.push(`inputs = ${g.inputs} is not a non-negative integer`);
  if (!Number.isInteger(g.outputs) || g.outputs < 1) defects.push(`outputs = ${g.outputs} is not a positive integer`);
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    const arity = fnArity(n.fn);
    if (n.fn < 0 || n.fn >= GENOME_FNS.length) {
      defects.push(`node ${i}: unknown function index ${n.fn}`);
      continue;
    }
    const refs = arity >= 3 ? [n.a, n.b, n.c] : arity === 2 ? [n.a, n.b] : [n.a];
    for (const r of refs) {
      if (r === CONST0 || r === CONST1) continue;
      if (!Number.isInteger(r) || r < 0) {
        defects.push(`node ${i} (${GENOME_FNS[n.fn]}): reference ${r} is not a valid input, node or constant`);
      } else if (r >= g.inputs + i) {
        defects.push(`node ${i} (${GENOME_FNS[n.fn]}): reference ${r} is out of range (inputs ${g.inputs} + ${i} earlier node(s))`);
      }
    }
  }
  if (g.out.length !== g.outputs) defects.push(`the output table has ${g.out.length} entries for ${g.outputs} declared output(s)`);
  for (let k = 0; k < g.out.length; k++) {
    const r = g.out[k];
    if (r === CONST0 || r === CONST1) continue;
    if (!Number.isInteger(r) || r < 0 || r >= g.inputs + g.nodes.length) {
      defects.push(`output ${k}: reference ${r} is out of range (inputs ${g.inputs} + ${g.nodes.length} node(s))`);
    }
  }
  return defects;
}

function refValid(ref: number, inputs: number, nodesSoFar: number): boolean {
  if (ref === CONST0 || ref === CONST1) return true;
  if (ref < 0) return false;
  if (ref < inputs) return true;
  return ref - inputs < nodesSoFar;
}

/** Drop unreachable/invalid nodes, renumber refs, keep the node order. */
export function canonicalize(g: LogicGenome): LogicGenome {
  const { inputs, outputs } = g;
  const nodes = g.nodes.map((n) => ({ ...n }));
  // 1. validity: a node may only read earlier nodes (or inputs/constants).
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    for (const key of ['a', 'b', 'c'] as const) {
      if (!refValid(n[key], inputs, i)) n[key] = CONST0;
    }
    const arity = fnArity(n.fn);
    if (arity < 2) n.b = CONST0;
    if (arity < 3) n.c = CONST0;
  }
  // 2. reachability from the outputs.
  const out = g.out.map((r) => (refValid(r, inputs, nodes.length) ? r : CONST0));
  const needed = new Uint8Array(nodes.length);
  const visit = (ref: number) => {
    if (ref < inputs) return;
    const k = ref - inputs;
    if (k < 0 || k >= nodes.length || needed[k]) return;
    needed[k] = 1;
    const n = nodes[k];
    visit(n.a);
    if (fnArity(n.fn) > 1) visit(n.b);
    if (fnArity(n.fn) > 2) visit(n.c);
  };
  for (const r of out) visit(r);
  // 3. renumber (old index → new index).
  const map = new Int32Array(nodes.length).fill(-1);
  const kept: GenomeNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!needed[i]) continue;
    map[i] = inputs + kept.length;
    const n = nodes[i];
    const fix = (ref: number) => (ref >= inputs ? map[ref - inputs] : ref);
    kept.push({ fn: n.fn, a: fix(n.a), b: fix(n.b), c: fix(n.c) });
  }
  const fixOut = (ref: number) => (ref >= inputs ? map[ref - inputs] : ref);
  return { inputs, outputs, nodes: kept, out: out.map(fixOut) };
}

/** Structural key: two genomes with the same key build the same circuit. */
export function genomeKey(g: LogicGenome): string {
  const parts: string[] = [`i${g.inputs}o${g.outputs}`];
  for (const n of g.nodes) parts.push(`${n.fn}:${n.a},${n.b},${n.c}`);
  parts.push(`out:${g.out.join(',')}`);
  return fnv1a64Hex(parts.join('|'));
}

export function genomeStats(g: LogicGenome): { nodes: number; depth: number; fanout: number[]; depthOf: number[] } {
  const fanout = new Array<number>(g.inputs + g.nodes.length).fill(0);
  const depthOf = new Array<number>(g.inputs + g.nodes.length).fill(0);
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    const self = g.inputs + i;
    let d = 0;
    const read = (ref: number) => {
      if (ref < 0) return;
      if (ref >= fanout.length) return;
      fanout[ref]++;
      d = Math.max(d, depthOf[ref] ?? 0);
    };
    read(n.a);
    if (fnArity(n.fn) > 1) read(n.b);
    if (fnArity(n.fn) > 2) read(n.c);
    depthOf[self] = d + 1;
  }
  let depth = 0;
  for (const r of g.out) {
    if (r < 0 || r >= fanout.length) continue;
    fanout[r]++;
    depth = Math.max(depth, depthOf[r] ?? 0);
  }
  return { nodes: g.nodes.length, depth, fanout, depthOf };
}

// ---------------------------------------------------------------------------
// Variation operators
// ---------------------------------------------------------------------------

export interface VariationOptions {
  limits?: GenomeLimits;
  /** Probability of picking each operator, in order (weights are normalised). */
  weights?: Partial<Record<'add' | 'remove' | 'fn' | 'rewire' | 'output', number>>;
}

function cloneGenome(g: LogicGenome): LogicGenome {
  return { inputs: g.inputs, outputs: g.outputs, nodes: g.nodes.map((n) => ({ ...n })), out: [...g.out] };
}

function insertNode(rng: Rng, g: LogicGenome, limits: GenomeLimits): void {
  if (g.nodes.length >= limits.maxNodes) return;
  const at = rng.int(g.nodes.length + 1);
  const fn = rng.int(GENOME_FNS.length);
  const node: GenomeNode = {
    fn,
    a: randomRef(rng, g.inputs, at, true),
    b: randomRef(rng, g.inputs, at, true),
    c: randomRef(rng, g.inputs, at, true),
  };
  g.nodes.splice(at, 0, node);
  // Every ref at or after the insertion point shifts by one.
  const shift = (ref: number) => (ref >= g.inputs + at ? ref + 1 : ref);
  for (let i = at + 1; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    n.a = shift(n.a);
    n.b = shift(n.b);
    n.c = shift(n.c);
  }
  g.out = g.out.map(shift);
}

function removeNode(rng: Rng, g: LogicGenome): void {
  if (g.nodes.length === 0) return;
  const at = rng.int(g.nodes.length);
  const removed = g.inputs + at;
  // Consumers of the removed node fall back to one of its own inputs: the
  // network keeps its shape instead of collapsing to a constant.
  const victim = g.nodes[at];
  const replacement = rng.chance(0.5) ? victim.a : victim.b;
  g.nodes.splice(at, 1);
  const fix = (ref: number) => {
    if (ref === removed) return replacement < 0 ? ref : ref > removed ? ref - 1 : ref;
    if (ref > removed) return ref - 1;
    return ref;
  };
  const fixSub = (ref: number) => {
    if (ref === removed) return replacement;
    if (ref > removed) return ref - 1;
    return ref;
  };
  for (const n of g.nodes) {
    n.a = fixSub(n.a);
    n.b = fixSub(n.b);
    n.c = fixSub(n.c);
  }
  g.out = g.out.map(fixSub);
  void fix;
}

/** One variation step; returns a new genome (the input is not modified). */
export function mutateGenome(g: LogicGenome, rng: Rng, opts: VariationOptions = {}): LogicGenome {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const next = cloneGenome(g);
  const w = opts.weights ?? {};
  const weights = [w.add ?? 1, w.remove ?? 0.6, w.fn ?? 1.2, w.rewire ?? 2.4, w.output ?? 0.8];
  const op = rng.weighted(weights);

  switch (op) {
    case 0:
      insertNode(rng, next, limits);
      break;
    case 1:
      removeNode(rng, next);
      break;
    case 2: {
      if (next.nodes.length === 0) {
        insertNode(rng, next, limits);
        break;
      }
      const at = rng.int(next.nodes.length);
      const fn = rng.int(GENOME_FNS.length);
      const n = next.nodes[at];
      n.fn = fn;
      if (fnArity(fn) < 2) n.b = CONST0;
      if (fnArity(fn) < 3) n.c = CONST0;
      break;
    }
    case 3: {
      const targets = next.nodes.length + next.out.length;
      if (targets === 0) break;
      const pick = rng.int(targets);
      const value = randomRef(rng, next.inputs, pick < next.nodes.length ? pick : next.nodes.length, true);
      if (pick < next.nodes.length) {
        const key = (['a', 'b', 'c'] as const)[rng.int(3)];
        const n = next.nodes[pick];
        if (key === 'c' && fnArity(n.fn) < 3) n.a = value;
        else if (key === 'b' && fnArity(n.fn) < 2) n.a = value;
        else n[key] = value;
      } else {
        next.out[pick - next.nodes.length] = value < 0 ? CONST0 : value;
      }
      break;
    }
    default: {
      if (next.out.length === 0) break;
      const k = rng.int(next.out.length);
      next.out[k] = randomRef(rng, next.inputs, next.nodes.length, false);
      break;
    }
  }
  return canonicalize(next);
}

/**
 * Subgraph crossover: keep a prefix of `a`, then graft the part of `b` that
 * reaches its outputs on top of it. Refs into `b`'s nodes that were dropped are
 * replaced by a random available ref — the child is always a legal network, and
 * the search pays for the noise with selection pressure.
 */
export function crossoverGenomes(a: LogicGenome, b: LogicGenome, rng: Rng): LogicGenome {
  if (a.inputs !== b.inputs || a.outputs !== b.outputs) return cloneGenome(a);
  const cutA = a.nodes.length === 0 ? 0 : rng.int(a.nodes.length + 1);
  const nodes: GenomeNode[] = a.nodes.slice(0, cutA).map((n) => ({ ...n }));
  const cutB = b.nodes.length === 0 ? 0 : rng.int(b.nodes.length + 1);
  const shift = cutA - cutB; // b's node k lands at cutA + (k - cutB)
  for (let k = cutB; k < b.nodes.length; k++) {
    const n = b.nodes[k];
    const remap = (ref: number): number => {
      if (ref < b.inputs) return ref;
      const idx = ref - b.inputs;
      if (idx >= cutB) return b.inputs + idx + shift;
      // A node of the dropped prefix: fall back to a random available ref.
      return randomRef(rng, a.inputs, cutA, true);
    };
    nodes.push({ fn: n.fn, a: remap(n.a), b: remap(n.b), c: remap(n.c) });
  }
  const out = b.out.map((ref) => {
    if (ref < b.inputs) return ref;
    const idx = ref - b.inputs;
    if (idx >= cutB) return b.inputs + idx + shift;
    return a.out.length > 0 ? rng.pick(a.out) : CONST0;
  });
  return canonicalize({ inputs: a.inputs, outputs: a.outputs, nodes, out });
}

// ---------------------------------------------------------------------------
// Genome → circuit
// ---------------------------------------------------------------------------

/**
 * Declared timing for the *search*: a gate cost that grows with the load it
 * drives. This is a model, not a measurement, and it is named in every report:
 * `base` is the no-load propagation delay per function and `perLoad` is the extra
 * delay per additional fan-out, exactly the first-order load model the engine
 * exposes as per-instance `tphl`/`tplh`. Replace it and the search re-ranks.
 */
export interface LoadDelayModel {
  id: string;
  description: string;
  /** No-load delay per genome function, in seconds. */
  base: number[];
  /** Delay per additional input load, in seconds. */
  perLoad: number;
}

export const ILLUSTRATIVE_LOAD_MODEL: LoadDelayModel = {
  id: 'L1',
  description:
    'declared load model: 0.6–1.4 ns no-load per gate (AND/OR 0.9–1.0, XOR 1.4, NOT/BUF 0.6) plus 0.35 ns per extra fan-out input',
  // Order matches GENOME_FNS: BUF, NOT, AND, NAND, OR, NOR, XOR, XNOR, MUX.
  base: [0.6e-9, 0.6e-9, 0.9e-9, 0.8e-9, 1.0e-9, 0.9e-9, 1.4e-9, 1.4e-9, 1.0e-9],
  perLoad: 0.35e-9,
};

/**
 * A test bench for the *detailed* passes: instead of declaring input ports, the
 * circuit is built with a real source on every input bit, so that the electrical
 * and thermal levels have something to drive them.
 *
 * With `stimulus` the sources are square waves (that is how dynamic power is
 * measured); without it they are DC values, which is how the static operating
 * point is measured. Both are *declared measurements*: the frequency, amplitude
 * and phase step are printed in the report next to the number they produced.
 */
export interface BenchOptions {
  /** DC level of every input bit (volts): 0 = logic low, ≥ vth = logic high. */
  dc?: number;
  /** Square-wave amplitude (peak-to-peak) per input bit. */
  amplitude?: number;
  frequency?: number;
  /** Phase difference between consecutive input bits, in degrees. */
  phaseStep?: number;
  riseTime?: number;
  fallTime?: number;
  /** Supply rail voltage (volts). */
  vdd?: number;
}

export interface BuildOptions {
  lib: Library;
  chips?: ChipLibrary;
  /** Name of the generated sheet (defaults to the spec name). */
  name?: string;
  delayModel?: LoadDelayModel;
  /** Gate style: 'ideal' for the search, 'cmos_static' for the transistor-level pass. */
  gateStyle?: 'ideal' | 'cmos_static' | 'pass_transistor' | 'transmission_gate';
  /** Horizontal spacing between logic levels, in schematic units. */
  columnSpacing?: number;
  rowSpacing?: number;
  /**
   * When set, every input bit is driven by a real source instead of a port
   * (the electrical pass). `stimulus` selects waves instead of DC values.
   */
  bench?: BenchOptions;
  /**
   * One DC level per input bit (volts), overriding `bench.dc`: that is how a
   * specific input vector is applied to a transistor-level circuit.
   */
  bitLevels?: number[];
}

/** Spec id and pin usage of each genome function. */
function gateFor(fn: number): { specId: string; pins: Array<'IN1' | 'IN2'>; mux?: boolean } {
  switch (fn) {
    case FN.BUF:
      return { specId: 'buffer', pins: ['IN1'] };
    case FN.NOT:
      return { specId: 'not_gate', pins: ['IN1'] };
    case FN.AND:
      return { specId: 'and_gate', pins: ['IN1', 'IN2'] };
    case FN.NAND:
      return { specId: 'nand_gate', pins: ['IN1', 'IN2'] };
    case FN.OR:
      return { specId: 'or_gate', pins: ['IN1', 'IN2'] };
    case FN.NOR:
      return { specId: 'nor_gate', pins: ['IN1', 'IN2'] };
    case FN.XOR:
      return { specId: 'xor_gate', pins: ['IN1', 'IN2'] };
    case FN.XNOR:
      return { specId: 'xnor_gate', pins: ['IN1', 'IN2'] };
    default:
      return { specId: 'mux', pins: [], mux: true };
  }
}

/**
 * Lay out the network: inputs in the first column, every node one column right of
 * its deepest input, outputs in the last column. The result is a readable
 * schematic (and the reason the exporter can print coordinates at all).
 */
function layout(g: LogicGenome): { pos: Array<[number, number]>; depth: number } {
  const { depthOf } = genomeStats(g);
  const pos: Array<[number, number]> = [];
  const perColumn = new Map<number, number>();
  for (let i = 0; i < g.nodes.length; i++) {
    const col = Math.max(1, depthOf[g.inputs + i] ?? 1);
    const row = perColumn.get(col) ?? 0;
    perColumn.set(col, row + 1);
    pos.push([col * 6, row * 3 - 1.5]);
  }
  let depth = 1;
  for (const d of depthOf) depth = Math.max(depth, d);
  return { pos, depth: Math.max(1, depth + 1) };
}

/** Net name of a flat input bit. */
export function inputNetName(spec: DesignSpec, k: number): string {
  return `in_${bitName(spec.inputs, k)}`;
}

/** Net name of a flat output bit. */
export function outputNetName(spec: DesignSpec, k: number): string {
  return `out_${bitName(spec.outputs, k)}`;
}

/** Net a node drives in the built circuit. */
export function nodeNetName(index: number): string {
  return `n${index}`;
}

export interface GenomeStructure {
  /** Net name each output bit is connected to, in output order. */
  outNets: string[];
  /** Nodes that can be tapped directly by an output port (no extra driver). */
  direct: Map<number, number>;
  /** Output bits that need their own driver (input/constant ref, or shared node). */
  buffers: Array<{ bit: number; ref: number }>;
  /** Constant generators the circuit needs (0, 1 or 2). */
  constants: number;
  /** Components a BOM would list for this genome. */
  components: number;
}

/**
 * Resolve how the outputs are tapped.
 *
 * An output bit whose net is *only* read by that output needs no extra component:
 * the port can sit on the gate's own net. Everything else (an output equal to an
 * input or a constant, or a node that also feeds other nodes) gets a real driver,
 * because a port cannot drive itself and a net cannot have two drivers.
 */
export function genomeStructure(g: LogicGenome): GenomeStructure {
  const { fanout } = genomeStats(g);
  const internal = new Map<number, number>();
  for (let i = 0; i < g.nodes.length; i++) {
    for (const ref of [g.nodes[i].a, g.nodes[i].b, g.nodes[i].c]) {
      if (ref >= g.inputs) internal.set(ref, (internal.get(ref) ?? 0) + 1);
    }
  }
  const direct = new Map<number, number>();
  const outNets: string[] = [];
  const buffers: Array<{ bit: number; ref: number }> = [];
  for (let k = 0; k < g.outputs; k++) {
    const ref = g.out[k];
    const isNode = ref >= g.inputs;
    const shared = isNode && (internal.get(ref) ?? 0) > 0;
    const already = isNode && direct.has(ref - g.inputs);
    if (isNode && !shared && !already) {
      direct.set(ref - g.inputs, k);
      outNets.push(nodeNetName(ref - g.inputs));
    } else if (isNode && !shared) {
      // Two output bits on the same node: the second needs a driver.
      buffers.push({ bit: k, ref: ref - g.inputs });
      outNets.push(outputNetName(specPlaceholder, k));
    } else {
      buffers.push({ bit: k, ref: isNode ? ref - g.inputs : ref });
      outNets.push(outputNetName(specPlaceholder, k));
    }
  }
  let constants = 0;
  const uses = new Set<number>();
  for (const n of g.nodes) for (const r of [n.a, n.b, n.c]) if (r === CONST0 || r === CONST1) uses.add(r);
  for (const r of g.out) if (r === CONST0 || r === CONST1) uses.add(r);
  for (const b of buffers) if (b.ref === CONST0 || b.ref === CONST1) uses.add(b.ref);
  constants = uses.size > 0 ? 1 : 0;
  return { outNets, direct, buffers, constants, components: g.nodes.length + buffers.length + constants };
}

/**
 * Net name of the bench ground. The sources' negative terminals and the ground
 * element must agree on it, or the bench has no reference at all and the level-1
 * solve is singular (`b.ground()` with no argument grounds the net named `gnd`).
 */
export const BENCH_GROUND = 'gnd';

/** Sentinel used while `genomeStructure` has no spec; only the name shape matters. */
const specPlaceholder = { inputs: [], outputs: [] } as unknown as DesignSpec;

export function genomeToCircuit(g: LogicGenome, spec: DesignSpec, opts: BuildOptions): Circuit {
  const model = opts.delayModel ?? ILLUSTRATIVE_LOAD_MODEL;
  const style = opts.gateStyle ?? 'ideal';
  const { fanout } = genomeStats(g);
  const structure = genomeStructure(g);
  const b = new CircuitBuilder(opts.lib, opts.name ?? spec.name, opts.chips);
  const { pos } = layout(g);

  // Ports: one per input bit, one per output bit. An output port re-uses the
  // driving gate's net whenever that net has no other reader.
  const vdd = opts.bench?.vdd ?? 3.3;
  if (opts.bench) {
    // A bench replaces the input ports with real sources: the electrical level
    // cannot drive a net that only a schematic port would have held.
    for (let k = 0; k < g.inputs; k++) {
      const wave = opts.bench.frequency !== undefined;
      const inst = wave
        ? b.add(
            'vsignal',
            {
              waveform: 'square',
              dc: 0,
              amp: opts.bench.amplitude ?? vdd,
              freq: opts.bench.frequency ?? 1e6,
              phase: (k * (opts.bench.phaseStep ?? 0) * Math.PI) / 180,
              tr: opts.bench.riseTime ?? 1e-9,
              tf: opts.bench.fallTime ?? 1e-9,
              duty: 0.5,
            },
            [0, k * 3 - 3],
          )
        : b.add('vdc', { dc: opts.bitLevels?.[k] ?? opts.bench.dc ?? 0 }, [0, k * 3 - 3]);
      b.at(inst, '+', inputNetName(spec, k)).at(inst, '-', BENCH_GROUND);
    }
    b.ground(BENCH_GROUND);
  } else {
    for (let k = 0; k < g.inputs; k++) b.port(bitName(spec.inputs, k), 'input', inputNetName(spec, k), 1);
  }
  // Which node directly drives which output bit. A directly tapped bit has no
  // driver of its own: the port must sit on the node's own net, which is exactly
  // the net the gate writes. (Getting this wrong leaves the port on an unconnected
  // net that always reads X — the bug this comment exists to prevent.)
  const nodeForBit = new Map<number, number>();
  for (const [node, bit] of structure.direct) nodeForBit.set(bit, node);
  const emittedBuffers = new Set<number>();
  for (let k = 0; k < g.outputs; k++) {
    const node = nodeForBit.get(k);
    const name = node === undefined ? outputNetName(spec, k) : nodeNetName(node);
    const buffer = structure.buffers.find((x) => x.bit === k);
    if (buffer) emittedBuffers.add(k);
    b.port(bitName(spec.outputs, k), 'output', name, 1);
  }

  const constantInst = new Map<number, string>();
  const constNet = (ref: number): string => {
    const key = ref === CONST1 ? 1 : 0;
    const name = key === 1 ? '__one' : '__zero';
    if (!constantInst.has(key)) {
      constantInst.set(key, name);
      const inst = b.add(key === 1 ? 'logic_high' : 'logic_low', {}, [0, -3]);
      b.at(inst, 'OUT', name);
    }
    return name;
  };
  const netFor = (ref: number): string => {
    if (ref === CONST0 || ref === CONST1) return constNet(ref);
    if (ref < g.inputs) return inputNetName(spec, ref);
    return nodeNetName(ref - g.inputs);
  };

  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    const gate = gateFor(n.fn);
    const loads = fanout[g.inputs + i] ?? 1;
    const delay = model.base[n.fn] + model.perLoad * Math.max(0, loads - 1);
    const params: ParamBag = { style, tphl: delay, tplh: delay, vdd: 3.3, vth: 1.65 };
    const inst = gate.mux
      ? b.add('mux', { ...params, channels: 2, selectBits: 1 }, pos[i])
      : b.add(gate.specId, { ...params, inputs: gate.pins.length }, pos[i]);
    // Every gate drives its own node net; an output port that taps this node
    // (see `nodeForBit` above) sits on the very same net.
    const outNet = nodeNetName(i);
    if (gate.mux) {
      b.at(inst, 'I0', netFor(n.a)).at(inst, 'I1', netFor(n.b)).at(inst, 'S0', netFor(n.c)).at(inst, 'Y', outNet);
    } else if (gate.pins.length === 1) {
      b.at(inst, 'IN1', netFor(n.a)).at(inst, 'OUT', outNet);
    } else {
      b.at(inst, 'IN1', netFor(n.a)).at(inst, 'IN2', netFor(n.b)).at(inst, 'OUT', outNet);
    }
  }

  // Outputs that need a driver of their own.
  let y = 20;
  for (const buffer of structure.buffers) {
    const ref = buffer.ref;
    const inst =
      ref === CONST0 || ref === CONST1
        ? b.add(ref === CONST1 ? 'logic_high' : 'logic_low', {}, [6, y])
        : b.add('buffer', { style, tphl: 0, tplh: 0, rout: 1e-3 }, [6, y]);
    b.at(inst, ref === CONST0 || ref === CONST1 ? 'OUT' : 'IN1', ref === CONST0 || ref === CONST1 ? outputNetName(spec, buffer.bit) : netFor(ref));
    if (ref !== CONST0 && ref !== CONST1) b.at(inst, 'OUT', outputNetName(spec, buffer.bit));
    y += 3;
  }
  void emittedBuffers;
  return b.finish({ erc: false });
}

/**
 * Component count of a built genome, counted from the genome rather than the
 * circuit: constant generators are shared, so this is what a BOM would list.
 */
export function genomeComponentCount(g: LogicGenome): number {
  return genomeStructure(g).components;
}
