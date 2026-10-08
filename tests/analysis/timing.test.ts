/**
 * Static timing analysis: longest path with the real chain of elements, the
 * synchronous period bound, unate edge propagation and the honest reporting of
 * elements that declare no delay.
 *
 * All expectations are simple arithmetic on the declared delays.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit } from '../sim/helpers.js';
import { buildLogicGraph, type LogicGraph } from '../../src/engine/analysis/logic.js';
import { analyzeTiming, describePath, gatePolarity, declaredTimingModel } from '../../src/engine/analysis/timing.js';
import type { CircuitBuilder } from '../../src/engine/core/build.js';

function graphOf(build: (b: CircuitBuilder) => void, name = 'timing'): LogicGraph {
  const { b, lib, chips } = builder(name);
  build(b);
  return buildLogicGraph(flattenCircuit(b.finish(), lib, chips, { allowWarnings: true }));
}

suite('timing');

test('a chain of 4 gates gives 4 × tplh and a path with the real gate chain', () => {
  const g = graphOf((b) => {
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    const gates = [] as ReturnType<CircuitBuilder['add']>[];
    for (let i = 0; i < 4; i++) gates.push(b.add('and_gate', { style: 'ideal', tphl: 3e-9, tplh: 5e-9 }, [0, i * 40]));
    b.at(gates[0], 'IN1', 'in').at(gates[0], 'IN2', 'in').at(gates[0], 'OUT', 'n1');
    b.at(gates[1], 'IN1', 'n1').at(gates[1], 'IN2', 'n1').at(gates[1], 'OUT', 'n2');
    b.at(gates[2], 'IN1', 'n2').at(gates[2], 'IN2', 'n2').at(gates[2], 'OUT', 'n3');
    b.at(gates[3], 'IN1', 'n3').at(gates[3], 'IN2', 'n3').at(gates[3], 'OUT', 'out');
  }, 'chain');
  const r = analyzeTiming(g);
  assertClose(r.combinationalDelay ?? NaN, 20e-9, 1e-15, 'combinational delay = 4 × 5 ns');
  assert(!!r.criticalPath, 'a critical path exists');
  const path = r.criticalPath!;
  assertEqual(path.stages, 4, 'four elements on the path');
  assertEqual(path.endKind, 'output', 'the path ends on an output');
  assertEqual(path.startKind, 'input', 'the path starts at an input');
  assertEqual(path.idealStages, 0, 'no ideal element on the path');
  // The path is reported as the actual chain of references.
  const chain = path.steps.map((s) => s.element?.ref).join('→');
  assert(chain.length > 0 && path.steps.every((s) => s.delay === 5e-9), `chain delays: ${chain}`);
  assert(describePath(path, g.netName).includes('→'), 'the description lists the chain');
});

test('critical path picks the slowest branch, not the first one', () => {
  const g = graphOf((b) => {
    const fast = b.add('and_gate', { style: 'ideal', tphl: 1e-9, tplh: 1e-9 }, [0, 0]);
    const mid = b.add('and_gate', { style: 'ideal', tphl: 2e-9, tplh: 2e-9 }, [0, 40]);
    const slow = b.add('or_gate', { style: 'ideal', tphl: 9e-9, tplh: 9e-9 }, [0, 80]);
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(fast, 'IN1', 'in').at(fast, 'IN2', 'in').at(fast, 'OUT', 'fast');
    b.at(mid, 'IN1', 'fast').at(mid, 'IN2', 'fast').at(mid, 'OUT', 'mid');
    b.at(slow, 'IN1', 'in').at(slow, 'IN2', 'in').at(slow, 'OUT', 'slow_out');
    // out = slow_out OR mid  → the worst arrival is max(9, 1+2) + 9 = 18 ns
    const merge = b.add('or_gate', { style: 'ideal', tphl: 9e-9, tplh: 9e-9 }, [0, 120]);
    b.at(merge, 'IN1', 'slow_out').at(merge, 'IN2', 'mid').at(merge, 'OUT', 'out');
  }, 'branches');
  const r = analyzeTiming(g);
  assertClose(r.combinationalDelay ?? NaN, 18e-9, 1e-15, 'worst arrival = 9 ns + 9 ns');
  assertEqual(r.criticalPath?.stages, 2, 'the critical path has two stages');
});

test('register-to-register path bounds the clock period', () => {
  const g = graphOf((b) => {
    const d0 = b.add('dff', { initial: '0', tckq: 2e-9, setup: 1e-9 }, [0, 0]);
    const d1 = b.add('dff', { initial: '0', tckq: 2e-9, setup: 1e-9 }, [0, 60]);
    const g1 = b.add('and_gate', { style: 'ideal', tphl: 4e-9, tplh: 4e-9 }, [0, 120]);
    const g2 = b.add('not_gate', { style: 'ideal', tphl: 3e-9, tplh: 3e-9 }, [0, 160]);
    b.port('clk', 'input', 'clk', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(d1, 'CLK', 'clk');
    b.at(d0, 'D', 'q1').at(d0, 'CLK', 'clk').at(d0, 'Q', 'q0');
    b.at(g1, 'IN1', 'q0').at(g1, 'IN2', 'q0').at(g1, 'OUT', 'c1');
    b.at(g2, 'IN1', 'c1').at(g2, 'OUT', 'c2');
    b.at(d1, 'D', 'c2');
    b.at(d1, 'Q', 'q1');
  }, 'register-path');
  const r = analyzeTiming(g);
  // Period ≥ tckq + tcomb + setup = 2 + 4 + 3 + 1 = 10 ns
  assertClose(r.clockPeriod ?? NaN, 10e-9, 1e-15, 'period bound');
  assertClose(r.maxFrequency ?? NaN, 1 / 10e-9, 1, 'frequency bound');
  assert(!!r.criticalRegisterPath, 'a register-to-register path exists');
  assertEqual(r.criticalRegisterPath!.startKind, 'register', 'starts at a register');
  assertEqual(r.criticalRegisterPath!.endKind, 'register', 'ends on a register');
  assertEqual(r.criticalRegisterPath!.stages, 2, 'two gates between the registers');
  assertClose(r.criticalRegisterPath!.setup, 1e-9, 1e-18, 'setup of the capturing register');
});

test('elements with no declared delay are reported and the total is a lower bound', () => {
  const g = graphOf((b) => {
    const g1 = b.add('and_gate', { style: 'ideal' }, [0, 0]); // ideal → 0 s
    const g2 = b.add('or_gate', { style: 'ideal', tphl: 4e-9, tplh: 6e-9 }, [0, 40]);
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(g1, 'IN1', 'in').at(g1, 'IN2', 'in').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'n1').at(g2, 'IN2', 'n1').at(g2, 'OUT', 'out');
  }, 'ideal-delays');
  const r = analyzeTiming(g);
  assertEqual(r.idealDelays.length, 1, 'one element with no delay');
  assert(r.diagnostics.some((d) => d.code === 'CF7101'), 'the lower bound is reported (CF7101)');
  assertClose(r.combinationalDelay ?? NaN, 6e-9, 1e-15, 'the declared delay still counts');
  assertEqual(r.criticalPath?.idealStages, 1, 'the ideal stage is flagged in the path');
});

test('unate propagation: an inverter inverts the edge that arrives', () => {
  // Two inputs, one slow rising (10 ns), one fast rising (1 ns); a NOT gate after
  // the slow one is the critical path for a rising output of the inverter.
  const g = graphOf((b) => {
    const slow = b.add('and_gate', { style: 'ideal', tphl: 1e-9, tplh: 10e-9 }, [0, 0]);
    const fast = b.add('and_gate', { style: 'ideal', tphl: 1e-9, tplh: 1e-9 }, [0, 40]);
    const inv = b.add('not_gate', { style: 'ideal', tphl: 2e-9, tplh: 2e-9 }, [0, 80]);
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(slow, 'IN1', 'in').at(slow, 'IN2', 'in').at(slow, 'OUT', 's1');
    b.at(fast, 'IN1', 'in').at(fast, 'IN2', 'in').at(fast, 'OUT', 'f1');
    b.at(inv, 'IN1', 's1').at(inv, 'OUT', 'out');
  }, 'unate');
  const r = analyzeTiming(g);
  const inv = g.elements.find((e) => e.fn === 1);
  assertEqual(gatePolarity(inv!), 'negative', 'an inverter is negative unate');
  // A rising edge at s1 (10 ns) falls out of the inverter at 12 ns; the fastest
  // path to a rising output is 1 + 2 = 3 ns through the wrong branch, so the
  // worst arrival is 12 ns.
  assertClose(r.combinationalDelay ?? NaN, 12e-9, 1e-15, 'worst arrival over both polarities');
});

test('declaredTimingModel reads the parameters of the element', () => {
  const g = graphOf((b) => {
    const g1 = b.add('and_gate', { style: 'ideal', tphl: 7e-9, tplh: 11e-9 }, [0, 0]);
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(g1, 'IN1', 'in').at(g1, 'IN2', 'in').at(g1, 'OUT', 'out');
  }, 'model');
  const el = g.elements[0];
  assertClose(declaredTimingModel(el, 'rise'), 11e-9, 1e-18, 'tplh');
  assertClose(declaredTimingModel(el, 'fall'), 7e-9, 1e-18, 'tphl');
});

test('a purely combinational circuit reports a combinational delay, no clock bound', () => {
  const g = graphOf((b) => {
    const g1 = b.add('not_gate', { style: 'ideal', tphl: 1e-9, tplh: 1e-9 }, [0, 0]);
    b.port('in', 'input', 'in', 1, 'digital');
    b.port('out', 'output', 'out', 1, 'digital');
    b.at(g1, 'IN1', 'in').at(g1, 'OUT', 'out');
  }, 'comb');
  const r = analyzeTiming(g);
  assertEqual(r.clockPeriod, null, 'no clock bound without registers');
  assertEqual(r.maxFrequency, null, 'no frequency without a clock');
  assertClose(r.combinationalDelay ?? NaN, 1e-9, 1e-18, 'one gate delay');
  assertEqual(r.idealDelays.length, 0, 'the gate declares a delay');
});
