/**
 * The benchmark suite: what it measures, and the honesty of what it reports.
 *
 * A benchmark is a claim about the engine, so it is tested the way any other claim
 * is: every case that says it ran must have a positive measured time and a stated
 * scope; a case that could not be measured must say why rather than print zero; a
 * throughput must be a counted unit divided by a measured interval; and a workload
 * that would exhaust the process heap must be refused with the arithmetic shown,
 * because an OOM kill produces no report at all.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import {
  BENCH_SUITES,
  benchmarkToText,
  heapRefusal,
  runBenchmarkSuite,
  type BenchmarkReport,
} from '../../src/engine/bench/index.js';

suite('bench');

/** One small run, shared by the cases below so the suite does not run it five times. */
let shared: Promise<BenchmarkReport> | null = null;
function quickRun(): Promise<BenchmarkReport> {
  if (!shared) {
    shared = runBenchmarkSuite({ suite: 'quick', sizes: [40], repeats: 1, quiet: true, seed: 'bench-test' });
  }
  return shared;
}

test('every suite names its groups and its sizes', () => {
  for (const name of ['quick', 'full', 'scaling', 'stress']) {
    const s = BENCH_SUITES[name];
    assert(s !== undefined, `the "${name}" suite exists`);
    assert(s.groups.length > 0, `"${name}" measures at least one group`);
    assert(s.sizes.length > 0, `"${name}" runs at at least one size`);
    assert(s.note.length > 10, `"${name}" says what it is for`);
  }
  // The stress suite is the one the specification asks for: ten components up to a
  // million, in decades.
  assertEqual(BENCH_SUITES.stress.sizes[0], 10, 'the stress sweep starts at ten components');
  assertEqual(BENCH_SUITES.stress.sizes[BENCH_SUITES.stress.sizes.length - 1], 1_000_000, 'and reaches a million');
});

test('a case that ran carries a measured time and a stated scope', async () => {
  const report = await quickRun();
  assert(report.cases.length >= 8, `the quick suite produced cases (${report.cases.length})`);
  const ran = report.cases.filter((c) => c.ran);
  assert(ran.length >= 6, `most cases ran (${ran.length} of ${report.cases.length})`);
  for (const c of ran) {
    assert(c.bestMs !== null && c.bestMs > 0, `${c.id} measured a positive time (${c.bestMs})`);
    assert(c.what.length > 10, `${c.id} states what was measured: "${c.what}"`);
    assert(c.sizeUnit.length > 0, `${c.id} names the unit its size counts`);
    assertEqual(c.ms.length, c.repeats, `${c.id} kept one time per repeat`);
    if (c.medianMs !== null && c.bestMs !== null) {
      assert(c.medianMs >= c.bestMs, `${c.id}: the median cannot be below the best`);
    }
  }
  assertEqual(
    report.totals.ran + report.totals.failed + report.totals.skipped,
    report.totals.cases,
    'the totals account for every case exactly once',
  );
  assertEqual(report.totals.failed, 0, 'no case failed in a healthy build');
});

test('throughput is a counted unit over a measured interval', async () => {
  const report = await quickRun();
  const logic = report.cases.find((c) => c.group === 'logic' && c.ran);
  assert(logic !== undefined, 'the quick suite measured logic evaluation');
  assert(logic!.rate !== null, 'logic reports a throughput');
  assert(/\/s$/.test(logic!.rateUnit ?? ''), `the throughput unit is per second ("${logic!.rateUnit}")`);
  const elements = Number(logic!.metrics.elements);
  const vectors = Number(logic!.metrics.vectors);
  assert(elements > 0 && vectors > 0, 'the counted units are in the metrics');
  const expected = (elements * vectors * 1000) / (logic!.bestMs ?? 1);
  const drift = Math.abs(expected - (logic!.rate ?? 0)) / expected;
  assert(drift < 0.02, `the quoted rate is the units over the best repeat (drift ${(drift * 100).toFixed(2)} %)`);
});

test('what cannot be measured is reported as not measured, with the reason', async () => {
  const report = await quickRun();
  // Rendering *is* measured now, as far as a headless process honestly can: the
  // layout pass and the draw pass, both of which are real engine work. Rasterising
  // into pixels still is not, and the case must say so rather than implying a frame
  // rate it never observed.
  const layoutCase = report.cases.find((c) => c.id.startsWith('render.layout'));
  assert(layoutCase !== undefined, 'the render group measures sheet layout');
  assertEqual(layoutCase!.ran, true, 'and it ran');
  assert((layoutCase!.bestMs ?? 0) > 0, `with a real time (${layoutCase!.bestMs} ms)`);
  assert((layoutCase!.rate ?? 0) > 0, `and a throughput (${layoutCase!.rate} ${layoutCase!.rateUnit})`);
  assertEqual(layoutCase!.rateUnit, 'blocks/s', 'quoted in blocks per second, not in frames');
  assert(layoutCase!.notes.join(' ').toLowerCase().includes('no pixel'), 'the note says no pixel is produced');

  const drawCase = report.cases.find((c) => c.id.startsWith('render.draw'));
  assert(drawCase !== undefined, 'the draw pass is measured too');
  assertEqual(drawCase!.ran, true, 'and it ran');
  assert((drawCase!.metrics.drawOps as number) > 0, `issuing real drawing operations (${drawCase!.metrics.drawOps})`);
  assert((drawCase!.metrics.svgBytes as number) > 1000, `and writing a document (${drawCase!.metrics.svgBytes} bytes)`);
  const drawNotes = drawCase!.notes.join(' ').toLowerCase();
  assert(drawNotes.includes('rasterisation is not'), `the case states what it does not measure: "${drawCase!.notes[0]}"`);
  assert(!drawNotes.includes('fps') && !drawNotes.includes('frames per second'), 'and claims no frame rate');
  for (const c of [layoutCase!, drawCase!]) assertEqual(c.skipped, null, 'a case that ran is not also marked skipped');

  const gpu = report.cases.find((c) => c.group === 'gpu');
  assert(gpu !== undefined, 'the GPU is probed');
  // Either nothing is offloaded, or a speedup was actually measured. There is no
  // third state where the report claims a GPU it did not benchmark.
  if (report.gpu.enabled) {
    assert(report.gpu.measuredSpeedup > 1.05, `an enabled GPU must show a measured speedup (${report.gpu.measuredSpeedup})`);
  } else {
    assert(gpu!.notes.some((n) => /no speedup|not enabled|disabled/i.test(n)), 'a disabled GPU says that no speedup was measured');
  }
});

test('the engine\'s own profiler reports a split that adds up', async () => {
  const report = await quickRun();
  const profile = report.cases.find((c) => c.group === 'profile');
  assert(profile !== undefined, 'the quick suite includes the internal profiler');
  assert(profile!.ran, `the profiler case ran (${profile!.error ?? ''})`);
  assert(report.profiler !== null, 'the report carries the profiler output');
  const phases = report.profiler!.phases;
  assert(phases.length >= 3, `the engine instrumented several phases (${phases.length})`);
  const names = phases.map((p) => p.name);
  assert(names.includes('netlist.flatten'), 'netlist construction is instrumented');
  assert(names.includes('logic.settle'), 'level-0 evaluation is instrumented');
  assert(names.includes('sim.dc'), 'the DC solve is instrumented');
  const percentKeys = Object.keys(profile!.metrics).filter((k) => k.endsWith('.percent'));
  assertEqual(percentKeys.length, Math.min(12, phases.length), 'every phase got a share in the metrics');
  const sum = percentKeys.reduce((a, k) => a + Number(profile!.metrics[k]), 0);
  assert(sum > 95 && sum < 102, `the shares of self time add up to about 100 % (${sum.toFixed(1)} %)`);
});

test('the size sweep refuses a workload that cannot fit, showing the arithmetic', () => {
  const gib = 1024 * 1024 * 1024;
  // Nothing measured yet: nothing is refused, because refusing on a guess would be
  // worse than trying.
  assertEqual(heapRefusal(1_000_000, null, 2 * gib), null, 'no estimate, no refusal');
  assertEqual(heapRefusal(1_000_000, 5000, null), null, 'no observable ceiling, no refusal');
  // 1 M components at 5 KiB each, ×2 safety, against a 2 GiB heap: refused, and the
  // reason carries the numbers a reader can check.
  const refused = heapRefusal(1_000_000, 5000, 2 * gib);
  assert(refused !== null, 'a workload twice the heap is refused');
  assert(/heap/.test(refused!), 'the reason names the heap');
  assert(/per component/.test(refused!), 'the reason quotes the measured cost per component');
  assert(/max-old-space-size/.test(refused!), 'and the remedy');
  // The same workload fits when the process is given the memory for it.
  assertEqual(heapRefusal(1_000_000, 5000, 64 * gib), null, 'with 64 GiB of heap the same size runs');
  // A small workload is never refused.
  assertEqual(heapRefusal(1000, 5000, 2 * gib), null, 'a thousand components always fits');
});

test('the sweep measures what a size costs end to end', async () => {
  const report = await runBenchmarkSuite({ suite: 'scaling', sizes: [200, 800], repeats: 1, quiet: true, seed: 'bench-sweep' });
  assertEqual(report.scaling.length, 2, 'both sizes were attempted');
  for (const row of report.scaling) {
    assert(row.ok, `the ${row.components}-component round trip came back intact (${row.note ?? 'ok'})`);
    assert(row.buildMs > 0 && row.flattenMs > 0 && row.logicMs > 0 && row.serializeMs > 0, `every phase of ${row.components} was timed`);
    assert(row.elements >= row.components, `the flattened netlist carries every gate (${row.elements})`);
    assert(row.bytes > row.components * 100, `the serialised form has a plausible size (${row.bytes} bytes)`);
    assert(row.eventsPerSecond !== null && row.eventsPerSecond > 0, 'throughput was computed');
  }
  // Cost must grow with size; a sweep where the big size is faster than the small
  // one is measuring noise, not the engine.
  const small = report.scaling[0];
  const big = report.scaling[1];
  assert(big.buildMs > small.buildMs, `building ${big.components} costs more than ${small.components}`);
  assert(big.serializeMs > small.serializeMs, 'and so does serialising it');
});

test('the text report carries the claim, the environment and every case', async () => {
  const report = await quickRun();
  const text = benchmarkToText(report);
  assert(text.includes('BENCHMARK'), 'the report is titled');
  assert(/MEASURED ON THIS MACHINE/i.test(text), 'and it states the scope of its claim');
  assert(text.includes(report.environment.platform), 'the machine is named');
  assert(/OPTIMAL|FASTEST/.test(text) === false, 'no unscoped superlative anywhere in the report');
  for (const c of report.cases) {
    assert(text.includes(c.id), `case ${c.id} appears in the text`);
  }
  assert(text.includes('not measured'), 'a case that did not run is visible as such');
  assert(text.includes('REPRODUCIBILITY'), 'the seed and sizes are reported');
  assert(text.includes(report.reproducibility.seed), 'including the seed itself');
});
