# Changelog

## 0.1.0 (current)

Initial release of CircuitForge.

### Implemented
- Core data model (typed IDs, library, primitives)
- Logic simulation (4-state, event-driven, level 0)
- Electrical simulation (MNA + Newton-Raphson, level 1)
- Thermal simulation (lumped RC, level 3)
- Hierarchical chips
- Static analysis (critical path, redundancies, ...)
- Schematic and BOM export
- Optimizer / auto-design (evolutionary search, multi-objective)
- Job queue (priorities, persistence)
- Auto-detection of repeated subcircuits
- Validation (logic, electrical, thermal, timing)
- GPU detection + CPU fallback
- Virtual instruments (VMM-1, TINY-OSC, FND-2)
- Benchmark suite
- Stress tests
- CLI
- Tkinter GUI stub
- Documentation (spec, usage, API)

### Not yet implemented
- Full schematic editor in the GUI
- SPICE netlist import/export
- Source-stepping for the MOSFET model
- More detailed BJT model
- Multi-core parallel simulation
- Web-based GUI

### Test count
138 unit tests, all green.