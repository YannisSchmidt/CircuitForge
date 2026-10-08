/**
 * Semiconductor component library.
 *
 * Every device here is implemented by real equations in `sim/elements` (levels 2
 * and 3). The `ModelCard` states the exact equations, their validity domain and
 * everything that is *not* modelled — this is the difference between an
 * engineering tool and a toy.
 */

import { Accuracy } from './labels.js';
import type { ComponentSpec } from './library.js';

// ---------------------------------------------------------------------------
// Diode family
// ---------------------------------------------------------------------------

const diodeCard = {
  family: 'Shockley diode with series resistance, junction capacitance and breakdown',
  version: '1.0.0',
  claims: [
    {
      phenomenon: 'static I-V',
      level: Accuracy.REALISTIC,
      detail:
        'i = Is·(exp(v/(N·Vt)) − 1) solved implicitly by Newton–Raphson with junction limiting. Reverse saturation, exponential turn-on and the ideality factor are all real (SPICE-class).',
      validity: 'up to the rated current; high-injection (IKF) is not modelled',
    },
    {
      phenomenon: 'series resistance',
      level: Accuracy.REALISTIC,
      detail: 'RS is stamped as a real series resistor, so the forward curve bends over correctly at high current.',
    },
    {
      phenomenon: 'zero-bias / junction capacitance',
      level: Accuracy.REALISTIC,
      detail: 'Cj(v) = Cj0·(1 − v/Vj)^(−M) with the standard linear extrapolation beyond FC·Vj. Reproduces the switching behaviour of a real diode.',
    },
    {
      phenomenon: 'reverse breakdown',
      level: Accuracy.APPROXIMATED,
      detail: 'An exponential breakdown branch is added when v < −BV. The BV edge shape is approximate; tunnelling detail is not reproduced.',
      validity: 'v > −2·BV',
    },
    {
      phenomenon: 'temperature dependence',
      level: Accuracy.REALISTIC,
      detail: 'Is(T) = Is·(T/Tnom)^(XTI/N)·exp(−Eg·(T−Tnom)/(N·Vt·T·Tnom)) — the standard SPICE law. Gives the real ≈ −2 mV/°C forward-voltage drift.',
    },
    {
      phenomenon: 'self-heating',
      level: Accuracy.APPROXIMATED,
      detail:
        'At level 3 the device heats through Rth_jc/Rth_ca/Cth, and the temperature feeds back into Is(T) → the real thermal runaway tendency appears. The package thermal network is single-node per junction.',
    },
    {
      phenomenon: 'reverse recovery charge (trr)',
      level: Accuracy.APPROXIMATED,
      detail: 'Emerges from the junction capacitance; the minority-carrier diffusion component (TT) is included as a transit-time term but not as a full charge-control model.',
    },
    { phenomenon: 'avalanche noise / softness factor', level: Accuracy.NOT_MODELED, detail: 'No avalanche noise, no breakdown softness parameter.' },
  ],
  equations: [
    'i_fwd = Is·(exp(v_d/(N·Vt)) − 1)',
    'i_bd  = −Ibv·exp(−(v_d + BV)/(NBV·Vt))',
    'v_d = v_int − i·RS',
    'Cj(v) = Cj0·(1 − v/Vj)^(−M)',
    'Is(T) = Is·(T/Tnom)^(XTI/N)·exp(−Eg(T−Tnom)/(N·Vt·T·Tnom))',
  ],
  parameters: [
    { name: 'is', unit: 'A', meaning: 'saturation current' },
    { name: 'n', unit: '', meaning: 'emission (ideality) coefficient' },
    { name: 'rs', unit: 'Ω', meaning: 'series resistance' },
    { name: 'bv', unit: 'V', meaning: 'reverse breakdown voltage' },
    { name: 'cj0', unit: 'F', meaning: 'zero-bias junction capacitance' },
    { name: 'tt', unit: 's', meaning: 'transit time' },
  ],
  limitations: [
    'No high-injection (IKF) roll-off of the ideality factor at very high current.',
    'No avalanche or shot noise generated inside the model (noise analysis covers thermal noise of the resistors).',
    'Reverse recovery is only partly represented (junction + transit time).',
  ],
  references: ['SPICE2 diode model (Nagel 1975)', 'Antognetti & Massobrio, Semiconductor Device Modeling with SPICE'],
  levels: [1, 2, 3],
};

const diodeSymbol = (extra: ComponentSpec['symbol'] = []): ComponentSpec['symbol'] => [
  { k: 'line', x1: 0, y1: -2, x2: 0, y2: -0.85 },
  { k: 'line', x1: 0, y1: 0.85, x2: 0, y2: 2 },
  { k: 'filled', pts: [0, -0.85, -0.9, 0.85, 0.9, 0.85] },
  { k: 'line', x1: -0.9, y1: 0.85, x2: 0.9, y2: 0.85, t: 0.22 },
  ...extra,
];

export const DIODE_SPECS: ComponentSpec[] = [
  {
    id: 'diode',
    name: 'Diode',
    category: 'semiconductor',
    description: 'Signal / rectifier / Schottky / Zener diode with full SPICE-class junction model.',
    refPrefix: 'D',
    spicePrefix: 'D',
    footprint: 'SMD/SOD-323',
    examplePart: '1N4148W',
    pins: [
      { name: 'A', direction: 'passive', electrical: 'analog', x: 0, y: -2, description: 'Anode' },
      { name: 'K', direction: 'passive', electrical: 'analog', x: 0, y: 2, description: 'Cathode' },
    ],
    params: [
      { name: 'variant', kind: 'choice', default: 'silicon', choices: ['silicon', 'schottky', 'zener', 'fast'], description: 'Parameter preset (selected parameters are pre-filled and remain editable)', sensitive: true },
      { name: 'is', kind: 'number', unit: 'amp', default: 2.52e-9, min: 1e-18, description: 'Saturation current', deviceParameter: true },
      { name: 'n', kind: 'number', unit: '', default: 1.752, min: 0.5, max: 10, description: 'Emission coefficient', deviceParameter: true },
      { name: 'rs', kind: 'number', unit: 'ohm', default: 0.568, min: 0, description: 'Series resistance', deviceParameter: true },
      { name: 'cj0', kind: 'number', unit: 'farad', default: 4e-12, min: 0, description: 'Zero-bias junction capacitance', deviceParameter: true },
      { name: 'vj', kind: 'number', unit: 'volt', default: 0.7, min: 0.1, description: 'Junction potential', deviceParameter: true },
      { name: 'm', kind: 'number', unit: '', default: 0.333, min: 0, max: 1, description: 'Grading coefficient', deviceParameter: true },
      { name: 'tt', kind: 'number', unit: 'second', default: 11.54e-9, min: 0, description: 'Transit time', deviceParameter: true },
      { name: 'bv', kind: 'number', unit: 'volt', default: 100, min: 0.1, description: 'Reverse breakdown voltage', deviceParameter: true },
      { name: 'ibv', kind: 'number', unit: 'amp', default: 1e-3, min: 0, description: 'Current at breakdown', deviceParameter: true },
      { name: 'eg', kind: 'number', unit: '', default: 1.11, description: 'Activation energy (eV)', deviceParameter: true },
      { name: 'xti', kind: 'number', unit: '', default: 3, description: 'Saturation-current temperature exponent', deviceParameter: true },
      { name: 'tnom', kind: 'number', unit: '', default: 27, description: 'Parameter measurement temperature (°C)', deviceParameter: true },
      { name: 'ifmax', kind: 'number', unit: 'amp', default: 0.3, min: 0, description: 'Maximum forward current rating (overstress flag)', deviceParameter: true },
      { name: 'rth_jc', kind: 'number', unit: '', default: 100, min: 0.01, description: 'Junction-to-case thermal resistance (°C/W)' },
      { name: 'rth_ca', kind: 'number', unit: '', default: 350, min: 0.01, description: 'Case-to-ambient thermal resistance (°C/W)' },
      { name: 'cth', kind: 'number', unit: '', default: 0.0015, min: 1e-12, description: 'Junction thermal capacitance (J/°C)' },
      { name: 'tjmax', kind: 'number', unit: '', default: 150, description: 'Maximum junction temperature (overstress flag)', deviceParameter: true },
    ],
    accuracy: Accuracy.REALISTIC,
    model: diodeCard,
    support: { logic: true, electrical: true, thermal: true, lowersTo: ['D'] },
    symbol: diodeSymbol(),
    keywords: ['d', 'rectifier', 'schottky', 'zener'],
  },
  {
    id: 'led',
    name: 'LED',
    category: 'semiconductor',
    description: 'Light-emitting diode with radiative efficiency, luminous output and wavelength shift.',
    refPrefix: 'D',
    spicePrefix: 'D',
    pins: [
      { name: 'A', direction: 'passive', electrical: 'analog', x: 0, y: -2, description: 'Anode' },
      { name: 'K', direction: 'passive', electrical: 'analog', x: 0, y: 2, description: 'Cathode' },
    ],
    params: [
      { name: 'colour', kind: 'choice', default: 'red', choices: ['ir', 'red', 'orange', 'yellow', 'green', 'blue', 'white', 'uv'], description: 'Nominal colour (sets Vf, wavelength and efficiency preset)', sensitive: true },
      { name: 'is', kind: 'number', unit: 'amp', default: 1e-21, min: 1e-30, description: 'Saturation current (LEDs are strongly non-ideal)', deviceParameter: true },
      { name: 'n', kind: 'number', unit: '', default: 1.8, min: 0.5, max: 12, description: 'Emission coefficient', deviceParameter: true },
      { name: 'rs', kind: 'number', unit: 'ohm', default: 8, min: 0, description: 'Series resistance', deviceParameter: true },
      { name: 'cj0', kind: 'number', unit: 'farad', default: 30e-12, min: 0, description: 'Junction capacitance', deviceParameter: true },
      { name: 'vj', kind: 'number', unit: 'volt', default: 2.2, description: 'Junction potential', deviceParameter: true },
      { name: 'm', kind: 'number', unit: '', default: 0.4, description: 'Grading coefficient', deviceParameter: true },
      { name: 'bv', kind: 'number', unit: 'volt', default: 5, min: 0.1, description: 'Reverse breakdown voltage (LEDs are fragile)', deviceParameter: true },
      { name: 'eta', kind: 'number', unit: '', default: 0.35, min: 0, max: 1, description: 'Radiative (wall-plug) efficiency at nominal current', sensitive: true },
      { name: 'lambda', kind: 'number', unit: 'meter', default: 625e-9, min: 1e-9, description: 'Peak wavelength' },
      { name: 'ifnom', kind: 'number', unit: 'amp', default: 0.02, min: 1e-9, description: 'Nominal forward current for the optical parameters' },
      { name: 'ifmax', kind: 'number', unit: 'amp', default: 0.03, min: 0, description: 'Maximum forward current rating', deviceParameter: true },
      { name: 'rth_jc', kind: 'number', unit: '', default: 200, min: 0.01, description: 'Junction-to-case thermal resistance (°C/W)' },
      { name: 'rth_ca', kind: 'number', unit: '', default: 500, min: 0.01, description: 'Case-to-ambient thermal resistance (°C/W)' },
      { name: 'cth', kind: 'number', unit: '', default: 0.003, min: 1e-12, description: 'Junction thermal capacitance (J/°C)' },
      { name: 'tjmax', kind: 'number', unit: '', default: 120, description: 'Maximum junction temperature', deviceParameter: true },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: {
      ...diodeCard,
      family: 'LED: Shockley diode + optical output model',
      claims: [
        ...diodeCard.claims,
        {
          phenomenon: 'optical output',
          level: Accuracy.APPROXIMATED,
          detail:
            'Radiant flux Φ ≈ η·(I_f/Ifnom)·(v_d − v_f0) with droop (efficiency falls above nominal current) and an emission-wavelength shift of +0.1 nm/K. Gives the correct luminous trend, thermal droop and wavelength drift; it is not a measured radiometric curve.',
        },
        {
          phenomenon: 'emission spectrum / CRI / beam pattern',
          level: Accuracy.NOT_MODELED,
          detail: 'Only the peak wavelength is reported; no spectrum, no spatial distribution.',
        },
      ],
    },
    support: { logic: true, electrical: true, thermal: true, lowersTo: ['D', 'LED'] },
    symbol: diodeSymbol([
      { k: 'line', x1: 0.75, y1: -0.9, x2: 1.5, y2: -1.7, t: 0.12 },
      { k: 'line', x1: 1.1, y1: -0.6, x2: 1.85, y2: -1.4, t: 0.12 },
      { k: 'filled', pts: [1.5, -1.7, 1.2, -1.75, 1.45, -1.45] },
      { k: 'filled', pts: [1.85, -1.4, 1.55, -1.45, 1.8, -1.15] },
    ]),
    keywords: ['led', 'light', 'emitter'],
  },
  {
    id: 'photodiode',
    name: 'Photodiode',
    category: 'semiconductor',
    description: 'Photodiode: junction model plus an illumination-driven current source, with optional reverse bias.',
    refPrefix: 'PD',
    spicePrefix: 'D',
    pins: [
      { name: 'A', direction: 'passive', electrical: 'analog', x: 0, y: -2, description: 'Anode' },
      { name: 'K', direction: 'passive', electrical: 'analog', x: 0, y: 2, description: 'Cathode' },
    ],
    params: [
      { name: 'is', kind: 'number', unit: 'amp', default: 1e-12, min: 1e-24, description: 'Saturation current', deviceParameter: true },
      { name: 'n', kind: 'number', unit: '', default: 1.2, min: 0.5, max: 8, description: 'Emission coefficient', deviceParameter: true },
      { name: 'rs', kind: 'number', unit: 'ohm', default: 20, min: 0, description: 'Series resistance', deviceParameter: true },
      { name: 'cj0', kind: 'number', unit: 'farad', default: 10e-12, min: 0, description: 'Junction capacitance (set by area in reality)', deviceParameter: true },
      { name: 'vj', kind: 'number', unit: 'volt', default: 0.7, description: 'Junction potential', deviceParameter: true },
      { name: 'm', kind: 'number', unit: '', default: 0.5, description: 'Grading coefficient', deviceParameter: true },
      { name: 'responsivity', kind: 'number', unit: '', default: 0.6, min: 0, max: 1.2, description: 'Responsivity at the operating wavelength (A/W)', sensitive: true },
      { name: 'power', kind: 'number', unit: 'watt', default: 1e-6, min: 0, description: 'Incident optical power', sensitive: true },
      { name: 'lambda', kind: 'number', unit: 'meter', default: 850e-9, description: 'Operating wavelength' },
      { name: 'dark', kind: 'number', unit: 'amp', default: 1e-9, min: 0, description: 'Dark current at 25 °C (doubles every ~10 °C)' },
      { name: 'bv', kind: 'number', unit: 'volt', default: 60, min: 0.1, description: 'Reverse breakdown voltage' },
      { name: 'rth_jc', kind: 'number', unit: '', default: 300, min: 0.01, description: 'Thermal resistance (°C/W)' },
      { name: 'cth', kind: 'number', unit: '', default: 0.002, min: 1e-12, description: 'Thermal capacitance (J/°C)' },
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: {
      ...diodeCard,
      family: 'Photodiode: junction model + photocurrent source',
      claims: [
        ...diodeCard.claims,
        { phenomenon: 'photocurrent', level: Accuracy.REALISTIC, detail: 'I_ph = Responsivity·P_opt, injected in parallel with the junction — this is the standard photodiode model.' },
        { phenomenon: 'dark-current temperature dependence', level: Accuracy.APPROXIMATED, detail: 'Dark current doubles every 10 °C (rule-of-thumb fit used in datasheets).' },
        { phenomenon: 'avalanche / linearity at high power', level: Accuracy.NOT_MODELED, detail: 'No avalanche multiplication, no saturation of responsivity.' },
      ],
    },
    support: { logic: false, electrical: true, thermal: true, lowersTo: ['D', 'IPHOTO'] },
    symbol: diodeSymbol([
      { k: 'line', x1: -0.75, y1: -1.9, x2: -1.5, y2: -1.1, t: 0.12 },
      { k: 'line', x1: -1.1, y1: -2.2, x2: -1.85, y2: -1.4, t: 0.12 },
      { k: 'filled', pts: [-1.5, -1.1, -1.8, -1.35, -1.55, -1.6] },
      { k: 'filled', pts: [-1.85, -1.4, -2.15, -1.65, -1.9, -1.9] },
    ]),
    keywords: ['photodiode', 'sensor', 'light'],
  },
];

// ---------------------------------------------------------------------------
// BJT
// ---------------------------------------------------------------------------

export const BJT_SPECS: ComponentSpec[] = [
  {
    id: 'bjt',
    name: 'BJT',
    category: 'semiconductor',
    description: 'Bipolar transistor (NPN or PNP) with Ebers–Moll transport model, Early effect and β roll-off.',
    refPrefix: 'Q',
    spicePrefix: 'Q',
    footprint: 'SOT-23',
    examplePart: 'BC847B',
    pins: [
      { name: 'C', direction: 'passive', electrical: 'analog', x: 2, y: -2, description: 'Collector' },
      { name: 'B', direction: 'passive', electrical: 'analog', x: -2, y: 0, description: 'Base' },
      { name: 'E', direction: 'passive', electrical: 'analog', x: 2, y: 2, description: 'Emitter' },
    ],
    params: [
      { name: 'polarity', kind: 'choice', default: 'npn', choices: ['npn', 'pnp'], description: 'Device polarity', sensitive: true },
      { name: 'is', kind: 'number', unit: 'amp', default: 1.8e-14, min: 1e-24, description: 'Transport saturation current', deviceParameter: true },
      { name: 'bf', kind: 'number', unit: '', default: 200, min: 0.1, description: 'Ideal forward current gain βF', deviceParameter: true },
      { name: 'br', kind: 'number', unit: '', default: 4, min: 0.01, description: 'Ideal reverse current gain βR', deviceParameter: true },
      { name: 'nf', kind: 'number', unit: '', default: 1, min: 0.5, max: 8, description: 'Forward emission coefficient', deviceParameter: true },
      { name: 'nr', kind: 'number', unit: '', default: 1, min: 0.5, max: 8, description: 'Reverse emission coefficient', deviceParameter: true },
      { name: 'vaf', kind: 'number', unit: 'volt', default: 100, min: 0, description: 'Forward Early voltage (0 = no Early effect)', deviceParameter: true },
      { name: 'var', kind: 'number', unit: 'volt', default: 0, min: 0, description: 'Reverse Early voltage (0 = no reverse Early effect, as in SPICE)', deviceParameter: true },
      { name: 'ikf', kind: 'number', unit: 'amp', default: 0.1, min: 1e-9, description: 'Forward knee current (β roll-off at high current)', deviceParameter: true },
      { name: 'rb', kind: 'number', unit: 'ohm', default: 10, min: 0, description: 'Base resistance', deviceParameter: true },
      { name: 'rc', kind: 'number', unit: 'ohm', default: 1, min: 0, description: 'Collector resistance', deviceParameter: true },
      { name: 're', kind: 'number', unit: 'ohm', default: 0.5, min: 0, description: 'Emitter resistance', deviceParameter: true },
      { name: 'cje', kind: 'number', unit: 'farad', default: 11e-12, min: 0, description: 'B-E zero-bias junction capacitance', deviceParameter: true },
      { name: 'cjc', kind: 'number', unit: 'farad', default: 4e-12, min: 0, description: 'B-C zero-bias junction capacitance', deviceParameter: true },
      { name: 'vje', kind: 'number', unit: 'volt', default: 0.7, description: 'B-E built-in potential', deviceParameter: true },
      { name: 'vjc', kind: 'number', unit: 'volt', default: 0.6, description: 'B-C built-in potential', deviceParameter: true },
      { name: 'mje', kind: 'number', unit: '', default: 0.33, description: 'B-E grading coefficient', deviceParameter: true },
      { name: 'mjc', kind: 'number', unit: '', default: 0.33, description: 'B-C grading coefficient', deviceParameter: true },
      { name: 'tf', kind: 'number', unit: 'second', default: 4e-10, min: 0, description: 'Forward transit time fT', deviceParameter: true },
      { name: 'xtb', kind: 'number', unit: '', default: 1.5, description: 'β temperature coefficient', deviceParameter: true },
      { name: 'eg', kind: 'number', unit: '', default: 1.11, description: 'Bandgap energy (eV)', deviceParameter: true },
      { name: 'xti', kind: 'number', unit: '', default: 3, description: 'Is temperature exponent', deviceParameter: true },
      { name: 'tnom', kind: 'number', unit: '', default: 27, description: 'Parameter temperature (°C)', deviceParameter: true },
      { name: 'vceo', kind: 'number', unit: 'volt', default: 45, min: 0, description: 'Maximum Vce rating (overstress flag)', deviceParameter: true },
      { name: 'icmax', kind: 'number', unit: 'amp', default: 0.1, min: 0, description: 'Maximum collector current rating', deviceParameter: true },
      { name: 'pdmax', kind: 'number', unit: 'watt', default: 0.25, min: 0, description: 'Maximum power dissipation at 25 °C (derated by Rth)', deviceParameter: true },
      { name: 'rth_jc', kind: 'number', unit: '', default: 120, min: 0.01, description: 'Junction-to-case thermal resistance (°C/W)' },
      { name: 'rth_ca', kind: 'number', unit: '', default: 300, min: 0.01, description: 'Case-to-ambient thermal resistance (°C/W)' },
      { name: 'cth', kind: 'number', unit: '', default: 0.004, min: 1e-12, description: 'Junction thermal capacitance (J/°C)' },
      { name: 'tjmax', kind: 'number', unit: '', default: 150, description: 'Maximum junction temperature', deviceParameter: true },
    ],
    accuracy: Accuracy.REALISTIC,
    model: {
      family: 'Ebers–Moll / transport formulation (Gummel–Poon subset)',
      version: '1.0.0',
      claims: [
        {
          phenomenon: 'static characteristics',
          level: Accuracy.REALISTIC,
          detail:
            'Transport model: Ict = IS·(exp(Vbe/(NF·Vt)) − exp(Vbc/(NR·Vt)))·(1 − Vbc/VAF − Vbe/VAR), with base and collector charge storage. This is the model used by SPICE level 1 BJT and matches measured curves for silicon transistors in the active region.',
          validity: '|Vbe| < 1.2 V, |Vbc| < Vceo',
        },
        { phenomenon: 'Early effect', level: Accuracy.REALISTIC, detail: 'Forward and reverse Early voltages both included (VAF, VAR).' },
        { phenomenon: 'current-gain roll-off', level: Accuracy.REALISTIC, detail: 'bF(i) = BF/(1 + Ict/IKF) reproduces the high-current β droop.' },
        { phenomenon: 'charge storage / capacitances', level: Accuracy.REALISTIC, detail: 'CJE/CJC with bias dependence plus the diffusion capacitance from TF; gives realistic switching times.' },
        {
          phenomenon: 'temperature',
          level: Accuracy.REALISTIC,
          detail: 'Is(T) with XTI/EG, β(T) with XTB — reproduces the −2 mV/°C Vbe drift and the β increase with temperature.',
        },
        { phenomenon: 'self-heating', level: Accuracy.APPROXIMATED, detail: 'Single-node thermal network per device with junction/case/ambient chain.' },
        { phenomenon: 'Gummel–Poon base-width modulation (XTB/XTI/IKR)',
          level: Accuracy.APPROXIMATED,
          detail: 'Quasi-saturation, IKR, the parasitic substrate transistor and the base-charge partitioning parameters (XTB, XTF, ITF, PTF) are simplified or absent.' },
        { phenomenon: 'noise (shot, flicker)', level: Accuracy.NOT_MODELED, detail: 'Device noise sources are not generated; only resistor thermal noise appears in noise analysis.' },
      ],
      equations: [
        'Ict = IS·(exp(Vbe/(NF·Vt)) − exp(Vbc/(NR·Vt)))·(1 − Vbc/VAF − Vbe/VAR)',
        'Ib = Ict/BF + ISE·(exp(Vbe/(NE·Vt)) − 1)',
        'bF(i) = BF/(1 + Ict/IKF)',
        'IS(T) = IS·(T/Tnom)^XTI·exp(−EG·(T−Tnom)/(Vt·T·Tnom))',
        'Cje(V) = CJE·(1−Vbe/VJE)^(−MJE)',
      ],
      parameters: [
        { name: 'is', unit: 'A', meaning: 'transport saturation current' },
        { name: 'bf', unit: '', meaning: 'forward current gain' },
        { name: 'vaf', unit: 'V', meaning: 'forward Early voltage' },
        { name: 'tf', unit: 's', meaning: 'forward transit time' },
      ],
      limitations: [
        'No quasi-saturation, no substrate PNP, no avalanche breakdown of the collector junction.',
        'No noise sources inside the device.',
        'Charge partitioning parameters are simplified (no XTF/PTF).',
      ],
      references: ['Gummel & Poon (1970)', 'SPICE2 BJT model', 'Antognetti & Massobrio'],
      levels: [1, 2, 3],
    },
    support: { logic: true, electrical: true, thermal: true, lowersTo: ['BJT'] },
    symbol: [
      { k: 'line', x1: -2, y1: 0, x2: -0.6, y2: 0 },
      { k: 'line', x1: -0.6, y1: -1.4, x2: -0.6, y2: 1.4, t: 0.22 },
      { k: 'line', x1: -0.55, y1: -0.6, x2: 1.1, y2: -2, t: 0.18 },
      { k: 'line', x1: -0.55, y1: 0.6, x2: 1.1, y2: 2, t: 0.18 },
      { k: 'line', x1: 1.1, y1: -2, x2: 2, y2: -2 },
      { k: 'line', x1: 1.1, y1: 2, x2: 2, y2: 2 },
      { k: 'filled', pts: [1.1, -2, 0.35, -1.05, 0.75, -0.75] },
    ],
    keywords: ['bjt', 'transistor', 'npn', 'pnp', 'bc547', '2n2222'],
  },
];

// ---------------------------------------------------------------------------
// MOSFETs
// ---------------------------------------------------------------------------

/**
 * Shared parameter list for the MOS devices. W and L live in the *component*
 * parameters (not the model card) because they are per-instance geometry.
 */
function mosParams(polarity: 'n' | 'p'): ComponentSpec['params'] {
  const vthDef = polarity === 'n' ? 0.7 : -0.7;
  return [
    { name: 'w', kind: 'number', unit: 'meter', default: 10e-6, min: 1e-9, description: 'Channel width', sensitive: true },
    { name: 'l', kind: 'number', unit: 'meter', default: 1e-6, min: 1e-9, description: 'Channel length', sensitive: true },
    { name: 'nseries', kind: 'number', unit: '', default: 1, min: 1, max: 64, description: 'Number of series fingers (m for paralleled devices)', sensitive: true },
    { name: 'vto', kind: 'number', unit: 'volt', default: vthDef, description: 'Zero-bias threshold voltage', deviceParameter: true },
    { name: 'kp', kind: 'number', unit: '', default: polarity === 'n' ? 120e-6 : 40e-6, min: 1e-12, description: 'Transconductance parameter µ·Cox (A/V²)', deviceParameter: true },
    { name: 'lambda', kind: 'number', unit: '', default: 0.02, min: 0, description: 'Channel-length modulation (1/V)', deviceParameter: true },
    { name: 'gamma', kind: 'number', unit: '', default: 0.4, min: 0, description: 'Body-effect coefficient √V', deviceParameter: true },
    { name: 'phi', kind: 'number', unit: 'volt', default: 0.7, min: 0.1, description: 'Surface inversion potential', deviceParameter: true },
    { name: 'tox', kind: 'number', unit: 'meter', default: 4.1e-9, min: 1e-10, description: 'Oxide thickness (used for the gate capacitance)', deviceParameter: true },
    { name: 'cgso', kind: 'number', unit: 'farad', default: 1e-10, min: 0, description: 'Gate-source overlap capacitance per metre', deviceParameter: true },
    { name: 'cgdo', kind: 'number', unit: 'farad', default: 1e-10, min: 0, description: 'Gate-drain overlap capacitance per metre', deviceParameter: true },
    { name: 'rd', kind: 'number', unit: 'ohm', default: 10, min: 0, description: 'Drain resistance', deviceParameter: true },
    { name: 'rs', kind: 'number', unit: 'ohm', default: 10, min: 0, description: 'Source resistance', deviceParameter: true },
    { name: 'rb', kind: 'number', unit: 'ohm', default: 0, min: 0, description: 'Bulk resistance', deviceParameter: true },
    { name: 'cbd', kind: 'number', unit: 'farad', default: 5e-15, min: 0, description: 'Bulk-drain zero-bias capacitance', deviceParameter: true },
    { name: 'cbs', kind: 'number', unit: 'farad', default: 5e-15, min: 0, description: 'Bulk-source zero-bias capacitance', deviceParameter: true },
    { name: 'pb', kind: 'number', unit: 'volt', default: 0.8, description: 'Bulk junction potential', deviceParameter: true },
    { name: 'mj', kind: 'number', unit: '', default: 0.5, description: 'Bulk junction grading coefficient', deviceParameter: true },
    { name: 'isub', kind: 'number', unit: 'amp', default: 1e-14, min: 0, description: 'Bulk junction saturation current', deviceParameter: true },
    { name: 'subth', kind: 'boolean', default: true, description: 'Enable subthreshold conduction modelling', deviceParameter: true },
    { name: 'nsub', kind: 'number', unit: '', default: 1.5, min: 1, max: 4, description: 'Subthreshold slope factor (1 = ideal 60 mV/decade)', deviceParameter: true },
    { name: 'tnom', kind: 'number', unit: '', default: 27, description: 'Nominal temperature for the parameters (°C)', deviceParameter: true },
    { name: 'tcv', kind: 'number', unit: '', default: -2e-3, description: 'Threshold-voltage temperature coefficient (V/°C)', deviceParameter: true },
    { name: 'bex', kind: 'number', unit: '', default: -1.5, description: 'Mobility temperature exponent (µ ∝ T^BEX)', deviceParameter: true },
    { name: 'vdsmax', kind: 'number', unit: 'volt', default: 20, min: 0, description: 'Maximum Vds rating (overstress flag)', deviceParameter: true },
    { name: 'idmax', kind: 'number', unit: 'amp', default: 0.1, min: 0, description: 'Maximum drain current rating', deviceParameter: true },
    { name: 'pdmax', kind: 'number', unit: 'watt', default: 0.35, min: 0, description: 'Maximum power dissipation at 25 °C', deviceParameter: true },
    { name: 'rth_jc', kind: 'number', unit: '', default: 60, min: 0.001, description: 'Junction-to-case thermal resistance (°C/W)' },
    { name: 'rth_ca', kind: 'number', unit: '', default: 200, min: 0.01, description: 'Case-to-ambient thermal resistance (°C/W)' },
    { name: 'cth', kind: 'number', unit: '', default: 1e-5, min: 1e-14, description: 'Junction thermal capacitance (J/°C)' },
    { name: 'tjmax', kind: 'number', unit: '', default: 150, description: 'Maximum junction temperature', deviceParameter: true },
  ];
}

function mosCard(polarity: 'n' | 'p'): {
  family: string;
  version: string;
  claims: ComponentSpec['model']['claims'];
  equations: string[];
  parameters: ComponentSpec['model']['parameters'];
  limitations: string[];
  references: string[];
  levels: number[];
} {
  const sign = polarity === 'n' ? 'n-channel' : 'p-channel';
  return {
    family: `MOSFET ${sign}: Shichman–Hodges square law with an EKV-style subthreshold interpolation and Meyer capacitances`,
    version: '1.0.0',
    claims: [
      {
        phenomenon: 'static I-V (strong inversion)',
        level: Accuracy.REALISTIC,
        detail:
          'Exact Shichman–Hodges square law in saturation — Id = ½·KP·(W/L)·Vov²·(1 + λ·Vds) — with channel-length modulation and the body effect (γ, √Φ). It reproduces measured MOSFET curves to within roughly 10–20 % once KP/VTO are set for the device; without extraction the error is dominated by the parameters, not the equations.',
        validity: '|Vds| and |Vgs| within the rated range; L > 0.25 µm',
      },
      {
        phenomenon: 'subthreshold conduction',
        level: Accuracy.APPROXIMATED,
        detail:
          'Exponential subthreshold current with the exact slope 1/(NSUB·Vt) — NSUB = 1.5 gives ≈90 mV/decade — blended into the square law with the EKV interpolation function ln²(1+e^x). The inter- polation is normalised so that strong inversion is exactly the classical square law above; a consequence, stated because it is a real deviation, is that the subthreshold *magnitude* is NSUB times the EKV specific current 2·NSUB·β·Vt². The transition region (±2·NSUB·Vt around threshold) is a blend, not a surface-potential solution: the moderate-inversion current can be off by tens of percent there. Not a BSIM-class model.',
      },
      {
        phenomenon: 'channel-length modulation',
        level: Accuracy.REALISTIC,
        detail: 'Classical (1 + λ·|Vds|) factor. Reverse conduction (Vds < 0) swaps drain and source internally, so the model is exactly antisymmetric in Vds.',
      },
      {
        phenomenon: 'capacitances',
        level: Accuracy.APPROXIMATED,
        detail:
          'Meyer capacitance model: gate oxide capacitance partitioned between gate-source and gate-drain according to the operating region, plus overlap and junction capacitances. Accurate for timing to within ~20 %; charge-conservation errors of the Meyer model are known.',
      },
      {
        phenomenon: 'temperature',
        level: Accuracy.REALISTIC,
        detail: 'Vth(T) linear with TCV and mobility µ(T) ∝ T^BEX, giving the correct ~−2 mV/°C threshold drift and mobility degradation at high temperature.',
      },
      {
        phenomenon: 'self-heating',
        level: Accuracy.APPROXIMATED,
        detail: 'Junction/case/ambient single-node chain per transistor; the resulting Rds(on) increase and Vth shift are physical consequences of the model.',
      },
      {
        phenomenon: 'short-channel effects',
        level: Accuracy.NOT_MODELED,
        detail: 'No DIBL, no velocity saturation, no gate-induced drain leakage, no poly depletion. For sub-0.25 µm devices this model is not appropriate — the architecture allows adding a level-2/BSIM model later.',
      },
      {
        phenomenon: 'gate leakage, breakdown, avalanche',
        level: Accuracy.NOT_MODELED,
        detail: 'No gate tunnelling current, no drain-source breakdown, no hot-carrier effects.',
      },
    ],
    equations: [
      'Vth = VTO + γ·(√(Φ−Vsb) − √Φ) + TCV·(T − Tnom)',
      'β = KP·(W/L)·M·(T/Tnom)^BEX',
      'subth enabled: Id = Is·[G(xF) − G(xR)]·(1+λVds), G(x) = ln²(1+e^x), x = Vov/(2·NSUB·Vt), Is = 2·NSUB²·Vt²·β',
      'saturation: Id = ½·β·Vov²·(1+λVds)  (exact limit of the expression above)',
      'linear    : Id = β·(Vov·Vds − Vds²/2)·(1+λVds)  (same limit)',
      'subth disabled: the two lines above, with a derivative discontinuity at Vov = 0 (SPICE level 1 behaviour)',
      'Cgs/Cgd from the Meyer partition of (2/3)·W·L·Cox + overlap',
    ],
    parameters: [
      { name: 'vto', unit: 'V', meaning: 'threshold voltage' },
      { name: 'kp', unit: 'A/V²', meaning: 'transconductance parameter µCox' },
      { name: 'lambda', unit: '1/V', meaning: 'channel-length modulation' },
      { name: 'w/l', unit: 'm', meaning: 'device geometry' },
    ],
    limitations: [
      'No short-channel effects: unsuitable below ~0.25 µm channel length.',
      'Subthreshold magnitude is NSUB× the EKV specific current (the interpolation is normalised to the square law instead).',
      'Moderate inversion (|Vov| < 2·NSUB·Vt) is interpolated: tens of percent of error is possible there.',
      'Meyer capacitance model (charge conservation is approximate).',
      'No gate leakage, no breakdown, no avalanche, no velocity saturation.',
      'Parameter extraction from datasheets is not provided: KP/VTO must be set by the user.',
    ],
    references: ['Shichman & Hodges (1968)', 'SPICE2 level 1', 'Meyer capacitance model (1971)'],
    levels: [1, 2, 3],
  };
}

function mosSymbol(polarity: 'n' | 'p'): ComponentSpec['symbol'] {
  const arrow = polarity === 'n' ? 1 : -1;
  return [
    // gate plate
    { k: 'line', x1: -1.6, y1: -1.2, x2: -1.6, y2: 1.2, t: 0.2 },
    { k: 'line', x1: -2, y1: 0, x2: -1.6, y2: 0 },
    // channel
    { k: 'line', x1: -1.25, y1: -1.2, x2: -1.25, y2: -0.5, t: 0.2 },
    { k: 'line', x1: -1.25, y1: -0.4, x2: -1.25, y2: 0.4, t: 0.2 },
    { k: 'line', x1: -1.25, y1: 0.5, x2: -1.25, y2: 1.2, t: 0.2 },
    // drain / source
    { k: 'line', x1: -1.25, y1: -1.2, x2: 1.2, y2: -1.2 },
    { k: 'line', x1: 1.2, y1: -1.2, x2: 1.2, y2: -2 },
    { k: 'line', x1: -1.25, y1: 1.2, x2: 1.2, y2: 1.2 },
    { k: 'line', x1: 1.2, y1: 1.2, x2: 1.2, y2: 2 },
    // bulk arrow (points inwards for N, outwards for P)
    { k: 'line', x1: -1.25, y1: 0, x2: -0.1, y2: 0, t: 0.16 },
    { k: 'filled', pts: arrow > 0 ? [-0.1, 0, -0.7, arrow * 0.35, -0.7, arrow * -0.35] : [-1.25, 0, -0.65, 0.35 * -arrow, -0.65, -0.35 * -arrow] },
    { k: 'line', x1: -0.1, y1: 0, x2: -0.1, y2: 2 },
  ];
}

export const MOS_SPECS: ComponentSpec[] = [
  {
    id: 'nmos',
    name: 'NMOS',
    category: 'semiconductor',
    description: 'N-channel enhancement MOSFET with body effect, subthreshold conduction and thermal coupling.',
    refPrefix: 'M',
    spicePrefix: 'M',
    footprint: 'SOT-23',
    examplePart: '2N7002',
    pins: [
      { name: 'D', direction: 'passive', electrical: 'analog', x: 1.2, y: -2, description: 'Drain' },
      { name: 'G', direction: 'passive', electrical: 'analog', x: -2, y: 0, description: 'Gate' },
      { name: 'S', direction: 'passive', electrical: 'analog', x: 1.2, y: 2, description: 'Source' },
      { name: 'B', direction: 'passive', electrical: 'analog', x: -0.1, y: 2, optional: true, description: 'Bulk/substrate (optional; if unconnected, it is tied to the source)' },
    ],
    params: [
      { name: 'model', kind: 'choice', default: 'square_law', choices: ['square_law', 'small_signal'], description: 'Parameter preset: power device vs. small-signal device', sensitive: true },
      ...mosParams('n'),
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: mosCard('n') as unknown as ComponentSpec['model'],
    support: { logic: true, electrical: true, thermal: true, lowersTo: ['MOSFET'] },
    symbol: mosSymbol('n'),
    keywords: ['nmos', 'nfet', 'mosfet', 'transistor', '2n7002'],
  },
  {
    id: 'pmos',
    name: 'PMOS',
    category: 'semiconductor',
    description: 'P-channel enhancement MOSFET with body effect, subthreshold conduction and thermal coupling.',
    refPrefix: 'M',
    spicePrefix: 'M',
    footprint: 'SOT-23',
    examplePart: 'BSS84',
    pins: [
      { name: 'D', direction: 'passive', electrical: 'analog', x: 1.2, y: -2, description: 'Drain' },
      { name: 'G', direction: 'passive', electrical: 'analog', x: -2, y: 0, description: 'Gate' },
      { name: 'S', direction: 'passive', electrical: 'analog', x: 1.2, y: 2, description: 'Source' },
      { name: 'B', direction: 'passive', electrical: 'analog', x: -0.1, y: 2, optional: true, description: 'Bulk/substrate (optional; if unconnected, it is tied to the source)' },
    ],
    params: [
      { name: 'model', kind: 'choice', default: 'square_law', choices: ['square_law', 'small_signal'], description: 'Parameter preset', sensitive: true },
      ...mosParams('p'),
    ],
    accuracy: Accuracy.APPROXIMATED,
    model: mosCard('p') as unknown as ComponentSpec['model'],
    support: { logic: true, electrical: true, thermal: true, lowersTo: ['MOSFET'] },
    symbol: mosSymbol('p'),
    keywords: ['pmos', 'pfet', 'mosfet', 'transistor', 'bss84'],
  },
];

export const SEMI_SPECS: ComponentSpec[] = [...DIODE_SPECS, ...BJT_SPECS, ...MOS_SPECS];
