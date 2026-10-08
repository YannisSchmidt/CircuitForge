# CircuitForge

An electronic circuit design, simulation, synthesis and optimization laboratory.
One engine, three ways to use it: a graphical editor served in a browser, a headless
command line, and a module other programs import.

```bash
npm install     # 3 dev packages; the runtime has no dependencies at all
npm start       # builds if needed, then serves the laboratory on http://localhost:8080
```

`npm start` is the whole promise in one command: if `dist/` is missing or stale it
compiles first, then serves the editor and opens it. Everything else is available
headlessly through `node bin/circuitforge.js` (or `npm run cli --`).

---

## What it does

**Design.** A sheet of components with nets, ports, references and positions, built
through a typed graph API or by clicking. Hierarchy is unlimited: a computer contains
a CPU, which contains an ALU, which contains an adder, which contains full adders,
which contain gates, which can be expanded to transistors. Every level is a circuit,
every circuit can be saved as a chip, and every chip can be opened again — the editor
keeps a breadcrumb and an undo stack per level.

**Simulate.** Four levels, each with models that declare their own accuracy:

| Level | What is computed | How |
|---|---|---|
| L0 logic | 0 / 1 / X / Z on every net | bit-parallel, 32 vectors per settle, fixed-point iteration |
| L1 electrical | node voltages, branch currents, power, delay | modified nodal analysis, Newton-Raphson, gmin and source stepping, trapezoidal/backward-Euler transient |
| L2 device | semiconductor behaviour | Shichman–Hodges class MOSFET subset, Gummel–Poon class BJT subset, single-junction diode |
| L3 thermal | junction temperature | lumped RC network coupled to the electrical solve |

**Instruments.** Voltmeter, ammeter, wattmeter, thermometer, signal generator
(dc/sine/square/triangle/sawtooth/pulse/clock/noise plus chirp, AM, FM, burst and
arbitrary), spectrum analyser with six windows, and an oscilloscope with channels,
cursors, zoom, frequency/period/duty/phase/RMS/mean/min/max measurements, THD and CSV
export.

**Analyze.** Critical path with the actual gate chain and the timing model that
produced it named, unused components, redundant connections, combinational loops, high
fan-out, slow/hot/power-hungry zones, constraint violations — as coded diagnostics
(`CF3001`…`CF9002`), not prose.

**Find — or make — the chip a design repeats.** Fan-in cones are grown over the flattened
logic and described by cone-local colour refinement; each combinational block's truth table
is *measured* at level 0 and compared row by row with the chip library. A block that matches
on every row can be replaced by an instance of it; a near match is reported, never substituted.
A block nobody has written as a chip can be extracted from one on-sheet occurrence, copied,
and re-measured exhaustively before registration in both libraries. DFF/latch patterns remain
visible but are not measured or substituted until a clocked equivalence check exists. On a flat
sheet of 184 full adders built from gates, one five-element block has 184 occurrences: 920
components become 184, with every output checked to compute what it computed before.

**Synthesize and optimize.** A behavioural specification (for example `A[7:0]`,
`B[7:0]` → `Y = A + B`) becomes architectures from a template catalogue, then a seeded
NSGA-II search with tiered filters — fast logic first, then timing, then electrical,
then thermal, then device detail — scored against weighted objectives with six
profiles (BALANCED, FASTEST, SMALLEST, LOW_POWER, LOW_TEMPERATURE, MOST_STABLE).
Results are reported as *best found under current constraints*, with the constraints,
search space, method, candidate count, simulation level and ranking criteria attached.
"WHY THIS DESIGN?" answers only with measured deltas against the runner-up. Run end to end
that is the specification's **reverse-engineering mode**: hand it a behavioural contract and
it generates architectures, searches, details the winner, simulates it, validates it and
saves it as a chip — `circuitforge synth --spec adder --param bits=4`, *Optimize ▸ Synthesize
design…* in the interface, or `POST /api/synth`.

**Validate.** Before a design is saved as a chip: logic (exhaustive when the input
space is small enough), electrical convergence, timing, thermal, power balance, edge
cases, seeded random vectors and stability — reported as pass/fail/skip counts.

**Run long work as jobs.** A queue with priority, reordering, pause, resume, cancel,
periodic checkpoints, history, and detection of jobs interrupted by a crash, offered
for resume on the next start.

**Export.** SPICE netlists, circuit and project documents (round-trip exact),
aggregated and detailed BOMs, three schematic levels (hierarchical, flattened, full
electrical), SVG of the sheet, waveform CSV, and JSON reports for analysis, validation
and benchmarks.

---

## Honesty rules this codebase follows

These are not aspirations; they are enforced by the reports and checked by tests.

- **Every model carries a card**: family, version, the phenomena it claims with an
  accuracy class (`REALISTIC`, `APPROXIMATED`, `IDEALIZED`, `NOT_MODELED`), what
  exactly is computed, where it stops being valid, its limitations and its references.
  The inspector shows it; `circuitforge validate` prints it; a sheet reports its
  weakest class.
- **Nothing is simulated that is only an arbitrary approximation.** No `temperature =
  power × 10`. If a quantity is not computed by a declared model, it is reported as
  not measured.
- **No invented statistics.** An objective that a search tier never scored is printed
  as `not measured`, not as zero. A benchmark case that cannot run reports why.
- **No unscoped superlatives.** Never `OPTIMAL`, `FASTEST` or `REALISTIC` alone —
  always *best found under these constraints, with this method, at this level*.
- **The GPU is probed, not claimed.** `gpuProbe()` reports `backend: none`,
  `enabled: false` and no speedup in this build; `enabled` only becomes true when a
  benchmark on a real backend measures more than 1.05×.
- **Refusal over guessing.** A workload that would not fit in the available heap is
  refused with the arithmetic behind the refusal (measured marginal cost per
  component, safety factor, the limit and how to raise it) instead of being killed.

---

## Layout

```
bin/circuitforge.js    the CLI: help, doctor, list, examples, simulate, analyze, mine,
                       validate, optimize, synth, export, benchmark, jobs, serve
src/engine/core/       circuit graph, library, chips, projects, diagnostics
src/engine/sim/        flattener (SoA netlist), MNA solver, transient, thermal
src/engine/analysis/   logic vector engine, timing, statistics, analyzer
src/engine/mining/     repeated subcircuits, measured matching, verified chip extraction
src/engine/instruments/ fft, spectrum, oscilloscope, meters, signal generator
src/engine/optim/      specs, genomes, cost, tiered search, NSGA-II, explanations
src/engine/validate/   the validation pipeline
src/engine/export/     spice, bom, three schematic levels
src/engine/io/         documents, project files, exact round trip
src/engine/jobs/       queue, tasks, memory and file checkpoint storage
src/engine/render/     layout, orthogonal routing, view, SVG/Canvas2D/Null backends
src/engine/bench/      the benchmark suite and its report
src/engine/synthesis/  the 19 reference designs and 24 worked examples
src/server/            HTTP server and JSON API behind the editor
src/ui/                the editor state machine and the command registry
public/                the interface: HTML, CSS and five ES modules
tests/                 380 tests: unit, integration, simulation, io, export,
                       analysis, mining, validation, jobs, optimizer, instruments,
                       render, editor, server, benchmarks, scale
docs/                  the twelve documents listed below
```

The browser imports the compiled engine as ES modules from the same server, so the
sheet on screen is simulated by the code the CLI runs. There is no second
implementation of the logic to keep in step with the first, and no bundler: `src/`
never imports a Node builtin statically, which is what keeps the engine loadable in a
browser.

---

## Command line

```bash
circuitforge doctor --full        # 15 self-checks, including every worked example
circuitforge list                 # the 53 component models and their accuracy
circuitforge examples             # the 24 worked examples and the readings they must meet
circuitforge simulate --chip cpu8 --level 0
circuitforge analyze  --chip ripple_adder --param bits=8
circuitforge mine     --file sheet.cfproj --replace --out rewritten.json
circuitforge validate --chip ripple_adder --spec adder --param bits=4
circuitforge optimize --spec and_not --profile FASTEST --budget 400 --why
circuitforge synth    --spec mux --param selectBits=2 --profile SMALLEST
circuitforge export   --chip cpu8 --format spice|json|bom|schematic|svg
circuitforge benchmark --suite quick|full|scaling|stress --json
circuitforge jobs                # queue, checkpoints, resume after a crash
circuitforge serve --port 8080   # the graphical laboratory
```

Every verb works without a display, prints what it measured, and exits non-zero on
failure. `--json` is available wherever a report is produced.

---

## Measured on the reference machine

2 cores (Xeon @ 2.60 GHz), 3.94 GiB RAM, node 22, no GPU. `circuitforge benchmark`
reproduces these; the report states the environment it ran in.

| Work | Result |
|---|---|
| Logic evaluation | 15.5–16.1 M element-evaluations/s |
| Hierarchy flattening | 103 k–153 k flattened elements/s |
| DC operating point | 70 k nodes/s, residual 0 |
| Transient | 2.4 k accepted steps/s |
| FFT (16 384 points) | 14.8 M samples/s, round-trip error 7.8e-16 |
| Sheet construction | linear: 10 k components in 79 ms, 100 k in 700 ms |
| Logic settle | linear: 100 k components in 665 ms |
| Serialisation | 20.8 MB/s of JSON, round trip exact |
| Sheet layout | 5.5 k–8.4 k blocks/s |
| Draw pass | 578 k–702 k drawing operations/s |
| Optimizer | ~1 k candidate evaluations/s |
| Repeated-subcircuit mining | 184 gate-level adders in 155 ms; new chips extracted and re-measured before registration |

A million-component sheet is **refused** in this environment, with the reason: roughly
8.75 GiB of heap against a 1.91 GiB V8 limit at a measured marginal cost of 4.6 KiB
per component. That is an environment limit, not an algorithmic one — per-component
cost was flat across every size that ran — and the report says how to raise it.

---

## Tests

```bash
npm test        # 380 tests, about 16 s
```

Unit, integration, simulation, regression, serialization, export/import, randomized,
performance and scale. The suite includes the invariants that are easy to lose: every
routed wire segment is axis-aligned (checked over 657 branches of seven reference
designs at two schematic levels), a full adder's truth table is 8/8 through the HTTP
API, the profiler's phases sum to 100 %, a benchmark's throughput is counted units
over its best repeat, a chip with an ERC error cannot be committed, and 184 repetitions of
a full adder are found, matched to the library chip by measured behaviour, and replaced
without changing any output.

---

## Documentation

| Document | What it covers |
|---|---|
| [README.md](README.md) | this file |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the engine's structure and why it is shaped that way |
| [docs/SIMULATION.md](docs/SIMULATION.md) | the four levels, their solvers and their accuracy |
| [docs/PHYSICS.md](docs/PHYSICS.md) | the device equations actually implemented, and their limits |
| [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) | objectives, profiles, tiers, the search and its reporting |
| [docs/GPU.md](docs/GPU.md) | what is probed, what is not claimed, and why |
| [docs/SCHEMATIC_EXPORT.md](docs/SCHEMATIC_EXPORT.md) | the three export levels and reconstruction |
| [docs/FORMAT.md](docs/FORMAT.md) | document, project and netlist formats, with versions |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | building, testing, extending, adding a model |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | the editor, the docks, the CLI, workflow by workflow |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | the suite, its method, and what its numbers mean |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | what this build does not do, stated plainly |
| [docs/API.md](docs/API.md) | the public API of every module |
| [docs/USAGE.md](docs/USAGE.md) | task-oriented guide |
| [docs/SPEC.md](docs/SPEC.md) | the 37-section specification this implementation tracks |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | what changed, and what was fixed |

---

## Requirements

Node.js 20 or newer. Nothing else: the runtime dependency list is empty, the
interface needs no framework, and the engine needs no native module.

## License and status

Version 1.0.0. The engine, the editor and the CLI are complete and tested; the
document set above describes exactly what is implemented, and
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) states what is not.
