/**
 * Stable hashing utilities.
 *
 * Two purposes:
 *  1. Fingerprinting a circuit / netlist / genome so that identical structures are
 *     recognised (search cache, deduplication, export manifests).
 *  2. Fast key generation for hash maps in hot paths (no string allocation).
 *
 * `fnv1a64Hex` is *not* a cryptographic hash and must not be used for security.
 * It is used only for identity/dedup; the collision probability for the sizes we
 * handle (< 10^9 items) is negligible (~2^-64 per pair).
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over a UTF-8 string, returned as 16 hex chars. */
export function fnv1a64Hex(input: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // Encode as UTF-8 bytes without allocating a Buffer.
    if (c < 0x80) {
      h = ((h ^ BigInt(c)) * FNV_PRIME) & MASK64;
    } else if (c < 0x800) {
      h = ((h ^ BigInt(0xc0 | (c >> 6))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | (c & 0x3f))) * FNV_PRIME) & MASK64;
    } else {
      h = ((h ^ BigInt(0xe0 | (c >> 12))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | ((c >> 6) & 0x3f))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | (c & 0x3f))) * FNV_PRIME) & MASK64;
    }
  }
  return h.toString(16).padStart(16, '0');
}

/** 32-bit FNV-1a; used where a numeric key is needed. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (input.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Streaming structural hash. Feeds bytes/ints/strings into a 128-bit state
 * (four independent 32-bit lanes) using a fast integer mix.
 */
export class StructuralHash {
  private a = 0x9e3779b9;
  private b = 0x85ebca6b;
  private c = 0xc2b2ae35;
  private d = 0x27d4eb2f;
  private n = 0;

  uint32(x: number): this {
    const v = x >>> 0;
    let a = (this.a ^ v) >>> 0;
    a = Math.imul(a ^ (a >>> 16), 0x7feb352d) >>> 0;
    this.a = a;
    let b = (this.b + v + this.n) >>> 0;
    b = Math.imul(b ^ (b >>> 15), 0x846ca68b) >>> 0;
    this.b = b;
    this.c = (Math.imul(this.c ^ (v * 0x9e3779b1), 0x85ebca6b) >>> 0) ^ (this.c >>> 3);
    this.d = (Math.imul(this.d + (v ^ (v >>> 13)), 0xc2b2ae35) >>> 0) ^ (this.d << 5);
    this.n++;
    return this;
  }

  int32(x: number): this {
    return this.uint32(x | 0);
  }

  /** Hash a double by its exact bit pattern (so NaN/±0 hash deterministically). */
  double(x: number): this {
    scratchF64[0] = x;
    const lo = scratchU32[0];
    const hi = scratchU32[1];
    return this.uint32(lo).uint32(hi);
  }

  /** Float with quantisation — use when tiny numerical noise must be ignored. */
  floatQuantised(x: number, scale = 1e6): this {
    return this.int32(Math.round(x * scale));
  }

  string(s: string): this {
    this.int32(s.length);
    for (let i = 0; i < s.length; i++) this.uint32(s.charCodeAt(i));
    return this;
  }

  bool(v: boolean): this {
    return this.uint32(v ? 1 : 0);
  }

  bytes(u8: ArrayLike<number>): this {
    this.int32(u8.length);
    for (let i = 0; i < u8.length; i++) this.uint32(u8[i]);
    return this;
  }

  int32Array(a: ArrayLike<number>): this {
    this.int32(a.length);
    for (let i = 0; i < a.length; i++) this.int32(a[i]);
    return this;
  }

  f64Array(a: ArrayLike<number>): this {
    this.int32(a.length);
    for (let i = 0; i < a.length; i++) this.double(a[i]);
    return this;
  }

  /** Final 16-hex-char digest. */
  hex(): string {
    const w = (x: number) => (x >>> 0).toString(16).padStart(8, '0');
    return w(this.a) + w(this.b) + w(this.c) + w(this.d);
  }

  /** Final digest as 4 uint32 lanes (avoids string allocation in hot paths). */
  lanes(): [number, number, number, number] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  number(): number {
    return this.a >>> 0;
  }
}

const scratchBuf = new ArrayBuffer(8);
const scratchF64 = new Float64Array(scratchBuf);
const scratchU32 = new Uint32Array(scratchBuf);

/** One-shot helper. */
export function hashOf(...parts: Array<string | number>): string {
  const h = new StructuralHash();
  for (const p of parts) {
    if (typeof p === 'number') h.double(p);
    else h.string(p);
  }
  return h.hex();
}
