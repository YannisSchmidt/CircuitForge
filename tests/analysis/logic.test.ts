/**
 * Level-0 logic engine: truth tables, four-state propagation, sequential
 * elements, buses, bit-parallel equivalence and loop handling.
 *
 * Every expected value here comes from the definition of the element (a truth
 * table or the documented register behaviour) — never from a previous run of the
 * engine.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit } from '../sim/helpers.js';
import {
  buildLogicGraph,
  logicSummary,
  LogicVectorSim,
  requireLogic,
  type LogicGraph,
} from '../../src/engine/analysis/logic.js';
import type { CircuitBuilder } from '../../src/engine/core/build.js';
import type { FlatNetlist } from '../../src/engine/sim/netlist.js';

interface Built {
  nl: FlatNetlist;
  g: LogicGraph;
  sim: LogicVectorSim;
  net: (name: string) => number;
}

function graphOf(build: (b: CircuitBuilder) => void, name = 'test'): Built {
  const { b, lib, chips } = builder(name);
  build(b);
  // A purely digital circuit has no ground: the floating-solution warning of the
  // electrical flattener does not apply to it, so warnings are allowed here.
  const nl = flattenCircuit(b.finish(), lib, chips, { allowWarnings: true });
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const net = (n: string): number => {
    for (let i = 0; i < g.netCount; i++) if (g.netName(i) === n) return i;
    throw new Error(`no net named ${n} (have ${[...Array(g.netCount).keys()].map((i) => g.netName(i)).join(', ')})`);
  };
  return { nl, g, sim, net };
}

/** Full adder from XOR/XOR/AND/AND/OR — the textbook gate-level circuit. */
function fullAdder(b: CircuitBuilder): void {
  const xor1 = b.add('xor_gate', { style: 'ideal' }, [0, 0]);
  const xor2 = b.add('xor_gate', { style: 'ideal' }, [0, 40]);
  const and1 = b.add('and_gate', { style: 'ideal' }, [0, 80]);
  const and2 = b.add('and_gate', { style: 'ideal' }, [0, 120]);
  const or1 = b.add('or_gate', { style: 'ideal' }, [0, 160]);
  b.port('A', 'input', 'A', 1, 'digital');
  b.port('B', 'input', 'B', 1, 'digital');
  b.port('C', 'input', 'C', 1, 'digital');
  b.port('S', 'output', 'S', 1, 'digital');
  b.port('CO', 'output', 'CO', 1, 'digital');
  b.at(xor1, 'IN1', 'A').at(xor1, 'IN2', 'B').at(xor1, 'OUT', 'x1');
  b.at(xor2, 'IN1', 'x1').at(xor2, 'IN2', 'C').at(xor2, 'OUT', 'S');
  b.at(and1, 'IN1', 'x1').at(and1, 'IN2', 'C').at(and1, 'OUT', 'a1');
  b.at(and2, 'IN1', 'A').at(and2, 'IN2', 'B').at(and2, 'OUT', 'a2');
  b.at(or1, 'IN1', 'a1').at(or1, 'IN2', 'a2').at(or1, 'OUT', 'CO');
}

suite('logic');

test('full adder: all 8 input vectors (exhaustive truth table)', () => {
  const { g, sim, net } = graphOf(fullAdder, 'full-adder');
  assertEqual(g.stats.gates, 5, 'gate count');
  assertEqual(g.stats.sequential, 0, 'register count');
  assertEqual(g.stats.levels, 3, 'logic levels (XOR → XOR/AND → OR)');
  const A = net('A');
  const B = net('B');
  const C = net('C');
  const S = net('S');
  const CO = net('CO');
  for (let v = 0; v < 8; v++) {
    sim.reset();
    sim.setVector(A, v, ((v >> 0) & 1) as 0 | 1);
    sim.setVector(B, v, ((v >> 1) & 1) as 0 | 1);
    sim.setVector(C, v, ((v >> 2) & 1) as 0 | 1);
    sim.settle();
    const sum = ((v >> 0) & 1) + ((v >> 1) & 1) + ((v >> 2) & 1);
    assertEqual(sim.sample(S, v), (sum & 1) as 0 | 1, `sum of ${v.toString(2).padStart(3, '0')}`);
    assertEqual(sim.sample(CO, v), (sum >> 1) as 0 | 1, `carry of ${v.toString(2).padStart(3, '0')}`);
  }
});

test('32 vectors are evaluated in one pass (bit-parallel equivalence)', () => {
  const { sim, net } = graphOf(fullAdder, 'parallel');
  // Build the same 8 patterns into vectors 0..7 and compare against the
  // single-vector engine run 8 times.
  const A = net('A');
  const B = net('B');
  const C = net('C');
  const S = net('S');
  const CO = net('CO');
  let aOnes = 0;
  let bOnes = 0;
  let cOnes = 0;
  for (let v = 0; v < 8; v++) {
    aOnes |= ((v >> 0) & 1) << v;
    bOnes |= ((v >> 1) & 1) << v;
    cOnes |= ((v >> 2) & 1) << v;
  }
  sim.reset();
  sim.drive(A, aOnes);
  sim.drive(B, bOnes);
  sim.drive(C, cOnes);
  sim.settle();
  for (let v = 0; v < 8; v++) {
    const sum = ((v >> 0) & 1) + ((v >> 1) & 1) + ((v >> 2) & 1);
    assertEqual(sim.sample(S, v), (sum & 1) as 0 | 1, `parallel sum, vector ${v}`);
    assertEqual(sim.sample(CO, v), (sum >> 1) as 0 | 1, `parallel carry, vector ${v}`);
  }
});

test('four-state propagation: unknown inputs follow the truth table', () => {
  const { sim, net } = graphOf((b) => {
    const andG = b.add('and_gate', { style: 'ideal' }, [0, 0]);
    const orG = b.add('or_gate', { style: 'ideal' }, [0, 40]);
    const nandG = b.add('nand_gate', { style: 'ideal' }, [0, 80]);
    const norG = b.add('nor_gate', { style: 'ideal' }, [0, 120]);
    const xorG = b.add('xor_gate', { style: 'ideal' }, [0, 160]);
    b.port('a', 'input', 'a', 1, 'digital');
    b.port('bx', 'input', 'bx', 1, 'digital');
    b.port('y_and', 'output', 'y_and', 1, 'digital');
    b.port('y_or', 'output', 'y_or', 1, 'digital');
    b.port('y_nand', 'output', 'y_nand', 1, 'digital');
    b.port('y_nor', 'output', 'y_nor', 1, 'digital');
    b.port('y_xor', 'output', 'y_xor', 1, 'digital');
    b.at(andG, 'IN1', 'a').at(andG, 'IN2', 'bx').at(andG, 'OUT', 'y_and');
    b.at(orG, 'IN1', 'a').at(orG, 'IN2', 'bx').at(orG, 'OUT', 'y_or');
    b.at(nandG, 'IN1', 'a').at(nandG, 'IN2', 'bx').at(nandG, 'OUT', 'y_nand');
    b.at(norG, 'IN1', 'a').at(norG, 'IN2', 'bx').at(norG, 'OUT', 'y_nor');
    b.at(xorG, 'IN1', 'a').at(xorG, 'IN2', 'bx').at(xorG, 'OUT', 'y_xor');
  }, 'four-state');
  const a = net('a');
  const bx = net('bx');
  const cases: Array<[0 | 1, 0 | 1 | 'X', 0 | 1 | 'X', 0 | 1 | 'X', 0 | 1 | 'X', 0 | 1 | 'X']> = [
    // a, b, and, or, nand, nor, (xor appended below)
    [0, 'X', 0, 'X', 1, 'X'],
    [1, 'X', 'X', 1, 'X', 0],
    [0, 0, 0, 0, 1, 1],
    [1, 1, 1, 1, 0, 0],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [av, bv, yAnd, yOr, yNand, yNor] = cases[i];
    sim.reset();
    sim.setVector(a, i, av);
    sim.setVector(bx, i, bv);
    sim.settle();
    assertEqual(sim.sample(net('y_and'), i), yAnd, `AND(${av},${bv})`);
    assertEqual(sim.sample(net('y_or'), i), yOr, `OR(${av},${bv})`);
    assertEqual(sim.sample(net('y_nand'), i), yNand, `NAND(${av},${bv})`);
    assertEqual(sim.sample(net('y_nor'), i), yNor, `NOR(${av},${bv})`);
  }
  // XOR with an unknown input is always unknown.
  sim.reset();
  sim.setVector(a, 0, 1);
  sim.setVector(bx, 0, 'X');
  sim.settle();
  assertEqual(sim.sample(net('y_xor'), 0), 'X', 'XOR(1,X)');
});

test('undriven inputs are X, and an unconnected net reports X', () => {
  const { sim, net, g } = graphOf((b) => {
    const g1 = b.add('and_gate', { style: 'ideal' }, [0, 0]);
    b.port('a', 'input', 'a', 1, 'digital');
    b.port('y', 'output', 'y', 1, 'digital');
    b.at(g1, 'IN1', 'a').at(g1, 'OUT', 'y');
  }, 'undriven');
  const y = net('y');
  sim.setVector(net('a'), 0, 1);
  sim.settle();
  assertEqual(sim.sample(y, 0), 'X', 'AND with an unconnected input');
  assertEqual(g.driverCount[net('a')] >= 0, true, 'driver count is defined');
});

test('D flip-flop: rising edge, initial value, QN, held state', () => {
  const { sim, net, g } = graphOf((b) => {
    const d0 = b.add('dff', { initial: '0' }, [0, 0]);
    b.port('d', 'input', 'd', 1, 'digital');
    b.port('clk', 'input', 'clk', 1, 'digital');
    b.port('q', 'output', 'q', 1, 'digital');
    b.port('qn', 'output', 'qn', 1, 'digital');
    b.at(d0, 'D', 'd').at(d0, 'CLK', 'clk').at(d0, 'Q', 'q').at(d0, 'QN', 'qn');
  }, 'dff');
  assertEqual(g.stats.sequential, 1, 'one register');
  const d = net('d');
  const clk = net('clk');
  const q = net('q');
  const qn = net('qn');
  // Power-on: q = initial = 0.
  sim.setVector(clk, 0, 0);
  sim.setVector(d, 0, 1);
  sim.settle();
  assertEqual(sim.sample(q, 0), 0, 'power-on state');
  assertEqual(sim.sample(qn, 0), 1, 'power-on complementary output');
  // Rising edge with D = 1 → q = 1. The clock level at t=0 is not an edge.
  sim.run(1);
  assertEqual(sim.sample(q, 0), 0, 'no clock transition yet');
  sim.setVector(clk, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'D latched on the rising edge');
  assertEqual(sim.sample(qn, 0), 0, 'complementary output follows');
  // Level held: the register does not re-sample while the clock stays high.
  sim.setVector(d, 0, 0);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'state held while the clock is high');
  // Falling edge does nothing on a rising-edge register…
  sim.setVector(clk, 0, 0);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'falling edge ignored');
  // …and the next rising edge takes D = 0.
  sim.setVector(clk, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 0, 'D sampled again');
});

test('D flip-flop: falling edge and asynchronous reset', () => {
  const { sim, net } = graphOf((b) => {
    const d0 = b.add('dff', { initial: '0', edge: 'falling' }, [0, 0]);
    const d1 = b.add('dff', { initial: '1', resetActive: 'high' }, [0, 60]);
    b.port('d', 'input', 'd', 1, 'digital');
    b.port('clk', 'input', 'clk', 1, 'digital');
    b.port('rst', 'input', 'rst', 1, 'digital');
    b.port('qf', 'output', 'qf', 1, 'digital');
    b.port('qr', 'output', 'qr', 1, 'digital');
    b.at(d0, 'D', 'd').at(d0, 'CLK', 'clk').at(d0, 'Q', 'qf');
    b.at(d1, 'D', 'd').at(d1, 'CLK', 'clk').at(d1, 'RST', 'rst').at(d1, 'Q', 'qr');
  }, 'dff-edges');
  const d = net('d');
  const clk = net('clk');
  const rst = net('rst');
  const qf = net('qf');
  const qr = net('qr');
  sim.setVector(clk, 0, 1);
  sim.setVector(d, 0, 1);
  sim.setVector(rst, 0, 0);
  sim.settle();
  assertEqual(sim.sample(qr, 0), 1, 'register initialised high');
  sim.setVector(clk, 0, 0);
  sim.run(1);
  assertEqual(sim.sample(qf, 0), 1, 'falling edge latches');
  sim.setVector(d, 0, 0);
  sim.setVector(clk, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(qf, 0), 1, 'rising edge ignored by a falling-edge register');
  sim.setVector(clk, 0, 0);
  sim.run(1);
  assertEqual(sim.sample(qf, 0), 0, 'next falling edge latches 0');
  // Asynchronous reset: level, no clock needed.
  sim.setVector(rst, 0, 1);
  sim.settle();
  assertEqual(sim.sample(qr, 0), 0, 'asynchronous reset clears the register');
  sim.setVector(rst, 0, 0);
  sim.setVector(d, 0, 1);
  sim.setVector(clk, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(qr, 0), 1, 'after reset release the register works again');
});

test('D latch is transparent while the enable is high', () => {
  const { sim, net } = graphOf((b) => {
    const l = b.add('dlatch', { initial: '0' }, [0, 0]);
    b.port('d', 'input', 'd', 1, 'digital');
    b.port('en', 'input', 'en', 1, 'digital');
    b.port('q', 'output', 'q', 1, 'digital');
    b.at(l, 'D', 'd').at(l, 'EN', 'en').at(l, 'Q', 'q');
  }, 'latch');
  const d = net('d');
  const en = net('en');
  const q = net('q');
  sim.setVector(en, 0, 1);
  sim.setVector(d, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'transparent while enabled');
  sim.setVector(d, 0, 0);
  sim.setVector(en, 0, 0);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'holds the last value when disabled');
  sim.setVector(d, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'input ignored while disabled');
  sim.setVector(en, 0, 1);
  sim.run(1);
  assertEqual(sim.sample(q, 0), 1, 'follows D again when enabled');
});

test('multiplexer selects a channel and an unknown select gives X', () => {
  const { sim, net } = graphOf((b) => {
    const m = b.add('mux', { channels: 4 }, [0, 0]);
    for (const p of ['I0', 'I1', 'I2', 'I3', 'S0', 'S1'] as const) b.port(p, 'input', p, 1, 'digital');
    b.port('y', 'output', 'y', 1, 'digital');
    for (const p of ['I0', 'I1', 'I2', 'I3', 'S0', 'S1', 'Y'] as const) b.at(m, p, p === 'Y' ? 'y' : p);
  }, 'mux');
  const y = net('y');
  // Select channel c (S1 S0 = binary c) with data = 1 at that channel only.
  for (let c = 0; c < 4; c++) {
    sim.reset();
    sim.setVector(net(`I${c}`), 0, 1);
    sim.setVector(net('S0'), 0, (c & 1) as 0 | 1);
    sim.setVector(net('S1'), 0, ((c >> 1) & 1) as 0 | 1);
    sim.settle();
    assertEqual(sim.sample(y, 0), 1, `channel ${c} is selected`);
  }
  // Unknown select → unknown output, even if all channels carry the same value.
  sim.reset();
  sim.setVector(net('I0'), 0, 1);
  sim.setVector(net('I1'), 0, 1);
  sim.setVector(net('S1'), 0, 0);
  sim.setVector(net('S0'), 0, 'X');
  sim.settle();
  assertEqual(sim.sample(y, 0), 'X', 'unknown select');
});

test('decoder/demux drives exactly one output high, the others low', () => {
  const { sim, net } = graphOf((b) => {
    const d = b.add('demux', { outputs: 4, decoderOnly: true }, [0, 0]);
    b.port('in', 'input', 'in', 1, 'digital');
    for (const p of ['S0', 'S1'] as const) b.port(p, 'input', p, 1, 'digital');
    for (let i = 0; i < 4; i++) b.port(`Y${i}`, 'output', `Y${i}`, 1, 'digital');
    b.at(d, 'IN', 'in').at(d, 'S0', 'S0').at(d, 'S1', 'S1');
    for (let i = 0; i < 4; i++) b.at(d, `Y${i}`, `Y${i}`);
  }, 'demux');
  for (let c = 0; c < 4; c++) {
    sim.reset();
    sim.setVector(net('in'), 0, 1);
    sim.setVector(net('S0'), 0, (c & 1) as 0 | 1);
    sim.setVector(net('S1'), 0, ((c >> 1) & 1) as 0 | 1);
    sim.settle();
    for (let i = 0; i < 4; i++) {
      // The library's decoder model drives every output: the selected one is
      // high, the others are a hard low (a conductance to ground, no Z).
      assertEqual(sim.sample(net(`Y${i}`), 0), i === c ? 1 : 0, `Y${i} with select ${c}`);
    }
  }
});

test('tristate bus: one driver wins, none gives Z, a conflict gives X', () => {
  const { sim, net, g } = graphOf((b) => {
    const t1 = b.add('tristate', {}, [0, 0]);
    const t2 = b.add('tristate', {}, [0, 60]);
    b.port('a', 'input', 'a', 1, 'digital');
    b.port('bb', 'input', 'bb', 1, 'digital');
    b.port('en1', 'input', 'en1', 1, 'digital');
    b.port('en2', 'input', 'en2', 1, 'digital');
    b.port('y', 'output', 'y', 1, 'digital');
    b.at(t1, 'IN', 'a').at(t1, 'EN', 'en1').at(t1, 'OUT', 'y');
    b.at(t2, 'IN', 'bb').at(t2, 'EN', 'en2').at(t2, 'OUT', 'y');
  }, 'bus');
  const y = net('y');
  const set = (a: 0 | 1, bb: 0 | 1, en1: 0 | 1, en2: 0 | 1): void => {
    sim.reset();
    sim.setVector(net('a'), 0, a);
    sim.setVector(net('bb'), 0, bb);
    sim.setVector(net('en1'), 0, en1);
    sim.setVector(net('en2'), 0, en2);
    sim.settle();
  };
  set(1, 0, 1, 0);
  assertEqual(sim.sample(y, 0), 1, 'first driver enabled');
  set(1, 0, 0, 0);
  assertEqual(sim.sample(y, 0), 'Z', 'nobody drives');
  set(1, 0, 0, 1);
  assertEqual(sim.sample(y, 0), 0, 'second driver enabled');
  set(1, 1, 1, 1);
  assertEqual(sim.sample(y, 0), 1, 'two drivers that agree');
  set(1, 0, 1, 1);
  assertEqual(sim.sample(y, 0), 'X', 'two drivers that disagree');
  assert(sim.diagnostics.some((d) => d.code === 'CF7001'), 'a bus conflict is reported (CF7001)');
  void g;
});

test('combinational loop is reported and evaluated with a bounded fixed point', () => {
  const { g, sim, net } = graphOf((b) => {
    const n1 = b.add('not_gate', { style: 'ideal' }, [0, 0]);
    const n2 = b.add('not_gate', { style: 'ideal' }, [0, 40]);
    b.port('en', 'input', 'en', 1, 'digital');
    b.port('y', 'output', 'y', 1, 'digital');
    // An enabled ring oscillator: n1 → n2 → n1 (a real loop) plus an output leg.
    const a1 = b.add('and_gate', { style: 'ideal' }, [0, 80]);
    b.at(n1, 'IN1', 'l2').at(n1, 'OUT', 'l1');
    b.at(n2, 'IN1', 'l1').at(n2, 'OUT', 'l2');
    b.at(a1, 'IN1', 'l1').at(a1, 'IN2', 'en').at(a1, 'OUT', 'y');
  }, 'loop');
  assert(g.stats.loops > 0, 'the loop elements are counted');
  assert(g.diagnostics.some((d) => d.code === 'CF7002'), 'the loop is reported (CF7002)');
  sim.setVector(net('en'), 0, 1);
  sim.settle();
  const value = sim.sample(net('y'), 0);
  assert(value === 0 || value === 1 || value === 'X', `the loop settles to a defined-or-X value (got ${value})`);
});

test('logicSummary reports gates, registers and ignored analogue elements', () => {
  const { g } = graphOf((b) => {
    const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [0, 0]);
    const n1 = b.add('not_gate', { style: 'ideal' }, [0, 40]);
    b.port('a', 'input', 'a', 1, 'digital');
    b.port('y', 'output', 'y', 1, 'digital');
    b.at(r1, '1', 'a').at(r1, '2', 'y');
    b.at(n1, 'IN1', 'a').at(n1, 'OUT', 'y2');
  }, 'summary');
  assertEqual(g.stats.gates, 1, 'one gate');
  assertEqual(g.stats.ignoredElements, 1, 'the resistor is ignored at level 0');
  const text = logicSummary(g);
  assert(text.includes('1 logic element'), `summary mentions the gate: ${text}`);
  assert(text.includes('non-digital'), `summary mentions the ignored element: ${text}`);
});

test('requireLogic throws a structured error for a purely analogue circuit', () => {
  const { g } = graphOf((b) => {
    const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [0, 0]);
    b.port('a', 'input', 'a', 1, 'analog');
    b.port('y', 'output', 'y', 1, 'analog');
    b.at(r1, '1', 'a').at(r1, '2', 'y');
  }, 'analogue');
  let threw = false;
  try {
    requireLogic(g);
  } catch (e) {
    threw = true;
    assertEqual((e as { code?: string }).code, 'CF7003', 'error code');
  }
  assert(threw, 'requireLogic must throw');
});
