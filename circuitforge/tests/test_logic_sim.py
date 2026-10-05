"""Tests for the LEVEL 0 logic simulator."""

import unittest
from circuitforge.sim.logic import (
    LogicState, LogicEngine, simulate_logic, register_logic_components_in_library,
    parse_logic, format_logic, LogicSimResult,
)
from circuitforge.core import build_circuit, add_component, connect
from circuitforge.core.primitives import register_primitive_specs
from circuitforge.exceptions import SimulationError


def _make_logic_circuit(spec_name: str, n_inputs: int) -> tuple:
    """Build a circuit with the given logic spec and named A, B, ..., Y nets."""
    c = build_circuit(f"test_{spec_name}")
    register_logic_components_in_library(c.library)
    inputs = []
    for i in range(n_inputs):
        inp = add_component(c, "LOGIC_INPUT", reference=f"I{i}")
        inputs.append(inp)
    g = add_component(c, spec_name, reference="G")
    out = add_component(c, "LOGIC_OUTPUT", reference="O")
    for i, inp in enumerate(inputs):
        connect(c, inp.ports[0], g.ports[i])
    out_idx = n_inputs  # output port index after the inputs
    connect(c, g.ports[out_idx], out.ports[0])
    # Rename nets
    net_for_input = []
    for n in c.nets.values():
        if not n.name:
            for i, inp in enumerate(inputs):
                if inp.ports[0] in n.ports:
                    n.name = chr(ord("A") + i)
            if g.ports[out_idx] in n.ports:
                n.name = "Y"
    return c, [chr(ord("A") + i) for i in range(n_inputs)], "Y"


def _truth_table(c, input_names, output_name, vectors):
    """Run simulate_logic on each vector and return list of outputs."""
    out = []
    for v in vectors:
        inputs = {n: LogicState(int(b)) for n, b in zip(input_names, v)}
        res = simulate_logic(c, inputs)
        out.append(res.get_by_name(c, output_name))
    return out


class TestParseFormat(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_logic("0"), LogicState.LOGIC_0)
        self.assertEqual(parse_logic("1"), LogicState.LOGIC_1)
        self.assertEqual(parse_logic("X"), LogicState.LOGIC_X)
        self.assertEqual(parse_logic("Z"), LogicState.LOGIC_Z)
        with self.assertRaises(ValueError):
            parse_logic("foo")

    def test_format(self):
        self.assertEqual(format_logic(LogicState.LOGIC_0), "0")
        self.assertEqual(format_logic(LogicState.LOGIC_1), "1")
        self.assertEqual(format_logic(LogicState.LOGIC_X), "X")
        self.assertEqual(format_logic(LogicState.LOGIC_Z), "Z")


class TestGates(unittest.TestCase):
    """Test every standard gate against its truth table."""

    def _check(self, spec, n_inputs, table):
        c, in_names, out_name = _make_logic_circuit(spec, n_inputs)
        n = 1 << n_inputs
        for v in range(n):
            vector = tuple((v >> (n_inputs - 1 - i)) & 1 for i in range(n_inputs))
            res = simulate_logic(c, {n: LogicState(b) for n, b in zip(in_names, vector)})
            got = res.get_by_name(c, out_name)
            self.assertEqual(
                got, LogicState(table[v]),
                f"{spec}{vector} expected {table[v]}, got {got.name}"
            )

    def test_not(self):
        self._check("NOT", 1, [1, 0])

    def test_buffer(self):
        self._check("BUFFER", 1, [0, 1])

    def test_and(self):
        self._check("AND", 2, [0, 0, 0, 1])

    def test_or(self):
        self._check("OR", 2, [0, 1, 1, 1])

    def test_nand(self):
        self._check("NAND", 2, [1, 1, 1, 0])

    def test_nor(self):
        self._check("NOR", 2, [1, 0, 0, 0])

    def test_xor(self):
        self._check("XOR", 2, [0, 1, 1, 0])

    def test_xnor(self):
        self._check("XNOR", 2, [1, 0, 0, 1])

    def test_and3(self):
        self._check("AND3", 3, [0, 0, 0, 0, 0, 0, 0, 1])

    def test_or3(self):
        self._check("OR3", 3, [0, 1, 1, 1, 1, 1, 1, 1])


class TestMux2(unittest.TestCase):
    def test_mux(self):
        c, in_names, out_name = _make_logic_circuit("MUX2", 3)
        # in_names = ['A', 'B', 'C']  -- a, b, sel
        cases = [
            (0, 1, 0, 0),  # sel=0 -> A=0
            (0, 1, 1, 1),  # sel=1 -> B=1
            (1, 0, 0, 1),
            (1, 0, 1, 0),
        ]
        for a, b, sel, expected in cases:
            res = simulate_logic(c, {
                "A": LogicState(a), "B": LogicState(b), "C": LogicState(sel)
            })
            self.assertEqual(res.get_by_name(c, "Y"), LogicState(expected),
                             f"MUX2 a={a} b={b} sel={sel}")


class TestPropagation(unittest.TestCase):
    def test_chained_gates(self):
        """NOT -> AND -> OR chain producing Y = A | ~A = 1 (when A defined)."""
        from circuitforge.core.ids import PortId
        c = build_circuit("chain")
        register_logic_components_in_library(c.library)
        ia = add_component(c, "LOGIC_INPUT", reference="IA")
        ib = add_component(c, "LOGIC_INPUT", reference="IB")
        na = add_component(c, "NOT", reference="NA")
        ab = add_component(c, "AND", reference="AB")
        oc = add_component(c, "OR", reference="OR")
        out = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, ia.ports[0], na.ports[0])
        connect(c, na.ports[1], ab.ports[1])
        connect(c, ib.ports[0], ab.ports[0])
        connect(c, ab.ports[2], oc.ports[0])
        connect(c, na.ports[1], oc.ports[1])
        connect(c, oc.ports[2], out.ports[0])
        # Rename nets by looking at the net each port is attached to
        def rename_for(pid, name):
            net_id = c.ports[PortId(int(pid))].net
            if net_id is not None:
                c.nets[net_id].name = name
        rename_for(ia.ports[0], "A")
        rename_for(ib.ports[0], "B")
        rename_for(oc.ports[2], "Y")
        names = {n.name for n in c.nets.values()}
        self.assertIn("A", names)
        self.assertIn("B", names)
        self.assertIn("Y", names)
        # Y = (B & ~A) | ~A
        expected = {
            (0, 0): 1,  # (0 & 1) | 1 = 1
            (0, 1): 1,  # (1 & 1) | 1 = 1
            (1, 0): 0,  # (0 & 0) | 0 = 0
            (1, 1): 0,  # (1 & 0) | 0 = 0
        }
        for a, b in expected:
            res = simulate_logic(c, {"A": LogicState(a), "B": LogicState(b)})
            self.assertEqual(
                res.get_by_name(c, "Y"),
                LogicState(expected[(a, b)]),
                f"a={a} b={b} expected {expected[(a, b)]}",
            )

    def test_unused_output_initial_x(self):
        """A net with no driver remains in initial X state."""
        c = build_circuit("u")
        register_logic_components_in_library(c.library)
        a = add_component(c, "LOGIC_INPUT", reference="IA")
        out = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, a.ports[0], out.ports[0])
        for n in c.nets.values():
            if not n.name:
                if a.ports[0] in n.ports: n.name = "A"
                else: n.name = "FLOATING"
        res = simulate_logic(c, {"A": LogicState.LOGIC_1})
        self.assertEqual(res.get_by_name(c, "FLOATING"), LogicState.LOGIC_X)


class TestStabilityAndConvergence(unittest.TestCase):
    def test_combination_loop_converges_to_x(self):
        """A 1-inverter loop has only X as a fixed point in 4-state logic."""
        c = build_circuit("loop")
        register_logic_components_in_library(c.library)
        inv = add_component(c, "NOT", reference="I")
        # output -> input forms a loop
        connect(c, inv.ports[1], inv.ports[0])
        res = simulate_logic(c, inputs={}, max_iterations=50)
        # Engine reaches a stable state (X on the loop net).
        self.assertTrue(res.stable)
        # The net's state is X (only fixed point of a=NOT(a) in {0,1,X,Z})
        # and no driver is set so initial is X.
        for n in c.nets.values():
            self.assertEqual(res.get(int(n.id)), LogicState.LOGIC_X)

    def test_engine_handles_many_iterations(self):
        """A long combinational chain converges in a few iterations."""
        from circuitforge.core.ids import PortId
        c = build_circuit("long")
        register_logic_components_in_library(c.library)
        inp = add_component(c, "LOGIC_INPUT", reference="I")
        prev = inp
        for k in range(50):
            inv = add_component(c, "NOT", reference=f"N{k}")
            connect(c, prev.ports[0], inv.ports[0])
            prev = inv
        out = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, prev.ports[1], out.ports[0])
        # Name the input net and output net
        c.ports[PortId(int(inp.ports[0]))].net
        in_net = c.ports[PortId(int(inp.ports[0]))].net
        out_net = c.ports[PortId(int(out.ports[0]))].net
        c.nets[in_net].name = "INP"
        c.nets[out_net].name = "OUT"
        res = simulate_logic(c, {"INP": LogicState.LOGIC_1})
        # 50 inversions of 1 => 0
        self.assertEqual(res.get_by_name(c, "OUT"), LogicState.LOGIC_0)


class TestEngineState(unittest.TestCase):
    def test_clear_inputs(self):
        eng = LogicEngine()
        eng.set_input(0, LogicState.LOGIC_1)
        self.assertEqual(eng._inputs[0], LogicState.LOGIC_1)
        eng.clear_inputs()
        self.assertEqual(eng._inputs, {})


if __name__ == "__main__":
    unittest.main()
