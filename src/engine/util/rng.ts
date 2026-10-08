/**
 * Deterministic pseudo-random number generation.
 *
 * Reproducibility is a hard requirement: a search must be re-runnable bit for bit.
 * We therefore use a fixed, self-contained, versioned PRNG instead of
 * `Math.random()`:
 *
 *   - `xoshiro128**` (Blackman & Vigna, 2018) — 2^128-1 period, 32-bit output,
 *     fast, small state, passes BigCrush.
 *   - seeded through `splitmix32` so that two nearby seeds produce decorrelated
 *     streams.
 *   - `fork()` derives an independent sub-stream (used to give every worker of a
 *     parallel search its own deterministic stream without coordination).
 *
 * The generator state is serialisable, which is what allows a job to resume
 * exactly where it stopped after a crash.
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

/** Rotate-left for uint32. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** splitmix32: used only to expand a user seed into the xoshiro state. */
function splitmix32(a: number): () => number {
  let state = a >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Rng {
  s0 = 0;
  s1 = 0;
  s2 = 0;
  s3 = 0;

  /** Number of random words drawn; part of the resumable state. */
  draws = 0;

  constructor(seed: number | string = 0x12345678) {
    this.seed(seed);
  }

  seed(seed: number | string): this {
    let s: number;
    if (typeof seed === 'string') s = hashSeed(seed);
    else s = seed >>> 0;
    const sm = splitmix32(s);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    // xoshiro requires a non-zero state.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
    this.draws = 0;
    return this;
  }

  /** Next raw 32-bit unsigned integer. */
  nextUint32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    this.draws++;
    return result;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) return 0;
    // Rejection sampling for an unbiased result.
    const limit = 4294967296 - (4294967296 % n);
    let v = this.nextUint32();
    while (v >= limit) v = this.nextUint32();
    return v % n;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Normal deviate (mean 0, stddev 1) via Box–Muller, no cached spare. */
  normal(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Normal deviate with given mean/stddev. */
  gauss(mean: number, stddev: number): number {
    return mean + stddev * this.normal();
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Weighted index selection (weights need not sum to 1). */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    if (total <= 0) return this.int(weights.length);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * Derive an independent, deterministic sub-stream.
   * Used to give parallel workers disjoint streams from one parent seed.
   */
  fork(label = ''): Rng {
    const a = this.nextUint32();
    const b = this.nextUint32();
    const c = this.nextUint32();
    const d = this.nextUint32();
    return new Rng(hashSeed(`${a.toString(16)}:${b.toString(16)}:${c.toString(16)}:${d.toString(16)}:${label}`));
  }

  /** Serializable state (for job checkpoints). */
  save(): RngState {
    return { s0: this.s0 >>> 0, s1: this.s1 >>> 0, s2: this.s2 >>> 0, s3: this.s3 >>> 0 };
  }

  restore(state: RngState, draws = 0): this {
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
    this.draws = draws;
    return this;
  }

  clone(): Rng {
    const r = new Rng(1);
    r.restore(this.save(), this.draws);
    return r;
  }
}

/** 32-bit string hash used to convert textual seeds into numeric ones. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Convenience: create a generator from a seed of any shape. */
export function makeRng(seed?: number | string): Rng {
  if (seed === undefined) return new Rng(Date.now() >>> 0);
  return new Rng(seed);
}
