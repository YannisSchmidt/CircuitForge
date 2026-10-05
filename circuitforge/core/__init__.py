"""Core data model: components, ports, nets, circuits.

This package owns the data model. Simulation engines consume Circuit
objects. The model is intentionally value-oriented: most attributes are
plain primitives (floats, ints, strings, small dataclasses). Heavy
simulation state is held by the engines, not in the core graph.
"""

from .ids import NodeId, ComponentId, NetId, PortId, ChipId
from .ports import Port, PortDirection, PortKind, PortSpec
from .nets import Net
from .components import (
    Component, ComponentKind, ComponentSpec, ModelAccuracy,
    PARAM_R, PARAM_C, PARAM_L, PARAM_VTH, PARAM_TEMP, PARAM_TCR,
    PARAM_KN, PARAM_KP, PARAM_LEAK, PARAM_VBREAK,
    PARAM_TR, PARAM_TF, PARAM_TD, PARAM_RTH, PARAM_CTH,
    PARAM_VDC, PARAM_VAC_AMP, PARAM_VAC_FREQ, PARAM_VAC_PHASE,
    PARAM_PULSE_VHI, PARAM_PULSE_VLO, PARAM_PULSE_PERIOD,
    PARAM_PULSE_WIDTH, PARAM_PULSE_RISE, PARAM_PULSE_FALL,
    PARAM_IDC, PARAM_PMAX, PARAM_VMAX, PARAM_IMAX,
)
from .circuit import Circuit
from .library import Library, ChipDefinition
from .primitives import (
    register_primitive_specs, BUILTIN_PRIMITIVES,
    ResistorSpec, CapacitorSpec, InductorSpec,
    DiodeSpec, NmosSpec, PmosSpec, BjtNpnSpec,
    VSourceDcSpec, VSourceAcSpec, VSourcePulseSpec, ISourceDcSpec,
    SwitchSpec, GroundSpec,
)
from .build import build_circuit, add_component, connect, connect_ports, Ground

__all__ = [
    "NodeId", "ComponentId", "NetId", "PortId", "ChipId",
    "Port", "PortDirection", "PortKind", "PortSpec",
    "Net",
    "Component", "ComponentKind", "ComponentSpec", "ModelAccuracy",
    "PARAM_R", "PARAM_C", "PARAM_L", "PARAM_VTH", "PARAM_TEMP", "PARAM_TCR",
    "PARAM_KN", "PARAM_KP", "PARAM_LEAK", "PARAM_VBREAK",
    "PARAM_TR", "PARAM_TF", "PARAM_TD", "PARAM_RTH", "PARAM_CTH",
    "PARAM_VDC", "PARAM_VAC_AMP", "PARAM_VAC_FREQ", "PARAM_VAC_PHASE",
    "PARAM_PULSE_VHI", "PARAM_PULSE_VLO", "PARAM_PULSE_PERIOD",
    "PARAM_PULSE_WIDTH", "PARAM_PULSE_RISE", "PARAM_PULSE_FALL",
    "PARAM_IDC", "PARAM_PMAX", "PARAM_VMAX", "PARAM_IMAX",
    "Circuit",
    "Library", "ChipDefinition",
    "register_primitive_specs", "BUILTIN_PRIMITIVES",
    "ResistorSpec", "CapacitorSpec", "InductorSpec",
    "DiodeSpec", "NmosSpec", "PmosSpec", "BjtNpnSpec",
    "VSourceDcSpec", "VSourceAcSpec", "VSourcePulseSpec", "ISourceDcSpec",
    "SwitchSpec", "GroundSpec",
    "build_circuit", "add_component", "connect", "connect_ports", "Ground",
]
