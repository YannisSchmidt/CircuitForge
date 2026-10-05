"""Tests for the thermal model."""

import math
import unittest

from circuitforge.thermal import (
    default_thermal_for_circuit, run_thermal,
    ThermalNode, ThermalNetwork, ThermalSimResult,
    coupled_electrical_thermal,
)
from circuitforge.core import build_circuit, add_component


class TestThermalNetwork(unittest.TestCase):

    def test_extraction(self):
        c = build_circuit("hot")
        add_component(c, "NMOS", reference="M1", rth=100.0, cth=1e-3, temp=300.15)
        add_component(c, "RESISTOR", reference="R1", r=1000)  # no thermal
        net = default_thermal_for_circuit(c)
        self.assertEqual(len(net.nodes), 1)
        # NMOS is the first added, so its id is 0
        self.assertIn(0, net.nodes)
        self.assertEqual(net.nodes[0].rth_to_amb, 100.0)
        self.assertEqual(net.nodes[0].cth, 1e-3)

    def test_steady_state_temperature(self):
        c = build_circuit("hot")
        m = add_component(c, "NMOS", reference="M1", rth=100.0, cth=1e-3, temp=300.15)
        net = default_thermal_for_circuit(c)
        series = [(0, {m.id: 1.0}), (20, {m.id: 1.0})]
        res = run_thermal(net, series, t_stop=20.0, dt=0.1)
        self.assertAlmostEqual(res.temperatures[m.id][-1], 400.15, places=4)

    def test_zero_power_no_heating(self):
        c = build_circuit("hot")
        m = add_component(c, "NMOS", reference="M1", rth=100.0, cth=1e-3, temp=300.15)
        net = default_thermal_for_circuit(c)
        series = [(0, {m.id: 0.0}), (10, {m.id: 0.0})]
        res = run_thermal(net, series, t_stop=10.0, dt=0.1)
        self.assertAlmostEqual(res.temperatures[m.id][-1], 300.15, places=4)

    def test_exponential_transient(self):
        c = build_circuit("hot")
        m = add_component(c, "NMOS", reference="M1", rth=100.0, cth=1e-3, temp=300.15)
        net = default_thermal_for_circuit(c)
        series = [(0, {m.id: 1.0}), (10, {m.id: 1.0})]
        res = run_thermal(net, series, t_stop=1.0, dt=0.001)
        for t in [0.1, 0.5, 1.0]:
            idx = int(t / 0.001)
            expected = 300.15 + 100.0 * (1 - math.exp(-t / 0.1))
            # Backward Euler gives 1% accuracy; allow 2K tolerance
            self.assertAlmostEqual(res.temperatures[m.id][idx], expected, delta=2.0,
                                   msg=f"t={t}")


class TestCoupling(unittest.TestCase):

    def test_feedback_writes_back_temp(self):
        c = build_circuit("hot")
        m = add_component(c, "NMOS", reference="M1", rth=100.0, cth=1e-3, temp=300.15)
        net = default_thermal_for_circuit(c)
        series = [(0, {m.id: 1.0}), (5, {m.id: 1.0})]
        run_thermal(net, series, t_stop=5.0, dt=0.01)
        coupled_electrical_thermal(c, series, t_stop=5.0, dt=0.01,
                                    ambient_temp=300.15, feedback=True)
        self.assertGreater(m.params["temp"], 300.15)
        self.assertLess(m.params["temp"], 500.0)


if __name__ == "__main__":
    unittest.main()
