/**
 * Element stamping.
 *
 * `stampElement` contributes one element to the MNA system. The same function is
 * used for the DC operating point (capacitors open, inductors short), for the
 * transient companion models, and for the AC small-signal matrix (where the
 * devices are replaced by their linearised conductances and the branch elements
 * by their complex impedances — the AC path lives in `ac.ts` and reuses
 * `linearise()` from here).
 *
 * Conventions
 *   - node 0 is ground and has no matrix row; `row(node)` returns -1 for it.
 *   - a voltage-defined element owns a branch unknown whose current flows from
 *     its first node to its second one.
 *   - for a nonlinear element, the linearised form i = g·v + Ieq is stamped as a
 *     conductance g plus a current injection −Ieq at the first node (+Ieq at the
 *     second), which is the standard Norton equivalent.
 */

import type { FlatNetlist } from './netlist.js';
import { evalWaveTable } from './lower.js';
import { NODE_STRIDE, STATE_STRIDE } from './paramslots.js';
import {
  BJT_SLOTS,
  C_SLOTS,
  CS_SLOTS,
  D_SLOTS,
  DFF_SLOTS,
  GATE_SLOTS,
  L_SLOTS,
  MOS_SLOTS,
  MUX_SLOTS,
  POT_SLOTS,
  PROBE_SLOTS,
  R_SLOTS,
  RELAY_SLOTS,
  SRC_SLOTS,
  SW_SLOTS,
  XFMR_SLOTS,
} from './paramslots.js';
import { Kind } from '../core/kinds.js';
import { MODEL_STRIDE } from './model.js';
import {
  bjtEvaluate,
  bjtScaleTemperature,
  diodeIsAtTemperature,
  diodeJunction,
  junctionCapacitance,
  mosCapacitances,
  mosEvaluate,
  safeExp,
  vt,
  type BjtParams,
} from './device-models.js';
import type { SparseMatrix } from './matrix.js';

export interface SimState {
  nl: FlatNetlist;
  m: SparseMatrix;
  /** Right-hand side (current injections). */
  rhs: Float64Array;
  /** Node voltages; index = node, v[0] = 0 (ground). */
  v: Float64Array;
  /** Branch currents indexed by branch index. */
  ib: Float64Array;
  /** Previous accepted time point (transient) / previous Newton iterate. */
  vOld: Float64Array;
  ibOld: Float64Array;
  /** Device temperatures in °C, indexed by element. */
  tempEl: Float64Array;
  /** Node temperature (°C) for non-self-heating elements. */
  ambient: number;
  time: number;
  dt: number;
  mode: 'dc' | 'tran';
  /** 0 = backward Euler, 1 = trapezoidal. */
  integration: number;
  gmin: number;
  /** Per-element current computed during stamping (for reports). */
  elementCurrent: Float64Array;
  /** Per-element dissipated power computed during stamping (W). */
  elementPower: Float64Array;
  iteration: number;
  /** Random source instance (for noise elements) — deterministic. */
  noiseScale: number;
  /** Enables junction capacitance stamping in transient. */
  useCapacitances: boolean;
  /** True when the caller wants the Newton-Raphson Jacobian only (AC). */
  jacobianOnly: boolean;
  /**
   * When true, the junction limiters are bypassed and the devices are evaluated
   * with their true terminal voltages. The solver sets it while it measures the
   * residual of the nonlinear system: the limiter is a Newton step-control device,
   * not part of the model, and if it were allowed to move the junctions during the
   * residual check it would hide a large KCL mismatch and declare a false
   * convergence.
   */
  noLimiting: boolean;
}

// ---------------------------------------------------------------------------

export function row(node: number): number {
  return node <= 0 ? -1 : node - 1;
}

export function branchRow(ctx: SimState, branch: number): number {
  return ctx.nl.nodeCount - 1 + branch;
}

/** Stamp a conductance g between nodes a and b. */
export function stampG(ctx: SimState, a: number, b: number, g: number): void {
  if (g === 0) return;
  const ra = row(a);
  const rb = row(b);
  if (ra >= 0) ctx.m.add(ra, ra, g);
  if (rb >= 0) ctx.m.add(rb, rb, g);
  if (ra >= 0 && rb >= 0) {
    ctx.m.add(ra, rb, -g);
    ctx.m.add(rb, ra, -g);
  }
}

/** Inject current I into node n (positive = into the node). */
export function inject(ctx: SimState, n: number, i: number): void {
  if (i === 0) return;
  const r = row(n);
  if (r >= 0) ctx.rhs[r] += i;
}

/** Add one Jacobian entry (row, col) for node indices, skipping ground. */
export function addMatrix(ctx: SimState, node: number, colNode: number, v: number): void {
  if (v === 0) return;
  const r = row(node);
  const c = row(colNode);
  if (r >= 0 && c >= 0) ctx.m.add(r, c, v);
}

/** Norton equivalent: current i = g·(va−vb) + ieq flowing from a to b. */
function stampNorton(ctx: SimState, a: number, b: number, g: number, ieq: number): void {
  stampG(ctx, a, b, g);
  inject(ctx, a, -ieq);
  inject(ctx, b, ieq);
}

/** Linearised two-terminal admittance: i = G(v)·(va−vb) + Ieq. */
function stampAdmittance(ctx: SimState, a: number, b: number, g: number, ieq: number): void {
  stampNorton(ctx, a, b, g, ieq);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Instantaneous value of an independent source.
 * `family`: 0 voltage, 1 current, 2 noise voltage, 3 noise current, 4 clock,
 * 5 battery (Thévenin with state of charge).
 */
export function sourceValue(ctx: SimState, e: number, dcOnly = false): number {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const family = p[o + SRC_SLOTS.family];
  const wave = p[o + SRC_SLOTS.waveform];
  const dc = p[o + SRC_SLOTS.dc];
  const amp = p[o + SRC_SLOTS.amp];
  const freq = p[o + SRC_SLOTS.freq];
  const phase = p[o + SRC_SLOTS.phase];
  const duty = p[o + SRC_SLOTS.duty];
  const tr = p[o + SRC_SLOTS.tr];
  const tf = p[o + SRC_SLOTS.tf];
  const delay = p[o + SRC_SLOTS.delay];

  if (family === 5) {
    // Battery: Voc = Vfull·(1 − tempco·ΔT)·SoC mapped between vnom (SoC=1) and
    // cutoff (SoC=0). The state of charge is integrated by the caller (state[0]).
    const sOff = nl.stateOffset[e];
    const soc = nl.state[sOff];
    const cutoff = amp;
    const vfull = dc;
    return cutoff + (vfull - cutoff) * Math.max(0, Math.min(1, soc));
  }
  if (family === 2 || family === 3) {
    // Noise source: amp already holds the scaled random sample for this step.
    return dc + amp;
  }
  if (dcOnly || wave === 0) return dc;

  const t = ctx.time - delay;
  if (t < 0) return dc;
  switch (wave) {
    case 1: {
      // sine
      const w = 2 * Math.PI * freq;
      return dc + amp * Math.sin(w * t + (phase * Math.PI) / 180);
    }
    case 2:
    case 5:
    case 6: {
      // square / pulse / clock: trapezoid with rise and fall times
      const period = 1 / Math.max(1e-12, freq);
      const th = duty * period;
      let tt = t % period;
      if (!Number.isFinite(tt)) tt = 0;
      const rise = Math.max(1e-15, tr);
      const fall = Math.max(1e-15, tf);
      let v = 0;
      if (tt < th - fall / 2) v = 1;
      else if (tt < th + fall / 2) v = 1 - (tt - (th - fall / 2)) / fall;
      else if (tt < period - rise / 2) v = 0;
      else v = (tt - (period - rise / 2)) / rise;
      v = Math.max(0, Math.min(1, v));
      return dc + amp * v;
    }
    case 3: {
      // triangle
      const period = 1 / Math.max(1e-12, freq);
      const x = (t % period) / period;
      const tri = x < 0.5 ? 4 * x - 1 : 3 - 4 * x;
      return dc + amp * tri;
    }
    case 4: {
      // sawtooth
      const period = 1 / Math.max(1e-12, freq);
      const x = (t % period) / period;
      return dc + amp * (2 * x - 1);
    }
    case 7: {
      return dc + amp;
    }
    case 8: {
      // Arbitrary piecewise-linear waveform. The table is `nl.waveTables[handle]`
      // with interleaved [t0,v0,t1,v1,…]; `dc` is an offset added to it and `delay`
      // shifts it in time. `amp`, `freq`, `duty`, `tr` and `tf` have no meaning for
      // a table and are ignored — the table *is* the waveform, so scaling it would
      // make the same text mean two different things depending on a parameter the
      // user did not think about.
      const handle = p[o + SRC_SLOTS.table];
      const tables = nl.waveTables;
      if (!Number.isFinite(handle) || handle < 0 || !tables || handle >= tables.length) {
        // A table that could not be registered was reported at flatten time
        // (CF4008); holding the DC offset is the documented fallback, not a guess.
        return dc;
      }
      const tt = t;
      return dc + evalWaveTable(tables[handle], tt);
    }
    default:
      return dc;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function stampElement(ctx: SimState, e: number): void {
  const k = ctx.nl.kind[e];
  switch (k) {
    case Kind.Resistor:
    case Kind.NtcThermistor:
    case Kind.Varistor:
    case Kind.AmmeterShunt:
      stampResistorFamily(ctx, e, k);
      break;
    case Kind.Capacitor:
      stampCapacitor(ctx, e);
      break;
    case Kind.Inductor:
      stampInductor(ctx, e);
      break;
    case Kind.Potentiometer:
      stampPotentiometer(ctx, e);
      break;
    case Kind.Transformer:
      stampTransformer(ctx, e);
      break;
    case Kind.Diode:
    case Kind.Led:
    case Kind.Photodiode:
      stampDiode(ctx, e);
      break;
    case Kind.Bjt:
      stampBjt(ctx, e);
      break;
    case Kind.Mosfet:
      stampMosfet(ctx, e);
      break;
    case Kind.Switch:
    case Kind.PushButton:
      stampSwitch(ctx, e);
      break;
    case Kind.Relay:
      stampRelay(ctx, e);
      break;
    case Kind.VoltageSource:
    case Kind.CurrentSource:
    case Kind.NoiseSource:
      stampSource(ctx, e);
      break;
    case Kind.Vcvs:
    case Kind.Vccs:
    case Kind.Ccvs:
    case Kind.Cccs:
      stampControlledSource(ctx, e);
      break;
    case Kind.LogicGate:
    case Kind.LogicBuf:
    case Kind.TriState:
      stampGate(ctx, e);
      break;
    case Kind.DFlipFlop:
      stampDff(ctx, e);
      break;
    case Kind.DLatch:
      stampDLatch(ctx, e);
      break;
    case Kind.Mux:
    case Kind.Demux:
      stampMux(ctx, e);
      break;
    case Kind.Probe:
    case Kind.Wattmeter:
      // Observers: they neither drive nor load the circuit in the ideal case.
      recordProbeValue(ctx, e);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Passives
// ---------------------------------------------------------------------------

function elementTemperature(ctx: SimState, e: number, thermalSlot: number): number {
  const nl = ctx.nl;
  const tn = nl.params[nl.paramOffset[e] + thermalSlot];
  if (tn >= 0 && tn < nl.thermalTemperature.length) return nl.thermalTemperature[tn] - 273.15;
  return ctx.ambient;
}

function stampResistorFamily(ctx: SimState, e: number, kind: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 3);
  const a = n[0];
  const b = n[1];
  const mode = kind === Kind.NtcThermistor ? 1 : kind === Kind.Varistor ? 2 : p[o + R_SLOTS.mode];

  let g: number;
  let ieq = 0;
  let current = 0;
  const va = ctx.v[a];
  const vb = ctx.v[b];
  const v = va - vb;
  const temp = elementTemperature(ctx, e, R_SLOTS.thermalNode);
  let rNominal = 1;

  if (mode === 1) {
    // NTC thermistor: R(T) = R25·exp(B·(1/T − 1/T25))
    const r25 = p[o + R_SLOTS.r];
    const bCoef = p[o + R_SLOTS.b];
    const tK = temp + 273.15;
    const rT = r25 * Math.exp(bCoef * (1 / tK - 1 / 298.15));
    rNominal = Number.isFinite(rT) && rT > 1e-6 ? rT : 1e9;
    g = 1 / rNominal;
  } else if (mode === 2 || kind === Kind.Varistor) {
    // Varistor: i = sign(v)·k·|v/vref|^alpha with k chosen so that i(vref) = 1 mA.
    const vref = Math.max(1e-6, p[o + R_SLOTS.vref]);
    const alpha = Math.max(2, p[o + R_SLOTS.alpha]);
    const gOff = 1 / Math.max(1e-9, p[o + R_SLOTS.r]);
    const k = 1e-3;
    const av = Math.abs(v);
    const ratio = av / vref;
    const i = Math.sign(v) * k * Math.pow(ratio, alpha) + gOff * v;
    const dIdV = k * alpha * Math.pow(Math.max(1e-9, ratio), alpha - 1) / vref + gOff;
    g = dIdV;
    ieq = i - g * v;
    current = i;
  } else {
    const r0 = Math.max(1e-12, p[o + R_SLOTS.r]);
    const tc1 = p[o + R_SLOTS.tc1];
    const tc2 = p[o + R_SLOTS.tc2];
    const tnom = p[o + R_SLOTS.tnom];
    const dT = temp - tnom;
    rNominal = r0 * (1 + tc1 * dT + tc2 * dT * dT);
    if (!(rNominal > 1e-12)) rNominal = 1e-12;
    g = 1 / rNominal;
  }

  if (kind === Kind.AmmeterShunt) {
    // Ideal ammeter: a zero-volt source, so the current is a solver unknown.
    const br = nl.branchIndex[e];
    if (br >= 0) {
      const ra = row(a);
      const rb = row(b);
      const rbr = branchRow(ctx, br);
      if (ra >= 0) ctx.m.add(ra, rbr, 1);
      if (rb >= 0) ctx.m.add(rb, rbr, -1);
      if (ra >= 0) ctx.m.add(rbr, ra, 1);
      if (rb >= 0) ctx.m.add(rbr, rb, -1);
      ctx.rhs[rbr] += 0;
      ctx.elementCurrent[e] = ctx.ib[br];
      return;
    }
  }

  stampAdmittance(ctx, a, b, g, ieq);
  current = mode === 0 && ieq === 0 ? g * v : current || g * v + ieq;
  ctx.elementCurrent[e] = current;
  // Absorbed power of a resistive element: V²/R with the conductance the stamp
  // actually installed (so a nonlinear mode uses its present operating-point
  // resistance). Always dissipating, so the sign is unambiguous.
  ctx.elementPower[e] = v * v * g;
  void rNominal;
}

function stampCapacitor(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const sOff = nl.stateOffset[e];
  const st = nl.state.subarray(sOff, sOff + STATE_STRIDE);

  // Layout: c>0/dc>…, esr between n[0] and the internal node, the capacitance
  // (and leakage) between the internal node and n[last].
  const hasInternal = nodeCount === 3;
  const a = n[0];
  const b = hasInternal ? n[2] : n[1];
  const mid = hasInternal ? n[1] : a;

  const c = Math.max(0, p[o + C_SLOTS.c]);
  const vmax = p[o + C_SLOTS.vmax];
  if (hasInternal) {
    const esr = Math.max(1e-12, p[o + C_SLOTS.esr]);
    const esl = p[o + C_SLOTS.esl];
    stampG(ctx, a, mid, 1 / esr);
    if (esl > 0) {
      // Series inductance: branch equation (L/dt)·i − (v_a − v_mid) = (L/dt)·i_prev
      const br = nl.branchIndex[e];
      if (br >= 0) {
        const rbr = branchRow(ctx, br);
        const ra = row(a);
        const rm = row(mid);
        const gL = ctx.integration === 0 ? esl / ctx.dt : (2 * esl) / ctx.dt;
        if (ra >= 0) ctx.m.add(ra, rbr, 1);
        if (rm >= 0) ctx.m.add(rm, rbr, -1);
        if (ra >= 0) ctx.m.add(rbr, ra, 1);
        if (rm >= 0) ctx.m.add(rbr, rm, -1);
        ctx.m.add(rbr, rbr, -gL);
        ctx.rhs[rbr] += -gL * st[3];
      }
    }
  }

  if (ctx.mode === 'dc' || !ctx.useCapacitances) {
    // DC: a capacitor is an open circuit; only the leakage conductance remains.
    const gleak = p[o + C_SLOTS.gleak];
    if (gleak > 0) stampG(ctx, mid, b, gleak);
    const v = ctx.v[mid] - ctx.v[b];
    ctx.elementCurrent[e] = gleak * v;
    ctx.elementPower[e] = 0;
    return;
  }

  const vc = ctx.v[mid] - ctx.v[b];
  const vcOld = st[0];
  const iOld = st[1];
  // Composition: C(V) = C·(1 + vc1·Vc)
  const vc1 = p[o + C_SLOTS.vc1];
  const cEff = Math.max(1e-18, c * (1 + vc1 * vc));
  let geq: number;
  let ieq: number;
  if (ctx.integration === 0) {
    // Backward Euler: i = (C/dt)(v − vOld)
    geq = cEff / ctx.dt;
    ieq = -(cEff / ctx.dt) * vcOld;
  } else {
    // Trapezoidal: i = (2C/dt)(v − vOld) − iOld
    geq = (2 * cEff) / ctx.dt;
    ieq = -(2 * cEff / ctx.dt) * vcOld - iOld;
  }
  const gleak = p[o + C_SLOTS.gleak];
  stampNorton(ctx, mid, b, geq + gleak, ieq);
  const i = geq * vc + ieq;
  ctx.elementCurrent[e] = i;
  // Signed absorbed power, V·I in the same direction: positive while charging,
  // negative while delivering (a discharging capacitor heats nothing).
  ctx.elementPower[e] = i * vc;
  // Overstress (|Vc| > Vmax) is detected by the analyser from the measured
  // voltage and the parameter; the model itself does not change behaviour.
  void vmax;
}

function stampInductor(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 2);
  const sOff = nl.stateOffset[e];
  const st = nl.state.subarray(sOff, sOff + STATE_STRIDE);
  const a = n[0];
  const b = n[1];
  const br = nl.branchIndex[e];
  if (br < 0) return;
  const l = Math.max(1e-15, p[o + L_SLOTS.l]);
  const dcr = Math.max(0, p[o + L_SLOTS.dcr]);
  const iOld = st[0];
  const vOld = st[1];
  const ra = row(a);
  const rb = row(b);
  const rbr = branchRow(ctx, br);
  let req: number;
  let veq: number;
  if (ctx.mode === 'dc') {
    // DC: a short circuit with its winding resistance.
    req = dcr > 0 ? dcr : 1e-9;
    veq = 0;
  } else if (ctx.integration === 0) {
    const gL = l / ctx.dt;
    req = gL + dcr;
    veq = gL * iOld;
  } else {
    const gL = (2 * l) / ctx.dt;
    req = gL + dcr;
    veq = gL * iOld + vOld;
  }
  if (ra >= 0) ctx.m.add(ra, rbr, 1);
  if (rb >= 0) ctx.m.add(rb, rbr, -1);
  if (ra >= 0) ctx.m.add(rbr, ra, 1);
  if (rb >= 0) ctx.m.add(rbr, rb, -1);
  ctx.m.add(rbr, rbr, -req);
  ctx.rhs[rbr] += veq;
  ctx.elementPower[e] = 0;
}

function stampPotentiometer(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 3);
  const [p1, w, p3] = [n[0], n[1], n[2]];
  const r = Math.max(1e-3, p[o + POT_SLOTS.r]);
  let wiper = Math.min(1, Math.max(0, p[o + POT_SLOTS.wiper]));
  if (p[o + POT_SLOTS.taper] > 0.5) {
    // Logarithmic taper: the resistance from pin 1 to the wiper is
    // R·(1 − 10^(−2p))… implemented as the standard audio-taper law.
    wiper = Math.pow(10, -2 * (1 - wiper));
  }
  const rw = Math.max(0, p[o + POT_SLOTS.rw]);
  const rterm = Math.max(0, p[o + POT_SLOTS.rterm]);
  const rTop = Math.max(1e-6, r * (1 - wiper) + rterm + rw);
  const rBot = Math.max(1e-6, r * wiper + rterm + rw);
  stampG(ctx, p1, w, 1 / rTop);
  stampG(ctx, w, p3, 1 / rBot);
  const vTop = ctx.v[p1] - ctx.v[w];
  const vBot = ctx.v[w] - ctx.v[p3];
  ctx.elementCurrent[e] = vTop / rTop + vBot / rBot;
  ctx.elementPower[e] = Math.abs((vTop * vTop) / rTop) + Math.abs((vBot * vBot) / rBot);
}

function stampTransformer(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 4);
  const [p1, p2, s1, s2] = [n[0], n[1], n[2], n[3]];
  const l1 = Math.max(1e-12, p[o + XFMR_SLOTS.l1]);
  const l2 = Math.max(1e-12, p[o + XFMR_SLOTS.l2]);
  const k = Math.min(0.999999, Math.max(0.0001, p[o + XFMR_SLOTS.k]));
  const rp = Math.max(0, p[o + XFMR_SLOTS.rp]);
  const rs = Math.max(0, p[o + XFMR_SLOTS.rs]);
  const m = k * Math.sqrt(l1 * l2);
  const br = nl.branchIndex[e];
  if (br < 0) return;
  const b1 = branchRow(ctx, br);
  const b2 = branchRow(ctx, br + 1);

  // Branch equations: v1 = L1·di1/dt + M·di2/dt + R1·i1 ; same for winding 2.
  const isDC = ctx.mode === 'dc' || ctx.dt <= 0;
  const g11 = isDC ? 0 : (ctx.integration === 0 ? l1 / ctx.dt : (2 * l1) / ctx.dt);
  const g22 = isDC ? 0 : (ctx.integration === 0 ? l2 / ctx.dt : (2 * l2) / ctx.dt);
  const g12 = isDC ? 0 : (ctx.integration === 0 ? m / ctx.dt : (2 * m) / ctx.dt);
  const sOff = nl.stateOffset[e];
  const st = nl.state.subarray(sOff, sOff + STATE_STRIDE);
  const i1Old = st[0];
  const i2Old = st[1];
  const v1Old = st[2];
  const v2Old = st[3];
  const trap = ctx.integration !== 0 && !isDC;

  // row 1: v(p1)-v(p2) − (g11+rp)·i1 − g12·i2 = rhs1
  const ra1 = row(p1);
  const rb1 = row(p2);
  const ra2 = row(s1);
  const rb2 = row(s2);
  if (ra1 >= 0) ctx.m.add(ra1, b1, 1);
  if (rb1 >= 0) ctx.m.add(rb1, b1, -1);
  if (ra1 >= 0) ctx.m.add(b1, ra1, 1);
  if (rb1 >= 0) ctx.m.add(b1, rb1, -1);
  ctx.m.add(b1, b1, -(g11 + (isDC ? (rp > 0 ? rp : 1e-9) : rp)));
  ctx.m.add(b1, b2, -g12);
  ctx.rhs[b1] += isDC ? 0 : g11 * i1Old + g12 * i2Old + (trap ? v1Old : 0);

  if (ra2 >= 0) ctx.m.add(ra2, b2, 1);
  if (rb2 >= 0) ctx.m.add(rb2, b2, -1);
  if (ra2 >= 0) ctx.m.add(b2, ra2, 1);
  if (rb2 >= 0) ctx.m.add(b2, rb2, -1);
  ctx.m.add(b2, b2, -(g22 + (isDC ? (rs > 0 ? rs : 1e-9) : rs)));
  ctx.m.add(b2, b1, -g12);
  ctx.rhs[b2] += isDC ? 0 : g22 * i2Old + g12 * i1Old + (trap ? v2Old : 0);
}

// ---------------------------------------------------------------------------
// Semiconductors
// ---------------------------------------------------------------------------

function stampDiode(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const mo = nl.modelIndex[e] * MODEL_STRIDE;
  const p = nl.params;
  const mp = nl.modelParams;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const a = n[0];
  const kNode = n[nodeCount - 1];
  const mid = nodeCount === 3 ? n[1] : a;
  const state = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);

  const temp = elementTemperature(ctx, e, 1);
  const vtV = vt(temp);
  const isT = diodeIsAtTemperature(mp[mo + D_SLOTS.is], mp[mo + D_SLOTS.n], mp[mo + D_SLOTS.eg], mp[mo + D_SLOTS.xti], mp[mo + D_SLOTS.tnom], temp);
  const rs = mp[mo + D_SLOTS.rs];
  if (rs > 0 && nodeCount === 3) {
    stampG(ctx, a, mid, 1 / rs);
    stampG(ctx, mid, kNode, ctx.gmin); // keeps the internal node connected
  }

  // Junction (with optional photocurrent injected in parallel).
  const vRaw = ctx.v[mid] - ctx.v[kNode];
  const v = junctionLimit(ctx, vRaw, state[0], vtV, isT);
  // state[0] is the junction-voltage memory of the limiter (SPICE's `vte`), not
  // an accepted-timepoint quantity: pnjlim needs the *previous limited* voltage
  // to bound the next step, so it must be written here, during Newton.
  // recordElementState() overwrites it with the raw voltage afterwards.
  if (!ctx.noLimiting) state[0] = v;
  const res = diodeJunction(v, isT, Math.max(0.5, mp[mo + D_SLOTS.n]), vtV, mp[mo + D_SLOTS.bv], mp[mo + D_SLOTS.ibv]);
  const variant = mp[mo + D_SLOTS.variant];
  let iphoto = 0;
  if (variant === 2) {
    // Photodiode: Iph = responsivity · optical power, flowing from cathode to
    // anode inside the device (i.e. it forward-biases the junction sense).
    const area = p[o + 0];
    const incident = p[o + 2];
    iphoto = -mp[mo + D_SLOTS.responsivity] * incident * area;
    const darkTemp = mp[mo + D_SLOTS.dark] * Math.pow(2, (temp - 25) / 10);
    iphoto -= darkTemp;
  }
  const ieq = res.i - res.g * v;
  stampAdmittance(ctx, mid, kNode, res.g, ieq);
  if (iphoto !== 0) {
    inject(ctx, kNode, iphoto);
    inject(ctx, mid, -iphoto);
  }

  // Junction capacitance (transient only).
  if (ctx.mode === 'tran' && ctx.useCapacitances) {
    const cj = junctionCapacitance(v, mp[mo + D_SLOTS.cj0], mp[mo + D_SLOTS.vj], mp[mo + D_SLOTS.m]);
    if (cj > 0) {
      const g = cj / ctx.dt;
      const ieqC = -g * state[1];
      stampNorton(ctx, mid, kNode, g, ieqC);
    }
  }
  const iTotal = res.i + iphoto;
  ctx.elementCurrent[e] = iTotal;
  // Absorbed power measured at the *terminals*: V(A→K)·I(A→K). The model keeps
  // an internal node behind the series resistance rs, and the device also
  // dissipates rs·I², so using the internal junction voltage would under-report
  // the element's dissipation. Signed: negative for a photodiode that is
  // delivering the power its illumination generated.
  ctx.elementPower[e] = (ctx.v[a] - ctx.v[kNode]) * iTotal;
}

/**
 * SPICE-style junction limiting (pnjlim) to keep Newton from overshooting.
 * The critical voltage uses the *device's own* saturation current — an LED with
 * Is = 1e-21 A must be allowed to reach ~2 V before it is clamped.
 */
function limitJunction(vNew: number, vOld: number, vtV: number, is = 1e-14): number {
  const vcrit = vtV * Math.log(vtV / (Math.SQRT2 * Math.max(1e-30, is)));
  const vte = vtV + 1e-9;
  if (vNew > vcrit && Math.abs(vNew - vOld) > 2 * vte) {
    if (vOld > 0) {
      const arg = 1 + (vNew - vOld) / vte;
      return arg > 0 ? vOld + vte * Math.log(arg) : vcrit;
    }
    return vte * Math.log(Math.max(1e-12, vNew / vte));
  }
  return vNew;
}

/** Limiter entry point: a no-op while the solver measures the true residual. */
function junctionLimit(ctx: SimState, vNew: number, vOld: number, vtV: number, is = 1e-14): number {
  return ctx.noLimiting ? vNew : limitJunction(vNew, vOld, vtV, is);
}

/**
 * Damping of a **channel** voltage step (gate-source, drain-source).
 *
 * `limitJunction` above is the right limiter for a pn junction, whose current is
 * exponential in the junction voltage *around a known scale* (vcrit). A MOSFET
 * channel is different: below threshold it is exponential in Vgs too, but the
 * "scale" moves with the operating point, so SPICE limits the step differently
 * (`fetlim`). This is the same idea with an explicit rule:
 *
 *     a channel voltage may move by at most max(1 V, |v_old|) per iteration
 *
 * Why it matters: without it, the first Newton iterations of a cold start (all
 * node voltages at 0, the supply stepping to 3.3 V) put tens of volts on the gate
 * of a device whose exponential subthreshold region is meaningless there; the
 * next iterate then lands at ±1 kV and the solve never returns. With it, the
 * channel voltage grows geometrically (1 V, 2 V, 4 V…) over a handful of
 * iterations — the standard behaviour of a SPICE-like simulator.
 *
 * The rule only damps the *path*: as the steps shrink, the limit stops acting, so
 * the converged solution is bit-for-bit the solution of the unlimited system
 * (verified by the residual test in the solver: a limited iterate is only
 * accepted when the *unlimited* KCL residual is zero). This is a numerical
 * method, not a device model — the model cards are unchanged.
 */
function limitChannelStep(vNew: number, vOld: number): number {
  const span = Math.max(1, Math.abs(vOld));
  const d = vNew - vOld;
  if (d > span) return vOld + span;
  if (d < -span) return vOld - span;
  return vNew;
}

function stampBjt(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const mo = nl.modelIndex[e] * MODEL_STRIDE;
  const mp = nl.modelParams;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const [c, b, eNode, nC, nB, nE] = [n[0], n[1], n[2], n[3], n[4], n[5]];
  const state = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const temp = elementTemperature(ctx, e, 1);
  const vtV = vt(temp);
  const polarity = mp[mo + BJT_SLOTS.polarity];
  const s = polarity === 0 ? 1 : -1;

  const rb = mp[mo + BJT_SLOTS.rb];
  const rc = mp[mo + BJT_SLOTS.rc];
  const re = mp[mo + BJT_SLOTS.re];
  if (rc > 0 && nodeCount > 3) stampG(ctx, c, nC, 1 / rc);
  if (rb > 0 && nodeCount > 3) stampG(ctx, b, nB, 1 / rb);
  if (re > 0 && nodeCount > 3) stampG(ctx, eNode, nE, 1 / re);
  if (nodeCount > 3) {
    stampG(ctx, nC, k0(), ctx.gmin);
    stampG(ctx, nB, k0(), ctx.gmin);
    stampG(ctx, nE, k0(), ctx.gmin);
  }

  const scaled = bjtScaleTemperature(mp[mo + BJT_SLOTS.is], mp[mo + BJT_SLOTS.bf], mp[mo + BJT_SLOTS.xtb], mp[mo + BJT_SLOTS.eg], mp[mo + BJT_SLOTS.xti], mp[mo + BJT_SLOTS.tnom], temp);
  // Limit the junction voltages (pnjlim on both junctions) and remember the
  // limited values: recordElementState() refreshes the memory on acceptance.
  const vbeRaw = s * (ctx.v[nB] - ctx.v[nE]);
  const vbcRaw = s * (ctx.v[nB] - ctx.v[nC]);
  const vbe = junctionLimit(ctx, vbeRaw, state[0], vtV, scaled.is);
  const vbc = junctionLimit(ctx, vbcRaw, state[1], vtV, scaled.is);
  if (!ctx.noLimiting) {
    state[0] = vbe;
    state[1] = vbc;
  }
  const params: BjtParams = {
    polarity,
    is: scaled.is,
    bf: scaled.bf,
    br: mp[mo + BJT_SLOTS.br],
    nf: Math.max(0.5, mp[mo + BJT_SLOTS.nf]),
    nr: Math.max(0.5, mp[mo + BJT_SLOTS.nr]),
    vaf: mp[mo + BJT_SLOTS.vaf],
    varV: mp[mo + BJT_SLOTS.var],
    ikf: mp[mo + BJT_SLOTS.ikf],
    ise: mp[mo + BJT_SLOTS.ise],
    ne: Math.max(1, mp[mo + BJT_SLOTS.ne]),
    isc: mp[mo + BJT_SLOTS.isc],
    nc: Math.max(1, mp[mo + BJT_SLOTS.nc]),
    tnom: mp[mo + BJT_SLOTS.tnom],
    xtb: mp[mo + BJT_SLOTS.xtb],
    eg: mp[mo + BJT_SLOTS.eg],
    xti: mp[mo + BJT_SLOTS.xti],
  };
  const r = bjtEvaluate(params, vbe, vbc, vtV);

  // Linearised currents (in the device frame) → original sign convention.
  const ib = s * r.ib;
  const ic = s * r.ic;
  const gpi = r.gpi;
  const gmu = r.gmu;
  const gm = r.gm;
  const go = r.go;
  // Constants of the linearisation in node-voltage terms.
  const vbeNode = s * (ctx.v[nB] - ctx.v[nE]);
  const vbcNode = s * (ctx.v[nB] - ctx.v[nC]);
  const ieqB = s * r.ib - (gpi * vbeNode + gmu * vbcNode);
  const ieqC = s * r.ic - (gm * vbeNode + go * vbcNode);

  // Jacobian entries. With vbe = vb−ve and vbc = vb−vc:
  //   dIb/dvb = gpi+gmu   dIb/dve = −gpi        dIb/dvc = −gmu
  //   dIc/dvb = gm+go     dIc/dve = −gm         dIc/dvc = −go
  //   row e (Ie = −Ib−Ic) is the negative sum.
  addMatrix(ctx, nB, nB, gpi + gmu);
  addMatrix(ctx, nB, nE, -gpi);
  addMatrix(ctx, nB, nC, -gmu);
  addMatrix(ctx, nC, nB, gm + go);
  addMatrix(ctx, nC, nE, -gm);
  addMatrix(ctx, nC, nC, -go);
  addMatrix(ctx, nE, nB, -(gpi + gmu + gm + go));
  addMatrix(ctx, nE, nE, gpi + gm);
  addMatrix(ctx, nE, nC, gmu + go);
  inject(ctx, nB, -ieqB);
  inject(ctx, nC, -ieqC);
  inject(ctx, nE, ieqB + ieqC);

  // Junction and diffusion capacitances (transient).
  if (ctx.mode === 'tran' && ctx.useCapacitances) {
    const cje = junctionCapacitance(vbeRaw, mp[mo + BJT_SLOTS.cje], mp[mo + BJT_SLOTS.vje], mp[mo + BJT_SLOTS.mje]);
    const cjc = junctionCapacitance(vbcRaw, mp[mo + BJT_SLOTS.cjc], mp[mo + BJT_SLOTS.vjc], mp[mo + BJT_SLOTS.mjc]);
    const tf = mp[mo + BJT_SLOTS.tf];
    const gmEff = Math.abs(r.gm);
    const diffusion = tf * Math.max(0, gmEff);
    stampNorton(ctx, nB, nE, (cje + diffusion) / ctx.dt, -((cje + diffusion) / ctx.dt) * state[2]);
    stampNorton(ctx, nB, nC, cjc / ctx.dt, -(cjc / ctx.dt) * state[3]);
  }

  ctx.elementCurrent[e] = ic;
  // Sum of the *terminal* powers with the model's own current directions
  // (collector current into the collector, base current into the base):
  // P = V_CE·I_C + V_BE·I_B measured at the terminals c/b/e, so the rb/rc/re
  // parasitics the model keeps on internal nodes are included.
  ctx.elementPower[e] = ic * (ctx.v[c] - ctx.v[eNode]) + ib * (ctx.v[b] - ctx.v[eNode]);
}

/** Helper used to reference ground (node 0) explicitly for gmin anchors. */
function k0(): number {
  return 0;
}

/** Stamp a VCCS: current `gain·(vp − vn)` flows from node `a` to node `b`. */
function addVccs(ctx: SimState, a: number, b: number, vp: number, vn: number, gain: number): void {
  if (gain === 0) return;
  const ra = row(a);
  const rb = row(b);
  const rp = row(vp);
  const rn = row(vn);
  if (ra >= 0) {
    if (rp >= 0) ctx.m.add(ra, rp, gain);
    if (rn >= 0) ctx.m.add(ra, rn, -gain);
  }
  if (rb >= 0) {
    if (rp >= 0) ctx.m.add(rb, rp, -gain);
    if (rn >= 0) ctx.m.add(rb, rn, gain);
  }
}

function stampMosfet(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const mo = nl.modelIndex[e] * MODEL_STRIDE;
  const mp = nl.modelParams;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 7);
  const d = n[0];
  const g = n[1];
  const sNode = n[2];
  const bNode = n[3];
  const nD = n[4];
  const nS = n[5];
  const nB = n[6];
  const state = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const temp = elementTemperature(ctx, e, 3);
  const vtV = vt(temp);
  const polarity = mp[mo + MOS_SLOTS.polarity];

  const rd = mp[mo + MOS_SLOTS.rd];
  const rs = mp[mo + MOS_SLOTS.rs];
  const rb = mp[mo + MOS_SLOTS.rb];
  if (rd > 0 && nD !== d) stampG(ctx, d, nD, 1 / rd);
  if (rs > 0 && nS !== sNode) stampG(ctx, sNode, nS, 1 / rs);
  if (rb > 0 && nB !== bNode) stampG(ctx, bNode, nB, 1 / rb);
  if (nD !== d || nS !== sNode || nB !== bNode) {
    stampG(ctx, nD, 0, ctx.gmin);
    stampG(ctx, nS, 0, ctx.gmin);
    stampG(ctx, nB, 0, ctx.gmin);
  }

  const mos = {
    polarity,
    vto: mp[mo + MOS_SLOTS.vto],
    kp: mp[mo + MOS_SLOTS.kp],
    lambda: mp[mo + MOS_SLOTS.lambda],
    gamma: mp[mo + MOS_SLOTS.gamma],
    phi: mp[mo + MOS_SLOTS.phi],
    nsub: mp[mo + MOS_SLOTS.nsub],
    subth: mp[mo + MOS_SLOTS.subth],
    tcv: mp[mo + MOS_SLOTS.tcv],
    bex: mp[mo + MOS_SLOTS.bex],
    tnom: mp[mo + MOS_SLOTS.tnom],
    w: Math.max(1e-9, p[o + 0]),
    l: Math.max(1e-9, p[o + 1]),
    m: Math.max(1, p[o + 2]),
    cgso: mp[mo + MOS_SLOTS.cgso],
    cgdo: mp[mo + MOS_SLOTS.cgdo],
    cgbO: mp[mo + MOS_SLOTS.cgbo],
    cbd: mp[mo + MOS_SLOTS.cbd],
    cbs: mp[mo + MOS_SLOTS.cbs],
    pb: mp[mo + MOS_SLOTS.pb],
    mj: mp[mo + MOS_SLOTS.mj],
    isub: mp[mo + MOS_SLOTS.isub],
    tox: mp[mo + MOS_SLOTS.tox],
  };

  const vgsRaw = ctx.v[g] - ctx.v[nS];
  const vdsRaw = ctx.v[nD] - ctx.v[nS];
  const vbsRaw = ctx.v[nB] - ctx.v[nS];
  // Channel voltages in the device frame (a p-channel device is the mirror
  // image), damped by `limitChannelStep`; state[7]/state[8] carry the damped
  // values between iterations, exactly like the junction limiter memories.
  const sgn = polarity === 0 ? 1 : -1;
  let vgs = sgn * vgsRaw;
  let vds = sgn * vdsRaw;
  if (!ctx.noLimiting) {
    vgs = limitChannelStep(vgs, state[7]);
    vds = limitChannelStep(vds, state[8]);
    state[7] = vgs;
    state[8] = vds;
  }
  const res = mosEvaluate(mos, sgn * vgs, sgn * vds, vbsRaw, temp, vtV);

  // Linearised drain current: id = gm·vgs + gds·vds + gmbs·vbs + Ieq
  // The affine (companion) model must pass through the point where the
  // derivatives were evaluated, i.e. the *damped* channel voltages.
  const vgsLim = sgn * vgs;
  const vdsLim = sgn * vds;
  const ieq = res.id - (res.gm * vgsLim + res.gds * vdsLim + res.gmbs * vbsRaw);
  stampG(ctx, nD, nS, res.gds);
  addVccs(ctx, nD, nS, g, nS, res.gm);
  addVccs(ctx, nD, nS, nB, nS, res.gmbs);
  inject(ctx, nD, -ieq);
  inject(ctx, nS, ieq);

  // Body junctions (drain/source to bulk). Orientation of the junction diode:
  // an n-channel device has a p-type body, so the drain-body and source-body
  // diodes conduct when the *body* rises above the terminal: argument = Vb − Vx.
  // A p-channel device is the mirror image: argument = Vx − Vb.
  // These junctions are normally reverse-biased; the limiter memories (state[5],
  // state[6]) keep Newton sane when they are driven into conduction, which is
  // legitimate in synchronous rectifiers and in inductor kick-back.
  const isub = mp[mo + MOS_SLOTS.isub];
  if (isub > 0) {
    const sgn = polarity === 0 ? -1 : 1;
    const vdbRaw = sgn * (ctx.v[nD] - ctx.v[nB]);
    const vsbRaw = sgn * (ctx.v[nS] - ctx.v[nB]);
    const vdb = junctionLimit(ctx, vdbRaw, state[5], vtV, isub);
    const vsb = junctionLimit(ctx, vsbRaw, state[6], vtV, isub);
    if (!ctx.noLimiting) {
      state[5] = vdb;
      state[6] = vsb;
    }
    const jd = diodeJunction(vdb, isub, 1, vtV, Infinity, 0);
    const js = diodeJunction(vsb, isub, 1, vtV, Infinity, 0);
    stampAdmittance(ctx, nD, nB, jd.g, jd.i - jd.g * vdb);
    stampAdmittance(ctx, nS, nB, js.g, js.i - js.g * vsb);
  }

  // Capacitances (transient).
  if (ctx.mode === 'tran' && ctx.useCapacitances) {
    const caps = mosCapacitances(mos, res, vgsLim, vdsLim, vtV);
    if (caps.cgs > 0) stampNorton(ctx, g, nS, caps.cgs / ctx.dt, -(caps.cgs / ctx.dt) * state[0]);
    if (caps.cgd > 0) stampNorton(ctx, g, nD, caps.cgd / ctx.dt, -(caps.cgd / ctx.dt) * state[1]);
    if (caps.cgb > 0) stampNorton(ctx, g, nB, caps.cgb / ctx.dt, -(caps.cgb / ctx.dt) * state[2]);
    const cbd = junctionCapacitance(polarity === 0 ? ctx.v[nD] - ctx.v[nB] : ctx.v[nB] - ctx.v[nD], mos.cbd, mos.pb, mos.mj);
    const cbs = junctionCapacitance(polarity === 0 ? ctx.v[nS] - ctx.v[nB] : ctx.v[nB] - ctx.v[nS], mos.cbs, mos.pb, mos.mj);
    stampNorton(ctx, nD, nB, cbd / ctx.dt, -(cbd / ctx.dt) * state[3]);
    stampNorton(ctx, nS, nB, cbs / ctx.dt, -(cbs / ctx.dt) * state[4]);
  }

  ctx.elementCurrent[e] = res.id;
  // Absorbed power at the terminals: V(D→S)·I_D, which includes the rd/rs
  // parasitics the model keeps on internal nodes. Negative when the channel is
  // driven as a generator, which is a legal operating region.
  ctx.elementPower[e] = res.id * (ctx.v[d] - ctx.v[sNode]);
  void rb;
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

/** Effective switch state with optional contact bounce (deterministic). */
function switchState(ctx: SimState, e: number, targetClosed: boolean, st: Float64Array, changeTime: number): boolean {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const bounce = p[o + SW_SLOTS.bounce] > 0.5;
  if (!bounce) return targetClosed;
  // Contact bounce: after a state change, the contact opens/closes a decaying
  // number of times. The pattern is deterministic in time (documented in the
  // model card): intervals t_k = period·decay^k.
  const lastChange = changeTime >= 0 ? changeTime : st[6];
  if (lastChange < 0 || lastChange > ctx.time) return targetClosed;
  const bounces = p[o + SW_SLOTS.bounces];
  const period = p[o + SW_SLOTS.bouncePeriod];
  const decay = p[o + SW_SLOTS.bounceDecay];
  let t = lastChange;
  let interval = period;
  for (let k = 0; k < bounces; k++) {
    t += interval;
    if (ctx.time < t) {
      // Inside the bounce window: alternate between the two states.
      return k % 2 === 0 ? !targetClosed : targetClosed;
    }
    interval *= decay;
  }
  return targetClosed;
}

function stampSwitch(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const a = n[0];
  const b = n[1];
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const ron = Math.max(1e-9, p[o + SW_SLOTS.ron]);
  const roff = Math.max(1, p[o + SW_SLOTS.roff]);
  const switchAt = p[o + SW_SLOTS.switchAt];
  const ctrlMode = p[o + SW_SLOTS.ctrlMode];
  const normallyClosed = p[o + SW_SLOTS.normallyClosed] > 0.5;
  const holdTime = p[o + SW_SLOTS.holdTime];
  const initial = p[o + SW_SLOTS.closed] > 0.5;

  let target: boolean;
  if (switchAt > 0 && ctx.time >= switchAt) {
    const released = holdTime > 0 && ctx.time > switchAt + holdTime;
    target = released ? !initial : initial;
  } else {
    target = initial;
  }
  if (ctrlMode === 2 && nodeCount > 2 && n[2] >= 0) {
    target = ctx.v[n[2]] > p[o + SW_SLOTS.ctrlThreshold];
  }
  // `closed` in the model refers to conduction; a normally-closed contact
  // inverts the mechanical state.
  let conducting = normallyClosed ? !target : target;
  if (p[o + SW_SLOTS.bounce] > 0.5) {
    conducting = switchState(ctx, e, conducting, st, st[6]);
  }

  const r = conducting ? ron : roff;
  const g = ctx.gmin + 1 / r;
  stampG(ctx, a, b, g);
  const v = ctx.v[a] - ctx.v[b];
  ctx.elementCurrent[e] = v / r;
  ctx.elementPower[e] = (v * v) / r;
}

function stampRelay(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 5);
  const [a1, a2, com, no, nc] = [n[0], n[1], n[2], n[3], n[4]];
  const br = nl.branchIndex[e];
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const lcoil = Math.max(1e-9, p[o + RELAY_SLOTS.lcoil]);
  const rcoil = Math.max(1e-3, p[o + RELAY_SLOTS.rcoil]);
  const vpull = p[o + RELAY_SLOTS.vpull];
  const vdrop = p[o + RELAY_SLOTS.vdrop];
  const tpull = p[o + RELAY_SLOTS.tpull];
  const tdrop = p[o + RELAY_SLOTS.tdrop];

  // Coil: an inductive branch (always a branch unknown, even in DC where it is
  // a plain resistor).
  if (br >= 0) {
    const rbr = branchRow(ctx, br);
    const ra = row(a1);
    const rb = row(a2);
    const isDC = ctx.mode === 'dc';
    const gL = isDC ? 0 : ctx.integration === 0 ? lcoil / ctx.dt : (2 * lcoil) / ctx.dt;
    if (ra >= 0) ctx.m.add(ra, rbr, 1);
    if (rb >= 0) ctx.m.add(rb, rbr, -1);
    if (ra >= 0) ctx.m.add(rbr, ra, 1);
    if (rb >= 0) ctx.m.add(rbr, rb, -1);
    ctx.m.add(rbr, rbr, -(gL + rcoil));
    ctx.rhs[rbr] += isDC ? 0 : gL * st[0] + (ctx.integration !== 0 && !isDC ? st[3] : 0);
  }

  // Mechanical armature: first-order travel towards the target position.
  const vcoil = ctx.v[a1] - ctx.v[a2];
  const x = st[1]; // 0 = released, 1 = fully pulled (previous accepted value)
  const target = x > 0.5 ? (vcoil < vdrop ? 0 : 1) : vcoil > vpull ? 1 : 0;
  const tau = target > x ? tpull : tdrop;
  let xNew = x;
  if (ctx.mode === 'tran' && ctx.dt > 0) {
    const a = ctx.dt / Math.max(1e-12, tau);
    xNew = x + (target - x) * Math.min(1, a);
  } else {
    xNew = target;
  }
  void xNew;

  // Contacts: NO closes when pulled, NC opens.
  const bounce = p[o + RELAY_SLOTS.bounce] > 0.5;
  const closedTarget = xNew > 0.5;
  void bounce;
  const ron = Math.max(1e-9, p[o + RELAY_SLOTS.ron]);
  const roff = 1e9;
  stampG(ctx, com, no, ctx.gmin + (closedTarget ? 1 / ron : 1 / roff));
  stampG(ctx, com, nc, ctx.gmin + (closedTarget ? 1 / roff : 1 / ron));
  const iCoil = br >= 0 ? ctx.ib[br] : vcoil / rcoil;
  ctx.elementCurrent[e] = iCoil;
  const vNO = ctx.v[com] - ctx.v[no];
  const vNC = ctx.v[com] - ctx.v[nc];
  // Coil power (signed: a relay coil always absorbs, but the branch current is
  // taken from the solver so the sign follows the terminal polarity) plus the
  // I²R loss of the conducting contact.
  ctx.elementPower[e] = vcoil * iCoil + (closedTarget ? (vNO * vNO) / ron : 0) + (!closedTarget ? (vNC * vNC) / ron : 0);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function stampSource(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const family = p[o + SRC_SLOTS.family];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 2);
  const a = n[0];
  const b = n[1];
  const br = nl.branchIndex[e];
  const rs = Math.max(0, p[o + SRC_SLOTS.rs]);
  const value = sourceValue(ctx, e, false);

  const isVoltage = family === 0 || family === 2 || family === 4 || family === 5;
  if (isVoltage) {
    if (rs > 0) {
      // Thévenin → Norton: ideal source behind a series resistance is exactly a
      // Norton source (conductance 1/rs + injected current V/rs).
      const g = 1 / rs;
      stampG(ctx, a, b, g);
      inject(ctx, a, value / rs);
      inject(ctx, b, -value / rs);
      // Through-current from a to b inside the element: with the ideal source
      // behind rs, (V_ab - value)/rs. Absorbed power = V_ab · I_ab, so a source
      // that delivers power reports a negative number.
      const vab = ctx.v[a] - ctx.v[b];
      ctx.elementCurrent[e] = (vab - value) / rs;
      ctx.elementPower[e] = vab * ctx.elementCurrent[e];
      return;
    }
    if (br < 0) {
      // No branch available: fall back to a large conductance (documented).
      const g = 1e-3;
      stampG(ctx, a, b, g);
      inject(ctx, a, value * g);
      inject(ctx, b, -value * g);
      return;
    }
    const rbr = branchRow(ctx, br);
    const ra = row(a);
    const rb = row(b);
    if (ra >= 0) ctx.m.add(ra, rbr, 1);
    if (rb >= 0) ctx.m.add(rb, rbr, -1);
    if (ra >= 0) ctx.m.add(rbr, ra, 1);
    if (rb >= 0) ctx.m.add(rbr, rb, -1);
    ctx.rhs[rbr] += value;
    // MNA convention of this stamp: the branch unknown is the current flowing
    // from node a through the source to node b, so the absorbed power is
    // (V_a - V_b)·i — negative for a source that drives a load.
    const i = ctx.ib[br];
    ctx.elementCurrent[e] = i;
    ctx.elementPower[e] = (ctx.v[a] - ctx.v[b]) * i;
    return;
  }

  // Current source (family 1 or 3). `value` is the current pushed *into* node a,
  // so the current through the element runs from b to a: absorbed power is
  // -V_ab·value, plus the V²/rs loss of the parallel source resistance.
  inject(ctx, a, value);
  inject(ctx, b, -value);
  if (rs > 0 && Number.isFinite(rs)) stampG(ctx, a, b, 1 / rs);
  ctx.elementCurrent[e] = value;
  const vab = ctx.v[a] - ctx.v[b];
  ctx.elementPower[e] = -vab * value + (rs > 0 && Number.isFinite(rs) ? (vab * vab) / rs : 0);
}

function stampControlledSource(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 4);
  const [op, om, ip, im] = [n[0], n[1], n[2], n[3]];
  const type = p[o + CS_SLOTS.type];
  const gain = p[o + CS_SLOTS.gain];
  const rout = p[o + CS_SLOTS.rout];
  const vmax = p[o + CS_SLOTS.vmax];
  const br = nl.branchIndex[e];

  if (type === 0) {
    // VCVS (E): branch equation v(op) − v(om) − rout·i = gain·(vip − vim).
    if (br < 0) return;
    const rbr = branchRow(ctx, br);
    const rop = row(op);
    const rom = row(om);
    const rip = row(ip);
    const rim = row(im);
    if (rop >= 0) ctx.m.add(rop, rbr, 1); // the branch current leaves op
    if (rom >= 0) ctx.m.add(rom, rbr, -1);
    if (rop >= 0) ctx.m.add(rbr, rop, 1);
    if (rom >= 0) ctx.m.add(rbr, rom, -1);
    ctx.m.add(rbr, rbr, -rout);
    if (rip >= 0) ctx.m.add(rbr, rip, -gain);
    if (rim >= 0) ctx.m.add(rbr, rim, gain);
    const i = ctx.ib[br];
    ctx.elementCurrent[e] = i;
    // The branch unknown leaves op, so the through-current from op to om is -i.
    // An ideal controlled source can deliver power without absorbing any: the
    // power balance of a circuit with controlled sources does not close, by
    // construction of the model (documented in docs/SIMULATION.md).
    ctx.elementPower[e] = -(ctx.v[op] - ctx.v[om]) * i;
    void vmax; // 0 = ideal (no clipping); a value enables the documented clamp
    return;
  }
  if (type === 2) {
    // CCVS (H): an internal zero-volt sense source (branch `br`) sits between
    // CTRL+/CTRL-; the output branch (`br + 1`) obeys
    // v(op) − v(om) − rout·i_out = gain·i_sense.
    if (br < 0 || br + 1 >= ctx.ib.length) return;
    const rSense = branchRow(ctx, br);
    const rOut = branchRow(ctx, br + 1);
    const rop = row(op);
    const rom = row(om);
    const rip = row(ip);
    const rim = row(im);
    // Sense source: v(CTRL+) − v(CTRL−) = 0, current from CTRL+ to CTRL−.
    if (rip >= 0) ctx.m.add(rip, rSense, 1);
    if (rim >= 0) ctx.m.add(rim, rSense, -1);
    if (rip >= 0) ctx.m.add(rSense, rip, 1);
    if (rim >= 0) ctx.m.add(rSense, rim, -1);
    // Output branch.
    if (rop >= 0) ctx.m.add(rop, rOut, 1);
    if (rom >= 0) ctx.m.add(rom, rOut, -1);
    if (rop >= 0) ctx.m.add(rOut, rop, 1);
    if (rom >= 0) ctx.m.add(rOut, rom, -1);
    ctx.m.add(rOut, rOut, -rout);
    ctx.m.add(rOut, rSense, -gain);
    const iOut = ctx.ib[br + 1];
    ctx.elementCurrent[e] = iOut;
    // Same convention as the VCVS output branch: the branch unknown leaves op.
    ctx.elementPower[e] = -(ctx.v[op] - ctx.v[om]) * iOut;
    return;
  }
  if (type === 1) {
    // VCCS: i from op to om = gain·(vip − vim)
    addVccs(ctx, op, om, ip, im, gain);
    if (rout > 0) stampG(ctx, op, om, 1 / rout);
    ctx.elementCurrent[e] = gain * (ctx.v[ip] - ctx.v[im]);
    // The stamped current runs from op to om inside the element, so the absorbed
    // power is V_op-om · I_out. The control port draws no current in this model,
    // which is why a VCCS can deliver power without absorbing any.
    ctx.elementPower[e] = ctx.elementCurrent[e] * (ctx.v[op] - ctx.v[om]);
    return;
  }
  // CCCS (F): a zero-volt sense source between ip and im whose current controls
  // the output current source.
  if (br < 0) return;
  const rbr = branchRow(ctx, br);
  const rip = row(ip);
  const rim = row(im);
  if (rip >= 0) ctx.m.add(rip, rbr, 1);
  if (rim >= 0) ctx.m.add(rim, rbr, -1);
  if (rip >= 0) ctx.m.add(rbr, rip, 1);
  if (rim >= 0) ctx.m.add(rbr, rim, -1);
  const iSense = ctx.ib[br];
  // Output current = gain · iSense, flowing from op to om inside the element,
  // i.e. drawn out of node op and delivered to node om. (KCL: currents entering
  // a node go on the right-hand side.)
  inject(ctx, op, -gain * iSense);
  inject(ctx, om, gain * iSense);
  if (rout > 0) stampG(ctx, op, om, 1 / rout);
  ctx.elementCurrent[e] = gain * iSense;
  ctx.elementPower[e] = gain * iSense * (ctx.v[op] - ctx.v[om]);
}

// ---------------------------------------------------------------------------
// Digital behavioural elements
// ---------------------------------------------------------------------------

function logicLevel(v: number, vth: number): number {
  return v > vth ? 1 : 0;
}

/** Apply a logic function to binary inputs (0/1). */
function applyGateFn(fn: number, inputs: ArrayLike<number>, count: number): number {
  switch (fn) {
    case 0:
      return inputs[0] ? 1 : 0; // buffer
    case 1:
      return inputs[0] ? 0 : 1; // not
    case 2:
    case 3: {
      let all = 1;
      for (let i = 0; i < count; i++) if (!inputs[i]) all = 0;
      return fn === 2 ? all : all ? 0 : 1;
    }
    case 4:
    case 5: {
      let any = 0;
      for (let i = 0; i < count; i++) if (inputs[i]) any = 1;
      return fn === 4 ? any : any ? 0 : 1;
    }
    case 6:
    case 7: {
      let parity = 0;
      for (let i = 0; i < count; i++) parity ^= inputs[i] ? 1 : 0;
      return fn === 6 ? parity : parity ? 0 : 1;
    }
    case 8:
      return inputs[0] ? 1 : 0;
    default:
      return 0;
  }
}

/** Gate functions that carry no input (level-0 sources). */
export const GATE_FN_CONST_HIGH = 9;
export const GATE_FN_CONST_LOW = 10;

function stampGate(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const fn = p[o + GATE_SLOTS.fn];
  const vdd = p[o + GATE_SLOTS.vdd];
  const vth = p[o + GATE_SLOTS.vth];
  const inputs = Math.max(0, Math.round(p[o + GATE_SLOTS.inputs]));
  const out = n[nodeCount - 1];
  const riv = Math.max(1e-6, p[o + GATE_SLOTS.rovh]);
  const rol = Math.max(1e-6, p[o + GATE_SLOTS.rovl]);
  const gleak = Math.max(0, p[o + GATE_SLOTS.gleak]);

  const levels = new Uint8Array(5);
  for (let i = 0; i < inputs && i < levels.length; i++) levels[i] = logicLevel(ctx.v[n[i]], vth);

  let enabled = true;
  if (nl.kind[e] === Kind.TriState) {
    const enNode = n[nodeCount - 2] === out ? -1 : nodeCount >= 3 ? n[nodeCount - 2] : -1;
    const en = enNode >= 0 ? logicLevel(ctx.v[enNode], vth) : 1;
    enabled = p[o + GATE_SLOTS.activeLow] > 0.5 ? en === 0 : en === 1;
  }

  // A constant source (fn 9/10) reads no input at all: its level is the whole
  // model, which is why the electrical stamp gives it the same driver as a gate.
  const level = fn === GATE_FN_CONST_HIGH ? 1 : fn === GATE_FN_CONST_LOW ? 0 : applyGateFn(fn, levels, inputs);
  void st;

  if (!enabled) {
    if (gleak > 0) stampG(ctx, out, 0, gleak);
    ctx.elementCurrent[e] = 0;
    ctx.elementPower[e] = 0;
    return;
  }
  const g = 1 / (level ? riv : rol);
  stampG(ctx, out, 0, g);
  inject(ctx, out, level ? vdd * g : 0);
  // Dynamic/static power estimate is computed by the caller from the actual
  // currents; here we record the instantaneous power of the output stage.
  const iOut = g * (ctx.v[out] - (level ? vdd : 0));
  ctx.elementCurrent[e] = iOut;
  // What the *gate* dissipates, not what it delivers: the current through the
  // output resistance times the voltage across it, i.e. (vdd - v_out)²/rout when
  // driving high and v_out²/rout when driving low. A gate with an ideal load
  // (v_out at a rail) therefore dissipates nothing, which is exactly what the
  // ideal-style model says. The dynamic CV²f term is not part of this model.
  const drop = level ? vdd - ctx.v[out] : ctx.v[out];
  ctx.elementPower[e] = drop * drop * g;
  void st;
}

function stampDff(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 5);
  const [d, clk, rst, q, qn] = [n[0], n[1], n[2], n[3], n[4]];
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const vdd = p[o + DFF_SLOTS.vdd];
  const vth = p[o + DFF_SLOTS.vth];
  const hasQN = p[o + DFF_SLOTS.hasQN] > 0.5;
  const rout = Math.max(1e-6, p[o + DFF_SLOTS.rout]);

  if (st[5] < 0.5) st[5] = -1; // marked as "not yet initialised"

  // The stored state is the *previous accepted* value: the latch itself is
  // updated once per accepted time step in recordElementState(), so a Newton
  // iteration cannot toggle the output.
  const qLevel = st[5] < 0 ? (p[o + DFF_SLOTS.initial] === 1 ? 1 : 0) : st[0] > 0.5 ? 1 : 0;
  const g = 1 / rout;
  stampG(ctx, q, 0, g);
  inject(ctx, q, qLevel ? vdd * g : 0);
  if (hasQN) {
    stampG(ctx, qn, 0, g);
    inject(ctx, qn, qLevel ? 0 : vdd * g);
  }
  ctx.elementPower[e] = 0;
  void d;
  void clk;
  void rst;
}

function stampDLatch(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 3);
  const q = n[2];
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const vdd = p[o + DFF_SLOTS.vdd];
  const rout = Math.max(1e-6, p[o + DFF_SLOTS.rout]);
  const qLevel = st[5] < 0 ? (p[o + DFF_SLOTS.initial] === 1 ? 1 : 0) : st[0] > 0.5 ? 1 : 0;
  const g = 1 / rout;
  stampG(ctx, q, 0, g);
  inject(ctx, q, qLevel ? vdd * g : 0);
  ctx.elementPower[e] = 0;
}

function stampMux(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const p = nl.params;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);
  const channels = Math.max(2, Math.round(p[o + MUX_SLOTS.channels]));
  const selectBits = Math.max(1, Math.round(p[o + MUX_SLOTS.selectBits]));
  const mode = p[o + MUX_SLOTS.mode];
  const vdd = p[o + MUX_SLOTS.vdd];
  const vth = p[o + MUX_SLOTS.vth];
  const rout = Math.max(1e-6, p[o + MUX_SLOTS.rout]);
  const g = 1 / rout;

  // Node layout (see MUX_SLOTS): a mux stores one net per channel, a demux only
  // one data net, so a wide demultiplexer still fits in NODE_STRIDE slots.
  const isDemux = mode === 1 || mode === 2;
  const dataCount = isDemux ? 1 : channels;
  const selBase = dataCount;

  let sel = 0;
  for (let i = 0; i < selectBits; i++) sel |= logicLevel(ctx.v[n[selBase + i]], vth) << i;
  sel = sel % channels;

  if (!isDemux) {
    const data = logicLevel(ctx.v[n[sel]], vth);
    const out = n[channels + selectBits];
    stampG(ctx, out, 0, g);
    inject(ctx, out, data ? vdd * g : 0);
  } else {
    // Demultiplexer: the data is routed to the selected output. Decoder: there is
    // no data to route, so the same net is the enable of the whole decoded word
    // (the lowerer binds the EN pin to it when one is wired).
    const input = logicLevel(ctx.v[n[0]], vth);
    for (let i = 0; i < channels; i++) {
      const out = n[selBase + selectBits + i];
      const on = i === sel ? input : 0;
      stampG(ctx, out, 0, g);
      inject(ctx, out, on ? vdd * g : 0);
    }
  }
  ctx.elementPower[e] = 0;
}

// ---------------------------------------------------------------------------
// Observers
// ---------------------------------------------------------------------------

function recordProbeValue(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const o = nl.paramOffset[e];
  const kind = nl.params[o + PROBE_SLOTS.kind];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + 2);
  if (kind === 0) {
    ctx.elementCurrent[e] = ctx.v[n[0]] - ctx.v[n[1]];
  } else if (kind === 1) {
    // Current probes measure the current recorded by the element that owns the
    // branch (ammeter shunt); nothing to compute here.
  } else if (kind === 2) {
    ctx.elementCurrent[e] = (ctx.v[n[0]] - ctx.v[n[1]]) * ctx.elementCurrent[e];
  }
}


// ---------------------------------------------------------------------------
// State recording (called once per accepted time step)
// ---------------------------------------------------------------------------

/**
 * Record the new device state after a step has been accepted.
 *
 * Stamping only ever *reads* the previous state, so a Newton iteration cannot
 * corrupt the history of a device (this is the classic bug that makes a
 * hand-written simulator latch at the wrong edge). Everything that must persist
 * across time steps is written here, exactly once per accepted step.
 */
export function recordElementState(ctx: SimState, e: number): void {
  const nl = ctx.nl;
  const k = nl.kind[e];
  const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + STATE_STRIDE);
  const o = nl.paramOffset[e];
  const p = nl.params;
  const nodeCount = nl.nodeCountPerElement[e];
  const n = nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nodeCount);

  switch (k) {
    case Kind.Capacitor: {
      const hasInternal = nodeCount === 3;
      const mid = hasInternal ? n[1] : n[0];
      const b = hasInternal ? n[2] : n[1];
      const vc = ctx.v[mid] - ctx.v[b];
      st[0] = vc;
      st[1] = ctx.elementCurrent[e];
      if (hasInternal && p[o + C_SLOTS.esl] > 0 && nl.branchIndex[e] >= 0) st[3] = ctx.ib[nl.branchIndex[e]];
      break;
    }
    case Kind.Inductor: {
      const br = nl.branchIndex[e];
      st[0] = br >= 0 ? ctx.ib[br] : 0;
      st[1] = ctx.v[n[0]] - ctx.v[n[1]];
      break;
    }
    case Kind.Transformer: {
      const br = nl.branchIndex[e];
      if (br >= 0) {
        st[0] = ctx.ib[br];
        st[1] = ctx.ib[br + 1];
        st[2] = ctx.v[n[0]] - ctx.v[n[1]];
        st[3] = ctx.v[n[2]] - ctx.v[n[3]];
      }
      break;
    }
    case Kind.Diode:
    case Kind.Led:
    case Kind.Photodiode: {
      const a = n[0];
      const kNode = n[nodeCount - 1];
      st[0] = ctx.v[a] - ctx.v[kNode];
      st[1] = ctx.v[a] - ctx.v[kNode];
      break;
    }
    case Kind.Bjt: {
      // The polarity belongs to the *model* (shared by every instance), not to
      // the element parameters — reading it from `params` returned the element's
      // multiplicity and inverted the recorded junctions of every NPN, which left
      // the pnjlim memories negative and made the next Newton iterate diverge.
      const mo = nl.modelIndex[e] * MODEL_STRIDE;
      const s = nl.modelParams[mo + BJT_SLOTS.polarity] === 0 ? 1 : -1;
      const hasInternal = nodeCount > 3;
      const cN = hasInternal ? n[3] : n[0];
      const bN = hasInternal ? n[4] : n[1];
      const eN = hasInternal ? n[5] : n[2];
      st[0] = s * (ctx.v[bN] - ctx.v[eN]); // vbe, the pnjlim memory of the b-e junction
      st[1] = s * (ctx.v[bN] - ctx.v[cN]); // vbc, the pnjlim memory of the b-c junction
      st[2] = st[0]; // last accepted vbe, the b-e diffusion-capacitance companion voltage
      st[3] = st[1]; // last accepted vbc
      break;
    }
    case Kind.Mosfet: {
      const [d, g, sNode, bNode, nD, nS, nB] = [n[0], n[1], n[2], n[3], n[4], n[5], n[6]];
      const polarity = nl.modelParams[nl.modelIndex[e] * MODEL_STRIDE + MOS_SLOTS.polarity];
      st[0] = ctx.v[g] - ctx.v[nS];
      st[1] = ctx.v[g] - ctx.v[nD];
      st[2] = ctx.v[g] - ctx.v[nB];
      st[3] = polarity === 0 ? ctx.v[nD] - ctx.v[nB] : ctx.v[nB] - ctx.v[nD];
      st[4] = polarity === 0 ? ctx.v[nS] - ctx.v[nB] : ctx.v[nB] - ctx.v[nS];
      void d;
      void sNode;
      void bNode;
      break;
    }
    case Kind.Switch:
    case Kind.PushButton: {
      const initial = p[o + SW_SLOTS.closed] > 0.5;
      const switchAt = p[o + SW_SLOTS.switchAt];
      const holdTime = p[o + SW_SLOTS.holdTime];
      const normallyClosed = p[o + SW_SLOTS.normallyClosed] > 0.5;
      const ctrlMode = p[o + SW_SLOTS.ctrlMode];
      let target: boolean;
      if (switchAt > 0 && ctx.time >= switchAt) {
        const released = holdTime > 0 && ctx.time > switchAt + holdTime;
        target = released ? !initial : initial;
      } else target = initial;
      if (ctrlMode === 2 && nodeCount > 2 && n[2] >= 0) target = ctx.v[n[2]] > p[o + SW_SLOTS.ctrlThreshold];
      const conducting = normallyClosed ? !target : target;
      if ((conducting ? 1 : 0) !== st[0]) st[6] = ctx.time;
      st[0] = conducting ? 1 : 0;
      break;
    }
    case Kind.Relay: {
      const vcoil = ctx.v[n[0]] - ctx.v[n[1]];
      const x = st[1];
      const target = x > 0.5 ? (vcoil < p[o + RELAY_SLOTS.vdrop] ? 0 : 1) : vcoil > p[o + RELAY_SLOTS.vpull] ? 1 : 0;
      const tau = target > x ? p[o + RELAY_SLOTS.tpull] : p[o + RELAY_SLOTS.tdrop];
      if (ctx.mode === 'tran' && ctx.dt > 0) {
        const a = ctx.dt / Math.max(1e-12, tau);
        st[1] = x + (target - x) * Math.min(1, a);
      } else st[1] = target;
      const br = nl.branchIndex[e];
      if (br >= 0) st[0] = ctx.ib[br];
      break;
    }
    case Kind.VoltageSource:
    case Kind.CurrentSource:
    case Kind.NoiseSource: {
      if (p[o + SRC_SLOTS.family] === 5) {
        // Battery: integrate the state of charge from the terminal current.
        const soc = st[0];
        const capacity = p[o + SRC_SLOTS.tr];
        const i = Math.abs(ctx.elementCurrent[e]);
        const dSoc = ctx.dt > 0 ? (i * ctx.dt) / (3600 * Math.max(1e-12, capacity)) : 0;
        st[0] = Math.max(0, Math.min(1, soc - dSoc));
      }
      break;
    }
    case Kind.LogicGate:
    case Kind.LogicBuf:
    case Kind.TriState: {
      const vth = p[o + GATE_SLOTS.vth];
      const out = n[nodeCount - 1];
      st[0] = ctx.v[out] > vth ? 1 : 0;
      break;
    }
    case Kind.DFlipFlop: {
      const [d, clk, rst, q, qn] = [n[0], n[1], n[2], n[3], n[4]];
      const vth = p[o + DFF_SLOTS.vth];
      const falling = p[o + DFF_SLOTS.falling] > 0.5;
      const resLow = p[o + DFF_SLOTS.resetLow] > 0.5;
      const hasReset = p[o + DFF_SLOTS.hasReset] > 0.5;
      const clkLevel = ctx.v[clk] > vth ? 1 : 0;
      if (st[5] < 0) {
        // First accepted step: adopt the declared power-on state.
        st[0] = p[o + DFF_SLOTS.initial] === 1 ? 1 : 0;
        st[1] = clkLevel;
        st[5] = 1;
        break;
      }
      const prevClk = st[1];
      const edge = falling ? prevClk === 1 && clkLevel === 0 : prevClk === 0 && clkLevel === 1;
      if (edge) st[0] = ctx.v[d] > vth ? 1 : 0;
      if (hasReset) {
        const rl = ctx.v[rst] > vth ? 1 : 0;
        const active = resLow ? rl === 0 : rl === 1;
        if (active) st[0] = resLow ? 0 : 1;
      }
      st[1] = clkLevel;
      st[2] = ctx.v[d] > vth ? 1 : 0;
      void q;
      void qn;
      break;
    }
    case Kind.DLatch: {
      const [d, en, q] = [n[0], n[1], n[2]];
      const vth = p[o + DFF_SLOTS.vth];
      if (st[5] < 0) {
        st[0] = p[o + DFF_SLOTS.initial] === 1 ? 1 : 0;
        st[5] = 1;
        break;
      }
      if (ctx.v[en] > vth) st[0] = ctx.v[d] > vth ? 1 : 0;
      void q;
      break;
    }
    default:
      break;
  }
}

/** Copy the "new" state into the "previous" slot after acceptance. */
export function commitElementState(ctx: SimState): void {
  // All state slots are already held in their final position by
  // recordElementState, so nothing else is needed; this hook exists so that
  // future models with two-phase state can hook in without touching the solver.
}

export { MODEL_STRIDE, STATE_STRIDE };
export type { SparseMatrix };
