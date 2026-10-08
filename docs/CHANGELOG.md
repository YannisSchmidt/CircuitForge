# Changelog

## 1.0.0

The Python prototype that this repository started as is retired: it is removed from the tree,
and the program is now a TypeScript engine with a browser interface and a headless CLI. Every
entry below is implemented and covered by the 368-test suite.

### Engine

- Core graph: `Circuit`, `CircuitBuilder`, `Project`, `Chip`, `ChipLibrary`, a 53-model
  component library where every model carries a card (family, version, claims with accuracy
  classes, equations, parameters, limitations, references).
- Flattener to a structure-of-arrays netlist with instance provenance, gate expansion to CMOS
  transistors, bus lanes and deduplicated device models.
- Level 0: four-state bit-parallel logic, 32 vectors per settle, fixed-point iteration,
  register latching, loop detection and diagnostics.
- Level 1: modified nodal analysis, Newton-Raphson with a gmin ladder and source stepping,
  trapezoidal and backward-Euler transient with error control, signed power.
- Level 2: Shichman–Hodges class MOSFETs, a Gummel–Poon class BJT subset, diodes and LEDs with
  junction and diffusion capacitance.
- Level 3: lumped RC thermal network coupled to the electrical solve, steady state and
  transient, with refusals for impossible configurations.
- Instruments: FFT with six windows, amplitude spectrum, THD, trace statistics, frequency,
  edges, phase, duty, cursors, resampling, an oscilloscope with channels and CSV/text reports,
  a signal generator with presets, meters.
- Analysis: timing with named models, statistics per instance and per type, an analyzer
  producing coded findings, zones and constraints, and a text summary.
- Validation pipeline: logic (exhaustive where the input space allows), electrical, timing,
  thermal, power, edge cases, seeded random vectors, stability — with pass/fail/skip counts and
  the accuracy classes of the models used.
- Optimization: seven behavioural specifications, a genome representation with canonicalisation
  and a candidate cache, an architecture template catalogue, a seeded NSGA-II with tiered
  filters 0–4, six weighted profiles, Pareto retention, reproducible reports, and a "why this
  design" that answers only with measured deltas.
- Jobs: a queue with priority, reordering, pause, resume, cancel, periodic file checkpoints,
  history, interrupted-job detection and resume.
- Export and IO: three schematic levels, SPICE, BOM, circuit and project documents with an
  exact round trip, waveform CSV, JSON reports.
- Benchmarks: four suites, counted-unit throughput, heap deltas, the engine's own profiler as a
  measured group, and a pure refusal function for workloads that would not fit in memory.

### Rendering

- Sheet layout from the library's own symbols and pin positions, chip ports projected onto the
  top and bottom edges, orthogonal routing with per-wire channels and bus lanes, dataflow
  auto-placement used only when authored positions are unusable and reported when used.
- A view transform with zoom-at-cursor, fit, culling and picking, and three drawing backends
  behind one `DrawContext`: Canvas2D for the editor, SVG for export, and a null backend that
  measures the draw pass without drawing.

### Interface and server

- An HTTP server on `node:http` alone, serving the editor, the compiled engine as ES modules,
  the documents, and a JSON API for health, library, chips, examples, specifications, profiles,
  simulation, analysis, validation, optimization, synthesis, export, projects on disk, the job
  queue and benchmarks.
- A graphical laboratory: menus, toolbar and breadcrumb from one command registry of 60
  commands; a component browser, chips and examples; a canvas sheet with placement, wiring,
  box selection, panning, zooming and hierarchy drilling; an inspector with editable
  parameters, pins, nets and the model card; docks for simulation, oscilloscope, analysis, jobs
  and console; a status bar with the sheet, the zoom, the weakest accuracy class and the save
  state.
- Editor logic in typed, tested modules with no DOM in it: hierarchy layers, per-layer undo
  stacks of documents, transactions so one drag is one undo step, width-checked wiring, chip
  commit as a new version behind an ERC that refuses to commit a broken sheet, and cycle
  checking against the chips an implementation actually contains.
- `npm start` as the one-command launch: build if needed, then serve.

### Fixed along the way

- `loadProjectText` returns `errors` and `warnings` as *counts* and the messages in
  `diagnostics`; the CLI iterated the counts, so **every** `--file` load of a saved project died
  with "number 0 is not iterable" before it read a single component.
- `expandGates` was recorded in the netlist metadata as though it had taken effect while a gate
  at its default `style` expanded to nothing, and the interface offered a checkbox labelled
  "expand gates to transistors" that could not do what it said. The netlist now counts what
  happened (`expandedGates`, `gatesLeftIdeal`, `expandedTransistors`) and reports it (`CF6012`,
  `CF6013`); the checkbox, the CLI help and the documents state both conditions.
- A benchmark case described itself as measuring "gates expanded to their declared
  implementation" while the circuit it built had no gate that could expand; it now reports the
  transistor count it actually produced.
- The server answered a document-only request with a default component library and the reference
  chip library, a pair that does not know each other, so anything that needed to *place* a chip
  (mining's replacement among them) refused with "the library has no component spec". Library and
  chips are now built as a pair.
- Mining's canonical form used globally refined colours, so each stage of a ripple chain had a
  different neighbourhood and an eight-bit adder reported eight patterns of one occurrence instead
  of one pattern of eight; cones that left the block through a *port* did not count that as an
  output; merging unioned the outputs of the cones instead of recomputing them over the union;
  budget pruning cut the data path before the carry chain; a single-gate cone was rejected before
  merging, which is why an XOR and an AND over the same two nets were never seen as the half adder
  they are; and `minOccurrences: 1` was silently clamped to 2.
- Three quadratic scans in sheet construction (reference allocation, pin rewiring, empty-net
  pruning): building 10 000 components went from 22.62 s to 79 ms, and the per-component cost
  is now flat from 10 to 100 000.
- The wire router produced diagonal segments by offsetting a channel on the wrong axis, and
  folded every branch of a net into one polyline, connecting the end of one branch to the start
  of the next. Wires are now one orthogonal polyline per load, checked over 657 branches.
- The hierarchical schematic export dropped `ExportedPort.net`, a documented field the
  flattened export already filled, so every sheet input looked undriven.
- Level 0 was addressed by net name in two places that needed node indices, which is silently
  out of range and produced truth tables of nothing but X.
- Picking ordered candidates by distance alone, so a wire — which starts exactly at the port it
  connects — always won and ports were unclickable.
- `serve` returned and the CLI's `main()` exits with the command's status, so the server died
  the instant it announced its URL.
- A benchmark that could not fit in memory was killed by the OOM killer with no output; it is
  now refused with the arithmetic behind the refusal.

## 0.1.0

The Python prototype: a circuit graph, a logic simulator, a chip library, a job queue and a
Tkinter stub. Removed in 1.0.0; its specification survives as [SPEC.md](SPEC.md), which the
TypeScript implementation tracks section by section.
