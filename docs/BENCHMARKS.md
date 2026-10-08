# Benchmarks

## Why the engine benchmarks itself

A simulator that quotes numbers about circuits has to be able to quote numbers about itself,
or "which part should be optimised next" is a matter of opinion. `circuitforge benchmark`
measures the engine, prints what it measured with the environment it ran in, and reports what
it could not measure.

```bash
circuitforge benchmark --suite quick              # a few seconds
circuitforge benchmark --suite full               # every group, about two and a half minutes
circuitforge benchmark --suite scaling --size 10 --size 1000 --size 10000 --size 100000
circuitforge benchmark --suite stress             # 10 … 1 000 000 by decades
circuitforge benchmark --suite quick --repeats 3 --json
```

Suites and groups: `quick`, `full`, `scaling`, `stress`; groups `logic`, `hierarchy`,
`electrical`, `io`, `optim`, `validate`, `instruments`, `profile`, `gpu`, `render`.

## Method

- **Throughput is counted units over the best repeat.** Never an estimate, never a mean that
  hides a slow first run, and the unit is printed with the number (`element-evaluations/s`,
  `flattened elements/s`, `nodes/s`, `accepted steps/s`, `blocks/s`, `draw ops/s`).
- **Memory is a heap delta around the timed work** (`process.memoryUsage().heapUsed`, or
  `performance.memory.usedJSHeapSize` in a browser that exposes it). A heap delta is not a
  footprint: it includes garbage the collector has not reclaimed, and the report says so. A
  negative delta means the collector ran mid-measurement, and that is printed rather than
  clamped to zero.
- **Repeats** are configurable; the report records the seed, the repeats and the sizes under
  `reproducibility`, so a number can be reproduced from the report alone.
- **The profiler is part of the suite.** One phase of a `full` run switches on the engine's own
  instrumentation and reports where the time went — netlist build, logic evaluation, sparse
  solve, transient stepping — with percentages re-normalised by the sum of self times so they
  add to 100 %.
- **Rendering is measured as far as a headless process honestly can**: the layout pass and the
  draw pass (drawing operations issued, SVG bytes written). Rasterisation is not timed,
  because there is no surface to rasterise onto; the case says so instead of quoting a frame
  rate it never observed.
- **The GPU is probed, not benchmarked.** The report carries the probe result
  (`backend: none`, `enabled: false`) and the measured probe time, and claims no speedup.
- **Exponential notation** is used below 1e-3 so small numbers stay readable, and every case
  prints what it did in `what`.

## Refusing a workload that does not fit

The scaling sweep measures the marginal heap cost per component between two sizes that ran,
multiplies by the requested size, applies a safety factor of 2, and refuses the size when the
result would exceed 60 % of the process's heap ceiling. The refusal is a pure function
(`heapRefusal`) so it can be tested with numbers, and the report prints the arithmetic:

> Would need roughly 8.75 GiB of heap against a 1.91 GiB limit in this process, at a measured
> marginal cost of 4.6 KiB per component (×2 safety factor). Raise the limit with
> `node --max-old-space-size=<MiB>`.

The estimate uses the **marginal** cost, not the absolute heap delta: at 10 gates the fixed
overhead of the library, the project and the collector is about 340 KiB, which an absolute
estimate reads as 34 KiB per component and which then refuses sizes that fit comfortably.
A refusal also states that this is an environment limit, not an algorithmic one, when the
per-component cost was flat across every size that ran.

Raising `--max-old-space-size` past the machine's RAM does not help: on a 3.94 GiB box,
`--max-old-space-size=6144` gets the process killed by the OOM killer with no output at all.
Refusing with numbers beats dying silently.

## Reference machine

2 cores (Intel Xeon @ 2.60 GHz), 3.94 GiB RAM, V8 heap ceiling 1.91 GiB by default, node
22.22.3, no GPU compute backend. Every number below was measured there and is reproducible
with the command shown.

## Results

| Case | Result |
|---|---|
| `logic.settle.100` | 3.18 ms, 16.09 M element-evaluations/s (100 elements, 19 levels, 512 vectors) |
| `logic.settle.1000` | 25.74 ms, 15.54 M element-evaluations/s |
| `hierarchy.flatten.100` | 4.84 ms, 103.4 k flattened elements/s |
| `hierarchy.flatten.1000` | 32.75 ms, 152.7 k flattened elements/s, `expandedTransistors` reported |
| `electrical.dc.1000` | 28.54 ms, 70.1 k nodes/s (2002 unknowns, 1 iteration, residual 0) |
| `electrical.transient.100` | 41.74 ms, 2.4 k accepted steps/s |
| `io.roundtrip.100` | 1.99 ms |
| `io.roundtrip.1000` | 17.94 ms, 337 kB of JSON, 20.8 MB/s |
| `io.project` | 3.93 ms (19 chips, 168 kB) |
| `optim.search` | 374–455 ms, ~1 k evaluations/s (415 evaluations, 415 distinct, 1 on the front) |
| `validate.full_adder` | 2.11 ms |
| `instruments.fft.16384` | 2.22 ms, 14.78 M samples/s, round-trip error 7.77e-16 |
| `render.layout.100` | 18.01 ms, 5.5 k blocks/s |
| `render.layout.1000` | 119.49 ms, 8.4 k blocks/s |
| `render.draw.100` | 22.58 ms, 578 k draw ops/s, 1.74 MB of SVG |
| `render.draw.1000` | 181.91 ms, 702 k draw ops/s, 16.8 MB of SVG |
| `gpu.probe` | ~2 µs, `backend=none`, `enabled=false` |

## Scaling

`--suite scaling --repeats 1`, all four phases linear in the number of components:

| Components | Build | Flatten | Logic settle | IO round trip | Heap |
|---|---|---|---|---|---|
| 10 | 0.47 ms | 5.8 ms | 8.7 ms | 3.9 ms | +341 KiB |
| 1 000 | 14 ms | 18.7 ms | 30.2 ms | 31.6 ms | +5.13 MiB |
| 10 000 | 79 ms | 125 ms | 70 ms | 192 ms | — |
| 100 000 | 700 ms | 1.12 s | 665 ms | 1.92 s | — |
| 1 000 000 | refused: 8.75 GiB needed against a 1.91 GiB ceiling | | | | |

Building 10 000 components used to take 22.62 s. Three quadratic scans were found by this
table and removed — reference allocation rebuilt a set of every reference in use on each add,
rewiring a pin disconnected and rescanned every net, and pruning empty nets scanned every port
of every net — bringing it to 79 ms, a 286× improvement, and making the per-component cost
flat from 10 to 100 000.

## Stress

`--suite stress` runs the same phases across 10, 100, 1 000, 10 000, 100 000 and 1 000 000
components and reports simulation time, memory, events per second and serialisation time per
decade, with refusals where the environment cannot fit the work. It is the suite that found
the quadratic build.

## What these numbers are not

- Not a comparison against another simulator. Nothing here was measured on the same workload
  in another tool, so no ratio is claimed.
- Not frame rates. Rasterisation is not measured headlessly.
- Not a GPU result. There is no compute backend in this build.
- Not portable. They are one machine's numbers, printed with that machine's identity so a
  reader can tell whether they apply.
