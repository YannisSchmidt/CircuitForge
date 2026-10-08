/**
 * Transient analysis: adaptive stepping, source breakpoints, energy accounting.
 *
 * The reference is the analytic solution of the RC step response. What is
 * asserted is what the integrator promises: the curve is followed to a stated
 * accuracy, the run always reaches `tstop`, edges of a square source are stepped
 * on exactly, and the energy the source delivers ends up in the resistor and the
 * capacitor (nothing is created or lost by the numerical scheme).
 */

import { assert, assertClose, suite, test } from '../framework.js';
import { builder, flattenCircuit, simulator } from '../sim/helpers.js';
import type { FlatNetlist } from '../../src/engine/sim/netlist.js';
import type { CircuitSimulator } from '../../src/engine/sim/solver.js';
import { elementIndex } from '../sim/helpers.js';

suite('transient');

const TAU = 1e-3; // 1 kΩ × 1 µF

/** 5 V step into 1 kΩ + 1 µF, starting from zero (skipInitialDc). */
function rcStep(integration: 'be' | 'trap' = 'be'): { nl: FlatNetlist; sim: CircuitSimulator; node: number; tstop: number } {
  const { b, lib, chips } = builder('rc');
  const v = b.add('vdc', { dc: 5 }, [0, 0]);
  b.at(v, '+', 'vcc').at(v, '-', 'gnd');
  b.ground();
  const r = b.add('resistor', { r: 1000, tc1: 0 }, [2, 0]);
  const c = b.add('capacitor', { c: 1e-6 }, [4, 0]);
  b.at(r, '1', 'vcc').at(r, '2', 'out').at(c, '1', 'out').at(c, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { thermal: false, ambient: 27 });
  const sim = simulator(nl, { thermal: false, ambient: 27, skipInitialDc: true, integration });
  sim.state.mode = 'tran';
  const node = nl.ports.find((p) => p.name === 'OUT')!.node;
  return { nl, sim, node, tstop: 5 * TAU };
}

function analytic(t: number): number {
  return 5 * (1 - Math.exp(-t / TAU));
}

test('the RC step response follows the analytic solution and reaches tstop', () => {
  const { sim, node, tstop } = rcStep();
  const tr = sim.transient(tstop, [{ key: 'v', kind: 'vnet', index: node }], { maxSamples: 20000 });
  assert(tr.ok, 'transient solved');
  const last = tr.sampleCount - 1;
  assertClose(tr.times[last], tstop, 1e-12, 'the run reaches tstop exactly');
  // A regression guard for the timestep: with `maxStep` at its default (tstop/20)
  // and an LTE controller, 5τ of RC takes hundreds of steps, never millions.
  assert(tr.steps > 20 && tr.steps < 2000, `step count stays sane (${tr.steps})`);
  let worst = 0;
  for (let i = 0; i < tr.sampleCount; i++) worst = Math.max(worst, Math.abs(tr.values[0][i] - analytic(tr.times[i])));
  assert(worst < 0.02, `worst deviation ${worst.toExponential(2)} V < 20 mV (0.4 % of 5 V)`);
  assert(tr.sampleCount >= 20, `the curve is sampled (${tr.sampleCount} points)`);
});

test('trapezoidal integration is more accurate than backward Euler at the end of the run', () => {
  const be = rcStep('be');
  const trBe = be.sim.transient(be.tstop, [{ key: 'v', kind: 'vnet', index: be.node }], { maxSamples: 20000 });
  const trap = rcStep('trap');
  const trTrap = trap.sim.transient(trap.tstop, [{ key: 'v', kind: 'vnet', index: trap.node }], { maxSamples: 20000 });
  const errBe = Math.abs(trBe.values[0][trBe.sampleCount - 1] - analytic(be.tstop));
  const errTrap = Math.abs(trTrap.values[0][trTrap.sampleCount - 1] - analytic(trap.tstop));
  assert(errTrap * 5 < errBe, `trap error ${errTrap.toExponential(2)} < be error ${errBe.toExponential(2)} / 5`);
});

test('energy balances: what the source delivers is dissipated or stored', () => {
  const { nl, sim, node, tstop } = rcStep();
  const tr = sim.transient(tstop, [{ key: 'v', kind: 'vnet', index: node }], { maxSamples: 20000 });
  const last = tr.sampleCount - 1;
  const vEnd = tr.values[0][last];
  let total = 0;
  for (const e of tr.elementEnergy) total += e;
  const capEnergy = tr.elementEnergy[elementIndex(nl, 'capacitor')];
  const resEnergy = tr.elementEnergy[elementIndex(nl, 'resistor')];
  const srcEnergy = tr.elementEnergy[elementIndex(nl, 'vdc')];
  assert(srcEnergy < 0, 'the source delivers energy (negative absorbed energy)');
  assertClose(resEnergy + srcEnergy + capEnergy, 0, 1e-7, 'source + losses + storage = 0');
  assert(resEnergy > 0.9e-5, `the resistor dissipates the rest (${resEnergy.toExponential(2)} J)`);
  assert(srcEnergy < -1.2e-5, `the source delivered the round number (${srcEnergy.toExponential(2)} J)`);
  assertClose(capEnergy, 0.5 * 1e-6 * vEnd * vEnd, 0.05e-6 * 1, 'the capacitor holds ½CV²');
  assert(Math.abs(total) < 1e-7, `the energy balance closes (ΣE = ${total.toExponential(2)} J)`);
});

test('a square source is stepped on exactly at every edge', () => {
  const { b, lib, chips } = builder('square');
  const g = b.add('vsignal', { waveform: 'square', amp: 5, freq: 1000, duty: 0.5, tr: 1e-6, tf: 1e-6 }, [0, 0]);
  b.at(g, '+', 'out').at(g, '-', 'gnd');
  b.ground();
  const r = b.add('resistor', { r: 1000, tc1: 0 }, [2, 0]);
  b.at(r, '1', 'out').at(r, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { thermal: false });
  const sim = simulator(nl, { thermal: false, skipInitialDc: true });
  sim.state.mode = 'tran';
  const node = nl.ports.find((p) => p.name === 'OUT')!.node;
  const tr = sim.transient(3e-3, [{ key: 'v', kind: 'vnet', index: node }], { maxSamples: 20000 });
  assert(tr.ok, 'transient solved');
  // The oscillator period is 1 ms, so the 0.5/1.0/…/2.5 ms edges must be sample
  // points; the value there is the middle of the finite edge.
  for (const edge of [0.5e-3, 1e-3, 1.5e-3, 2e-3, 2.5e-3]) {
    let best = Infinity;
    for (let i = 0; i < tr.sampleCount; i++) best = Math.min(best, Math.abs(tr.times[i] - edge));
    assert(best < 1e-12, `edge at ${edge * 1e3} ms is a sample point (Δt = ${best.toExponential(2)} s)`);
  }
  const level = (t: number) => tr.values[0][tr.times.findIndex((x) => x >= t)];
  assertClose(level(0.4e-3), 5, 1e-6, 'high level is dc + amp');
  assertClose(level(0.9e-3), 0, 1e-6, 'low level is dc');
});

test('a source breakpoint is not stepped over: the step before an edge stops on it', () => {
  const { b, lib, chips } = builder('edge');
  const g = b.add('vsignal', { waveform: 'square', amp: 1, freq: 100, duty: 0.5, tr: 1e-9, tf: 1e-9 }, [0, 0]);
  b.at(g, '+', 'out').at(g, '-', 'gnd');
  b.ground();
  const r = b.add('resistor', { r: 100, tc1: 0 }, [2, 0]);
  b.at(r, '1', 'out').at(r, '2', 'gnd');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { thermal: false });
  const sim = simulator(nl, { thermal: false, skipInitialDc: true });
  sim.state.mode = 'tran';
  const node = nl.ports.find((p) => p.name === 'OUT')!.node;
  const tr = sim.transient(25e-3, [{ key: 'v', kind: 'vnet', index: node }], { maxSamples: 20000 });
  // 100 Hz → edges every 5 ms; all of them must appear as samples.
  for (const edge of [5e-3, 10e-3, 15e-3, 20e-3]) {
    let found = false;
    for (let i = 0; i < tr.sampleCount; i++) if (Math.abs(tr.times[i] - edge) < 1e-12) found = true;
    assert(found, `edge at ${edge * 1e3} ms was not stepped over`);
  }
  assert(tr.rejected < tr.steps, `rejections are the exception (${tr.rejected}/${tr.steps})`);
});
