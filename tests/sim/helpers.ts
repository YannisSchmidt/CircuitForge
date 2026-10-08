/**
 * Shared helpers for simulation tests: build a circuit, flatten it and get a
 * simulator, with the ambient fixed so that results are reproducible.
 */

import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { ChipLibrary } from '../../src/engine/core/chip.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { Project } from '../../src/engine/core/project.js';
import type { Circuit } from '../../src/engine/core/circuit.js';
import { flatten, type FlatNetlist, type FlattenOptions } from '../../src/engine/sim/netlist.js';
import { CircuitSimulator, type SolverOptions } from '../../src/engine/sim/solver.js';
import { assert } from '../framework.js';
import { Severity } from '../../src/engine/core/labels.js';

export const AMBIENT = 27; // matches the default nominal temperature of the device models

export function makeLibs(): { lib: ReturnType<typeof createDefaultLibrary>; chips: ChipLibrary } {
  return { lib: createDefaultLibrary(), chips: new ChipLibrary() };
}

export function builder(name = 'test'): { b: CircuitBuilder; lib: ReturnType<typeof createDefaultLibrary>; chips: ChipLibrary } {
  const { lib, chips } = makeLibs();
  return { b: new CircuitBuilder(lib, name), lib, chips };
}

/** A project (component library + chip library in sync), for hierarchy tests. */
export interface TestProject {
  project: Project;
  lib: ReturnType<typeof createDefaultLibrary>;
  chips: ChipLibrary;
}

export function testProject(name = 'test-project'): TestProject {
  const { lib, chips } = makeLibs();
  return { project: new Project(name, lib, chips), lib, chips };
}

export function flattenCircuit(
  c: Circuit,
  lib: ReturnType<typeof createDefaultLibrary>,
  chips: ChipLibrary,
  options: FlattenOptions & { allowWarnings?: boolean } = {},
): FlatNetlist {
  const { allowWarnings = false, ...flatOpts } = options;
  const nl = flatten(c, lib, chips, { ambient: AMBIENT, ...flatOpts });
  const bad = nl.diagnostics.filter((d) => d.severity === Severity.Error || (!allowWarnings && d.severity === Severity.Warning));
  const text = bad.map((d) => `${d.severity} ${d.code}: ${d.message}`).join('; ');
  assert(bad.length === 0, `netlist diagnostics: ${text}`);
  return nl;
}

export function simulator(nl: FlatNetlist, options: Partial<SolverOptions> = {}): CircuitSimulator {
  return new CircuitSimulator(nl, { ambient: AMBIENT, ...options });
}

/** Node index of an output port (by name) — ports bind to nets, nets to nodes. */
export function portNode(nl: FlatNetlist, name: string): number {
  const p = nl.ports.find((x) => x.name === name);
  assert(!!p, `no port named ${name} in the netlist`);
  return p!.node;
}

/** Element index of the first element lowered from a component of that spec. */
export function elementIndex(nl: FlatNetlist, specId: string): number {
  const inst = nl.instances.findIndex((i) => i.specId === specId);
  assert(inst >= 0, `no instance of spec ${specId}`);
  const el = nl.instIndex.indexOf(inst);
  assert(el >= 0, `no element lowered from instance ${inst} (${specId})`);
  return el;
}

/** Node index of a net by name (path-qualified names work too). */
export function nodeOfNetName(nl: FlatNetlist, netName: string): number {
  for (let i = 0; i < nl.nodeCount; i++) {
    const name = nl.nodeNames[nl.nodeName[i] - 1];
    if (name === netName || name?.endsWith(`/${netName}`)) return i;
  }
  assert(false, `no node named ${netName} (known: ${nl.nodeNames.join(', ')})`);
  return 0;
}
