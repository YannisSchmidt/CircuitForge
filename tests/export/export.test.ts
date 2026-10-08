/**
 * Export layer: the three schematic levels, the BOM, the netlist and the data
 * writers.
 *
 * The tests check the contract of each level, not its formatting: level 1 keeps
 * chip instances as blocks, level 2 expands them, level 3 exports exactly the
 * elements that were simulated. Quantities and connections are checked against
 * the source, because an export that quietly loses a component is worse than no
 * export at all.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit, testProject } from '../sim/helpers.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { buildReferenceChips } from '../../src/engine/synthesis/reference.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import {
  exportSchematicElectrical,
  exportSchematicFlattened,
  exportSchematicHierarchical,
  schematicComponentsToCsv,
  schematicNetsToCsv,
  schematicToJson,
} from '../../src/engine/export/schematic.js';
import { bomToCsv, bomToText, buildBomFromCircuit, buildBomFromNetlist } from '../../src/engine/export/bom.js';
import { exportSpiceNetlist } from '../../src/engine/export/spice.js';
import { reportToText, waveformToCsv } from '../../src/engine/export/data.js';

suite('export/schematic');

test('the hierarchical level keeps chip instances as blocks, with parameters', () => {
  const { project } = testProject('export-hier');
  buildReferenceChips(project);
  const b = new CircuitBuilder(project.lib, 'board', project.chips);
  const alu = project.instantiate(b, 'alu_n', { bits: 4 }, [0, 0]);
  const r = b.add('resistor', { r: 4700 }, [200, 0]);
  b.port('R', 'input', 'r_in', 1, 'analog');
  b.at(r, '1', 'r_in');
  b.at(r, '2', 'r_out');
  b.at(alu, 'A0', 'r_out');
  const circuit = b.finish({ erc: false });

  const sheet = exportSchematicHierarchical(circuit, project.lib);
  assertEqual(sheet.level, 'hierarchical', 'level tag');
  assertEqual(sheet.counts.components, 2, 'two components as drawn');
  const chipBlock = sheet.components.find((c) => c.chip === 'alu_n');
  assert(!!chipBlock, 'the ALU is exported as a chip block');
  assertEqual(chipBlock!.bits, 1, 'one physical block (the width is a chip parameter, not a vector instance)');
  assertEqual(chipBlock!.params.bits, 4, 'the chip parameter is exported');
  assertEqual(chipBlock!.value, '4', 'the value column shows the defining parameter');
  assertEqual(sheet.components.find((c) => c.ref === r.ref)!.value, '4700', 'resistor value');
  assertEqual(sheet.fingerprint, circuit.fingerprint(), 'the fingerprint is the circuit fingerprint');
  assert(sheet.nets.some((n) => n.connections.some((c) => c.startsWith(`${r.ref}.`))), 'a net lists its connections by ref.pin');
  assert(sheet.notes.length > 0, 'the export documents what it does not expand');
});

test('the flattened level expands chips and keeps hierarchical paths', () => {
  const { project, lib, chips } = testProject('export-flat');
  buildReferenceChips(project);
  const b = new CircuitBuilder(lib, 'board', chips);
  const alu = project.instantiate(b, 'alu_n', { bits: 2 }, [0, 0]);
  for (let i = 0; i < 2; i++) b.at(alu, `A${i}`, `a${i}`);
  b.port('A0', 'input', 'a0', 1);
  b.port('A1', 'input', 'a1', 1);
  const circuit = b.finish({ erc: false });
  const nl = flatten(circuit, lib, chips, { ambient: 27 });
  const sheet = exportSchematicFlattened(nl);
  assertEqual(sheet.level, 'flattened', 'level tag');
  assert(sheet.counts.components! > 2, 'the ALU expanded into many components');
  assertEqual(sheet.counts.elements, nl.elementCount, 'element count matches the netlist');
  assert(sheet.counts.maxDepth! >= 2, 'hierarchy depth is reported');
  assert(sheet.components.every((c) => c.path.length > 0), 'every component has a path');
  assert(sheet.components.some((c) => c.path.includes('.')), 'paths are hierarchical');
  // Gate families collapse into element kinds: LOGIC_GATE, LOGIC_BUFFER and
  // MULTIPLEXER are what the ALU's gates, buffers and mux trees lower to.
  assert(sheet.counts.byKind && Object.keys(sheet.counts.byKind).length >= 3, `kinds are counted (${JSON.stringify(sheet.counts.byKind)})`);
});

test('the electrical level exports the elements that were simulated', () => {
  const { b, lib, chips } = builder('export-elec');
  const v1 = b.add('vdc', { dc: 5 }, [0, 0]);
  const r1 = b.add('resistor', { r: 1000 }, [60, 0]);
  const r2 = b.add('resistor', { r: 1000 }, [120, 0]);
  b.ground();
  b.at(v1, '+', 'vcc').at(r1, '1', 'vcc');
  b.at(r1, '2', 'mid').at(r2, '1', 'mid');
  b.at(r2, '2', 'gnd').at(v1, '-', 'gnd');
  const circuit = b.finish({ erc: false });
  const nl = flattenCircuit(circuit, lib, chips, { allowWarnings: true });
  const sheet = exportSchematicElectrical(nl);
  assertEqual(sheet.level, 'electrical', 'level tag');
  assertEqual(sheet.elements.length, nl.elementCount, 'one exported element per simulated element');
  assertEqual(sheet.elements.length, 3, 'two resistors and one source');
  const resistor = sheet.elements.find((e) => e.kind === 'RESISTOR')!;
  assert(!!resistor, 'the resistor is exported');
  assertEqual(resistor.params.r, 1000, 'the resistor value is the physical parameter');
  assertEqual(resistor.nodes.length, 2, 'a resistor has two nodes');
  assert(resistor.nodes.includes('mid'), 'node names are the schematic net names');
  const source = sheet.elements.find((e) => e.kind === 'VOLTAGE_SOURCE' || e.kind === 'VSOURCE' || e.kind.startsWith('VOLTAGE'))!;
  assert(!!source, `the source is exported (kinds: ${sheet.elements.map((e) => e.kind).join(', ')})`);
  assertEqual(source.params.dc, 5, 'the source value is exported');
  assertEqual(source.branches, 1, 'a voltage source adds a branch unknown');
});

test('exports are JSON and CSV serializable, and the CSV has one row per component', () => {
  const { b, lib, chips } = builder('export-text');
  const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
  b.port('A', 'input', 'a', 1);
  b.port('B', 'input', 'b', 1);
  b.port('Y', 'output', 'y', 1);
  b.at(g, 'IN1', 'a').at(g, 'IN2', 'b').at(g, 'OUT', 'y');
  const circuit = b.finish({ erc: false });
  const nl = flattenCircuit(circuit, lib, chips, { allowWarnings: true });
  const sheet = exportSchematicHierarchical(circuit, lib);
  const parsed = JSON.parse(schematicToJson(sheet));
  assertEqual(parsed.format, 'circuitforge.schematic', 'the JSON carries the format tag');
  assertEqual(parsed.counts.components, 1, 'round-tripped through JSON');
  const csv = schematicComponentsToCsv(sheet).trim().split('\n');
  assertEqual(csv.length, 2, 'header + one row');
  assert(csv[0].startsWith('path,ref,type'), 'the CSV has a header');
  const netCsv = schematicNetsToCsv(exportSchematicFlattened(nl)).trim().split('\n');
  assertEqual(netCsv.length, nl.nodeCount + 1, 'one row per net, plus the header');
});

suite('export/bom');

test('the sheet BOM counts blocks, the netlist BOM counts physical parts', () => {
  const { project, lib, chips } = testProject('export-bom');
  buildReferenceChips(project);
  const b = new CircuitBuilder(lib, 'subsystem', chips);
  const reg = project.instantiate(b, 'register_n', { bits: 4 }, [0, 0]);
  b.port('CLK', 'input', 'clk', 1);
  b.at(reg, 'CLK', 'clk');
  const circuit = b.finish({ erc: false });

  const blocks = buildBomFromCircuit(circuit, lib);
  assertEqual(blocks.totals.distinctTypes, 1, 'one type as drawn');
  assertEqual(blocks.totals.physicalComponents, 1, 'one block');
  assertEqual(blocks.aggregated[0].type, 'register_n', 'the block is the register chip');

  const nl = flatten(circuit, lib, chips, { ambient: 27 });
  const parts = buildBomFromNetlist(nl);
  assert(parts.totals.elements === nl.elementCount, 'element total matches the netlist');
  assert(parts.totals.physicalComponents >= 8, 'the register expands into its parts');
  assert(parts.totals.byKind && Object.keys(parts.totals.byKind).length >= 2, `kinds are counted (${JSON.stringify(parts.totals.byKind)})`);
  // Every aggregated line's quantity equals the sum of its items.
  for (const line of parts.aggregated) assertEqual(line.quantity, line.items.length, `quantity of ${line.type}`);
  const text = bomToText(parts);
  assert(text.includes('BILL OF MATERIALS'), 'text BOM has a title');
  const csv = bomToCsv(parts).trim().split('\n');
  assertEqual(csv.length, parts.aggregated.length + 1, 'CSV rows = aggregated lines + header');
});

test('a vector instance counts as its physical copies', () => {
  const { b, lib, chips } = builder('export-vector');
  const inv = b.add('not_gate', { style: 'ideal' }, [0, 0], { bits: 4 });
  b.port('A', 'input', 'a', 4);
  b.port('Y', 'output', 'y', 4);
  b.at(inv, 'IN1', 'a').at(inv, 'OUT', 'y');
  const circuit = b.finish({ erc: false });
  const nl = flatten(circuit, lib, chips, { ambient: 27 });
  const bom = buildBomFromNetlist(nl);
  assertEqual(bom.totals.physicalComponents, 4, 'four physical inverters');
  assertEqual(bom.totals.elements, 4, 'four simulated elements');
});

suite('export/spice and data');

test('the netlist export names every element and every port', () => {
  const { b, lib, chips } = builder('export-spice');
  const v1 = b.add('vdc', { dc: 9 }, [0, 0]);
  const r1 = b.add('resistor', { r: 330 }, [60, 0]);
  const d1 = b.add('diode', { is: 1e-12, n: 1.8 }, [120, 0]);
  b.ground();
  b.at(v1, '+', 'vcc').at(r1, '1', 'vcc');
  b.at(r1, '2', 'n1').at(d1, 'A', 'n1');
  b.at(d1, 'K', 'gnd').at(v1, '-', 'gnd');
  b.port('OUT', 'output', 'n1', 1, 'analog');
  const circuit = b.finish({ erc: false });
  const nl = flattenCircuit(circuit, lib, chips, { allowWarnings: true });
  const text = exportSpiceNetlist(nl);
  const lines = text.split('\n');
  assert(lines[0].startsWith('* CircuitForge netlist'), 'header comment');
  assert(text.includes('.end'), 'the netlist is terminated');
  assert(text.includes('.port OUT n1 output'), 'ports are named');
  assert(/^R\d+ /.test(lines.find((l) => l.startsWith('R')) ?? ''), 'the resistor has a classic R line');
  assert(/^D\d+ /.test(lines.find((l) => l.startsWith('D')) ?? ''), 'the diode has a classic D line');
  assert(lines.some((l) => l.startsWith('V')), 'the source has a classic V line');
  assert(text.includes('; R1'), 'each line names the component it came from');
  assert(text.includes('330'), 'the value is exported');
});

test('waveform and report writers carry their conditions', () => {
  const csv = waveformToCsv(
    { name: 'v(out)', unit: 'V', t: [0, 1e-3, 2e-3], signals: [{ name: 'v(out)', unit: 'V', values: [0, 2.5, 5] }] },
    { circuit: 'rc', level: 1, stimulus: 'V1 step 0 → 5 V, C = 1 µF', decimalComma: false },
  );
  const lines = csv.trim().split('\n');
  assert(lines[0].startsWith('#'), 'the header is commented out');
  assert(csv.includes('# circuit: rc'), 'the circuit is named');
  assert(csv.includes('# simulation level: L1'), 'the level is named');
  assert(csv.includes('# stimulus:'), 'the stimulus is named');
  assertEqual(lines[lines.length - 1], '0.002,5', 'the last sample');

  const report = reportToText({
    title: 'critical path',
    subtitle: 'circuit rc-filter',
    sections: [{ title: 'path', rows: [['U1', '2 ns if style ideal'], ['U2', '3 ns']], notes: ['measured at 27 °C'] }],
  });
  assert(report.includes('CRITICAL PATH'), 'title is upper-cased');
  assert(report.includes('U1') && report.includes('note: measured at 27 °C'), 'rows and notes are present');
});
