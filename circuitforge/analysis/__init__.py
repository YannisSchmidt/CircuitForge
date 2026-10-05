"""Static circuit analyzer (section 18 of the spec)."""
from .static_analysis import (
    analyze_circuit, CircuitAnalysis, CriticalPath,
    find_unused_components, find_dangling_ports, find_redundancies,
    estimate_critical_path, fan_out_report,
)

__all__ = [
    "analyze_circuit", "CircuitAnalysis", "CriticalPath",
    "find_unused_components", "find_dangling_ports", "find_redundancies",
    "estimate_critical_path", "fan_out_report",
]
