/**
 * Zero-dependency test framework.
 *
 * Deliberately tiny: a registry of named cases, plain assertions that throw,
 * and a TAP-like runner with timings. No globals, no magic — the runner imports
 * every test module explicitly so that a missing file is a compile error, not a
 * silently skipped test.
 */

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
  suite: string;
}

const registry: TestCase[] = [];
let currentSuite = 'default';

export function suite(name: string): void {
  currentSuite = name;
}

export function test(name: string, fn: () => void | Promise<void>): void {
  registry.push({ name, fn, suite: currentSuite });
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message = 'values differ'): void {
  if (actual !== expected) throw new AssertionError(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

export function assertClose(actual: number, expected: number, tol: number, message = 'numbers differ'): void {
  if (!Number.isFinite(actual)) throw new AssertionError(`${message}: got ${actual} (not finite), expected ${expected}`);
  if (Math.abs(actual - expected) > tol) {
    throw new AssertionError(`${message}: expected ${expected} ± ${tol}, got ${actual} (delta ${Math.abs(actual - expected).toExponential(3)})`);
  }
}

/** Relative comparison with an absolute floor. */
export function assertRelative(actual: number, expected: number, relTol: number, absFloor = 1e-12, message = 'numbers differ'): void {
  const tol = Math.max(absFloor, Math.abs(expected) * relTol);
  assertClose(actual, expected, tol, message);
}

export function assertThrows(fn: () => unknown, message = 'expected a throw'): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new AssertionError(message);
}

// ---------------------------------------------------------------------------
// Deterministic RNG for randomised tests (the seed is printed on failure)
// ---------------------------------------------------------------------------

export class TestRng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x9e3779b9) >>> 0;
    let z = this.s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  filter?: string;
  verbose?: boolean;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  failures: Array<{ name: string; error: Error }>;
}

export async function runAll(options: RunOptions = {}): Promise<RunSummary> {
  const t0 = Date.now();
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; error: Error }> = [];
  const filter = options.filter?.toLowerCase();
  for (const t of registry) {
    const full = `${t.suite} :: ${t.name}`;
    if (filter && !full.toLowerCase().includes(filter)) continue;
    const start = Date.now();
    try {
      await t.fn();
      passed++;
      if (options.verbose) console.log(`ok   ${full}  (${Date.now() - start} ms)`);
    } catch (e) {
      failed++;
      const err = e as Error;
      failures.push({ name: full, error: err });
      console.log(`FAIL ${full}`);
      console.log(`     ${err.message.split('\n').join('\n     ')}`);
      if (options.verbose && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
  const ms = Date.now() - t0;
  console.log(`\n${passed} passed, ${failed} failed, ${ms} ms`);
  return { passed, failed, skipped: 0, ms, failures };
}

export function testCount(): number {
  return registry.length;
}

// ---------------------------------------------------------------------------
// Micro-benchmark helper (printed, never asserted: machine-dependent)
// ---------------------------------------------------------------------------

export function bench(name: string, iterations: number, fn: (i: number) => void): number {
  // Warm-up, then measure.
  for (let i = 0; i < Math.min(10, iterations); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`bench ${name}: ${(ms / iterations).toFixed(4)} ms/op over ${iterations} ops (${ms.toFixed(1)} ms total)`);
  return ms;
}
