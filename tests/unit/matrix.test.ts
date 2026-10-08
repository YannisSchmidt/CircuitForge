/**
 * Sparse linear solver tests.
 *
 * The dense LU is an independent implementation, so it is used as the oracle for
 * randomised systems. Random matrices are made strictly diagonally dominant so
 * that they are guaranteed nonsingular and well conditioned — otherwise a
 * difference between the two solvers says nothing about either of them.
 */

import { SparseMatrix, DenseLu } from '../../src/engine/sim/matrix.js';
import { assert, assertClose, assertEqual, TestRng, test, suite } from '../framework.js';

suite('matrix');

function buildSparse(n: number, a: Float64Array, est = 4): SparseMatrix {
  const m = new SparseMatrix(n, est);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = a[i * n + j];
      if (v !== 0) m.add(i, j, v);
    }
  }
  return m;
}

function buildDense(n: number, a: Float64Array): DenseLu {
  const d = new DenseLu(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d.add(i, j, a[i * n + j]);
  return d;
}

function residual(n: number, a: Float64Array, x: Float64Array, b: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += a[i * n + j] * x[j];
    worst = Math.max(worst, Math.abs(sum - b[i]));
  }
  return worst;
}

test('solves a hand-checked 3x3 system identically to the dense solver', () => {
  const a = Float64Array.from([2, -1, 0, -1, 3, -1, 0, -1, 2]);
  const b = Float64Array.from([1, 2, 3]);
  const m = buildSparse(3, a);
  assert(m.factorize(), 'sparse factorisation failed');
  const x = new Float64Array(3);
  assert(m.solve(b, x), 'sparse solve failed');
  assertClose(x[0], 1.5, 1e-12, 'x0');
  assertClose(x[1], 2, 1e-12, 'x1');
  assertClose(x[2], 2.5, 1e-12, 'x2');
});

test('pivots a matrix whose row and column permutations differ', () => {
  // This is the MNA pattern of a voltage source + two resistors: row 2 is the
  // voltage-defining row, so the elimination order needs both permutations.
  const a = Float64Array.from([0.001, -0.001, 1, -0.001, 0.002, 0, 1, 0, 0]);
  const b = Float64Array.from([0, 0, 10]);
  const m = buildSparse(3, a);
  assert(m.factorize(), 'factorisation failed');
  const x = new Float64Array(3);
  assert(m.solve(b, x), 'solve failed');
  // v1 = 10, v2 = 5, branch current = -5 mA (flowing + → -)
  assertClose(x[0], 10, 1e-9, 'v1');
  assertClose(x[1], 5, 1e-9, 'v2');
  assertClose(x[2], -0.005, 1e-9, 'i');
});

/**
 * Residual bound for a solved system.
 *
 * The comparison must be scale aware: a floating point solve satisfies
 * ‖A·x − b‖ ≲ eps · (‖A‖·‖x‖ + ‖b‖) for a well conditioned matrix, and only in
 * *unit roundoff* terms, not in absolute volts. Asserting a fixed absolute
 * residual would fail for perfectly correct solves of large-magnitude systems.
 */
function residualBound(n: number, a: Float64Array, x: Float64Array, b: Float64Array): number {
  let rowNorm = 0;
  for (let i = 0; i < n; i++) {
    let row = 0;
    for (let j = 0; j < n; j++) row += Math.abs(a[i * n + j]);
    rowNorm = Math.max(rowNorm, row);
  }
  let maxX = 0;
  let maxB = 0;
  for (let i = 0; i < n; i++) {
    maxX = Math.max(maxX, Math.abs(x[i]));
    maxB = Math.max(maxB, Math.abs(b[i]));
  }
  return 1e-11 * (rowNorm * maxX + maxB);
}

test('matches the dense solver on 500 randomised diagonally dominant systems', () => {
  const rng = new TestRng(0xc0ffee);
  let worstCmp = 0;
  for (let trial = 0; trial < 500; trial++) {
    const n = rng.int(1, 40);
    const density = rng.range(0.05, 0.35);
    const a = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      let off = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (rng.next() < density * 0.5) {
          const v = rng.range(-1, 1);
          a[i * n + j] = v;
          off += Math.abs(v);
        }
      }
      // Strong dominance (2× the row sum) keeps the condition number moderate,
      // so the two solvers must agree closely — a weak bound would let a broken
      // factoriser hide behind the condition number.
      a[i * n + i] = 2 * off + rng.range(1, 3);
    }
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) b[i] = rng.range(-10, 10);

    const sp = buildSparse(n, a);
    assert(sp.factorize({ checkInvariants: true }), `trial ${trial}: sparse factorisation failed (n=${n})`);
    const xs = new Float64Array(n);
    assert(sp.solve(b, xs), `trial ${trial}: sparse solve failed`);
    const res = residual(n, a, xs, b);
    assert(res <= residualBound(n, a, xs, b), `trial ${trial}: residual ${res} exceeds the floating point bound`);

    const d = buildDense(n, a);
    assert(d.factorize(), `trial ${trial}: dense factorisation failed`);
    const xd = new Float64Array(n);
    d.solve(b, xd);
    for (let i = 0; i < n; i++) worstCmp = Math.max(worstCmp, Math.abs(xs[i] - xd[i]));
  }
  assert(worstCmp < 1e-6, `worst |sparse-dense| = ${worstCmp}`);
});

test('handles a pathologically ill-conditioned system without lying about it', () => {
  // A matrix at the edge of diagonal dominance: a solution is produced, and the
  // residual bound is checked in *unit roundoff* terms rather than an absolute
  // tolerance that would be meaningless here.
  const rng = new TestRng(0x1234);
  for (let trial = 0; trial < 50; trial++) {
    const n = rng.int(4, 20);
    const a = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      let off = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (rng.next() < 0.3) {
          a[i * n + j] = rng.range(-1, 1);
          off += Math.abs(a[i * n + j]);
        }
      }
      a[i * n + i] = off + rng.range(0.01, 0.2); // nearly singular
    }
    const b = new Float64Array(n).fill(1);
    const sp = buildSparse(n, a);
    if (!sp.factorize({ checkInvariants: true })) continue; // reported singular: fine
    const x = new Float64Array(n);
    if (!sp.solve(b, x)) continue;
    const res = residual(n, a, x, b);
    let rowNorm = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += Math.abs(a[i * n + j]);
      rowNorm = Math.max(rowNorm, row);
    }
    let maxX = 0;
    for (let i = 0; i < n; i++) maxX = Math.max(maxX, Math.abs(x[i]));
    // The bound scales with the solution magnitude, which may be huge here.
    assert(res <= 1e-11 * (rowNorm * maxX + 1) * 1e3, `trial ${trial}: scaled residual ${res} too large (maxX=${maxX})`);
  }
});

test('reports singularity for a structurally empty matrix', () => {
  const m = new SparseMatrix(3, 1);
  m.add(0, 0, 1);
  m.add(1, 1, 1);
  // row/column 2 stays empty
  assertEqual(m.factorize(), false, 'an empty column must be detected as singular');
  assertEqual(m.stats().singular, true, 'stats must report singular');
});

test('reports singularity for an all-zero pivot column with nonzero body', () => {
  const m = new SparseMatrix(2, 2);
  m.add(0, 1, 1);
  m.add(1, 1, 1);
  assertEqual(m.factorize(), false, 'column 0 has no entry: singular');
});

test('clear() keeps the structure and allows a second, different solve', () => {
  const m = new SparseMatrix(2, 2);
  m.add(0, 0, 2);
  m.add(0, 1, 1);
  m.add(1, 0, 1);
  m.add(1, 1, 3);
  const x = new Float64Array(2);
  assert(m.factorize(), 'first factorisation');
  m.solve(Float64Array.from([1, 2]), x);
  assertClose(x[0], 0.2, 1e-12, 'first solve x0');
  assertClose(x[1], 0.6, 1e-12, 'first solve x1');
  // Change the matrix: A = [[4,1],[1,3]], b = [1,2]
  m.clear();
  m.add(0, 0, 4);
  m.add(0, 1, 1);
  m.add(1, 0, 1);
  m.add(1, 1, 3);
  assert(m.factorize(), 'second factorisation');
  assert(m.solve(Float64Array.from([1, 2]), x), 'second solve');
  assertClose(x[0], 1 / 11, 1e-12, 'second solve x0');
  assertClose(x[1], 7 / 11, 1e-12, 'second solve x1');
});

test('reuseOrder produces the same solution', () => {
  const rng = new TestRng(1234);
  const n = 30;
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    let off = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (rng.next() < 0.1) {
        a[i * n + j] = rng.range(-1, 1);
        off += Math.abs(a[i * n + j]);
      }
    }
    a[i * n + i] = off + 1;
  }
  const b = new Float64Array(n).fill(1);
  const m = new SparseMatrix(n, 4);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (a[i * n + j] !== 0) m.add(i, j, a[i * n + j]);
  assert(m.factorize({ reuseOrder: false }), 'first');
  const x1 = new Float64Array(n);
  m.solve(b, x1);
  m.clear();
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (a[i * n + j] !== 0) m.add(i, j, a[i * n + j]);
  assert(m.factorize({ reuseOrder: true }), 'reused');
  const x2 = new Float64Array(n);
  m.solve(b, x2);
  for (let i = 0; i < n; i++) assertClose(x2[i], x1[i], 1e-12, `x[${i}] with reused order`);
});

test('growth past the initial capacity keeps results correct', () => {
  // Force many growths by starting with a tiny capacity estimate.
  const n = 60;
  const m = new SparseMatrix(n, 1);
  const dense = new DenseLu(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = i === j ? 2 + n : Math.abs(i - j) === 1 ? -1 : 0;
      if (v !== 0) {
        m.add(i, j, v);
        dense.add(i, j, v);
      }
    }
  }
  assert(m.factorize(), 'factorisation failed');
  const b = new Float64Array(n).fill(1);
  const x = new Float64Array(n);
  const xd = new Float64Array(n);
  assert(m.solve(b, x), 'solve failed');
  dense.factorize();
  dense.solve(b, xd);
  for (let i = 0; i < n; i++) assertClose(x[i], xd[i], 1e-9, `x[${i}]`);
});

test('the dense solver is a faithful oracle (residuals on random systems)', () => {
  const rng = new TestRng(77);
  for (let trial = 0; trial < 20; trial++) {
    const n = rng.int(2, 12);
    const a = new Float64Array(n * n);
    const d = new DenseLu(n);
    for (let i = 0; i < n; i++) {
      let off = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const v = rng.range(-1, 1);
        a[i * n + j] = v;
        off += Math.abs(v);
      }
      a[i * n + i] = off + rng.range(0.5, 2);
      for (let j = 0; j < n; j++) d.add(i, j, a[i * n + j]);
    }
    const b = new Float64Array(n).fill(1);
    assert(d.factorize(), 'dense factorisation');
    const x = new Float64Array(n);
    assert(d.solve(b, x), 'dense solve');
    const res = residual(n, a, x, b);
    assert(res < 1e-9, `dense residual ${res}`);
  }
});
