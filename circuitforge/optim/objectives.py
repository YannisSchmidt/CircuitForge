"""
Multi-objective scoring (section 11 of the spec).

We define a small set of named objectives:
- SPEED: critical path delay (ns)
- COMPONENT_COUNT: number of components
- POWER: total power dissipation (W)
- TEMPERATURE: max junction temperature (°C)
- STABILITY: how well the circuit behaves under variations
- MEMORY: regular (currently unused)

Each objective is *minimized* (lower delay is faster, lower power is
better, etc.). The user specifies weights that sum to 1.

We also provide preset profiles for the common cases:
- FASTEST, SMALLEST, LOW_POWER, LOW_TEMPERATURE, MOST_STABLE, BALANCED.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional


# Objective keys
SPEED = "speed"
AREA = "area"            # synonym for component count
POWER = "power"
TEMPERATURE = "temperature"
STABILITY = "stability"
MEMORY = "memory"


@dataclass
class Objective:
    """
    A single measurable quantity in a candidate (e.g. delay in ns,
    component count). Used for reporting, not for scoring.
    """
    name: str
    value: float
    unit: str = ""
    direction: str = "minimize"

    def __repr__(self) -> str:
        return f"{self.name}={self.value} {self.unit}"


@dataclass
class ObjectiveSpec:
    """
    Specification of one optimization objective.

    `weight` is the importance (typically summing to 1 across all
    objectives). `target` is an aspirational value used for
    normalization (candidates achieving the target are awarded the
    best normalized score of 1.0).
    """
    name: str
    weight: float = 0.0
    target: float = 0.0
    minimize: bool = True  # all our objectives are minimized


@dataclass
class ObjectiveSet:
    """
    A bundle of objectives with their weights.
    """
    objectives: Dict[str, ObjectiveSpec] = field(default_factory=dict)

    @classmethod
    def from_weights(cls, **weights) -> "ObjectiveSet":
        objs = {}
        for name, w in weights.items():
            if w == 0:
                continue
            objs[name] = ObjectiveSpec(name=name, weight=float(w), target=0.0)
        # Normalize
        total = sum(o.weight for o in objs.values())
        if total > 0:
            for o in objs.values():
                o.weight /= total
        return cls(objectives=objs)

    def weights(self) -> Dict[str, float]:
        return {name: o.weight for name, o in self.objectives.items()}

    def targets(self) -> Dict[str, float]:
        return {name: o.target for name, o in self.objectives.items()}

    def total_weight(self) -> float:
        return sum(o.weight for o in self.objectives.values())


def profile_fastest() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.6, area=0.15, power=0.1,
                                     temperature=0.05, stability=0.1)


def profile_smallest() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.1, area=0.6, power=0.1,
                                     temperature=0.05, stability=0.15)


def profile_low_power() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.1, area=0.15, power=0.5,
                                     temperature=0.15, stability=0.1)


def profile_low_temperature() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.1, area=0.1, power=0.25,
                                     temperature=0.45, stability=0.1)


def profile_most_stable() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.1, area=0.1, power=0.1,
                                     temperature=0.15, stability=0.5,
                                     memory=0.05)


def profile_balanced() -> ObjectiveSet:
    return ObjectiveSet.from_weights(speed=0.25, area=0.2, power=0.2,
                                     temperature=0.1, stability=0.2, memory=0.05)


PROFILES: Dict[str, callable] = {
    "FASTEST": profile_fastest,
    "SMALLEST": profile_smallest,
    "LOW_POWER": profile_low_power,
    "LOW_TEMPERATURE": profile_low_temperature,
    "MOST_STABLE": profile_most_stable,
    "BALANCED": profile_balanced,
}


def get_profile(name: str) -> ObjectiveSet:
    """Return a preset ObjectiveSet, or a balanced one if unknown."""
    if name in PROFILES:
        return PROFILES[name]()
    return profile_balanced()