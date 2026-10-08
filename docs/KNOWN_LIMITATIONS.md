# Known limitations

What this build does not do. Each item states the limit and, where there is one, the reason
and what would be needed to lift it. Nothing here is a bug list; these are boundaries of the
models and the implementation, and the engine reports them rather than papering over them.

## Level 0 — logic

- **No time.** Level 0 computes the settled value long after every transient has died out.
  Propagation delay lives in the timing analysis and comes from the delays elements declare.
- **Declared delays only.** A critical path over elements that declare 0 delay is reported as
  0 ns and labelled a lower bound. The timing model in use is named in every report
  (`declared delays` by default) so a reader knows what produced the number.
- **Loops settle or they do not.** Settling is fixed-point iteration; a combinational loop is
  reported through the graph's diagnostics and its elements listed, with the values shown
  labelled as the last iterate. There is no oscillation model.
- **Metastability is not modelled.** Setup time is declared and checked; hold time, recovery
  and a metastability window are reported as NOT_MODELED. Inventing one would be a guess.
- **32 vectors per settle.** An exhaustive truth table is therefore limited to five inputs in
  one settle; wider sheets are reported as truncated with the reason. Validation uses a
  contract of corners plus seeded random vectors above 16 bits.

## Level 1 — electrical

- **No distributed elements.** No transmission lines, no S-parameters, no
  frequency-dependent interconnect, no skin effect. MNA with lumped elements only.
- **Inductors stiffen the solve.** They are companion-modelled as MNA current unknowns, which
  limits the step size a switching converter can take; a very stiff converter will take many
  rejected steps and say so.
- **Convergence is not guaranteed.** A solve that does not converge reports `converged: false`
  with the iteration count, the worst voltage error and the node, and the voltages shown are
  labelled as the last iterate. The gmin ladder and source stepping are bounded; the engine
  deliberately does not raise `gmin` or the iteration cap to force a converged-looking answer.
- **A sheet with no ground reference is diagnosed** (`CF3001`) rather than silently anchored
  to node 0.

## Level 2 — devices

- **MOSFETs**: a Shichman–Hodges class model. No BSIM short-channel effects, no velocity
  saturation, no gate tunnelling, no charge partitioning model, no layout parasitics.
  Subthreshold conduction is a smoothing parameter, not a physical slope.
- **BJTs**: a Gummel–Poon subset. No excess phase, no substrate network, no avalanche
  multiplication.
- **Diodes**: single-junction exponential with junction and diffusion capacitance. Reverse
  breakdown is a declared knee, not an avalanche model.
- **LEDs**: electrically modelled, optically not. Light output is reported as NOT_MODELED.
- **Valid ranges are declared per claim.** Outside them the model still computes a number; the
  card says where it stops being valid, and a thermal solve that leaves the range is reported
  as out of range rather than clamped.
- **Gate expansion needs two conditions, and only one of them is a flatten option.**
  `expandGates: true` permits expansion; a gate actually expands only when its own `style`
  parameter is not the default `ideal` (for example `cmos_static`). A netlist can therefore hold
  ideal gates and transistor-level gates at once. This is reported rather than left implicit:
  `CF6012` counts the gates and transistors produced, and `CF6013` warns when expansion was
  requested and no gate qualified. The counters are `expandedGates`, `gatesLeftIdeal` and
  `expandedTransistors`.
- **Expanded gates have no level-0 behaviour.** A gate lowered to transistors contributes
  devices, not a logic element, so a fully expanded netlist settles electrically and has nothing
  for the logic engine — or the miner — to read. That is why mining flattens with expansion off
  and offers no option to turn it on.

## Level 3 — thermal

- **Lumped RC, one node per instance.** No spatial gradient inside a package, no board
  conduction model, no convection correlation, no radiation, no airflow.
- **Thermal resistances are declared, not computed** from geometry or materials.
- **Coupling is two-way only where the model declares a temperature coefficient.** Elsewhere
  power flows into the thermal network and temperature does not flow back.
- **`rthCa = 0` is refused** (`CF5303`): it means an infinitely good heatsink.
- **A thermal ramp needs `skipInitialDc: true`**, or the DC solve pins the design to its final
  temperature before the sweep starts.

## GPU

- **No compute backend exists in this build.** `gpuProbe()` reports `backend: none`,
  `enabled: false`, `measuredSpeedup: 0`. Everything runs on the CPU, and no report attributes
  work to a GPU or claims a speedup. `enabled` becomes true only when a benchmark on a real
  backend measures more than 1.05× for the task, on the machine it ran on.

## Optimization and synthesis

- **The search explores what its genome can express.** Nodes are two-input functions over
  earlier nodes or the specification's inputs. A design needing a construct outside that
  representation — a specific clocking scheme, a tri-state bus protocol, an analogue feedback
  loop — will not be found, and the report does not claim the space was covered.
- **Tiered filtering means some objectives are never scored.** `power`, `temperature` and
  `switchEnergy` are `null` until tiers 3 and 4 run on the detailed candidates; reports print
  them as *not measured*, never as zero.
- **The stability risk score is a declared heuristic** over structural properties (loops,
  undetermined outputs, constraint violations). It is not a metastability or noise-margin
  analysis.
- **No optimality claim, ever.** Results are *best found under current constraints*, with the
  specification, profile, budget, population, seed, tiers and ranking criteria attached.

## Analysis

- **Findings are structural and measured, not predictive.** Unused components, redundant
  connections, fan-out, loops, duplicate types and constraint violations are computed from the
  netlist. There is no timing closure, no signal-integrity, no power-integrity and no
  testability analysis.
- **Zones (slow, hot, power) require a solved simulator.** Without one they are empty, and the
  report says nothing was measured rather than showing zeros.
- **Mining sees the logic layer only.** Repeated subcircuits are found among flattened logic
  elements: resistive, reactive and semiconductor circuitry is not mined, and a block whose
  identity is analogue (a filter section, a bias network) is out of reach of this method.
- **Mining needs a distinguished output.** Cones are grown backwards from an element, so a
  repeating structure with no element that drives something outside itself — a symmetric
  lattice, say — is not a candidate.
- **Shape equality is not proven isomorphism.** Two cones are called the same shape when their
  cone-local colour refinement agrees. That is a strong test and it has no known counterexample
  in this codebase, but it is not a canonical-labelling proof, and every report says so. What
  settles a match is the measured truth table.
- **Only cones over the same external nets are merged.** A full adder is merged because its sum
  cone and its carry cone both read `a`, `b` and `ci`. Two outputs whose cones read different
  nets stay two findings, so a block like "correct sum, carry taken from a two-input AND" is
  reported as its parts rather than as one wrong adder.
- **Behaviour is measured exhaustively only up to five inputs.** Beyond that the truth table is
  sampled, is labelled as not exhaustive, and a match against a chip is correspondingly weaker.
- **Occurrences inside a chip expansion are reported but not replaceable.** They belong to
  another sheet; editing them from here would change every instance of that chip. The count of
  replaceable occurrences is reported separately from the count of occurrences.

## Rendering

- **Crossings are counted, not eliminated.** The router guarantees axis-aligned segments, a
  perpendicular exit and entry at every port, stable channel offsets for parallel runs and bus
  lanes — and it reports how many crossings remain. It does not solve a general
  crossing-minimisation problem.
- **Auto-placement is used only when the authored positions are unusable** (missing or
  overlapping), and the report counts what moved. Placement is by dataflow level with a
  barycentre row order; it is deterministic, not aesthetic.
- **Text below a legible size is skipped**, and the frame reports what it culled. At the zoom
  where a whole CPU fits on screen, a 7-unit port name is a smudge, and drawing ten thousand
  of them costs frames to produce noise.
- **Rasterisation is not measured headlessly.** The benchmark times geometry and draw calls;
  the editor reports its own frame times.

## Scale and environment

- **A million-component sheet needs more heap than the default V8 limit allows** (about 8.75 GiB
  against 1.91 GiB on the reference machine, at a measured marginal cost of 4.6 KiB per
  component). The benchmark refuses that size with the arithmetic and the flag that would raise
  the limit, rather than being killed. Per-component cost was flat across every size that ran,
  so this is an environment limit, not an algorithmic one.
- **The server runs jobs in 20 ms slices on a timer** so a long optimization does not starve
  HTTP; an optimization requested directly over the API with a budget above 5 000 evaluations is
  refused with a hint to enqueue it as a job instead.
- **The editor keeps an undo stack of documents per hierarchy layer**, capped at 200 entries.
  Serialising a very large sheet per edit costs milliseconds at a thousand components and more
  above that.

## Interface

- **The interface is a browser page served by the engine's own server.** There is no native
  window, no offline packaged app and no mobile layout. Double-clicking to launch means
  `npm start`, which serves the editor and opens it.
- **Files live on the server**, in its `data/` directory. A browser import reads a file from
  your machine; a save writes to the server. There is no cloud storage and no collaboration.
- **No automated browser test clicks the canvas.** Everything that can go wrong when a user
  edits a circuit lives in `src/ui/` — typed, DOM-free and tested headlessly — and the served
  modules are checked to parse and to be delivered as executable JavaScript with the engine
  reachable as ES modules. What is *not* covered is the DOM layer itself: no test in this
  repository drives a real browser, so a layout or event-handling defect in `public/` would be
  found by a person using it, not by `npm test`.

## Documentation and process

- **Worked examples are checked, not asserted.** `circuitforge doctor --full` runs all 24 and
  compares 19 declared readings against their independent derivations. An example whose reading
  cannot be derived independently is not in the set.
- **The reference designs are regression tests.** 19 chips, and flattening counts that must not
  drift (ripple adder 40 elements, ALU 106, RAM 119, CPU8 375).
