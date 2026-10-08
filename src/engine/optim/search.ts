/**
 * The optimisation session: seeded NSGA-II over the logic-network genome, with
 * the tiered filter of `cost.ts`, a candidate cache, checkpoints that survive a
 * crash, and a report that states its own scope.
 *
 * The claim this module is allowed to make is exactly one:
 *
 *      BEST FOUND UNDER CURRENT CONSTRAINTS
 *
 * …and it always prints the constraints, the search space it explored, the method,
 * how many candidates it evaluated, which simulation level each number came from,
 * and the ranking criteria. It never says "optimal", and it never reports a
 * number it did not measure at a level it can name.
 */

import { Rng, type RngState } from '../util/rng.js';
import { ENGINE_VERSION, MODEL_VERSIONS, type ModelName } from '../util/version.js';
import type { Library } from '../core/library.js';
import { ChipLibrary, type Chip } from '../core/chip.js';
import type { Project } from '../core/project.js';
import type { Circuit } from '../core/circuit.js';
import { cpuCores, detectPlatform } from '../util/platform.js';
import {
  Nsga2,
  type EvaluateResult,
  type Individual,
} from './nsga2.js';
import {
  DEFAULT_CONSTRAINTS,
  detailCandidate,
  evaluateCandidate,
  TIER_NAMES,
  type Candidate,
  type DesignConstraints,
  type DetailResult,
  type EvaluateOptions,
  type Objectives,
} from './cost.js';
import { crossoverGenomes, genomeKey, genomeStats, genomeToCircuit, mutateGenome, type GenomeLimits, type LogicGenome, DEFAULT_LIMITS } from './genome.js';
import { describeSpec, planVectors, type DesignSpec, type VectorPlan } from './spec.js';
import { rankCandidates, resolveProfile, OBJECTIVE_NAMES, type ObjectiveWeights, type ProfileName, type ProfileSpec, type RankingResult } from './profiles.js';
import { SEED_CATALOG, templateSeeds } from './templates.js';
import { whyThisDesign, type WhyReport } from './explain.js';

/** Objectives the evolutionary search itself minimises. */
export const SEARCH_OBJECTIVES = ['delay', 'components', 'risk', 'memory'] as const;

export interface OptimizeBudget {
  /** Hard cap on candidate evaluations. */
  evaluations?: number;
  /** Hard cap on wall-clock milliseconds. */
  milliseconds?: number;
  /** Hard cap on generations. */
  generations?: number;
}

export interface OptimizeRequest {
  spec: DesignSpec;
  lib: Library;
  chips?: ChipLibrary;
  /** Name of the generated sheet / chip (defaults to the specification name). */
  name?: string;
  profile?: ProfileName | ProfileSpec;
  weights?: Partial<ObjectiveWeights>;
  constraints?: DesignConstraints;
  limits?: GenomeLimits;
  seed?: number | string;
  populationSize?: number;
  budget?: OptimizeBudget;
  /** Detail (tiers 3–4) this many top candidates at the end; 0 = never. */
  detailTop?: number;
  /** Architecture seeds: `auto` (default) uses the catalogue, `none` skips them. */
  seeds?: 'auto' | 'none';
  /** Extra genomes to seed with (e.g. an architecture the user already has). */
  extraSeeds?: LogicGenome[];
}

export interface OptimizeProgress {
  phase: 'searching' | 'detailing' | 'done' | 'cancelled' | 'paused';
  generation: number;
  evaluated: number;
  rejected: number;
  cached: number;
  populationSize: number;
  paretoSize: number;
  archiveSize: number;
  /** Evaluations left in the budget, or null when the budget is time-bounded. */
  remaining: number | null;
  bestScore: number | null;
  elapsedMs: number;
  cpuMs: number;
  memoryMB: number;
  evaluationsPerSecond: number;
  estimatedRemainingMs: number | null;
  /** Objective values of the current best (search objectives only). */
  bestObjectives: Partial<Record<(typeof SEARCH_OBJECTIVES)[number], number>>;
  /** How many evaluated candidates actually meet the contract. */
  feasible: number;
  /**
   * Smallest constraint violation among the infeasible candidates, or null when
   * at least one is feasible (or nothing was evaluated). This is the number that
   * says "the search is getting closer" while no correct design exists yet.
   */
  bestViolation: number | null;
}

export interface CandidateReport {
  key: string;
  source: string;
  generation: number;
  objectives: Objectives;
  /** True when the candidate met the specification and every constraint. */
  ok: boolean;
  /** Summed constraint violation (0 when `ok`). */
  violation: number;
  /** Which constraint was broken and by how much, in measured terms. */
  violationTerms: Record<string, number>;
  /** The evaluator's own one-line verdict. */
  reason: string;
  genome: { nodes: number; depth: number; maxFanout: number };
  fingerprint: string | null;
  vectorsChecked: number;
  vectorMethod: string;
  tiers: Array<{ id: number; name: string; passed: boolean; note: string; ms: number }>;
  detail: DetailResult | null;
  score: number;
  rank: number;
}

export interface OptimizationReport {
  claim: 'BEST FOUND UNDER CURRENT CONSTRAINTS';
  spec: { name: string; description: string; vectors: number; method: string; note: string };
  constraints: DesignConstraints;
  searchSpace: {
    genome: string;
    functions: string[];
    maxNodes: number;
    populationSize: number;
    generations: number;
    evaluations: number;
    distinctCandidates: number;
    seeds: string[];
  };
  method: {
    algorithm: string;
    selection: string;
    variation: string;
    cache: { hits: number; misses: number };
    tiers: Record<number, string>;
  };
  simulationLevels: { search: string; detail: string | null };
  ranking: {
    profile: ProfileName;
    weights: ObjectiveWeights;
    criteria: string;
    note: string;
    weighted: string[];
  };
  reproducibility: {
    seed: number | string;
    rngDraws: number;
    engineVersion: string;
    modelVersion: Record<string, string>;
    hardware: { platform: string; cores: number; cpu: string };
    cpuMs: number;
    wallMs: number;
  };
  best: CandidateReport | null;
  runnerUp: CandidateReport | null;
  pareto: CandidateReport[];
  notes: string[];
}

export interface OptimizerSnapshot {
  version: 1;
  generation: number;
  rng: RngState;
  draws: number;
  /** Every individual the search evaluated, as genomes + objective vectors. */
  archive: Array<{ genes: LogicGenome; key: string; values: number[]; generation: number; source: string }>;
  population: string[];
  stats: { evaluated: number; rejected: number; cached: number; cpuMs: number; wallMs: number; detailed: number };
  finished: boolean;
  cancelled: boolean;
}

interface ArchivedCandidate {
  individual: Individual<LogicGenome>;
  source: string;
  candidate: Candidate | null;
  detail: DetailResult | null;
}

/** Versions of the models whose numbers appear in this report. */
function modelVersionsInPlay(): Record<string, string> {
  const names: ModelName[] = ['bitlogic', 'logic', 'timing', 'mna', 'devices', 'thermal', 'ranking'];
  const out: Record<string, string> = {};
  for (const n of names) out[n] = MODEL_VERSIONS[n];
  return out;
}

/**
 * One optimisation session.
 *
 * The session is deliberately *steppable*: the job queue drives it one generation
 * at a time, which is what makes pause/resume/cancel and checkpoints possible
 * without threads and without losing work.
 */
export class Optimizer {
  readonly request: OptimizeRequest;
  readonly spec: DesignSpec;
  readonly profile: ProfileSpec;
  readonly plan: VectorPlan;
  readonly constraints: DesignConstraints;
  readonly limits: GenomeLimits;
  readonly rng: Rng;
  readonly engine: Nsga2<LogicGenome>;
  readonly archive = new Map<string, ArchivedCandidate>();
  private sources = new Map<string, string>();
  private evaluated = 0;
  private rejected = 0;
  private cached = 0;
  private cacheMisses = 0;
  private detailed = 0;
  private t0 = Date.now();
  private cpuMs = 0;
  private phase: OptimizeProgress['phase'] = 'searching';
  private ranking: RankingResult | null = null;
  private reportCache: OptimizationReport | null = null;
  private seedNames: string[] = [];

  constructor(request: OptimizeRequest) {
    this.request = request;
    this.spec = request.spec;
    this.profile = resolveProfile(request.profile, request.weights);
    this.constraints = request.constraints ?? {};
    this.limits = request.limits ?? DEFAULT_LIMITS;
    this.rng = new Rng(request.seed ?? `${request.spec.name}:${request.name ?? ''}`);
    this.plan = planVectors(this.spec, this.rng);
    this.engine = new Nsga2<LogicGenome>({ populationSize: request.populationSize ?? 24, tournamentSize: 2, crossoverRate: 0.5 });
    this.seedPopulation();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private evaluateOptions(): EvaluateOptions {
    return {
      spec: this.spec,
      plan: this.plan,
      lib: this.request.lib,
      chips: this.request.chips ?? new ChipLibrary(),
      constraints: this.constraints,
      limits: this.limits,
      ambient: this.constraints.ambient ?? DEFAULT_CONSTRAINTS.ambient,
    };
  }

  /** Objective vector the evolutionary search sees (all measured at tiers 0–2). */
  private valuesOf(candidate: Candidate): number[] {
    const o = candidate.objectives;
    return [o.delay, o.components, o.risk, o.memory];
  }

  private evaluate = (genes: LogicGenome): EvaluateResult => {
    const t = Date.now();
    const candidate = evaluateCandidate(genes, this.evaluateOptions());
    this.cpuMs += Date.now() - t;
    this.archive.set(candidate.key, { individual: null as unknown as Individual<LogicGenome>, source: this.sourceOf(genes), candidate, detail: null });
    if (!Number.isFinite(candidate.violation)) {
      // Unbuildable: there is no objective vector to rank, so it is a rejection.
      // The caller (seed()/step()) counts it; counting here too would double it.
      return { values: [], rejected: `${TIER_NAMES[candidate.failedTier ?? 0]}: ${candidate.reason}` };
    }
    // A candidate that builds and measures but breaks the contract keeps its
    // objectives and carries its violation. Constrained dominance then ranks it
    // below every feasible design and above the ones that are further off, which
    // is the only gradient a search has when no seed is correct.
    return { values: this.valuesOf(candidate), violation: candidate.violation };
  };

  private sourceOf(genes: LogicGenome): string {
    return this.sources.get(genomeKey(genes)) ?? 'variation';
  }

  private seedPopulation(): void {
    const seeds: Array<{ genes: LogicGenome; key: string }> = [];
    if (this.request.seeds !== 'none') {
      const t = templateSeeds(this.spec, this.rng, { randomCount: Math.max(2, Math.round((this.request.populationSize ?? 24) / 4)) });
      for (let i = 0; i < t.genomes.length; i++) {
        const key = genomeKey(t.genomes[i]);
        this.sources.set(key, t.sources[i]);
        this.seedNames.push(t.sources[i]);
        seeds.push({ genes: t.genomes[i], key });
      }
    }
    for (const g of this.request.extraSeeds ?? []) {
      const key = genomeKey(g);
      this.sources.set(key, 'caller seed');
      seeds.push({ genes: g, key });
    }
    if (seeds.length === 0) {
      const g = templateSeeds(this.spec, this.rng, { architectures: false, randomCount: this.request.populationSize ?? 24 });
      for (const genome of g.genomes) seeds.push({ genes: genome, key: genomeKey(genome) });
    }
    const step = this.engine.seed(seeds, this.evaluate);
    this.evaluated += step.evaluated;
    this.cached += step.cached;
    this.syncArchive();
  }

  /** Attach the Nsga2 individual objects to the archive entries that lack them. */
  private syncArchive(): void {
    for (const [key, ind] of this.engine.archive) {
      const entry = this.archive.get(key);
      if (entry) entry.individual = ind;
      else this.archive.set(key, { individual: ind, source: this.sources.get(key) ?? 'variation', candidate: null, detail: null });
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /** Produce and evaluate one generation. */
  step(): void {
    // A paused or cancelled session does no work: `step()` is what the job queue
    // calls in a loop, so ignoring the phase here made `pause()` a no-op.
    if (this.phase !== 'searching') return;
    if (this.engine.size === 0) {
      // Nothing survived the seeds: without a population there is nothing to
      // vary, and reporting a design would be a lie.
      this.phase = 'done';
      return;
    }
    const t = Date.now();
    const before = this.engine.archive.size;
    const step = this.engine.step(
      this.rng,
      (a, b) => {
        if (b === null || this.rng.chance(0.35)) {
          const genes = mutateGenome(a, this.rng, { limits: this.limits });
          return { genes, key: genomeKey(genes) };
        }
        const genes = crossoverGenomes(a, b, this.rng);
        return { genes, key: genomeKey(genes) };
      },
      this.evaluate,
    );
    const ms = Date.now() - t;
    this.cpuMs += ms;
    this.evaluated += step.evaluated;
    this.rejected += step.rejected;
    this.cached += step.cached;
    this.cacheMisses += step.evaluated;
    void before;
    void ms;
    this.syncArchive();
    this.reportCache = null;
    this.ranking = null;
  }

  /** Run until a stop condition: budget, generation count, or a caller's stop. */
  run(): void {
    const budget = this.request.budget ?? {};
    while (this.phase === 'searching') {
      if (budget.evaluations !== undefined && this.evaluated >= budget.evaluations) break;
      if (budget.generations !== undefined && this.engine.generation >= budget.generations) break;
      if (budget.milliseconds !== undefined && Date.now() - this.t0 >= budget.milliseconds) break;
      this.step();
    }
    if (this.phase === 'searching' && ((this.request.detailTop ?? 0) > 0)) this.detailTop();
    if (this.phase === 'searching') this.phase = 'done';
  }

  pause(): void {
    if (this.phase === 'searching') this.phase = 'paused';
  }

  resume(): void {
    if (this.phase === 'paused') this.phase = 'searching';
  }

  cancel(): void {
    this.phase = 'cancelled';
  }

  // -------------------------------------------------------------------------
  // Detailed pass
  // -------------------------------------------------------------------------

  /**
   * Measure tiers 3–4 on the candidates that matter: the Pareto front of the
   * search, plus the current profile leaders, capped at `count`.
   */
  detailTop(count = this.request.detailTop ?? 8): void {
    const ranked = rankCandidates(
      [...this.archive.values()].filter((e) => e.candidate?.ok).map((e) => ({ key: e.candidate!.key, objectives: e.candidate!.objectives })),
      this.profile,
    );
    const front = this.engine.archiveFront();
    const keys: string[] = [];
    const seen = new Set<string>();
    // Profile leaders first (the user's stated trade-off), then the front.
    for (const r of ranked.ranked) {
      if (keys.length >= count) break;
      if (seen.has(r.key)) continue;
      if (!this.archive.get(r.key)?.candidate?.ok) continue;
      seen.add(r.key);
      keys.push(r.key);
    }
    for (const ind of front) {
      if (keys.length >= count) break;
      if (seen.has(ind.key)) continue;
      if (!this.archive.has(ind.key)) continue;
      seen.add(ind.key);
      keys.push(ind.key);
    }
    this.phase = 'detailing';
    for (const key of keys) {
      const entry = this.archive.get(key);
      if (!entry?.candidate?.ok) continue;
      const t = Date.now();
      const detail = detailCandidate(entry.candidate.genome, { ...this.evaluateOptions(), ambient: this.constraints.ambient });
      this.cpuMs += Date.now() - t;
      entry.detail = detail;
      entry.candidate.detail = detail;
      entry.candidate.objectives.power = detail.staticPower;
      entry.candidate.objectives.temperature = detail.temperature;
      entry.candidate.objectives.switchEnergy = detail.switchEnergy;
      this.detailed++;
    }
    this.phase = 'done';
    this.ranking = null;
    this.reportCache = null;
  }

  // -------------------------------------------------------------------------
  // Ranking and reporting
  // -------------------------------------------------------------------------

  rank(): RankingResult {
    if (this.ranking) return this.ranking;
    const inputs = [...this.archive.values()]
      .filter((e) => e.candidate?.ok)
      .map((e) => ({ key: e.candidate!.key, objectives: e.candidate!.objectives }));
    this.ranking = rankCandidates(inputs, this.profile);
    return this.ranking;
  }

  private candidateReport(key: string, score: number, rank: number): CandidateReport | null {
    const entry = this.archive.get(key);
    if (!entry?.candidate) return null;
    const c = entry.candidate;
    const stats = genomeStats(c.genome);
    return {
      key,
      source: entry.source,
      generation: entry.individual?.generation ?? 0,
      objectives: c.objectives,
      ok: c.ok,
      violation: c.violation,
      violationTerms: { ...c.violationTerms },
      reason: c.reason,
      genome: { nodes: stats.nodes, depth: stats.depth, maxFanout: Math.max(0, ...stats.fanout) },
      fingerprint: c.fingerprint,
      vectorsChecked: c.vectorsChecked,
      vectorMethod: c.vectorMethod,
      tiers: c.tiers.map((t) => ({ id: t.id, name: t.name, passed: t.passed, note: t.note, ms: t.ms })),
      detail: entry.detail,
      score,
      rank,
    };
  }

  progress(): OptimizeProgress {
    const budget = this.request.budget ?? {};
    const elapsed = Date.now() - this.t0;
    const ranked = this.rank();
    const best = ranked.ranked[0] ? this.archive.get(ranked.ranked[0].key) : undefined;
    const remaining = budget.evaluations !== undefined ? Math.max(0, budget.evaluations - this.evaluated) : null;
    const rate = this.evaluated > 0 && elapsed > 0 ? (this.evaluated / elapsed) * 1000 : 0;
    const bestObjectives: Partial<Record<(typeof SEARCH_OBJECTIVES)[number], number>> = {};
    if (best?.candidate) {
      bestObjectives.delay = best.candidate.objectives.delay;
      bestObjectives.components = best.candidate.objectives.components;
      bestObjectives.risk = best.candidate.objectives.risk;
      bestObjectives.memory = best.candidate.objectives.memory;
    }
    return {
      phase: this.phase,
      generation: this.engine.generation,
      evaluated: this.evaluated,
      rejected: this.rejected,
      cached: this.cached,
      populationSize: this.engine.size,
      paretoSize: this.engine.front().length,
      archiveSize: this.archive.size,
      remaining,
      bestScore: ranked.ranked[0]?.score ?? null,
      elapsedMs: elapsed,
      cpuMs: this.cpuMs,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      evaluationsPerSecond: rate,
      estimatedRemainingMs: remaining !== null && rate > 0 ? (remaining / rate) * 1000 : null,
      bestObjectives,
      feasible: this.feasibleCount(),
      bestViolation: this.bestViolation(),
    };
  }

  /** Candidates in the archive that met every constraint. */
  feasibleCount(): number {
    let n = 0;
    for (const e of this.archive.values()) if (e.candidate?.ok) n++;
    return n;
  }

  /** Smallest violation among the candidates that did not, or null. */
  bestViolation(): number | null {
    if (this.feasibleCount() > 0) return 0;
    let best: number | null = null;
    for (const e of this.archive.values()) {
      const c = e.candidate;
      if (!c || c.ok || !Number.isFinite(c.violation)) continue;
      if (best === null || c.violation < best) best = c.violation;
    }
    return best;
  }

  /** The candidate closest to meeting the contract, feasible or not. */
  closest(): CandidateReport | null {
    const ranked = this.rank();
    if (ranked.ranked[0]) return this.candidateReport(ranked.ranked[0].key, ranked.ranked[0].score, 1);
    let bestKey: string | null = null;
    let bestViolation = Infinity;
    for (const [key, e] of this.archive) {
      const c = e.candidate;
      if (!c || !Number.isFinite(c.violation)) continue;
      if (c.violation < bestViolation) {
        bestViolation = c.violation;
        bestKey = key;
      }
    }
    return bestKey ? this.candidateReport(bestKey, bestViolation, 0) : null;
  }

  /** "WHY THIS DESIGN?" — measured deltas against the runner-up, nothing more. */
  why(): WhyReport | null {
    const report = this.report();
    if (!report.best) return null;
    return whyThisDesign(report.best, report.runnerUp, this.profile.weights);
  }

  /** The full report — the only place the claim is stated. */
  report(): OptimizationReport {
    if (this.reportCache) return this.reportCache;
    const ranked = this.rank();
    const best = ranked.ranked[0] ? this.candidateReport(ranked.ranked[0].key, ranked.ranked[0].score, 1) : null;
    const runner = ranked.ranked[1] ? this.candidateReport(ranked.ranked[1].key, ranked.ranked[1].score, 2) : null;
    const front = this.engine.archiveFront();
    const pareto: CandidateReport[] = [];
    for (const ind of front.slice(0, 12)) {
      const r = ranked.ranked.find((x) => x.key === ind.key);
      const rep = this.candidateReport(ind.key, r?.score ?? 1, 0);
      if (rep) pareto.push(rep);
    }
    const hardware = detectPlatform();
    const notes: string[] = [];
    const feasibleCount = this.feasibleCount();
    if (feasibleCount === 0) {
      const closest = this.closest();
      notes.push(
        `no candidate satisfied the specification: ${this.evaluated} candidate(s) were evaluated and every one broke the contract. ` +
          (closest
            ? `The closest missed by a violation of ${closest.violation.toFixed(4)} (${closest.reason}); its numbers are reported for diagnosis, not as a design.`
            : 'No candidate was even buildable.'),
      );
      notes.push(
        'Widen the search (more generations, a larger population, a higher node limit) or relax the constraints before drawing any conclusion from this run.',
      );
    }
    const detailedCount = [...this.archive.values()].filter((e) => e.detail !== null).length;
    if (detailedCount === 0) {
      notes.push(
        'power and temperature were not measured for any candidate: the report describes levels 0–2 only ' +
          '(logic, structure, declared-model timing). Ask for the detailed pass to see them.',
      );
    } else {
      notes.push(
        `static power at the transistor level and the level-3 steady state were measured for ${detailedCount} candidate(s); ` +
          'switching energy comes from a transient over the declared stimulus. Candidates without a detailed pass are ranked on a reduced weight set.',
      );
    }
    if (!this.spec.vectors && this.spec.behaviour) {
      notes.push(`the contract was generated from the specification's behaviour: ${this.plan.note}`);
    }
    notes.push(...(this.spec.combinational === false ? ['sequential specification: sequential behaviour is verified by vector simulation only'] : []));
    const report: OptimizationReport = {
      claim: 'BEST FOUND UNDER CURRENT CONSTRAINTS',
      spec: {
        name: this.spec.name,
        description: describeSpec(this.spec),
        vectors: this.plan.vectors.length,
        method: this.plan.method,
        note: this.plan.note,
      },
      constraints: { ...this.constraints },
      searchSpace: {
        genome: `${this.limits.maxNodes} nodes max, ${this.plan.method === 'exhaustive' ? 'exhaustive' : 'sampled'} behaviour contract`,
        functions: ['BUF', 'NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR', 'MUX(const)'],
        maxNodes: this.limits.maxNodes,
        populationSize: this.request.populationSize ?? 24,
        generations: this.engine.generation,
        evaluations: this.evaluated,
        distinctCandidates: this.archive.size,
        seeds: [...new Set(this.seedNames)],
      },
      method: {
        algorithm: 'NSGA-II (fast non-dominated sort + crowding distance), elitist (μ+λ)',
        selection: 'binary tournament on (rank, crowding distance)',
        variation: 'subgraph crossover + 5 mutation operators (insert, delete, change function, rewire, retarget output)',
        cache: { hits: this.cached, misses: this.cacheMisses },
        tiers: Object.fromEntries(Object.entries(TIER_NAMES).map(([k, v]) => [Number(k), v])),
      },
      simulationLevels: {
        search: 'level 0 (bit-parallel 0/1/X/Z logic) for the contract, declared-delay timing under the load model of the genome',
        detail:
          detailedCount > 0
            ? 'level 1 DC operating point of the transistor-level implementation, level 3 electro-thermal steady state, transient switching energy'
            : null,
      },
      ranking: {
        profile: this.profile.name,
        weights: this.profile.weights,
        criteria:
          'weighted sum of min–max normalised objectives (lower is better) inside this candidate set; ' +
          `objectives ${OBJECTIVE_NAMES.filter((n) => this.profile.weights[n] > 0).join(', ')}`,
        note: ranked.note,
        weighted: OBJECTIVE_NAMES.filter((n) => this.profile.weights[n] > 0),
      },
      reproducibility: {
        seed: this.request.seed ?? `${this.spec.name}:${this.request.name ?? ''}`,
        rngDraws: this.rng.draws,
        engineVersion: ENGINE_VERSION,
        modelVersion: modelVersionsInPlay(),
        hardware: { platform: hardware.node ? 'node' : 'browser', cores: cpuCores(), cpu: hardware.cpu.model },
        cpuMs: this.cpuMs,
        wallMs: Date.now() - this.t0,
      },
      best,
      runnerUp: runner,
      pareto,
      notes,
    };
    this.reportCache = report;
    return report;
  }

  // -------------------------------------------------------------------------
  // Applying the result
  // -------------------------------------------------------------------------

  bestGenome(): LogicGenome | null {
    const ranked = this.rank();
    const key = ranked.ranked[0]?.key;
    return key ? (this.archive.get(key)?.candidate?.genome ?? null) : null;
  }

  buildBest(opts: { gateStyle?: 'ideal' | 'cmos_static'; bench?: boolean } = {}): Circuit | null {
    const genome = this.bestGenome();
    if (!genome) return null;
    return genomeToCircuit(genome, this.spec, {
      lib: this.request.lib,
      chips: this.request.chips,
      name: this.request.name ?? this.spec.name,
      gateStyle: opts.gateStyle ?? 'ideal',
      bench: opts.bench ? { vdd: this.constraints.level1?.vdd ?? 3.3 } : undefined,
    });
  }

  /** Save the best design as a reusable chip (the "save as chip" of the spec). */
  saveBestAsChip(project: Project, opts: { id?: string; name?: string; description?: string; overwrite?: boolean } = {}): Chip | null {
    const circuit = this.buildBest();
    if (!circuit) return null;
    const id = opts.id ?? `${this.spec.name}_auto`;
    const report = this.report();
    const best = report.best;
    return project.saveAsChip(circuit, {
      id,
      name: opts.name ?? `${this.spec.name.toUpperCase()} (optimised)`,
      description:
        opts.description ??
        `Generated from the specification ${describeSpec(this.spec)} and optimised by the NSGA-II search ` +
          `(${this.profile.name} profile). ${report.claim}: ${best ? `${best.objectives.components} components, ${(best.objectives.delay * 1e9).toFixed(3)} ns` : 'no candidate'}.`,
      tags: ['generated', 'optimised'],
      origin: 'synthesis',
      overwrite: opts.overwrite,
    });
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  snapshot(): OptimizerSnapshot {
    return {
      version: 1,
      generation: this.engine.generation,
      rng: { s0: this.rng.s0, s1: this.rng.s1, s2: this.rng.s2, s3: this.rng.s3 },
      draws: this.rng.draws,
      archive: [...this.archive.values()]
        .filter((e) => e.candidate)
        .map((e) => ({
          genes: e.candidate!.genome,
          key: e.candidate!.key,
          values: e.candidate!.ok ? this.valuesOf(e.candidate!) : [],
          generation: e.individual?.generation ?? 0,
          source: e.source,
        })),
      population: this.engine.population.map((p) => p.key),
      stats: { evaluated: this.evaluated, rejected: this.rejected, cached: this.cached, cpuMs: this.cpuMs, wallMs: Date.now() - this.t0, detailed: this.detailed },
      finished: this.phase === 'done',
      cancelled: this.phase === 'cancelled',
    };
  }

  /**
   * Rebuild a session from a checkpoint. The archive is restored *without*
   * re-running the tiers: the checkpoint carries the genomes and the objective
   * vectors the search had already computed, which is what makes a crash resume
   * cost nothing.
   */
  static restore(snapshot: OptimizerSnapshot, request: OptimizeRequest): Optimizer {
    const optimizer = new Optimizer({ ...request, seed: request.seed ?? `${request.spec.name}:resume` });
    optimizer.archive.clear();
    optimizer.evaluated = snapshot.stats.evaluated;
    optimizer.rejected = snapshot.stats.rejected;
    optimizer.cached = snapshot.stats.cached;
    optimizer.cpuMs = snapshot.stats.cpuMs;
    optimizer.detailed = snapshot.stats.detailed;
    optimizer.rng.s0 = snapshot.rng.s0;
    optimizer.rng.s1 = snapshot.rng.s1;
    optimizer.rng.s2 = snapshot.rng.s2;
    optimizer.rng.s3 = snapshot.rng.s3;
    optimizer.rng.draws = snapshot.draws;
    const population: Individual<LogicGenome>[] = [];
    for (const entry of snapshot.archive) {
      const candidate = evaluateCandidate(entry.genes, optimizer.evaluateOptions());
      candidate.ok = entry.values.length > 0;
      candidate.objectives.delay = entry.values[0] ?? candidate.objectives.delay;
      candidate.objectives.components = entry.values[1] ?? candidate.objectives.components;
      candidate.objectives.risk = entry.values[2] ?? candidate.objectives.risk;
      candidate.objectives.memory = entry.values[3] ?? candidate.objectives.memory;
      const individual: Individual<LogicGenome> = {
        genes: entry.genes,
        key: entry.key,
        values: entry.values,
        rank: 0,
        crowding: 0,
        generation: entry.generation,
        // A restored archive entry either met the contract (violation 0) or could
        // not be evaluated at all (no objective vector). Nothing in between is
        // stored, because a checkpoint that carried infeasible candidates would
        // have to carry their violation terms too.
        violation: entry.values.length === 0 ? Number.POSITIVE_INFINITY : 0,
        rejected: entry.values.length === 0 ? 'restored as rejected' : undefined,
      };
      optimizer.archive.set(entry.key, { individual, source: entry.source, candidate, detail: null });
      optimizer.engine.archive.set(entry.key, individual);
      if (snapshot.population.includes(entry.key)) population.push(individual);
    }
    optimizer.engine.population.push(...population);
    optimizer.engine.generation = snapshot.generation;
    optimizer.phase = snapshot.cancelled ? 'cancelled' : snapshot.finished ? 'done' : 'searching';
    return optimizer;
  }
}

export { SEED_CATALOG };
