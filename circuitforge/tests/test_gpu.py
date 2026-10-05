"""Tests for the GPU engine wrapper."""

import unittest
import numpy as np

from circuitforge.gpu import (
    Engine, get_engine, reset_engine, is_gpu_available, set_force_cpu,
    get_engine_info, benchmark,
)


class TestEngine(unittest.TestCase):

    def setUp(self):
        # Force CPU for predictable testing
        set_force_cpu(True)
        reset_engine()

    def tearDown(self):
        set_force_cpu(False)
        reset_engine()

    def test_engine_init(self):
        eng = Engine()
        # With set_force_cpu we should be on CPU
        self.assertEqual(eng.backend, "numpy")
        self.assertFalse(eng.is_gpu)

    def test_solve_on_cpu(self):
        eng = Engine()
        A = np.array([[3.0, 2.0], [1.0, 2.0]])
        b = np.array([7.0, 5.0])
        x = eng.solve(A, b)
        expected = np.linalg.solve(A, b)
        np.testing.assert_allclose(x, expected, rtol=1e-10)

    def test_array_returns_numpy(self):
        eng = Engine()
        a = eng.array([1, 2, 3])
        self.assertIsInstance(a, np.ndarray)

    def test_matmul(self):
        eng = Engine()
        A = np.array([[1.0, 2.0], [3.0, 4.0]])
        B = np.array([[5.0, 6.0], [7.0, 8.0]])
        C = eng.matmul(A, B)
        np.testing.assert_allclose(C, A @ B)

    def test_get_engine_returns_singleton(self):
        a = get_engine()
        b = get_engine()
        self.assertIs(a, b)

    def test_is_gpu_available(self):
        # We forced CPU; should be False
        self.assertFalse(is_gpu_available())

    def test_get_engine_info(self):
        info = get_engine_info()
        self.assertEqual(info.name, "numpy")
        self.assertFalse(info.is_gpu)

    def test_stats(self):
        eng = Engine()
        A = np.eye(8)
        b = np.ones(8)
        eng.solve(A, b)
        s = eng.stats()
        self.assertEqual(s["backend"], "numpy")
        self.assertEqual(s["n_calls"], 1)
        self.assertGreater(s["n_cpu"], 0)

    def test_benchmark(self):
        # Small benchmark; should run
        r = benchmark(stop=64, factor=2, n_iters=1)
        self.assertIn("n", r)
        self.assertIn("cpu", r)
        self.assertIn("is_gpu_available", r)
        self.assertGreater(len(r["n"]), 0)


if __name__ == "__main__":
    unittest.main()