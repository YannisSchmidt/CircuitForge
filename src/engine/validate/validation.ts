/**
 * Automatic validation — the gate a circuit must pass before it is allowed to
 * become a chip, and the answer to "is this design actually correct?".
 *
 * The module is built around one rule that the rest of the engine shares: a
 * number in a report must have been measured, by a named model, at a named
 * simulation level, under stated conditions. Nothing here extrapolates:
 *
 *   - `logic`      compares outputs against the behavioural contract vector by
 *                  vector, at level 0. The report says how many vectors were
 *                  checked and whether the coverage was exhaustive or sampled.
 *   - `edge`       drives the classic corner patterns (all-zero, all-one,
 *                  walking ones, walking zeros, one-hot, ±1 around each corner)
 *                  and reports each one separately.
 *   - `random`     drives seeded random vectors — the seed is in the report, so
 *                  the run is reproducible.
 *   - `electrical` solves the level-1 DC operating point of the *expanded*
 *                  netlist (gates become transistors when a CMOS expansion
 *                  exists) and checks convergence, node voltages against the
 *                  rails and the absence of NaN/Inf.
 *   - `power`      reads the solved operating point: gross dissipation, gross
 *                  supply, and the conservation balance between the two.
 *   - `timing`     runs the timing engine and reports the critical path, the
 *                  clock-period lower bound and the setup slack.
 *   - `thermal`    runs the level-3 electro-thermal steady state and reports the
 *                  hottest node.
 *   - `stability`  re-runs the checks and requires bit-identical results: a
 *                  simulator that is not deterministic is not a simulator.
 *   - `erc`        and `serialization` cover structural rules and the round trip
 *                  through the file format.
 *
 * A check that could not run (no behavioural contract, no analog elements, no
 * registers…) is reported as `skipped` with the reason. It is never reported as
 * passed, and a skipped check never contributes to the verdict.
 */

import { Accuracy, Severity, weakerAccuracy, type Diagnostic } from '../core/labels.js';
import { Kind } from '../core/kinds.js';
import type { Library, ParamBag } from '../core/library.js';
import { ChipLibrary, type Chip } from '../core/chip.js';
import type { Circuit } from '../core/circuit.js';
import { flatten, nodeNameAt, elementNodes, type FlatNetlist } from '../sim/netlist.js';
import { CircuitSimulator, type TransientRequest } from '../sim/solver.js';
import { buildLogicGraph, LogicVectorSim, type LogicGraph } from '../analysis/logic.js';
import { analyzeTiming, describePath, type TimingReport } from '../analysis/timing.js';
import { declaredDelays } from '../analysis/tech.js';
import { circuitToDocument, circuitFromDocument } from '../io/serialize.js';
import { Rng } from '../util/rng.js';
import { ENGINE_VERSION, MODEL_VERSIONS, provenance } from '../util/version.js';
import { cpuCores, detectPlatform } from '../util/platform.js';
import { planVectors, type DesignSpec, type PortSpec, type SpecVector } from '../optim/spec.js';
import { simulateVectors } from '../optim/cost.js';

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type CheckId =
  | 'erc'
  | 'logic'
  | 'edge'
  | 'random'
  | 'electrical'
  | 'power'
  | 'timing'
  | 'thermal'
  | 'stability'
  | 'serialization';

export interface CheckCase {
  /** Human-readable name of this single case inside the check. */
  name: string;
  passed: boolean;
  /** What was observed (numbers, vectors, node names…). */
  detail: string;
}

export interface ValidationCheck {
  id: CheckId;
  name: string;
  /** Simulation level this check ran at (0 = logic, 1 = electrical, 3 = thermal). */
  level: number;
  /** Honest accuracy of the model that produced the numbers. */
  accuracy: Accuracy;
  ran: boolean;
  skippedReason: string | null;
  /**
   * True when the check could not run *and* its absence makes a verdict
   * impossible — e.g. the specification's ports are not on the circuit, so the
   * contract was never applied. A blocking skip downgrades the whole report to
   * NOT VALIDATED: saying "validated" while the functional contract went
   * unchecked would be exactly the claim this module exists to prevent.
   *
   * A check the caller switched off is not blocking: asking for the ERC only is a
   * legitimate request, and the report lists what ran.
   */
  blocking: boolean;
  passed: number;
  failed: number;
  skipped: number;
  cases: CheckCase[];
  /** Measured values worth keeping (never invented). */
  metrics: Record<string, number | string | null>;
  diagnostics: Diagnostic[];
  ms: number;
  /** What this check does *not* cover — always stated. */
  limits: string[];
}

export interface ValidationTotals {
  checks: number;
  ran: number;
  skippedChecks: number;
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ValidationReport {
  /**
   * The only claim this module makes. `VALIDATED UNDER THE STATED CONDITIONS`
   * means every check that ran passed, and the conditions are listed. It never
   * says "correct in general".
   */
  claim: 'VALIDATED UNDER THE STATED CONDITIONS' | 'FAILED VALIDATION' | 'NOT VALIDATED';
  subject: {
    kind: 'circuit' | 'chip';
    name: string;
    fingerprint: string;
    components: number;
    nets: number;
    ports: { inputs: number; outputs: number };
    chipId?: string;
    chipVersion?: string;
    params?: ParamBag;
  };
  conditions: {
    seed: number | string;
    ambient: number;
    vdd: number;
    vectors: { total: number; method: string; note: string; exhaustive: boolean };
    repeats: number;
    maxTemperature: number;
    clockPeriod: number | null;
    gateExpansion: boolean;
    /** Which electrical implementation of the logic gates was measured. */
    gateStyle: string;
  };
  checks: ValidationCheck[];
  totals: ValidationTotals;
  /** True only when at least one check ran and none failed. */
  ok: boolean;
  failures: string[];
  notes: string[];
  reproducibility: {
    engineVersion: string;
    modelVersions: Record<string, string>;
    hardware: { platform: string; cores: number; cpu: string };
    provenance: ReturnType<typeof provenance>;
    wallMs: number;
  };
}

export interface ValidationLevels {
  erc?: boolean;
  logic?: boolean;
  edge?: boolean;
  random?: boolean;
  electrical?: boolean;
  power?: boolean;
  timing?: boolean;
  thermal?: boolean;
  stability?: boolean;
  serialization?: boolean;
}

export interface ValidationOptions {
  lib: Library;
  chips?: ChipLibrary;
  /**
   * Behavioural contract. When absent, the logic checks fall back to
   * "outputs are determined" (no X/Z), which is weaker and says so.
   */
  spec?: DesignSpec;
  /** Parameter set for a parametric chip (ignored for a plain circuit). */
  params?: ParamBag;
  seed?: number | string;
  /** Which checks to run; all default to true. */
  levels?: ValidationLevels;
  /** Input spaces up to this many bits are enumerated completely. */
  exhaustiveBitLimit?: number;
  /** Number of seeded random vectors. */
  randomVectors?: number;
  /** Determinism repeats for the stability check. */
  repeats?: number;
  ambient?: number;
  vdd?: number;
  /** A node hotter than this (°C) fails the thermal check. */
  maxTemperature?: number;
  /** A node voltage outside ±this (V) fails the electrical check. */
  maxNodeVoltage?: number;
  /** Target clock period (s) for the setup-slack verdict; null = report only. */
  clockPeriod?: number | null;
  /** Expand gates to transistors for the electrical/thermal checks. */
  expandGates?: boolean;
  /** Extra vectors appended to the contract (edge cases the user cares about). */
  extraVectors?: SpecVector[];
  /** Transient duration for the stability check (s); 0 = skip the transient. */
  transientStop?: number;
  /**
   * Implementation style forced on every logic gate before flattening:
   * `'cmos_static'`, `'pass_transistor'` or `'transmission_gate'` expand the gates
   * to their transistor network, which is what makes the level-1 and level-3
   * numbers describe devices rather than the idealised gate model.
   *
   * Omitted (the default) keeps the style each gate was authored with. The report
   * always says which style was measured, and the logic checks are unaffected —
   * the style changes the electrical implementation, never the truth table.
   */
  gateStyle?: 'ideal' | 'cmos_static' | 'pass_transistor' | 'transmission_gate';
}

export const DEFAULT_VALIDATION: Required<
  Pick<ValidationOptions, 'exhaustiveBitLimit' | 'randomVectors' | 'repeats' | 'ambient' | 'vdd' | 'maxTemperature' | 'maxNodeVoltage' | 'expandGates' | 'transientStop'>
> = {
  exhaustiveBitLimit: 12,
  randomVectors: 64,
  repeats: 3,
  ambient: 25,
  vdd: 3.3,
  maxTemperature: 125,
  maxNodeVoltage: 6,
  expandGates: true,
  transientStop: 0,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e3) return `${v.toFixed(1)}`;
  if (a >= 1) return `${v.toFixed(digits)}`;
  if (a >= 1e-3) return `${(v * 1e3).toFixed(digits)} m`;
  if (a >= 1e-6) return `${(v * 1e6).toFixed(digits)} µ`;
  if (a >= 1e-9) return `${(v * 1e9).toFixed(digits)} n`;
  if (a >= 1e-12) return `${(v * 1e12).toFixed(digits)} p`;
  return v.toExponential(3);
}

const fmtV = (v: number) => `${fmt(v)} V`;
const fmtA = (v: number) => `${fmt(v)} A`;
const fmtW = (v: number) => `${fmt(v)} W`;
const fmtS = (v: number) => `${fmt(v)} s`;

function newCheck(id: CheckId, name: string, level: number, accuracy: Accuracy, limits: string[]): ValidationCheck {
  return {
    id,
    name,
    level,
    accuracy,
    ran: false,
    skippedReason: null,
    blocking: false,
    passed: 0,
    failed: 0,
    skipped: 0,
    cases: [],
    metrics: {},
    diagnostics: [],
    ms: 0,
    limits,
  };
}

function record(check: ValidationCheck, c: CheckCase): void {
  check.cases.push(c);
  if (c.passed) check.passed++;
  else check.failed++;
}

function skip(check: ValidationCheck, reason: string, blocking = false): void {
  check.ran = false;
  check.skippedReason = reason;
  check.skipped = 1;
  check.blocking = blocking;
}

/** Gate spec ids whose `style` parameter selects an electrical implementation. */
const GATE_SPEC_IDS = new Set(['not_gate', 'buffer', 'and_gate', 'nand_gate', 'or_gate', 'nor_gate', 'xor_gate', 'xnor_gate', 'tristate']);

/**
 * Return a copy of `circuit` whose logic gates use `style`.
 *
 * A copy, never the caller's circuit: validation must not edit the design it is
 * asked about. The truth table of a gate does not depend on its style, so the
 * logic checks see the same behaviour; the level-1 and level-3 checks see the
 * transistor network the style implies.
 */
export function withGateStyle(circuit: Circuit, style: string): { circuit: Circuit; gates: number } {
  let gates = 0;
  const copy = circuit.clone();
  for (const inst of copy.allComponents()) {
    if (!GATE_SPEC_IDS.has(inst.specId)) continue;
    copy.setParam(inst.id, 'style', style);
    gates++;
  }
  return { circuit: copy, gates };
}

/** Port list of a circuit, split by direction. */
export function circuitPorts(circuit: Circuit): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const inputs: PortSpec[] = [];
  const outputs: PortSpec[] = [];
  for (const p of circuit.allPorts()) {
    const spec: PortSpec = { name: p.name, width: Math.max(1, p.width), direction: p.direction === 'input' ? 'input' : 'output', description: p.description };
    if (p.direction === 'input') inputs.push(spec);
    else outputs.push(spec);
  }
  return { inputs, outputs };
}

/**
 * Build a specification from a circuit's own ports. It carries no `behaviour`,
 * so the logic checks it feeds can only verify that the outputs are determined
 * — and the report says exactly that.
 */
/**
 * Group per-bit circuit ports into vector ports.
 *
 * A sheet exposes one port per bit (`A0`, `A1`, …); a specification describes one
 * port per vector (`A`, width 4) and the harness rebuilds the bit names as
 * `A0`…`A3`. Grouping is what makes the two conventions meet. A port whose name
 * has no trailing index (`CI`, `CO`, `EN`) stays as it is and is looked up by its
 * own name.
 */
function groupBitPorts(ports: PortSpec[]): PortSpec[] {
  const groups = new Map<string, { base: string; indices: number[]; plain: PortSpec[] }>();
  const order: string[] = [];
  for (const p of ports) {
    const m = /^(.*?)(\d+)$/.exec(p.name);
    if (!m || p.width !== 1) {
      const key = `plain:${p.name}`;
      if (!groups.has(key)) {
        groups.set(key, { base: '', indices: [], plain: [] });
        order.push(key);
      }
      groups.get(key)!.plain.push(p);
      continue;
    }
    const base = m[1] || p.name;
    const key = `idx:${base}`;
    if (!groups.has(key)) {
      groups.set(key, { base, indices: [], plain: [] });
      order.push(key);
    }
    groups.get(key)!.indices.push(Number(m[2]));
  }
  const out: PortSpec[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    for (const p of g.plain) out.push(p);
    if (g.indices.length === 0) continue;
    g.indices.sort((a, b) => a - b);
    // Only a contiguous run from 0 is a vector; anything else is left per-bit so
    // that a design with A1 and A7 but no A2..A6 is not silently renumbered.
    const contiguous = g.indices.every((v, i) => v === i);
    if (contiguous) out.push({ name: g.base, width: g.indices.length, direction: g.plain[0]?.direction ?? (ports.find((p) => p.name === `${g.base}${g.indices[0]}`)?.direction ?? 'input') });
    else for (const i of g.indices) out.push({ name: `${g.base}${i}`, width: 1, direction: ports.find((p) => p.name === `${g.base}${i}`)?.direction ?? 'input' });
  }
  return out;
}

export function specFromCircuit(circuit: Circuit, name = circuit.name): DesignSpec {
  const raw = circuitPorts(circuit);
  const inputs = groupBitPorts(raw.inputs);
  const outputs = groupBitPorts(raw.outputs);
  return {
    name,
    description: `Port contract derived from the circuit "${circuit.name}" — no behavioural expectation was supplied, so the logic checks verify that every output is determined (never X or Z) for the vectors that ran.`,
    inputs,
    outputs,
    combinational: true,
  };
}

/** Number of input bits a spec asks for. */
function specInputBits(spec: DesignSpec): number {
  let n = 0;
  for (const p of spec.inputs) n += Math.max(1, Math.round(p.width));
  return n;
}

// ---------------------------------------------------------------------------
// Vector planning for validation
// ---------------------------------------------------------------------------

export interface ValidationVectors {
  contract: SpecVector[];
  edges: Array<{ name: string; vectors: SpecVector[] }>;
  random: SpecVector[];
  plan: ReturnType<typeof planVectors>;
  exhaustive: boolean;
  total: number;
  note: string;
}

/**
 * Corner patterns worth their own report line: they are where real designs break
 * (carry chains, sign bits, enable polarity), and they cost nothing to run.
 */
function edgePatterns(spec: DesignSpec): Array<{ name: string; vectors: SpecVector[] }> {
  const groups: Array<{ name: string; vectors: SpecVector[] }> = [];
  const nIn = spec.inputs.length;
  const allZero = () => spec.inputs.map(() => 0);
  const allOne = () => spec.inputs.map((p) => (p.width >= 32 ? 0xffffffff : (1 << Math.max(1, p.width)) - 1));

  groups.push({ name: 'all inputs low', vectors: [{ in: allZero(), out: [] }] });
  groups.push({ name: 'all inputs high', vectors: [{ in: allOne(), out: [] }] });

  // Walking one / walking zero over every input bit.
  const walkingOne: SpecVector[] = [];
  const walkingZero: SpecVector[] = [];
  for (let pi = 0; pi < nIn; pi++) {
    const width = Math.max(1, spec.inputs[pi].width);
    for (let b = 0; b < width; b++) {
      const v = allZero();
      v[pi] = (1 << b) >>> 0;
      walkingOne.push({ in: v, out: [] });
      const w = allOne();
      w[pi] = (~(1 << b) & ((1 << width) - 1)) >>> 0;
      walkingZero.push({ in: w, out: [] });
    }
  }
  if (walkingOne.length) groups.push({ name: 'walking one', vectors: walkingOne });
  if (walkingZero.length) groups.push({ name: 'walking zero', vectors: walkingZero });

  // One-hot per port and its ±1 neighbours (the carry/borrow boundaries).
  const neighbours: SpecVector[] = [];
  const maskOf = (q: number): number => {
    const w = Math.max(1, Math.round(spec.inputs[q].width));
    return w >= 32 ? 0xffffffff : (1 << w) - 1;
  };
  for (let pi = 0; pi < nIn; pi++) {
    const mask = maskOf(pi);
    for (const delta of [1, -1]) {
      for (const base of [0, mask]) {
        const v = allZero();
        // Every port is set to a value its *own* width can carry: the other ports
        // hold the same corner while this one steps ±1 across it. Masking the whole
        // vector with port pi's mask instead — which is what this loop did — puts 15
        // on a 1-bit carry-in, and the two sides then disagree about what was tested:
        // the harness drives one lane, so it applies 1, while `behaviour` is asked
        // about 15. A correct 4-bit adder failed 10 of its own 12 edge vectors that
        // way, against an exhaustive contract run that had already matched all 512.
        for (let q = 0; q < nIn; q++) v[q] = base & maskOf(q);
        v[pi] = ((base + delta) & mask) >>> 0;
        neighbours.push({ in: v, out: [] });
      }
    }
  }
  if (neighbours.length) groups.push({ name: '±1 around each corner', vectors: neighbours });

  // Maximum-minimum mixed: half the ports high, half low, both parities.
  const mixed: SpecVector[] = [];
  for (const parity of [0, 1]) {
    const v = allZero();
    for (let pi = 0; pi < nIn; pi++) {
      const width = Math.max(1, spec.inputs[pi].width);
      const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
      v[pi] = ((pi + parity) % 2 === 0 ? mask : 0) >>> 0;
    }
    mixed.push({ in: v, out: [] });
  }
  if (mixed.length) groups.push({ name: 'alternating ports high/low', vectors: mixed });

  return groups;
}

/**
 * Fill in the expected outputs of vectors that arrive without them, using the
 * specification's behaviour. Vectors whose outputs stay empty can only be used
 * for the "outputs are determined" check, and the report says so.
 */
function fillExpectations(spec: DesignSpec, vectors: SpecVector[]): SpecVector[] {
  if (!spec.behaviour) return vectors;
  return vectors.map((v) => (v.out.length === spec.outputs.length ? v : { in: v.in, out: spec.behaviour!(v.in) }));
}

/**
 * The plan used when no contract exists: there is nothing to enumerate against,
 * so the vector set is the edge patterns plus seeded random inputs, and every
 * expected output stays empty (which makes the checks verify that the outputs are
 * *determined*, never that they are *right*). The report says exactly that.
 */
function noContractPlan(spec: DesignSpec): ValidationVectors['plan'] {
  return {
    vectors: [],
    method: 'sampled',
    note: `no behavioural contract was supplied for "${spec.name}": the input space was not enumerated, and no expected output exists to compare against`,
  };
}

export function planValidationVectors(spec: DesignSpec, opts: ValidationOptions, rng: Rng): ValidationVectors {
  const hasContract = spec.behaviour !== undefined || (spec.vectors !== undefined && spec.vectors.length > 0);
  const plan = hasContract ? planVectors(spec, rng) : noContractPlan(spec);
  const contract = [...plan.vectors, ...(opts.extraVectors ?? [])];
  const bits = specInputBits(spec);
  const exhaustive = plan.method === 'exhaustive' || plan.method === 'declared';
  const edges = edgePatterns(spec).map((g) => ({ name: g.name, vectors: fillExpectations(spec, g.vectors) }));
  const random: SpecVector[] = [];
  const nRandom = Math.max(0, opts.randomVectors ?? DEFAULT_VALIDATION.randomVectors);
  if (nRandom > 0 && spec.behaviour) {
    for (let i = 0; i < nRandom; i++) {
      const input = spec.inputs.map((p) => rng.int(2 ** Math.min(31, Math.max(1, p.width))));
      random.push({ in: input, out: spec.behaviour(input) });
    }
  }
  const total = contract.length + edges.reduce((n, g) => n + g.vectors.length, 0) + random.length;
  const note = !hasContract
    ? `${edges.reduce((n, g) => n + g.vectors.length, 0)} edge-case vector(s), no behavioural contract`
    :
    `${contract.length} contract vector(s) (${plan.method})` +
    (exhaustive ? '' : ` — the ${bits}-bit input space was sampled, not enumerated`) +
    `, ${edges.reduce((n, g) => n + g.vectors.length, 0)} edge-case vector(s)` +
    `, ${random.length} seeded random vector(s)`;
  return { contract, edges, random, plan, exhaustive: hasContract ? exhaustive : false, total, note };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function checkErc(circuit: Circuit, lib: Library, chips: ChipLibrary): ValidationCheck {
  // The accuracy class describes how faithfully a *physical phenomenon* is
  // modelled. The ERC models none: it is an exact structural test of the netlist,
  // so it is labelled REALISTIC and says plainly that it covers structure only.
  const check = newCheck('erc', 'Electrical rule check', 0, Accuracy.REALISTIC, [
    'Structural rules only (dangling pins, shorts, missing ground, port widths). It says nothing about behaviour, and it models no physical quantity.',
  ]);
  const t = Date.now();
  const diags = circuit.erc(lib, chips);
  check.diagnostics = diags;
  const errors = diags.filter((d) => d.severity === Severity.Error);
  const warnings = diags.filter((d) => d.severity === Severity.Warning);
  check.ran = true;
  record(check, {
    name: 'no error-severity rule violation',
    passed: errors.length === 0,
    detail: errors.length === 0 ? `${warnings.length} warning(s), 0 error(s)` : errors.map((e) => `${e.code}: ${e.message}`).slice(0, 8).join('; '),
  });
  record(check, {
    name: 'no warning-severity rule violation',
    passed: warnings.length === 0,
    detail: warnings.length === 0 ? 'clean' : warnings.map((e) => `${e.code}: ${e.message}`).slice(0, 8).join('; '),
  });
  check.metrics = { errors: errors.length, warnings: warnings.length, infos: diags.length - errors.length - warnings.length };
  check.ms = Date.now() - t;
  return check;
}

interface LogicHarness {
  nl: FlatNetlist;
  graph: LogicGraph;
  inputNodes: number[];
  outputNodes: number[];
  missing: string[];
}

/** Bind a spec's bits to netlist nodes. Missing bits are reported, never guessed. */
function buildHarness(nl: FlatNetlist, spec: DesignSpec): LogicHarness {
  const graph = buildLogicGraph(nl);
  const missing: string[] = [];
  const find = (base: string, b: number): number => {
    // Per-bit port naming first (`A3`), then the port's own name for bit 0 of a
    // vector that is exposed as a single port (`CO`, `CI`, `EN`).
    const p = nl.ports.find((x) => x.name === `${base}${b}`) ?? (b === 0 ? nl.ports.find((x) => x.name === base) : undefined);
    if (!p) {
      missing.push(`${base}${b}`);
      return -1;
    }
    return p.node;
  };
  const inputNodes: number[] = [];
  for (const p of spec.inputs) {
    const width = Math.max(1, Math.round(p.width));
    for (let b = 0; b < width; b++) inputNodes.push(find(p.name, b));
  }
  const outputNodes: number[] = [];
  for (const p of spec.outputs) {
    const width = Math.max(1, Math.round(p.width));
    for (let b = 0; b < width; b++) outputNodes.push(find(p.name, b));
  }
  return { nl, graph, inputNodes, outputNodes, missing };
}

/**
 * Drive one vector and read the outputs. Returns 'X'/'Z' for undetermined bits.
 * One `LogicVectorSim` pass carries all 32 lanes at once, so vectors are applied
 * in chunks.
 */
function applyVectors(h: LogicHarness, vectors: readonly SpecVector[], spec: DesignSpec): Array<{ got: Array<0 | 1 | 'X' | 'Z'>; want: number[] | null }> {
  const out: Array<{ got: Array<0 | 1 | 'X' | 'Z'>; want: number[] | null }> = [];
  const sim = new LogicVectorSim(h.graph);
  const chunk = 32;
  for (let base = 0; base < vectors.length; base += chunk) {
    const n = Math.min(chunk, vectors.length - base);
    let flat = 0;
    for (let pi = 0; pi < spec.inputs.length; pi++) {
      const width = Math.max(1, Math.round(spec.inputs[pi].width));
      for (let b = 0; b < width; b++, flat++) {
        const node = h.inputNodes[flat];
        if (node < 0) continue;
        let ones = 0;
        for (let i = 0; i < n; i++) {
          const v = vectors[base + i];
          if (((v.in[pi] ?? 0) >>> b) & 1) ones |= 1 << i;
        }
        sim.drive(node, ones >>> 0, 0);
      }
    }
    sim.settle();
    for (let i = 0; i < n; i++) {
      const v = vectors[base + i];
      const got: Array<0 | 1 | 'X' | 'Z'> = [];
      for (const node of h.outputNodes) got.push(node < 0 ? 'X' : sim.sample(node, i));
      out.push({ got, want: v.out.length === spec.outputs.length ? v.out : null });
    }
  }
  return out;
}

/**
 * One bit of the expected output, addressed the way the harness addresses the
 * measured one.
 *
 * `values` holds one packed number per output *port*, while `bit` counts output
 * *lanes* across all ports in declaration order — the same flattening `buildHarness`
 * used for `outputNodes` and `applyVectors` used for the inputs. The widths are
 * therefore not optional: walking 32 bits of the first port instead of `width` bits
 * of each port reads the expected value of the wrong port as soon as a spec has more
 * than one output port and the first is narrower than the total. A 1-bit adder (S
 * then CO) then compares the measured carry against the expected sum, which fails on
 * exactly the vectors where the two differ and looks like a broken design rather
 * than a broken comparison.
 */
function bitOf(values: readonly number[], bit: number, widths: readonly number[]): 0 | 1 {
  let flat = 0;
  for (let p = 0; p < values.length; p++) {
    const width = widths[p] ?? 1;
    const v = values[p] >>> 0;
    for (let b = 0; b < width; b++) {
      if (flat === bit) return ((v >>> b) & 1) as 0 | 1;
      flat++;
    }
    if (flat > bit) break;
  }
  // Out of range means the harness and the spec disagree about how many output bits
  // there are. Returning 0 keeps the comparison total; the mismatch it produces is
  // reported against the vector, which is where a reader looks for it.
  return 0;
}

/** Output port widths in declaration order — the flattening `bitOf` walks. */
function outputWidths(spec: DesignSpec): number[] {
  return spec.outputs.map((p) => Math.max(1, Math.round(p.width)));
}

function checkLogic(h: LogicHarness, spec: DesignSpec, vv: ValidationVectors, check: ValidationCheck): void {
  const t = Date.now();
  if (h.missing.length > 0) {
    skip(
      check,
      `the circuit does not expose the specification's port bits: ${h.missing.slice(0, 6).join(', ')}${h.missing.length > 6 ? '…' : ''}`,
      true,
    );
    check.ms = Date.now() - t;
    return;
  }
  check.ran = true;
  const hasBehaviour = spec.behaviour !== undefined || spec.vectors !== undefined;
  const widths = outputWidths(spec);
  const results = applyVectors(h, vv.contract, spec);
  let mismatches = 0;
  let undetermined = 0;
  let firstBad: string | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    for (let k = 0; k < r.got.length; k++) {
      const got = r.got[k];
      if (got === 'X' || got === 'Z') {
        undetermined++;
        if (!firstBad) firstBad = `vector ${i}: output bit ${k} is ${got}`;
        continue;
      }
      if (r.want) {
        const want = bitOf(r.want, k, widths);
        if (want !== got) {
          mismatches++;
          if (!firstBad) firstBad = `vector ${i}: output bit ${k} = ${got}, expected ${want}`;
        }
      }
    }
  }
  record(check, {
    name: hasBehaviour ? 'every contract vector reproduces the expected outputs' : 'every output is determined for every contract vector',
    passed: mismatches === 0 && undetermined === 0,
    detail:
      mismatches === 0 && undetermined === 0
        ? `${results.length} vector(s) × ${h.outputNodes.length} output bit(s) = ${results.length * h.outputNodes.length} comparison(s), all matched`
        : `${mismatches} mismatch(es), ${undetermined} undetermined bit(s); first: ${firstBad}`,
  });
  check.metrics = {
    vectors: results.length,
    outputBits: h.outputNodes.length,
    comparisons: results.length * h.outputNodes.length,
    mismatches,
    undetermined,
    coverage: vv.exhaustive ? 'exhaustive' : 'sampled',
    contract: hasBehaviour ? 'behavioural' : 'port contract only (no expectation supplied)',
  };
  check.accuracy = Accuracy.REALISTIC;
  check.ms = Date.now() - t;
}

function checkEdge(h: LogicHarness, spec: DesignSpec, vv: ValidationVectors): ValidationCheck {
  const check = newCheck('edge', 'Edge cases', 0, Accuracy.REALISTIC, [
    'Only the patterns listed here are covered; passing them does not prove the design correct elsewhere.',
  ]);
  const t = Date.now();
  if (h.missing.length > 0) {
    skip(check, `port bits missing from the circuit (${h.missing.length})`, true);
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  const widths = outputWidths(spec);
  let total = 0;
  let bad = 0;
  for (const group of vv.edges) {
    const results = applyVectors(h, group.vectors, spec);
    let mismatches = 0;
    let undetermined = 0;
    let firstBad = '';
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      for (let k = 0; k < r.got.length; k++) {
        const got = r.got[k];
        if (got === 'X' || got === 'Z') {
          undetermined++;
          if (!firstBad) firstBad = `vector ${i}, output bit ${k} = ${got}`;
          continue;
        }
        if (r.want) {
          const want = bitOf(r.want, k, widths);
          if (want !== got) {
            mismatches++;
            if (!firstBad) firstBad = `vector ${i}, output bit ${k} = ${got}, expected ${want}`;
          }
        }
      }
    }
    total += results.length;
    bad += mismatches + undetermined;
    record(check, {
      name: group.name,
      passed: mismatches === 0 && undetermined === 0,
      detail:
        mismatches + undetermined === 0
          ? `${results.length} vector(s), outputs determined${results[0]?.want ? ' and matching the contract' : ''}`
          : `${mismatches} mismatch(es), ${undetermined} undetermined; first: ${firstBad}`,
    });
  }
  check.metrics = { groups: vv.edges.length, vectors: total, failingVectors: bad };
  check.ms = Date.now() - t;
  return check;
}

/**
 * Seeded random vectors, compared against the behaviour when one was supplied.
 */
function checkRandomWithSpec(h: LogicHarness, spec: DesignSpec, vv: ValidationVectors, seed: number | string): ValidationCheck {
  const check = newCheck('random', 'Randomised vectors', 0, Accuracy.REALISTIC, [
    `Seeded with ${String(seed)}: the same seed always produces the same vectors, so a failure here is reproducible.`,
    'A random sample is evidence, not proof. The contract check states whether coverage was exhaustive.',
  ]);
  const t = Date.now();
  // Ports first: without them the vectors cannot be driven, and running anyway
  // would report every output as undetermined — a failure of the harness, not of
  // the design.
  if (h.missing.length > 0) {
    skip(check, `port bits missing from the circuit (${h.missing.length}): ${h.missing.slice(0, 6).join(', ')}${h.missing.length > 6 ? '…' : ''}`, true);
    check.ms = Date.now() - t;
    return check;
  }
  if (vv.random.length === 0) {
    skip(check, 'no behavioural contract was supplied, so there is nothing to compare a random vector against');
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  const widths = outputWidths(spec);
  const results = applyVectors(h, vv.random, spec);
  let mismatches = 0;
  let undetermined = 0;
  let firstBad = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    for (let k = 0; k < r.got.length; k++) {
      const got = r.got[k];
      if (got === 'X' || got === 'Z') {
        undetermined++;
        if (!firstBad) firstBad = `vector ${i}, output bit ${k} = ${got}`;
        continue;
      }
      if (r.want && bitOf(r.want, k, widths) !== got) {
        mismatches++;
        if (!firstBad) firstBad = `vector ${i}, output bit ${k} = ${got}, expected ${bitOf(r.want, k, widths)}`;
      }
    }
  }
  record(check, {
    name: `${vv.random.length} seeded random vectors`,
    passed: mismatches === 0 && undetermined === 0,
    detail:
      mismatches + undetermined === 0
        ? `${results.length} vector(s) × ${h.outputNodes.length} output bit(s) matched the behaviour`
        : `${mismatches} mismatch(es), ${undetermined} undetermined; first: ${firstBad}`,
  });
  check.metrics = { vectors: results.length, mismatches, undetermined, seed: String(seed) };
  check.ms = Date.now() - t;
  return check;
}

interface ElectricalContext {
  sim: CircuitSimulator;
  nl: FlatNetlist;
  solved: boolean;
  report: ReturnType<CircuitSimulator['dcSolve']> | null;
}

function solveDc(nl: FlatNetlist, opts: ValidationOptions): ElectricalContext {
  const sim = new CircuitSimulator(nl, { ambient: opts.ambient ?? DEFAULT_VALIDATION.ambient });
  let report: ReturnType<CircuitSimulator['dcSolve']> | null = null;
  let solved = false;
  try {
    report = sim.dcSolve({ quiet: true });
    solved = report.converged;
  } catch {
    solved = false;
  }
  return { sim, nl, solved, report };
}

/**
 * Elements that actually take part in the electrical solve. Ports and ground
 * symbols are bookkeeping: a netlist made only of those has no equation to solve,
 * and quoting a DC operating point for it would be a fabrication.
 */
function electricalElementCount(nl: FlatNetlist): number {
  let n = 0;
  for (let e = 0; e < nl.elementCount; e++) {
    const k = nl.kind[e];
    if (k === Kind.Port || k === Kind.Ground) continue;
    n++;
  }
  return n;
}

/** Logic elements that were kept behavioural (not expanded to transistors). */
function countBehaviouralGates(nl: FlatNetlist): number {
  let n = 0;
  for (let e = 0; e < nl.elementCount; e++) {
    const k = nl.kind[e];
    if (k === Kind.LogicGate || k === Kind.LogicBuf || k === Kind.TriState || k === Kind.Mux || k === Kind.Demux || k === Kind.DFlipFlop || k === Kind.DLatch) n++;
  }
  return n;
}

function hasAnalogElements(nl: FlatNetlist): boolean {
  return nl.nodeCount > 1 && electricalElementCount(nl) > 0;
}

/**
 * Whether node 0 is a real reference for this netlist.
 *
 * `hasGroundReference` tracks an explicit ground *symbol*. A gate expanded to its
 * CMOS transistor network ties its sources to node 0 without any symbol, so the
 * reference exists even though the flag is false — and reporting "this design
 * floats" for it would be wrong. Both facts are counted, and the case says which
 * one applied.
 */
function groundReference(nl: FlatNetlist): { referenced: boolean; explicit: boolean; users: number } {
  let users = 0;
  for (let e = 0; e < nl.elementCount; e++) {
    // `elementNodes` is the only correct accessor: the node stride is a property
    // of the netlist layout, not a constant this module may assume.
    const nodes = elementNodes(nl, e);
    for (let i = 0; i < nodes.length; i++) if (nodes[i] === 0) users++;
  }
  return { referenced: nl.hasGroundReference || users > 0, explicit: nl.hasGroundReference, users };
}

function checkElectrical(nl: FlatNetlist, ec: ElectricalContext, opts: ValidationOptions): ValidationCheck {
  const check = newCheck('electrical', 'Level-1 DC operating point', 1, Accuracy.APPROXIMATED, [
    'DC operating point only: no switching, no transient overshoot, no AC behaviour.',
    'Gates are expanded to their CMOS transistor network when such an expansion exists; the delay and energy of that expansion follow the declared device models, not a foundry.',
  ]);
  const t = Date.now();
  if (!hasAnalogElements(nl)) {
    skip(check, 'the flattened netlist has no electrical element to solve');
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  record(check, {
    name: 'Newton iteration converged',
    passed: ec.solved,
    detail: ec.solved
      ? `converged in ${ec.report?.iterations ?? 0} iteration(s)` +
        `${ec.report?.usedGminStepping ? ', gmin stepping' : ''}${ec.report?.usedSourceStepping ? ', source stepping' : ''}`
      : `did not converge${ec.report ? ` after ${ec.report.iterations} iteration(s), worst voltage error ${fmt(ec.report.worstVoltageError ?? NaN)}` : ' (the solver threw)'}`,
  });
  // Node voltages must be finite and inside the rails.
  const vdd = opts.vdd ?? DEFAULT_VALIDATION.vdd;
  const limit = opts.maxNodeVoltage ?? DEFAULT_VALIDATION.maxNodeVoltage;
  // `sim.v` is the solved node-voltage vector, indexed by global node (node 0 = ground).
  const v: Float64Array = ec.nl.nodeCount > 0 ? ec.sim.v : new Float64Array(0);
  let nonFinite = 0;
  let outOfRange = 0;
  let worst = 0;
  let worstNode = '';
  for (let n = 1; n < v.length; n++) {
    const x = v[n];
    if (!Number.isFinite(x)) {
      nonFinite++;
      continue;
    }
    if (Math.abs(x) > Math.abs(worst)) {
      worst = x;
      worstNode = nodeNameAt(nl, n);
    }
    if (Math.abs(x) > limit) outOfRange++;
  }
  record(check, {
    name: 'every node voltage is finite',
    passed: nonFinite === 0,
    detail: nonFinite === 0 ? `${Math.max(0, v.length - 1)} node(s) solved` : `${nonFinite} node(s) returned NaN/Inf`,
  });
  record(check, {
    name: `every node voltage is inside ±${limit} V`,
    passed: outOfRange === 0,
    detail: outOfRange === 0 ? `largest |V| = ${fmtV(worst)} at ${worstNode || 'GND'}` : `${outOfRange} node(s) outside the range; largest |V| = ${fmtV(worst)} at ${worstNode}`,
  });
  const gnd = groundReference(nl);
  const behavioural = countBehaviouralGates(nl);
  if (!gnd.referenced && behavioural > 0 && electricalElementCount(nl) === behavioural) {
    // A netlist made only of ideal gates: the gate model is a controlled source
    // that never references node 0, so the missing reference is a property of the
    // *model*, not a defect of the design. Reporting it as a failure would fail
    // every gate-level circuit in existence; reporting it as a pass would hide a
    // real limitation. It is stated as scope, and the voltages are labelled as
    // differences rather than potentials.
    check.limits.push(
      'no element references node 0: this netlist is made of ideal behavioural gates, whose model is a controlled source with no ground terminal. ' +
        "The solver's gmin conductance provides the reference, so the voltages above are differences against that artificial reference, not potentials against a real 0 V node.",
    );
    check.diagnostics.push({
      severity: Severity.Info,
      code: 'CF9002',
      message: 'no 0 V reference in an ideal-gate netlist: node voltages are differences against the gmin reference',
    });
  } else {
    record(check, {
      name: 'the netlist has a 0 V reference',
      passed: gnd.referenced,
      detail: gnd.explicit
        ? `a ground symbol ties a used net (${gnd.users} element pin(s) on node 0)`
        : gnd.referenced
          ? `no ground symbol, but ${gnd.users} element pin(s) tie node 0 — the reference comes from the gate expansion's own supply network`
          : 'no element references node 0: the solver holds the netlist down with gmin, so absolute node voltages are not meaningful. Add a ground symbol.',
    });
  }
  // Honesty about *what* was solved: a behavioural gate is lowered as a voltage
  // source at the declared supply, so its DC operating point says nothing about
  // transistors. The check reports that instead of letting the reader assume a
  // transistor network was solved.
  if (behavioural > 0 && nl.expandedTransistors === 0) {
    check.accuracy = Accuracy.IDEALIZED;
    check.limits.push(
      `${behavioural} logic gate(s) are behavioural (style 'ideal'): the operating point describes the idealised gate model, not a transistor network. ` +
        "Build the gates with style 'cmos_static' for transistor-level voltage, current and power.",
    );
    check.diagnostics.push({
      severity: Severity.Info,
      code: 'CF9001',
      message: `${behavioural} logic gate(s) were not expanded to transistors; the level-1 numbers are the idealised gate model`,
    });
  }
  check.metrics = {
    behaviouralGates: behavioural,
    nodes: Math.max(0, v.length - 1),
    elements: nl.elementCount,
    expandedTransistors: nl.expandedTransistors,
    iterations: ec.report?.iterations ?? null,
    worstVoltageError: ec.report?.worstVoltageError ?? null,
    gminStepping: ec.report?.usedGminStepping ? 1 : 0,
    sourceStepping: ec.report?.usedSourceStepping ? 1 : 0,
    maxAbsVoltage: worst,
    supply: vdd,
  };
  check.ms = Date.now() - t;
  return check;
}

function checkPower(nl: FlatNetlist, ec: ElectricalContext): ValidationCheck {
  const check = newCheck('power', 'Power balance', 1, Accuracy.APPROXIMATED, [
    'Static (DC) operating point only. Dynamic power needs a transient and a declared stimulus.',
    'Conservation is checked against the gross dissipation, not the net sum: a transistor network dissipates at least the gmin floor, which belongs to no element.',
  ]);
  const t = Date.now();
  if (!ec.solved) {
    skip(check, 'the DC operating point did not converge, so no power figure can be quoted');
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  const p = ec.sim.powers();
  let dissipated = 0;
  let supplied = 0;
  let dissipating = 0;
  for (let e = 0; e < p.length; e++) {
    if (p[e] > 0) {
      dissipated += p[e];
      if (p[e] > 1e-9) dissipating++;
    } else supplied += -p[e];
  }
  const imbalance = Math.abs(dissipated - supplied);
  // The tolerance is relative: a transistor network balances only down to the
  // gmin floor, which is a solver artefact and not a component.
  const tol = Math.max(1e-9, 1e-3 * Math.max(dissipated, supplied));
  record(check, {
    name: 'supplied power equals dissipated power',
    passed: imbalance <= tol,
    detail: `dissipated ${fmtW(dissipated)}, supplied ${fmtW(supplied)}, imbalance ${fmtW(imbalance)} (tolerance ${fmtW(tol)})`,
  });
  record(check, {
    name: 'no element reports a non-finite power',
    passed: Array.from(p).every(Number.isFinite),
    detail: `${p.length} element power(s) read from the solved operating point`,
  });
  check.metrics = {
    dissipatedW: dissipated,
    suppliedW: supplied,
    imbalanceW: imbalance,
    dissipatingElements: dissipating,
    elements: p.length,
  };
  check.ms = Date.now() - t;
  return check;
}

function checkTiming(graph: LogicGraph, timing: TimingReport | null, opts: ValidationOptions): ValidationCheck {
  const check = newCheck('timing', 'Timing', 0, Accuracy.APPROXIMATED, [
    'Delays come from the components\' declared propagation times and the timing engine\'s arrival-time propagation. They are not silicon measurements.',
    'When a gate declares 0 s for both edges, the report is a lower bound and says so.',
    'Hold time, clock skew, jitter and metastability are not modelled.',
  ]);
  const t = Date.now();
  if (!timing) {
    skip(check, 'the netlist has no logic element, so there is no path to time');
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  const critical = timing.criticalPath ?? timing.criticalRegisterPath;
  record(check, {
    name: 'a critical path was found',
    passed: critical !== null,
    detail: critical ? describePath(critical, graph.netName) : 'no combinational path exists (the design may be purely sequential or purely passive)',
  });
  const ideal = timing.idealDelays.length;
  if (ideal === 0) {
    record(check, {
      name: 'every logic element declares a propagation delay',
      passed: true,
      detail: 'all elements declare tphl and tplh',
    });
  } else {
    // Missing delay data is a property of the models, not a defect in the design:
    // nothing the author did is wrong, and failing the whole validation here would
    // bury the real verdict under a complaint about the library. It is recorded as a
    // limitation of this check and reflected in its accuracy (IDEALIZED below), which
    // is where a reader looks to ask what a number is worth. A genuine timing failure
    // stays a failure: when a target is given and even this lower bound exceeds it,
    // the case below fails on the measured path.
    record(check, {
      name: 'the reported path delay is a lower bound',
      passed: true,
      detail: `${ideal} element(s) declare 0 s for both edges, so the delay below can only understate the real one`,
    });
    check.limits.push(
      `${ideal} of ${graph.elements.length} logic element(s) declare no propagation delay (tphl = tplh = 0): every delay in this check is a lower bound, not a measurement. Declare delays on the gates, or validate with --gate-style cmos_static to time the transistor network instead.`,
    );
  }
  // A target given by the caller is checked against the path that actually
  // constrains it: a register-to-register path when the design is synchronous,
  // the combinational delay when it is not.
  const constraining = timing.clockPeriod !== null ? timing.clockPeriod : timing.combinationalDelay;
  const constrainingName = timing.clockPeriod !== null ? 'register-to-register path' : 'combinational path';
  if (constraining !== null) {
    const target = opts.clockPeriod ?? null;
    if (target !== null && target > 0) {
      const slack = target - constraining;
      record(check, {
        name: `${constrainingName} meets the ${fmtS(target)} target`,
        passed: slack >= 0,
        detail: `${constrainingName} needs ${fmtS(constraining)}, target ${fmtS(target)}, slack ${fmtS(slack)}`,
      });
    } else {
      record(check, {
        name: `${constrainingName} delay reported (no target given)`,
        passed: true,
        detail:
          timing.clockPeriod !== null
            ? `period ≥ ${fmtS(timing.clockPeriod)} → ≤ ${fmt(timing.maxFrequency ?? NaN)} Hz`
            : `combinational delay ${fmtS(constraining)} (the design has no register, so there is no clock period to bound)`,
      });
    }
  }
  const dangling = timing.danglingNets.length;
  record(check, {
    name: 'every net has a finite arrival time',
    passed: dangling === 0,
    detail: dangling === 0 ? 'no undriven or loop-fed net' : `${dangling} net(s) never settle (undriven, or fed only by a combinational loop)`,
  });
  check.diagnostics = timing.diagnostics;
  check.metrics = {
    criticalPathDelay: timing.combinationalDelay ?? (critical ? critical.delay : null),
    clockPeriod: timing.clockPeriod,
    maxFrequency: timing.maxFrequency,
    combinationalDelay: timing.combinationalDelay,
    idealDelayElements: ideal,
    danglingNets: dangling,
    criticalPath: critical ? describePath(critical, graph.netName) : null,
  };
  check.accuracy = ideal === 0 ? Accuracy.APPROXIMATED : Accuracy.IDEALIZED;
  check.ms = Date.now() - t;
  return check;
}

function checkThermal(nl: FlatNetlist, ec: ElectricalContext, opts: ValidationOptions): ValidationCheck {
  const check = newCheck('thermal', 'Level-3 electro-thermal steady state', 3, Accuracy.APPROXIMATED, [
    'Lumped thermal RC network: one temperature per thermal node, no spatial gradient inside a die.',
    'Steady state only — the time to reach it needs a thermal transient with declared heat capacities.',
    'Rth/Cth come from the component parameters, not from a package measurement.',
  ]);
  const t = Date.now();
  if (!ec.solved) {
    skip(check, 'the DC operating point did not converge, so there is no power to turn into heat');
    check.ms = Date.now() - t;
    return check;
  }
  if (nl.thermalNodeCount === 0) {
    skip(check, 'the netlist has no thermal node (no component declares a thermal resistance)');
    check.ms = Date.now() - t;
    return check;
  }
  check.ran = true;
  ec.sim.resetThermalToAmbient();
  let res: { iterations: number; maxTemperature: number; converged: boolean } | null = null;
  try {
    res = ec.sim.solveThermalSteadyState();
  } catch {
    res = null;
  }
  const limit = opts.maxTemperature ?? DEFAULT_VALIDATION.maxTemperature;
  // `solveThermalSteadyState().maxTemperature` is in °C, like `elementTemperature`
  // and every other temperature this engine reports to a user. Only the netlist's
  // internal `thermalTemperature` state is in kelvin, and it is never read here.
  record(check, {
    name: 'the thermal loop converged',
    passed: res?.converged === true,
    detail: res ? `${res.iterations} iteration(s), hottest node ${fmt(res.maxTemperature)} °C` : 'the thermal solver threw',
  });
  const tMax = res ? res.maxTemperature : NaN;
  record(check, {
    name: `the hottest node stays below ${limit} °C`,
    passed: Number.isFinite(tMax) && tMax <= limit,
    detail: Number.isFinite(tMax) ? `${fmt(tMax)} °C at an ambient of ${opts.ambient ?? DEFAULT_VALIDATION.ambient} °C` : 'no temperature was produced',
  });
  // Hottest element, for the report.
  let hottestElement = '';
  let hottest = -Infinity;
  for (let e = 0; e < nl.elementCount; e++) {
    const te = ec.sim.elementTemperature(e);
    if (te > hottest) {
      hottest = te;
      hottestElement = nodeNameAt(nl, nl.nodes[e * 3] ?? 0);
    }
  }
  check.metrics = {
    thermalNodes: nl.thermalNodeCount,
    maxTemperatureC: Number.isFinite(tMax) ? tMax : null,
    limitC: limit,
    ambientC: opts.ambient ?? DEFAULT_VALIDATION.ambient,
    iterations: res?.iterations ?? null,
    converged: res?.converged ? 1 : 0,
    hottestElementNode: hottestElement || null,
  };
  check.ms = Date.now() - t;
  return check;
}

function checkStability(
  h: LogicHarness,
  spec: DesignSpec,
  vv: ValidationVectors,
  nl: FlatNetlist,
  opts: ValidationOptions,
): ValidationCheck {
  const check = newCheck('stability', 'Stability and determinism', 0, Accuracy.REALISTIC, [
    'Determinism of this simulator, not of the silicon: it proves the tool repeats itself, not that the design is free of races.',
    'The transient part only runs when a duration is given (`transientStop`).',
  ]);
  const t = Date.now();
  check.ran = true;
  const repeats = Math.max(2, opts.repeats ?? DEFAULT_VALIDATION.repeats);
  // 1. The logic answer must be bit-identical across repeats.
  const signatures: string[] = [];
  for (let r = 0; r < repeats; r++) {
    const results = applyVectors(h, vv.contract.slice(0, 96), spec);
    signatures.push(results.map((x) => x.got.join('')).join('|'));
  }
  const identical = signatures.every((s) => s === signatures[0]);
  record(check, {
    name: `${repeats} logic runs produce identical results`,
    passed: identical,
    detail: identical ? `all ${repeats} runs agree on ${vv.contract.slice(0, 96).length} vector(s)` : `run 2 differs from run 1: the simulator is not deterministic`,
  });
  // 2. The DC operating point must be reproducible from a fresh netlist.
  if (hasAnalogElements(nl)) {
    const volts: number[][] = [];
    for (let r = 0; r < Math.min(repeats, 3); r++) {
      const ec = solveDc(nl, opts);
      volts.push(Array.from(ec.sim.v));
    }
    let maxDelta = 0;
    for (let i = 1; i < volts.length; i++) {
      for (let n = 0; n < volts[0].length; n++) {
        const a = volts[0][n];
        const b = volts[i][n];
        if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) maxDelta = Math.max(maxDelta, Math.abs(a - b));
      }
    }
    record(check, {
      name: `${Math.min(repeats, 3)} DC solves agree to 1 nV`,
      passed: maxDelta <= 1e-9,
      detail: `largest node-voltage difference ${fmtV(maxDelta)}`,
    });
  } else {
    check.skipped++;
  }
  // 3. Optional transient: the response must stay finite (no numerical blow-up).
  const tstop = opts.transientStop ?? DEFAULT_VALIDATION.transientStop;
  if (tstop > 0 && hasAnalogElements(nl)) {
    const sim = new CircuitSimulator(nl, { ambient: opts.ambient ?? DEFAULT_VALIDATION.ambient });
    const requests: TransientRequest[] = [];
    for (const p of nl.ports) if (p.direction === 'output') requests.push({ key: p.name, kind: 'vnode', index: p.node });
    let res = null as null | { ok: boolean; sampleCount: number; values: Float64Array[] };
    try {
      const tr = sim.transient(tstop, requests.slice(0, 8), { maxSamples: 512 });
      res = { ok: tr.ok, sampleCount: tr.sampleCount, values: tr.values };
    } catch {
      res = null;
    }
    let finite = true;
    let maxAbs = 0;
    if (res) {
      for (const series of res.values) for (const x of series) if (!Number.isFinite(x)) finite = false; else maxAbs = Math.max(maxAbs, Math.abs(x));
    }
    record(check, {
      name: `transient over ${fmtS(tstop)} stays finite`,
      passed: res !== null && res.ok && finite,
      detail: res ? `${res.sampleCount} sample(s), largest |value| ${fmt(maxAbs)}${finite ? '' : ', non-finite sample present'}` : 'the transient solver threw',
    });
  } else {
    check.skipped++;
  }
  check.metrics = { repeats, deterministic: identical ? 1 : 0, transientSamples: 0 };
  check.ms = Date.now() - t;
  return check;
}

function checkSerialization(circuit: Circuit, lib: Library, chips: ChipLibrary): ValidationCheck {
  const check = newCheck('serialization', 'Save / load round trip', 0, Accuracy.REALISTIC, [
    'The file format, not the physics: it proves the design survives being written and read back.',
  ]);
  const t = Date.now();
  check.ran = true;
  const before = circuit.fingerprint(lib);
  let after = '';
  let diagnostics = 0;
  try {
    const doc = circuitToDocument(circuit);
    const text = JSON.stringify(doc);
    const loaded = circuitFromDocument(JSON.parse(text) as typeof doc, lib, chips);
    after = loaded.circuit.fingerprint(lib);
    diagnostics = loaded.diagnostics.filter((d) => d.severity === Severity.Error).length;
  } catch (err) {
    after = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  record(check, {
    name: 'the fingerprint survives the round trip',
    passed: before === after && diagnostics === 0,
    detail: before === after ? `fingerprint ${before} reproduced exactly` : `before ${before}, after ${after}`,
  });
  check.metrics = { fingerprint: before, roundTripFingerprint: after, loadErrors: diagnostics };
  check.ms = Date.now() - t;
  return check;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface ValidationSubject {
  circuit: Circuit;
  name: string;
  kind: 'circuit' | 'chip';
  chipId?: string;
  chipVersion?: string;
}

/**
 * Validate a circuit against a specification (or against its own port contract
 * when no specification is given).
 *
 * This never throws on a design defect: every problem becomes a failed case in
 * the report. It only throws when the inputs are unusable (no circuit, no
 * library), which is a caller bug.
 */
/**
 * A validation run, one check per step.
 *
 * The session exists so the job queue can pause, resume and checkpoint a
 * validation exactly as it does an optimisation: each `step()` runs one complete
 * check, so a checkpoint always lands between two checks and never in the middle
 * of a Newton iteration.
 */
export class ValidationSession {
  readonly subject: ValidationSubject;
  readonly opts: ValidationOptions;
  readonly spec: DesignSpec;
  readonly vectors: ValidationVectors;
  readonly seed: number | string;
  /** Checks already completed, in execution order. */
  readonly checks: ValidationCheck[] = [];
  private pending: Array<{ id: CheckId; name: string; run: () => ValidationCheck }> = [];
  private nl: FlatNetlist | null = null;
  private harness: LogicHarness | null = null;
  private ec: ElectricalContext | null = null;
  private ecReady = false;
  private timing: TimingReport | null = null;
  private timingDone = false;
  private t0 = Date.now();
  private finished = false;
  private flattenError: string | null = null;
  /** The circuit actually measured (a styled copy when `gateStyle` was given). */
  private circuit: Circuit;
  /** How many gates the forced style was applied to. */
  private styledGates = 0;

  constructor(subject: ValidationSubject, opts: ValidationOptions) {
    this.subject = subject;
    this.opts = opts;
    this.circuit = subject.circuit;
    this.seed = opts.seed ?? `${subject.name}:validate`;
    const rng = new Rng(this.seed);
    this.spec = opts.spec ?? specFromCircuit(subject.circuit, subject.name);
    this.vectors = planValidationVectors(this.spec, opts, rng);
    const levels = opts.levels ?? {};
    const want = (id: keyof ValidationLevels): boolean => levels[id] !== false;

    const lib = opts.lib;
    const chips = opts.chips ?? new ChipLibrary();
    // A forced gate style is applied to a copy: the caller's circuit is never
    // edited by a validation run.
    const styled = opts.gateStyle ? withGateStyle(subject.circuit, opts.gateStyle) : { circuit: subject.circuit, gates: 0 };
    this.circuit = styled.circuit;
    this.styledGates = opts.gateStyle ? styled.gates : 0;
    const circuit = this.circuit;
    try {
      this.nl = flatten(circuit, lib, chips, {
        ambient: opts.ambient ?? DEFAULT_VALIDATION.ambient,
        expandGates: opts.expandGates ?? DEFAULT_VALIDATION.expandGates,
        thermal: true,
      });
    } catch (err) {
      this.flattenError = err instanceof Error ? err.message : String(err);
    }

    if (this.nl === null) {
      // Nothing can be measured: report the single fact we do know.
      this.pending.push({
        id: 'erc',
        name: 'Electrical rule check',
        run: () => {
          const check = newCheck('erc', 'Electrical rule check', 0, Accuracy.NOT_MODELED, []);
          skip(check, `the circuit could not be flattened: ${this.flattenError}`);
          return check;
        },
      });
      return;
    }
    this.harness = buildHarness(this.nl, this.spec);
    const nl = this.nl;
    const harness = this.harness;
    const spec = this.spec;
    const vv = this.vectors;
    const seed = this.seed;
    const o = opts;

    if (want('erc')) this.pending.push({ id: 'erc', name: 'Electrical rule check', run: () => checkErc(this.circuit, lib, chips) });
    if (want('logic')) {
      this.pending.push({
        id: 'logic',
        name: 'Logic contract',
        run: () => {
          const check = newCheck('logic', 'Logic contract', 0, Accuracy.REALISTIC, [
            vv.exhaustive ? "Coverage is exhaustive over the specification's input space." : 'Coverage is sampled: the report states how the vectors were chosen.',
            spec.behaviour || spec.vectors
              ? 'Compared against the supplied behavioural contract.'
              : 'No behavioural contract was supplied: the check only verifies that the outputs are determined (never X or Z).',
          ]);
          checkLogic(harness, spec, vv, check);
          return check;
        },
      });
    }
    if (want('edge')) this.pending.push({ id: 'edge', name: 'Edge cases', run: () => checkEdge(harness, spec, vv) });
    if (want('random')) this.pending.push({ id: 'random', name: 'Randomised vectors', run: () => checkRandomWithSpec(harness, spec, vv, seed) });
    if (want('electrical')) this.pending.push({ id: 'electrical', name: 'Level-1 DC operating point', run: () => checkElectrical(nl, this.dc(), o) });
    if (want('power')) this.pending.push({ id: 'power', name: 'Power balance', run: () => checkPower(nl, this.dc()) });
    if (want('timing')) this.pending.push({ id: 'timing', name: 'Timing', run: () => checkTiming(harness.graph, this.timingReport(), o) });
    if (want('thermal')) this.pending.push({ id: 'thermal', name: 'Level-3 electro-thermal steady state', run: () => checkThermal(nl, this.dc(), o) });
    if (want('stability')) this.pending.push({ id: 'stability', name: 'Stability and determinism', run: () => checkStability(harness, spec, vv, nl, o) });
    if (want('serialization')) this.pending.push({ id: 'serialization', name: 'Save / load round trip', run: () => checkSerialization(this.circuit, lib, chips) });
  }

  /** The DC operating point is solved once and shared by three checks. */
  private dc(): ElectricalContext {
    if (!this.ecReady) {
      this.ec = this.nl ? solveDc(this.nl, this.opts) : null;
      this.ecReady = true;
    }
    if (!this.ec) throw new Error('the electrical checks ran on a netlist that could not be built');
    return this.ec;
  }

  private timingReport(): TimingReport | null {
    if (!this.timingDone) {
      this.timingDone = true;
      if (this.harness && this.harness.graph.elements.length > 0) {
        try {
          this.timing = analyzeTiming(this.harness.graph, declaredDelays());
        } catch {
          this.timing = null;
        }
      }
    }
    return this.timing;
  }

  /** Number of checks this session will run. */
  get totalChecks(): number {
    return this.checks.length + this.pending.length;
  }

  /** Number of checks completed so far. */
  get ranChecks(): number {
    return this.checks.length;
  }

  /** Name of the check that will run next, or null when finished. */
  get nextCheck(): string | null {
    return this.pending[0]?.name ?? null;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Run the next check. Returns true when the session is complete. */
  step(): boolean {
    if (this.finished) return true;
    const next = this.pending.shift();
    if (!next) {
      this.finished = true;
      return true;
    }
    this.checks.push(next.run());
    if (this.pending.length === 0) this.finished = true;
    return this.finished;
  }

  /** Run every remaining check. */
  runAll(): ValidationReport {
    while (!this.step()) {
      /* one check per iteration */
    }
    return this.report();
  }

  /** Gates the forced style was applied to (0 when no style was forced). */
  get restyledGates(): number {
    return this.styledGates;
  }

  /** The report. Safe to call mid-run: it describes what has been measured. */
  report(): ValidationReport {
    return finish(this.subject, this.circuit, this.opts.lib, this.spec, this.vectors, this.checks, this.opts, this.seed, this.t0, this.nl, this.styledGates);
  }
}

export function validateCircuit(subject: ValidationSubject, opts: ValidationOptions): ValidationReport {
  return new ValidationSession(subject, opts).runAll();
}

/** The gate style actually measured, as one clause of the report. */
function styleClause(opts: ValidationOptions, styledGates: number): string {
  if (!opts.gateStyle) return 'as authored (no gate style was forced)';
  return `${opts.gateStyle} forced on ${styledGates} logic gate(s)`;
}

function finish(
  subject: ValidationSubject,
  circuit: Circuit,
  lib: Library,
  spec: DesignSpec,
  vv: ValidationVectors,
  checks: ValidationCheck[],
  opts: ValidationOptions,
  seed: number | string,
  t0: number,
  nl: FlatNetlist | null,
  styledGates = 0,
): ValidationReport {
  const totals: ValidationTotals = { checks: checks.length, ran: 0, skippedChecks: 0, cases: 0, passed: 0, failed: 0, skipped: 0 };
  for (const c of checks) {
    if (c.ran) totals.ran++;
    else totals.skippedChecks++;
    totals.cases += c.cases.length;
    totals.passed += c.passed;
    totals.failed += c.failed;
    totals.skipped += c.skipped;
  }
  const failures: string[] = [];
  for (const c of checks) {
    for (const k of c.cases) if (!k.passed) failures.push(`${c.name} → ${k.name}: ${k.detail}`);
  }
  const ports = circuitPorts(circuit);
  const blocking = checks.filter((c) => !c.ran && c.blocking);
  const ok = totals.ran > 0 && totals.failed === 0 && blocking.length === 0;
  const claim: ValidationReport['claim'] =
    totals.ran === 0 || blocking.length > 0 ? 'NOT VALIDATED' : ok ? 'VALIDATED UNDER THE STATED CONDITIONS' : 'FAILED VALIDATION';
  const notes: string[] = [];
  for (const c of blocking) {
    notes.push(`${c.name} could not be applied — ${c.skippedReason}. No verdict is possible without it.`);
  }
  if (!spec.behaviour && !spec.vectors) {
    notes.push('no behavioural contract was supplied: the logic, edge-case and random checks verified that the outputs are determined, not that they are the intended values.');
  }
  if (!vv.exhaustive) {
    notes.push(`the ${specInputBits(spec)}-bit input space was sampled, not enumerated: ${vv.plan.note}`);
  }
  const electrical = checks.find((c) => c.id === 'electrical');
  if (electrical?.ran && Number(electrical.metrics.behaviouralGates ?? 0) > 0 && Number(electrical.metrics.expandedTransistors ?? 0) === 0) {
    notes.push(
      `the level-1 and level-3 numbers describe the idealised behavioural gate model (${electrical.metrics.behaviouralGates} gate(s)), not a transistor network: ` +
        "rebuild the gates with style 'cmos_static' to measure them at the device level.",
    );
  }
  for (const c of checks) if (!c.ran && c.skippedReason) notes.push(`${c.name}: skipped — ${c.skippedReason}`);
  const hardware = detectPlatform();
  return {
    claim,
    subject: {
      kind: subject.kind,
      name: subject.name,
      fingerprint: circuit.fingerprint(lib),
      components: circuit.componentCount(),
      nets: circuit.netCount(),
      ports: { inputs: ports.inputs.length, outputs: ports.outputs.length },
      chipId: subject.chipId,
      chipVersion: subject.chipVersion,
      params: opts.params,
    },
    conditions: {
      seed,
      ambient: opts.ambient ?? DEFAULT_VALIDATION.ambient,
      vdd: opts.vdd ?? DEFAULT_VALIDATION.vdd,
      vectors: { total: vv.total, method: vv.plan.method, note: vv.note, exhaustive: vv.exhaustive },
      repeats: opts.repeats ?? DEFAULT_VALIDATION.repeats,
      maxTemperature: opts.maxTemperature ?? DEFAULT_VALIDATION.maxTemperature,
      clockPeriod: opts.clockPeriod ?? null,
      gateExpansion: opts.expandGates ?? DEFAULT_VALIDATION.expandGates,
      gateStyle: styleClause(opts, styledGates),
    },
    checks,
    totals,
    ok,
    failures,
    notes,
    reproducibility: {
      engineVersion: ENGINE_VERSION,
      modelVersions: { logic: MODEL_VERSIONS.logic, bitlogic: MODEL_VERSIONS.bitlogic, mna: MODEL_VERSIONS.mna, devices: MODEL_VERSIONS.devices, thermal: MODEL_VERSIONS.thermal, timing: MODEL_VERSIONS.timing },
      hardware: { platform: hardware.node ? 'node' : 'browser', cores: cpuCores(), cpu: hardware.cpu.model },
      provenance: provenance(hardware.node ? 'node' : 'browser'),
      wallMs: Date.now() - t0,
    },
  };
  void nl;
}

/** Validate a chip: resolves its implementation for a parameter set first. */
export function validateChip(chip: Chip, opts: ValidationOptions): ValidationReport {
  const params = opts.params ?? chip.defaultParams();
  const circuit = chip.implementation(params);
  return validateCircuit(
    { circuit, name: `${chip.name} (${chip.id}@${chip.version})`, kind: 'chip', chipId: chip.id, chipVersion: chip.version },
    { ...opts, params },
  );
}

/** Validate every parameter set a caller lists, plus the defaults. */
export function validateChipSweep(chip: Chip, paramSets: ParamBag[], opts: ValidationOptions): ValidationReport[] {
  const sets = paramSets.length > 0 ? paramSets : [chip.defaultParams()];
  return sets.map((p) => validateChip(chip, { ...opts, params: p }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MARK = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

export function validationToText(report: ValidationReport, opts: { verbose?: boolean } = {}): string {
  const L: string[] = [];
  L.push('='.repeat(78));
  L.push(`VALIDATION — ${report.subject.name}`);
  L.push(report.claim);
  L.push('='.repeat(78));
  L.push(`subject       : ${report.subject.kind}, ${report.subject.components} component(s), ${report.subject.nets} net(s), ${report.subject.ports.inputs} input / ${report.subject.ports.outputs} output port(s)`);
  L.push(`fingerprint   : ${report.subject.fingerprint}`);
  if (report.subject.params) L.push(`parameters    : ${JSON.stringify(report.subject.params)}`);
  const c = report.conditions;
  L.push(`conditions    : seed ${String(c.seed)}, ambient ${c.ambient} °C, Vdd ${c.vdd} V, ${c.repeats} determinism repeat(s)`);
  L.push(`vectors       : ${c.vectors.total} (${c.vectors.exhaustive ? 'exhaustive' : 'sampled'}) — ${c.vectors.note}`);
  L.push(`gate expansion: ${c.gateExpansion ? 'on (CMOS transistor network)' : 'off (behavioural gates)'}`);
  L.push(`gate style    : ${c.gateStyle}`);
  L.push('');
  for (const check of report.checks) {
    const state = check.ran ? (check.failed === 0 ? MARK.pass : MARK.fail) : MARK.skip;
    L.push(`[${state}] ${check.name}  (level ${check.level}, ${check.accuracy}, ${check.ms} ms)`);
    if (!check.ran) {
      L.push(`       skipped: ${check.skippedReason ?? 'not requested'}`);
      continue;
    }
    for (const k of check.cases) L.push(`       ${k.passed ? 'ok  ' : 'FAIL'} ${k.name} — ${k.detail}`);
    if (opts.verbose) {
      for (const [key, value] of Object.entries(check.metrics)) L.push(`            ${key} = ${value === null ? 'not measured' : String(value)}`);
      for (const lim of check.limits) L.push(`            limit: ${lim}`);
    }
  }
  L.push('');
  L.push(`totals        : ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped case(s) over ${report.totals.ran} check(s) (${report.totals.skippedChecks} skipped), ${report.reproducibility.wallMs} ms`);
  if (report.failures.length > 0) {
    L.push('');
    L.push('failures:');
    for (const f of report.failures.slice(0, 20)) L.push(`  - ${f}`);
    if (report.failures.length > 20) L.push(`  … and ${report.failures.length - 20} more`);
  }
  if (report.notes.length > 0) {
    L.push('');
    L.push('scope notes:');
    for (const n of report.notes) L.push(`  - ${n}`);
  }
  L.push('');
  L.push(`engine ${report.reproducibility.engineVersion} · models ${Object.entries(report.reproducibility.modelVersions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push(`hardware ${report.reproducibility.hardware.platform}, ${report.reproducibility.hardware.cores} core(s), ${report.reproducibility.hardware.cpu}`);
  return L.join('\n');
}

/** Weakest accuracy over the checks that ran — the honest label of the report. */
/**
 * The honest label of a whole report: the weakest accuracy among the checks that
 * actually ran. A report is never stronger than its weakest measurement, and a
 * report where nothing ran has no accuracy to claim at all.
 */
export function reportAccuracy(report: ValidationReport): Accuracy {
  let acc: Accuracy | null = null;
  for (const c of report.checks) {
    if (!c.ran) continue;
    acc = acc === null ? c.accuracy : weakerAccuracy(acc, c.accuracy);
  }
  return acc ?? Accuracy.NOT_MODELED;
}

export { simulateVectors };
