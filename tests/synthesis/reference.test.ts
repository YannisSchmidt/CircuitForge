/**
 * The reference project library as a regression suite.
 *
 * Each reference chip is instantiated exactly the way a user would instantiate
 * it (through `Project.instantiate`, with parameters) and then driven at level 0.
 * The chips are the project's own documentation: if one of these tests fails, the
 * library is broken, not the test.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit } from '../sim/helpers.js';
import { chipHarness, referenceProject } from './helpers.js';
import { Project } from '../../src/engine/core/project.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { parametricChip } from '../../src/engine/synthesis/projects.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';

const DEMO_PROGRAM = '63,84,21,92,56,81,8A,F0,00,00,00,00,00,00,00,00';

suite('synthesis/reference');

test('constant sources drive gates: logic_high pulls up, logic_low pulls down', () => {
  const { b, lib, chips } = builder('constants');
  const one = b.add('logic_high', {}, [0, 0]);
  const zero = b.add('logic_low', {}, [0, 40]);
  const and = b.add('and_gate', { style: 'ideal', inputs: 2 }, [60, 0]);
  const or = b.add('or_gate', { style: 'ideal', inputs: 2 }, [60, 40]);
  b.at(one, 'OUT', 'one').at(zero, 'OUT', 'zero');
  b.at(and, 'IN1', 'one').at(and, 'IN2', 'zero').at(and, 'OUT', 'and_out');
  b.at(or, 'IN1', 'one').at(or, 'IN2', 'zero').at(or, 'OUT', 'or_out');
  const nl = flattenCircuit(b.finish(), lib, chips, { allowWarnings: true });
  assertEqual(nl.elementCount, 4, 'two sources and two gates');
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  sim.settle();
  const name = (n: number): string => g.netName(n);
  const at = (n: string): number => [...Array(g.netCount).keys()].find((i) => name(i) === n)!;
  assertEqual(Number(sim.sample(at('one'), 0)), 1, 'logic_high output');
  assertEqual(Number(sim.sample(at('zero'), 0)), 0, 'logic_low output');
  assertEqual(Number(sim.sample(at('and_out'), 0)), 0, 'AND of one and zero');
  assertEqual(Number(sim.sample(at('or_out'), 0)), 1, 'OR of one and zero');
});

test('decoder_3to8: all eight codes one-hot, and EN = 0 forces every output low', () => {
  const p = referenceProject('decoder');
  const h = chipHarness(p, 'decoder_3to8');
  h.settle();
  for (let code = 0; code < 8; code++) {
    h.set('en', 1);
    h.setBus('s', code, 3);
    h.settle();
    for (let y = 0; y < 8; y++) assertEqual(h.get(`y${y}`), y === code ? 1 : 0, `en=1, code ${code}, output ${y}`);
  }
  // Regression: the enable must dominate a non-zero select, not just the 000 case.
  for (const code of [1, 3, 5, 7]) {
    h.set('en', 0);
    h.setBus('s', code, 3);
    h.settle();
    for (let y = 0; y < 8; y++) assertEqual(h.get(`y${y}`), 0, `en=0, code ${code}, output ${y} must be low`);
  }
});

test('register_n: reset, load on the clock edge, hold when EN is low', () => {
  const p = referenceProject('register');
  const h = chipHarness(p, 'register_n');
  h.set('rst', 1);
  h.set('en', 0);
  h.settle();
  h.pulse();
  h.set('rst', 0);
  assertEqual(h.getBus('q', 8), 0, 'reset state');

  // EN low: the accumulator-style register must not follow D.
  h.setBus('d', 5, 8);
  h.set('en', 0);
  h.settle();
  h.pulse(2);
  assertEqual(h.getBus('q', 8), 0, 'EN = 0 holds the old value');

  h.set('en', 1);
  h.settle();
  h.pulse();
  assertEqual(h.getBus('q', 8), 5, 'loaded 5 while EN = 1');

  h.setBus('d', 10, 8);
  h.set('en', 0);
  h.settle();
  h.pulse(3);
  assertEqual(h.getBus('q', 8), 5, 'D changed while disabled: Q must hold 5');
});

test('counter_n: counts on the clock, loads a value, holds when EN is low', () => {
  const p = referenceProject('counter');
  const h = chipHarness(p, 'counter_n');
  h.set('rst', 1);
  h.set('en', 0);
  h.settle();
  h.pulse();
  h.set('rst', 0);
  h.set('en', 1);
  h.settle();
  h.pulse(3);
  assertEqual(h.getBus('q', 8), 3, 'three counted edges');

  h.setBus('l', 9, 8);
  h.set('load', 1);
  h.settle();
  h.pulse();
  assertEqual(h.getBus('q', 8), 9, 'loaded 9');

  h.set('load', 0);
  h.set('en', 0);
  h.settle();
  h.pulse(4);
  assertEqual(h.getBus('q', 8), 9, 'EN = 0 freezes the counter');
});

test('alu_n: the op code table, carry and zero flag', () => {
  const p = referenceProject('alu');
  const h = chipHarness(p, 'alu_n');
  const run = (a: number, b: number, op: number): { s: number; c: number; z: number } => {
    h.setBus('a', a, 8);
    h.setBus('b', b, 8);
    h.setBus('op', op, 3);
    h.settle();
    return { s: h.getBus('s', 8), c: h.get('c'), z: h.get('z') };
  };
  const cases: Array<[number, number, number, number]> = [
    [0b000, 12, 10, 12 & 10],
    [0b001, 12, 10, 12 | 10],
    [0b010, 12, 10, 12 ^ 10],
    [0b100, 12, 10, 22],
    [0b101, 12, 10, 2],
    [0b110, 12, 0, 13],
    [0b111, 12, 0, 11],
  ];
  for (const [op, a, b, want] of cases) {
    assertEqual(run(a, b, op).s, want, `op ${op} on ${a}, ${b}`);
  }
  assertEqual(run(12, 0, 0b011).s, 0xf3, 'op 3 is NOT A');
  assertEqual(run(255, 1, 0b100).s, 0, 'ADD wraps at 8 bits');
  assertEqual(run(255, 1, 0b100).c, 1, 'ADD sets the carry out');
  assertEqual(run(0, 0, 0b001).z, 1, 'zero result sets Z');
  assertEqual(run(0, 1, 0b001).z, 0, 'non-zero result clears Z');
});

test('rom_n: a 16-word table reads back word by word (parameter-dependent interface)', () => {
  const p = referenceProject('rom');
  const program = ['63', '84', '21', '92', '56', '81', '8A', 'F0', '00', '01', '02', '03', 'FE', 'FF', '7F', '80'];
  const h = chipHarness(p, 'rom_n', { words: 16, width: 8, content: program.join(',') });
  assertEqual(h.net('a3') >= 0, true, 'a 16-word ROM has four address pins');
  h.settle();
  for (let address = 0; address < 16; address++) {
    h.setBus('a', address, 4);
    h.settle();
    assertEqual(h.getBus('d', 8), parseInt(program[address], 16), `rom[${address}]`);
  }
});

test('ram_n: writes on the clock while WE is high, reads back, holds the rest', () => {
  const p = referenceProject('ram');
  const h = chipHarness(p, 'ram_n', { words: 4, width: 4 });
  h.set('clk', 0);
  h.set('we', 0);
  h.settle();
  const write = (address: number, value: number): void => {
    h.set('we', 1);
    h.setBus('a', address, 2);
    h.setBus('di', value, 4);
    h.settle();
    h.set('clk', 1);
    h.sim.run(1);
    h.set('clk', 0);
    h.sim.run(1);
  };
  const read = (address: number): number => {
    h.set('we', 0);
    h.setBus('a', address, 2);
    h.settle();
    return h.getBus('do', 4);
  };
  write(1, 3);
  write(3, 9);
  assertEqual(read(1), 3, 'address 1 after writing 3');
  assertEqual(read(3), 9, 'address 3 after writing 9');
  assertEqual(read(0), 0, 'address 0 was never written');
  assertEqual(read(2), 0, 'address 2 was never written');
  // Writing must not disturb the other cells.
  write(0, 15);
  assertEqual(read(0), 15, 'address 0 after writing 15');
  assertEqual(read(1), 3, 'address 1 unchanged');
  assertEqual(read(3), 9, 'address 3 unchanged');
});

test('cpu8: the demo program runs to completion (A = 14, PC = 7, HALT = 1)', () => {
  const p = referenceProject('cpu');
  const h = chipHarness(p, 'cpu8', { program: DEMO_PROGRAM });
  h.set('clk', 0);
  h.set('run', 0);
  h.set('rst', 1);
  h.settle();
  h.pulse();
  h.set('rst', 0);
  h.set('run', 1);
  h.settle();
  assertEqual(h.getBus('a', 8), 0, 'accumulator cleared by reset');
  assertEqual(h.getBus('pc', 4), 0, 'PC cleared by reset');

  let edges = 0;
  for (let i = 0; i < 20 && h.get('halt') !== 1; i++) {
    h.pulse();
    edges++;
  }
  assertEqual(h.get('halt'), 1, 'HALT must be reached');
  assertEqual(h.getBus('a', 8), 14, 'accumulator after the demo program');
  assertEqual(h.getBus('pc', 4), 7, 'PC stops at the halt instruction');
  assertEqual(edges, 7, 'one edge per instruction (LDA, ADD, XOR, SUB, JMP, ADD, HLT)');
  // HALT is sticky: more clock edges must not change anything.
  h.pulse(3);
  assertEqual(h.getBus('a', 8), 14, 'accumulator after HALT');
  assertEqual(h.getBus('pc', 4), 7, 'PC after HALT');
});

test('cpu8: a second program exercises NOT, ADD with carry, INC and DEC', () => {
  const p = referenceProject('cpu2');
  // Opcode in the high nibble: 30 = NOT A, 8F = ADD 15, A0 = INC A, B0 = DEC A, F0 = HLT.
  const program = ['30', '8F', 'A0', 'B0', 'F0', '00', '00', '00', '00', '00', '00', '00', '00', '00', '00', '00'];
  const h = chipHarness(p, 'cpu8', { program: program.join(',') });
  h.set('clk', 0);
  h.set('run', 1);
  h.set('rst', 1);
  h.settle();
  h.pulse();
  h.set('rst', 0);
  h.settle();
  let edges = 0;
  for (let i = 0; i < 20 && h.get('halt') !== 1; i++) {
    h.pulse();
    edges++;
  }
  // NOT 0 = 0xFF, +15 = 0x0E (with carry), INC = 0x0F, DEC = 0x0E, HLT.
  assertEqual(h.get('halt'), 1, 'HALT must be reached');
  assertEqual(h.getBus('a', 8), 0x0e, 'accumulator after NOT/ADD/INC/DEC');
  assertEqual(edges, 5, 'one edge per instruction');
});

test('a chip that is not registered is refused with an actionable error (CF4004)', () => {
  const p = new Project('missing-chip');
  const b = new CircuitBuilder(p.lib, 'root', p.chips);
  let code = '';
  let message = '';
  try {
    p.instantiate(b, 'not1', {}, [0, 0]);
  } catch (err) {
    assert(err instanceof Error, 'thrown diagnostics are real Errors');
    code = (err as { code?: string }).code ?? '';
    message = err.message;
  }
  assertEqual(code, 'CF4004', 'the error carries the CF4004 diagnostic code');
  assert(message.includes('CF4004') && message.includes('not1'), `the error must name the missing chip, got "${message}"`);
});

test('a generator that throws at flatten time becomes a CF5005 diagnostic, not a crash', () => {
  const p = new Project('broken-generator');
  parametricChip(p, {
    id: 'flaky',
    name: 'FLAKY',
    description: 'Builds fine with the default parameters, throws for any other set.',
    params: [{ name: 'width', kind: 'number', unit: '', default: 1, min: 1, max: 4, description: 'Lanes' }],
    tags: ['test'],
    generator: (b, params) => {
      if (Number(params['width']) > 1) throw new Error('generator deliberately broken');
      b.port('A', 'input', 'a', 1);
      b.port('Y', 'output', 'y', 1);
      const buf = b.add('buffer', { style: 'ideal' }, [0, 0]);
      b.at(buf, 'IN1', 'a').at(buf, 'OUT', 'y');
    },
  });
  const b = new CircuitBuilder(p.lib, 'root', p.chips);
  const inst = p.instantiate(b, 'flaky', { width: 3 }, [0, 0]);
  b.port('A', 'input', 'a', 1);
  b.at(inst, 'A', 'a');
  const circuit = b.finish({ erc: false });
  const nl = flatten(circuit, p.lib, p.chips, { ambient: 27 });
  const codes = nl.diagnostics.map((d) => d.code);
  assert(codes.includes('CF5005'), `expected CF5005 for the broken generator, got ${codes.join(', ') || 'nothing'}`);
  assertEqual(nl.elementCount, 0, 'nothing is lowered from a failed chip');
});
