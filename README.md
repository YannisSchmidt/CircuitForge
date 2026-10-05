# CircuitForge

A complete circuit design, simulation and synthesis toolchain. CircuitForge
combines:

- a typed graph data model for circuits,
- 4 simulation levels (logic, electrical, thermal, and a roadmap to SPICE-like detail),
- hierarchical chips with auto-detection of repeated subcircuits,
- a search-based auto-design / synthesis engine,
- a job queue with persistence and concurrency control,
- a complete validation pipeline (logic, electrical, thermal, timing),
- a CLI and a Tkinter-based GUI,
- three virtual instruments (VMM-1 voltmeter, TINY-OSC oscilloscope, FND-2 frequency counter),
- a benchmark and stress-test suite,
- CPU + optional GPU acceleration (NumPy / CuPy).

**This is real engineering software, not a demo.** Every model is documented
with its accuracy class (`REALISTIC`, `APPROXIMATED`, `IDEALIZED`, `NOT_MODELED`)
and every "best" result is qualified with the search constraints and the
candidate count (see the spec's section 33).

## Quick start

```bash
# Install (editable, no extra deps beyond numpy)
pip install -e .

# Run the test suite
python -m unittest discover -s circuitforge/tests

# CLI
python -m circuitforge.cli info tests/data/my_project.json
python -m circuitforge.cli simulate tests/data/my_project.json --logic
python -m circuitforge.cli auto-design --category adder --bits 4
python -m circuitforge.cli benchmark --output bench.json

# GUI
python -m circuitforge.gui
```

## Project layout

```
circuitforge/
  core/          # graph data model (components, ports, nets, circuit, library)
  sim/           # logic (level 0) and electrical (level 1) simulators
  thermal/       # lumped-RC thermal network (level 3)
  chips/         # hierarchical chips
  analysis/      # static analysis, critical path, redundancies
  export/        # schematic and BOM export
  optim/         # auto-design, evolutionary search, multi-objective scoring
  jobs/          # job queue with persistence
  validation.py  # automatic validation (logic, electrical, thermal, timing)
  instruments.py # VMM-1, TINY-OSC, FND-2
  gpu.py         # CPU / GPU dispatch (CuPy optional)
  benchmarks.py  # reproducible benchmark suite
  stress.py      # stress tests for large circuits
  patterns.py    # auto-detection of repeated subcircuits
  cli.py         # command-line interface
  gui.py         # Tkinter GUI
  io/serialize.py # JSON project round-trip
  utils/         # RNG, hashes, units, versioning
  tests/         # full test suite (138 tests)
docs/
  SPEC.md        # full specification (37 sections)
  USAGE.md       # user guide
  API.md         # auto-style API reference
```

## Engine versions

- Spec schema version: 1
- Engine version: 0.1.0
- Python: 3.11+
- NumPy: required (≥ 1.24)
- CuPy: optional (for GPU acceleration)

## License

This software is provided as-is. Use at your own risk; validate all results
before relying on them for production designs.

## See also

- `docs/SPEC.md` for the complete specification.
- `docs/USAGE.md` for the user guide.
- `docs/API.md` for the public API reference.