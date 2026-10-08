/**
 * Statistics: per-component and per-circuit numbers, and the honesty rules that
 * go with them.
 *
 * The rule under test: a number is reported only when something computed it. A
 * circuit that was never solved has no power and no temperature — `null` and a
 * note, never a zero that could be mistaken for a measurement.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { AMBIENT, builder, flattenCircuit, simulator } from '../sim/helpers.js';
import { circuitStats, elementArrival, fmtNs, instanceStats, specStats } from '../../src/engine/analysis/stats.js';
import { buildLogicGraph } from '../../src/engine/analysis/logic.js';
import { analyzeTiming } from '../../src/engine/analysis/timing.js';
import type { CircuitBuilder } from '../../src/engine/core/build.js';
import type { Library } from '../../src/engine/core/library.js';

suite('stats');

function chain(b: CircuitBuilder): void {
  b.port('A', 'input', 'a', 1);
  b.port('Y', 'output', 'y', 1);
  const g1 = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
  const g2 = b.add('not_gate', { style: 'ideal' }, [0, 40]);
  const g3 = b.add('xor_gate', { style: 'ideal', inputs: 2 }, [0, 80]);
  b.at(g1, 'IN1', 'a').at(g1, 'IN2', 'a').at(g1, 'OUT', 'n1');
  b.at(g2, 'IN1', 'n1').at(g2, 'OUT', 'n2');
  b.at(g3, 'IN1', 'n2').at(g3, 'IN2', 'n1').at(g3, 'OUT', 'y');
}

function statsOf(build: (b: CircuitBuilder) => void) {
  const { b, lib, chips } = builder('stats');
  build(b);
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  return { nl, lib, chips };
}

test('circuitStats counts what the netlist contains, and nothing it does not', () => {
  const { nl, lib } = statsOf(chain);
  const { stats, instances, specs } = circuitStats(nl, { lib });
  assertEqual(stats.instances, 3, 'three components');
  assertEqual(stats.distinctSpecs, 3, 'three library types');
  assertEqual(stats.hierarchyDepth, 1, 'no nesting');
  assertEqual(stats.ports, 2, 'two ports');
  assertEqual(stats.elements, 3, 'one element per gate');
  assertEqual(stats.logic!.gates, 3, 'three gates at level 0');
  assertEqual(stats.logic!.sequential, 0, 'no register');
  assertEqual(stats.logic!.levels, 3, 'a → g1 → g2 → g3');
  assertEqual(stats.fanout!.max, 2, 'n1 feeds the not gate and the xor gate');
  assertEqual(stats.fanout!.dangling, 0, 'every output is read');
  assertEqual(instances.length, 3, 'one entry per instance');
  assertEqual(specs.length, 3, 'one entry per type');
  // Elements per instance: the map comes from the netlist provenance.
  const totalElements = instances.reduce((a, i) => a + i.elements, 0);
  assertEqual(totalElements, nl.elementCount, 'the per-instance element counts add up');
  const kinds = instances.flatMap((i) => i.elementKinds.map((k) => k.kind));
  // A kind is the *engine* vocabulary, not the logic function: the AND and the
  // XOR are both `LOGIC_GATE`, the inverter is `LOGIC_BUF`.
  assertEqual(new Set(kinds).size, 2, 'two distinct element kinds for three functions');
  assertEqual(stats.logic!.gates, 3, 'but three functions at level 0');
  assert(stats.ms >= 0, 'the report carries its own cost');
});

test('statistics are honest about what was not measured', () => {
  const { nl, lib } = statsOf(chain);
  const { stats } = circuitStats(nl, { lib });
  assertEqual(stats.electrical.totalPower, null, 'no power without a solved simulator');
  assertEqual(stats.electrical.totalDissipated, null, 'no dissipation either');
  assertEqual(stats.electrical.dissipatingElements, null, 'and no count of dissipating elements');
  assertEqual(stats.thermal, null, 'no thermal network in a digital-only netlist');
  assert(
    stats.notes.some((n) => n.includes('no solved simulator')),
    `the note says why (${stats.notes.join(' | ')})`,
  );
  assertEqual(instances_power(nl), null, 'per-instance power is null as well');
});

function instances_power(nl: ReturnType<typeof statsOf>['nl']): number | null {
  const stats = instanceStats(nl, {});
  return stats[0].power;
}

test('a solved circuit reports measured power, gross dissipation and supply', () => {
  const { b, lib, chips } = builder('power');
  const v = b.add('vdc', { dc: 9 }, [0, 0]);
  b.at(v, '+', 'vcc').at(v, '-', 'gnd');
  b.ground();
  const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [20, 0]);
  const r2 = b.add('resistor', { r: 2000, tc1: 0 }, [40, 0]);
  b.at(r1, '1', 'vcc').at(r1, '2', 'mid').at(r2, '1', 'mid').at(r2, '2', 'gnd');
  b.port('MID', 'output', 'mid', 1, 'analog');
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  const sim = simulator(nl, { thermal: true });
  sim.dcSolve();
  const { stats, instances } = circuitStats(nl, { lib, sim });
  // 9 V over 3 kΩ = 3 mA: 9 mW in R1 (1 kΩ) and 18 mW in R2 (2 kΩ).
  assertClose(stats.electrical.totalDissipated!, 0.027, 1e-5, 'gross dissipation 27 mW');
  assertClose(stats.electrical.totalSupplied!, 0.027, 1e-5, 'gross supply 27 mW');
  assert(Math.abs(stats.electrical.totalPower!) < 1e-7, 'the net sum is zero by conservation');
  assertEqual(stats.electrical.dissipatingElements, 2, 'two elements dissipate');
  const r1Stats = instances.find((i) => i.specId === 'resistor' && i.ref === 'R1')!;
  assertClose(r1Stats.power!, 0.009, 1e-5, 'R1 dissipates 9 mW');
  assert(r1Stats.temperature !== null, 'and it has a junction temperature (it owns a thermal node)');
  assertClose(r1Stats.temperature!, AMBIENT + 0.009 * 200, 0.5, 'the junction follows Rth·P within the model tolerances');
  assertEqual(stats.thermal!.nodes, 4, 'a junction and a case node per resistor');
  const r2Stats = instances.find((i) => i.ref === 'R2')!;
  assertClose(stats.thermal!.maxTemperature!, r2Stats.temperature!, 1e-6, 'the hottest junction is R2, which dissipates twice as much');
  assert(r2Stats.temperature! > r1Stats.temperature!, 'and it is hotter than R1');
});

test('specStats aggregates by type and ranks by instance count', () => {
  const { b, lib, chips } = builder('specs');
  for (let i = 0; i < 4; i++) b.add('and_gate', { style: 'ideal', inputs: 2 }, [i * 20, 0]);
  b.add('not_gate', { style: 'ideal' }, [0, 40]);
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  const instances = instanceStats(nl, {});
  const specs = specStats(instances, lib);
  assertEqual(specs[0].specId, 'and_gate', 'the most used type comes first');
  assertEqual(specs[0].instances, 4, 'four instances');
  assertEqual(specs[0].elements, 4, 'one element each');
  assertEqual(specs.find((s) => s.specId === 'not_gate')!.instances, 1, 'one inverter');
  // Every gate has no consumer on its output: the statistics must say so.
  assertEqual(specs[0].unusedInstances, 4, 'all four AND gates are unused');
});

test('elementArrival and fmtNs report the timing of one element', () => {
  const { b, lib, chips } = builder('arrival');
  chain(b);
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  const graph = buildLogicGraph(nl);
  const timing = analyzeTiming(graph);
  const arrivals = graph.elements.map((el) => elementArrival(el, timing));
  assertEqual(arrivals.length, 3, 'one arrival per gate');
  for (const a of arrivals) assert(a !== null && Number.isFinite(a!), `arrival is finite (${a})`);
  assertEqual(fmtNs(null), 'n/a', 'a missing time is reported as n/a, not 0');
  assertEqual(fmtNs(2.5e-9), '2.500 ns', 'nanoseconds are formatted');
  assertEqual(fmtNs(1.5e-6), '1.5000 µs', 'microseconds keep four decimals');
  assertEqual(fmtNs(2e-3), '2.0000 ms', 'milliseconds as well');
});
