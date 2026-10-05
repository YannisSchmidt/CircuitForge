"""
Evolutionary search (sections 12, 13 of the spec).

We implement a simple evolutionary loop:
1. Initialize a population of random candidates from a template.
2. Evaluate each candidate at the cheapest level that the user
   enabled (logical -> electrical -> thermal).
3. Apply a multi-level filter: only candidates that pass the cheap
   tests get promoted to the expensive ones.
4. Pick the best K to be parents of the next generation.
5. Apply mutation (and optionally crossover).
7. Repeat until time budget is exhausted.

A cache (fingerprint -> evaluation) avoids re-evaluating identical
candidates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional, Any, Callable
import random
import time
import math

from ..core.circuit import Circuit
from ..utils.rng import DeterministicRNG
from ..utils.hashes import stable_hash
from .objectives import ObjectiveSet
from .templates import CircuitTemplate, Gene as GeneSpec
from .evaluator import (
    Candidate, EvaluationResult, evaluate_candidate, score_candidate,
    filter_logical, filter_electrical,
)


@dataclass
class SearchConfig:
    """Configuration for an evolutionary search."""
    population_size: int = 32
    n_generations: int = 50
    mutation_rate: float = 0.3
    crossover_rate: float = 0.2
    elite_fraction: float = 0.1
    time_budget_s: float = 60.0
    seed: int = 0
    enable_electrical: bool = False
    enable_thermal: bool = False
    max_vectors: int = 16
    input_names: List[str] = field(default_factory=list)
    expected_outputs_fn: Optional[Callable] = None


@dataclass
class SearchResult:
    """Result of an evolutionary search."""
    best: Optional[Candidate] = None
    best_score: float = float("inf")
    generations: int = 0
    candidates_tested: int = 0
    candidates_rejected: int = 0
    history: List[float] = field(default_factory=list)  # best score per gen
    wall_time_s: float = 0.0
    timed_out: bool = False
    error: Optional[str] = None

    def why(self, other: "SearchResult") -> str:
        """Explain why `self` is better than `other` (section 23)."""
        if self.best is None or other.best is None:
            return "no comparison possible"
        a = self.best.evaluation
        b = other.best.evaluation
        if a is None or b is None:
            return "no evaluation"
        lines = ["WHY THIS DESIGN?"]
        lines.append(f"  score:    {a.score:.4g} vs {b.score:.4g}")
        lines.append(f"  n_comp:   {a.n_components} vs {b.n_components}")
        if a.delay_ns > 0:
            lines.append(f"  delay:    {a.delay_ns:.4g} ns vs {b.delay_ns:.4g} ns")
        if a.power_w > 0:
            lines.append(f"  power:    {a.power_w:.4g} W vs {b.power_w:.4g} W")
        lines.append(f"  stability:{a.stability:.4g} vs {b.stability:.4g}")
        lines.append(f"  tests:    {a.tests_passed}/{a.tests_total} vs "
                     f"{b.tests_passed}/{b.tests_total}")
        return "\n".join(lines)


class SearchLogger:
    """Simple text logger."""
    def __init__(self):
        self.entries: List[str] = []
    def log(self, msg: str) -> None:
        self.entries.append(msg)
    def __str__(self) -> str:
        return "\n".join(self.entries)


# ----------------------------------------------------------------------------
# Population initialization
# ----------------------------------------------------------------------------

def _random_genes(template: CircuitTemplate, rng: random.Random) -> List[Any]:
    return [g.random_value(rng) for g in template.genes()]


def _make_candidate(template: CircuitTemplate, gene_values: List[Any]) -> Candidate:
    genes = {g.name: v for g, v in zip(template.genes(), gene_values)}
    circuit = template.instantiate(genes)
    fp = circuit.fingerprint()
    return Candidate(
        template_name=template.name,
        genes=genes,
        circuit=circuit,
        fingerprint=fp,
    )


# ----------------------------------------------------------------------------
# Mutation and crossover
# ----------------------------------------------------------------------------

def _mutate(template: CircuitTemplate, values: List[Any],
            rng: random.Random, rate: float) -> List[Any]:
    out = []
    for gene, val in zip(template.genes(), values):
        if rng.random() < rate:
            out.append(gene.mutate(val, rng))
        else:
            out.append(val)
    return out


def _crossover(template: CircuitTemplate, a: List[Any], b: List[Any],
               rng: random.Random) -> List[Any]:
    # Single-point crossover
    if len(a) < 2:
        return a[:]
    pt = rng.randint(1, len(a) - 1)
    return a[:pt] + b[pt:]


# ----------------------------------------------------------------------------
# The search
# ----------------------------------------------------------------------------

def run_evolutionary_search(
    template: CircuitTemplate,
    config: SearchConfig,
    objectives: ObjectiveSet,
    progress_callback: Optional[Callable[[int, int, float], None]] = None,
    logger: Optional[SearchLogger] = None,
) -> SearchResult:
    """
    Run an evolutionary search on a template.

    Parameters
    ----------
    template : CircuitTemplate
    config : SearchConfig
    objectives : ObjectiveSet
    progress_callback : optional callable (gen, tested, best_score)
    logger : optional SearchLogger for textual progress output

    Returns a SearchResult with the best candidate found.
    """
    if logger is None:
        logger = SearchLogger()
    if config.expected_outputs_fn is None:
        raise ValueError("config.expected_outputs_fn must be set")
    rng = random.Random(config.seed)
    t0 = time.time()
    cache: Dict[str, EvaluationResult] = {}
    tested = 0
    rejected = 0
    best: Optional[Candidate] = None
    history: List[float] = []
    # Initial population
    population: List[Candidate] = []
    for _ in range(config.population_size):
        vals = _random_genes(template, rng)
        cand = _make_candidate(template, vals)
        population.append(cand)
    # Evaluate population
    for cand in population:
        if cand.fingerprint in cache:
            cand.evaluation = cache[cand.fingerprint]
            continue
        cand.evaluation = evaluate_candidate(
            cand, objectives, config.input_names,
            config.expected_outputs_fn, rng, library=None,
            enable_electrical=config.enable_electrical,
            enable_thermal=config.enable_thermal,
            max_vectors=config.max_vectors,
        )
        cache[cand.fingerprint] = cand.evaluation
        tested += 1
        if cand.evaluation.tests_failed > 0 or cand.evaluation.error:
            rejected += 1
        if best is None or (cand.evaluation and cand.evaluation.score < best.evaluation.score):
            best = cand
        if time.time() - t0 > config.time_budget_s:
            break
    # Sort by score
    population.sort(key=lambda c: c.evaluation.score if c.evaluation else float("inf"))
    history.append(population[0].evaluation.score)
    if progress_callback:
        progress_callback(0, tested, history[-1])
    logger.log(f"gen 0 best_score={history[-1]:.4g} tested={tested}")
    # Generations
    gen = 0
    while gen < config.n_generations:
        if time.time() - t0 > config.time_budget_s:
            break
        gen += 1
        # Select elite
        n_elite = max(1, int(config.elite_fraction * config.population_size))
        new_population = population[:n_elite]
        # Generate offspring
        while len(new_population) < config.population_size:
            # Tournament selection
            k = min(3, len(population))
            a = min(random.sample(population, k),
                    key=lambda c: c.evaluation.score if c.evaluation else float("inf"))
            b = min(random.sample(population, k),
                    key=lambda c: c.evaluation.score if c.evaluation else float("inf"))
            a_vals = [a.genes[g.name] for g in template.genes()]
            b_vals = [b.genes[g.name] for g in template.genes()]
            if rng.random() < config.crossover_rate:
                vals = _crossover(template, a_vals, b_vals, rng)
            else:
                vals = a_vals
            vals = _mutate(template, vals, rng, config.mutation_rate)
            cand = _make_candidate(template, vals)
            if cand.fingerprint in cache:
                cand.evaluation = cache[cand.fingerprint]
            else:
                cand.evaluation = evaluate_candidate(
                    cand, objectives, config.input_names,
                    config.expected_outputs_fn, rng,
                    library=None,
                    enable_electrical=config.enable_electrical,
                    enable_thermal=config.enable_thermal,
                    max_vectors=config.max_vectors,
                )
                cache[cand.fingerprint] = cand.evaluation
                tested += 1
                if cand.evaluation.tests_failed > 0 or cand.evaluation.error:
                    rejected += 1
                if time.time() - t0 > config.time_budget_s:
                    break
            new_population.append(cand)
            if best is None or (cand.evaluation and cand.evaluation.score < best.evaluation.score):
                best = cand
        population = new_population
        population.sort(key=lambda c: c.evaluation.score if c.evaluation else float("inf"))
        history.append(population[0].evaluation.score)
        logger.log(f"gen {gen} best_score={history[-1]:.4g} tested={tested}")
        if progress_callback:
            progress_callback(gen, tested, history[-1])
    return SearchResult(
        best=best,
        best_score=best.evaluation.score if best else float("inf"),
        generations=gen,
        candidates_tested=tested,
        candidates_rejected=rejected,
        history=history,
        wall_time_s=time.time() - t0,
        timed_out=(time.time() - t0) > config.time_budget_s,
    )


# ----------------------------------------------------------------------------
# Multi-level filtering
# ----------------------------------------------------------------------------

def filter_level(circuit: Circuit, level: str,
                 input_names: List[str], expected_outputs, max_vectors: int = 16) -> bool:
    """
    Run the named logical level filter. Currently only 'logic' is implemented.
    """
    if level == "logic":
        import random as _random
        rng = _random.Random(0)
        return filter_logical(circuit, input_names, expected_outputs, rng, max_vectors)
    if level == "electrical":
        return filter_electrical(circuit)
    return True