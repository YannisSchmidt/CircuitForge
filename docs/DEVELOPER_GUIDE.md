# Developer guide

## Getting started

```bash
npm install       # typescript only; the runtime has zero dependencies
npm run build     # tsc -p tsconfig.json → dist/
npm test          # tsc -p tsconfig.test.json → dist-test/, then run the suite
npm start         # build if needed, then serve the laboratory on :8080
```

Node 20 or newer. No native modules, no bundler, no package manager beyond npm.

Scripts: `build`, `watch`, `check` (typecheck only), `test`, `test:fast` (skip the
typecheck), `bench`, `examples`, `start`, `serve`, `cli`.

## Project shape

- `src/engine/` — the engine. It must stay loadable in a browser, so **no static
  `import` of a Node builtin anywhere under `src/`**. Where a builtin is genuinely
  needed (`node:v8` for the heap ceiling, `node:fs` for a file job store) it is fetched
  with `process.getBuiltinModule('node:…')` inside the function that uses it, never at
  module scope.
- `bin/circuitforge.js` — the CLI, plain JavaScript ESM and deliberately outside the
  tsconfig `include`, which is why it *may* import `node:*` statically. It loads the
  compiled engine from `dist/` and can build it first if it is missing.
- `src/server/` — the HTTP server and JSON API.
- `src/ui/` — the editor state machine and the command registry. Typed and tested, with
  no DOM in it: everything that can go wrong when a user edits a circuit goes wrong here,
  which is why it is not in the browser layer.
- `public/` — the interface: `index.html`, `styles.css` and five ES modules that import
  the engine from `/engine/index.js` as served by the same server.
- `tests/` — one file per area, all registered in `tests/run.ts`. `tests/framework.ts`
  provides `suite(name)`, `test(name, fn)`, `assert`, `assertEqual`, `assertClose`
  (absolute tolerance), `assertThrows` and `TestRng`.
- `docs/` — the documents listed in the README.
- `data/`, `devtests/`, `dist/`, `dist-test/`, `node_modules/` are not tracked.

## Conventions that matter

**Errors carry codes.** Every failure is a diagnostic with a `CFxxxx` code, a severity and
a message; `fail(code, message, extra)` throws an `EngineError` that carries it. Ranges:
`CF3xxx` circuit and ERC, `CF4xxx` chips, `CF5xxx` simulation and solvers, `CF6xxx`/`CF7xxx`
validation, `CF8xxx` analysis, `CF9xxx` io and formats. The CLI, the API and the console
dock all print the code, so a user can search for it.

**Reports say what they did not measure.** An objective that a tier never scored is `null`
and prints as `not measured`. A benchmark case that cannot run is reported with a reason,
not skipped silently. A workload that would not fit in memory is refused with the
arithmetic behind the refusal.

**Never claim an unscoped superlative.** `OPTIMAL`, `FASTEST` and `REALISTIC` appear only
with the scope attached: constraints, search space, method, candidate count, simulation
level and ranking criteria.

**Determinism is a feature.** Seeded RNGs everywhere (`new Rng(seed)`), no reliance on
object key order for anything reported, canonical forms before hashing, and layouts that
route the same sheet the same way every time. A test asserts the render fingerprint is
stable across two runs of the same layout.

**Complexity is watched.** Sheet construction, flattening, logic evaluation and
serialisation are linear in the number of components and are covered by a scale test
(20 000 components build in under 20 s, 100 000 flatten and settle). Three quadratic
scans were found by the scaling benchmark and removed: reference allocation kept a set of
every reference in use, rewiring a pin scanned every net, and pruning empty nets scanned
every port per net. Building 10 000 components went from 22.6 s to 79 ms.

## Adding a component model

1. Write a `ComponentSpec` in `src/engine/core/primitives.ts` (or
   `primitives-semi.ts`): id, name, category, description, pins with directions and symbol
   positions, parameters with kinds, defaults, units and ranges, `refPrefix`, `spicePrefix`,
   the symbol shapes, `support` (which levels it runs at) and the **model card**.
2. The model card is not optional: family, version, claims (each with a phenomenon, an
   accuracy class, what is computed and the validity range), the equations implemented, the
   parameters that influence it with units and meanings, the limitations (always non-empty)
   and the references. `weakestCardAccuracy` derives the spec's overall class from the
   claims, so a spec cannot claim more than its weakest claim.
3. Register it in `createDefaultLibrary()`.
4. Lower it to elements in the flattener, and give it a device model in the solver if it
   runs at level 1 or 2.
5. Add tests: the DC behaviour against a hand-derived value, the accuracy class, and the
   model card's completeness. `circuitforge doctor` refuses a library entry without a card.

## Adding a benchmark case

`src/engine/bench/index.ts`. A case is `runCase(id, group, title, ctx, size, body)` where
the body returns `{ what, sizeUnit, run, units?, rateUnit?, metrics?, notes?, after? }`.

- `run` is timed and called once per repeat; throughput is **counted units over the best
  repeat**, never an estimate.
- `after` runs once, outside the repeats, for readings that only exist once the work has
  happened (convergence, accepted steps, search scores).
- Anything not measured goes in `notes` with the reason. The suite prints them.
- Use `heapRefusal(size, bytesPerComponent, ceiling, safety, fraction)` — the pure function
  behind the sweep's memory guard — when a size might not fit. It takes the **marginal**
  heap cost between two sizes that ran; the absolute delta over-refuses, because fixed
  overhead (340 KiB at 10 gates) reads as 34 KiB per component.

## Debugging

- `circuitforge doctor --full` runs 15 self-checks including every worked example against
  the readings it declares. It is the first thing to run when something looks wrong.
- `CIRCUITFORGE_DEBUG=1` or `--stack` prints stack traces instead of one-line messages.
- The engine's own profiler is a singleton: `profiler.enable()`, `profiler.reset()`,
  `profiler.begin(name)` returning a handle whose `.end(units)` records throughput,
  `.count()` for counters, `.report()` and `.format()`. The benchmark's `profile` group
  turns it on and reports where the time went, re-normalised by the sum of self times so
  the phases add to 100 %.
- In the editor, the Console dock prints every engine diagnostic with its code, and the
  status bar shows the sheet, the zoom, the weakest accuracy class on the sheet and
  whether anything is unsaved.

## Testing checklist for a change

1. `npm run build` clean — never hide `tsc` output.
2. `npm test` green (380 tests).
3. If the change touches a solver, a model or a report: add a test that asserts a
   hand-derived number, not a snapshot of whatever the code produced.
4. If it touches performance: `circuitforge benchmark --suite scaling --size 1000
   --size 10000 --size 100000` and check the phases are still linear.
5. If it touches the interface: `npm start`, and drive the change by hand — the suite
   covers the editor's logic, not the DOM.
