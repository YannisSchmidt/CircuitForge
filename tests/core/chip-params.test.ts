/**
 * A parametric chip's interface is a function of its parameters.
 *
 * The static component spec of a chip is built from its *default* parameter set,
 * so it cannot know that a 16-word ROM has one address pin more than the 8-word
 * default. Everything that looks at a chip instance — the flattener, the ERC, the
 * GUI — must therefore resolve the pins from the implementation for the pins'
 * own parameter set. These tests pin that contract down; before it existed, a
 * wire to such a pin was silently dropped.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { testProject } from '../sim/helpers.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';
import { parametricChip, numberParam, grid } from '../../src/engine/synthesis/projects.js';
import { buildReferenceChips } from '../../src/engine/synthesis/reference.js';
import type { Project } from '../../src/engine/core/project.js';
import type { ParamBag } from '../../src/engine/core/library.js';

/** An inverter bank whose *port count* is a parameter. */
function fanChip(project: Project): void {
  parametricChip(project, {
    id: 'fan',
    name: 'FAN',
    description: 'Inverter bank: width = number of lanes (the interface follows the parameter).',
    params: [{ name: 'width', kind: 'number', unit: '', default: 1, min: 1, max: 4, description: 'Lanes' }],
    tags: ['test'],
    generator: (b: CircuitBuilder, params) => {
      const width = numberParam(params, 'width', 1, 1, 4);
      for (let i = 0; i < width; i++) {
        b.port(`X${i}`, 'input', `x${i}`, 1);
        b.port(`Y${i}`, 'output', `y${i}`, 1);
        const inv = b.add('not_gate', { style: 'ideal', inputs: 1 }, grid(i, 0));
        b.at(inv, 'IN1', `x${i}`).at(inv, 'OUT', `y${i}`);
      }
    },
  });
}

function harness(p: ReturnType<typeof testProject>, params: ParamBag, pins: string[]) {
  const b = new CircuitBuilder(p.project.lib, 'root', p.project.chips);
  const inst = p.project.instantiate(b, 'fan', params, [0, 0]);
  for (const pin of pins) {
    const out = pin.startsWith('Y');
    b.port(pin, out ? 'output' : 'input', pin.toLowerCase(), 1);
    b.at(inst, pin, pin.toLowerCase());
  }
  const circuit = b.finish();
  return { b, circuit };
}

suite('core/chip-params');

test('the declared interface is the default build, the implementation pins follow the parameters', () => {
  const p = testProject('chip-params');
  fanChip(p.project);
  const chip = p.project.chips.must('fan');
  assertEqual(chip.def.ports.length, 2, 'default build: X0 + Y0');
  assertEqual(chip.implementationPins({ width: 3 }).length, 6, 'three lanes: X0..X2 + Y0..Y2');
  assertEqual(
    chip.implementationPins({ width: 3 }).map((pin) => pin.name).join(','),
    'X0,Y0,X1,Y1,X2,Y2',
    'pin order is the implementation port order',
  );
});

test('instantiating with a wider parameter set is accepted by the ERC and simulates', () => {
  const p = testProject('chip-params-wide');
  fanChip(p.project);
  const { b, circuit } = harness(p, { width: 3 }, ['X0', 'X1', 'X2', 'Y0', 'Y1', 'Y2']);
  const ercErrors = b.diagnostics.filter((d) => d.severity === 'error');
  assertEqual(ercErrors.length, 0, `ERC must accept the parameterised pins: ${ercErrors.map((d) => `${d.code} ${d.message}`).join('; ')}`);

  const nl = flatten(circuit, p.lib, p.chips, { ambient: 27 });
  const errors = nl.diagnostics.filter((d) => d.severity === 'error');
  assertEqual(errors.length, 0, 'netlist errors');
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const net = (name: string): number => {
    for (let i = 0; i < g.netCount; i++) if (g.netName(i) === name) return i;
    throw new Error(`no net ${name}`);
  };
  // Drive a pattern that is not uniform across the lanes: a lane mix-up would
  // still pass an all-zero or all-one pattern.
  for (const [x0, x1, x2] of [[0, 1, 0], [1, 1, 0], [1, 0, 1]]) {
    sim.setVector(net('x0'), 0, x0 as 0 | 1);
    sim.setVector(net('x1'), 0, x1 as 0 | 1);
    sim.setVector(net('x2'), 0, x2 as 0 | 1);
    sim.settle();
    assertEqual(Number(sim.sample(net('y0'), 0)), 1 - x0, 'y0');
    assertEqual(Number(sim.sample(net('y1'), 0)), 1 - x1, 'y1');
    assertEqual(Number(sim.sample(net('y2'), 0)), 1 - x2, 'y2');
  }
});

test('two instances of the same parametric chip with different parameters coexist', () => {
  const p = testProject('chip-params-multi');
  fanChip(p.project);
  const b = new CircuitBuilder(p.project.lib, 'root', p.project.chips);
  const wide = p.project.instantiate(b, 'fan', { width: 3 }, [0, 0]);
  const narrow = p.project.instantiate(b, 'fan', { width: 1 }, [0, 200]);
  for (let i = 0; i < 3; i++) {
    b.port(`A${i}`, 'input', `a${i}`, 1);
    b.at(wide, `X${i}`, `a${i}`);
  }
  b.port('BW', 'input', 'bw', 1);
  b.at(narrow, 'X0', 'bw');
  for (let i = 0; i < 3; i++) {
    b.port(`W${i}`, 'output', `w${i}`, 1);
    b.at(wide, `Y${i}`, `w${i}`);
  }
  b.port('NW', 'output', 'nw', 1);
  b.at(narrow, 'Y0', 'nw');
  const circuit = b.finish();
  assertEqual(b.diagnostics.filter((d) => d.severity === 'error').length, 0, 'ERC clean for both instances');
  const nl = flatten(circuit, p.lib, p.chips, { ambient: 27 });
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const net = (name: string): number => {
    for (let i = 0; i < g.netCount; i++) if (g.netName(i) === name) return i;
    throw new Error(`no net ${name}`);
  };
  sim.setVector(net('a0'), 0, 1);
  sim.setVector(net('a1'), 0, 0);
  sim.setVector(net('a2'), 0, 0);
  sim.setVector(net('bw'), 0, 1);
  sim.settle();
  assertEqual([0, 1, 2].map((i) => Number(sim.sample(net(`w${i}`), 0))).join(''), '011', 'wide instance inverts its own lanes');
  assertEqual(Number(sim.sample(net('nw'), 0)), 0, 'narrow instance is unaffected');
});

test('a wire to a pin that no parameter set declares is an ERC error (CF3010)', () => {
  const p = testProject('chip-params-bogus');
  fanChip(p.project);
  const b = new CircuitBuilder(p.project.lib, 'root', p.project.chips);
  const inst = p.project.instantiate(b, 'fan', { width: 3 }, [0, 0]);
  b.port('X', 'input', 'x', 1);
  b.at(inst, 'X9', 'x');
  b.port('Y', 'output', 'y', 1);
  b.at(inst, 'Y0', 'y');
  b.finish();
  const codes = b.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  assert(codes.includes('CF3010'), `expected CF3010 for the bogus pin, got ${codes.join(', ') || 'no errors'}`);
});

test('rom_n declares the address pins of the requested word count', () => {
  const p = testProject('chip-params-rom');
  buildReferenceChips(p.project);
  const rom = p.project.chips.must('rom_n');
  assertEqual(rom.implementationPins({ words: 8, width: 4 }).filter((pin) => pin.name.startsWith('A')).length, 3, '8 words: A0..A2');
  assertEqual(rom.implementationPins({ words: 16, width: 8 }).filter((pin) => pin.name.startsWith('A')).length, 4, '16 words: A0..A3');
  // The generated circuit is memoised per parameter set: two lookups are the same object.
  assert(rom.implementation({ words: 16 }) === rom.implementation({ words: 16 }), 'generator results are memoised');
  assert(rom.implementation({ words: 16 }) !== rom.implementation({ words: 8 }), 'different parameters, different circuits');
});
