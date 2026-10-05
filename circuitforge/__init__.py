"""
CircuitForge
============

Advanced Electronic Circuit Design, Simulation, Synthesis & Optimization Laboratory.

This package implements a hierarchical, multi-level circuit simulation
and optimization engine. See README.md and ARCHITECTURE.md for a complete
overview.

Package layout
--------------
- core:        circuit graph, components, nets, ports, primitives
- components:  concrete component libraries (passives, semiconductors, sources...)
- sim:         simulation engines (logic, electrical, detailed, thermal)
- thermal:     thermal network solver
- chips:       hierarchical chip library (saving / loading user-defined chips)
- export:      schematics, BOM, formats
- analysis:    static analysis (critical path, hot spots, redundancy...)
- optim:       synthesis + multi-objective search + evolutionary loop
- jobs:        job queue with persistence and recovery
- io:          serialization (project files, chips, archives)
- patterns:    auto-detection of repeated subcircuits
- reference:   reference designs and regression test designs
- cli:         headless command-line interface
- tools:       internal tools (profiler, etc.)
- utils:       RNG, hashing, units, version helpers
"""

__version__ = "0.1.0"
__engine_version__ = "0.1.0"
__schema_version__ = "1"

VERSION_INFO = {
    "package": __version__,
    "engine": __engine_version__,
    "schema": __schema_version__,
}


def about() -> str:
    """Return a one-line summary of the package version."""
    return (
        f"CircuitForge v{__version__} "
        f"(engine {__engine_version__}, schema {__schema_version__})"
    )
