"""
Ports.

A port is a named endpoint of a component. It can be:
- an electrical terminal (anode, cathode, drain, source, gate, ...);
- a digital input/output;
- a power pin (Vdd, Vss);
- a digital/analog bidirectional terminal.

Ports have a *direction* (input, output, inout, none) for digital
semantics and a *kind* (electrical, digital, power) for engine dispatch.
A *PortSpec* is the static description of a port (used at component
definition time); a *Port* is the live instance inside a circuit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Any


class PortDirection(Enum):
    """Logical signal direction. For purely analog pins use NONE."""
    INPUT = "input"
    OUTPUT = "output"
    INOUT = "inout"
    NONE = "none"     # analog / passive terminal


class PortKind(Enum):
    """What kind of electrical / logical interface this port is."""
    ANALOG = "analog"               # continuous voltage/current
    DIGITAL = "digital"             # multi-valued logic (0/1/X/Z)
    POWER = "power"                 # supply rail
    GROUND = "ground"               # reference ground
    CLOCK = "clock"                 # clock input (treated as digital for sim)


@dataclass(frozen=True)
class PortSpec:
    """
    Static description of a port, used when defining a component template.

    Attributes
    ----------
    name: str
        Name within the component (e.g. "drain", "a", "y").
    direction: PortDirection
    kind: PortKind
    default_net: optional name
        If set, this port is implicitly connected to a global net of the
        given name. Used for power and ground pins.
    description: str
    """
    name: str
    direction: PortDirection = PortDirection.NONE
    kind: PortKind = PortKind.ANALOG
    default_net: Optional[str] = None
    description: str = ""

    def __post_init__(self):
        # Tolerate stringly-typed direction/kind for ergonomics.
        # `frozen=True` means we have to use object.__setattr__.
        if isinstance(self.direction, str):
            object.__setattr__(self, "direction", PortDirection(self.direction))
        if isinstance(self.kind, str):
            object.__setattr__(self, "kind", PortKind(self.kind))


@dataclass
class Port:
    """
    A live port instance within a circuit.

    Attributes
    ----------
    component: int
        ComponentId of the owner.
    spec_index: int
        Index into the owning component's port list.
    name: str
        Cached name (e.g. "drain").
    net: int or None
        NetId this port is currently connected to, or None.
    direction, kind: copied from the spec.
    """
    component: int
    spec_index: int
    name: str
    direction: PortDirection = PortDirection.NONE
    kind: PortKind = PortKind.ANALOG
    net: Optional[int] = None

    def __repr__(self) -> str:
        return (
            f"Port({self.name} of C{self.component} "
            f"-> N{self.net if self.net is not None else '?'})"
        )
