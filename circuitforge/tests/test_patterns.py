"""Tests for the auto-detection of repeated subcircuits."""

import unittest

from circuitforge.core import build_circuit
from circuitforge.patterns import find_repeated_patterns
from circuitforge.sim.logic import register_logic_components_in_library
from circuitforge.core.ids import ComponentId


class TestPatternDetection(unittest.TestCase):

    def test_no_repetition(self):
        c = build_circuit("unique")
        register_logic_components_in_library(c.library)
        # Just a single NOT chain
        from circuitforge.core import add_component, connect
        a = add_component(c, "LOGIC_INPUT", reference="A")
        n1 = add_component(c, "NOT", reference="N1")
        n2 = add_component(c, "NOT", reference="N2")
        o = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, a.ports[0], n1.ports[0])
        connect(c, n1.ports[1], n2.ports[0])
        connect(c, n2.ports[1], o.ports[0])
        patterns = find_repeated_patterns(c)
        # Nothing repeats
        self.assertEqual(patterns, [])

    def test_find_duplicate_pair(self):
        c = build_circuit("dup")
        register_logic_components_in_library(c.library)
        from circuitforge.core import add_component, connect
        # Two independent NOT gates (disjoint subgraphs sharing only inputs)
        a = add_component(c, "LOGIC_INPUT", reference="A")
        b = add_component(c, "LOGIC_INPUT", reference="B")
        n1 = add_component(c, "NOT", reference="N1")
        n2 = add_component(c, "NOT", reference="N2")
        o1 = add_component(c, "LOGIC_OUTPUT", reference="O1")
        o2 = add_component(c, "LOGIC_OUTPUT", reference="O2")
        connect(c, a.ports[0], n1.ports[0])
        connect(c, n1.ports[1], o1.ports[0])
        connect(c, b.ports[0], n2.ports[0])
        connect(c, n2.ports[1], o2.ports[0])
        patterns = find_repeated_patterns(c, max_components_per_pattern=10)
        # At least one pattern should be detected
        self.assertGreater(len(patterns), 0)
        # The NOT gate should appear with at least 2 occurrences
        not_patterns = [p for p in patterns if "NOT" in p.spec_signature]
        self.assertGreaterEqual(sum(p.occurrences for p in not_patterns), 2)


if __name__ == "__main__":
    unittest.main()