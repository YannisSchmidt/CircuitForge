/**
 * Hierarchical chips.
 *
 * A chip is a named, versioned, parameterised circuit with an interface. Any
 * circuit can be saved as a chip; a chip can be instantiated inside another
 * circuit, without a depth limit (expansion is iterative and cycle-checked).
 *
 * Chips can also be *parametric*: a generator function materialises the
 * implementation for a given parameter set (this is how an N-bit adder chip
 * produces N-bit hardware instead of being a fixed artwork). The generator is
 * deterministic — the same parameters always produce the same circuit, which is
 * required for reproducible search.
 */

import type { Circuit } from './circuit.js';
import { Circuit as CircuitClass } from './circuit.js';
import { resolveParams, type ComponentSpec, type ParamBag, type ParamSpec } from './library.js';
import { Accuracy, Diagnostic, error, warn } from './labels.js';
import { StructuralHash } from '../util/hash.js';
import { ENGINE_VERSION, MODEL_VERSIONS } from '../util/version.js';

export interface ChipPort {
  name: string;
  direction: 'input' | 'output' | 'bidirectional';
  width: number;
  electrical?: 'analog' | 'digital' | 'supply' | 'ground' | 'any';
  description?: string;
}

/**
 * One pin of a chip implementation, as seen by an instance.
 *
 * A parametric chip's interface is a *function of its parameters*: a ROM built
 * for 16 words really does have one address pin more than the 8-word default.
 * Everything that looks at a chip instance therefore resolves its pins here
 * instead of trusting the static spec (which reflects the default parameters).
 */
export interface ChipPinInfo {
  name: string;
  direction: 'input' | 'output' | 'bidirectional';
  width: number;
}

/** Measured performance of a chip — only ever filled from real simulations. */
export interface ChipMetrics {
  /** Propagation delay from the input that matters to the output (s). */
  propagationDelay?: number;
  /** Worst-case delay over all input→output paths (s). */
  criticalPathDelay?: number;
  /** Which path produced the critical delay. */
  criticalPath?: string[];
  /** Static power at the nominal supply (W). */
  staticPower?: number;
  /** Dynamic energy per switching event (J). */
  dynamicEnergy?: number;
  /** Peak instantaneous power (W). */
  peakPower?: number;
  /** Junction temperature of the hottest device at nominal conditions (°C). */
  maxTemperature?: number;
  /** Component count (physical, i.e. after vector expansion). */
  componentCount?: number;
  transistorCount?: number;
  /** Engine level that produced these numbers. */
  level?: number;
  /** Accuracy label attached to the numbers (see labels.ts). */
  accuracy?: Accuracy;
  /** Stimulus/conditions used to measure. */
  conditions?: string;
  measuredAt?: string;
}

export interface ChipDefinition {
  /** Library key, unique inside a project, e.g. 'full_adder'. */
  id: string;
  /** Display name, e.g. 'FULL_ADDER'. */
  name: string;
  version: string;
  description: string;
  ports: ChipPort[];
  params: ParamSpec[];
  /** Implementation. */
  circuit: Circuit;
  /** Optional parametric generator: params → circuit (deterministic). */
  generator?: (params: ParamBag) => Circuit;
  metrics?: ChipMetrics;
  tags?: string[];
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  /** Provenance: how this chip came to be. */
  origin?: 'user' | 'synthesis' | 'extracted' | 'library' | 'imported';
  /** For synthesised chips: the run record that produced them. */
  runId?: string;
  /** Human-readable notes shown in the inspector. */
  notes?: string;
}

export class Chip {
  readonly def: ChipDefinition;
  /** Cache of generated implementations: params-hash → circuit. */
  private generated = new Map<string, Circuit>();
  /** Cached fingerprint per parameter set (avoid recomputation). */
  private fingerprints = new Map<string, string>();

  constructor(def: ChipDefinition) {
    this.def = def;
    if (!def.version) def.version = '1.0.0';
    if (!def.createdAt) def.createdAt = new Date().toISOString();
  }

  get id(): string {
    return this.def.id;
  }
  get name(): string {
    return this.def.name;
  }
  get version(): string {
    return this.def.version;
  }
  get ports(): ChipPort[] {
    return this.def.ports;
  }
  get params(): ParamSpec[] {
    return this.def.params;
  }

  /** Fully qualified key used in the library: id@version. */
  key(): string {
    return `${this.def.id}@${this.def.version}`;
  }

  /** Default parameter bag. */
  defaultParams(): ParamBag {
    const out: ParamBag = {};
    for (const p of this.def.params) out[p.name] = p.default;
    return out;
  }

  /**
   * Resolve the implementation circuit for a parameter set. For non-parametric
   * chips the base circuit is returned (shared, read-only); for parametric chips
   * the generator result is memoised.
   */
  implementation(params: ParamBag = {}): Circuit {
    if (!this.def.generator) return this.def.circuit;
    const key = paramKey(params);
    let c = this.generated.get(key);
    if (!c) {
      c = this.def.generator(params);
      c.name = `${this.def.name}_${key}`;
      this.generated.set(key, c);
    }
    return c;
  }

  /** Content fingerprint of the implementation for a parameter set. */
  fingerprint(params: ParamBag = {}): string {
    const key = paramKey(params);
    const cached = this.fingerprints.get(key);
    if (cached) return cached;
    const h = new StructuralHash();
    h.string(this.def.id).string(this.def.version);
    const impl = this.implementation(params);
    h.string(impl.fingerprint());
    for (const p of this.def.ports) h.string(`${p.name}:${p.direction}:${p.width}`);
    const fp = h.hex();
    this.fingerprints.set(key, fp);
    return fp;
  }

  /** Pins of the implementation for a parameter set — the real interface. */
  implementationPins(params: ParamBag = {}): ChipPinInfo[] {
    return this.implementation(params).allPorts().map((p) => ({
      name: p.name,
      direction: p.direction,
      width: p.width,
    }));
  }

  stats(params: ParamBag = {}): { components: number; nets: number; ports: number } {
    const impl = this.implementation(params);
    return { components: impl.componentCount(), nets: impl.netCount(), ports: impl.allPorts().length };
  }
}

/** Chip flavour of `resolveParams`: the declared parameters are the chip's. */
export function resolvedChipParams(chip: Chip, instParams: ParamBag): ParamBag {
  return resolveParams(chip.params, instParams);
}

function paramKey(params: ParamBag): string {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${k}=${params[k]}`).join(',') || 'default';
}

/**
 * Registry of chips available in a project.
 * Lookups accept `id`, `id@version`, or the displayed name.
 */
export class ChipLibrary {
  private chips = new Map<string, Chip>();
  private byName = new Map<string, Chip>();

  add(chip: Chip): void {
    const key = chip.key();
    this.chips.set(key, chip);
    this.chips.set(chip.def.id, chip); // latest version wins for the plain id
    this.byName.set(chip.name, chip);
    this.byName.set(chip.name.toUpperCase(), chip);
  }

  get(idOrKey: string): Chip | undefined {
    return this.chips.get(idOrKey) ?? this.byName.get(idOrKey) ?? this.byName.get(idOrKey.toUpperCase());
  }

  must(idOrKey: string): Chip {
    const c = this.get(idOrKey);
    if (!c) throw new Error(`unknown chip "${idOrKey}"`);
    return c;
  }

  has(idOrKey: string): boolean {
    return this.get(idOrKey) !== undefined;
  }

  all(): Chip[] {
    const seen = new Set<string>();
    const out: Chip[] = [];
    for (const chip of this.chips.values()) {
      if (seen.has(chip.key())) continue;
      seen.add(chip.key());
      out.push(chip);
    }
    return out.sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  size(): number {
    const seen = new Set<string>();
    for (const c of this.chips.values()) seen.add(c.key());
    return seen.size;
  }

  remove(id: string): boolean {
    const chip = this.chips.get(id);
    if (!chip) return false;
    this.chips.delete(chip.key());
    this.chips.delete(chip.def.id);
    this.byName.delete(chip.name);
    this.byName.delete(chip.name.toUpperCase());
    return true;
  }

  /** Chips that instantiate `id`, directly or indirectly (for UI warnings). */
  dependentsOf(id: string): string[] {
    const out = new Set<string>();
    for (const chip of this.all()) {
      if (chip.def.id === id) continue;
      const visited = new Set<string>();
      if (this.usesChip(chip, id, visited)) out.add(chip.def.id);
    }
    return [...out];
  }

  private usesChip(chip: Chip, target: string, visited: Set<string>): boolean {
    if (visited.has(chip.def.id)) return false;
    visited.add(chip.def.id);
    for (const inst of chip.def.circuit.allComponents()) {
      const ref = (inst.params['__chip'] as string) ?? inst.chipRef;
      if (ref && (ref === target || ref.startsWith(`${target}@`))) return true;
      if (ref) {
        const sub = this.get(ref);
        if (sub && this.usesChip(sub, target, visited)) return true;
      }
    }
    return false;
  }

  /** Detect a cycle that would be introduced by making `childId` a child of `parentId`. */
  cycleCheck(parentId: string, childId: string): Diagnostic[] {
    if (parentId === childId) {
      return [error('CF4001', `chip "${parentId}" cannot contain itself`, { target: { type: 'chip', id: parentId } })];
    }
    const child = this.get(childId);
    if (!child) return [error('CF4002', `unknown chip "${childId}"`)];
    const stack: Array<{ id: string; path: string[] }> = [{ id: parentId, path: [parentId] }];
    const seen = new Set<string>();
    while (stack.length) {
      const { id, path } = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const chip = this.get(id);
      if (!chip) continue;
      for (const inst of chip.def.circuit.allComponents()) {
        const ref = inst.chipRef ?? (typeof inst.params['__chip'] === 'string' ? (inst.params['__chip'] as string) : undefined);
        if (!ref) continue;
        const base = ref.split('@')[0];
        if (base === childId) {
          return [
            error('CF4003', `instantiating "${childId}" inside "${parentId}" would create a cycle: ${[...path, childId].join(' → ')}`, {
              hint: 'Break the loop by extracting a leaf chip.',
            }),
          ];
        }
        stack.push({ id: ref, path: [...path, base] });
      }
    }
    return [];
  }
}

export function makeChip(def: Partial<ChipDefinition> & { id: string; name: string; circuit: Circuit }): Chip {
  const ports: ChipPort[] = def.ports ?? def.circuit.allPorts().map((p) => ({
    name: p.name,
    direction: p.direction,
    width: p.width,
    electrical: p.electrical,
    description: p.description,
  }));
  return new Chip({
    id: def.id,
    name: def.name,
    version: def.version ?? '1.0.0',
    description: def.description ?? '',
    ports,
    params: def.params ?? [],
    circuit: def.circuit,
    generator: def.generator,
    metrics: def.metrics,
    tags: def.tags ?? [],
    author: def.author,
    createdAt: def.createdAt,
    modifiedAt: def.modifiedAt,
    origin: def.origin ?? 'user',
    runId: def.runId,
    notes: def.notes,
  });
}

/** Sanitise a user-provided name into a library id. */
export function sanitizeChipId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'chip';
}

/** Bump a semantic version string (patch by default). */
export function bumpVersion(v: string, part: 'major' | 'minor' | 'patch' = 'patch'): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return '1.0.0';
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === 'major') {
    maj++;
    min = 0;
    pat = 0;
  } else if (part === 'minor') {
    min++;
    pat = 0;
  } else pat++;
  return `${maj}.${min}.${pat}`;
}

/** Metadata block written into exported chips. */
export function chipProvenance(chip: Chip): Record<string, string | number> {
  return {
    engine: ENGINE_VERSION,
    schema: 1,
    models: Object.values(MODEL_VERSIONS).join(','),
    chip: chip.key(),
    fingerprint: chip.fingerprint(),
    origin: chip.def.origin ?? 'user',
    createdAt: chip.def.createdAt ?? '',
  };
}

export { CircuitClass, warn };
