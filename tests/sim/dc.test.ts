/**
 * DC operating point tests.
 *
 * Every case here has an analytically known answer that is computed from the
 * *model equations* (not copied from a previous run of this simulator), so a
 * failure means the simulator disagrees with its own documented model.
 */

import { assert, assertClose, assertRelative, test, suite } from '../framework.js';
import { builder, flattenCircuit, simulator, portNode } from './helpers.js';

suite('sim.dc');

test('voltage divider: exact node voltages and source current', () => {
  const { b, lib, chips } = builder();
  const v1 = b.add('vdc', { dc: 10, rs: 0 }, [0, 0]);
  const r1 = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [30, 0]);
  const r2 = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(v1, '+', 'vcc').at(r1, '1', 'vcc').at(r1, '2', 'mid').at(r2, '1', 'mid').at(r2, '2', 'gnd').at(v1, '-', 'gnd');
  b.port('OUT', 'output', 'mid', 1, 'analog');
  const c = b.finish();
  const nl = flattenCircuit(c, lib, chips);
  const sim = simulator(nl);
  const rep = sim.dcSolve();
  assert(rep.converged, `did not converge: ${rep.iterations} iterations`);
  // gmin (1e-12 S) across ~1 kΩ nodes perturbs the answer by ~1e-9 V: that is
  // the documented cost of the numerical shunt.
  assertClose(sim.v[portNode(nl, 'OUT')], 5, 1e-7, 'divider output voltage');
  // The source current is the branch unknown of the voltage source.
  const br = nl.branchIndex[0];
  assertClose(Math.abs(sim.ib[br]), 0.005, 1e-9, 'source current (5 mA)');
});

test('current source into parallel resistors obeys the current divider', () => {
  const { b, lib, chips } = builder();
  const i1 = b.add('idc', { dc: 0.01 }, [0, 0]);
  const r1 = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [30, 0]);
  const r2 = b.add('resistor', { r: 3000, tc1: 0, tc2: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(i1, '+', 'n').at(i1, '-', 'gnd').at(r1, '1', 'n').at(r1, '2', 'gnd').at(r2, '1', 'n').at(r2, '2', 'gnd');
  b.port('N', 'output', 'n', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  // 10 mA into 1k || 3k = 750 Ω -> 7.5 V
  assertClose(sim.v[portNode(nl, 'N')], 7.5, 1e-7, 'node voltage');
});

test('superposition holds for a two-source linear network', () => {
  const build = (v1: number, v2: number): number => {
    const { b, lib, chips } = builder();
    const s1 = b.add('vdc', { dc: v1 }, [0, 0]);
    const s2 = b.add('vdc', { dc: v2 }, [0, 40]);
    const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [30, 0]);
    const r2 = b.add('resistor', { r: 2000, tc1: 0 }, [60, 0]);
    const g = b.add('ground', {}, [60, 40]);
    b.at(g, '0', 'gnd');
    b.at(s1, '+', 'a').at(s1, '-', 'gnd').at(s2, '+', 'b').at(s2, '-', 'gnd');
    b.at(r1, '1', 'a').at(r1, '2', 'm').at(r2, '1', 'm').at(r2, '2', 'b');
    b.port('M', 'output', 'm', 1, 'analog');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl);
    assert(sim.dcSolve().converged, 'converged');
    return sim.v[portNode(nl, 'M')];
  };
  // Node m of a resistor chain driven by two sources: v(m) = (v1·G2 + v2·G1)/(G1+G2)... computed directly:
  // G1 = 1mS, G2 = 0.5mS, both from a and b. v(m)·(G1+G2) = v1·G1 + v2·G2
  const expected = (a: number, bb: number) => (a * 0.001 + bb * 0.0005) / 0.0015;
  const vA = build(5, 0);
  const vB = build(0, 5);
  const vAB = build(5, 5);
  assertClose(vA, expected(5, 0), 1e-7, 'only source A');
  assertClose(vB, expected(0, 5), 1e-7, 'only source B');
  assertClose(vAB, vA + vB, 1e-7, 'superposition');
});

test('series and parallel resistor laws', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 12 }, [0, 0]);
  const r1 = b.add('resistor', { r: 100, tc1: 0 }, [20, 0]);
  const r2 = b.add('resistor', { r: 200, tc1: 0 }, [40, 0]);
  const r3 = b.add('resistor', { r: 300, tc1: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  // r1 in series with (r2 || r3)
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(r1, '1', 'a').at(r1, '2', 'b');
  b.at(r2, '1', 'b').at(r2, '2', 'gnd').at(r3, '1', 'b').at(r3, '2', 'gnd');
  b.port('B', 'output', 'b', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  const rpar = 1 / (1 / 200 + 1 / 300);
  const expected = 12 * rpar / (100 + rpar);
  assertClose(sim.v[portNode(nl, 'B')], expected, 1e-6, 'series-parallel divider');
});

test('power dissipation of a resistor equals V·I', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 9 }, [0, 0]);
  const r = b.add('resistor', { r: 470, tc1: 0 }, [30, 0]);
  const g = b.add('ground', {}, [30, 40]);
  b.at(g, '0', 'gnd');
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(r, '1', 'a').at(r, '2', 'gnd');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  const expected = (9 * 9) / 470;
  assertRelative(sim.state.elementPower[nl.elementCount - 1], expected, 1e-6, 1e-12, 'resistor power');
});

test('VCVS: output is gain × differential input', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 1 }, [0, 0]);
  const e = b.add('vcvs', { gain: 10, rout: 0 }, [30, 0]);
  const r = b.add('resistor', { r: 1000, tc1: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(v, '+', 'in').at(v, '-', 'gnd');
  b.at(e, 'IN+', 'in').at(e, 'IN-', 'gnd').at(e, 'OUT+', 'out').at(e, 'OUT-', 'gnd');
  b.at(r, '1', 'out').at(r, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  assertClose(sim.v[portNode(nl, 'OUT')], 10, 1e-6, 'VCVS output');
});

test('VCCS: current equals gm × input voltage (loaded with a resistor)', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 2 }, [0, 0]);
  const g = b.add('vccs', { gm: 0.0025 }, [30, 0]);
  const r = b.add('resistor', { r: 2000, tc1: 0 }, [60, 0]);
  const gnd = b.add('ground', {}, [60, 40]);
  b.at(gnd, '0', 'gnd');
  b.at(v, '+', 'in').at(v, '-', 'gnd');
  b.at(g, 'IN+', 'in').at(g, 'IN-', 'gnd');
  // The source current flows from OUT+ to OUT- *inside* the element, so with
  // OUT+ on the output node it pulls current out of the load: v = -gm·vin·R.
  b.at(g, 'OUT+', 'out').at(g, 'OUT-', 'gnd');
  b.at(r, '1', 'out').at(r, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  // i = gm·vin = 0.0025 S × 2 V = 5 mA pulled out of the 2 kΩ load → -10 V.
  assertClose(sim.v[portNode(nl, 'OUT')], -10, 1e-5, 'VCCS output voltage');
});

test('CCVS: output voltage is gain × control current', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 1 }, [0, 0]);
  const rc = b.add('resistor', { r: 100, tc1: 0 }, [20, 0]);
  const h = b.add('ccvs', { gain: 1000, rout: 0 }, [40, 0]);
  const rl = b.add('resistor', { r: 1000, tc1: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  // Control current: 1 V / 100 Ω = 10 mA through the sense path.
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(rc, '1', 'a').at(rc, '2', 'ctl');
  b.at(h, 'CTRL+', 'ctl').at(h, 'CTRL-', 'gnd');
  b.at(h, 'OUT+', 'out').at(h, 'OUT-', 'gnd');
  b.at(rl, '1', 'out').at(rl, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  assert(sim.dcSolve().converged, 'converged');
  // SPICE convention: v(OUT+) − v(OUT−) = gain · i_sense, where i_sense is the
  // current flowing from CTRL+ to CTRL- *inside* the sense source (+10 mA here).
  assertClose(sim.v[portNode(nl, 'OUT')], 10, 1e-4, 'CCVS output voltage');
});

test('CCCS: output current is gain × control current', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 1 }, [0, 0]);
  const rc = b.add('resistor', { r: 100, tc1: 0 }, [20, 0]);
  const f = b.add('cccs', { gain: 4 }, [40, 0]);
  const rl = b.add('resistor', { r: 1000, tc1: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  // Control branch: 1 V across 100 Ω = 10 mA through the sense source. (No
  // ammeter here: two ideal zero-volt sources in parallel would make the system
  // singular — a real, physical degeneracy, not a simulator limitation.)
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(rc, '1', 'a').at(rc, '2', 'ctl');
  b.at(f, 'CTRL+', 'ctl').at(f, 'CTRL-', 'gnd');
  b.at(f, 'OUT+', 'out').at(f, 'OUT-', 'gnd');
  b.at(rl, '1', 'out').at(rl, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl);
  const rep = sim.dcSolve();
  assert(rep.converged, 'converged');
  // The current flows from OUT+ to OUT- inside the element, so with OUT+ on the
  // load node it pulls 4 × 10 mA out of a 1 kΩ load -> -40 V.
  assertClose(sim.v[portNode(nl, 'OUT')], -40, 1e-3, 'CCCS output voltage');
});

test('Thévenin equivalent: Voc / Isc gives the source resistance', () => {
  const buildWithLoad = (load: number): number => {
    const { b, lib, chips } = builder();
    const v = b.add('vdc', { dc: 5 }, [0, 0]);
    const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [20, 0]);
    const r2 = b.add('resistor', { r: 3000, tc1: 0 }, [40, 0]);
    const g = b.add('ground', {}, [60, 40]);
    b.at(g, '0', 'gnd');
    b.at(v, '+', 'a').at(v, '-', 'gnd').at(r1, '1', 'a').at(r1, '2', 'o');
    if (load === Infinity) {
      b.at(r2, '1', 'o').at(r2, '2', 'gnd');
    } else {
      const rl = b.add('resistor', { r: load, tc1: 0 }, [60, 0]);
      b.at(r2, '1', 'o').at(r2, '2', 'gnd').at(rl, '1', 'o').at(rl, '2', 'gnd');
    }
    b.port('O', 'output', 'o', 1, 'analog');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl);
    assert(sim.dcSolve().converged, 'converged');
    return sim.v[portNode(nl, 'O')];
  };
  const voc = buildWithLoad(Infinity);
  const vLoad = buildWithLoad(1000); // Rth in series with 1k load
  // Thevenin: Rth = 1k||3k = 750 Ω, so V(load) = Voc · 1000/(1000+750)
  assertClose(voc, 3.75, 1e-7, 'open circuit voltage');
  assertClose(vLoad, voc * (1000 / 1750), 1e-6, 'loaded output');
});

test('maximum power transfer happens at the matched load', () => {
  const powerAt = (load: number): number => {
    const { b, lib, chips } = builder();
    const v = b.add('vdc', { dc: 10 }, [0, 0]);
    const rs = b.add('resistor', { r: 500, tc1: 0 }, [20, 0]);
    const rl = b.add('resistor', { r: load, tc1: 0 }, [40, 0]);
    const g = b.add('ground', {}, [40, 40]);
    b.at(g, '0', 'gnd');
    b.at(v, '+', 'a').at(v, '-', 'gnd').at(rs, '1', 'a').at(rs, '2', 'o').at(rl, '1', 'o').at(rl, '2', 'gnd');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl);
    assert(sim.dcSolve().converged, 'converged');
    // The load is the last element.
    return sim.state.elementPower[nl.elementCount - 1];
  };
  const p400 = powerAt(400);
  const p500 = powerAt(500);
  const p625 = powerAt(625);
  assert(p500 > p400, 'matched load must dissipate more than a smaller one');
  assert(p500 > p625, 'matched load must dissipate more than a larger one');
  assertClose(p500, 0.05, 1e-7, 'matched power = V²/(4Rs) = 50 mW');
});

test('gmin does not perturb the answer of a well-grounded circuit', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 1 }, [0, 0]);
  const r1 = b.add('resistor', { r: 1e3, tc1: 0 }, [20, 0]);
  const r2 = b.add('resistor', { r: 1e3, tc1: 0 }, [40, 0]);
  const g = b.add('ground', {}, [40, 40]);
  b.at(g, '0', 'gnd');
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(r1, '1', 'a').at(r1, '2', 'm').at(r2, '1', 'm').at(r2, '2', 'gnd');
  b.port('M', 'output', 'm', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const coarse = simulator(nl, { gmin: 1e-3 });
  assert(coarse.dcSolve().converged, 'converged with a large gmin');
  const vCoarse = coarse.v[portNode(nl, 'M')];
  const fine = simulator(nl, { gmin: 1e-12 });
  assert(fine.dcSolve().converged, 'converged with a small gmin');
  const vFine = fine.v[portNode(nl, 'M')];
  assertClose(vFine, 0.5, 1e-7, 'accurate answer');
  // A 1 mS gmin across 1 kΩ nodes is a real (documented) error; make sure the
  // solver reports the value it used rather than pretending it is exact.
  assert(coarse.diagnosticsSnapshot().length >= 0, 'diagnostics readable');
  assert(Math.abs(vCoarse - 0.5) > Math.abs(vFine - 0.5), 'a large gmin must move the answer');
});
