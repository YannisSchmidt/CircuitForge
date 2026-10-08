/**
 * The job queue: priority, pause/resume/cancel, reordering, persistence, crash
 * detection and history.
 *
 * The queue is cooperative, so every case here drives it explicitly with `tick()`
 * or `pump()` and asserts on exact step boundaries — that is what makes the
 * pause/resume and checkpoint behaviour testable at all.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { JobQueue, queueStatusLine } from '../../src/engine/jobs/queue.js';
import { MemoryStorage, FileStorage, QUEUE_KEY, checkpointKey } from '../../src/engine/jobs/storage.js';
import { registerDefaultTasks, makeContext, OptimizeTask, ValidateTask } from '../../src/engine/jobs/tasks.js';
import { emptyProgress, type JobProgress, type JobRecord, type QueueSnapshot, type Task } from '../../src/engine/jobs/types.js';
import { builder, AMBIENT } from '../sim/helpers.js';
import { circuitToDocument } from '../../src/engine/io/serialize.js';
import type { JobKind } from '../../src/engine/jobs/types.js';

suite('job queue');

/** A task that counts to `n`, one unit per step, and checkpoints its counter. */
class CounterTask implements Task {
  readonly kind: JobKind = 'simulate';
  readonly name: string;
  private i = 0;
  private n: number;
  /** Set to make one step throw, for the failure path. */
  failAt = -1;
  steps = 0;

  constructor(n: number, name = 'counter', checkpoint?: unknown) {
    this.n = n;
    this.name = name;
    if (checkpoint && typeof checkpoint === 'object') this.i = Number((checkpoint as { i?: number }).i ?? 0);
  }

  totalWork(): number | null {
    return this.n;
  }
  step(): boolean {
    this.steps++;
    if (this.failAt === this.i) throw new Error(`deliberate failure at unit ${this.i}`);
    this.i++;
    return this.i >= this.n;
  }
  progress(): JobProgress {
    return { ...emptyProgress(), tested: this.i, rejected: 0, remaining: Math.max(0, this.n - this.i), fraction: this.i / this.n, activity: `unit ${this.i}/${this.n}` };
  }
  result(): unknown {
    return { counted: this.i, of: this.n };
  }
  summary(): string {
    return `counted ${this.i} of ${this.n}`;
  }
  checkpoint(): unknown {
    return { i: this.i };
  }
}

/** A queue pre-loaded with counter tasks of a given length. */
function counterQueue(opts: { n?: number; storage?: MemoryStorage } = {}): { q: JobQueue; storage: MemoryStorage } {
  const storage = opts.storage ?? new MemoryStorage();
  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 0 });
  q.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? opts.n ?? 5), String(spec.name ?? 'counter'), cp));
  return { q, storage };
}

test('a queued job runs to completion, one step at a time', () => {
  const { q } = counterQueue({ n: 4 });
  const job = q.enqueue('simulate', 'four steps', { n: 4 });
  assertEqual(job.state, 'running', 'the job starts immediately on an idle queue');
  let steps = 0;
  while (q.tick()) steps++;
  assertEqual(steps, 4, 'exactly one step per work unit');
  assertEqual(q.get(job.id)!.state, 'done', 'the job finished');
  assertEqual(q.idle(), true, 'the queue is idle');
  const r = q.get(job.id)!.result as { counted: number };
  assertEqual(r.counted, 4, 'the result is the measured one');
  assertEqual(q.get(job.id)!.summary, 'counted 4 of 4', 'the summary comes from the task');
});

test('progress carries measured counters, a rate and an ETA', () => {
  const { q } = counterQueue({ n: 6 });
  const job = q.enqueue('simulate', 'six', { n: 6 });
  q.tick();
  q.tick();
  const p = q.get(job.id)!.progress;
  assertEqual(p.tested, 2, 'two units tested');
  assertEqual(p.remaining, 4, 'four left');
  assert(p.fraction !== null && Math.abs(p.fraction! - 1 / 3) < 1e-9, `the fraction is 2/6 (${p.fraction})`);
  assert(Number.isFinite(p.elapsedMs) && p.elapsedMs >= 0, 'elapsed time is measured');
  assert(Number.isFinite(p.ramMB), 'heap usage is read from the runtime');
  assert(p.activity.includes('unit'), 'the activity describes the current work');
  assertEqual(p.gpu, null, 'no GPU figure is invented when no GPU backend is enabled');
});

test('pump() stops at the time slice and resumes where it left off', () => {
  // A million units, not a thousand: a counter step is so cheap that a 5 ms slice
  // finishes a thousand of them, which made this case pass or fail on the speed
  // of the machine running it.
  const { q } = counterQueue({ n: 1_000_000 });
  q.enqueue('simulate', 'long', { n: 1_000_000 });
  const a = q.pump(5);
  assert(a > 0, 'the pump ran some steps');
  const done = q.get(q.ids()[0])!.progress.tested;
  assertEqual(done, a, 'every pumped step advanced the task by one unit');
  const b = q.pump(5);
  assert(b > 0, 'pumping again continues');
  assert(q.get(q.ids()[0])!.progress.tested > done, 'progress moved on');
  q.requestStop();
  const c = q.pump(Infinity);
  assertEqual(c, 0, 'a stop requested before the pump means the pump does nothing');
  assertEqual(q.get(q.ids()[0])!.state, 'running', 'the job is still running: the stop did not cancel it');
  const d = q.pump(5);
  assert(d > 0, 'the flag was consumed: the next pump runs again');
  q.cancel(q.ids()[0]);
});

test('higher priority runs first; ties keep insertion order', () => {
  const { q } = counterQueue({ n: 1 });
  const order: string[] = [];
  // The listener is attached first: `enqueue` starts a job immediately on an idle
  // queue, so a listener attached afterwards would miss the first 'started'.
  q.onChange((e) => {
    if (e.type === 'started') order.push(e.job.name);
  });
  // The first job occupies the queue, so the others stay queued.
  q.enqueue('simulate', 'busy', { n: 3 });
  const low = q.enqueue('simulate', 'low', { n: 1 }, { priority: 0 });
  const high = q.enqueue('simulate', 'high', { n: 1 }, { priority: 10 });
  const mid = q.enqueue('simulate', 'mid', { n: 1 }, { priority: 5 });
  assertEqual(q.queued()[0].id, high.id, 'priority 10 is next');
  assertEqual(q.queued()[1].id, mid.id, 'priority 5 follows');
  assertEqual(q.queued()[2].id, low.id, 'priority 0 last');
  while (q.tick()) void 0;
  assertEqual(order.join(','), 'busy,high,mid,low', 'execution followed the priority order');
});

test('setPriority re-orders a waiting job', () => {
  const { q } = counterQueue({ n: 2 });
  q.enqueue('simulate', 'busy', { n: 2 });
  const a = q.enqueue('simulate', 'a', { n: 1 }, { priority: 0 });
  const b = q.enqueue('simulate', 'b', { n: 1 }, { priority: 0 });
  assertEqual(q.queued()[0].id, a.id, 'a was first');
  q.setPriority(b.id, 7);
  assertEqual(q.queued()[0].id, b.id, 'b jumped ahead');
  assertEqual(q.get(a.id)!.priority, 0, 'a kept its priority');
});

test('pause stops the job, resume continues from the same unit', () => {
  const { q } = counterQueue({ n: 6 });
  const job = q.enqueue('simulate', 'pausable', { n: 6 });
  q.tick();
  q.tick();
  assert(q.pause(job.id), 'the job paused');
  assertEqual(q.get(job.id)!.state, 'paused', 'the state is paused');
  assertEqual(q.tick(), false, 'a paused queue does no work');
  assertEqual(q.get(job.id)!.progress.tested, 2, 'no work happened while paused');
  assert(q.resume(job.id), 'the job resumed');
  let steps = 0;
  while (q.tick()) steps++;
  assertEqual(steps, 4, 'only the remaining four units ran');
  assertEqual((q.get(job.id)!.result as { counted: number }).counted, 6, 'the job completed all six units');
});

test('a queued job can be paused before it ever starts', () => {
  const { q } = counterQueue({ n: 2 });
  q.enqueue('simulate', 'busy', { n: 2 });
  const later = q.enqueue('simulate', 'later', { n: 2 });
  assert(q.pause(later.id), 'a queued job pauses');
  assertEqual(later.state, 'paused', 'it is paused');
  while (q.tick()) void 0;
  assertEqual(q.get(later.id)!.state, 'paused', 'it never ran');
  assertEqual(q.get(later.id)!.progress.tested, 0, 'no work was done');
});

test('cancel drops a running job and starts the next one', () => {
  const { q } = counterQueue({ n: 5 });
  const a = q.enqueue('simulate', 'a', { n: 5 });
  const b = q.enqueue('simulate', 'b', { n: 2 });
  q.tick();
  assert(q.cancel(a.id), 'the job cancelled');
  assertEqual(q.get(a.id)!.state, 'cancelled', 'the state is cancelled');
  assertEqual(q.active()?.id, b.id, 'the next job started');
  while (q.tick()) void 0;
  assertEqual(q.get(b.id)!.state, 'done', 'the surviving job finished');
  assert(q.historyEntries().some((h) => h.id === a.id && h.state === 'cancelled'), 'the cancelled job is in the history');
});

test('reorder moves a waiting job without touching the running one', () => {
  const { q } = counterQueue({ n: 2 });
  q.enqueue('simulate', 'busy', { n: 2 });
  const a = q.enqueue('simulate', 'a', { n: 1 });
  const b = q.enqueue('simulate', 'b', { n: 1 });
  const c = q.enqueue('simulate', 'c', { n: 1 });
  assertEqual(q.queued().map((j) => j.name).join(','), 'a,b,c', 'insertion order');
  assert(q.reorder(c.id, 0), 'c moved to the front');
  assertEqual(q.queued().map((j) => j.name).join(','), 'c,a,b', 'the new order');
  assertEqual(q.reorder(q.active()!.id, 0), false, 'the running job cannot be reordered');
  assertEqual(q.reorder('nope', 0), false, 'an unknown id is rejected');
});

test('a throwing task fails the job and the queue carries on', () => {
  const storage = new MemoryStorage();
  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 0 });
  const broken = new CounterTask(4, 'broken');
  broken.failAt = 2;
  q.register('simulate', (spec) => (spec.broken ? broken : new CounterTask(Number(spec.n ?? 2))));
  const a = q.enqueue('simulate', 'will fail', { broken: true });
  const b = q.enqueue('simulate', 'fine', { n: 2 });
  while (q.tick()) void 0;
  assertEqual(q.get(a.id)!.state, 'failed', 'the job failed');
  assert(q.get(a.id)!.error!.includes('deliberate failure'), `the error is the thrown message (${q.get(a.id)!.error})`);
  assertEqual(q.get(b.id)!.state, 'done', 'the next job still ran');
  assertEqual(q.queueProgress().failedCount, 1, 'the failure is counted');
});

test('enqueueing an unregistered kind is an error, not a silent no-op', () => {
  const { q } = counterQueue();
  let threw = '';
  try {
    q.enqueue('optimize', 'no factory', {});
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes('no task factory'), `the error explains the problem (${threw})`);
  assertEqual(q.ids().length, 0, 'nothing was enqueued');
});

test('the queue persists, and a fresh queue restores jobs and history', () => {
  const storage = new MemoryStorage();
  const a = counterQueue({ storage });
  a.q.enqueue('simulate', 'long', { n: 50 });
  for (let i = 0; i < 5; i++) a.q.tick();
  a.q.save();
  assert(storage.read(QUEUE_KEY) !== null, 'the queue document exists');

  const b = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 0 });
  b.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? 5), String(spec.name ?? 'counter'), cp));
  const res = b.restore();
  assertEqual(res.jobs, 1, 'one job restored');
  const job = b.get(b.ids()[0])!;
  assertEqual(job.name, 'long', 'the job kept its name');
  assertEqual(job.state, 'paused', 'a job that was running is restored paused, not silently restarted');
  const interrupted = b.detectInterrupted();
  assertEqual(interrupted.length, 1, 'the interrupted job is detected');
  assert(interrupted[0].resumable, 'it is resumable');
  assert(interrupted[0].description.includes('long'), 'the prompt text names the job');
});

test('a crashed run is offered back and resumes from its checkpoint', () => {
  const storage = new MemoryStorage();
  // Simulate a crash: the snapshot says "running", and a checkpoint exists.
  const snapshot: QueueSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    engineVersion: 'test',
    jobs: [
      {
        id: 'simulate-crash-1',
        kind: 'simulate',
        name: 'crashed',
        state: 'running',
        priority: 0,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        pausedMs: 0,
        steps: 3,
        progress: { ...emptyProgress(), tested: 3 },
        error: null,
        summary: null,
        spec: { n: 10 },
        checkpoint: null,
        checkpointAt: null,
        result: null,
      },
    ],
    history: [],
    counter: 1,
  };
  storage.write(QUEUE_KEY, JSON.stringify(snapshot));
  storage.write(checkpointKey('simulate-crash-1'), JSON.stringify({ id: 'simulate-crash-1', kind: 'simulate', savedAt: new Date().toISOString(), checkpoint: { i: 3 } }));

  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 0 });
  let created: CounterTask | null = null;
  q.register('simulate', (spec, cp) => {
    created = new CounterTask(Number(spec.n ?? 10), 'crashed', cp);
    return created;
  });
  const res = q.restore();
  assertEqual(res.interrupted.length, 1, 'the crashed job was detected');
  const prompt = q.detectInterrupted();
  assertEqual(prompt.length, 1, 'one job is offered back');
  assert(prompt[0].description.includes('crashed'), 'the prompt names it');
  assert(q.resumeInterrupted('simulate-crash-1'), 'the job resumed');
  let steps = 0;
  while (q.tick()) steps++;
  assertEqual(steps, 7, 'only the remaining seven units ran, not ten');
  assertEqual(created!.steps, 7, 'the rebuilt task did not redo the checkpointed work');
  assertEqual((q.get('simulate-crash-1')!.result as { counted: number }).counted, 10, 'the job completed');
});

test('a corrupt queue document is ignored instead of crashing the start-up', () => {
  const storage = new MemoryStorage();
  storage.write(QUEUE_KEY, '{ this is not json');
  const q = new JobQueue(storage);
  q.register('simulate', () => new CounterTask(1));
  const res = q.restore();
  assertEqual(res.jobs, 0, 'nothing was restored');
  assertEqual(q.ids().length, 0, 'the queue is empty and usable');
  q.enqueue('simulate', 'works', { n: 1 });
  while (q.tick()) void 0;
  assertEqual(q.queueProgress().doneCount, 1, 'the queue still works');
});

test('a snapshot from a future version is refused rather than mis-read', () => {
  const storage = new MemoryStorage();
  storage.write(QUEUE_KEY, JSON.stringify({ version: 99, savedAt: '', engineVersion: '', jobs: [], history: [], counter: 0 }));
  const q = new JobQueue(storage);
  q.register('simulate', () => new CounterTask(1));
  assertEqual(q.restore().jobs, 0, 'an unknown version restores nothing');
});

test('checkpoints are written on the step count and on the timer', () => {
  const storage = new MemoryStorage();
  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 3 });
  q.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? 10), 'cp', cp));
  const job = q.enqueue('simulate', 'cp', { n: 10 });
  assertEqual(storage.read(QUEUE_KEY), null, 'nothing is written before the threshold');
  q.tick();
  q.tick();
  assertEqual(q.checkpointsOnDisk(), 0, 'no checkpoint yet');
  q.tick();
  assert(q.checkpointsOnDisk() >= 1, 'the checkpoint landed on the third step');
  const doc = JSON.parse(storage.read(checkpointKey(job.id))!) as { checkpoint: { i: number } };
  assertEqual(doc.checkpoint.i, 3, 'the checkpoint carries the counter');
});

test('history keeps finished jobs, newest first, and can be cleared', () => {
  const { q } = counterQueue({ n: 1 });
  q.enqueue('simulate', 'one', { n: 1 });
  q.enqueue('simulate', 'two', { n: 1 });
  while (q.tick()) void 0;
  const h = q.historyEntries();
  assertEqual(h.length, 2, 'both jobs are in the history');
  assert(h.every((e) => e.state === 'done'), 'both finished');
  assert(h[0].finishedAt! >= h[1].finishedAt!, 'newest first');
  assertEqual(q.clearHistory(), 2, 'clearing returns the count');
  assertEqual(q.historyEntries().length, 0, 'the history is empty');
});

test('forget() removes a finished job and its checkpoint file', () => {
  const storage = new MemoryStorage();
  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 1 });
  q.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? 2), 'f', cp));
  const job = q.enqueue('simulate', 'f', { n: 2 });
  while (q.tick()) void 0;
  assertEqual(q.forget(job.id), true, 'the job was forgotten');
  assertEqual(q.get(job.id), undefined, 'the record is gone');
  assertEqual(q.forget(job.id), false, 'forgetting twice is a no-op');
  assertEqual(q.forget('running-nope'), false, 'an unknown id is rejected');
});

test('the status line reports the active job with its measured numbers', () => {
  const { q } = counterQueue({ n: 4 });
  q.enqueue('simulate', 'status', { n: 4 });
  q.tick();
  const line = queueStatusLine(q);
  assert(line.includes('status'), 'the line names the job');
  assert(/tested/.test(line), 'the line reports tested units');
  assert(/remaining/.test(line), 'the line reports remaining units');
  assert(/ram/.test(line), 'the line reports memory');
  while (q.tick()) void 0;
  assert(queueStatusLine(q).includes('idle'), 'an empty queue says it is idle');
});

test('listeners see the whole lifecycle, and a broken one does not break the queue', () => {
  const { q } = counterQueue({ n: 2 });
  const seen: string[] = [];
  q.onChange((e) => seen.push(e.type));
  q.onChange(() => {
    throw new Error('a listener that throws');
  });
  const job = q.enqueue('simulate', 'l', { n: 2 });
  q.tick();
  q.pause(job.id);
  q.resume(job.id);
  while (q.tick()) void 0;
  assert(seen.includes('enqueued'), 'enqueued emitted');
  assert(seen.includes('started'), 'started emitted');
  assert(seen.includes('progress'), 'progress emitted');
  assert(seen.includes('paused'), 'paused emitted');
  assert(seen.includes('resumed'), 'resumed emitted');
  assert(seen.includes('finished'), 'finished emitted');
  assertEqual(q.get(job.id)!.state, 'done', 'the job still finished despite the throwing listener');
});

// ---------------------------------------------------------------------------
// Real jobs
// ---------------------------------------------------------------------------

function smallCircuit() {
  const { b, lib, chips } = builder('job-circuit');
  b.port('A0', 'input', 'a', 1);
  b.port('B0', 'input', 'b', 1);
  b.port('Y0', 'output', 'y', 1);
  const inv = b.add('not_gate', { inputs: 1, tphl: 1.2e-9, tplh: 1.4e-9 }, [0, 0]);
  const and = b.add('and_gate', { inputs: 2, tphl: 1.2e-9, tplh: 1.4e-9 }, [60, 0]);
  b.at(inv, 'IN1', 'b').at(inv, 'OUT', 'nb');
  b.at(and, 'IN1', 'a').at(and, 'IN2', 'nb').at(and, 'OUT', 'y');
  return { circuit: b.finish({ erc: false }), lib, chips };
}

test('an optimize job runs generations, checkpoints and reports its scope', () => {
  const ctx = makeContext();
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const job = q.enqueue(
    'optimize',
    'optimize and_not_2',
    { specId: 'and_not', params: { bits: 2 }, profile: 'FASTEST', populationSize: 8, generations: 3, detailTop: 0, seed: 'job-test' },
  );
  let guard = 0;
  while (q.tick() && guard++ < 200) void 0;
  assert(guard < 200, 'the job terminated');
  const rec = q.get(job.id)! as JobRecord;
  assertEqual(rec.state, 'done', `the job finished (${rec.error ?? ''})`);
  assert(rec.progress.tested > 0, 'candidates were evaluated');
  const result = rec.result as { report: { claim: string; best: unknown; searchSpace: { generations: number } }; whyText: string | null };
  assertEqual(result.report.claim, 'BEST FOUND UNDER CURRENT CONSTRAINTS', 'the exact claim wording');
  assert(result.report.best !== null, 'a best candidate exists');
  assertEqual(result.report.searchSpace.generations >= 3, true, 'at least the requested generations ran');
  const cp = rec.checkpoint as { version: number; generation: number };
  assertEqual(cp.version, 1, 'the checkpoint is an optimizer snapshot');
  assert(cp.generation >= 3, 'the checkpoint carries the generation count');
  assert(rec.summary!.includes('BEST FOUND'), 'the summary quotes the claim');
  // The task itself is reconstructible from the spec — that is what a resume does.
  const rebuilt = new OptimizeTask({ specId: 'and_not', params: { bits: 2 }, populationSize: 8, generations: 3, seed: 'job-test' }, cp, ctx);
  assertEqual(rebuilt.describe().includes('and_not_2'), true, 'the rebuilt task knows its specification');
  assert(OptimizeTask.knownSpecs().includes('adder'), 'the catalogue is exposed');
});

test('an optimize job resumes from a checkpoint without redoing generations', () => {
  const ctx = makeContext();
  const spec = { specId: 'and_not', params: { bits: 2 }, populationSize: 8, generations: 6, detailTop: 0, seed: 'resume-test' };
  const first = new OptimizeTask(spec as never, null, ctx);
  first.step();
  first.step();
  const cp = first.checkpoint();
  const genAfterTwo = (cp as { generation: number }).generation;
  assertEqual(genAfterTwo, 2, 'two steps ran two generations');
  const resumed = new OptimizeTask(spec as never, cp, ctx);
  assertEqual(resumed.progress().tested, first.progress().tested, 'the resumed task reports the same number of evaluations');
  let steps = 0;
  while (!resumed.step() && steps < 50) steps++;
  assertEqual(steps, 4, 'only the four remaining generations ran');
  const result = resumed.result() as { report: { searchSpace: { generations: number } } };
  assert(result.report.searchSpace.generations >= 6, 'the resumed run reached the target');
});

test('a validate job steps one check at a time and returns the report', () => {
  const { circuit, lib, chips } = smallCircuit();
  const ctx = makeContext();
  // A job spec is JSON, so the circuit must survive a serialise/parse round trip.
  const doc = JSON.parse(JSON.stringify(circuitToDocument(circuit))) as never;
  void lib;
  void chips;
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const job = q.enqueue('validate', 'validate and_not', {
    circuit: doc,
    specId: 'and_not',
    params: { bits: 1 },
    ambient: AMBIENT,
  });
  const seen: number[] = [];
  let guard = 0;
  while (!q.get(job.id)!.state.match(/done|failed/) && guard++ < 100) {
    q.tick();
    seen.push(q.get(job.id)!.progress.tested + q.get(job.id)!.progress.rejected);
  }
  const rec = q.get(job.id)!;
  assertEqual(rec.state, 'done', `the validation job finished (${rec.error ?? ''})`);
  const result = rec.result as { report: { claim: string; totals: { passed: number; failed: number } }; text: string };
  assertEqual(result.report.claim, 'VALIDATED UNDER THE STATED CONDITIONS', `the verdict (${result.report.totals.failed} failure(s))`);
  assert(result.text.includes('PASS'), 'the text report came back through the job');
  assert(rec.summary!.includes('VALIDATED'), 'the summary quotes the claim');
  // The checkpoint records how far the session got.
  const cp = rec.checkpoint as { totalChecks: number };
  assert(cp.totalChecks >= 8, 'the checkpoint knows the planned check count');
  const rebuilt = new ValidateTask({ circuit: doc, specId: 'and_not', params: { bits: 1 } } as never, cp, ctx);
  assertEqual(rebuilt.totalWork(), cp.totalChecks, 'the rebuilt task plans the same checks');
});

test('analyze, simulate and export jobs run through the same queue', () => {
  const { circuit } = smallCircuit();
  const ctx = makeContext();
  const doc = circuitToDocument(circuit);
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const a = q.enqueue('analyze', 'analyze', { circuit: doc, ambient: AMBIENT });
  const s = q.enqueue('simulate', 'dc', { circuit: doc, mode: 'dc', ambient: AMBIENT });
  const e = q.enqueue('export', 'export', { circuit: doc, artefacts: ['bom', 'circuit'] });
  let guard = 0;
  while (!q.idle() && guard++ < 500) q.pump(20);
  assert(guard < 500, 'all three jobs terminated');
  assertEqual(q.get(a.id)!.state, 'done', `analyze finished (${q.get(a.id)!.error})`);
  assertEqual(q.get(s.id)!.state, 'done', `simulate finished (${q.get(s.id)!.error})`);
  assertEqual(q.get(e.id)!.state, 'done', `export finished (${q.get(e.id)!.error})`);
  const an = q.get(a.id)!.result as { report: { findings: unknown[] } };
  assert(Array.isArray(an.report.findings), 'the analyzer report came back');
  const sim = q.get(s.id)!.result as { points: Array<{ converged: boolean }> };
  assertEqual(sim.points.length, 1, 'one DC point');
  assertEqual(sim.points[0].converged, true, 'the DC solve converged');
  const exp = q.get(e.id)!.result as { produced: Record<string, string> };
  assert(exp.produced.bomCsv.length > 0, 'a BOM was produced');
  assert(exp.produced.circuit.includes('circuitforge.circuit'), 'the circuit document was produced');
});

test('a sweep job runs every point and reports a finite value for each', () => {
  const { circuit } = smallCircuit();
  const ctx = makeContext();
  const doc = circuitToDocument(circuit);
  // Sweep a parameter of a component that really exists, found by its own ref.
  const target = circuit.allComponents()[1];
  assert(!!target, 'the circuit has a second component to sweep');
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const job = q.enqueue('simulate', 'sweep', {
    circuit: doc,
    mode: 'sweep',
    ambient: AMBIENT,
    sweep: { ref: target.ref, param: 'tphl', from: 0.5e-9, to: 2e-9, steps: 4 },
  });
  let guard = 0;
  while (!q.get(job.id)!.state.match(/done|failed/) && guard++ < 50) q.tick();
  const rec = q.get(job.id)!;
  assertEqual(rec.state, 'done', `the sweep finished (${rec.error})`);
  const result = rec.result as { points: Array<{ value: number; converged: boolean }> };
  assertEqual(result.points.length, 5, 'five sweep points: index 0..steps inclusive');
  assert(result.points.every((p) => Number.isFinite(p.value)), 'every point has a finite parameter value');
  assert(result.points.every((p) => p.converged), 'every point converged');
  const cp = rec.checkpoint as { index: number };
  assert(cp.index >= 5, `the checkpoint recorded the sweep position (${cp.index})`);
});

test('a job whose spec names no circuit fails cleanly with an explanation', () => {
  const ctx = makeContext();
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const job = q.enqueue('simulate', 'no circuit', { mode: 'dc' });
  q.tick();
  const rec = q.get(job.id)!;
  assertEqual(rec.state, 'failed', 'the job failed');
  assert(rec.error!.includes('names no circuit'), `the error explains what is missing (${rec.error})`);
});

test('a job referencing an unknown specification id is refused', () => {
  const ctx = makeContext();
  const q = new JobQueue(new MemoryStorage(), { autoSaveMs: 0, autoSaveSteps: 0 });
  registerDefaultTasks(q, ctx);
  const job = q.enqueue('optimize', 'bad spec', { specId: 'not_a_spec' });
  q.tick();
  assertEqual(q.get(job.id)!.state, 'failed', 'the job failed');
  assert(q.get(job.id)!.error!.includes('unknown design specification'), 'the error names the problem');
  assert(q.get(job.id)!.error!.includes('adder'), 'the error lists the known ids');
});

test('file-backed storage writes atomically and survives a queue rebuild', () => {
  const dir = `.circuitforge-cache/test-jobs-${Date.now()}`;
  let storage: FileStorage;
  try {
    storage = new FileStorage(dir);
  } catch {
    return; // no Node fs in this runtime: the memory cases above already cover the logic
  }
  assertEqual(storage.durable, true, 'the file store is durable');
  const q = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 2 });
  q.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? 5), 'file', cp));
  const job = q.enqueue('simulate', 'file', { n: 6 });
  q.tick();
  q.tick();
  assert(storage.read(QUEUE_KEY) !== null, 'the queue document is on disk');
  const q2 = new JobQueue(storage, { autoSaveMs: 0, autoSaveSteps: 0 });
  q2.register('simulate', (spec, cp) => new CounterTask(Number(spec.n ?? 5), 'file', cp));
  const res = q2.restore();
  assertEqual(res.jobs, 1, 'the job came back from disk');
  assertEqual(q2.get(job.id)!.progress.tested >= 2, true, 'the persisted progress is at least what ran');
  storage.remove(QUEUE_KEY);
  storage.remove(checkpointKey(job.id));
});

