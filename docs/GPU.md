# GPU

## The short version

**This build has no GPU compute backend.** `gpuProbe()` reports:

```json
{
  "available": false,
  "backend": "none",
  "vendor": "unknown",
  "renderer": "unknown",
  "compute": false,
  "enabled": false,
  "measuredSpeedup": 0,
  "notes": [
    "Node.js runtime: no GPU compute backend. CPU worker threads are used instead.",
    "GPU stays disabled until a benchmark measures a speed-up > 1.05x for the target task."
  ]
}
```

Every simulation, optimization and render in this build runs on the CPU. No number in any
report, benchmark or interface attributes work to a GPU, and no speedup is claimed.

## The policy that keeps it that way

A GPU claim is only made when a benchmark on a real backend measures it:

1. `gpuProbe()` reports what it can see — a backend name, whether compute is available,
   and whether the engine has enabled it.
2. `enabled` stays `false` until a benchmark measures more than **1.05×** for the task in
   question, on the hardware it ran on, with the measurement recorded in the report.
3. `measuredSpeedup` is the number that was measured, or `0`. It is never an estimate, a
   theoretical FLOP ratio, or a figure carried over from another machine.
4. The benchmark's `gpu` group prints the probe result and the measured time even when
   nothing is enabled, so the absence is visible in the report rather than absent from it.

The alternative — printing "GPU accelerated" because a backend exists somewhere, or
quoting a speedup that was never measured — is exactly the kind of claim this project's
honesty rules forbid.

## Where the drawing happens

The editor renders on a 2D canvas through the same `DrawContext` the SVG exporter uses.
The render pipeline is culled: only blocks and wires inside the viewport are visited, and
a frame reports how many it drew and how many it skipped.

Measured headlessly (geometry and draw calls, not rasterisation):

| Work | Result |
|---|---|
| Sheet layout, 100 blocks | 18 ms, 5.5 k blocks/s |
| Sheet layout, 1000 blocks | 119 ms, 8.4 k blocks/s |
| Draw pass, 100 blocks | 22.6 ms, 578 k draw ops/s, 1.7 MB of SVG |
| Draw pass, 1000 blocks | 182 ms, 702 k draw ops/s, 16.8 MB of SVG |

Rasterising those operations into pixels is **not** measured headlessly, because a
headless process has no surface to rasterise onto. The benchmark case says so explicitly
instead of quoting a frame rate it never observed; the editor reports its own frame times.

## Where a compute backend would help

If one is added, these are the workloads where it would matter, in the order the engine's
own measurements suggest:

1. **Large MNA solves.** The DC and transient solves dominate level-1 time on big sheets
   (70 k nodes/s today). A batched sparse factorisation would be the single largest win.
2. **Evolutionary search.** The optimizer scores about 1 k candidates/s, and each score is
   an independent level-0 settle — an embarrassingly parallel workload.
3. **Batched FFT.** The spectrum analyser already runs at 14.8 M samples/s single-threaded;
   a GPU matters only when many spectra are computed at once.
4. **Sheet rendering at scale.** A hundred-thousand-block sheet is currently drawn by
   culling and by skipping text below a legible size; an instanced renderer would remove
   the need for either.

## Adding a backend

`src/engine/util/platform.ts` holds the probe. A backend has to provide: a name, a
capability report, and an implementation of one of the workloads above, plus a benchmark
case that measures the same work with and without it on the same machine. Until that
benchmark exists and shows more than 1.05×, `enabled` stays false — including for a
backend that is present, loaded and working, because "it is installed" is not a
performance claim.

Node worker threads are the fallback that is actually available today: the job queue runs
jobs in slices so the HTTP server stays responsive, and a benchmark can be run as a job
rather than in the request path.
