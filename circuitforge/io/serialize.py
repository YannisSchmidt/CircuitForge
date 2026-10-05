"""
JSON-based serialization of circuits and libraries.

This is the canonical, human-readable serialization used for projects,
chips, and optimization checkpoints. The format is intentionally simple
so it can be diffed and version-controlled.

Schema versioning: every serialized blob carries a schema version. The
loader refuses to load blobs from an unknown future version.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple, Optional

from .. import __schema_version__, __engine_version__
from ..exceptions import SchemaError
from ..core.circuit import Circuit
from ..core.components import ComponentSpec, ComponentKind, ModelAccuracy, ParameterSpec
from ..core.ports import PortSpec, PortDirection, PortKind
from ..core.library import Library, ChipDefinition
from ..core.primitives import register_primitive_specs


# ----------------------------------------------------------------------------
# Spec <-> dict
# ----------------------------------------------------------------------------

def _portspec_to_dict(p: PortSpec) -> Dict[str, Any]:
    return {
        "name": p.name,
        "direction": p.direction.value,
        "kind": p.kind.value,
        "default_net": p.default_net,
        "description": p.description,
    }


def _portspec_from_dict(d: Dict[str, Any]) -> PortSpec:
    return PortSpec(
        name=d["name"],
        direction=PortDirection(d.get("direction", "none")),
        kind=PortKind(d.get("kind", "analog")),
        default_net=d.get("default_net"),
        description=d.get("description", ""),
    )


def _paramspec_to_dict(p: ParameterSpec) -> Dict[str, Any]:
    return {
        "name": p.name,
        "default": p.default,
        "unit": p.unit,
        "min": p.min,
        "max": p.max,
        "description": p.description,
    }


def _paramspec_from_dict(d: Dict[str, Any]) -> ParameterSpec:
    return ParameterSpec(
        name=d["name"],
        default=float(d["default"]),
        unit=d.get("unit", ""),
        min=d.get("min"),
        max=d.get("max"),
        description=d.get("description", ""),
    )


def _accuracy_to_dict(acc: ModelAccuracy) -> str:
    return acc.name


def _accuracy_from_dict(s: str) -> ModelAccuracy:
    return ModelAccuracy[s]


def spec_to_dict(spec: ComponentSpec) -> Dict[str, Any]:
    return {
        "name": spec.name,
        "category": spec.category.value,
        "primitive": spec.primitive,
        "description": spec.description,
        "ports": [_portspec_to_dict(p) for p in spec.ports],
        "parameters": {k: _paramspec_to_dict(v) for k, v in spec.parameters.items()},
        "model_accuracy": {k: _accuracy_to_dict(v) for k, v in spec.model_accuracy.items()},
    }


def spec_from_dict(d: Dict[str, Any]) -> ComponentSpec:
    s = ComponentSpec(
        name=d["name"],
        category=ComponentKind(d["category"]),
        primitive=d.get("primitive", True),
        description=d.get("description", ""),
    )
    for pd in d.get("ports", []):
        s.ports.append(_portspec_from_dict(pd))
    for k, pv in d.get("parameters", {}).items():
        s.parameters[k] = _paramspec_from_dict(pv)
    for k, v in d.get("model_accuracy", {}).items():
        s.model_accuracy[k] = _accuracy_from_dict(v)
    return s


# ----------------------------------------------------------------------------
# Circuit <-> dict
# ----------------------------------------------------------------------------

def circuit_to_dict(circuit: Circuit) -> Dict[str, Any]:
    comps = []
    for cid in sorted(circuit.components, key=lambda x: int(x)):
        c = circuit.components[cid]
        comps.append({
            "id": int(cid),
            "spec": c.spec.name,
            "reference": c.reference,
            "params": {k: c.params[k] for k in sorted(c.params)},
            "ports": [int(p) for p in c.ports],
            "position": [c.position[0], c.position[1]],
            "rotation": c.rotation,
            "metadata": c.metadata,
        })
    nets = []
    for nid in sorted(circuit.nets, key=lambda x: int(x)):
        n = circuit.nets[nid]
        nets.append({
            "id": int(nid),
            "name": n.name,
            "is_global": n.is_global,
            "ports": [int(p) for p in sorted(n.ports, key=lambda x: int(x))],
        })
    ports = []
    for pid in sorted(circuit.ports, key=lambda x: int(x)):
        p = circuit.ports[pid]
        ports.append({
            "id": int(pid),
            "component": p.component,
            "spec_index": p.spec_index,
            "name": p.name,
            "direction": p.direction.value,
            "kind": p.kind.value,
            "net": int(p.net) if p.net is not None else None,
        })
    return {
        "schema": __schema_version__,
        "engine": __engine_version__,
        "name": circuit.name,
        "description": circuit.description,
        "metadata": circuit.metadata,
        "counters": {
            "next_component": circuit._next_component,
            "next_net": circuit._next_net,
            "next_port": circuit._next_port,
        },
        "components": comps,
        "nets": nets,
        "ports": ports,
    }


def circuit_from_dict(d: Dict[str, Any], library: Library) -> Circuit:
    schema = d.get("schema")
    if schema is None:
        raise SchemaError("serialized circuit has no schema version")
    if schema > __schema_version__:
        raise SchemaError(
            f"serialized schema {schema} is newer than supported {__schema_version__}"
        )
    c = Circuit(name=d.get("name", "untitled"),
                description=d.get("description", ""),
                library=library,
                metadata=d.get("metadata", {}))
    # Pre-allocate counter to avoid ID collisions
    from ..core.ids import PortId, NetId
    ctrs = d.get("counters", {})
    c._next_component = int(ctrs.get("next_component", 0))
    c._next_net = int(ctrs.get("next_net", 0))
    c._next_port = int(ctrs.get("next_port", 0))
    # Restore nets first
    for nd in d.get("nets", []):
        from ..core.nets import Net
        from ..core.ids import NetId
        nid = NetId(int(nd["id"]))
        n = Net(id=int(nid), name=nd.get("name", ""), is_global=nd.get("is_global", False))
        n.ports = {PortId(int(p)) for p in nd.get("ports", [])}
        c._nets[nid] = n
        if n.is_global and n.name and library is not None:
            library.register_global_net(n.name, nid)
    # Restore ports
    for pd in d.get("ports", []):
        from ..core.ports import Port
        from ..core.ids import PortId
        pid = PortId(int(pd["id"]))
        c._ports[pid] = Port(
            component=int(pd["component"]),
            spec_index=int(pd["spec_index"]),
            name=pd["name"],
            direction=PortDirection(pd.get("direction", "none")),
            kind=PortKind(pd.get("kind", "analog")),
            net=int(pd["net"]) if pd.get("net") is not None else None,
        )
    # Restore components
    for cd in d.get("components", []):
        from ..core.components import Component
        from ..core.ids import PortId, ComponentId
        cid = ComponentId(int(cd["id"]))
        spec_name = cd["spec"]
        if not library.has_primitive(spec_name):
            raise SchemaError(f"serialized component references unknown spec {spec_name!r}")
        spec = library.get_primitive(spec_name)
        comp = Component(
            id=int(cid),
            spec=spec,
            reference=cd.get("reference", ""),
            params={k: float(v) for k, v in cd.get("params", {}).items()},
            ports=[PortId(int(p)) for p in cd.get("ports", [])],
            position=tuple(cd.get("position", [0.0, 0.0])),
            rotation=int(cd.get("rotation", 0)),
            metadata=cd.get("metadata", {}),
        )
        c._components[cid] = comp
    return c


# ----------------------------------------------------------------------------
# Library <-> dict
# ----------------------------------------------------------------------------

def library_to_dict(library: Library) -> Dict[str, Any]:
    return {
        "name": library.name,
        "primitives": {name: spec_to_dict(spec) for name, spec in library._primitives.items()},
        # chips handled separately (they may contain circuits)
        "global_nets": library._global_nets,
    }


def library_from_dict(d: Dict[str, Any]) -> Library:
    lib = Library(name=d.get("name", "default"))
    for name, sd in d.get("primitives", {}).items():
        spec = spec_from_dict(sd)
        lib._primitives[name] = spec
    lib._global_nets = dict(d.get("global_nets", {}))
    return lib


# ----------------------------------------------------------------------------
# Project (circuit + library) <-> JSON
# ----------------------------------------------------------------------------

def project_to_json(circuit: Circuit) -> str:
    if circuit.library is None:
        raise ValueError("cannot serialize a circuit without a library")
    payload = {
        "schema": __schema_version__,
        "engine": __engine_version__,
        "library": library_to_dict(circuit.library),
        "circuit": circuit_to_dict(circuit),
    }
    return json.dumps(payload, indent=2, sort_keys=True)


def project_from_json(s: str) -> Circuit:
    payload = json.loads(s)
    schema = payload.get("schema")
    if schema is None or schema > __schema_version__:
        raise SchemaError(
            f"project schema {schema} not supported (max={__schema_version__})"
        )
    lib = library_from_dict(payload["library"])
    # ensure primitives are registered (so spec lookups work even if
    # the library is partial)
    if not lib._primitives:
        register_primitive_specs(lib)
    return circuit_from_dict(payload["circuit"], lib)
