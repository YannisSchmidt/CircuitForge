/**
 * Transistor-level gates (`style = cmos_static`).
 *
 * These cases check the expansion as a *circuit*: the truth table of a static
 * NAND and NOR, the integrity of the series stacks, and that a small network of
 * expanded gates solves to a real operating point. Each of the three failure
 * modes below was a real bug found by exactly these tests:
 *
 *   1. a PMOS whose threshold was read with the wrong sign conducted when it was
 *      meant to be off (a leakage-only gate burned milliwatts);
 *   2. the series stack wired its second device with drain = source, which left
 *      the pull-down with a single conducting device and put two conducting
 *      branches in contention on the output (a plain NAND read 1.02 V where it
 *      owed 3.3 V);
 *   3. without Newton step damping on the channel voltages, the exponential
 *      subthreshold region of a cold start ran away and a four-gate network
 *      never converged (±1 kV node voltages in a 3.3 V circuit).
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit, portNode, simulator } from './helpers.js';
import { Kind } from '../../src/engine/core/kinds.js';

suite('sim.cmos');

const VDD = 3.3;
const SIZE = { style: 'cmos_static', wn: 10e-6, wp: 20e-6, l: 0.18e-6 };

/** Build one gate with two DC-driven inputs, solve, and report the output. */
function gateCase(specId: string, inputs: [number, number]): { out: number; leakage: number; converged: boolean; usedStepping: boolean; transistors: number } {
  const { b, lib, chips } = builder(`${specId}-${inputs.join('')}`);
  const a = b.add('vdc', { dc: inputs[0] }, [0, 0]);
  b.at(a, '+', 'va').at(a, '-', 'gnd');
  const c = b.add('vdc', { dc: inputs[1] }, [0, 3]);
  b.at(c, '+', 'vb').at(c, '-', 'gnd');
  b.ground();
  const g = b.add(specId, { ...SIZE, inputs: 2 }, [6, 0]);
  b.at(g, 'IN1', 'va').at(g, 'IN2', 'vb').at(g, 'OUT', 'y');
  b.port('Y', 'output', 'y', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { expandGates: true });
  const transistors = [...nl.kind].filter((k) => k === Kind.Mosfet).length;
  const sim = simulator(nl);
  const dc = sim.dcSolve();
  let leakage = 0;
  for (const p of sim.powers()) if (Number.isFinite(p) && p > 0) leakage += p;
  return {
    out: sim.v[portNode(nl, 'Y')],
    leakage,
    converged: dc.converged,
    usedStepping: dc.usedGminStepping || dc.usedSourceStepping,
    transistors,
  };
}

test('a static NAND follows its truth table, at leakage power only', () => {
  for (const inputs of [[0, 0], [0, 1], [1, 0], [1, 1]] as Array<[number, number]>) {
    const r = gateCase('nand_gate', [inputs[0] * VDD, inputs[1] * VDD] as [number, number]);
    assert(r.converged, `NAND(${inputs}) converges`);
    assert(!r.usedStepping, `NAND(${inputs}) converges from the plain Newton iteration`);
    assertEqual(r.transistors, 4, 'a 2-input static NAND is four transistors');
    const expectHigh = !(inputs[0] && inputs[1]);
    if (expectHigh) assert(r.out > 3.2, `NAND(${inputs}) is high (${r.out.toFixed(4)} V)`);
    else assert(r.out < 0.1, `NAND(${inputs}) is low (${r.out.toFixed(4)} V)`);
    // A static CMOS gate has no DC path from the rail to ground, so the only
    // current is subthreshold and junction leakage.
    assert(r.leakage < 1e-7, `NAND(${inputs}) burns leakage only (${(r.leakage * 1e9).toFixed(2)} nW)`);
  }
});

test('a static NOR follows its truth table (the series stack is the PMOS side)', () => {
  for (const inputs of [[0, 0], [0, 1], [1, 0], [1, 1]] as Array<[number, number]>) {
    const r = gateCase('nor_gate', [inputs[0] * VDD, inputs[1] * VDD] as [number, number]);
    assert(r.converged, `NOR(${inputs}) converges`);
    assertEqual(r.transistors, 4, 'a 2-input static NOR is four transistors');
    const expectHigh = !(inputs[0] || inputs[1]);
    // A NOR with both inputs low pulls up through *two* series PMOS devices, so
    // the high level is a little below the rail — the classic NOR weakness, not
    // an error: the value is what the solved device equations give.
    if (expectHigh) assert(r.out > 3.0, `NOR(${inputs}) is high (${r.out.toFixed(4)} V)`);
    else assert(r.out < 0.1, `NOR(${inputs}) is low (${r.out.toFixed(4)} V)`);
    assert(r.leakage < 1e-7, `NOR(${inputs}) burns leakage only (${(r.leakage * 1e9).toFixed(2)} nW)`);
  }
});

test('a four-gate transistor-level network converges to a real operating point', () => {
  // XOR = NAND(NAND(a, n), NAND(b, n)), n = NAND(a, b) — the smallest network of
  // expanded gates that put the solver through a cold start with stacked devices.
  const { b, lib, chips } = builder('nand-xor');
  const va = b.add('vdc', { dc: VDD }, [0, 0]);
  b.at(va, '+', 'va').at(va, '-', 'gnd');
  const vb = b.add('vdc', { dc: 0 }, [0, 3]);
  b.at(vb, '+', 'vb').at(vb, '-', 'gnd');
  b.ground();
  const g1 = b.add('nand_gate', { ...SIZE, inputs: 2 }, [6, 0]);
  b.at(g1, 'IN1', 'va').at(g1, 'IN2', 'vb').at(g1, 'OUT', 'n1');
  const g2 = b.add('nand_gate', { ...SIZE, inputs: 2 }, [12, 0]);
  b.at(g2, 'IN1', 'va').at(g2, 'IN2', 'n1').at(g2, 'OUT', 'n2');
  const g3 = b.add('nand_gate', { ...SIZE, inputs: 2 }, [18, 0]);
  b.at(g3, 'IN1', 'vb').at(g3, 'IN2', 'n1').at(g3, 'OUT', 'n3');
  const g4 = b.add('nand_gate', { ...SIZE, inputs: 2 }, [24, 0]);
  b.at(g4, 'IN1', 'n2').at(g4, 'IN2', 'n3').at(g4, 'OUT', 'y');
  b.port('Y', 'output', 'y', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { expandGates: true });
  assertEqual([...nl.kind].filter((k) => k === Kind.Mosfet).length, 16, 'four NANDs are sixteen transistors');
  const sim = simulator(nl);
  const dc = sim.dcSolve();
  assert(dc.converged, 'the network converges');
  assert(!dc.usedGminStepping && !dc.usedSourceStepping, 'the plain Newton iteration is enough');
  assert(dc.iterations < 40, `it converges in a few iterations (${dc.iterations})`);
  // a = 1, b = 0 → XOR = 1
  assert(sim.v[portNode(nl, 'Y')] > 3.0, `XOR(1,0) is high (${sim.v[portNode(nl, 'Y')].toFixed(4)} V)`);
  // Every node is inside the supply window: a node above VDD is the signature of
  // an unconverged solve, not of a circuit.
  for (let n = 1; n < nl.nodeCount; n++) {
    assert(sim.v[n] > -0.2 && sim.v[n] < VDD + 0.2, `node ${n} stays inside the rails (${sim.v[n].toFixed(4)} V)`);
  }
  // Power balance. The residual is not zero by construction: the solver's gmin
  // conductance is stamped between each device terminal and ground and the
  // currents it carries belong to no element, so the floor is gmin·V²·(nodes).
  let sum = 0;
  let gross = 0;
  for (const p of sim.powers()) {
    if (!Number.isFinite(p)) continue;
    sum += p;
    if (p > 0) gross += p;
  }
  assert(gross > 1e-12, `the gates dissipate something (${(gross * 1e9).toFixed(3)} nW)`);
  assert(Math.abs(sum) < 1e-9, `the element powers balance to the gmin floor (${sum.toExponential(2)} W)`);
});

test('a NAND stack never ties its own drain to its source', () => {
  // Regression: with the degenerate stack the second NMOS of the pull-down had
  // drain = source = the output node, so it carried no current, and the *first*
  // device — whose gate is the other input — pulled the output down while the
  // PMOS pulled it up. NAND(1, 0) then settled at 1.02 V by contention.
  const r = gateCase('nand_gate', [VDD, 0]);
  assertClose(r.out, VDD, 0.3, 'NAND(1,0) is at the rail, not at a contention point');
  const low = gateCase('nand_gate', [VDD, VDD]);
  assert(low.out < 0.1, 'NAND(1,1) is at ground');
});
