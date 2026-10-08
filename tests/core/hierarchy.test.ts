/**
 * Hierarchy: chips, vector instances (`bits = N`), wide gates and the ERC safety
 * net that catches wiring that would otherwise be silently dangling.
 *
 * `bits = N` has two well-defined meanings and this file pins both down:
 *   - on a primitive, N copies of the element, one per lane of the nets it is
 *     wired to (a 4-bit inverter);
 *   - on a chip, N copies of the implementation bound lane by lane (a 1-bit adder
 *     chip with bits = 4 is a 4-bit ripple adder made of four 1-bit adders).
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit, testProject, type TestProject } from '../sim/helpers.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { Severity } from '../../src/engine/core/labels.js';

function project(name = 'hierarchy'): TestProject {
  return testProject(name);
}

/** Wrap a chip in a root circuit that exposes every port, then simulate at L0. */
function harness(p: TestProject, chipId: string, params = {}, bits = 1) {
  const b = new CircuitBuilder(p.lib, `root-${chipId}`);
  const chip = p.project.chips.must(chipId);
  const inst = p.project.instantiate(b, chipId, params, [0, 0], { bits });
  for (const port of chip.def.ports) {
    b.port(port.name, port.direction === 'output' ? 'output' : 'input', port.name.toLowerCase(), port.width);
    b.at(inst, port.name, port.name.toLowerCase());
  }
  // A purely digital circuit has no ground symbol: the floating-solution warning
  // of the electrical flattener does not apply to it.
  const nl = flatten(b.finish({ erc: false }), p.lib, p.chips, { ambient: 27 });
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const net = (name: string): number => {
    for (let i = 0; i < g.netCount; i++) if (g.netName(i) === name) return i;
    throw new Error(`no net ${name}`);
  };
  return { nl, g, sim, net };
}

suite('hierarchy');

test('a primitive with bits = 4 becomes four elements bound lane by lane', () => {
  const { b, lib, chips } = builder('vector');
  const inv = b.add('not_gate', { style: 'ideal' }, [0, 0], { bits: 4 });
  b.port('A', 'input', 'a', 4);
  b.port('Y', 'output', 'y', 4);
  b.at(inv, 'IN1', 'a').at(inv, 'OUT', 'y');
  const nl = flattenCircuit(b.finish(), lib, chips, { allowWarnings: true });
  assertEqual(nl.elementCount, 4, 'one element per lane');
  assertEqual(nl.nodeCount, 9, 'ground + four lanes of a and four of y');
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const name = (n: number): string => g.netName(n);
  for (const value of [0, 5, 15]) {
    sim.reset();
    for (let lane = 0; lane < 4; lane++) {
      const netName = lane ? `a[${lane}]` : 'a';
      const node = [...Array(g.netCount).keys()].find((i) => name(i) === netName)!;
      sim.setVector(node, 0, ((value >> lane) & 1) as 0 | 1);
    }
    sim.settle();
    let got = 0;
    for (let lane = 0; lane < 4; lane++) {
      const netName = lane ? `y[${lane}]` : 'y';
      const node = [...Array(g.netCount).keys()].find((i) => name(i) === netName)!;
      got |= (Number(sim.sample(node, 0)) & 1) << lane;
    }
    assertEqual(got, ~value & 15, `bitwise NOT of ${value}`);
  }
});

test('a 1-bit chip with bits = 4 is a real 4-bit instance (adder lanes)', () => {
  const p = project('chip-vector');
  p.project.buildChip({ id: 'half_adder_ref', name: 'HALF_ADDER_REF' }, (b) => {
    const x = b.add('xor_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    const a = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 40]);
    b.port('A', 'input', 'a', 1);
    b.port('B', 'input', 'b', 1);
    b.port('S', 'output', 's', 1);
    b.port('CO', 'output', 'co', 1);
    b.at(x, 'IN1', 'a').at(x, 'IN2', 'b').at(x, 'OUT', 's');
    b.at(a, 'IN1', 'a').at(a, 'IN2', 'b').at(a, 'OUT', 'co');
  });
  const b = new CircuitBuilder(p.lib, 'root');
  const inst = p.project.instantiate(b, 'half_adder_ref', {}, [0, 0], { bits: 4 });
  for (const port of ['A', 'B', 'S', 'CO']) {
    b.port(port, 'input', port.toLowerCase(), 4);
    b.at(inst, port, port.toLowerCase());
  }
  // A purely digital circuit has no ground symbol: the floating-solution warning
  // of the electrical flattener does not apply to it.
  const nl = flatten(b.finish({ erc: false }), p.lib, p.chips, { ambient: 27 });
  assertEqual(nl.elementCount, 8, 'four lanes × two gates');
  assertEqual(nl.instances.length, 1 + 4 * 2, 'the chip instance plus its expanded children');
  const g = buildLogicGraph(nl);
  const sim = new LogicVectorSim(g);
  const at = (n: string): number => [...Array(g.netCount).keys()].find((i) => g.netName(i) === n)!;
  // Each lane is an independent half adder: S[i] = A[i] xor B[i].
  for (let v = 0; v < 16; v++) {
    sim.reset();
    for (let lane = 0; lane < 4; lane++) {
      sim.setVector(at(lane ? `a[${lane}]` : 'a'), v, ((v >> lane) & 1) as 0 | 1);
      sim.setVector(at(lane ? `b[${lane}]` : 'b'), v, (((15 - v) >> lane) & 1) as 0 | 1);
    }
    sim.settle();
    let sum = 0;
    for (let lane = 0; lane < 4; lane++) sum |= (Number(sim.sample(at(lane ? `s[${lane}]` : 's'), v)) & 1) << lane;
    assertEqual(sum, v ^ (15 - v), `lane-wise xor for pattern ${v}`);
  }
});

test('a gate wider than one element is expanded into a tree of 2-input gates', () => {
  const { b, lib, chips } = builder('wide-gate');
  // 16 inputs is more than one element holds (15): it must become a tree.
  b.port('Y', 'output', 'y', 1);
  for (let i = 0; i < 16; i++) b.port(`I${i}`, 'input', `i${i}`, 1);
  const g = b.add('and_gate', { style: 'ideal', inputs: 16, tplh: 1e-9, tphl: 1e-9 }, [0, 0]);
  for (let i = 0; i < 16; i++) b.at(g, `IN${i + 1}`, `i${i}`);
  b.at(g, 'OUT', 'y');
  const nl = flattenCircuit(b.finish(), lib, chips, { allowWarnings: true });
  assert(nl.elementCount > 1, `the wide gate is expanded (got ${nl.elementCount} elements)`);
  const graph = buildLogicGraph(nl);
  const sim = new LogicVectorSim(graph);
  const net = (name: string): number => [...Array(graph.netCount).keys()].find((i) => graph.netName(i) === name)!;
  for (const pattern of [0, 0xffff, 0x00ff, 0x8000]) {
    sim.reset();
    for (let i = 0; i < 16; i++) sim.setVector(net(`i${i}`), pattern, ((pattern >> i) & 1) as 0 | 1);
    sim.settle();
    assertEqual(sim.sample(net('y'), pattern), pattern === 0xffff ? 1 : 0, `AND of pattern 0x${pattern.toString(16)}`);
  }
});

test('ERC reports a wire to a pin that does not exist (CF3010)', () => {
  const { b, lib } = builder('erc-pin');
  const g = b.add('and_gate', { style: 'ideal' }, [0, 0]);
  b.port('A', 'input', 'a', 1);
  b.port('Y', 'output', 'y', 1);
  b.at(g, 'IN1', 'a').at(g, 'IN2', 'a').at(g, 'OUT', 'y');
  // A typo'd pin name: without the ERC this would be silently dangling (it is not
  // CF3011, which is about a *declared* input the gate does not read).
  b.at(g, 'INX', 'a');
  const diags = b.circuit.erc(lib);
  const found = diags.find((d) => d.code === 'CF3010');
  assert(!!found, `CF3010 must be reported (got ${diags.map((d) => d.code).join(', ')})`);
  assertEqual(found!.severity, Severity.Error, 'severity of a dangling pin');
});

test('ERC reports an input wired beyond the configured inputs (CF3011)', () => {
  const { b, lib } = builder('erc-inputs');
  const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
  b.port('A', 'input', 'a', 1);
  b.port('Y', 'output', 'y', 1);
  b.at(g, 'IN1', 'a').at(g, 'IN2', 'a').at(g, 'OUT', 'y');
  b.at(g, 'IN3', 'a');
  const diags = b.circuit.erc(lib);
  const found = diags.find((d) => d.code === 'CF3011');
  assert(!!found, `CF3011 must be reported (got ${diags.map((d) => d.code).join(', ')})`);
  assertEqual(found!.severity, Severity.Warning, 'severity of an unused wire');
  // Raising `inputs` silences it for that component, and the gate really uses it.
  const g2 = b.add('and_gate', { style: 'ideal', inputs: 3 }, [0, 80]);
  b.at(g2, 'IN1', 'a').at(g2, 'IN2', 'a').at(g2, 'IN3', 'a').at(g2, 'OUT', 'y2');
  b.port('Y2', 'output', 'y2', 1);
  const diags2 = b.circuit.erc(lib);
  assert(
    !diags2.some((d) => d.code === 'CF3011' && d.message.includes(g2.ref)),
    'no CF3011 for the gate that reads three inputs',
  );
});

test('a project keeps the chip library and the component library in sync', () => {
  const p = project('sync');
  const chip = p.project.buildChip({ id: 'inv', name: 'INV' }, (b) => {
    const g = b.add('not_gate', { style: 'ideal' }, [0, 0]);
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    b.at(g, 'IN1', 'a').at(g, 'OUT', 'y');
  });
  assert(p.project.chips.has('inv'), 'the chip is in the chip library');
  assert(!!p.lib.get('inv'), 'the component spec exists (the flattener needs it)');
  assertEqual(p.lib.get('inv')!.category, 'chip', 'the spec is categorised as a chip');
  assertEqual(p.project.specOf(chip).pins.length, 2, 'two pins');
  // A dependent chip blocks removal.
  p.project.buildChip({ id: 'inv2', name: 'INV2' }, (b) => {
    const inner = p.project.instantiate(b, 'inv', {}, [0, 0]);
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    b.at(inner, 'A', 'a').at(inner, 'Y', 'y');
  });
  assert(!p.project.removeChip('inv'), 'removing a chip that is used by another chip is refused');
  assert(p.project.diagnostics.some((d) => d.code === 'CF4007'), 'and it is reported (CF4007)');
});
