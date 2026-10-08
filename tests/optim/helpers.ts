/**
 * Shared harness for the optimiser tests.
 *
 * `evaluateCandidate` and `detailCandidate` take an options bag (spec, vector
 * plan, library, chip library, constraints, limits, ambient). Every test wants
 * the same sensible bag and only varies the genome and the specification, so the
 * bag is built once here — and the vector plan is derived from a *fixed* seed, so
 * a sampled specification gives every test the same vectors.
 */

import { ChipLibrary } from '../../src/engine/core/chip.js';
import type { Library } from '../../src/engine/core/library.js';
import { Rng } from '../../src/engine/util/rng.js';
import {
  DEFAULT_CONSTRAINTS,
  detailCandidate as detail,
  evaluateCandidate as evaluate,
  type Candidate,
  type DetailResult,
  type EvaluateOptions,
} from '../../src/engine/optim/cost.js';
import { DEFAULT_LIMITS, type LogicGenome } from '../../src/engine/optim/genome.js';
import { planVectors, type DesignSpec, type VectorPlan } from '../../src/engine/optim/spec.js';

export const TEST_AMBIENT = 27;
export const TEST_SEED = 'circuitforge-test-plan';

/** The vector plan a test evaluates against (deterministic). */
export function planVectorsFor(spec: DesignSpec, seed: number | string = TEST_SEED): VectorPlan {
  return planVectors(spec, new Rng(seed));
}

export function optionsFor(spec: DesignSpec, lib: Library, chips: ChipLibrary = new ChipLibrary()): EvaluateOptions {
  return {
    spec,
    plan: planVectorsFor(spec),
    lib,
    chips,
    constraints: { ...DEFAULT_CONSTRAINTS },
    limits: { ...DEFAULT_LIMITS },
    ambient: TEST_AMBIENT,
  };
}

/** Tiers 0–2 on one genome. */
export function evaluateCandidate(genome: LogicGenome, spec: DesignSpec, lib: Library, chips: ChipLibrary = new ChipLibrary()): Candidate {
  return evaluate(genome, optionsFor(spec, lib, chips));
}

/** Tiers 3–4 on one genome (the transistor-level bench). */
export function detailCandidate(
  genome: LogicGenome,
  opts: { spec: DesignSpec; lib: Library; chips?: ChipLibrary; vectorIndices?: number[] },
): DetailResult {
  return detail(genome, { ...optionsFor(opts.spec, opts.lib, opts.chips), ...(opts.vectorIndices ? { vectorIndices: opts.vectorIndices } : {}) });
}

export { DEFAULT_CONSTRAINTS, DEFAULT_LIMITS };
export type { Candidate, DetailResult, EvaluateOptions, LogicGenome };
