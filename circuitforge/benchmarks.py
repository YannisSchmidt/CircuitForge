"""
Benchmark suite (section 31 of the spec).

Each benchmark returns a ``BenchmarkResult`` with timing, memory
and verification metrics. The result includes a "passed" flag and
notes about the configuration used (so that benchmark results are
reproducible and comparable).
"""

from __future__ import annotations

import time
import resource
import math
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Any, Optional


@dataclass
class BenchmarkResult:
    name: str
    passed: bool
    elapsed_s: float
    memory_kb: int
    notes: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def summary(self) -> str:
        return (
            f"{self.name}: {'PASS' if self.passed else 'FAIL'} "
            f"({self.elapsed_s * 1000:.2f} ms, {self.memory_kb} KB)"
        )


def _memory_kb() -> int:
    """Get current process memory usage in KB (best effort)."""
    try:
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except Exception:
        return 0


def _run(name: str, fn: Callable[[], Dict[str, Any]],
         validate: Callable[[Dict[str, Any]], bool]) -> BenchmarkResult:
    mem_before = _memory_kb()
    t0 = time.perf_counter()
    try:
        data = fn()
        elapsed = time.perf_counter() - t0
        passed = validate(data)
    except Exception as e:
        elapsed = time.perf_counter() - t0
        return BenchmarkResult(
            name=name, passed=False, elapsed_s=elapsed,
            memory_kb=_memory_kb() - mem_before,
            error=str(e),
        )
    return BenchmarkResult(
        name=name, passed=passed, elapsed_s=elapsed,
        memory_kb=_memory_kb() - mem_before,
        notes=data,
    )


# Individual benchmarks --------------------------------------------------------

def bench_logic_scaling() -> BenchmarkResult:
    """Time a logic simulation on a chain of N NOT gates for N=10, 100, 1000."""
    from .core import build_circuit, add_component, connect
    from .core.ids import PortId, NetId
    from .sim.logic import register_logic_components_in_library, simulate_logic, LogicState
    def run():
        out = {}
        for n in (10, 100, 1000):
            c = build_circuit("chain")
            register_logic_components_in_library(c.library)
            a = add_component(c, "LOGIC_INPUT", reference="A")
            comps = [a]
            for i in range(n):
                g = add_component(c, "NOT", reference=f"N{i}")
                connect(c, comps[-1].ports[0], g.ports[0])
                comps.append(g)
            o = add_component(c, "LOGIC_OUTPUT", reference="O")
            connect(c, comps[-1].ports[0], o.ports[0])
            # Name the input net
            port = c.ports[PortId(int(a.ports[0]))]
            if port.net is not None:
                try:
                    c._nets[NetId(int(port.net))].name = "A"
                except KeyError:
                    pass
            t0 = time.perf_counter()
            simulate_logic(c, {"A": LogicState(1)})
            out[f"n={n}_s"] = time.perf_counter() - t0
        return out
    return _run(
        "logic_scaling",
        run,
        lambda d: all(v < 5.0 for v in d.values()),
    )


def bench_electrical_scaling() -> BenchmarkResult:
    """Time an electrical simulation on a resistor ladder for several N."""
    from .core import build_circuit, add_component, connect, Ground
    from .core.ids import PortId
    from .sim.electrical import simulate_electrical, ElectricalSimOptions
    def run():
        out = {}
        for n in (3, 6, 12):
            c = build_circuit("ladder")
            # Series chain: VSRC -> R1 -> R2 -> ... -> Rn -> GND
            vdd = add_component(c, "VSRC_DC", reference="VDD", vdc=5.0)
            g = Ground(c)
            connect(c, vdd.ports[1], g.ports[0])
            last_port = vdd.ports[0]
            for i in range(n):
                r = add_component(c, "RESISTOR", reference=f"R{i}", r=1000)
                connect(c, last_port, r.ports[0])
                connect(c, r.ports[1], g.ports[0])
            opts = ElectricalSimOptions(t_start=0, t_stop=1e-6, dt=1e-7,
                                         max_newton=10)
            t0 = time.perf_counter()
            try:
                simulate_electrical(c, opts)
                out[f"n={n}_s"] = time.perf_counter() - t0
            except Exception as e:
                out[f"n={n}_error"] = str(e)
        return out
    return _run(
        "electrical_scaling",
        run,
        lambda d: sum(1 for k in d if k.endswith("_s")) >= 1,
    )


def bench_thermal_steady() -> BenchmarkResult:
    """Time a thermal simulation reaching steady state on a chip."""
    from .core import build_circuit, add_component
    from .thermal import default_thermal_for_circuit, run_thermal
    def run():
        c = build_circuit("chip")
        # 20 components
        for i in range(20):
            add_component(c, "RESISTOR", reference=f"R{i}")
        net = default_thermal_for_circuit(c)
        powers = {cid: 0.1 for cid in net.nodes}
        series = [(0, powers), (1, powers), (2, powers), (3, powers), (4, powers)]
        t0 = time.perf_counter()
        result = run_thermal(net, series, t_stop=5, dt=0.1)
        return {"elapsed": time.perf_counter() - t0,
                "t_max": result.t_max,
                "wall_time_s": result.wall_time_s}
    return _run(
        "thermal_steady",
        run,
        lambda d: d["t_max"] > 300,
    )


def bench_optim_speed() -> BenchmarkResult:
    """Time a small auto_design run."""
    from .optim.specification import AutoDesignSpec, ALU_SPEC
    from .optim.synthesizer import auto_design
    from .optim.search import SearchConfig
    def run():
        cfg = SearchConfig(population_size=8, n_generations=4, time_budget_s=10,
                            seed=0)
        spec = ALU_SPEC(4)
        t0 = time.perf_counter()
        try:
            cand = auto_design(spec, cfg)
            ok = cand is not None
        except Exception:
            ok = False
        return {"elapsed": time.perf_counter() - t0, "ok": ok}
    return _run(
        "optim_speed",
        run,
        lambda d: d["ok"] and d["elapsed"] < 30,
    )


def bench_pattern_detection() -> BenchmarkResult:
    """Time pattern detection on a duplicate-heavy circuit."""
    from .core import build_circuit, add_component, connect
    from .sim.logic import register_logic_components_in_library
    from .patterns import find_repeated_patterns
    def run():
        c = build_circuit("dup")
        register_logic_components_in_library(c.library)
        # 100 NOT gates
        for i in range(50):
            a = add_component(c, "LOGIC_INPUT", reference=f"A{i}")
            n = add_component(c, "NOT", reference=f"N{i}")
            o = add_component(c, "LOGIC_OUTPUT", reference=f"O{i}")
            connect(c, a.ports[0], n.ports[0])
            connect(c, n.ports[1], o.ports[0])
        t0 = time.perf_counter()
        patterns = find_repeated_patterns(c)
        return {"elapsed": time.perf_counter() - t0,
                "n_patterns": len(patterns)}
    return _run(
        "pattern_detection",
        run,
        lambda d: d["elapsed"] < 5,
    )


# Public runner ---------------------------------------------------------------

def run_all_benchmarks() -> List[BenchmarkResult]:
    """Run all benchmarks and return a list of results."""
    return [
        bench_logic_scaling(),
        bench_electrical_scaling(),
        bench_thermal_steady(),
        bench_optim_speed(),
        bench_pattern_detection(),
    ]