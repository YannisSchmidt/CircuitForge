"""
Circuit.

A Circuit is the central data structure of CircuitForge. It contains:
- a set of components (with their concrete parameter values);
- a set of nets (each a set of connected ports);
- a name and a description;
- a library reference (for resolving primitive specs);
- hierarchical sub-circuits (chips).

The Circuit is a *value*: it is fully serializable, and two Circuits
with the same structure produce the same fingerprint.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any, Iterator, Set

from .ids import NodeId, ComponentId, NetId, PortId, ChipId
from .ports import Port, PortSpec, PortDirection, PortKind
from .nets import Net
from .components import Component, ComponentSpec, ComponentKind, ModelAccuracy
from .library import Library
from ..utils.hashes import stable_hash


@dataclass
class Circuit:
    """
    A circuit graph.

    A circuit is owned by exactly one Library, which is the registry
    of available component specs (primitives and chips). When saving
    a circuit, both the circuit and the (slice of the) library it needs
    are serialized together.
    """
    name: str = "untitled"
    description: str = ""
    library: Optional[Library] = None

    # graph state
    _components: Dict[ComponentId, Component] = field(default_factory=dict)
    _nets: Dict[NetId, Net] = field(default_factory=dict)
    _ports: Dict[PortId, Port] = field(default_factory=dict)

    # counters
    _next_component: int = 0
    _next_net: int = 0
    _next_port: int = 0

    # free-form
    metadata: Dict[str, Any] = field(default_factory=dict)

    # ---- read-only views ----
    @property
    def components(self) -> Dict[int, Component]:
        return self._components

    @property
    def nets(self) -> Dict[int, Net]:
        return self._nets

    @property
    def ports(self) -> Dict[int, Port]:
        return self._ports

    def component(self, cid) -> Component:
        return self._components[ComponentId(int(cid))]

    def net(self, nid) -> Net:
        return self._nets[NetId(int(nid))]

    def port(self, pid) -> Port:
        return self._ports[PortId(int(pid))]

    def __iter__(self) -> Iterator[Component]:
        return iter(self._components.values())

    def __len__(self) -> int:
        return len(self._components)

    # ---- id allocation ----
    def _alloc_component_id(self) -> int:
        cid = self._next_component
        self._next_component += 1
        return cid

    def _alloc_net_id(self) -> int:
        nid = self._next_net
        self._next_net += 1
        return nid

    def _alloc_port_id(self) -> int:
        pid = self._next_port
        self._next_port += 1
        return pid

    # ---- component management ----
    def add_component(
        self,
        spec,  # ComponentSpec or str (name looked up in this.library)
        reference: str = "",
        params: Optional[Dict[str, float]] = None,
        position: Tuple[float, float] = (0.0, 0.0),
        rotation: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Component:
        cid_int = self._alloc_component_id()
        cid = ComponentId(cid_int)
        # Resolve spec by name if a string is given
        if isinstance(spec, str):
            if self.library is None or not self.library.has_primitive(spec):
                raise KeyError(f"unknown primitive {spec!r}")
            spec = self.library.get_primitive(spec)
        # Validate and apply params
        concrete: Dict[str, float] = {}
        if params:
            for k, v in params.items():
                if k in spec.parameters:
                    concrete[k] = spec.parameters[k].validate(v)
                else:
                    concrete[k] = float(v)
        # ensure all declared parameters are present (with defaults)
        for k, pspec in spec.parameters.items():
            if k not in concrete:
                concrete[k] = pspec.default
        # ports
        ports: List[PortId] = []
        for i, pspec in enumerate(spec.ports):
            pid_int = self._alloc_port_id()
            pid = PortId(pid_int)
            ports.append(pid)
            self._ports[pid] = Port(
                component=cid_int,
                spec_index=i,
                name=pspec.name,
                direction=pspec.direction,
                kind=pspec.kind,
                net=None,
            )
        comp = Component(
            id=cid_int,
            spec=spec,
            reference=reference or f"{spec.name}_{cid_int}",
            params=concrete,
            ports=ports,
            position=position,
            rotation=rotation,
            metadata=dict(metadata) if metadata else {},
        )
        self._components[cid] = comp
        # auto-attach power/ground ports to global nets
        for i, pspec in enumerate(spec.ports):
            if pspec.default_net and self.library is not None:
                pid = comp.ports[i]
                gname = pspec.default_net
                # Reuse an existing net with this name in the circuit
                existing = None
                for n in self._nets.values():
                    if n.name == gname and n.is_global:
                        existing = n.id
                        break
                if existing is not None:
                    self._attach_to_net(pid, existing)
                    if self.library.has_global_net(gname):
                        self.library.register_global_net(gname, existing)
                else:
                    real_nid_int = self.create_net(name=gname, is_global=True)
                    self.library.register_global_net(gname, real_nid_int)
                    self._attach_to_net(pid, real_nid_int)
        return comp

    # ---- net management ----
    def create_net(self, name: str = "", is_global: bool = False) -> int:
        nid_int = self._alloc_net_id()
        self._nets[NetId(nid_int)] = Net(id=nid_int, name=name, is_global=is_global)
        return nid_int

    def ensure_net(self, name: str) -> int:
        for n in self._nets.values():
            if n.name == name:
                return n.id
        return self.create_net(name=name)

    def get_or_create_global_net(self, name: str) -> int:
        if self.library is None:
            raise RuntimeError("circuit has no library; cannot resolve global net")
        if self.library.has_global_net(name):
            return self.library.get_global_net(name)
        nid_int = self.create_net(name=name, is_global=True)
        self.library.register_global_net(name, nid_int)
        return nid_int

    def connect(self, a_port, b_port) -> int:
        """Connect two ports. Returns the resulting net id (int)."""
        a_pid = PortId(int(a_port))
        b_pid = PortId(int(b_port))
        ap = self._ports[a_pid]
        bp = self._ports[b_pid]
        if ap.net is None and bp.net is None:
            nid_int = self.create_net()
            self._attach_to_net(a_pid, nid_int)
            self._attach_to_net(b_pid, nid_int)
            return nid_int
        if ap.net is not None and bp.net is None:
            self._attach_to_net(b_pid, ap.net)
            return ap.net
        if ap.net is None and bp.net is not None:
            self._attach_to_net(a_pid, bp.net)
            return bp.net
        if ap.net == bp.net:
            return ap.net
        return self._merge_nets(ap.net, bp.net)

    def connect_port_to_net(self, port, net) -> None:
        self._attach_to_net(PortId(int(port)), int(net))

    def _attach_to_net(self, port, net) -> None:
        pid = PortId(int(port))
        nid = NetId(int(net))
        p = self._ports[pid]
        if p.net is not None:
            old = self._nets[p.net]
            old.ports.discard(pid)
            old.drivers.discard(pid)
        p.net = nid
        self._nets[nid].ports.add(pid)

    def _merge_nets(self, a, b) -> int:
        a = int(a) if a is not None else None
        b = int(b) if b is not None else None
        if a == b:
            return a
        keep, drop = (a, b) if a < b else (b, a)
        nk = self._nets[NetId(keep)]
        nd = self._nets[NetId(drop)]
        for p in list(nd.ports):
            self._attach_to_net(p, keep)
        del self._nets[NetId(drop)]
        return keep

    # ---- bulk construction ----
    def connect_chain(self, *port_ids) -> int:
        if not port_ids:
            raise ValueError("connect_chain requires at least one port")
        first = PortId(int(port_ids[0]))
        net = self._ports[first].net
        if net is None:
            net_int = self.create_net()
            self._attach_to_net(first, net_int)
        for pid in port_ids[1:]:
            self._attach_to_net(PortId(int(pid)), net)
        return net

    # ---- integrity checks ----
    def check_integrity(self) -> List[str]:
        issues: List[str] = []
        comp_ids = set(int(c) for c in self._components.keys())
        for pid, p in self._ports.items():
            if p.component not in comp_ids:
                issues.append(f"port {pid} references unknown component {p.component}")
        dangling = [pid for pid, p in self._ports.items() if p.net is None]
        if dangling:
            issues.append(f"{len(dangling)} dangling port(s) (not connected to any net)")
        for nid, n in list(self._nets.items()):
            if not n.ports:
                issues.append(f"net {nid} ({n.name!r}) is empty")
                del self._nets[nid]
        # Library global nets that have id==0 are not yet materialised;
        # that's a hint, not an error.
        if self.library is not None:
            for gname in self.library.list_global_nets():
                gnid = self.library.get_global_net(gname)
                if gnid == 0:
                    continue  # not materialised yet
                if not any(n.name == gname for n in self._nets.values()):
                    issues.append(f"library global net {gname!r} is not used")
        return issues

    # ---- fingerprinting ----
    def fingerprint(self) -> str:
        comp_data = []
        for cid in sorted(self._components, key=lambda x: int(x)):
            c = self._components[cid]
            comp_data.append({
                "spec": c.spec.name,
                "params": {k: c.params[k] for k in sorted(c.params)},
                "ports": [int(p) for p in c.ports],
            })
        port_net = []
        for pid in sorted(self._ports, key=lambda x: int(x)):
            p = self._ports[pid]
            port_net.append({
                "port": int(pid),
                "net": int(p.net) if p.net is not None else -1,
            })
        return stable_hash({"components": comp_data, "ports": port_net})

    # ---- reporting ----
    def bom(self) -> Dict[str, int]:
        """Return a Bill of Materials as a dict spec_name -> count."""
        result: Dict[str, int] = {}
        for c in self._components.values():
            result[c.spec.name] = result.get(c.spec.name, 0) + 1
        return result

    def detailed_bom(self) -> List[Tuple[str, str, float, int]]:
        out: List[Tuple[str, str, float, int]] = []
        for c in self._components.values():
            primary = _primary_param(c.spec.name, c.params)
            out.append((c.reference, c.spec.name, primary, 1))
        return out

    def __repr__(self) -> str:
        return f"Circuit({self.name!r}: {len(self._components)} components, {len(self._nets)} nets)"


_PRIMARY_PARAM_CACHE = {
    "RESISTOR": "r",
    "CAPACITOR": "c",
    "INDUCTOR": "l",
    "NMOS": "kn",
    "PMOS": "kp",
    "DIODE": None,  # no obvious primary
    "BJT_NPN": None,
    "VSRC_DC": "vdc",
    "ISRC_DC": "idc",
    "VSRC_AC": "vac_amp",
    "VSRC_PULSE": "pulse_vhi",
    "SWITCH": None,
}


def _primary_param(spec_name: str, params: Dict[str, float]) -> float:
    name = _PRIMARY_PARAM_CACHE.get(spec_name)
    if name and name in params:
        return params[name]
    if params:
        # fall back to first param alphabetically
        return params[sorted(params)[0]]
    return 0.0
