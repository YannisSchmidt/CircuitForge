/**
 * Delay models (D0 declared / T1 illustrative table).
 *
 * The point of these cases is the honesty contract: a table is an *input*, the
 * report always says which model produced its numbers, a declared delay is never
 * silently overridden, and an element the table does not describe contributes 0
 * rather than a guess.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit } from '../sim/helpers.js';
import { buildLogicGraph } from '../../src/engine/analysis/logic.js';
import {
  ILLUSTRATIVE_CMOS_TABLE,
  declaredDelays,
  resolveTimingModel,
  tableDelays,
  tableTimingModel,
} from '../../src/engine/analysis/tech.js';
import { analyzeNetlist } from '../../src/engine/analysis/analyzer.js';
import { LOGIC_FN } from '../../src/engine/analysis/logic.js';
import type { CircuitBuilder } from '../../src/engine/core/build.js';
import type { Library } from '../../src/engine/core/library.js';

suite('timing models');

function chainOf(build: (b: CircuitBuilder) => void) {
  const { b, lib, chips } = builder('tech');
  build(b);
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  return { nl, lib, graph: buildLogicGraph(nl) };
}

/** Four ideal gates in a chain: every model declares 0 ns of delay. */
function idealChain(b: CircuitBuilder): void {
  b.port('A', 'input', 'a', 1);
  b.port('Y', 'output', 'y', 1);
  const gates = [0, 1, 2, 3].map((i) => b.add('and_gate', { style: 'ideal', inputs: 2, tphl: 0, tplh: 0 }, [i * 40, 0]));
  b.at(gates[0], 'IN1', 'a').at(gates[0], 'IN2', 'a').at(gates[0], 'OUT', 'n1');
  b.at(gates[1], 'IN1', 'n1').at(gates[1], 'IN2', 'n1').at(gates[1], 'OUT', 'n2');
  b.at(gates[2], 'IN1', 'n2').at(gates[2], 'IN2', 'n2').at(gates[2], 'OUT', 'n3');
  b.at(gates[3], 'IN1', 'n3').at(gates[3], 'IN2', 'n3').at(gates[3], 'OUT', 'y');
}

test('the default model is the declared-delay model, and it says so', () => {
  const d0 = resolveTimingModel(undefined);
  assertEqual(d0.id, 'D0', 'the default model is D0');
  assertEqual(resolveTimingModel('declared').id, 'D0', '"declared" resolves to D0');
  assert(d0.description.includes('lower bound'), 'D0 admits what a declared 0 means');
});

test('the illustrative table names itself and admits what it is not', () => {
  const t1 = resolveTimingModel('illustrative');
  assertEqual(t1.id, 'T1', '"illustrative" resolves to the T1 table');
  assertEqual(resolveTimingModel(ILLUSTRATIVE_CMOS_TABLE).id, 'T1', 'a table can be passed directly');
  assert(t1.description.includes('not a measurement'), `the description is explicit (${t1.description.slice(0, 60)}…)`);
  for (const fn of [LOGIC_FN.BUF, LOGIC_FN.NOT, LOGIC_FN.AND, LOGIC_FN.OR, LOGIC_FN.XOR]) {
    const d = ILLUSTRATIVE_CMOS_TABLE.byFunction[fn];
    assert(!!d && d.tphl > 0 && d.tplh > 0, 'every logic function in the table has a positive delay');
  }
});

test('a declared delay wins over the table unless the caller overrides it', () => {
  const { graph } = chainOf((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const g = b.add('and_gate', { style: 'ideal', inputs: 2, tphl: 50e-9, tplh: 50e-9 }, [0, 0]);
    b.at(g, 'IN1', 'a').at(g, 'IN2', 'a').at(g, 'OUT', 'y');
  });
  const el = graph.elements[0];
  const declaredWins = tableTimingModel(ILLUSTRATIVE_CMOS_TABLE)(el, 'fall');
  assertClose(declaredWins, 50e-9, 1e-15, 'the declared 50 ns is used');
  const overridden = tableTimingModel(ILLUSTRATIVE_CMOS_TABLE, { overrideDeclared: true })(el, 'fall');
  assertClose(overridden, ILLUSTRATIVE_CMOS_TABLE.byFunction[LOGIC_FN.AND].tphl, 1e-15, 'the table replaces it on request');
});

test('a function the table does not describe contributes 0, not a guess', () => {
  const { graph } = chainOf(idealChain);
  const empty = tableDelays({ ...ILLUSTRATIVE_CMOS_TABLE, byFunction: {} });
  assertEqual(empty.model(graph.elements[0], 'rise'), 0, 'an unknown function is 0 s');
});

test('a multiplexer costs one table step per select bit (a declared rule of the table)', () => {
  const { graph } = chainOf((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('B', 'input', 'b', 1);
    b.port('Y', 'output', 'y', 1);
    const m = b.add('mux', { channels: 4, selectBits: 2 }, [0, 0]);
    b.at(m, 'I0', 'a').at(m, 'I1', 'b').at(m, 'I2', 'a').at(m, 'I3', 'b').at(m, 'S0', 'a').at(m, 'S1', 'b').at(m, 'Y', 'y');
  });
  const mux = graph.elements.find((el) => el.kind === 'mux');
  assert(!!mux, 'the mux element is in the graph');
  const model = tableTimingModel(ILLUSTRATIVE_CMOS_TABLE);
  assertEqual(mux!.selects.length, 2, 'the 4:1 multiplexer has two select bits');
  assertEqual(mux!.selects.length, 2, 'the 4:1 multiplexer has two select bits');
  const steps = Math.max(1, mux!.selects.length);
  assertClose(model(mux!, 'fall'), ILLUSTRATIVE_CMOS_TABLE.mux.tphl * steps, 1e-15, 'one step per select bit');
});

test('the illustrative model gives a nonzero critical path where the declared model gives 0', () => {
  const { nl, lib } = chainOf(idealChain);

  const declared = analyzeNetlist(nl, { lib });
  assertEqual(declared.timingModel.id, 'D0', 'the default analysis uses declared delays');
  assertClose(declared.timing.criticalPath!.delay, 0, 1e-18, 'ideal gates declare 0 ns');
  assert(declared.timing.idealElements > 0, 'the report counts the elements whose model declares no delay');

  const illustrative = analyzeNetlist(nl, { lib, timingModel: 'illustrative' });
  assertEqual(illustrative.timingModel.id, 'T1', 'the report names the table it used');
  const d = illustrative.timing.criticalPath!.delay;
  assert(d > 0, `the illustrative table gives a usable ranking (${d} s)`);
  assertClose(d, 4 * ILLUSTRATIVE_CMOS_TABLE.byFunction[LOGIC_FN.AND].tplh, 1e-15, 'four AND gates of the table');
  assert(
    illustrative.notes.some((n) => n.includes('illustrative') || n.includes('T1')),
    `the note names the model (${illustrative.notes.join(' | ')})`,
  );
  // Both reports describe the same design; only the numbers differ.
  assertEqual(illustrative.timing.criticalPath!.stages, declared.timing.criticalPath!.stages, 'same path, different delays');
});
