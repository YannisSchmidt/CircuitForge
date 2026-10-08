/**
 * Registry of parametric chip generators.
 *
 * A generator is a function and cannot be written into a project file. Instead a
 * parametric chip records the *identity* of its generator, and the loader asks
 * this registry for the function again. That keeps the reference library (whose
 * generators are compiled into the engine) fully parametric across save/load,
 * while a foreign file — whose generator this build does not know — still loads,
 * as the fixed implementation that was materialised when the file was written.
 */

import type { CircuitBuilder } from '../core/build.js';
import type { ParamBag } from '../core/library.js';

export type ChipGenerator = (b: CircuitBuilder, params: ParamBag) => void;

const registry = new Map<string, ChipGenerator>();

/** Register (or replace) the generator of a chip id. */
export function registerChipGenerator(id: string, generator: ChipGenerator): void {
  registry.set(id, generator);
}

export function getChipGenerator(id: string): ChipGenerator | undefined {
  return registry.get(id);
}

export function chipGeneratorIds(): string[] {
  return [...registry.keys()].sort();
}
