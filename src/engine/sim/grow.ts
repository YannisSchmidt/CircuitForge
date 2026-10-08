/**
 * Growable typed-array builders.
 *
 * Flattening a million-component circuit must not allocate a million small
 * objects or push 20 million doubles into a plain JS array. These classes keep a
 * typed backing store with doubling growth; `data` is exposed directly so the
 * buffered values can be written without a temporary object.
 */

export class GrowF64 {
  data: Float64Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Float64Array(Math.max(16, capacity));
  }

  ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push(v: number): void {
    this.ensure(1);
    this.data[this.length++] = v;
  }

  pushMany(src: Float64Array, count: number): void {
    this.ensure(count);
    this.data.set(src.subarray(0, count), this.length);
    this.length += count;
  }

  /** Trimmed copy (exact size). */
  toArray(): Float64Array {
    return this.data.slice(0, this.length);
  }
}

export class GrowI32 {
  data: Int32Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Int32Array(Math.max(16, capacity));
  }

  ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const next = new Int32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push(v: number): void {
    this.ensure(1);
    this.data[this.length++] = v;
  }

  pushMany(src: Int32Array, count: number): void {
    this.ensure(count);
    this.data.set(src.subarray(0, count), this.length);
    this.length += count;
  }

  toArray(): Int32Array {
    return this.data.slice(0, this.length);
  }
}

export class GrowU8 {
  data: Uint8Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Uint8Array(Math.max(16, capacity));
  }

  ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push(v: number): void {
    this.ensure(1);
    this.data[this.length++] = v & 0xff;
  }

  toArray(): Uint8Array {
    return this.data.slice(0, this.length);
  }
}

export class GrowU16 {
  data: Uint16Array;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Uint16Array(Math.max(16, capacity));
  }

  ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const next = new Uint16Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push(v: number): void {
    this.ensure(1);
    this.data[this.length++] = v & 0xffff;
  }

  toArray(): Uint16Array {
    return this.data.slice(0, this.length);
  }
}

/** Deduplicating string table (keeps specification names compact). */
export class StringTable {
  private map = new Map<string, number>();
  list: string[] = [];

  /**
   * Intern with index 0 reserved for "no name": `nameOf(0)` is undefined, so an
   * index of 0 in a typed array is a safe "unnamed" sentinel.
   */
  internNamed(s: string): number {
    const existing = this.map.get(s);
    if (existing !== undefined) return existing;
    const idx = this.list.length + 1;
    this.list.push(s);
    this.map.set(s, idx);
    return idx;
  }

  /** Name of an interned index (undefined for the 0 sentinel). */
  nameOf(idx: number): string | undefined {
    return idx <= 0 ? undefined : this.list[idx - 1];
  }

  intern(s: string): number {
    const existing = this.map.get(s);
    if (existing !== undefined) return existing;
    const idx = this.list.length;
    this.list.push(s);
    this.map.set(s, idx);
    return idx;
  }

  get size(): number {
    return this.list.length;
  }
}
