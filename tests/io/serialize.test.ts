/**
 * Serialization: a saved design must come back *identical*, and a damaged file
 * must be reported precisely instead of producing a quietly different circuit.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, testProject } from '../sim/helpers.js';
import { chipHarness } from '../synthesis/helpers.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { buildReferenceChips } from '../../src/engine/synthesis/reference.js';
import { loadProjectText, saveProjectText } from '../../src/engine/io/project-file.js';
import {
  CIRCUIT_FORMAT,
  chipToDocument,
  circuitFromDocument,
  circuitToDocument,
  type ProjectDocument,
} from '../../src/engine/io/serialize.js';
import { Severity } from '../../src/engine/core/labels.js';

suite('io/serialize');

test('a circuit round-trips with the same structure, ids, refs and fingerprint', () => {
  const { b, lib, chips } = builder('round-trip');
  const r1 = b.add('resistor', { r: 1000 }, [0, 0]);
  const r2 = b.add('resistor', { r: 2000 }, [80, 0]);
  const gnd = b.add('ground', {}, [40, 120]);
  b.at(r1, '1', 'in').at(gnd, '0', 'in');
  b.at(r1, '2', 'mid').at(r2, '1', 'mid');
  b.at(r2, '2', 'out').at(gnd, '0', 'out');
  b.port('IN', 'input', 'in', 1, 'analog');
  b.port('OUT', 'output', 'out', 1, 'analog');
  const circuit = b.finish({ erc: false });

  const doc = circuitToDocument(circuit);
  assertEqual(doc.format, CIRCUIT_FORMAT, 'format tag');
  const { circuit: back, diagnostics } = circuitFromDocument(JSON.parse(JSON.stringify(doc)), lib, chips);
  assertEqual(diagnostics.length, 0, `no diagnostics on a clean round trip: ${diagnostics.map((d) => d.message).join('; ')}`);
  assertEqual(back.fingerprint(), circuit.fingerprint(), 'structural fingerprint');
  assertEqual(back.componentCount(), 3, 'component count');
  assertEqual(back.netCount(), circuit.netCount(), 'net count');
  assertEqual(back.allComponents().map((c) => `${c.id}:${c.ref}`).join(','), '1:R1,2:R2,3:GND1', 'ids and references are preserved');
  assertEqual(back.netOf(r1.id, '2')?.name, 'mid', 'connection restored');
  assertEqual(back.allPorts().map((p) => `${p.name}:${p.direction}`).join(','), 'IN:input,OUT:output', 'ports restored');
  assertEqual((back.getComponent(r1.id)?.params as { r: number }).r, 1000, 'parameters restored');
});

test('a project round-trips: chips, sheet, fingerprints and parametric generators', () => {
  const { project: original } = testProject('io-project');
  buildReferenceChips(original);
  const b = new CircuitBuilder(original.lib, 'sheet', original.chips);
  const inst = original.instantiate(b, 'register_n', { bits: 4 }, [0, 0]);
  b.port('CLK', 'input', 'clk', 1);
  b.at(inst, 'CLK', 'clk');
  original.sheet = b.finish({ erc: false });

  const text = saveProjectText(original);
  const { project: reloaded, errors, warnings } = loadProjectText(text);
  assertEqual(errors, 0, 'no errors');
  assertEqual(warnings, 0, 'no warnings');
  assertEqual(
    reloaded.chips.all().map((c) => c.def.id).sort().join(','),
    original.chips.all().map((c) => c.def.id).sort().join(','),
    'the same chips come back',
  );
  assertEqual(reloaded.sheet?.fingerprint(), original.sheet.fingerprint(), 'the working sheet is identical');

  // Parametric chips keep their generator: the 16-word ROM interface is available
  // again even though the default (saved) build has three address pins.
  const rom = reloaded.chips.must('rom_n');
  assert(!!rom.def.generator, 'the ROM generator is re-attached');
  assertEqual(rom.def.ports.filter((p) => p.name.startsWith('A')).length, 3, 'saved default interface');
  assertEqual(rom.implementationPins({ words: 16, width: 8 }).filter((p) => p.name.startsWith('A')).length, 4, 'generator works after load');
});

test('the reloaded reference CPU still executes its program', () => {
  const { project: original } = testProject('io-cpu');
  buildReferenceChips(original);
  const { project: reloaded, errors } = loadProjectText(saveProjectText(original));
  assertEqual(errors, 0, 'clean load');
  const h = chipHarness(reloaded, 'cpu8');
  h.set('clk', 0);
  h.set('run', 0);
  h.set('rst', 1);
  h.settle();
  h.pulse();
  h.set('rst', 0);
  h.set('run', 1);
  h.settle();
  for (let i = 0; i < 20 && h.get('halt') !== 1; i++) h.pulse();
  assertEqual(h.get('halt'), 1, 'HALT reached after the reload');
  assertEqual(h.getBus('a', 8), 14, 'accumulator after the reload');
  assertEqual(h.getBus('pc', 4), 7, 'PC after the reload');
});

test('a damaged file is reported precisely, never silently repaired', () => {
  const { b, lib, chips } = builder('damaged');
  const r1 = b.add('resistor', { r: 100 }, [0, 0]);
  const r2 = b.add('resistor', { r: 200 }, [80, 0]);
  b.at(r1, '1', 'a').at(r2, '1', 'a');
  const doc = circuitToDocument(b.finish({ erc: false }));
  assertEqual(doc.nets.length, 1, 'the fixture has exactly one net');

  // 1. Not JSON at all.
  const notJson = loadProjectText('{ this is not json');
  assert(notJson.diagnostics.some((d) => d.code === 'CF6001'), 'CF6001 for invalid JSON');

  // 2. A component type this build does not provide.
  const unknown = JSON.parse(JSON.stringify(doc)) as typeof doc;
  unknown.components[0].spec = 'flux_capacitor';
  const loadedUnknown = circuitFromDocument(unknown, lib, chips);
  assertEqual(loadedUnknown.circuit.componentCount(), 1, 'the unknown component is not invented');
  assert(loadedUnknown.diagnostics.some((d) => d.code === 'CF6002'), 'CF6002 names the missing type');

  // 3. A parameter out of range.
  const outOfRange = JSON.parse(JSON.stringify(doc)) as typeof doc;
  outOfRange.components[0].params = { r: -5 };
  const loadedBad = circuitFromDocument(outOfRange, lib, chips);
  const badParam = loadedBad.diagnostics.find((d) => d.code === 'CF6003');
  assert(!!badParam, 'CF6003 for an out-of-range parameter');
  assertEqual(badParam!.severity, Severity.Error, 'an invalid parameter is an error, not a warning');

  // 4. A tampered net list: the circuit loads, but the fingerprint mismatch is
  //    reported rather than hidden.
  const tampered = JSON.parse(JSON.stringify(doc)) as typeof doc;
  tampered.nets[0].connections = [];
  const loadedTampered = circuitFromDocument(tampered, lib, chips);
  assertEqual(loadedTampered.circuit.netCount(), 1, 'the net still exists');
  const mismatch = loadedTampered.diagnostics.find((d) => d.code === 'CF6004');
  assert(!!mismatch, 'CF6004 when the file does not rebuild the circuit it claims');

  // 5. A net that refers to a component that is not in the file.
  const dangling = JSON.parse(JSON.stringify(doc)) as typeof doc;
  dangling.nets[0].connections.push([999, '1']);
  const loadedDangling = circuitFromDocument(dangling, lib, chips);
  assert(loadedDangling.diagnostics.some((d) => d.code === 'CF6003'), 'CF6003 for a connection to a missing component');
});

test('chips are loaded in dependency order and cycles are diagnosed', () => {
  const { project } = testProject('cycles');
  buildReferenceChips(project);
  const doc = JSON.parse(saveProjectText(project)) as ProjectDocument;
  // Reverse the chip order: the loader must still resolve dependencies.
  doc.chips.reverse();
  const { project: reloaded, errors } = loadProjectText(JSON.stringify(doc));
  assertEqual(errors, 0, 'order in the file does not matter');
  assert(!!reloaded.chips.get('cpu8'), 'the CPU chip loaded');

  // A chip that depends on itself must be refused with a diagnostic, not a hang.
  const cyclic = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
  const chip = cyclic.chips.find((c) => c.id === 'not1');
  assert(!!chip, 'not1 is in the reference library');
  chip!.dependencies = ['not1'];
  const result = loadProjectText(JSON.stringify(cyclic));
  assert(result.diagnostics.some((d) => d.code === 'CF6007'), `CF6007 for the cycle, got ${result.diagnostics.map((d) => d.code).join(', ') || 'nothing'}`);
});

test('the reference library validates clean (no ERC errors or warnings)', () => {
  const { project } = testProject('validate');
  buildReferenceChips(project);
  const diags = project.validate();
  const errors = diags.filter((d) => d.severity === Severity.Error);
  const warnings = diags.filter((d) => d.severity === Severity.Warning);
  assertEqual(errors.length, 0, `ERC errors in the reference library: ${errors.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  assertEqual(warnings.length, 0, `ERC warnings in the reference library: ${warnings.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  // The digital-only ground note is expected and must stay informational.
  assert(diags.some((d) => d.code === 'CF3001' && d.severity === Severity.Info), 'digital circuits report the missing ground as info');
});

test('chip documents record their dependencies and the generator identity', () => {
  const { project } = testProject('chip-doc');
  buildReferenceChips(project);
  const cpu = chipToDocument(project.chips.must('cpu8'));
  assert(cpu.dependencies.includes('counter_n'), 'the CPU depends on the counter chip');
  assert(cpu.dependencies.includes('alu_n'), 'the CPU depends on the ALU chip');
  assertEqual(cpu.generatorId, 'cpu8', 'a parametric chip records its generator id');
  assert(cpu.uses.includes('logic_low'), 'component types are recorded');
  const rom = chipToDocument(project.chips.must('rom_n'));
  assertEqual(rom.generatorId, 'rom_n', 'the ROM generator is recorded');
  assert(rom.dependencies.length === 0, 'the ROM uses no other chip');
});
