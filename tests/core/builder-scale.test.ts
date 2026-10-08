/**
 * Construction at scale, and the reference designators it hands out.
 *
 * The regressions here are the ones a benchmark found: building a sheet used to be
 * quadratic, because every pin connection scanned every net and every new
 * component rebuilt the set of all reference designators. A 10 000-gate sheet cost
 * 22.6 s in the builder against 119 ms in the flattener — the design was fine, the
 * construction was not. These tests keep it linear and keep the refs correct while
 * it is.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { ChipLibrary } from '../../src/engine/core/chip.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';
import { Rng } from '../../src/engine/util/rng.js';

suite('builder at scale');

const lib = createDefaultLibrary();

/** A chain of `n` two-input gates over 32-bit nets, the shape a big sheet has. */
function gateSheet(n: number, seed = 'scale'): { builder: CircuitBuilder; gates: number } {
  const rng = new Rng(seed);
  const b = new CircuitBuilder(lib, `sheet_${n}`);
  b.port('IN0', 'input', 'in0', 32);
  b.port('IN1', 'input', 'in1', 32);
  const pool = ['in0', 'in1'];
  for (let i = 0; i < n; i++) {
    const inst = b.add(rng.chance(0.15) ? 'not_gate' : 'and_gate', { inputs: rng.chance(0.15) ? 1 : 2 }, [i * 10, 0]);
    b.at(inst, 'IN1', pool[pool.length - 1 - rng.int(Math.min(pool.length, 8))], 32);
    b.at(inst, 'IN2', pool[rng.int(Math.min(pool.length, 8))], 32);
    const out = `n${i}`;
    b.at(inst, 'OUT', out, 32);
    pool.push(out);
  }
  b.port('Y', 'output', pool[pool.length - 1], 32);
  return { builder: b, gates: n };
}

test('building a large sheet stays linear in the number of pins', () => {
  // Not a timing assertion against a wall clock, which would flake on a loaded
  // machine: a bound wide enough that only a quadratic regression breaks it. The
  // measured cost of this sheet is well under a second; the quadratic version took
  // minutes at this size and would take an hour at the sizes the stress suite asks
  // for.
  const n = 20_000;
  const t0 = Date.now();
  const { builder } = gateSheet(n);
  const circuit = builder.finish({ erc: false });
  const elapsed = Date.now() - t0;
  assertEqual(circuit.componentCount(), n, 'every gate landed on the sheet');
  assert(elapsed < 20_000, `20 000 components built in ${elapsed} ms — quadratic construction would take minutes`);
});

test('a large sheet still flattens, evaluates and reports the right size', () => {
  const { builder } = gateSheet(4000, 'flatten-scale');
  const circuit = builder.finish({ erc: false });
  const nl = flatten(circuit, lib, new ChipLibrary(), { expandGates: false, metadata: false });
  const graph = buildLogicGraph(nl);
  assert(graph.elements.length >= 4000, `the flattened graph carries every gate (${graph.elements.length})`);
  const sim = new LogicVectorSim(graph);
  for (const net of graph.inputs) sim.drive(net, 0x5a5a5a5a);
  sim.settle();
  // Outputs are determined: a chain of gates over driven inputs has no X in it.
  let undetermined = 0;
  for (const net of graph.outputs) {
    const p = sim.planes(net);
    if (p.x !== 0 || p.z !== 0) undetermined++;
  }
  assertEqual(undetermined, 0, 'every output net settled to a determined value');
});

test('reference designators stay unique and in sequence', () => {
  const { builder } = gateSheet(5000, 'refs');
  const circuit = builder.finish({ erc: false });
  const refs = circuit.allComponents().map((c) => c.ref);
  assertEqual(new Set(refs).size, refs.length, 'no two components share a reference designator');
  const prefix = refs[0].replace(/[0-9]+$/, '');
  const numbers = refs.map((r) => Number(r.slice(prefix.length)));
  assertEqual(numbers[0], 1, 'the first designator is 1');
  assertEqual(numbers[numbers.length - 1], 5000, 'and the last is the component count');
  for (let i = 1; i < numbers.length; i++) {
    assertEqual(numbers[i], numbers[i - 1] + 1, `designators advance by one (${numbers[i - 1]} → ${numbers[i]})`);
  }
});

test('an explicitly used designator is never handed out again', () => {
  const b = new CircuitBuilder(lib, 'explicit-refs');
  const taken = b.add('resistor', { r: 1000 }, [0, 0], { ref: 'R5' });
  const auto1 = b.add('resistor', { r: 1000 }, [0, 20]);
  const auto2 = b.add('resistor', { r: 1000 }, [0, 40]);
  const circuit = b.finish({ erc: false });
  assertEqual(taken.ref, 'R5', 'the explicit designator is kept as given');
  assertEqual(auto1.ref, 'R1', 'automatic designators start at 1');
  assertEqual(auto2.ref, 'R2', 'and advance');
  // Walk the sequence into the reserved designator: it must be skipped, not reused.
  const b2 = new CircuitBuilder(lib, 'skip-taken');
  b2.add('resistor', { r: 1000 }, [0, 0], { ref: 'R3' });
  const seq = [b2.add('resistor', {}, [0, 0]).ref, b2.add('resistor', {}, [0, 0]).ref, b2.add('resistor', {}, [0, 0]).ref];
  assertEqual(seq.join(','), 'R1,R2,R4', 'R3 is reserved, so the third automatic designator is R4');
  void circuit;
});

test('removing a component frees its designator and rewiring a pin leaves the old net', () => {
  const b = new CircuitBuilder(lib, 'edit');
  const r1 = b.add('resistor', { r: 1000 }, [0, 0]);
  const r2 = b.add('resistor', { r: 1000 }, [0, 20]);
  const circuit = b.finish({ erc: false });
  assertEqual(circuit.componentCount(), 2, 'two components on the sheet');
  circuit.removeComponent(r1.id);
  assertEqual(circuit.componentCount(), 1, 'one left after removal');
  const next = circuit.nextRef('R');
  assert(next === 'R3' || next === 'R1', `the next designator is free (${next})`);
  assert(next !== r2.ref, 'and it is not the one still in use');

  // Rewiring a pin through the builder must not leave it attached to both nets:
  // `attach` alone would, which is why the builder detaches the net it recorded.
  const b2 = new CircuitBuilder(lib, 'rewire');
  const g = b2.add('and_gate', { inputs: 2 }, [0, 0]);
  b2.at(g, 'IN1', 'first', 1);
  b2.at(g, 'IN1', 'second', 1);
  b2.at(g, 'IN2', 'second', 1);
  b2.at(g, 'OUT', 'y', 1);
  const c2 = b2.finish({ erc: false });
  const first = c2.allNets().find((n) => n.name === 'first');
  const second = c2.allNets().find((n) => n.name === 'second');
  assert(first === undefined || first.ports.length === 0, 'the abandoned net keeps no connection (or was pruned)');
  assert(second !== undefined, 'the net the pin was moved to exists');
  const pins = (second?.ports ?? []).map((p) => p.pin).sort();
  assertEqual(pins.join(','), 'IN1,IN2', 'both pins sit on the new net, and IN1 sits on it once');
});
