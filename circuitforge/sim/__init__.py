"""Simulation engines.

The package exposes the four simulation levels required by the spec:
- LEVEL 0 LOGIC:    LogicEngine (fast, 4-state event-driven)
- LEVEL 1 ELECTRICAL: ElectricalEngine (companion-style MNA)
- LEVEL 2 DETAILED: DetailedEngine (wraps Electrical + parasitic)
- LEVEL 3 ELECTRO_THERMAL: ThermalEngine (coupled electrical+thermal)
"""
