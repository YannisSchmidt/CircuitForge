/**
 * Schematic export at three levels of detail.
 *
 * The specification asks for three levels, and they answer three different
 * questions, so they are three different documents rather than one document with
 * a verbosity flag:
 *
 *   hierarchical  — the sheet *as drawn*: chip instances are single blocks with
 *                   their parameters. This is what a designer reviews.
 *   flattened     — chips expanded: every block becomes the components it is
 *                   made of, each carrying its hierarchical path. This is what an
 *                   integration engineer debugs.
 *   electrical    — the netlist that was actually simulated: every element with
 *                   its kind, nodes, named physical parameters and model
 *                   reference, including the transistors that gates were
 *                   expanded into. This is what a simulator ran.
 *
 * All three carry the engine version, the structural fingerprint and the
 * component/net/element counts, so an exported sheet can always be traced back to
 * the design and the build that produced it. Nothing is invented: a field the
 * source does not know is absent, not filled with a plausible default.
 */

import type { Circuit, CircuitPort } from '../core/circuit.js';
import type { Library, ParamValue } from '../core/library.js';
import { Kind, KIND_NAME } from '../core/kinds.js';
import type { FlatNetlist } from '../sim/netlist.js';
import { elementNodes, elementName } from '../sim/netlist.js';
import { layoutOf } from '../sim/paramslots.js';
import type { Diagnostic } from '../core/labels.js';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../util/version.js';

export type ExportLevel = 'hierarchical' | 'flattened' | 'electrical';

export interface ExportedComponent {
  /** Hierarchical identity, e.g. "U1.U3". Stable for a given design. */
  path: string;
  ref: string;
  /** Library type id (chip id for a block at the hierarchical level). */
  type: string;
  typeName: string;
  /** Value column: the dominant parameter, formatted. */
  value?: string;
  x: number;
  y: number;
  rotation: number;
  /** Vector multiplier: this component is `bits` physical copies. */
  bits: number;
  depth: number;
  /** Chip this block instantiates (hierarchical level). */
  chip?: string;
  /** Parameters as declared (SI base units). */
  params: Record<string, ParamValue>;
  /** Electrical level: the element kinds this component lowered to. */
  kinds?: string[];
  /** Electrical level: model table indices used. */
  models?: number[];
  /** Flattened/electrical: how many netlist elements this component produced. */
  elements?: number;
  /** Rotation/mirror as authored (electrical level keeps the parent's). */
  mirrorX?: boolean;
  mirrorY?: boolean;
  label?: string;
}

export interface ExportedNet {
  name: string;
  /** Bus width, when the source knows it. */
  width?: number;
  /** Connections as "REF.PIN" (hierarchical) or "path.pin" (flattened). */
  connections: string[];
  /** Electrical level: node index in the simulated netlist. */
  node?: number;
  lane?: number;
  class?: string;
}

export interface ExportedPort {
  name: string;
  direction: string;
  width: number;
  net?: string;
}

export interface SchematicExport {
  level: ExportLevel;
  format: 'circuitforge.schematic';
  version: number;
  engine: string;
  name: string;
  generatedAt: string;
  fingerprint: string;
  counts: {
    components: number;
    nets: number;
    ports: number;
    /** Flattened/electrical only. */
    instances?: number;
    elements?: number;
    nodes?: number;
    maxDepth?: number;
    byKind?: Record<string, number>;
  };
  components: ExportedComponent[];
  nets: ExportedNet[];
  ports: ExportedPort[];
  /** Ground node label, when the source has one. */
  ground?: string;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  notes: string[];
}

const NOTES: Record<ExportLevel, string> = {
  hierarchical:
    'Chip instances are exported as blocks (path, chip, parameters). Expanding them is the job of the flattened export.',
  flattened:
    'Chips are expanded; every component carries its hierarchical path. Node connections are the flattened netlist nodes, which include vector lanes and self-generated supply rails.',
  electrical:
    'This is the netlist that was simulated: element kinds, nodes and physical parameters after gate expansion and vector expansion. Coordinates are inherited from the parent instance.',
};

function diagnosticsOf(source: { diagnostics?: Diagnostic[] }): Array<{ code: string; severity: string; message: string }> {
  return (source.diagnostics ?? []).map((d) => ({ code: d.code, severity: String(d.severity), message: d.message }));
}

/** The value column of a component: the parameter that defines it, formatted. */
function valueOf(params: Record<string, ParamValue>): string | undefined {
  const order = ['r', 'c', 'l', 'v', 'i', 'vdc', 'freq', 'amplitude', 'value', 'ratio', 'gain', 'gm', 'beta', 'vth', 'width', 'length', 'bits', 'words'];
  for (const key of order) {
    const v = params[key];
    if (v === undefined || v === '' || v === null) continue;
    return typeof v === 'number' ? formatNumber(v) : String(v);
  }
  return undefined;
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-3)) return v.toExponential(6);
  return String(Number(v.toPrecision(6)));
}

// ---------------------------------------------------------------------------
// Level 1 — hierarchical (the sheet as drawn)
// ---------------------------------------------------------------------------

export function exportSchematicHierarchical(circuit: Circuit, lib: Library): SchematicExport {
  const components: ExportedComponent[] = circuit.allComponents().map((inst) => {
    const spec = lib.get(inst.specId);
    const chip = inst.chipRef;
    return {
      path: inst.ref,
      ref: inst.ref,
      type: chip ?? inst.specId,
      typeName: chip ? `${chip.toUpperCase()}` : (spec?.name ?? inst.specId),
      value: valueOf(inst.params),
      x: inst.x,
      y: inst.y,
      rotation: inst.rotation,
      bits: inst.bits ?? 1,
      depth: 0,
      chip,
      params: { ...inst.params },
      mirrorX: inst.mirrorX,
      mirrorY: inst.mirrorY,
      label: inst.label,
    };
  });

  const pinRefs = new Map<number, string[]>();
  for (const net of circuit.allNets()) {
    pinRefs.set(
      net.id,
      net.ports.map((p) => `${circuit.getComponent(p.component)?.ref ?? `#${p.component}`}.${p.pin}`),
    );
  }

  return {
    level: 'hierarchical',
    format: 'circuitforge.schematic',
    version: SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    name: circuit.name,
    generatedAt: new Date().toISOString(),
    fingerprint: circuit.fingerprint(),
    counts: {
      components: components.length,
      nets: circuit.netCount(),
      ports: circuit.allPorts().length,
    },
    components,
    nets: circuit.allNets().map((net) => ({
      name: net.name,
      width: net.width,
      connections: pinRefs.get(net.id) ?? [],
      class: net.netClass,
    })),
    // `net` is part of the documented format and the flattened export fills it: a
    // port whose net is not named cannot be re-attached by an importer, and cannot
    // be told apart from a sheet input by a renderer.
    ports: circuit.allPorts().map((p: CircuitPort) => ({
      name: p.name,
      direction: p.direction,
      width: p.width,
      net: circuit.getNet(p.net)?.name,
    })),
    diagnostics: [],
    notes: [NOTES.hierarchical],
  };
}

// ---------------------------------------------------------------------------
// Level 2 — flattened (chips expanded, logical primitives kept)
// ---------------------------------------------------------------------------

export function exportSchematicFlattened(nl: FlatNetlist): SchematicExport {
  const byKind: Record<string, number> = {};
  const components: ExportedComponent[] = nl.instances
    .filter((inst) => inst.elementCount > 0 || inst.depth > 0)
    .map((inst) => {
      const kinds = new Set<string>();
      const models = new Set<number>();
      const nodes = new Set<string>();
      for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) {
        const kind = nl.kind[e];
        const name = KIND_NAME[kind] ?? `KIND_${kind}`;
        kinds.add(name);
        byKind[name] = (byKind[name] ?? 0) + 1;
        if (nl.modelIndex[e] >= 0) models.add(nl.modelIndex[e]);
        for (const node of elementNodes(nl, e)) nodes.add(nodeLabel(nl, node));
      }
      return {
        path: inst.path,
        ref: inst.ref,
        type: inst.specId,
        typeName: inst.specId,
        value: valueOf(inst.params),
        x: inst.x,
        y: inst.y,
        rotation: inst.rotation,
        bits: inst.bits,
        depth: inst.depth,
        chip: inst.chipRef,
        params: { ...inst.params },
        kinds: [...kinds].sort(),
        models: models.size ? [...models].sort((a, b) => a - b) : undefined,
        elements: inst.elementCount,
      };
    });

  return {
    level: 'flattened',
    format: 'circuitforge.schematic',
    version: SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    name: nl.name,
    generatedAt: new Date().toISOString(),
    fingerprint: nl.fingerprint,
    counts: {
      components: components.length,
      nets: nl.nodeCount,
      ports: nl.ports.length,
      instances: nl.instances.length,
      elements: nl.elementCount,
      nodes: nl.nodeCount,
      maxDepth: components.reduce((m, c) => Math.max(m, c.depth), 0),
      byKind,
    },
    components,
    nets: [...Array(nl.nodeCount).keys()].map((node) => ({
      name: nodeLabel(nl, node),
      connections: connectionsOfNode(nl, node),
      node,
      lane: nl.nodeLane[node],
    })),
    ports: nl.ports.map((p) => ({ name: p.name, direction: String(p.direction), width: p.width, net: nodeLabel(nl, p.node) })),
    ground: nodeLabel(nl, nl.groundNode),
    diagnostics: diagnosticsOf(nl),
    notes: [NOTES.flattened],
  };
}

// ---------------------------------------------------------------------------
// Level 3 — electrical (what the simulator ran)
// ---------------------------------------------------------------------------

export interface ExportedElement {
  index: number;
  kind: string;
  nodes: string[];
  /** Named physical parameters (SI base units), from the kind's slot layout. */
  params: Record<string, number>;
  /** Model table index, when the element uses a device model. */
  model?: number;
  /** Branch count (voltage sources, inductors): extra unknowns in the matrix. */
  branches?: number;
  /** Provenance: which component produced this element. */
  component?: string;
}

export interface ElectricalExport extends SchematicExport {
  elements: ExportedElement[];
  /** All model keys of the netlist, in table order. */
  models: string[];
}

export function exportSchematicElectrical(nl: FlatNetlist): ElectricalExport {
  const flattened = exportSchematicFlattened(nl);
  const elements: ExportedElement[] = [];
  for (let e = 0; e < nl.elementCount; e++) {
    const kind = nl.kind[e];
    const layout = layoutOf(kind);
    const params: Record<string, number> = {};
    if (layout) {
      const base = nl.paramOffset[e];
      for (const [name, slot] of Object.entries(layout.slots)) {
        const v = nl.params[base + slot];
        if (v !== 0) params[name] = v;
      }
    }
    const inst = nl.instIndex[e];
    elements.push({
      index: e,
      kind: KIND_NAME[kind] ?? `KIND_${kind}`,
      nodes: [...elementNodes(nl, e)].map((node) => nodeLabel(nl, node)),
      params,
      model: nl.modelIndex[e] >= 0 ? nl.modelIndex[e] : undefined,
      branches: branchCount(nl, kind) || undefined,
      component: inst >= 0 && inst < nl.instances.length ? nl.instances[inst].path : undefined,
    });
  }
  return {
    ...flattened,
    level: 'electrical',
    counts: { ...flattened.counts, components: elements.length },
    components: flattened.components,
    elements,
    models: modelKeys(nl),
    notes: [NOTES.electrical],
  } as ElectricalExport;
}

/** Nodes of an element as labels (ground included). */
export function nodeLabel(nl: FlatNetlist, node: number): string {
  if (node === 0) return 'GND';
  const id = nl.nodeName[node] ?? 0;
  return id > 0 ? nl.nodeNames[id - 1] ?? `N${node}` : `N${node}`;
}

function connectionsOfNode(nl: FlatNetlist, node: number): string[] {
  const out: string[] = [];
  for (let e = 0; e < nl.elementCount; e++) {
    const nodes = elementNodes(nl, e);
    for (let k = 0; k < nodes.length; k++) {
      if (nodes[k] === node) out.push(`${elementName(nl, e)}#${k}${laneSuffix(nl, node)}`);
    }
  }
  return out;
}

function laneSuffix(nl: FlatNetlist, node: number): string {
  const lane = nl.nodeLane[node] ?? 0;
  return lane > 0 ? `[${lane}]` : '';
}

function branchCount(nl: FlatNetlist, kind: number): number {
  switch (kind) {
    case Kind.VoltageSource:
    case Kind.Inductor:
    case Kind.Vcvs:
    case Kind.Vccs:
    case Kind.Ccvs:
    case Kind.Cccs:
      return 1;
    default:
      return 0;
  }
}

function modelKeys(nl: FlatNetlist): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nl.modelCount; i++) {
    const inst = nl.instIndex.find((_, e) => nl.modelIndex[e] === i);
    const key = inst !== undefined ? `${KIND_NAME[nl.kind[inst]] ?? 'MODEL'}#${i}` : `MODEL#${i}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export function schematicToJson(sheet: SchematicExport, pretty = true): string {
  return `${JSON.stringify(sheet, null, pretty ? 2 : undefined)}\n`;
}

/** One row per component: import into a spreadsheet, or diff two exports. */
export function schematicComponentsToCsv(sheet: SchematicExport): string {
  const header = ['path', 'ref', 'type', 'typeName', 'chip', 'value', 'bits', 'depth', 'x', 'y', 'rotation', 'elements', 'kinds', 'params'];
  const rows = sheet.components.map((c) => [
    c.path,
    c.ref,
    c.type,
    c.typeName,
    c.chip ?? '',
    c.value ?? '',
    String(c.bits),
    String(c.depth),
    String(c.x),
    String(c.y),
    String(c.rotation),
    c.elements === undefined ? '' : String(c.elements),
    (c.kinds ?? []).join(' '),
    JSON.stringify(c.params),
  ]);
  return csv([header, ...rows]);
}

/** One row per net. */
export function schematicNetsToCsv(sheet: SchematicExport): string {
  return csv([['net', 'width', 'node', 'connections'], ...sheet.nets.map((n) => [n.name, n.width === undefined ? '' : String(n.width), n.node === undefined ? '' : String(n.node), n.connections.join(' ')])]);
}

function csv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
