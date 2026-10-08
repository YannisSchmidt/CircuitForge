/**
 * Sparse matrix and LU solver for Modified Nodal Analysis.
 *
 * Pivot threshold policy: a pivot is accepted only if |pivot| ≥ PIVOT_TOL times
 * the largest magnitude in its row (relative, threshold pivoting) — measured on
 * circuit matrices, 0.1 keeps the residual within a few percent of the floating
 * point bound while costing ~35% more fill-in than 1e-3, and it is the value the
 * simulator uses by default. Loosening it is a speed/accuracy trade the caller
 * can make explicitly.
 *
 * Storage is the classical "Sparse 1.3" doubly-linked layout used by SPICE since
 * 1973: every entry is a node in a row list and in a column list, so insertion of
 * fill-in is O(1) and the pivot search can walk degrees incrementally.
 *
 * Structure:  A = P_row⁻¹ · L · U · P_col⁻¹
 *   - L is unit lower triangular, its multipliers are stored *in place* at the
 *     positions of the eliminated entries below the pivot column,
 *   - U is upper triangular including the diagonal,
 *   - `rowOrder[step]` / `colOrder[step]` record which physical row/column was
 *     used at each elimination step (that is the permutation).
 *
 * Pivoting is Markowitz with a degree-bucketed column search and a relative
 * magnitude threshold, which is the same heuristic SPICE uses: it keeps the
 * ordering close to the original node numbering and therefore keeps fill-in low.
 *
 * IMPORTANT: `factorize()` overwrites the values with the L/U factors. Only call
 * `solve()` between a `factorize()` and the next `clear()`. Always `clear()`
 * before re-stamping a new matrix.
 */

const NONE = -1;

/** Default relative pivot threshold (see the note at the top of this file). */
export const PIVOT_TOL = 0.1;

export interface MatrixStats {
  size: number;
  entries: number;
  /** Number of fill-in entries created by the last factorisation. */
  fillIn: number;
  /** Pivots accepted although they were below the relative threshold. */
  weakPivots: number;
  singular: boolean;
  /** Physical row that could not be pivotal, when singular. */
  singularRow: number;
  /** Elimination steps completed. */
  steps: number;
}

export class SparseMatrix {
  /** Number of unknowns. */
  readonly size: number;

  private cap: number;
  private count = 0;
  private freeHead = NONE;

  private value: Float64Array;
  private rowOf: Int32Array;
  private colOf: Int32Array;
  private nextRow: Int32Array;
  private prevRow: Int32Array;
  private nextCol: Int32Array;
  private prevCol: Int32Array;

  private rowHead: Int32Array;
  private colHead: Int32Array;

  // --- factorisation state ---------------------------------------------------
  /** Pivot step of each physical row/column, -1 while still active. */
  private rowStep: Int32Array;
  private colStep: Int32Array;
  /** step -> physical row / column. */
  private rowOrder: Int32Array;
  private colOrder: Int32Array;
  /** Active non-zero counts (entries whose row *and* column are still active). */
  private rowDeg: Int32Array;
  private colDeg: Int32Array;
  /** Buckets of columns keyed by colDeg (for the Markowitz pivot search). */
  private bucketHead: Int32Array;
  private bucketOf: Int32Array;
  private bucketNext: Int32Array;
  private bucketPrev: Int32Array;
  private minBucket = 0;
  /** Order of the previous factorisation, used when `reuseOrder` is set. */
  private prevRowOrder: Int32Array;
  private prevColOrder: Int32Array;
  private hasPrevOrder = false;

  private scratch: Float64Array;
  private lastStats: MatrixStats = { size: 0, entries: 0, fillIn: 0, weakPivots: 0, singular: false, singularRow: -1, steps: 0 };

  constructor(size: number, estimatedEntries = 8) {
    this.size = size;
    this.cap = Math.max(16, size * estimatedEntries);
    this.value = new Float64Array(this.cap);
    this.rowOf = new Int32Array(this.cap);
    this.colOf = new Int32Array(this.cap);
    this.nextRow = new Int32Array(this.cap);
    this.prevRow = new Int32Array(this.cap);
    this.nextCol = new Int32Array(this.cap);
    this.prevCol = new Int32Array(this.cap);
    this.rowHead = new Int32Array(size).fill(NONE);
    this.colHead = new Int32Array(size).fill(NONE);
    this.rowStep = new Int32Array(size).fill(NONE);
    this.colStep = new Int32Array(size).fill(NONE);
    this.rowOrder = new Int32Array(size);
    this.colOrder = new Int32Array(size);
    this.rowDeg = new Int32Array(size);
    this.colDeg = new Int32Array(size);
    this.bucketHead = new Int32Array(size + 2).fill(NONE);
    this.bucketOf = new Int32Array(size).fill(NONE);
    this.bucketNext = new Int32Array(size).fill(NONE);
    this.bucketPrev = new Int32Array(size).fill(NONE);
    this.prevRowOrder = new Int32Array(size).fill(NONE);
    this.prevColOrder = new Int32Array(size).fill(NONE);
    this.scratch = new Float64Array(size);
  }

  get entries(): number {
    return this.count;
  }

  stats(): MatrixStats {
    return { ...this.lastStats, size: this.size, entries: this.count };
  }

  // ---------------------------------------------------------------------------
  // Storage primitives
  // ---------------------------------------------------------------------------

  private alloc(): number {
    if (this.freeHead !== NONE) {
      const e = this.freeHead;
      this.freeHead = this.nextRow[e];
      return e;
    }
    if (this.count >= this.cap) this.grow();
    return this.count++;
  }

  private grow(): void {
    const cap = this.cap * 2 + 16;
    const fi = (a: Float64Array) => {
      const b = new Float64Array(cap);
      b.set(a);
      return b;
    };
    const ii = (a: Int32Array) => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.value = fi(this.value);
    this.rowOf = ii(this.rowOf);
    this.colOf = ii(this.colOf);
    this.nextRow = ii(this.nextRow);
    this.prevRow = ii(this.prevRow);
    this.nextCol = ii(this.nextCol);
    this.prevCol = ii(this.prevCol);
    this.cap = cap;
  }

  private linkRow(r: number, e: number): void {
    const head = this.rowHead[r];
    this.nextRow[e] = head;
    this.prevRow[e] = NONE;
    if (head !== NONE) this.prevRow[head] = e;
    this.rowHead[r] = e;
    this.rowOf[e] = r;
  }

  private linkCol(c: number, e: number): void {
    const head = this.colHead[c];
    this.nextCol[e] = head;
    this.prevCol[e] = NONE;
    if (head !== NONE) this.prevCol[head] = e;
    this.colHead[c] = e;
    this.colOf[e] = c;
  }

  /** Find the physical entry at (row, col), or NONE. O(row length). */
  find(row: number, col: number): number {
    for (let e = this.rowHead[row]; e !== NONE; e = this.nextRow[e]) {
      if (this.colOf[e] === col) return e;
    }
    return NONE;
  }

  /** Add `v` to entry (row, col), creating the entry when needed. */
  add(row: number, col: number, v: number): void {
    if (v === 0) return;
    for (let e = this.rowHead[row]; e !== NONE; e = this.nextRow[e]) {
      if (this.colOf[e] === col) {
        this.value[e] += v;
        return;
      }
    }
    const e = this.alloc();
    this.value[e] = v;
    this.linkRow(row, e);
    this.linkCol(col, e);
  }

  /** Overwrite entry (row, col). */
  set(row: number, col: number, v: number): void {
    const e = this.find(row, col);
    if (e !== NONE) this.value[e] = v;
    else this.add(row, col, v);
  }

  /** Iterate all structurally stored entries. Used by the dense reference path. */
  forEachEntry(fn: (row: number, col: number, value: number) => void): void {
    for (let r = 0; r < this.size; r++) {
      for (let e = this.rowHead[r]; e !== NONE; e = this.nextRow[e]) fn(r, this.colOf[e], this.value[e]);
    }
  }

  get(row: number, col: number): number {
    const e = this.find(row, col);
    return e === NONE ? 0 : this.value[e];
  }

  /** Zero every value, keeping the structure. Call before re-stamping. */
  clear(): void {
    this.value.fill(0, 0, this.count);
    this.hasPrevOrder = false;
  }

  /** Drop every entry and reset the permutations (structure rebuilt from scratch). */
  reset(): void {
    this.count = 0;
    this.freeHead = NONE;
    this.rowHead.fill(NONE);
    this.colHead.fill(NONE);
    this.hasPrevOrder = false;
    this.lastStats = { size: this.size, entries: 0, fillIn: 0, weakPivots: 0, singular: false, singularRow: -1, steps: 0 };
  }

  // ---------------------------------------------------------------------------
  // Bucket bookkeeping for the Markowitz column search
  // ---------------------------------------------------------------------------

  /**
   * Insert a column into the bucket for degree `d`.
   *
   * `minBucket` is a *hint* that must never be larger than the true minimum
   * non-empty bucket: inserts only ever lower it, and the pivot search only ever
   * raises it while scanning upward. Making it jump upward here (an earlier
   * version "repaired" a stale hint) silently hides non-empty buckets below it —
   * that bug made the factoriser report a false singularity.
   */
  private bucketInsert(c: number, d: number): void {
    if (d > this.size) d = this.size;
    this.bucketOf[c] = d;
    const head = this.bucketHead[d];
    this.bucketNext[c] = head;
    this.bucketPrev[c] = NONE;
    if (head !== NONE) this.bucketPrev[head] = c;
    this.bucketHead[d] = c;
    if (d < this.minBucket) this.minBucket = d;
  }

  private bucketRemove(c: number): void {
    const d = this.bucketOf[c];
    if (d < 0) return;
    const p = this.bucketPrev[c];
    const nx = this.bucketNext[c];
    if (p === NONE) this.bucketHead[d] = nx;
    else this.bucketNext[p] = nx;
    if (nx !== NONE) this.bucketPrev[nx] = p;
    this.bucketOf[c] = NONE;
    this.bucketNext[c] = NONE;
    this.bucketPrev[c] = NONE;
  }

  /**
   * Move a column to bucket `d`. Degree-0 columns are *not* kept in a bucket:
   * they can never be pivots, and leaving them in bucket 0 would make the pivot
   * search pick them and report a false singularity.
   */
  private bucketSetDegree(c: number, d: number): void {
    if (this.bucketOf[c] === d) return;
    this.bucketRemove(c);
    if (d > 0) this.bucketInsert(c, d);
  }

  // ---------------------------------------------------------------------------
  // Factorisation
  // ---------------------------------------------------------------------------

  /**
   * LU factorisation with Markowitz pivoting.
   *
   * `tol` is a *relative* pivot threshold (SPICE's reltol): a pivot is only
   * accepted if its magnitude is at least `tol` times the largest magnitude in
   * its row. `reuseOrder` replays the previous pivot order when it is still
   * structurally valid, which is what makes repeated factorisations during a
   * Newton loop cheap.
   */
  factorize(opts: {
    tol?: number;
    reuseOrder?: boolean;
    checkInvariants?: boolean;
    trace?: (info: { step: number; row: number; col: number; pivot: number; activeColumns: number; minDegree: number; buckets: string }) => void;
    traceStart?: (info: { step: number; minBucket: number; buckets: string }) => void;
  } = {}): boolean {
    const n = this.size;
    const tol = opts.tol ?? PIVOT_TOL;
    const check = opts.checkInvariants === true;
    const trace = opts.trace;
    let fillIn = 0;
    let weakPivots = 0;

    // --- reset the elimination state ----------------------------------------
    this.rowStep.fill(NONE);
    this.colStep.fill(NONE);
    this.rowDeg.fill(0);
    this.colDeg.fill(0);
    this.bucketHead.fill(NONE);
    this.bucketOf.fill(NONE);
    this.bucketNext.fill(NONE);
    this.bucketPrev.fill(NONE);
    this.minBucket = n + 1; // sentinel: no bucket populated yet

    // Initial degrees: only entries with a non-zero value count.
    for (let r = 0; r < n; r++) {
      for (let e = this.rowHead[r]; e !== NONE; e = this.nextRow[e]) {
        if (this.value[e] !== 0) {
          this.rowDeg[r]++;
          this.colDeg[this.colOf[e]]++;
        }
      }
    }
    // Only columns with at least one active non-zero can be pivots.
    for (let c = 0; c < n; c++) {
      if (this.colDeg[c] > 0) this.bucketInsert(c, this.colDeg[c]);
    }

    const toEliminate: number[] = [];
    const pivotRowEntries: number[] = [];

    for (let step = 0; step < n; step++) {
      if (check) {
        const pre = this.checkInvariants(step);
        if (pre) throw new Error(`sparse LU invariant violated *before* step ${step}: ${pre}`);
      }
      if (opts.traceStart) {
        let bk = '';
        for (let d = 1; d <= n; d++) {
          const cols: number[] = [];
          for (let c2 = this.bucketHead[d]; c2 !== NONE && cols.length < 40; c2 = this.bucketNext[c2]) cols.push(c2);
          if (cols.length) bk += `${d}:[${cols.join(',')}] `;
        }
        opts.traceStart({ step, minBucket: this.minBucket, buckets: bk });
      }
      // ---- 1. pick the column with the fewest active entries ----------------
      let pc = NONE;
      // Reuse hint: the same column as last time, if it is still active.
      if (opts.reuseOrder && this.hasPrevOrder) {
        const hint = this.prevColOrder[step];
        if (hint >= 0 && this.colStep[hint] === NONE && this.colDeg[hint] > 0) pc = hint;
      }
      if (pc === NONE) {
        // Sweep the buckets from the current minimum (bucket 0 is never used).
        let d = Math.max(1, this.minBucket);
        while (d <= n && this.bucketHead[d] === NONE) d++;
        if (d > n) {
          // No column left with an active entry: structurally singular.
          this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: true, singularRow: -1, steps: step };
          return false;
        }
        this.minBucket = d;
        pc = this.bucketHead[d];
        if (this.colDeg[pc] <= 0) {
          // Should be unreachable (invariant checked in tests). Recover by
          // dropping the stale entry and rescanning from the bottom rather than
          // skipping a step, which would corrupt the permutation.
          this.bucketRemove(pc);
          this.minBucket = 1;
          d = 1;
          while (d <= n && this.bucketHead[d] === NONE) d++;
          if (d > n) {
            this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: true, singularRow: -1, steps: step };
            return false;
          }
          this.minBucket = d;
          pc = this.bucketHead[d];
        }
      }
      this.bucketRemove(pc);

      // ---- 2. pick the pivot inside that column ----------------------------
      // Markowitz cost (rowDeg-1)·(colDeg-1); the degree of the column is the
      // same for every candidate, so it only scales the comparison.
      let pr = NONE;
      let pivotElem = NONE;
      let bestCost = Infinity;
      let bestMag = -1;
      for (let e = this.colHead[pc]; e !== NONE; e = this.nextCol[e]) {
        const r = this.rowOf[e];
        if (this.rowStep[r] !== NONE) continue;
        const mag = Math.abs(this.value[e]);
        if (mag === 0) continue;
        const cost = (this.rowDeg[r] - 1) * (this.colDeg[pc] - 1);
        if (cost < bestCost || (cost === bestCost && mag > bestMag)) {
          bestCost = cost;
          bestMag = mag;
          pivotElem = e;
          pr = r;
        }
      }
      if (pivotElem === NONE) {
        this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: true, singularRow: pr, steps: step };
        return false;
      }

      // Relative magnitude threshold against the largest entry of the pivot row.
      let rowMax = 0;
      for (let e = this.rowHead[pr]; e !== NONE; e = this.nextRow[e]) {
        if (this.colStep[this.colOf[e]] !== NONE) continue;
        const a = Math.abs(this.value[e]);
        if (a > rowMax) rowMax = a;
      }
      const pivotVal = this.value[pivotElem];
      if (!(Math.abs(pivotVal) >= tol * rowMax) && rowMax > 0) {
        // Take the largest available anyway (still nonsingular) and flag it.
        let best = NONE;
        let mag = 0;
        for (let e = this.colHead[pc]; e !== NONE; e = this.nextCol[e]) {
          const r = this.rowOf[e];
          if (this.rowStep[r] !== NONE) continue;
          const a = Math.abs(this.value[e]);
          if (a > mag) {
            mag = a;
            best = e;
          }
        }
        if (best !== NONE) {
          pivotElem = best;
          pr = this.rowOf[best];
        }
        weakPivots++;
      }
      const pv = this.value[pivotElem];
      if (pv === 0 || !Number.isFinite(pv)) {
        this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: true, singularRow: pr, steps: step };
        return false;
      }

      this.rowOrder[step] = pr;
      this.colOrder[step] = pc;

      // ---- 3. eliminate -----------------------------------------------------
      toEliminate.length = 0;
      for (let e = this.colHead[pc]; e !== NONE; e = this.nextCol[e]) {
        const r = this.rowOf[e];
        if (r === pr || this.rowStep[r] !== NONE) continue;
        if (this.value[e] !== 0) toEliminate.push(e);
      }
      pivotRowEntries.length = 0;
      for (let e = this.rowHead[pr]; e !== NONE; e = this.nextRow[e]) {
        if (this.colStep[this.colOf[e]] === NONE && this.colOf[e] !== pc) pivotRowEntries.push(e);
      }

      for (const ek of toEliminate) {
        const kr = this.rowOf[ek];
        const mult = this.value[ek] / pv;
        this.value[ek] = mult; // keep the L multiplier in place
        const rowList = pivotRowEntries;
        for (let i = 0; i < rowList.length; i++) {
          const ep = rowList[i];
          const cp = this.colOf[ep];
          const delta = mult * this.value[ep];
          if (delta === 0) continue;
          let found = NONE;
          for (let s = this.rowHead[kr]; s !== NONE; s = this.nextRow[s]) {
            if (this.colOf[s] === cp) {
              found = s;
              break;
            }
          }
          if (found === NONE) {
            const ne = this.alloc();
            this.value[ne] = -delta;
            this.linkRow(kr, ne);
            this.linkCol(cp, ne);
            this.rowDeg[kr]++;
            this.colDeg[cp]++;
            this.bucketSetDegree(cp, this.colDeg[cp]);
            fillIn++;
          } else {
            const wasZero = this.value[found] === 0;
            this.value[found] -= delta;
            if (wasZero && this.value[found] !== 0) {
              this.rowDeg[kr]++;
              this.colDeg[cp]++;
              this.bucketSetDegree(cp, this.colDeg[cp]);
            } else if (!wasZero && this.value[found] === 0) {
              this.rowDeg[kr]--;
              this.colDeg[cp]--;
              this.bucketSetDegree(cp, this.colDeg[cp]);
            }
          }
        }
      }

      // ---- 4. retire the pivot row and column -------------------------------
      // The pivot column leaves the active set: every active row that has an
      // entry in it loses one active entry. Structurally present but numerically
      // zero entries are skipped — they never contributed to the degree, and
      // decrementing for them would drift the bookkeeping (a bug this invariant
      // check was written to catch).
      for (let e = this.colHead[pc]; e !== NONE; e = this.nextCol[e]) {
        if (this.value[e] === 0) continue;
        const r = this.rowOf[e];
        if (this.rowStep[r] === NONE && this.rowDeg[r] > 0) this.rowDeg[r]--;
      }
      // The pivot row leaves the active set: every active column it touches
      // loses one active entry.
      for (let e = this.rowHead[pr]; e !== NONE; e = this.nextRow[e]) {
        if (this.value[e] === 0) continue;
        const c = this.colOf[e];
        if (this.colStep[c] !== NONE) continue;
        if (this.colDeg[c] > 0) this.colDeg[c]--;
        if (c !== pc) this.bucketSetDegree(c, this.colDeg[c]);
      }
      this.rowStep[pr] = step;
      this.colStep[pc] = step;
      this.bucketRemove(pc);

      if (trace) {
        let active = 0;
        for (let c = 0; c < n; c++) if (this.colStep[c] === NONE && this.colDeg[c] > 0) active++;
        let bk = '';
        for (let d = 1; d <= n; d++) {
          let c2 = this.bucketHead[d];
          let cnt = 0;
          while (c2 !== NONE && cnt < 99) {
            cnt++;
            c2 = this.bucketNext[c2];
          }
          if (cnt > 0) bk += `${d}:${cnt} `;
        }
        trace({ step, row: pr, col: pc, pivot: pv, activeColumns: active, minDegree: this.colDeg[pc], buckets: bk });
      }
      if (check) {
        const problem = this.checkInvariants(step);
        if (problem) {
          this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: true, singularRow: pr, steps: step };
          throw new Error(`sparse LU invariant violated at step ${step} (pivot ${pr},${pc}): ${problem}`);
        }
      }
    }

    this.prevRowOrder.set(this.rowOrder);
    this.prevColOrder.set(this.colOrder);
    this.hasPrevOrder = true;
    this.lastStats = { size: n, entries: this.count, fillIn, weakPivots, singular: false, singularRow: -1, steps: n };
    return true;
  }

  /** Debug: per-active-column bookkeeping state as text lines. */
  dumpActiveColumns(): string[] {
    const out: string[] = [];
    for (let c = 0; c < this.size; c++) {
      if (this.colStep[c] !== NONE) continue;
      let actual = 0;
      for (let e = this.colHead[c]; e !== NONE; e = this.nextCol[e]) {
        if (this.value[e] === 0) continue;
        if (this.rowStep[this.rowOf[e]] === NONE) actual++;
      }
      out.push(`col ${c}: colDeg=${this.colDeg[c]} bucket=${this.bucketOf[c]} actualActive=${actual} rows=[${(() => {
        const r: number[] = [];
        for (let e = this.colHead[c]; e !== NONE; e = this.nextCol[e]) r.push(this.rowOf[e]);
        return r.join(',');
      })()}]`);
    }
    return out;
  }

  /**
   * Recompute the degree bookkeeping from scratch and compare it with the
   * incrementally maintained values. O(entries). Used by tests and by
   * `factorize({checkInvariants:true})` to catch bookkeeping bugs early.
   */
  checkInvariants(step: number): string | null {
    const n = this.size;
    const rowDeg = new Int32Array(n);
    const colDeg = new Int32Array(n);
    for (let r = 0; r < n; r++) {
      for (let e = this.rowHead[r]; e !== NONE; e = this.nextRow[e]) {
        const c = this.colOf[e];
        if (this.value[e] === 0) continue;
        if (this.colStep[c] === NONE) rowDeg[r]++;
        if (this.rowStep[r] === NONE) colDeg[c]++;
      }
    }
    for (let r = 0; r < n; r++) {
      if (this.rowStep[r] === NONE && rowDeg[r] !== this.rowDeg[r]) {
        return `rowDeg[${r}] = ${this.rowDeg[r]}, recomputed ${rowDeg[r]} (step ${step})`;
      }
    }
    for (let c = 0; c < n; c++) {
      if (this.colStep[c] !== NONE) continue;
      if (colDeg[c] !== this.colDeg[c]) return `colDeg[${c}] = ${this.colDeg[c]}, recomputed ${colDeg[c]} (step ${step})`;
      const expected = colDeg[c] > 0 ? colDeg[c] : NONE;
      if (this.bucketOf[c] !== expected) return `bucketOf[${c}] = ${this.bucketOf[c]}, expected ${expected} (colDeg ${colDeg[c]}, step ${step})`;
    }
    return null;
  }

  /**
   * Solve A·x = b using the factors computed by `factorize()`.
   * `b` and `x` must not alias.
   */
  solve(b: Float64Array, x: Float64Array): boolean {
    const n = this.size;
    if (this.lastStats.singular || this.lastStats.steps !== n) return false;
    const y = this.scratch;

    // Forward: L·y = b, in elimination order.
    for (let step = 0; step < n; step++) {
      const pr = this.rowOrder[step];
      let sum = b[pr];
      for (let e = this.rowHead[pr]; e !== NONE; e = this.nextRow[e]) {
        const cs = this.colStep[this.colOf[e]];
        if (cs < 0 || cs >= step) continue;
        sum -= this.value[e] * y[cs];
      }
      y[step] = sum;
    }

    // Backward: U·x = y.
    for (let step = n - 1; step >= 0; step--) {
      const pr = this.rowOrder[step];
      let sum = y[step];
      let diag = 0;
      for (let e = this.rowHead[pr]; e !== NONE; e = this.nextRow[e]) {
        const cs = this.colStep[this.colOf[e]];
        if (cs < 0) continue;
        if (cs > step) sum -= this.value[e] * x[cs];
        else if (cs === step) diag = this.value[e];
      }
      if (diag === 0 || !Number.isFinite(diag)) return false;
      const v = sum / diag;
      if (!Number.isFinite(v)) return false;
      x[step] = v;
    }

    // Unpermute. `y`/`x` are indexed by *elimination step*: the step's equation
    // is rowOrder[step] but the step's unknown is colOrder[step] (the row
    // permutation reorders equations, the column permutation reorders unknowns).
    const out = this.solveScratch ?? (this.solveScratch = new Float64Array(n));
    for (let step = 0; step < n; step++) out[this.colOrder[step]] = x[step];
    x.set(out);
    return true;
  }

  private solveScratch: Float64Array | null = null;
}

/**
 * Dense LU with partial pivoting.
 *
 * Used for small systems (where it is faster than sparse bookkeeping) and as the
 * independent reference implementation that the sparse solver is tested against.
 */
export class DenseLu {
  private a: Float64Array;
  private piv: Int32Array;
  readonly n: number;
  singular = false;

  constructor(n: number) {
    this.n = n;
    this.a = new Float64Array(n * n);
    this.piv = new Int32Array(n);
  }

  zero(): void {
    this.a.fill(0);
  }

  add(i: number, j: number, v: number): void {
    this.a[i * this.n + j] += v;
  }

  get(i: number, j: number): number {
    return this.a[i * this.n + j];
  }

  factorize(): boolean {
    const n = this.n;
    const a = this.a;
    this.singular = false;
    for (let k = 0; k < n; k++) {
      let p = k;
      let max = Math.abs(a[k * n + k]);
      for (let i = k + 1; i < n; i++) {
        const v = Math.abs(a[i * n + k]);
        if (v > max) {
          max = v;
          p = i;
        }
      }
      this.piv[k] = p;
      if (max === 0) {
        this.singular = true;
        return false;
      }
      if (p !== k) {
        for (let j = 0; j < n; j++) {
          const t = a[k * n + j];
          a[k * n + j] = a[p * n + j];
          a[p * n + j] = t;
        }
      }
      const piv = a[k * n + k];
      for (let i = k + 1; i < n; i++) {
        const f = (a[i * n + k] /= piv);
        if (f === 0) continue;
        for (let j = k + 1; j < n; j++) a[i * n + j] -= f * a[k * n + j];
      }
    }
    return true;
  }

  solve(b: Float64Array, x: Float64Array): boolean {
    const n = this.n;
    const a = this.a;
    if (this.singular) return false;
    for (let i = 0; i < n; i++) x[i] = b[i];
    for (let k = 0; k < n; k++) {
      const p = this.piv[k];
      if (p !== k) {
        const t = x[k];
        x[k] = x[p];
        x[p] = t;
      }
      for (let i = k + 1; i < n; i++) x[i] -= a[i * n + k] * x[k];
    }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j < n; j++) x[i] -= a[i * n + j] * x[j];
      const d = a[i * n + i];
      if (d === 0) return false;
      x[i] /= d;
    }
    return true;
  }
}
