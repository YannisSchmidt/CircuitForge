"""
LEVEL 3 — Electro-thermal co-simulation.

The thermal subsystem is modeled as a lumped RC network: each
semiconductor component has a thermal resistance (Rth) to the
ambient and a thermal capacitance (Cth). The power dissipated by
the component flows into the thermal node, raising its
temperature; the temperature, in turn, influences the electrical
behavior (e.g. threshold voltage, mobility, leakage).

ACCURACY DISCLAIMER
-------------------
The thermal model is APPROXIMATED:
- Lumped (no spatial temperature distribution within the die).
- Single thermal node per component.
- No convection modeling beyond the Rth to ambient.
- No thermal coupling between adjacent components (no thermal
  cross-talk on the die).
- Heat-sinks are modeled as a reduced Rth to ambient.

A more detailed model would require a 2D/3D thermal grid, which
is out of scope for the current engine but the architecture
allows for it.
"""
from .thermal import (
    ThermalNode, ThermalNetwork, ThermalSimResult,
    run_thermal, default_thermal_for_circuit, coupled_electrical_thermal,
)

__all__ = [
    "ThermalNode", "ThermalNetwork", "ThermalSimResult",
    "run_thermal", "default_thermal_for_circuit", "coupled_electrical_thermal",
]
