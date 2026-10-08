/**
 * Digital component library: primitive gates, latches, flip-flops, mux/demux.
 *
 * Every gate carries a `style` parameter that selects how it is *implemented*:
 *
 *   ideal              — a behavioural element with user-declared delays. Fastest;
 *                        used by the logic engine and by the search filter.
 *   cmos_static        — expanded into real NMOS/PMOS transistors with the given
 *                        W/L and transistors' electrical parameters. This is the
 *                        "no abstraction without access to its implementation"
 *                        requirement: a NAND gate *is* four transistors when you
 *                        ask for the electrical level.
 *   pass_transistor    — NMOS-only pass logic (with the real Vth drop).
 *   transmission_gate  — complementary pass gates.
 *
 * Level 0 (logic) always uses the behavioural model (that is the point of a fast
 * filter); levels 1–3 use the selected style, and the UI can expand any gate in
 * place to inspect the transistors.
 */

import { Accuracy } from './labels.js';
import type { ComponentSpec, PinSpec, SymbolShape } from './library.js';

// ---------------------------------------------------------------------------
// Symbol builders
// ---------------------------------------------------------------------------

const BUBBLE: Extract<SymbolShape, { k: 'circle' }> = { k: 'circle', cx: 1.28, cy: 0, r: 0.18 };

/** AND-shaped body: left edge at x=-1, D-curve on the right. */
function andBody(): SymbolShape[] {
  return [
    { k: 'poly', pts: [-1, -1, 0, -1], t: 0.16 },
    { k: 'poly', pts: [-1, 1, 0, 1], t: 0.16 },
    { k: 'line', x1: -1, y1: -1, x2: -1, y2: 1, t: 0.16 },
    { k: 'arc', cx: 0, cy: 0, r: 1, a0: -90, a1: 90, t: 0.16 },
  ];
}

/** OR-shaped body (curved input edge, pointed output). */
function orBody(): SymbolShape[] {
  return [
    { k: 'poly', pts: [-1, -1, 0.1, -1], t: 0.16 },
    { k: 'poly', pts: [-1, 1, 0.1, 1], t: 0.16 },
    { k: 'arc', cx: -0.35, cy: 0, r: 2.2, a0: -78, a1: 78, t: 0.16 },
    { k: 'arc', cx: 0.1, cy: 0, r: 1, a0: -90, a1: 90, t: 0.16 },
  ];
}

function xorBody(): SymbolShape[] {
  return [
    ...orBody(),
    { k: 'arc', cx: -0.95, cy: 0, r: 2.2, a0: -78, a1: 78, t: 0.16 },
  ];
}

function notBody(): SymbolShape[] {
  return [
    { k: 'poly', pts: [-1, -1, 1, 0, -1, 1], t: 0.16 },
  ];
}

function bufBody(): SymbolShape[] {
  return [{ k: 'poly', pts: [-1, -1, 1, 0, -1, 1], t: 0.16 }];
}

export type GateShape = 'and' | 'or' | 'xor' | 'not' | 'buf';

function gateSymbol(shape: GateShape, bubble: boolean, inputs: number): SymbolShape[] {
  let body: SymbolShape[];
  switch (shape) {
    case 'and':
      body = andBody();
      break;
    case 'or':
      body = orBody();
      break;
    case 'xor':
      body = xorBody();
      break;
    case 'not':
    case 'buf':
      body = notBody();
      break;
  }
  const out: SymbolShape[] = [...body];
  if (bubble) out.push(shape === 'and' || shape === 'xor' || shape === 'or' ? { ...BUBBLE, cx: 1.15 } : BUBBLE);
  void inputs;
  return out;
}

/**
 * Maximum number of input pins a gate component declares. One element holds 15
 * inputs, so a gate declared with 16 is expanded into a tree of 2-input gates by
 * the lowerer — the pin exists, and the netlist stays within one element.
 */
const MAX_GATE_INPUT_PINS = 16;

/**
 * Pins of a gate. The component declares the pins for its *default* input count
 * and, for the multi-input families, the extra pins up to the maximum the element
 * can carry (15): they are optional, so an unused one is not a warning, and the
 * `inputs` parameter decides how many of them the gate actually reads.
 */
function gatePins(inputs: number, inverted: boolean, shape: GateShape): PinSpec[] {
  const pins: PinSpec[] = [];
  const span = 2.4;
  const maxPins = inputs > 1 ? MAX_GATE_INPUT_PINS : inputs;
  const declared = Math.max(inputs, maxPins);
  for (let i = 0; i < declared; i++) {
    // The first `inputs` pins sit on the body; the optional extras continue
    // below it, and the renderer re-lays them out from the `inputs` parameter.
    const inside = i < inputs;
    const t = inputs === 1 ? 0 : i / (inputs - 1);
    const extra = i - inputs + 1;
    const y = inside ? -span / 2 + t * span : span / 2 + extra * 0.9;
    pins.push({
      name: `IN${i + 1}`,
      direction: 'input',
      electrical: 'digital',
      x: shape === 'and' ? -2 : -2.15,
      y,
      optional: !inside,
    });
  }
  pins.push({
    name: 'OUT',
    direction: 'output',
    electrical: 'digital',
    x: 2,
    y: 0,
    description: inverted ? 'Inverted output' : 'Output',
  });
  return pins;
}

/** Common electrical parameters shared by all gate implementations. */
function gateElectricalParams(wDef: number, lDef: number): ComponentSpec['params'] {
  return [
    { name: 'vdd', kind: 'number', unit: 'volt', default: 3.3, min: 0.4, description: 'Supply voltage (used by the transistor-level implementation and for logic thresholds)', sensitive: true },
    { name: 'vth', kind: 'number', unit: 'volt', default: 1.65, description: 'Logic threshold (input voltage at which the input flips)' },
    { name: 'wn', kind: 'number', unit: 'meter', default: wDef, min: 1e-9, description: 'NMOS width used when expanding to transistors', deviceParameter: true },
    { name: 'wp', kind: 'number', unit: 'meter', default: wDef * 2, min: 1e-9, description: 'PMOS width used when expanding (2–3× the NMOS width is typical)', deviceParameter: true },
    { name: 'l', kind: 'number', unit: 'meter', default: lDef, min: 1e-9, description: 'Gate length used when expanding', deviceParameter: true },
    { name: 'tphl', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Propagation delay HIGH→LOW (0 = derive from the electrical model)', sensitive: true },
    { name: 'tplh', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Propagation delay LOW→HIGH' },
    { name: 'tr', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Output rise time (0 = derive)' },
    { name: 'tf', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Output fall time (0 = derive)' },
    { name: 'cload', kind: 'number', unit: 'farad', default: 0, min: 0, description: 'Extra load capacitance used by the timing model' },
    { name: 'rout', kind: 'number', unit: 'ohm', default: 100, min: 1e-6, description: 'Output resistance of the logic driver', sensitive: true },
    { name: 'drive', kind: 'number', unit: '', default: 1, min: 0.01, description: 'Output drive strength multiplier (fan-out capability)' },
  ];
}

const styleParam: ComponentSpec['params'][number] = {
  name: 'style',
  kind: 'choice',
  default: 'ideal',
  choices: ['ideal', 'cmos_static', 'pass_transistor', 'transmission_gate'],
  description: 'Circuit style: how the gate is implemented when expanded to the electrical level',
  sensitive: true,
};

const gateCard: ComponentSpec['model'] = {
  family: 'Primitive gate: behavioural logic model + optional CMOS transistor expansion',
  version: '1.0.0',
  claims: [
    {
      phenomenon: 'logic function',
      level: Accuracy.REALISTIC,
      detail: 'The boolean function is computed exactly, including the X (unknown) and Z (high-impedance) states with three-valued logic rules.',
    },
    {
      phenomenon: 'delay',
      level: Accuracy.APPROXIMATED,
      detail:
        'With style = ideal the delay is the declared TPHL/TPLH (linear ramp output); with a transistor style the delay emerges from the RC charging of the load by the real MOSFETs, which reproduces the load dependence and the asymmetry between the two edges.',
      validity: 'ideal style requires the user to provide the delay (default 0 = no delay)',
    },
    {
      phenomenon: 'input loading',
      level: Accuracy.APPROXIMATED,
      detail: 'Each input presents a capacitance derived from the transistor geometry when expanded; the ideal style uses a fixed value taken from the electrical parameters.',
    },
    {
      phenomenon: 'power',
      level: Accuracy.REALISTIC,
      detail:
        'When expanded, static (cross-conduction), dynamic (CV²f) and leakage power all emerge from the transistor model — they are not entered as numbers. With style = ideal, power is a documented estimate P = C·V²·f + leakage, flagged as an estimate.',
    },
    {
      phenomenon: 'metastability / setup-hold',
      level: Accuracy.NOT_MODELED,
      detail: 'For memory elements, no setup/hold window or metastability resolution curve is modelled; timing violations are reported as crisp errors.',
    },
  ],
  equations: ['Y = f(A,B,…)  with 0/1/X/Z', 't_pd from the RC charge of the load when transistor-expanded'],
  parameters: [
    { name: 'vdd', unit: 'V', meaning: 'supply voltage' },
    { name: 'tphl/tplh', unit: 's', meaning: 'declared delays for the ideal style' },
    { name: 'wn/wp/l', unit: 'm', meaning: 'transistor geometry used for expansion' },
  ],
  limitations: [
    'The ideal style has no supply-current modelling: use a transistor style when power matters.',
    'No charge sharing, no ratio fighting, no body-bias detail beyond the body effect.',
  ],
  references: ['Weste & Harris, CMOS VLSI Design', 'Rabaey, Digital Integrated Circuits'],
  levels: [0, 1, 2, 3],
};

function makeGate(
  id: string,
  name: string,
  description: string,
  shape: GateShape,
  inputs: number,
  bubble: boolean,
  extraParams: ComponentSpec['params'] = [],
  keywords: string[] = [],
): ComponentSpec {
  const refPrefix = shape === 'not' || shape === 'buf' ? 'U' : `U`;
  return {
    id,
    name,
    category: 'digital',
    description,
    refPrefix,
    spicePrefix: 'X',
    pins: gatePins(inputs, bubble, shape),
    params: [
      styleParam,
      ...gateElectricalParams(10e-6, 0.18e-6),
      {
        name: 'inputs',
        kind: 'number',
        unit: '',
        default: inputs,
        min: 1,
        max: 16,
        description: 'Actual number of inputs used (1 is legal: a one-input gate is the identity, which is how NOT and BUFFER reduce)',
      },
      ...extraParams,
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['GATE'] },
    symbol: gateSymbol(shape, bubble, inputs),
    keywords: ['gate', 'logic', ...keywords],
  };
}

export const DIGITAL_SPECS: ComponentSpec[] = [
  makeGate('not_gate', 'NOT Gate (Inverter)', 'CMOS inverter; the fundamental digital building block.', 'not', 1, true, [], ['inverter', 'inv']),
  makeGate('buffer', 'Buffer', 'Non-inverting driver; useful to model fan-out and level restoration.', 'buf', 1, false, [], ['buf', 'driver']),
  makeGate('and_gate', 'AND Gate', 'Logical AND.', 'and', 2, false, [], ['and']),
  makeGate('nand_gate', 'NAND Gate', 'Logical NAND; the natural CMOS primitive (2 series NMOS + 2 parallel PMOS).', 'and', 2, true, [], ['nand']),
  makeGate('or_gate', 'OR Gate', 'Logical OR.', 'or', 2, false, [], ['or']),
  makeGate('nor_gate', 'NOR Gate', 'Logical NOR.', 'or', 2, true, [], ['nor']),
  makeGate('xor_gate', 'XOR Gate', 'Logical exclusive-OR; expands to a transmission-gate implementation.', 'xor', 2, false, [
    { name: 'implementation', kind: 'choice', default: 'transmission_gate', choices: ['transmission_gate', 'static_cmos', 'mirror'], description: 'XOR circuit topology used when expanded', sensitive: true },
  ], ['xor']),
  makeGate('xnor_gate', 'XNOR Gate', 'Logical exclusive-NOR (equivalence).', 'xor', 2, true, [
    { name: 'implementation', kind: 'choice', default: 'transmission_gate', choices: ['transmission_gate', 'static_cmos', 'mirror'], description: 'Circuit topology used when expanded', sensitive: true },
  ], ['xnor']),
  {
    id: 'tristate',
    name: 'Tri-State Buffer',
    category: 'digital',
    description: 'Three-state driver: output is driven or high-impedance (Z), with real enable timing.',
    refPrefix: 'U',
    spicePrefix: 'X',
    pins: [
      { name: 'IN', direction: 'input', electrical: 'digital', x: -2, y: -0.8 },
      { name: 'EN', direction: 'input', electrical: 'digital', x: -2, y: 1.2, description: 'Enable (active high)' },
      { name: 'OUT', direction: 'output', electrical: 'digital', x: 2, y: 0 },
    ],
    params: [
      styleParam,
      ...gateElectricalParams(20e-6, 0.18e-6),
      { name: 'enableDelay', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Extra delay when entering/leaving high-impedance' },
      { name: 'activeLow', kind: 'boolean', default: false, description: 'Enable is active low' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['GATE'] },
    symbol: [
      { k: 'poly', pts: [-1, -1, 1, 0, -1, 1], t: 0.16 },
      { k: 'line', x1: -1.5, y1: 1.2, x2: -1, y2: 1.2 },
      { k: 'circle', cx: -1.65, cy: 1.2, r: 0.15 },
    ],
    keywords: ['tri', 'zbuf', 'bus'],
  },
  {
    id: 'dff',
    name: 'D Flip-Flop',
    category: 'digital',
    description: 'Edge-triggered D flip-flop with asynchronous reset/preset, real setup/hold reporting.',
    refPrefix: 'U',
    spicePrefix: 'X',
    pins: [
      { name: 'D', direction: 'input', electrical: 'digital', x: -3, y: -2 },
      { name: 'CLK', direction: 'input', electrical: 'digital', x: -3, y: 0 },
      { name: 'RST', direction: 'input', electrical: 'digital', x: -3, y: 2, optional: true },
      { name: 'Q', direction: 'output', electrical: 'digital', x: 3, y: -1.5 },
      { name: 'QN', direction: 'output', electrical: 'digital', x: 3, y: 1.5, optional: true },
    ],
    params: [
      styleParam,
      ...gateElectricalParams(20e-6, 0.18e-6),
      { name: 'edge', kind: 'choice', default: 'rising', choices: ['rising', 'falling'], description: 'Active clock edge' },
      { name: 'setup', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Setup time (used by the validation pipeline to detect violations)' },
      { name: 'hold', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Hold time' },
      { name: 'tckq', kind: 'number', unit: 'second', default: 0, min: 0, description: 'Clock-to-Q delay (0 = derived from tphl/tplh)' },
      { name: 'resetActive', kind: 'choice', default: 'high', choices: ['high', 'low'], description: 'Reset polarity' },
      { name: 'initial', kind: 'choice', default: '0', choices: ['0', '1', 'X'], description: 'Power-on state' },
      { name: 'scan', kind: 'boolean', default: false, description: 'Adds a scan multiplexer in front of the D input (DFT)' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: {
      ...gateCard,
      family: 'Edge-triggered storage element, master–slave transmission-gate realisation',
      claims: [
        { phenomenon: 'state storage', level: Accuracy.REALISTIC, detail: 'State machine with edge detection; the initial state is a parameter because a real flip-flop has no defined power-on value without a reset.' },
        { phenomenon: 'timing', level: Accuracy.APPROXIMATED, detail: 'Crisp setup/hold windows with declared values; metastability resolution is not simulated — a violation is reported as a diagnostic instead.' },
        { phenomenon: 'dynamic power', level: Accuracy.REALISTIC, detail: 'When expanded to transistors, the clock-to-Q switching energy emerges from the actual node capacitances.' },
        { phenomenon: 'clock jitter / radiation-induced upsets', level: Accuracy.NOT_MODELED, detail: 'Not modelled.' },
      ],
    },
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['DFF'] },
    symbol: [
      { k: 'rect', x: -2, y: -2.5, w: 4, h: 5, t: 0.16, r: 0.2 },
      { k: 'line', x1: -3, y1: -2, x2: -2, y2: -2 },
      { k: 'line', x1: -3, y1: 0, x2: -2, y2: 0 },
      { k: 'line', x1: -3, y1: 2, x2: -2, y2: 2 },
      { k: 'line', x1: 3, y1: -1.5, x2: 2, y2: -1.5 },
      { k: 'line', x1: 3, y1: 1.5, x2: 2, y2: 1.5 },
      { k: 'poly', pts: [-2, -0.35, -1.5, 0, -2, 0.35], t: 0.12 },
      { k: 'text', x: -1.55, y: -1.6, s: 'D', size: 0.75 },
      { k: 'text', x: -1.55, y: 2.4, s: 'R', size: 0.75 },
      { k: 'text', x: 1.55, y: 0.2, s: 'Q', size: 0.75, anchor: 'r' },
    ],
    keywords: ['ff', 'flipflop', 'register', 'storage'],
  },
  {
    id: 'dlatch',
    name: 'D Latch',
    category: 'digital',
    description: 'Level-sensitive D latch (transparent when enabled).',
    refPrefix: 'U',
    spicePrefix: 'X',
    pins: [
      { name: 'D', direction: 'input', electrical: 'digital', x: -3, y: -1.5 },
      { name: 'EN', direction: 'input', electrical: 'digital', x: -3, y: 1.5 },
      { name: 'Q', direction: 'output', electrical: 'digital', x: 3, y: 0 },
    ],
    params: [styleParam, ...gateElectricalParams(20e-6, 0.18e-6), { name: 'initial', kind: 'choice', default: '0', choices: ['0', '1', 'X'], description: 'Power-on state' }],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['DLATCH'] },
    symbol: [
      { k: 'rect', x: -2, y: -2, w: 4, h: 4, t: 0.16, r: 0.2 },
      { k: 'line', x1: -3, y1: -1.5, x2: -2, y2: -1.5 },
      { k: 'line', x1: -3, y1: 1.5, x2: -2, y2: 1.5 },
      { k: 'line', x1: 3, y1: 0, x2: 2, y2: 0 },
      { k: 'text', x: -1.6, y: -1.1, s: 'D', size: 0.75 },
      { k: 'text', x: -1.6, y: 1.9, s: 'E', size: 0.75 },
    ],
    keywords: ['latch', 'transparent'],
  },
  {
    id: 'mux',
    name: 'Multiplexer',
    category: 'digital',
    description: '2^N-to-1 multiplexer with select lines; expands to transmission gates or a static CMOS tree.',
    refPrefix: 'U',
    spicePrefix: 'X',
    pins: [
      { name: 'I0', direction: 'input', electrical: 'digital', x: -3, y: -2.4 },
      { name: 'I1', direction: 'input', electrical: 'digital', x: -3, y: -0.8 },
      { name: 'I2', direction: 'input', electrical: 'digital', x: -3, y: 0.8, optional: true },
      { name: 'I3', direction: 'input', electrical: 'digital', x: -3, y: 2.4, optional: true },
      { name: 'S0', direction: 'input', electrical: 'digital', x: -3, y: 4 },
      { name: 'S1', direction: 'input', electrical: 'digital', x: -3, y: 5.2, optional: true },
      { name: 'Y', direction: 'output', electrical: 'digital', x: 3, y: 0 },
    ],
    params: [
      styleParam,
      ...gateElectricalParams(20e-6, 0.18e-6),
      { name: 'channels', kind: 'number', unit: '', default: 2, min: 2, max: 16, description: 'Number of inputs (power of two)', sensitive: true },
      { name: 'selectBits', kind: 'number', unit: '', default: 1, min: 1, max: 4, description: 'Number of select lines' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['MUX'] },
    symbol: [
      { k: 'poly', pts: [-2, -2.8, 0, -3.4, 2, -2.2, 2, 2.2, 0, 3.4, -2, 2.8], t: 0.16 },
      { k: 'text', x: 0.6, y: 0.4, s: 'MUX', size: 0.8, anchor: 'c' },
    ],
    keywords: ['mux', 'select'],
  },
  {
    id: 'demux',
    name: 'Demultiplexer / Decoder',
    category: 'digital',
    description: '1-to-2^N demultiplexer / binary decoder. In decoder mode (decoderOnly) the data input acts as the enable of the decoded word, and the optional EN pin is used when it is wired.',
    refPrefix: 'U',
    spicePrefix: 'X',
    pins: [
      { name: 'IN', direction: 'input', electrical: 'digital', x: -3, y: -2.4 },
      { name: 'EN', direction: 'input', electrical: 'digital', x: -3, y: -0.8, optional: true, description: 'Decoder mode: enable of the decoded word (IN is used when EN is not wired)' },
      { name: 'S0', direction: 'input', electrical: 'digital', x: -3, y: 0.8 },
      { name: 'S1', direction: 'input', electrical: 'digital', x: -3, y: 2.4, optional: true },
      { name: 'Y0', direction: 'output', electrical: 'digital', x: 3, y: -2.4 },
      { name: 'Y1', direction: 'output', electrical: 'digital', x: 3, y: -0.8 },
      { name: 'Y2', direction: 'output', electrical: 'digital', x: 3, y: 0.8, optional: true },
      { name: 'Y3', direction: 'output', electrical: 'digital', x: 3, y: 2.4, optional: true },
    ],
    params: [
      styleParam,
      ...gateElectricalParams(20e-6, 0.18e-6),
      { name: 'outputs', kind: 'number', unit: '', default: 2, min: 2, max: 16, description: 'Number of outputs', sensitive: true },
      { name: 'decoderOnly', kind: 'boolean', default: false, description: 'Decoder mode: outputs are the decoded address, IN acts as the enable' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: true, lowersTo: ['DEMUX'] },
    symbol: [
      { k: 'poly', pts: [-2, -3.4, 2, -2.2, 2, 2.2, -2, 3.4], t: 0.16 },
      { k: 'text', x: 0.3, y: 0.4, s: 'DMX', size: 0.7, anchor: 'c' },
    ],
    keywords: ['demux', 'decoder'],
  },

  {
    id: 'logic_high',
    name: 'Logic High (1)',
    category: 'digital',
    description: 'Constant logic high. Level 0 uses it as a source; at the electrical level it is a driver to VDD through the output resistance.',
    refPrefix: 'V',
    spicePrefix: 'X',
    pins: [{ name: 'OUT', direction: 'output', electrical: 'digital', x: 2, y: 0, width: 1 }],
    params: [
      ...gateElectricalParams(10e-6, 0.18e-6),
      { name: 'vdd', kind: 'number', unit: 'V', default: 3.3, min: 0, description: 'Logic-high voltage' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: false, lowersTo: ['LOGIC_BUFFER'] },
    symbol: [
      { k: 'line', x1: -1.4, y1: 0, x2: 0.6, y2: 0, t: 0.16 },
      { k: 'text', x: -0.6, y: 0, s: '1', size: 1.1, anchor: 'c' },
    ],
    keywords: ['high', 'vdd', 'one', 'constant', 'supply'],
  },
  {
    id: 'logic_low',
    name: 'Logic Low (0)',
    category: 'digital',
    description: 'Constant logic low. Level 0 uses it as a source; at the electrical level it is a driver to 0 V through the output resistance.',
    refPrefix: 'V',
    spicePrefix: 'X',
    pins: [{ name: 'OUT', direction: 'output', electrical: 'digital', x: 2, y: 0, width: 1 }],
    params: [...gateElectricalParams(10e-6, 0.18e-6)],
    accuracy: Accuracy.APPROXIMATED,
    model: gateCard,
    support: { logic: true, electrical: true, thermal: true, expandable: false, lowersTo: ['LOGIC_BUFFER'] },
    symbol: [
      { k: 'line', x1: -1.4, y1: 0, x2: 0.6, y2: 0, t: 0.16 },
      { k: 'text', x: -0.6, y: 0, s: '0', size: 1.1, anchor: 'c' },
    ],
    keywords: ['low', 'gnd', 'zero', 'constant'],
  },
];
