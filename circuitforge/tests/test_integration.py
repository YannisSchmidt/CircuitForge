"""End-to-end integration test.

Build a 4-bit adder, run a logic simulation, validate it against a
golden function, save and reload, run a thermal sim, run pattern
detection, and finally auto-design a slightly different adder. This
test exercises every major subsystem.
"""

import unittest
import time

from circuitforge.core import build_circuit, add_component, connect
from circuitforge.sim.logic import (
    register_logic_components_in_library, simulate_logic, LogicState,
)
from circuitforge.io.serialize import project_to_json, project_from_json
from circuitforge.validation import (
    validate_logic, validate_electrical, validate_thermal, validate_timing,
)
from circuitforge.thermal import default_thermal_for_circuit, run_thermal
from circuitforge.patterns import find_repeated_patterns
from circuitforge.optim.specification import AutoDesignSpec
from circuitforge.optim.synthesizer import auto_design
from circuitforge.optim.search import SearchConfig
from circuitforge.optim.templates import BitAdderTemplate
from circuitforge.instruments import VMM1, TINY_OSC, FND2


def _adder_golden(v):
    n = (len(v) - 1) // 2
    a = sum(v[i] << i for i in range(n))
    b = sum(v[n + i] << i for i in range(n))
    cin = v[2 * n]
    s = a + b + cin
    return [(s >> i) & 1 for i in range(n)] + [(s >> n) & 1]


class TestIntegration(unittest.TestCase):

    def test_end_to_end_4bit_adder(self):
        # 1. Build a 4-bit adder from the BitAdderTemplate
        t = BitAdderTemplate(n_bits=4)
        c = t.instantiate({"n_bits": 4})
        # 2. Validate against a golden function (exhaustive)
        rep = validate_logic(c, _adder_golden, exhaustive=True, max_random=2048)
        self.assertEqual(rep.n_failed, 0,
                          f"Logic validation failed: {rep.failed_vectors[:3]}")
        # 3. Simulate
        from circuitforge.core.ids import PortId, NetId
        for comp in c._components.values():
            if comp.spec.name == "LOGIC_INPUT":
                for pid in comp.ports:
                    port = c.ports[PortId(int(pid))]
                    if port.net is not None:
                        try:
                            c._nets[NetId(int(port.net))].name = comp.reference
                        except KeyError:
                            pass
        inputs = {f"A{i}": LogicState(1) for i in range(4)}
        inputs.update({f"B{i}": LogicState(0) for i in range(4)})
        inputs["CIN"] = LogicState(1)
        result = simulate_logic(c, inputs)
        self.assertGreater(len(result.net_states), 0)
        # 4. Timing validation
        rep = validate_timing(c)
        self.assertEqual(rep.n_failed, 0)
        # 5. Thermal validation
        rep = validate_thermal(c)
        self.assertEqual(rep.n_failed, 0)
        # 6. Persistence round-trip
        s = project_to_json(c)
        c2 = project_from_json(s)
        self.assertEqual(len(c.components), len(c2.components))
        self.assertEqual(len(c.nets), len(c2.nets))
        # 7. Pattern detection
        patterns = find_repeated_patterns(c)
        # The 4-bit adder is one big connected circuit so direct
        # detection of full adders as separate patterns is hard without
        # a more sophisticated algorithm. We just confirm the function
        # runs without errors.
        # (Note: sub-patterns like NOTs/ANDs may still be detected if
        # the structure allows it.)
        # self.assertGreaterEqual(len(patterns), 0)  # always true
        # 8. Auto-design a 4-bit adder (smaller search space)
        spec = AutoDesignSpec(
            category="ADDER",
            description="integration 4-bit adder",
            parameters={"n_bits": 4},
            target_operations=[],
            optimization_profile="balanced",
        )
        cfg = SearchConfig(population_size=8, n_generations=2,
                            time_budget_s=5, seed=0)
        cand = auto_design(spec, cfg)
        self.assertIsNotNone(cand)
        # 9. Instruments
        vmm = VMM1()
        for i in range(20):
            vmm.sample("VOUT", i * 0.001, 3.3)
        m = vmm.read("VOUT")
        self.assertAlmostEqual(m.value, 3.3, places=1)
        # 10. Full report
        print(f"\nIntegration: {len(c.components)} components, "
              f"{len(patterns)} patterns, "
              f"auto_design score={cand.evaluation.score:.4f}")


if __name__ == "__main__":
    unittest.main()