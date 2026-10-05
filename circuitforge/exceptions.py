"""
Centralized exception types.

We keep the exception tree small and self-explanatory so that errors
propagating from the engine are easy to identify and to handle.
"""

from __future__ import annotations


class CircuitForgeError(Exception):
    """Base class for all CircuitForge errors."""


# -- circuit graph ----------------------------------------------------------
class CircuitError(CircuitForgeError):
    """Generic circuit structure error."""


class PortError(CircuitError):
    """Port-related error (missing, type mismatch, etc.)."""


class NetError(CircuitError):
    """Net-related error (open net, conflicting drivers, etc.)."""


class ConnectionError(CircuitForgeError):
    """Connection-related error."""


class HierarchyError(CircuitForgeError):
    """Hierarchical chip error (cycle, depth overflow, missing port...)."""


# -- simulation -------------------------------------------------------------
class SimulationError(CircuitForgeError):
    """Generic simulation error."""


class ConvergenceError(SimulationError):
    """Numerical simulation failed to converge."""


class ModelError(SimulationError):
    """Model error (missing parameter, out of range, ...)."""


class OverrangeError(SimulationError):
    """Component or circuit exceeds its physical ratings."""


class TopologyError(SimulationError):
    """Circuit topology not supported by a given simulator (e.g. floating net)."""


# -- optimization -----------------------------------------------------------
class OptimizationError(CircuitForgeError):
    """Generic optimization error."""


class SpecError(OptimizationError):
    """Invalid specification for synthesis."""


# -- io ---------------------------------------------------------------------
class IOError_(CircuitForgeError):
    """I/O error during project / chip load or save."""


class SchemaError(IOError_):
    """Schema version mismatch or corruption."""
