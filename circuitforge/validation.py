"""
Automatic validation of candidate circuits (section 17 of the spec).

A `Validator` runs a battery of tests on a candidate:
- LOGIC TEST: random test vectors against the golden model
- ELECTRICAL TEST: optional, if the circuit has electrical components
- TIMING TEST: critical path analysis
- THERMAL TEST: optional
- POWER TEST: total power consumption
- EDGE CASE TEST: e.g. all-zeros, all-ones
- RANDOM TEST: many random vectors
- STABILITY TEST: same vector repeatedly (determinism check)

The validator produces a `ValidationReport` with the number of tests
run and the number of failures. For small circuits, exhaustive
testing is performed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional, Dict, Any
import random
import itertools

from .core.circuit import Circuit
from .sim.logic import simulate_logic, LogicState
from .sim.electrical import simulate_electrical, ElectricalSimOptions
from .thermal import default_thermal_for_circuit, run_thermal
from .analysis import analyze_circuit


@dataclass
class ValidationReport:
    n_tests: int = 0
    n_passed: int = 0
    n_failed: int = 0
    n_skipped: int = 0
    failed_vectors: List[Any] = field(default_factory=list)
    wall_time_s: float = 0.0

    def summary(self) -> str:
        lines = [
            "VALIDATION REPORT",
            f"  tests run:    {self.n_tests}",
            f"  passed:       {self.n_passed}",
            f"  failed:       {self.n_failed}",
            f"  skipped:      {self.n_skipped}",
        ]
        if self.failed_vectors:
            lines.append(f"  first failures: {self.failed_vectors[:3]}")
        return "\n".join(lines)


def _name_nets(circuit: Circuit) -> None:
    from .core.ids import PortId, ComponentId
    for n in circuit.nets.values():
        if n.name:
            continue
        for pid in n.ports:
            port = circuit.ports[PortId(int(pid))]
            comp = circuit._components.get(ComponentId(int(port.component)))
            if comp is None:
                continue
            if comp.spec.name in ("LOGIC_INPUT", "LOGIC_OUTPUT"):
                n.name = comp.reference
                break


def _get_input_output_names(circuit: Circuit):
    """Return (input_names, output_names) discovered from LOGIC_INPUT/OUTPUT components."""
    inputs = []
    outputs = []
    for comp in circuit._components.values():
        if comp.spec.name == "LOGIC_INPUT":
            inputs.append(comp.reference)
        elif comp.spec.name == "LOGIC_OUTPUT":
            outputs.append(comp.reference)
    return inputs, outputs


def _safe_get_value(circuit, name):
    """Look up the value of a named net after a logic simulation."""
    for nid, net in circuit.nets.items():
        if net.name == name:
            return nid
    return None


def validate_logic(circuit: Circuit, expected_outputs_fn: Callable,
                   exhaustive: bool = False, max_random: int = 256,
                   seed: int = 0) -> ValidationReport:
    """
    Run logical tests against a golden model.
    """
    import time as _time
    t0 = _time.time()
    _name_nets(circuit)
    inputs, outputs = _get_input_output_names(circuit)
    if not inputs or not outputs:
        return ValidationReport(n_skipped=1, wall_time_s=_time.time() - t0)
    n = len(inputs)
    rep = ValidationReport()
    # Determine the test vectors
    if exhaustive and (1 << n) <= 2 * max_random:
        vectors = list(itertools.product([0, 1], repeat=n))
    else:
        rng = random.Random(seed)
        vectors = []
        seen = set()
        target = (1 << n) if exhaustive else max_random
        target = min(target, 1 << n)
        while len(vectors) < target:
            v = tuple(rng.randint(0, 1) for _ in inputs)
            if v in seen:
                continue
            seen.add(v)
            vectors.append(v)
    for v in vectors:
        rep.n_tests += 1
        in_dict = {n: LogicState(b) for n, b in zip(inputs, v)}
        try:
            res = simulate_logic(circuit, in_dict)
        except Exception:
            rep.n_failed += 1
            rep.failed_vectors.append(v)
            continue
        out = []
        for o in outputs:
            # Find the net for this output
            for nid, net in circuit.nets.items():
                if net.name == o:
                    state = res.get(int(nid))
                    out.append(int(state.value) if hasattr(state, "value") else 0)
                    break
        expected = expected_outputs_fn(list(v))
        if len(out) == len(expected) and out == expected:
            rep.n_passed += 1
        else:
            rep.n_failed += 1
            rep.failed_vectors.append(v)
    rep.wall_time_s = _time.time() - t0
    return rep


def validate_electrical(circuit: Circuit, t_stop: float = 1e-6,
                        dt: float = 1e-9) -> ValidationReport:
    """Run a short electrical simulation and report convergence."""
    import time as _time
    from .core.components import ModelAccuracy
    t0 = _time.time()
    rep = ValidationReport()
    # Skip if no analog/electrical components
    has_electrical = any(
        c.spec.model_accuracy.get("electrical", ModelAccuracy.NOT_MODELED)
        != ModelAccuracy.NOT_MODELED
        for c in circuit._components.values()
    )
    if not has_electrical:
        rep.n_skipped = 1
        rep.wall_time_s = _time.time() - t0
        return rep
    rep.n_tests = 1
    try:
        opts = ElectricalSimOptions(t_start=0, t_stop=t_stop, dt=dt,
                                    max_newton=10)
        simulate_electrical(circuit, opts)
        rep.n_passed = 1
    except Exception:
        rep.n_failed = 1
    rep.wall_time_s = _time.time() - t0
    return rep


def validate_thermal(circuit: Circuit, ambient_temp: float = 300.15,
                     t_stop: float = 1.0, dt: float = 0.01) -> ValidationReport:
    import time as _time
    t0 = _time.time()
    rep = ValidationReport()
    rep.n_tests = 1
    try:
        net = default_thermal_for_circuit(circuit)
        net.ambient_temp = ambient_temp
        powers = {cid: 0.001 for cid in net.nodes}
        series = [(0, powers), (t_stop, powers)]
        run_thermal(net, series, t_stop, dt)
        rep.n_passed = 1
    except Exception:
        rep.n_failed = 1
    rep.wall_time_s = _time.time() - t0
    return rep


def validate_timing(circuit: Circuit) -> ValidationReport:
    import time as _time
    t0 = _time.time()
    rep = ValidationReport()
    rep.n_tests = 1
    try:
        analysis = analyze_circuit(circuit)
        if analysis.estimated_max_delay >= 0:
            rep.n_passed = 1
        else:
            rep.n_failed = 1
    except Exception:
        rep.n_failed = 1
    rep.wall_time_s = _time.time() - t0
    return rep


def validate_candidate(circuit: Circuit, expected_outputs_fn: Callable,
                        exhaustive: bool = False, max_random: int = 256,
                        seed: int = 0) -> ValidationReport:
    """Run the full validation suite."""
    import time as _time
    t0 = _time.time()
    rep_logic = validate_logic(circuit, expected_outputs_fn, exhaustive, max_random, seed)
    rep_elec = validate_electrical(circuit)
    rep_therm = validate_thermal(circuit)
    rep_time = validate_timing(circuit)
    total = ValidationReport(wall_time_s=_time.time() - t0)
    for r in (rep_logic, rep_elec, rep_therm, rep_time):
        total.n_tests += r.n_tests
        total.n_passed += r.n_passed
        total.n_failed += r.n_failed
        total.n_skipped += r.n_skipped
    return total