"""Tests for the benchmark suite."""

import unittest

from circuitforge.benchmarks import (
    BenchmarkResult,
    bench_logic_scaling, bench_electrical_scaling, bench_thermal_steady,
    bench_optim_speed, bench_pattern_detection, run_all_benchmarks,
)


class TestBenchmarks(unittest.TestCase):

    def test_benchmarks_runnable(self):
        # Run individual benchmarks; they must complete (pass or fail)
        for fn in (bench_logic_scaling, bench_thermal_steady,
                    bench_pattern_detection):
            r = fn()
            self.assertIsInstance(r, BenchmarkResult)
            self.assertGreaterEqual(r.elapsed_s, 0)

    def test_run_all_benchmarks(self):
        results = run_all_benchmarks()
        self.assertEqual(len(results), 5)
        for r in results:
            self.assertIsInstance(r, BenchmarkResult)
            self.assertIsNotNone(r.name)


if __name__ == "__main__":
    unittest.main()