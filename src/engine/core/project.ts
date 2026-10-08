/**
 * A project: the component library plus the chip library, kept in sync.
 *
 * The two libraries serve different masters and must agree:
 *   - `Library` answers "what components exist?" — the schematic editor, the
 *     ERC and the netlist flattener all look up by spec id, and a chip instance
 *     is a component like any other;
 *   - `ChipLibrary` answers "how is this chip built?" — implementation circuits,
 *     parametric generators, metrics, provenance, versioning.
 *
 * Registering a chip therefore registers both: the implementation and the
 * component spec (pins laid out from the chip ports). This class is the single
 * place where that happens, so the GUI, the CLI, the synthesis pipeline and the
 * optimizer all see the same project.
 */

import { Circuit, type ComponentInstance, type Point } from './circuit.js';
import {
  Chip,
  ChipLibrary,
  makeChip,
  resolvedChipParams,
  sanitizeChipId,
  type ChipDefinition,
  type ChipPort,
} from './chip.js';
import { chipSpec, createDefaultLibrary } from './registry.js';
import type { Library, ParamBag, ComponentSpec } from './library.js';
import { error, fail, info, type Diagnostic } from './labels.js';
import { CircuitBuilder } from './build.js';

export interface SaveAsChipOptions {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  portNames?: Record<string, string>;
  tags?: string[];
  origin?: ChipDefinition['origin'];
  author?: string;
  notes?: string;
  /** Extra parameters exposed by the chip (in addition to the ports). */
  params?: ChipDefinition['params'];
  /**
   * Parametric chip: the circuit passed in is the default implementation, and
   * this generator materialises the implementation for any other parameter set.
   * It must be a pure function of `params` (reproducibility of the search).
   */
  generator?: ChipDefinition['generator'];
  /** Overwrite an existing chip with the same id (used by edit-and-resave). */
  overwrite?: boolean;
}

export class Project {
  readonly lib: Library;
  readonly chips: ChipLibrary;
  readonly diagnostics: Diagnostic[] = [];
  /** Project name, shown by the CLI and the window title. */
  name: string;
  /**
   * The sheet the user is editing. It is optional: a project can exist purely as
   * a chip library, and a loaded file may contain only chips.
   */
  sheet?: Circuit;
  /** Chip whose implementation is being edited, when editing inside a chip. */
  activeChip?: string;

  constructor(name = 'untitled project', lib: Library = createDefaultLibrary(), chips: ChipLibrary = new ChipLibrary()) {
    this.name = name;
    this.lib = lib;
    this.chips = chips;
  }

  /** Register a chip: implementation + component spec, atomically. */
  addChip(chip: Chip): Chip {
    this.chips.add(chip);
    const spec = chipSpec(
      chip.def.id,
      chip.def.name,
      chip.def.description,
      chip.def.ports,
      chip.def.params,
      { width: Math.max(5, 3 + 0.5 * Math.max(chip.def.name.length, 6)), keywords: chip.def.tags },
    );
    // `chip` category keeps the flattener, the ERC and the UI agreeing that this
    // spec is an instance, not a primitive.
    spec.category = 'chip';
    spec.support = { ...spec.support, expandable: true, lowersTo: [chip.def.id.toUpperCase()] };
    if (this.lib.has(chip.def.id)) this.lib.override(spec);
    else this.lib.register(spec);
    return chip;
  }

  /** Instantiate a chip inside a builder. */
  instantiate(
    b: CircuitBuilder,
    chipOrId: Chip | string,
    params: ParamBag = {},
    position: Point | [number, number] = { x: 0, y: 0 },
    opts: { ref?: string; bits?: number } = {},
  ): ComponentInstance {
    const chip = typeof chipOrId === 'string' ? this.chips.get(chipOrId) : chipOrId;
    if (!chip) {
      // A generator may only instantiate chips that are already registered. Name
      // the missing chip: "unknown chip \"mux4\"" hides the real problem (the
      // builder of a dependency was never called).
      fail('CF4004', `chip \"${String(chipOrId)}\" is not registered in project \"${this.name}\"`, {
        hint: 'Register chips in dependency order (gates → adders → selectors → sequential → memory → cpu) so every generator finds the chips it instantiates.',
      });
    }
    const spec = this.lib.get(chip.def.id);
    if (!spec) {
      fail('CF4004', `chip "${chip.def.id}" has no component spec — register it through Project.addChip`, {
        hint: 'A chip registered directly in the ChipLibrary is invisible to the netlist flattener.',
      });
    }
    // Chip parameters default to the values declared by the chip.
    const merged: ParamBag = { ...chip.defaultParams(), ...params };
    const pos: Point = Array.isArray(position) ? { x: position[0], y: position[1] } : position;
    return b.addChip(spec, merged, pos, opts.ref, { bits: opts.bits });
  }

  /**
   * Turn a circuit into a chip and register it. The ports of the circuit become
   * the ports of the chip; without an explicit id the name is sanitized into one.
   */
  saveAsChip(circuit: Circuit, options: SaveAsChipOptions = {}): Chip {
    const id = options.id ?? sanitizeChipId(options.name ?? circuit.name);
    const existing = this.chips.get(id);
    if (existing && !options.overwrite) {
      fail('CF4005', `a chip with id "${id}" already exists (version ${existing.version})`, {
        hint: 'Pass overwrite: true (or a new id) to save under the same id.',
      });
    }
    const ports: ChipPort[] = circuit.allPorts().map((p) => ({
      name: options.portNames?.[p.name] ?? p.name,
      direction: p.direction,
      width: p.width,
      electrical: p.electrical,
      description: p.description,
    }));
    if (ports.length === 0) {
      this.diagnostics.push(
        info('CF4006', `chip "${id}" has no port: it can be used as a self-contained macro, but not instantiated with connections`),
      );
    }
    const chip = makeChip({
      id,
      name: options.name ?? circuit.name.toUpperCase(),
      version: options.version ?? existing?.version ?? '1.0.0',
      description: options.description ?? circuit.description ?? '',
      circuit,
      ports,
      params: options.params ?? [],
      generator: options.generator,
      tags: options.tags,
      origin: options.origin ?? 'user',
      author: options.author,
      notes: options.notes,
      metrics: existing?.def.metrics,
    });
    return this.addChip(chip);
  }

  /** Convenience: build a circuit with a builder and save it as a chip in one go. */
  buildChip(options: SaveAsChipOptions & { name: string }, build: (b: CircuitBuilder) => void): Chip {
    const b = new CircuitBuilder(this.lib, options.name, this.chips);
    build(b);
    const circuit = b.finish({ erc: false });
    this.diagnostics.push(...b.diagnostics);
    return this.saveAsChip(circuit, options);
  }

  specOf(chipOrId: Chip | string): ComponentSpec {
    const chip = typeof chipOrId === 'string' ? this.chips.must(chipOrId) : chipOrId;
    const spec = this.lib.get(chip.def.id);
    if (!spec) fail('CF4004', `no component spec for chip "${chip.def.id}"`);
    return spec;
  }

  /** Remove a chip (implementation + spec). */
  removeChip(chipOrId: Chip | string): boolean {
    const chip = typeof chipOrId === 'string' ? this.chips.get(chipOrId) : chipOrId;
    if (!chip) return false;
    const dependents = this.chips.dependentsOf(chip.def.id);
    if (dependents.length > 0) {
      this.diagnostics.push(
        error('CF4007', `chip "${chip.def.id}" is used by ${dependents.length} other chip(s): ${dependents.join(', ')}`, {
          hint: 'Delete or refactor the dependents first; removing it now would leave them unbuildable.',
        }),
      );
      return false;
    }
    this.chips.remove(chip.def.id);
    const specs = this.lib as unknown as { specs?: Map<string, ComponentSpec> };
    specs.specs?.delete(chip.def.id);
    return true;
  }

  /**
   * Run the electrical rules check over the working sheet *and* over every chip
   * implementation in the project.
   *
   * The ERC of a single circuit cannot see inside a chip, so this is the check
   * that guards a save: a chip whose internal wiring is broken (a dangling pin, a
   * parameter out of range, two drivers on one net) is reported before it is
   * written to the library, not when someone instantiates it later.
   */
  validate(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const check = (circuit: Circuit, owner: string): void => {
      for (const d of circuit.erc(this.lib, this.chips)) {
        out.push({ ...d, data: { ...(d.data ?? {}), circuit: owner } });
      }
    };
    if (this.sheet) check(this.sheet, this.sheet.name);
    for (const chip of this.chips.all()) check(chip.def.circuit, `${chip.def.id}@${chip.def.version}`);
    return out;
  }

  /** All chips, sorted by name. */
  list(): Chip[] {
    return this.chips.all();
  }

  /** Structured summary for the CLI, the UI and the reports. */
  summary(): Array<Record<string, unknown>> {
    return this.list().map((c) => ({
      id: c.def.id,
      name: c.def.name,
      version: c.version,
      ports: c.def.ports.length,
      params: c.def.params.length,
      components: c.def.circuit.componentCount(),
      nets: c.def.circuit.netCount(),
      origin: c.def.origin ?? 'user',
      description: c.def.description,
    }));
  }
}
