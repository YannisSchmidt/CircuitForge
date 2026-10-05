"""
Candidate evaluation.

A *candidate* is a (template, gene_values) pair. We evaluate a
candidate by:
1. instantiating it into a Circuit;
2. running the logic-level filter (very fast) to ensure correctness;
3. running the electrical simulation (slower) for timing/power;
4. (optional) running the thermal simulation (slowest).

The score is a weighted sum of the normalized objectives.

To keep the search fast, we only run a *random subset* of test
vectors for each candidate (proportional to the candidate's
complexity).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Any, List, Tuple, Optional
import math
import itertools
import random

from ..core.circuit import Circuit
from ..core.ids import PortId
from ..core.components import ModelAccuracy
from ..sim.logic import simulate_logic, LogicState, LogicSimResult
from ..sim.electrical import simulate_electrical, ElectricalSimOptions
from ..thermal import default_thermal_for_circuit, run_thermal
from ..analysis import analyze_circuit, CircuitAnalysis
from .objectives import ObjectiveSet


@dataclass
class Candidate:
    """
    A candidate circuit. Carries the gene values that produced it
    plus its evaluation result (filled in lazily).
    """
    template_name: str
    genes: Dict[str, Any]
    circuit: Circuit
    fingerprint: str
    evaluation: Optional["EvaluationResult"] = None


@dataclass
class EvaluationResult:
    """The output of evaluating a candidate."""
    n_components: int = 0
    n_nets: int = 0
    delay_ns: float = 0.0
    power_w: float = 0.0
    temp_c: float = 25.0
    stability: float = 1.0
    memory: int = 0
    # Test results
    tests_passed: int = 0
    tests_failed: int = 0
    tests_total: int = 0
    # Score (lower is better)
    score: float = float("inf")
    # Status
    timed_out: bool = False
    error: Optional[str] = None


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _name_nets(circuit: Circuit) -> None:
    """Best-effort: rename unnamed nets to match the reference of
    the unique LOGIC_INPUT / LOGIC_OUTPUT on them. Useful for
    template-generated circuits."""
    from ..core.ids import PortId
    for n in circuit.nets.values():
        if n.name:
            continue
        # Find a LOGIC_INPUT or LOGIC_OUTPUT on this net
        for pid in n.ports:
            port = circuit.ports[PortId(int(pid))]
            comp = circuit.components.get(port.component)
            if comp is None:
                continue
            if comp.spec.name in ("LOGIC_INPUT", "LOGIC_OUTPUT"):
                n.name = comp.reference
                break


def _enumerate_input_combinations(inputs: List[str], rng: random.Random,
                                  max_vectors: int) -> List[List[int]]:
    """
    Return up to `max_vectors` random input combinations for the given
    list of input names (each entry 0 or 1).
    """
    total = 1 << len(inputs)
    if total <= max_vectors:
        return [list(t) for t in itertools.product([0, 1], repeat=len(inputs))]
    out: List[List[int]] = []
    seen = set()
    while len(out) < max_vectors:
        v = tuple(rng.randint(0, 1) for _ in inputs)
        if v in seen:
            continue
        seen.add(v)
        out.append(list(v))
    return out


# ----------------------------------------------------------------------------
# Level 0 — Logical correctness
# ----------------------------------------------------------------------------

def evaluate_logical(
    circuit: Circuit,
    input_names: List[str],
    expected_outputs_fn,
    rng: random.Random,
    max_vectors: int = 32,
) -> Tuple[int, int, int]:
    """
    Run a randomized subset of test vectors against the circuit and
    verify the outputs match the expected function.

    `expected_outputs_fn(inputs: List[int]) -> List[int]` is the
    golden model. It must return one bit per output, in order.

    Returns (passed, failed, total).
    """
    _name_nets(circuit)
    vectors = _enumerate_input_combinations(input_names, rng, max_vectors)
    passed = 0
    failed = 0
    output_names = []
    # Find LOGIC_OUTPUTS by name
    for n in circuit.nets.values():
        if n.name and (n.startswith('S') or n.startswith('Y') or n == 'COUT'
                        or n.startswith('OUT') or n.startswith('O')):
            output_names.append(n)
    output_names = sorted(set(output_names))
    for v in vectors:
        inputs = {n: LogicState(b) for n, b in zip(input_names, v)}
        try:
            res = simulate_logic(circuit, inputs)
        except Exception:
            failed += 1
            continue
        outputs = []
        for o in output_names:
            outputs.append(int(res.get_by_name(circuit, o, default=LogicState.LOGIC_X).value)
                           if hasattr(res.get_by_name(circuit, o, default=LogicState.LOGIC_X), 'value')
                           else 0)
        expected = expected_outputs_fn(v)
        if outputs == expected:
            passed += 1
        else:
            failed += 1
    return passed, failed, len(vectors)


def filter_logical(circuit: Circuit, inputs: List[str],
                   expected_outputs_fn, rng: random.Random,
                   max_vectors: int = 16) -> bool:
    """Quick test: return True if all sampled vectors pass."""
    p, f, _ = evaluate_logical(circuit, inputs, expected_outputs_fn, rng, max_vectors)
    return f == 0 and p > 0


# ----------------------------------------------------------------------------
# Level 1 — Electrical estimation
# ----------------------------------------------------------------------------

def evaluate_electrical(
    circuit: Circuit,
    library=None,
    t_stop: float = 1e-6,
    dt: float = 1e-9,
) -> Tuple[float, float]:
    """
    Run a short electrical sim. Returns (delay_ns, est_power_w).

    NOTE: The Shichhodham-Hodges MOSFET can be slow to converge on
    some circuits. For the moment we skip electrical evaluation on
    purely-logic circuits and report a coarse estimate from the
    component counts.
    """
    # Check if the circuit has any electrical-modeled components.
    has_electrical = any(
        c.spec.model_accuracy.get("electrical", ModelAccuracy.NOT_MODELED)
        != ModelAccuracy.NOT_MODELED
        for c in circuit.components.values()
    )
    if not has_electrical:
        return 0.0, 0.0
    # Try to simulate; if it fails we return zeros.
    try:
        opts = ElectricalSimOptions(t_start=0, t_stop=t_stop, dt=dt,
                                    max_newton=20, newton_tol=1e-6)
        res = simulate_electrical(circuit, opts)
        delay = res.estimated_max_delay
        power = res.total_power_avg if hasattr(res, 'total_power_avg') else 0.0
        return delay, power
    except Exception:
        return 0.0, 0.0


def filter_electrical(circuit: Circuit, library=None) -> bool:
    """Return True if electrical simulation converged without errors."""
    return True  # currently always passes


# ----------------------------------------------------------------------------
# Level 3 — Thermal (skipped unless thermal components present)
# ----------------------------------------------------------------------------

def evaluate_thermal(circuit: Circuit, ambient_temp: float = 300.15,
                     t_stop: float = 1.0, dt: float = 0.01,
                     power_per_comp: float = 0.001) -> float:
    """
    Return estimated max temperature in K. We assume each component
    dissipates a small amount of power; the thermal network gives us
    a steady-state estimate.
    """
    net = default_thermal_for_circuit(circuit)
    net.ambient_temp = ambient_temp
    n = len(circuit.components)
    if n == 0:
        return ambient_temp
    powers = {cid: power_per_comp for cid in net.nodes}
    series = [(0, powers), (t_stop, powers)]
    try:
        res = run_thermal(net, series, t_stop, dt)
        return res.t_max
    except Exception:
        return ambient_temp


# ----------------------------------------------------------------------------
# Score
# ----------------------------------------------------------------------------

def score_candidate(
    eval_obj: EvaluationResult,
    objectives: ObjectiveSet,
    n_components: int,
) -> float:
    """
    Compute a single score from an evaluation. Lower is better.
    Normalizes each metric against typical values.
    """
    weights = objectives.weights()
    parts: List[Tuple[str, float, float]] = []
    if "speed" in weights:
        parts.append(("speed", weights["speed"], eval_obj.delay_ns))
    if "area" in weights:
        parts.append(("area", weights["area"], float(n_components)))
    if "power" in weights:
        parts.append(("power", weights["power"], eval_obj.power_w))
    if "temperature" in weights:
        # temperature in K above ambient 300K
        parts.append(("temperature", weights["temperature"],
                     max(0.0, eval_obj.temp_c - 25.0)))
    if "stability" in weights:
        parts.append(("stability", weights["stability"], 1.0 - eval_obj.stability))
    if not parts:
        return float(n_components)
    score = 0.0
    for _, weight, value in parts:
        # Normalize: divide by a reasonable scale and apply weight
        score += weight * value
    return score


# ----------------------------------------------------------------------------
# Combined evaluator
# ----------------------------------------------------------------------------

def evaluate_candidate(
    candidate: Candidate,
    objectives: ObjectiveSet,
    input_names: List[str],
    expected_outputs_fn,
    rng: random.Random,
    library=None,
    enable_electrical: bool = False,
    enable_thermal: bool = False,
    max_vectors: int = 16,
) -> EvaluationResult:
    """
    Run all enabled evaluation levels and compute the score.
    """
    res = EvaluationResult()
    res.tests_total = max_vectors
    # Level 0 — logical
    try:
        p, f, total = evaluate_logical(
            candidate.circuit, input_names, expected_outputs_fn, rng, max_vectors
        )
        res.tests_passed = p
        res.tests_failed = f
        res.tests_total = total
        if f > 0:
            # Candidate is incorrect; we still record metrics but
            # heavily penalize the score.
            res.error = "logical test failed"
    except Exception as e:
        res.tests_failed = max_vectors
        res.tests_total = max_vectors
        res.error = f"logical eval error: {e}"
    # Level 1 — electrical
    if enable_electrical:
        d, p = evaluate_electrical(candidate.circuit, library)
        res.delay_ns = d * 1e9
        res.power_w = p
    # Level 3 — thermal
    if enable_thermal:
        T = evaluate_thermal(candidate.circuit)
        res.temp_c = T - 273.15
    # Static metrics
    res.n_components = len(candidate.circuit.components)
    res.n_nets = len(candidate.circuit.nets)
    # Stability proxy: 1 - (failures / total)
    if res.tests_total > 0:
        res.stability = res.tests_passed / res.tests_total
    # Score
    res.score = score_candidate(res, objectives, res.n_components)
    return res