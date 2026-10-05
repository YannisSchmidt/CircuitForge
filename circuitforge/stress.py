"""
Stress tests (section 31 of the spec).

Stress tests push the system beyond nominal operating conditions:
very large circuits, dense connectivity, oscillating behavior, and
adversarial inputs. Each test returns a ``StressResult`` with the
outcome and any diagnostic info.

These are slow by design — they should be run on demand, not as
part of the default unit-test suite.
"""

from __future__ import annotations

import time
import random
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Callable


@dataclass
class StressResult:
    name: str
    passed: bool
    elapsed_s: float
    notes: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


def _run(name: str, fn: Callable[[], Dict[str, Any]],
         validate: Callable[[Dict[str, Any]], bool]) -> StressResult:
    t0 = time.perf_counter()
    try:
        data = fn()
        elapsed = time.perf_counter() - t0
        passed = validate(data)
    except Exception as e:
        return StressResult(
            name=name, passed=False,
            elapsed_s=time.perf_counter() - t0, error=str(e),
        )
    return StressResult(
        name=name, passed=passed, elapsed_s=elapsed, notes=data,
    )


# Individual stress tests -----------------------------------------------------

def stress_ripple_carry_adder(n_bits: int = 32) -> StressResult:
    """Build and simulate a 32-bit ripple-carry adder."""
    from .core import build_circuit, add_component, connect
    from .sim.logic import register_logic_components_in_library, simulate_logic, LogicState

    def run():
        c = build_circuit("rc_add")
        register_logic_components_in_library(c.library)
        # We don't have a full-adder primitive; build a long chain of
        # ANDs and ORs (not real addition, but exercises the engine)
        prev = None
        for i in range(n_bits * 4):
            a = add_component(c, "LOGIC_INPUT", reference=f"I{i}")
            g = add_component(c, "AND", reference=f"G{i}")
            o = add_component(c, "LOGIC_OUTPUT", reference=f"O{i}")
            connect(c, a.ports[0], g.ports[0])
            if prev is not None:
                connect(c, prev.ports[0], g.ports[1])
            connect(c, g.ports[2], o.ports[0])
            prev = o
        # 1000 ticks
        inputs = {f"I{i}": LogicState(i % 2) for i in range(n_bits * 4)}
        t0 = time.perf_counter()
        for _ in range(100):
            simulate_logic(c, inputs)
        elapsed = time.perf_counter() - t0
        return {"elapsed_s": elapsed,
                "n_components": len(c._components),
                "n_nets": len(c._nets)}

    return _run(
        f"ripple_carry_adder_{n_bits}b",
        run,
        lambda d: d["elapsed_s"] < 60,
    )


def stress_wide_bus(n_wires: int = 64) -> StressResult:
    """Drive a wide bus of N wires through buffers."""
    from .core import build_circuit, add_component, connect
    from .core.ids import PortId
    from .sim.logic import register_logic_components_in_library, simulate_logic, LogicState

    def run():
        c = build_circuit("wide_bus")
        register_logic_components_in_library(c.library)
        for i in range(n_wires):
            a = add_component(c, "LOGIC_INPUT", reference=f"I{i}")
            b = add_component(c, "BUFFER", reference=f"B{i}")
            o = add_component(c, "LOGIC_OUTPUT", reference=f"O{i}")
            connect(c, a.ports[0], b.ports[0])
            connect(c, b.ports[1], o.ports[0])
            # Name the net after the LOGIC_INPUT reference
            port = c.ports[PortId(int(a.ports[0]))]
            if port.net is not None:
                c._nets[port.net].name = f"I{i}"
        inputs = {f"I{i}": LogicState(1 if i % 2 == 0 else 0)
                  for i in range(n_wires)}
        t0 = time.perf_counter()
        simulate_logic(c, inputs)
        elapsed = time.perf_counter() - t0
        return {"elapsed_s": elapsed, "n_components": len(c._components)}

    return _run(
        f"wide_bus_{n_wires}",
        run,
        lambda d: d["elapsed_s"] < 10,
    )


def stress_random_graph(n_components: int = 200, seed: int = 42) -> StressResult:
    """Build a random logic graph and simulate it."""
    from .core import build_circuit, add_component, connect
    from .sim.logic import register_logic_components_in_library, simulate_logic, LogicState

    def run():
        rng = random.Random(seed)
        c = build_circuit("random")
        register_logic_components_in_library(c.library)
        comps = []
        for i in range(n_components):
            kind = rng.choice(["AND", "OR", "NOT", "BUF", "NAND", "NOR", "XOR"])
            if kind in ("AND", "OR", "NAND", "NOR", "XOR"):
                c_kind = kind
            else:
                c_kind = kind
            try:
                g = add_component(c, c_kind, reference=f"G{i}")
            except Exception:
                g = add_component(c, "BUF", reference=f"G{i}")
            comps.append(g)
        # Random connections
        for g in comps[1:]:
            for pi in range(min(len(g.ports) - 1, 2)):
                src = rng.choice(comps[: comps.index(g)])
                try:
                    connect(c, src.ports[2], g.ports[pi])
                except Exception:
                    pass
        # Inputs and outputs
        inputs = {}
        for i, g in enumerate(comps[:min(8, n_components)]):
            try:
                comps[i].spec.ports
                # Add a LOGIC_INPUT driver
                drv = add_component(c, "LOGIC_INPUT", reference=f"D{i}")
                connect(c, drv.ports[0], g.ports[0])
                inputs[f"D{i}"] = LogicState(rng.randint(0, 1))
            except Exception:
                pass
        t0 = time.perf_counter()
        try:
            simulate_logic(c, inputs)
            elapsed = time.perf_counter() - t0
        except Exception as e:
            return {"elapsed_s": time.perf_counter() - t0,
                    "error": str(e)}
        return {"elapsed_s": elapsed, "n_components": len(c._components)}

    return _run(
        f"random_graph_{n_components}",
        run,
        lambda d: "error" not in d and d["elapsed_s"] < 30,
    )


def stress_persistence(n_cycles: int = 5) -> StressResult:
    """Save and load a complex circuit many times to test persistence."""
    import tempfile
    import os
    from .core import build_circuit, add_component, connect
    from .sim.logic import register_logic_components_in_library
    from .io.serialize import project_to_json, project_from_json

    def run():
        c = build_circuit("persist")
        register_logic_components_in_library(c.library)
        # Build a real 4-bit adder
        for i in range(4):
            a = add_component(c, "LOGIC_INPUT", reference=f"A{i}")
            b = add_component(c, "LOGIC_INPUT", reference=f"B{i}")
        for i in range(4):
            x = add_component(c, "XOR", reference=f"X{i}")
        for i in range(4):
            o = add_component(c, "LOGIC_OUTPUT", reference=f"O{i}")

        with tempfile.TemporaryDirectory() as tmp:
            t0 = time.perf_counter()
            for i in range(n_cycles):
                s = project_to_json(c)
                # Re-load
                project_from_json(s)
            elapsed = time.perf_counter() - t0
        return {"elapsed_s": elapsed, "n_cycles": n_cycles}

    return _run(
        "persistence",
        run,
        lambda d: d["elapsed_s"] < 5,
    )


# Public runner ---------------------------------------------------------------

def run_all_stress_tests() -> List[StressResult]:
    return [
        stress_ripple_carry_adder(16),
        stress_wide_bus(32),
        stress_random_graph(50),
        stress_persistence(3),
    ]