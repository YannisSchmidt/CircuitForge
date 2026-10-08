/**
 * Device equations.
 *
 * Pure functions: given terminal voltages and a temperature, return the terminal
 * currents and the small-signal conductances used by Newton–Raphson. No state, no
 * allocation — the solver calls these millions of times.
 *
 * Every formula here appears verbatim in the corresponding `ModelCard`
 * (`PHYSICS.md` mirrors it). Nothing in this file is a guess: each relation is
 * either the standard SPICE formulation or an explicitly named alternative, and
 * the deviations are stated in the model card.
 */

import { CONST, toKelvin } from '../util/units.js';

const Q = CONST.q;
const K = CONST.k;

/** Thermal voltage in volts. `tempC` is the device temperature in °C. */
export function vt(tempC: number): number {
  return (K * toKelvin(tempC)) / Q;
}

/** Guard against exp() overflow: exp(80) is already 5e34 and useless. */
const EXP_LIMIT = 80;

export function safeExp(x: number): number {
  if (x > EXP_LIMIT) return Math.exp(EXP_LIMIT) * (1 + (x - EXP_LIMIT));
  if (x < -EXP_LIMIT) return 0;
  return Math.exp(x);
}

/** softplus(x) = ln(1+e^x), computed without overflow. */
export function softplus(x: number): number {
  if (x > 40) return x;
  if (x < -40) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

/** sigmoid(x) = 1/(1+e^-x), the derivative of softplus. */
export function sigmoid(x: number): number {
  if (x > 40) return 1;
  if (x < -40) return Math.exp(x);
  return 1 / (1 + Math.exp(-x));
}

// ---------------------------------------------------------------------------
// Junction (diode) — Shockley with series resistance handled by the caller
// ---------------------------------------------------------------------------

export interface DiodeResult {
  /** Current flowing from the anode node into the device (A). */
  i: number;
  /** Conductance dI/dV (S). */
  g: number;
  /** True when the junction is in reverse breakdown. */
  breakdown: boolean;
}

/**
 * Junction current and conductance including optional reverse breakdown.
 *
 *   forward  i = Is(T)·(exp(v/(N·Vt)) − 1)
 *   reverse  i = −Is(T)
 *   breakdown (v < −BV) : i −= Ibv·exp(−(v + BV)/Vt)
 *
 * `Is` is passed already temperature-scaled.
 */
export function diodeJunction(v: number, is: number, n: number, vtV: number, bv: number, ibv: number): DiodeResult {
  const nvt = n * vtV;
  let i: number;
  let g: number;
  let breakdown = false;
  if (v > -5 * nvt) {
    const e = safeExp(v / nvt);
    i = is * (e - 1);
    g = (is / nvt) * e;
  } else {
    // Linearised reverse region: avoids underflow and keeps the derivative
    // meaningful far in reverse.
    i = -is;
    g = is / nvt;
  }
  if (Number.isFinite(bv) && v < -bv) {
    breakdown = true;
    const arg = -(v + bv) / vtV;
    const e = safeExp(arg > 0 ? arg : 0);
    i -= ibv * e;
    g += (ibv / vtV) * e * (arg > 0 ? 1 : 0);
  }
  return { i, g, breakdown };
}

/**
 * Diode saturation current at temperature T, SPICE formulation:
 *   Is(T) = Is·(T/Tnom)^(XTI/N)·exp( (Eg·q/(N·k)) · (1/Tnom − 1/T) )
 */
export function diodeIsAtTemperature(is: number, n: number, eg: number, xti: number, tnomC: number, tempC: number): number {
  if (Math.abs(tempC - tnomC) < 1e-9) return is;
  const t = toKelvin(tempC);
  const tn = toKelvin(tnomC);
  const ratio = Math.pow(t / tn, xti / n);
  const exponent = (eg * Q / (n * K)) * (1 / tn - 1 / t);
  const scaled = is * ratio * Math.exp(Math.min(80, exponent));
  return Number.isFinite(scaled) && scaled > 0 ? scaled : is;
}

/** Junction capacitance Cj(v) = Cj0·(1 − v/Vj)^(−M) with the standard FC extrapolation. */
export function junctionCapacitance(v: number, cj0: number, vj: number, m: number, fc = 0.5): number {
  if (cj0 <= 0) return 0;
  if (v < fc * vj) {
    return cj0 * Math.pow(1 - v / vj, -m);
  }
  const f2 = Math.pow(1 - fc, 1 + m);
  const f3 = 1 - fc * (1 + m);
  return (cj0 / f2) * (f3 + (m * v) / vj);
}

// ---------------------------------------------------------------------------
// BJT — transport formulation (Gummel–Poon subset)
// ---------------------------------------------------------------------------

export interface BjtParams {
  polarity: number; // 0 npn, 1 pnp
  is: number;
  bf: number;
  br: number;
  nf: number;
  nr: number;
  vaf: number;
  varV: number;
  ikf: number;
  ise: number;
  ne: number;
  isc: number;
  nc: number;
  tnom: number;
  xtb: number;
  eg: number;
  xti: number;
}

export interface BjtResult {
  /** Base current (positive into the base). */
  ib: number;
  /** Collector current (positive into the collector). */
  ic: number;
  /** dIb/dVbe, dIb/dVbc, dIc/dVbe, dIc/dVbc */
  gpi: number;
  gmu: number;
  gm: number;
  go: number;
  /** Region label used by reports. */
  region: string;
}

const BjtScratch: BjtResult = { ib: 0, ic: 0, gpi: 0, gmu: 0, gm: 0, go: 0, region: 'off' };

/**
 * Ebers–Moll transport model with Early voltage and knee-current roll-off.
 *
 *   Ict = (If − Ir) / qb,   qb = 1/(1 − Vbc/VAF − Vbe/VAR)
 *   If  = Is·(exp(Vbe/(NF·Vt)) − 1)
 *   Ir  = Is·(exp(Vbc/(NR·Vt)) − 1)
 *   Ib  = If/BF + Ir/BR + ISE·(exp(Vbe/(NE·Vt)) − 1) + ISC·(exp(Vbc/(NC·Vt)) − 1)
 *   Ic  = Ict − Ir/BR − ISC·(exp(Vbc/(NC·Vt)) − 1)
 *
 * `vbe`/`vbc`/`vce` are already polarity-corrected (positive for a forward-biased
 * device) — the caller flips the signs for a PNP.
 */
export function bjtEvaluate(p: BjtParams, vbe: number, vbc: number, vtV: number): BjtResult {
  const nfv = p.nf * vtV;
  const nrv = p.nr * vtV;
  const nev = p.ne * vtV;
  const ncv = p.nc * vtV;

  const expF = vbe > -5 * nfv ? safeExp(vbe / nfv) : 0;
  const expR = vbc > -5 * nrv ? safeExp(vbc / nrv) : 0;
  const ifwd = p.is * (expF - 1);
  const irev = p.is * (expR - 1);
  const difF = (p.is / nfv) * expF;
  const difR = (p.is / nrv) * expR;

  // Knee current roll-off: bF(i) = BF/(1 + Ict/IKF) is applied to the
  // *forward* component only, which is where it matters (high-current β droop).
  const knee = Number.isFinite(p.ikf) && p.ikf > 0 ? 1 + Math.abs(ifwd) / p.ikf : 1;
  const bf = p.bf * (1 / knee);
  const br = p.br;

  // Base-width modulation (Early effect) in SPICE's direct form:
  //   qb = 1 − Vbe/VAR − Vbc/VAF,   Ict = (If − Ir)·qb
  // qb > 1 means a narrower neutral base, which *increases* the transport
  // current, so a positive VAF makes the collector current grow with Vce (the
  // familiar 1 + Vce/VA law) and a positive VAR makes it shrink with Vbe (the
  // reverse Early effect). VAR = 0 disables it, as in SPICE.
  const vafEff = Number.isFinite(p.vaf) && p.vaf > 0 ? p.vaf : Infinity;
  const varEff = Number.isFinite(p.varV) && p.varV > 0 ? p.varV : Infinity;
  const qbRaw = 1 - vbc / vafEff - vbe / varEff;
  const qb = qbRaw > 0.05 ? qbRaw : 0.05; // clamped for numerical stability
  const ict = (ifwd - irev) * qb;

  const expE = p.ise > 0 && expF > 0 ? safeExp(Math.min(EXP_LIMIT, vbe / nev)) : 0;
  const expC = p.isc > 0 && expR > 0 ? safeExp(Math.min(EXP_LIMIT, vbc / ncv)) : 0;
  const iE = p.ise * (expE - 1);
  const iC = p.isc * (expC - 1);

  const ib = ifwd / bf + irev / br + iE + iC;
  const ic = ict - irev / br - iC;

  // ---- derivatives ----
  // qb depends linearly on the junction voltages, so dqb/dVbe = -1/VAR and
  // dqb/dVbc = -1/VAF — but only while the clamp is inactive. The guards test
  // `> 0` as well as finiteness: VAR = 0 is the documented "effect absent" value
  // (SPICE's off state) and dividing by it would poison the Jacobian.
  const dqbDVbe = qbRaw > 0.05 && p.varV > 0 && Number.isFinite(p.varV) ? -1 / p.varV : 0;
  const dqbDVbc = qbRaw > 0.05 && p.vaf > 0 && Number.isFinite(p.vaf) ? -1 / p.vaf : 0;

  const dIctDVbe = difF * qb + (ifwd - irev) * dqbDVbe;
  const dIctDVbc = -difR * qb + (ifwd - irev) * dqbDVbc;

  const dIbDVbe = difF / bf + (p.ise > 0 ? (p.ise / nev) * expE : 0);
  const dIbDVbc = difR / br + (p.isc > 0 ? (p.isc / ncv) * expC : 0);
  const dIcDVbe = dIctDVbe;
  const dIcDVbc = dIctDVbc - difR / br - (p.isc > 0 ? (p.isc / ncv) * expC : 0);

  const res = BjtScratch;
  res.ib = ib;
  res.ic = ic;
  res.gpi = dIbDVbe;
  res.gmu = dIbDVbc;
  res.gm = dIcDVbe;
  res.go = dIcDVbc;
  res.region = vbe > 0.4 ? (vbc < -0.2 ? 'forward-active' : 'saturation') : vbc < -0.4 ? 'reverse' : 'cutoff';
  return res;
}

/** Temperature scaling of the BJT transport current, β and breakdown. */
export function bjtScaleTemperature(
  is: number,
  bf: number,
  xtb: number,
  eg: number,
  xti: number,
  tnomC: number,
  tempC: number,
): { is: number; bf: number } {
  if (Math.abs(tempC - tnomC) < 1e-9) return { is, bf };
  const t = toKelvin(tempC);
  const tn = toKelvin(tnomC);
  const ratio = t / tn;
  const newIs = is * Math.pow(ratio, xti) * Math.exp(Math.min(80, (eg * Q / K) * (1 / tn - 1 / t)));
  const newBf = bf * Math.pow(ratio, xtb);
  return {
    is: Number.isFinite(newIs) && newIs > 0 ? newIs : is,
    bf: Number.isFinite(newBf) && newBf > 0 ? newBf : bf,
  };
}

// ---------------------------------------------------------------------------
// MOSFET — smooth (EKV-style) square-law-asymptote model
// ---------------------------------------------------------------------------

export interface MosParams {
  polarity: number; // 0 nmos, 1 pmos
  vto: number;
  kp: number;
  lambda: number;
  gamma: number;
  phi: number;
  nsub: number;
  subth: number;
  tcv: number;
  bex: number;
  tnom: number;
  w: number;
  l: number;
  m: number;
  cgso: number;
  cgdo: number;
  cgbO: number;
  cbd: number;
  cbs: number;
  pb: number;
  mj: number;
  isub: number;
  tox: number;
}

export interface MosResult {
  /** Drain current, positive flowing into the drain (device frame). */
  id: number;
  gm: number;
  gds: number;
  gmbs: number;
  /** -2 reverse (Vds < 0), -1 subthreshold/weak, 0 linear (triode), 1 saturation. */
  region: number;
  /** Effective threshold used (V). */
  vth: number;
}

const MosScratch: MosResult = { id: 0, gm: 0, gds: 0, gmbs: 0, region: -1, vth: 0 };

/**
 * Smooth MOSFET model.
 *
 * Normalised overdrive x = (Vgs − Vth)/(2·n·Vt) and y = (Vgs − Vth − Vds)/(2·n·Vt):
 *
 *   Id = I0 · ( softplus(x)² − softplus(y)² ) · (1 + λ·|Vds|),   I0 = 2·n·Vt²·KP·(W/L)·M
 *
 * Properties (all verified in the test suite):
 *   − strong inversion, saturation: Id → (KP/2)(W/L)(Vgs−Vth)²(1+λVds)  (exact square
 *     law asymptote when n = 1),
 *   − weak inversion: Id → I0·e^((Vgs−Vth)/(n·Vt)), i.e. an exponential subthreshold
 *     with slope n·Vt (≈ 60·n mV/decade),
 *   − derivatives are continuous everywhere, which is what makes Newton converge
 *     on switching circuits without artificial region hopping.
 *
 * This is *not* Shichman–Hodges region-by-region switching and it is not BSIM: the
 * model card states exactly this.
 */
/** Guarded logistic: never overflows, returns exactly 0/1 in the tails. */
export function logistic(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

/** EKV interpolation function G(x) = ln²(1 + e^x), evaluated without overflow. */
function ekvG(x: number): number {
  if (x > 30) return x * x; // ln(1+e^x) → x
  if (x < -30) {
    const e = Math.exp(x);
    return e * e; // ln(1+e^x) → e^x
  }
  const t = Math.log1p(Math.exp(x));
  return t * t;
}

/** dG/dx = 2·ln(1+e^x)·σ(x), equally stable. */
function ekvGp(x: number): number {
  if (x > 30) return 2 * x;
  if (x < -30) {
    const e = Math.exp(x);
    return 2 * e * e;
  }
  const e = Math.exp(x);
  return 2 * Math.log1p(e) * (e / (1 + e));
}

/**
 * MOSFET evaluation in the device frame (Vds ≥ 0), before polarity handling.
 *
 * The model has two modes, selected by the `subth` parameter:
 *
 *   subth = true  — EKV-style interpolation between the exact asymptotes:
 *       Id = Is·[G(xF) − G(xR)]·(1 + λVds),  x = Vov/(2·n·Vt),  G(x)=ln²(1+e^x)
 *       Is = 2·n²·Vt²·β,  β = kp·(W/L)·M·μ(T)/μ(Tnom)
 *     Strong inversion: G(x)→x², so Id → β/2·(Vov² − (Vov−Vds)²)·(1+λVds), i.e.
 *     *exactly* the classical square law ½βVov²(1+λVds) in saturation.
 *     Weak inversion: G(x)→e^x, so Id → Is·(e^(Vov/nVt) − e^((Vov−Vds)/nVt)), the
 *     classical subthreshold law with the correct **slope** 1/(n·Vt) per e-fold.
 *     Because the interpolation function is normalised to the classical square
 *     law, the subthreshold *magnitude* is n times the EKV specific current
 *     2nβVt² — the one documented deviation from EKV, and it is a constant factor,
 *     not a shape change.
 *     The difference structure is what makes this usable: an offset that appears
 *     in G(xF) cancels against the same offset in G(xR), so there is no spurious
 *     subthreshold current leaking into strong inversion.
 *
 *   subth = false — the plain square law above, with no subthreshold branch. The
 *     current and its derivative are discontinuous at Vov = 0, exactly like SPICE
 *     level 1; that is documented, not a bug.
 */
function mosForward(p: MosParams, vgs: number, vds: number, vbs: number, tempC: number, vtV: number): MosResult {
  const phi = Math.max(0.1, p.phi);
  const rootArg = Math.max(0, phi - vbs);
  // This function works in the *device frame*, always the n-channel one: for a
  // p-channel device `mosEvaluate` mirrors the terminal voltages before calling
  // in, so the threshold is a magnitude here. A signed SPICE-style VTO (negative
  // for a PMOS) therefore has the same meaning, and taking the absolute value
  // makes the two conventions agree — a negative VTO used as-is would make the
  // device conduct exactly when it is off.
  const vto = p.polarity === 0 ? p.vto : Math.abs(p.vto);
  const vth = vto + p.gamma * (Math.sqrt(rootArg) - Math.sqrt(phi)) + p.tcv * (tempC - p.tnom);
  const vov = vgs - vth;

  const mut = Math.abs(tempC - p.tnom) < 1e-9 ? 1 : Math.pow(toKelvin(tempC) / toKelvin(p.tnom), p.bex);
  const beta = p.kp * (p.w / p.l) * p.m * mut;
  const n = Math.max(1, p.nsub);
  const clm = 1 + p.lambda * vds;

  let idRaw: number;
  let dIdVgs: number;
  let dIdVds: number;

  if (p.subth) {
    const nvt2 = 2 * n * vtV;
    const xF = vov / nvt2;
    const xR = (vov - vds) / nvt2;
    const is = 2 * n * n * vtV * vtV * beta;
    const gF = ekvG(xF);
    const gR = ekvG(xR);
    idRaw = is * (gF - gR);
    dIdVgs = (is * (ekvGp(xF) - ekvGp(xR))) / nvt2;
    dIdVds = (is * ekvGp(xR)) / nvt2;
  } else {
    const F = (x: number): number => (x > 0 ? x * x : 0);
    const Fp = (x: number): number => (x > 0 ? 2 * x : 0);
    const half = beta / 2;
    idRaw = half * (F(vov) - F(vov - vds));
    dIdVgs = half * (Fp(vov) - Fp(vov - vds));
    dIdVds = half * Fp(vov - vds);
  }

  const id = idRaw * clm;
  const gm = dIdVgs * clm;
  const gds = dIdVds * clm + idRaw * p.lambda;

  const dvthdVbs = vbs < phi ? -p.gamma / (2 * Math.sqrt(Math.max(1e-6, rootArg))) : 0;
  const gmbs = -gm * dvthdVbs;

  const res = MosScratch;
  res.id = id;
  res.gm = gm;
  res.gds = gds;
  res.gmbs = gmbs;
  res.vth = vth;
  res.region = vov <= 0 ? -1 : vds > vov ? 1 : 0; // weak / saturation / linear
  return res;
}

/**
 * MOSFET evaluation with polarity handling and reverse-mode support.
 *
 * For Vds < 0 the device is evaluated with drain and source exchanged (the
 * standard source/drain-interchange trick) and the current sign is flipped, which
 * makes the model exactly antisymmetric in Vds — continuous, with continuous
 * derivatives, at the crossover.
 */
export function mosEvaluate(p: MosParams, vgsRaw: number, vdsRaw: number, vbsRaw: number, tempC: number, vtV: number): MosResult {
  const s = p.polarity === 0 ? 1 : -1;
  const vgs = s * vgsRaw;
  const vds = s * vdsRaw;
  const vbs = s * vbsRaw;

  const res = MosScratch;
  if (vds >= 0) {
    const r = mosForward(p, vgs, vds, vbs, tempC, vtV);
    res.id = s * r.id;
    res.gm = r.gm;
    res.gds = r.gds;
    res.gmbs = r.gmbs;
    res.vth = r.vth;
    res.region = r.region;
    return res;
  }
  // Swap drain and source: Vgs' = Vgs − Vds, Vds' = −Vds, Vbs' = Vbs − Vds.
  const r = mosForward(p, vgs - vds, -vds, vbs - vds, tempC, vtV);
  // I = −I'(Vgs−Vds, −Vds, Vbs−Vds): chain rule through the substitutions.
  res.id = s * -r.id;
  res.gm = -r.gm;
  res.gds = r.gm + r.gds + r.gmbs;
  res.gmbs = -r.gmbs;
  res.vth = r.vth;
  res.region = -2; // reverse conduction
  return res;
}

/** Oxide capacitance per unit area (F/m²). */
export function coxPerArea(tox: number): number {
  return (CONST.eps0 * CONST.epsSiO2) / Math.max(1e-10, tox);
}

/**
 * Meyer capacitance model: the gate oxide charge is partitioned between gate-
 * source and gate-drain according to the operating region. This is the classical
 * model; it is not charge-conserving in the strict sense (a known limitation,
 * stated in the model card).
 */
export function mosCapacitances(
  p: MosParams,
  result: MosResult,
  vgsRaw: number,
  vdsRaw: number,
  vtV: number,
): { cgs: number; cgd: number; cgb: number } {
  const s = p.polarity === 0 ? 1 : -1;
  const vgs = s * vgsRaw;
  const vds = s * vdsRaw;
  // Gate oxide capacitance of the channel.
  const cox = coxPerArea(p.tox) * p.w * p.l * p.m;
  const ov = 2 * Math.max(1, p.nsub) * vtV;
  const vov = vgs - result.vth;
  // Smooth region weights (they sum to 1): saturation / linear / off.
  const wSat = sigmoid((vds - vov) / ov);
  const wOff = sigmoid(-vov / ov);
  const wLin = Math.max(0, 1 - wSat - wOff);
  // Overlap capacitances are always present; they are given per metre of width.
  const cOverlapS = (p.cgso ?? 0) * p.w * p.m;
  const cOverlapD = (p.cgdo ?? 0) * p.w * p.m;
  const cgs = cox * ((2 / 3) * wSat + 0.5 * wLin) + cOverlapS;
  const cgd = cox * (0.5 * wLin) + cOverlapD;
  const cgb = cox * wOff;
  return { cgs, cgd, cgb };
}
