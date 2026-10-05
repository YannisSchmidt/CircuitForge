"""Tests for the stress-test suite.

These tests run a subset of the stress tests to verify the harness
works. The full stress suite is meant to be run on demand.
"""

import unittest

from circuitforge.stress import (
    StressResult,
    stress_wide_bus, stress_persistence, run_all_stress_tests,
)


class TestStress(unittest.TestCase):

    def test_persistence(self):
        r = stress_persistence(n_cycles=2)
        self.assertIsInstance(r, StressResult)
        self.assertIsNone(r.error, msg=f"persistence errored: {r.error}")

    def test_wide_bus(self):
        r = stress_wide_bus(n_wires=8)
        self.assertIsInstance(r, StressResult)
        self.assertIsNone(r.error, msg=f"wide_bus errored: {r.error}")

    def test_run_all_returns_list(self):
        results = run_all_stress_tests()
        self.assertIsInstance(results, list)
        self.assertEqual(len(results), 4)


if __name__ == "__main__":
    unittest.main()