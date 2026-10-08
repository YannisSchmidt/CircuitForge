/**
 * Circuit and project serialization — the one format that must round-trip
 * *exactly*.
 *
 * Two rules drive the design:
 *
 *  1. **Reconstruction is exact.** A saved circuit loaded back must produce the
 *     same structural fingerprint, the same reference designators, the same
 *     positions, rotations, parameters and connections. Nothing is
 *     "approximately" restored, nothing is renumbered. The test suite asserts
 *     `fingerprint(load(save(c))) === fingerprint(c)`.
 *
 *  2. **Loading is validated, never trusting.** A file may be old, hand-edited or
 *     written by another build. Every unknown component type, unknown pin,
 *     out-of-range parameter, duplicate id and chip cycle is reported as a
 *     diagnostic — with the offending object — instead of producing a silently
 *     different circuit.
 *
 * The documents are plain JSON: readable, diffable, greppable. Chip generators
 * are functions and cannot be serialized; a parametric chip therefore records the
 * *identity* of its generator, and the loader re-attaches the generator when the
 * build knows it (see `synthesis/generators.ts`). When it does not, the chip is
 * restored as the fixed circuit that was materialised at save time, and the
 * loader says so.
 */

import { Circuit, type CircuitMeta, type ComponentInstance } from '../core/circuit.js';
import type { ChipPort, ChipDefinition, ChipMetrics } from '../core/chip.js';
import { Chip, makeChip } from '../core/chip.js';
import type { Library, ParamBag, ParamSpec, ParamValue } from '../core/library.js';
import type { ChipLibrary } from '../core/chip.js';
import { Severity, error, info, warn, type Diagnostic } from '../core/labels.js';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../util/version.js';

export const CIRCUIT_FORMAT = 'circuitforge.circuit';
export const PROJECT_FORMAT = 'circuitforge.project';

export interface CircuitDocument {
  format: typeof CIRCUIT_FORMAT;
  version: number;
  engine: string;
  name: string;
  description: string;
  meta: CircuitMeta;
  components: ComponentDocument[];
  nets: NetDocument[];
  ports: PortDocument[];
  /** Structural fingerprint of the circuit this document was written from. */
  fingerprint: string;
}

export interface ComponentDocument {
  id: number;
  spec: string;
  ref: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  bits: number;
  chip?: string;
  params: Record<string, ParamValue>;
  mirrorX?: boolean;
  mirrorY?: boolean;
  bitOrder?: 'lsb' | 'msb';
  label?: string;
  locked?: boolean;
  touched?: string[];
  meta?: Record<string, string | number | boolean>;
}

export interface NetDocument {
  id: number;
  name: string;
  width: number;
  class?: string;
  drivenByPort?: boolean;
  /** Connections, as `[componentId, pinName]` pairs. */
  connections: Array<[number, string]>;
}

export interface PortDocument {
  id: number;
  name: string;
  direction: 'input' | 'output' | 'bidirectional';
  width: number;
  net: number;
  electrical?: 'analog' | 'digital' | 'supply' | 'ground' | 'any';
  description?: string;
}

export interface ChipDocument {
  id: string;
  name: string;
  version: string;
  description: string;
  ports: ChipPort[];
  params: ParamSpec[];
  tags: string[];
  origin?: ChipDefinition['origin'];
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  notes?: string;
  runId?: string;
  metrics?: ChipMetrics;
  /** Identity of the parametric generator, when the chip has one. */
  generatorId?: string;
  /** Chips this implementation instantiates (dependency order on load). */
  dependencies: string[];
  /** Component types this chip uses (provenance + validation on load). */
  uses: string[];
  circuit: CircuitDocument;
  fingerprint: string;
}

export interface ProjectDocument {
  format: typeof PROJECT_FORMAT;
  version: number;
  engine: string;
  name: string;
  savedAt: string;
  /** Working circuit (the sheet the user is editing), when there is one. */
  circuit?: CircuitDocument;
  /** Chips saved with the project, in dependency order. */
  chips: ChipDocument[];
  /** Free-form notes carried by the project. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Circuit → document
// ---------------------------------------------------------------------------

export function circuitToDocument(circuit: Circuit): CircuitDocument {
  return {
    format: CIRCUIT_FORMAT,
    version: SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    name: circuit.name,
    description: circuit.description,
    meta: { ...circuit.meta },
    components: circuit.allComponents().map((inst) => {
      const doc: ComponentDocument = {
        id: inst.id,
        spec: inst.specId,
        ref: inst.ref,
        x: inst.x,
        y: inst.y,
        rotation: inst.rotation,
        bits: inst.bits ?? 1,
        params: { ...inst.params },
      };
      if (inst.chipRef) doc.chip = inst.chipRef;
      if (inst.mirrorX) doc.mirrorX = true;
      if (inst.mirrorY) doc.mirrorY = true;
      if (inst.bitOrder) doc.bitOrder = inst.bitOrder;
      if (inst.label) doc.label = inst.label;
      if (inst.locked) doc.locked = true;
      if (inst.touched?.length) doc.touched = [...inst.touched];
      if (inst.meta) doc.meta = { ...inst.meta };
      return doc;
    }),
    nets: circuit.allNets().map((net) => ({
      id: net.id,
      name: net.name,
      width: net.width,
      class: net.netClass,
      drivenByPort: net.drivenByPort,
      connections: net.ports.map((p) => [p.component, p.pin] as [number, string]),
    })),
    ports: circuit.allPorts().map((port) => ({
      id: port.id,
      name: port.name,
      direction: port.direction,
      width: port.width,
      net: port.net,
      electrical: port.electrical,
      description: port.description,
    })),
    fingerprint: circuit.fingerprint(),
  };
}

export interface CircuitLoadResult {
  circuit: Circuit;
  diagnostics: Diagnostic[];
}

/**
 * Rebuild a circuit from a document.
 *
 * Connections are re-created pin by pin through the public API, so a document
 * cannot smuggle in a state the editor could not produce (for example a net whose
 * width disagrees with the pins attached to it — that becomes a CF6003).
 */
export function circuitFromDocument(doc: CircuitDocument, lib: Library, chips?: ChipLibrary): CircuitLoadResult {
  const diagnostics: Diagnostic[] = [];
  if (doc.format !== CIRCUIT_FORMAT) {
    diagnostics.push(error('CF6001', `not a circuit document: format "${String(doc.format)}"`));
    return { circuit: new Circuit(doc?.name ?? 'invalid'), diagnostics };
  }
  if (doc.version > SCHEMA_VERSION) {
    diagnostics.push(
      error('CF6001', `circuit document version ${doc.version} is newer than this build (${SCHEMA_VERSION})`, {
        hint: 'Open it with a newer CircuitForge, or export it again in the current format.',
      }),
    );
    return { circuit: new Circuit(doc.name), diagnostics };
  }

  const circuit = new Circuit(doc.name ?? 'untitled');
  circuit.description = doc.description ?? '';
  circuit.meta = { ...(doc.meta ?? {}) };

  for (const cd of doc.components ?? []) {
    const spec = lib.get(cd.spec);
    // A chip instance names a chip, not a library primitive. Dropping it because the
    // primitive library has no spec of that name loses the component *and* every net
    // that touched it — the CF6003 cascade below — so a saved hierarchy could be
    // written but never read back, and its fingerprint could not survive the round
    // trip. `flatten`, `erc` and `isDigital` resolve chips the same way: library
    // first, so a primitive that shadows a chip id keeps its primitive meaning, then
    // the project's chip library.
    const knownChip = cd.chip ?? (chips?.get(cd.spec) ? cd.spec : undefined);
    if (!spec && !knownChip) {
      diagnostics.push(
        error('CF6002', `component ${cd.ref} references unknown type "${cd.spec}"`, {
          target: { type: 'component', id: cd.id, name: cd.ref },
          hint: 'Neither the component library nor the project chips provide that type.',
        }),
      );
      continue;
    }
    const inst: ComponentInstance = {
      id: cd.id,
      specId: cd.spec,
      ref: cd.ref,
      x: cd.x ?? 0,
      y: cd.y ?? 0,
      rotation: cd.rotation ?? 0,
      params: { ...(cd.params ?? {}) },
      bits: cd.bits ?? 1,
      chipRef: cd.chip,
      mirrorX: cd.mirrorX,
      mirrorY: cd.mirrorY,
      bitOrder: cd.bitOrder,
      label: cd.label,
      locked: cd.locked,
      touched: cd.touched ? [...cd.touched] : undefined,
      meta: cd.meta ? { ...cd.meta } : undefined,
    };
    // Parameters are checked against the spec when there is one; a chip instance's
    // parameters belong to its definition, which the chip's own load already checked.
    const issues = spec ? validateLoadedParams(spec.params, inst.params) : [];
    for (const issue of issues) {
      diagnostics.push(
        error('CF6003', `${inst.ref}.${issue}`, { target: { type: 'component', id: inst.id, name: inst.ref } }),
      );
    }
    if (inst.chipRef && chips && !chips.get(inst.chipRef)) {
      diagnostics.push(
        warn('CF6005', `chip instance ${inst.ref} refers to chip "${inst.chipRef}", which is not in this project yet`, {
          target: { type: 'component', id: inst.id, name: inst.ref },
          hint: 'Chips are loaded with the project; an instance of an unsaved chip cannot be flattened.',
        }),
      );
    }
    circuit.insertComponent(inst);
  }

  for (const nd of doc.nets ?? []) {
    circuit.insertNet({
      id: nd.id,
      name: nd.name || `NET_${nd.id}`,
      width: nd.width ?? 1,
      ports: [],
      netClass: nd.class,
      drivenByPort: nd.drivenByPort,
    });
  }
  for (const nd of doc.nets ?? []) {
    for (const [component, pin] of nd.connections ?? []) {
      const inst = circuit.getComponent(component);
      if (!inst) {
        diagnostics.push(error('CF6003', `net ${nd.name} refers to component #${component}, which does not exist`, { target: { type: 'net', id: nd.id, name: nd.name } }));
        continue;
      }
      const result = circuit.attach(component, pin, nd.id);
      if (!result.ok) for (const d of result.diagnostics) diagnostics.push(d);
    }
  }

  for (const pd of doc.ports ?? []) {
    circuit.insertPort({
      id: pd.id,
      name: pd.name,
      direction: pd.direction,
      width: pd.width ?? 1,
      net: pd.net,
      electrical: pd.electrical,
      description: pd.description,
    });
  }

  // Integrity: the fingerprint in the document must match what we rebuilt.
  const rebuilt = circuit.fingerprint();
  if (doc.fingerprint && rebuilt !== doc.fingerprint) {
    diagnostics.push(
      warn('CF6004', `circuit "${circuit.name}" does not round-trip identically (fingerprint ${doc.fingerprint} → ${rebuilt})`, {
        hint: 'The file was edited or written by a different build; the circuit loaded, but it is not the original.',
      }),
    );
  }
  return { circuit, diagnostics };
}

function validateLoadedParams(specs: ParamSpec[], params: ParamBag): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    if (!(spec.name in params)) continue;
    const value = params[spec.name];
    if (spec.kind === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) out.push(`${spec.name} is not a number: ${JSON.stringify(value)}`);
      else if (spec.min !== undefined && n < spec.min) out.push(`${spec.name} = ${n} is below the minimum ${spec.min}`);
      else if (spec.max !== undefined && n > spec.max) out.push(`${spec.name} = ${n} is above the maximum ${spec.max}`);
    } else if (spec.kind === 'choice') {
      if (spec.choices && !spec.choices.includes(String(value))) {
        out.push(`${spec.name} = ${JSON.stringify(value)} is not one of ${spec.choices.join(', ')}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function chipToDocument(chip: Chip): ChipDocument {
  const deps = new Set<string>();
  const uses = new Set<string>();
  for (const inst of chip.def.circuit.allComponents()) {
    if (inst.chipRef) deps.add(inst.chipRef);
    else uses.add(inst.specId);
  }
  return {
    id: chip.def.id,
    name: chip.def.name,
    version: chip.def.version,
    description: chip.def.description,
    ports: chip.def.ports.map((p) => ({ ...p })),
    params: chip.def.params.map((p) => ({ ...p })),
    tags: [...(chip.def.tags ?? [])],
    origin: chip.def.origin,
    author: chip.def.author,
    createdAt: chip.def.createdAt,
    modifiedAt: chip.def.modifiedAt,
    notes: chip.def.notes,
    runId: chip.def.runId,
    metrics: chip.def.metrics,
    // The generator is a function: record its identity so a build that knows it
    // can re-attach it (see synthesis/generators.ts).
    generatorId: chip.def.generator ? chip.def.id : undefined,
    circuit: circuitToDocument(chip.def.circuit),
    dependencies: [...deps].sort(),
    uses: [...uses].sort(),
    fingerprint: chip.fingerprint(),
  };
}

/** Rebuild a chip from a document; `attachGenerator` re-attaches a parametric body. */
export function chipFromDocument(
  doc: ChipDocument,
  lib: Library,
  options: { attachGenerator?: (params: ParamBag) => Circuit } = {},
): { chip: Chip; diagnostics: Diagnostic[] } {
  const { circuit, diagnostics } = circuitFromDocument(doc.circuit, lib);
  const definition: Partial<ChipDefinition> & { id: string; name: string; circuit: Circuit } = {
    id: doc.id,
    name: doc.name,
    version: doc.version,
    description: doc.description,
    ports: doc.ports?.map((p) => ({ ...p })),
    params: doc.params?.map((p) => ({ ...p })) ?? [],
    circuit,
    tags: doc.tags ?? [],
    origin: doc.origin ?? 'imported',
    author: doc.author,
    createdAt: doc.createdAt,
    modifiedAt: doc.modifiedAt,
    notes: doc.notes,
    runId: doc.runId,
    metrics: doc.metrics,
    generator: options.attachGenerator,
  };
  const chip = makeChip(definition);
  if (doc.generatorId && !options.attachGenerator) {
    diagnostics.push(
      info('CF6006', `chip "${doc.id}" is parametric (generator "${doc.generatorId}") but this build cannot restore the generator: the loaded chip is the fixed implementation saved with the file`, {
        hint: 'Parametric chips of the reference library regain their generator automatically; a user-defined generator must be registered again by the program that created it.',
      }),
    );
  }
  return { chip, diagnostics };
}

export { Severity };
