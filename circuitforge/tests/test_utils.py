"""Tests for the utility layer (RNG, hashing, units, versions)."""

import unittest

from circuitforge.utils import (
    DeterministicRNG, get_rng, reset_global_rng, seed_from_string,
    stable_hash, content_hash,
    Voltage, Current, Resistance, Power, Energy, Capacitance, Inductance,
    Temperature, Frequency, Time,
    Q_, V, A, OHM, F, H, W, J, K, HZ, S, Unit, Quantity, UnitMismatch,
    human_si, c_to_k, k_to_c,
    engine_version, schema_version, format_version_info,
)
from circuitforge.exceptions import CircuitForgeError


class TestDeterministicRNG(unittest.TestCase):

    def test_determinism(self):
        a = DeterministicRNG(42)
        b = DeterministicRNG(42)
        self.assertEqual([a.random() for _ in range(10)], [b.random() for _ in range(10)])

    def test_seed_from_string(self):
        self.assertIsInstance(seed_from_string("hello"), int)
        self.assertEqual(seed_from_string("a"), seed_from_string("a"))
        self.assertNotEqual(seed_from_string("a"), seed_from_string("b"))

    def test_fork_is_deterministic_and_independent(self):
        # Two independent parents with the same seed should produce the
        # same sequence of child seeds.
        a = DeterministicRNG(123)
        b = DeterministicRNG(123)
        for label in ("foo", "bar", "baz"):
            ca = a.fork(label)
            cb = b.fork(label)
            self.assertEqual(ca.seed, cb.seed, f"mismatch on label {label}")
        # Children draw independently: two parents with same seed produce
        # the same child draw
        c1 = a.fork("x")
        c2 = b.fork("x")
        self.assertEqual(c1.random(), c2.random())
        # Different label under same parent -> different child seed
        self.assertNotEqual(a.fork("u").seed, a.fork("v").seed)

    def test_global_reset(self):
        r1 = reset_global_rng(7)
        x1 = r1.random()
        x2 = r1.random()
        r2 = reset_global_rng(7)
        self.assertEqual(x1, r2.random())
        self.assertEqual(x2, r2.random())

    def test_ndarray_consistency(self):
        a = DeterministicRNG(99)
        b = DeterministicRNG(99)
        import numpy as np
        np.testing.assert_array_equal(
            a.np_integers(0, 100, size=5),
            b.np_integers(0, 100, size=5),
        )


class TestHashes(unittest.TestCase):

    def test_stable_hash_dict_key_order_invariant(self):
        self.assertEqual(stable_hash({"a": 1, "b": 2}), stable_hash({"b": 2, "a": 1}))

    def test_content_hash(self):
        self.assertEqual(content_hash(b"abc"), content_hash(b"abc"))
        self.assertNotEqual(content_hash(b"abc"), content_hash(b"abd"))


class TestUnits(unittest.TestCase):

    def test_arithmetic_same_unit(self):
        v1 = Voltage(1.0)
        v2 = Voltage(2.5)
        self.assertAlmostEqual((v1 + v2).value, 3.5)
        self.assertAlmostEqual((v2 - v1).value, 1.5)

    def test_arithmetic_unit_mismatch(self):
        with self.assertRaises(UnitMismatch):
            Voltage(1.0) + Current(1.0)
        with self.assertRaises(UnitMismatch):
            Voltage(1.0) - Current(1.0)

    def test_multiplication_creates_product_unit(self):
        v = Voltage(3.0)
        i = Current(0.5)
        p = v * i
        self.assertAlmostEqual(p.value, 1.5)
        self.assertIn("V", p.unit.symbol)
        self.assertIn("A", p.unit.symbol)

    def test_division_same_unit_is_dimensionless(self):
        v1 = Voltage(2.0)
        v2 = Voltage(4.0)
        r = v2 / v1
        self.assertAlmostEqual(r.value, 2.0)
        self.assertEqual(r.unit.name, "dimensionless")

    def test_human_si(self):
        self.assertEqual(human_si(0, F), "0 F")
        self.assertEqual(human_si(1e-9, F), "1 nF")
        self.assertEqual(human_si(1e-6, F), "1 µF")
        self.assertEqual(human_si(1e-12, F), "1 pF")
        self.assertEqual(human_si(1e3, OHM), "1 kΩ")
        self.assertEqual(human_si(2.2e3, OHM), "2.2 kΩ")
        self.assertEqual(human_si(1e-3, A), "1 mA")

    def test_temperature_helpers(self):
        self.assertAlmostEqual(c_to_k(0), 273.15)
        self.assertAlmostEqual(c_to_k(25), 298.15)
        self.assertAlmostEqual(k_to_c(273.15), 0)
        self.assertAlmostEqual(k_to_c(298.15), 25)

    def test_unit_mismatch_is_circuitforge_error(self):
        with self.assertRaises(CircuitForgeError):
            raise UnitMismatch(V, A, op="test")

    def test_str_and_repr(self):
        v = Voltage(1.0)
        s = str(v)
        self.assertIn("1", s)
        self.assertIn("V", s)
        self.assertIn("V", repr(v))


class TestVersion(unittest.TestCase):

    def test_format_version_info(self):
        info = format_version_info()
        self.assertIn("CircuitForge", info)
        self.assertIn("engine=", info)
        self.assertIn("schema=", info)


if __name__ == "__main__":
    unittest.main()
