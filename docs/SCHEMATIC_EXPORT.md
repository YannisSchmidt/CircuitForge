# Schematic export

Three levels of schematic export, one renderer, and an exact-reconstruction path back.

## The three levels

| Level | What it contains | Use it for |
|---|---|---|
| `hierarchical` | the sheet as drawn: chip instances are blocks, with path, chip id, parameters, position, rotation, bits | editing, review, the GUI's default view |
| `flattened` | chips expanded, logical primitives kept: every instance with its path and depth | checking what a design really contains, logic-level review |
| `electrical` | every element the solver sees, including gates expanded to transistors | cross-checking against the netlist, SPICE-level review |

All three produce the same `SchematicExport` shape, so a consumer written against one
reads the others.

```ts
interface SchematicExport {
  level: 'hierarchical' | 'flattened' | 'electrical';
  format: 'circuitforge.schematic';
  version: number;            // SCHEMA_VERSION
  engine: string;             // ENGINE_VERSION
  name: string;
  generatedAt: string;
  fingerprint: string;        // the circuit's own fingerprint
  counts: { components, nets, ports, instances?, elements?, nodes?, maxDepth?, byKind? };
  components: ExportedComponent[];
  nets: ExportedNet[];
  ports: ExportedPort[];
  ground?: string;
  diagnostics: Array<{ code, severity, message }>;
  notes: string[];
}
```

Each `ExportedComponent` carries `path`, `ref`, `type`, `typeName`, `value`, `x`, `y`,
`rotation`, `bits`, `depth`, `chip`, `params`, and — at the flattened and electrical
levels — the `kinds`, `models` and `elements` it lowers to, plus `mirrorX`, `mirrorY` and
`label`. Each `ExportedNet` carries `name`, `width`, the connections as `"REF.PIN"`
strings, and at the flattened levels the `node` and `lane` it occupies. Each
`ExportedPort` carries `name`, `direction`, `width` and the `net` it is attached to.

The `notes` field states what the level does and does not expand, so a reader cannot
mistake a hierarchical export for a complete one.

## Measured sizes

For the reference CPU8 with a resistor and a source attached:

| Level | Components | Elements |
|---|---|---|
| hierarchical | 4 | — |
| flattened | 474 | 377 |

The hierarchical export is what a person reviews; the flattened one is what an analysis
tool consumes.

## Reconstruction

`circuitToDocument(circuit)` and `circuitFromDocument(doc, lib, chips)` round-trip a sheet
exactly: positions, rotations, mirrors, bit widths, bit order, parameters, references,
nets, net classes, ports and per-component metadata. Loading returns
`{ circuit, diagnostics }`, and the diagnostics are the ones worth reading — a document
that references a component type not in the library loads with a warning naming it, rather
than silently dropping the component.

The round trip is fingerprint-stable: exporting, saving, loading and re-exporting produces
the same fingerprint. The test suite checks this on the 19-chip reference project
(462 KiB) and on the CPU8 sheet (`e8e3808bcefc381daffa94b2599810f4`).

## The sheet picture

`render.renderCircuitToSvg(circuit, lib, chips, options)` lays a sheet out and draws it as
a standalone SVG. The layout is built from a `SchematicExport`, which is why all three
levels render for free:

- blocks come from the library's own symbols and pin positions, not from a renderer's idea
  of what a gate looks like;
- chip ports are projected onto the top and bottom edges (inputs above, outputs below) when
  `portSides: 'top-bottom'`, which is the block style this project was asked for — the
  layout reports which projection it applied;
- wires are orthogonal polylines with a stub out of each port, one branch per load, with
  per-wire channel offsets so parallel runs separate and bus lanes so a wide net reads as a
  ribbon;
- positions are kept as authored unless they are unusable (missing or overlapping), in
  which case blocks are placed by dataflow level and `stats.autoPlaced` says how many moved.

The same `DrawContext` has three backends: `CanvasContext` for the editor, `SvgContext` for
export, and `NullContext` for measuring the draw pass without drawing. A picture on screen
and a picture in a file are therefore produced by one code path.

## Bill of materials

`buildBomFromCircuit(circuit, lib)` produces aggregated and detailed lines with reference,
value, footprint, part number and count, and `circuitforge export --format bom` writes it.
The aggregated form is what a purchaser reads; the detailed form keeps every reference so
a line can be traced back to the sheet.

## CLI

```bash
circuitforge export --chip cpu8 --format schematic --level flattened --out cpu8.flat.json
circuitforge export --chip cpu8 --format svg --out cpu8.svg
circuitforge export --chip cpu8 --format spice --out cpu8.cir
circuitforge export --chip cpu8 --format bom   --out cpu8.bom.json
```

The SPICE exporter writes the flattened netlist the simulator would run, with the engine
version and the netlist fingerprint in the header, so a file can be traced to the design
that produced it. Digital primitives are exported as behavioural entries, and the mapping
is documented in [FORMAT.md](FORMAT.md).
