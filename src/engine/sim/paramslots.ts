/**
 * Element parameter layouts.
 *
 * The simulator never touches `Record<string, value>` in its inner loops. Every
 * element kind declares a compact slot table; the flattener writes values into a
 * single `Float64Array` with a per-element offset, so an element implementation
 * reads `params[off + R_SLOTS.r]` — a plain array index, no string hashing, no
 * property lookup, no allocation.
 *
 * Conventions
 *   - All values are in base SI units, except temperatures (°C) and angles (°).
 *   - Booleans are stored as 0/1 floats.
 *   - Enumerations use the integer codes documented next to the slot table.
 *   - A slot that a given instance does not need is still written (with its
 *     default) so that the stride is constant per kind.
 */

export const R_SLOTS = {
  /** 0 = linear, 1 = NTC thermistor, 2 = varistor, 3 = potentiometer half */
  mode: 0,
  /** resistance (Ω) or R25 for NTC */
  r: 1,
  tc1: 2,
  tc2: 3,
  /** NTC B coefficient (K) */
  b: 4,
  /** varistor exponent */
  alpha: 5,
  /** varistor reference voltage */
  vref: 6,
  rth: 7,
  cth: 8,
  esl: 9,
  epc: 10,
  pmax: 11,
  vmax: 12,
  /** nominal temperature (°C) */
  tnom: 13,
  /** thermal node index (level 3), -1 when unassigned */
  thermalNode: 14,
  /** current source value injected in parallel (used by potentiometer parts) */
  iparallel: 15,
} as const;
export const R_STRIDE = 16;

export const POT_SLOTS = {
  r: 0,
  /** wiper position 0..1 */
  wiper: 1,
  /** 0 = linear, 1 = logarithmic */
  taper: 2,
  /** wiper contact resistance */
  rw: 3,
  /** end resistance */
  rterm: 4,
  pmax: 5,
  rth: 6,
  cth: 7,
  thermalNode: 8,
  tnom: 9,
} as const;
export const POT_STRIDE = 10;

export const C_SLOTS = {
  c: 0,
  esr: 1,
  esl: 2,
  /** leakage conductance (S) */
  gleak: 3,
  vmax: 4,
  vc1: 5,
  /** 1 when the dielectric-absorption branch is enabled */
  da: 6,
  rth: 7,
  cth: 8,
  tnom: 9,
  tc1: 10,
  /** 1 = polarized (reverse-voltage flag) */
  polarized: 11,
  thermalNode: 12,
} as const;
export const C_STRIDE = 13;

export const L_SLOTS = {
  l: 0,
  dcr: 1,
  isat: 2,
  epc: 3,
  coreLoss: 4,
  imax: 5,
  rth: 6,
  cth: 7,
  /** initial current (A) */
  ic: 8,
  thermalNode: 9,
} as const;
export const L_STRIDE = 10;

export const XFMR_SLOTS = {
  l1: 0,
  l2: 1,
  k: 2,
  rp: 3,
  rs: 4,
  coreLoss: 5,
  isat: 6,
  rth: 7,
  cth: 8,
  thermalNode: 9,
} as const;
export const XFMR_STRIDE = 10;

export const D_SLOTS = {
  /** 0 = diode, 1 = LED, 2 = photodiode */
  variant: 0,
  is: 1,
  n: 2,
  rs: 3,
  cj0: 4,
  vj: 5,
  m: 6,
  tt: 7,
  bv: 8,
  ibv: 9,
  eg: 10,
  xti: 11,
  tnom: 12,
  area: 13,
  rthJc: 14,
  rthCa: 15,
  cth: 16,
  tjmax: 17,
  ifmax: 18,
  /** LED/photo optics */
  lambda: 19,
  eta: 20,
  ifnom: 21,
  responsivity: 22,
  opticalPower: 23,
  dark: 24,
  tnomOpt: 25,
  thermalNode: 26,
} as const;
export const D_STRIDE = 27;

export const BJT_SLOTS = {
  /** 0 = NPN, 1 = PNP */
  polarity: 0,
  is: 1,
  bf: 2,
  br: 3,
  nf: 4,
  nr: 5,
  vaf: 6,
  var: 7,
  ikf: 8,
  ise: 9,
  ne: 10,
  isc: 11,
  nc: 12,
  rb: 13,
  rc: 14,
  re: 15,
  cje: 16,
  cjc: 17,
  vje: 18,
  vjc: 19,
  mje: 20,
  mjc: 21,
  tf: 22,
  tr: 23,
  xtb: 24,
  eg: 25,
  xti: 26,
  tnom: 27,
  area: 28,
  rthJc: 29,
  rthCa: 30,
  cth: 31,
  tjmax: 32,
  vceo: 33,
  icmax: 34,
  pdmax: 35,
  thermalNode: 36,
} as const;
export const BJT_STRIDE = 37;

export const MOS_SLOTS = {
  /** 0 = NMOS, 1 = PMOS */
  polarity: 0,
  w: 1,
  l: 2,
  /** multiplicity (paralleling) */
  m: 3,
  vto: 4,
  kp: 5,
  lambda: 6,
  gamma: 7,
  phi: 8,
  tox: 9,
  cgso: 10,
  cgdo: 11,
  cgbo: 12,
  cbd: 13,
  cbs: 14,
  pb: 15,
  mj: 16,
  isub: 17,
  /** 1 = enable subthreshold */
  subth: 18,
  nsub: 19,
  rd: 20,
  rs: 21,
  rb: 22,
  tnom: 23,
  tcv: 24,
  bex: 25,
  vdsmax: 26,
  idmax: 27,
  pdmax: 28,
  rthJc: 29,
  rthCa: 30,
  cth: 31,
  tjmax: 32,
  ad: 33,
  asArea: 34,
  pd: 35,
  ps: 36,
  thermalNode: 37,
} as const;
export const MOS_STRIDE = 38;

export const SW_SLOTS = {
  /** 1 = closed at t=0 */
  closed: 0,
  ron: 1,
  roff: 2,
  /** 1 = bounce enabled */
  bounce: 3,
  bounces: 4,
  bouncePeriod: 5,
  bounceDecay: 6,
  switchAt: 7,
  /** control mode: 0 = scripted (switchAt), 1 = driven by the gate node, 2 = threshold on the control node */
  ctrlMode: 8,
  ctrlThreshold: 9,
  /** 1 = normally closed */
  normallyClosed: 10,
  /** 1 = drive node present (pin CTRL connected) */
  hasCtrl: 11,
  /** hold: after switchAt for how long (push button) */
  holdTime: 12,
} as const;
export const SW_STRIDE = 13;

export const RELAY_SLOTS = {
  lcoil: 0,
  rcoil: 1,
  vpull: 2,
  vdrop: 3,
  tpull: 4,
  tdrop: 5,
  ron: 6,
  bounce: 7,
  rth: 8,
  cth: 9,
  thermalNode: 10,
} as const;
export const RELAY_STRIDE = 11;

/** One table for every independent / controlled-independent source. */
export const SRC_SLOTS = {
  /** source family: 0 = independent voltage, 1 = independent current, 2 = noise voltage, 3 = noise current, 4 = clock */
  family: 0,
  /** waveform: 0 dc, 1 sine, 2 square, 3 triangle, 4 sawtooth, 5 pulse, 6 clock, 7 noise, 8 arbitrary */
  waveform: 1,
  dc: 2,
  amp: 3,
  freq: 4,
  phase: 5,
  duty: 6,
  tr: 7,
  tf: 8,
  delay: 9,
  rs: 10,
  ilimit: 11,
  /** AC analysis magnitude/phase */
  ac: 12,
  acphase: 13,
  /** noise density (V/√Hz or A/√Hz), 1/f corner */
  noiseDensity: 14,
  flicker: 15,
  bwLow: 16,
  bwHigh: 17,
  /** jitter (s RMS) */
  jitter: 18,
  /** waveform table handle (index into netlist.waveTables), -1 when unused */
  table: 19,
} as const;
export const SRC_STRIDE = 20;

export const CS_SLOTS = {
  /** 0 = E (VCVS), 1 = G (VCCS), 2 = H (CCVS), 3 = F (CCCS) */
  type: 0,
  gain: 1,
  rout: 2,
  rin: 3,
  vmax: 4,
  /** branch index of the control branch for H/F */
  ctrlBranch: 5,
} as const;
export const CS_STRIDE = 6;

export const GATE_SLOTS = {
  /**
   * Logic function: 0 buf, 1 not, 2 and, 3 nand, 4 or, 5 nor, 6 xor, 7 xnor,
   * 8 tristate, 9 constant high, 10 constant low. The two constants have no
   * inputs: they are the level-0 source of a circuit (a "1" / "0" symbol), and
   * at the electrical level they are a driver with an output resistance.
   */
  fn: 0,
  inputs: 1,
  vdd: 2,
  vth: 3,
  tphl: 4,
  tplh: 5,
  tr: 6,
  tf: 7,
  cload: 8,
  rout: 9,
  drive: 10,
  /** 1 = enable is active low (tristate) */
  activeLow: 11,
  /** output resistance in the high state (pull-up) */
  rovh: 12,
  /** output resistance in the low state (pull-down) */
  rovl: 13,
  /** leakage conductance when high-impedance */
  gleak: 14,
} as const;
export const GATE_STRIDE = 15;

export const DFF_SLOTS = {
  /** 1 = falling edge */
  falling: 0,
  setup: 1,
  hold: 2,
  tckq: 3,
  vdd: 4,
  vth: 5,
  cload: 6,
  rout: 7,
  /** 0 = initial low, 1 = initial high, 2 = unknown */
  initial: 8,
  /** 1 = reset active low */
  resetLow: 9,
  hasReset: 10,
  /** 1 = complementary output QN is loaded */
  hasQN: 11,
  /** 1 = scan chain multiplexer present */
  scan: 12,
} as const;
export const DFF_STRIDE = 13;

/**
 * Multiplexer / demultiplexer element layout (nodes):
 *   nodes[0 .. channels-1]            data inputs (mux only)
 *   nodes[dataCount .. +selectBits-1] select lines, S0 first
 *   mux:     nodes[channels+selectBits]           → Y
 *   demux:   nodes[1+selectBits .. +channels-1]    → Y0..Y(channels-1)
 * `dataCount` is 1 for a demux/decoder (IN is the data, or the enable in decoder
 * mode) and `channels` for a mux.
 */
export const MUX_SLOTS = {
  channels: 0,
  selectBits: 1,
  /** 0 = mux, 1 = demux, 2 = decoder */
  mode: 2,
  vdd: 3,
  vth: 4,
  tphl: 5,
  tplh: 6,
  cload: 7,
  rout: 8,
} as const;
export const MUX_STRIDE = 9;

export const PROBE_SLOTS = {
  /** 0 voltage, 1 current, 2 power, 3 temperature, 4 logic, 5 frequency */
  kind: 0,
  /** probe index in the netlist probe table */
  index: 1,
  /** for power probes: the element whose power is measured */
  target: 2,
} as const;
export const PROBE_STRIDE = 3;

/** Layout lookup by element kind. */
export interface KindLayout {
  stride: number;
  slots: Record<string, number>;
  /**
   * Element-parameter slot holding the level-3 thermal node this element heats,
   * or undefined when the kind has no thermal node at all.
   *
   * This is the slot in the *element* parameter array, which is not the same
   * table as the model array: the semiconductors carry their junction node in an
   * early element slot (diode/BJT 1, MOSFET 3) while the passives use the
   * `thermalNode` field of their own layout. Reading the model-array slot
   * (D_SLOTS.thermalNode = 26, …) on an element array returned 0 — the first
   * thermal node of the circuit — so a transistor's heat was injected into a
   * resistor's junction and the element "temperature" was somebody else's.
   */
  thermalSlot?: number;
}

/**
 * Thermal node an element heats (level 3), or -1 when it has none.
 *
 * Honest by construction: a kind that declares no `thermalSlot` returns -1 (its
 * dissipation is reported in the power statistics but feeds no thermal node),
 * and an element whose slot is negative (or was never written) returns -1 too.
 */
export function elementThermalNode(kind: number, paramOffset: number, params: Float64Array): number {
  const slot = KIND_LAYOUT[kind]?.thermalSlot;
  if (slot === undefined) return -1;
  const v = params[paramOffset + slot];
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : -1;
}

export const KIND_LAYOUT: Record<number, KindLayout> = {
  1: { stride: R_STRIDE, slots: R_SLOTS, thermalSlot: R_SLOTS.thermalNode }, // resistor
  2: { stride: C_STRIDE, slots: C_SLOTS, thermalSlot: C_SLOTS.thermalNode }, // capacitor
  3: { stride: L_STRIDE, slots: L_SLOTS, thermalSlot: L_SLOTS.thermalNode }, // inductor
  4: { stride: POT_STRIDE, slots: POT_SLOTS, thermalSlot: POT_SLOTS.thermalNode }, // potentiometer
  5: { stride: XFMR_STRIDE, slots: XFMR_SLOTS, thermalSlot: XFMR_SLOTS.thermalNode }, // transformer
  6: { stride: R_STRIDE, slots: R_SLOTS, thermalSlot: R_SLOTS.thermalNode }, // NTC
  7: { stride: R_STRIDE, slots: R_SLOTS, thermalSlot: R_SLOTS.thermalNode }, // varistor (always -1)
  // Semiconductors: the junction node lives in an early element slot (see the
  // lowering), not in the model-array `thermalNode` field.
  10: { stride: D_STRIDE, slots: D_SLOTS, thermalSlot: 1 },
  11: { stride: D_STRIDE, slots: D_SLOTS, thermalSlot: 1 },
  12: { stride: D_STRIDE, slots: D_SLOTS, thermalSlot: 1 },
  13: { stride: BJT_STRIDE, slots: BJT_SLOTS, thermalSlot: 1 },
  14: { stride: MOS_STRIDE, slots: MOS_SLOTS, thermalSlot: 3 },
  // Switches have no junction to heat: their dissipation is reported, but the
  // model declares no self-heating (no rth/cth parameters).
  20: { stride: SW_STRIDE, slots: SW_SLOTS },
  21: { stride: SW_STRIDE, slots: SW_SLOTS },
  22: { stride: RELAY_STRIDE, slots: RELAY_SLOTS, thermalSlot: RELAY_SLOTS.thermalNode },
  30: { stride: SRC_STRIDE, slots: SRC_SLOTS },
  31: { stride: SRC_STRIDE, slots: SRC_SLOTS },
  35: { stride: CS_STRIDE, slots: CS_SLOTS },
  36: { stride: CS_STRIDE, slots: CS_SLOTS },
  37: { stride: CS_STRIDE, slots: CS_SLOTS },
  38: { stride: CS_STRIDE, slots: CS_SLOTS },
  45: { stride: GATE_STRIDE, slots: GATE_SLOTS },
  46: { stride: GATE_STRIDE, slots: GATE_SLOTS },
  47: { stride: GATE_STRIDE, slots: GATE_SLOTS },
  48: { stride: DFF_STRIDE, slots: DFF_SLOTS },
  49: { stride: DFF_STRIDE, slots: DFF_SLOTS },
  50: { stride: MUX_STRIDE, slots: MUX_SLOTS },
  51: { stride: MUX_STRIDE, slots: MUX_SLOTS },
  62: { stride: PROBE_STRIDE, slots: PROBE_SLOTS },
  63: { stride: PROBE_STRIDE, slots: PROBE_SLOTS },
  64: { stride: PROBE_STRIDE, slots: PROBE_SLOTS },
  67: { stride: SRC_STRIDE, slots: SRC_SLOTS },
};

export function layoutOf(kind: number): KindLayout | undefined {
  return KIND_LAYOUT[kind];
}

/**
 * Maximum node count per element (nodes array stride).
 *
 * 16 slots cover the widest digital primitive that stays a single element:
 * an 8-way multiplexer (8 data + 3 select + 1 output = 12) and an 8-way
 * demultiplexer/decoder (1 data + 3 select + 8 outputs = 12). Wider
 * multiplexers are a diagnostic (CF5104) rather than a silent truncation.
 */
export const NODE_STRIDE = 16;

/** Per-element simulator state stride (device history, gate state…). */
export const STATE_STRIDE = 24;
