/**
 * Architecture seeds.
 *
 * A search that starts from nothing spends its first generations rediscovering
 * the ripple-carry adder. Seeding with the classic structures is not cheating —
 * it is what an engineer does — and the report names every seed that was used, so
 * a result can never be mistaken for a design the search invented from scratch.
 *
 * Two rules keep the seeds honest:
 *
 *   1. **A seed must be applicable.** `rippleSeed` returns `null` for a
 *      specification that has no sum output; offering an adder as the starting
 *      point of `A & ~B` does not diversify the population, it wastes it.
 *   2. **A seed must be exact when it claims to be.** `truthTableSeed` derives
 *      each output bit from the specification's own behaviour and *verifies* the
 *      network it built against assignments outside the subspace it synthesised
 *      from. If the verification fails, the seed is not offered — a plausible but
 *      wrong architecture is worse than none, because it biases the whole run.
 *
 * Three genuinely different adder architectures are provided, because that is what
 * makes the trade-off real:
 *
 *   ripple-carry  one full adder per bit, carry chained: few gates, depth O(n)
 *   prefix        Kogge–Stone generate/propagate: depth O(log n), many more gates
 *   truth table   per-bit synthesis: minimal for bitwise specifications
 */

import { Rng } from '../util/rng.js';
import {
  CONST0,
  CONST1,
  FN,
  canonicalize,
  inputNetName,
  randomGenome,
  seededGenome,
  type GenomeNode,
  type LogicGenome,
} from './genome.js';
import { bitName, bitsToValues, inputBits, outputBits, type DesignSpec } from './spec.js';

export interface SeedDescription {
  id: string;
  name: string;
  description: string;
  /** When the seed applies, in one clause. */
  appliesWhen: string;
}

export const SEED_CATALOG: SeedDescription[] = [
  {
    id: 'ripple',
    name: 'ripple carry',
    description: 'one full adder per bit, carry chained through every stage',
    appliesWhen: 'the specification has A and B inputs and an S output',
  },
  {
    id: 'prefix',
    name: 'Kogge–Stone prefix',
    description: 'generate/propagate pairs with a log-depth prefix carry tree',
    appliesWhen: 'the specification has A and B inputs and an S output',
  },
  {
    id: 'truth_table',
    name: 'per-bit truth-table synthesis',
    description: 'each output bit is synthesised exactly from the behaviour (Shannon expansion, at most 3 dependencies per bit)',
    appliesWhen: 'the specification has a behaviour and every output bit depends on at most 3 input bits',
  },
  {
    id: 'classic',
    name: 'classic sum/carry',
    description: 'the textbook adder wiring, written by hand',
    appliesWhen: 'the specification is named adder_n or alu_slice_n',
  },
  {
    id: 'random',
    name: 'random networks',
    description: 'seeded random logic networks of small size',
    appliesWhen: 'always',
  },
];

/** A bit index of an input or output port inside a spec. */
function bitIndex(spec: DesignSpec, portName: string, bit: number): number {
  let offset = 0;
  for (const p of spec.inputs) {
    const w = Math.max(1, p.width);
    if (p.name === portName) return offset + bit;
    offset += w;
  }
  return -1;
}

function outIndex(spec: DesignSpec, portName: string, bit: number): number {
  let offset = 0;
  for (const p of spec.outputs) {
    const w = Math.max(1, p.width);
    if (p.name === portName) return offset + bit;
    offset += w;
  }
  return -1;
}

/** True when the specification is shaped like an adder: A + B → S (+ CO). */
export function isAdderShaped(spec: DesignSpec): boolean {
  return bitIndex(spec, 'A', 0) >= 0 && bitIndex(spec, 'B', 0) >= 0 && outIndex(spec, 'S', 0) >= 0;
}

/** Width in bits of the operand an adder-shaped spec works on. */
function adderWidth(spec: DesignSpec): number {
  const a = spec.inputs.find((p) => p.name === 'A');
  return a ? Math.max(1, Math.round(a.width)) : 0;
}

/** Ripple-carry adder genome, or null when the spec is not adder-shaped. */
export function rippleSeed(spec: DesignSpec): LogicGenome | null {
  if (!isAdderShaped(spec)) return null;
  const n = adderWidth(spec);
  if (n <= 0) return null;
  const ci = bitIndex(spec, 'CI', 0);
  const nodes: GenomeNode[] = [];
  const push = (fn: number, a: number, b: number, c = CONST0): number => {
    nodes.push({ fn, a, b, c });
    return inputBits(spec) + nodes.length - 1;
  };
  let carry = ci >= 0 ? ci : CONST0;
  const sums: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = bitIndex(spec, 'A', i);
    const b = bitIndex(spec, 'B', i);
    const axb = push(FN.XOR, a, b);
    sums.push(push(FN.XOR, axb, carry));
    const g = push(FN.AND, a, b);
    const p = push(FN.AND, carry, axb);
    carry = push(FN.OR, g, p);
  }
  const out: number[] = new Array(outputBits(spec)).fill(CONST0);
  for (let i = 0; i < n; i++) {
    const k = outIndex(spec, 'S', i);
    if (k >= 0) out[k] = sums[i];
  }
  const co = outIndex(spec, 'CO', 0);
  if (co >= 0) out[co] = carry;
  return canonicalize({ inputs: inputBits(spec), outputs: outputBits(spec), nodes, out });
}

/**
 * Kogge–Stone prefix adder: every bit computes (g, p) = (a·b, a⊕b) and the carry
 * tree combines them in log₂(n) levels.
 */
export function prefixSeed(spec: DesignSpec): LogicGenome | null {
  if (!isAdderShaped(spec)) return null;
  const n = adderWidth(spec);
  if (n <= 1) return null; // a 1-bit adder has no prefix tree to build
  const nodes: GenomeNode[] = [];
  const push = (fn: number, a: number, b: number, c = CONST0): number => {
    nodes.push({ fn, a, b, c });
    return inputBits(spec) + nodes.length - 1;
  };
  const g: number[] = [];
  const p: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = bitIndex(spec, 'A', i);
    const b = bitIndex(spec, 'B', i);
    g.push(push(FN.AND, a, b));
    p.push(push(FN.XOR, a, b));
  }
  // Prefix operator: (G,P) ∘ (G',P') = (G + P·G', P·P')
  const G = [...g];
  const P = [...p];
  for (let d = 1; d < n; d *= 2) {
    const nG = [...G];
    const nP = [...P];
    for (let i = d; i < n; i++) {
      const pg = push(FN.AND, P[i], G[i - d]);
      nG[i] = push(FN.OR, G[i], pg);
      nP[i] = push(FN.AND, P[i], P[i - d]);
    }
    for (let i = d; i < n; i++) {
      G[i] = nG[i];
      P[i] = nP[i];
    }
  }
  // Carry-in: the prefix tree above computes the group generate and propagate for
  // bits 0..i *assuming CI = 0*. The carry into bit i is therefore
  //     c_i = G[i-1] + P[i-1]·CI
  // and wiring `G[i-1]` alone — which an earlier version of this seed did — is
  // wrong for every vector with CI = 1. That is exactly half of an adder's input
  // space, so the mistake is not a corner case.
  const ci = bitIndex(spec, 'CI', 0);
  const cinOf = (i: number): number => {
    if (i === 0) return ci >= 0 ? ci : CONST0;
    if (ci < 0) return G[i - 1];
    return push(FN.OR, G[i - 1], push(FN.AND, P[i - 1], ci));
  };
  const out: number[] = new Array(outputBits(spec)).fill(CONST0);
  for (let i = 0; i < n; i++) {
    const a = bitIndex(spec, 'A', i);
    const b = bitIndex(spec, 'B', i);
    const axb = push(FN.XOR, a, b);
    const s = push(FN.XOR, axb, cinOf(i));
    const k = outIndex(spec, 'S', i);
    if (k >= 0) out[k] = s;
  }
  const co = outIndex(spec, 'CO', 0);
  if (co >= 0) out[co] = cinOf(n);
  return canonicalize({ inputs: inputBits(spec), outputs: outputBits(spec), nodes, out });
}

// ---------------------------------------------------------------------------
// Per-bit truth-table synthesis
// ---------------------------------------------------------------------------

/** Set flat input bit `j` of a port-value array. */
function withBit(spec: DesignSpec, bits: number[], j: number, value: 0 | 1): number[] {
  const copy = [...bits];
  copy[j] = value;
  return bitsToValues(spec.inputs, copy);
}

/**
 * Pack four table entries into the 2-input function index `twoInputNodes` expects.
 *
 * The table is enumerated with the *first* dependency as its least significant
 * bit, so index `m` carries (a = m & 1, b = (m >> 1) & 1). The function index, on
 * the other hand, is weighted f00·1 + f01·2 + f10·4 + f11·8 — that is, `b` is its
 * low bit. Swapping the two is the classic truth-table bug: it turns `a & ~b` into
 * `~a & b`, which is wrong for exactly half of all functions and therefore easy to
 * miss. Every seed built here is verified against the behaviour afterwards, so a
 * mistake of this kind costs the seed rather than the search — but the packing is
 * written out explicitly so it can be read and checked.
 */
function pack2(table: number[], offset: number): number {
  const f00 = table[offset] ?? 0; // a=0, b=0
  const f10 = table[offset + 1] ?? 0; // a=1, b=0
  const f01 = table[offset + 2] ?? 0; // a=0, b=1
  const f11 = table[offset + 3] ?? 0; // a=1, b=1
  return f00 | (f01 << 1) | (f10 << 2) | (f11 << 3);
}

/**
 * Exact network for one 2-input truth value.
 *
 * `v` packs f(a,b) over (00, 01, 10, 11) as bits 0..3, so all sixteen functions
 * of two variables have a construction here — including the four that need one
 * inverted operand, which is why the result is a small list of nodes rather than
 * a single function index.
 */
function twoInputNodes(
  v: number,
  a: number,
  b: number,
  push: (fn: number, a: number, b?: number, c?: number) => number,
): number {
  switch (v) {
    case 0:
      return CONST0;
    case 15:
      return CONST1;
    case 3:
      return push(FN.NOT, a);
    case 12:
      // f = a: a buffer component would reproduce a value the ref already carries,
      // so the ref itself is the network. One less component, one less level.
      return a;
    case 5:
      return push(FN.NOT, b);
    case 10:
      return b;
    case 8:
      return push(FN.AND, a, b);
    case 7:
      return push(FN.NAND, a, b);
    case 14:
      return push(FN.OR, a, b);
    case 1:
      return push(FN.NOR, a, b);
    case 6:
      return push(FN.XOR, a, b);
    case 9:
      return push(FN.XNOR, a, b);
    case 4:
      return push(FN.AND, a, push(FN.NOT, b));
    case 2:
      return push(FN.AND, push(FN.NOT, a), b);
    case 13:
      return push(FN.OR, a, push(FN.NOT, b));
    default:
      return push(FN.OR, push(FN.NOT, a), b); // v === 11
  }
}

/**
 * Which input bits an output bit can depend on, found by flipping each bit from
 * several base assignments. A single base is not enough: in `a & ~b` the operand
 * `b` only matters when `a` is 1, so an all-zero base alone would miss it.
 */
function dependenciesOf(spec: DesignSpec, outBit: number, bases: number[][], ins: number): number[] {
  const deps: number[] = [];
  for (let j = 0; j < ins; j++) {
    let matters = false;
    for (const base of bases) {
      const flipped = [...base];
      flipped[j] = base[j] === 1 ? 0 : 1;
      const a = spec.behaviour!(bitsToValues(spec.inputs, base));
      const b = spec.behaviour!(bitsToValues(spec.inputs, flipped));
      const av = outputBitOf(spec, a, outBit);
      const bv = outputBitOf(spec, b, outBit);
      if (av !== bv) {
        matters = true;
        break;
      }
    }
    if (matters) deps.push(j);
  }
  return deps;
}

function outputBitOf(spec: DesignSpec, values: number[], bit: number): 0 | 1 {
  let flat = 0;
  for (const p of spec.outputs) {
    const w = Math.max(1, Math.round(p.width));
    const v = values[spec.outputs.indexOf(p)] ?? 0;
    for (let b = 0; b < w; b++) {
      if (flat === bit) return ((v >>> b) & 1) as 0 | 1;
      flat++;
    }
  }
  return 0;
}

/**
 * Per-bit exact synthesis.
 *
 * For every output bit: find the input bits it depends on, read its truth table
 * over them, and build the smallest exact network (Shannon expansion on the third
 * variable when there are three). The result is then *verified* against
 * assignments that set the non-dependency bits, because a bit can matter only in
 * combination with another — if the verification fails, the seed is not offered.
 *
 * The expansion is exact for any number of dependencies: a Shannon decision tree
 * over k variables reproduces the truth table by construction, so the real bound is
 * the node budget, not a limit on k. Two exact reductions keep that tree small —
 * variables a branch's sub-table does not vary with are dropped before splitting,
 * and a sub-function that is just its argument yields the ref itself rather than a
 * buffer — so a 4-to-1 multiplexer seeds as three muxes, the design an engineer
 * would draw, instead of twenty-one gates. `maxDeps` only caps how wide a table this is
 * willing to build (2^k behaviour calls) and `maxNodes` caps the network; when
 * either is exceeded the seed declines itself rather than offer a truncated, and
 * therefore wrong, architecture.
 *
 * The dependency set is exact whenever the full table over all input bits is
 * affordable (`outs · 2^ins ≤ maxBehaviourCalls`): the table is built once, each
 * variable is tested against every row, and the resulting network is then replayed
 * against every row as well. Beyond that budget the dependencies are estimated from
 * systematic bases and the network is verified on up to 512 random assignments
 * instead, which is a statistical guarantee, and the seed declines itself on any
 * mismatch.
 *
 * @returns null when the specification has no behaviour, when some output bit depends
 * on more than `maxDeps` input bits, when the table would exceed 4096 entries, when
 * the exact network would not fit in `maxNodes`, or when verification fails.
 */
export function truthTableSeed(
  spec: DesignSpec,
  rng: Rng,
  maxDeps = 10,
  maxNodes = 220,
  maxBehaviourCalls = 1 << 16,
): LogicGenome | null {
  if (!spec.behaviour) return null;
  const ins = inputBits(spec);
  const outs = outputBits(spec);
  if (ins === 0 || outs === 0) return null;
  const bitsOf = (m: number): number[] => {
    const b = new Array<number>(ins).fill(0);
    for (let i = 0; i < ins; i++) b[i] = (m >>> i) & 1;
    return b;
  };
  /**
   * Exact mode builds the complete truth table over every input bit, once per
   * output bit, and derives the dependency set from it. That makes the
   * dependencies provably right instead of merely plausible, and it is what the
   * verification below can then turn into a proof.
   */
  const exact = ins <= 24 && outs * (1 << ins) <= maxBehaviourCalls;
  const fullTables: number[][] | null = exact
    ? Array.from({ length: outs }, (_, k) => {
        const row = new Array<number>(1 << ins);
        // `behaviour` takes one word per input port, so the flat bit pattern has to
        // be packed first — feeding it raw bits silently reads the wrong operands.
        for (let m = 0; m < 1 << ins; m++) {
          row[m] = outputBitOf(spec, spec.behaviour!(bitsToValues(spec.inputs, bitsOf(m))), k);
        }
        return row;
      })
    : null;

  // Systematic bases, not random ones: an input bit can matter only in
  // combination with another (in a majority gate, A matters only when B or C is
  // set), and a handful of random bases can easily miss that — which would drop
  // the seed for a specification it handles perfectly. One-hot and one-cold bases
  // cover every pair (j, k) in both polarities, deterministically and in
  // 2 + 2·ins evaluations. They are only consulted when the full table is too
  // expensive to build, because a flip test from finitely many bases is not a
  // proof: the carry-out of a 2-bit adder ignores A0 from every systematic base
  // (A0 changes the carry only when the other four bits already sum to 3), so a
  // heuristic dependency set silently dropped A0 and the seed was wrong on the
  // four vectors where it mattered.
  const bases: number[][] = [new Array(ins).fill(0), new Array(ins).fill(1)];
  if (!fullTables) {
    for (let j = 0; j < ins; j++) {
      const one = new Array(ins).fill(0);
      one[j] = 1;
      bases.push(one);
      const zero = new Array(ins).fill(1);
      zero[j] = 0;
      bases.push(zero);
    }
    for (let i = 0; i < 4 && ins > 4; i++) bases.push(Array.from({ length: ins }, () => (rng.chance(0.5) ? 1 : 0)));
  }
  /** Dependencies of one output bit: read off the full table, or estimated. */
  const depsOf = (k: number): number[] => {
    if (!fullTables) return dependenciesOf(spec, k, bases, ins);
    const row = fullTables[k];
    const deps: number[] = [];
    for (let j = 0; j < ins; j++) {
      const step = 1 << j;
      for (let base = 0; base < row.length; base += step << 1) {
        let differs = false;
        for (let o = 0; o < step; o++) {
          if (row[base + o] !== row[base + o + step]) {
            differs = true;
            break;
          }
        }
        if (differs) {
          deps.push(j);
          break;
        }
      }
    }
    return deps;
  };

  const nodes: GenomeNode[] = [];
  // The budget is checked as nodes are pushed rather than estimated beforehand: a
  // decision tree prunes heavily when a variable turns out not to matter, so the
  // only honest bound is the count actually reached.
  let overBudget = false;
  const push = (fn: number, a: number, b: number = CONST0, c: number = CONST0): number => {
    nodes.push({ fn, a, b, c });
    if (nodes.length > maxNodes) overBudget = true;
    return ins + nodes.length - 1;
  };
  const out: number[] = [];

  for (let k = 0; k < outs; k++) {
    const deps = depsOf(k);
    if (deps.length > maxDeps) return null;
    // 2^k entries to expand: bounded so a wide dependency set costs a refusal, not
    // a stall. In exact mode the entries are a re-indexing of the table already
    // built; otherwise they cost 2^k behaviour calls.
    if (deps.length > 0 && 1 << deps.length > 4096) return null;
    const indexOf = (m: number): number => {
      let src = 0;
      for (let d = 0; d < deps.length; d++) if ((m >>> d) & 1) src |= 1 << deps[d];
      return src;
    };
    // Truth table over the dependencies, with every other input bit at 0 — which is
    // the whole function exactly when the dependency set is complete.
    const table: number[] = [];
    for (let m = 0; m < 1 << deps.length; m++) {
      if (fullTables) {
        table.push(fullTables[k][indexOf(m)]);
        continue;
      }
      const bits = new Array<number>(ins).fill(0);
      for (let d = 0; d < deps.length; d++) bits[deps[d]] = (m >>> d) & 1;
      table.push(outputBitOf(spec, spec.behaviour(bitsToValues(spec.inputs, bits)), k));
    }
    // Exact Shannon expansion over the dependencies, splitting on the last one.
    //
    // The previous version special-cased 0, 1, 2 and 3 dependencies and returned
    // null for anything wider. That was not a limitation of the method — a decision
    // tree is exact for every k — and the specifications it threw away are exactly
    // the interesting ones: a 4-to-1 multiplexer's output depends on all six of its
    // input bits (four data, two select), so it got no exact seed at all and the
    // search started from random networks of one to seven nodes, never finding a
    // working design in four thousand evaluations.
    /**
     * Which of `sub` the sub-table really varies with, and the sub-table re-indexed
     * over just those. Once a branch fixes the select bits of a multiplexer, its
     * remaining table is `Y = Dk` for one data bit — three of the four data
     * variables are then irrelevant, and expanding over them anyway would build a
     * tree of gates to reproduce a wire.
     */
    const relevant = (sub: number[], subTable: number[]): { sub: number[]; subTable: number[] } => {
      const keep: number[] = [];
      const keepAt: number[] = [];
      for (let i = 0; i < sub.length; i++) {
        const step = 1 << i;
        let matters = false;
        for (let base = 0; base < subTable.length && !matters; base += step << 1) {
          for (let o = 0; o < step; o++) {
            if (subTable[base + o] !== subTable[base + o + step]) {
              matters = true;
              break;
            }
          }
        }
        if (matters) {
          keep.push(sub[i]);
          keepAt.push(i);
        }
      }
      if (keep.length === sub.length) return { sub, subTable };
      const compacted: number[] = [];
      for (let m = 0; m < 1 << keep.length; m++) {
        let src = 0;
        for (let d = 0; d < keep.length; d++) if ((m >>> d) & 1) src |= 1 << keepAt[d];
        compacted.push(subTable[src]);
      }
      return { sub: keep, subTable: compacted };
    };
    const expandDeps = (rawSub: number[], rawTable: number[]): number => {
      const { sub, subTable } = relevant(rawSub, rawTable);
      if (sub.length === 0) return subTable[0] === 1 ? CONST1 : CONST0;
      if (sub.length === 1) {
        const v = (subTable[0] ?? 0) | ((subTable[1] ?? 0) << 1);
        // f = a needs no component at all: the ref already carries that value.
        return v === 0 ? CONST0 : v === 3 ? CONST1 : v === 2 ? sub[0] : push(FN.NOT, sub[0]);
      }
      // Two dependencies go through the 16-function two-input table, which realises
      // the sub-function with a single gate rather than a tree of them.
      if (sub.length === 2) return twoInputNodes(pack2(subTable, 0), sub[0], sub[1], push);
      const half = subTable.length >> 1;
      const sel = sub[sub.length - 1];
      const n0 = expandDeps(sub.slice(0, -1), subTable.slice(0, half));
      const n1 = expandDeps(sub.slice(0, -1), subTable.slice(half));
      // Both halves collapsed to the same ref: the select does not matter here, so no
      // mux is emitted and the tree prunes itself.
      if (n0 === n1) return n0;
      return push(FN.MUX, n0, n1, sel);
    };
    const ref = expandDeps(deps, table);
    if (overBudget) return null;
    // Verification. In exact mode the dependency set is complete by construction, so
    // replaying every row of the table through the built network is a proof that it
    // implements the specification on this bit — and it is what caught the eight
    // random probes being far too weak to notice a network that was wrong on four of
    // thirty-two vectors. Without the full table the check is statistical instead:
    // 512 random assignments catch a network wrong on as little as 1/32 of the space
    // with probability better than 1 − 1e−7. Either way a failure declines the seed
    // rather than hand the search a wrong architecture.
    const probes = fullTables ? 1 << deps.length : Math.min(1 << ins, 512);
    for (let probe = 0; probe < probes; probe++) {
      let bits: number[];
      let want: number;
      if (fullTables) {
        bits = new Array<number>(ins).fill(0);
        const src = indexOf(probe);
        for (let d = 0; d < deps.length; d++) bits[deps[d]] = (probe >>> d) & 1;
        want = fullTables[k][src];
      } else {
        bits = Array.from({ length: ins }, () => (rng.chance(0.5) ? 1 : 0));
        want = outputBitOf(spec, spec.behaviour(bitsToValues(spec.inputs, bits)), k);
      }
      if (evaluateRef(ref, bits, ins, nodes) !== want) return null;
    }
    out.push(ref);
  }
  return canonicalize({ inputs: ins, outputs: outs, nodes, out });
}

/** Evaluate one genome ref against a concrete input assignment (seed verifier). */
function evaluateRef(ref: number, bits: number[], ins: number, nodes: GenomeNode[]): 0 | 1 {
  const value = (r: number): 0 | 1 => {
    if (r === CONST0) return 0;
    if (r === CONST1) return 1;
    if (r < ins) return (bits[r] & 1) as 0 | 1;
    const n = nodes[r - ins];
    if (!n) return 0;
    const a = value(n.a);
    const b = value(n.b);
    const c = value(n.c);
    switch (n.fn) {
      case FN.BUF:
        return a;
      case FN.NOT:
        return (a ^ 1) as 0 | 1;
      case FN.AND:
        return (a & b) as 0 | 1;
      case FN.NAND:
        return ((a & b) ^ 1) as 0 | 1;
      case FN.OR:
        return (a | b) as 0 | 1;
      case FN.NOR:
        return ((a | b) ^ 1) as 0 | 1;
      case FN.XOR:
        return (a ^ b) as 0 | 1;
      case FN.XNOR:
        return ((a ^ b) ^ 1) as 0 | 1;
      case FN.MUX:
        return c === 1 ? b : a;
      default:
        return 0;
    }
  };
  return value(ref);
}

/**
 * Back-compatible name for `truthTableSeed`.
 *
 * The earlier version of this seed emitted a placeholder shape (`Y = ~A`) and let
 * the tier-1 filter reject it. That was honest but useless: a seed that is always
 * wrong does not diversify the search, it consumes population slots. The seed is
 * now exact or absent.
 */
export function bitwiseSeed(spec: DesignSpec, rng: Rng = new Rng(`${spec.name}:bitwise`)): LogicGenome | null {
  return truthTableSeed(spec, rng);
}

/** Whether `truthTableSeed` applies to this specification (for reports). */
export function truthTableApplies(spec: DesignSpec): boolean {
  return !!spec.behaviour;
}

export interface SeedOptions {
  /** How many random networks to add on top of the named architectures. */
  randomCount?: number;
  /**
   * Widest exact truth-table expansion to attempt, in input bits per output bit.
   * The node budget below is the binding constraint; this only caps how large a
   * truth table is built in order to find out.
   */
  maxDeps?: number;
  /** Node budget for the seeded genome (default: the genome limit). */
  maxNodes?: number;
  /**
   * Behaviour calls the truth-table seed may spend to build the full table over all
   * input bits. Inside the budget the dependency set is exact; beyond it the seed
   * falls back to estimated dependencies and statistical verification.
   */
  maxBehaviourCalls?: number;
  /** Include the named architectures that fit the specification. */
  architectures?: boolean;
}

export interface SeedSet {
  genomes: LogicGenome[];
  /** Which seed produced each genome, in the same order. */
  sources: string[];
}

/**
 * Build the starting population for a specification: every architecture seed that
 * actually applies to it, plus random networks so the search is never trapped
 * inside the seeds' shapes.
 */
export function templateSeeds(spec: DesignSpec, rng: Rng, opts: SeedOptions = {}): SeedSet {
  const genomes: LogicGenome[] = [];
  const sources: string[] = [];
  const add = (g: LogicGenome | null, source: string): void => {
    if (!g) return;
    genomes.push(g);
    sources.push(source);
  };
  if (opts.architectures !== false) {
    add(rippleSeed(spec), 'ripple');
    add(prefixSeed(spec), 'prefix');
    add(
      truthTableSeed(spec, rng, opts.maxDeps ?? 10, opts.maxNodes ?? 220, opts.maxBehaviourCalls ?? (1 << 16)),
      'truth table',
    );
    if (/^adder_|^alu_slice_|^subtractor_/.test(spec.name)) add(seededGenome(spec, rng), 'classic sum/carry');
  }
  const randomCount = opts.randomCount ?? 6;
  for (let i = 0; i < randomCount; i++) {
    genomes.push(randomGenome(spec, rng));
    sources.push('random');
  }
  return { genomes, sources };
}

/**
 * Human label for one bit of the specification, e.g. `A3` — the port name plus
 * the bit index, which is how the user wrote the specification (spec §24).
 */
export function bitLabel(spec: DesignSpec, k: number, dir: 'input' | 'output'): string {
  return bitName(dir === 'input' ? spec.inputs : spec.outputs, k);
}

/** Net name of an input bit inside a generated circuit (used by the explainer). */
export function inputBitNet(spec: DesignSpec, k: number): string {
  return inputNetName(spec, k);
}
