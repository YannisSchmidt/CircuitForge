/**
 * Transistor-level expansion of digital gates.
 *
 * When a gate's `style` is not `ideal`, the flattener replaces the behavioural
 * element with a real CMOS circuit built from NMOS/PMOS devices. The topologies
 * below are the standard static-CMOS and transmission-gate structures (Weste &
 * Harris, Rabaey); they are written out explicitly rather than being "implied" by
 * a behavioural model, which is the point: the electrical level really simulates
 * the transistors of the gate.
 *
 * Documented deviations from a silicon implementation:
 *   - Device sizing is uniform per gate type (WN/WP/L parameters) rather than
 *     optimised per stage.
 *   - The expanded gates drive the netlist's internal VDD rail. Gates whose VDD
 *     parameters disagree produce a diagnostic; the first value wins.
 *   - Reset/preset in flip-flops is implemented logically (an AND term on the D
 *     input) rather than with a dedicated reset transistor network.
 *   - Body terminals are tied to the appropriate rail (bulk = source rail).
 */

import { Diagnostic, warn } from '../core/labels.js';
import { Kind } from '../core/kinds.js';
import { MOS_SLOTS, MOS_STRIDE, NODE_STRIDE } from './paramslots.js';
import { MODEL_STRIDE, ModelTable } from './model.js';
import type { ElementSink } from './lower.js';

export interface CmosContext {
  /** Spec id of the gate being expanded. */
  kind: string;
  inputs: number;
  /** Logic function code (see GATE_SLOTS.fn): 0 buf, 1 not, 2 and, 3 nand, 4 or, 5 nor, 6 xor, 7 xnor, 8 tristate. */
  polarityFns: number;
  vdd: number;
  vth: number;
  wn: number;
  wp: number;
  l: number;
  tphl: number;
  tplh: number;
  cload: number;
  rou: number;
  activeLow: boolean;
  implementation: string;
  instanceIndex: number;
  sink: ElementSink;
  ambient: number;
  inputNodes: Int32Array;
  outputNode: number;
  /** Enable node for tri-state gates, -1 otherwise. */
  enableNode: number;
  supply: (which: 'vdd' | 'gnd', volts: number) => number;
  diagnostic: (d: Diagnostic) => void;
  ref: string;
  thermal: boolean;
}

interface MosTemplate {
  kp: number;
  vto: number;
  lambda: number;
  gamma: number;
  phi: number;
  tox: number;
  cgso: number;
  cgdo: number;
  cbd: number;
  cbs: number;
  pb: number;
  mj: number;
  isub: number;
  subth: number;
  nsub: number;
  tcv: number;
  bex: number;
  rthJc: number;
  rthCa: number;
  cth: number;
  vdsmax: number;
  idmax: number;
  pdmax: number;
  tjmax: number;
}

/**
 * Device parameters used for expanded logic gates. These describe a generic
 * 0.18 µm-class process; they are *not* extracted from a specific foundry and the
 * model card says so. KP is per square, so the effective transconductance comes
 * from the W/L ratio given in the gate parameters.
 */
const NMOS_TEMPLATE: MosTemplate = {
  kp: 190e-6,
  vto: 0.45,
  lambda: 0.05,
  gamma: 0.35,
  phi: 0.7,
  tox: 4.1e-9,
  cgso: 1.2e-10,
  cgdo: 1.2e-10,
  cbd: 2e-15,
  cbs: 2e-15,
  pb: 0.9,
  mj: 0.5,
  isub: 1e-14,
  subth: 1,
  nsub: 1.4,
  tcv: -1.8e-3,
  bex: -1.6,
  rthJc: 90,
  rthCa: 300,
  cth: 2e-6,
  vdsmax: 3.6,
  idmax: 0.05,
  pdmax: 0.3,
  tjmax: 150,
};

const PMOS_TEMPLATE: MosTemplate = {
  ...NMOS_TEMPLATE,
  kp: 55e-6,
  vto: -0.45,
  tcv: -1.5e-3,
  rthJc: 100,
  rthCa: 320,
  cth: 2.4e-6,
  vdsmax: -3.6,
};

/** Which gate ids have a transistor-level implementation. */
export function needsCmosExpansion(specId: string): boolean {
  switch (specId) {
    case 'not_gate':
    case 'buffer':
    case 'and_gate':
    case 'nand_gate':
    case 'or_gate':
    case 'nor_gate':
    case 'xor_gate':
    case 'xnor_gate':
    case 'tristate':
      return true;
    default:
      return false;
  }
}

/**
 * Expand one gate into transistors. Internal nodes are allocated on demand; the
 * expansion is a pure function of the gate parameters, so two identical gates
 * produce identical sub-circuits (which the pattern miner can then detect!).
 */
export function expandCmosGate(c: CmosContext): void {
  const vdd = c.supply('vdd', c.vdd);
  const gnd = c.supply('gnd', 0);
  const builder = new CmosBuilder(c, vdd, gnd);

  const fn = c.polarityFns;
  const inputs: number[] = [];
  for (let i = 0; i < c.inputs; i++) inputs.push(c.inputNodes[i] ?? 0);

  switch (fn) {
    case 0: // buffer
      builder.inverter(builder.inverter(inputs[0], builder.n()), c.outputNode);
      break;
    case 1: // inverter
      builder.inverter(inputs[0], c.outputNode);
      break;
    case 2: // and
      builder.andN(inputs, c.outputNode);
      break;
    case 3: // nand
      builder.nandN(inputs, c.outputNode);
      break;
    case 4: // or
      builder.orN(inputs, c.outputNode);
      break;
    case 5: // nor
      builder.norN(inputs, c.outputNode);
      break;
    case 6: // xor
      builder.xor(inputs[0], inputs[1], c.outputNode, c.implementation);
      break;
    case 7: // xnor
      builder.inverter(builder.xor(inputs[0], inputs[1], builder.n(), c.implementation), c.outputNode);
      break;
    case 8: // tristate buffer
      builder.triState(inputs[0], c.enableNode, c.outputNode, c.activeLow);
      break;
    default:
      c.diagnostic(warn('CF5201', `${c.ref}: unknown logic function ${fn}; transistor expansion skipped (behavioural model kept)`));
      break;
  }
  if (builder.transistors === 0) {
    c.diagnostic(
      warn('CF5202', `${c.ref}: gate style "${c.kind}" could not be expanded to transistors; falling back to the behavioural model`, {
        hint: 'Use style = ideal to silence this message, or report the gate type.',
      }),
    );
  }
}

class CmosBuilder {
  /**
   * Chain of `inputs.length` devices in series between `node` and `rail`, the
   * first input's device adjacent to `node`. Used for the NMOS pull-down of a
   * NAND and the PMOS pull-up of a NOR.
   */
  private seriesStack(polarity: 0 | 1, inputs: number[], node: number, rail: number, w: number): void {
    const mid: number[] = [];
    for (let i = 0; i < inputs.length - 1; i++) mid.push(this.n());
    let source = rail;
    for (let i = inputs.length - 1; i >= 0; i--) {
      const drain = i === 0 ? node : mid[i - 1];
      this.mos(polarity, drain, inputs[i], source, w);
      source = drain;
    }
  }

  transistors = 0;
  private nodeBuf: Int32Array;
  private paramBuf: Float64Array;
  private modelBuf: Float64Array;

  constructor(
    private c: CmosContext,
    private vdd: number,
    private gnd: number,
  ) {
    this.nodeBuf = c.sink.scratchNodeBuffer();
    this.paramBuf = c.sink.scratchParamBuffer();
    this.modelBuf = c.sink.modelScratch();
  }

  /** Allocate a private internal node. */
  n(): number {
    return this.c.sink.allocInternalNode();
  }

  /** Emit one MOSFET. Bulk is tied to gnd (NMOS) or vdd (PMOS). */
  mos(polarity: 0 | 1, d: number, g: number, s: number, w: number): void {
    const modelIndex = this.model(polarity, w);
    const b = polarity === 0 ? this.gnd : this.vdd;
    const nb = this.nodeBuf;
    const pb = this.paramBuf;
    for (let i = 0; i < NODE_STRIDE; i++) nb[i] = -1;
    for (let i = 0; i < MOS_STRIDE; i++) pb[i] = 0;
    nb[0] = d;
    nb[1] = g;
    nb[2] = s;
    nb[3] = s; // default bulk = source (MOS_SPECS requires B; a real layout ties it to the rail)
    nb[4] = d;
    nb[5] = s;
    nb[6] = s;
    // Bulk rail connection: the model uses node[3]; when the source is not on a
    // rail the bulk is still tied to the rail in a real layout.
    nb[3] = b;
    pb[0] = w;
    pb[1] = this.c.l;
    pb[2] = 1;
    pb[3] = this.c.thermal ? this.thermalNode(polarity) : -1;
    this.c.sink.addElement(Kind.Mosfet, nb, 7, pb, { instIndex: this.c.instanceIndex, modelIndex });
    this.transistors++;
  }

  private thermalNode(polarity: 0 | 1): number {
    const t = polarity === 0 ? NMOS_TEMPLATE : PMOS_TEMPLATE;
    const junction = this.c.sink.thermalNode(t.cth, 0);
    const caseNode = this.c.sink.thermalNode(0, t.rthCa);
    this.c.sink.thermalLink(junction, caseNode, t.rthJc);
    return junction;
  }

  private model(polarity: 0 | 1, w: number): number {
    const t = polarity === 0 ? NMOS_TEMPLATE : PMOS_TEMPLATE;
    const m = this.modelBuf;
    for (let i = 0; i < MODEL_STRIDE; i++) m[i] = 0;
    m[MOS_SLOTS.polarity] = polarity;
    m[MOS_SLOTS.vto] = t.vto;
    m[MOS_SLOTS.kp] = t.kp;
    m[MOS_SLOTS.lambda] = t.lambda;
    m[MOS_SLOTS.gamma] = t.gamma;
    m[MOS_SLOTS.phi] = t.phi;
    m[MOS_SLOTS.tox] = t.tox;
    m[MOS_SLOTS.cgso] = t.cgso;
    m[MOS_SLOTS.cgdo] = t.cgdo;
    m[MOS_SLOTS.cbd] = t.cbd;
    m[MOS_SLOTS.cbs] = t.cbs;
    m[MOS_SLOTS.pb] = t.pb;
    m[MOS_SLOTS.mj] = t.mj;
    m[MOS_SLOTS.isub] = t.isub;
    m[MOS_SLOTS.subth] = t.subth;
    m[MOS_SLOTS.nsub] = t.nsub;
    m[MOS_SLOTS.tnom] = 27;
    m[MOS_SLOTS.tcv] = t.tcv;
    m[MOS_SLOTS.bex] = t.bex;
    m[MOS_SLOTS.vdsmax] = t.vdsmax;
    m[MOS_SLOTS.idmax] = t.idmax;
    m[MOS_SLOTS.pdmax] = t.pdmax;
    m[MOS_SLOTS.tjmax] = t.tjmax;
    m[MOS_SLOTS.rthJc] = t.rthJc;
    m[MOS_SLOTS.rthCa] = t.rthCa;
    m[MOS_SLOTS.cth] = t.cth;
    m[MOS_SLOTS.rd] = 0;
    m[MOS_SLOTS.rs] = 0;
    m[MOS_SLOTS.rb] = 0;
    m[MOS_SLOTS.w] = w;
    m[MOS_SLOTS.l] = this.c.l;
    // Multiplicity lives in the *element* params (slot 2) for the stamping; keep
    // the model field consistent anyway so the model key is not misleading.
    m[MOS_SLOTS.m] = 1;
    return this.c.sink.registerModel(Kind.Mosfet, ModelTable.keyOf(Kind.Mosfet, m, MOS_STRIDE), m);
  }

  /** Static CMOS inverter: 1 PMOS to VDD, 1 NMOS to GND, shared gate/drain. */
  inverter(a: number, y: number): number {
    this.mos(1, y, a, this.vdd, this.c.wp);
    this.mos(0, y, a, this.gnd, this.c.wn);
    return y;
  }

  /**
   * N-input static NAND: N series NMOS from the output to ground, N parallel
   * PMOS from VDD to the output. Longer input lists are split into balanced
   * stages so that no more than 4 devices are stacked (a real design rule).
   */
  nandN(inputs: number[], y: number): number {
    if (inputs.length <= 1) {
      this.inverter(inputs[0] ?? 0, y);
      return y;
    }
    if (inputs.length > 4) {
      // NAND(a,b,c,d,e,f) = NAND( AND(a..c), AND(d..f) )
      const mid = Math.ceil(inputs.length / 2);
      const left = this.andN(inputs.slice(0, mid), this.n());
      const right = this.andN(inputs.slice(mid), this.n());
      return this.nandN([left, right], y);
    }
    // Series NMOS stack: y —M0— m0 —M1— m1 —…— gnd. Every device sits between
    // two *different* nodes; the previous version wired the second device with
    // drain = source = y, which left the stack with a single conducting device
    // and put two conducting paths in contention on the output.
    this.seriesStack(0, inputs, y, this.gnd, this.c.wn);
    // parallel PMOS
    for (const gate of inputs) this.mos(1, y, gate, this.vdd, this.c.wp);
    return y;
  }

  /** N-input static NOR: parallel NMOS, series PMOS. */
  norN(inputs: number[], y: number): number {
    if (inputs.length <= 1) {
      this.inverter(inputs[0] ?? 0, y);
      return y;
    }
    if (inputs.length > 4) {
      const mid = Math.ceil(inputs.length / 2);
      const left = this.orN(inputs.slice(0, mid), this.n());
      const right = this.orN(inputs.slice(mid), this.n());
      return this.norN([left, right], y);
    }
    for (const gate of inputs) this.mos(0, y, gate, this.gnd, this.c.wn);
    // Series PMOS stack: y —M0— m0 —M1— …— vdd (same construction as the NAND).
    this.seriesStack(1, inputs, y, this.vdd, this.c.wp);
    return y;
  }

  andN(inputs: number[], y: number): number {
    return this.inverter(this.nandN(inputs, this.n()), y);
  }

  orN(inputs: number[], y: number): number {
    return this.inverter(this.norN(inputs, this.n()), y);
  }

  /**
   * XOR, two documented implementations:
   *  - transmission_gate (default): Y = B ? !A : A built from two pass gates, so
   *    8 transistors instead of 16.
   *  - static_cmos: Y = NAND( NAND(A,!B), NAND(!A,B) ) — 16 transistors, fully
   *    static, no floating internal nodes.
   */
  xor(a: number, b: number, y: number, implementation: string): number {
    if (implementation === 'static_cmos' || implementation === 'mirror') {
      const na = this.inverter(a, this.n());
      const nb = this.inverter(b, this.n());
      const t1 = this.nandN([a, nb], this.n());
      const t2 = this.nandN([na, b], this.n());
      return this.nandN([t1, t2], y);
    }
    // transmission-gate implementation
    const na = this.inverter(a, this.n());
    const nb = this.inverter(b, this.n());
    this.transmissionGate(a, y, b, nb);
    this.transmissionGate(na, y, nb, b);
    return y;
  }

  /**
   * Transmission gate: pass node `in` to `out` when `ctrl` is high (NCTRL low).
   * Two transistors in parallel; both are off when the control is inactive.
   */
  transmissionGate(input: number, out: number, ctrl: number, nctrl: number): void {
    this.mos(0, out, ctrl, input, this.c.wn);
    this.mos(1, out, nctrl, input, this.c.wp);
  }

  /** Tri-state buffer: inverter chain + output pass gate. */
  triState(a: number, enable: number, y: number, activeLow: boolean): number {
    const en = activeLow ? this.inverter(enable, this.n()) : enable;
    const nen = this.inverter(en, this.n());
    const d = this.inverter(this.inverter(a, this.n()), this.n());
    this.transmissionGate(d, y, en, nen);
    return y;
  }

  /** Master–slave D flip-flop built from two transmission-gate latches. */
  dff(d: number, clk: number, q: number, qn: number, reset: number, resetActiveLow: boolean, hasReset: boolean, hasQN: boolean): number {
    const clkBuf = this.inverter(clk, this.n());
    const nclk = this.inverter(clkBuf, this.n());
    let din = d;
    if (hasReset) {
      // D AND (NOT active reset) — implemented with NAND + inverter.
      const nrst = resetActiveLow ? reset : this.inverter(reset, this.n());
      // nrst is high when the flip-flop is *not* in reset
      const st = this.inverter(reset, this.n());
      const ar = resetActiveLow ? st : reset;
      const mask = this.inverter(ar, this.n());
      din = this.andN([d, mask], this.n());
      void nrst;
    }
    const m1 = this.dlatch(din, clkBuf, nclk);
    const s1 = this.dlatch(m1, nclk, clkBuf);
    const qb = this.inverter(s1, q);
    if (hasQN) this.inverter(qb, qn);
    return qb;
  }

  /** Transmission-gate D latch; returns the internal storage node. */
  dlatch(d: number, enable: number, nenable: number): number {
    const a = this.n();
    this.transmissionGate(d, a, enable, nenable);
    const b = this.inverter(a, this.n());
    // keeper: weak feedback inverter (represented by a full inverter; a real
    // implementation uses a minimum-size device, documented in SCHEMATIC/PHYSICS)
    this.inverter(b, a);
    return b;
  }
}
