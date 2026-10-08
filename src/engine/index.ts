/**
 * CircuitForge — the engine's public surface.
 *
 * One import gives the whole laboratory: the component library and the circuit
 * model, the four simulation levels, the synthesis and reference projects, the
 * analyzer, the exporter, the optimizer, the validation gate, the job queue and the
 * instruments.
 *
 * The order below is the dependency order, and it is also the order in which the
 * pieces are worth reading if you are new to the codebase: nothing here depends on
 * anything listed after it.
 *
 *   util         versions, hashing, the profiler, units, platform detection, the RNG
 *   core         accuracy labels, the component library, circuits, chips, projects
 *   sim          the SoA netlist, the MNA solver, device models, levels 0 to 3
 *   synthesis    reference designs and the generators that build them
 *   analysis     logic simulation, static timing, statistics, the circuit analyzer
 *   export       schematics, BOMs, SPICE netlists, waveforms and reports
 *   io           the circuit and project file formats
 *   optim        specs, genomes, the tiered cost function, NSGA-II, explanations
 *   validate     the gate every chip passes before it can be saved
 *   jobs         the queue, its storage and the tasks it runs
 *   instruments  oscilloscope, spectrum analyzer, meters, signal generator
 *
 * Two conventions hold across every module and are worth knowing before you call
 * anything:
 *
 * - A number is never invented. Where a model approximates, the result carries an
 *   `Accuracy` and a note saying what the approximation is; where something was not
 *   measured, the field is `null` and the reason is in the text.
 * - A claim is always scoped. Optimization reports say "BEST FOUND UNDER CURRENT
 *   CONSTRAINTS" and list the constraints, the search space, the method, the
 *   candidate count and the simulation level, because "optimal" without a scope is
 *   not a statement about the world.
 */

export * from './util/version.js';
export * from './util/hash.js';
export * from './util/units.js';
export * from './util/profiler.js';
export * from './util/platform.js';
export * from './util/rng.js';

export * from './core/labels.js';
export * from './core/kinds.js';
export * from './core/library.js';
export * from './core/primitives.js';
export * from './core/primitives-digital.js';
export * from './core/primitives-semi.js';
export * from './core/registry.js';
export * from './core/circuit.js';
export * from './core/chip.js';
export * from './core/build.js';
export * from './core/project.js';

export * from './sim/paramslots.js';
export * from './sim/model.js';
export * from './sim/grow.js';
export * from './sim/matrix.js';
export * from './sim/netlist.js';
export * from './sim/device-models.js';
export * from './sim/cmos.js';
export * from './sim/elements.js';
export * from './sim/lower.js';
export * from './sim/solver.js';

export * from './synthesis/reference.js';
export * from './synthesis/generators.js';
export * from './synthesis/projects.js';
export * from './synthesis/projects-cpu.js';
export * from './synthesis/examples.js';

export * from './analysis/index.js';
export * from './export/index.js';

export * from './io/serialize.js';
export * from './io/project-file.js';

export * from './optim/spec.js';
export * from './optim/genome.js';
export * from './optim/cost.js';
export * from './optim/profiles.js';
export * from './optim/nsga2.js';
export * from './optim/templates.js';
export * from './optim/explain.js';
export * from './optim/search.js';

export * from './validate/validation.js';
export * from './jobs/index.js';
export * from './instruments/index.js';
export * from './bench/index.js';

/**
 * Schematic rendering, as a namespace: its `Point`, `Bounds`, `Theme` and `view` are
 * renderer vocabulary and would collide with the core types of the same name.
 */
export * as render from './render/index.js';

/** The editor's logic: the state machine and the command registry the GUI binds to. */
export * as ui from '../ui/index.js';

import { ENGINE_VERSION } from './util/version.js';
import { detectPlatform, platformSummary } from './util/platform.js';

/** The engine version, as a string, for banners and reports. */
export const VERSION = ENGINE_VERSION;

/**
 * Everything a banner, a report header or an `about` command needs: what this
 * program is, which version of it produced the numbers, and what it ran on.
 *
 * Reported rather than assumed, because a result that cannot be tied to a version
 * and a platform cannot be reproduced.
 */
export function about(): {
  name: string;
  version: string;
  platform: ReturnType<typeof platformSummary>;
  simulationLevels: string[];
  accuracyClasses: string[];
} {
  return {
    name: 'CircuitForge',
    version: ENGINE_VERSION,
    platform: platformSummary(detectPlatform()),
    simulationLevels: [
      'L0 logic — 0/1/X/Z, bit-parallel over 32 vectors',
      'L1 electrical — MNA with Newton-Raphson, transient, declared gate delays',
      'L2 detailed device — semiconductor models with their own model cards',
      'L3 electro-thermal — two-way coupling between dissipation and a lumped RC thermal network',
    ],
    accuracyClasses: ['REALISTIC', 'APPROXIMATED', 'IDEALIZED', 'NOT_MODELED'],
  };
}
