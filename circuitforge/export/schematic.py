"""
Schematic export.

Three levels (section 20 of the spec):
- HIERARCHICAL: chips are shown as blocks.
- DEFLATED:   recursive unfolding of nested chips (one level).
- FULL ELECTRICAL: every chip is unfolded to primitive components.

The output is a Python dict (round-trippable via the JSON serializer).
This is intentionally simple and machine-readable so it can be
imported by other tools (e.g. KiCad, custom viewers).

A BOM (Bill of Materials) is exported separately (section 22).
"""

from __future__ import annotations

import json
from typing import Dict, List, Tuple, Any, Optional

from ..core.circuit import Circuit
from ..core.components import ComponentSpec
from ..core.ids import ComponentId, PortId, NetId
from ..core.library import Library, ChipDefinition
from ..chips.hierarchical import list_chip_instances, unfold_chip


def _component_export(c, comp, absolute_net_id) -> Dict[str, Any]:
    """Build the export dict for a single component."""
    connections = []
    for i, pid in enumerate(comp.ports):
        port = c.ports[PortId(int(pid))]
        net_id = int(port.net) if port.net is not None else None
        connections.append({
            "port_index": i,
            "port_name": comp.spec.ports[i].name,
            "net_id": net_id,
        })
    return {
        "reference": comp.reference,
        "spec": comp.spec.name,
        "category": comp.spec.category.value,
        "params": {k: comp.params[k] for k in sorted(comp.params)},
        "position": [comp.position[0], comp.position[1]],
        "rotation": comp.rotation,
        "connections": connections,
        "model_accuracy": {k: v.name for k, v in comp.spec.model_accuracy.items()},
    }


def export_hierarchical(circuit: Circuit, library: Optional[Library] = None) -> Dict[str, Any]:
    """
    Export the circuit keeping chip instances as blocks.
    """
    components = []
    for cid in sorted(circuit.components, key=lambda x: int(x)):
        comp = circuit.components[cid]
        components.append(_component_export(circuit, comp, None))
    return {
        "kind": "schematic.hierarchical",
        "circuit_name": circuit.name,
        "n_components": len(components),
        "components": components,
        "nets": [
            {"id": int(nid), "name": n.name, "n_ports": len(n.ports),
             "is_global": n.is_global}
            for nid, n in sorted(circuit.nets.items(), key=lambda x: int(x[0]))
        ],
    }


def export_flat(circuit: Circuit, library: Library, max_depth: int = 1) -> Dict[str, Any]:
    """
    Export with chips recursively unfolded up to `max_depth` levels.
    """
    current = circuit
    for _ in range(max_depth):
        instances = list_chip_instances(current)
        if not instances:
            break
        for inst in instances:
            current = unfold_chip(current, library, inst.chip_name, inst.component_id)
            break  # restart after each unfold (newly created chips may exist)
    return export_hierarchical(current)


def export_full_electrical(circuit: Circuit, library: Library) -> Dict[str, Any]:
    """
    Export the fully unfolded electrical schematic (section 20, level 3).
    Every chip is expanded to its internal primitives.
    """
    return export_flat(circuit, library, max_depth=100)


def export_to_dict(circuit: Circuit, library: Optional[Library] = None) -> Dict[str, Any]:
    """Default export: hierarchical."""
    return export_hierarchical(circuit, library)


def export_bom(circuit: Circuit) -> Dict[str, Any]:
    """Generate a Bill of Materials (section 22)."""
    bom = circuit.bom()
    detailed = circuit.detailed_bom()
    return {
        "circuit_name": circuit.name,
        "total_components": sum(bom.values()),
        "by_type": bom,
        "detailed": [
            {"reference": ref, "spec": spec, "primary_value": val}
            for ref, spec, val, _ in detailed
        ],
    }


def export_to_json(circuit: Circuit, library: Optional[Library] = None) -> str:
    """Default export as a JSON string."""
    return json.dumps(export_hierarchical(circuit, library), indent=2)