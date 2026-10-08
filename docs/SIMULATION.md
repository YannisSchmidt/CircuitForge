# Simulation

Four levels, one netlist. Each level computes different things, says what it computes,
and declares the accuracy of the models behind it. A level that was not run reports
nothing — it never reports a plausible-looking zero.

## The netlist every level shares

`flatten(circuit, lib, chips, options)` turns a hierarchical circuit into a `FlatNetlist`:
structure-of-arrays typed buffers, one row per element, node 0 as ground by convention,
buses addressed as `netId * 4096 + lane`, device parameters deduplicated into models.
Instances keep provenance (`path`, `ref`, `depth`, `elementStart`, `elementCount`), which
is what lets a report name the component behind an element, and `metadata: true` is what
records it.

Flattening is linear in the size of the design: 100 000 components flatten in about
1.1 s on the reference machine, and the cost per component is flat from 10 to 100 000.

## Level 0 — four-state logic

`buildLogicGraph(netlist)` extracts the digital elements (gates, buffers, tristates,
muxes, demuxes, decoders, D flip-flops, D latches) and `LogicVectorSim` settles them.

- Values are 0, 1, X (unknown) and Z (floating), held as **bit planes**: one bit per
  vector, 32 vectors at a time. One `settle()` therefore evaluates 32 input
  combinations, which is why an exhaustive truth table of up to five inputs costs one
  settle.
- Settling is fixed-point iteration over dependency levels, not event scheduling. A
  combinational loop is reported through the graph's diagnostics and its elements are
  listed in `loopElements`; the values on them are the last iterate, and the report says
  so rather than pretending they settled.
- Registers latch on `run(ticks)`: settle, update register state, settle again.
- Delays are **not** part of level 0. It computes the settled value long after every
  transient has died out, and it is symmetric in time. Propagation delay lives in the
  timing analysis, which uses the delays the elements declare.
- `drive(node, ones, unknown)` and `sample(node, lane)` address nets by **node index**,
  not by name. `word(node)` returns the 32-lane bit pattern; `sample` returns one lane
  as `0`, `1`, `X` or `Z` (numbers for the first two, strings for the last two).

Measured throughput: 15.5–16.1 million element-evaluations per second.

## Level 1 — electrical

`new CircuitSimulator(netlist, options)` builds the MNA system; `dcSolve()` finds the
operating point and `transient(tstop, requests, options)` sweeps time.

- **Formulation**: modified nodal analysis. Unknowns are node voltages plus the currents
  of voltage sources and inductors. The matrix is sparse and rebuilt when the topology
  changes, not when the values do.
- **Non-linear solve**: Newton-Raphson with a gmin ladder and source stepping when a
  direct solve fails or the matrix is singular. Defaults: `reltol 1e-3`, `vntol 1e-6`,
  `gmin 1e-12`, up to 200 iterations, pivoting tolerance guarded.
- **Time integration**: trapezoidal or backward Euler (`'tr'` / `'be'`, default `'be'`),
  with `trtol 7` for error control. Non-linear devices are linearised by companion
  models each step, so an accepted step is one that met the error test; rejected steps
  are counted and reported.
- **Sampling**: by default the record is a uniform grid over the whole run
  (`tstop / (maxSamples − 1)`), so the record always covers what was asked for, while
  the solver still adapts its internal step. `outputInterval` overrides the grid.
  A second `transient()` on the same simulator resumes from the previous end time —
  call `resetTransient()` first for a fresh sweep.
- **Power is signed**: positive is absorbed, negative is delivered. `totalDissipated`
  sums absorption only, and a purely digital sheet legitimately dissipates nothing at
  this level, which is reported as `0 W` together with the count of analogue elements
  that produced it.
- **Ground**: node 0 is ground by convention; `hasGroundReference` says whether the
  design actually declares one, and a sheet without it is diagnosed (`CF3001`) rather
  than silently anchored.

Measured: 70 k nodes/s for the DC solve, 2.4 k accepted steps/s for the transient.

## Level 2 — device detail

The same solver, with device models instead of ideal elements. Gates can be **expanded**
into CMOS transistor networks, which replaces a behavioural gate with the transistors that
implement it. Expansion takes two conditions, and it is worth being precise about them
because one of them is not a solver option at all:

1. the flatten option `expandGates: true`, which permits it;
2. the gate's own `style` parameter being something other than the default `ideal` — for
   example `cmos_static` — which asks for it.

So one netlist can hold ideal gates and transistor-level gates side by side, and a request
that meets no gate is a request that did nothing. Both outcomes are reported instead of
left implicit: `CF6012` names the gates expanded and the transistors created (and how many
gates stayed ideal), and `CF6013` warns when expansion was requested and no gate qualified.
The counters are `nl.expandedGates`, `nl.gatesLeftIdeal` and `nl.expandedTransistors`. A
gate that has been lowered to transistors contributes devices and no logic element, so an
expanded netlist has no level-0 behaviour — which is why the miner flattens with expansion
off. Device equations and their validity ranges are in [PHYSICS.md](PHYSICS.md).

Level 2 is not a SPICE-compatible simulator: the models are documented subsets, each
with a card naming what is implemented and what is omitted.

## Level 3 — electro-thermal

`solveThermalSteadyState()` solves a lumped RC thermal network: one node per instance,
junction-to-case and case-to-ambient resistances, thermal mass when a sweep is run, an
ambient temperature and an optional heatsink. Power from the electrical solve drives it,
and temperature feeds back into the device parameters that declare a temperature
coefficient, so the coupling is two-way where the model declares it and one-way where it
does not.

There is no spatial gradient inside a package, no airflow model, and no package-to-package
coupling beyond the declared thermal resistances. `rthCa = 0` is refused (`CF5303`)
because it means an infinitely good heatsink, and a ramp needs `skipInitialDc: true` or
the DC solve pins it to its final value.

## Accuracy

Every model carries a card: family, version, the phenomena it claims with a class
(`REALISTIC`, `APPROXIMATED`, `IDEALIZED`, `NOT_MODELED`), what exactly is computed, the
validity range, the limitations and the references. A circuit's accuracy is the weakest
class among the models it uses, and reports print that weakest class, not the best.

## What no level does

- No transmission lines, S-parameters or distributed interconnect.
- No electromagnetic coupling between components, no crosstalk, no radiation.
- No optical emission from an LED: the electrical behaviour is modelled, the light is not.
- No manufacturing variation, no Monte Carlo mismatch, no ageing.
- No analogue behavioural scheduling: level 0 has no notion of time, level 1 has no notion
  of logic levels beyond voltages.

Each of these is listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) with the reason.
