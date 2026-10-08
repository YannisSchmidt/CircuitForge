/**
 * Design specifications: *what* a circuit must do, said independently of how it
 * is built.
 *
 * A specification is the input of the whole synthesis flow, so it has to be
 * honest about its own strength:
 *
 *   - a `vectors` table is an exact contract: the design must reproduce every
 *     listed output for every listed input, and the validator says how many
 *     vectors it actually checked;
 *   - a `behaviour` function is a *generator* for such a table: it is expanded
 *     into vectors before the search starts, and the report says whether the
 *     expansion was exhaustive (every input combination, when the input space is
 *     small enough) or sampled (with the sampling stated: corners + seeded
 *     random vectors).
 *
 * Nothing here knows about gates, chips or costs: it is the specification an
 * optimizer is asked to meet.
 */

import { Rng } from '../util/rng.js';

export interface PortSpec {
  name: string;
  /** Width in bits (1 = a single wire). */
  width: number;
  direction: 'input' | 'output';
  description?: string;
}

export interface SpecVector {
  /** Value per input port, in port order (LSB-first bit order within a port). */
  in: number[];
  /** Expected value per output port. */
  out: number[];
}

export interface DesignSpec {
  name: string;
  description?: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  /**
   * The contract, spelled out. When absent, `behaviour` is used to build one
   * (which makes the contract a *generated* one — the report says so).
   */
  vectors?: SpecVector[];
  /** Outputs for given input-port values. Expanded into vectors. */
  behaviour?: (inputValues: number[]) => number[];
  /**
   * Input spaces up to this many bits are enumerated completely; above it the
   * expansion is sampled (corners + `maxVectors` seeded random vectors).
   */
  exhaustiveBitLimit?: number;
  /** Cap on generated vectors when the input space is sampled. */
  maxVectors?: number;
  /** Default true: a combinational loop is a defect, not a feature. */
  combinational?: boolean;
}

/** Bit index range of each port, in a flat bit numbering. */
export interface BitRange {
  port: string;
  index: number;
  width: number;
  /** Index of the first bit of this port in the flat bit numbering. */
  offset: number;
}

export function totalWidth(ports: readonly PortSpec[]): number {
  let n = 0;
  for (const p of ports) n += Math.max(1, Math.round(p.width));
  return n;
}

export function bitRanges(ports: readonly PortSpec[]): BitRange[] {
  const out: BitRange[] = [];
  let offset = 0;
  for (const p of ports) {
    const width = Math.max(1, Math.round(p.width));
    out.push({ port: p.name, index: 0, width, offset });
    offset += width;
  }
  return out;
}

export const inputBits = (spec: DesignSpec): number => totalWidth(spec.inputs);
export const outputBits = (spec: DesignSpec): number => totalWidth(spec.outputs);

/** Name of the flat bit `k` of an input/output list, e.g. `A3`. */
export function bitName(ports: readonly PortSpec[], k: number): string {
  for (const range of bitRanges(ports)) {
    if (k >= range.offset && k < range.offset + range.width) return `${range.port}${k - range.offset}`;
  }
  return `x${k}`;
}

/** Port values → flat bits (LSB first inside each port). */
export function valuesToBits(ports: readonly PortSpec[], values: readonly number[]): number[] {
  const bits: number[] = [];
  const ranges = bitRanges(ports);
  for (let i = 0; i < ranges.length; i++) {
    const v = values[i] ?? 0;
    for (let b = 0; b < ranges[i].width; b++) bits.push((v >>> b) & 1);
  }
  return bits;
}

/** Flat bits → port values. */
export function bitsToValues(ports: readonly PortSpec[], bits: readonly number[]): number[] {
  const values: number[] = [];
  for (const range of bitRanges(ports)) {
    let v = 0;
    for (let b = 0; b < range.width; b++) v |= ((bits[range.offset + b] ?? 0) & 1) << b;
    values.push(v >>> 0);
  }
  return values;
}

/** Max value a port of this width can carry. */
export function portMask(width: number): number {
  return width >= 32 ? 0xffffffff : (1 << width) - 1;
}

export interface VectorPlan {
  vectors: SpecVector[];
  /** 'exhaustive' = every input combination; 'sampled' = corners + random. */
  method: 'exhaustive' | 'sampled' | 'declared';
  /** What the plan is worth as evidence. */
  note: string;
}

/** Uniform random vector over the spec's input space. */
function randomInputs(spec: DesignSpec, rng: Rng): number[] {
  return spec.inputs.map((p) => rng.int(2 ** Math.min(32, Math.max(1, p.width))) & portMask(p.width));
}

/**
 * Build the vector set a search and its validator will use.
 *
 * Exhaustive up to `exhaustiveBitLimit` input bits (default 12 → 4096 vectors);
 * above that, corners (all-zero, all-one, one-hot per bit, alternating 0101/1010
 * on every port) plus seeded random vectors, with the count reported.
 */
export function planVectors(spec: DesignSpec, rng: Rng): VectorPlan {
  if (spec.vectors && spec.vectors.length > 0) {
    return {
      vectors: spec.vectors.map((v) => ({ in: [...v.in], out: [...v.out] })),
      method: 'declared',
      note: `${spec.vectors.length} vector(s) declared by the specification (the contract is exactly what is listed, nothing more)`,
    };
  }
  if (!spec.behaviour) {
    throw new Error(`specification "${spec.name}" has neither vectors nor a behaviour`);
  }
  const fn = spec.behaviour;
  const bits = inputBits(spec);
  const limit = spec.exhaustiveBitLimit ?? 12;
  const vectors: SpecVector[] = [];
  if (bits <= limit) {
    const total = 2 ** bits;
    for (let v = 0; v < total; v++) {
      const values: number[] = [];
      let shift = 0;
      for (const p of bitRanges(spec.inputs)) {
        const width = p.width;
        values.push((v >>> shift) & portMask(width));
        shift += width;
      }
      vectors.push({ in: values, out: fn(values).map((x) => x & 0xffffffff) });
    }
    return {
      vectors,
      method: 'exhaustive',
      note: `all ${total} input combination(s) of the ${bits}-bit input space were enumerated`,
    };
  }
  // Corners first: a search that fails a corner is worth rejecting early.
  const zero = spec.inputs.map(() => 0);
  const ones = spec.inputs.map((p) => portMask(p.width));
  const alt0 = spec.inputs.map((p, i) => (i % 2 === 0 ? 0 : portMask(p.width)));
  const alt1 = spec.inputs.map((p, i) => (i % 2 === 0 ? portMask(p.width) : 0));
  for (const values of [zero, ones, alt0, alt1]) vectors.push({ in: values, out: fn(values).map((x) => x & 0xffffffff) });
  for (const i of bitRanges(spec.inputs)) {
    for (let b = 0; b < i.width; b++) {
      const values = spec.inputs.map(() => 0);
      values[i.index] = 1 << b; // `bitRanges` returns one entry per port
      vectors.push({ in: values, out: fn(values).map((x) => x & 0xffffffff) });
    }
  }
  const cap = spec.maxVectors ?? 4096;
  while (vectors.length < cap) {
    const values = randomInputs(spec, rng);
    vectors.push({ in: values, out: fn(values).map((x) => x & 0xffffffff) });
  }
  return {
    vectors,
    method: 'sampled',
    note:
      `the ${bits}-bit input space is too large to enumerate: ${vectors.length} vector(s) — ` +
      `4 corners, one per single input bit, and seeded random vectors (the residue is not covered)`,
  };
}

// ---------------------------------------------------------------------------
// Canned specifications (the reference list the project ships with)
// ---------------------------------------------------------------------------

function namedPorts(names: readonly string[], width: number, direction: 'input' | 'output', description?: string): PortSpec[] {
  return names.map((name) => ({ name, width, direction, description }));
}

/** `A[n-1:0] + B[n-1:0] → S[n-1:0]` plus carry-out. The reverse-engineering example. */
export function adderSpec(bits: number): DesignSpec {
  const mask = portMask(bits);
  return {
    name: `adder_${bits}`,
    description: `${bits}-bit unsigned adder: A + B → S, with carry out`,
    inputs: [...namedPorts(['A', 'B'], bits, 'input'), { name: 'CI', width: 1, direction: 'input', description: 'carry in' }],
    outputs: [{ name: 'S', width: bits, direction: 'output' }, { name: 'CO', width: 1, direction: 'output', description: 'carry out' }],
    behaviour: ([a, b, ci]) => {
      const sum = (a + b + ci) >>> 0;
      return [sum & mask, (sum >>> bits) & 1];
    },
  };
}

/** `A - B → D`, borrow out. */
export function subtractorSpec(bits: number): DesignSpec {
  const mask = portMask(bits);
  return {
    name: `subtractor_${bits}`,
    description: `${bits}-bit unsigned subtractor: A - B → D, with borrow`,
    inputs: namedPorts(['A', 'B'], bits, 'input'),
    outputs: [{ name: 'D', width: bits, direction: 'output' }, { name: 'BO', width: 1, direction: 'output' }],
    behaviour: ([a, b]) => {
      const d = (a - b) >>> 0;
      return [d & mask, a < b ? 1 : 0];
    },
  };
}

/** Magnitude comparator: A > B, A = B, A < B. */
export function comparatorSpec(bits: number): DesignSpec {
  return {
    name: `comparator_${bits}`,
    description: `${bits}-bit magnitude comparator`,
    inputs: namedPorts(['A', 'B'], bits, 'input'),
    outputs: [
      { name: 'GT', width: 1, direction: 'output' },
      { name: 'EQ', width: 1, direction: 'output' },
      { name: 'LT', width: 1, direction: 'output' },
    ],
    behaviour: ([a, b]) => [a > b ? 1 : 0, a === b ? 1 : 0, a < b ? 1 : 0],
  };
}

/** One ALU slice: the operation is a 4-bit opcode (A+B, A-B, AND, OR, XOR, NOT A, shift). */
export function aluSliceSpec(bits: number): DesignSpec {
  const mask = portMask(bits);
  return {
    name: `alu_slice_${bits}`,
    description: `${bits}-bit ALU: op 0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 NOT, 6 SHL, 7 SHR`,
    inputs: [...namedPorts(['A', 'B'], bits, 'input'), { name: 'OP', width: 3, direction: 'input' }],
    outputs: [{ name: 'Y', width: bits, direction: 'output' }, { name: 'CO', width: 1, direction: 'output' }],
    behaviour: ([a, b, op]) => {
      switch (op) {
        case 0: {
          const s = (a + b) >>> 0;
          return [s & mask, (s >>> bits) & 1];
        }
        case 1: {
          const d = (a - b) >>> 0;
          return [d & mask, a < b ? 1 : 0];
        }
        case 2:
          return [a & b, 0];
        case 3:
          return [a | b, 0];
        case 4:
          return [a ^ b, 0];
        case 5:
          return [(~a) & mask, 0];
        case 6:
          return [(a << 1) & mask, (a >>> (bits - 1)) & 1];
        default:
          return [a >>> 1, a & 1];
      }
    },
  };
}

/** `Y = A & ~B` — a two-gate problem a search must get right in a few generations. */
export function andNotSpec(bits: number): DesignSpec {
  const mask = portMask(bits);
  return {
    name: `and_not_${bits}`,
    description: `${bits}-bit bitwise A & ~B`,
    inputs: namedPorts(['A', 'B'], bits, 'input'),
    outputs: [{ name: 'Y', width: bits, direction: 'output' }],
    behaviour: ([a, b]) => [(a & ~b) & mask],
  };
}

/** Majority-of-three, per bit. Small enough to enumerate exhaustively for a whole byte. */
export function majoritySpec(bits: number): DesignSpec {
  const mask = portMask(bits);
  return {
    name: `majority_${bits}`,
    description: `${bits}-wide majority of three inputs, bitwise`,
    inputs: namedPorts(['A', 'B', 'C'], bits, 'input'),
    outputs: [{ name: 'Y', width: bits, direction: 'output' }],
    behaviour: ([a, b, c]) => {
      let y = 0;
      for (let i = 0; i < bits; i++) {
        const one = ((a >>> i) & 1) + ((b >>> i) & 1) + ((c >>> i) & 1);
        if (one >= 2) y |= 1 << i;
      }
      return [y & mask];
    },
  };
}

/** 2^n-to-1 multiplexer driven bit-select: one output bit per data input. */
export function muxSpec(width: number, selectBits: number): DesignSpec {
  const inputs: PortSpec[] = [{ name: 'D', width: 1 << selectBits, direction: 'input', description: 'data word, one bit per channel' }];
  for (let i = 0; i < selectBits; i++) inputs.push({ name: `S${i}`, width: 1, direction: 'input' });
  return {
    name: `mux_${1 << selectBits}_to_1`,
    description: `${1 << selectBits}-to-1 multiplexer`,
    inputs,
    outputs: [{ name: 'Y', width: 1, direction: 'output' }],
    behaviour: (values) => {
      const data = values[0];
      let sel = 0;
      for (let i = 0; i < selectBits; i++) sel |= (values[1 + i] & 1) << i;
      return [(data >>> sel) & 1];
    },
    exhaustiveBitLimit: 16,
  };
}

/** Human-readable one-liner for reports. */
export function describeSpec(spec: DesignSpec): string {
  const fmt = (p: PortSpec) => `${p.name}${p.width > 1 ? `[${p.width - 1}:0]` : ''}`;
  const ins = spec.inputs.map(fmt).join(', ');
  const outs = spec.outputs.map(fmt).join(', ');
  return `${spec.name}: ${ins} → ${outs} — ${spec.description ?? 'no description'}`;
}

// ---------------------------------------------------------------------------
// Named catalogue — the bridge between a JSON job spec and a live DesignSpec
// ---------------------------------------------------------------------------

/**
 * A `DesignSpec` carries a `behaviour` *function*, so it cannot be serialised.
 * The catalogue solves that honestly: a job stores `{ id, params }`, and the
 * engine rebuilds the same specification from the same id and parameters. Two
 * runs of the same job therefore measure the same contract, which is what makes
 * a resumed job comparable to the one that was interrupted.
 */
export interface SpecParam {
  name: string;
  default: number;
  min: number;
  max: number;
  description: string;
}

export interface SpecCatalogEntry {
  id: string;
  name: string;
  description: string;
  params: SpecParam[];
  build: (params: Record<string, number>) => DesignSpec;
}

const bitsParam = (name: string, def: number, min: number, max: number, description: string): SpecParam => ({ name, default: def, min, max, description });

export const SPEC_CATALOG: SpecCatalogEntry[] = [
  {
    id: 'adder',
    name: 'Adder',
    description: 'A + B → S with carry in/out',
    params: [bitsParam('bits', 4, 1, 16, 'Operand width')],
    build: (p) => adderSpec(p.bits ?? 4),
  },
  {
    id: 'subtractor',
    name: 'Subtractor',
    description: 'A - B → D with borrow out',
    params: [bitsParam('bits', 4, 1, 16, 'Operand width')],
    build: (p) => subtractorSpec(p.bits ?? 4),
  },
  {
    id: 'comparator',
    name: 'Magnitude comparator',
    description: 'A > B, A = B, A < B',
    params: [bitsParam('bits', 4, 1, 16, 'Operand width')],
    build: (p) => comparatorSpec(p.bits ?? 4),
  },
  {
    id: 'alu_slice',
    name: 'ALU',
    description: 'ADD, SUB, AND, OR, XOR, NOT, SHL, SHR selected by a 3-bit opcode',
    params: [bitsParam('bits', 4, 1, 16, 'Operand width')],
    build: (p) => aluSliceSpec(p.bits ?? 4),
  },
  {
    id: 'and_not',
    name: 'A & ~B',
    description: 'Bitwise AND with an inverted operand',
    params: [bitsParam('bits', 4, 1, 32, 'Operand width')],
    build: (p) => andNotSpec(p.bits ?? 4),
  },
  {
    id: 'majority',
    name: 'Majority of three',
    description: 'Bitwise majority vote over A, B, C',
    params: [bitsParam('bits', 4, 1, 32, 'Operand width')],
    build: (p) => majoritySpec(p.bits ?? 4),
  },
  {
    id: 'mux',
    name: 'Multiplexer',
    description: '2^n-to-1 multiplexer, one data bit per channel',
    params: [bitsParam('selectBits', 2, 1, 4, 'Number of select bits')],
    build: (p) => muxSpec(1 << (p.selectBits ?? 2), p.selectBits ?? 2),
  },
];

/** Ids in the catalogue, in display order. */
export function specIds(): string[] {
  return SPEC_CATALOG.map((e) => e.id);
}

export function specCatalogEntry(id: string): SpecCatalogEntry | undefined {
  return SPEC_CATALOG.find((e) => e.id === id);
}

/** Default parameters of a catalogue entry. */
export function specDefaultParams(entry: SpecCatalogEntry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of entry.params) out[p.name] = p.default;
  return out;
}

/**
 * Rebuild a specification from a serialisable reference.
 * @throws when the id is unknown — an unknown specification must never silently
 * become a different one.
 */
export function buildSpecById(id: string, params: Record<string, number> = {}): DesignSpec {
  const entry = specCatalogEntry(id);
  if (!entry) throw new Error(`unknown design specification "${id}" (known: ${specIds().join(', ')})`);
  const merged = specDefaultParams(entry);
  for (const p of entry.params) {
    const raw = params[p.name];
    if (raw === undefined) continue;
    const v = Math.round(Number(raw));
    merged[p.name] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return entry.build(merged);
}
