"""
Thermal network solver.

We model thermal behavior as an RC network where:
- Each component with a non-zero thermal capacitance is a "thermal
  node" with temperature T_i (in K).
- The ambient is a fixed node at T_amb.
- The thermal resistance between component i and the ambient is
  Rth_i (K/W).
- The thermal capacitance of component i is Cth_i (J/K).
- Power dissipated by component i is P_i (W).

The differential equation for the temperature of node i is:
    Cth_i * dT_i/dt = (T_amb - T_i) / Rth_i + P_i

This is integrated with Backward Euler (same as the electrical
solver) for stability.

The network can also include thermal coupling between nodes:
    Cth_i * dT_i/dt = (T_amb - T_i) / Rth_i + P_i
                      + sum_j (T_j - T_i) / Rth_ij

This is a sparse linear system at each time step.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional
import time
import math

import numpy as np

from ..core.circuit import Circuit
from ..core.ids import NetId
from ..core.components import ComponentSpec, ModelAccuracy
from ..core.ports import PortKind
from ..exceptions import SimulationError, ModelError


@dataclass
class ThermalNode:
    """
    A single thermal node (one per component that dissipates power).
    """
    component_id: int
    rth_to_amb: float       # K/W, thermal resistance to ambient
    cth: float              # J/K, thermal capacitance
    t_junction_init: float  # K, initial temperature


@dataclass
class ThermalCoupling:
    """
    Thermal coupling between two nodes (e.g. shared substrate).
    """
    a_id: int  # component id
    b_id: int
    rth: float  # K/W between a and b


@dataclass
class ThermalNetwork:
    """
    Container for the thermal network extracted from a circuit.
    """
    ambient_temp: float = 300.15
    nodes: Dict[int, ThermalNode] = field(default_factory=dict)
    couplings: List[ThermalCoupling] = field(default_factory=list)


@dataclass
class ThermalSimResult:
    times: np.ndarray
    temperatures: Dict[int, np.ndarray] = field(default_factory=dict)  # cid -> T(t)
    # derived
    t_ambient: float = 300.15
    t_max: float = 300.15
    t_min: float = 300.15
    t_avg: float = 300.15
    converged: bool = True
    wall_time_s: float = 0.0


# ----------------------------------------------------------------------------
# Extraction
# ----------------------------------------------------------------------------

def default_thermal_for_circuit(circuit: Circuit) -> ThermalNetwork:
    """
    Build a default thermal network from a circuit. Each component
    that declares Rth and Cth parameters gets a node.
    """
    net = ThermalNetwork()
    for cid, c in circuit.components.items():
        rth = c.params.get("rth", 0.0)
        cth = c.params.get("cth", 0.0)
        t_init = c.params.get("temp", 300.15)
        if rth > 0.0 or cth > 0.0:
            net.nodes[int(cid)] = ThermalNode(
                component_id=int(cid),
                rth_to_amb=rth if rth > 0 else 1e9,
                cth=cth if cth > 0 else 1e-9,
                t_junction_init=t_init,
            )
    return net


# ----------------------------------------------------------------------------
# Solver
# ----------------------------------------------------------------------------

def _solve_thermal_step(
    net: ThermalNetwork,
    powers: Dict[int, float],
    T_curr: Dict[int, float],
    dt: float,
) -> Dict[int, float]:
    """
    Solve one time step of the thermal network using Backward Euler.

    The unknown vector is T_new (one entry per node). The matrix
    equation is:
        Cth_i/dt * (T_new[i] - T_curr[i]) = (T_amb - T_new[i]) / Rth_i + P_i
                                            + sum_j (T_new[j] - T_new[i]) / Rth_ij
    Rearranged:
        (Cth_i/dt + 1/Rth_i + sum_j 1/Rth_ij) * T_new[i]
            - sum_j T_new[j] / Rth_ij
            = Cth_i/dt * T_curr[i] + T_amb / Rth_i + P_i
    """
    n = len(net.nodes)
    if n == 0:
        return {}
    node_ids = sorted(net.nodes)
    id_to_idx = {cid: i for i, cid in enumerate(node_ids)}
    A = np.zeros((n, n))
    b = np.zeros(n)
    for cid, node in net.nodes.items():
        i = id_to_idx[cid]
        # diagonal contributions
        diag = node.cth / max(dt, 1e-30) + 1.0 / max(node.rth_to_amb, 1e-12)
        # add coupling contributions
        for cpl in net.couplings:
            if cpl.a_id == cid:
                diag += 1.0 / max(cpl.rth, 1e-12)
            elif cpl.b_id == cid:
                diag += 1.0 / max(cpl.rth, 1e-12)
        A[i, i] = diag
        # off-diagonal from couplings
        for cpl in net.couplings:
            if cpl.a_id == cid and cpl.b_id in id_to_idx:
                j = id_to_idx[cpl.b_id]
                A[i, j] -= 1.0 / max(cpl.rth, 1e-12)
            elif cpl.b_id == cid and cpl.a_id in id_to_idx:
                j = id_to_idx[cpl.a_id]
                A[i, j] -= 1.0 / max(cpl.rth, 1e-12)
        # right-hand side
        b[i] = (node.cth / max(dt, 1e-30)) * T_curr[cid] + \
               net.ambient_temp / max(node.rth_to_amb, 1e-12) + \
               powers.get(cid, 0.0)
    try:
        T_new_vec = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        raise SimulationError("thermal matrix is singular")
    return {cid: float(T_new_vec[id_to_idx[cid]]) for cid in node_ids}


def run_thermal(
    net: ThermalNetwork,
    powers_timeseries: List[Tuple[float, Dict[int, float]]],
    t_stop: float,
    dt: float,
) -> ThermalSimResult:
    """
    Integrate the thermal network over time given a series of
    per-component power dissipation values.

    Parameters
    ----------
    net : ThermalNetwork
    powers_timeseries : list of (t, dict cid -> power)
        Power dissipated by each component at time t. Linear
        interpolation is used between samples.
    t_stop : float
    dt : float
    """
    t0 = time.perf_counter()
    n_steps = int(round(t_stop / dt)) + 1
    times = np.linspace(0, t_stop, n_steps)
    temperatures: Dict[int, np.ndarray] = {
        cid: np.zeros(n_steps) for cid in net.nodes
    }
    # Initialize
    T_curr = {cid: node.t_junction_init for cid, node in net.nodes.items()}
    for cid in net.nodes:
        temperatures[cid][0] = T_curr[cid]
    # Interpolate power at each step
    if not powers_timeseries:
        return ThermalSimResult(
            times=times, temperatures=temperatures, t_ambient=net.ambient_temp,
            t_max=net.ambient_temp, t_min=net.ambient_temp, t_avg=net.ambient_temp,
            wall_time_s=time.perf_counter() - t0,
        )
    powers_timeseries = sorted(powers_timeseries, key=lambda x: x[0])
    ts = [t for t, _ in powers_timeseries]
    for step in range(1, n_steps):
        t = times[step]
        # find bracketing samples
        if t <= ts[0]:
            powers = powers_timeseries[0][1]
        elif t >= ts[-1]:
            powers = powers_timeseries[-1][1]
        else:
            # linear interpolation
            for k in range(len(ts) - 1):
                if ts[k] <= t <= ts[k + 1]:
                    alpha = (t - ts[k]) / max(ts[k + 1] - ts[k], 1e-30)
                    p_a = powers_timeseries[k][1]
                    p_b = powers_timeseries[k + 1][1]
                    powers = {}
                    for cid in p_a:
                        powers[cid] = p_a[cid] * (1 - alpha) + p_b.get(cid, 0.0) * alpha
                    break
        T_curr = _solve_thermal_step(net, powers, T_curr, dt)
        for cid, T in T_curr.items():
            temperatures[cid][step] = T
    # Stats
    if temperatures:
        all_t = np.concatenate([temperatures[cid] for cid in temperatures])
        t_max_v = float(np.max(all_t))
        t_min_v = float(np.min(all_t))
        t_avg_v = float(np.mean(all_t))
    else:
        t_max_v = net.ambient_temp
        t_min_v = net.ambient_temp
        t_avg_v = net.ambient_temp
    return ThermalSimResult(
        times=times,
        temperatures=temperatures,
        t_ambient=net.ambient_temp,
        t_max=t_max_v,
        t_min=t_min_v,
        t_avg=t_avg_v,
        wall_time_s=time.perf_counter() - t0,
    )


# ----------------------------------------------------------------------------
# Coupling
# ----------------------------------------------------------------------------

def coupled_electrical_thermal(
    circuit: Circuit,
    electrical_result_powers_timeseries,
    t_stop: float,
    dt: float,
    ambient_temp: float = 300.15,
    feedback: bool = True,
) -> ThermalSimResult:
    """
    Run a thermal simulation coupled to an electrical simulation.

    For now, the coupling is one-way: we use the electrical
    simulation's per-component power dissipation as the input to
    the thermal solver. If `feedback=True`, the resulting
    temperatures are written back to the components' `temp` parameter,
    so a subsequent electrical simulation will see them.

    This is a *quasi-static* coupling: we assume the electrical
    behavior reaches steady state much faster than the thermal one,
    which is true for most circuits.

    For a true transient coupling, you would alternate electrical
    and thermal sub-steps within a single time step. This is a
    future-work item.
    """
    net = default_thermal_for_circuit(circuit)
    net.ambient_temp = ambient_temp
    result = run_thermal(net, electrical_result_powers_timeseries, t_stop, dt)
    if feedback:
        for cid, T_series in result.temperatures.items():
            cid_int = int(cid)
            from ..core.ids import ComponentId
            comp = circuit._components.get(ComponentId(cid_int))
            if comp is not None:
                comp.params["temp"] = float(T_series[-1])
    return result
