"""
Ergonomic circuit construction helpers.

Most users should not manipulate the raw `Circuit` API directly. The
helpers in this module provide:

- `build_circuit(name, library=None)`: create a fresh circuit with a
  default library if none is given.
- `add_component(circuit, spec_name, reference="", **params)`: add a
  component, looking up the spec by name in the circuit's library.
- `connect(circuit, port_a, port_b)`: connect two ports.
- `Ground(circuit, reference="GND")`: convenience for a ground source.

If `library` is omitted, a default library with all built-in primitives
is created. This is the most common entry point.

Example
-------
>>> c = build_circuit("rc")
>>> r = add_component(c, "RESISTOR", reference="R1", r=10e3)
>>> cap = add_component(c, "CAPACITOR", reference="C1", c=1e-9)
>>> gnd = Ground(c)
>>> connect(c, r.ports[0], cap.ports[0])  # net "R1a--C1a"
>>> connect(c, r.ports[1], gnd.ports[0])
>>> connect(c, cap.ports[1], gnd.ports[0])
"""

from __future__ import annotations

from typing import Optional, Dict, Any, Union, overload

from .circuit import Circuit
from .components import Component, ComponentSpec
from .library import Library
from .primitives import register_primitive_specs


def build_circuit(name: str = "untitled", description: str = "",
                  library: Optional[Library] = None) -> Circuit:
    """
    Create a new circuit with a library containing all built-in primitives.
    """
    if library is None:
        library = Library(name=f"lib_for_{name}")
        register_primitive_specs(library)
        # Register a default global GND net
        # Note: the actual net id is allocated when the first ground is placed.
        # We pre-register the name with net id 0 (sentinel); on first use
        # the real net id will replace it.
        library._global_nets.setdefault("GND", 0)
        library._global_nets.setdefault("VDD", 0)
    c = Circuit(name=name, description=description, library=library)
    return c


def add_component(
    circuit: Circuit,
    spec_name: str,
    reference: str = "",
    position=(0.0, 0.0),
    rotation: int = 0,
    metadata: Optional[Dict[str, Any]] = None,
    **params: float,
) -> Component:
    """
    Add a component instance to the circuit.

    `spec_name` is looked up in the circuit's library. `params` are the
    parameter values (validated against the spec).
    """
    if circuit.library is None:
        raise RuntimeError("circuit has no library; use build_circuit()")
    if not circuit.library.has_primitive(spec_name):
        raise KeyError(f"unknown primitive {spec_name!r}; available: {circuit.library.list_primitives()}")
    spec = circuit.library.get_primitive(spec_name)
    return circuit.add_component(
        spec=spec,
        reference=reference,
        params=params,
        position=position,
        rotation=rotation,
        metadata=metadata,
    )


def connect(circuit: Circuit, port_a: int, port_b: int) -> int:
    """Connect two ports, returning the resulting net id."""
    return circuit.connect(port_a, port_b)


def connect_ports(circuit: Circuit, *ports: int) -> int:
    """Connect many ports to a single net."""
    return circuit.connect_chain(*ports)


def Ground(circuit: Circuit, reference: str = "GND") -> Component:
    """Place a ground source in the circuit."""
    g = add_component(circuit, "GROUND", reference=reference)
    # Force a real net id for the library's global GND if we haven't already
    if circuit.library is not None:
        gnd_pid = g.ports[0]
        # Allocate a real net for GND if needed
        if not any(n.name == "GND" and n.is_global for n in circuit.nets.values()):
            # Create a net and attach
            nid = circuit.get_or_create_global_net("GND")
            # If the ground port is on a different net, merge
            current_net = circuit.ports[gnd_pid].net
            if current_net is not None and current_net != nid:
                circuit._attach_to_net(gnd_pid, nid)
            elif current_net is None:
                circuit._attach_to_net(gnd_pid, nid)
    return g
