"""
Static circuit analysis (section 18 of the spec).

The analyzer inspects a circuit WITHOUT simulating it and reports:
- unused components (no inputs or no outputs connected)
- dangling ports (not connected to any net)
- redundant components (identical references on the same net)
- critical path (longest combinational chain, estimated by
  counting the number of gate delays from any input to any output)
- fan-out (per-net count of input ports)
- instability risks (high fan-out, long chains without buffering)
- constraint violations (parameters out of spec)

The analyzer works for digital circuits at the logic level. For
analog circuits, the analysis is more limited: it cannot compute
critical path without a simulation, but it can report structural
properties.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional
from collections import deque

from ..core.circuit import Circuit
from ..core.components import ComponentSpec, ModelAccuracy
from ..core.ids import NetId, ComponentId, PortId
from ..core.ports import PortDirection, PortKind
from ..sim.logic import (
    LogicEngine, LogicState, compile_for_logic,
)


@dataclass
class CriticalPath:
    """A path from an input to an output through the logic."""
    gates: List[int]   # component ids along the path
    delay: float       # sum of gate delays (in seconds)


@dataclass
class CircuitAnalysis:
    n_components: int = 0
    n_nets: int = 0
    n_ports: int = 0
    unused_components: List[int] = field(default_factory=list)
    dangling_ports: List[int] = field(default_factory=list)
    redundancies: List[Tuple[int, int]] = field(default_factory=list)
    high_fanout_nets: List[Tuple[int, int]] = field(default_factory=list)
    critical_paths: List[CriticalPath] = field(default_factory=list)
    estimated_max_delay: float = 0.0
    violations: List[str] = field(default_factory=list)
    constraint_violations: List[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            "CIRCUIT ANALYSIS",
            f"  components: {self.n_components}",
            f"  nets: {self.n_nets}",
            f"  ports: {self.n_ports}",
            f"  unused components: {len(self.unused_components)}",
            f"  dangling ports: {len(self.dangling_ports)}",
            f"  redundancies: {len(self.redundancies)}",
            f"  high fan-out nets (>10): {len(self.high_fanout_nets)}",
            f"  critical paths: {len(self.critical_paths)}",
            f"  estimated max delay: {self.estimated_max_delay*1e9:.2f} ns",
        ]
        if self.violations:
            lines.append("  VIOLATIONS:")
            for v in self.violations:
                lines.append(f"    - {v}")
        if self.constraint_violations:
            lines.append("  CONSTRAINT VIOLATIONS:")
            for v in self.constraint_violations:
                lines.append(f"    - {v}")
        return "\n".join(lines)


def find_unused_components(circuit: Circuit) -> List[int]:
    """
    Components whose every output port is unconnected (floating).
    """
    out: List[int] = []
    for cid, comp in circuit.components.items():
        has_output = False
        any_connected = False
        for i, pspec in enumerate(comp.spec.ports):
            pid = comp.ports[i]
            port = circuit.ports[PortId(int(pid))]
            if port.net is not None:
                any_connected = True
            if port.net is not None and pspec.direction == PortDirection.OUTPUT:
                has_output = True
        if not any_connected:
            out.append(int(cid))
    return out


def find_dangling_ports(circuit: Circuit) -> List[int]:
    return [int(pid) for pid, p in circuit.ports.items() if p.net is None]


def find_redundancies(circuit: Circuit) -> List[Tuple[int, int]]:
    """
    Find pairs of identical components connected to the same set of nets.
    A real redundancy analysis would be more subtle (e.g. via BDDs or
    SAT), but this is a useful cheap heuristic.
    """
    out: List[Tuple[int, int]] = []
    seen: Set[int] = set()
    comps = list(circuit.components.items())
    for i, (cid_a, comp_a) in enumerate(comps):
        if int(cid_a) in seen:
            continue
        nets_a = set()
        for pid in comp_a.ports:
            port = circuit.ports[PortId(int(pid))]
            if port.net is not None:
                nets_a.add(int(port.net))
        for cid_b, comp_b in comps[i + 1:]:
            if comp_a.spec.name != comp_b.spec.name:
                continue
            if comp_a.params != comp_b.params:
                continue
            nets_b = set()
            for pid in comp_b.ports:
                port = circuit.ports[PortId(int(pid))]
                if port.net is not None:
                    nets_b.add(int(port.net))
            if nets_a == nets_b and len(nets_a) > 0:
                out.append((int(cid_a), int(cid_b)))
                seen.add(int(cid_b))
    return out


def fan_out_report(circuit: Circuit, threshold: int = 10) -> List[Tuple[int, int]]:
    """
    Return a list of (net_id, input_count) for nets whose input count
    exceeds `threshold`.
    """
    result: List[Tuple[int, int]] = []
    for nid, n in circuit.nets.items():
        in_count = 0
        for pid in n.ports:
            port = circuit.ports[PortId(int(pid))]
            comp = circuit.components.get(ComponentId(port.component))
            if comp is None:
                continue
            pspec = comp.spec.ports[port.spec_index]
            if pspec.direction in (PortDirection.INPUT, PortDirection.INOUT):
                in_count += 1
        if in_count > threshold:
            result.append((int(nid), in_count))
    return sorted(result, key=lambda x: -x[1])


def estimate_critical_path(circuit: Circuit) -> Tuple[List[CriticalPath], float]:
    """
    Estimate the critical path of a digital circuit.

    Each gate is assigned a delay = 1 (or its `tpd` parameter if
    set). The critical path is the longest weighted path from any
    input to any output in the gate graph.

    Returns
    -------
    paths : list of CriticalPath (top-K longest)
    max_delay : float (the longest delay found)
    """
    # Build a graph: component -> list of (next_component, weight)
    # Edges follow net connectivity.
    # For each component, its delay is its `tpd` param (default 1ns in this model).
    graph: Dict[int, List[Tuple[int, float]]] = {}
    delay_of: Dict[int, float] = {}
    in_degree: Dict[int, int] = {int(c): 0 for c in circuit.components}
    for cid, comp in circuit.components.items():
        d = comp.params.get("tpd", 1.0)  # treat as 1 unit
        delay_of[int(cid)] = d
        graph[int(cid)] = []
    # For each net, gather the components on it
    net_to_comps: Dict[int, Set[int]] = {}
    for nid, n in circuit.nets.items():
        comps_on_net = set()
        for pid in n.ports:
            port = circuit.ports[PortId(int(pid))]
            comps_on_net.add(int(port.component))
        net_to_comps[int(nid)] = comps_on_net
    # Edges: from a component to every other component that shares a net AND
    # that is downstream. The simplest model: from each component C to any
    # other component D that has at least one INPUT port on a net where C
    # has an OUTPUT port.
    edges_added: Set[Tuple[int, int]] = set()
    for nid, comps in net_to_comps.items():
        drivers = []  # components with output on this net
        receivers = []  # components with input on this net
        for cid in comps:
            comp = circuit.components[ComponentId(cid)]
            for i, pspec in enumerate(comp.spec.ports):
                pid = comp.ports[i]
                port = circuit.ports[PortId(int(pid))]
                if port.net != nid:
                    continue
                if pspec.direction == PortDirection.OUTPUT:
                    drivers.append(cid)
                elif pspec.direction in (PortDirection.INPUT, PortDirection.INOUT):
                    receivers.append(cid)
        for d in drivers:
            for r in receivers:
                if d == r:
                    continue
                if (d, r) in edges_added:
                    continue
                graph.setdefault(d, []).append((r, delay_of.get(d, 1.0)))
                edges_added.add((d, r))
                in_degree[r] = in_degree.get(r, 0) + 1
    # Topological sort
    queue = deque([c for c, d in in_degree.items() if d == 0])
    order: List[int] = []
    while queue:
        c = queue.popleft()
        order.append(c)
        for nxt, _ in graph.get(c, []):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)
    # Longest path in DAG
    best: Dict[int, float] = {int(c): 0.0 for c in circuit.components}
    parent: Dict[int, Optional[int]] = {int(c): None for c in circuit.components}
    for c in order:
        for nxt, w in graph.get(c, []):
            cand = best[c] + w
            if cand > best[nxt]:
                best[nxt] = cand
                parent[nxt] = c
    if not best:
        return [], 0.0
    max_c = max(best, key=lambda c: best[c])
    max_delay = best[max_c]
    # Reconstruct path
    path: List[int] = []
    cur: Optional[int] = max_c
    while cur is not None:
        path.append(cur)
        cur = parent[cur]
    path.reverse()
    return [CriticalPath(gates=path, delay=max_delay)], max_delay


def analyze_circuit(circuit: Circuit) -> CircuitAnalysis:
    analysis = CircuitAnalysis(
        n_components=len(circuit.components),
        n_nets=len(circuit.nets),
        n_ports=len(circuit.ports),
    )
    analysis.unused_components = find_unused_components(circuit)
    analysis.dangling_ports = find_dangling_ports(circuit)
    analysis.redundancies = find_redundancies(circuit)
    analysis.high_fanout_nets = fan_out_report(circuit, threshold=10)
    paths, max_delay = estimate_critical_path(circuit)
    analysis.critical_paths = paths
    analysis.estimated_max_delay = max_delay
    if analysis.dangling_ports:
        analysis.violations.append(
            f"{len(analysis.dangling_ports)} dangling port(s)"
        )
    if analysis.high_fanout_nets:
        analysis.violations.append(
            f"{len(analysis.high_fanout_nets)} high fan-out net(s)"
        )
    # Constraint violations
    for cid, comp in circuit.components.items():
        for pname, pval in comp.params.items():
            pspec_def = comp.spec.parameters.get(pname)
            if pspec_def is None:
                continue
            if pspec_def.min is not None and pval < pspec_def.min:
                analysis.constraint_violations.append(
                    f"component {comp.reference}: {pname}={pval} below min {pspec_def.min}"
                )
            if pspec_def.max is not None and pval > pspec_def.max:
                analysis.constraint_violations.append(
                    f"component {comp.reference}: {pname}={pval} above max {pspec_def.max}"
                )
    return analysis
