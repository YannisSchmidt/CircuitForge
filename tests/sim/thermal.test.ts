/**
 * Level-3 electro-thermal coupling.
 *
 * What is asserted is only what the lumped model actually computes: a device
 * with `rth` (°C/W) and a measured dissipation P settles at T_amb + Rth·P, the
 * device's own temperature coefficient feeds back into the electrical point, and
 * the transient thermal ramp follows the Cth·Rth time constant.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit, simulator } from '../sim/helpers.js';
import { elementIndex } from '../sim/helpers.js';
import { elementThermalNode, R_SLOTS } from '../../src/engine/sim/paramslots.js';

suite('thermal');

/** 20 V across a 400 Ω resistor = 1 W at the nominal temperature. */
function divider(opts: { rth: number; cth?: number; tc1?: number; ambient?: number; thermalCoupling?: boolean; skipInitialDc?: boolean }) {
  const { b, lib, chips } = builder('thermal');
  const v = b.add('vdc', { dc: 20 }, [0, 0]);
  b.at(v, '+', 'vcc').at(v, '-', 'gnd');
  b.ground();
  const r = b.add('resistor', { r: 400, rth: opts.rth, cth: opts.cth ?? 0.005, tc1: opts.tc1 ?? 0 }, [2, 0]);
  b.at(r, '1', 'vcc').at(r, '2', 'gnd');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { ambient: opts.ambient ?? 25 });
  const sim = simulator(nl, {
    ambient: opts.ambient ?? 25,
    thermalCoupling: opts.thermalCoupling ?? true,
    skipInitialDc: opts.skipInitialDc ?? false,
  });
  return { nl, sim, r };
}

test('1 W in a 200 °C/W resistor raises its junction to ambient + 200 °C', () => {
  const { nl, sim } = divider({ rth: 200 });
  const dc = sim.dcSolve();
  assert(dc.converged, 'the electrical point converged');
  assert(!!dc.thermal, 'the report has a thermal block (the netlist has a thermal network)');
  assert(dc.thermal!.converged, `the thermal loop settled (delta ${dc.thermal!.worstTemperatureChange} °C)`);
  assertClose(dc.thermal!.maxTemperature, 225, 0.05, 'junction at ambient + Rth·P');
  const rEl = elementIndex(nl, 'resistor');
  assertClose(sim.elementTemperature(rEl), 225, 0.05, 'per-element junction temperature');
  assertClose(sim.powers()[rEl], 1, 1e-3, 'the dissipation is the measured 1 W');
  assertClose(sim.powers()[elementIndex(nl, 'vdc')] * -1, 1, 1e-3, 'the source delivers the same power');
});

test('temperature coefficient feeds back: the resistor heats until P(T) = (T − T_amb)/Rth', () => {
  const { nl, sim } = divider({ rth: 200, tc1: 100e-6 });
  sim.dcSolve();
  const rEl = elementIndex(nl, 'resistor');
  const t = sim.elementTemperature(rEl);
  // The model scales R around its own nominal temperature, which the netlist
  // carries in the element parameters — read it instead of assuming 25 °C.
  const tnom = nl.params[nl.paramOffset[rEl] + R_SLOTS.tnom];
  const rAtT = 400 * (1 + 100e-6 * (t - tnom));
  const p = (20 * 20) / rAtT;
  assertClose(t, 25 + 200 * p, 0.05, 'the reported junction satisfies the model it was solved from');
  assert(t < 225, 'and it is below the coefficient-free 225 °C, because R rose');
  assertClose(sim.powers()[rEl], p, 1e-6, 'the reported power is the power at that temperature');
});

test('thermalCoupling: false leaves the circuit at ambient and says so', () => {
  const { nl, sim } = divider({ rth: 200, thermalCoupling: false });
  const dc = sim.dcSolve();
  assertClose(dc.thermal!.maxTemperature, 25, 1e-9, 'no self-heating without the coupling loop');
  assert(sim.powers()[elementIndex(nl, 'resistor')] > 0.99, 'the electrical point is unchanged at ambient');
  assertClose(sim.elementTemperature(elementIndex(nl, 'resistor')), 25, 1e-9, 'junction stays at ambient');
});

test('transient: the junction ramps towards its steady state with the Rth·Cth time constant', () => {
  // τ = 1 s. `skipInitialDc` keeps the transient from re-running the DC point
  // (which would re-settle the junction at 225 °C) so the ramp really starts cold.
  const { nl, sim } = divider({ rth: 200, cth: 0.005, skipInitialDc: true });
  sim.dcSolve(); // the electrical point (and the junction heats to 225 °C)
  sim.resetThermalToAmbient(); // then hand the level-3 state back at ambient
  const tr = sim.transient(5, [{ key: 'tj', kind: 'temp', index: 0 }]);
  assert(tr.ok, `transient solved (${tr.steps} steps)`);
  const last = tr.sampleCount - 1;
  const tj = tr.values[0][last];
  const target = 225;
  const expected = 25 + (target - 25) * (1 - Math.exp(-tr.times[last] / 1));
  assert(tr.sampleCount >= 5, 'the ramp was sampled');
  assert(tj > 25 && tj < target, `the junction rose (${tj.toFixed(2)} °C at ${tr.times[last].toFixed(2)} s)`);
  assertClose(tj, expected, 4, 'within the implicit-Euler error of the analytic ramp');
  assertEqual(elementThermalNode(nl.kind[0], nl.paramOffset[0], nl.params), -1, 'the source owns no thermal node');
  assert(nl.thermalNodeCount > 0, 'the resistor does own one');
});

test('a netlist without a thermal network reports no thermal block (never 0 °C)', () => {
  const { b, lib, chips } = builder('no-thermal');
  const v = b.add('vdc', { dc: 5 }, [0, 0]);
  b.at(v, '+', 'vcc').at(v, '-', 'gnd');
  b.ground();
  const r = b.add('resistor', { r: 1000, rth: 0 }, [2, 0]);
  b.at(r, '1', 'vcc').at(r, '2', 'gnd');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { thermal: false });
  const sim = simulator(nl, { thermal: false });
  const dc = sim.dcSolve();
  assertEqual(nl.thermalNodeCount, 0, 'a netlist built with thermal: false has no thermal nodes');
  assert(dc.thermal === undefined, 'and the report does not pretend to know a temperature');
});
