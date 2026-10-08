/**
 * Bill of materials.
 *
 * Two shapes, because two different people read it:
 *
 *   aggregated — one line per (type, parameter set): quantity, reference
 *                designators, unit parameters. This is the purchasing list.
 *   detailed   — one line per physical component with its hierarchical path,
 *                position and parameters. This is the assembly list.
 *
 * Quantities are *physical*: vector instances (`bits = 4`) count as four, and
 * gates that were expanded into transistors can be counted both ways
 * (`includeExpandedDevices`) because a real board would carry the transistors.
 * The source of every number is the netlist that was simulated — nothing here is
 * estimated.
 */

import type { FlatNetlist } from '../sim/netlist.js';
import type { Circuit } from '../core/circuit.js';
import type { Library } from '../core/library.js';
import { KIND_NAME } from '../core/kinds.js';
import type { ParamValue } from '../core/library.js';
import { ENGINE_VERSION } from '../util/version.js';

/** One physical component in a BOM line. */
export interface BomItem {
  /**
   * How to name this component: the hierarchical path when it differs from the
   * reference designator. Two blocks on the same sheet can both contain a `U3`,
   * so the path — not the local ref — is what identifies a component here.
   */
  id: string;
  ref: string;
  path: string;
}

export interface BomLine {
  type: string;
  typeName: string;
  /** How many physical components this line covers. */
  quantity: number;
  /** The physical components, in netlist order. */
  items: BomItem[];
  /** The parameter set shared by these instances (aggregated) — or this one's. */
  params: Record<string, ParamValue>;
  /** Flattened/electrical: how many netlist elements these components produced. */
  elements?: number;
  /** Element kinds produced (electrical detail). */
  kinds?: string[];
}

export interface Bom {
  name: string;
  generatedAt: string;
  engine: string;
  fingerprint: string;
  /** Level the BOM was taken from: 'hierarchical' | 'flattened' | 'electrical'. */
  source: string;
  aggregated: BomLine[];
  detailed: BomLine[];
  totals: {
    distinctTypes: number;
    physicalComponents: number;
    elements: number;
    /** Element counts by kind name (only when taken from a netlist). */
    byKind?: Record<string, number>;
  };
  notes: string[];
}

export interface BomOptions {
  /** Which document the BOM describes (provenance only). */
  source?: string;
  /** Count the elements a component lowered to (always on for netlists). */
  includeElements?: boolean;
}

/** BOM of a netlist: physical quantities, expanded vector instances, real paths. */
export function buildBomFromNetlist(nl: FlatNetlist, options: BomOptions = {}): Bom {
  const detailed: BomLine[] = [];
  const byKey = new Map<string, BomLine>();
  const byKind: Record<string, number> = {};

  for (const inst of nl.instances) {
    if (inst.elementCount === 0 && inst.depth === 0 && inst.chipRef) continue; // a block that produced nothing
    const physical = Math.max(1, inst.bits);
    const kinds = new Set<string>();
    for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) {
      const name = KIND_NAME[nl.kind[e]] ?? `KIND_${nl.kind[e]}`;
      kinds.add(name);
      byKind[name] = (byKind[name] ?? 0) + 1;
    }
    const params: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(inst.params)) {
      if (k.startsWith('__')) continue; // internal bookkeeping
      params[k] = v;
    }
    const line: BomLine = {
      type: inst.chipRef ?? inst.specId,
      typeName: inst.chipRef ?? inst.specId,
      quantity: physical,
      items: [{ id: inst.path, ref: inst.ref, path: inst.path }],
      params,
      elements: options.includeElements === false ? undefined : inst.elementCount,
      kinds: kinds.size ? [...kinds].sort() : undefined,
    };
    detailed.push(line);

    const key = bomKey(line);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      existing.items.push(...line.items);
      existing.elements = (existing.elements ?? 0) + (line.elements ?? 0);
      for (const k of line.kinds ?? []) {
        if (!existing.kinds?.includes(k)) (existing.kinds ??= []).push(k);
      }
      existing.kinds?.sort();
    } else {
      byKey.set(key, { ...line, items: [...line.items], kinds: line.kinds ? [...line.kinds] : undefined });
    }
  }

  const aggregated = [...byKey.values()].sort((a, b) => (b.quantity - a.quantity) || a.type.localeCompare(b.type));
  for (const line of aggregated) line.typeName = line.type;
  return {
    name: nl.name,
    generatedAt: new Date().toISOString(),
    engine: ENGINE_VERSION,
    fingerprint: nl.fingerprint,
    source: options.source ?? 'flattened netlist',
    aggregated,
    detailed,
    totals: {
      distinctTypes: aggregated.length,
      physicalComponents: detailed.reduce((sum, l) => sum + l.quantity, 0),
      elements: nl.elementCount,
      byKind: Object.keys(byKind).length ? byKind : undefined,
    },
    notes: [
      'Quantities are physical: a vector instance (bits = N) counts as N components.',
      'Parameters are the values the instances were built with (SI base units).',
      `Element counts come from the flattened netlist — the same data the simulator ran (engine ${ENGINE_VERSION}).`,
    ],
  };
}

function bomKey(line: BomLine): string {
  const params = Object.entries(line.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');
  return `${line.type}|${params}`;
}

/**
 * BOM of a sheet as drawn: chip instances count as one block each, with their
 * `bits` multiplier applied (a 4-bit register instance is four physical parts, as
 * the schematic says). This is the "what do I order to build this subsystem" BOM,
 * in contrast to `buildBomFromNetlist`, which expands everything.
 */
export function buildBomFromCircuit(circuit: Circuit, lib: Library, options: BomOptions = {}): Bom {
  const detailed: BomLine[] = [];
  const byKey = new Map<string, BomLine>();
  let elements = 0;
  for (const inst of circuit.allComponents()) {
    const spec = lib.get(inst.specId);
    const type = inst.chipRef ?? inst.specId;
    const physical = Math.max(1, inst.bits ?? 1);
    const params: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(inst.params)) if (!k.startsWith('__')) params[k] = v;
    const line: BomLine = {
      type,
      typeName: inst.chipRef ?? spec?.name ?? inst.specId,
      quantity: physical,
      items: [{ id: inst.ref, ref: inst.ref, path: inst.ref }],
      params,
    };
    detailed.push(line);
    const key = bomKey(line);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += physical;
      existing.items.push(...line.items);
    } else {
      byKey.set(key, { ...line, items: [...line.items] });
    }
  }
  const aggregated = [...byKey.values()].sort((a, b) => b.quantity - a.quantity || a.type.localeCompare(b.type));
  return {
    name: circuit.name,
    generatedAt: new Date().toISOString(),
    engine: ENGINE_VERSION,
    fingerprint: circuit.fingerprint(),
    source: options.source ?? 'schematic (as drawn)',
    aggregated,
    detailed,
    totals: { distinctTypes: aggregated.length, physicalComponents: detailed.reduce((sum, l) => sum + l.quantity, 0), elements },
    notes: [
      'Blocks are not expanded: a chip instance is one line. Use the netlist BOM to see what a chip is built from.',
      'Quantities are physical: a vector instance (bits = N) counts as N components.',
    ],
  };
}

export function bomToCsv(bom: Bom, which: 'aggregated' | 'detailed' = 'aggregated'): string {
  const lines = which === 'aggregated' ? bom.aggregated : bom.detailed;
  const rows: string[][] = [['quantity', 'type', 'components', 'elements', 'kinds', 'params']];
  for (const line of lines) {
    rows.push([
      String(line.quantity),
      line.type,
      line.items.map((i) => i.id).join(' '),
      line.elements === undefined ? '' : String(line.elements),
      (line.kinds ?? []).join(' '),
      JSON.stringify(line.params),
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

export function bomToText(bom: Bom): string {
  const out: string[] = [];
  out.push(`BILL OF MATERIALS — ${bom.name}`);
  out.push(`engine ${bom.engine} · fingerprint ${bom.fingerprint} · source: ${bom.source}`);
  out.push(`${bom.totals.distinctTypes} distinct types · ${bom.totals.physicalComponents} physical components · ${bom.totals.elements} netlist elements`);
  out.push('');
  const width = Math.max(4, ...bom.aggregated.map((l) => l.type.length));
  out.push(`${'QTY'.padStart(5)}  ${'TYPE'.padEnd(width)}  COMPONENTS`);
  for (const line of bom.aggregated) {
    const ids = line.items.map((i) => i.id);
    const shown = ids.length > 8 ? `${ids.slice(0, 8).join(' ')} … (+${ids.length - 8})` : ids.join(' ');
    out.push(`${String(line.quantity).padStart(5)}  ${line.type.padEnd(width)}  ${shown}`);
  }
  out.push('');
  for (const note of bom.notes) out.push(`note: ${note}`);
  return `${out.join('\n')}\n`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
