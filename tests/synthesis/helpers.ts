/**
 * Shared harness for the reference chips: instantiate a chip in a root circuit,
 * expose every port of its *implementation*, run the ERC, flatten and drive the
 * level-0 logic engine.
 *
 * Two things here are deliberate:
 *  - the ports are taken from `implementationPins(params)`, not from the static
 *    spec, because a parametric chip may have more pins than its default build
 *    (a 16-word ROM has one address pin more than the 8-word default);
 *  - `finish()` runs the ERC, so every test also asserts that the project's own
 *    hierarchy passes the electrical rules check.
 */

import { Project } from '../../src/engine/core/project.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { resolvedChipParams } from '../../src/engine/core/chip.js';
import type { ParamBag } from '../../src/engine/core/library.js';
import { flatten, type FlatNetlist } from '../../src/engine/sim/netlist.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';
import { buildReferenceChips, buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { assert } from '../framework.js';

/** A project with the whole reference library registered. */
export function referenceProject(name = 'reference'): Project {
  const project = new Project(name);
  buildReferenceChips(project);
  return project;
}

export { buildReferenceProject };

export interface ChipHarness {
  nl: FlatNetlist;
  sim: LogicVectorSim;
  net(name: string): number;
  /** Drive one net (must be an input of the harness). */
  set(name: string, value: number): void;
  get(name: string): number;
  /** The raw level of a net: 0, 1, or the strings 'X' / 'Z'. */
  raw(name: string): number | string;
  setBus(prefix: string, value: number, width: number): void;
  getBus(prefix: string, width: number): number;
  /** One clock edge: clk 0→1 (settle, update), then back to 0. */
  pulse(times?: number): void;
  settle(): void;
}

/** Build a harness around one chip of a project. */
export function chipHarness(project: Project, chipId: string, params: ParamBag = {}): ChipHarness {
  const chip = project.chips.must(chipId);
  const merged: ParamBag = { ...chip.defaultParams(), ...params };
  const pins = chip.implementationPins(resolvedChipParams(chip, merged));

  const b = new CircuitBuilder(project.lib, `root-${chipId}`, project.chips);
  const inst = project.instantiate(b, chipId, merged, [0, 0]);
  for (const p of pins) {
    b.port(p.name, p.direction === 'output' ? 'output' : 'input', p.name.toLowerCase(), p.width);
    b.at(inst, p.name, p.name.toLowerCase());
  }
  const circuit = b.finish();
  const ercErrors = b.diagnostics.filter((d) => d.severity === 'error');
  assert(ercErrors.length === 0, `ERC rejected the ${chipId} harness: ${ercErrors.map((d) => `${d.code} ${d.message}`).join('; ')}`);

  const nl = flatten(circuit, project.lib, project.chips, { ambient: 27 });
  const errs = nl.diagnostics.filter((d) => d.severity === 'error');
  assert(errs.length === 0, `netlist errors: ${errs.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const net = (name: string): number => {
    for (let i = 0; i < g.netCount; i++) if (g.netName(i) === name) return i;
    throw new Error(`no net ${name}`);
  };
  const set = (name: string, value: number): void => sim.setVector(net(name), 0, (value & 1) as 0 | 1);
  const get = (name: string): number => Number(sim.sample(net(name), 0)) & 1;
  // A test bench must drive every input: an undriven input is X, and an X that
  // reaches a register would make the failure look like a chip bug.
  for (const pin of pins) {
    if (pin.direction !== 'input') continue;
    assert(net(pin.name.toLowerCase()) >= 0, `input pin ${pin.name} of ${chipId} is not wired in the harness`);
    set(pin.name.toLowerCase(), 0);
  }
  sim.settle();
  return {
    nl,
    sim,
    net,
    set,
    get,
    setBus: (prefix, value, width) => {
      for (let i = 0; i < width; i++) set(`${prefix}${i}`, (value >> i) & 1);
    },
    raw: (name) => sim.sample(net(name), 0),
    getBus: (prefix, width) => {
      let out = 0;
      for (let i = 0; i < width; i++) out |= get(`${prefix}${i}`) << i;
      return out;
    },
    pulse: (times = 1) => {
      for (let i = 0; i < times; i++) {
        set('clk', 1);
        sim.run(1);
        set('clk', 0);
        sim.run(1);
      }
    },
    settle: () => sim.settle(),
  };
}
