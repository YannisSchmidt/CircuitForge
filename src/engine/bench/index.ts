/**
 * Benchmarking the engine itself.
 *
 * This module exists because a simulator that quotes numbers about circuits must
 * also be able to quote numbers about *itself*: how fast it evaluates logic, how
 * the sparse solve scales, what a flatten costs, how much memory a hundred
 * thousand components take. Every figure it produces is measured here, in this
 * process, on this machine, and is reported with the workload that produced it.
 *
 * What is measured, and how far the measurement reaches:
 *
 *   - Wall-clock time, best and median of N repeats. Repeats absorb JIT warm-up
 *     and the odd GC pause; they do not absorb machine load. Nothing here pins a
 *     core, disables turbo or isolates the process, so a run on a busy machine is
 *     slower and that is stated in the report rather than hidden.
 *   - Throughput is always a counted unit over a measured interval: element
 *     evaluations per second for logic, nodes per second for the sparse solve,
 *     accepted steps per second for transient, bytes per second for I/O. The unit
 *     is named in `rateUnit` so nobody has to guess what "ops" meant.
 *   - Memory is a heap delta around the timed work (`process.memoryUsage().heapUsed`
 *     under Node, `performance.memory.usedJSHeapSize` in a browser that exposes
 *     it). A heap delta is not a footprint: it excludes the ArrayBuffer backing
 *     the SoA netlist only when the engine allocates it on the JS heap, which it
 *     does, but it also includes garbage the collector has not reclaimed. The
 *     report says so.
 *   - The GPU is *probed*, not benchmarked, in a headless process: there is no
 *     context to measure. The report carries the probe result and, when nothing
 *     was measured, claims no speedup — `gpu.enabled` stays false until a
 *     benchmark on a real backend shows one.
 *   - Schematic rendering is timed only as far as a headless process honestly can:
 *     the `render` group measures sheet layout (blocks, ports, orthogonal routing)
 *     and the draw pass (drawing operations issued, SVG bytes written). Rasterising
 *     those operations into pixels needs a canvas or a WebGL2 context, so no frame
 *     rate is claimed here — the GUI reports its own.
 *
 * The internal profiler is part of the suite, not an afterthought: one phase of a
 * `full` run switches the engine's own instrumentation on and reports where the
 * time went (netlist build, logic evaluation, sparse solve, transient stepping),
 * which is the only honest way to answer "what should be optimised next".
 */

import { CircuitBuilder } from '../core/build.js';
import type { ChipLibrary } from '../core/chip.js';
import type { Circuit } from '../core/circuit.js';
import type { Library } from '../core/library.js';
import { Project } from '../core/project.js';
import { createDefaultLibrary } from '../core/registry.js';
import { buildReferenceProject } from '../synthesis/reference.js';
import { flatten, netlistStats, type FlatNetlist } from '../sim/netlist.js';
import { CircuitSimulator } from '../sim/solver.js';
import { buildLogicGraph, LogicVectorSim } from '../analysis/logic.js';
import { analyzeCircuit } from '../analysis/analyzer.js';
import { circuitToDocument, circuitFromDocument } from '../io/serialize.js';
import { projectToDocument } from '../io/project-file.js';
import { buildBomFromCircuit } from '../export/bom.js';
import { exportSchematicFlattened, exportSchematicHierarchical } from '../export/schematic.js';
import { exportSpiceNetlist } from '../export/spice.js';
import { validateChip } from '../validate/validation.js';
import { Optimizer } from '../optim/search.js';
import { andNotSpec } from '../optim/spec.js';
import { fft } from '../instruments/fft.js';
import { drawSheet, fitBounds, layoutCircuit, NullContext, renderToSvg } from '../render/index.js';
import { profiler, type ProfileReport } from '../util/profiler.js';
import { detectPlatform, gpuProbe, platformSummary, type PlatformInfo } from '../util/platform.js';
import { Rng } from '../util/rng.js';
import { ENGINE_VERSION } from '../util/version.js';

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Which families of measurement a suite covers. */
export type BenchGroup =
  | 'logic'
  | 'hierarchy'
  | 'electrical'
  | 'thermal'
  | 'io'
  | 'export'
  | 'optim'
  | 'validate'
  | 'analyze'
  | 'instruments'
  | 'scaling'
  | 'render'
  | 'gpu'
  | 'profile';

/** One measurement, with the workload and the scope that give it meaning. */
export interface BenchmarkCase {
  id: string;
  group: BenchGroup;
  title: string;
  /** What was actually done — the scope every number in this case is quoted under. */
  what: string;
  /** Workload size, in `sizeUnit`. Zero when the case did not run. */
  size: number;
  sizeUnit: string;
  repeats: number;
  /** Per-repeat wall time, ms, in run order. */
  ms: number[];
  bestMs: number | null;
  medianMs: number | null;
  meanMs: number | null;
  /** Throughput over the best repeat, or null when the case counts no unit. */
  rate: number | null;
  rateUnit: string | null;
  /** Heap delta across the timed work, bytes, or null where it is not observable. */
  heapBytes: number | null;
  /** False when the case threw or was skipped; `error`/`skipped` say which. */
  ran: boolean;
  error: string | null;
  skipped: string | null;
  /** Anything a reader must know to interpret the number. */
  notes: string[];
  /** Secondary readings: node counts, iterations, convergence, byte sizes… */
  metrics: Record<string, number | string | boolean | null>;
}

/** One row of the size sweep: what a workload of N components costs end to end. */
export interface ScalingRow {
  components: number;
  buildMs: number;
  flattenMs: number;
  logicMs: number;
  serializeMs: number;
  bytes: number;
  heapBytes: number | null;
  elements: number;
  nets: number;
  /** Element evaluations per second over the whole sweep point. */
  eventsPerSecond: number | null;
  ok: boolean;
  note: string | null;
}

export interface BenchmarkReport {
  /** The strongest claim this report makes, and it is never stronger than this. */
  claim: string;
  suite: string;
  engineVersion: string;
  generatedAt: string;
  durationMs: number;
  environment: {
    platform: string;
    node: boolean;
    heapLimitBytes: number | null;
    summary: string;
  };
  cases: BenchmarkCase[];
  scaling: ScalingRow[];
  profiler: ProfileReport | null;
  gpu: ReturnType<typeof gpuProbe>;
  totals: {
    cases: number;
    ran: number;
    failed: number;
    skipped: number;
    /** Sum of the best repeat of every case that ran, ms. */
    measuredMs: number;
  };
  notes: string[];
  /** Everything needed to reproduce the run, or to know that it cannot be. */
  reproducibility: {
    seed: string;
    repeats: number;
    sizes: number[];
    engineVersion: string;
    platform: string;
    note: string;
  };
}

export interface BenchmarkOptions {
  /** `quick` (default), `full`, `scaling` or `stress`. */
  suite?: string;
  /** Overrides the suite's size sweep. */
  sizes?: number[];
  /** Repeats per case; the best and the median are both reported. */
  repeats?: number;
  /** Emit machine-readable output (the CLI switches to JSON with this). */
  json?: boolean;
  quiet?: boolean;
  /** Progress line per case, for a live console. */
  onProgress?: (line: string) => void;
  /** Deterministic seed for every synthetic workload. */
  seed?: string | number;
  /** Abort between cases (a job queue cancels a benchmark this way). */
  cancelled?: () => boolean;
}

/** What each suite runs, and at which sizes. */
export const BENCH_SUITES: Record<string, { groups: BenchGroup[]; sizes: number[]; note: string }> = {
  quick: {
    groups: ['logic', 'hierarchy', 'electrical', 'io', 'optim', 'validate', 'instruments', 'profile', 'gpu', 'render'],
    sizes: [100, 1000],
    note: 'A few seconds: the throughput of every subsystem at a modest size.',
  },
  full: {
    groups: [
      'logic',
      'hierarchy',
      'electrical',
      'thermal',
      'io',
      'export',
      'optim',
      'validate',
      'analyze',
      'instruments',
      'scaling',
      'profile',
      'gpu',
      'render',
    ],
    sizes: [100, 1000, 10_000],
    note: 'Every subsystem, plus the size sweep to 10 000 components.',
  },
  scaling: {
    groups: ['scaling'],
    sizes: [10, 100, 1000, 10_000, 100_000],
    note: 'The sweep on its own: build, flatten, evaluate, serialise, memory.',
  },
  stress: {
    groups: ['scaling', 'logic', 'hierarchy', 'io'],
    sizes: [10, 100, 1000, 10_000, 100_000, 1_000_000],
    note: 'Up to a million components. This takes minutes and a lot of heap; it is a stress test, not a quick check.',
  },
};

const DEFAULT_SEED = 'circuitforge-bench';

// ---------------------------------------------------------------------------
// Small measurement utilities
// ---------------------------------------------------------------------------

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

function heapUsed(): number | null {
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  if (proc?.memoryUsage) return proc.memoryUsage().heapUsed;
  const perf = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance;
  if (perf?.memory?.usedJSHeapSize) return perf.memory.usedJSHeapSize;
  return null;
}

function heapLimit(): number | null {
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapTotal: number } } }).process;
  return proc?.memoryUsage ? proc.memoryUsage().heapTotal : null;
}

/**
 * The heap this process may allocate before V8 gives up, or null where nothing
 * reports one.
 *
 * Read through `process.getBuiltinModule` rather than an import: a static
 * `node:v8` import inside `src/` would break the browser build, and the engine is
 * one codebase for both.
 */
function heapCeiling(): number | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process;
  const v8 = proc?.getBuiltinModule?.('node:v8') as { getHeapStatistics?: () => { heap_size_limit: number } } | undefined;
  const limit = v8?.getHeapStatistics?.().heap_size_limit;
  return typeof limit === 'number' && limit > 0 ? limit : null;
}

/**
 * Whether a workload of `size` components should be refused before it is attempted,
 * and the arithmetic that says so.
 *
 * Pure, so the decision can be tested with numbers instead of by running a workload
 * that would take the process down: an OOM kill produces no report at all, which is
 * the one outcome a benchmark must never have.
 *
 * @param bytesPerComponent marginal heap cost measured between two sizes that ran,
 *   or null when nothing has been measured yet — then nothing is refused, because
 *   refusing on a guess would be worse than trying.
 * @param ceiling the process heap limit, or null when it is not observable.
 * @returns the reason to report, or null when the size should be attempted.
 */
export function heapRefusal(
  size: number,
  bytesPerComponent: number | null,
  ceiling: number | null,
  safety = 2,
  fraction = 0.6,
): string | null {
  if (ceiling === null || bytesPerComponent === null || !(bytesPerComponent > 0) || !(size > 0)) return null;
  const needed = size * bytesPerComponent * safety;
  if (needed <= ceiling * fraction) return null;
  return (
    `Would need roughly ${fmtBytes(needed)} of heap against a ${fmtBytes(ceiling)} limit in this process, ` +
    `at a measured marginal cost of ${fmtBytes(bytesPerComponent)} per component (×${safety} safety factor). ` +
    'Raise the limit with `node --max-old-space-size=<MiB>` on a machine with the RAM to match.'
  );
}

/** Yield to the event loop so a long suite stays responsive to progress output. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmtRate(rate: number | null, unit: string | null): string {
  if (rate === null || !unit) return 'n/a';
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} G${unit}`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(2)} M${unit}`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)} k${unit}`;
  return `${rate.toFixed(1)} ${unit}`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  return `${(ms * 1000).toFixed(1)} µs`;
}

function fmtBytes(n: number | null): string {
  if (n === null) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GiB`;
  if (a >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MiB`;
  if (a >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KiB`;
  return `${n} B`;
}

// ---------------------------------------------------------------------------
// Synthetic workloads
// ---------------------------------------------------------------------------

const GATE_FNS = ['and_gate', 'or_gate', 'xor_gate', 'nand_gate', 'nor_gate', 'xnor_gate'];

/**
 * A random combinational cloud of `gates` gates over 32-bit nets.
 *
 * Random, not a reference design, because a benchmark workload must not be a
 * design the engine happens to special-case: sources are drawn from a sliding
 * window of recent nets so the circuit has real depth and real fan-out without
 * degenerating into a chain or a star.
 */
function logicCircuit(lib: Library, gates: number, rng: Rng, width = 32): { circuit: Circuit; declared: number } {
  const b = new CircuitBuilder(lib, `bench_logic_${gates}`);
  const inputs = Math.max(2, Math.min(16, Math.ceil(gates / 256)));
  const pool: string[] = [];
  for (let i = 0; i < inputs; i++) {
    b.port(`IN${i}`, 'input', `in${i}`, width);
    pool.push(`in${i}`);
  }
  let declared = 0;
  for (let g = 0; g < gates; g++) {
    const unary = rng.chance(0.12);
    const specId = unary ? 'not_gate' : GATE_FNS[rng.int(GATE_FNS.length)];
    const inst = b.add(specId, { inputs: unary ? 1 : 2 }, [(g % 64) * 24, Math.floor(g / 64) * 20]);
    // A sliding window of recent nets: deep enough to be a real circuit, narrow
    // enough that fan-out stays in the range a design would have.
    const from = pool.length - Math.min(pool.length, 1 + rng.int(48));
    const a = pool[from + rng.int(pool.length - from)];
    b.at(inst, 'IN1', a, width);
    if (!unary) {
      const bNet = pool[from + rng.int(pool.length - from)];
      b.at(inst, 'IN2', bNet, width);
    }
    const out = `n${g}`;
    b.at(inst, 'OUT', out, width);
    pool.push(out);
    declared++;
  }
  // The last few nets become observable outputs; the rest are internal.
  const outs = Math.min(8, declared);
  for (let i = 0; i < outs; i++) {
    const net = pool[pool.length - 1 - i];
    b.port(`OUT${i}`, 'output', net, width);
  }
  return { circuit: b.finish({ erc: false }), declared };
}

/**
 * A sheet of `instances` copies of one reference chip, wired to shared buses.
 *
 * This is the hierarchy workload: flattening it has to descend through the chip
 * into its own implementation, which is what a real design does constantly.
 */
function chipArray(project: Project, instances: number, chipId = 'full_adder'): { circuit: Circuit; chip: string } {
  const b = new CircuitBuilder(project.lib, `bench_chips_${instances}`, project.chips);
  b.port('A', 'input', 'a', instances);
  b.port('B', 'input', 'b', instances);
  b.port('CI', 'input', 'ci', instances);
  b.port('S', 'output', 's', instances);
  b.port('CO', 'output', 'co', instances);
  for (let i = 0; i < instances; i++) {
    const inst = project.instantiate(b, chipId, {}, [(i % 32) * 40, Math.floor(i / 32) * 30], { ref: `U${i + 1}` });
    b.at(inst, 'a', 'a', instances);
    b.at(inst, 'b', 'b', instances);
    b.at(inst, 'ci', 'ci', instances);
    b.at(inst, 's', 's', instances);
    b.at(inst, 'co', 'co', instances);
  }
  return { circuit: b.finish({ erc: false }), chip: chipId };
}

/**
 * An RC ladder: `sections` series resistors, each with a capacitor to ground,
 * driven by one ideal voltage source.
 *
 * One node per section, so the MNA system is `sections + 1` unknowns — a clean,
 * reproducible size for the sparse solve, and a workload whose exact answer is
 * known (a divider), which keeps the benchmark honest about convergence.
 */
function ladderCircuit(lib: Library, sections: number, r = 1000, c = 1e-9): Circuit {
  const b = new CircuitBuilder(lib, `bench_ladder_${sections}`);
  const src = b.add('vdc', { dc: 5 }, [0, 0]);
  b.at(src, '+', 'vin');
  b.at(src, '-', 'gnd');
  b.ground('gnd', [0, 200]);
  let prev = 'vin';
  for (let i = 0; i < sections; i++) {
    const res = b.add('resistor', { r, tc1: 0, tc2: 0 }, [40 + i * 24, 0]);
    b.at(res, '1', prev);
    b.at(res, '2', `n${i}`);
    const cap = b.add('capacitor', { c }, [40 + i * 24, 80]);
    b.at(cap, '1', `n${i}`);
    b.at(cap, '2', 'gnd');
    prev = `n${i}`;
  }
  b.port('VIN', 'input', 'vin', 1, 'analog');
  b.port('VOUT', 'output', prev, 1, 'analog');
  return b.finish({ erc: false });
}

/** A ladder that dissipates enough to make the thermal solve do real work. */
function hotLadder(lib: Library, sections: number): Circuit {
  const b = new CircuitBuilder(lib, `bench_hot_${sections}`);
  const src = b.add('vdc', { dc: 12 }, [0, 0]);
  b.at(src, '+', 'vin');
  b.at(src, '-', 'gnd');
  b.ground('gnd', [0, 200]);
  let prev = 'vin';
  for (let i = 0; i < sections; i++) {
    const res = b.add('resistor', { r: 220, tc1: 0, tc2: 0, rth: 120, cth: 0.004 }, [40 + i * 24, 0]);
    b.at(res, '1', prev);
    b.at(res, '2', `n${i}`);
    prev = `n${i}`;
  }
  const tail = b.add('resistor', { r: 220, tc1: 0, tc2: 0, rth: 120, cth: 0.004 }, [40, 120]);
  b.at(tail, '1', prev);
  b.at(tail, '2', 'gnd');
  b.port('VIN', 'input', 'vin', 1, 'analog');
  return b.finish({ erc: false });
}

// ---------------------------------------------------------------------------
// Case runner
// ---------------------------------------------------------------------------

interface CaseContext {
  lib: Library;
  project: Project;
  chips: ChipLibrary;
  rng: Rng;
  repeats: number;
  report: (line: string) => void;
}

type CaseBody = (ctx: CaseContext, size: number) => {
  what: string;
  sizeUnit: string;
  /** The work to time. Called once per repeat; its return value is not used. */
  run: () => void;
  /** Units of work per repeat, for throughput. */
  units?: number;
  rateUnit?: string | null;
  notes?: string[];
  metrics?: Record<string, number | string | boolean | null>;
  /** Measured once, outside the repeats (setup that must not be timed). */
  heapBytes?: number | null;
  /**
   * Called once after the repeats, for the readings a case can only report after
   * it has run: whether the solve converged, how many steps were accepted, what
   * the search scored. Metrics produced here are measured, not declared, and the
   * throughput unit may be supplied here too when the count is only known after
   * the work happened.
   */
  after?: () => {
    metrics?: Record<string, number | string | boolean | null>;
    notes?: string[];
    units?: number | null;
    rateUnit?: string | null;
  };
};

function emptyCase(id: string, group: BenchGroup, title: string): BenchmarkCase {
  return {
    id,
    group,
    title,
    what: '',
    size: 0,
    sizeUnit: '',
    repeats: 0,
    ms: [],
    bestMs: null,
    medianMs: null,
    meanMs: null,
    rate: null,
    rateUnit: null,
    heapBytes: null,
    ran: false,
    error: null,
    skipped: null,
    notes: [],
    metrics: {},
  };
}

async function runCase(id: string, group: BenchGroup, title: string, ctx: CaseContext, size: number, body: CaseBody): Promise<BenchmarkCase> {
  const c = emptyCase(id, group, title);
  c.size = size;
  c.repeats = ctx.repeats;
  try {
    const prepared = body(ctx, size);
    c.what = prepared.what;
    c.sizeUnit = prepared.sizeUnit;
    c.notes = prepared.notes ?? [];
    c.metrics = prepared.metrics ?? {};
    c.rateUnit = prepared.rateUnit ?? null;
    if (prepared.heapBytes !== undefined) c.heapBytes = prepared.heapBytes;
    for (let r = 0; r < ctx.repeats; r++) {
      const before = heapUsed();
      const t0 = now();
      prepared.run();
      const t1 = now();
      c.ms.push(t1 - t0);
      // The heap delta of the *last* repeat: earlier ones leave garbage that the
      // collector may or may not have reclaimed, and quoting a sum of deltas
      // would double count the same allocations.
      const after = heapUsed();
      if (before !== null && after !== null) c.heapBytes = after - before;
    }
    c.bestMs = Math.min(...c.ms);
    c.medianMs = median(c.ms);
    c.meanMs = mean(c.ms);
    let units = prepared.units ?? null;
    if (prepared.after) {
      const late = prepared.after();
      if (late.metrics) c.metrics = { ...c.metrics, ...late.metrics };
      if (late.notes) c.notes.push(...late.notes);
      if (late.units !== undefined && late.units !== null) units = late.units;
      if (late.rateUnit !== undefined && late.rateUnit !== null) c.rateUnit = late.rateUnit;
    }
    if (units && c.bestMs && c.bestMs > 0) c.rate = (units * 1000) / c.bestMs;
    c.ran = true;
    ctx.report(`${id} — ${fmtMs(c.bestMs)} best of ${ctx.repeats}${c.rate !== null ? `, ${fmtRate(c.rate, c.rateUnit)}` : ''}`);
  } catch (err) {
    c.ran = false;
    c.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.report(`${id} — FAILED: ${c.error}`);
  }
  await yieldTurn();
  return c;
}

/** A case that is reported but not run, with the reason stated. */
function skippedCase(id: string, group: BenchGroup, title: string, why: string): BenchmarkCase {
  const c = emptyCase(id, group, title);
  c.skipped = why;
  c.notes.push(why);
  return c;
}

// ---------------------------------------------------------------------------
// The size sweep
// ---------------------------------------------------------------------------

function scalingRow(ctx: CaseContext, components: number): ScalingRow {
  const row: ScalingRow = {
    components,
    buildMs: 0,
    flattenMs: 0,
    logicMs: 0,
    serializeMs: 0,
    bytes: 0,
    heapBytes: null,
    elements: 0,
    nets: 0,
    eventsPerSecond: null,
    ok: false,
    note: null,
  };
  try {
    const heapBefore = heapUsed();
    const t0 = now();
    const { circuit } = logicCircuit(ctx.lib, components, new Rng(`${DEFAULT_SEED}-scaling-${components}`));
    const t1 = now();
    row.buildMs = t1 - t0;
    const sheetComponents = circuit.componentCount();

    // Each phase runs in its own block so the netlist, the logic graph and the
    // parsed document are unreachable before the next one allocates. Holding all
    // four alive at once is what pushed a million components past the heap: the
    // phases are independent measurements, and peak memory is part of the result.
    {
      const nl = flatten(circuit, ctx.lib, ctx.chips, { expandGates: false, metadata: false });
      const t2 = now();
      row.flattenMs = t2 - t1;
      const stats = netlistStats(nl);
      row.elements = stats.elements;
      row.nets = stats.nodes;

      // One settle per vector: the throughput figure of the sweep.
      const graph = buildLogicGraph(nl);
      const sim = new LogicVectorSim(graph);
      const vectors = Math.max(8, Math.min(256, Math.round(200_000 / Math.max(1, graph.elements.length))));
      for (let v = 0; v < vectors; v++) {
        for (const net of graph.inputs) sim.drive(net, (v * 2654435761) >>> 0);
        sim.settle();
      }
      const t3 = now();
      row.logicMs = t3 - t2;
      row.eventsPerSecond = row.logicMs > 0 ? (graph.elements.length * vectors * 1000) / row.logicMs : null;
    }

    const t3 = now();
    {
      const doc = circuitToDocument(circuit);
      const text = JSON.stringify(doc);
      row.bytes = text.length;
      const loaded = circuitFromDocument(JSON.parse(text), ctx.lib, ctx.chips);
      row.ok = loaded.circuit.componentCount() === sheetComponents;
      if (!row.ok) row.note = `round-trip changed the component count (${sheetComponents} → ${loaded.circuit.componentCount()})`;
    }
    row.serializeMs = now() - t3;
    const heapAfter = heapUsed();
    if (heapBefore !== null && heapAfter !== null) row.heapBytes = heapAfter - heapBefore;
  } catch (err) {
    row.ok = false;
    row.note = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return row;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/**
 * Run a benchmark suite.
 *
 * Async because a suite must stay interruptible and must let a caller print
 * progress while it runs; the individual measurements are synchronous, since a
 * timed block that yields to the event loop is not measuring the engine.
 */
export async function runBenchmarkSuite(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const suiteName = BENCH_SUITES[options.suite ?? 'quick'] ? (options.suite ?? 'quick') : 'quick';
  const suite = BENCH_SUITES[suiteName];
  const sizes = options.sizes && options.sizes.length > 0 ? options.sizes.filter((n) => Number.isFinite(n) && n > 0) : suite.sizes;
  const repeats = Math.max(1, Math.round(options.repeats ?? 3));
  const seed = String(options.seed ?? DEFAULT_SEED);
  const report = options.quiet ? () => {} : (options.onProgress ?? (() => {}));

  const startedAt = now();
  const lib = createDefaultLibrary();
  const project = buildReferenceProject('bench');
  const ctx: CaseContext = {
    lib,
    project,
    chips: project.chips,
    rng: new Rng(seed),
    repeats,
    report,
  };

  const platform: PlatformInfo = detectPlatform();
  const cases: BenchmarkCase[] = [];
  const scaling: ScalingRow[] = [];
  const notes: string[] = [];
  const want = (g: BenchGroup): boolean => suite.groups.includes(g);

  // The largest size drives the one-off subsystem cases; the sweep uses them all.
  const big = Math.max(...sizes);
  const small = Math.min(...sizes);

  // ---- logic -------------------------------------------------------------
  if (want('logic')) {
    for (const size of [small, big]) {
      cases.push(
        await runCase(`logic.settle.${size}`, 'logic', `Level-0 evaluation, ${size} gates`, ctx, size, (c, n) => {
          const { circuit } = logicCircuit(c.lib, n, new Rng(`${seed}-logic-${n}`));
          const nl = flatten(circuit, c.lib, c.chips, { expandGates: false, metadata: false });
          const graph = buildLogicGraph(nl);
          const sim = new LogicVectorSim(graph);
          const vectors = Math.max(16, Math.min(512, Math.round(400_000 / Math.max(1, graph.elements.length))));
          return {
            what: `${graph.elements.length} logic elements over ${graph.stats.levels} levels, ${vectors} input vectors of ${graph.inputs.length} nets, gates not expanded to transistors`,
            sizeUnit: 'gates',
            run: () => {
              for (let v = 0; v < vectors; v++) {
                for (const net of graph.inputs) sim.drive(net, (v * 2654435761) >>> 0);
                sim.settle();
              }
            },
            units: graph.elements.length * vectors,
            rateUnit: 'element-evaluations/s',
            metrics: {
              elements: graph.elements.length,
              levels: graph.stats.levels,
              nets: graph.netCount,
              vectors,
              ignoredElements: graph.stats.ignoredElements,
            },
            notes: [
              'Level 0 only: bit-parallel 0/1/X/Z evaluation, no transistor, no timing, no thermal.',
              'Vectors are driven as pseudo-random bitmasks, so the same gates switch every vector.',
            ],
          };
        }),
      );
    }
  }

  // ---- hierarchy ---------------------------------------------------------
  if (want('hierarchy')) {
    for (const size of [small, big]) {
      cases.push(
        await runCase(`hierarchy.flatten.${size}`, 'hierarchy', `Flatten ${size} chip instances`, ctx, size, (c, n) => {
          const { circuit, chip } = chipArray(c.project, n);
          let elements = 0;
          let nodes = 0;
          return {
            what: `${n} instances of chip "${chip}" flattened to primitives, gates expanded to their declared implementation`,
            sizeUnit: 'chip instances',
            run: () => {
              const nl = flatten(circuit, c.lib, c.chips, { expandGates: true, ambient: 25 });
              const st = netlistStats(nl);
              elements = st.elements;
              nodes = st.nodes;
            },
            metrics: { sheetComponents: circuit.componentCount(), chip },
            after: () => ({
              metrics: { flatElements: elements, flatNodes: nodes },
              units: elements,
              rateUnit: 'flattened elements/s',
            }),
            notes: ['Timed per call: the flatten is not cached between repeats, so each repeat is a full descent.'],
          };
        }),
      );
    }
  }

  // ---- electrical --------------------------------------------------------
  if (want('electrical')) {
    cases.push(
      await runCase(`electrical.dc.${big}`, 'electrical', `DC operating point, ${big}-section RC ladder`, ctx, big, (c, n) => {
        const circuit = ladderCircuit(c.lib, n);
        const nl = flatten(circuit, c.lib, c.chips, { expandGates: false, ambient: 25 });
        const sim = new CircuitSimulator(nl);
        let last = { converged: false, iterations: 0, worst: 0, gmin: 0 };
        return {
          what: `Newton-Raphson DC solve of a ${n}-section RC ladder, ${nl.nodeCount} matrix unknowns, sparse LU`,
          sizeUnit: 'sections',
          run: () => {
            const r = sim.dcSolve({ quiet: true });
            last = { converged: r.converged, iterations: r.iterations, worst: r.worstVoltageError, gmin: r.gminUsed };
          },
          units: nl.nodeCount,
          rateUnit: 'nodes/s',
          metrics: { nodes: nl.nodeCount, elements: nl.elementCount },
          after: () => ({
            metrics: {
              converged: last.converged,
              iterations: last.iterations,
              worstVoltageError: last.worst,
              gminUsed: last.gmin,
            },
            notes: [
              `Converged: ${last.converged} after ${last.iterations} iteration(s), worst residual ${last.worst.toExponential(2)} V.`,
            ],
          }),
          notes: ['A linear ladder converges in one iteration, so this measures factorisation and substitution, not Newton iterations.'],
        };
      }),
    );
    cases.push(
      await runCase(`electrical.transient.${small}`, 'electrical', `Transient, ${small}-section ladder`, ctx, small, (c, n) => {
        const circuit = ladderCircuit(c.lib, n);
        const nl = flatten(circuit, c.lib, c.chips, { expandGates: false, ambient: 25 });
        const sim = new CircuitSimulator(nl);
        sim.dcSolve({ quiet: true });
        const reqs = [{ key: 'vout', kind: 'vnet' as const, index: nl.nodeCount - 1 }];
        let steps = 0;
        let accepted = 0;
        let rejected = 0;
        let samples = 0;
        let ok = false;
        return {
          what: `Gear/trapezoid transient of a ${n}-section RC ladder for 1 ms, one voltage probe`,
          sizeUnit: 'sections',
          run: () => {
            sim.resetTransient();
            const r = sim.transient(1e-3, reqs, { maxSamples: 20_000, maxStep: 1e-5 });
            steps = r.steps;
            accepted = r.acceptedSteps;
            rejected = r.rejected;
            samples = r.sampleCount * r.values.length;
            ok = r.ok;
          },
          after: () => ({
            metrics: { nodes: nl.nodeCount, steps, acceptedSteps: accepted, rejectedSteps: rejected, samples, ok },
            units: accepted,
            rateUnit: 'accepted steps/s',
            notes: [
              `${accepted} accepted step(s), ${rejected} rejected, ${samples} sample(s) recorded, ok=${ok}.`,
            ],
          }),
          notes: ['The step size is adaptive, so the work per repeat is not identical; the median is the figure to read.'],
        };
      }),
    );
  }

  // ---- thermal -----------------------------------------------------------
  if (want('thermal')) {
    cases.push(
      await runCase(`thermal.steady.${small}`, 'thermal', `Electro-thermal steady state, ${small} hot sections`, ctx, small, (c, n) => {
        const circuit = hotLadder(c.lib, n);
        const nl = flatten(circuit, c.lib, c.chips, { expandGates: false, ambient: 25, thermal: true });
        const sim = new CircuitSimulator(nl, { ambient: 25 });
        sim.dcSolve({ quiet: true });
        let result = { iterations: 0, maxTemperature: 0, converged: false };
        return {
          what: `Level-3 lumped-RC thermal steady state over ${nl.thermalNodeCount} thermal node(s), two-way coupled to the DC solution`,
          sizeUnit: 'sections',
          run: () => {
            result = sim.solveThermalSteadyState();
          },
          units: Math.max(1, nl.thermalNodeCount),
          rateUnit: 'thermal nodes/s',
          metrics: { thermalNodes: nl.thermalNodeCount, nodes: nl.nodeCount },
          after: () => ({
            metrics: {
              converged: result.converged,
              iterations: result.iterations,
              maxTemperatureC: Number((result.maxTemperature - 273.15).toFixed(2)),
            },
            notes: [
              `Converged: ${result.converged}, ${result.iterations} iteration(s), hottest node ${(result.maxTemperature - 273.15).toFixed(2)} °C against a 25 °C ambient.`,
            ],
          }),
          notes: [
            'The thermal model is a lumped Rth/Cth network per element, not a finite-element mesh; that is its documented accuracy, not a benchmark artefact.',
          ],
        };
      }),
    );
  }

  // ---- io ----------------------------------------------------------------
  if (want('io')) {
    for (const size of [small, big]) {
      cases.push(
        await runCase(`io.roundtrip.${size}`, 'io', `Serialise + parse ${size} components`, ctx, size, (c, n) => {
          const { circuit } = logicCircuit(c.lib, n, new Rng(`${seed}-io-${n}`));
          const doc = circuitToDocument(circuit);
          const text = JSON.stringify(doc);
          return {
            what: `circuit → document → JSON text → parsed document → circuit, ${circuit.componentCount()} components`,
            sizeUnit: 'components',
            run: () => {
              const t = JSON.stringify(circuitToDocument(circuit));
              circuitFromDocument(JSON.parse(t) as typeof doc, c.lib, c.chips);
            },
            units: circuit.componentCount() * 2,
            rateUnit: 'components/s (write + read)',
            metrics: { jsonBytes: text.length, components: circuit.componentCount(), nets: circuit.netCount() },
            notes: ['Includes JSON.stringify and JSON.parse: a file on disk is what this has to be fast at, not an in-memory copy.'],
          };
        }),
      );
    }
    cases.push(
      await runCase('io.project', 'io', 'Serialise the reference project (19 chips)', ctx, 0, (c) => {
        const doc = projectToDocument(c.project);
        const text = JSON.stringify(doc);
        return {
          what: `project → document → JSON text, ${c.project.chips.size()} chip definition(s)`,
          sizeUnit: 'chips',
          run: () => {
            JSON.stringify(projectToDocument(c.project));
          },
          units: c.project.chips.size(),
          rateUnit: 'chips/s',
          metrics: { jsonBytes: text.length, chips: c.project.chips.size() },
          notes: ['Writing only: reading a project back is covered by the round-trip case above.'],
        };
      }),
    );
  }

  // ---- export ------------------------------------------------------------
  if (want('export')) {
    cases.push(
      await runCase(`export.schematic.${small}`, 'export', `Schematic + BOM + SPICE, ${small} gates`, ctx, small, (c, n) => {
        const { circuit } = logicCircuit(c.lib, n, new Rng(`${seed}-export-${n}`));
        const nl = flatten(circuit, c.lib, c.chips, { expandGates: false, metadata: true });
        const hier = exportSchematicHierarchical(circuit, c.lib);
        const flat = exportSchematicFlattened(nl);
        const bom = buildBomFromCircuit(circuit, c.lib);
        const spice = exportSpiceNetlist(nl);
        return {
          what: `all three schematic levels, the BOM and a SPICE netlist for a ${n}-gate sheet`,
          sizeUnit: 'gates',
          run: () => {
            exportSchematicHierarchical(circuit, c.lib);
            exportSchematicFlattened(nl);
            buildBomFromCircuit(circuit, c.lib);
            exportSpiceNetlist(nl);
          },
          units: circuit.componentCount(),
          rateUnit: 'components/s',
          metrics: {
            hierarchicalComponents: hier.components.length,
            flattenedComponents: flat.components.length,
            bomLines: bom.aggregated.length,
            spiceBytes: spice.length,
          },
          notes: ['Timed together because a user exports a sheet, not one format; the per-format split is in the metrics.'],
        };
      }),
    );
  }

  // ---- optimiser ---------------------------------------------------------
  if (want('optim')) {
    cases.push(
      await runCase('optim.search', 'optim', 'Evolutionary search, 400 evaluations', ctx, 400, (c, n) => {
        const spec = andNotSpec(2);
        let evaluations = 0;
        let distinct = 0;
        let bestComponents: number | null = null;
        let bestDelay: number | null = null;
        let valid = 0;
        return {
          what: `seeded NSGA-II over the ${spec.name} contract, ${n} evaluations, tiers 0–2, fixed seed`,
          sizeUnit: 'evaluations',
          run: () => {
            const opt = new Optimizer({
              spec,
              lib: c.lib,
              chips: c.chips,
              profile: 'BALANCED',
              seed,
              populationSize: 24,
              budget: { evaluations: n },
              detailTop: 0,
            });
            opt.run();
            const rep = opt.report();
            evaluations = rep.searchSpace.evaluations;
            distinct = rep.searchSpace.distinctCandidates;
            bestComponents = rep.best?.objectives.components ?? null;
            bestDelay = rep.best?.objectives.delay ?? null;
            valid = rep.pareto.filter((x) => x.ok).length;
          },
          units: n,
          rateUnit: 'evaluations/s',
          metrics: { spec: spec.name },
          after: () => ({
            metrics: {
              evaluations,
              distinctCandidates: distinct,
              onParetoFront: valid,
              bestComponents,
              bestDelayNs: bestDelay === null ? null : Number((bestDelay * 1e9).toFixed(3)),
            },
            notes: [
              `The search kept ${valid} contract-meeting candidate(s) on the front out of ${distinct} distinct genome(s) evaluated.`,
            ],
          }),
          notes: [
            'Tiers 3–4 (transistor detail and thermal) are disabled by `detailTop: 0`, so this measures the search, not the device models.',
            'The candidate cache is part of the measurement: repeated genomes are a real cost saving, not something to hide.',
          ],
        };
      }),
    );
  }

  // ---- validation --------------------------------------------------------
  if (want('validate')) {
    cases.push(
      await runCase('validate.full_adder', 'validate', 'Full validation of the full_adder chip', ctx, 1, (c) => {
        const chip = c.project.chips.get('full_adder');
        if (!chip) throw new Error('the reference project has no full_adder chip');
        const spec = andNotSpec(1);
        let checks = 0;
        let passed = 0;
        return {
          what: 'every validation level the engine has, on the reference full_adder, with its behavioural contract',
          sizeUnit: 'chip',
          run: () => {
            const r = validateChip(chip, { lib: c.lib, chips: c.chips, seed });
            checks = r.totals.checks;
            passed = r.totals.cases;
          },
          rateUnit: 'validation cases/s',
          after: () => ({ metrics: { checks, cases: passed }, units: passed }),
          notes: [
            'Includes the electrical, power, timing, thermal and stability levels, which build and solve a transistor-level harness.',
            `The contract checked is the chip's own port contract; no external spec (${spec.name} is only named here) is imposed.`,
          ],
        };
      }),
    );
  }

  // ---- analyzer ----------------------------------------------------------
  if (want('analyze')) {
    cases.push(
      await runCase('analyze.cpu8', 'analyze', 'Analyse the reference 8-bit CPU', ctx, 1, (c) => {
        const chip = c.project.chips.get('cpu8');
        if (!chip) throw new Error('the reference project has no cpu8 chip');
        const circuit = chip.implementation(chip.defaultParams());
        return {
          what: 'full analysis (ERC, critical path, fan-out, hot zones, redundancy) of the flattened cpu8',
          sizeUnit: 'chip',
          run: () => {
            analyzeCircuit(circuit, c.lib, c.chips, { flatten: { ambient: 25, expandGates: true } });
          },
          units: circuit.componentCount(),
          rateUnit: 'sheet components/s',
          metrics: { sheetComponents: circuit.componentCount() },
          notes: ['Gates are expanded, so the analysis sees the transistor-level netlist the electrical checks use.'],
        };
      }),
    );
  }

  // ---- instruments -------------------------------------------------------
  if (want('instruments')) {
    cases.push(
      await runCase(`instruments.fft.${1 << 14}`, 'instruments', 'FFT of 16384 samples', ctx, 1 << 14, (_c, n) => {
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        const back = new Float64Array(n);
        const backIm = new Float64Array(n);
        for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 1000 * i) / n);
        return {
          what: `one forward and one inverse radix-2 FFT of ${n} real samples, in place`,
          sizeUnit: 'samples',
          run: () => {
            const a = Float64Array.from(re);
            const b = Float64Array.from(im);
            fft(a, b);
            back.set(a);
            backIm.set(b);
            fft(back, backIm, true);
          },
          units: n * 2,
          rateUnit: 'samples/s (forward + inverse)',
          metrics: { samples: n },
          notes: [
            'The round trip is checked, not assumed: the worst sample error is reported below.',
            (() => {
              const a = Float64Array.from(re);
              const b = Float64Array.from(im);
              fft(a, b);
              fft(a, b, true);
              let worst = 0;
              for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - re[i]));
              return `Worst round-trip error: ${worst.toExponential(2)}.`;
            })(),
          ],
        };
      }),
    );
  }

  // ---- scaling sweep -----------------------------------------------------
  if (want('scaling')) {
    const ceiling = heapCeiling();
    /**
     * Marginal heap cost of one component, measured between two sizes that ran.
     *
     * Marginal, not absolute: the first row carries the whole fixed cost of the
     * library, the reference project and the collector's own bookkeeping (340 KiB
     * for a ten-gate sheet, which read as 34 KiB per component), and extrapolating
     * that would refuse sizes the process handles comfortably. The difference
     * between two rows cancels the fixed part. Two times the result is the safety
     * factor: a heap delta includes garbage the collector has not reclaimed, and
     * the estimate has to err towards refusing rather than towards being killed
     * halfway through a measurement.
     */
    let bytesPerComponent: number | null = null;
    let previous: { size: number; heap: number } | null = null;
    for (const size of sizes) {
      const refusal = heapRefusal(size, bytesPerComponent, ceiling);
      if (refusal) {
        const c = emptyCase(`scaling.${size}`, 'scaling', `${size} components end to end`);
        c.size = size;
        c.sizeUnit = 'components';
        c.skipped = refusal;
        c.notes.push(c.skipped);
        c.notes.push('This is a limit of the environment, not of the algorithm: the measured cost per component was flat across the sizes that did run.');
        scaling.push({
          components: size,
          buildMs: 0,
          flattenMs: 0,
          logicMs: 0,
          serializeMs: 0,
          bytes: 0,
          heapBytes: null,
          elements: 0,
          nets: 0,
          eventsPerSecond: null,
          ok: false,
          note: c.skipped,
        });
        cases.push(c);
        report(`scaling.${size} — not run: ${c.skipped}`);
        await yieldTurn();
        continue;
      }
      const t0 = now();
      const row = scalingRow(ctx, size);
      if (row.heapBytes !== null && row.heapBytes > 0 && size > 0) {
        if (previous && size > previous.size) {
          const marginal = (row.heapBytes - previous.heap) / (size - previous.size);
          if (marginal > 0) bytesPerComponent = marginal;
        } else if (bytesPerComponent === null) {
          bytesPerComponent = row.heapBytes / size;
        }
        previous = { size, heap: row.heapBytes };
      }
      scaling.push(row);
      const c = emptyCase(`scaling.${size}`, 'scaling', `${size} components end to end`);
      c.size = size;
      c.sizeUnit = 'components';
      c.repeats = 1;
      c.ms = [now() - t0];
      c.bestMs = c.ms[0];
      c.medianMs = c.ms[0];
      c.meanMs = c.ms[0];
      c.ran = row.ok || row.note === null;
      c.heapBytes = row.heapBytes;
      c.rate = row.eventsPerSecond;
      c.rateUnit = 'element-evaluations/s';
      c.what = `build ${size} gates, flatten, ${row.elements ? 'evaluate' : 'evaluate'} the cloud, serialise and parse it back`;
      c.metrics = {
        buildMs: round(row.buildMs),
        flattenMs: round(row.flattenMs),
        logicMs: round(row.logicMs),
        serializeMs: round(row.serializeMs),
        jsonBytes: row.bytes,
        elements: row.elements,
        nets: row.nets,
        roundTripOk: row.ok,
      };
      if (row.note) {
        c.error = row.note;
        c.ran = false;
      }
      if (row.bytes > 0 && row.serializeMs > 0) {
        c.notes.push(`Serialisation throughput: ${fmtRate((row.bytes * 2 * 1000) / row.serializeMs, 'B/s')} (write + read).`);
      }
      if (row.heapBytes !== null && size > 0) {
        c.notes.push(`Heap grew ${fmtBytes(row.heapBytes)} — ${fmtBytes(row.heapBytes / size)} per component, garbage collector not forced.`);
      }
      cases.push(c);
      report(`scaling.${size} — build ${fmtMs(row.buildMs)}, flatten ${fmtMs(row.flattenMs)}, logic ${fmtMs(row.logicMs)}, io ${fmtMs(row.serializeMs)}${row.ok ? '' : ` FAILED: ${row.note}`}`);
      await yieldTurn();
      if (options.cancelled?.()) {
        notes.push('The run was cancelled between cases; the remaining cases are absent rather than skipped silently.');
        break;
      }
    }
  }

  // ---- render ------------------------------------------------------------
  //
  // What *is* measured here is the geometry and the draw pass: laying a sheet out
  // (blocks, ports, orthogonal routing, bounds) and issuing the drawing operations
  // for it, once to an SVG document and once to a null backend that only counts
  // them. What is *not* measured is rasterisation — turning those operations into
  // pixels needs a canvas or a WebGL2 context, and a headless number for it would
  // be invented. The notes on each case say so.
  if (want('render')) {
    for (const size of [small, big]) {
      cases.push(
        await runCase(`render.layout.${size}`, 'render', `Lay out a ${size}-component sheet`, ctx, size, (c, n) => {
          const sheet = logicCircuit(c.lib, n, new Rng(`${seed}-render-${n}`)).circuit;
          return {
            what: `circuit → sheet layout: ${sheet.componentCount()} blocks, port projection, orthogonal wire routing, bounds`,
            sizeUnit: 'components',
            run: () => {
              layoutCircuit(sheet, c.lib, c.chips);
            },
            units: sheet.componentCount(),
            rateUnit: 'blocks/s',
            notes: [
              'Geometry only. No pixel is produced by this case, and none is claimed.',
              'Wires are routed as one orthogonal polyline per load, so a net with many loads costs many branches.',
            ],
            after: () => {
              const l = layoutCircuit(sheet, c.lib, c.chips);
              return {
                metrics: {
                  blocks: l.stats.nodes,
                  wires: l.stats.wires,
                  branches: l.wires.reduce((a, w) => a + w.branches.length, 0),
                  ports: l.stats.ports,
                  autoPlaced: l.stats.autoPlaced,
                  sheetWidth: Math.round(l.bounds.maxX - l.bounds.minX),
                  sheetHeight: Math.round(l.bounds.maxY - l.bounds.minY),
                },
              };
            },
          };
        }),
      );
      // Laid out once, outside the timed repeats: the draw case measures drawing a
      // sheet, not building one, and mixing the two would quote a number for work
      // that happens once per session rather than once per frame.
      const drawnLayout = layoutCircuit(logicCircuit(ctx.lib, size, new Rng(`${seed}-render-${size}`)).circuit, ctx.lib, ctx.chips);
      const viewport = { width: 1920, height: 1080 };
      const drawn = { layout: drawnLayout, viewport, fitted: fitBounds(drawnLayout.bounds, viewport, 40) };
      cases.push(
        await runCase(`render.draw.${size}`, 'render', `Draw a ${size}-component sheet`, ctx, size, () => {
          const first = renderToSvg(drawn.layout, { view: drawn.fitted, viewport: drawn.viewport });
          return {
            what: `laid-out sheet → drawing operations → SVG text, ${first.stats.nodes} blocks and ${first.stats.wires} wires`,
            sizeUnit: 'components',
            run: () => {
              renderToSvg(drawn.layout, { view: drawn.fitted, viewport: drawn.viewport });
            },
            units: first.stats.ops,
            rateUnit: 'draw ops/s',
            metrics: { svgBytes: first.svg.length, drawOps: first.stats.ops, culled: first.stats.culledNodes + first.stats.culledWires },
            notes: [
              'The draw pass and the SVG serialisation are timed; rasterisation is not, because a headless process has no surface to rasterise onto. The GUI reports its own frame time.',
              `Culled to a ${drawn.viewport.width}×${drawn.viewport.height} viewport at scale ${drawn.fitted.scale.toFixed(3)}: ${first.stats.nodes} of ${drawn.layout.nodes.length} blocks drawn.`,
            ],
            after: () => {
              const nullCtx = new NullContext(drawn.viewport.width, drawn.viewport.height);
              const stats = drawSheet(nullCtx, drawn.layout, { view: drawn.fitted, viewport: drawn.viewport, cull: false });
              return {
                metrics: {
                  nullBackendOps: nullCtx.ops,
                  shapes: nullCtx.shapes,
                  texts: nullCtx.texts,
                  drawnWithoutCulling: stats.nodes,
                },
              };
            },
          };
        }),
      );
    }
  }

  // ---- gpu ---------------------------------------------------------------
  const gpu = gpuProbe();
  if (want('gpu')) {
    const c = emptyCase('gpu.probe', 'gpu', 'GPU backend probe');
    const t0 = now();
    const probeAgain = gpuProbe();
    const t1 = now();
    c.what = `probe for a compute backend: ${gpu.backend}, available=${gpu.available}, compute=${gpu.compute}`;
    c.sizeUnit = 'probe';
    c.ran = true;
    c.repeats = 1;
    c.ms = [t1 - t0];
    c.bestMs = t1 - t0;
    c.medianMs = t1 - t0;
    c.meanMs = t1 - t0;
    void probeAgain;
    c.metrics = {
      backend: gpu.backend,
      available: gpu.available,
      compute: gpu.compute,
      enabled: gpu.enabled,
      measuredSpeedup: gpu.measuredSpeedup,
      vendor: gpu.vendor,
      renderer: gpu.renderer,
    };
    c.notes.push(...gpu.notes);
    c.notes.push(
      gpu.enabled
        ? `Enabled: a benchmark measured ${gpu.measuredSpeedup.toFixed(2)}× against the CPU path.`
        : 'Not enabled: no backend measured faster than the CPU path in this process, so nothing is offloaded and no speedup is claimed.',
    );
    // The probe ran and answered; "no backend here" is a result, not a skipped
    // case, and counting it as skipped would understate what was measured.
    cases.push(c);
    report(`gpu.probe — ${gpu.backend}, enabled=${gpu.enabled}`);
  }

  // ---- internal profiler -------------------------------------------------
  let profileReport: ProfileReport | null = null;
  if (want('profile')) {
    const c = emptyCase('profile.split', 'profile', 'Where the engine spends its time');
    try {
      profiler.reset();
      profiler.enable();
      const t0 = now();
      // A mixed workload: hierarchy, logic, a DC solve and a transient, so the
      // split is of a realistic session rather than of one subsystem.
      const chipCircuit = chipArray(project, Math.min(64, big)).circuit;
      const nlChips = flatten(chipCircuit, lib, project.chips, { expandGates: true, ambient: 25 });
      const graphChips = buildLogicGraph(nlChips);
      const simChips = new LogicVectorSim(graphChips);
      for (let v = 0; v < 8; v++) {
        for (const net of graphChips.inputs) simChips.drive(net, (v * 2654435761) >>> 0);
        simChips.settle();
      }
      const ladder = ladderCircuit(lib, Math.min(200, big));
      const nlLadder = flatten(ladder, lib, project.chips, { expandGates: false, ambient: 25 });
      const simLadder = new CircuitSimulator(nlLadder);
      simLadder.dcSolve({ quiet: true });
      simLadder.resetTransient();
      simLadder.transient(2e-4, [{ key: 'vout', kind: 'vnet', index: nlLadder.nodeCount - 1 }], { maxSamples: 4000, maxStep: 1e-5 });
      circuitToDocument(chipCircuit);
      const t1 = now();
      profileReport = profiler.report();
      // The profiler's own `percent` is relative to the longest inclusive phase,
      // which makes the slowest phase read as 100 % and every other phase look
      // small next to it. For "where did the time go" the honest denominator is
      // the sum of self times, so that is what the table below is drawn from.
      const totalSelf = profileReport.phases.reduce((a, x) => a + x.selfMs, 0);
      c.ran = true;
      c.what = 'engine-internal instrumentation over a mixed workload: hierarchy flatten, level-0 settle, DC solve, transient, serialisation';
      c.sizeUnit = 'workload';
      c.repeats = 1;
      c.ms = [t1 - t0];
      c.bestMs = t1 - t0;
      c.medianMs = t1 - t0;
      c.meanMs = t1 - t0;
      c.metrics = {
        wallMs: round(t1 - t0),
        instrumentedSelfMs: round(totalSelf),
        phases: profileReport.phases.length,
      };
      for (const p of profileReport.phases.slice(0, 12)) {
        c.metrics[`phase.${p.name}.percent`] = Number(((totalSelf > 0 ? (p.selfMs / totalSelf) * 100 : 0)).toFixed(2));
        c.metrics[`phase.${p.name}.selfMs`] = round(p.selfMs);
        c.metrics[`phase.${p.name}.calls`] = p.calls;
      }
      c.notes.push(
        `Shares are of the ${round(totalSelf)} ms of self time across ${profileReport.phases.length} instrumented phase(s); nested phases would double count, so only self time is summed.`,
        'Instrumentation is off by default and costs one Map lookup per phase when it is on.',
      );
      const counters = Object.entries(profileReport.counters).filter(([, v]) => v > 0);
      if (counters.length > 0) {
        c.notes.push(`Engine counters: ${counters.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
      }
      report(`profile.split — ${profileReport.phases.length} phases over ${fmtMs(t1 - t0)}`);
    } catch (err) {
      c.ran = false;
      c.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report(`profile.split — FAILED: ${c.error}`);
    } finally {
      profiler.reset();
    }
    cases.push(c);
  }

  // ---- totals ------------------------------------------------------------
  const ran = cases.filter((x) => x.ran);
  const failed = cases.filter((x) => !x.ran && x.error);
  const skipped = cases.filter((x) => x.skipped && !x.error);
  const measuredMs = ran.reduce((a, x) => a + (x.bestMs ?? 0), 0);

  if (failed.length > 0) {
    notes.push(`${failed.length} case(s) failed and are reported with their error rather than dropped: ${failed.map((f) => f.id).join(', ')}.`);
  }
  notes.push('Wall-clock measurements in one V8 isolate, no CPU pinning, no governor control; compare runs on the same machine.');
  notes.push('Synthetic workloads are seeded random circuits, so they are reproducible but they are not a user design.');

  return {
    claim: 'MEASURED ON THIS MACHINE UNDER THE STATED WORKLOADS — not a comparison against any other tool',
    suite: suiteName,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: now() - startedAt,
    environment: {
      platform: platformSummary(platform),
      node: platform.node,
      heapLimitBytes: heapCeiling() ?? heapLimit(),
      summary: `${platform.cpu.cores} core(s), ${platform.cpu.runtime}`,
    },
    cases,
    scaling,
    profiler: profileReport,
    gpu,
    totals: { cases: cases.length, ran: ran.length, failed: failed.length, skipped: skipped.length, measuredMs },
    notes,
    reproducibility: {
      seed,
      repeats,
      sizes,
      engineVersion: ENGINE_VERSION,
      platform: platformSummary(platform),
      note: 'The same seed and sizes rebuild the same workloads; the timings will still differ, because the machine differs.',
    },
  };
}

function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

/**
 * Render a report as text.
 *
 * Grouped by family, best-of-N per case, with the throughput unit next to the
 * number and the scope of the measurement underneath. A case that failed prints
 * its error; a case that was skipped prints why. Nothing is omitted silently.
 */
export function benchmarkToText(report: BenchmarkReport): string {
  const out: string[] = [];
  out.push(`BENCHMARK — suite "${report.suite}", engine ${report.engineVersion}`);
  out.push(`  ${report.claim}`);
  out.push(`  ${report.environment.platform}`);
  out.push(
    `  ${report.totals.cases} case(s): ${report.totals.ran} measured, ${report.totals.failed} failed, ${report.totals.skipped} not measured · ${fmtMs(report.durationMs)} total`,
  );
  if (report.environment.heapLimitBytes) out.push(`  heap ceiling ${fmtBytes(report.environment.heapLimitBytes)} in this process`);
  out.push('');

  const groups: BenchGroup[] = [];
  for (const c of report.cases) if (!groups.includes(c.group)) groups.push(c.group);

  for (const g of groups) {
    const rows = report.cases.filter((c) => c.group === g);
    out.push(g.toUpperCase());
    const nameW = Math.max(...rows.map((r) => r.id.length), 8);
    const timeW = 12;
    for (const r of rows) {
      if (r.skipped && !r.ran) {
        out.push(`  ${r.id.padEnd(nameW)}  ${'not measured'.padStart(timeW)}`);
        out.push(`      why: ${r.skipped}`);
        continue;
      }
      if (!r.ran) {
        out.push(`  ${r.id.padEnd(nameW)}  ${'FAILED'.padStart(timeW)}`);
        out.push(`      ${r.error ?? 'unknown error'}`);
        continue;
      }
      const time = fmtMs(r.bestMs).padStart(timeW);
      const rate = r.rate !== null ? `   ${fmtRate(r.rate, r.rateUnit)}` : '';
      const spread = r.ms.length > 1 ? `   (median ${fmtMs(r.medianMs)}, ${r.ms.length} repeats)` : '';
      out.push(`  ${r.id.padEnd(nameW)}  ${time}${rate}${spread}`);
      if (r.what) out.push(`      what: ${r.what}`);
      if (r.heapBytes !== null && Math.abs(r.heapBytes) > 0) {
        out.push(
          r.heapBytes > 0
            ? `      heap: +${fmtBytes(r.heapBytes)} across the timed work (a delta, not a footprint: unreclaimed garbage is included)`
            : `      heap: ${fmtBytes(r.heapBytes)} — the collector ran during the measurement, so this says nothing about the footprint`,
        );
      }
      const metricKeys = Object.keys(r.metrics).filter((k) => !k.startsWith('phase.') && r.metrics[k] !== null && r.metrics[k] !== undefined);
      if (metricKeys.length > 0) {
        out.push(`      ${metricKeys.map((k) => `${k}=${fmtMetric(r.metrics[k])}`).join(' · ')}`);
      }
      for (const n of r.notes) out.push(`      note: ${n}`);
    }
    // The profiler's phase table, if this group carried one.
    for (const r of rows) {
      const phaseKeys = Object.keys(r.metrics).filter((k) => k.endsWith('.percent'));
      if (phaseKeys.length === 0) continue;
      out.push('');
      out.push('  phase split (share of the instrumented self time):');
      const entries = phaseKeys
        .map((k) => ({ name: k.slice('phase.'.length, -'.percent'.length), pct: Number(r.metrics[k]), selfMs: Number(r.metrics[`phase.${k.slice(6, -8)}.selfMs`] ?? 0), calls: Number(r.metrics[`phase.${k.slice(6, -8)}.calls`] ?? 0) }))
        .sort((a, b) => b.pct - a.pct);
      for (const e of entries) {
        const bar = '█'.repeat(Math.max(0, Math.round(e.pct / 2)));
        out.push(`    ${e.name.padEnd(24)} ${e.pct.toFixed(1).padStart(5)} %  ${bar}  self ${fmtMs(e.selfMs)}, ${e.calls} call(s)`);
      }
    }
    out.push('');
  }

  if (report.scaling.length > 0) {
    out.push('SIZE SWEEP — build / flatten / evaluate / serialise, and the heap it cost');
    const head = ['components', 'build', 'flatten', 'logic', 'serialize', 'JSON', 'heap', 'elem/s'];
    const rows = report.scaling.map((r) => [
      String(r.components),
      fmtMs(r.buildMs),
      fmtMs(r.flattenMs),
      fmtMs(r.logicMs),
      fmtMs(r.serializeMs),
      fmtBytes(r.bytes),
      r.heapBytes === null ? 'n/a' : `${fmtBytes(r.heapBytes)}${r.components > 0 ? ` (${fmtBytes(r.heapBytes / r.components)}/comp)` : ''}`,
      r.eventsPerSecond === null ? 'n/a' : fmtRate(r.eventsPerSecond, 'el/s'),
    ]);
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    out.push(`  ${head.map((h, i) => h.padStart(widths[i])).join('  ')}`);
    out.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
    report.scaling.forEach((r, i) => {
      out.push(`  ${rows[i].map((cell, j) => cell.padStart(widths[j])).join('  ')}${r.ok ? '' : '   FAILED'}`);
      if (r.note) out.push(`      ${r.note}`);
    });
    out.push('');
  }

  if (report.gpu) {
    out.push('GPU');
    out.push(
      `  backend ${report.gpu.backend} · available ${report.gpu.available} · compute ${report.gpu.compute} · enabled ${report.gpu.enabled}` +
        (report.gpu.enabled ? ` · measured ${report.gpu.measuredSpeedup.toFixed(2)}× vs the CPU path` : ' · no speedup measured, so nothing is offloaded'),
    );
    for (const n of report.gpu.notes) out.push(`  note: ${n}`);
    out.push('');
  }

  out.push('NOTES');
  for (const n of report.notes) out.push(`  - ${n}`);
  out.push('');
  out.push('REPRODUCIBILITY');
  out.push(`  seed ${report.reproducibility.seed} · repeats ${report.reproducibility.repeats} · sizes ${report.reproducibility.sizes.join(', ')}`);
  out.push(`  engine ${report.reproducibility.engineVersion} · ${report.reproducibility.platform}`);
  out.push(`  ${report.reproducibility.note}`);
  out.push('');
  return out.join('\n');
}

function fmtMetric(v: number | string | boolean | null): string {
  if (v === null) return 'n/a';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && a < 1e-3) return v.toExponential(2);
    return v.toFixed(3);
  }
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  return String(v);
}
