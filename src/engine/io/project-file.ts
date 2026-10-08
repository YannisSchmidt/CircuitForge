/**
 * The project file: one JSON text holding the whole design — the sheet being
 * edited and every chip saved with the project, in dependency order.
 *
 * Round-trip guarantee: saving and loading a project gives back the same chips,
 * the same implementations, the same fingerprints and the same working circuit.
 * Parametric chips keep their generator when this build knows it (the reference
 * library does), and are restored as their saved fixed implementation when it
 * does not — in which case the loader says exactly that, instead of pretending.
 *
 * Loading is deliberately forgiving in one direction only: it reports what it
 * could not restore instead of failing halfway. `LoadResult.errors` counts
 * diagnostics of severity Error; a project with errors is still returned so the
 * user can inspect and repair the file.
 */

import { Project } from '../core/project.js';
import { ChipLibrary, type Chip } from '../core/chip.js';
import { createDefaultLibrary } from '../core/registry.js';
import type { Library } from '../core/library.js';
import { Severity, error, info, warn, type Diagnostic } from '../core/labels.js';
import { CircuitBuilder } from '../core/build.js';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../util/version.js';
import { getChipGenerator } from '../synthesis/generators.js';
import {
  PROJECT_FORMAT,
  chipFromDocument,
  chipToDocument,
  circuitFromDocument,
  circuitToDocument,
  type ChipDocument,
  type CircuitDocument,
  type ProjectDocument,
} from './serialize.js';

export interface SaveProjectOptions {
  /** The sheet the user is editing, if any. */
  circuit?: CircuitDocumentSource;
  notes?: string;
  /** Chip ids to leave out (used to export a hand-off without scratch chips). */
  excludeChips?: string[];
}

type CircuitDocumentSource = Parameters<typeof circuitToDocument>[0];

export function projectToDocument(project: Project, options: SaveProjectOptions = {}): ProjectDocument {
  const exclude = new Set(options.excludeChips ?? []);
  const chips = orderChipsForSave(project.chips.all().filter((chip) => !exclude.has(chip.def.id)));
  const doc: ProjectDocument = {
    format: PROJECT_FORMAT,
    version: SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    name: project.name,
    savedAt: new Date().toISOString(),
    chips: chips.map(chipToDocument),
    notes: options.notes,
  };
  const sheet = options.circuit ?? project.sheet;
  if (sheet) doc.circuit = circuitToDocument(sheet);
  return doc;
}

/**
 * Chips are written so that a chip always appears after the chips it
 * instantiates, which lets the loader register them in one pass.
 */
function orderChipsForSave(chips: Chip[]): Chip[] {
  const byId = new Map(chips.map((c) => [c.def.id, c]));
  const emitted = new Set<string>();
  const out: Chip[] = [];
  const visit = (chip: Chip, stack: string[]): void => {
    if (emitted.has(chip.def.id)) return;
    if (stack.includes(chip.def.id)) return; // a cycle: the ERC reports it, don't hang
    stack.push(chip.def.id);
    for (const inst of chip.def.circuit.allComponents()) {
      const dep = inst.chipRef ? byId.get(inst.chipRef) : undefined;
      if (dep) visit(dep, stack);
    }
    stack.pop();
    emitted.add(chip.def.id);
    out.push(chip);
  };
  for (const chip of chips) visit(chip, []);
  return out;
}

export function saveProjectText(project: Project, options: SaveProjectOptions = {}): string {
  return `${JSON.stringify(projectToDocument(project, options), null, 2)}\n`;
}

export interface LoadResult {
  project: Project;
  diagnostics: Diagnostic[];
  /** Convenience: number of Error-severity diagnostics. */
  errors: number;
  warnings: number;
}

export interface LoadOptions {
  /** Reuse an existing component library (defaults to the build's own). */
  lib?: Library;
  /** Reuse an existing chip library (defaults to a fresh one). */
  chips?: ChipLibrary;
  /** Project name override (defaults to the name in the file). */
  name?: string;
}

/**
 * Load a project file. Chips are registered in dependency order even if the file
 * is not sorted, cycles are diagnosed instead of hanging, and the working circuit
 * is restored last so that it can see every chip it instantiates.
 */
export function loadProjectText(text: string, options: LoadOptions = {}): LoadResult {
  const diagnostics: Diagnostic[] = [];
  let doc: ProjectDocument;
  try {
    doc = JSON.parse(text) as ProjectDocument;
  } catch (err) {
    diagnostics.push(error('CF6001', `the file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`));
    return { project: new Project(options.name ?? 'damaged project', options.lib ?? createDefaultLibrary(), options.chips), diagnostics, errors: 1, warnings: 0 };
  }
  if (doc?.format !== PROJECT_FORMAT) {
    diagnostics.push(error('CF6001', `not a CircuitForge project: format "${String(doc?.format)}"`, { hint: `Expected "${PROJECT_FORMAT}".` }));
  } else if (doc.version > SCHEMA_VERSION) {
    diagnostics.push(
      error('CF6001', `project format version ${doc.version} is newer than this build (${SCHEMA_VERSION})`, {
        hint: 'A newer CircuitForge wrote this file; parts may not load.',
      }),
    );
  }
  if (doc?.engine && doc.engine !== ENGINE_VERSION) {
    diagnostics.push(
      info('CF6010', `project saved by engine ${doc.engine}, this build is ${ENGINE_VERSION}`, {
        hint: 'Results computed by the old engine are labelled with its version in the reports.',
      }),
    );
  }

  const lib = options.lib ?? createDefaultLibrary();
  const chips = options.chips ?? new ChipLibrary();
  const project = new Project(options.name ?? doc?.name ?? 'untitled project', lib, chips);

  const docs = [...(doc?.chips ?? [])];
  const byId = new Map(docs.map((c) => [c.id, c]));
  const loaded = new Set<string>();
  const loading: string[] = [];

  const loadChip = (cd: ChipDocument): void => {
    if (loaded.has(cd.id)) return;
    if (loading.includes(cd.id)) {
      diagnostics.push(error('CF6007', `chip "${cd.id}" depends on itself (${[...loading, cd.id].join(' → ')})`));
      return;
    }
    loading.push(cd.id);
    for (const dep of cd.dependencies ?? []) {
      const depDoc = byId.get(dep);
      if (depDoc) loadChip(depDoc);
      else diagnostics.push(warnMissingDependency(cd, dep));
    }
    loading.pop();
    const missingTypes = (cd.uses ?? []).filter((type) => !lib.get(type));
    for (const type of missingTypes) {
      diagnostics.push(
        error('CF6002', `chip "${cd.id}" uses component type "${type}", which this build does not provide`, {
          target: { type: 'chip', id: cd.id, name: cd.name },
        }),
      );
    }
    const generatorId = cd.generatorId ?? (getChipGenerator(cd.id) ? cd.id : undefined);
    const generator = generatorId ? getChipGenerator(generatorId) : undefined;
    const attach = generator
      ? (params: Parameters<typeof generator>[1]) => {
          const b = new CircuitBuilder(project.lib, cd.name, project.chips);
          generator(b, params);
          return b.finish({ erc: false });
        }
      : undefined;
    const { chip, diagnostics: chipDiags } = chipFromDocument(cd, lib, { attachGenerator: attach });
    for (const d of chipDiags) diagnostics.push(d);
    try {
      project.addChip(chip);
      loaded.add(cd.id);
    } catch (err) {
      diagnostics.push(error('CF6008', `chip "${cd.id}" could not be registered: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  for (const cd of docs) loadChip(cd);

  if (doc?.circuit) {
    const { circuit, diagnostics: circuitDiags } = circuitFromDocument(doc.circuit, lib, chips);
    for (const d of circuitDiags) diagnostics.push(d);
    project.sheet = circuit;
  }

  const errors = diagnostics.filter((d) => d.severity === Severity.Error).length;
  const warnings = diagnostics.filter((d) => d.severity === Severity.Warning).length;
  return { project, diagnostics, errors, warnings };
}

function warnMissingDependency(chip: ChipDocument, dep: string): Diagnostic {
  return warn('CF6009', `chip "${chip.id}" instantiates chip "${dep}", which is not in the file`, {
    target: { type: 'chip', id: chip.id, name: chip.name },
    hint: 'Instances of that chip will not flatten; the rest of the project loads normally.',
  });
}
