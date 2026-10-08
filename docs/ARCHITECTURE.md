# CircuitForge — Architecture

> Design document. Written **before** the implementation, kept in sync with it.
> Every section states what is really implemented, what is approximated, and what
> is deliberately not modelled. See `KNOWN_LIMITATIONS.md` for the honesty ledger.

## 0. Requirements analysis

The specification (37 sections) decomposes into five hard engineering problems and
a long tail of features. The hard problems drive the whole architecture:

| # | Problem | Why it is hard | Architectural answer |
|---|---------|----------------|----------------------|
| P1 | Simulate **electrical** circuits with real device physics | needs a nonlinear algebraic solver + implicit integration + convergence control (this is what SPICE is) | Modified Nodal Analysis (MNA) with Newton–Raphson, gmin/source stepping, junction limiting, LTE-controlled adaptive time stepping |
| P2 | Simulate **huge** circuits (10⁵–10⁶ components) | O(n) memory per step, event storms, GC | structure-of-arrays netlists, typed arrays, integer-indexed graph, event-driven scheduler with bucketed queue, no per-element objects in hot loops |
| P3 | **Search** over millions of candidate architectures, multi-objective | cost per candidate must be microseconds, not milliseconds | tiered filter: L0 bit-parallel logic (32/64 candidates at once) → analytic timing → electrical → thermal → full validation; deterministic seeded RNG |
| P4 | Never lie about accuracy | a "thermal model" that is `T = P·10` is fraud | every model declares `REALISTIC / APPROXIMATED / IDEALIZED / NOT_MODELED`, lists parameters, validity domain and unmodelled effects; measured metrics carry the provenance of the engine level that produced them |
| P5 | A GUI that is pleasant for 10⁶ elements | DOM is too slow | WebGL2 instanced renderer, SDF rounded rectangles, one atlas texture, batched draw calls; UI chrome in DOM, everything inside the canvas in GL |

Secondary requirements (hierarchy, exports, BOM, jobs, reproducibility, instruments,
CLI, docs, tests) are ordinary application engineering on top of these five.

### Technical risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Newton–Raphson divergence on switching circuits | gmin stepping + source stepping + pnjlim + MOSFET limiting; explicit convergence failure reporting (never silently return garbage) |
| Dense MNA is O(n³) | sparse LU (right-looking, Markowitz-lite pivot selection, fill-in tracked) with an AC/DC reuse; circuit partitioning for large flat netlists |
| Timestep explosion with fast digital edges | LTE control + per-device `trtol`, plus optional event-driven "digital fast path" per net |
| Search that explores nothing useful | genome is *typed*: architecture class + prefix topology + gate style + drive strength + width; generator is total (every genome maps to a valid netlist) |
| Reproducibility drift | all randomness through a seeded, versioned PRNG (`xoshiro128**`), every run stores engine/model versions + seeds + hardware |
| GPU that is faster in the marketing deck than in reality | GPU is used only for intrinsically parallel work (independent netlist evaluations / Monte-Carlo sweeps); a benchmark decides CPU vs GPU vs hybrid, and the winner is stored in the run record |
| Python prototype death by scope | prototype is replaced (see `MIGRATION.md`); the TypeScript engine is the single source of truth, the UI reuses the same code in the browser |

### Language / stack decision

* **TypeScript (ES2022), zero runtime dependencies.**
  * Same engine code runs in Node (headless, jobs, benches) and in the browser (interactive, GPU) — one implementation, no FFI, no version skew.
  * Typed arrays + SoA give C-like inner loops; V8 JIT handles monomorphic numeric kernels well.
  * Node ≥ 20 for `node:test`, `worker_threads`, `Atomics`, `SSE`.
* **WebGL2** for the schematic view (instanced quads + SDF), **WebGPU** when present
  for compute (cost/benefit decided by benchmark).
* Rejected: Rust+C++ (no crates.io/apt mirror in the deployment environment → cannot
  build reproducibly for the user), Python for hot loops (JIT-less inner loops and
  GIL for parallelism).

## 1. Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ UI (browser)         WebGL2 canvas · panels · scope · job monitor     │
├───────────────────────────────────────────────────────────────────────┤
│ Server (node)        static files · REST · SSE event stream           │
├───────────────────────────────────────────────────────────────────────┤
│ Application          jobs · project store · exports · benchmarks      │
├───────────────────────────────────────────────────────────────────────┤
│ Synthesis/Optim      specification → genome → netlist → score         │
├───────────────────────────────────────────────────────────────────────┤
│ Analysis             static analysis · critical path · patterns       │
├───────────────────────────────────────────────────────────────────────┤
│ Simulation           L0 logic · L1 electrical(MNA) · L2 device ·      │
│                      L3 electro-thermal · instruments                 │
├───────────────────────────────────────────────────────────────────────┤
│ Core model           library · circuit · nets · ports · chips · I/O   │
└───────────────────────────────────────────────────────────────────────┘
```

Dependency rule: **downward only**. The core model knows nothing about simulation;
simulation knows nothing about synthesis; synthesis knows nothing about the UI.
This is what makes the engine testable in isolation and reusable in CLI mode.

## 2. Core data model

Two representations, deliberately:

1. **Authoring model** (`core/`): object graph — `Circuit` → `ComponentInstance[]`
   + `Net[]`, plus a `Library` of `ComponentSpec`s. Readable, diffable, JSON-stable,
   used by the editor, the exporter, and the human.
2. **Execution model** (`sim/netlist.ts`): flattened, structure-of-arrays
   `FlatNetlist` — parallel typed arrays (`compKind: Uint8Array`, `params: Float64Array`,
   `nodeA: Int32Array`, …). Produced from the authoring model by `flatten()`, which
   recursively expands chips. Immutable once built (so it is shareable, hashable and
   parallelisable across workers).

`Circuit` is a *value*: deterministic ids, canonical ordering, stable fingerprint
(`util/hash.ts`), so two structurally identical circuits hash identically — this is
what the search cache (`optim/cache.ts`) and the reproducibility records rely on.

### Naming and identity

* Components: reference designators (`R12`, `Q4`, `U2`) that are *stable across
  edits*; the internal id is a monotone integer, never reused inside a project.
* Nets: `NET_<id>` unless the user names them; connected ports are the source of truth.
* Chips: `name@version`, content-addressed by fingerprint. `FULL_ADDER@1`.

## 3. Simulation engine

### Level 0 — Logic (`sim/logic.ts`, `sim/bitlogic.ts`)

* 4 states `0/1/X/Z` packed 2 bits/nets; gates compiled to a flat table.
* Event-driven scheduler: bucket queue indexed by `time / timeStep`, so scheduling
  is O(1) and ticks are cache-linear.
* **Bit-parallel mode** (`bitlogic.ts`): 32 vectors at once via `Uint32Array` words;
  a 32-bit adder with N gates costs `N/32` word-ops. This is the workhorse of the
  search filter: validation of a candidate against 32 exhaustively enumerated input
  vectors costs one pass.
* Delay model: unit-delay option (fast filter), or per-gate `tphl/tplh` from the
  library (timing filter). Documented as `IDEALIZED` / `APPROXIMATED` respectively.

### Level 1 — Electrical (`sim/mna.ts`, `sim/transient.ts`)

* Modified Nodal Analysis. Unknowns = node voltages + branch currents for
  voltage-defined elements.
* Linear: sparse LU with partial pivoting (pattern-reuse across steps).
* Nonlinear: Newton–Raphson, companion models per device, convergence on
  ΔV + residual, with `gmin` stepping, source stepping, and SPICE-style
  `pnjlim`/`fetlim` limiting.
* Transient: implicit integration (Backward Euler and Trapezoidal), adaptive step
  from local truncation error, `breakpoints` injected by time-dependent sources.
* AC: complex MNA at the operating point (small-signal linearisation), sweep
  linear/log/decade, output in magnitude/phase.
* Measurements are taken by instruments reading the *solver state*, not by replaying
  waveforms, so e.g. `Power(Q4)` is `v·i` at every accepted step.

### Level 2 — Detailed device (`devices/*.ts`)

Shichman–Hodges MOS (with body effect, channel-length modulation, subthreshold),
Ebers–Moll BJT (with Early effect and β roll-off), Shockley diode with series
resistance, junction capacitance and breakdown, LED/photodiode variants, coupled
inductors, relay with mechanical dynamics. Each device file carries a
`MODEL_CARD` with parameters, validity domain and limitations, surfaced in the UI
and in `PHYSICS.md`.

### Level 3 — Electro-thermal (`sim/thermal.ts`)

Lumped **thermal RC network** solved with the same integrator as the electrical
problem. Each device contributes a junction node with `Rth_jc`, `Rth_ca`, `Cth`,
couples to ambient and optionally to a heatsink node. Two-way coupling:

```
instantaneous dissipated power ──► thermal nodes
junction temperature ───────────► device parameters (Is(T), Vth(T), μ(T), R(T))
```

Convergence is achieved by **outer iteration**: solve electrical at the current
temperature, update the thermal network, repeat until ΔT below tolerance or a
documented iteration cap is reached (then the step result is flagged as
`NOT_CONVERGED`, never silently accepted).

## 4. Hierarchy

A chip is `{ name, version, ports[], params[], implementation: Circuit, metrics }`.
Instantiation is a component with kind `chip` and a reference into the library.
`flatten()` expands recursively, memoised per (fingerprint, parameter set); identity
of a chip's *netlist* is therefore content-addressed. Cycles are detected and
rejected with a precise diagnostic path.

Depth is structurally unlimited (iterative expansion, explicit stack) — bounded only
by memory. The UI navigates the hierarchy as a stack of editors ("enter chip /
return"), and every level down is a real circuit, never a mock.

## 5. Analysis

Static: critical path (longest path on the topological order, unit and library
delays, with the actual component chain reported), unused components, dangling nets,
combinational loops (SCC detection via Tarjan), fan-out hotspots, energy hotspots
(real dissipation from L1 runs), redundancy (isomorphic duplicates), margin
violations (against declared ratings).

Pattern mining (`src/engine/mining/`): fan-in cones are grown over the flattened logic
graph at several external-input budgets, and two cones are treated as the same shape when
their **cone-local** Weisfeiler–Lehman labels agree — local, because a global refinement
encodes the neighbourhood beyond the cone, and in a ripple chain no two stages have the
same neighbourhood. Cones that read the same external nets are merged, so a sum cone and a
carry cone become one full adder rather than two half findings, and each merged block's
inputs and outputs are recomputed over the union. Equality of shape is a strong structural
test, **not** a proof of isomorphism, and the report says so: what confirms a match is
behaviour, measured at level 0 and compared row by row with the chip library. Only an
identical match is offered for replacement, only for occurrences that live on the mined
sheet, and blocks contained in a larger reported block are labelled as such so that nobody
de-duplicates the same gates twice.

## 6. Synthesis & optimization

```
Specification ─► Architecture space (typed genome)
                    │
                    ├─ tier 0: logic filter     (bit-parallel, exhaustive vectors)
                    ├─ tier 1: timing filter    (analytic RC/Elmore + load model)
                    ├─ tier 2: electrical       (MNA transient, real waveforms)
                    ├─ tier 3: thermal          (electro-thermal coupling)
                    └─ tier 4: validation       (logic/electrical/timing/thermal/
                                                 power/edge-case/random/stability)
```

* **Generators** are constructive and total: every genome yields a valid netlist
  (adders: ripple/carry-select/carry-skip/brent-kung/kogge-stone/sklansky; multipliers:
  array/Wallace/Dadda; ALU: op-mux topology; memories: row×column banking, sense-amp
  style; CPU: datapath+control templates; gate style: CMOS static / pass-transistor /
  transmission gate).
* **Search**: multi-objective evolutionary (NSGA-II style: fast non-dominated sort +
  crowding distance), seeded and checkpointable. Every candidate is fingerprinted;
  the cache refuses to re-simulate.
* **Ranking**: weighted sum over normalised objectives *or* Pareto front. Ties are
  broken deterministically. All reported numbers carry their engine-level provenance.
* **Explanation** (`optim/explain.ts`) diffs the winner against the runner-up using
  measured quantities only, and states constraints, search space, method, candidate
  count, simulation levels and ranking criteria — never an invented narrative.

## 7. Jobs

`jobs/`: a persistent queue (append-only JSONL journal + periodic snapshots) with
priority, pause/resume/cancel, reordering, per-job progress, checkpoints (genome
population, RNG state, cache digest, metrics so far) so an interrupted search resumes
*exactly*. A watchdog writes the last checkpoint on uncaught exceptions — the crash
recovery the spec asks for. Multiple jobs run with bounded concurrency
(`min(cores, configured)`), with the interactive job preempting.

## 8. Exports

| Export | Content |
|--------|---------|
| Hierarchical schematic | SVG/JSON with chips as blocks, ports, wire routes |
| Flattened schematic | all chips expanded, still human-readable |
| Full electrical schematic | every elementary device with reference, value, position, rotation, connectivity, parameters — no abstraction |
| Exact reconstruction | deterministic JSON (`FORMAT.md`) with all geometry + parameters |
| BOM | aggregated + detailed, CSV/JSON/Markdown |
| Simulation data | waveforms (CSV/JSON), operating points, .raw-like binary |
| Reports | performance, optimization, validation, analysis |

All exports are generated from the same in-memory model, so they cannot disagree.

## 9. Performance strategy

Measured, never asserted (`BENCHMARKS.md`): SoA netlists, integer net ids, avoided
allocation in hot loops (scratch buffers reused), event bucketing, bit-parallel
logic, sparse LU with reused pattern, parallelism via worker threads for independent
candidates (and WebGPU where a benchmark proves a win), incremental rendering with
instancing, and an internal profiler (`util/profiler.ts`) that attributes time to
engine phases and is exposed in the UI.

## 10. Testing strategy

`tests/`: unit (core, units, RNG, hash), model tests (analytic verification of every
device: RC step, RLC ringing, diode I–V, MOS square law, BJT bias, transformer,
rectifier, thermal step response), integration (spec → chip → export → re-import →
simulate), regression (every fixed bug gets a test), randomized/fuzz (serialization
round-trip on random circuits), serialization/format, export/import, performance
budgets, and stress (10 → 10⁶ components). CI-ish entry point: `npm test`.

## 11. Directory map

```
src/engine/core/*        data model, library, registry, chips, serialization
src/engine/sim/*         L0/L1/L2/L3 engines, netlist flattening, solver
src/engine/devices/*     device model cards & stamps
src/engine/analysis/*    static analysis, critical path, timing, statistics
src/engine/mining/*      repeated subcircuits, measured chip matching, replacement
src/engine/synthesis/*   specification → genome → netlist generators
src/engine/optim/*       objectives, NSGA-II search, cache, explanation, tiers
src/engine/jobs/*        queue, persistence, checkpoints, crash recovery
src/engine/export/*      schematics, BOM, reports, archives
src/engine/instruments/* scope, multimeter, spectrum, thermometer
src/engine/io/*          project format, migrations
src/engine/bench/*       benchmark suites, stress generators, profiler reports
src/engine/util/*        RNG, units, hashing, profiler, platform probes
src/server/*             HTTP(S) server, REST + SSE API
src/ui/*                 WebGL2 renderer, panels, scope, editor, job monitor
tests/*                  node:test suites
docs/*                   the 12 required documents
```
