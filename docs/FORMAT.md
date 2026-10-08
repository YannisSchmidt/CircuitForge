# Formats

Every file this engine writes is JSON with a `format` string and a `version` number, so a
reader can refuse a file it does not understand instead of misreading it.

| Format string | Version | Written by |
|---|---|---|
| `circuitforge.circuit` | `SCHEMA_VERSION = 1` | `circuitToDocument` |
| `circuitforge.project` | `SCHEMA_VERSION = 1` | `projectToDocument` |
| `circuitforge.schematic` | `SCHEMA_VERSION = 1` | the three export levels |
| `circuitforge.jobqueue` | `1` | the job queue checkpoint |

`ENGINE_VERSION` (currently `1.0.0`) is recorded separately in reports, benchmarks and
exports, because the engine version and the file schema version change at different rates.
Both live in `src/engine/util/version.ts` and must be imported from there, never from the
barrel, to keep the module graph acyclic.

## Circuit document

```jsonc
{
  "format": "circuitforge.circuit",
  "version": 1,
  "engine": "1.0.0",
  "name": "FULL_ADDER",
  "components": [
    {
      "id": 1,              // stable within the document
      "spec": "xor_gate",   // library type id
      "ref": "U1",          // reference designator, unique on the sheet
      "x": 0, "y": 0,       // sheet units
      "rotation": 0,        // 0 | 90 | 180 | 270
      "bits": 1,            // vector multiplier: this is `bits` physical copies
      "params": { "inputs": 2 },
      "chip": null          // chip id when the component is a chip instance
      // optional: mirrorX, mirrorY, bitOrder, label, locked, touched, meta
    }
  ],
  "nets":   [ { "id": 1, "name": "a", "width": 1, "class": "signal",
                "ports": [ { "component": 1, "pin": "IN1" } ] } ],
  "ports":  [ { "id": 1, "name": "A", "direction": "input", "width": 1, "net": 1 } ],
  "meta":   { }
}
```

Sheet units are the units positions are authored in. The library draws symbols in a smaller
"symbol" space where a gate body spans −1…1, and the renderer's `SYMBOL_SCALE` is 10 sheet
units per symbol unit — the spacing the reference designs were laid out on.

Loading returns `{ circuit, diagnostics }`. Unknown component types, duplicate references
and width mismatches are reported as diagnostics with engine codes rather than thrown, so a
partially valid file still loads and the reader is told exactly what was wrong.

## Project document

```jsonc
{
  "format": "circuitforge.project",
  "version": 1,
  "name": "laboratory",
  "chips": [
    {
      "id": "full_adder", "name": "Full Adder", "version": "1.0.0",
      "description": "…",
      "ports":  [ { "name": "A", "direction": "input", "width": 1 } ],
      "params": [ { "id": "bits", "kind": "number", "default": 1 } ],
      "metrics": { },
      "circuit": { /* a circuit document */ }
    }
  ],
  "sheet": { /* a circuit document, optional */ }
}
```

The 19-chip reference project serialises to 462 KiB. The editor adds two fields of its own
when it saves — `openSheet` (the sheet being edited, which may be a chip implementation
rather than the project's own) and `breadcrumb` — so that reopening a file restores what
the user was looking at.

## Job queue checkpoint

```jsonc
{
  "version": 1,
  "savedAt": "…",
  "engineVersion": "1.0.0",
  "counter": 7,
  "jobs": [
    {
      "id": "optimize-ab12cd34-3", "kind": "optimize", "name": "…",
      "state": "paused",            // queued | running | paused | done | failed | cancelled | interrupted
      "priority": 0,
      "createdAt": "…", "startedAt": "…", "finishedAt": null, "pausedMs": 0,
      "steps": 412,
      "progress": {
        "tested": 412, "rejected": 380, "remaining": 88, "fraction": 0.82,
        "best": { "label": "delay", "value": 1.5e-9, "unit": "s" },
        "elapsedMs": 421, "cpuMs": 402, "etaMs": 90, "ratePerSecond": 978, "ramMB": 61
      },
      "spec": { },                  // what the job was asked to do
      "checkpoint": { },            // enough state to continue
      "checkpointAt": "…",
      "result": null, "error": null, "summary": null
    }
  ],
  "history": [ ]
}
```

Checkpoints are written every `autoSaveMs` (2 s on the server) and every `autoSaveSteps`,
and on shutdown. On start, `restore()` reloads jobs and history and reports which jobs were
interrupted — the CLI prints `Previous job detected… Resume? [Y/N]` and the Jobs dock shows
the same choice with a Resume button per job. A job whose checkpoint is missing or whose
engine version differs is reported as not resumable rather than resumed into an
inconsistent state.

## Flat netlist (in memory)

Not a file format, but the structure every level simulates from, and worth documenting
because reports quote its indices:

- `kind[e]`, `model[e]`, `paramOffset[e]` — one row per element, parameters addressed as
  `params[paramOffset[e] + SLOT.x]` with `MODEL_STRIDE = 48`;
- `elementNodes(nl, e)` for the nodes an element touches, `nodeNameAt(nl, n)` for a net's
  name, `nodeNet[n]` for flat node indices — these three are the safe lookups;
- `instances[i]` with `elementStart`, `elementCount`, `path`, `ref`, `depth` for
  provenance, populated when `metadata: true`;
- `expandedGates`, `gatesLeftIdeal` and `expandedTransistors` say what a request to expand
  gates actually did — see [SIMULATION.md](SIMULATION.md) for the two conditions and the
  `CF6012`/`CF6013` diagnostics that report them;
- `groundNode` is 0 by convention; `hasGroundReference` says whether the design declares
  one, and code that needs to know must ask that rather than assume;
- buses are addressed as `netId * 4096 + lane`.

## SPICE

`exportSpiceNetlist(netlist, options)` writes the flattened netlist, not the sheet: a chip
instance becomes the elements inside it, which is the point of exporting. The header carries
the engine version, the netlist fingerprint, and the element, node and branch counts.
Digital primitives are written as behavioural entries; the mapping is per kind and is listed
in the file's own comments so a reader of the netlist does not have to guess what a line
means.

## Versioning

A schema change that a reader must act on increments `SCHEMA_VERSION`. Additive fields do
not, and readers are written to ignore fields they do not know. A file whose `version` is
newer than the reader's schema is refused with a diagnostic naming both numbers.
