# CircuitForge Specification (37 sections)

This document is the canonical specification that this implementation tracks.

> **Implementation note.** The specification was written against a Python prototype, which
> this repository no longer contains: version 1.0.0 is a TypeScript engine with a browser
> interface and a headless CLI, and the runtime dependency list is empty. Where a section
> below names a Python module, the corresponding TypeScript module is listed in
> [ARCHITECTURE.md](ARCHITECTURE.md) and the public surface in [API.md](API.md). The
> requirements themselves — hierarchy, four simulation levels, declared accuracy, synthesis,
> jobs, validation, analysis, export, reproducibility and the honesty rules — are unchanged,
> and [CHANGELOG.md](CHANGELOG.md) records what each became.
Each section describes a feature, its accuracy class, and the limitations of
the current implementation.

> **Disclaimer**: "Best", "optimal", "realistic" and similar terms are always
> qualified. A result is reported as "BEST FOUND UNDER CURRENT CONSTRAINTS" and
> the search space, candidate count, simulation level and ranking criteria
> are documented alongside.

---

## Section 1 — Goals

CircuitForge is a complete circuit design, simulation, and synthesis toolchain.
It targets the level of professional EDA tools, implemented in TypeScript
on Node.js with no runtime dependency
as its only hard dependency.

## Section 2 — Physics modeling philosophy

Real physics is used where modelable. Each model is tagged with an accuracy
class:

- `REALISTIC` — derived from accepted physical equations, parameters sourced
  from real datasheets.
- `APPROXIMATED` — uses a simplified equation (e.g. a small-signal model for
  a BJT) that is good enough for hand calculations.
- `IDEALIZED` — ignores non-idealities (e.g. an ideal opamp with infinite
  gain and bandwidth).
- `NOT MODELED` — the model does not cover this level.

Each component declares its accuracy per simulation level (logic, electrical,
thermal, detailed) so users can always inspect what was simulated and how.

## Section 3 — Core data model

The graph model has:

- `ComponentId` — typed identifier for components.
- `PortId` — typed identifier for ports.
- `NetId` — typed identifier for nets.
- `Library` — registry of primitive specs and hierarchical chips.
- `Circuit` — the actual graph.

IDs are typed wrappers around `int`. Two `PortId(0)` instances always compare
equal and hash equal. The dict keys use the typed ID, so round-tripping a
project through JSON preserves the typing.

## Section 4 — Library and primitives

The library registers primitive specs (resistor, capacitor, NMOS, ...) and
hierarchical chips. Each primitive declares its ports, parameters, defaults,
and accuracy per simulation level.

## Section 5 — Logic simulation (Level 0)

4-state event-driven simulator (`LOGIC_0`, `LOGIC_1`, `LOGIC_X`, `LOGIC_Z`).
Supports `AND`, `OR`, `NOT`, `NAND`, `NOR`, `XOR`, `XNOR`, `BUFFER`, `MUX2`,
`AND3`, `OR3`. The simulator compiles the netlist into flat arrays for the
inner loop and converges to a fixed point in at most `max_iterations` ticks.

## Section 6 — Electrical simulation (Level 1)

Modified Nodal Analysis (MNA) with Newton-Raphson for non-linear devices.
Backward Euler for capacitors and inductors. Ground-aware stamping. Substep
halving on singular Jacobian.

Limitations:
- The MOSFET model is a simple level-1 model with a documented false fixed
  point under certain Vgs/Rd combinations. Source-stepping is on the roadmap.
- The BJT model is a small-signal Ebers-Moll approximation.

## Section 7 — Thermal simulation (Level 3)

Lumped RC network. Each component has a thermal node connected to ambient
through a thermal resistance. The simulator uses Backward Euler for stability.

Coupled electrical-thermal simulation is supported: the electrical solver
informs the thermal solver of the dissipated power, and the thermal solver
returns the steady-state temperature, which is then written back to the
component's parameters.

## Section 8 — Hierarchical chips

Circuits can be saved as chips (analogous to sub-circuits in SPICE). Chips
have a typed port interface and a parameter list. Chips can be instantiated
as components, and instances can be unfolded to recover the original flat
circuit.

## Section 9 — Auto-detection of repeated subcircuits (PATTERNS)

The patterns module finds repeated subcircuits by fingerprinting 1-hop and
2-hop neighborhoods of every non-boundary component. The output is a list of
`DetectedPattern` objects, each with the fingerprint, the spec signature, the
list of occurrences, and the component count. Patterns can be extracted as
chips via `extract_pattern_as_chip`.

> **Implementation note.** `src/engine/mining/` goes further than neighbourhood
> fingerprints, which cannot see a block wider than two hops. It grows fan-in cones at
> several external-input budgets, describes each with cone-local Weisfeiler–Lehman labels
> so that the eight stages of a ripple adder are one pattern of eight rather than eight
> patterns of one, merges cones that read the same external nets into one multi-output
> block, and *measures* each block at level 0 before comparing it with the chip library.
> `SubcircuitPattern` carries the shape, the occurrences (with the nets a replacement
> would wire to), the measured truth table, the matched chip and the number of rows that
> differ, and what replacing it would save. `replacePatternWithChip` substitutes the
> occurrences that are on the mined sheet and reports every one it skipped, with the
> reason. `extractPatternAsChip` copies one on-sheet occurrence into a new chip,
> promotes the boundary nets to ordered ports, checks ERC, and re-measures the copy;
> it registers the chip in both libraries **only after all truth-table rows agree**.
> The editor offers “Save as new chip”; the CLI can persist the result and source sheet
> as one `.cfproj`, and the HTTP API returns a portable `ChipDocument` (the API request
> itself remains stateless). Extraction is exhaustive only through five binary inputs;
> it refuses an unmeasured or partial table. The chip is a fixed implementation — it
> does not infer a parameter schema or invent metrics. The 184-occurrence example this
> section asks for is a test:
> `tests/mining/mining.test.ts` builds the sheet, finds all 184, matches them to
> `full_adder` by measured behaviour, replaces all 184, and checks that no output
> changed.

## Section 10 — Job queue

The job queue has priorities, pause/resume/cancel, and atomic JSON persistence
(tmp + `os.replace`). On load, a running job is recovered into the `PAUSED`
state for safety.

## Section 11 — Static analysis

`analyze_circuit` returns a `CircuitAnalysis` with:

- `unused_components`
- `dangling_ports`
- `redundancies`
- `high_fanout_nets`
- `critical_path` (longest path in the DAG, weighted by `tpd`)
- `constraint_violations`

`estimate_critical_path` runs a topological sort on the dataflow DAG and
returns the longest delay to any output.

## Section 12 — Schematic and BOM export

Three export modes:

- `export_hierarchical` — keeps the chip hierarchy.
- `export_flat(max_depth)` — flattens up to the given depth.
- `export_full_electrical` — includes all electrical params.
- `export_bom` — Bill of Materials, aggregated by spec.

## Section 13 — Validation

`validate_logic` runs a random or exhaustive comparison against a
user-provided golden function. `validate_electrical` runs a short simulation
and checks convergence. `validate_thermal` runs a short thermal sim. 
`validate_timing` checks that the critical-path delay is non-negative.
`validate_candidate` runs all four in sequence.

## Section 14 — GPU acceleration

`Engine` is typed-array arithmetic (Float64Array, Int32Array) with no
external numerical library and, in this build, no GPU backend. The engine
chooses GPU when (a) CuPy is available, (b) the user hasn't forced CPU
(`set_force_cpu(True)` or `CIRCUITFORGE_NO_GPU=1`), and (c) the workload
size is above a configurable threshold. Stats are exposed via `engine.stats()`.

The system is fully functional without GPU. GPU is *always* optional.

## Section 15 — Optimizer / auto-design

`optim.specification.AutoDesignSpec` declares the target category, parameters,
and optimization profile. `optim.search.run_evolutionary_search` runs a
genetic algorithm with tournament selection, single-point crossover, per-gene
mutation, elite preservation, fingerprint cache, and a time budget. The
golden model for each category is implemented in `optim.synthesizer`.

Profiles: `FASTEST`, `SMALLEST`, `LOW_POWER`, `LOW_TEMP`, `MOST_STABLE`, `BALANCED`.

## Section 16 — Reproducibility

Every search is reproducible: the seed, the parameters, the constraints, the
model version, the engine version, the hardware, the candidates, the score
and the final ranking are all reported.

## Section 17 — Instruments

- **VMM-1** voltmeter: DC voltage with 0.1 % accuracy class.
- **TINY-OSC** oscilloscope: 50 MHz sample rate, 8-bit vertical resolution.
- **FND-2** frequency counter: 1-second gate time, zero-crossing counting.

## Section 18 — CLI

The CLI exposes the most common operations:

- `info` — project info.
- `validate` — validation.
- `simulate` — logic or electrical simulation.
- `export` — schematic or BOM.
- `auto-design` — synthesizer entry point.
- `benchmark` — benchmark suite.
- `gpu-info` — GPU diagnostics.

## Section 19 — GUI

A browser-based laboratory served by the engine's own HTTP server. Loads a JSON project, runs logic simulation, runs
validation. Full schematic editing is on the roadmap.

## Section 20 — Persistence

`io.serialize` round-trips projects to JSON. Typed IDs are preserved.
Schemas are versioned.

## Section 21 — Engine and schema versioning

The schema version is 1. The engine version is 0.1.0. Both are checked
on load.

## Section 22 — Tests

138 unit tests covering all major subsystems. The full suite runs in
under 1 second on a modern machine.

## Section 23 — Benchmarks

Reproducible benchmark suite in `src/engine/bench`. Each benchmark returns a
`BenchmarkResult` with timing, memory, and notes.

## Section 24 — Stress tests

The `stress` suite pushes the system beyond nominal conditions: wide buses,
random graphs, long persistence cycles. The harness returns a list of
`StressResult` objects.

## Section 25 — Error handling

A typed exception hierarchy rooted in `CircuitForgeError` provides
specific error types for each subsystem.

## Section 26 — Performance budget

- Logic simulation of 1000-gate circuits: < 100 ms.
- Electrical simulation of a 50-node circuit with 1000 time steps: < 5 s.
- Auto-design for 8-bit adder: < 30 s on a modern CPU.
- Persistence of a 1000-component project: < 200 ms.

## Section 27 — Documentation

This document. Plus the user guide (`USAGE.md`) and the API reference
(`API.md`).

## Section 28 — Roadmap

Items deliberately deferred to future versions:

- Full schematic editor in the GUI.
- SPICE-compatible netlist import/export.
- Source-stepping for the MOSFET model.
- More BJT details (charge storage, recombination).
- Multi-core parallel simulation.
- Web-based GUI.

## Sections 29-37 — Compliance, security, dependencies

CircuitForge has **zero runtime dependencies**: the engine, the server
and the interface are TypeScript and ES modules on Node.js 20 or newer,
with only a TypeScript compiler at build time. The engine makes no
network call and touches no file: file access lives in the CLI and in the
server, restricted to the paths the user gives (`--out`, the server's
`data/` directory) and containment-checked so a path cannot walk out of
them. There is no native module and no GPU requirement; a compute backend
is probed for and, in this build, none is present (see
[GPU.md](GPU.md)).