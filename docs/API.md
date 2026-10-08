# Public API

TypeScript, ES modules, no runtime dependencies. The package exports the engine barrel:

```ts
import * as cf from 'circuitforge';          // or: from './dist/engine/index.js'
const { createDefaultLibrary, buildReferenceProject, flatten, CircuitSimulator } = cf;
```

About 424 symbols are exported from the barrel, plus two namespaces — `cf.render` (the
renderer) and `cf.ui` (the editor logic) — which are namespaced because their `Point`,
`Bounds`, `Theme`, `view`, `Editor` and `Command` vocabulary would collide with the core
types of the same name.

Versions: `VERSION`, `ENGINE_VERSION`, `SCHEMA_VERSION`, `about()`. Import version
constants from `engine/util/version.js` inside the engine, never from the barrel, to keep the
module graph acyclic.

## Core — `engine/core`

```ts
class Circuit {
  addComponent(spec, params, position: Point, opts?: { ref?, bits?, rotation?, chipRef? }): ComponentInstance
  insertComponent(inst): void
  getComponent(id): ComponentInstance | undefined
  componentCount(): number
  allComponents(): ComponentInstance[]
  forEachComponent(fn): void
  removeComponent(id): void
  removeComponents(ids: Iterable<ComponentId>): void
  moveComponent(id, x, y): void          // bumps `revision`
  rotateComponent(id, delta = 90): void  // bumps `revision`
  setParam(id, name, value): void
  setBits(id, bits): void
  setRef(id, ref): void
  createNet(name = '', width = 1): Net
  getNet(id): Net | undefined
  netCount(): number
  allNets(): Net[]
  netOf(component, pin): Net | undefined
  connect(component, pin, netId): EditResult     // attach + detach + prune
  attach(component, pin, netId): EditResult      // O(1), no detach, no prune
  detach(component, pin, netId): boolean         // targeted detach
  disconnect(component, pin?, opts?): void
  mergeNets(a, b): NetId
  pruneEmptyNets(): number
  renameNet(id, name): EditResult
  nextRef(prefix): string                        // O(1) amortised cursor
  addPort(name, direction, width?, netId?, electrical?): CircuitPort
  allPorts(): CircuitPort[]
  removePort(id): void
  pinPositions(lib, inst): Array<{ name, x, y }>
  effectivePinWidth(inst, pinWidth): number
  isDigital(lib, chips?): boolean
  erc(lib, chips?): Diagnostic[]
  fingerprint(lib?): string
  clone(): Circuit
  cloneWithNewIds(): { circuit, componentMap, netMap }
  stats(lib): CircuitStats
  revision: number                               // bumped by every structural change
}
```

`components`, `nets` and `ports` are private maps: iterate with the accessors above.

```ts
class CircuitBuilder {
  constructor(lib: Library, name: string, chips?: ChipLibrary)
  spec(spec: ComponentSpec, params?, position?, opts?): ComponentHandle
  add(specId: string, params?, position?, opts?): ComponentHandle
  net(name, width?): string
  at(handle, pin, netName, width?): this         // attach + targeted detach of the old net
  wires(list): this
  ground(position?): ComponentHandle
  port(name, direction, netName, width?): this
  addChip(chipId, params?, position?, opts?): ComponentHandle
  finish(opts?: { erc?: boolean }): Circuit
  getNet(name): Net | undefined
  diagnostics: Diagnostic[]
}

class Project {
  constructor(name: string, lib: Library, chips?: ChipLibrary)
  instantiate(b: CircuitBuilder, chipOrId, params?, position?, opts?): ComponentHandle
  saveAsChip(circuit, opts?: SaveAsChipOptions): Chip
  specOf(chipOrId): ComponentSpec
  chips: ChipLibrary
  lib: Library
  name: string
}

class Chip {
  def: ChipDefinition
  key(): string
  defaultParams(): ParamBag
  implementation(params?): Circuit      // throws for a parametric chip given no params
  implementationPins(params?): ChipPinInfo[]
  fingerprint(params?): string
  stats(params?): { components, nets, ports }
}

class ChipLibrary {
  add(chip): void; get(idOrKey): Chip | undefined; must(idOrKey): Chip
  has(idOrKey): boolean; all(): Chip[]; size(): number; remove(id): boolean
  dependentsOf(id): string[]; usesChip(id, child): boolean
  cycleCheck(parentId, childId): Diagnostic[]
}

createDefaultLibrary(): Library         // 53 specs, each with a model card and an accuracy class
buildReferenceProject(name): Project    // 19 chips, registered in .lib and .chips
makeChip(def): Chip; sanitizeChipId(name): string; bumpVersion(v, part?): string
chipProvenance(chip): Record<string, string | number>
```

Types: `ComponentSpec`, `PinSpec`, `ParamSpec`, `SymbolShape`, `SimulationSupport`,
`ModelCard`, `ModelClaim`, `Accuracy` (enum: `REALISTIC`, `APPROXIMATED`, `IDEALIZED`,
`NOT_MODELED`), `Diagnostic`, `Severity`, `CircuitPort`, `Net`, `ComponentInstance`.
Diagnostics: `diag()`, `fail(code, message, extra?)`, `EngineError`, `countBySeverity()`,
`weakerAccuracy()`, `cardAccuracy()`, `weakestCardAccuracy()`.

## Netlist and solvers — `engine/sim`

```ts
flatten(root: Circuit, lib: Library, chips: ChipLibrary, opts?: {
  expandGates?: boolean; ambient?: number; thermal?: boolean;
  maxDepth?: number; metadata?: boolean;
}): FlatNetlist

netlistStats(nl): Record<string, number | Record<string, number>>
nodeNameAt(nl, node): string
elementName(nl, element): string
elementNodes(nl, element): number[]      // not device terminals for multi-element models

class CircuitSimulator {
  constructor(nl: FlatNetlist, opts?: Partial<SolverOptions>)
  dcSolve(opts?: { quiet?: boolean }): {
    converged, iterations, worstVoltageError, worstNode, gminUsed,
    usedGminStepping, usedSourceStepping, rejectedSteps, singular, singularNodes, thermal
  }
  transient(tstop: number, requests: TransientRequest[], opts?: {
    maxSamples?, maxStep?, initialStep?, outputInterval?, skipInitialDc?
  }): TransientResult
  resetTransient(): void
  solveThermalSteadyState(): ThermalResult
  powers(): Record<number, number>       // signed: positive absorbed
  v: Float64Array                        // node voltages by node index
}

circuitStats(nl, opts?: { sim?, lib?, graph?, timing?, skipLogic?, instances? }): CircuitStatsResult
```

Solver defaults: `reltol 1e-3`, `vntol 1e-6`, `gmin 1e-12`, 200 iterations, `'be'`
integration, `trtol 7`. Node 0 is ground by convention; ask `nl.hasGroundReference` rather
than assuming. `nl.nodeNet[n]` holds flat indices. `TransientResult.values` is
`Float64Array[]`; a second `transient()` resumes from the previous end time unless
`resetTransient()` is called. `SolverOptions.ambient` is separate from `nl.ambient`.

## Analysis — `engine/analysis`

```ts
buildLogicGraph(nl): LogicGraph   // { netlist, netCount, elements, driverCount, inputs,
                                  //   outputs, netName(node), loopElements, stats, diagnostics }
class LogicVectorSim {
  constructor(graph, opts?: { loopIterations?: number })
  drive(node: number, ones: number, unknown?: number): void   // NODE INDEX, not a name
  release(node: number): void
  settle(): void                                              // returns nothing
  run(ticks?: number): void
  sample(node, lane): string | number     // 0 and 1 as numbers, X and Z as strings
  word(node): string                      // the 32-lane bit pattern
  histogram(node): { zero, one, x, z }
  planes(node): { ones, x, z }
  setVector(node, ...): void
}
analyzeCircuit(circuit, lib, chips?): {
  name, fingerprint, ms, findings[], counts, stats, instances[], specs[],
  timing, zones, constraints[], timingModel, summary, notes[], diagnostics[]
}
analyzeTiming(nl, opts?): TimingReport    // PS = 1e-12
circuitStats(nl, opts?): CircuitStatsResult
```

`graph.inputs` and `graph.outputs` are node indices; `graph.netName(i)` resolves them.
`graph.stats` is `{ gates, sequential, levels, ignoredElements, loops }`.

## Instruments — `engine/instruments`

```ts
fft(re: Float64Array, im: Float64Array, inverse = false): void
windowCoefficients(kind, n): Float64Array; WINDOWS: Record<WindowKind, WindowInfo>
coherentGainOf(w): number; enbwOf(w): number; nextPow2(n): number
amplitudeSpectrum(samples, opts): AmplitudeSpectrum
totalHarmonicDistortion(spec, fundamentalHz, sampleRate, maxOrder?): ThdResult
traceStats(trace): TraceStats          // time-weighted mean, RMS, AC RMS, min/max, pp, stddev
measureFrequency(trace, opts?): FrequencyResult
measureEdges(trace, reference?): EdgeResult
measurePhase(a, b, opts?): PhaseResult
measureDutyCycle(trace): DutyResult
measureCursors(...): CursorResult
resampleUniform(trace, t0, t1, count): Float64Array
robustLevels(values, lo?, hi?): { low, high, p1, p99 }
class Oscilloscope {
  constructor(sim: CircuitSimulator)
  addChannel(request: ChannelRequest): Channel; addChannels(requests): Channel[]
  removeChannel(i): boolean; clearChannels(): void; channels(): readonly Channel[]
  run(opts: CaptureOptions): CaptureResult
  zoom(t0, t1): void; resetZoom(): void; setCursors(t1, t2): void
  trace(i): Trace | null; traces(): Trace[]; stats(i): TraceStats | null
  frequency(i, opts?): FrequencyResult | null; edges(i, ref?): EdgeResult | null
  duty(i): DutyResult | null; phase(a, b, opts?): PhaseResult | null
  cursorsAt(i, t1?, t2?): CursorResult | null
  spectrum(i, opts?): SpectrumReading | null
  report(opts?): ScopeReport; toText(opts?): string; toCsv(opts?): string
}
class SignalGenerator { ... }  GENERATOR_PRESETS; NATIVE_WAVEFORMS; SYNTHESISED_WAVEFORMS
CHANNEL_COLORS
```

Window ENBW and coherent gain (rectangular 1.000/1.000, Hann 0.4995/1.501, Hamming
0.5396/1.354, Blackman 0.4196/1.728, Blackman-Harris 0.3584/2.006, flat-top 0.2154/3.774).

## Optimization — `engine/optim`

```ts
buildSpecById(id, params?): DesignSpec      // adder, subtractor, comparator, alu_slice,
                                            // and_not, majority, mux
describeSpec(spec): string; planVectors(spec, opts?): VectorPlan
adderSpec(bits); muxSpec(width, selectBits); andNotSpec(width)
truthTableSeed(...); templateSeeds(spec, rng, opts?): LogicGenome[]
rippleSeed(...); prefixSeed(...); twoInputNodes(...); bitsToValues(...)
genomeKey(genome): string; canonicalize(genome): LogicGenome
evaluateCandidate(genome, spec, plan, opts?): CandidateScore
detailCandidate(genome, opts?): CandidateDetail      // hard-codes gateStyle 'cmos_static'
DEFAULT_CONSTRAINTS: DesignConstraints
class Optimizer {
  constructor(request: OptimizeRequest)     // { spec, lib, chips?, name?, profile?, weights?,
                                            //   constraints?, limits?, seed?, populationSize?,
                                            //   budget?, detailTop?, seeds?, extraSeeds? }
  run(): void                               // SYNCHRONOUS; it holds the event loop
  step(): boolean                           // one generation; honours pause and cancel
  pause(): void; resume(): void; cancel(): void
  report(): OptimizationReport
  why(): ObjectiveDelta[]                   // measured deltas against the runner-up
  buildBest(): Circuit | null
  saveBestAsChip(opts?): Chip | null
  snapshot(): unknown
}
nsga2(...); PROFILES / OPTIMIZATION_PROFILES
```

`budget` is an object (`{ evaluations?, generations?, milliseconds? }`); a bare number means
an unbounded search. `spec.behaviour(values)` takes one word per input port — wrap with
`bitsToValues`. `ObjectiveDelta` fields: `winner`, `runnerUp`, `absolute`, `relative`,
`unit`, `weighted`, `scope`, `better`.

## Validation — `engine/validate`

```ts
validateChip(chip, opts?: {
  lib?, chips?, spec?, params?, seed?, levels?, randomVectors?, repeats?,
  ambient?, vdd?, maxTemperature?, clockPeriod?
}): ValidationReport        // .totals holds counts; CheckCase.passed is a boolean
reportAccuracy(report): string
```

## Export and IO — `engine/export`, `engine/io`

```ts
exportSchematicHierarchical(circuit, lib): SchematicExport
exportSchematicFlattened(nl): SchematicExport
exportSchematicElectrical(nl): SchematicExport
exportSpiceNetlist(nl: FlatNetlist, opts?): string      // takes a NETLIST, not a circuit
buildBomFromCircuit(circuit, lib): Bom
circuitToDocument(circuit): CircuitDocument
circuitFromDocument(doc, lib, chips): { circuit, diagnostics }
projectToDocument(project): ProjectDocument
projectFromDocument(doc, lib, chips): { project, diagnostics }
```

`CIRCUIT_FORMAT` and `PROJECT_FORMAT` are strings. Document component keys: `id`, `spec`,
`ref`, `x`, `y`, `rotation`, `bits`, `params`, `chip`, plus optional `mirrorX`, `mirrorY`,
`bitOrder`, `label`, `locked`, `touched`, `meta`.

## Jobs — `engine/jobs`

```ts
class JobQueue {
  constructor(storage?: JobStorage, options?: QueueOptions)
  register(kind, factory): void; registeredKinds(): JobKind[]
  enqueue(kind, name, spec?, opts?): JobRecord
  reorder(id, index): boolean; setPriority(id, priority): boolean
  ids(): string[]; get(id): JobRecord | undefined; active(): JobRecord | null
  queued(): JobRecord[]; pending(): number; idle(): boolean
  pause(id?): boolean; resume(id): boolean; cancel(id): boolean
  requestStop(): void; tick(): boolean; pump(ms?): number
  queueProgress(): { jobs, running, queuedCount, doneCount, failedCount, cancelledCount,
                     pausedCount, ramMB, elapsedMs }
  historyEntries(limit?): HistoryEntry[]; clearHistory(): number
  save(): void; snapshot(): QueueSnapshot
  restore(): { jobs, history, interrupted }
  detectInterrupted(): Array<{ job, ageMs, resumable, description }>
  resumeInterrupted(id): boolean; forget(id): boolean
  onChange(listener): () => void
}
class MemoryStorage implements JobStorage
class FileStorage implements JobStorage     // constructor(dir)
registerDefaultTasks(queue, ctx): JobQueue  // optimize, validate, simulate, analyze, export
makeContext(project?): JobContext
queueStatusLine(q): string
```

Job kinds: `optimize`, `validate`, `benchmark`, `simulate`, `analyze`, `export`. `JobProgress`
carries `tested`, `rejected`, `remaining`, `fraction`, `best`, `elapsedMs`, `cpuMs`, `etaMs`,
`ratePerSecond`, `ramMB`.

## Rendering — `cf.render`

```ts
layoutCircuit(circuit, lib, chips?, opts?: LayoutOptions): SheetLayout
layoutExport(exported, lib, opts?, chips?): SheetLayout
renderToSvg(layout, opts: DrawOptions): { svg, stats }
renderCircuitToSvg(circuit, lib, chips?, opts?): { svg, layout, stats, view }
drawSheet(ctx: DrawContext, layout, opts): DrawStats
class SvgContext implements DrawContext { toString(): string; ops }
class CanvasContext implements DrawContext { ops; restoreAll() }
class NullContext implements DrawContext { ops, shapes, texts, paths, bounds() }
sizeCanvas(canvas, cssWidth, cssHeight, dpr?): void
view(x?, y?, scale?): ViewTransform
worldToScreen(v, p); screenToWorld(v, p); zoomAt(v, screenPoint, factor); panBy(v, dx, dy)
fitBounds(bounds, viewport, padding?): ViewTransform
visibleBounds(v, viewport); visibleNodes(layout, v, viewport); visibleWires(layout, v, viewport)
pick(layout, worldPoint, tolerance?): PickResult     // port > sheet-port > wire > node
insideNode(node, p); distanceToPolyline(p, points); distanceToSegment(p, a, b)
routeOrthogonal(from, fromSide, to, toSide, opts?): Point[]
isOrthogonal(points, tolerance?): boolean
busLanes(points, width, gap?): Point[][]
channelOf(net, from, to, modulus?): number
crossings(a, b): number; segmentsCross(p1, p2, p3, p4): boolean; countCrossings(wires, cap?)
roundedCorners(points, radius?); polylineLength(points); wiresBounds(wires)
autoPlace(nodes, nets, byId, grid): number; moveNode(node, x, y): void
needsPlacement(nodes): boolean; countOverlaps(nodes): number
rotatePoint(p, rotation); rotateSide(side, rotation)
DARK_THEME; LIGHT_THEME; THEMES; themeByName(name?); wireColor(theme, state, wire)
SYMBOL_SCALE = 10; LAYOUT = { grid, stub, laneGap, busLaneGap, nodeGap, blockRadius,
                              wireRadius, portReach, portSize, chipPortSpacing,
                              minBlockWidth, minBlockHeight }
MIN_SCALE; MAX_SCALE
emptyState(): SheetState
```

`SheetLayout.style.portSides` reports which projection was applied; `stats.autoPlaced` counts
what the auto-layout moved.

## Editor logic — `cf.ui`

```ts
class Editor {
  constructor(opts?: { lib?, chips?, project?, name?, onChange?, onLog?, undoLimit? })
  lib; chips; project; layers: EditorLayer[]
  layer; circuit; name; depth; path: string[]; canGoUp; isDirty; file; canUndo; canRedo
  selection: string[]; selectedNet: string | null; pendingWire
  toDocument(); toProjectDocument(); loadDocument(doc); newProject(name?)
  undo(); redo(); beginTransaction(); endTransaction(reason?)
  place(specId, x, y, params?, opts?): PlaceResult | null
  placeChip(chipId, x, y, params?): PlaceResult | null
  move(refs, dx, dy); moveTo(ref, x, y, grid?); moveLive(ref, x, y, grid?)
  rotate(refs, delta?); remove(refs); duplicate(refs, offset?)
  setParam(ref, name, value); setBits(ref, bits); setRef(ref, next)
  connect(refA, pinA, refB, pinB, width?): ConnectResult | null
  connectToNet(ref, pin, netName, width?); disconnect(ref, pin?)
  addPort(name, direction, width?); removePort(name)
  startWire(ref, pin); finishWire(ref, pin); cancelWire()
  select(refs, additive?); selectNet(net); clearSelection(); selectAll(); selected
  open(ref): boolean; openChip(chipId): boolean; up(): boolean; goToLevel(level)
  commitToChip(opts?): { chip, version } | null
  saveAsChip(opts?): Chip | null
  chipOf(inst): Chip | undefined; byRef(ref); byId(id)
  erc(): Diagnostic[]; loadReferenceProject(): number
  describe(): string; snapshot(): EditorSnapshot; log(line, severity?)
}
COMMANDS: Command[]; MENUS: MenuDefinition[]
commandById(id); commandsInGroup(group); menuItems(menu); paletteEntries()
keymap(): Map<string, string>
normalizeKey(event): string
```

## Benchmarks and platform — `engine/bench`, `engine/util`

```ts
runBenchmarkSuite(opts?: { suite?, repeats?, sizes?, quiet?, seed? }): Promise<BenchmarkReport>
benchmarkToText(report): string
heapRefusal(size, bytesPerComponent, ceiling, safety?, fraction?): { refuse, reason, ... }
BENCH_SUITES
detectPlatform(): PlatformInfo
platformSummary(info: PlatformInfo): string        // takes the info, returns one line
gpuProbe(): { available, backend, vendor, renderer, compute, enabled, measuredSpeedup, notes }
profiler: { enable(), disable(), reset(), begin(name) → { end(units?), count() }, report(), format() }
class Rng { constructor(seed); next(); int(n); chance(p); pick(list) }
```

## Synthesis — `engine/synthesis`

```ts
buildReferenceProject(name): Project       // 19 chips
EXAMPLES: Example[]                        // 24, each with build(lib, chips), expected[],
                                           // demonstrates[], level, category, transient?
checkExample(example, lib, chips): ExampleCheck[]
```

Reference chips: `not1`, `nand2`, `xor2`, `bus_and`, `half_adder`, `full_adder`,
`ripple_adder`, `mux2`, `mux4`, `mux_tree`, `decoder_2to4`, `decoder_3to8`,
`priority_encoder_8to3`, `register_n`, `counter_n`, `alu_n`, `ram_n`, `rom_n`, `cpu8`.

## Mining — `cf.mining`

```ts
mineSubcircuits(circuit, lib, chips?, opts?: {
  depth?, minOccurrences?, maxPatterns?, measure?, matchChips?, maxMeasuredInputs?,
  maxPatternInputs?, maxPatternSize?, coneSlack?, mergeOutputs?, ambient?
}): MiningReport

replacePatternWithChip(circuit, lib, chips, pattern, opts?: {
  chipId?, limit?
}): ReplaceResult

extractPatternAsChip(circuit, lib, chips, pattern, opts?: {
  chipId?, name?, description?, occurrence?, maxMeasuredInputs?
}): ExtractResult  // copied, ERC-checked, re-measured, then registered

miningToText(report): string
markSubBlocks(patterns): { tests: number, cutShort: boolean }
inspectCones(circuit, lib, chips?, opts?): unknown[]   // what the miner sees, for tests
adjacency(graph), refineColours(graph, adj, rounds), coneOf(...), canonicalCone(...)
```

`MiningReport.patterns[]` carries `id`, `description`, `kinds`, `size`, `inputs`, `outputs`,
`count`, `occurrences[]` (with `refs`, `paths`, `onSheet`, and the net names a replacement wires
to), `behaviour` (`rows`, `complete`, `measured`, and the `reason` when it was not), `matchedChip`
(`id`, `version`, `identical`, `differingRows`, `note`), `suggestedChip`, `subBlockOf` and
`saving` (`replaceable`, `componentsTotal`, …). `ReplaceResult` carries the rewritten `circuit`,
`replaced`, `skipped[]` with a reason each, before/after component and net counts, `diagnostics`
and `notes`. Even an explicit `chipId` override is measured against the pattern first: a near match
or an unmeasured block is refused with engine diagnostic `CF8024`; the HTTP wrapper returns `409 CF409`. `extractPatternAsChip` returns the extracted `chip`, its implementation circuit,
its measured table, `identical`, `differingRows`, diagnostics and notes. It promotes boundary nets
to ordered ports, refuses an occurrence inside another chip or a pattern with no exhaustive
measurement (the bit-parallel L0 engine exhaustively measures up to five inputs; a wider
pattern is not measured and cannot be extracted). DFF/latch patterns are also not measured:
one settle does not exercise clock transitions, and a static snapshot cannot prove equivalent
state machines. The extraction checks ERC plus every supported combinational truth-table row
**before** registration in both `ChipLibrary` and `Library`. It does not infer parameters or
metrics; the extracted chip is the fixed component-level implementation of that occurrence.
This is a level-0 equivalence check, not timing, power, device-level or thermal sign-off: re-run
those analyses after replacement when they matter.

There is deliberately no `expandGates` option here: mining reads the logic graph, and a gate
lowered to transistors is not a logic element.

## Server — `dist/server/index.js`

```ts
startServer(opts?: {
  port?, host?, publicDir?, engineDir?, dataDir?, open?, quiet?, engine?, maxBodyBytes?
}): Promise<{ url, host, port, requests(): number, close(): Promise<void> }>
```

Binds every interface by default so a preview proxy can reach it, serves `public/`, the
compiled engine under `/engine/` and `/ui/`, the documents under `/docs/`, and a JSON API
under `/api/`: `health`, `library`, `chips`, `examples`, `specs`, `profiles`, `projects`,
`project/save`, `project/open`, `simulate`, `analyze`, `mine`, `validate`, `optimize`, `synth`,
`export`, `jobs` (+ `enqueue`, `pause`, `resume`, `cancel`, `priority`, `reorder`,
`resume-interrupted`, `history`) and `benchmark`. Errors carry the engine's own code and,
where there is one, a hint.

`POST /api/mine` takes a circuit document and the miner's options, and answers with the report.
With `extract: true` it copies one on-sheet occurrence, exhaustively verifies the implementation,
and returns its `ChipDocument`, implementation document, ports, measurements and diagnostics.
The chip is registered only in the two libraries built for that request; the API is stateless, so
the client persists it by saving the returned chip or adding it to a project. With
`extract: true, replace: true`, the same request replaces the other occurrences with that new
chip and also returns the rewritten circuit document. Without extraction, `replace: true`
substitutes only identical matches — optionally `pattern`, `chip` and `limit` — and returns the
rewritten circuit document, the counts, and every skipped occurrence with its reason. Asking it
to replace a block that is *not* identical to a chip is a `409 CF409`, not a silent approximation.
An unmeasured, partial, or non-extractable block also returns 409 with the engine's reason and
hint. Because placing a chip needs that chip's component spec, the server builds the component
library and the chip library as a pair (`libraryPair`): a document-only request is answered with
the reference project's two libraries. A request that brings its own `ChipDocument[]` is loaded
through the dependency-aware project deserializer, which rebuilds runtime `Chip` objects and
registers their component specs; raw JSON objects are never inserted directly into `ChipLibrary`.
