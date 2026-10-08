/**
 * Component library.
 *
 * A `ComponentSpec` is the *type* of a component: its pins, its parameters, its
 * model card, its symbol. An `Instance` (see `circuit.ts`) is one usage of that
 * type with concrete parameter values and a position on the sheet.
 *
 * The library is the extension point: adding a new component type requires only
 * a new spec (plus, if it is a physics device, an element implementation in
 * `sim/elements`). Nothing in the simulator core is modified to add components —
 * that is the "extensible component system" requirement.
 */

import { Accuracy, ModelCard, weakerAccuracy } from './labels.js';

export type ComponentCategory =
  | 'passive'
  | 'semiconductor'
  | 'switching'
  | 'source'
  | 'digital'
  | 'instrument'
  | 'power'
  | 'chip'
  | 'other';

export type PinDirection = 'input' | 'output' | 'bidirectional' | 'passive' | 'power';

export type PinElectrical = 'analog' | 'digital' | 'supply' | 'ground' | 'any';

export interface PinSpec {
  /** Stable pin name within the component, e.g. 'A', 'K', 'G', 'D', 'S'. */
  name: string;
  direction: PinDirection;
  electrical: PinElectrical;
  /** Logical bus width (1 for scalar pins). */
  width?: number;
  /** Symbol-space position (unit = symbol grid, x right, y down). */
  x: number;
  y: number;
  /** Description shown in the inspector. */
  description?: string;
  /** True if the pin may be left unconnected without warning. */
  optional?: boolean;
}

export type ParamKind = 'number' | 'string' | 'boolean' | 'choice';

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  /** Engineering unit key (see util/units.ts) or a free-form label. */
  unit?: string;
  /** Default in *base units* (ohms, farads, volts, seconds, °C…). */
  default: number | string | boolean;
  min?: number;
  max?: number;
  /** Increment used by spinner widgets. */
  step?: number;
  choices?: string[];
  description: string;
  /** True when changing this parameter changes the model's results materially. */
  sensitive?: boolean;
  /** True when the parameter is a device fabrication parameter (not a value). */
  deviceParameter?: boolean;
}

/**
 * Compact symbol description, rendered by the UI (and the SVG exporter) without
 * any component-specific code. Coordinates are in symbol units, origin at the
 * component anchor, y down.
 */
export type SymbolShape =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; t?: number; dash?: boolean }
  | { k: 'poly'; pts: number[]; fill?: boolean; t?: number }
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean; t?: number; r?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill?: boolean; t?: number }
  | { k: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; t?: number }
  | { k: 'text'; x: number; y: number; s: string; size?: number; anchor?: 'l' | 'c' | 'r'; weight?: number }
  | { k: 'filled'; pts: number[] };

/** How a component behaves in each simulation level. */
export interface SimulationSupport {
  /** Level 0 (4-state logic) — behavioural digital model available. */
  logic: boolean;
  /** Level 1/2 (MNA) — electrical element available. */
  electrical: boolean;
  /** Level 3 — contributes to the thermal network. */
  thermal: boolean;
  /**
   * Electrical implementation may be *expanded* into devices instead of being
   * simulated as a single element (e.g. a CMOS gate expands to transistors).
   */
  expandable?: boolean;
  /** Element kinds this spec lowers to during flattening. */
  lowersTo?: string[];
}

/**
 * Merge an instance's parameters with the declared defaults of a parameter list.
 *
 * A parameter that the component declares but the instance did not set takes its
 * declared default, whatever else the instance's parameter bag carries (a chip
 * instance carries the whole bag, including parameters of other chips).
 */
export function resolveParams(declared: readonly ParamSpec[], instParams: ParamBag): ParamBag {
  const out: ParamBag = {};
  for (const p of declared) {
    const v = instParams[p.name];
    out[p.name] = v === undefined ? p.default : v;
  }
  return out;
}

export interface ComponentSpec {
  /** Unique, stable id, e.g. 'resistor'. Never changed once released. */
  id: string;
  /** Display name, e.g. 'Resistor'. */
  name: string;
  category: ComponentCategory;
  /** One-line description for the palette tooltip. */
  description: string;
  pins: PinSpec[];
  params: ParamSpec[];
  /** Overall accuracy for the *default* parameter set. */
  accuracy: Accuracy;
  model: ModelCard;
  support: SimulationSupport;
  symbol: SymbolShape[];
  /** Reference designator prefix, e.g. 'R'. */
  refPrefix: string;
  /** Default footprint/case for the BOM (optional). */
  footprint?: string;
  /** Manufacturer part number template / example (optional). */
  examplePart?: string;
  /** Spice-like primitive keyword, used by the SPICE netlist exporter. */
  spicePrefix?: string;
  /** Pin count including power pins; computed if omitted. */
  keywords?: string[];
}

export interface LibraryOptions {
  includeBuiltins?: boolean;
}

/**
 * Registry of component specs. Immutable from the outside: specs are registered
 * once (or replaced explicitly by a plugin), and lookups are by id.
 */
export class Library {
  private specs = new Map<string, ComponentSpec>();
  /** Chips are registered here too, under category 'chip'. */
  private aliases = new Map<string, string>();

  constructor(specs: Iterable<ComponentSpec> = []) {
    for (const s of specs) this.register(s);
  }

  register(spec: ComponentSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`component spec "${spec.id}" is already registered`);
    }
    this.specs.set(spec.id, spec);
  }

  /** Replace an existing spec (plugin override) or add a new one. */
  override(spec: ComponentSpec): void {
    this.specs.set(spec.id, spec);
  }

  addAlias(alias: string, id: string): void {
    this.aliases.set(alias, id);
  }

  get(id: string): ComponentSpec | undefined {
    return this.specs.get(id) ?? this.specs.get(this.aliases.get(id) ?? '');
  }

  /** Get or throw — use when the id is known to exist (code paths, not user input). */
  must(id: string): ComponentSpec {
    const s = this.get(id);
    if (!s) throw new Error(`unknown component spec "${id}"`);
    return s;
  }

  has(id: string): boolean {
    return this.specs.has(id) || this.aliases.has(id);
  }

  all(): ComponentSpec[] {
    return [...this.specs.values()];
  }

  byCategory(cat: ComponentCategory): ComponentSpec[] {
    return this.all().filter((s) => s.category === cat);
  }

  /** Category order used by the palette. */
  static readonly CATEGORY_ORDER: ComponentCategory[] = [
    'passive',
    'semiconductor',
    'switching',
    'source',
    'digital',
    'instrument',
    'power',
    'chip',
    'other',
  ];

  clone(): Library {
    const l = new Library();
    for (const [k, v] of this.specs) l.specs.set(k, v);
    for (const [k, v] of this.aliases) l.aliases.set(k, v);
    return l;
  }

  size(): number {
    return this.specs.size;
  }
}

// ---------------------------------------------------------------------------
// Parameter typing helpers
// ---------------------------------------------------------------------------

export type ParamValue = number | string | boolean;
export type ParamBag = Record<string, ParamValue>;

/** Read a numeric parameter with a fallback to the spec default. */
export function num(p: ParamBag, spec: ComponentSpec, name: string, fallback = NaN): number {
  const v = p[name];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  const def = spec.params.find((s) => s.name === name);
  if (def && typeof def.default === 'number') return def.default;
  return fallback;
}

export function bool(p: ParamBag, spec: ComponentSpec, name: string, fallback = false): boolean {
  const v = p[name];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  const def = spec.params.find((s) => s.name === name);
  if (def) return Boolean(def.default);
  return fallback;
}

export function str(p: ParamBag, spec: ComponentSpec, name: string, fallback = ''): string {
  const v = p[name];
  if (typeof v === 'string') return v;
  if (v !== undefined && v !== null) return String(v);
  const def = spec.params.find((s) => s.name === name);
  if (def) return String(def.default);
  return fallback;
}

/** Build the default parameter bag for a spec. */
export function defaultParams(spec: ComponentSpec, overrides: ParamBag = {}): ParamBag {
  const out: ParamBag = {};
  for (const p of spec.params) out[p.name] = p.default;
  return { ...out, ...overrides };
}

/** Validate a parameter bag; returns diagnostics (empty = valid). */
export function validateParams(
  spec: ComponentSpec,
  params: ParamBag,
): Array<{ param: string; message: string }> {
  const issues: Array<{ param: string; message: string }> = [];
  for (const p of spec.params) {
    const v = params[p.name];
    if (v === undefined) continue;
    if (p.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ param: p.name, message: `expected a number, got ${JSON.stringify(v)}` });
        continue;
      }
      if (p.min !== undefined && v < p.min) issues.push({ param: p.name, message: `below minimum ${p.min}` });
      if (p.max !== undefined && v > p.max) issues.push({ param: p.name, message: `above maximum ${p.max}` });
    } else if (p.kind === 'boolean') {
      if (typeof v !== 'boolean') issues.push({ param: p.name, message: `expected a boolean` });
    } else if (p.kind === 'choice') {
      if (typeof v !== 'string' || (p.choices && !p.choices.includes(v))) {
        issues.push({ param: p.name, message: `expected one of ${p.choices?.join(', ')}` });
      }
    }
  }
  return issues;
}

/** Symbol helper: build a 2-pin pass-through symbol (used by many components). */
export function twoPinSymbol(pinGap: number, extra: SymbolShape[] = []): SymbolShape[] {
  return extra;
}

/** Aggregate accuracy across several model cards. */
export function weakestCardAccuracy(cards: readonly ModelCard[]): Accuracy {
  let acc = Accuracy.REALISTIC;
  for (const c of cards) {
    for (const claim of c.claims) acc = weakerAccuracy(acc, claim.level);
  }
  return acc;
}
