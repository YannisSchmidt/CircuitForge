# Usage

Task-oriented recipes. The graphical editor is described in
[USER_GUIDE.md](USER_GUIDE.md); this file is the command line and the module API.

```bash
npm install && npm start          # the laboratory, on http://localhost:8080
node bin/circuitforge.js help     # every verb
```

## Check the installation

```bash
circuitforge doctor               # 15 self-checks
circuitforge doctor --full        # … plus all 24 worked examples against their stated readings
circuitforge version
circuitforge about
```

`doctor` verifies the runtime, the build, the library (53 models, each with a model card and
an accuracy class), the reference chip library, a DC solve against a hand-derived value
(a 12 V divider across 1 kΩ and 2 kΩ gives 7.999999995 V and 48 mW), a transient sweep with
an FFT against closed-form values (an RC low-pass at 1 kHz gives |H| 0.8545 and −32.24°),
that the transient record covers the window requested, level-0 logic (a full adder is 8 of 8),
hierarchy flattening (CPU8 → 375 elements, depth 4), serialisation round trip, the optimizer,
and the profiler.

## See what is available

```bash
circuitforge list                       # component types, pins, parameters, accuracy
circuitforge list --category semiconductor
circuitforge examples                   # the 24 worked examples
circuitforge examples --check           # run them and compare every declared reading
circuitforge examples --write examples  # write each example's artefacts to a directory
```

## Simulate

```bash
circuitforge simulate --chip full_adder --level 0
circuitforge simulate --chip ripple_adder --param bits=8 --level 0 --vectors 64
circuitforge simulate --example voltage_divider --level 1
circuitforge simulate --example rc_lowpass --level 1 --tstop 0.06
circuitforge simulate --chip cpu8 --level 0 --json
```

Level 0 prints the truth table and the settled value of every output; level 1 prints the DC
operating point with its convergence (iterations, worst voltage error, gmin used, singularity)
and the signed power of every element; level 3 adds the thermal steady state. A solve that did
not converge says so.

## Analyze

```bash
circuitforge analyze --chip cpu8
circuitforge analyze --chip alu_n --param bits=4 --verbose
```

Prints the summary, the critical path with its gate chain and the timing model named, fan-out
statistics, zones, and every finding with its code. A 0 ns critical path is labelled a lower
bound when the elements declare no delay.

## Mine

```bash
circuitforge mine --chip ripple_adder --param bits=8     # what does this design repeat?
circuitforge mine --file sheet.cfproj                    # the same, for a saved sheet
circuitforge mine --file sheet.cfproj --replace --out rewritten.json
circuitforge mine --example alu --min 4 --max-inputs 4 --json
```

Prints every block the sheet repeats: its shape, how many times it occurs, how many of those
occurrences are on this sheet, its measured truth table, and the library chip that computes the
same thing — `IDENTICAL` when every measured row agrees, or the number of rows that differ.
`--replace` substitutes the identical matches and, with `--out`, writes the rewritten sheet as a
circuit document; occurrences inside a chip expansion are skipped with the reason, because they
belong to another sheet. A near match is never substituted.

| Flag | Meaning |
|---|---|
| `--min N` | report a block only from N occurrences (2; 1 lists blocks worth chipping) |
| `--depth N` | fan-in cone depth that defines a block (3) |
| `--max-inputs N` | widest cone to consider, in external inputs (5) |
| `--max-size N` | most elements in one block (12) |
| `--max N` | cap on blocks reported, best first (24) |
| `--pattern ID` | which block `--replace` acts on |
| `--chip ID` | instantiate this chip instead of the matched one |
| `--limit N` | replace at most N occurrences |
| `--no-measure`, `--no-match` | skip the measurement, or skip comparing with the library |

## Validate

```bash
circuitforge validate --chip ripple_adder --spec adder --param bits=4
circuitforge validate --chip mux4 --spec mux --param width=4 --param selectBits=2
```

Reports pass/fail/skip counts per level (logic, electrical, timing, thermal, power, edge
cases, random vectors, stability), the fingerprint of what was validated, and the accuracy
classes of the models used. A 4-bit ripple adder against the adder contract: 22 passed, 0
failed, 2 skipped, 512 contract vectors, 12 of 12 edge cases, 200 random vectors, DC converged
over 29 nodes, power balance 0 W.

## Optimize and synthesize

```bash
circuitforge optimize --spec and_not --profile FASTEST --budget 400 --why
circuitforge optimize --spec mux --param selectBits=2 --profile SMALLEST --budget 400 --json
circuitforge synth    --spec adder --param bits=4 --profile BALANCED --budget 600
```

`--why` prints the measured deltas against the runner-up and nothing else. `synth` runs the
whole reverse-engineering path and saves the result as a validated chip. Every result is
reported as *best found under current constraints*, with the specification, profile, budget,
population, seed and tiers attached.

## Export

```bash
circuitforge export --chip cpu8 --format spice   --out cpu8.cir
circuitforge export --chip cpu8 --format json    --out cpu8.cfcircuit.json
circuitforge export --chip cpu8 --format bom     --out cpu8.bom.json
circuitforge export --chip cpu8 --format schematic --level flattened --out cpu8.flat.json
circuitforge export --chip cpu8 --format svg     --out cpu8.svg
```

Formats: `spice`, `json`, `bom`, `schematic` (at `hierarchical`, `flattened` or `electrical`
level), `svg`. The SPICE file carries the engine version and the netlist fingerprint in its
header.

## Benchmark

```bash
circuitforge benchmark --suite quick
circuitforge benchmark --suite full --repeats 2
circuitforge benchmark --suite scaling --size 1000 --size 10000 --size 100000
circuitforge benchmark --suite stress --json --quiet
```

See [BENCHMARKS.md](BENCHMARKS.md) for the method, the reference numbers and what the suite
refuses to claim.

## Jobs

```bash
circuitforge jobs                                  # queue state
circuitforge jobs --enqueue optimize --spec mux --budget 2000
circuitforge jobs --pause <id> | --resume <id> | --cancel <id>
circuitforge jobs --history
```

After a crash the CLI reports `Previous job detected… Resume? [Y/N]` and resumes from the
checkpoint on disk.

## As a module

```js
import * as cf from 'circuitforge';

const project = cf.buildReferenceProject('demo');
const circuit = project.chips.get('ripple_adder').implementation({ bits: 4 });

// level 0
const nl = cf.flatten(circuit, project.lib, project.chips, { metadata: true });
const graph = cf.buildLogicGraph(nl);
const sim = new cf.LogicVectorSim(graph);
const a = graph.inputs.map((n) => graph.netName(n));
sim.drive(graph.inputs[0], 1, 0);      // node index, not name
sim.settle();
console.log(a, graph.outputs.map((n) => sim.word(n)));

// level 1
const solver = new cf.CircuitSimulator(nl, { ambient: 25 });
const dc = solver.dcSolve({ quiet: true });
console.log(dc.converged, dc.iterations, dc.worstVoltageError);

// a picture of it
const { svg } = cf.render.renderCircuitToSvg(circuit, project.lib, project.chips, {
  viewport: { width: 1200, height: 800 },
});
```

## Conventions worth knowing

- Gate pins are `IN1…IN16` and `OUT`; a gate instance declares how many inputs it uses with
  the `inputs` parameter, and the rest are not drawn or exported.
- A DFF is `[D, CLK, RST, Q, QN]`; a mux `[I0…, S0…, Y]`; a demux or decoder
  `[IN, EN, S0…, Y0…]`; R and C are `1` and `2`; `vdc` is `+` and `-` with the parameter
  `dc`; a diode is `A` and `K`; meters are `+` and `-`, a wattmeter `V+ V- I+ I-`.
- Primitive ids: `and_gate`, `or_gate`, `xor_gate`, `nand_gate`, `nor_gate`, `xnor_gate`,
  `not_gate`, `buffer`, `tristate`, `dff`, `dlatch`, `mux`, `demux`, `logic_high`,
  `logic_low`, `resistor`, `capacitor`, `inductor`, `vdc`, `ground`, `voltmeter`, `ammeter`,
  `thermometer`, `diode`, `led`, `nmos`, `pmos`.
- Reference chip nets are lowercase (`full_adder`: `a`, `b`, `ci`, `s`, `co`) while its chip
  ports are uppercase (`A`, `B`, `CI`, `S`, `CO`).
