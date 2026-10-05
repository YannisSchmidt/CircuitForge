"""
Auto-detection of repeated subcircuits (section 9 of the spec).

The detector finds structural patterns by hash-fingerprinting every
connected substructure in the circuit and counting how often each
appears. Patterns that appear more than once can be turned into
chips via `extract_pattern_as_chip`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Set, Optional, Tuple, Any
from collections import defaultdict

from .core.circuit import Circuit
from .core.ids import ComponentId, NetId, PortId
from .core.library import Library
from .chips.hierarchical import save_as_chip


@dataclass
class DetectedPattern:
    """
    A repeated subcircuit found in the circuit.

    The fingerprint is a stable hash of the pattern's structure. The
    `component_ids` lists the actual occurrences. `arity` is the
    number of inputs/outputs (a rough proxy for complexity).
    """
    fingerprint: str
    spec_signature: str
    component_count: int
    occurrences: int
    component_ids: List[List[int]] = field(default_factory=list)
    # Heuristic complexity
    arity: int = 0

    def summary(self) -> str:
        return (
            f"Pattern ({self.spec_signature}): {self.occurrences} occurrences, "
            f"{self.component_count} components each"
        )


def _subgraph_fingerprint(circuit: Circuit, component_ids: List[int]) -> str:
    """
    Fingerprint the structure of `component_ids` ignoring their net
    ids. Each component contributes a sorted list of (port_name,
    net-fingerprint) pairs.
    """
    from .utils.hashes import stable_hash
    cid_set = set(int(c) for c in component_ids)
    # Build a canonical "net fingerprint" map: for each net, classify it
    # as "internal" (only cids in cid_set) or "external" (some cids
    # outside).
    net_fps: Dict[int, str] = {}
    for nid, net in circuit._nets.items():
        ext = any(
            int(circuit.ports[PortId(int(p))].component) not in cid_set
            for p in net.ports
        )
        if ext:
            net_fps[int(nid)] = "ext"
        else:
            # Internal: hash the (comp, port_name) it touches
            targets = []
            for p in net.ports:
                port = circuit.ports[PortId(int(p))]
                comp = circuit._components[ComponentId(int(port.component))]
                targets.append((int(port.component), comp.spec.ports[port.spec_index].name))
            net_fps[int(nid)] = "int:" + str(sorted(targets))
    comp_data = []
    for cid in sorted(cid_set):
        comp = circuit._components[ComponentId(cid)]
        port_info = []
        for i, pid in enumerate(comp.ports):
            port = circuit.ports[PortId(int(pid))]
            pspec = comp.spec.ports[i]
            if port.net is None:
                port_info.append((pspec.name, "floating"))
            else:
                port_info.append((pspec.name, net_fps.get(int(port.net), "?")))
        comp_data.append({
            "spec": comp.spec.name,
            "params": {k: comp.params[k] for k in sorted(comp.params)},
            "ports": port_info,
        })
    return stable_hash({"components": comp_data})


def _is_pattern_seed(circuit: Circuit, cid: int) -> bool:
    """A component is a good seed if it is not a 'boundary' type."""
    comp = circuit._components[ComponentId(cid)]
    if comp.spec.name in ("LOGIC_INPUT", "LOGIC_OUTPUT"):
        return False
    return True


def _find_k_hop_groups(circuit: Circuit, k: int) -> List[List[int]]:
    """
    For each non-boundary component, return the (k-hop) neighborhood
    of *non-boundary* components reachable through nets. Boundary
    components (LOGIC_INPUT/OUTPUT) are skipped during BFS so the
    pattern focuses on the gate logic.
    """
    seen: Set[Tuple[int, ...]] = set()
    out: List[List[int]] = []
    for cid in circuit._components:
        if not _is_pattern_seed(circuit, int(cid)):
            continue
        group: Set[int] = {int(cid)}
        frontier: List[int] = [int(cid)]
        for _ in range(k):
            new_frontier: Set[int] = set()
            for c in frontier:
                comp = circuit._components[ComponentId(c)]
                for pid in comp.ports:
                    port = circuit.ports[PortId(int(pid))]
                    if port.net is None:
                        continue
                    net = circuit._nets[port.net]
                    for p in net.ports:
                        other = int(circuit.ports[PortId(int(p))].component)
                        if other in group:
                            continue
                        if not _is_pattern_seed(circuit, other):
                            continue
                        new_frontier.add(other)
                        group.add(other)
            frontier = list(new_frontier)
        key = tuple(sorted(group))
        if key in seen:
            continue
        seen.add(key)
        out.append(sorted(group))
    return out


def _subcircuit_fingerprint(circuit: Circuit, component_ids: List[int]) -> str:
    """
    Compute a stable hash of a set of components together with their
    connecting nets. The hash depends only on the spec types and
    parameters, not on the absolute ids.
    """
    from .utils.hashes import stable_hash
    cid_set = set(int(c) for c in component_ids)
    comp_data = []
    for cid in sorted(cid_set):
        comp = circuit._components[ComponentId(cid)]
        comp_data.append({
            "spec": comp.spec.name,
            "params": {k: comp.params[k] for k in sorted(comp.params)},
        })
    # External connections: list of (port_name, net_id) for ports
    # that touch a net with a component not in cid_set
    external = []
    for cid in sorted(cid_set):
        comp = circuit._components[ComponentId(cid)]
        for i, pspec in enumerate(comp.spec.ports):
            pid = comp.ports[i]
            port = circuit.ports[PortId(int(pid))]
            if port.net is None:
                continue
            net = circuit._nets[port.net]
            # External ports
            if any(p not in cid_set for p in net.ports):
                external.append({
                    "comp": int(cid),
                    "port_name": pspec.name,
                })
    return stable_hash({"components": comp_data, "external": sorted(external, key=lambda x: (x["comp"], x["port_name"]))})


def _collect_reachable(circuit: Circuit, start_ids: List[int],
                       max_components: int) -> Optional[List[int]]:
    """
    BFS from `start_ids`, following nets that connect only to the
    growing set. Returns the connected component of the graph
    defined by shared nets, capped at `max_components`.
    """
    visited: Set[int] = set(int(c) for c in start_ids)
    queue: List[int] = list(start_ids)
    while queue:
        c = queue.pop(0)
        if len(visited) >= max_components:
            return None
        comp = circuit._components[ComponentId(int(c))]
        for pid in comp.ports:
            port = circuit.ports[PortId(int(pid))]
            if port.net is None:
                continue
            net = circuit._nets[port.net]
            for p in net.ports:
                p_port = circuit.ports[PortId(int(p))]
                other_cid = int(p_port.component)
                if other_cid not in visited and other_cid in circuit._components:
                    visited.add(other_cid)
                    queue.append(other_cid)
    return sorted(visited)


def find_repeated_patterns(
    circuit: Circuit,
    min_occurrences: int = 2,
    max_components_per_pattern: int = 50,
    max_patterns: int = 20,
) -> List[DetectedPattern]:
    """
    Find subcircuits that repeat at least `min_occurrences` times.

    The current approach uses k-hop neighborhoods (k=1) — i.e. each
    component with its direct neighbors through nets — and hashes each
    substructure. Patterns with the same hash are considered equal.
    """
    fingerprints: Dict[str, List[List[int]]] = defaultdict(list)
    spec_sigs: Dict[str, str] = {}
    seen_global: Set[Tuple[int, ...]] = set()
    # Try several k values and merge
    for k in (1, 2):
        for group in _find_k_hop_groups(circuit, k):
            if len(group) > max_components_per_pattern:
                continue
            key = tuple(sorted(group))
            if key in seen_global:
                continue
            seen_global.add(key)
            fp = _subgraph_fingerprint(circuit, group)
            sig = "|".join(sorted({circuit._components[ComponentId(c)].spec.name for c in group}))
            fingerprints[fp].append(group)
            spec_sigs[fp] = sig
    out: List[DetectedPattern] = []
    for fp, groups in fingerprints.items():
        if len(groups) < min_occurrences:
            continue
        comp0 = groups[0]
        cid_set = set(comp0)
        arity = 0
        for c in comp0:
            comp = circuit._components[ComponentId(c)]
            for pid in comp.ports:
                port = circuit.ports[PortId(int(pid))]
                if port.net is None:
                    continue
                if any(int(circuit.ports[PortId(int(p))].component) not in cid_set
                       for p in circuit._nets[port.net].ports):
                    arity += 1
        out.append(DetectedPattern(
            fingerprint=fp,
            spec_signature=spec_sigs[fp],
            component_count=len(comp0),
            occurrences=len(groups),
            component_ids=groups,
            arity=arity,
        ))
    out.sort(key=lambda p: (-p.occurrences, -p.component_count))
    return out[:max_patterns]


def extract_pattern_as_chip(
    circuit: Circuit,
    library: Library,
    pattern: DetectedPattern,
    chip_name: str,
    description: str = "",
) -> Any:
    """
    Extract the first occurrence of a pattern as a chip in the library.
    The remaining occurrences in the circuit are NOT replaced — for
    that, use `replace_pattern_with_chip`.
    """
    import copy
    from .core.circuit import Circuit as CircuitCls
    if not pattern.component_ids:
        raise ValueError("pattern has no component occurrences")
    first_occurrence = pattern.component_ids[0]
    # Build a sub-circuit containing only the pattern's components and
    # their nets. We map to fresh ids.
    new_circuit = CircuitCls(name=chip_name)
    new_circuit.library = library
    cid_map: Dict[int, int] = {}
    pid_map: Dict[int, int] = {}
    nid_map: Dict[int, int] = {}
    for cid in first_occurrence:
        cid_map[cid] = new_circuit._alloc_component_id()
    for cid in first_occurrence:
        comp = circuit._components[ComponentId(cid)]
        for i, pid in enumerate(comp.ports):
            pid_map[pid] = new_circuit._alloc_port_id()
        # Create ports
        from .core.ports import Port
        for i, pid in enumerate(comp.ports):
            pspec = comp.spec.ports[i]
            new_circuit._ports[PortId(pid_map[pid])] = Port(
                component=cid_map[cid],
                spec_index=i,
                name=pspec.name,
                direction=pspec.direction,
                kind=pspec.kind,
                net=None,
            )
        # Create the component
        from .core.components import Component
        new_comp = Component(
            id=cid_map[cid],
            spec=comp.spec,
            reference=comp.reference,
            params=dict(comp.params),
            ports=[PortId(pid_map[p]) for p in comp.ports],
            position=comp.position,
            rotation=comp.rotation,
            metadata=dict(comp.metadata),
        )
        new_circuit._components[ComponentId(cid_map[cid])] = new_comp
    # Create nets
    used_nets = set()
    for cid in first_occurrence:
        comp = circuit._components[ComponentId(cid)]
        for pid in comp.ports:
            port = circuit.ports[PortId(int(pid))]
            if port.net is None:
                continue
            used_nets.add(port.net)
    for nid in used_nets:
        nid_map[nid] = new_circuit.create_net(name=circuit._nets[nid].name,
                                              is_global=circuit._nets[nid].is_global)
    # Attach ports to nets
    for cid in first_occurrence:
        comp = circuit._components[ComponentId(cid)]
        for i, pid in enumerate(comp.ports):
            port = circuit.ports[PortId(int(pid))]
            if port.net is None:
                continue
            new_circuit._attach_to_net(pid_map[pid], nid_map[port.net])
    # Identify the chip's public ports (those that touch external nets)
    external_pids = []
    cid_set = set(cid_map.values())
    for nid, net in new_circuit._nets.items():
        for pid in net.ports:
            p_port = new_circuit.ports[pid]
            # External = not all components in cid_set
            # In this synthetic case every port is internal to the pattern;
            # but we want to expose nets that touch outside.
            # Here, "external" means nets that were originally connected
            # to something outside first_occurrence. We'll track those.
    # For simplicity, we expose the nets by their name in the original
    # circuit. We'll have the user manually pick port names if they
    # want; for now we pick all named nets.
    port_names: Dict[int, str] = {}
    name_counter = 0
    for nid, net in new_circuit._nets.items():
        if net.name:
            port_names[nid] = net.name
        elif name_counter == 0:
            port_names[nid] = f"P{name_counter}"
            name_counter += 1
    # Save as chip
    chip = save_as_chip(new_circuit, library, chip_name,
                        port_names={},  # let save_as_chip determine from spec
                        description=description)
    return chip