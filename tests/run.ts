/**
 * Test runner entry point.
 *
 * Every test module is imported explicitly (a renamed or deleted file must be a
 * compile error, never a silently skipped test). Usage:
 *   node dist/tests/run.js [--filter=substring] [--verbose]
 */

import { runAll, testCount } from './framework.js';

import './unit/matrix.test.js';
import './sim/dc.test.js';
import './sim/devices.test.js';
import './sim/cmos.test.js';
import './sim/thermal.test.js';
import './sim/transient.test.js';
import './core/hierarchy.test.js';
import './core/chip-params.test.js';
import './synthesis/reference.test.js';
import './synthesis/examples.test.js';
import './io/serialize.test.js';
import './export/export.test.js';
import './analysis/logic.test.js';
import './analysis/timing.test.js';
import './analysis/analyze.test.js';
import './analysis/stats.test.js';
import './analysis/tech.test.js';
import './validate/validation.test.js';
import './jobs/queue.test.js';
import './optim/optimizer.test.js';
import './instruments/instruments.test.js';
import './bench/benchmark.test.js';
import './core/builder-scale.test.js';
import './render/render.test.js';
import './ui/editor.test.js';
import './server/server.test.js';

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith('--filter='))?.slice('--filter='.length);
const verbose = args.includes('--verbose');

const summary = await runAll({ filter, verbose });
if (summary.passed + summary.failed < testCount()) {
  console.log(`note: ${testCount() - summary.passed - summary.failed} case(s) filtered out`);
}
process.exitCode = summary.failed === 0 ? 0 : 1;
