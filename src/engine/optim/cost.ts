/**
 * Candidate evaluation: the tiered filter a search runs every design through.
 *
 * The whole point of the ladder is that a claim is never stronger than the level
 * it was measured at:
 *
 *   tier 0  build        the genome becomes a real circuit and a real netlist
 *   tier 1  logic        every vector of the specification is simulated at level 0
 *   tier 2  structure    size, depth, fan-out, timing under the declared load model
 *   tier 3  electrical   the *transistor-level* implementation is solved (level 1)
 *   tier 4  detailed     electro-thermal steady state (level 3) and switching
 *                        energy from a transient
 *
 * Tiers 0–2 are cheap and run on every candidate; 3–4 are orders of magnitude
 * more expensive and run only on the survivors the caller asks to detail. Every
 * number carries the tier it came from, so a report can say "12.4 ns at tier 2
 * (declared load model)" rather than "12.4 ns" as if it were silicon.
 */

import type { ChipLibrary } from '../core/chip.js';
import type { Library } from '../core/library.js';
import { flatten, nodeNameAt, type FlatNetlist } from '../sim/netlist.js';
import { Kind } from '../core/kinds.js';
import { CircuitSimulator } from '../sim/solver.js';
import { buildLogicGraph, LogicVectorSim, type LogicGraph } from '../analysis/logic.js';
import { analyzeTiming } from '../analysis/timing.js';
import { declaredDelays } from '../analysis/tech.js';
import { Severity } from '../core/labels.js';
import {
  CONST0,
  CONST1,
  FN,
  fnArity,
  genomeDefects,
  genomeKey,
  genomeStats,
  genomeStructure,
  genomeToCircuit,
  mutateGenome,
  ILLUSTRATIVE_LOAD_MODEL,
  type GenomeLimits,
  type LogicGenome,
} from './genome.js';
import type { Rng } from '../util/rng.js';
import { outputBits } from './spec.js';
import type { DesignSpec, SpecVector, VectorPlan } from './spec.js';

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

export type TierId = 0 | 1 | 2 | 3 | 4;

export const TIER_NAMES: Record<TierId, string> = {
  0: 'build the circuit',
  1: 'level 0 logic over the specification vectors',
  2: 'structure, fan-out and declared-model timing',
  3: 'level 1 electrical operating point (transistor level)',
  4: 'level 3 electro-thermal steady state and switching energy',
};

export interface DesignConstraints {
  /** Hard caps: a candidate that breaks one is rejected, not merely penalised. */
  maxComponents?: number;
  maxDepth?: number;
  maxDelay?: number;
  maxFanout?: number;
  /** Ambient temperature used by the level-3 pass (°C). */
  ambient?: number;
  /** Cap on the transistor-level operating-point solve (seconds of simulated time). */
  level1?: { vdd?: number; frequency?: number; periods?: number };
}

export const DEFAULT_CONSTRAINTS: Required<Pick<DesignConstraints, 'maxFanout' | 'ambient'>> = {
  maxFanout: 16,
  ambient: 27,
};

/** Risk weights: the structural smell score, each term counted, none invented. */
export const RISK_WEIGHTS = {
  fanout: 1,
  redundant: 0.5,
  constantInput: 0.25,
  unknownOutput: 2,
  loop: 20,
} as const;

export interface RiskTerms {
  fanoutViolations: number;
  redundantNodes: number;
  constantInputs: number;
  unknownOutputs: number;
  loops: number;
}

export interface Objectives {
  /** Critical-path delay (s) under the declared load model (tier 2). */
  delay: number;
  /** Logic levels on the longest path (tier 2). */
  depth: number;
  /** Primitive components a BOM would list (tier 2). */
  components: number;
  /** Structural risk score, dimensionless (tier 2). */
  risk: number;
  /** Register bits in the design (0 for a pure combinational network). */
  memory: number;
  /** Worst-case static dissipation at the transistor level (W, tier 3). */
  power: number | null;
  /** Hottest junction of the level-3 steady state (°C, tier 4). */
  temperature: number | null;
  /** Switching energy of one full input transition (J, tier 4). */
  switchEnergy: number | null;
}

export interface TierRecord {
  id: TierId;
  name: string;
  passed: boolean;
  skipped: boolean;
  ms: number;
  note: string;
}

export interface Candidate {
  genome: LogicGenome;
  /** Structural identity (cache key). */
  key: string;
  ok: boolean;
  /** Tier that rejected the candidate, if any. */
  failedTier: TierId | null;
  reason: string;
  /**
   * Summed constraint violation; 0 exactly when `ok` is true.
   *
   * An infeasible candidate still carries every objective the cheap tiers could
   * measure, and this amount is what lets the search rank two wrong designs
   * against each other and move toward feasibility instead of stalling. It is a
   * sum of normalised excesses, each of which is also reported by name in
   * `violationTerms`, so a report can say *which* constraint was broken and by
   * how much rather than quoting a bare number.
   */
  violation: number;
  /** Each constraint's own normalised excess (0 = met). */
  violationTerms: Record<string, number>;
  tiers: TierRecord[];
  objectives: Objectives;
  risk: RiskTerms;
  /** Netlist fingerprint, once the circuit was flattened. */
  fingerprint: string | null;
  vectorsChecked: number;
  vectorMethod: string;
  diagnostics: number;
  ms: number;
  /** Detail-pass artefacts (present only after `detailCandidate`). */
  detail?: DetailResult;
}

export interface DetailResult {
  /** Measured static dissipation per input vector (W). */
  staticPowerPerVector: number[];
  worstVectorIndex: number;
  /** Worst-case static dissipation (W). */
  staticPower: number;
  /** Level-3 steady state at the worst vector. */
  temperature: number | null;
  thermalConverged: boolean;
  /** Transient measurement of the switching energy (J). */
  switchEnergy: number | null;
  /** What the transient measured, and over how long. */
  transientNote: string;
  /** Simulated time and wall time of the whole detail pass. */
  simulatedTime: number;
  ms: number;
  notes: string[];
}

export interface VectorOutcome {
  checked: number;
  mismatches: number;
  unknown: number;
  /** First few mismatches, for the report. */
  firstMismatch: { index: number; expected: number; got: string } | null;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Level-0 vector simulation (shared with the validator)
// ---------------------------------------------------------------------------

/**
 * Drive the specification's vectors into a flattened circuit and read the
 * outputs back. Input and output ports are addressed by name, so this works for
 * any circuit whose ports are the specification's bits (the genomes this module
 * builds always are).
 */
export function simulateVectors(
  nl: FlatNetlist,
  spec: DesignSpec,
  vectors: readonly SpecVector[],
  opts: { loopIterations?: number } = {},
): VectorOutcome {
  const graph = buildLogicGraph(nl);
  const sim = new LogicVectorSim(graph, opts.loopIterations === undefined ? {} : { loopIterations: opts.loopIterations });
  const inputPorts = spec.inputs.flatMap((p) =>
    Array.from({ length: Math.max(1, p.width) }, (_, b) => nl.ports.find((x) => x.name === `${p.name}${b}`)),
  );
  const outputPorts = spec.outputs.flatMap((p) =>
    Array.from({ length: Math.max(1, p.width) }, (_, b) => nl.ports.find((x) => x.name === `${p.name}${b}`)),
  );
  for (const p of [...inputPorts, ...outputPorts]) {
    if (!p) throw new Error(`specification port is missing from the netlist (${spec.name})`);
  }
  const out: VectorOutcome = { checked: 0, mismatches: 0, unknown: 0, firstMismatch: null, ok: true };
  const chunk = 32;
  for (let base = 0; base < vectors.length; base += chunk) {
    const n = Math.min(chunk, vectors.length - base);
    // Pack this chunk of vectors into the bit-parallel planes.
    for (let k = 0; k < inputPorts.length; k++) {
      let ones = 0;
      for (let i = 0; i < n; i++) {
        const values = vectors[base + i].in;
        // Bit k of the flat input numbering, from the port values.
        let flat = 0;
        let shift = 0;
        for (let pi = 0; pi < spec.inputs.length; pi++) {
          const width = Math.max(1, spec.inputs[pi].width);
          for (let b = 0; b < width; b++) {
            if (shift === k) flat = (values[pi] >>> b) & 1;
            shift++;
          }
        }
        if (flat) ones |= 1 << i;
      }
      sim.drive(inputPorts[k]!.node, ones >>> 0, 0);
    }
    sim.settle();
    for (let i = 0; i < n; i++) {
      out.checked++;
      let expected = 0;
      let shift = 0;
      for (let po = 0; po < spec.outputs.length; po++) {
        const width = Math.max(1, spec.outputs[po].width);
        for (let b = 0; b < width; b++) {
          const want = (vectors[base + i].out[po] >>> b) & 1;
          if (shift === 0 || true) {
            // The output port index equals the flat bit index.
          }
          void want;
          shift++;
        }
      }
      for (let k = 0; k < outputPorts.length; k++) {
        const got = sim.sample(outputPorts[k]!.node, i);
        let want = 0;
        let flat = 0;
        for (let po = 0; po < spec.outputs.length; po++) {
          const width = Math.max(1, spec.outputs[po].width);
          for (let b = 0; b < width; b++) {
            if (flat === k) want = (vectors[base + i].out[po] >>> b) & 1;
            flat++;
          }
        }
        expected |= want;
        if (got === 'X' || got === 'Z') {
          out.unknown++;
          if (out.ok) out.firstMismatch = { index: base + i, expected: want, got };
          out.ok = false;
        } else if (got !== want) {
          out.mismatches++;
          if (out.ok) out.firstMismatch = { index: base + i, expected: want, got: String(got) };
          out.ok = false;
        }
      }
      void expected;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiers 0–2
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  spec: DesignSpec;
  plan: VectorPlan;
  lib: Library;
  chips: ChipLibrary;
  constraints?: DesignConstraints;
  limits?: GenomeLimits;
  /** Ambient temperature for the level-3 pass. */
  ambient?: number;
}

function riskOf(g: LogicGenome, graph: LogicGraph, nl: FlatNetlist, unknownOutputs: number, maxFanout: number): RiskTerms {
  // A node that repeats an earlier node's function and inputs computes a value
  // that already exists: measured structurally, reported as a count.
  const seen = new Set<string>();
  let redundant = 0;
  let constantInputs = 0;
  for (const n of g.nodes) {
    const shape = `${n.fn}|${n.a}|${n.b}|${n.c}`;
    if (seen.has(shape)) redundant++;
    else seen.add(shape);
    if (n.a === CONST0 || n.a === CONST1) constantInputs++;
    else if (fnArity(n.fn) > 1 && (n.b === CONST0 || n.b === CONST1)) constantInputs++;
  }
  // Fan-out is read from the logic graph, the same source the analyzer uses.
  const fanout = fanoutHistogram(graph, nl.nodeCount);
  let fanoutViolations = 0;
  for (let n = 1; n < nl.nodeCount; n++) if (fanout[n] > maxFanout) fanoutViolations++;
  return {
    fanoutViolations,
    redundantNodes: redundant,
    constantInputs,
    unknownOutputs,
    loops: graph.loopElements.length,
  };
}

/**
 * Run tiers 0–2. Never throws on a candidate's own defects: a genome that cannot
 * be built is a rejected candidate with a reason, not a crash of the search.
 */
export function evaluateCandidate(genome: LogicGenome, opts: EvaluateOptions): Candidate {
  const t0 = Date.now();
  const constraints = opts.constraints ?? {};
  const spec = opts.spec;
  const tiers: TierRecord[] = [];
  const objectives: Objectives = {
    delay: 0,
    depth: 0,
    components: 0,
    risk: 0,
    memory: 0,
    power: null,
    temperature: null,
    switchEnergy: null,
  };
  const risk: RiskTerms = { fanoutViolations: 0, redundantNodes: 0, constantInputs: 0, unknownOutputs: 0, loops: 0 };
  const violationTerms: Record<string, number> = {};
  const fail = (tier: TierId, reason: string, violation = Number.POSITIVE_INFINITY): Candidate => ({
    genome,
    key: genomeKey(genome),
    ok: false,
    failedTier: tier,
    reason,
    violation,
    violationTerms,
    tiers,
    objectives,
    risk,
    fingerprint: null,
    vectorsChecked: 0,
    vectorMethod: opts.plan.method,
    diagnostics: 0,
    ms: Date.now() - t0,
  });

  // ---- tier 0: build -------------------------------------------------------
  let mark = Date.now();
  let circuit;
  let nl: FlatNetlist;
  // Well-formedness first: a genome with a dangling or forward reference has no
  // circuit at all, so there is nothing to measure and nothing to rank.
  const defects = genomeDefects(genome);
  if (defects.length > 0) {
    tiers.push({ id: 0, name: TIER_NAMES[0], passed: false, skipped: false, ms: Date.now() - mark, note: defects.slice(0, 3).join('; ') });
    return fail(0, `the genome is malformed: ${defects[0]}${defects.length > 1 ? ` (+${defects.length - 1} more)` : ''}`);
  }
  try {
    circuit = genomeToCircuit(genome, spec, { lib: opts.lib, chips: opts.chips });
    nl = flatten(circuit, opts.lib, opts.chips, {});
  } catch (err) {
    tiers.push({ id: 0, name: TIER_NAMES[0], passed: false, skipped: false, ms: Date.now() - mark, note: String((err as Error).message ?? err) });
    // Unbuildable: there is no objective vector to rank, so the violation is
    // unbounded and the search treats it as a rejection rather than a candidate.
    return fail(0, `the design does not build: ${String((err as Error).message ?? err)}`);
  }
  const buildMs = Date.now() - mark;
  const errors = nl.diagnostics.filter((d) => d.severity === Severity.Error);
  tiers.push({
    id: 0,
    name: TIER_NAMES[0],
    passed: errors.length === 0,
    skipped: false,
    ms: buildMs,
    note: errors.length === 0 ? `${nl.elementCount} element(s), ${nl.nodeCount} net(s)` : errors.map((d) => `${d.code} ${d.message}`).join('; '),
  });
  if (errors.length > 0) return fail(0, `netlist error: ${errors[0].code} ${errors[0].message}`);

  // ---- tier 1: logic -------------------------------------------------------
  mark = Date.now();
  let graph: LogicGraph;
  let outcome: VectorOutcome;
  let loopNote: string | null = null;
  try {
    graph = buildLogicGraph(nl);
    if (spec.combinational !== false && graph.loopElements.length > 0) {
      loopNote = `${graph.loopElements.length} element(s) form a combinational loop`;
    }
    outcome = loopNote ? { checked: 0, mismatches: 0, unknown: 0, firstMismatch: null, ok: false } : simulateVectors(nl, spec, opts.plan.vectors);
  } catch (err) {
    tiers.push({ id: 1, name: TIER_NAMES[1], passed: false, skipped: false, ms: Date.now() - mark, note: String((err as Error).message ?? err) });
    return fail(1, `level 0 simulation failed: ${String((err as Error).message ?? err)}`);
  }
  tiers.push({
    id: 1,
    name: TIER_NAMES[1],
    passed: outcome.ok && loopNote === null,
    skipped: false,
    ms: Date.now() - mark,
    note: loopNote
      ? `${loopNote} in a combinational design; the vectors were not simulated`
      : outcome.ok
        ? `${outcome.checked} vector(s) reproduced (${opts.plan.method})`
        : `${outcome.mismatches} wrong and ${outcome.unknown} undefined output(s) over ${outcome.checked} vector(s)` +
          (outcome.firstMismatch
            ? `; first at vector ${outcome.firstMismatch.index}: expected ${outcome.firstMismatch.expected}, got ${outcome.firstMismatch.got}`
            : ''),
  });

  // ---- tier 2: structure, timing, size ------------------------------------
  // Measured even when tier 1 failed: size, depth, fan-out and delay are
  // properties of the structure, not of the behaviour, and the search needs them
  // to rank two incorrect designs against each other.
  mark = Date.now();
  // The gates of a genome declare the load-adjusted delay of the search's model,
  // so the declared-delay model (D0) is exactly the right reading here.
  const d0 = declaredDelays();
  const timing = analyzeTiming(graph, { model: d0.model, clockToQ: d0.clockToQ, setup: d0.setup });
  const structure = genomeStructure(genome);
  objectives.components = structure.components;
  objectives.delay = timing.combinationalDelay ?? timing.criticalPath?.delay ?? 0;
  objectives.depth = timing.criticalPath?.stages ?? genomeStats(genome).depth;
  const riskTerms = riskOf(genome, graph, nl, outcome.unknown, constraints.maxFanout ?? DEFAULT_CONSTRAINTS.maxFanout);
  risk.fanoutViolations = riskTerms.fanoutViolations;
  risk.redundantNodes = riskTerms.redundantNodes;
  risk.constantInputs = riskTerms.constantInputs;
  risk.unknownOutputs = riskTerms.unknownOutputs;
  risk.loops = riskTerms.loops;
  objectives.risk =
    RISK_WEIGHTS.fanout * risk.fanoutViolations +
    RISK_WEIGHTS.redundant * risk.redundantNodes +
    RISK_WEIGHTS.constantInput * risk.constantInputs +
    RISK_WEIGHTS.unknownOutput * risk.unknownOutputs +
    RISK_WEIGHTS.loop * risk.loops;
  // The genome language is purely combinational: it has no register construct, so
  // the memory objective is a measured 0 rather than an estimate. Should a
  // sequential genome be added, this is the line that must start counting its
  // state bits.
  objectives.memory = 0;

  // ---- constraint violations, each normalised and named --------------------
  const outBitCount = Math.max(1, outputBits(spec) * Math.max(1, outcome.checked));
  if (loopNote !== null) {
    violationTerms.loops = 1 + risk.loops / Math.max(1, graph.elements.length);
  } else if (!outcome.ok) {
    violationTerms.behaviour = (outcome.mismatches + outcome.unknown) / outBitCount;
    if (outcome.unknown > 0) violationTerms.undeterminedOutputs = outcome.unknown / outBitCount;
  }
  if (constraints.maxComponents !== undefined && objectives.components > constraints.maxComponents) {
    violationTerms.maxComponents = (objectives.components - constraints.maxComponents) / Math.max(1, constraints.maxComponents);
  }
  if (constraints.maxDepth !== undefined && objectives.depth > constraints.maxDepth) {
    violationTerms.maxDepth = (objectives.depth - constraints.maxDepth) / Math.max(1, constraints.maxDepth);
  }
  if (constraints.maxDelay !== undefined && objectives.delay > constraints.maxDelay) {
    violationTerms.maxDelay = (objectives.delay - constraints.maxDelay) / Math.max(1e-12, constraints.maxDelay);
  }
  if (constraints.maxFanout !== undefined && risk.fanoutViolations > 0) {
    violationTerms.maxFanout = risk.fanoutViolations / Math.max(1, nl.nodeCount);
  }
  let violation = 0;
  for (const v of Object.values(violationTerms)) violation += v;

  const violationText =
    violation === 0
      ? null
      : Object.entries(violationTerms)
          .map(([k, v]) => describeViolation(k, v, objectives, risk, constraints, outcome))
          .join('; ');
  tiers.push({
    id: 2,
    name: TIER_NAMES[2],
    passed: violationText === null,
    skipped: false,
    ms: Date.now() - mark,
    note:
      violationText ??
      `${objectives.components} component(s), depth ${objectives.depth}, critical path ${(objectives.delay * 1e9).toFixed(3)} ns, risk ${objectives.risk.toFixed(2)}`,
  });

  const candidate: Candidate = {
    genome,
    key: genomeKey(genome),
    ok: violation === 0,
    failedTier: violation === 0 ? null : violationTerms.behaviour !== undefined || violationTerms.loops !== undefined ? 1 : 2,
    reason: violation === 0 ? 'accepted' : (violationText ?? 'constraint violated'),
    violation,
    violationTerms,
    tiers,
    objectives,
    risk,
    fingerprint: nl.fingerprint,
    vectorsChecked: outcome.checked,
    vectorMethod: opts.plan.method,
    diagnostics: nl.diagnostics.length,
    ms: Date.now() - t0,
  };
  return candidate;
}

/** One clause of a violation, quoted with the measured numbers behind it. */
function describeViolation(
  key: string,
  amount: number,
  objectives: Objectives,
  risk: RiskTerms,
  constraints: DesignConstraints,
  outcome: VectorOutcome,
): string {
  const pct = (amount * 100).toFixed(1);
  switch (key) {
    case 'loops':
      return `${risk.loops} element(s) form a combinational loop (violation ${pct} %)`;
    case 'behaviour':
      return `wrong behaviour: ${outcome.mismatches} mismatched and ${outcome.unknown} undefined output bit(s) over ${outcome.checked} vector(s) (violation ${pct} %)` +
        (outcome.firstMismatch ? `, first at vector ${outcome.firstMismatch.index}: expected ${outcome.firstMismatch.expected}, got ${outcome.firstMismatch.got}` : '');
    case 'undeterminedOutputs':
      return `${outcome.unknown} output bit(s) never settled (violation ${pct} %)`;
    case 'maxComponents':
      return `components ${objectives.components} > ${constraints.maxComponents} (excess ${pct} %)`;
    case 'maxDepth':
      return `depth ${objectives.depth} > ${constraints.maxDepth} (excess ${pct} %)`;
    case 'maxDelay':
      return `delay ${(objectives.delay * 1e9).toFixed(3)} ns > ${((constraints.maxDelay ?? 0) * 1e9).toFixed(3)} ns (excess ${pct} %)`;
    case 'maxFanout':
      return `${risk.fanoutViolations} net(s) exceed the fan-out limit of ${constraints.maxFanout} (violation ${pct} %)`;
    default:
      return `${key} violated by ${pct} %`;
  }
}

// ---------------------------------------------------------------------------
// Tiers 3–4: the detailed pass
// ---------------------------------------------------------------------------

/**
 * Measure what only the device levels can answer:
 *
 *   static power   the transistor-level implementation, solved at level 1 for the
 *                  worst of a small input set (corners first, then random)
 *   temperature    the level-3 electro-thermal steady state at that operating point
 *   switch energy  a transient that toggles every input once, integrating the
 *                  supply current — the energy one full transition costs
 *
 * A candidate whose transistor level does not converge is reported as such: the
 * objectives stay `null` and the caller decides what to do. Nothing here is
 * extrapolated from the structure.
 */
export function detailCandidate(genome: LogicGenome, opts: EvaluateOptions & { vectorIndices?: number[] }): DetailResult {
  const spec = opts.spec;
  const t0 = Date.now();
  const ambient = opts.ambient ?? opts.constraints?.ambient ?? DEFAULT_CONSTRAINTS.ambient;
  const vdd = opts.constraints?.level1?.vdd ?? 3.3;
  const notes: string[] = [];
  const result: DetailResult = {
    staticPowerPerVector: [],
    worstVectorIndex: 0,
    staticPower: 0,
    temperature: null,
    thermalConverged: false,
    switchEnergy: null,
    transientNote: 'not run',
    simulatedTime: 0,
    ms: 0,
    notes,
  };

  const inputs = spec.inputs;
  const width = inputs.reduce((a, p) => a + Math.max(1, p.width), 0);
  const bitOf = (values: readonly number[], k: number): number => {
    let shift = 0;
    for (let pi = 0; pi < inputs.length; pi++) {
      const w = Math.max(1, inputs[pi].width);
      for (let b = 0; b < w; b++) {
        if (shift === k) return (values[pi] >>> b) & 1;
        shift++;
      }
    }
    return 0;
  };
  const vectors = opts.plan.vectors;
  const picked: number[] = opts.vectorIndices ?? [];
  if (picked.length === 0) {
    // Corners + a few seeded-random vectors: enough to see contention, small
    // enough to stay affordable. The count is reported, never assumed.
    const stride = Math.max(1, Math.floor(vectors.length / 6));
    for (let i = 0; i < vectors.length && picked.length < 8; i += stride) picked.push(i);
    if (!picked.includes(0)) picked.unshift(0);
  }
  notes.push(`static power measured over ${picked.length} input vector(s) of ${vectors.length}`);

  let worst = { index: picked[0] ?? 0, power: -Infinity };
  let measuredSim: CircuitSimulator | null = null;
  let measuredNl: FlatNetlist | null = null;
  for (const index of picked) {
    const values = vectors[index]?.in ?? inputs.map(() => 0);
    // Build a bench that drives each input bit at its own level: the genome
    // builder emits one source per bit, and the levels are the vector's bits.
    let nl: FlatNetlist;
    try {
      const benchCircuit = genomeToCircuit(genome, spec, {
        lib: opts.lib,
        chips: opts.chips,
        gateStyle: 'cmos_static',
        bench: { vdd },
        // One DC level per input bit: the vector, applied to real sources.
        bitLevels: Array.from({ length: width }, (_, k) => bitOf(values, k) * vdd),
      });
      nl = flatten(benchCircuit, opts.lib, opts.chips, { expandGates: true, thermal: true, ambient });
    } catch (err) {
      notes.push(`the transistor-level build failed: ${String((err as Error).message ?? err)}`);
      break;
    }
    const sim = new CircuitSimulator(nl, { ambient });
    const dc = sim.dcSolve();
    if (!dc.converged) {
      notes.push(`vector ${index}: the level-1 solve did not converge (worst node ${dc.worstNode})`);
      result.staticPowerPerVector.push(Number.NaN);
      continue;
    }
    const p = sim.powers();
    let gross = 0;
    for (const v of p) if (Number.isFinite(v) && v > 0) gross += v;
    result.staticPowerPerVector.push(gross);
    if (gross > worst.power) {
      worst = { index, power: gross };
      measuredSim = sim;
      measuredNl = nl;
    }
  }

  if (worst.power > -Infinity && Number.isFinite(worst.power)) {
    result.worstVectorIndex = worst.index;
    result.staticPower = worst.power;
  }
  if (measuredSim && measuredNl) {
    const thermal = measuredSim.solveThermalSteadyState();
    result.temperature = measuredSim.maxTemperature();
    result.thermalConverged = thermal.converged;
    notes.push(
      `level-3 steady state: ${thermal.iterations} iteration(s), ${thermal.converged ? 'converged' : 'NOT converged'}`,
    );
  }

  // ---- switching energy: one transition, integrated from the supply ---------
  try {
    const freq = opts.constraints?.level1?.frequency ?? 1e6;
    const periods = opts.constraints?.level1?.periods ?? 3;
    const nl = flatten(
      genomeToCircuit(genome, spec, {
        lib: opts.lib,
        chips: opts.chips,
        gateStyle: 'cmos_static',
        bench: { vdd, amplitude: vdd, frequency: freq, phaseStep: 180 / Math.max(1, width), riseTime: 1e-9, fallTime: 1e-9 },
      }),
      opts.lib,
      opts.chips,
      { expandGates: true, thermal: false, ambient },
    );
    const sim = new CircuitSimulator(nl, { ambient });
    const period = 1 / freq;
    const tr = sim.transient(period * periods, [], { maxStep: period / 40 });
    if (tr.ok) {
      result.simulatedTime = tr.sampleCount;
      // `elementEnergy` is the signed energy each element *absorbed*: what the
      // sources delivered is the negative part, summed over them only.
      let delivered = 0;
      for (let e = 0; e < nl.elementCount; e++) {
        if (nl.kind[e] !== Kind.VoltageSource && nl.kind[e] !== Kind.CurrentSource) continue;
        delivered += -Math.min(0, tr.elementEnergy[e] ?? 0);
      }
      const span = tr.times[tr.sampleCount - 1] - tr.times[0];
      result.switchEnergy = span > 0 ? delivered / (span / period) : null;
      result.transientNote =
        `transient over ${(span * 1e9).toFixed(1)} ns (${periods} period(s) of ${(freq / 1e6).toFixed(3)} MHz, ` +
        `${tr.sampleCount} samples): the sources delivered ${(delivered * 1e9).toFixed(4)} nJ, i.e. ` +
        `${result.switchEnergy !== null ? (result.switchEnergy * 1e12).toFixed(3) + ' pJ per period' : 'not measurable'}`;
      notes.push(`switching energy measured from a real transient (${tr.steps} step(s), ${tr.rejected} rejected)`);
    } else {
      result.transientNote = `the transient did not complete: ${tr.diagnostics.map((d) => d.code).join(', ') || 'no diagnostic'}`;
    }
  } catch (err) {
    result.transientNote = `the transient could not be set up: ${String((err as Error).message ?? err)}`;
  }

  result.ms = Date.now() - t0;
  return result;
}

/** Fan-out of every element's inputs, for reports and the GUI's fan-out overlay. */
export function fanoutHistogram(graph: LogicGraph, netCount: number): Int32Array {
  const fanout = new Int32Array(netCount);
  for (const el of graph.elements) for (const net of el.inputs.concat(el.selects)) if (net >= 0 && net < netCount) fanout[net]++;
  return fanout;
}

/**
 * One round of variation, used by the search: mutate or recombine, then
 * canonicalise. Kept here so that a caller can also propose candidates by hand.
 */
export function proposeVariation(parent: LogicGenome, rng: Rng, limits: GenomeLimits): LogicGenome {
  return mutateGenome(parent, rng, { limits });
}

/** Re-exported for callers that only need the names of the nets a report cites. */
export { nodeNameAt };

/** Functions a genome may use, for the report's "search space" section. */
export const SEARCH_SPACE = {
  functions: [FN.BUF, FN.NOT, FN.AND, FN.NAND, FN.OR, FN.NOR, FN.XOR, FN.XNOR, FN.MUX] as const,
  names: ['BUF', 'NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR', 'MUX'] as const,
  constants: [CONST0, CONST1] as const,
};
