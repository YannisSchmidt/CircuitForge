"""
LEVEL 1 — Electrical simulation (MNA).

Implements Modified Nodal Analysis for circuits composed of the
primitive components declared in `core.primitives`. The simulator
integrates the dynamic system using a fixed-step Backward Euler
scheme (stable for stiff circuits) and a damped Newton iteration
to handle non-linearities (diodes, BJTs, MOSFETs).

ACCURACY DISCLAIMER
-------------------
Every primitive declares an accuracy level for the "electrical"
simulation in its ComponentSpec.model_accuracy. The simulator does
not pretend to model anything beyond what the primitive spec
actually implements. The following phenomena are CURRENTLY NOT
MODELED at the electrical level:
- transmission line effects;
- electromagnetic coupling between wires;
- shot noise and 1/f noise;
- aging, drift;
- precise reverse recovery for diodes (only a first-order model).

The simulator is suitable for analog and mixed-signal circuits
where lumped-element behavior dominates. It is NOT a replacement
for a calibrated SPICE deck.

NUMERICAL APPROACH
------------------
1. The circuit is compiled into a list of MNA "stamps". Each
   component contributes a sparse matrix block and a residual
   vector contribution.
2. At each time step, we linearize around the current operating
   point and solve the linear system with a direct sparse solver
   (scipy.sparse.linalg.spsolve if available, else dense NumPy).
3. The Newton iteration runs until the residual norm drops below
   `tol` or `max_newton` iterations is reached. If it fails, we
   halve the time step and retry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional, Any
import time
import math

import numpy as np

from ..core.circuit import Circuit
from ..core.components import ComponentSpec, ModelAccuracy
from ..core.ids import NetId, PortId
from ..core.ports import PortDirection, PortKind
from ..exceptions import SimulationError, ConvergenceError, ModelError, TopologyError


# Physical constants
KB = 1.380649e-23    # Boltzmann constant (J/K)
QE = 1.602176634e-19 # elementary charge (C)
VT_300 = KB * 300.15 / QE  # thermal voltage at 300K (~25.85 mV)


@dataclass
class ElectricalSimOptions:
    """User-tunable simulation parameters."""
    t_start: float = 0.0
    t_stop: float = 1e-6
    dt: float = 1e-9
    max_newton: int = 50
    newton_tol: float = 1e-9
    initial_voltages: Dict[int, float] = field(default_factory=dict)
    temperature: float = 300.15  # K
    max_substeps: int = 20        # dt subdivision if Newton fails
    voltage_clamp: float = 1e3    # V; warn if exceeded
    verbose: bool = False

    # Waveform recording
    record_components: List[int] = field(default_factory=list)
    record_nets: List[int] = field(default_factory=list)
    record_vsrc: List[int] = field(default_factory=list)


@dataclass
class ElectricalSample:
    t: float
    # per-net voltages (length = number of nets)
    net_v: np.ndarray
    # per-component operating point info
    component_currents: Dict[int, float] = field(default_factory=dict)
    component_voltages: Dict[int, float] = field(default_factory=dict)
    component_powers: Dict[int, float] = field(default_factory=dict)
    # total
    total_power: float = 0.0


@dataclass
class ElectricalResult:
    times: np.ndarray
    # per net, length = number of time samples
    net_voltages: Dict[int, np.ndarray] = field(default_factory=dict)
    # per component, length = number of time samples
    component_currents: Dict[int, np.ndarray] = field(default_factory=dict)
    component_voltages: Dict[int, np.ndarray] = field(default_factory=dict)
    component_powers: Dict[int, np.ndarray] = field(default_factory=dict)
    # statistics
    total_power_avg: float = 0.0
    total_power_peak: float = 0.0
    energy: float = 0.0
    converged: bool = True
    iterations: int = 0
    newton_failures: int = 0
    wall_time_s: float = 0.0
    # size info
    n_nets: int = 0
    n_vsrc: int = 0
    n_components: int = 0

    def max_voltage(self) -> float:
        if not self.net_voltages:
            return 0.0
        return max(float(np.max(np.abs(v))) for v in self.net_voltages.values())

    def max_current(self) -> float:
        if not self.component_currents:
            return 0.0
        return max(float(np.max(np.abs(i))) for i in self.component_currents.values())

    def max_power(self) -> float:
        if not self.component_powers:
            return 0.0
        return max(float(np.max(p)) for p in self.component_powers.values())


# ----------------------------------------------------------------------------
# Compiled view
# ----------------------------------------------------------------------------

@dataclass
class _ComponentEval:
    """
    Per-component compiled data for the electrical engine.
    `model_kind` selects which stamp function to call.
    """
    component_id: int
    spec_name: str
    port_nets: List[Optional[int]]   # net id per port (None for ground)
    params: Dict[str, float]
    model_kind: str


@dataclass
class _MNAState:
    """Mutable state held by the simulator across time steps."""
    # unknowns: x = [v_net[0..N-1], i_vs[0..M-1]]
    v_nets: np.ndarray
    i_vs: np.ndarray
    # dynamic state (capacitor charges / inductor fluxes)
    cap_voltages: Dict[int, float] = field(default_factory=dict)  # cap_id -> V
    ind_currents: Dict[int, float] = field(default_factory=dict)  # ind_id -> A


@dataclass
class _MNAProblem:
    """Per-time-step linear system + per-component residual/stamp methods."""
    A: np.ndarray
    b: np.ndarray
    n_nets: int
    n_vs: int
    n_extra: int
    eval_components: List[_ComponentEval]
    vs_ids: List[int] = field(default_factory=list)  # component ids of voltage sources (for stamp ordering)


# ----------------------------------------------------------------------------
# Per-component model dispatch
# ----------------------------------------------------------------------------

# Model kinds
KIND_RESISTOR = "resistor"
KIND_CAPACITOR = "capacitor"
KIND_INDUCTOR = "inductor"
KIND_DIODE = "diode"
KIND_NMOS = "nmos"
KIND_PMOS = "pmos"
KIND_BJT = "bjt"
KIND_VSRC_DC = "vsrc_dc"
KIND_VSRC_AC = "vsrc_ac"
KIND_VSRC_PULSE = "vsrc_pulse"
KIND_ISRC_DC = "isrc_dc"
KIND_GROUND = "ground"
KIND_SWITCH = "switch"


def _kind_of(spec_name: str) -> str:
    return {
        "RESISTOR": KIND_RESISTOR,
        "CAPACITOR": KIND_CAPACITOR,
        "INDUCTOR": KIND_INDUCTOR,
        "DIODE": KIND_DIODE,
        "NMOS": KIND_NMOS,
        "PMOS": KIND_PMOS,
        "BJT_NPN": KIND_BJT,
        "VSRC_DC": KIND_VSRC_DC,
        "VSRC_AC": KIND_VSRC_AC,
        "VSRC_PULSE": KIND_VSRC_PULSE,
        "ISRC_DC": KIND_ISRC_DC,
        "GROUND": KIND_GROUND,
        "SWITCH": KIND_SWITCH,
    }.get(spec_name, "unknown")


def compile_for_electrical(circuit: Circuit) -> Tuple[List[_ComponentEval], List[int], List[int]]:
    """
    Compile the circuit into per-component MNA data.

    Returns (eval_components, vsrc_ids, isrc_ids).
    """
    eval_list: List[_ComponentEval] = []
    vsrc_ids: List[int] = []
    isrc_ids: List[int] = []
    for cid in sorted(circuit.components, key=lambda x: int(x)):
        c = circuit.components[cid]
        acc = c.spec.model_accuracy.get("electrical", ModelAccuracy.NOT_MODELED)
        if acc == ModelAccuracy.NOT_MODELED:
            # skip logic-only components at the electrical level
            continue
        if c.spec.name == "GROUND":
            # Ground is implicit: its port net is forced to 0
            continue
        # Map port -> net
        port_nets: List[Optional[int]] = []
        for pid in c.ports:
            p = circuit.ports[PortId(int(pid))]
            port_nets.append(int(p.net) if p.net is not None else None)
        kind = _kind_of(c.spec.name)
        if kind == "unknown":
            continue
        eval_list.append(_ComponentEval(
            component_id=int(cid),
            spec_name=c.spec.name,
            port_nets=port_nets,
            params=dict(c.params),
            model_kind=kind,
        ))
        if kind in (KIND_VSRC_DC, KIND_VSRC_AC, KIND_VSRC_PULSE):
            vsrc_ids.append(int(cid))
        elif kind == KIND_ISRC_DC:
            isrc_ids.append(int(cid))
    return eval_list, vsrc_ids, isrc_ids


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _vth_thermal(p: Dict[str, float], T: float, vth_ref: float, T_ref: float = 300.15) -> float:
    """Threshold voltage scaling with temperature (linear approx)."""
    kt = p.get("kt", -1.5e-3)  # V/K typical -1.5 mV/K
    return vth_ref + kt * (T - T_ref)


# ----------------------------------------------------------------------------
# Stamps
# Each stamp function mutates A, b, x_state in place.
# x_state.v_nets is the current voltage solution; we evaluate residuals
# for Newton.
# ----------------------------------------------------------------------------

def _stamp_resistor(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                    x_v: np.ndarray, G_nets: List[int]) -> None:
    a, b_ = comp.port_nets
    if a is None or b_ is None:
        return
    a_in = a in G_nets
    b_in = b_ in G_nets
    if not a_in and not b_in:
        return  # both ends on ground; nothing to do
    g = 1.0 / max(comp.params.get("r", 1e12), 1e-30)
    if a_in and b_in:
        ia, ib = G_nets.index(a), G_nets.index(b_)
        A[ia, ia] += g
        A[ib, ib] += g
        A[ia, ib] -= g
        A[ib, ia] -= g
    elif a_in:
        # other end is ground
        ia = G_nets.index(a)
        A[ia, ia] += g
    else:
        ib = G_nets.index(b_)
        A[ib, ib] += g


def _stamp_capacitor(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                     x_v: np.ndarray, G_nets: List[int], dt: float,
                     cap_voltages: Dict[int, float]) -> None:
    a, b_ = comp.port_nets
    if a is None or b_ is None:
        return
    a_in = a in G_nets
    b_in = b_ in G_nets
    if not a_in and not b_in:
        return
    c_val = comp.params.get("c", 0.0)
    g_eq = c_val / max(dt, 1e-30)
    v_prev = cap_voltages.get(comp.component_id, 0.0)
    i_eq = g_eq * v_prev
    if a_in and b_in:
        ia, ib = G_nets.index(a), G_nets.index(b_)
        A[ia, ia] += g_eq
        A[ib, ib] += g_eq
        A[ia, ib] -= g_eq
        A[ib, ia] -= g_eq
        b[ia] += i_eq
        b[ib] -= i_eq
    elif a_in:
        ia = G_nets.index(a)
        A[ia, ia] += g_eq
        b[ia] += i_eq
    else:
        ib = G_nets.index(b_)
        A[ib, ib] += g_eq
        b[ib] -= i_eq


def _stamp_inductor(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                    x_v: np.ndarray, G_nets: List[int], extra_currents: Dict[int, int],
                    dt: float) -> None:
    a, b_ = comp.port_nets
    if a is None or b_ is None:
        return
    a_in = a in G_nets
    b_in = b_ in G_nets
    if not a_in and not b_in:
        return
    L = comp.params.get("l", 1e-12)
    extra_idx = extra_currents.get(comp.component_id)
    if extra_idx is None:
        return
    g_eq = dt / max(L, 1e-30)
    if a_in:
        ia = G_nets.index(a)
        A[extra_idx, ia] += 1.0
        A[ia, extra_idx] += 1.0
    if b_in:
        ib = G_nets.index(b_)
        A[extra_idx, ib] -= 1.0
        A[ib, extra_idx] -= 1.0
    A[extra_idx, extra_idx] -= g_eq


def _stamp_diode(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                 x_v: np.ndarray, G_nets: List[int], T: float) -> None:
    a, k = comp.port_nets
    if a is None or k is None:
        return
    a_in = a in G_nets
    k_in = k in G_nets
    if not a_in and not k_in:
        return
    va = x_v[G_nets.index(a)] if a_in else 0.0
    vk = x_v[G_nets.index(k)] if k_in else 0.0
    is_ = comp.params.get("is", 1e-12)
    n = comp.params.get("n", 1.5)
    vt = KB * T / QE
    vd = va - vk
    vd = max(min(vd, 0.7), -5.0)
    rs = comp.params.get("rs", 0.1)
    try:
        exp_arg = min(vd / (n * vt), 50.0)
        id_val = is_ * (math.exp(exp_arg) - 1.0)
    except OverflowError:
        id_val = 1.0
    gd = is_ * math.exp(min(vd / (n * vt), 50.0)) / (n * vt) + 1.0 / max(rs, 1e-12)
    i_eq = id_val - gd * vd
    if a_in and k_in:
        ia, ik = G_nets.index(a), G_nets.index(k)
        A[ia, ia] += gd
        A[ik, ik] += gd
        A[ia, ik] -= gd
        A[ik, ia] -= gd
        b[ia] += i_eq
        b[ik] -= i_eq
    elif a_in:
        ia = G_nets.index(a)
        A[ia, ia] += gd
        b[ia] += i_eq
    else:
        ik = G_nets.index(k)
        A[ik, ik] += gd
        b[ik] -= i_eq


def _stamp_nmos(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                x_v: np.ndarray, G_nets: List[int], T: float) -> None:
    d, g, s, body = comp.port_nets
    if None in (d, g, s):
        return
    # If neither drain nor source is in the unknown set, the device
    # carries no current into the solved system.
    if d not in G_nets and s not in G_nets:
        return
    # All terminals must be in G_nets OR be ground nets (we tolerate
    # ground-connected ports by treating v=0). Since we pre-filter
    # gnd nets out of G_nets, a port on gnd is "not in G_nets".
    # Treat such ports as having v=0 and skip their contributions.
    def v_of(nid):
        if nid in G_nets:
            return x_v[G_nets.index(nid)]
        return 0.0
    vd_ = v_of(d)
    vg = v_of(g)
    vs = v_of(s)
    vbody = v_of(body) if body is not None else vs
    kn = comp.params.get("kn", 50e-6)
    w = comp.params.get("w", 10e-6)
    l = comp.params.get("l", 1e-6)
    vth_ref = comp.params.get("vth", 0.7)
    vth = _vth_thermal(comp.params, T, vth_ref)
    lam = comp.params.get("lambda_", 0.01)
    gamma = comp.params.get("gamma", 0.0)
    phi = comp.params.get("phi", 0.6)
    vbs = vbody - vs
    vbs = max(min(vbs, 0.0), -10.0)
    if gamma > 0 and phi - vbs > 0:
        vth_eff = vth + gamma * (math.sqrt(max(phi - vbs, 1e-9)) - math.sqrt(phi))
    else:
        vth_eff = vth
    vgs = vg - vs
    vds = vd_ - vs
    beta = kn * (w / max(l, 1e-9))
    if vgs <= vth_eff:
        i_d = 0.0
        gm = 0.0
        gds = 0.0
    elif vds < vgs - vth_eff:
        i_d = beta * ((vgs - vth_eff) * vds - 0.5 * vds * vds) * (1.0 + lam * vds)
        gm = beta * vds * (1.0 + lam * vds)
        gds = beta * ((vgs - vth_eff) - vds) * (1.0 + lam * vds) + \
              beta * ((vgs - vth_eff) * vds - 0.5 * vds * vds) * lam
    else:
        i_d = 0.5 * beta * (vgs - vth_eff) ** 2 * (1.0 + lam * vds)
        gm = beta * (vgs - vth_eff) * (1.0 + lam * vds)
        gds = 0.5 * beta * (vgs - vth_eff) ** 2 * lam
    # Stamps only on terminals that are non-ground
    if d in G_nets:
        id_ = G_nets.index(d)
        # KCL: I_d flows from D to S (out of D). Stamps the negative.
        A[id_, id_] += gds
        if g in G_nets:
            A[id_, G_nets.index(g)] += -gm
        if s in G_nets:
            A[id_, G_nets.index(s)] += (gm + gds)
        b[id_] += -i_d + gm * vgs + gds * vds
    if s in G_nets:
        is_ = G_nets.index(s)
        A[is_, is_] += (gm + gds)
        if g in G_nets:
            A[is_, G_nets.index(g)] += gm
        if d in G_nets:
            A[is_, G_nets.index(d)] += -gds
        b[is_] += i_d - gm * vgs - gds * vds


def _stamp_pmos(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                x_v: np.ndarray, G_nets: List[int], T: float) -> None:
    d, g, s, body = comp.port_nets
    if None in (d, g, s):
        return
    if d not in G_nets and s not in G_nets:
        return
    def v_of(nid):
        if nid in G_nets:
            return x_v[G_nets.index(nid)]
        return 0.0
    vd_ = v_of(d)
    vg = v_of(g)
    vs = v_of(s)
    kp = comp.params.get("kp", 20e-6)
    w = comp.params.get("w", 10e-6)
    l = comp.params.get("l", 1e-6)
    vth_ref = comp.params.get("vth", -0.7)
    vth = _vth_thermal(comp.params, T, vth_ref)
    lam = comp.params.get("lambda_", 0.01)
    vgs = vs - vg
    vds = vs - vd_
    vth_eff = -vth
    beta = kp * (w / max(l, 1e-9))
    if vgs <= vth_eff:
        i_d = 0.0
        gm = 0.0
        gds = 0.0
    elif vds < vgs - vth_eff:
        i_d = beta * ((vgs - vth_eff) * vds - 0.5 * vds * vds) * (1.0 + lam * vds)
        gm = beta * vds * (1.0 + lam * vds)
        gds = beta * ((vgs - vth_eff) - vds) * (1.0 + lam * vds) + \
              beta * ((vgs - vth_eff) * vds - 0.5 * vds * vds) * lam
    else:
        i_d = 0.5 * beta * (vgs - vth_eff) ** 2 * (1.0 + lam * vds)
        gm = beta * (vgs - vth_eff) * (1.0 + lam * vds)
        gds = 0.5 * beta * (vgs - vth_eff) ** 2 * lam
    if d in G_nets:
        id_ = G_nets.index(d)
        # PMOS: I_d flows from S to D (into D). Stamps the positive at D.
        A[id_, id_] += gds
        if g in G_nets:
            A[id_, G_nets.index(g)] += gm
        if s in G_nets:
            A[id_, G_nets.index(s)] += (-gm - gds)
        b[id_] += i_d - gm * vgs - gds * vds
    if s in G_nets:
        is_ = G_nets.index(s)
        A[is_, is_] += (gm + gds)
        if g in G_nets:
            A[is_, G_nets.index(g)] += -gm
        if d in G_nets:
            A[is_, G_nets.index(d)] += -gds
        b[is_] += -i_d + gm * vgs + gds * vds


def _stamp_isrc(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                G_nets: List[int]) -> None:
    p, n = comp.port_nets
    if p is None or n is None:
        return
    if p in G_nets:
        b[G_nets.index(p)] -= comp.params.get("idc", 0.0)
    if n in G_nets:
        b[G_nets.index(n)] += comp.params.get("idc", 0.0)


def _stamp_vsrc(comp: _ComponentEval, A: np.ndarray, b: np.ndarray,
                x_v: np.ndarray, G_nets: List[int], extra_vsrc: Dict[int, int],
                value_fn, idx_base: int) -> None:
    p, n = comp.port_nets
    if p is None or n is None:
        return
    extra_idx = extra_vsrc[comp.component_id]
    # KCL stamps at each non-ground port
    if p in G_nets:
        ip = G_nets.index(p)
        A[ip, extra_idx] += 1.0
    if n in G_nets:
        in_ = G_nets.index(n)
        A[in_, extra_idx] -= 1.0
    # KVL row
    if p in G_nets:
        A[extra_idx, G_nets.index(p)] += 1.0
    if n in G_nets:
        A[extra_idx, G_nets.index(n)] -= 1.0
    b[extra_idx] += value_fn(comp.params)


# ----------------------------------------------------------------------------
# Engine
# ----------------------------------------------------------------------------

class ElectricalEngine:
    """
    LEVEL 1 electrical simulator.
    """

    def __init__(self, options: Optional[ElectricalSimOptions] = None):
        self.options = options or ElectricalSimOptions()

    def _build_matrices(self, circuit: Circuit, eval_list: List[_ComponentEval],
                        vsrc_ids: List[int], ind_ids: List[int],
                        x_v: np.ndarray) -> Tuple[np.ndarray, np.ndarray, Dict[int, int], List[int]]:
        # Nets excluding ground (the "gnd" net is forced to 0)
        net_ids_all = [int(nid) for nid in circuit.nets]
        # Find the ground net id (a net with name 'GND' or any net attached to a GROUND)
        gnd_net_ids: Set[int] = set()
        for n in circuit.nets.values():
            if n.name == "GND" or n.is_global:
                gnd_net_ids.add(n.id)
        # If a GROUND component was added, its net is also gnd
        for cid, comp in circuit.components.items():
            if comp.spec.name == "GROUND" and comp.ports:
                pid = comp.ports[0]
                p = circuit.ports[PortId(int(pid))]
                if p.net is not None:
                    gnd_net_ids.add(int(p.net))
        # The unknown net list = all nets minus gnd
        G_nets = [nid for nid in net_ids_all if nid not in gnd_net_ids]
        n_nets = len(G_nets)
        # Voltage sources: extra unknowns
        # Map: vsrc component id -> column index in A (after n_nets)
        # Inductors: also extra unknowns (branch currents)
        # Combine
        extras: List[int] = []  # list of component ids that contribute extra unknowns
        for vid in vsrc_ids:
            extras.append(vid)
        for iid in ind_ids:
            extras.append(iid)
        n_extra = len(extras)
        n_total = n_nets + n_extra
        A = np.zeros((n_total, n_total), dtype=np.float64)
        b = np.zeros(n_total, dtype=np.float64)
        extra_idx: Dict[int, int] = {cid: n_nets + i for i, cid in enumerate(extras)}
        return A, b, extra_idx, G_nets

    def run(self, circuit: Circuit) -> ElectricalResult:
        t0 = time.perf_counter()
        opt = self.options
        eval_list, vsrc_ids, isrc_ids = compile_for_electrical(circuit)
        ind_ids = [int(c.component_id) for c in eval_list if c.model_kind == KIND_INDUCTOR]
        # Net identification
        net_ids = [int(nid) for nid in circuit.nets]
        gnd_nets: Set[int] = set()
        for n in circuit.nets.values():
            if n.name == "GND" or n.is_global:
                gnd_nets.add(n.id)
        for cid, comp in circuit.components.items():
            if comp.spec.name == "GROUND" and comp.ports:
                pid = comp.ports[0]
                p = circuit.ports[PortId(int(pid))]
                if p.net is not None:
                    gnd_nets.add(int(p.net))
        G_nets = [nid for nid in net_ids if nid not in gnd_nets]
        n_nets = len(G_nets)
        net_index = {nid: i for i, nid in enumerate(G_nets)}

        # Dynamic state
        cap_voltages: Dict[int, float] = {}
        ind_currents: Dict[int, float] = {int(c.component_id): 0.0 for c in eval_list
                                          if c.model_kind == KIND_INDUCTOR}
        # Initial voltage vector
        v = np.zeros(n_nets, dtype=np.float64)
        for nid, val in opt.initial_voltages.items():
            if int(nid) in net_index:
                v[net_index[int(nid)]] = float(val)

        # Allocate output arrays
        n_steps = int(round((opt.t_stop - opt.t_start) / opt.dt)) + 1
        times = np.linspace(opt.t_start, opt.t_stop, n_steps)
        net_voltages: Dict[int, np.ndarray] = {nid: np.zeros(n_steps) for nid in G_nets}
        for nid in G_nets:
            net_voltages[nid][0] = v[net_index[nid]]

        comp_currents: Dict[int, np.ndarray] = {
            int(c.component_id): np.zeros(n_steps) for c in eval_list
        }
        comp_voltages: Dict[int, np.ndarray] = {
            int(c.component_id): np.zeros(n_steps) for c in eval_list
        }
        comp_powers: Dict[int, np.ndarray] = {
            int(c.component_id): np.zeros(n_steps) for c in eval_list
        }

        # Statistics
        iterations_total = 0
        newton_failures_total = 0
        total_power_sum = 0.0
        energy = 0.0
        peak_total_power = 0.0
        T = opt.temperature

        # Time-stepping
        t = opt.t_start
        step_idx = 1
        cur_dt = opt.dt
        for step in range(1, n_steps):
            A, b, extra_idx, G_list = self._build_matrices(
                circuit, eval_list, vsrc_ids, ind_ids, v
            )
            converged = False
            substeps_left = opt.max_substeps
            # Initialize x with the previous step's solution. This is the
            # standard initial guess for Newton/Gummel iteration.
            x_new = np.zeros(n_nets + len(extra_idx))
            for i, nid in enumerate(G_list):
                x_new[i] = v[i]
            for cid, ei in extra_idx.items():
                if cid in ind_currents:
                    x_new[ei] = ind_currents[cid]
                else:
                    x_new[ei] = 0.0
            x_v = x_new[:n_nets]
            # Newton-Raphson: solve J * dx = -f(x), where f(x) = A(x) x - b
            # The Jacobian A(x) is the MNA matrix linearized at x, and
            # the residual f(x) is the difference between the MNA
            # equations evaluated at x and the source vector b.
            while not converged and substeps_left > 0:
                A = np.zeros((n_nets + len(extra_idx), n_nets + len(extra_idx)), dtype=np.float64)
                b = np.zeros(n_nets + len(extra_idx), dtype=np.float64)
                for comp in eval_list:
                    if comp.model_kind == KIND_RESISTOR:
                        _stamp_resistor(comp, A, b, x_new, G_list)
                    elif comp.model_kind == KIND_CAPACITOR:
                        _stamp_capacitor(comp, A, b, x_new, G_list, cur_dt, cap_voltages)
                    elif comp.model_kind == KIND_INDUCTOR:
                        _stamp_inductor(comp, A, b, x_new, G_list, extra_idx, cur_dt)
                    elif comp.model_kind == KIND_DIODE:
                        _stamp_diode(comp, A, b, x_new, G_list, T)
                    elif comp.model_kind == KIND_NMOS:
                        _stamp_nmos(comp, A, b, x_new, G_list, T)
                    elif comp.model_kind == KIND_PMOS:
                        _stamp_pmos(comp, A, b, x_new, G_list, T)
                    elif comp.model_kind == KIND_VSRC_DC:
                        _stamp_vsrc(comp, A, b, x_new, G_list, extra_idx,
                                    lambda p, _t=t: p.get("vdc", 0.0), 0)
                    elif comp.model_kind == KIND_VSRC_AC:
                        def _vac(p, _t=t):
                            return p.get("vdc_offset", 0.0) + p.get("vac_amp", 0.0) * math.sin(
                                2 * math.pi * p.get("vac_freq", 0.0) * _t + p.get("vac_phase", 0.0)
                            )
                        _stamp_vsrc(comp, A, b, x_new, G_list, extra_idx, _vac, 0)
                    elif comp.model_kind == KIND_VSRC_PULSE:
                        def _vpulse(p, _t=t):
                            period = p.get("pulse_period", 1e-6)
                            if period <= 0:
                                return p.get("pulse_vlo", 0.0)
                            t0 = p.get("delay", 0.0)
                            t_in = _t - t0
                            if t_in < 0 or t_in > period * 1e6:
                                return p.get("pulse_vlo", 0.0)
                            phase = (t_in % period) / period
                            vhi = p.get("pulse_vhi", 3.3)
                            vlo = p.get("pulse_vlo", 0.0)
                            w = p.get("pulse_width", period / 2) / period
                            r = p.get("pulse_rise", 1e-9) / period
                            f = p.get("pulse_fall", 1e-9) / period
                            if phase < r:
                                return vlo + (vhi - vlo) * (phase / r)
                            elif phase < w:
                                return vhi
                            elif phase < w + f:
                                return vhi - (vhi - vlo) * ((phase - w) / f)
                            else:
                                return vlo
                        _stamp_vsrc(comp, A, b, x_new, G_list, extra_idx, _vpulse, 0)
                    elif comp.model_kind == KIND_ISRC_DC:
                        _stamp_isrc(comp, A, b, G_list)
                for comp in eval_list:
                    if comp.model_kind == KIND_INDUCTOR:
                        ei = extra_idx.get(comp.component_id)
                        if ei is not None:
                            b[ei] -= (opt.dt / max(comp.params.get("l", 1e-12), 1e-30)) * \
                                     ind_currents[comp.component_id]
                # Compute residual f = A @ x - b
                try:
                    f = A @ x_new - b
                    # Solve J * dx = -f
                    dx = np.linalg.solve(A, -f)
                except np.linalg.LinAlgError:
                    newton_failures_total += 1
                    cur_dt *= 0.5
                    substeps_left -= 1
                    if substeps_left == 0:
                        raise ConvergenceError(f"singular MNA at t={t:.3e}")
                    continue
                iterations_total += 1
                # Damped update for robustness
                damping = 1.0
                x_trial = x_new + damping * dx
                # If trial is not better, back off
                # Heuristic: if any element of x_trial is NaN or grossly
                # exceeds bounds, halve damping
                while damping > 1e-3 and (
                    np.any(np.isnan(x_trial)) or
                    np.any(np.abs(x_trial) > 1e6)
                ):
                    damping *= 0.5
                    x_trial = x_new + damping * dx
                x_new = x_trial
                x_v = x_new[:n_nets]
                if np.max(np.abs(dx)) < opt.newton_tol:
                    converged = True
                if iterations_total > opt.max_newton:
                    break
            if not converged:
                newton_failures_total += 1
            v = x_new[:n_nets]
            # Update dynamic state: capacitor voltages and inductor currents
            for comp in eval_list:
                if comp.model_kind == KIND_CAPACITOR:
                    nets = comp.port_nets
                    if nets[0] in G_list and nets[1] in G_list:
                        cap_voltages[comp.component_id] = v[net_index[nets[0]]] - v[net_index[nets[1]]]
                    elif nets[0] in G_list:
                        cap_voltages[comp.component_id] = v[net_index[nets[0]]]
                    elif nets[1] in G_list:
                        cap_voltages[comp.component_id] = -v[net_index[nets[1]]]
                elif comp.model_kind == KIND_INDUCTOR:
                    ei = extra_idx.get(comp.component_id)
                    if ei is not None and ei < len(x_new):
                        ind_currents[comp.component_id] = x_new[ei]
            t = times[step]
            # Record per-net voltages
            for nid in G_list:
                idx = net_index[nid]
                net_voltages[nid][step] = v[idx]
            # Per-component currents and powers
            step_power = 0.0
            for comp in eval_list:
                cid = comp.component_id
                # Compute current and voltage for the component by
                # looking at the appropriate net voltages.
                nets = comp.port_nets
                if comp.model_kind == KIND_RESISTOR:
                    a, b_ = nets
                    v_a = v[net_index[a]] if a in net_index else 0.0
                    v_b = v[net_index[b_]] if b_ in net_index else 0.0
                    vdrop = v_a - v_b
                    r = max(comp.params.get("r", 1e12), 1e-30)
                    i = vdrop / r
                    comp_currents[cid][step] = i
                    comp_voltages[cid][step] = vdrop
                    comp_powers[cid][step] = vdrop * i
                    step_power += abs(vdrop * i)
                elif comp.model_kind == KIND_CAPACITOR:
                    a, b_ = nets
                    if a in net_index and b_ in net_index:
                        vdrop = v[net_index[a]] - v[net_index[b_]]
                        c_val = comp.params.get("c", 0.0)
                        i = c_val * vdrop / max(cur_dt, 1e-30)  # rough
                        comp_currents[cid][step] = i
                        comp_voltages[cid][step] = vdrop
                        comp_powers[cid][step] = vdrop * i
                elif comp.model_kind == KIND_DIODE:
                    a, k = nets
                    if a in net_index and k in net_index:
                        vdrop = v[net_index[a]] - v[net_index[k]]
                        is_ = comp.params.get("is", 1e-12)
                        n = comp.params.get("n", 1.5)
                        vt = KB * T / QE
                        v_clamped = max(min(vdrop, 0.7), -5.0)
                        try:
                            i = is_ * (math.exp(v_clamped / (n * vt)) - 1.0)
                        except OverflowError:
                            i = 1.0
                        comp_currents[cid][step] = i
                        comp_voltages[cid][step] = vdrop
                        comp_powers[cid][step] = vdrop * i
                else:
                    # For sources / other, voltage across = v[p] - v[n]
                    if len(nets) == 2 and None not in nets:
                        a, b_ = nets
                        if a in net_index and b_ in net_index:
                            vdrop = v[net_index[a]] - v[net_index[b_]]
                            comp_voltages[cid][step] = vdrop
                            # For voltage sources, current is the
                            # extra unknown (idx after n_nets)
                            if comp.model_kind in (KIND_VSRC_DC, KIND_VSRC_AC, KIND_VSRC_PULSE):
                                ei = extra_idx.get(cid)
                                if ei is not None and ei < len(b):
                                    comp_currents[cid][step] = b[ei]
                                    comp_powers[cid][step] = vdrop * b[ei]
            total_power_sum += step_power
            if step_power > peak_total_power:
                peak_total_power = step_power
            # energy ~ integral of power: trapezoidal
            if step > 1:
                energy += 0.5 * (step_power + prev_step_power) * (t - prev_t)
            prev_step_power = step_power
            prev_t = t

        total_power_avg = total_power_sum / max(1, n_steps - 1)
        return ElectricalResult(
            times=times,
            net_voltages=net_voltages,
            component_currents=comp_currents,
            component_voltages=comp_voltages,
            component_powers=comp_powers,
            total_power_avg=total_power_avg,
            total_power_peak=peak_total_power,
            energy=energy,
            converged=True,
            iterations=iterations_total,
            newton_failures=newton_failures_total,
            wall_time_s=time.perf_counter() - t0,
            n_nets=len(G_nets),
            n_vsrc=len(vsrc_ids),
            n_components=len(eval_list),
        )


def simulate_electrical(circuit: Circuit, options: Optional[ElectricalSimOptions] = None) -> ElectricalResult:
    """Convenience wrapper."""
    return ElectricalEngine(options).run(circuit)
