/**
 * Lowering: component instance → simulator elements.
 *
 * This is the single place where the *authoring* meaning of a component is
 * translated into the *execution* representation: element kind, node list, and a
 * parameter block laid out with the kind's slot table. Adding a component spec to
 * the library therefore costs one case here (plus, if it is a new physics device,
 * one element implementation) — the simulator core never changes.
 *
 * Values that a device shares with its siblings (the physics of a transistor
 * model, for instance) go into the deduplicated model table; values that are
 * per-instance (geometry, thermal node, angle) stay in the element parameter
 * block.
 */

import type { Circuit, ComponentInstance } from '../core/circuit.js';
import type { ComponentSpec, ParamBag, ParamSpec } from '../core/library.js';
import { Diagnostic, error, warn, info } from '../core/labels.js';
import { Kind } from '../core/kinds.js';
import {
  BJT_SLOTS,
  BJT_STRIDE,
  C_SLOTS,
  C_STRIDE,
  CS_SLOTS,
  CS_STRIDE,
  D_SLOTS,
  D_STRIDE,
  DFF_SLOTS,
  DFF_STRIDE,
  GATE_SLOTS,
  GATE_STRIDE,
  L_SLOTS,
  L_STRIDE,
  MOS_SLOTS,
  MOS_STRIDE,
  MUX_SLOTS,
  MUX_STRIDE,
  NODE_STRIDE,
  POT_SLOTS,
  POT_STRIDE,
  PROBE_SLOTS,
  PROBE_STRIDE,
  R_SLOTS,
  R_STRIDE,
  RELAY_SLOTS,
  RELAY_STRIDE,
  SRC_SLOTS,
  SRC_STRIDE,
  SW_SLOTS,
  SW_STRIDE,
  XFMR_SLOTS,
  XFMR_STRIDE,
} from './paramslots.js';
import { MODEL_STRIDE, ModelTable } from './model.js';
import { expandCmosGate, needsCmosExpansion, type CmosContext } from './cmos.js';
import { CONST } from '../util/units.js';

/**
 * Parse an arbitrary-waveform parameter: `"t:v"` pairs, comma or whitespace separated.
 *
 * Accepted: `0:0, 1e-3:5, 2e-3:5, 3e-3:0`. Times may carry an SI suffix (ns, us, µs,
 * ms, s) so a waveform can be written the way it is described; values may carry m, k,
 * meg. Times must be strictly increasing — a repeated time would make the source
 * value depend on which side of the pair the search came from, i.e. on the step the
 * solver happened to take.
 *
 * @returns interleaved `[t0, v0, t1, v1, …]`, or null when the text is unusable.
 */
export function parseArbitraryWaveform(text: string): Float64Array | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  const out: number[] = [];
  for (const part of parts) {
    const sep = part.indexOf(':');
    if (sep <= 0 || sep >= part.length - 1) return null;
    const t = parseSuffixed(part.slice(0, sep));
    const v = parseSuffixed(part.slice(sep + 1));
    if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
    if (out.length > 0 && !(t > out[out.length - 2])) return null;
    out.push(t, v);
  }
  return Float64Array.from(out);
}

const SI_SUFFIX: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12,
};

/** A number with an optional SI suffix, tolerating the units people actually type. */
function parseSuffixed(text: string): number {
  const s = String(text).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return NaN;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zµ]*)$/.exec(s);
  if (!match) return NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return NaN;
  const unit = match[2];
  if (!unit) return value;
  // "ms" and "us"/"µs"/"ns" are unambiguous; a bare "s" is seconds.
  const key = unit.endsWith('s') && unit.length > 1 ? unit.slice(0, -1) : unit;
  if (key === 's' || key === '') return value;
  const scale = SI_SUFFIX[key];
  return scale === undefined ? NaN : value * scale;
}

/**
 * Render a PWL table back to the parameter text `parseArbitraryWaveform` reads.
 *
 * The round trip is exact, which is what makes an arbitrary waveform exportable and
 * re-importable without losing its shape.
 */
export function formatArbitraryWaveform(table: Float64Array): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < table.length; i += 2) parts.push(`${table[i]}:${table[i + 1]}`);
  return parts.join(', ');
}

/**
 * Interpolate a PWL table at time t.
 *
 * Outside the table the first and last values are held (a generator does not restart
 * or go silent at the end of its record). The search is binary, so a long table costs
 * O(log n) per evaluation and the solver can afford one on every Newton iteration.
 */
export function evalWaveTable(table: Float64Array, t: number): number {
  const n = table.length >> 1;
  if (n === 0) return 0;
  if (n === 1 || t <= table[0]) return table[1];
  const last = (n - 1) * 2;
  if (t >= table[last]) return table[last + 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid * 2] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = table[lo * 2];
  const t1 = table[hi * 2];
  const v0 = table[lo * 2 + 1];
  const v1 = table[hi * 2 + 1];
  const span = t1 - t0;
  if (!(span > 0)) return v0;
  return v0 + ((t - t0) / span) * (v1 - v0);
}

export interface ElementSink {
  addElement(
    kind: number,
    nodes: Int32Array,
    nodeCount: number,
    paramScratch: Float64Array | null,
    opts?: { instIndex?: number; modelIndex?: number; branches?: number; stateInit?: Float64Array },
  ): number;
  registerModel(kind: number, key: string, params: Float64Array): number;
  allocInternalNode(): number;
  scratchNodeBuffer(): Int32Array;
  scratchParamBuffer(): Float64Array;
  modelScratch(): Float64Array;
  addDiagnostic(d: Diagnostic): void;
  /**
   * Marks the start/end of a gate → transistor expansion.
   *
   * The netlist counts the MOSFETs emitted between the two calls so that
   * `expandedTransistors` reports transistors the *engine* synthesised, and never
   * mixes in the ones the user placed. Without the marker the counter stayed at 0
   * even for a fully expanded netlist, and every report that quoted it was wrong.
   */
  setExpanding?(on: boolean): void;
  /**
   * Register a piecewise-linear waveform table and return its handle, or −1 when
   * the table is unusable. Optional so a test sink that never lowers an arbitrary
   * source does not have to implement it — and so a source that needs one on a sink
   * without it produces a diagnostic instead of a silent constant.
   */
  addWaveTable?(points: Float64Array): number;
  /** Thermal network construction. */
  thermalNode(cth: number, rthAmbient: number): number;
  thermalLink(a: number, b: number, rth: number): void;
  thermalSetCth(node: number, cth: number): void;
  thermalNodeForNet(netId: number): number;
}

export interface LowerContext {
  inst: ComponentInstance;
  spec: ComponentSpec;
  circuit: Circuit;
  sink: ElementSink;
  /** Net id of a pin, or -1 when unconnected. */
  netOf(inst: ComponentInstance, pinName: string): number;
  /** Global node of a pin (lane selectable for buses). */
  nodeOf(inst: ComponentInstance, pinName: string, lane?: number): number;
  /** Global node for an arbitrary (net, lane). */
  nodeForNet(netId: number, lane: number): number;
  options: {
    expandGates: boolean;
    thermal: boolean;
    ambient: number;
    maxDepth: number;
    metadata: boolean;
  };
  instanceIndex: number;
  addDiagnostic(d: Diagnostic): void;
  /** Internal supply rail for expanded gates (lazily created). */
  supplyNode(kind: 'vdd' | 'gnd', volts: number): number;
}

// ---------------------------------------------------------------------------
// Parameter access
// ---------------------------------------------------------------------------

const specParamCache = new WeakMap<ComponentSpec, Map<string, ParamSpec>>();

function specParamMap(spec: ComponentSpec): Map<string, ParamSpec> {
  let m = specParamCache.get(spec);
  if (!m) {
    m = new Map();
    for (const p of spec.params) m.set(p.name, p);
    specParamCache.set(spec, m);
  }
  return m;
}

/** Typed reader for a component's parameter bag with spec defaults. */
class P {
  constructor(
    private bag: ParamBag,
    private spec: ComponentSpec,
  ) {}

  /** Numeric parameter (falls back to the spec default, then `fallback`). */
  n(name: string, fallback = 0): number {
    const v = this.bag[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
    const def = specParamMap(this.spec).get(name);
    if (def && typeof def.default === 'number') return def.default;
    return fallback;
  }

  b(name: string, fallback = false): boolean {
    const v = this.bag[name];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === 'true' || v === '1';
    const def = specParamMap(this.spec).get(name);
    if (def) return Boolean(def.default);
    return fallback;
  }

  s(name: string, fallback = ''): string {
    const v = this.bag[name];
    if (typeof v === 'string') return v;
    if (v !== undefined && v !== null) return String(v);
    const def = specParamMap(this.spec).get(name);
    return def ? String(def.default) : fallback;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function lowerInstance(ctx: LowerContext): void {
  const { inst, spec, sink } = ctx;
  const p = new P(inst.params, spec);
  const nodes = sink.scratchNodeBuffer();
  const params = sink.scratchParamBuffer();
  const inst0 = ctx.instanceIndex;

  const resetNodes = (count: number) => {
    for (let i = 0; i < NODE_STRIDE; i++) nodes[i] = -1;
    void count;
  };
  const resetParams = (stride: number) => {
    for (let i = 0; i < stride; i++) params[i] = 0;
  };

  /** Thermal node for a device: shared through the T (thermal) pin when present. */
  const thermal = (rthJc: number, rthCa: number, cth: number): { junction: number; case_: number } => {
    if (!ctx.options.thermal) return { junction: -1, case_: -1 };
    const tNet = ctx.netOf(inst, 'T');
    const junction = sink.thermalNode(cth, 0);
    if (tNet >= 0) {
      const shared = sink.thermalNodeForNet(tNet);
      sink.thermalLink(junction, shared, Math.max(1e-6, rthJc));
      return { junction, case_: shared };
    }
    const caseNode = sink.thermalNode(0, Math.max(1e-6, rthCa));
    sink.thermalLink(junction, caseNode, Math.max(1e-6, rthJc));
    return { junction, case_: caseNode };
  };

  switch (spec.id) {
    // -----------------------------------------------------------------------
    // Passives
    // -----------------------------------------------------------------------
    case 'resistor': {
      resetNodes(2);
      resetParams(R_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '1');
      nodes[1] = ctx.nodeOf(inst, '2');
      params[R_SLOTS.mode] = 0;
      params[R_SLOTS.r] = Math.max(1e-9, p.n('r', 1e4));
      params[R_SLOTS.tc1] = p.n('tc1', 0);
      params[R_SLOTS.tc2] = p.n('tc2', 0);
      params[R_SLOTS.rth] = p.n('rth', 200);
      params[R_SLOTS.cth] = p.n('cth', 0.005);
      params[R_SLOTS.esl] = Math.max(0, p.n('esl', 0));
      params[R_SLOTS.epc] = Math.max(0, p.n('epc', 0));
      params[R_SLOTS.pmax] = p.n('pmax', Infinity);
      params[R_SLOTS.vmax] = Math.max(0, p.n('vmax', 0));
      params[R_SLOTS.tnom] = CONST.tnom;
      params[R_SLOTS.thermalNode] = thermal(p.n('rth', 200), 0, p.n('cth', 0.005)).junction;
      sink.addElement(Kind.Resistor, nodes, 2, params, { instIndex: inst0 });
      break;
    }
    case 'ntc_thermistor': {
      resetNodes(2);
      resetParams(R_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '1');
      nodes[1] = ctx.nodeOf(inst, '2');
      params[R_SLOTS.mode] = 1;
      params[R_SLOTS.r] = Math.max(1e-6, p.n('r25', 1e4));
      params[R_SLOTS.b] = p.n('b', 3950);
      params[R_SLOTS.tnom] = 25;
      params[R_SLOTS.rth] = p.n('rth', 80);
      params[R_SLOTS.cth] = p.n('cth', 0.002);
      params[R_SLOTS.thermalNode] = thermal(0.1, p.n('rth', 80), p.n('cth', 0.002)).junction;
      sink.addElement(Kind.NtcThermistor, nodes, 2, params, { instIndex: inst0 });
      break;
    }
    case 'varistor': {
      resetNodes(2);
      resetParams(R_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '1');
      nodes[1] = ctx.nodeOf(inst, '2');
      params[R_SLOTS.mode] = 2;
      params[R_SLOTS.vref] = Math.max(1e-3, p.n('vref', 24));
      params[R_SLOTS.alpha] = Math.max(2, p.n('alpha', 30));
      params[R_SLOTS.r] = 1 / Math.max(1e-15, p.n('leak', 1e-9));
      sink.addElement(Kind.Varistor, nodes, 2, params, { instIndex: inst0 });
      break;
    }
    case 'capacitor': {
      resetNodes(3);
      resetParams(C_STRIDE);
      const n1 = ctx.nodeOf(inst, '1');
      const n2 = ctx.nodeOf(inst, '2');
      const esr = Math.max(0, p.n('esr', 0));
      const esl = Math.max(0, p.n('esl', 0));
      params[C_SLOTS.c] = Math.max(1e-18, p.n('c', 1e-7));
      params[C_SLOTS.esr] = esr;
      params[C_SLOTS.esl] = esl;
      // Insulation quality `leak` is expressed in MΩ·µF: R_ins = leak/C expressed
      // in ohms (with C in farads), so the leakage conductance is C/leak.
      const leak = p.n('leak', 0);
      const c = Math.max(1e-18, p.n('c', 1e-7));
      params[C_SLOTS.gleak] = leak > 0 ? c / leak : 0;
      params[C_SLOTS.vmax] = Math.max(0, p.n('vmax', 0));
      params[C_SLOTS.vc1] = p.n('vc1', 0);
      params[C_SLOTS.da] = p.b('da', false) ? 1 : 0;
      params[C_SLOTS.polarized] = p.b('polarized', false) ? 1 : 0;
      params[C_SLOTS.rth] = p.n('rth', 100);
      params[C_SLOTS.cth] = p.n('cth', 0.01);
      params[C_SLOTS.tnom] = CONST.tnom;
      params[C_SLOTS.thermalNode] = thermal(1, p.n('rth', 100), p.n('cth', 0.01)).junction;
      // A single internal node carries ESR/ESL when they are present.
      if (esr > 0 || esl > 0) {
        nodes[0] = n1;
        nodes[1] = sink.allocInternalNode();
        nodes[2] = n2;
        sink.addElement(Kind.Capacitor, nodes, 3, params, { instIndex: inst0 });
      } else {
        nodes[0] = n1;
        nodes[1] = n2;
        sink.addElement(Kind.Capacitor, nodes, 2, params, { instIndex: inst0 });
      }
      break;
    }
    case 'inductor': {
      resetNodes(2);
      resetParams(L_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '1');
      nodes[1] = ctx.nodeOf(inst, '2');
      params[L_SLOTS.l] = Math.max(1e-15, p.n('l', 1e-3));
      params[L_SLOTS.dcr] = Math.max(0, p.n('dcr', 0));
      params[L_SLOTS.isat] = Math.max(1e-9, p.n('isat', 1e3));
      params[L_SLOTS.epc] = Math.max(0, p.n('epc', 0));
      params[L_SLOTS.coreLoss] = Math.max(0, p.n('coreLoss', 0));
      params[L_SLOTS.imax] = p.n('ilm', Infinity);
      params[L_SLOTS.rth] = p.n('rth', 40);
      params[L_SLOTS.cth] = p.n('cth', 0.02);
      params[L_SLOTS.thermalNode] = thermal(0.5, p.n('rth', 40), p.n('cth', 0.02)).junction;
      sink.addElement(Kind.Inductor, nodes, 2, params, { instIndex: inst0, branches: 1 });
      break;
    }
    case 'transformer': {
      resetNodes(4);
      resetParams(XFMR_STRIDE);
      nodes[0] = ctx.nodeOf(inst, 'P1');
      nodes[1] = ctx.nodeOf(inst, 'P2');
      nodes[2] = ctx.nodeOf(inst, 'S1');
      nodes[3] = ctx.nodeOf(inst, 'S2');
      params[XFMR_SLOTS.l1] = Math.max(1e-12, p.n('l1', 1));
      params[XFMR_SLOTS.l2] = Math.max(1e-12, p.n('l2', 0.01));
      params[XFMR_SLOTS.k] = Math.min(0.999999, Math.max(0.0001, p.n('k', 0.995)));
      params[XFMR_SLOTS.rp] = Math.max(0, p.n('rp', 0));
      params[XFMR_SLOTS.rs] = Math.max(0, p.n('rs', 0));
      params[XFMR_SLOTS.coreLoss] = Math.max(0, p.n('coreLoss', 0));
      params[XFMR_SLOTS.isat] = 1e6;
      params[XFMR_SLOTS.rth] = p.n('rth', 20);
      params[XFMR_SLOTS.cth] = p.n('cth', 0.5);
      params[XFMR_SLOTS.thermalNode] = thermal(2, p.n('rth', 20), p.n('cth', 0.5)).junction;
      sink.addElement(Kind.Transformer, nodes, 4, params, { instIndex: inst0, branches: 2 });
      break;
    }
    case 'potentiometer': {
      resetNodes(3);
      resetParams(POT_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '1');
      nodes[1] = ctx.nodeOf(inst, 'W');
      nodes[2] = ctx.nodeOf(inst, '3');
      params[POT_SLOTS.r] = Math.max(1, p.n('r', 1e4));
      params[POT_SLOTS.wiper] = Math.min(1, Math.max(0, p.n('wiper', 0.5)));
      params[POT_SLOTS.taper] = p.s('taper', 'linear') === 'log' ? 1 : 0;
      params[POT_SLOTS.rw] = Math.max(0, p.n('rw', 1));
      params[POT_SLOTS.rterm] = Math.max(0, p.n('rterm', 2));
      params[POT_SLOTS.pmax] = p.n('pmax', 0.25);
      params[POT_SLOTS.rth] = p.n('rth', 200);
      params[POT_SLOTS.cth] = p.n('cth', 0.005);
      params[POT_SLOTS.thermalNode] = thermal(200, 0, 0.005).junction;
      sink.addElement(Kind.Potentiometer, nodes, 3, params, { instIndex: inst0 });
      break;
    }

    // -----------------------------------------------------------------------
    // Semiconductors
    // -----------------------------------------------------------------------
    case 'diode':
    case 'led':
    case 'photodiode': {
      const variant = spec.id === 'led' ? 1 : spec.id === 'photodiode' ? 2 : 0;
      resetNodes(3);
      resetParams(D_STRIDE);
      // --- model (physics, deduplicated) ---
      const model = drainModelScratch(ctx);
      model[D_SLOTS.is] = Math.max(1e-24, p.n('is', 1e-14));
      model[D_SLOTS.n] = Math.max(0.5, p.n('n', 1));
      model[D_SLOTS.rs] = Math.max(0, p.n('rs', 0));
      model[D_SLOTS.cj0] = Math.max(0, p.n('cj0', 0));
      model[D_SLOTS.vj] = Math.max(0.1, p.n('vj', 0.7));
      model[D_SLOTS.m] = Math.min(1, Math.max(0, p.n('m', 0.33)));
      model[D_SLOTS.tt] = Math.max(0, p.n('tt', 0));
      model[D_SLOTS.bv] = p.n('bv', Infinity);
      model[D_SLOTS.ibv] = Math.max(0, p.n('ibv', 1e-3));
      model[D_SLOTS.eg] = p.n('eg', 1.11);
      model[D_SLOTS.xti] = p.n('xti', 3);
      model[D_SLOTS.tnom] = p.n('tnom', 27);
      model[D_SLOTS.variant] = variant;
      model[D_SLOTS.lambda] = p.n('lambda', 600e-9);
      model[D_SLOTS.eta] = p.n('eta', 0.35);
      model[D_SLOTS.ifnom] = Math.max(1e-9, p.n('ifnom', 0.02));
      model[D_SLOTS.responsivity] = p.n('responsivity', 0.6);
      model[D_SLOTS.dark] = Math.max(0, p.n('dark', 1e-9));
      model[D_SLOTS.tjmax] = p.n('tjmax', 150);
      model[D_SLOTS.ifmax] = p.n('ifmax', Infinity);
      model[D_SLOTS.rthJc] = p.n('rth_jc', 100);
      model[D_SLOTS.rthCa] = p.n('rth_ca', 350);
      model[D_SLOTS.cth] = p.n('cth', 0.0015);
      const modelIndex = sink.registerModel(Kind.Diode + variant, ModelTable.keyOf(Kind.Diode, model, D_STRIDE), model);

      // --- per-instance element parameters ---
      const area = Math.max(1e-3, p.n('area', 1));
      const th = thermal(model[D_SLOTS.rthJc], model[D_SLOTS.rthCa], model[D_SLOTS.cth]);
      params[elemSlot(0)] = area;
      params[elemSlot(1)] = th.junction;
      params[elemSlot(2)] = p.n('power', 0); // photodiode illumination
      params[elemSlot(3)] = p.n('illumination', 1);
      const n1 = ctx.nodeOf(inst, 'A');
      const n2 = ctx.nodeOf(inst, 'K');
      if (model[D_SLOTS.rs] > 0) {
        nodes[0] = n1;
        nodes[1] = sink.allocInternalNode();
        nodes[2] = n2;
        sink.addElement(Kind.Diode + variant, nodes, 3, params, { instIndex: inst0, modelIndex });
      } else {
        nodes[0] = n1;
        nodes[1] = n2;
        sink.addElement(Kind.Diode + variant, nodes, 2, params, { instIndex: inst0, modelIndex });
      }
      break;
    }
    case 'bjt': {
      resetNodes(6);
      resetParams(BJT_STRIDE);
      const model = drainModelScratch(ctx);
      model[BJT_SLOTS.polarity] = p.s('polarity', 'npn') === 'pnp' ? 1 : 0;
      model[BJT_SLOTS.is] = Math.max(1e-24, p.n('is', 1e-14));
      model[BJT_SLOTS.bf] = Math.max(0.1, p.n('bf', 100));
      model[BJT_SLOTS.br] = Math.max(0.01, p.n('br', 1));
      model[BJT_SLOTS.nf] = p.n('nf', 1);
      model[BJT_SLOTS.nr] = p.n('nr', 1);
      // 0 = effect absent (SPICE's off state); bjtEvaluate() treats a
      // non-positive VAF/VAR/IKF as "no Early effect" / "no knee".
      model[BJT_SLOTS.vaf] = Math.max(0, p.n('vaf', 0));
      model[BJT_SLOTS.var] = Math.max(0, p.n('var', 0));
      model[BJT_SLOTS.ikf] = Math.max(0, p.n('ikf', 0));
      model[BJT_SLOTS.ise] = Math.max(0, p.n('ise', 0));
      model[BJT_SLOTS.ne] = Math.max(1, p.n('ne', 1.5));
      model[BJT_SLOTS.isc] = Math.max(0, p.n('isc', 0));
      model[BJT_SLOTS.nc] = Math.max(1, p.n('nc', 2));
      model[BJT_SLOTS.rb] = Math.max(0, p.n('rb', 0));
      model[BJT_SLOTS.rc] = Math.max(0, p.n('rc', 0));
      model[BJT_SLOTS.re] = Math.max(0, p.n('re', 0));
      model[BJT_SLOTS.cje] = Math.max(0, p.n('cje', 0));
      model[BJT_SLOTS.cjc] = Math.max(0, p.n('cjc', 0));
      model[BJT_SLOTS.vje] = p.n('vje', 0.7);
      model[BJT_SLOTS.vjc] = p.n('vjc', 0.6);
      model[BJT_SLOTS.mje] = p.n('mje', 0.33);
      model[BJT_SLOTS.mjc] = p.n('mjc', 0.33);
      model[BJT_SLOTS.tf] = Math.max(0, p.n('tf', 0));
      model[BJT_SLOTS.tr] = Math.max(0, p.n('tr', 0));
      model[BJT_SLOTS.xtb] = p.n('xtb', 1.5);
      model[BJT_SLOTS.eg] = p.n('eg', 1.11);
      model[BJT_SLOTS.xti] = p.n('xti', 3);
      model[BJT_SLOTS.tnom] = p.n('tnom', 27);
      model[BJT_SLOTS.vceo] = p.n('vceo', Infinity);
      model[BJT_SLOTS.icmax] = p.n('icmax', Infinity);
      model[BJT_SLOTS.pdmax] = p.n('pdmax', Infinity);
      model[BJT_SLOTS.tjmax] = p.n('tjmax', 150);
      model[BJT_SLOTS.rthJc] = p.n('rth_jc', 120);
      model[BJT_SLOTS.rthCa] = p.n('rth_ca', 300);
      model[BJT_SLOTS.cth] = p.n('cth', 0.004);
      const modelIndex = sink.registerModel(Kind.Bjt, ModelTable.keyOf(Kind.Bjt, model, BJT_STRIDE), model);

      const th = thermal(model[BJT_SLOTS.rthJc], model[BJT_SLOTS.rthCa], model[BJT_SLOTS.cth]);
      params[elemSlot(0)] = 1;
      params[elemSlot(1)] = th.junction;

      const c = ctx.nodeOf(inst, 'C');
      const b = ctx.nodeOf(inst, 'B');
      const e = ctx.nodeOf(inst, 'E');
      // Internal nodes are only created when a series resistance is actually
      // present — otherwise the device is exact without them.
      // Internal base/collector/emitter nodes exist only when the corresponding
      // series resistance is non-zero: with zero resistance the internal node is
      // electrically identical to the external one, and allocating it would
      // waste an unknown in the matrix (the default is 0 -> no internal node).
      nodes[0] = c;
      nodes[1] = b;
      nodes[2] = e;
      nodes[3] = model[BJT_SLOTS.rc] > 0 ? sink.allocInternalNode() : c;
      nodes[4] = model[BJT_SLOTS.rb] > 0 ? sink.allocInternalNode() : b;
      nodes[5] = model[BJT_SLOTS.re] > 0 ? sink.allocInternalNode() : e;
      sink.addElement(Kind.Bjt, nodes, 6, params, { instIndex: inst0, modelIndex });
      break;
    }
    case 'nmos':
    case 'pmos': {
      const polarity = spec.id === 'pmos' ? 1 : 0;
      resetNodes(7);
      resetParams(MOS_STRIDE);
      const model = drainModelScratch(ctx);
      model[MOS_SLOTS.polarity] = polarity;
      // The model evaluates the channel in its own frame where the threshold is a
      // positive magnitude for both device types (mosEvaluate flips the terminal
      // voltages for a p-channel device). SPICE users habitually write VTO = -0.7
      // for a PMOS, so the magnitude is taken here.
      model[MOS_SLOTS.vto] = polarity ? Math.abs(p.n('vto', 0.7)) : p.n('vto', 0.7);
      model[MOS_SLOTS.kp] = Math.max(1e-12, p.n('kp', 120e-6));
      model[MOS_SLOTS.lambda] = Math.max(0, p.n('lambda', 0.02));
      model[MOS_SLOTS.gamma] = Math.max(0, p.n('gamma', 0.4));
      model[MOS_SLOTS.phi] = Math.max(0.1, p.n('phi', 0.7));
      model[MOS_SLOTS.tox] = Math.max(1e-10, p.n('tox', 4.1e-9));
      model[MOS_SLOTS.cgso] = Math.max(0, p.n('cgso', 1e-10));
      model[MOS_SLOTS.cgdo] = Math.max(0, p.n('cgdo', 1e-10));
      model[MOS_SLOTS.cgbo] = Math.max(0, p.n('cgbo', 0));
      model[MOS_SLOTS.cbd] = Math.max(0, p.n('cbd', 0));
      model[MOS_SLOTS.cbs] = Math.max(0, p.n('cbs', 0));
      model[MOS_SLOTS.pb] = p.n('pb', 0.8);
      model[MOS_SLOTS.mj] = p.n('mj', 0.5);
      model[MOS_SLOTS.isub] = Math.max(0, p.n('isub', 1e-14));
      model[MOS_SLOTS.subth] = p.b('subth', true) ? 1 : 0;
      model[MOS_SLOTS.nsub] = Math.max(1, p.n('nsub', 1.5));
      model[MOS_SLOTS.rd] = Math.max(0, p.n('rd', 0));
      model[MOS_SLOTS.rs] = Math.max(0, p.n('rs', 0));
      model[MOS_SLOTS.rb] = Math.max(0, p.n('rb', 0));
      model[MOS_SLOTS.tnom] = p.n('tnom', 27);
      model[MOS_SLOTS.tcv] = p.n('tcv', -2e-3);
      model[MOS_SLOTS.bex] = p.n('bex', -1.5);
      model[MOS_SLOTS.vdsmax] = p.n('vdsmax', Infinity);
      model[MOS_SLOTS.idmax] = p.n('idmax', Infinity);
      model[MOS_SLOTS.pdmax] = p.n('pdmax', Infinity);
      model[MOS_SLOTS.tjmax] = p.n('tjmax', 150);
      model[MOS_SLOTS.rthJc] = p.n('rth_jc', 60);
      model[MOS_SLOTS.rthCa] = p.n('rth_ca', 200);
      model[MOS_SLOTS.cth] = p.n('cth', 1e-5);
      model[MOS_SLOTS.ad] = p.n('ad', 0);
      model[MOS_SLOTS.asArea] = p.n('as', 0);
      model[MOS_SLOTS.pd] = p.n('pd', 0);
      model[MOS_SLOTS.ps] = p.n('ps', 0);
      const modelIndex = sink.registerModel(Kind.Mosfet, ModelTable.keyOf(Kind.Mosfet, model, MOS_STRIDE), model);

      const th = thermal(model[MOS_SLOTS.rthJc], model[MOS_SLOTS.rthCa], model[MOS_SLOTS.cth]);
      params[0] = Math.max(1e-9, p.n('w', 10e-6));
      params[1] = Math.max(1e-9, p.n('l', 1e-6));
      params[2] = Math.max(1, p.n('nseries', 1));
      params[3] = th.junction;

      const d = ctx.nodeOf(inst, 'D');
      const g = ctx.nodeOf(inst, 'G');
      const s = ctx.nodeOf(inst, 'S');
      const bNode = ctx.netOf(inst, 'B') >= 0 ? ctx.nodeOf(inst, 'B') : s;
      // Optional series resistance internal nodes.
      const hasD = model[MOS_SLOTS.rd] > 0;
      const hasS = model[MOS_SLOTS.rs] > 0;
      const hasB = model[MOS_SLOTS.rb] > 0;
      const nD = hasD ? sink.allocInternalNode() : d;
      const nS = hasS ? sink.allocInternalNode() : s;
      const nB = hasB ? sink.allocInternalNode() : bNode;
      nodes[0] = d;
      nodes[1] = g;
      nodes[2] = s;
      nodes[3] = bNode;
      nodes[4] = nD;
      nodes[5] = nS;
      nodes[6] = nB;
      sink.addElement(Kind.Mosfet, nodes, 7, params, { instIndex: inst0, modelIndex });
      break;
    }

    // -----------------------------------------------------------------------
    // Switching
    // -----------------------------------------------------------------------
    case 'switch':
    case 'push_button': {
      resetNodes(3);
      resetParams(SW_STRIDE);
      const isButton = spec.id === 'push_button';
      const normallyClosed = isButton ? p.s('contact', 'NO') === 'NC' : false;
      const ctrlNet = ctx.netOf(inst, 'CTRL');
      nodes[0] = ctx.nodeOf(inst, 'A');
      nodes[1] = ctx.nodeOf(inst, 'B');
      nodes[2] = ctrlNet >= 0 ? ctx.nodeForNet(ctrlNet, 0) : -1;
      params[SW_SLOTS.closed] = (isButton ? p.b('pressed', false) : p.b('closed', false)) !== normallyClosed ? 1 : 0;
      params[SW_SLOTS.ron] = Math.max(1e-9, p.n('ron', 0.05));
      params[SW_SLOTS.roff] = Math.max(1, p.n('roff', 1e9));
      params[SW_SLOTS.bounce] = p.b('bounce', false) ? 1 : 0;
      params[SW_SLOTS.bounces] = Math.max(0, p.n('bounces', 3));
      params[SW_SLOTS.bouncePeriod] = Math.max(1e-9, p.n('bouncePeriod', 1e-4));
      params[SW_SLOTS.bounceDecay] = Math.min(0.95, Math.max(0.05, p.n('bounceDecay', 0.5)));
      params[SW_SLOTS.switchAt] = isButton ? p.n('pressAt', 0) : p.n('switchAt', 0);
      params[SW_SLOTS.ctrlMode] = ctrlNet >= 0 ? 2 : 0;
      params[SW_SLOTS.ctrlThreshold] = p.n('vth', 1.65);
      params[SW_SLOTS.normallyClosed] = normallyClosed ? 1 : 0;
      params[SW_SLOTS.hasCtrl] = ctrlNet >= 0 ? 1 : 0;
      params[SW_SLOTS.holdTime] = isButton ? Math.max(0, p.n('holdTime', 0)) : 0;
      sink.addElement(Kind.Switch, nodes, ctrlNet >= 0 ? 3 : 2, params, { instIndex: inst0 });
      break;
    }
    case 'relay': {
      resetNodes(5);
      resetParams(RELAY_STRIDE);
      nodes[0] = ctx.nodeOf(inst, 'A1');
      nodes[1] = ctx.nodeOf(inst, 'A2');
      nodes[2] = ctx.nodeOf(inst, 'COM');
      nodes[3] = ctx.nodeOf(inst, 'NO');
      nodes[4] = ctx.nodeOf(inst, 'NC');
      params[RELAY_SLOTS.lcoil] = Math.max(1e-9, p.n('lcoil', 0.05));
      params[RELAY_SLOTS.rcoil] = Math.max(1e-3, p.n('rcoil', 400));
      params[RELAY_SLOTS.vpull] = Math.max(0.01, p.n('vpull', 3.5));
      params[RELAY_SLOTS.vdrop] = Math.max(0, p.n('vdrop', 1.5));
      params[RELAY_SLOTS.tpull] = Math.max(1e-9, p.n('tpull', 5e-3));
      params[RELAY_SLOTS.tdrop] = Math.max(1e-9, p.n('tdrop', 3e-3));
      params[RELAY_SLOTS.ron] = Math.max(1e-9, p.n('ron', 0.05));
      params[RELAY_SLOTS.bounce] = p.b('bounce', true) ? 1 : 0;
      params[RELAY_SLOTS.rth] = 200;
      params[RELAY_SLOTS.cth] = 0.05;
      params[RELAY_SLOTS.thermalNode] = thermal(50, 150, 0.05).junction;
      sink.addElement(Kind.Relay, nodes, 5, params, { instIndex: inst0, branches: 1 });
      break;
    }

    // -----------------------------------------------------------------------
    // Sources
    // -----------------------------------------------------------------------
    case 'vdc':
    case 'idc':
    case 'vac':
    case 'iac':
    case 'vsignal':
    case 'isignal':
    case 'clock':
    case 'noise_source':
    case 'battery': {
      const isCurrent = spec.id === 'idc' || spec.id === 'iac' || spec.id === 'isignal';
      const isClock = spec.id === 'clock';
      const isNoise = spec.id === 'noise_source';
      const isBattery = spec.id === 'battery';
      resetNodes(2);
      resetParams(SRC_STRIDE);
      const pos = spec.pins[0]?.name ?? '+';
      const neg = spec.pins[1]?.name ?? '-';
      nodes[0] = ctx.nodeOf(inst, pos);
      nodes[1] = ctx.nodeOf(inst, neg);

      let family: number;
      let waveform: number;
      if (isCurrent) {
        family = isNoise ? 3 : 1;
      } else {
        family = isNoise ? 2 : isClock ? 4 : 0;
      }
      if (spec.id === 'vdc') waveform = 0;
      else if (spec.id === 'vac') waveform = 1;
      else if (spec.id === 'iac') waveform = 1;
      else if (spec.id === 'clock') waveform = 6;
      else if (spec.id === 'noise_source') waveform = 7;
      else {
        const w = p.s('waveform', 'sine');
        waveform = w === 'dc' ? 0 : w === 'sine' ? 1 : w === 'square' ? 2 : w === 'triangle' ? 3 : w === 'sawtooth' ? 4 : w === 'pulse' ? 5 : w === 'clock' ? 6 : w === 'noise' ? 7 : 8;
      }
      params[SRC_SLOTS.family] = family;
      params[SRC_SLOTS.waveform] = waveform;
      // `resetParams` zeroes the scratch, and handle 0 is a valid table: without
      // this every source would point at the first table in the netlist.
      params[SRC_SLOTS.table] = -1;
      if (waveform === 8) {
        const text = p.s('arbitrary', '');
        const table = parseArbitraryWaveform(text);
        const target = { target: { type: 'component' as const, id: inst.id, name: inst.ref } };
        if (!table) {
          ctx.addDiagnostic(
            warn(
              'CF4008',
              `${inst.ref}: set to the arbitrary waveform but its "arbitrary" parameter (${text ? `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"` : 'empty'}) is not a list of "t:v" pairs with strictly increasing t; the source holds its DC offset instead`,
              target,
            ),
          );
        } else if (sink.addWaveTable) {
          const handle = sink.addWaveTable(table);
          if (handle < 0) {
            ctx.addDiagnostic(warn('CF4008', `${inst.ref}: arbitrary waveform rejected (times must be strictly increasing, values finite); the source holds its DC offset`, target));
          } else {
            params[SRC_SLOTS.table] = handle;
          }
        } else {
          ctx.addDiagnostic(warn('CF4008', `${inst.ref}: arbitrary waveform could not be registered (this netlist sink has no waveform table); the source holds its DC offset`, target));
        }
      }
      if (spec.id === 'vdc' || spec.id === 'idc') {
        params[SRC_SLOTS.dc] = p.n('dc', 0);
        params[SRC_SLOTS.amp] = 0;
      } else if (spec.id === 'clock') {
        params[SRC_SLOTS.dc] = p.n('vlow', 0);
        params[SRC_SLOTS.amp] = p.n('vhigh', 3.3) - p.n('vlow', 0);
        params[SRC_SLOTS.freq] = Math.max(1e-6, p.n('freq', 1e6));
        params[SRC_SLOTS.duty] = Math.min(0.999, Math.max(0.001, p.n('duty', 0.5)));
        params[SRC_SLOTS.tr] = Math.max(0, p.n('tr', 1e-9));
        params[SRC_SLOTS.tf] = Math.max(0, p.n('tf', 1e-9));
        params[SRC_SLOTS.rs] = Math.max(0, p.n('rs', 0));
        params[SRC_SLOTS.delay] = Math.max(0, p.n('delay', 0));
        params[SRC_SLOTS.jitter] = Math.max(0, p.n('jitter', 0));
        params[SRC_SLOTS.ac] = p.n('vhigh', 3.3) / 2;
      } else if (isBattery) {
        // Thévenin battery: the open-circuit voltage depends on the state of
        // charge, which the element integrates over time (family 5).
        params[SRC_SLOTS.family] = 5;
        params[SRC_SLOTS.dc] = p.n('vnom', 3.7);
        params[SRC_SLOTS.amp] = p.n('cutoff', 3.0);
        params[SRC_SLOTS.rs] = Math.max(1e-4, p.n('rseries', 0.1));
        params[SRC_SLOTS.duty] = p.n('soc', 1);
        params[SRC_SLOTS.tr] = Math.max(1e-9, p.n('capacity', 2.5));
        params[SRC_SLOTS.tf] = p.n('tempco', -2e-3);
        params[SRC_SLOTS.ac] = 0;
      } else {
        params[SRC_SLOTS.dc] = p.n('dc', 0);
        params[SRC_SLOTS.amp] = p.n('amp', spec.id === 'vac' ? 1 : 1e-3);
        params[SRC_SLOTS.freq] = Math.max(0, p.n('freq', 1000));
        params[SRC_SLOTS.phase] = p.n('phase', 0);
        params[SRC_SLOTS.duty] = p.n('duty', 0.5);
        params[SRC_SLOTS.tr] = Math.max(0, p.n('tr', 1e-9));
        params[SRC_SLOTS.tf] = Math.max(0, p.n('tf', 1e-9));
        params[SRC_SLOTS.delay] = p.n('delay', 0);
        params[SRC_SLOTS.rs] = Math.max(0, p.n('rs', 0));
        params[SRC_SLOTS.ac] = p.n('ac', spec.id === 'vac' ? 1 : 1e-3);
        params[SRC_SLOTS.acphase] = p.n('acphase', 0);
        params[SRC_SLOTS.noiseDensity] = p.n('density', 10e-9);
        params[SRC_SLOTS.flicker] = p.n('flicker', 0);
        params[SRC_SLOTS.bwLow] = p.n('bwLow', 0);
        params[SRC_SLOTS.bwHigh] = p.n('bwHigh', 1e6);
      }
      if (spec.id === 'vdc') params[SRC_SLOTS.rs] = Math.max(0, p.n('rs', 0));
      if (spec.id === 'vdc' || spec.id === 'battery') params[SRC_SLOTS.ilimit] = Math.max(0, p.n('ilimit', 0));
      const branch = family === 0 || family === 2 || family === 4 || family === 5 ? 1 : 0;
      sink.addElement(Kind.VoltageSource, nodes, 2, params, { instIndex: inst0, branches: branch });
      break;
    }

    // -----------------------------------------------------------------------
    // Controlled sources
    // -----------------------------------------------------------------------
    case 'vcvs':
    case 'vccs':
    case 'ccvs':
    case 'cccs': {
      const type = spec.id === 'vcvs' ? 0 : spec.id === 'vccs' ? 1 : spec.id === 'ccvs' ? 2 : 3;
      resetNodes(4);
      resetParams(CS_STRIDE);
      nodes[0] = ctx.nodeOf(inst, 'OUT+');
      nodes[1] = ctx.nodeOf(inst, 'OUT-');
      nodes[2] = ctx.nodeOf(inst, 'IN+');
      nodes[3] = ctx.nodeOf(inst, 'IN-');
      if (type === 2 || type === 3) {
        nodes[2] = ctx.nodeOf(inst, 'CTRL+');
        nodes[3] = ctx.nodeOf(inst, 'CTRL-');
      }
      params[CS_SLOTS.type] = type;
      // The transconductance source names its transfer parameter `gm`, the other
      // three name it `gain` (SPICE naming).
      params[CS_SLOTS.gain] = type === 1 ? p.n('gm', 0.001) : p.n('gain', 1);
      params[CS_SLOTS.rout] = Math.max(0, p.n('rout', 0));
      params[CS_SLOTS.rin] = Math.max(0, p.n('rin', 0));
      params[CS_SLOTS.vmax] = Math.max(0, p.n('vmax', 0));
      const branches = type === 0 ? 1 : type === 2 ? 2 : type === 3 ? 1 : 0;
      sink.addElement(Kind.Vcvs + type, nodes, 4, params, { instIndex: inst0, branches });
      break;
    }

    // -----------------------------------------------------------------------
    // Digital
    // -----------------------------------------------------------------------
    case 'not_gate':
    case 'buffer':
    case 'and_gate':
    case 'nand_gate':
    case 'or_gate':
    case 'nor_gate':
    case 'xor_gate':
    case 'xnor_gate':
    case 'tristate': {
      lowerGate(ctx, p as unknown as ParamReader, inst0);
      break;
    }
    case 'dff': {
      resetNodes(5);
      resetParams(DFF_STRIDE);
      const hasReset = ctx.netOf(inst, 'RST') >= 0;
      const hasQN = ctx.netOf(inst, 'QN') >= 0;
      nodes[0] = ctx.nodeOf(inst, 'D');
      nodes[1] = ctx.nodeOf(inst, 'CLK');
      nodes[2] = hasReset ? ctx.nodeOf(inst, 'RST') : 0;
      nodes[3] = ctx.nodeOf(inst, 'Q');
      nodes[4] = hasQN ? ctx.nodeOf(inst, 'QN') : nodes[3];
      params[DFF_SLOTS.falling] = p.s('edge', 'rising') === 'falling' ? 1 : 0;
      params[DFF_SLOTS.setup] = Math.max(0, p.n('setup', 0));
      params[DFF_SLOTS.hold] = Math.max(0, p.n('hold', 0));
      params[DFF_SLOTS.tckq] = Math.max(0, p.n('tckq', 0));
      params[DFF_SLOTS.vdd] = p.n('vdd', 3.3);
      params[DFF_SLOTS.vth] = p.n('vth', 1.65);
      params[DFF_SLOTS.cload] = Math.max(0, p.n('cload', 0));
      params[DFF_SLOTS.rout] = Math.max(1e-6, p.n('rout', 100));
      const init = p.s('initial', '0');
      params[DFF_SLOTS.initial] = init === '1' ? 1 : init === 'X' ? 2 : 0;
      params[DFF_SLOTS.resetLow] = p.s('resetActive', 'high') === 'low' ? 1 : 0;
      params[DFF_SLOTS.hasReset] = hasReset ? 1 : 0;
      params[DFF_SLOTS.hasQN] = hasQN ? 1 : 0;
      params[DFF_SLOTS.scan] = p.b('scan', false) ? 1 : 0;
      sink.addElement(Kind.DFlipFlop, nodes, 5, params, { instIndex: inst0 });
      break;
    }
    case 'dlatch': {
      resetNodes(3);
      resetParams(DFF_STRIDE);
      nodes[0] = ctx.nodeOf(inst, 'D');
      nodes[1] = ctx.nodeOf(inst, 'EN');
      nodes[2] = ctx.nodeOf(inst, 'Q');
      params[DFF_SLOTS.initial] = p.s('initial', '0') === '1' ? 1 : 0;
      params[DFF_SLOTS.vdd] = p.n('vdd', 3.3);
      params[DFF_SLOTS.vth] = p.n('vth', 1.65);
      params[DFF_SLOTS.rout] = Math.max(1e-6, p.n('rout', 100));
      sink.addElement(Kind.DLatch, nodes, 3, params, { instIndex: inst0 });
      break;
    }
    case 'mux':
    case 'demux': {
      lowerMux(ctx, p as unknown as ParamReader, inst0, spec.id === 'demux');
      break;
    }

    // -----------------------------------------------------------------------
    // Instruments / power infrastructure
    // -----------------------------------------------------------------------
    case 'logic_high':
    case 'logic_low': {
      // A level-0 source: one output net, no input. The electrical model is a
      // driver with the same output resistance as a gate.
      resetNodes(1);
      resetParams(GATE_STRIDE);
      nodes[0] = ctx.netOf(inst, 'OUT') >= 0 ? ctx.nodeOf(inst, 'OUT') : ctx.nodeOf(inst, '0');
      params[GATE_SLOTS.fn] = spec.id === 'logic_high' ? 9 : 10;
      params[GATE_SLOTS.inputs] = 0;
      params[GATE_SLOTS.vdd] = p.n('vdd', 3.3);
      params[GATE_SLOTS.vth] = p.n('vth', 1.65);
      params[GATE_SLOTS.cload] = Math.max(0, p.n('cload', 0));
      params[GATE_SLOTS.rout] = Math.max(1e-6, p.n('rout', 100));
      params[GATE_SLOTS.rovh] = Math.max(1e-6, p.n('rout', 100));
      params[GATE_SLOTS.rovl] = Math.max(1e-6, p.n('rout', 100));
      params[GATE_SLOTS.gleak] = 1e-12;
      sink.addElement(Kind.LogicBuf, nodes, 1, params, { instIndex: inst0 });
      break;
    }
    case 'ground': {
      // Nothing is emitted: the net attached to a ground symbol becomes node 0.
      break;
    }
    case 'voltmeter':
    case 'logic_probe': {
      resetNodes(2);
      resetParams(PROBE_STRIDE);
      nodes[0] = ctx.nodeOf(inst, spec.pins[0].name);
      nodes[1] = spec.pins.length > 1 ? ctx.nodeOf(inst, spec.pins[1].name) : 0;
      params[PROBE_SLOTS.kind] = spec.id === 'logic_probe' ? 4 : 0;
      params[PROBE_SLOTS.index] = ctx.instanceIndex;
      sink.addElement(Kind.Probe, nodes, 2, params, { instIndex: inst0 });
      // A voltmeter declares an input resistance and the UI exposes it, so it has to
      // do something: with `rin > 0` the meter is also a resistor between its two
      // terminals, and the voltage it reads is the *loaded* one. Emitting only the
      // observer made every finite `rin` a no-op — the parameter was there, the
      // readout claimed the circuit was loaded, and nothing was.
      const rin = spec.id === 'voltmeter' ? Math.max(0, p.n('rin', 0)) : 0;
      if (rin > 0 && nodes[0] >= 0 && nodes[1] >= 0 && nodes[0] !== nodes[1]) {
        resetParams(R_STRIDE);
        params[R_SLOTS.mode] = 0;
        params[R_SLOTS.r] = rin;
        sink.addElement(Kind.Resistor, nodes, 2, params, { instIndex: inst0 });
      }
      break;
    }
    case 'ammeter': {
      resetNodes(2);
      resetParams(PROBE_STRIDE);
      nodes[0] = ctx.nodeOf(inst, '+');
      nodes[1] = ctx.nodeOf(inst, '-');
      params[PROBE_SLOTS.kind] = 1;
      params[PROBE_SLOTS.index] = ctx.instanceIndex;
      const rshunt = Math.max(0, p.n('rshunt', 0));
      if (rshunt === 0) {
        // Ideal ammeter: a zero-volt source carries the current as an unknown.
        sink.addElement(Kind.AmmeterShunt, nodes, 2, params, { instIndex: inst0, branches: 1 });
      } else {
        resetParams(R_STRIDE);
        params[R_SLOTS.r] = rshunt;
        params[R_SLOTS.mode] = 0;
        params[R_SLOTS.tnom] = 27;
        params[R_SLOTS.pmax] = Infinity;
        params[R_SLOTS.vmax] = 0;
        params[R_SLOTS.thermalNode] = -1;
        sink.addElement(Kind.Resistor, nodes, 2, params, { instIndex: inst0 });
      }
      break;
    }
    case 'wattmeter': {
      resetNodes(2);
      resetParams(PROBE_STRIDE);
      // Shunt between I+ and I-, voltage sensed between V+ and V-.
      const vi = ctx.nodeOf(inst, 'V+');
      const vneg = ctx.nodeOf(inst, 'V-');
      const iplus = ctx.nodeOf(inst, 'I+');
      const iminus = ctx.nodeOf(inst, 'I-');
      params[PROBE_SLOTS.kind] = 2;
      params[PROBE_SLOTS.index] = ctx.instanceIndex;
      params[PROBE_SLOTS.target] = -1;
      nodes[0] = vi;
      nodes[1] = vneg;
      sink.addElement(Kind.Wattmeter, nodes, 2, params, { instIndex: inst0 });
      resetParams(R_STRIDE);
      params[R_SLOTS.r] = Math.max(1e-9, p.n('rshunt', 0.01));
      params[R_SLOTS.mode] = 0;
      params[R_SLOTS.tnom] = 27;
      params[R_SLOTS.pmax] = Infinity;
      params[R_SLOTS.vmax] = 0;
      params[R_SLOTS.thermalNode] = -1;
      nodes[0] = iplus;
      nodes[1] = iminus;
      sink.addElement(Kind.Resistor, nodes, 2, params, { instIndex: inst0 });
      break;
    }
    case 'thermometer': {
      resetNodes(2);
      resetParams(PROBE_STRIDE);
      const tNet = ctx.netOf(inst, 'T');
      const hot = tNet >= 0 ? sink.thermalNodeForNet(tNet) : -1;
      nodes[0] = hot >= 0 ? hot : 0;
      nodes[1] = 0;
      params[PROBE_SLOTS.kind] = 3;
      params[PROBE_SLOTS.index] = ctx.instanceIndex;
      params[PROBE_SLOTS.target] = hot;
      sink.addElement(Kind.Probe, nodes, 1, params, { instIndex: inst0 });
      break;
    }
    case 'probe': {
      resetNodes(1);
      resetParams(PROBE_STRIDE);
      nodes[0] = ctx.nodeOf(inst, 'P');
      const kindStr = p.s('kind', 'voltage');
      params[PROBE_SLOTS.kind] = kindStr === 'current' ? 1 : kindStr === 'power' ? 2 : kindStr === 'temperature' ? 3 : kindStr === 'logic' ? 4 : kindStr === 'frequency' ? 5 : 0;
      params[PROBE_SLOTS.index] = ctx.instanceIndex;
      sink.addElement(Kind.Probe, nodes, 1, params, { instIndex: inst0 });
      break;
    }
    case 'heatsink': {
      const tNet = ctx.netOf(inst, 'T');
      const node = tNet >= 0 ? sink.thermalNodeForNet(tNet) : sink.thermalNode(0, 1);
      const rth = Math.max(0.01, p.n('rth', 5)) * Math.max(0.01, p.n('forced', 0) || 1);
      sink.thermalLink(node, -1, rth);
      if (ctx.options.thermal) sink.thermalSetCth(node, Math.max(1e-6, p.n('cth', 20)));
      break;
    }
    case 'thermal_pad': {
      const a = ctx.netOf(inst, 'A');
      const b = ctx.netOf(inst, 'B');
      const na = a >= 0 ? sink.thermalNodeForNet(a) : -1;
      const nb = b >= 0 ? sink.thermalNodeForNet(b) : -1;
      if (na < 0 && nb < 0) {
        ctx.addDiagnostic(warn('CF5101', `${inst.ref}: thermal pad connected to no thermal net; ignored`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
        break;
      }
      sink.thermalLink(na, nb, Math.max(1e-4, p.n('rth', 1.5)));
      if (ctx.options.thermal && p.n('cth', 0.5) > 0) sink.thermalSetCth(Math.max(na, nb), p.n('cth', 0.5));
      break;
    }
    default: {
      ctx.addDiagnostic(
        info('CF5102', `${inst.ref}: no electrical implementation for "${spec.id}" (component is schematic-only)`, {
          target: { type: 'component', id: inst.id, name: inst.ref },
        }),
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal interface implemented by the parameter reader above. */
export interface ParamReader {
  n(name: string, fallback?: number): number;
  b(name: string, fallback?: boolean): boolean;
  s(name: string, fallback?: string): string;
}

/** Slot index used by the compact per-instance element blocks of devices. */
function elemSlot(i: number): number {
  return i;
}

/** Device-element stride (area / thermal node / optical power / illumination). */
export const DEVICE_ELEM_STRIDE = 4;

function drainModelScratch(ctx: LowerContext): Float64Array {
  const buf = ctx.sink.modelScratch();
  for (let i = 0; i < MODEL_STRIDE; i++) buf[i] = 0;
  return buf;
}

function lowerGate(ctx: LowerContext, p: ParamReader, instIndex: number): void {
  const { inst, spec, sink } = ctx;
  const style = p.s('style', 'ideal');
  // `inputs` is bounded by the pins the spec declares and by the node stride of
  // one element: what does not fit is expanded into a tree of 2-input gates of
  // the same family (see expandWideGate).
  const declaredInputs = Math.max(1, spec.pins.filter((pin) => pin.direction === 'input').length);
  const requested = Math.max(
    spec.id === 'not_gate' || spec.id === 'buffer' ? 1 : 2,
    Math.round(p.n('inputs', spec.id === 'not_gate' || spec.id === 'buffer' ? 1 : 2)),
  );
  const inputs = Math.min(requested, declaredInputs);
  if (requested > declaredInputs) {
    ctx.addDiagnostic(
      warn('CF5102', `${inst.ref}: ${requested} inputs requested but the component declares ${declaredInputs}; using ${declaredInputs}`, {
        hint: 'Add the missing pins to the component or use a tree of gates.',
      }),
    );
  }
  const fn = gateFunction(spec.id);

  if (style !== 'ideal' && ctx.options.expandGates && needsCmosExpansion(spec.id)) {
    const cmosCtx: CmosContext = {
      kind: spec.id,
      inputs,
      polarityFns: fn,
      vdd: p.n('vdd', 3.3),
      vth: p.n('vth', 1.65),
      wn: Math.max(1e-9, p.n('wn', 10e-6)),
      wp: Math.max(1e-9, p.n('wp', 20e-6)),
      l: Math.max(1e-9, p.n('l', 0.18e-6)),
      tphl: p.n('tphl', 0),
      tplh: p.n('tplh', 0),
      cload: Math.max(0, p.n('cload', 0)),
      rou: Math.max(1e-6, p.n('rout', 100)),
      activeLow: p.b('activeLow', false),
      implementation: p.s('implementation', 'transmission_gate'),
      instanceIndex: instIndex,
      sink,
      ambient: ctx.options.ambient,
      inputNodes: collectInputNodes(ctx, spec, inputs),
      outputNode: ctx.nodeOf(inst, 'OUT'),
      enableNode: spec.id === 'tristate' ? ctx.nodeOf(inst, 'EN') : -1,
      supply: (which, volts) => ctx.supplyNode(which, volts),
      diagnostic: (d) => ctx.addDiagnostic(d),
      ref: inst.ref,
      thermal: ctx.options.thermal,
    };
    ctx.sink.setExpanding?.(true);
    try {
      expandCmosGate(cmosCtx);
    } finally {
      ctx.sink.setExpanding?.(false);
    }
    return;
  }

  const wired = spec.pins.filter((pin) => pin.direction === 'input').slice(0, inputs);
  const params = sink.scratchParamBuffer();
  for (let i = 0; i < GATE_STRIDE; i++) params[i] = 0;
  params[GATE_SLOTS.vdd] = p.n('vdd', 3.3);
  params[GATE_SLOTS.vth] = p.n('vth', 1.65);
  params[GATE_SLOTS.tphl] = Math.max(0, p.n('tphl', 0));
  params[GATE_SLOTS.tplh] = Math.max(0, p.n('tplh', 0));
  params[GATE_SLOTS.tr] = Math.max(0, p.n('tr', 0));
  params[GATE_SLOTS.tf] = Math.max(0, p.n('tf', 0));
  params[GATE_SLOTS.cload] = Math.max(0, p.n('cload', 0));
  params[GATE_SLOTS.rout] = Math.max(1e-6, p.n('rout', 100));
  params[GATE_SLOTS.drive] = Math.max(0.01, p.n('drive', 1));
  params[GATE_SLOTS.activeLow] = p.b('activeLow', false) ? 1 : 0;
  params[GATE_SLOTS.rovh] = Math.max(1e-6, p.n('rout', 100));
  params[GATE_SLOTS.rovl] = Math.max(1e-6, p.n('rout', 100));
  params[GATE_SLOTS.gleak] = 1e-12;

  if (wired.length > MAX_GATE_INPUTS) {
    // A gate wider than one element: an associative tree of 2-input gates of the
    // same family (the declared delay is split evenly over the levels of the
    // tree, so the input-to-output delay of the whole gate stays what was asked).
    const inputNodes: number[] = [];
    for (const pin of wired) inputNodes.push(ctx.nodeOf(inst, pin.name));
    expandWideGate(ctx, fn, inputNodes, ctx.nodeOf(inst, 'OUT'), params, { instIndex });
    return;
  }

  const nodes = sink.scratchNodeBuffer();
  for (let i = 0; i < NODE_STRIDE; i++) nodes[i] = -1;
  const inPins = wired;
  for (let i = 0; i < inPins.length; i++) nodes[i] = ctx.nodeOf(inst, inPins[i].name);
  nodes[inPins.length] = ctx.nodeOf(inst, 'OUT');
  params[GATE_SLOTS.fn] = fn;
  params[GATE_SLOTS.inputs] = inPins.length;
  const kind = spec.id === 'tristate' ? Kind.TriState : spec.id === 'buffer' || spec.id === 'not_gate' ? Kind.LogicBuf : Kind.LogicGate;
  sink.addElement(kind, nodes, inPins.length + 1, params, { instIndex });
}

function collectInputNodes(ctx: LowerContext, spec: ComponentSpec, inputs: number): Int32Array {
  const arr = new Int32Array(inputs);
  const inPins = spec.pins.filter((pin) => pin.direction === 'input').slice(0, inputs);
  for (let i = 0; i < inputs; i++) {
    arr[i] = inPins[i] ? ctx.nodeOf(ctx.inst, inPins[i].name) : 0;
  }
  return arr;
}

/** Maximum number of inputs one gate element can carry (nodes[0..n-1] + OUT). */
const MAX_GATE_INPUTS = NODE_STRIDE - 1;

/**
 * Split a gate function into the associative base function and whether the result
 * is inverted. A 16-input NAND is an AND tree followed by an inverter — never a
 * tree of NANDs, which would compute a different function.
 */
function splitGateFunction(fn: number): { base: number; invert: boolean } {
  switch (fn) {
    case 2:
      return { base: 2, invert: false }; // AND
    case 3:
      return { base: 2, invert: true }; // NAND
    case 4:
      return { base: 4, invert: false }; // OR
    case 5:
      return { base: 4, invert: true }; // NOR
    case 6:
      return { base: 6, invert: false }; // XOR
    case 7:
      return { base: 6, invert: true }; // XNOR
    default:
      return { base: 0, invert: fn === 1 }; // BUF / NOT
  }
}

/**
 * Expand a gate with more inputs than one element can hold into a balanced tree
 * of 2-input gates of the same family. The declared propagation delay is divided
 * by the number of levels, so the input-to-output delay of the whole gate stays
 * the value the designer asked for; the drive parameters are shared by all levels.
 */
function expandWideGate(
  ctx: LowerContext,
  fn: number,
  inputs: readonly number[],
  outputNode: number,
  params: Float64Array,
  opts: { instIndex: number },
): void {
  const { base, invert } = splitGateFunction(fn);
  const levels = Math.ceil(Math.log2(Math.max(2, inputs.length)));
  const perLevel = 1 / levels;
  const nodes = ctx.sink.scratchNodeBuffer();
  const levelParams = ctx.sink.scratchParamBuffer();
  const emit = (kind: number, a: number, b: number, out: number): void => {
    for (let i = 0; i < NODE_STRIDE; i++) nodes[i] = -1;
    for (let i = 0; i < GATE_STRIDE; i++) levelParams[i] = params[i];
    levelParams[GATE_SLOTS.inputs] = b >= 0 ? 2 : 1;
    levelParams[GATE_SLOTS.tphl] = params[GATE_SLOTS.tphl] * perLevel;
    levelParams[GATE_SLOTS.tplh] = params[GATE_SLOTS.tplh] * perLevel;
    levelParams[GATE_SLOTS.tr] = params[GATE_SLOTS.tr] * perLevel;
    levelParams[GATE_SLOTS.tf] = params[GATE_SLOTS.tf] * perLevel;
    nodes[0] = a;
    if (b >= 0) nodes[1] = b;
    nodes[b >= 0 ? 2 : 1] = out;
    ctx.sink.addElement(kind, nodes, b >= 0 ? 3 : 2, levelParams, opts);
  };
  // Associative tree of the base function…
  let level: number[] = inputs.slice();
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const mid = ctx.sink.allocInternalNode();
      levelParams[GATE_SLOTS.fn] = base;
      emit(Kind.LogicGate, level[i], level[i + 1], mid);
      next.push(mid);
    }
    level = next;
  }
  // …followed by an inverter when the family is inverted (NAND, NOR, XNOR).
  levelParams[GATE_SLOTS.fn] = invert ? 1 : 0;
  emit(Kind.LogicBuf, level[0], -1, outputNode);
}

export function gateFunction(specId: string): number {
  switch (specId) {
    case 'buffer':
      return 0;
    case 'not_gate':
      return 1;
    case 'and_gate':
      return 2;
    case 'nand_gate':
      return 3;
    case 'or_gate':
      return 4;
    case 'nor_gate':
      return 5;
    case 'xor_gate':
      return 6;
    case 'xnor_gate':
      return 7;
    case 'tristate':
      return 8;
    default:
      return 0;
  }
}

function lowerMux(ctx: LowerContext, p: ParamReader, instIndex: number, isDemux: boolean): void {
  const { inst, spec, sink } = ctx;
  const nodes = sink.scratchNodeBuffer();
  const params = sink.scratchParamBuffer();
  for (let i = 0; i < NODE_STRIDE; i++) nodes[i] = -1;
  for (let i = 0; i < MUX_STRIDE; i++) params[i] = 0;
  const channels = isDemux ? Math.max(2, Math.min(8, Math.round(p.n('outputs', 2)))) : Math.max(2, Math.min(8, Math.round(p.n('channels', 2))));
  const selectBits = Math.max(1, Math.ceil(Math.log2(channels)));
  params[MUX_SLOTS.channels] = channels;
  params[MUX_SLOTS.selectBits] = selectBits;
  params[MUX_SLOTS.mode] = p.b('decoderOnly', false) ? 2 : isDemux ? 1 : 0;
  params[MUX_SLOTS.vdd] = p.n('vdd', 3.3);
  params[MUX_SLOTS.vth] = p.n('vth', 1.65);
  params[MUX_SLOTS.tphl] = Math.max(0, p.n('tphl', 0));
  params[MUX_SLOTS.tplh] = Math.max(0, p.n('tplh', 0));
  params[MUX_SLOTS.cload] = Math.max(0, p.n('cload', 0));
  params[MUX_SLOTS.rout] = Math.max(1e-6, p.n('rout', 100));

  const dataPins = spec.pins.filter((pin) => /^I\d+$/.test(pin.name) || pin.name === 'IN');
  const selPins = spec.pins.filter((pin) => /^S\d+$/.test(pin.name));
  const outPins = spec.pins.filter((pin) => /^Y\d*$/.test(pin.name));
  let n = 0;
  if (isDemux) {
    // One data net (for a decoder: the enable), then the select lines, then one
    // net per output: 1 + selectBits + channels ≤ 16. A decoder may declare an
    // EN pin, which then carries the enable instead of IN.
    const mode = p.b('decoderOnly', false) ? 2 : 1;
    const enablePin = mode === 2 ? spec.pins.find((pin) => pin.name === 'EN') : undefined;
    const enableConnected = enablePin && ctx.netOf(inst, 'EN') >= 0;
    nodes[n++] = enableConnected
      ? ctx.nodeOf(inst, 'EN')
      : dataPins[0]
        ? ctx.nodeOf(inst, dataPins[0].name)
        : 0;
    for (let i = 0; i < selectBits; i++) nodes[n++] = selPins[i] ? ctx.nodeOf(inst, selPins[i].name) : 0;
    for (let i = 0; i < channels; i++) {
      nodes[n++] = outPins[i]
        ? ctx.nodeOf(inst, outPins[i].name)
        : outPins[outPins.length - 1]
          ? ctx.nodeOf(inst, outPins[outPins.length - 1].name)
          : 0;
    }
  } else {
    // One net per channel, then the select lines, then the single output.
    for (let i = 0; i < channels; i++) {
      nodes[n++] = dataPins[i]
        ? ctx.nodeOf(inst, dataPins[i].name)
        : dataPins[dataPins.length - 1]
          ? ctx.nodeOf(inst, dataPins[dataPins.length - 1].name)
          : 0;
    }
    for (let i = 0; i < selectBits; i++) nodes[n++] = selPins[i] ? ctx.nodeOf(inst, selPins[i].name) : 0;
    nodes[n++] = ctx.nodeOf(inst, 'Y');
  }
  if (n > NODE_STRIDE) {
    ctx.addDiagnostic(
      error(
        'CF5104',
        `${inst.ref}: ${isDemux ? 'demultiplexer' : 'multiplexer'} with ${channels} channels needs ${n} nodes (max ${NODE_STRIDE}); use at most 8 channels`,
        { hint: 'Wider selectors are built from 8-way elements (a tree), not from a single element.' },
      ),
    );
    return;
  }
  sink.addElement(isDemux ? Kind.Demux : Kind.Mux, nodes, n, params, { instIndex });
}
