/**
 * Registry assembly.
 *
 * Builds the default `Library` from the built-in spec modules, and provides:
 *   - chip → ComponentSpec generation (hierarchical blocks look like any other
 *     component to the editor, the netlister and the exporters);
 *   - variant presets (diode/LED/MOS "variant" and "model" choices) that fill in
 *     physically consistent parameter sets.
 */

import type { ComponentSpec, Library, ParamBag, PinSpec, SymbolShape } from './library.js';
import { Library as LibraryClass, defaultParams } from './library.js';
import { BASE_SPECS } from './primitives.js';
import { DIGITAL_SPECS } from './primitives-digital.js';
import { SEMI_SPECS } from './primitives-semi.js';
import type { ChipPort } from './chip.js';

/** All built-in specs, in palette order. */
export function builtinSpecs(): ComponentSpec[] {
  return [...BASE_SPECS, ...SEMI_SPECS, ...DIGITAL_SPECS];
}

/** Create the default library. */
export function createDefaultLibrary(): LibraryClass {
  return new LibraryClass(builtinSpecs());
}

/**
 * Build a `ComponentSpec` describing a chip instance, with pins laid out on the
 * left (inputs) and right (outputs) edges of a rectangle sized from the pin count.
 */
export function chipSpec(
  chipId: string,
  name: string,
  description: string,
  ports: readonly ChipPort[],
  params: ComponentSpec['params'] = [],
  options: { width?: number; keywords?: string[] } = {},
): ComponentSpec {
  const inputs = ports.filter((p) => p.direction !== 'output');
  const outputs = ports.filter((p) => p.direction === 'output');
  const rows = Math.max(inputs.length, outputs.length, 2);
  const halfHeight = Math.max(2, rows * 0.9) + 0.4;
  const width = options.width ?? Math.max(5, 3 + 0.55 * Math.max(name.length, 8));

  const pins: PinSpec[] = [];
  const place = (p: ChipPort, list: readonly ChipPort[], side: 'l' | 'r') => {
    const idx = list.indexOf(p);
    const n = list.length;
    const span = 2 * halfHeight - 1.6;
    const y = n === 1 ? 0 : -span / 2 + (idx * span) / (n - 1);
    pins.push({
      name: p.name,
      direction: p.direction,
      electrical: p.electrical ?? 'digital',
      x: side === 'l' ? -width / 2 - 1 : width / 2 + 1,
      y,
      width: p.width,
      description: p.description,
    });
  };
  for (const p of inputs) place(p, inputs, 'l');
  for (const p of outputs) place(p, outputs, 'r');

  const symbol: SymbolShape[] = [
    { k: 'rect', x: -width / 2, y: -halfHeight, w: width, h: 2 * halfHeight, t: 0.18, r: 0.22 },
    { k: 'text', x: 0, y: 0, s: name.slice(0, 22), size: 0.95, anchor: 'c' },
  ];
  for (const p of inputs) {
    const pin = pins.find((q) => q.name === p.name)!;
    symbol.push({ k: 'line', x1: -width / 2 - 1, y1: pin.y, x2: -width / 2, y2: pin.y, t: 0.12 });
  }
  for (const p of outputs) {
    const pin = pins.find((q) => q.name === p.name)!;
    symbol.push({ k: 'line', x1: width / 2, y1: pin.y, x2: width / 2 + 1, y2: pin.y, t: 0.12 });
  }

  return {
    id: chipId,
    name,
    category: 'chip',
    description,
    refPrefix: 'U',
    spicePrefix: 'X',
    pins,
    params,
    accuracy: undefined as never, // replaced below
    model: {
      family: 'Hierarchical chip',
      version: '1.0.0',
      claims: [],
      equations: [],
      parameters: [],
      limitations: [],
      references: [],
      levels: [],
    },
    support: { logic: true, electrical: true, thermal: true, expandable: true },
    symbol,
    keywords: options.keywords ?? [name.toLowerCase()],
  } as ComponentSpec;
}

// ---------------------------------------------------------------------------
// Variant presets
// ---------------------------------------------------------------------------

interface Preset {
  params: ParamBag;
  note: string;
}

/**
 * Presets are *physically consistent* parameter sets, not magic numbers: each one
 * is either taken from a datasheet or is a documented typical value. Selecting a
 * variant in the UI applies the preset and every value remains editable.
 */
export const PRESETS: Record<string, Record<string, Preset>> = {
  diode: {
    silicon: {
      note: '1N4148-class small-signal silicon diode (datasheet-derived parameters).',
      params: { is: 2.52e-9, n: 1.752, rs: 0.568, cj0: 4e-12, vj: 0.7, m: 0.333, tt: 11.54e-9, bv: 100, ibv: 1e-3, ifmax: 0.3 },
    },
    schottky: {
      note: 'Schottky (BAT54-class): low Vf, higher reverse leakage.',
      params: { is: 2.2e-8, n: 1.05, rs: 0.4, cj0: 10e-12, vj: 0.45, m: 0.5, tt: 1e-11, bv: 30, ibv: 1e-4, ifmax: 0.2 },
    },
    zener: {
      note: 'Zener (BZX84-class): breakdown used as a reference.',
      params: { is: 1e-9, n: 1.5, rs: 1.5, cj0: 30e-12, vj: 0.75, m: 0.33, tt: 1e-9, bv: 5.1, ibv: 0.02, ifmax: 0.2 },
    },
    fast: {
      note: 'Fast-recovery rectifier (UF4007-class).',
      params: { is: 1e-8, n: 1.9, rs: 0.06, cj0: 20e-12, vj: 0.75, m: 0.35, tt: 5e-9, bv: 1000, ibv: 1e-3, ifmax: 1 },
    },
  },
  led: {
    ir: { note: 'IR emitter 850 nm, Vf ≈ 1.3 V.', params: { is: 1e-20, n: 1.6, rs: 5, vj: 1.0, lambda: 850e-9, eta: 0.4, ifnom: 0.02, bv: 5 } },
    red: { note: 'Standard red LED 625 nm, Vf ≈ 2.0 V at 20 mA.', params: { is: 1e-21, n: 1.8, rs: 8, vj: 2.0, lambda: 625e-9, eta: 0.35, ifnom: 0.02, bv: 5 } },
    orange: { note: 'Orange LED 605 nm.', params: { is: 8e-22, n: 1.8, rs: 8, vj: 2.1, lambda: 605e-9, eta: 0.3, ifnom: 0.02, bv: 5 } },
    yellow: { note: 'Yellow LED 590 nm.', params: { is: 6e-22, n: 1.8, rs: 8, vj: 2.15, lambda: 590e-9, eta: 0.28, ifnom: 0.02, bv: 5 } },
    green: { note: 'Green LED 525 nm (InGaN), Vf ≈ 3.0 V.', params: { is: 1e-22, n: 2.0, rs: 14, vj: 2.6, lambda: 525e-9, eta: 0.3, ifnom: 0.02, bv: 5 } },
    blue: { note: 'Blue LED 470 nm (InGaN), Vf ≈ 3.1 V.', params: { is: 8e-23, n: 2.0, rs: 16, vj: 2.7, lambda: 470e-9, eta: 0.4, ifnom: 0.02, bv: 5 } },
    white: { note: 'White LED (blue die + phosphor) 450 nm pump.', params: { is: 6e-23, n: 2.1, rs: 18, vj: 2.7, lambda: 450e-9, eta: 0.45, ifnom: 0.02, bv: 5 } },
    uv: { note: 'UV LED 395 nm.', params: { is: 3e-23, n: 2.3, rs: 20, vj: 3.0, lambda: 395e-9, eta: 0.25, ifnom: 0.02, bv: 5 } },
  },
  nmos: {
    square_law: {
      note: 'Generic power NMOS (2N7002-class, L = 0.18 µm equivalent).',
      params: { vto: 0.7, kp: 120e-6, lambda: 0.02, gamma: 0.4, phi: 0.7, w: 10e-6, l: 0.18e-6, tox: 4.1e-9, rd: 10, rs: 10 },
    },
    small_signal: {
      note: 'Small-signal NMOS (CD4007-class): lower KP, higher Vth.',
      params: { vto: 1.0, kp: 20e-6, lambda: 0.01, gamma: 0.5, phi: 0.7, w: 5e-6, l: 1e-6, tox: 20e-9, rd: 0, rs: 0 },
    },
  },
  pmos: {
    square_law: {
      note: 'Generic power PMOS (BSS84-class).',
      params: { vto: -0.7, kp: 40e-6, lambda: 0.02, gamma: 0.4, phi: 0.7, w: 20e-6, l: 0.18e-6, tox: 4.1e-9, rd: 10, rs: 10 },
    },
    small_signal: {
      note: 'Small-signal PMOS (CD4007-class).',
      params: { vto: -1.0, kp: 8e-6, lambda: 0.01, gamma: 0.5, phi: 0.7, w: 10e-6, l: 1e-6, tox: 20e-9, rd: 0, rs: 0 },
    },
  },
  bjt: {
    npn: {
      note: 'Generic NPN (BC847B): β ≈ 200, fT ≈ 300 MHz.',
      params: { is: 1.8e-14, bf: 200, br: 4, vaf: 100, ikf: 0.1, rb: 10, rc: 1, re: 0.5, cje: 11e-12, cjc: 4e-12, tf: 4e-10 },
    },
    pnp: {
      note: 'Generic PNP (BC857B): β ≈ 220.',
      params: { is: 2.5e-14, bf: 220, br: 4, vaf: 80, ikf: 0.06, rb: 12, rc: 1.2, re: 0.6, cje: 12e-12, cjc: 4.5e-12, tf: 5e-10 },
    },
  },
};

/** Parameters whose value is set by a preset (so the UI can show "modified"). */
export function presetFor(specId: string, variant: string): Preset | undefined {
  return PRESETS[specId]?.[variant];
}

/**
 * Apply the preset selected by the component's `variant`/`model`/`polarity`
 * parameter, preserving any parameter the user explicitly changed.
 * `touched` lists the parameter names the user has edited.
 */
export function applyPreset(spec: ComponentSpec, params: ParamBag, touched: readonly string[] = []): ParamBag {
  const out: ParamBag = { ...params };
  const key =
    (typeof out['variant'] === 'string' && out['variant']) ||
    (typeof out['model'] === 'string' && out['model']) ||
    (typeof out['polarity'] === 'string' && out['polarity']) ||
    (typeof out['colour'] === 'string' && out['colour']) ||
    '';
  if (!key) return out;
  const preset = presetFor(spec.id, key);
  if (!preset) return out;
  for (const [k, v] of Object.entries(preset.params)) {
    if (touched.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Full default parameter bag for a spec, including the variant preset. */
export function specDefaults(spec: ComponentSpec): ParamBag {
  return applyPreset(spec, defaultParams(spec));
}
