/**
 * The reference project library.
 *
 * One call materialises every reference chip — gates, adders, selectors, the
 * sequential and memory chips and the CPU — so a new project, the test suite and
 * the GUI all start from exactly the same hardware. The chips double as the
 * regression suite: `tests/synthesis/reference.test.ts` runs them.
 */

import { Project } from '../core/project.js';
import type { Chip } from '../core/chip.js';
import {
  buildAdderChips,
  buildGateChips,
  buildMemoryChips,
  buildSelectorChips,
  buildSequentialChips,
} from './projects.js';
import { buildCpuChip } from './projects-cpu.js';

export interface ReferenceChips {
  gates: Chip[];
  adders: Chip[];
  selectors: Chip[];
  sequential: Chip[];
  memory: Chip[];
  cpu: Chip;
}

/**
 * Register every reference chip in `project`, in dependency order (a chip may
 * only instantiate chips that are already registered).
 */
export function buildReferenceChips(project: Project, options: { program?: string } = {}): ReferenceChips {
  const gates = buildGateChips(project);
  const adders = buildAdderChips(project);
  const selectors = buildSelectorChips(project);
  const sequential = buildSequentialChips(project);
  const memory = buildMemoryChips(project);
  const cpu = buildCpuChip(project, options.program === undefined ? {} : { program: options.program });
  return { gates, adders, selectors, sequential, memory, cpu };
}

/** A project already populated with the whole reference library. */
export function buildReferenceProject(name = 'circuitforge reference'): Project {
  const project = new Project(name);
  buildReferenceChips(project);
  return project;
}
