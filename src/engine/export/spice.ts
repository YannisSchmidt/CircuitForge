/**
 * SPICE-like netlist export.
 *
 * Honesty first: this is *our* netlist in a SPICE-shaped syntax, written to be
 * read and diffed. It is deliberately restricted to the classic element subset
 * (R, C, L, D, Q, M, V, I, E, G, F, H, X) with `name node node … value` lines, so
 * that a hand check in another simulator is possible for analog subcircuits —
 * but it is not advertised as a validated ngspice input: digital primitives are
 * exported as their own `.model`-less X/behavioural lines, and the parameters are
 * the ones the engine actually used, with the comments naming each slot.
 *
 * Every element line ends with `; <component path>` so a line in this file can be
 * traced back to the schematic.
 */

import type { FlatNetlist } from '../sim/netlist.js';
import { Kind, KIND_NAME } from '../core/kinds.js';
import { layoutOf } from '../sim/paramslots.js';
import { ENGINE_VERSION } from '../util/version.js';
import { nodeLabel } from './schematic.js';

/** Classic SPICE letter for each element kind ('' when there is none). */
const LETTER: Partial<Record<number, string>> = {
  [Kind.Resistor]: 'R',
  [Kind.Capacitor]: 'C',
  [Kind.Inductor]: 'L',
  [Kind.Potentiometer]: 'R',
  [Kind.NtcThermistor]: 'R',
  [Kind.Varistor]: 'R',
  [Kind.Diode]: 'D',
  [Kind.Led]: 'D',
  [Kind.Photodiode]: 'D',
  [Kind.Bjt]: 'Q',
  [Kind.Mosfet]: 'M',
  [Kind.Jfet]: 'J',
  [Kind.VoltageSource]: 'V',
  [Kind.CurrentSource]: 'I',
  [Kind.NoiseSource]: 'V',
  [Kind.Vcvs]: 'E',
  [Kind.Vccs]: 'G',
  [Kind.Ccvs]: 'H',
  [Kind.Cccs]: 'F',
  [Kind.Switch]: 'S',
  [Kind.Transformer]: 'K',
};

/** Slot names that double as SPICE value parameters. */
const VALUE_SLOT: Partial<Record<number, string>> = {
  [Kind.Resistor]: 'r',
  [Kind.Capacitor]: 'c',
  [Kind.Inductor]: 'l',
  [Kind.Potentiometer]: 'r',
  [Kind.NtcThermistor]: 'r',
  [Kind.Varistor]: 'r',
  [Kind.VoltageSource]: 'dc',
  [Kind.CurrentSource]: 'dc',
  [Kind.NoiseSource]: 'dc',
};

export interface SpiceExportOptions {
  /** Include a header comment block (engine, counts, fingerprint). */
  header?: boolean;
  /** Keep the per-element parameter comments. */
  comments?: boolean;
  title?: string;
}

export function exportSpiceNetlist(nl: FlatNetlist, options: SpiceExportOptions = {}): string {
  const header = options.header ?? true;
  const comments = options.comments ?? true;
  const out: string[] = [];
  if (header) {
    out.push(`* CircuitForge netlist — ${options.title ?? nl.name}`);
    out.push(`* engine ${ENGINE_VERSION} · fingerprint ${nl.fingerprint}`);
    out.push(`* ${nl.elementCount} elements · ${nl.nodeCount} nodes · ${nl.branchCount} branches · flattened in ${nl.flattenMs} ms`);
    out.push('* This file mirrors the netlist the simulator ran. Digital primitives are');
    out.push('* exported as behavioural entries; see docs/FORMAT.md for the mapping.');
  }
  out.push('.circuit');
  for (const port of nl.ports) {
    out.push(`.port ${port.name} ${nodeLabel(nl, port.node)} ${port.direction}`);
  }

  let counter = new Map<string, number>();
  for (let e = 0; e < nl.elementCount; e++) {
    const kind = nl.kind[e];
    const letter = LETTER[kind];
    const name = KIND_NAME[kind] ?? `KIND_${kind}`;
    const prefix = letter ?? 'X';
    const seq = (counter.get(prefix) ?? 0) + 1;
    counter.set(prefix, seq);
    const nodes = nodeList(nl, e);
    const value = netlistValue(nl, e, kind);
    const path = nl.instIndex[e] >= 0 && nl.instIndex[e] < nl.instances.length ? nl.instances[nl.instIndex[e]].path : `el${e}`;
    const model = nl.modelIndex[e] >= 0 ? ` m=${nl.modelIndex[e]}` : '';
    if (letter) {
      out.push(`${prefix}${seq} ${nodes.join(' ')} ${value}${model}${comments ? ` ; ${path}` : ''}`);
    } else {
      // A digital primitive: no classic letter exists, so it stays explicit
      // rather than pretending to be something it is not.
      out.push(`X${seq} ${nodes.join(' ')} ${name}${comments ? ` ; ${path}` : ''}`);
    }
    if (comments && !letter) {
      const layout = layoutOf(kind);
      if (layout) {
        const base = nl.paramOffset[e];
        const slots = Object.entries(layout.slots)
          .filter(([, slot]) => nl.params[base + slot] !== 0)
          .map(([slotName, slot]) => `${slotName}=${format(nl.params[base + slot])}`);
        if (slots.length) out.push(`*   ${slots.join(' ')}`);
      }
    }
  }
  out.push('.end');
  return `${out.join('\n')}\n`;
}

function nodeList(nl: FlatNetlist, e: number): string[] {
  const n = nl.nodeCountPerElement[e];
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(nodeLabel(nl, nl.nodes[e * 16 + k]));
  return out;
}

function netlistValue(nl: FlatNetlist, e: number, kind: number): string {
  const layout = layoutOf(kind);
  const slotName = VALUE_SLOT[kind];
  if (layout && slotName !== undefined) {
    const slot = layout.slots[slotName];
    if (slot !== undefined) return format(nl.params[nl.paramOffset[e] + slot]);
  }
  const gate = layout?.slots['fn'];
  if (gate !== undefined) return `fn=${nl.params[nl.paramOffset[e] + gate]}`;
  return '0';
}

function format(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-3)) return v.toExponential(6);
  return String(Number(v.toPrecision(8)));
}
