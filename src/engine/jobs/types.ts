/**
 * Job queue types.
 *
 * A job is a long, interruptible unit of work: an optimisation run, a validation
 * sweep, a benchmark suite. The queue never blocks the caller — it advances one
 * `step()` at a time, which is what lets a GUI redraw between steps, a CLI print
 * progress, and a checkpoint land on disk at a known point instead of in the
 * middle of a Newton iteration.
 *
 * Every progress number in this module is *measured*: `tested` counts evaluations
 * the engine actually performed, `eta` is derived from the measured rate, and a
 * field the runtime cannot see (GPU load on a machine without a GPU) is reported
 * as `null` rather than estimated.
 */

export type JobKind =
  | 'optimize'
  | 'validate'
  | 'benchmark'
  | 'simulate'
  | 'analyze'
  | 'export'
  | 'mine'
  | 'reverse';

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed';

/** Progress statistics the UI and the CLI both display. */
export interface JobProgress {
  /** Work units completed (candidates evaluated, checks run, benchmarks done…). */
  tested: number;
  /** Work units rejected (a candidate that failed a tier, a case that failed). */
  rejected: number;
  /** Work units left, or null when the job is time-bounded. */
  remaining: number | null;
  /** 0..1 completion estimate; null when no estimate is honest. */
  fraction: number | null;
  /** Best value found so far, in the job's own unit, plus its label. */
  best: { label: string; value: number; unit: string } | null;
  /** Wall-clock milliseconds since the job started (paused time excluded). */
  elapsedMs: number;
  /** CPU milliseconds charged to this job (`process.cpuUsage` delta). */
  cpuMs: number;
  /** Estimated milliseconds to completion; null when the rate is unknown. */
  etaMs: number | null;
  /** Throughput in work units per second. */
  ratePerSecond: number;
  /** Heap used by the process, MB. */
  ramMB: number;
  /**
   * GPU utilisation. Always null unless a GPU backend is both present *and*
   * enabled by a benchmark — CircuitForge never invents a GPU figure.
   */
  gpu: { utilisation: number; backend: string } | null;
  /** Human-readable current activity, e.g. 'generation 12 · tier 2 timing'. */
  activity: string;
}

export function emptyProgress(): JobProgress {
  return {
    tested: 0,
    rejected: 0,
    remaining: null,
    fraction: null,
    best: null,
    elapsedMs: 0,
    cpuMs: 0,
    etaMs: null,
    ratePerSecond: 0,
    ramMB: 0,
    gpu: null,
    activity: 'idle',
  };
}

/** A history entry: one line per job that reached a terminal state. */
export interface HistoryEntry {
  id: string;
  kind: JobKind;
  name: string;
  state: JobState;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  progress: JobProgress;
  /** Short summary of the outcome, written by the task. */
  summary: string;
  error: string | null;
  /** Whether a checkpoint exists that could resume this job. */
  resumable: boolean;
}

/** What a task must provide to be driven by the queue. */
export interface Task {
  readonly kind: JobKind;
  readonly name: string;
  /**
   * Perform one unit of work.
   * @returns true when the task is complete, false to be called again.
   */
  step(): boolean;
  /** Measured progress. Must be cheap: the queue calls it after every step. */
  progress(): JobProgress;
  /** Result payload once complete (JSON-serialisable). */
  result(): unknown;
  /** One-line outcome summary for the history. */
  summary(): string;
  /**
   * Serialisable resume point. Must be small enough to write often: the queue
   * saves it on a timer, not on every step.
   */
  checkpoint(): unknown;
  /** Called when the job is cancelled: release big allocations. */
  dispose?(): void;
  /** Estimated total work units, when the task knows it (for `remaining`). */
  totalWork?(): number | null;
}

/** A job as stored on disk and as seen by the UI. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  name: string;
  state: JobState;
  /** Higher runs first; ties broken by insertion order. */
  priority: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pausedMs: number;
  steps: number;
  progress: JobProgress;
  error: string | null;
  summary: string | null;
  /** Parameters needed to rebuild the task after a crash. */
  spec: Record<string, unknown>;
  /** Last checkpoint payload, when the task produced one. */
  checkpoint: unknown;
  checkpointAt: string | null;
  /** Result payload, kept only for finished jobs (may be large). */
  result: unknown;
}

export interface QueueSnapshot {
  version: 1;
  savedAt: string;
  engineVersion: string;
  /** Jobs in execution order. */
  jobs: JobRecord[];
  history: HistoryEntry[];
  /** Monotonic counter used to mint job ids. */
  counter: number;
}

export interface QueueOptions {
  /** Milliseconds between automatic checkpoint writes; 0 = never. */
  autoSaveMs?: number;
  /** Steps between automatic checkpoint writes; 0 = never. */
  autoSaveSteps?: number;
  /** How many finished jobs to keep in the history. */
  historyLimit?: number;
  /** Maximum milliseconds of work per `pump()` call (keeps the UI responsive). */
  sliceMs?: number;
}

export const DEFAULT_QUEUE_OPTIONS: Required<QueueOptions> = {
  autoSaveMs: 2000,
  autoSaveSteps: 200,
  historyLimit: 200,
  sliceMs: 16,
};
