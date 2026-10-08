/**
 * Automatic validation.
 *
 * These cases are written to catch the failure mode the specification forbids: a
 * report that says "validated" without having measured anything. So they assert
 * on the *scope* of the report as much as on its verdict — which check ran, which
 * was skipped and why, how many vectors were checked, whether coverage was
 * exhaustive, and which model produced each number.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, AMBIENT } from '../sim/helpers.js';
import {
  ValidationSession,
  specFromCircuit,
  validateCircuit,
  validationToText,
  reportAccuracy,
  planValidationVectors,
} from '../../src/engine/validate/validation.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { Rng } from '../../src/engine/util/rng.js';
import { andNotSpec, adderSpec } from '../../src/engine/optim/spec.js';
import { Accuracy } from '../../src/engine/core/labels.js';
import type { Circuit } from '../../src/engine/core/circuit.js';
import type { Library } from '../../src/engine/core/library.js';
import type { ChipLibrary } from '../../src/engine/core/chip.js';

suite('validation');

/** `Y0 = A0 & ~B0`, with declared gate delays so the timing check has numbers. */
function andNot(gateParams: Record<string, number> = {}): { circuit: Circuit; lib: Library; chips: ChipLibrary } {
  const { b, lib, chips } = builder('and-not');
  b.port('A0', 'input', 'a', 1);
  b.port('B0', 'input', 'b', 1);
  b.port('Y0', 'output', 'y', 1);
  const params = { inputs: 2, tphl: 1.2e-9, tplh: 1.4e-9, ...gateParams };
  const inv = b.add('not_gate', { ...params, inputs: 1 }, [0, 0]);
  const and = b.add('and_gate', params, [60, 0]);
  b.at(inv, 'IN1', 'b').at(inv, 'OUT', 'nb');
  b.at(and, 'IN1', 'a').at(and, 'IN2', 'nb').at(and, 'OUT', 'y');
  return { circuit: b.finish({ erc: false }), lib, chips };
}

/** The same circuit with the output wired straight to A — a real functional bug. */
function wrongAndNot(): { circuit: Circuit; lib: Library; chips: ChipLibrary } {
  const { b, lib, chips } = builder('and-not-wrong');
  b.port('A0', 'input', 'a', 1);
  b.port('B0', 'input', 'b', 1);
  b.port('Y0', 'output', 'y', 1);
  const inv = b.add('not_gate', { inputs: 1, tphl: 1.2e-9, tplh: 1.4e-9 }, [0, 0]);
  b.at(inv, 'IN1', 'b').at(inv, 'OUT', 'nb');
  // The AND is there but its output goes nowhere; Y follows A.
  const buf = b.add('buffer', { inputs: 1, tphl: 1e-9, tplh: 1e-9 }, [60, 0]);
  b.at(buf, 'IN1', 'a').at(buf, 'OUT', 'y');
  return { circuit: b.finish({ erc: false }), lib, chips };
}

const find = (report: ReturnType<typeof validateCircuit>, id: string) => {
  const c = report.checks.find((x) => x.id === id);
  assert(!!c, `no check "${id}" in the report (got ${report.checks.map((x) => x.id).join(', ')})`);
  return c!;
};

test('a correct design is validated, and the report states its conditions', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'and_not_1', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  assertEqual(report.claim, 'VALIDATED UNDER THE STATED CONDITIONS', 'the verdict');
  assert(report.ok, 'ok must be true');
  assertEqual(report.failures.length, 0, `no failure expected, got: ${report.failures.join(' | ')}`);
  // The contract check must have compared real vectors.
  const logic = find(report, 'logic');
  assert(logic.ran, 'the logic check ran');
  assertEqual(logic.level, 0, 'the logic check is a level-0 measurement');
  assertEqual(logic.accuracy, Accuracy.REALISTIC, 'level 0 is exact for a declared contract');
  assertEqual(Number(logic.metrics.vectors), 4, 'a 2-bit input space is 4 vectors');
  assertEqual(Number(logic.metrics.mismatches), 0, 'no mismatch');
  assertEqual(logic.metrics.coverage, 'exhaustive', 'coverage must be reported as exhaustive');
  assertEqual(report.conditions.vectors.exhaustive, true, 'the conditions repeat the coverage');
  assert(report.conditions.vectors.total >= 4, 'edge cases add vectors on top of the contract');
});

test('a wrong design fails, and the report says which vector broke', () => {
  const { circuit, lib, chips } = wrongAndNot();
  const report = validateCircuit({ circuit, name: 'wrong', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  assertEqual(report.claim, 'FAILED VALIDATION', 'the verdict');
  assert(!report.ok, 'ok must be false');
  const logic = find(report, 'logic');
  assert(logic.failed > 0, 'the logic check must have failed cases');
  assert(Number(logic.metrics.mismatches) > 0, 'a mismatch was counted');
  assert(report.failures.some((f) => f.includes('Logic contract')), 'the failure list names the check');
  assert(report.failures.some((f) => /expected/.test(f)), 'the failure detail quotes the expected value');
});

test('every check names its level, its accuracy and its limits', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'and_not_1', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  for (const c of report.checks) {
    assert(typeof c.level === 'number', `${c.id} has a simulation level`);
    assert(Object.values(Accuracy).includes(c.accuracy), `${c.id} has an accuracy class`);
    assert(c.limits.length > 0, `${c.id} states what it does not cover`);
    assert(c.name.length > 0, `${c.id} has a name`);
    if (!c.ran) assert(c.skippedReason !== null && c.skippedReason.length > 0, `${c.id} explains why it was skipped`);
  }
  const electrical = find(report, 'electrical');
  assertEqual(electrical.level, 1, 'the DC check is level 1');
  const thermal = find(report, 'thermal');
  assertEqual(thermal.level, 3, 'the thermal check is level 3');
});

test('the level-1 and level-3 numbers are real measurements', () => {
  const { circuit, lib, chips } = andNot();
  // Force the transistor implementation: an 'ideal' gate is a controlled source,
  // and its operating point would say nothing about devices.
  const report = validateCircuit({ circuit, name: 'and_not_1', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, gateStyle: 'cmos_static' });
  assertEqual(report.conditions.gateStyle, 'cmos_static forced on 2 logic gate(s)', 'the report says which style was measured');
  const electrical = find(report, 'electrical');
  assert(electrical.ran, 'the electrical check ran on the expanded netlist');
  assert(Number(electrical.metrics.expandedTransistors) >= 6, `gates were expanded to transistors (${electrical.metrics.expandedTransistors})`);
  assertEqual(Number(electrical.metrics.behaviouralGates), 0, 'no behavioural gate is left in the measured netlist');
  assert(electrical.cases.some((c) => c.name.includes('converged') && c.passed), 'Newton converged');
  const power = find(report, 'power');
  assert(power.ran, 'the power check ran');
  const dissipated = Number(power.metrics.dissipatedW);
  const supplied = Number(power.metrics.suppliedW);
  assert(dissipated >= 0 && Number.isFinite(dissipated), `dissipated power is a finite non-negative number (${dissipated})`);
  assert(supplied >= 0 && Number.isFinite(supplied), `supplied power is a finite non-negative number (${supplied})`);
  const thermal = find(report, 'thermal');
  assert(thermal.ran, 'the thermal check ran');
  const tMax = Number(thermal.metrics.maxTemperatureC);
  assert(Number.isFinite(tMax), `the hottest node has a temperature (${tMax})`);
  assert(tMax >= AMBIENT - 1, `the junction cannot be colder than the ambient (${tMax} vs ${AMBIENT})`);
  assert(tMax < AMBIENT + 5, `a leakage-only gate barely self-heats (${tMax} °C)`);
  assertEqual(reportAccuracy(report), Accuracy.APPROXIMATED, 'a transistor-level run is APPROXIMATED, not IDEALIZED');
});

test('ideal gates are reported as the idealised model, never as transistors', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'and_not_1', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const electrical = find(report, 'electrical');
  assertEqual(Number(electrical.metrics.expandedTransistors), 0, 'nothing was expanded');
  assertEqual(Number(electrical.metrics.behaviouralGates), 2, 'both gates are behavioural');
  assertEqual(electrical.accuracy, Accuracy.IDEALIZED, 'the accuracy drops to IDEALIZED');
  assert(electrical.limits.some((l) => l.includes('cmos_static')), 'the limits tell the reader how to get device-level numbers');
  assertEqual(report.conditions.gateStyle, 'as authored (no gate style was forced)', 'the conditions say no style was forced');
  assert(report.notes.some((n) => n.includes('idealised behavioural gate model')), 'the report notes repeat it');
  assertEqual(reportAccuracy(report), Accuracy.IDEALIZED, 'the report label follows the weakest check that ran');
  // The floating ideal-gate netlist is a property of the model, not a defect of
  // the design: it must be stated, not failed.
  assert(!electrical.cases.some((c) => c.name.includes('0 V reference')), 'the missing reference is scope, not a failed case');
  assert(electrical.limits.some((l) => l.includes('gmin')), 'and the gmin reference is explained');
});

test('edge cases are reported one pattern at a time', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'and_not_1', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const edge = find(report, 'edge');
  assert(edge.ran, 'the edge-case check ran');
  const names = edge.cases.map((c) => c.name);
  assert(names.includes('all inputs low'), 'all-low pattern present');
  assert(names.includes('all inputs high'), 'all-high pattern present');
  assert(names.some((n) => n.includes('walking one')), 'walking-one pattern present');
  assert(names.some((n) => n.includes('walking zero')), 'walking-zero pattern present');
  assert(edge.cases.every((c) => c.passed), `every edge case passed: ${edge.cases.filter((c) => !c.passed).map((c) => c.detail).join(' | ')}`);
});

test('random vectors are seeded, and the seed appears in the report', () => {
  const { circuit, lib, chips } = andNot();
  const spec = andNotSpec(1);
  const a = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec, ambient: AMBIENT, seed: 'fixed-seed', randomVectors: 16 });
  const b = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec, ambient: AMBIENT, seed: 'fixed-seed', randomVectors: 16 });
  const ra = find(a, 'random');
  const rb = find(b, 'random');
  assert(ra.ran && rb.ran, 'the random check ran');
  assertEqual(ra.metrics.seed, 'fixed-seed', 'the seed is recorded');
  assertEqual(Number(ra.metrics.vectors), 16, 'the requested number of vectors ran');
  assertEqual(ra.cases.map((c) => c.detail).join(), rb.cases.map((c) => c.detail).join(), 'the same seed gives the same run');
  assertEqual(a.conditions.seed, 'fixed-seed', 'the conditions carry the seed');
});

test('determinism: repeats produce identical logic and identical DC solutions', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, repeats: 3 });
  const stability = find(report, 'stability');
  assert(stability.ran, 'the stability check ran');
  assert(stability.cases.some((c) => c.name.includes('identical results') && c.passed), 'logic runs agree');
  assert(stability.cases.some((c) => c.name.includes('DC solves agree') && c.passed), 'DC solves agree');
  assertEqual(Number(stability.metrics.deterministic), 1, 'the metric says deterministic');
});

test('the serialization round trip reproduces the fingerprint exactly', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const ser = find(report, 'serialization');
  assert(ser.ran, 'the round-trip check ran');
  assert(ser.passed > 0 && ser.failed === 0, 'the round trip passed');
  assertEqual(String(ser.metrics.fingerprint), String(ser.metrics.roundTripFingerprint), 'the fingerprint is identical');
  assertEqual(report.subject.fingerprint, circuit.fingerprint(lib), 'the subject fingerprint matches the circuit');
});

test('timing reports a lower bound when gates declare no delay — and says so', () => {
  const { circuit, lib, chips } = andNot({ tphl: 0, tplh: 0 });
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const timing = find(report, 'timing');
  assert(timing.ran, 'the timing check ran');
  // Missing delay data is a property of the models, not a defect in the design, so it
  // is recorded as a limitation of the check rather than as a failed case: failing the
  // whole validation here would bury the real verdict under a complaint about the
  // library, and every gate in the default library declares 0 s.
  const bound = timing.cases.find((c) => c.name.includes('lower bound'));
  assert(!!bound && bound.passed, 'the lower-bound case is a statement about the report, and it holds');
  assert(bound!.detail.includes('declare 0 s'), 'the detail says how many elements declare no delay');
  assertEqual(timing.failed, 0, 'an incomplete delay model does not fail the design');
  assert(
    timing.limits.some((l) => l.includes('lower bound') && l.includes('no propagation delay')),
    'the limits state that every delay here is a lower bound and how to get a real one',
  );
  assertEqual(timing.accuracy, Accuracy.IDEALIZED, 'an all-ideal timing report drops to IDEALIZED');
  assert(timing.limits.some((l) => l.toLowerCase().includes('hold')), 'the limits admit hold time is not modelled');
  assert(
    !timing.cases.some((c) => c.name.includes('every logic element declares a propagation delay')),
    'with no delay data the completeness case is replaced by the lower-bound one, not reported alongside it',
  );
});

test('a design whose gates all declare delays passes the delay-completeness case', () => {
  const { circuit, lib, chips } = andNot({ tphl: 1.2e-9, tplh: 1.4e-9 });
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, levels: { timing: true, erc: false, logic: false, edge: false, random: false, electrical: false, power: false, thermal: false, stability: false, serialization: false } });
  const timing = find(report, 'timing');
  const declared = timing.cases.find((c) => c.name.includes('declares a propagation delay'));
  assert(!!declared && declared.passed, 'all elements declare tphl and tplh');
  assertEqual(timing.accuracy, Accuracy.APPROXIMATED, 'with declared delays the report is APPROXIMATED, not IDEALIZED');
  assert(!timing.limits.some((l) => l.includes('no propagation delay')), 'no lower-bound limitation is claimed when the data is there');
});

test('a clock target turns the timing check into a pass/fail verdict', () => {
  const { circuit, lib, chips } = andNot();
  // The path is one inverter plus one AND: ~2.6 ns. A 10 ns period passes, 1 ns fails.
  const loose = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, clockPeriod: 1e-8, levels: { timing: true, erc: false, logic: false, edge: false, random: false, electrical: false, power: false, thermal: false, stability: false, serialization: false } });
  const tight = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, clockPeriod: 1e-9, levels: { timing: true, erc: false, logic: false, edge: false, random: false, electrical: false, power: false, thermal: false, stability: false, serialization: false } });
  const lt = find(loose, 'timing');
  const tt = find(tight, 'timing');
  assert(lt.cases.some((c) => c.name.includes('target') && c.passed), 'the 10 ns target is met');
  assert(tt.cases.some((c) => c.name.includes('target') && !c.passed), 'the 1 ns target is missed');
  assertEqual(tight.claim, 'FAILED VALIDATION', 'missing the target fails the validation');
});

test('checks that cannot run are skipped with a reason, never passed', () => {
  const { circuit, lib, chips } = andNot();
  // No behavioural contract: the random check has nothing to compare against.
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: specFromCircuit(circuit), ambient: AMBIENT });
  const random = find(report, 'random');
  assert(!random.ran, 'the random check did not run');
  assert(random.skippedReason !== null, 'it says why');
  assert(random.skippedReason!.includes('behavioural contract'), 'the reason names the missing input');
  assertEqual(random.passed, 0, 'a skipped check scores nothing');
  assert(report.totals.skippedChecks >= 1, 'the totals count the skipped check');
  assert(report.notes.some((n) => n.includes('behavioural contract')), 'the scope notes repeat it');
  // Without a contract the logic check still ran, and says what it verified.
  const logic = find(report, 'logic');
  assert(logic.ran, 'the logic check still ran');
  assertEqual(logic.metrics.contract, 'port contract only (no expectation supplied)', 'the weaker contract is named');
});

test('a port mismatch is reported, not guessed around', () => {
  const { circuit, lib, chips } = andNot();
  // The circuit is 1 bit wide; asking for a 4-bit adder contract cannot work.
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: adderSpec(4), ambient: AMBIENT });
  const logic = find(report, 'logic');
  assert(!logic.ran, 'the logic check did not run');
  assert(logic.skippedReason!.includes('does not expose'), 'the reason says the ports are missing');
  assertEqual(logic.blocking, true, 'the skip blocks any verdict');
  // Other checks did run and passed, and the claim must still refuse to say
  // "validated": the functional contract was never applied.
  assert(report.totals.ran > 0, 'other checks ran');
  assertEqual(report.totals.failed, 0, 'nothing that ran failed');
  assertEqual(report.claim, 'NOT VALIDATED', 'no verdict without the contract');
  assertEqual(report.ok, false, 'ok is false');
  assert(report.notes.some((n) => n.includes('No verdict is possible')), 'the notes say why there is no verdict');
  assertEqual(find(report, 'edge').blocking, true, 'the edge cases are blocked by the same mismatch');
});

test('a vector port is bound by name whether it is per-bit or single', () => {
  const { circuit, lib, chips } = andNot();
  // Derived from the circuit's own ports: A0/B0/Y0 group into A/B/Y of width 1,
  // and the harness must find them again as A0/B0/Y0.
  const spec = specFromCircuit(circuit);
  assertEqual(spec.inputs.map((p) => `${p.name}:${p.width}`).join(','), 'A:1,B:1', 'the input ports were grouped');
  assertEqual(spec.outputs.map((p) => `${p.name}:${p.width}`).join(','), 'Y:1', 'the output ports were grouped');
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec, ambient: AMBIENT });
  const logic = find(report, 'logic');
  assert(logic.ran, `the logic check ran against the derived contract (${logic.skippedReason})`);
  assertEqual(logic.blocking, false, 'nothing blocked it');
});

test('the session is steppable: one check per step', () => {
  const { circuit, lib, chips } = andNot();
  const session = new ValidationSession({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const total = session.totalChecks;
  assert(total >= 8, `the session plans every check (${total})`);
  assertEqual(session.ranChecks, 0, 'nothing has run yet');
  const seen: string[] = [];
  let guard = 0;
  while (!session.done && guard++ < 100) {
    const next = session.nextCheck;
    session.step();
    seen.push(next ?? '?');
    assertEqual(session.ranChecks, seen.length, 'one check per step');
  }
  assertEqual(seen.length, total, 'every planned check ran exactly once');
  const report = session.report();
  assertEqual(report.checks.length, total, 'the report carries every check');
  assertEqual(report.claim, 'VALIDATED UNDER THE STATED CONDITIONS', 'the verdict after a full session');
  // A report taken mid-session must describe only what was measured.
  const partial = new ValidationSession({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  partial.step();
  partial.step();
  const mid = partial.report();
  assertEqual(mid.checks.length, 2, 'a partial report has two checks');
  assert(mid.notes.length >= 0, 'a partial report is still well formed');
});

test('levels can be switched off, and the totals follow', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit(
    { circuit, name: 'n', kind: 'circuit' },
    { lib, chips, spec: andNotSpec(1), ambient: AMBIENT, levels: { erc: false, electrical: false, power: false, thermal: false, stability: false, serialization: false, timing: false, random: false } },
  );
  const ids = report.checks.map((c) => c.id);
  assert(ids.includes('logic') && ids.includes('edge'), 'the requested checks are present');
  assert(!ids.includes('thermal') && !ids.includes('erc'), 'the disabled checks are absent, not skipped');
  assertEqual(report.totals.checks, 2, 'two checks ran');
});

test('the text report quotes the claim, the conditions and the scope notes', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  const text = validationToText(report, { verbose: true });
  assert(text.includes('VALIDATED UNDER THE STATED CONDITIONS'), 'the claim is printed');
  assert(text.includes('conditions'), 'the conditions are printed');
  assert(text.includes('seed'), 'the seed is printed');
  assert(text.includes('exhaustive'), 'the coverage is printed');
  assert(text.includes('PASS'), 'check verdicts are printed');
  assert(text.includes('limit:'), 'verbose mode prints the limits');
  assert(text.includes('engine'), 'the engine version is printed');
  assert(!/\bOPTIMAL\b/.test(text), 'the report never claims optimality');
  assert(!/\bREALISTIC\b.*guarantee/i.test(text), 'no guarantee language');
  assert(reportAccuracy(report) === Accuracy.IDEALIZED || reportAccuracy(report) === Accuracy.APPROXIMATED, 'the report label is the weakest accuracy that ran');
});

test('no check ever reports a non-finite metric as if it were measured', () => {
  const { circuit, lib, chips } = andNot();
  const report = validateCircuit({ circuit, name: 'n', kind: 'circuit' }, { lib, chips, spec: andNotSpec(1), ambient: AMBIENT });
  for (const c of report.checks) {
    for (const [key, value] of Object.entries(c.metrics)) {
      if (typeof value === 'number') {
        assert(Number.isFinite(value), `${c.id}.${key} = ${value} is not finite`);
      } else {
        assert(value === null || typeof value === 'string', `${c.id}.${key} has a reportable type`);
      }
    }
    for (const k of c.cases) {
      assert(!/NaN|Infinity|undefined/.test(k.detail), `${c.id} → ${k.name} quotes a non-number: ${k.detail}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Regressions: the comparison, the vectors, and hierarchical subjects
// ---------------------------------------------------------------------------

suite('validation: regressions');

test('expected outputs are read per port width, not out of the first port', () => {
  // A 1-bit adder has two output ports of one bit each (S then CO). Reading the
  // expected value as "bit k of the first port" compares the measured carry against
  // the expected sum, which fails on exactly the vectors where the two differ — four
  // of eight — and reports a correct full adder as a broken one.
  const project = buildReferenceProject('validation regression');
  const chip = project.chips.get('full_adder');
  assert(!!chip, 'the reference library has no full_adder');
  const report = validateCircuit(
    { circuit: chip!.implementation({}), name: 'full_adder', kind: 'chip', chipId: 'full_adder' },
    { lib: project.lib, chips: project.chips, spec: adderSpec(1), ambient: AMBIENT },
  );
  const logic = find(report, 'logic');
  assert(logic.ran, 'the logic contract ran');
  assertEqual(logic.failed, 0, `a correct full adder must match its spec: ${logic.cases.map((c) => c.detail).join(' | ')}`);
  assertEqual(Number(logic.metrics.comparisons), 16, '8 vectors × 2 output bits');
  assertEqual(Number(logic.metrics.mismatches), 0, 'no mismatch');
  assertEqual(report.claim, 'VALIDATED UNDER THE STATED CONDITIONS', 'the whole report passes');
});

test('a wide multi-port spec validates exhaustively across every output bit', () => {
  // S is 4 bits and CO is 1, so the flat output-bit index crosses a port boundary at
  // bit 4. This is the case that a per-port flattening has to get right.
  const project = buildReferenceProject('validation regression');
  const chip = project.chips.get('ripple_adder');
  assert(!!chip, 'the reference library has no ripple_adder');
  const report = validateCircuit(
    { circuit: chip!.implementation({ bits: 4 }), name: 'ripple_adder', kind: 'chip', chipId: 'ripple_adder', chipVersion: chip!.version },
    { lib: project.lib, chips: project.chips, spec: adderSpec(4), params: { bits: 4 }, ambient: AMBIENT },
  );
  const logic = find(report, 'logic');
  assertEqual(Number(logic.metrics.vectors), 512, 'the 9-bit input space is enumerated');
  assertEqual(Number(logic.metrics.outputBits), 5, 'S[4] plus CO');
  assertEqual(Number(logic.metrics.comparisons), 2560, '512 × 5');
  assertEqual(logic.failed, 0, `exhaustive contract failed: ${logic.cases.map((c) => c.detail).join(' | ')}`);
  assertEqual(report.claim, 'VALIDATED UNDER THE STATED CONDITIONS', 'a correct 4-bit adder validates');
});

test('every generated edge vector fits the port it is driven on', () => {
  // The harness drives one lane per bit, so a value wider than its port is truncated
  // on the way in while `behaviour` is asked about the untruncated number: the two
  // sides then disagree about which vector was tested, and a correct design fails its
  // own edge cases. With a 4-bit A and B and a 1-bit CI, the ±1-around-a-corner
  // pattern used to put 15 on CI.
  const spec = adderSpec(4);
  const vv = planValidationVectors(spec, { lib: buildReferenceProject('edge vectors').lib, randomVectors: 0 }, new Rng(7));
  const groups = vv.edges;
  assert(groups.length > 0, 'edge patterns were generated');
  let checked = 0;
  for (const group of groups) {
    for (const vector of group.vectors) {
      for (let pi = 0; pi < spec.inputs.length; pi++) {
        const width = Math.max(1, Math.round(spec.inputs[pi].width));
        const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
        const value = vector.in[pi] ?? 0;
        assert(
          (value & ~mask) === 0,
          `${group.name}: input ${spec.inputs[pi].name} = ${value} does not fit ${width} bit(s) — the driven value would not be the expected one`,
        );
        checked++;
      }
      // The expectation must be computed from the same numbers that get driven.
      if (vector.out.length === spec.outputs.length && spec.behaviour) {
        const again = spec.behaviour(vector.in);
        for (let k = 0; k < again.length; k++) assertEqual(vector.out[k], again[k], `${group.name}: the stored expectation is not behaviour(in)`);
      }
    }
  }
  assert(checked >= 60, `expected every port of every edge vector to be checked, got ${checked}`);
});

test('a hierarchical subject is digital, passes the ERC and survives the round trip', () => {
  // Three separate lookups used to stop at the primitive library and report a chip
  // instance as an unknown type: isDigital (which turned "no ground" into a warning
  // on a purely logic circuit), erc (CF3002 for every full adder in a ripple adder)
  // and the file loader (which dropped the components and every net touching them).
  const project = buildReferenceProject('validation regression');
  const chip = project.chips.get('ripple_adder');
  const circuit = chip!.implementation({ bits: 4 });
  assert(circuit.isDigital(project.lib, project.chips), 'a ripple adder of full adders is a digital circuit');
  const erc = circuit.erc(project.lib, project.chips);
  const errors = erc.filter((d) => d.severity === 'error');
  const warnings = erc.filter((d) => d.severity === 'warning');
  assertEqual(errors.length, 0, `ERC errors: ${errors.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  assertEqual(warnings.length, 0, `ERC warnings on a logic-only circuit: ${warnings.map((d) => `${d.code} ${d.message}`).join('; ')}`);

  const report = validateCircuit(
    { circuit, name: 'ripple_adder', kind: 'chip', chipId: 'ripple_adder' },
    { lib: project.lib, chips: project.chips, spec: adderSpec(4), params: { bits: 4 }, ambient: AMBIENT },
  );
  const ercCheck = find(report, 'erc');
  assertEqual(ercCheck.failed, 0, `the ERC check failed: ${ercCheck.cases.map((c) => c.detail).join(' | ')}`);
  const ser = find(report, 'serialization');
  assert(ser.ran, 'the round-trip check ran');
  assertEqual(ser.failed, 0, `the round trip failed: ${ser.cases.map((c) => c.detail).join(' | ')}`);
  assertEqual(String(ser.metrics.fingerprint), String(ser.metrics.roundTripFingerprint), 'a hierarchy reloads to the same netlist');
});

test('an unknown type is still an error when no chip provides it either', () => {
  // The fallback must not become a way to load anything: a component that names
  // neither a primitive nor a chip in the project is still refused, and the nets that
  // referenced it are still reported rather than silently kept.
  const project = buildReferenceProject('validation regression');
  const circuit = project.chips.get('ripple_adder')!.implementation({ bits: 4 });
  const doc = circuitToDocument(circuit);
  doc.components = [{ id: 1, spec: 'no_such_part', ref: 'X1', x: 0, y: 0, bits: 1, params: {} } as never];
  const loaded = circuitFromDocument(doc, project.lib, project.chips);
  const codes = loaded.diagnostics.map((d) => d.code);
  assert(codes.includes('CF6002'), `expected CF6002 for an unknown type, got ${codes.join(', ') || 'no diagnostics'}`);
  const message = loaded.diagnostics.find((d) => d.code === 'CF6002')!.message;
  assert(message.includes('no_such_part'), 'the diagnostic names the type it could not resolve');
});

// Imported here rather than at the top so the regression block reads on its own.
import { circuitFromDocument, circuitToDocument } from '../../src/engine/io/serialize.js';
