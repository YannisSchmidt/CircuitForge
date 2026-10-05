"""
Hierarchical chip operations.

A *chip* is a reusable sub-circuit. It is defined by:
- a name (unique in the library)
- a list of public ports (name, direction)
- a list of parameters (name, default value)
- an internal Circuit (the implementation)

A *chip instance* inside a parent circuit is just a regular
Component whose spec is a CHIPS spec, plus a back-reference to the
chip definition in the library.

To support "SAVE AS CHIP", we need to:
1. Identify which ports of the source circuit are the chip's
   external interface (the user names them).
2. Wrap the source circuit's components and nets inside a
   ChipDefinition.
3. Register the chip in the library.

To support instantiation, we provide `instantiate_chip` which
returns a special component that, when simulated, delegates to
the chip's internal circuit.

The simplest possible chip model: a chip is just a ComponentSpec
whose implementation is provided at simulation time. For now,
chips are simulated by the *unfold* operation: replace the chip
instance by its full internal circuit in a copy of the parent
circuit, then simulate the unfolded circuit.

Unfolding is a powerful debugging tool: it lets the user inspect
a chip down to the transistor level. It is the implementation of
section 1 of the spec ("any abstraction must not hide its
implementation").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
import copy

from ..core.circuit import Circuit
from ..core.components import (
    Component, ComponentSpec, ComponentKind, ModelAccuracy, ParameterSpec,
)
from ..core.library import Library, ChipDefinition
from ..core.ports import PortSpec, PortDirection, PortKind
from ..core.ids import PortId, NetId, ComponentId
from ..exceptions import HierarchyError


@dataclass
class ChipInstance:
    """
    Metadata for a chip instance inside a parent circuit.
    """
    component_id: int       # ComponentId of the chip in the parent
    chip_name: str
    reference: str
    port_mapping: Dict[str, int]  # chip port name -> net id in parent
    parameters: Dict[str, float]


def _make_chip_spec(chip: ChipDefinition) -> ComponentSpec:
    """Build a ComponentSpec that represents a chip in a parent circuit."""
    s = ComponentSpec(
        name=chip.name,
        category=ComponentKind.CUSTOM,
        description=chip.description,
        primitive=False,
    )
    for port_name, direction in chip.ports:
        s.add_port(port_name, direction=PortDirection(direction), kind=PortKind.ANALOG)
    for pname, pdefault in chip.parameters.items():
        s.add_param(pname, pdefault, unit="", min=None, max=None, description="")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,  # chips are pass-through; their
                                          # accuracy depends on the inner
                                          # components
        electrical=ModelAccuracy.NOT_MODELED,
        detailed=ModelAccuracy.NOT_MODELED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return s


def save_as_chip(
    source: Circuit,
    library: Library,
    name: str,
    port_names: Dict[int, str],
    description: str = "",
    version: str = "1.0.0",
    parameters: Optional[Dict[str, float]] = None,
) -> ChipDefinition:
    """
    Save `source` as a chip in `library` with the given name.

    Parameters
    ----------
    source : Circuit
        The circuit to save.
    library : Library
        The library to register the chip in.
    name : str
        The chip's name.
    port_names : dict
        Maps each external port (identified by PortId) to the
        chip's external port name.
    description : str
    version : str
    parameters : dict
        Chip parameters (must already be exposed as parameters in
        the source, but for now we accept any dict).
    """
    chip = ChipDefinition(
        name=name,
        version=version,
        description=description,
        parameters=dict(parameters or {}),
        internal_circuit=copy.deepcopy(source),
    )
    # Build chip ports from the mapping
    port_list: List[Tuple[str, str]] = []
    for port_id, pname in port_names.items():
        # Determine direction from the source port's spec
        port = source.ports.get(PortId(int(port_id)))
        if port is None:
            raise HierarchyError(f"port id {port_id} not found in source circuit")
        from ..core.ids import ComponentId
        comp = source._components.get(ComponentId(int(port.component)))
        if comp is None:
            raise HierarchyError(f"port {port_id} references unknown component")
        pspec = comp.spec.ports[port.spec_index]
        port_list.append((pname, pspec.direction.value))
    chip.ports = port_list
    # Build the chip's spec and register it as a primitive in the library
    spec = _make_chip_spec(chip)
    library._primitives[chip.name] = spec
    library._chips[chip.name] = chip
    return chip


def instantiate_chip(
    parent: Circuit,
    library: Library,
    chip_name: str,
    reference: str = "",
    port_net_mapping: Optional[Dict[str, int]] = None,
    parameters: Optional[Dict[str, float]] = None,
) -> Component:
    """
    Place a chip instance in the parent circuit. Returns the
    newly created Component.

    Parameters
    ----------
    parent : Circuit
        The parent circuit in which to place the chip.
    library : Library
        The library that contains the chip definition. If the
        chip is not in this library, it is copied from `parent.library`
        (or vice versa).
    chip_name : str
        The chip to instantiate.
    reference : str
        The reference name (e.g. "U2").
    port_net_mapping : dict
        Maps chip port name to net id in the parent.
    parameters : dict
        Parameter values for the chip.
    """
    # Cross-library resolution: search the requested library, then the
    # parent's library, then any other library reachable from them.
    chip: Optional[ChipDefinition] = None
    if library.has_chip(chip_name):
        chip = library.get_chip(chip_name)
    elif parent.library is not None and parent.library.has_chip(chip_name):
        chip = parent.library.get_chip(chip_name)
        # Copy into the requested library
        library._chips[chip_name] = copy.deepcopy(chip)
    else:
        raise HierarchyError(f"unknown chip {chip_name!r}")
    if chip.name not in library._primitives:
        spec = _make_chip_spec(chip)
        library._primitives[chip.name] = spec
    spec = library.get_primitive(chip.name)
    # Ensure the parent circuit's library has the chip too
    if parent.library is not None and chip_name not in parent.library._chips:
        parent.library._chips[chip_name] = copy.deepcopy(chip)
    if parent.library is not None and chip_name not in parent.library._primitives:
        parent.library._primitives[chip_name] = copy.deepcopy(spec)
    comp = parent.add_component(
        spec=spec,
        reference=reference or chip_name,
        params=parameters or {},
    )
    if port_net_mapping:
        for port_name, net_id in port_net_mapping.items():
            if port_name not in [pspec.name for pspec in spec.ports]:
                raise HierarchyError(f"chip {chip_name!r} has no port {port_name!r}")
            port_idx = spec.port_index(port_name)
            pid = comp.ports[port_idx]
            parent._attach_to_net(pid, int(net_id))
    return comp


def unfold_chip(parent: Circuit, library: Library, chip_name: str,
                instance_component_id: int) -> Circuit:
    """
    Return a copy of `parent` in which the named chip instance has
    been replaced by its full internal implementation.

    Strategy
    --------
    For each public port of the chip, we look for a net in the
    internal circuit with the same name. Any port in the internal
    circuit attached to that net is connected, in the unfolded
    circuit, to the net the chip's public port was attached to
    in the parent.

    The rest of the internal circuit is copied verbatim, with
    nets and ports remapped to new ids in the unfolded circuit.
    """
    if not library.has_chip(chip_name):
        raise HierarchyError(f"unknown chip {chip_name!r}")
    chip = library.get_chip(chip_name)
    if chip.internal_circuit is None:
        raise HierarchyError(f"chip {chip_name!r} has no internal circuit")
    # Find the chip instance in the parent
    target_comp = parent._components.get(ComponentId(int(instance_component_id)))
    if target_comp is None:
        raise HierarchyError(f"component {instance_component_id} not found")
    if target_comp.spec.name != chip_name:
        raise HierarchyError(f"component is not an instance of {chip_name!r}")
    # Build a copy of the parent
    new_parent = copy.deepcopy(parent)
    cid_int = int(instance_component_id)
    cid = ComponentId(cid_int)
    if cid not in new_parent._components:
        raise HierarchyError("component missing after copy")
    inst_comp = new_parent._components[cid]
    # Gather the nets that the chip's external ports connect to
    port_to_net: Dict[str, int] = {}
    for i, pspec in enumerate(inst_comp.spec.ports):
        pid = inst_comp.ports[i]
        port = new_parent.ports[PortId(int(pid))]
        if port.net is None:
            raise HierarchyError(f"chip port {pspec.name!r} is dangling in parent")
        port_to_net[pspec.name] = int(port.net)
    # Remove the chip instance from the copy
    for pid in list(inst_comp.ports):
        p = new_parent.ports.get(PortId(int(pid)))
        if p is not None and p.net is not None:
            n = new_parent._nets.get(p.net)
            if n is not None:
                n.ports.discard(PortId(int(pid)))
        new_parent._ports.pop(PortId(int(pid)), None)
    new_parent._components.pop(cid, None)
    # Step 1: allocate fresh ids in the new parent for every component
    # and port in the chip's internal circuit, and every net.
    new_comp_map: Dict[int, int] = {}
    new_port_map: Dict[int, int] = {}
    new_net_map: Dict[int, int] = {}
    for chip_cid in chip.internal_circuit._components:
        new_cid_int = new_parent._next_component
        new_parent._next_component += 1
        new_comp_map[int(chip_cid)] = new_cid_int
    for chip_pid in list(chip.internal_circuit._ports):
        new_pid_int = new_parent._next_port
        new_parent._next_port += 1
        new_port_map[int(chip_pid)] = new_pid_int
    for chip_nid, chip_net in chip.internal_circuit._nets.items():
        new_nid_int = new_parent.create_net(name=chip_net.name, is_global=chip_net.is_global)
        new_net_map[int(chip_nid)] = new_nid_int
    # Step 2: create the new components and ports in the new parent.
    from ..core.ports import Port
    for chip_cid, chip_comp in chip.internal_circuit._components.items():
        new_cid_int = new_comp_map[int(chip_cid)]
        new_cid = ComponentId(new_cid_int)
        new_ports: List[PortId] = []
        for j, chip_pid in enumerate(chip_comp.ports):
            new_pid_int = new_port_map[int(chip_pid)]
            new_pid = PortId(new_pid_int)
            pspec = chip_comp.spec.ports[j]
            new_parent._ports[new_pid] = Port(
                component=new_cid_int,
                spec_index=j,
                name=pspec.name,
                direction=pspec.direction,
                kind=pspec.kind,
                net=None,
            )
            new_ports.append(new_pid)
        new_comp = Component(
            id=new_cid_int,
            spec=chip_comp.spec,
            reference=chip_comp.reference,
            params=dict(chip_comp.params),
            ports=new_ports,
            position=chip_comp.position,
            rotation=chip_comp.rotation,
            metadata=dict(chip_comp.metadata),
        )
        new_parent._components[new_cid] = new_comp
    # Step 3: for public-port nets in the chip, route to the parent's net.
    for port_name, parent_net in port_to_net.items():
        for chip_nid, chip_net in chip.internal_circuit._nets.items():
            if chip_net.name == port_name:
                for chip_pid in chip_net.ports:
                    mapped = new_port_map.get(int(chip_pid))
                    if mapped is not None and mapped in new_parent._ports:
                        new_parent._attach_to_net(mapped, parent_net)
                if new_net_map[int(chip_nid)] in new_parent._nets:
                    del new_parent._nets[NetId(new_net_map[int(chip_nid)])]
                new_net_map[int(chip_nid)] = parent_net
                break
    # Step 4: attach all remaining ports to their nets.
    for chip_cid, chip_comp in chip.internal_circuit._components.items():
        for j, chip_pid in enumerate(chip_comp.ports):
            chip_port = chip.internal_circuit._ports[PortId(int(chip_pid))]
            if chip_port.net is None:
                continue
            target_nid = new_net_map[int(chip_port.net)]
            new_parent._attach_to_net(new_port_map[int(chip_pid)], target_nid)
    # Step 5: prune empty nets (the placeholder nets for public ports
    # whose ports have all been redirected to the parent's net).
    empty = [nid for nid, n in list(new_parent._nets.items()) if not n.ports]
    for nid in empty:
        del new_parent._nets[nid]
    return new_parent


def unfold_all(circuit: Circuit, library: Library, max_depth: int = 100) -> Circuit:
    """
    Recursively unfold all chip instances in the circuit. This is
    useful for exporting a fully-expanded schematic.
    """
    current = circuit
    for _ in range(max_depth):
        chip_instances = [
            (cid, comp) for cid, comp in current._components.items()
            if comp.spec.name in library.list_chips() and not comp.spec.primitive
        ]
        if not chip_instances:
            break
        cid, comp = chip_instances[0]
        current = unfold_chip(current, library, comp.spec.name, int(cid))
    return current


def get_chip_definition(library: Library, name: str) -> ChipDefinition:
    return library.get_chip(name)


def list_chip_instances(circuit: Circuit) -> List[ChipInstance]:
    """Return a list of all chip instances in a circuit (non-recursive)."""
    out: List[ChipInstance] = []
    for cid, comp in circuit._components.items():
        if not comp.spec.primitive:
            port_mapping = {}
            for i, pspec in enumerate(comp.spec.ports):
                pid = comp.ports[i]
                port = circuit.ports[PortId(int(pid))]
                if port.net is not None:
                    port_mapping[pspec.name] = int(port.net)
            out.append(ChipInstance(
                component_id=int(cid),
                chip_name=comp.spec.name,
                reference=comp.reference,
                port_mapping=port_mapping,
                parameters=dict(comp.params),
            ))
    return out
