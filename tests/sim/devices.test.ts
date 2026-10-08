/**
 * Device models.
 *
 * Every simulation here is *isothermal* (`thermal: false`): these cases check a
 * model against its own equations at a stated temperature. Self-heating is a
 * separate, coupled problem and is tested in `tests/sim/thermal.test.ts`.
 */
/**
 * Semiconductor device tests (isothermal).
 *
 * The expected values are computed from the same published model equations the
 * models document (Shockley, Ebers–Moll/Gummel–Poon, square-law MOS with channel * length modulation), solved *independently* of the simulator: either in closed
 * form, or by a bisection root solve of the circuit equations performed here.
 * A disagreement therefore means the simulator's implementation, not the model.
 */

import { assert, assertClose, assertEqual, assertRelative, suite, test } from '../framework.js';
import { builder, elementIndex, flattenCircuit, nodeOfNetName, simulator, portNode } from './helpers.js';
import { Kind } from '../../src/engine/core/kinds.js';

suite('sim.devices');

/**
 * Thermal voltage at 27 °C, computed from the fundamental constants the models
 * use (k·T/q with T = 300.15 K) — quoted here rather than imported so that this
 * file is an independent statement of what the models must produce.
 */
const VT = 0.0258649258;

/** Boltzmann constant in eV/K — the IS(T) exponent needs Eg/k, not Eg/(k·T/q). */
const KB_EV = 8.617333262e-5;

/** Solve i(v) = v/Rs… for a diode in series with a resistor, by bisection. */
function diodeWithResistorCurrent(vSource: number, rSeries: number, is: number, n: number): number {
  const vt = n * VT;
  const f = (i: number): number => vSource - i * rSeries - vt * Math.log(i / is + 1);
  let lo = 0;
  let hi = vSource / rSeries;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

test('diode forward voltage matches the Shockley law for a given current', () => {
  const { b, lib, chips } = builder();
  const i = b.add('idc', { dc: 0.01 }, [0, 0]); // 10 mA forced through the diode
  const d = b.add('diode', { is: 1e-12, n: 1, rs: 0, tnom: 27 }, [30, 0]);
  const g = b.add('ground', {}, [30, 40]);
  b.at(g, '0', 'gnd');
  // A current source with '+' on the node draws current *out* of it (SPICE
  // convention: positive current flows from n+ through the source to n-), so the
  // diode from the node to ground has to supply that current: A at 'a', K on gnd.
  b.at(i, '+', 'a').at(i, '-', 'gnd');
  b.at(d, 'A', 'a').at(d, 'K', 'gnd');
  b.port('A', 'output', 'a', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  const rep = sim.dcSolve();
  assert(rep.converged, 'converged');
  const expected = 1 * VT * Math.log(0.01 / 1e-12 + 1);
  assertClose(Math.abs(sim.v[portNode(nl, 'A')]), expected, 2e-3, 'diode forward voltage');
});

test('diode with a series resistor matches the bisection solution of its own equation', () => {
  const { b, lib, chips } = builder();
  const v = b.add('vdc', { dc: 5 }, [0, 0]);
  const r = b.add('resistor', { r: 1000, tc1: 0 }, [20, 0]);
  const d = b.add('diode', { is: 1e-12, n: 1, rs: 0, tnom: 27 }, [40, 0]);
  const g = b.add('ground', {}, [40, 40]);
  b.at(g, '0', 'gnd');
  b.at(v, '+', 'a').at(v, '-', 'gnd').at(r, '1', 'a').at(r, '2', 'k');
  b.at(d, 'A', 'k').at(d, 'K', 'gnd');
  b.port('K', 'output', 'k', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  assert(sim.dcSolve().converged, 'converged');
  const expectedCurrent = diodeWithResistorCurrent(5, 1000, 1e-12, 1);
  const expectedV = expectedCurrent * 1000;
  assertClose(5 - sim.v[portNode(nl, 'K')], expectedV, 1e-3, 'resistor voltage = diode voltage');
  assertClose(sim.state.elementCurrent[nl.elementCount - 1], expectedCurrent, 1e-6, 'diode current');
});

test('reverse-biased diode only leaks its saturation current', () => {
  const { b, lib, chips } = builder();
  // v('k') = +5 V with the anode on ground → the junction sees -5 V (reverse).
  const v = b.add('vdc', { dc: 5 }, [0, 0]);
  const d = b.add('diode', { is: 1e-12, n: 1, rs: 0, tnom: 27 }, [30, 0]);
  const g = b.add('ground', {}, [30, 40]);
  b.at(g, '0', 'gnd');
  b.at(v, '+', 'k').at(v, '-', 'gnd');
  b.at(d, 'A', 'gnd').at(d, 'K', 'k');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  assert(sim.dcSolve().converged, 'converged');
  const current = Math.abs(sim.state.elementCurrent[nl.elementCount - 1]);
  assert(current < 2e-12, `reverse leakage ${current} should be ~1e-12 A`);
});

test('diode temperature scaling follows the documented IS(T) law', () => {
  // Run the same forward current at two ambient temperatures and compare the
  // measured voltage difference with the model's own prediction.
  const measure = (tempC: number): number => {
    const { b, lib, chips } = builder();
    const i = b.add('idc', { dc: 0.01 }, [0, 0]);
    const d = b.add('diode', { is: 1e-12, n: 1, rs: 0, tnom: 27, eg: 1.11, xti: 3 }, [30, 0]);
    const g = b.add('ground', {}, [30, 40]);
    b.at(g, '0', 'gnd');
    b.at(i, '+', 'a').at(i, '-', 'gnd');
    b.at(d, 'A', 'a').at(d, 'K', 'gnd');
    b.port('A', 'output', 'a', 1, 'analog');
    const nl = flattenCircuit(b.finish(), lib, chips, { ambient: tempC });
    const sim = simulator(nl, { ambient: tempC, thermal: false });
    assert(sim.dcSolve().converged, `converged at ${tempC} °C`);
    return Math.abs(sim.v[portNode(nl, 'A')]);
  };
  const v27 = measure(27);
  const v77 = measure(77);
  // IS(T) = IS·(T/Tnom)^(xti/n)·exp(-Eg/(n·k)·(1/T − 1/Tnom)); V = n·Vt(T)·ln(I/IS)
  // The exponent uses Eg/k in kelvin (Eg in eV / k in eV/K); k·T/q must NOT be
  // substituted for it — that would understate it by a factor of ~300.
  const t1 = 27 + 273.15;
  const t2 = 77 + 273.15;
  const n = 1;
  const isRatio = Math.pow(t2 / t1, 3 / n) * Math.exp((1.11 / (n * KB_EV)) * (1 / t1 - 1 / t2));
  const expectedV77 = n * (VT * (t2 / t1)) * Math.log(0.01 / (1e-12 * isRatio) + 1);
  assert(isRatio > 100, `IS must grow strongly with temperature (ratio ${isRatio.toFixed(1)})`);
  assertClose(v77, expectedV77, 3e-3, 'forward voltage at 77 °C');
  assert(v77 < v27, 'a diode drops less voltage when hot');
  // Roughly -2 mV/K at this current is the classic rule of thumb; assert the
  // sign and order of magnitude, not a magic constant.
  const tc = (v77 - v27) / 50;
  assert(tc < -0.001 && tc > -0.004, `temperature coefficient ${tc.toFixed(5)} V/K out of range`);
});

test('LED has a larger forward drop than a silicon diode at the same current', () => {
  const forward = (specId: string, params: Record<string, number | string>): number => {
    const { b, lib, chips } = builder();
    const i = b.add('idc', { dc: 0.01 }, [0, 0]);
    const d = b.add(specId, params, [30, 0]);
    const g = b.add('ground', {}, [30, 40]);
    b.at(g, '0', 'gnd');
    b.at(i, '+', 'a').at(i, '-', 'gnd');
    b.at(d, 'A', 'a').at(d, 'K', 'gnd');
    b.port('A', 'output', 'a', 1, 'analog');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl, { thermal: false });
    assert(sim.dcSolve().converged, 'converged');
    return Math.abs(sim.v[portNode(nl, 'A')]);
  };
  const vLed = forward('led', { colour: 'red', is: 1e-21, n: 1.8, rs: 8 });
  const vDiode = forward('diode', { is: 1e-12, n: 1, rs: 0 });
  assert(vLed > vDiode, `LED drop ${vLed} should exceed the diode drop ${vDiode}`);
  assert(vLed > 1.4 && vLed < 2.6, `red LED drop ${vLed} V is outside the physical range`);
});

test('photodiode delivers a photocurrent proportional to the optical power', () => {
  // Short-circuit measurement: an ideal 0 V source holds the junction at 0 V, so
  // the terminal current is the photocurrent alone (the junction contributes
  // exactly nothing at 0 V) and must be linear in the optical power.
  const isc = (power: number): number => {
    const { b, lib, chips } = builder();
    const d = b.add('photodiode', { responsivity: 0.6, power, dark: 0, is: 1e-12, n: 1.2, rs: 0 }, [30, 0]);
    const short = b.add('vdc', { dc: 0 }, [60, 0]);
    const g = b.add('ground', {}, [60, 40]);
    b.at(g, '0', 'gnd');
    b.at(d, 'A', 'out').at(d, 'K', 'gnd').at(short, '+', 'out').at(short, '-', 'gnd');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl, { thermal: false });
    assert(sim.dcSolve().converged, 'converged');
    return Math.abs(sim.state.elementCurrent[elementIndex(nl, 'photodiode')]);
  };
  assertRelative(isc(1e-3), 0.6e-3, 1e-6, 1e-15, 'Isc at 1 mW');
  assertRelative(isc(2e-3), 1.2e-3, 1e-6, 1e-15, 'Isc at 2 mW');
  assertRelative(isc(2e-3) / isc(1e-3), 2, 1e-9, 1e-15, 'linearity in optical power');

  // Loaded (photoconductive) mode: the diode voltage must satisfy the node
  // equation solved here independently: v/R = Iph − Is·(e^(v/nVt) − 1).
  const { b, lib, chips } = builder();
  const d = b.add('photodiode', { responsivity: 0.6, power: 2e-3, dark: 0, is: 1e-12, n: 1.2, rs: 0 }, [30, 0]);
  const r = b.add('resistor', { r: 1000, tc1: 0 }, [60, 0]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(d, 'A', 'out').at(d, 'K', 'gnd').at(r, '1', 'out').at(r, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  assert(sim.dcSolve().converged, 'converged (loaded)');
  const v = sim.v[portNode(nl, 'OUT')];
  const nvt = 1.2 * VT;
  let lo = 0;
  let hi = 2;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const f = mid / 1000 - (1.2e-3 - 1e-12 * (Math.exp(mid / nvt) - 1));
    if (f > 0) hi = mid;
    else lo = mid;
  }
  assertClose(v, (lo + hi) / 2, 1e-3, 'photodiode voltage into a 1 kΩ load');
  assert(v > 0.5 && v < 0.7, `photodiode output ${v} V outside the junction-limited range`);
});

test('BJT in the forward active region obeys the documented Gummel-Poon relations', () => {
  const { b, lib, chips } = builder();
  const vcc = b.add('vdc', { dc: 10 }, [0, 0]);
  const vbb = b.add('vdc', { dc: 0.66 }, [0, 60]);
  const rb = b.add('resistor', { r: 10000, tc1: 0 }, [20, 60]);
  const rc = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  // Series resistances are set to zero so that the external node voltages *are*
  // the junction voltages; the library default is 10 Ω each.
  const q = b.add('bjt', { polarity: 'npn', is: 1e-14, bf: 200, br: 4, vaf: 100, var: 0, ikf: 1e9, rb: 0, rc: 0, re: 0, tnom: 27 }, [30, 30]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(vcc, '+', 'vcc').at(vcc, '-', 'gnd');
  b.at(rc, '1', 'vcc').at(rc, '2', 'c').at(q, 'C', 'c');
  b.at(vbb, '+', 'bb').at(vbb, '-', 'gnd');
  b.at(rb, '1', 'bb').at(rb, '2', 'base').at(q, 'B', 'base').at(q, 'E', 'gnd');
  b.port('C', 'output', 'c', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  const rep = sim.dcSolve();
  assert(rep.converged, `converged (${rep.iterations} iterations)`);
  const vc = sim.v[portNode(nl, 'C')];
  const vbe = sim.v[nodeOfNetName(nl, 'base')];
  const ic = (10 - vc) / 1000;
  const ib = (0.66 - vbe) / 10000;
  const vbc = vbe - vc;
  assert(ic > 1e-5 && ic < 0.5, `collector current ${ic} out of the expected range`);
  assert(vbc < -0.2, `the transistor must be in forward active, vbc = ${vbc}`);
  // Documented forward-active relations (IKf is off, Ise/Isc are zero):
  //   If = Is·(e^(Vbe/Vt) − 1), Ir = Is·(e^(Vbc/Vt) − 1) ≈ −Is
  //   qb = 1 − Vbe/VAR − Vbc/VAF        (VAR disabled here)
  //   Ic = (If − Ir)·qb − Ir/Br,  Ib = If/Bf + Ir/Br
  const ifwd = 1e-14 * (Math.exp(vbe / VT) - 1);
  const irev = 1e-14 * (Math.exp(vbc / VT) - 1);
  const qb = 1 - vbc / 100;
  assertRelative(ic, (ifwd - irev) * qb - irev / 4, 0.02, 1e-9, 'Ic vs the transport equation');
  assertRelative(ib, ifwd / 200 + irev / 4, 0.02, 1e-9, 'Ib vs the diode-sum equation');
  // The current gain is therefore Bf·qb, not Bf: the Early effect raises it as
  // the collector voltage grows (qb = 1 + (Vce − Vbe)/VAF).
  assertRelative(ic / ib, 200 * qb, 0.02, 1e-9, 'current gain Ic/Ib');
  assert(qb > 1.05 && qb < 1.15, `Early charge factor ${qb} outside the expected range`);
});

test('BJT saturation: collector voltage collapses when the base is overdriven', () => {
  const { b, lib, chips } = builder();
  const vcc = b.add('vdc', { dc: 5 }, [0, 0]);
  const vbb = b.add('vdc', { dc: 5 }, [0, 60]);
  const rb = b.add('resistor', { r: 1000, tc1: 0 }, [20, 60]);
  const rc = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  // IKf is left at the library default (0.1 A), so the knee roll-off is part of
  // the expected behaviour and is included in the reference solution below.
  // rb/rc/re = 0 removes the internal nodes, so the external voltages are the
  // junction voltages and the reference solve below is exact; the library
  // defaults are 10 Ω each.
  const q = b.add('bjt', { polarity: 'npn', is: 1e-14, bf: 200, br: 4, vaf: 1e9, var: 0, ikf: 0.1, rb: 0, rc: 0, re: 0 }, [30, 30]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(vcc, '+', 'vcc').at(vcc, '-', 'gnd');
  b.at(rc, '1', 'vcc').at(rc, '2', 'c').at(q, 'C', 'c');
  b.at(vbb, '+', 'bb').at(vbb, '-', 'gnd');
  b.at(rb, '1', 'bb').at(rb, '2', 'base').at(q, 'B', 'base').at(q, 'E', 'gnd');
  b.port('C', 'output', 'c', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  assert(sim.dcSolve().converged, 'converged');
  const vc = sim.v[portNode(nl, 'C')];
  assert(vc < 0.4, `hard-driven switch must saturate, got Vce = ${vc} V`);
  assert(vc > 0, `Vce must stay positive, got ${vc} V`);

  // Independent reference: the Ebers–Moll/Gummel–Poon equations the model
  // documents, solved here by bisection on the two node equations.
  //   ifwd = Is·(e^(Vbe/Vt) − 1), irev = Is·(e^(Vbc/Vt) − 1), Vbc = Vbe − Vce
  //   Ib = ifwd/(Bf/(1+ifwd/IKf)) + irev/Br,  Ic = (ifwd − irev) − irev/Br
  const is = 1e-14;
  const bf = 200;
  const br = 4;
  const ikf = 0.1;
  const model = (vbe: number, vce: number) => {
    const ifwd = is * (Math.exp(vbe / VT) - 1);
    const irev = is * (Math.exp((vbe - vce) / VT) - 1);
    const bfEff = bf / (1 + Math.abs(ifwd) / ikf);
    return { ib: ifwd / bfEff + irev / br, ic: ifwd - irev - irev / br };
  };
  const vceFor = (vbe: number): number => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (model(vbe, mid).ic - (5 - mid) / 1000 > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  let lo = 0.5;
  let hi = 0.95;
  for (let k = 0; k < 200; k++) {
    const vbe = (lo + hi) / 2;
    if (model(vbe, vceFor(vbe)).ib - (5 - vbe) / 1000 > 0) hi = vbe;
    else lo = vbe;
  }
  const vbe = (lo + hi) / 2;
  const expectedVce = vceFor(vbe);
  assertClose(vc, expectedVce, 2e-3, 'saturation voltage against the independent Ebers–Moll solve');
  // β must degrade in saturation: Ic < Bf·Ib.
  const vbeSim = sim.v[nodeOfNetName(nl, 'base')];
  const ib = (5 - vbeSim) / 1000;
  const ic = (5 - vc) / 1000;
  assert(ic < bf * ib, `saturation must reduce the current gain (Ic/Ib = ${(ic / ib).toFixed(1)})`);
});

test('PNP transistor mirrors the NPN behaviour with reversed polarities', () => {
  const { b, lib, chips } = builder();
  const vcc = b.add('vdc', { dc: 5 }, [0, 0]);
  const vbb = b.add('vdc', { dc: 4.3 }, [0, 60]);
  const rb = b.add('resistor', { r: 10000, tc1: 0 }, [20, 60]);
  const rc = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  const q = b.add('bjt', { polarity: 'pnp', is: 1e-14, bf: 100, vaf: 1e9 }, [30, 30]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  // Emitter at +5 V, base pulled to 4.3 V → Veb = 0.7 V; collector through a
  // resistor to ground.
  b.at(vcc, '+', 'vcc').at(vcc, '-', 'gnd');
  b.at(q, 'E', 'vcc');
  b.at(vbb, '+', 'bb').at(vbb, '-', 'gnd');
  b.at(rb, '1', 'bb').at(rb, '2', 'base').at(q, 'B', 'base');
  b.at(rc, '1', 'c').at(rc, '2', 'gnd').at(q, 'C', 'c');
  b.port('C', 'output', 'c', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  const rep = sim.dcSolve();
  assert(rep.converged, 'converged');
  const vc = sim.v[portNode(nl, 'C')];
  const ic = vc / 1000;
  assert(ic > 1e-5, `PNP must conduct (Ic = ${ic} A)`);
  assert(vc > 0.5 && vc < 5, `collector voltage ${vc} V out of the active region`);
});

test('NMOS saturation current follows the square law with channel-length modulation', () => {
  const { b, lib, chips } = builder();
  const vdd = b.add('vdc', { dc: 5 }, [0, 0]);
  const vg = b.add('vdc', { dc: 1.7 }, [0, 60]);
  const rd = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  const m = b.add('nmos', { model: 'square_law', w: 1e-5, l: 1e-6, vto: 0.7, kp: 1.2e-4, lambda: 0.02, rd: 0, rs: 0, tnom: 27 }, [30, 30]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(vdd, '+', 'vdd').at(vdd, '-', 'gnd');
  b.at(rd, '1', 'vdd').at(rd, '2', 'd').at(m, 'D', 'd').at(m, 'S', 'gnd').at(m, 'B', 'gnd');
  b.at(vg, '+', 'g').at(vg, '-', 'gnd').at(m, 'G', 'g');
  b.port('D', 'output', 'd', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  const rep = sim.dcSolve();
  assert(rep.converged, 'converged');
  const vd = sim.v[portNode(nl, 'D')];
  const id = (5 - vd) / 1000;
  const vov = 1.7 - 0.7;
  const lambda = 0.02;
  // Saturation asserted by the region test itself: vds > vov.
  assert(vd > vov, `device must be in saturation (vd = ${vd}, vov = ${vov})`);
  const expected = 0.5 * 1.2e-4 * (1e-5 / 1e-6) * vov * vov * (1 + lambda * vd);
  assertRelative(id, expected, 0.03, 1e-9, 'NMOS drain current');
});

test('NMOS triode region: current rises then flattens as Vds grows', () => {
  const currentAt = (vds: number): number => {
    const { b, lib, chips } = builder();
    const vg = b.add('vdc', { dc: 2.0 }, [0, 60]);
    const vd = b.add('vdc', { dc: vds }, [0, 0]);
    const m = b.add('nmos', { w: 1e-5, l: 1e-6, vto: 0.7, kp: 1.2e-4, lambda: 0.02, tnom: 27 }, [30, 30]);
    const g = b.add('ground', {}, [60, 40]);
    b.at(g, '0', 'gnd');
    b.at(vg, '+', 'g').at(vg, '-', 'gnd').at(m, 'G', 'g');
    b.at(vd, '+', 'd').at(vd, '-', 'gnd').at(m, 'D', 'd').at(m, 'S', 'gnd').at(m, 'B', 'gnd');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl, { thermal: false });
    assert(sim.dcSolve().converged, 'converged');
    const instIdx = nl.instances.findIndex((i) => i.specId === 'nmos');
    return Math.abs(sim.state.elementCurrent[instIdx]);
  };
  const vov = 2.0 - 0.7;
  const iSmall = currentAt(0.2); // triode
  const iAtVov = currentAt(vov); // boundary
  const iLarge = currentAt(3.0); // saturation
  assert(iSmall > 0, 'a transistor above threshold conducts with a small Vds');
  assert(iAtVov > iSmall, 'current grows with Vds in the triode region');
  // Saturation: ½k·W/L·Vov² ≈ triode maximum, with a small CLM increase.
  const sat = 0.5 * 1.2e-4 * 10 * vov * vov;
  assertRelative(iAtVov, sat, 0.05, 1e-9, 'triode boundary current');
  assert(iLarge < sat * 1.2 && iLarge > sat * 0.98, `saturation current ${iLarge} should be near ${sat}`);
});

test('PMOS mirrors the NMOS square law', () => {
  const { b, lib, chips } = builder();
  const vdd = b.add('vdc', { dc: 5 }, [0, 0]);
  const vg = b.add('vdc', { dc: 3.3 }, [0, 60]); // Vsg = 5 - 3.3 = 1.7 V
  const rd = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  const m = b.add('pmos', { w: 2e-5, l: 1e-6, vto: -0.7, kp: 6e-5, lambda: 0.02, rd: 0, rs: 0, tnom: 27 }, [30, 30]);
  const g = b.add('ground', {}, [60, 40]);
  b.at(g, '0', 'gnd');
  b.at(vdd, '+', 'vdd').at(vdd, '-', 'gnd');
  b.at(m, 'S', 'vdd').at(m, 'B', 'vdd');
  b.at(rd, '1', 'd').at(rd, '2', 'gnd').at(m, 'D', 'd');
  b.at(vg, '+', 'g').at(vg, '-', 'gnd').at(m, 'G', 'g');
  b.port('D', 'output', 'd', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  assert(sim.dcSolve().converged, 'converged');
  const vd = sim.v[portNode(nl, 'D')];
  const id = vd / 1000;
  const vsg = 5 - 3.3;
  const vov = vsg - 0.7;
  const vsd = 5 - vd;
  assert(vsd > vov, `PMOS must be in saturation (vsd = ${vsd}, vov = ${vov})`);
  const expected = 0.5 * 6e-5 * 20 * vov * vov * (1 + 0.02 * vsd);
  assertRelative(id, expected, 0.03, 1e-9, 'PMOS drain current');
});

test('MOS subthreshold conduction is exponential and continuous with strong inversion', () => {
  // The models are documented as including a weak-inversion branch (`subth`).
  // Continuity at the boundary matters: a discontinuity breaks Newton
  // convergence in every real circuit, so it is checked here.
  const currentAt = (vg: number): number => {
    const { b, lib, chips } = builder();
    const vgSrc = b.add('vdc', { dc: vg }, [0, 60]);
    const vd = b.add('vdc', { dc: 1.5 }, [0, 0]);
    const m = b.add('nmos', { w: 1e-5, l: 1e-6, vto: 0.7, kp: 1.2e-4, lambda: 0.02, subth: true, tnom: 27 }, [30, 30]);
    const g = b.add('ground', {}, [60, 40]);
    b.at(g, '0', 'gnd');
    b.at(vgSrc, '+', 'g').at(vgSrc, '-', 'gnd').at(m, 'G', 'g');
    b.at(vd, '+', 'd').at(vd, '-', 'gnd').at(m, 'D', 'd').at(m, 'S', 'gnd').at(m, 'B', 'gnd');
    const nl = flattenCircuit(b.finish(), lib, chips);
    const sim = simulator(nl, { thermal: false });
    assert(sim.dcSolve().converged, `converged at vg = ${vg}`);
    const instIdx = nl.instances.findIndex((i) => i.specId === 'nmos');
    return Math.abs(sim.state.elementCurrent[instIdx]);
  };
  const below = currentAt(0.4);
  const mid = currentAt(0.65);
  const above = currentAt(1.0);
  assert(below > 0, 'subthreshold current must be non-zero (it is a documented model feature)');
  assert(above > mid && mid > below, 'current must increase monotonically with gate voltage');
  // Continuity: no jump larger than 3x per 50 mV across the boundary.
  const near = currentAt(0.69);
  const just = currentAt(0.71);
  assert(just < near * 3, `discontinuity at the threshold: ${near} -> ${just}`);
  assert(just > near * 0.5, `discontinuity at the threshold: ${near} -> ${just}`);
});

test('re-solving a converged BJT circuit is a fixed point (the electro-thermal loop needs it)', () => {
  // Regression: the state recorder used to read the transistor polarity from the
  // *element* parameters, where the field is the device multiplicity. Every NPN
  // therefore stored its junction voltages negated, which left the pnjlim
  // memories negative — a second Newton solve from the answer then diverged
  // (Vc jumped from 11 mV to 1.8 V) and the level-3 loop had no chance.
  const { b, lib, chips } = builder('bjt-resolve');
  const vcc = b.add('vdc', { dc: 5 }, [0, 0]);
  const rb = b.add('resistor', { r: 10000, tc1: 0 }, [20, 40]);
  const rc = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
  const q = b.add('bjt', { polarity: 'npn', is: 1e-14, bf: 200, br: 4, vaf: 1e9, rb: 0, rc: 0, re: 0 }, [30, 20]);
  b.ground();
  b.at(vcc, '+', 'vcc').at(vcc, '-', 'gnd');
  b.at(rc, '1', 'vcc').at(rc, '2', 'c').at(q, 'C', 'c');
  b.at(rb, '1', 'c').at(rb, '2', 'base').at(q, 'B', 'base').at(q, 'E', 'gnd');
  b.port('C', 'output', 'c', 1, 'analog');
  const nl = flattenCircuit(b.finish(), lib, chips);
  const sim = simulator(nl, { thermal: false });
  const first = sim.dcSolve();
  assert(first.converged, 'the first solve converges');
  const node = portNode(nl, 'C');
  const v1 = sim.v[node];
  assert(v1 > 0 && v1 < 5, `a sane collector voltage (${v1.toFixed(4)} V)`);
  // The recorder must store the junction voltages with the *stamping* sign
  // convention (an NPN's forward Vbe is positive), not the negated values the
  // element-parameter polarity lookup produced.
  const instIdx = nl.instances.findIndex((i) => i.specId === 'bjt');
  const bjtEl = nl.instIndex.lastIndexOf(instIdx);
  const st = nl.state.subarray(nl.stateOffset[bjtEl], nl.stateOffset[bjtEl] + 4);
  const [cN, bN, eN] = [nl.nodes[bjtEl * 16], nl.nodes[bjtEl * 16 + 1], nl.nodes[bjtEl * 16 + 2]];
  assertClose(st[0], sim.v[bN] - sim.v[eN], 1e-9, 'recorded Vbe equals the solved base-emitter voltage');
  assertClose(st[1], sim.v[bN] - sim.v[cN], 1e-9, 'recorded Vbc equals the solved base-collector voltage');
  assert(st[0] > 0.3 && st[0] < 1.2, `the forward bias is recorded as positive (${st[0].toFixed(4)} V)`);
  // Second solve: same answer, and no need for the continuation methods.
  const second = sim.dcSolve();
  assert(second.converged, 'the second solve converges');
  assert(!second.usedGminStepping && !second.usedSourceStepping, 'the second solve converges from the answer alone');
  assertClose(sim.v[node], v1, 1e-6, 'the fixed point is the same operating point');
});

test('an expanded CMOS gate is off when it should be off (a PMOS threshold is a magnitude)', () => {
  // A p-channel device conducts when its gate sits *below* its source. The
  // device-frame evaluation mirrors the terminal voltages, so a signed SPICE
  // VTO (−0.45 V for this PMOS) must be read as the magnitude 0.45 V; read as a
  // number, it made the PMOS conduct when it was meant to be off — a NAND with
  // both inputs high burned 6 mW statically instead of 0.3 nW.
  const { b, lib, chips } = builder('cmos-nand');
  const va = b.add('vdc', { dc: 3.3 }, [0, 0]);
  b.at(va, '+', 'va').at(va, '-', 'gnd');
  const vb = b.add('vdc', { dc: 3.3 }, [0, 2]);
  b.at(vb, '+', 'vb').at(vb, '-', 'gnd');
  b.ground();
  const g = b.add('nand_gate', { style: 'cmos_static', inputs: 2, wn: 10e-6, wp: 20e-6, l: 0.18e-6 }, [4, 0]);
  b.at(g, 'IN1', 'va').at(g, 'IN2', 'vb').at(g, 'OUT', 'y');
  b.port('y', 'output', 'y', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { expandGates: true });
  const mosCount = [...nl.kind].filter((k) => k === Kind.Mosfet).length;
  assertEqual(mosCount, 4, 'a 2-input static NAND is four transistors');
  const sim = simulator(nl);
  const dc = sim.dcSolve();
  assert(dc.converged, 'the transistor-level operating point converges');
  const y = portNode(nl, 'y');
  assert(sim.v[y] < 0.1, `both inputs high pulls the output low (${sim.v[y].toFixed(4)} V)`);
  const p = sim.powers();
  let worst = 0;
  for (const v of p) if (Number.isFinite(v) && v > 0) worst += v;
  assert(worst < 1e-7, `a static CMOS gate burns leakage only (${(worst * 1e9).toFixed(2)} nW)`);
});
