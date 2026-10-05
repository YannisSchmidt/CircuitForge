"""
Nets.

A net is a set of ports that are forced to share the same electrical
potential. Conceptually, every net holds:
- the set of port instances attached to it;
- an optional name (e.g. "VCC", "GND", "net_42");
- a digital driver mask (used by the logic engine to detect conflicts);
- a voltage/current value (set by the simulator, not by the core model).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Set


@dataclass
class Net:
    """
    An electrical net.

    A net is identified by its id (`NetId`). Multiple ports can attach
    to a net; their owners must share the same potential.

    Attributes
    ----------
    id: int
        NetId value.
    name: str
        Human-readable label.
    ports: set of PortId
        Live ports currently attached to this net. Populated by
        Circuit.connect / add_component.
    drivers: set of PortId
        Subset of `ports` that actively drive the net (output ports,
        supply sources). Used by the logic engine.
    is_global: bool
        True if this net is a global net (GND, VDD, ...) and implicit
        connections are allowed.
    """
    id: int
    name: str = ""
    ports: Set[int] = field(default_factory=set)
    drivers: Set[int] = field(default_factory=set)
    is_global: bool = False

    def __repr__(self) -> str:
        return f"Net({self.name or '?'}#{self.id}, ports={len(self.ports)})"
