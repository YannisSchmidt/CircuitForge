# Optimization and synthesis

## What is being optimized

A **design specification** states the behaviour: input ports, output ports, and either an
explicit contract of vectors or a `behaviour(values)` function that produces the expected
outputs for given input-port words. Seven specifications ship with the engine:

| Spec | Ports | Parameters |
|---|---|---|
| `adder` | A, B, CI → S, CO | `bits` |
| `subtractor` | A, B → D, BO | `bits` |
| `comparator` | A, B → LT, EQ, GT | `bits` |
| `alu_slice` | A, B, OP → Y, flags | `bits`, `ops` |
| `and_not` | A, B → Y | `width` |
| `majority` | A, B, C → Y | `width` |
| `mux` | D, S → Y | `width`, `selectBits` |

The contract is expanded into vectors by `planVectors`: exhaustively while the input space
is at most `exhaustiveBitLimit` (16 bits), and above that by corners plus seeded random
vectors up to `maxVectors`. A report always says how the vectors were produced, because
"validated on 512 vectors" and "validated exhaustively" are different claims.

## Objectives and profiles

Six objectives, weighted by a profile:

| Objective | Meaning | Weight in BALANCED |
|---|---|---|
| Speed | critical-path delay from the declared element delays | 40 % |
| Components | instance count | 20 % |
| Power | total dissipation, measured at tier 3 | 15 % |
| Temperature | maximum junction temperature, measured at tier 4 | 10 % |
| Stability | risk score from loops, undetermined outputs and violations | 10 % |
| Memory | footprint of the candidate's netlist | 5 % |

Profiles: `FASTEST`, `SMALLEST`, `LOW_POWER`, `LOW_TEMPERATURE`, `MOST_STABLE`,
`BALANCED`, and `CUSTOM` with explicit weights. An objective that a tier never scored is
reported as `not measured` — `power`, `temperature` and `switchEnergy` are `null` until
tiers 3 and 4 run, and the report prints them that way rather than as zero.

## Candidates and the search

A candidate is a **genome**: a list of nodes, each a two-input function over earlier nodes
or over the specification's inputs. Two-input functions are indexed
`v = f00 | f01<<1 | f10<<2 | f11<<3`, so AND = 8, NAND = 7, OR = 14, NOR = 1, XOR = 6,
XNOR = 9, BUF = 12, NOT = 3, `a & ~b` = 4, `~a & b` = 2. Genomes are canonicalized before
hashing, so structurally identical candidates share a cache entry and the search reports
how many evaluations were distinct versus cached.

The search is a seeded **NSGA-II** over that representation, seeded additionally with
architectures from a template catalogue:

- truth-table seeds (direct synthesis for small functions),
- ripple-carry adders,
- prefix adders (Kogge–Stone and friends, with the carry-in handled per architecture),
- classic two-level minimization.

With seed 5, the catalogue yields for example: `mux_2_to_1` 1 node, `mux_4_to_1` 3 nodes,
`and_not_2` 4 nodes, `adder_1` 6 nodes, `adder_2` 27 nodes (exactly 4.4 ns),
`subtractor_4` 149 nodes, `comparator_4` 170 nodes. Where no exact template exists
(`mux_8_to_1`, `adder_4`, `alu_slice_4`) the search starts from the generic seeds and says
so.

## Tiers

Candidates are filtered from cheap to expensive, so most of the budget is spent on
promising designs rather than on simulating everything fully:

| Tier | What runs | Cost |
|---|---|---|
| 0 | structural validity, loops, node/depth limits | microseconds |
| 1 | level-0 behaviour against the contract | one settle per vector batch |
| 2 | timing: critical path from declared delays | one graph pass |
| 3 | electrical: DC solve, power, switching energy | a full MNA solve |
| 4 | thermal: steady-state temperature | a thermal solve |

`detailTop` controls how many of the best candidates are taken to tiers 3–4 at the end
(0 = never). That is why a report can show `power: null` for a winner: the winner was
ranked on the tiers that ran, and the report says which those were.

## Reproducibility

Every report carries the seed, the parameters, the constraints, the profile and its
weights, the engine and schema versions, the platform summary (cores, model, runtime, GPU
probe), the candidate count, the distinct count, the Pareto front and the scores. The same
seed, budget, population and specification produce the same search. Benchmarks record the
same block, so a number in a report can be reproduced from the report alone.

## Reporting results

Two rules the reports and the interface both follow:

1. **Never an unscoped superlative.** The winner is *best found under current
   constraints*, with the specification, profile, budget, population, seed, tiers and
   ranking criteria attached. Not "optimal", not "fastest" alone.
2. **"Why this design?" answers only with measurements.** `why()` returns the deltas
   against the runner-up: which objective won, the absolute and relative difference, the
   unit, the weighted contribution and the scope. For example a run on `and_not` with
   `FASTEST` reported stability risk −100 %, delay −16.67 % and power −7.45 % against
   runner-up `cdd84b2da3aedc89`. Nothing is explained by an appeal to the algorithm's
   intent, because the intent is not a measurement.

## Reverse engineering

`circuitforge synth --spec adder --param bits=4` runs the full path: specification →
architecture candidates → search → simulation → validation → save as a chip. The chip is
validated against the specification it was synthesized for, and the validation report is
printed with its pass/fail/skip counts before the chip is offered for reuse. The GUI's
*Optimize ▸ Reverse-engineer a spec…* runs the same stages and shows each one.

## Measured performance

About 1 000 candidate evaluations per second on the reference machine (2 cores, no GPU).
A 415-evaluation search for a 2-bit multiplexer under `SMALLEST` finds the 3-component,
2 ns, depth-2 optimum and validates it 22/0/2 in under half a second. The `full` benchmark
suite reports the search's own numbers — evaluations, distinct evaluations, front size,
best candidate — under the `optim` group.

## Limits

- The search only explores architectures its genome representation can express. A design
  requiring a construct outside it (a specific clocking scheme, a tri-state bus protocol,
  an analogue feedback loop) will not be found, and the report does not claim the space
  was covered.
- Power and temperature come from tiers 3 and 4; with `detailTop: 0` they are never
  measured and are reported as such.
- The stability risk score is a declared heuristic over structural properties (loops,
  undetermined outputs, constraint violations). It is not a metastability analysis.
