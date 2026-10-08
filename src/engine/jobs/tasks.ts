/**
 * Concrete jobs: the tasks the queue can actually run.
 *
 * Every task here is built from a *serialisable* spec (JSON), which is what makes
 * a job persistable and resumable across a crash. Nothing that cannot be written
 * to disk goes into a spec: a circuit is stored as its document, a design
 * specification as `{ specId, params }` resolved through the catalogue, and the
 * library and chip set come from the shared `JobContext`.
 *
 * Each task is steppable at a granularity that matters to the user:
 *   optimize  → one generation per step
 *   validate  → one check per step
 *   simulate  → one sweep point / one time window per step
 *   analyze   → one analysis pass per step
 *   export    → one artefact per step
 * so a pause lands between two meaningful units and a checkpoint is always
 * consistent.
 */

import { createDefaultLibrary } from '../core/registry.js';
import { ChipLibrary, type Chip } from '../core/chip.js';
import { Project } from '../core/project.js';
import type { Library } from '../core/library.js';
import type { Circuit } from '../core/circuit.js';
import { circuitToDocument, circuitFromDocument, type CircuitDocument } from '../io/serialize.js';
import { flatten, nodeNameAt, netlistStats, type FlatNetlist } from '../sim/netlist.js';
import { CircuitSimulator } from '../sim/solver.js';
import { analysisToText, analyzeCircuit, type AnalyzeReport } from '../analysis/analyzer.js';
import { Severity } from '../core/labels.js';
import { circuitStats } from '../analysis/stats.js';
import { exportSchematicHierarchical, exportSchematicFlattened, exportSchematicElectrical, schematicToJson, type ExportLevel } from '../export/schematic.js';
import { buildBomFromCircuit, bomToCsv, bomToText } from '../export/bom.js';
import { exportSpiceNetlist } from '../export/spice.js';
import { Optimizer, type OptimizationReport, type OptimizerSnapshot, type OptimizeRequest } from '../optim/search.js';
import { buildSpecById, describeSpec, specIds, type DesignSpec } from '../optim/spec.js';
import type { ProfileName } from '../optim/profiles.js';
import { whyToText } from '../optim/explain.js';
import { ValidationSession, validateCircuit, validationToText, type ValidationReport } from '../validate/validation.js';
import { emptyProgress, type JobKind, type JobProgress, type Task } from './types.js';
import type { JobQueue } from './queue.js';

/** What a task needs from the outside world. */
export interface JobContext {
  lib: Library;
  chips: ChipLibrary;
  project: Project;
}

export function makeContext(project?: Project): JobContext {
  const p = project ?? new Project('circuitforge jobs');
  return { lib: p.lib, chips: p.chips, project: p };
}

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

const num = (spec: Record<string, unknown>, key: string, fallback: number): number => {
  const v = spec[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const str = (spec: Record<string, unknown>, key: string, fallback: string): string => {
  const v = spec[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
};

const bool = (spec: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const v = spec[key];
  return typeof v === 'boolean' ? v : fallback;
};

const obj = (spec: Record<string, unknown>, key: string): Record<string, unknown> => {
  const v = spec[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

/** Load a circuit from a job spec: an inline document, or a chip from the project. */
function circuitFromSpec(spec: Record<string, unknown>, ctx: JobContext): { circuit: Circuit; source: string } {
  const doc = spec.circuit as CircuitDocument | undefined;
  if (doc && typeof doc === 'object') {
    const loaded = circuitFromDocument(doc, ctx.lib, ctx.chips);
    return { circuit: loaded.circuit, source: `document "${doc.name ?? 'inline'}"` };
  }
  const chipId = typeof spec.chipId === 'string' ? spec.chipId : null;
  if (chipId) {
    const chip: Chip | undefined = ctx.chips.get(chipId);
    if (!chip) throw new Error(`chip "${chipId}" is not in the project's chip library`);
    const params = obj(spec, 'chipParams');
    const bag: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') bag[k] = v;
    return { circuit: chip.implementation(bag), source: `chip ${chip.key()}` };
  }
  // A project holds the sheet the user is editing; `sheetId` selects it by name
  // so a job spec can still name the circuit it wants.
  if (typeof spec.sheetId === 'string' || spec.useProjectSheet === true) {
    const sheet = ctx.project.sheet;
    if (!sheet) throw new Error('the project has no working sheet');
    const wanted = typeof spec.sheetId === 'string' ? spec.sheetId : null;
    if (wanted && sheet.name !== wanted) throw new Error(`the project's working sheet is "${sheet.name}", not "${wanted}"`);
    return { circuit: sheet, source: `sheet "${sheet.name}"` };
  }
  throw new Error('the job spec names no circuit: give `circuit`, `chipId` or `sheetId`');
}

function flattenOf(circuit: Circuit, ctx: JobContext, ambient: number, expandGates: boolean): FlatNetlist {
  return flatten(circuit, ctx.lib, ctx.chips, { ambient, expandGates, thermal: true });
}

// ---------------------------------------------------------------------------
// optimize
// ---------------------------------------------------------------------------

export interface OptimizeJobSpec extends Record<string, unknown> {
  specId: string;
  params?: Record<string, number>;
  profile?: ProfileName;
  weights?: Record<string, number>;
  constraints?: Record<string, unknown>;
  seed?: number | string;
  populationSize?: number;
  generations?: number;
  evaluations?: number;
  milliseconds?: number;
  detailTop?: number;
  maxNodes?: number;
  saveAsChip?: boolean;
  chipId?: string;
}

export class OptimizeTask implements Task {
  readonly kind: JobKind = 'optimize';
  readonly name: string;
  private optimizer: Optimizer;
  private designSpec: DesignSpec;
  private saveAsChip: boolean;
  private chipId: string | null;
  private ctx: JobContext;
  private generations: number | null;
  private detailing = false;
  private detailBudget: number;
  private done = false;
  private report: OptimizationReport | null = null;
  private savedChipId: string | null = null;

  constructor(spec: OptimizeJobSpec, checkpoint: unknown, ctx: JobContext) {
    this.ctx = ctx;
    this.designSpec = buildSpecById(str(spec, 'specId', 'adder'), obj(spec, 'params') as Record<string, number>);
    this.saveAsChip = bool(spec, 'saveAsChip', false);
    this.chipId = typeof spec.chipId === 'string' ? spec.chipId : null;
    const generations = spec.generations !== undefined ? num(spec, 'generations', 0) : null;
    this.generations = generations && generations > 0 ? generations : null;
    this.detailBudget = num(spec, 'detailTop', 0);
    const weightsRaw = obj(spec, 'weights');
    const weights: Record<string, number> = {};
    for (const [k, v] of Object.entries(weightsRaw)) if (typeof v === 'number') weights[k] = v;
    const constraints = obj(spec, 'constraints');
    const request: OptimizeRequest = {
      spec: this.designSpec,
      lib: ctx.lib,
      chips: ctx.chips,
      name: str(spec, 'name', this.designSpec.name),
      profile: (str(spec, 'profile', 'BALANCED') as ProfileName),
      weights: weights as never,
      constraints: constraints as never,
      limits: { maxNodes: num(spec, 'maxNodes', 220), seedNodes: 16 },
      seed: spec.seed ?? `${this.designSpec.name}:job`,
      populationSize: num(spec, 'populationSize', 24),
      budget: {
        ...(generations ? { generations } : {}),
        ...(spec.evaluations !== undefined ? { evaluations: num(spec, 'evaluations', 0) } : {}),
        ...(spec.milliseconds !== undefined ? { milliseconds: num(spec, 'milliseconds', 0) } : {}),
      },
      detailTop: this.detailBudget,
    };
    if (checkpoint && typeof checkpoint === 'object' && 'version' in (checkpoint as Record<string, unknown>)) {
      this.optimizer = Optimizer.restore(checkpoint as OptimizerSnapshot, request);
    } else {
      this.optimizer = new Optimizer(request);
    }
    this.name = `optimize ${this.designSpec.name}`;
  }

  totalWork(): number | null {
    return this.generations;
  }

  step(): boolean {
    if (this.done) return true;
    if (!this.detailing && this.generations !== null && this.optimizer.engine.generation >= this.generations) {
      this.detailing = true;
    }
    if (!this.detailing) {
      this.optimizer.step();
      const p = this.optimizer.progress();
      if (p.phase === 'done' || p.phase === 'cancelled') this.detailing = true;
      if (this.generations !== null && this.optimizer.engine.generation >= this.generations) this.detailing = true;
      const budget = this.optimizer.request.budget ?? {};
      if (budget.evaluations !== undefined && p.evaluated >= budget.evaluations) this.detailing = true;
      if (budget.milliseconds !== undefined && p.elapsedMs >= budget.milliseconds) this.detailing = true;
      return false;
    }
    if (this.detailBudget > 0 && !this.detailing) return false;
    // Detailed pass: one candidate per step, so a large detail pass stays pausable.
    if (this.detailBudget > 0) {
      this.optimizer.detailTop(this.detailBudget);
      this.detailBudget = 0;
    }
    this.report = this.optimizer.report();
    if (this.saveAsChip) {
      const chip = this.optimizer.saveBestAsChip(this.ctx.project, { id: this.chipId ?? undefined, overwrite: true });
      this.savedChipId = chip?.id ?? null;
    }
    this.done = true;
    return true;
  }

  progress(): JobProgress {
    const p = this.optimizer.progress();
    const base = emptyProgress();
    const best = this.optimizer.rank().ranked[0];
    return {
      ...base,
      tested: p.evaluated,
      rejected: p.rejected,
      remaining: p.remaining,
      fraction: this.generations ? Math.min(1, p.generation / this.generations) : null,
      best: best ? { label: 'weighted score (lower is better)', value: best.score, unit: '' } : null,
      cpuMs: p.cpuMs,
      etaMs: p.estimatedRemainingMs,
      ratePerSecond: p.evaluationsPerSecond,
      activity:
        p.phase === 'detailing'
          ? 'detailed pass (levels 1–3 on the leaders)'
          : `generation ${p.generation} · population ${p.populationSize} · Pareto ${p.paretoSize} · archive ${p.archiveSize}${p.cached > 0 ? ` · ${p.cached} cache hit(s)` : ''}`,
    };
  }

  result(): unknown {
    const report = this.report ?? this.optimizer.report();
    const why = this.optimizer.why();
    return {
      report,
      whyText: why ? whyToText(why) : null,
      savedChipId: this.savedChipId,
      circuit: this.savedChipId ? null : undefined,
    };
  }

  summary(): string {
    const report = this.report ?? this.optimizer.report();
    const best = report.best;
    if (!best) return `${report.claim}: no candidate satisfied the contract`;
    return (
      `${report.claim}: ${best.objectives.components} component(s), ${(best.objectives.delay * 1e9).toFixed(3)} ns, ` +
      `${report.searchSpace.evaluations} evaluation(s), profile ${report.ranking.profile}` +
      (this.savedChipId ? `, saved as chip "${this.savedChipId}"` : '')
    );
  }

  checkpoint(): unknown {
    return this.optimizer.snapshot();
  }

  dispose(): void {
    this.optimizer.cancel();
  }

  /** The spec's design, for the UI ("what is being optimised"). */
  describe(): string {
    return describeSpec(this.designSpec);
  }

  /** Known specification ids, so a caller can build a valid spec. */
  static knownSpecs(): string[] {
    return specIds();
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface ValidateJobSpec extends Record<string, unknown> {
  circuit?: CircuitDocument;
  chipId?: string;
  sheetId?: string;
  chipParams?: Record<string, unknown>;
  specId?: string;
  params?: Record<string, number>;
  seed?: number | string;
  levels?: Record<string, boolean>;
  randomVectors?: number;
  repeats?: number;
  ambient?: number;
  vdd?: number;
  maxTemperature?: number;
  clockPeriod?: number | null;
  expandGates?: boolean;
  transientStop?: number;
  exhaustiveBitLimit?: number;
}

export class ValidateTask implements Task {
  readonly kind: JobKind = 'validate';
  readonly name: string;
  private session: ValidationSession;
  private source: string;
  private report: ValidationReport | null = null;

  constructor(spec: ValidateJobSpec, _checkpoint: unknown, ctx: JobContext) {
    const { circuit, source } = circuitFromSpec(spec, ctx);
    this.source = source;
    let designSpec: DesignSpec | undefined;
    if (typeof spec.specId === 'string' && spec.specId.length > 0) {
      designSpec = buildSpecById(spec.specId, obj(spec, 'params') as Record<string, number>);
    }
    const levelsRaw = obj(spec, 'levels');
    const levels: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(levelsRaw)) if (typeof v === 'boolean') levels[k] = v;
    this.session = new ValidationSession(
      { circuit, name: circuit.name, kind: typeof spec.chipId === 'string' ? 'chip' : 'circuit', chipId: typeof spec.chipId === 'string' ? spec.chipId : undefined },
      {
        lib: ctx.lib,
        chips: ctx.chips,
        spec: designSpec,
        seed: spec.seed ?? `${circuit.name}:job`,
        levels: levels as never,
        randomVectors: spec.randomVectors !== undefined ? num(spec, 'randomVectors', 64) : undefined,
        repeats: spec.repeats !== undefined ? num(spec, 'repeats', 3) : undefined,
        ambient: spec.ambient !== undefined ? num(spec, 'ambient', 25) : undefined,
        vdd: spec.vdd !== undefined ? num(spec, 'vdd', 3.3) : undefined,
        maxTemperature: spec.maxTemperature !== undefined ? num(spec, 'maxTemperature', 125) : undefined,
        clockPeriod: spec.clockPeriod === null ? null : spec.clockPeriod !== undefined ? num(spec, 'clockPeriod', 0) || null : undefined,
        expandGates: spec.expandGates !== undefined ? bool(spec, 'expandGates', true) : undefined,
        transientStop: spec.transientStop !== undefined ? num(spec, 'transientStop', 0) : undefined,
        exhaustiveBitLimit: spec.exhaustiveBitLimit !== undefined ? num(spec, 'exhaustiveBitLimit', 12) : undefined,
      },
    );
    this.name = `validate ${circuit.name}`;
  }

  totalWork(): number | null {
    return this.session.totalChecks;
  }

  step(): boolean {
    if (this.session.done) {
      this.report = this.session.report();
      return true;
    }
    const finished = this.session.step();
    if (finished) this.report = this.session.report();
    return finished;
  }

  progress(): JobProgress {
    const base = emptyProgress();
    const done = this.session.ranChecks;
    const total = this.session.totalChecks;
    const failed = this.session.checks.reduce((n, c) => n + c.failed, 0);
    const passed = this.session.checks.reduce((n, c) => n + c.passed, 0);
    return {
      ...base,
      tested: passed,
      rejected: failed,
      remaining: Math.max(0, total - done),
      fraction: total > 0 ? done / total : null,
      best: null,
      activity: this.session.nextCheck ? `running "${this.session.nextCheck}" (${done}/${total} check(s) done)` : 'complete',
    };
  }

  result(): unknown {
    const report = this.report ?? this.session.report();
    return { report, text: validationToText(report, { verbose: true }) };
  }

  summary(): string {
    const report = this.report ?? this.session.report();
    return `${report.claim}: ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped over ${report.totals.ran} check(s) — ${this.source}`;
  }

  checkpoint(): unknown {
    // A validation checkpoint records the checks already done; the session is
    // rebuilt and the remaining checks re-run, which is cheap and always correct.
    return { completed: this.session.checks.map((c) => c.id), ranChecks: this.session.ranChecks, totalChecks: this.session.totalChecks };
  }
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

export interface SimulateJobSpec extends Record<string, unknown> {
  circuit?: CircuitDocument;
  chipId?: string;
  sheetId?: string;
  chipParams?: Record<string, unknown>;
  /** 'dc' | 'transient' | 'sweep' | 'thermal'. */
  mode?: string;
  /** Sweep source: which parameter of which component to vary. */
  sweep?: { ref?: string; param?: string; from?: number; to?: number; steps?: number };
  tstop?: number;
  maxSamples?: number;
  ambient?: number;
  expandGates?: boolean;
  /** Node names to record in a transient. Empty = every output port. */
  probes?: string[];
}

export class SimulateTask implements Task {
  readonly kind: JobKind = 'simulate';
  readonly name: string;
  private ctx: JobContext;
  private spec: SimulateJobSpec;
  private circuit: Circuit;
  private source: string;
  private mode: 'dc' | 'transient' | 'sweep' | 'thermal';
  private points: Array<Record<string, unknown>> = [];
  private index = 0;
  private total: number;
  private done = false;
  private error: string | null = null;
  private waveforms: Array<{ name: string; times: number[]; values: number[] }> = [];

  constructor(spec: SimulateJobSpec, checkpoint: unknown, ctx: JobContext) {
    this.ctx = ctx;
    this.spec = spec;
    const loaded = circuitFromSpec(spec, ctx);
    this.circuit = loaded.circuit;
    this.source = loaded.source;
    const mode = str(spec, 'mode', 'dc');
    this.mode = mode === 'transient' || mode === 'sweep' || mode === 'thermal' ? mode : 'dc';
    const sweep = obj(spec, 'sweep');
    this.total = this.mode === 'sweep' ? Math.max(1, Math.round(num(sweep, 'steps', 11))) : 1;
    if (checkpoint && typeof checkpoint === 'object') {
      const cp = checkpoint as { index?: number; points?: Array<Record<string, unknown>> };
      if (Array.isArray(cp.points)) this.points = cp.points;
      this.index = Math.min(this.total, Math.max(0, cp.index ?? this.points.length));
    }
    this.name = `${this.mode} ${this.circuit.name}`;
  }

  totalWork(): number | null {
    return this.total;
  }

  step(): boolean {
    if (this.done) return true;
    const ambient = num(this.spec, 'ambient', 25);
    const expand = bool(this.spec, 'expandGates', true);
    try {
      if (this.mode === 'sweep') {
        const sweep = obj(this.spec, 'sweep');
        const ref = str(sweep, 'ref', '');
        const param = str(sweep, 'param', '');
        const from = num(sweep, 'from', 0);
        const to = num(sweep, 'to', 1);
        const steps = Math.max(1, Math.round(num(sweep, 'steps', 11)));
        if (!ref || !param) throw new Error('a sweep needs `sweep.ref` and `sweep.param`');
        const value = from + ((to - from) * this.index) / steps;
        const circuit = this.circuit.clone();
        const target = circuit.allComponents().find((c) => c.ref === ref);
        if (!target) throw new Error(`no component with reference designator "${ref}"`);
        circuit.setParam(target.id, param, value);
        const nl = flattenOf(circuit, this.ctx, ambient, expand);
        const sim = new CircuitSimulator(nl, { ambient });
        const conv = sim.dcSolve({ quiet: true });
        const powers = sim.powers();
        let dissipated = 0;
        for (let e = 0; e < powers.length; e++) if (powers[e] > 0) dissipated += powers[e];
        this.points.push({
          index: this.index,
          value,
          converged: conv.converged,
          iterations: conv.iterations,
          worstVoltageError: conv.worstVoltageError,
          dissipatedW: dissipated,
          maxTemperatureC: conv.thermal ? conv.thermal.maxTemperature : null,
          nodes: nl.nodeCount,
        });
        this.index++;
        if (this.index > steps) this.done = true;
        return this.done;
      }

      const nl = flattenOf(this.circuit, this.ctx, ambient, expand);
      const sim = new CircuitSimulator(nl, { ambient });
      if (this.mode === 'dc') {
        const conv = sim.dcSolve({ quiet: true });
        const powers = sim.powers();
        const nodes: Array<{ node: string; volts: number }> = [];
        for (let n = 1; n < nl.nodeCount; n++) nodes.push({ node: nodeNameAt(nl, n), volts: sim.v[n] });
        let dissipated = 0;
        let supplied = 0;
        for (let e = 0; e < powers.length; e++) {
          if (powers[e] > 0) dissipated += powers[e];
          else supplied += -powers[e];
        }
        this.points.push({
          converged: conv.converged,
          iterations: conv.iterations,
          worstVoltageError: conv.worstVoltageError,
          gminUsed: conv.gminUsed,
          usedGminStepping: conv.usedGminStepping,
          usedSourceStepping: conv.usedSourceStepping,
          singular: conv.singular,
          dissipatedW: dissipated,
          suppliedW: supplied,
          nodes,
          stats: netlistStats(nl),
        });
        this.done = true;
        return true;
      }
      if (this.mode === 'thermal') {
        const conv = sim.dcSolve({ quiet: true });
        sim.resetThermalToAmbient();
        const th = sim.solveThermalSteadyState();
        const hottest: Array<{ element: number; node: string; celsius: number }> = [];
        for (let e = 0; e < Math.min(nl.elementCount, 4096); e++) {
          hottest.push({ element: e, node: nodeNameAt(nl, nl.nodes[e * 3] ?? 0), celsius: sim.elementTemperature(e) });
        }
        hottest.sort((a, b) => b.celsius - a.celsius);
        this.points.push({ dcConverged: conv.converged, thermalIterations: th.iterations, converged: th.converged, maxTemperatureC: th.maxTemperature, ambientC: ambient, hottest: hottest.slice(0, 16) });
        this.done = true;
        return true;
      }
      // transient
      const tstop = num(this.spec, 'tstop', 1e-6);
      const probes = Array.isArray(this.spec.probes) ? (this.spec.probes as string[]) : [];
      const requests = probes.length
        ? probes.map((p) => {
            const port = nl.ports.find((x) => x.name === p);
            return { key: p, kind: 'vnode' as const, index: port ? port.node : 0 };
          })
        : nl.ports.filter((p) => p.direction === 'output').slice(0, 16).map((p) => ({ key: p.name, kind: 'vnode' as const, index: p.node }));
      const tr = sim.transient(tstop, requests, { maxSamples: num(this.spec, 'maxSamples', 1024) });
      this.waveforms = requests.map((r, i) => ({
        name: r.key,
        times: Array.from(tr.times),
        values: Array.from(tr.values[i] ?? new Float64Array(0)),
      }));
      this.points.push({
        ok: tr.ok,
        sampleCount: tr.sampleCount,
        steps: tr.steps,
        rejected: tr.rejected,
        wallMs: tr.wallMs,
        tstop,
        probes: requests.map((r) => r.key),
        elementEnergyTotal: Array.from(tr.elementEnergy).reduce((a, b) => a + b, 0),
      });
      this.done = true;
      return true;
    } catch (err) {
      this.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.done = true;
      return true;
    }
  }

  progress(): JobProgress {
    const base = emptyProgress();
    return {
      ...base,
      tested: this.mode === 'sweep' ? this.points.length : this.done ? 1 : 0,
      rejected: this.error ? 1 : 0,
      remaining: Math.max(0, this.total - (this.mode === 'sweep' ? this.points.length : this.done ? 1 : 0)),
      fraction: this.total > 0 ? Math.min(1, (this.mode === 'sweep' ? this.points.length : this.done ? 1 : 0) / this.total) : null,
      activity: this.error ? `failed: ${this.error}` : this.mode === 'sweep' ? `sweep point ${this.points.length}/${this.total}` : `${this.mode} solve on ${this.source}`,
    };
  }

  result(): unknown {
    return { mode: this.mode, source: this.source, points: this.points, waveforms: this.waveforms, error: this.error };
  }

  summary(): string {
    if (this.error) return `${this.mode} failed: ${this.error}`;
    if (this.mode === 'sweep') return `sweep of ${this.points.length} point(s) on ${this.source}`;
    const p = this.points[0] as Record<string, unknown> | undefined;
    if (!p) return `${this.mode} produced no result`;
    if (this.mode === 'dc') return `DC: ${p.converged ? 'converged' : 'did NOT converge'} in ${p.iterations} iteration(s), dissipated ${Number(p.dissipatedW).toExponential(3)} W`;
    if (this.mode === 'thermal') return `thermal steady state: ${p.converged ? 'converged' : 'did NOT converge'}, hottest ${Number(p.maxTemperatureC).toFixed(2)} °C`;
    return `transient: ${p.sampleCount} sample(s) over ${Number(p.tstop).toExponential(3)} s, ${p.ok ? 'ok' : 'NOT ok'}`;
  }

  checkpoint(): unknown {
    return { index: this.index, points: this.points.slice(-32) };
  }
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

export interface AnalyzeJobSpec extends Record<string, unknown> {
  circuit?: CircuitDocument;
  chipId?: string;
  sheetId?: string;
  chipParams?: Record<string, unknown>;
  ambient?: number;
  expandGates?: boolean;
  constraints?: Record<string, unknown>;
  verbose?: boolean;
}

export class AnalyzeTask implements Task {
  readonly kind: JobKind = 'analyze';
  readonly name: string;
  private ctx: JobContext;
  private spec: AnalyzeJobSpec;
  private circuit: Circuit;
  private source: string;
  private phase = 0;
  private report: AnalyzeReport | null = null;
  private stats: ReturnType<typeof circuitStats> | null = null;
  private text: string | null = null;

  constructor(spec: AnalyzeJobSpec, _checkpoint: unknown, ctx: JobContext) {
    this.ctx = ctx;
    this.spec = spec;
    const loaded = circuitFromSpec(spec, ctx);
    this.circuit = loaded.circuit;
    this.source = loaded.source;
    this.name = `analyze ${this.circuit.name}`;
  }

  totalWork(): number | null {
    return 3;
  }

  step(): boolean {
    const ambient = num(this.spec, 'ambient', 25);
    const expand = bool(this.spec, 'expandGates', true);
    if (this.phase === 0) {
      const nl = flattenOf(this.circuit, this.ctx, ambient, expand);
      this.stats = circuitStats(nl, { lib: this.ctx.lib });
      this.phase = 1;
      return false;
    }
    if (this.phase === 1) {
      this.report = analyzeCircuit(this.circuit, this.ctx.lib, this.ctx.chips, {
        flatten: { ambient, expandGates: expand },
        constraints: obj(this.spec, 'constraints') as never,
      });
      this.phase = 2;
      return false;
    }
    if (this.report) this.text = analysisToText(this.report, { verbose: bool(this.spec, 'verbose', false) });
    this.phase = 3;
    return true;
  }

  progress(): JobProgress {
    const base = emptyProgress();
    const names = ['statistics', 'analyzer', 'report'];
    return {
      ...base,
      tested: Math.min(this.phase, 3),
      remaining: Math.max(0, 3 - this.phase),
      fraction: this.phase / 3,
      rejected: this.report ? this.report.findings.filter((f) => f.severity === Severity.Error).length : 0,
      activity: this.phase >= 3 ? 'complete' : `running ${names[this.phase] ?? 'analysis'} on ${this.source}`,
    };
  }

  result(): unknown {
    return { report: this.report, stats: this.stats?.stats ?? null, text: this.text, source: this.source };
  }

  summary(): string {
    if (!this.report) return 'analysis did not finish';
    const n = this.report.findings.length;
    const errs = this.report.findings.filter((f) => f.severity === Severity.Error).length;
    return `${n} finding(s) (${errs} error-severity) on ${this.source}`;
  }

  checkpoint(): unknown {
    return { phase: this.phase };
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ExportJobSpec extends Record<string, unknown> {
  circuit?: CircuitDocument;
  chipId?: string;
  sheetId?: string;
  chipParams?: Record<string, unknown>;
  /** Which artefacts to produce. */
  artefacts?: string[];
  level?: ExportLevel;
  ambient?: number;
  expandGates?: boolean;
}

export class ExportTask implements Task {
  readonly kind: JobKind = 'export';
  readonly name: string;
  private ctx: JobContext;
  private spec: ExportJobSpec;
  private circuit: Circuit;
  private source: string;
  private artefacts: string[];
  private index = 0;
  private produced: Record<string, string> = {};
  private error: string | null = null;

  constructor(spec: ExportJobSpec, checkpoint: unknown, ctx: JobContext) {
    this.ctx = ctx;
    this.spec = spec;
    const loaded = circuitFromSpec(spec, ctx);
    this.circuit = loaded.circuit;
    this.source = loaded.source;
    this.artefacts = Array.isArray(spec.artefacts) && spec.artefacts.length > 0 ? (spec.artefacts as string[]) : ['schematic', 'bom', 'spice'];
    if (checkpoint && typeof checkpoint === 'object') {
      const cp = checkpoint as { index?: number; produced?: Record<string, string> };
      this.index = cp.index ?? 0;
      this.produced = cp.produced ?? {};
    }
    this.name = `export ${this.circuit.name}`;
  }

  totalWork(): number | null {
    return this.artefacts.length;
  }

  step(): boolean {
    if (this.index >= this.artefacts.length) return true;
    const which = this.artefacts[this.index];
    const level = (str(this.spec, 'level', 'hierarchical') as ExportLevel);
    try {
      if (which === 'schematic') {
        const sheet = level === 'hierarchical' ? exportSchematicHierarchical(this.circuit, this.ctx.lib) : null;
        if (sheet) this.produced.schematic = schematicToJson(sheet);
        else {
          const nl = flattenOf(this.circuit, this.ctx, num(this.spec, 'ambient', 25), bool(this.spec, 'expandGates', false));
          this.produced.schematic = schematicToJson(level === 'electrical' ? exportSchematicElectrical(nl) : exportSchematicFlattened(nl));
        }
      } else if (which === 'bom') {
        const bom = buildBomFromCircuit(this.circuit, this.ctx.lib);
        this.produced.bomCsv = bomToCsv(bom, 'aggregated');
        this.produced.bomDetailedCsv = bomToCsv(bom, 'detailed');
        this.produced.bomText = bomToText(bom);
      } else if (which === 'spice') {
        const nl = flattenOf(this.circuit, this.ctx, num(this.spec, 'ambient', 25), bool(this.spec, 'expandGates', true));
        this.produced.spice = exportSpiceNetlist(nl);
      } else if (which === 'circuit') {
        this.produced.circuit = JSON.stringify(circuitToDocument(this.circuit), null, 2);
      } else {
        this.produced[which] = `unknown artefact "${which}"`;
      }
    } catch (err) {
      this.error = `${which}: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.index++;
    return this.index >= this.artefacts.length;
  }

  progress(): JobProgress {
    const base = emptyProgress();
    return {
      ...base,
      tested: this.index,
      remaining: Math.max(0, this.artefacts.length - this.index),
      fraction: this.index / this.artefacts.length,
      rejected: this.error ? 1 : 0,
      activity: this.index >= this.artefacts.length ? 'complete' : `writing ${this.artefacts[this.index]}`,
    };
  }

  result(): unknown {
    return { source: this.source, artefacts: this.artefacts, produced: this.produced, error: this.error };
  }

  summary(): string {
    const keys = Object.keys(this.produced);
    return `${keys.length} artefact(s) exported from ${this.source}${this.error ? ` — error: ${this.error}` : ''}`;
  }

  checkpoint(): unknown {
    return { index: this.index, produced: Object.fromEntries(Object.entries(this.produced).map(([k, v]) => [k, v.length > 4096 ? `${v.slice(0, 4096)}…(truncated in checkpoint)` : v])) };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register every built-in task kind on a queue. */
export function registerDefaultTasks(queue: JobQueue, ctx: JobContext): JobQueue {
  queue.register('optimize', (spec, cp) => new OptimizeTask(spec as OptimizeJobSpec, cp, ctx));
  queue.register('validate', (spec, cp) => new ValidateTask(spec as ValidateJobSpec, cp, ctx));
  queue.register('simulate', (spec, cp) => new SimulateTask(spec as SimulateJobSpec, cp, ctx));
  queue.register('analyze', (spec, cp) => new AnalyzeTask(spec as AnalyzeJobSpec, cp, ctx));
  queue.register('export', (spec, cp) => new ExportTask(spec as ExportJobSpec, cp, ctx));
  return queue;
}

/** Validate a circuit synchronously — the "validate before saving a chip" path. */
export function validateBeforeSave(circuit: Circuit, ctx: JobContext, spec?: DesignSpec): ValidationReport {
  return validateCircuit({ circuit, name: circuit.name, kind: 'circuit' }, { lib: ctx.lib, chips: ctx.chips, spec });
}

export { whyToText, validationToText, analysisToText };
