"""
Library.

The Library is the registry of:
- all primitive component specs (resistor, capacitor, ...);
- all hierarchical chips (sub-circuits) defined by the user or by the
  reference package;
- global net names (GND, VDD, ...).

Every Circuit references a Library. The Library can be shared across
many circuits, or a circuit can carry its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from .components import ComponentSpec
from .ids import ChipId
from ..utils.hashes import stable_hash


@dataclass
class ChipDefinition:
    """
    A user-defined or reference hierarchical chip.

    A chip has a public interface (a set of named ports) and an
    implementation (an internal sub-circuit). The internal circuit may
    itself use other chips, allowing arbitrary nesting depth.

    Attributes
    ----------
    name: str
        Unique chip name within the library.
    version: str
    description: str
    ports: list of (name, direction) pairs in declaration order.
    parameters: dict of name -> default value (chips may have parameters)
    internal_circuit: optional Circuit
        None if not yet implemented (e.g. a stub imported from a spec).
    metadata: free-form
    """
    name: str
    version: str = "1.0.0"
    description: str = ""
    ports: List[tuple] = field(default_factory=list)
    parameters: Dict[str, float] = field(default_factory=dict)
    internal_circuit: Optional["Circuit"] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class Library:
    """
    Registry of primitive specs and chips.
    """

    def __init__(self, name: str = "default"):
        self.name = name
        self._primitives: Dict[str, ComponentSpec] = {}
        self._chips: Dict[str, ChipDefinition] = {}
        self._global_nets: Dict[str, int] = {}

    # ---- primitives ----
    def register_primitive(self, spec: ComponentSpec) -> ComponentSpec:
        if spec.name in self._primitives:
            raise ValueError(f"primitive {spec.name!r} already registered")
        self._primitives[spec.name] = spec
        return spec

    def has_primitive(self, name: str) -> bool:
        return name in self._primitives

    def get_primitive(self, name: str) -> ComponentSpec:
        if name not in self._primitives:
            raise KeyError(f"unknown primitive {name!r}")
        return self._primitives[name]

    def list_primitives(self) -> List[str]:
        return sorted(self._primitives)

    # ---- chips ----
    def register_chip(self, chip: ChipDefinition) -> ChipDefinition:
        if chip.name in self._chips:
            raise ValueError(f"chip {chip.name!r} already registered")
        self._chips[chip.name] = chip
        return chip

    def has_chip(self, name: str) -> bool:
        return name in self._chips

    def get_chip(self, name: str) -> ChipDefinition:
        if name not in self._chips:
            raise KeyError(f"unknown chip {name!r}")
        return self._chips[name]

    def list_chips(self) -> List[str]:
        return sorted(self._chips)

    # ---- global nets ----
    def register_global_net(self, name: str, net_id: int) -> None:
        # The net id is local to a circuit; we store the name only.
        # Circuits look up by name; the first time a net is registered
        # with that name we record the id (best-effort).
        self._global_nets[name] = net_id

    def has_global_net(self, name: str) -> bool:
        return name in self._global_nets

    def get_global_net(self, name: str) -> int:
        return self._global_nets[name]

    def list_global_nets(self) -> List[str]:
        return sorted(self._global_nets)

    # ---- fingerprinting ----
    def fingerprint(self) -> str:
        return stable_hash({
            "primitives": sorted(self._primitives),
            "chips": sorted(self._chips),
            "global_nets": sorted(self._global_nets),
        })

    def __repr__(self) -> str:
        return (
            f"Library({self.name!r}: "
            f"{len(self._primitives)} primitives, {len(self._chips)} chips, "
            f"{len(self._global_nets)} global nets)"
        )
