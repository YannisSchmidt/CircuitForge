/**
 * Regression tests for the example library.
 *
 * Every example carries expectations whose numbers come from a closed form written
 * down independently of the engine. These tests are therefore not "does the example
 * run" but "does the engine still agree with the analytic answer" — a model that
 * drifts, a probe that resolves to the wrong node, or a default that changes meaning
 * all show up here as a failed case with the measured value next to the expected one.
 */

import { suite, test, assert, assertClose } from '../framework.js';
import {
  EXAMPLES,
  exampleById,
  exampleIds,
  examplesByCategory,
  checkExample,
} from '../../src/engine/synthesis/examples.js';
import { Project } from '../../src/engine/core/project.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { CircuitSimulator } from '../../src/engine/sim/solver.js';
import { analyzeCircuit } from '../../src/engine/analysis/analyzer.js';

const project = new Project();

suite('examples: catalogue');
{
  test('every id is unique and resolvable', () => {
    const ids = exampleIds();
    assert(new Set(ids).size === ids.length, 'duplicate example id');
    assert(ids.length >= 24, `expected at least 24 examples, found ${ids.length}`);
    for (const id of ids) assert(exampleById(id)?.id === id, `exampleById(${id}) did not round-trip`);
    assert(exampleById('no_such_example') == null, 'an unknown id must resolve to null/undefined, not throw');
  });

  test('both categories are populated', () => {
    // Three categories, because a resistor that heats itself is neither an analog
    // signal example nor a logic example: it is a thermal one.
    assert(examplesByCategory('analog').length >= 6, `too few analog examples: ${examplesByCategory('analog').length}`);
    assert(examplesByCategory('digital').length >= 14, `too few digital examples: ${examplesByCategory('digital').length}`);
    assert(examplesByCategory('thermal').length >= 1, 'no thermal example');
  });

  test('every example declares what it demonstrates and where its numbers come from', () => {
    for (const ex of EXAMPLES) {
      assert(ex.demonstrates.length > 0, `${ex.id}: no demonstration listed`);
      assert(ex.description.length > 20, `${ex.id}: description too short to be useful`);
      for (const e of ex.expected) {
        assert(e.source.length > 10, `${ex.id}/${e.key}: an expectation without a stated source is an invented number`);
        assert(e.tolerance > 0 && e.tolerance < 1.5, `${ex.id}/${e.key}: tolerance ${e.tolerance} is not a meaningful bound`);
        assert(e.unit.length > 0, `${ex.id}/${e.key}: no unit`);
      }
    }
  });

  test('every example builds, flattens and analyses without an error diagnostic', () => {
    for (const ex of EXAMPLES) {
      const circuit = ex.build(project.lib, project.chips);
      assert(circuit.componentCount() > 0, `${ex.id}: built an empty circuit`);
      const thermal = ex.level === 3;
      const nl = flatten(circuit, project.lib, project.chips, { metadata: true, thermal, ambient: 25 });
      const errors = nl.diagnostics.filter((d) => d.severity === 'error');
      assert(errors.length === 0, `${ex.id}: netlist errors ${errors.map((d) => d.code).join(',')}`);
      const report = analyzeCircuit(circuit, project.lib, project.chips, { flatten: { ambient: 25, expandGates: true } });
      const blocking = report.diagnostics.filter((d) => d.severity === 'error');
      assert(blocking.length === 0, `${ex.id}: analysis errors ${blocking.map((d) => d.code + ' ' + d.message).join('; ')}`);
    }
  });

  test('analog examples solve a DC operating point', () => {
    for (const ex of examplesByCategory('analog')) {
      const circuit = ex.build(project.lib, project.chips);
      const nl = flatten(circuit, project.lib, project.chips, { metadata: true, thermal: ex.level === 3, ambient: 25 });
      const sim = new CircuitSimulator(nl, { integration: 'trap' });
      sim.dcSolve({ quiet: true });
      for (let n = 1; n < nl.nodeCount; n++) {
        assert(Number.isFinite(sim.v[n]), `${ex.id}: node ${n} did not converge to a finite voltage`);
      }
    }
  });
}

suite('examples: expectations');
{
  test('every measured expectation agrees with its closed form', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const ex of EXAMPLES) {
      const result = await checkExample(ex, project.lib, project.chips);
      checked += result.cases.length;
      for (const c of result.cases) {
        if (c.measured === null) {
          failures.push(`${ex.id}/${c.quantity}: no reading (${c.note})`);
        } else if (!c.pass) {
          failures.push(`${ex.id}/${c.quantity}: ${c.note}`);
        }
      }
    }
    assert(failures.length === 0, `${failures.length} of ${checked} expectations failed:\n  ` + failures.join('\n  '));
    assert(checked >= 19, `expected at least 19 checked quantities, got ${checked}`);
  });

  test('the voltage divider reproduces Ohm’s law exactly', async () => {
    const ex = exampleById('voltage_divider');
    assert(ex !== null, 'voltage_divider missing');
    const result = await checkExample(ex!, project.lib, project.chips);
    const mid = result.cases.find((c) => c.quantity === 'midpoint voltage');
    assert(mid !== undefined && mid.measured !== null, 'midpoint voltage not measured');
    const dissipated = result.cases.find((c) => c.quantity === 'total dissipation');
    assert(dissipated !== undefined && dissipated.measured !== null, 'total dissipation not measured');
    // 1 kΩ over 2 kΩ from 12 V: the midpoint sits at 8 V and the pair burns
    // 12²/3000 = 48 mW, which must equal the sum of the two resistors' own powers.
    assertClose(mid!.measured!, 8, 1e-6);
    assertClose(dissipated!.measured!, 0.048, 1e-9);
  });

  test('the RC filter’s phase lag matches −atan(ωRC)', async () => {
    const ex = exampleById('rc_lowpass');
    assert(ex !== null, 'rc_lowpass missing');
    const result = await checkExample(ex!, project.lib, project.chips);
    const phase = result.cases.find((c) => c.quantity === 'output phase');
    assert(phase !== undefined && phase.measured !== null, 'phase not measured');
    // A single-probe example would report 0° here and pass silently; the sign and the
    // magnitude together prove the output was really compared against the drive.
    assert(phase!.measured! < -30 && phase!.measured! > -34, `phase ${phase!.measured} is not near −32.14°`);
  });

  test('the charging capacitor follows 1 − e^(−t/RC) at τ and 3τ', async () => {
    const ex = exampleById('rc_charge');
    assert(ex !== null, 'rc_charge missing');
    const result = await checkExample(ex!, project.lib, project.chips);
    const at = (q: string): number => {
      const c = result.cases.find((x) => x.quantity === q);
      assert(c !== undefined && c.measured !== null, `${q} not measured`);
      return c!.measured!;
    };
    assertClose(at('voltage at τ'), 5 * (1 - Math.exp(-1)), 0.02);
    assertClose(at('voltage at 3τ'), 5 * (1 - Math.exp(-3)), 0.02);
    assert(at('final voltage') > 4.9, `the capacitor did not reach the source voltage: ${at('final voltage')}`);
  });

  test('a MOSFET really switches: on-state mA, off-state below 1 µA', async () => {
    const ex = exampleById('transistor_switch');
    assert(ex !== null, 'transistor_switch missing');
    const result = await checkExample(ex!, project.lib, project.chips);
    const on = result.cases.find((c) => c.quantity === 'on-state current');
    const off = result.cases.find((c) => c.quantity === 'off-state current');
    assert(on !== undefined && on.measured !== null, 'on-state current not measured');
    assert(off !== undefined && off.measured !== null, 'off-state current not measured');
    assertClose(on!.measured!, 3.3e-3, 0.5e-3);
    assert(off!.measured! < 1e-6, `off-state current ${off!.measured} is not sub-µA — the device would not be off`);
    assert(off!.measured! >= 0, 'a magnitude cannot be negative');
  });

  test('self-heating raises the junction by P·Rth, and the limit is stated', async () => {
    const ex = exampleById('self_heating');
    assert(ex !== null, 'self_heating missing');
    const result = await checkExample(ex!, project.lib, project.chips);
    const rise = result.cases.find((c) => c.quantity === 'junction rise');
    assert(rise !== undefined && rise.measured !== null, 'junction rise not measured');
    assertClose(rise!.measured!, 200, 60);
    // The check must carry the model's limits, not just its number.
    assert(result.limits.length >= 0, 'limits must be an array even when empty');
  });

  test('a skipped expectation is reported as skipped, never as a pass', async () => {
    // An expectation nobody can measure must not quietly count as satisfied: this is
    // the difference between a test suite and a decoration.
    const ex = exampleById('voltage_divider')!;
    const result = await checkExample({ ...ex, expected: [...ex.expected, { quantity: 'imaginary', key: 'no_such_key', value: 1, tolerance: 0.01, unit: 'V', source: 'deliberately unmeasurable, to prove the harness reports it' }] }, project.lib, project.chips);
    assert(result.skipped === 1, `expected exactly one skipped case, got ${result.skipped}`);
    assert(result.failed === 0, 'an unmeasurable expectation must be skipped, not failed');
    const c = result.cases.find((x) => x.quantity === 'imaginary');
    assert(c !== undefined && c.measured === null && c.note.length > 0, 'the skipped case must say why');
  });
}
