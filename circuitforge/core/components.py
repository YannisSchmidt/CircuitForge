"""
Components.

A *ComponentSpec* is the static description of a kind of component
(what parameters it has, what ports it exposes, what physical model
applies, what accuracy level it can simulate at).

A *Component* is a live instance of a spec inside a circuit: it has a
unique id, a reference name (e.g. "R12"), concrete parameter values,
and a list of live ports.

This separation lets us (a) register primitive specs once, (b) reuse
the same spec thousands of times in a circuit with different parameter
values, and (c) cache per-spec dispatch in the simulation engine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Any, List, Optional, Tuple, Callable

from .ids import ComponentId
from .ports import PortSpec, PortDirection, PortKind


# ---- canonical parameter names (string constants) ----
# These are not enforced as the only names a spec can use, but they
# standardize the common ones so analysis code can rely on them.
PARAM_R = "r"            # resistance in ohm
PARAM_C = "c"            # capacitance in F
PARAM_L = "l"            # inductance in H
PARAM_VTH = "vth"        # threshold voltage in V
PARAM_KN = "kn"          # NMOS transconductance parameter
PARAM_KP = "kp"          # PMOS transconductance parameter
PARAM_TEMP = "temp"      # operating temperature in K
PARAM_LEAK = "leak"      # leakage current in A
PARAM_VBREAK = "vbreak"  # breakdown voltage
PARAM_TR = "tr"          # rise time
PARAM_TF = "tf"          # fall time
PARAM_TD = "td"          # propagation delay
PARAM_RTH = "rth"        # thermal resistance K/W
PARAM_CTH = "cth"        # thermal capacitance J/K
PARAM_VDC = "vdc"        # DC voltage
PARAM_VAC_AMP = "vac_amp"
PARAM_VAC_FREQ = "vac_freq"
PARAM_VAC_PHASE = "vac_phase"
PARAM_PULSE_VHI = "pulse_vhi"
PARAM_PULSE_VLO = "pulse_vlo"
PARAM_PULSE_PERIOD = "pulse_period"
PARAM_PULSE_WIDTH = "pulse_width"
PARAM_PULSE_RISE = "pulse_rise"
PARAM_PULSE_FALL = "pulse_fall"
PARAM_IDC = "idc"
PARAM_PMAX = "pmax"      # max power rating
PARAM_VMAX = "vmax"      # max voltage rating
PARAM_IMAX = "imax"      # max current rating
PARAM_TCR = "tcr"        # temperature coefficient (1/K)


class ModelAccuracy(Enum):
    """
    Honest accounting of what a model actually captures.

    See section 2 of the specification: every component must be labeled
    with the accuracy level it is *really* simulating.
    """
    NOT_MODELED = 0
    IDEALIZED = 1
    APPROXIMATED = 2
    REALISTIC = 3


class ComponentKind(Enum):
    """
    Coarse classification of a component. Used by the analyzer and by
    the BOM export. A finer-grained classification is provided by the
    spec's `category` field.
    """
    PASSIVE = "passive"
    SEMICONDUCTOR = "semiconductor"
    SOURCE = "source"
    SWITCH = "switch"
    INSTRUMENT = "instrument"
    LOGIC_GATE = "logic_gate"
    CUSTOM = "custom"


@dataclass
class ParameterSpec:
    """Description of a single parameter of a component spec."""
    name: str
    default: float
    unit: str = ""           # documentation only
    min: Optional[float] = None
    max: Optional[float] = None
    description: str = ""

    def validate(self, value: float) -> float:
        if self.min is not None and value < self.min:
            raise ValueError(
                f"parameter '{self.name}'={value} below min {self.min} {self.unit}"
            )
        if self.max is not None and value > self.max:
            raise ValueError(
                f"parameter '{self.name}'={value} above max {self.max} {self.unit}"
            )
        return float(value)


@dataclass
class ComponentSpec:
    """
    Static description of a component kind.

    Attributes
    ----------
    name: str
        Unique name within the library (e.g. "RESISTOR", "NMOS", "VSRC_DC").
    category: ComponentKind
    parameters: dict name -> ParameterSpec
    ports: list of PortSpec (positional)
    primitive: bool
        True for atomic components. False for chips (hierarchical).
    model_accuracy: dict level_name -> ModelAccuracy
        Maps each simulation level ("logic", "electrical", "detailed",
        "thermal") to the accuracy the spec actually achieves. Required.
    description: str
    """
    name: str
    category: ComponentKind
    parameters: Dict[str, ParameterSpec] = field(default_factory=dict)
    ports: List[PortSpec] = field(default_factory=list)
    primitive: bool = True
    model_accuracy: Dict[str, ModelAccuracy] = field(default_factory=dict)
    description: str = ""

    def port_index(self, name: str) -> int:
        for i, p in enumerate(self.ports):
            if p.name == name:
                return i
        raise KeyError(f"spec {self.name!r} has no port named {name!r}")

    def get_param_default(self, name: str) -> float:
        p = self.parameters.get(name)
        if p is None:
            raise KeyError(f"spec {self.name!r} has no parameter {name!r}")
        return p.default

    def add_param(self, name: str, default: float, **kw) -> None:
        if name in self.parameters:
            raise ValueError(f"parameter {name!r} already declared in {self.name!r}")
        self.parameters[name] = ParameterSpec(name=name, default=default, **kw)

    def add_port(self, name: str, direction=PortDirection.NONE, kind=PortKind.ANALOG,
                 default_net: Optional[str] = None, description: str = "") -> None:
        if any(p.name == name for p in self.ports):
            raise ValueError(f"port {name!r} already declared in {self.name!r}")
        self.ports.append(PortSpec(name=name, direction=direction, kind=kind,
                                   default_net=default_net, description=description))

    def declare_model_accuracy(self, **mapping) -> None:
        """
        Declare the accuracy of this spec at each simulation level.

        Example:
            spec.declare_model_accuracy(
                logic=ModelAccuracy.IDEALIZED,
                electrical=ModelAccuracy.APPROXIMATED,
                detailed=ModelAccuracy.APPROXIMATED,
                thermal=ModelAccuracy.NOT_MODELED,
            )
        """
        for k, v in mapping.items():
            if not isinstance(v, ModelAccuracy):
                raise TypeError(f"accuracy for {k!r} must be ModelAccuracy, got {type(v)}")
            self.model_accuracy[k] = v

    def accuracy_report(self) -> str:
        """Return a human-readable accuracy report (section 2 of spec)."""
        lines = ["MODEL ACCURACY"]
        for level in ("logic", "electrical", "detailed", "thermal"):
            acc = self.model_accuracy.get(level, ModelAccuracy.NOT_MODELED)
            lines.append(f"  {level:<11s} {acc.name}")
        return "\n".join(lines)


@dataclass
class Component:
    """
    A live component instance inside a circuit.

    Attributes
    ----------
    id: ComponentId
    spec: ComponentSpec
    reference: str
        Human reference, e.g. "R12", "Q4", "U2".
    params: dict name -> float
        Concrete parameter values for this instance.
    ports: list of PortId
        Indices into the circuit's port list.
    position: (x, y)
        Free-form layout coordinate (used for export).
    rotation: int
        Rotation in degrees (0/90/180/270).
    metadata: dict
        Free-form user data; never used by the engine.
    """
    id: int
    spec: ComponentSpec
    reference: str = ""
    params: Dict[str, float] = field(default_factory=dict)
    ports: List[int] = field(default_factory=list)
    position: Tuple[float, float] = (0.0, 0.0)
    rotation: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:
        return f"Component({self.reference or self.spec.name}#{self.id})"

    def get_param(self, name: str) -> float:
        if name in self.params:
            return self.params[name]
        return self.spec.get_param_default(name)

    def set_param(self, name: str, value: float) -> None:
        pspec = self.spec.parameters.get(name)
        if pspec is None:
            # Tolerate arbitrary user parameters but warn via spec extension
            self.params[name] = float(value)
            return
        self.params[name] = pspec.validate(value)
