# User guide

Two ways in: the graphical laboratory and the command line. Both run the same engine, so a
number produced in one is a number the other would produce.

## Starting

```bash
npm install
npm start
```

The editor opens at `http://localhost:8080`. It starts with the FULL_ADDER reference design
on the sheet and the reference library — 19 chip definitions — loaded, so there is
something to look at and something to open immediately.

```bash
node bin/circuitforge.js help      # every verb
node bin/circuitforge.js doctor    # 15 self-checks
```

## The window

```
┌ File Edit View Circuit Simulate Analyze Optimize Jobs Window Help ─ engine badge ┐
├ New Open Save Export │ Undo Redo Rotate Delete │ ▶ Run Step DC ∿ Stop │ Fit + − Grid │ breadcrumb │ level ERC Analyze Optimize ┤
├────────────┬──────────────────────────────────────────────┬───────────────────────┤
│ Components │                                              │ Inspector │ Nets │ Model │
│ Chips      │                  CIRCUIT                     │                               │
│ Examples   │                                              │                               │
├────────────┴──────────────────────────────────────────────┴───────────────────────┤
│ Simulation │ Oscilloscope │ Analysis │ Jobs │ Console                              │
├───────────────────────────────────────────────────────────────────────────────────┤
│ ● idle │ sheet summary │ accuracy │ zoom │ cursor │ engine                        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

The left panel browses what can be placed: the 53 component types grouped by category with
their declared accuracy, the chip definitions, and the 24 worked examples. The right panel
inspects whatever is selected. The dock holds simulation results, the oscilloscope, the
analyzer, the job queue and the console.

## Drawing a circuit

1. **Place.** Click a component in the left panel to arm it, then click the sheet. Shift-click
   places several. Esc cancels.
2. **Wire.** Click a port, move, click another port. The preview follows the cursor with the
   same orthogonal routing the finished wire will use. Clicking empty space abandons the wire.
   Alt-click a port to disconnect it.
3. **Move.** Drag a component; drag empty space to box-select; middle-drag, right-drag or
   space-drag to pan; scroll to zoom around the cursor. `F` fits the sheet.
4. **Rotate / delete.** `R`, `Shift+R`, `Delete`. Arrow keys nudge by 2 units, `Shift`+arrow
   by a grid step.
5. **Ports.** `P` adds a circuit port — a sheet input or output, which is what makes the sheet
   usable as a chip.

Colours are states, not decoration: green is a determined high, slate a determined low, amber
an unknown (X), and a net with no driver on the sheet or with more than one is drawn in the
undriven or contested colour the ERC would report.

## Hierarchy

Double-click a chip block to open its implementation. The breadcrumb above the sheet shows
where you are; click a crumb to jump out. A primitive has nothing underneath and the console
says so rather than doing nothing silently.

Edits inside a chip are **local** until you commit them: *Circuit ▸ Update chip definition*
writes them back as a new version (minor by default), after an ERC that refuses to commit a
broken sheet. That is deliberate — silently changing every instance of a chip in a design
because someone dragged a gate inside one of them is not a surprise a tool should give.

*Circuit ▸ Load reference library* adds the 19 reference designs (NOT, NAND, XOR, half and
full adder, ripple adder, mux 2 and 4, mux tree, decoders, priority encoder, register,
counter, ALU, RAM, ROM, CPU8). *File ▸ Save sheet as chip…* makes your own.

## Simulating

The Simulation dock runs the levels you tick:

- **L0 logic** settles the four-state logic and colours every wire. Click an input's value to
  cycle it 0 → 1 → X. The truth table is exhaustive up to five inputs (the engine evaluates
  32 vectors per settle) and says so when it is truncated. *Step tick* advances registers;
  *Clock* drives a net whose name contains `clk` at 2 Hz.
- **L1 electrical** solves the DC operating point and prints node voltages, element power
  (signed: absorbed is positive) and the convergence — iterations, worst voltage error, gmin
  used, and whether the matrix was singular. A solve that did not converge says so in red and
  the voltages shown are labelled as the last iterate.
- **L3 thermal** solves the lumped RC network and badges hot components on the sheet.
- **Expand gates to transistors** permits the flatten to lower a gate into its CMOS network, but
  a gate is only lowered when its own `style` parameter (Inspector) is not the default `ideal` —
  set it to `cmos_static`. If nothing qualified, the console says so with `CF6013` instead of
  leaving a ticked box to imply a transistor-level netlist; when gates were expanded, `CF6012`
  counts them. An expanded gate has no level-0 behaviour, so the truth table goes empty by
  design: it is now a device network, solved electrically.
- **Transient** (*Simulate ▸ Transient sweep…*) runs a sweep and sends it to the oscilloscope.

## The oscilloscope

Add channels by measure (voltage, current, power, temperature, logic) and target (a node name
or an instance path), set `tstop` and the sample count, press **Capture**. Drag to zoom,
double-click to reset, shift-drag to place cursors. Each channel reports mean, RMS, min, max,
peak-to-peak, frequency, period and duty, with the method the frequency measurement used.
**Spectrum** runs an FFT with a Hann window and reports the peak and the THD. **CSV** and
**Text report** export the capture, which includes the convergence of the run that produced
it — a waveform from a solve that did not converge is a picture of a guess, and it is labelled
as one.

Right-clicking a wire offers *Probe this net in the oscilloscope*.

## Analyzing

*Analyze ▸ Analyze circuit* fills the Analysis dock: a summary, the critical path with its
actual gate chain and the timing model that produced it named, zones (slow, hot, power), every
finding with its code and detail, and a per-type table. Buttons select the components on the
critical path and the ones the analyzer reports as unused.

A critical path of 0 ns is reported as a **lower bound** when the elements declare no delay,
not as "this design is infinitely fast".

*Analyze ▸ Find repeated subcircuits* (`Ctrl+Shift+M`) mines the sheet: each card shows the
block's shape, how many times it occurs, how many of those occurrences are on this sheet, what
it computes (a truth table measured at level 0, and whether the measurement was exhaustive),
and which library chip computes the same thing. **Replace with…** is enabled only when the
match is identical on every measured row and at least one occurrence is on this sheet; a block
that differs from a chip is shown with the number of rows that differ and cannot be
substituted, because substituting it would change what the circuit computes. A block contained
in a larger reported block is labelled *sub-block of* — a full adder really does contain two
half adders, and replacing the smaller one first would break the larger. Replacement is an
edit, so `Ctrl+Z` gives the sheet back.

The search describes the sheet as it was when it ran. Edit the sheet afterwards and the
patterns are stale — the interface refuses to replace from a stale search and asks you to run
it again rather than rewriting gates by index into a circuit that has moved on.

*Circuit ▸ Run ERC* lists the electrical rules diagnostics with their codes.

## Optimizing

*Optimize ▸ Optimize design…* takes a specification (`adder`, `mux`, `comparator`,
`alu_slice`, `and_not`, `majority`, `subtractor`), parameters as JSON, a profile, a budget, a
population and a seed. The search runs in the frame loop, so the interface stays responsive
and the status bar says it is working.

*Optimize ▸ Synthesize design…* is the same pipeline taken end to end, and it is what the
specification calls reverse engineering: you give a behavioural contract instead of a circuit,
and the program generates architectures, searches them, details the winner, simulates it,
validates it and saves it as a chip you can then place and open.

The result dialog reports the best candidate — components, depth, delay, power, temperature,
stability risk — the ranked candidates, and the scope: specification, profile, budget,
population, seed and which tiers ran. Objectives a tier never scored print as *not measured*.
**Why this design?** answers only with measured deltas against the runner-up.

*Optimize ▸ Reverse-engineer a spec…* runs the whole path: specification → architectures →
search → simulation → validation → saved chip, printing each stage.

*Jobs ▸ Run benchmark…* measures the engine itself, either as a server job (progress, pause,
resume, cancel, survives a closed tab) or in the browser tab.

## Jobs

The Jobs dock enqueues optimizations, validations, simulations, analyses, exports and
benchmarks. Each row shows state, a progress bar, tested/rejected counts, the best value found
so far, the ETA and the elapsed time, with pause, resume, cancel and result buttons. Jobs
checkpoint to disk every two seconds; after a crash the dock shows **Previous job detected**
with a Resume button per interrupted job, and the CLI asks
`Previous job detected… Resume? [Y/N]`.

## Saving, opening, exporting

- *File ▸ Save* / *Save as…* write a `.cfproj.json` into the server's `data/` directory.
- *File ▸ Open…* lists what is on the server; *Import circuit document…* reads a file from
  your machine.
- *File ▸ Export…* offers SPICE, circuit document, BOM, schematic (at any of the three
  levels), an SVG picture of the sheet, and the analysis or validation reports.

## Keyboard

`Ctrl+Z` / `Ctrl+Shift+Z` undo and redo (one drag is one step), `Ctrl+S` save, `Ctrl+A` select
all, `Delete` remove, `R` rotate, `F` fit, `G` grid, `P` add port, `Enter` open selection,
`Backspace` up a level, `Ctrl+Enter` run logic, `Ctrl+Shift+Enter` step a tick, `Ctrl+.` stop,
`Ctrl+Shift+E` ERC, `Ctrl+Shift+A` analyze, `Ctrl+Shift+O` optimize, `Ctrl+Shift+J` jobs,
`Ctrl+`` console. Every shortcut is also a menu item with a handler behind it; the command
registry is what keeps them from disagreeing.

## Command line

```bash
circuitforge list                                # the library and its accuracy classes
circuitforge examples --check                    # every worked example against its stated readings
circuitforge simulate --chip cpu8 --level 0
circuitforge analyze  --chip ripple_adder --param bits=8
circuitforge validate --chip ripple_adder --spec adder --param bits=4
circuitforge optimize --spec and_not --profile FASTEST --budget 400 --why
circuitforge synth    --spec mux --param selectBits=2 --profile SMALLEST
circuitforge export   --chip cpu8 --format spice
circuitforge benchmark --suite scaling --size 1000 --size 10000 --size 100000
circuitforge jobs                                # queue state, resume interrupted work
```

Add `--json` for machine-readable output and `--quiet` to suppress progress.
