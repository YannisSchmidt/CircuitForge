"""
Auto-design specifications (section 10 and 24 of the spec).

A spec describes the desired circuit at the black box level:
- category: ALU, RAM, MULTIPLIER, REGISTER, ...
- parameters: data_width, address_width, capacity, ...
- target_operations: ADD, SUB, ...
- optimization: SPEED, AREA, ...
- constraints: max_components, max_delay, ...

From a spec, the synthesizer (see `synthesizer.py`) selects a
template and starts the evolutionary search.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple, Any

from .objectives import ObjectiveSet, get_profile


@dataclass
class AutoDesignSpec:
    """
    Specification of a circuit to design.

    Example
    -------
    >>> ALU_SPEC(
    ...     data_width=32,
    ...     target_operations={"ADD", "SUB", "AND", "OR", "XOR"},
    ...     optimization="SPEED",
    ...     max_components=50000,
    ... )
    """
    category: str = "ALU"          # ALU, RAM, MULTIPLIER, REGISTER, etc.
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)
    target_operations: Set[str] = field(default_factory=set)
    optimization_profile: str = "BALANCED"
    custom_objectives: Optional[ObjectiveSet] = None
    seed: int = 0
    max_components: int = 50000
    max_delay_ns: float = 1000.0
    max_power_w: float = 100.0

    def objectives(self) -> ObjectiveSet:
        if self.custom_objectives is not None:
            return self.custom_objectives
        return get_profile(self.optimization_profile)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "description": self.description,
            "parameters": dict(self.parameters),
            "target_operations": sorted(self.target_operations),
            "optimization_profile": self.optimization_profile,
            "seed": self.seed,
            "max_components": self.max_components,
            "max_delay_ns": self.max_delay_ns,
            "max_power_w": self.max_power_w,
        }


def ALU_SPEC(
    data_width: int = 32,
    target_operations: Optional[Set[str]] = None,
    optimization: str = "BALANCED",
    seed: int = 0,
    max_components: int = 50000,
) -> AutoDesignSpec:
    """Convenience builder for ALU specs."""
    return AutoDesignSpec(
        category="ALU",
        description=f"{data_width}-bit ALU",
        parameters={"data_width": data_width},
        target_operations=set(target_operations or {"ADD", "SUB"}),
        optimization_profile=optimization,
        seed=seed,
        max_components=max_components,
    )


def RAM_SPEC(
    data_width: int = 8,
    address_width: int = 16,
    optimization: str = "BALANCED",
    seed: int = 0,
) -> AutoDesignSpec:
    """Convenience builder for RAM specs."""
    return AutoDesignSpec(
        category="RAM",
        description=f"{data_width}-bit data, {address_width}-bit address "
                    f"({2 ** address_width} words)",
        parameters={"data_width": data_width, "address_width": address_width},
        target_operations={"READ", "WRITE"},
        optimization_profile=optimization,
        seed=seed,
    )


def MULTIPLIER_SPEC(
    data_width: int = 8,
    optimization: str = "BALANCED",
    seed: int = 0,
) -> AutoDesignSpec:
    """Convenience builder for multiplier specs."""
    return AutoDesignSpec(
        category="MULTIPLIER",
        description=f"{data_width}-bit unsigned multiplier",
        parameters={"data_width": data_width},
        target_operations={"MUL"},
        optimization_profile=optimization,
        seed=seed,
    )