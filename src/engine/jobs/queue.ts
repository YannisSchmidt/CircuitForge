/**
 * The job queue: priority ordering, pause/resume/cancel, reordering, periodic
 * persistence, crash detection and history.
 *
 * Cooperative by construction. The queue owns no thread and no timer of its own:
 * a caller drives it with `tick()` (one step) or `pump(ms)` (steps until a time
 * slice is used up). A GUI calls `pump(16)` from its frame loop and stays
 * interactive; a CLI calls `pump(Infinity)` and prints progress; a test calls
 * `tick()` and asserts on exact step boundaries.
 *
 * Crash resilience: a job's `spec` and its last `checkpoint` are written to
 * storage on a timer and on a step count. On start-up `detectInterrupted()` finds
 * jobs whose state says they were running when the process died and offers them
 * back — the exact "Previous job detected … Resume? [Y/N]" behaviour, decided by
 * the caller rather than by a prompt buried in the engine.
 */

import { ENGINE_VERSION } from '../util/version.js';
import { isNode } from '../util/platform.js';
import { gpuProbe } from '../util/platform.js';
import {
  DEFAULT_QUEUE_OPTIONS,
  emptyProgress,
  type HistoryEntry,
  type JobKind,
  type JobProgress,
  type JobRecord,
  type QueueOptions,
  type QueueSnapshot,
  type Task,
} from './types.js';
import {
  CHECKPOINT_PREFIX,
  HISTORY_PREFIX,
  MemoryStorage,
  QUEUE_KEY,
  checkpointKey,
  historyKey,
  type JobStorage,
} from './storage.js';

export type TaskFactory = (spec: Record<string, unknown>, checkpoint: unknown) => Task;

export interface EnqueueOptions {
  priority?: number;
  /** Start immediately if the queue is idle (default true). */
  start?: boolean;
}

export type QueueListener = (event: QueueEvent) => void;

export type QueueEvent =
  | { type: 'enqueued'; job: JobRecord }
  | { type: 'started'; job: JobRecord }
  | { type: 'progress'; job: JobRecord }
  | { type: 'paused'; job: JobRecord }
  | { type: 'resumed'; job: JobRecord }
  | { type: 'cancelled'; job: JobRecord }
  | { type: 'finished'; job: JobRecord }
  | { type: 'failed'; job: JobRecord; error: string }
  | { type: 'saved'; key: string }
  | { type: 'restored'; jobs: number; history: number };

interface CpuClock {
  /** Cumulative CPU microseconds at the last sample. */
  last: { user: number; system: number } | null;
  /** CPU milliseconds charged to the current job. */
  chargedMs: number;
}

function readCpu(): { user: number; system: number } | null {
  if (!isNode) return null;
  try {
    const u = (globalThis.process as { cpuUsage?: () => { user: number; system: number } }).cpuUsage?.();
    return u ? { user: u.user, system: u.system } : null;
  } catch {
    return null;
  }
}

function heapMB(): number {
  if (!isNode) return 0;
  try {
    return Math.round((globalThis.process.memoryUsage().heapUsed / 1048576) * 10) / 10;
  } catch {
    return 0;
  }
}

let idCounter = 0;

/** Job id: monotonic inside a process, unique across restarts by timestamp. */
function newJobId(kind: JobKind): string {
  idCounter++;
  return `${kind}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export class JobQueue {
  readonly storage: JobStorage;
  readonly options: Required<QueueOptions>;
  private jobs = new Map<string, JobRecord>();
  private order: string[] = [];
  private tasks = new Map<string, Task>();
  private factories = new Map<JobKind, TaskFactory>();
  private history: HistoryEntry[] = [];
  private counter = 0;
  private listeners = new Set<QueueListener>();
  private activeId: string | null = null;
  private cpu: CpuClock = { last: null, chargedMs: 0 };
  private lastSaveAt = 0;
  private stepsSinceSave = 0;
  private gpu = gpuProbe();
  /** Set when the caller asks the queue to stop pumping (graceful shutdown). */
  private stopRequested = false;

  constructor(storage: JobStorage = new MemoryStorage(), options: QueueOptions = {}) {
    this.storage = storage;
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
    this.lastSaveAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Task registration
  // -------------------------------------------------------------------------

  /** Register the factory that rebuilds a task of this kind from its spec. */
  register(kind: JobKind, factory: TaskFactory): void {
    this.factories.set(kind, factory);
  }

  registeredKinds(): JobKind[] {
    return [...this.factories.keys()];
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onChange(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken listener must not take the queue down.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Enqueueing and ordering
  // -------------------------------------------------------------------------

  enqueue(kind: JobKind, name: string, spec: Record<string, unknown> = {}, opts: EnqueueOptions = {}): JobRecord {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`no task factory registered for job kind "${kind}"`);
    const id = newJobId(kind);
    this.counter++;
    const record: JobRecord = {
      id,
      kind,
      name,
      state: 'queued',
      priority: opts.priority ?? 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      pausedMs: 0,
      steps: 0,
      progress: emptyProgress(),
      error: null,
      summary: null,
      spec,
      checkpoint: null,
      checkpointAt: null,
      result: null,
    };
    this.jobs.set(id, record);
    this.order.push(id);
    this.sortOrder();
    this.emit({ type: 'enqueued', job: record });
    if (opts.start !== false && this.activeId === null) this.startNext();
    return record;
  }

  /**
   * Execution order: priority descending, then insertion order. Re-sorting is
   * O(n log n) on a queue that stays small (tens of jobs), so it is done on every
   * mutation rather than maintained incrementally.
   */
  private sortOrder(): void {
    const createdAt = new Map<string, number>();
    this.order.forEach((id, i) => createdAt.set(id, i));
    this.order.sort((a, b) => {
      const ja = this.jobs.get(a);
      const jb = this.jobs.get(b);
      if (!ja || !jb) return 0;
      if (jb.priority !== ja.priority) return jb.priority - ja.priority;
      return (createdAt.get(a) ?? 0) - (createdAt.get(b) ?? 0);
    });
  }

  /**
   * Move a job to a position in the queue (0 = next to run). The running job is
   * not movable; positions are counted over the jobs that are still waiting.
   */
  reorder(id: string, index: number): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state === 'running') return false;
    const waiting = this.order.filter((x) => this.jobs.get(x)?.state === 'queued');
    const from = waiting.indexOf(id);
    if (from < 0) return false;
    waiting.splice(from, 1);
    waiting.splice(Math.max(0, Math.min(waiting.length, index)), 0, id);
    // Rebuild the global order: running/paused jobs keep their place at the front.
    const pinned = this.order.filter((x) => !waiting.includes(x));
    this.order = [...pinned, ...waiting];
    this.save();
    return true;
  }

  setPriority(id: string, priority: number): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.priority = priority;
    this.sortOrder();
    this.save();
    return true;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Ids in execution order. */
  ids(): string[] {
    return [...this.order];
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** The job currently running, if any. */
  active(): JobRecord | null {
    return this.activeId ? (this.jobs.get(this.activeId) ?? null) : null;
  }

  /** Jobs waiting to run, in execution order. */
  queued(): JobRecord[] {
    return this.order.map((id) => this.jobs.get(id)).filter((j): j is JobRecord => !!j && j.state === 'queued');
  }

  private buildTask(job: JobRecord): Task | null {
    const factory = this.factories.get(job.kind);
    if (!factory) return null;
    try {
      return factory(job.spec, job.checkpoint);
    } catch (err) {
      job.state = 'failed';
      job.error = `the task could not be built: ${err instanceof Error ? err.message : String(err)}`;
      job.finishedAt = new Date().toISOString();
      this.pushHistory(job);
      this.emit({ type: 'failed', job, error: job.error });
      return null;
    }
  }

  private startNext(): boolean {
    if (this.activeId !== null) return false;
    // A paused job is never picked up: `resume()` is the only way back to
    // 'queued'. Auto-promoting it here made `pause()` a no-op whenever the queue
    // was pumped again.
    const next = this.queued()[0];
    if (!next) return false;
    if (!this.tasks.has(next.id)) {
      const task = this.buildTask(next);
      if (!task) return false;
      this.tasks.set(next.id, task);
    }
    next.state = 'running';
    if (next.startedAt === null) next.startedAt = new Date().toISOString();
    this.activeId = next.id;
    this.cpu = { last: readCpu(), chargedMs: 0 };
    this.emit({ type: 'started', job: next });
    return true;
  }

  /** Pause the running job (or a queued one, which then will not be picked up). */
  pause(id = this.activeId ?? undefined): boolean {
    if (!id) return false;
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'running') {
      job.state = 'paused';
      this.chargeCpu(job);
      if (this.activeId === id) this.activeId = null;
      this.save();
      this.emit({ type: 'paused', job });
      return true;
    }
    if (job.state === 'queued') {
      job.state = 'paused';
      this.save();
      this.emit({ type: 'paused', job });
      return true;
    }
    return false;
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'paused') return false;
    job.state = 'queued';
    this.cpu = { last: readCpu(), chargedMs: 0 };
    this.sortOrder();
    this.save();
    this.emit({ type: 'resumed', job });
    if (this.activeId === null) this.startNext();
    return true;
  }

  /** Cancel a job. A running one is dropped after its current step returns. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return false;
    job.state = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.chargeCpu(job);
    const task = this.tasks.get(id);
    try {
      task?.dispose?.();
    } catch {
      /* disposal is best effort */
    }
    this.tasks.delete(id);
    if (this.activeId === id) this.activeId = null;
    // A cancelled job keeps its checkpoint: the user may want to resume it later.
    this.save();
    this.pushHistory(job);
    this.emit({ type: 'cancelled', job });
    this.startNext();
    return true;
  }

  /** Ask the pump loop to return as soon as the current step ends. */
  requestStop(): void {
    this.stopRequested = true;
  }

  private chargeCpu(job: JobRecord): void {
    const now = readCpu();
    if (now && this.cpu.last) {
      const deltaUs = now.user - this.cpu.last.user + (now.system - this.cpu.last.system);
      job.progress.cpuMs += Math.max(0, deltaUs / 1000);
    }
    this.cpu.last = now;
  }

  // -------------------------------------------------------------------------
  // Driving
  // -------------------------------------------------------------------------

  /**
   * Run one step of the active job.
   * @returns true when a step ran, false when there is nothing to do.
   */
  tick(): boolean {
    if (!this.startNext()) {
      if (this.activeId === null) return false;
    }
    const job = this.active();
    if (!job || job.state !== 'running') return false;
    const task = this.tasks.get(job.id);
    if (!task) {
      job.state = 'failed';
      job.error = 'the task disappeared from the queue';
      job.finishedAt = new Date().toISOString();
      this.activeId = null;
      this.pushHistory(job);
      this.emit({ type: 'failed', job, error: job.error });
      return false;
    }
    job.steps++;
    let done = false;
    try {
      done = task.step();
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      job.finishedAt = new Date().toISOString();
      this.chargeCpu(job);
      this.tasks.delete(job.id);
      this.activeId = null;
      this.pushHistory(job);
      this.emit({ type: 'failed', job, error: job.error });
      this.save();
      this.startNext();
      return true;
    }
    this.chargeCpu(job);
    job.progress = this.decorate(task.progress(), job);
    if (done) this.finish(job, task);
    else this.emit({ type: 'progress', job });
    this.stepsSinceSave++;
    this.maybeSave();
    return true;
  }

  /** Fill in the runtime-measured fields a task cannot know about itself. */
  private decorate(p: JobProgress, job: JobRecord): JobProgress {
    const started = job.startedAt ? Date.parse(job.startedAt) : Date.now();
    const elapsed = Math.max(0, Date.now() - started - job.pausedMs);
    const ram = heapMB();
    // GPU figures are only reported when a backend is present *and* enabled by a
    // benchmark; otherwise the field stays null instead of showing a fake load.
    const gpu = this.gpu.enabled ? { utilisation: this.gpu.measuredSpeedup, backend: this.gpu.backend } : null;
    const rate = elapsed > 0 ? (p.tested / elapsed) * 1000 : 0;
    const total = this.tasks.get(job.id)?.totalWork?.() ?? null;
    const remaining = p.remaining ?? (total !== null ? Math.max(0, total - p.tested) : null);
    const fraction = total !== null && total > 0 ? Math.min(1, p.tested / total) : remaining !== null && rate > 0 ? null : null;
    return {
      ...p,
      elapsedMs: elapsed,
      cpuMs: job.progress.cpuMs + p.cpuMs,
      ramMB: ram,
      gpu: p.gpu ?? gpu,
      ratePerSecond: rate,
      remaining,
      fraction: p.fraction ?? fraction,
      etaMs: p.etaMs ?? (remaining !== null && rate > 0 ? (remaining / rate) * 1000 : null),
    };
  }

  private finish(job: JobRecord, task: Task): void {
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
    try {
      job.result = task.result();
    } catch (err) {
      job.result = null;
      job.error = `the task finished but its result could not be read: ${err instanceof Error ? err.message : String(err)}`;
      job.state = 'failed';
    }
    try {
      job.summary = task.summary();
    } catch {
      job.summary = null;
    }
    try {
      job.checkpoint = task.checkpoint();
      job.checkpointAt = new Date().toISOString();
    } catch {
      /* a task that cannot checkpoint is still finished */
    }
    this.tasks.delete(job.id);
    this.activeId = null;
    this.pushHistory(job);
    this.emit({ type: job.state === 'done' ? 'finished' : 'failed', job, ...(job.state === 'failed' ? { error: job.error ?? '' } : {}) } as QueueEvent);
    this.save();
    this.startNext();
  }

  /**
   * Pump the queue for at most `ms` milliseconds of wall time (Infinity = until
   * the queue is empty or `requestStop()` is called).
   * @returns the number of steps executed.
   */
  pump(ms = this.options.sliceMs): number {
    // A stop requested before the call means "do not start pumping": clearing the
    // flag first would silently ignore it. A stop requested *during* the loop (from
    // a listener, or from the task itself) ends the loop after the current step.
    const wasStopped = this.stopRequested;
    this.stopRequested = false;
    if (wasStopped) return 0;
    const t0 = Date.now();
    let steps = 0;
    while (!this.stopRequested) {
      if (!this.tick()) break;
      steps++;
      if (Number.isFinite(ms) && Date.now() - t0 >= ms) break;
    }
    return steps;
  }

  /** Number of jobs that still have work to do. */
  pending(): number {
    return this.order.filter((id) => {
      const s = this.jobs.get(id)?.state;
      return s === 'queued' || s === 'running' || s === 'paused';
    }).length;
  }

  /** True when nothing is queued, running or paused. */
  idle(): boolean {
    return this.pending() === 0;
  }

  /** Aggregate progress over the whole queue, for a single status line. */
  queueProgress(): { jobs: number; running: JobRecord | null; queuedCount: number; doneCount: number; failedCount: number; cancelledCount: number; pausedCount: number; ramMB: number; elapsedMs: number } {
    let done = 0;
    let failed = 0;
    let cancelled = 0;
    let paused = 0;
    let elapsed = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'done') done++;
      else if (job.state === 'failed') failed++;
      else if (job.state === 'cancelled') cancelled++;
      else if (job.state === 'paused') paused++;
      elapsed += job.progress.elapsedMs;
    }
    return { jobs: this.jobs.size, running: this.active(), queuedCount: this.queued().length, doneCount: done, failedCount: failed, cancelledCount: cancelled, pausedCount: paused, ramMB: heapMB(), elapsedMs: elapsed };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private pushHistory(job: JobRecord): void {
    const entry: HistoryEntry = {
      id: job.id,
      kind: job.kind,
      name: job.name,
      state: job.state,
      priority: job.priority,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: job.progress.elapsedMs,
      progress: job.progress,
      summary: job.summary ?? '',
      error: job.error,
      resumable: job.checkpoint !== null && job.state !== 'done',
    };
    this.history.unshift(entry);
    if (this.history.length > this.options.historyLimit) this.history.length = this.options.historyLimit;
    try {
      this.storage.write(historyKey(job.id), JSON.stringify(entry));
    } catch {
      /* history is a convenience; losing it must not lose the job */
    }
  }

  historyEntries(limit = this.options.historyLimit): HistoryEntry[] {
    return this.history.slice(0, limit);
  }

  clearHistory(): number {
    const n = this.history.length;
    this.history = [];
    for (const key of this.safeList(HISTORY_PREFIX)) {
      try {
        this.storage.remove(`${HISTORY_PREFIX}${key}`);
      } catch {
        /* best effort */
      }
    }
    return n;
  }

  private safeList(prefix: string): string[] {
    try {
      return this.storage.list(prefix);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private maybeSave(): void {
    const now = Date.now();
    const byTime = this.options.autoSaveMs > 0 && now - this.lastSaveAt >= this.options.autoSaveMs;
    const bySteps = this.options.autoSaveSteps > 0 && this.stepsSinceSave >= this.options.autoSaveSteps;
    if (byTime || bySteps) this.save();
  }

  /** Write the queue and the active job's checkpoint. */
  save(): void {
    const snapshot = this.snapshot();
    try {
      this.storage.write(QUEUE_KEY, JSON.stringify(snapshot));
      this.emit({ type: 'saved', key: QUEUE_KEY });
    } catch {
      // A full disk must not kill the run; the next save retries.
      return;
    }
    this.lastSaveAt = Date.now();
    this.stepsSinceSave = 0;
    const job = this.active() ?? [...this.jobs.values()].find((j) => j.state === 'paused');
    if (!job) return;
    const task = this.tasks.get(job.id);
    if (!task) return;
    try {
      job.checkpoint = task.checkpoint();
      job.checkpointAt = new Date().toISOString();
      this.storage.write(checkpointKey(job.id), JSON.stringify({ id: job.id, kind: job.kind, savedAt: job.checkpointAt, checkpoint: job.checkpoint }));
    } catch {
      /* best effort */
    }
  }

  snapshot(): QueueSnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      jobs: this.order.map((id) => this.jobs.get(id)).filter((j): j is JobRecord => !!j),
      history: this.history,
      counter: this.counter,
    };
  }

  /**
   * Load a queue from storage. Jobs that were `running` when the process died are
   * marked `paused` — they are resumable, but resuming is the caller's decision.
   */
  restore(): { jobs: number; history: number; interrupted: JobRecord[] } {
    const raw = (() => {
      try {
        return this.storage.read(QUEUE_KEY);
      } catch {
        return null;
      }
    })();
    if (!raw) return { jobs: 0, history: 0, interrupted: [] };
    let snapshot: QueueSnapshot;
    try {
      snapshot = JSON.parse(raw) as QueueSnapshot;
    } catch {
      return { jobs: 0, history: 0, interrupted: [] };
    }
    if (snapshot.version !== 1) return { jobs: 0, history: 0, interrupted: [] };
    this.jobs.clear();
    this.order = [];
    this.tasks.clear();
    this.counter = snapshot.counter ?? 0;
    const interrupted: JobRecord[] = [];
    for (const job of snapshot.jobs ?? []) {
      if (job.state === 'running') {
        job.state = 'paused';
        interrupted.push(job);
      }
      this.jobs.set(job.id, job);
      this.order.push(job.id);
      // Reload the freshest checkpoint for jobs that have one on disk.
      try {
        const cp = this.storage.read(checkpointKey(job.id));
        if (cp) {
          const parsed = JSON.parse(cp) as { checkpoint?: unknown };
          if (parsed.checkpoint !== undefined) {
            job.checkpoint = parsed.checkpoint;
            job.checkpointAt = job.checkpointAt;
          }
        }
      } catch {
        /* keep whatever the snapshot carried */
      }
    }
    this.history = snapshot.history ?? [];
    // Merge in history entries that exist on disk but not in the snapshot.
    const known = new Set(this.history.map((h) => h.id));
    for (const key of this.safeList(HISTORY_PREFIX)) {
      if (known.has(key)) continue;
      try {
        const text = this.storage.read(`${HISTORY_PREFIX}${key}`);
        if (text) this.history.push(JSON.parse(text) as HistoryEntry);
      } catch {
        /* skip unreadable entries */
      }
    }
    this.history.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    if (this.history.length > this.options.historyLimit) this.history.length = this.options.historyLimit;
    this.emit({ type: 'restored', jobs: this.jobs.size, history: this.history.length });
    return { jobs: this.jobs.size, history: this.history.length, interrupted };
  }

  /**
   * "Previous job detected … Resume? [Y/N]"
   *
   * Returns the jobs that were interrupted by a crash or a kill, with the
   * information a prompt needs. It never resumes anything by itself.
   */
  detectInterrupted(): Array<{ job: JobRecord; ageMs: number; resumable: boolean; description: string }> {
    const out: Array<{ job: JobRecord; ageMs: number; resumable: boolean; description: string }> = [];
    for (const job of this.jobs.values()) {
      if (job.state !== 'paused' && job.state !== 'cancelled') continue;
      if (job.checkpoint === null && job.state === 'cancelled') continue;
      const when = job.checkpointAt ?? job.finishedAt ?? job.startedAt ?? job.createdAt;
      const age = Date.now() - Date.parse(when);
      out.push({
        job,
        ageMs: Math.max(0, age),
        resumable: job.checkpoint !== null && this.factories.has(job.kind),
        description: `${job.name} (${job.kind}), ${job.progress.tested} unit(s) done, last checkpoint ${formatAge(Math.max(0, age))} ago`,
      });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs);
  }

  /** Resume an interrupted job: rebuild its task from the checkpoint. */
  resumeInterrupted(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.checkpoint === null) return false;
    const task = this.buildTask(job);
    if (!task) return false;
    this.tasks.set(job.id, task);
    job.state = 'queued';
    job.finishedAt = null;
    job.error = null;
    this.cpu = { last: readCpu(), chargedMs: 0 };
    this.sortOrder();
    this.save();
    this.emit({ type: 'resumed', job });
    if (this.activeId === null) this.startNext();
    return true;
  }

  /** Discard a finished or cancelled job's record (and its checkpoint file). */
  forget(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'running') return false;
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.tasks.delete(id);
    try {
      this.storage.remove(checkpointKey(id));
    } catch {
      /* best effort */
    }
    this.save();
    return true;
  }

  /** Number of checkpoint files on disk (a leak check for tests). */
  checkpointsOnDisk(): number {
    return this.safeList(CHECKPOINT_PREFIX).length;
  }

  /** Rebuild a task outside the queue (used by `--resume` on the CLI). */
  buildTaskFor(job: JobRecord): Task | null {
    return this.buildTask(job);
  }

  /** Report the storage backend, for the UI status bar. */
  storageInfo(): { location: string; durable: boolean } {
    return { location: this.storage.location, durable: this.storage.durable };
  }
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)} s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(0)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(0)} day(s)`;
}

/** One-line status for a CLI or a status bar. */
export function queueStatusLine(q: JobQueue): string {
  const p = q.queueProgress();
  const active = p.running;
  if (!active) return `queue: ${p.jobs} job(s), ${p.queuedCount} waiting, ${p.doneCount} done, ${p.failedCount} failed — idle`;
  const pr = active.progress;
  const eta = pr.etaMs !== null ? `${(pr.etaMs / 1000).toFixed(0)} s left` : 'no ETA';
  return `[${active.id}] ${active.name} · ${pr.activity} · ${pr.tested} tested / ${pr.rejected} rejected / ${pr.remaining ?? '?'} remaining · ${eta} · cpu ${(pr.cpuMs / 1000).toFixed(1)} s · ram ${pr.ramMB} MB`;
}

export { formatAge };
