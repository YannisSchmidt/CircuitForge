"""Tests for the validation module."""

import unittest

from circuitforge.optim.templates import BitAdderTemplate
from circuitforge.validation import (
    validate_logic, validate_electrical, validate_thermal,
    validate_timing, validate_candidate,
)


def _adder_golden(v):
    n = (len(v) - 1) // 2
    a = sum(v[i] << i for i in range(n))
    b = sum(v[n + i] << i for i in range(n))
    cin = v[2 * n]
    s = a + b + cin
    return [(s >> i) & 1 for i in range(n)] + [(s >> n) & 1]


class TestLogicValidation(unittest.TestCase):

    def test_4bit_adder_full_exhaustive(self):
        t = BitAdderTemplate(n_bits=4)
        c = t.instantiate({"n_bits": 4})
        rep = validate_logic(c, _adder_golden, exhaustive=True, max_random=1024)
        # 9 inputs => 512 vectors
        self.assertEqual(rep.n_tests, 512)
        self.assertEqual(rep.n_failed, 0)

    def test_8bit_adder_random(self):
        t = BitAdderTemplate(n_bits=8)
        c = t.instantiate({"n_bits": 8})
        rep = validate_logic(c, _adder_golden, exhaustive=False, max_random=100)
        self.assertEqual(rep.n_tests, 100)
        self.assertEqual(rep.n_failed, 0)

    def test_broken_candidate_fails(self):
        # Use a 2-bit adder but pretend it's 4-bit: this should fail
        # on vectors where the high bits matter.
        t = BitAdderTemplate(n_bits=2)
        c = t.instantiate({"n_bits": 2})
        def bad_golden(v):
            # Pretend the outputs include the 4-bit interpretation
            return _adder_golden(list(v) + [0] * 6)
        rep = validate_logic(c, bad_golden, exhaustive=True)
        self.assertGreater(rep.n_failed, 0)


class TestElectricalValidation(unittest.TestCase):

    def test_pure_logic_circuit_no_electrical_issue(self):
        # A purely-logic circuit (no analog components) should not
        # have any electrical issues.
        from circuitforge.core import build_circuit, add_component, connect, Ground
        from circuitforge.sim.logic import register_logic_components_in_library
        from circuitforge.core.primitives import register_primitive_specs
        c = build_circuit("logic")
        register_logic_components_in_library(c.library)
        a = add_component(c, "LOGIC_INPUT", reference="A")
        b = add_component(c, "LOGIC_INPUT", reference="B")
        g = add_component(c, "AND", reference="G")
        out = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, a.ports[0], g.ports[0])
        connect(c, b.ports[0], g.ports[1])
        connect(c, g.ports[2], out.ports[0])
        rep = validate_electrical(c)
        # Either runs and passes/fails, or is skipped for purely-logic
        # circuits. We accept all of these as graceful.
        self.assertGreaterEqual(rep.n_tests + rep.n_skipped, 1)
        self.assertEqual(rep.n_failed, 0)


class TestThermalValidation(unittest.TestCase):

    def test_thermal_no_components(self):
        from circuitforge.core import build_circuit
        c = build_circuit("empty")
        rep = validate_thermal(c)
        # No thermal nodes; should pass
        self.assertEqual(rep.n_failed, 0)


class TestTimingValidation(unittest.TestCase):

    def test_timing_chain(self):
        from circuitforge.core import build_circuit, add_component, connect
        from circuitforge.sim.logic import register_logic_components_in_library
        c = build_circuit("timing")
        register_logic_components_in_library(c.library)
        a = add_component(c, "LOGIC_INPUT", reference="A")
        inv = add_component(c, "NOT", reference="INV")
        out = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, a.ports[0], inv.ports[0])
        connect(c, inv.ports[1], out.ports[0])
        rep = validate_timing(c)
        self.assertEqual(rep.n_failed, 0)


class TestFullValidation(unittest.TestCase):

    def test_full_suite(self):
        t = BitAdderTemplate(n_bits=4)
        c = t.instantiate({"n_bits": 4})
        rep = validate_candidate(c, _adder_golden, exhaustive=True)
        self.assertEqual(rep.n_failed, 0)


if __name__ == "__main__":
    unittest.main()