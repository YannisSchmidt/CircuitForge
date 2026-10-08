/**
 * Engineering unit handling.
 *
 * Used by the UI (parameter fields), the CLI (argument parsing) and the exporters
 * (BOM rendering). Parsing is strict: a value that cannot be represented exactly
 * is rejected rather than silently rounded, because silently rounding a parameter
 * is a correctness bug in an engineering tool.
 */

export const SI_PREFIXES: Record<string, number> = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1,
  d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18,
};

const PREFIX_ORDER: Array<[number, string]> = [
  [1e24, 'Y'], [1e21, 'Z'], [1e18, 'E'], [1e15, 'P'], [1e12, 'T'], [1e9, 'G'], [1e6, 'M'],
  [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'], [1e-18, 'a'],
];

export interface UnitDef {
  /** Unit symbol, e.g. 'Ω'. */
  symbol: string;
  /** Accepted spellings, e.g. ['ohm', 'Ω', 'R']. */
  aliases: string[];
  /** Default prefix used when formatting. */
  formatPrefix?: number;
}

export const UNITS = {
  volt: { symbol: 'V', aliases: ['V', 'v', 'volt', 'volts'] },
  amp: { symbol: 'A', aliases: ['A', 'a', 'amp', 'amps', 'ampere'] },
  ohm: { symbol: 'Ω', aliases: ['Ω', 'ohm', 'Ohm', 'ohms', 'R', 'r'] },
  farad: { symbol: 'F', aliases: ['F', 'f', 'farad', 'farads'] },
  henry: { symbol: 'H', aliases: ['H', 'h', 'henry', 'henrys'] },
  watt: { symbol: 'W', aliases: ['W', 'w', 'watt', 'watts'] },
  second: { symbol: 's', aliases: ['s', 'sec', 'secs', 'second', 'seconds'] },
  hertz: { symbol: 'Hz', aliases: ['Hz', 'hz', 'HZ', 'hertz'] },
  celsius: { symbol: '°C', aliases: ['°C', 'C', 'degC', 'celsius'] },
  kelvin: { symbol: 'K', aliases: ['K', 'kelvin'] },
  siemens: { symbol: 'S', aliases: ['S', 'siemens', 'mho'] },
  ratio: { symbol: '', aliases: ['', 'x', 'ratio'] },
  joule: { symbol: 'J', aliases: ['J', 'joule'] },
  ampPerVolt: { symbol: 'S', aliases: ['S'] },
  voltPerVolt: { symbol: '', aliases: ['V/V'] },
  meter: { symbol: 'm', aliases: ['m', 'meter'] },
} as const satisfies Record<string, UnitDef>;

export type UnitName = keyof typeof UNITS;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, '');
}

function matchUnit(token: string): UnitName | null {
  const t = token;
  if (!t) return null;
  for (const key of Object.keys(UNITS) as UnitName[]) {
    const def = UNITS[key];
    for (const alias of def.aliases) {
      if (alias && alias === t) return key;
    }
  }
  return null;
}

/** Result of a strict parse; `ok === false` carries a human-readable reason. */
export interface ParseResult {
  ok: boolean;
  value: number;
  /** Unit resolved by the parse (if a unit suffix was present). */
  unit?: UnitName;
  error?: string;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

/**
 * Parse an engineering value such as `10k`, `4.7kΩ`, `2.2uF`, `-1.5e-3`, `100n`.
 * A trailing unit symbol is accepted and validated against `expect` when given.
 */
export function parseValue(input: string | number, expect?: UnitName): ParseResult {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, value: NaN, error: 'value is not finite' };
    return { ok: true, value: input };
  }
  const s = normalize(input);
  if (s === '') return { ok: false, value: NaN, error: 'empty value' };
  const m = NUM_RE.exec(s);
  if (!m) return { ok: false, value: NaN, error: `cannot parse number in "${input}"` };
  let value = Number(m[0]);
  if (!Number.isFinite(value)) return { ok: false, value: NaN, error: `cannot parse number in "${input}"` };
  let rest = s.slice(m[0].length);

  // Optional SI prefix directly attached to the number.
  let prefixMul = 1;
  if (rest.length > 0 && !/^[eE]/.test(rest)) {
    const two = rest.slice(0, 2);
    if (two === 'da' && SI_PREFIXES.da) {
      prefixMul = SI_PREFIXES.da;
      rest = rest.slice(2);
    } else {
      const one = rest[0];
      if (one in SI_PREFIXES && !/^\d/.test(one)) {
        prefixMul = SI_PREFIXES[one];
        rest = rest.slice(1);
      }
    }
  }

  // Remaining token may be a unit, possibly with a 'Ω' or 'Ω' style symbol.
  let unit: UnitName | undefined;
  if (rest.length > 0) {
    const asUnit = matchUnit(rest);
    if (!asUnit) {
      // Accept trailing punctuation commonly found in pasted values.
      const cleaned = rest.replace(/[;,]$/, '');
      const u2 = matchUnit(cleaned);
      if (!u2) return { ok: false, value: NaN, error: `unknown unit "${rest}"` };
      unit = u2;
    } else {
      unit = asUnit;
    }
  }
  if (expect && unit && unit !== expect) {
    // Allow compatible spellings (volt/voltPerVolt are not compatible).
    return { ok: false, value: NaN, error: `expected ${UNITS[expect].symbol || expect}, got ${UNITS[unit].symbol || unit}` };
  }
  value *= prefixMul;
  return { ok: true, value, unit };
}

/** Parse or throw. Used by the CLI where a bad argument must abort loudly. */
export function parseValueOrThrow(input: string | number, expect?: UnitName): number {
  const r = parseValue(input, expect);
  if (!r.ok) throw new Error(`invalid value "${input}": ${r.error}`);
  return r.value;
}

/** Format a number with an SI prefix and unit symbol, e.g. `4.7 kΩ`. */
export function formatValue(value: number, unit?: UnitName, opts: { digits?: number; space?: boolean } = {}): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '-∞' : 'NaN';
  const digits = opts.digits ?? 4;
  const space = opts.space ?? false;
  const symbol = unit ? UNITS[unit].symbol : '';
  const abs = Math.abs(value);
  if (value === 0) return (symbol ? `0${space ? ' ' : ''}${symbol}` : '0');
  if (unit === 'celsius') return `${round(value, digits)} °C`;
  // Choose the prefix that puts the mantissa in [1, 1000).
  let chosen = 1;
  let chosenPrefix = '';
  for (const [mul, pfx] of PREFIX_ORDER) {
    if (abs >= mul * 0.999999) {
      chosen = mul;
      chosenPrefix = pfx;
      break;
    }
  }
  if (abs < 1e-18) {
    return `${value.toExponential(3)}${symbol ? ' ' + symbol : ''}`;
  }
  const mant = value / chosen;
  const text = round(mant, digits);
  const sep = space && symbol ? ' ' : '';
  return `${text}${chosenPrefix}${sep}${symbol}`;
}

function round(v: number, digits: number): string {
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 100) s = v.toFixed(Math.max(0, digits - 3));
  else if (abs >= 10) s = v.toFixed(Math.max(0, digits - 2));
  else s = v.toFixed(Math.max(1, digits - 1));
  // strip trailing zeros
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Format a frequency for display (Hz/kHz/MHz). */
export function formatFrequency(hz: number): string {
  return formatValue(hz, 'hertz', { digits: 5, space: true });
}

/** Format a duration (s/ms/µs/ns/ps). */
export function formatTime(s: number): string {
  return formatValue(s, 'second', { digits: 5, space: true });
}

/**
 * Temperature conversions. The engine uses **kelvin** internally for device
 * equations (thermal voltage) and **celsius** for all user-facing values; these
 * helpers are the only place where the conversion happens.
 */
export const toKelvin = (celsius: number): number => celsius + 273.15;
export const toCelsius = (kelvin: number): number => kelvin - 273.15;

/** Physical constants used across the engine (CODATA 2018). */
export const CONST = {
  /** Boltzmann constant, J/K. */
  k: 1.380649e-23,
  /** Elementary charge, C. */
  q: 1.602176634e-19,
  /** Reference temperature for SPICE device cards, °C. */
  tnom: 27,
  /** Silicon bandgap at 0 K, eV. */
  egSi: 1.11,
  /** Zero Celsius in kelvin. */
  zeroC: 273.15,
  /** Permittivity of free space, F/m. */
  eps0: 8.8541878128e-12,
  /** Relative permittivity of silicon. */
  epsSi: 11.7,
  /** Relative permittivity of silicon dioxide. */
  epsSiO2: 3.9,
  /** Intrinsic carrier concentration of Si at 300 K, cm^-3. */
  ni300: 1.0e10,
} as const;

/** Thermal voltage kT/q in volts at a given temperature in celsius. */
export function thermalVoltage(celsius: number): number {
  return (CONST.k * toKelvin(celsius)) / CONST.q;
}
