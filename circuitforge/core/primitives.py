"""
Primitive component specs.

Each primitive spec is registered into a Library when the module is
imported. The accuracy declarations follow the contract defined in
section 2 of the specification: every model declares what it actually
simulates, and the user can see whether a given simulation level is
REALISTIC, APPROXIMATED, IDEALIZED, or NOT MODELED for that component.

Accuracy policy for the primitives implemented here
---------------------------------------------------
RESISTOR / CAPACITOR / INDUCTOR:
    - logic:           NOT_MODELED  (these are analog parts)
    - electrical:      APPROXIMATED  (linear model with parasitics; no aging, no noise)
    - detailed:        APPROXIMATED  (same as electrical; no non-linear drift)
    - thermal:         APPROXIMATED  (power dissipation + thermal RC; no convection)

DIODE / LED:
    - logic:           NOT_MODELED
    - electrical:      APPROXIMATED  (Shockley equation with R_s; no reverse recovery)
    - detailed:        APPROXIMATED  (adds reverse recovery model)
    - thermal:         APPROXIMATED  (Pdiss -> Tj with thermal RC)

BJT / MOSFET:
    - logic:           NOT_MODELED
    - electrical:      APPROXIMATED  (Ebers-Moll / Shichman-Hodges; no body effect, no short-channel)
    - detailed:        APPROXIMATED  (adds body effect, channel-length modulation, subthreshold)
    - thermal:         APPROXIMATED  (Pdiss -> Tj with thermal RC; self-heating)

SOURCES:
    - logic:           IDEALIZED     (digital pulses only)
    - electrical:      APPROXIMATED  (ideal source with R_s)
    - detailed:        APPROXIMATED
    - thermal:         NOT_MODELED   (we don't heat sources)

SWITCH:
    - logic:           IDEALIZED
    - electrical:      APPROXIMATED  (Ron / Roff)
    - detailed:        APPROXIMATED
    - thermal:         NOT_MODELED
"""

from __future__ import annotations

from typing import Dict, List

from .components import (
    ComponentSpec, ComponentKind, ModelAccuracy,
    PARAM_R, PARAM_C, PARAM_L, PARAM_VTH,
    PARAM_KN, PARAM_KP, PARAM_TEMP, PARAM_LEAK, PARAM_VBREAK,
    PARAM_TR, PARAM_TF, PARAM_TD, PARAM_RTH, PARAM_CTH,
    PARAM_VDC, PARAM_VAC_AMP, PARAM_VAC_FREQ, PARAM_VAC_PHASE,
    PARAM_PULSE_VHI, PARAM_PULSE_VLO, PARAM_PULSE_PERIOD,
    PARAM_PULSE_WIDTH, PARAM_PULSE_RISE, PARAM_PULSE_FALL,
    PARAM_IDC, PARAM_PMAX, PARAM_VMAX, PARAM_IMAX,
)
from .library import Library
from .ports import PortDirection, PortKind


BUILTIN_PRIMITIVES: List[str] = []  # filled in by register_primitive_specs


def _declare(spec: ComponentSpec) -> ComponentSpec:
    BUILTIN_PRIMITIVES.append(spec.name)
    return spec


# =============================================================================
# Passive components
# =============================================================================

def _build_resistor() -> ComponentSpec:
    s = ComponentSpec(
        name="RESISTOR",
        category=ComponentKind.PASSIVE,
        description="Ideal resistor with series inductance and parallel capacitance.",
    )
    s.add_port("a", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param(PARAM_R, 1e3, unit="Ω", min=0.0, max=1e12,
                description="Resistance in ohm")
    s.add_param("r_para", 0.1, unit="Ω", min=0.0, max=1.0,
                description="Series parasitic resistance of leads")
    s.add_param("l_para", 1e-9, unit="H", min=0.0, max=1e-3,
                description="Series parasitic inductance of leads")
    s.add_param("c_para", 1e-12, unit="F", min=0.0, max=1e-6,
                description="Parallel parasitic capacitance")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0,
                description="Operating temperature")
    s.add_param(PARAM_TCR, 0.0, unit="1/K", min=-1e-2, max=1e-2,
                description="Temperature coefficient of resistance")
    s.add_param(PARAM_PMAX, 0.25, unit="W", min=0.0, max=1000.0,
                description="Maximum dissipated power rating")
    s.add_param(PARAM_VMAX, 200.0, unit="V", min=0.0, max=100000.0,
                description="Maximum voltage rating")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


def _build_capacitor() -> ComponentSpec:
    s = ComponentSpec(
        name="CAPACITOR",
        category=ComponentKind.PASSIVE,
        description="Capacitor with equivalent series resistance and inductance (ESR/ESL).",
    )
    s.add_port("a", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param(PARAM_C, 1e-6, unit="F", min=1e-18, max=1.0,
                description="Capacitance in farads")
    s.add_param("esr", 0.05, unit="Ω", min=0.0, max=1e3,
                description="Equivalent series resistance")
    s.add_param("esl", 1e-9, unit="H", min=0.0, max=1e-3,
                description="Equivalent series inductance")
    s.add_param("leak", 1e-9, unit="A", min=0.0, max=1.0,
                description="Leakage current at rated voltage")
    s.add_param(PARAM_VMAX, 50.0, unit="V", min=0.0, max=100000.0,
                description="Maximum voltage rating")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0,
                description="Operating temperature")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


def _build_inductor() -> ComponentSpec:
    s = ComponentSpec(
        name="INDUCTOR",
        category=ComponentKind.PASSIVE,
        description="Inductor with series resistance and parallel capacitance.",
    )
    s.add_port("a", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param(PARAM_L, 1e-3, unit="H", min=1e-12, max=100.0,
                description="Inductance in henries")
    s.add_param("r_dc", 0.5, unit="Ω", min=0.0, max=1e3,
                description="DC winding resistance")
    s.add_param("c_par", 1e-12, unit="F", min=0.0, max=1e-6,
                description="Parasitic parallel capacitance")
    s.add_param("i_sat", 1.0, unit="A", min=1e-6, max=1000.0,
                description="Saturation current")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0,
                description="Operating temperature")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


# We also need a TCR constant since it's not in the central constants module
PARAM_TCR = "tcr"


# =============================================================================
# Semiconductor primitives
# =============================================================================

def _build_diode() -> ComponentSpec:
    s = ComponentSpec(
        name="DIODE",
        category=ComponentKind.SEMICONDUCTOR,
        description="Shockley diode with series resistance.",
    )
    s.add_port("a", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Anode")
    s.add_port("k", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Cathode")
    s.add_param("is", 1e-12, unit="A", min=1e-30, max=1e-3,
                description="Saturation current")
    s.add_param("n", 1.5, unit="", min=1.0, max=3.0,
                description="Emission coefficient")
    s.add_param("rs", 0.1, unit="Ω", min=0.0, max=100.0,
                description="Series resistance")
    s.add_param(PARAM_VBREAK, 100.0, unit="V", min=0.0, max=10000.0,
                description="Reverse breakdown voltage")
    s.add_param("c_j0", 1e-12, unit="F", min=0.0, max=1e-6,
                description="Zero-bias junction capacitance")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0,
                description="Operating temperature")
    s.add_param("tt", 0.0, unit="s", min=0.0, max=1e-3,
                description="Reverse recovery time (0 = off)")
    s.add_param(PARAM_PMAX, 0.5, unit="W", min=0.0, max=100.0,
                description="Maximum power dissipation")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


def _build_nmos() -> ComponentSpec:
    s = ComponentSpec(
        name="NMOS",
        category=ComponentKind.SEMICONDUCTOR,
        description="Shichman-Hodges NMOS transistor (level-1 SPICE-like).",
    )
    s.add_port("d", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Drain")
    s.add_port("g", direction=PortDirection.INPUT, kind=PortKind.ANALOG,
               description="Gate")
    s.add_port("s", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Source")
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               default_net="GND",
               description="Body / bulk")
    s.add_param(PARAM_KN, 50e-6, unit="A/V^2", min=0.0, max=10.0,
                description="Transconductance parameter (Kn')")
    s.add_param("w", 10e-6, unit="m", min=1e-9, max=1.0,
                description="Channel width")
    s.add_param("l", 1e-6, unit="m", min=1e-9, max=1.0,
                description="Channel length")
    s.add_param(PARAM_VTH, 0.7, unit="V", min=-5.0, max=5.0,
                description="Zero-bias threshold voltage")
    s.add_param("lambda_", 0.01, unit="1/V", min=0.0, max=1.0,
                description="Channel-length modulation")
    s.add_param("gamma", 0.0, unit="V^0.5", min=0.0, max=5.0,
                description="Body-effect coefficient")
    s.add_param("phi", 0.6, unit="V", min=0.1, max=2.0,
                description="Surface potential")
    s.add_param("tox", 1e-8, unit="m", min=1e-10, max=1e-5,
                description="Oxide thickness")
    s.add_param("c_gd", 1e-15, unit="F", min=0.0, max=1e-9,
                description="Gate-drain overlap capacitance")
    s.add_param("c_gs", 1e-15, unit="F", min=0.0, max=1e-9,
                description="Gate-source overlap capacitance")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0,
                description="Operating temperature")
    s.add_param(PARAM_PMAX, 0.5, unit="W", min=0.0, max=100.0,
                description="Maximum power dissipation")
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


def _build_pmos() -> ComponentSpec:
    s = ComponentSpec(
        name="PMOS",
        category=ComponentKind.SEMICONDUCTOR,
        description="Shichman-Hodges PMOS transistor (level-1 SPICE-like).",
    )
    s.add_port("d", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("g", direction=PortDirection.INPUT, kind=PortKind.ANALOG)
    s.add_port("s", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               default_net="VDD")
    s.add_param(PARAM_KP, 20e-6, unit="A/V^2", min=0.0, max=10.0,
                description="Transconductance parameter (Kp')")
    s.add_param("w", 10e-6, unit="m", min=1e-9, max=1.0)
    s.add_param("l", 1e-6, unit="m", min=1e-9, max=1.0)
    s.add_param(PARAM_VTH, -0.7, unit="V", min=-5.0, max=5.0,
                description="Zero-bias threshold voltage (negative for PMOS)")
    s.add_param("lambda_", 0.01, unit="1/V", min=0.0, max=1.0)
    s.add_param("gamma", 0.0, unit="V^0.5", min=0.0, max=5.0)
    s.add_param("phi", 0.6, unit="V", min=0.1, max=2.0)
    s.add_param("tox", 1e-8, unit="m", min=1e-10, max=1e-5)
    s.add_param("c_gd", 1e-15, unit="F", min=0.0, max=1e-9)
    s.add_param("c_gs", 1e-15, unit="F", min=0.0, max=1e-9)
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.add_param(PARAM_PMAX, 0.5, unit="W", min=0.0, max=100.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


def _build_bjt_npn() -> ComponentSpec:
    s = ComponentSpec(
        name="BJT_NPN",
        category=ComponentKind.SEMICONDUCTOR,
        description="Ebers-Moll NPN BJT.",
    )
    s.add_port("c", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Collector")
    s.add_port("b", direction=PortDirection.INPUT, kind=PortKind.ANALOG,
               description="Base")
    s.add_port("e", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Emitter")
    s.add_param("is", 1e-12, unit="A", min=1e-30, max=1e-3)
    s.add_param("bf", 100.0, unit="", min=1.0, max=1000.0,
                description="Forward beta")
    s.add_param("br", 1.0, unit="", min=0.1, max=100.0,
                description="Reverse beta")
    s.add_param("vaf", 100.0, unit="V", min=1.0, max=10000.0,
                description="Forward Early voltage")
    s.add_param("rb", 10.0, unit="Ω", min=0.0, max=1e6)
    s.add_param("re", 1.0, unit="Ω", min=0.0, max=1e3)
    s.add_param("rc", 5.0, unit="Ω", min=0.0, max=1e3)
    s.add_param("cje", 1e-12, unit="F", min=0.0, max=1e-6)
    s.add_param("cjc", 1e-12, unit="F", min=0.0, max=1e-6)
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.add_param(PARAM_PMAX, 0.5, unit="W", min=0.0, max=100.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.NOT_MODELED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.APPROXIMATED,
    )
    return _declare(s)


# =============================================================================
# Sources
# =============================================================================

def _build_vsrc_dc() -> ComponentSpec:
    s = ComponentSpec(
        name="VSRC_DC",
        category=ComponentKind.SOURCE,
        description="Ideal DC voltage source with series resistance.",
    )
    s.add_port("p", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Positive terminal")
    s.add_port("n", direction=PortDirection.NONE, kind=PortKind.ANALOG,
               description="Negative terminal")
    s.add_param(PARAM_VDC, 0.0, unit="V", min=-1e6, max=1e6)
    s.add_param("rs", 0.001, unit="Ω", min=0.0, max=100.0,
                description="Series resistance (non-zero to help simulators)")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return _declare(s)


def _build_vsrc_ac() -> ComponentSpec:
    s = ComponentSpec(
        name="VSRC_AC",
        category=ComponentKind.SOURCE,
        description="Sinusoidal AC voltage source.",
    )
    s.add_port("p", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("n", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param("vdc_offset", 0.0, unit="V", min=-1e6, max=1e6)
    s.add_param(PARAM_VAC_AMP, 1.0, unit="V", min=0.0, max=1e6)
    s.add_param(PARAM_VAC_FREQ, 1000.0, unit="Hz", min=0.0, max=1e12)
    s.add_param(PARAM_VAC_PHASE, 0.0, unit="rad", min=-1e6, max=1e6)
    s.add_param("rs", 0.001, unit="Ω", min=0.0, max=100.0)
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return _declare(s)


def _build_vsrc_pulse() -> ComponentSpec:
    s = ComponentSpec(
        name="VSRC_PULSE",
        category=ComponentKind.SOURCE,
        description="Pulse voltage source (V_lo, V_hi, period, width, rise, fall).",
    )
    s.add_port("p", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("n", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param(PARAM_PULSE_VLO, 0.0, unit="V", min=-1e6, max=1e6)
    s.add_param(PARAM_PULSE_VHI, 3.3, unit="V", min=-1e6, max=1e6)
    s.add_param(PARAM_PULSE_PERIOD, 1e-6, unit="s", min=1e-15, max=1e6)
    s.add_param(PARAM_PULSE_WIDTH, 5e-7, unit="s", min=0.0, max=1e6)
    s.add_param(PARAM_PULSE_RISE, 1e-9, unit="s", min=0.0, max=1.0)
    s.add_param(PARAM_PULSE_FALL, 1e-9, unit="s", min=0.0, max=1.0)
    s.add_param("delay", 0.0, unit="s", min=0.0, max=1e6)
    s.add_param("rs", 0.001, unit="Ω", min=0.0, max=100.0)
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return _declare(s)


def _build_isrc_dc() -> ComponentSpec:
    s = ComponentSpec(
        name="ISRC_DC",
        category=ComponentKind.SOURCE,
        description="Ideal DC current source with parallel resistance.",
    )
    s.add_port("p", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("n", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_param(PARAM_IDC, 0.0, unit="A", min=-1e6, max=1e6)
    s.add_param("rp", 1e12, unit="Ω", min=1.0, max=1e15,
                description="Parallel resistance (large but finite)")
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return _declare(s)


# =============================================================================
# Switch
# =============================================================================

def _build_switch() -> ComponentSpec:
    s = ComponentSpec(
        name="SWITCH",
        category=ComponentKind.SWITCH,
        description="SPST switch with configurable on/off resistance.",
    )
    s.add_port("a", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("b", direction=PortDirection.NONE, kind=PortKind.ANALOG)
    s.add_port("ctrl", direction=PortDirection.INPUT, kind=PortKind.DIGITAL,
               description="Control input: 1 = closed, 0 = open")
    s.add_param("ron", 0.01, unit="Ω", min=0.0, max=1e3)
    s.add_param("roff", 1e9, unit="Ω", min=1.0, max=1e15)
    s.add_param("vth", 1.5, unit="V", min=-100.0, max=100.0)
    s.add_param(PARAM_TD, 1e-9, unit="s", min=0.0, max=1.0)
    s.add_param(PARAM_TEMP, 298.15, unit="K", min=0.0, max=1000.0)
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.APPROXIMATED,
        detailed=ModelAccuracy.APPROXIMATED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return _declare(s)


# =============================================================================
# Ground (special source with zero voltage)
# =============================================================================

def _build_ground() -> ComponentSpec:
    s = ComponentSpec(
        name="GROUND",
        category=ComponentKind.SOURCE,
        description="Reference ground (0 V by definition).",
    )
    s.add_port("gnd", direction=PortDirection.NONE, kind=PortKind.GROUND,
               default_net="GND")
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.IDEALIZED,
        detailed=ModelAccuracy.IDEALIZED,
        thermal=ModelAccuracy.IDEALIZED,
    )
    return _declare(s)


# =============================================================================
# Registration
# =============================================================================

def register_primitive_specs(library: Library) -> Library:
    """Register all built-in primitive specs into the given library."""
    specs = [
        _build_resistor(),
        _build_capacitor(),
        _build_inductor(),
        _build_diode(),
        _build_nmos(),
        _build_pmos(),
        _build_bjt_npn(),
        _build_vsrc_dc(),
        _build_vsrc_ac(),
        _build_vsrc_pulse(),
        _build_isrc_dc(),
        _build_switch(),
        _build_ground(),
    ]
    for sp in specs:
        library.register_primitive(sp)
    return library


# Re-export spec factories for tests
def ResistorSpec(): return _build_resistor()
def CapacitorSpec(): return _build_capacitor()
def InductorSpec(): return _build_inductor()
def DiodeSpec(): return _build_diode()
def NmosSpec(): return _build_nmos()
def PmosSpec(): return _build_pmos()
def BjtNpnSpec(): return _build_bjt_npn()
def VSourceDcSpec(): return _build_vsrc_dc()
def VSourceAcSpec(): return _build_vsrc_ac()
def VSourcePulseSpec(): return _build_vsrc_pulse()
def ISourceDcSpec(): return _build_isrc_dc()
def SwitchSpec(): return _build_switch()
def GroundSpec(): return _build_ground()
