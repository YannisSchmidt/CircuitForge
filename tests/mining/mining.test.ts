/**
 * Repeated-subcircuit mining: cone growth, the canonical form that decides when two
 * cones are the same shape, the measurement that decides what one computes, and the
 * replacement that turns the repetitions into chip instances.
 *
 * The headline claim this suite protects is the one the design document makes: a sheet
 * that repeats a full adder built from gates reports one pattern of that many
 * occurrences, identifies it as the `full_adder` chip *by measured behaviour* rather
 * than by a name, and replacing every occurrence shrinks the sheet without changing
 * what any output computes. Two things are deliberately asserted as well, because they
 * are the ones an implementation is tempted to get quietly wrong: occurrences that live
 * inside a chip expansion are reported but not replaceable from this sheet, and a near
 * match is never substituted.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import type { Library } from '../../src/engine/core/library.js';
import type { Circuit } from '../../src/engine/core/circuit.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { flatten } from '../../src/engine/sim/netlist.js';
import { buildLogicGraph, LogicVectorSim } from '../../src/engine/analysis/logic.js';
import { mineSubcircuits, replacePatternWithChip, miningToText, markSubBlocks, adjacency, refineColours } from '../../src/engine/mining/index.js';
import type { PatternOccurrence, SubcircuitPattern } from '../../src/engine/mining/index.js';

const project = buildReferenceProject('mining tests');
const lib: Library = project.lib;
const chips = project.chips;

/**
 * A flat sheet holding `n` full adders, each built from the gates a textbook shows:
 * two XORs for the sum, two ANDs and an OR for the carry. Every adder is wired to its
 * own ports, so every element of every adder sits on this sheet at depth 1 — the case
 * in which replacement is allowed.
 */
function flatAdders(n: number, name = `flat_${n}`, style?: string): Circuit {
  const b = new CircuitBuilder(lib, name);
  const params = (inputs: number): Record<string, number | string> => (style ? { inputs, style } : { inputs });
  for (let i = 0; i < n; i++) {
    for (const net of ['a', 'b', 'ci']) b.port(`${net}${i}`.toUpperCase(), 'input', `${net}${i}`, 1);
    const x1 = b.add('xor_gate', params(2), [i * 220, 0]);
    const x2 = b.add('xor_gate', params(2), [i * 220 + 60, 0]);
    const a1 = b.add('and_gate', params(2), [i * 220, 60]);
    const a2 = b.add('and_gate', params(2), [i * 220 + 60, 60]);
    const or = b.add('or_gate', params(2), [i * 220 + 120, 60]);
    b.at(x1, 'IN1', `a${i}`, 1);
    b.at(x1, 'IN2', `b${i}`, 1);
    b.at(x1, 'OUT', `x1_${i}`, 1);
    b.at(x2, 'IN1', `x1_${i}`, 1);
    b.at(x2, 'IN2', `ci${i}`, 1);
    b.at(x2, 'OUT', `s${i}`, 1);
    b.at(a1, 'IN1', `a${i}`, 1);
    b.at(a1, 'IN2', `b${i}`, 1);
    b.at(a1, 'OUT', `p${i}`, 1);
    b.at(a2, 'IN1', `x1_${i}`, 1);
    b.at(a2, 'IN2', `ci${i}`, 1);
    b.at(a2, 'OUT', `g${i}`, 1);
    b.at(or, 'IN1', `p${i}`, 1);
    b.at(or, 'IN2', `g${i}`, 1);
    b.at(or, 'OUT', `co${i}`, 1);
    b.port(`S${i}`, 'output', `s${i}`, 1);
    b.port(`CO${i}`, 'output', `co${i}`, 1);
  }
  return b.finish({ erc: false });
}

/** The full adder's truth table, written out by hand so the test is not circular. */
function fullAdderRows(): string[] {
  const rows: string[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k >> 0) & 1;
    const bb = (k >> 1) & 1;
    const ci = (k >> 2) & 1;
    const sum = a ^ bb ^ ci;
    const co = (a & bb) | (ci & (a ^ bb));
    rows.push(`${sum}${co}`);
  }
  return rows;
}

/** Drive every input of a flattened circuit through its combinations and read the outputs. */
function truthTable(circuit: Circuit, inputs: string[], outputs: string[], combinations: number): string[] {
  const netlist = flatten(circuit, lib, chips, { metadata: true });
  const graph = buildLogicGraph(netlist);
  const sim = new LogicVectorSim(graph, { loopIterations: 8 });
  const nameToIndex = new Map<string, number>();
  for (const index of [...graph.inputs, ...graph.outputs]) nameToIndex.set(graph.netName(index), index);
  for (const name of inputs) assert(nameToIndex.has(name), `input net "${name}" is not in the flattened graph`);
  for (const name of outputs) assert(nameToIndex.has(name), `output net "${name}" is not in the flattened graph`);
  const words = inputs.map((_, i) => {
    let word = 0;
    for (let k = 0; k < combinations; k++) if ((k >> i) & 1) word |= 1 << k;
    return word;
  });
  inputs.forEach((name, i) => sim.drive(nameToIndex.get(name) as number, words[i], 0));
  sim.settle();
  const rows: string[] = [];
  for (let k = 0; k < combinations; k++) {
    rows.push(outputs.map((name) => String(sim.sample(nameToIndex.get(name) as number, k))).join(''));
  }
  return rows;
}

/** Expand a reference chip into a circuit, failing loudly if the library lacks it. */
function chipImpl(id: string, params: Record<string, number> = {}): Circuit {
  const chip = chips.get(id);
  assert(chip !== undefined, `the reference library has no chip called "${id}"`);
  return chip.implementation(params);
}

/** The pattern whose measured behaviour equals the given chip's, if the miner found one. */
function matched(patterns: SubcircuitPattern[], chipId: string): SubcircuitPattern | undefined {
  return patterns.find((p) => p.matchedChip?.id === chipId && p.matchedChip.identical);
}

suite('mining');

test('finds the repeated full adder on a flat sheet, once, with all its occurrences', () => {
  const circuit = flatAdders(6);
  const report = mineSubcircuits(circuit, lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, `the miner did not identify the full adder; it reported: ${report.patterns.map((p) => p.description).join(', ') || 'nothing'}`);
  assertEqual(adder.count, 6, 'occurrences of the six-adder sheet');
  assertEqual(adder.size, 5, 'elements in a full adder (2 XOR, 2 AND, 1 OR)');
  assertEqual(adder.inputs, 3, 'external inputs (a, b, carry-in)');
  assertEqual(adder.outputs, 2, 'outputs (sum, carry-out)');
  assertEqual(adder.saving.replaceable, 6, 'every occurrence sits on this sheet, so every one is replaceable');
  assertEqual(report.patterns[0].id, adder.id, 'the finding that saves the most ranks first');
  // Sub-blocks of the adder may be listed too — an XOR and an AND over the same two
  // nets really are a half adder, and saying so is not wrong. What must not happen is
  // six separate reports of one repeated block.
  assert(report.patterns.length <= 3, `the six adders should collapse into a handful of patterns, got ${report.patterns.length}`);
});

test('the measured truth table is the full adder\'s, row for row', () => {
  const report = mineSubcircuits(flatAdders(3), lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, 'no full adder pattern was measured');
  const behaviour = adder.behaviour;
  assert(behaviour !== null, 'the pattern was found but not measured');
  const chipMatch = adder.matchedChip;
  assert(chipMatch !== null, 'the pattern was measured but matched no chip');
  assertEqual(behaviour.rows.join(' '), fullAdderRows().join(' '), 'measured rows');
  assertEqual(behaviour.complete, true, 'three inputs are enumerable, so the measurement must be exhaustive');
  assertEqual(chipMatch.differingRows, 0, 'differing rows against the chip');
  assertEqual(chipMatch.note, 'measured truth tables are identical over all 8 input combination(s)', 'the match note');
});

test('replacing every occurrence shrinks the sheet and changes no output', () => {
  const circuit = flatAdders(6);
  const report = mineSubcircuits(circuit, lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, 'no full adder pattern to replace');
  const before = truthTable(circuit, ['a0', 'b0', 'ci0', 'a5', 'b5', 'ci5'], ['s0', 'co0', 's5', 'co5'], 64);

  const result = replacePatternWithChip(circuit, lib, chips, adder, {});
  assertEqual(result.replaced, 6, 'occurrences replaced');
  assertEqual(result.skipped.length, 0, 'occurrences skipped');
  assertEqual(result.componentsBefore, 30, 'components before (6 adders x 5 gates)');
  assertEqual(result.componentsAfter, 6, 'components after (6 chip instances)');
  assertEqual(result.netsBefore, 48, 'nets before');
  assertEqual(result.netsAfter, 30, 'nets after');
  assertEqual(result.diagnostics.filter((d) => d.severity === 'error').length, 0, 'ERC errors after replacement');

  const after = truthTable(result.circuit, ['a0', 'b0', 'ci0', 'a5', 'b5', 'ci5'], ['s0', 'co0', 's5', 'co5'], 64);
  assertEqual(after.join(' '), before.join(' '), 'outputs of the first and last adder, over all 64 input combinations');
});

test('the spec\'s headline number: 184 repetitions are found and all 184 replaced', () => {
  const circuit = flatAdders(184);
  const report = mineSubcircuits(circuit, lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, 'the 184-adder sheet did not yield the full adder pattern');
  assertEqual(adder.count, 184, 'occurrences');
  assertEqual(adder.saving.replaceable, 184, 'replaceable occurrences');
  const result = replacePatternWithChip(circuit, lib, chips, adder, {});
  assertEqual(result.replaced, 184, 'replacements performed');
  assertEqual(result.componentsAfter, 184, 'components after (one instance per adder)');
  assertEqual(result.diagnostics.filter((d) => d.severity === 'error').length, 0, 'ERC errors after replacement');
});

test('an occurrence inside a chip expansion is reported but not replaceable from this sheet', () => {
  const ripple = chipImpl('ripple_adder', { bits: 4 });
  const report = mineSubcircuits(ripple, lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, 'the ripple adder did not yield the full adder pattern');
  assert(adder.count >= 3, `expected the inner adders to be seen, got ${adder.count}`);
  assertEqual(adder.saving.replaceable, 0, 'replaceable occurrences: they live in another sheet');
  const result = replacePatternWithChip(ripple, lib, chips, adder, {});
  assertEqual(result.replaced, 0, 'nothing may be replaced');
  assertEqual(result.skipped.length, adder.count, 'every occurrence is skipped, with a reason');
  for (const skip of result.skipped) {
    assert(/chip expansion|not on this sheet/i.test(skip.reason), `the skip reason should say where the occurrence lives, got: ${skip.reason}`);
  }
});

test('a fragment that appears once is not called a repeated subcircuit', () => {
  const report = mineSubcircuits(flatAdders(1), lib, chips, { minOccurrences: 2 });
  assertEqual(matched(report.patterns, 'full_adder') === undefined, true, 'a single adder is not a repetition');
  const twice = mineSubcircuits(flatAdders(2), lib, chips, { minOccurrences: 2 });
  assert(matched(twice.patterns, 'full_adder') !== undefined, 'two adders are a repetition');
});

test('two different fragments get two patterns, and the same fragment gets one id', () => {
  // A half adder (XOR + AND) next to full adders: the half adder must not be folded
  // into the full adder pattern, and it must be recognisable on its own.
  const b = new CircuitBuilder(lib, 'mixed');
  for (const net of ['ha', 'hb']) b.port(net.toUpperCase(), 'input', net, 1);
  const hx = b.add('xor_gate', { inputs: 2 }, [0, 0]);
  const ha = b.add('and_gate', { inputs: 2 }, [0, 60]);
  b.at(hx, 'IN1', 'ha', 1);
  b.at(hx, 'IN2', 'hb', 1);
  b.at(hx, 'OUT', 'hs', 1);
  b.at(ha, 'IN1', 'ha', 1);
  b.at(ha, 'IN2', 'hb', 1);
  b.at(ha, 'OUT', 'hc', 1);
  b.port('HS', 'output', 'hs', 1);
  b.port('HC', 'output', 'hc', 1);
  const half = b.finish({ erc: false });

  const halfReport = mineSubcircuits(half, lib, chips, { minOccurrences: 1 });
  const halfPattern = halfReport.patterns.find((p) => p.size === 2 && p.outputs === 2);
  assert(halfPattern !== undefined, 'the half adder was not reported as its own pattern');
  assertEqual(halfPattern.matchedChip?.id ?? '', 'half_adder', 'the half adder matches the half_adder chip');

  const fullReport = mineSubcircuits(flatAdders(4), lib, chips, {});
  const full = matched(fullReport.patterns, 'full_adder');
  assert(full !== undefined, 'no full adder pattern on the four-adder sheet');
  assert(full.id !== halfPattern.id, 'the half adder and the full adder must not share a canonical id');
});

test('mining the same circuit twice gives the same patterns in the same order', () => {
  const circuit = flatAdders(8);
  const a = mineSubcircuits(circuit, lib, chips, {});
  const bb = mineSubcircuits(circuit, lib, chips, {});
  assertEqual(a.patterns.map((p) => `${p.id}:${p.count}`).join(','), bb.patterns.map((p) => `${p.id}:${p.count}`).join(','), 'pattern ids and counts');
  // The report quotes how long the mining took, which is the one thing about it that
  // legitimately differs between two runs.
  const withoutTiming = (text: string): string => text.replace(/mined in [0-9.]+ ?m?s/g, 'mined in —');
  assertEqual(withoutTiming(miningToText(a)), withoutTiming(miningToText(bb)), 'the rendered report');
});

test('the declared budgets bound every pattern of a large design', () => {
  const cpu = chipImpl('cpu8');
  const report = mineSubcircuits(cpu, lib, chips, { maxPatternInputs: 5, maxPatternSize: 12 });
  assert(report.patterns.length > 0, 'a 375-element CPU should contain repeated logic');
  for (const pattern of report.patterns) {
    assert(pattern.inputs <= 5, `pattern ${pattern.id} has ${pattern.inputs} external inputs, over the declared budget of 5`);
    assert(pattern.size <= 12, `pattern ${pattern.id} has ${pattern.size} elements, over the declared budget of 12`);
    assert(pattern.count >= 2, `pattern ${pattern.id} is reported with ${pattern.count} occurrence(s)`);
  }
});

test('mining keeps the logic layer, even for gates built to be expanded', () => {
  // A gate carrying `style: cmos_static` becomes a transistor network when a netlist is
  // flattened with expansion on — and a transistor is not a logic element, so expanding
  // would delete the subject of this analysis. The miner therefore flattens with
  // expansion off and offers no option to turn it on: a sheet of transistor-level gates
  // is still mined as the logic it implements.
  const report = mineSubcircuits(flatAdders(3, 'cmos_adders', 'cmos_static'), lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, `the adder was not found among cmos_static gates; reported: ${report.patterns.map((p) => p.description).join(', ') || 'nothing'}`);
  assertEqual(adder.count, 3, 'occurrences');
  assertEqual(adder.size, 5, 'elements counted at the logic layer, not transistors');
});

test('a circuit with no logic in it reports nothing, and says why', () => {
  const b = new CircuitBuilder(lib, 'analogue');
  const v = b.add('vdc', { dc: 5 }, [0, 0]);
  b.at(v, '+', 'vin');
  b.at(v, '-', 'gnd');
  const r1 = b.add('resistor', { resistance: 1000 }, [60, 0]);
  b.at(r1, '1', 'vin');
  b.at(r1, '2', 'mid');
  const r2 = b.add('resistor', { resistance: 1000 }, [60, 60]);
  b.at(r2, '1', 'mid');
  b.at(r2, '2', 'gnd');
  b.ground();
  const report = mineSubcircuits(b.finish({ erc: false }), lib, chips, {});
  assertEqual(report.patterns.length, 0, 'a resistive divider has no repeated logic');
  assert(report.notes.some((n) => /no logic elements/i.test(n)), `the report should explain the empty result, notes were: ${report.notes.join(' | ')}`);
});

test('a near match is never substituted, and the report says how near', () => {
  // Two XORs and an AND read three inputs and compute sum plus a *wrong* carry: the
  // structure is close to a full adder but the behaviour is not, so no chip may claim it.
  // Both outputs are driven by cones over the same three nets, so the merge sees one
  // block: the sum is right and the carry is a three-input AND, which is wrong for
  // every case where exactly two of the three inputs are high.
  const b = new CircuitBuilder(lib, 'near');
  for (const net of ['na', 'nb', 'nc']) b.port(net.toUpperCase(), 'input', net, 1);
  const x1 = b.add('xor_gate', { inputs: 2 }, [0, 0]);
  const x2 = b.add('xor_gate', { inputs: 2 }, [60, 0]);
  const a1 = b.add('and_gate', { inputs: 3 }, [0, 60]);
  b.at(x1, 'IN1', 'na', 1);
  b.at(x1, 'IN2', 'nb', 1);
  b.at(x1, 'OUT', 'nx', 1);
  b.at(x2, 'IN1', 'nx', 1);
  b.at(x2, 'IN2', 'nc', 1);
  b.at(x2, 'OUT', 'ns', 1);
  b.at(a1, 'IN1', 'na', 1);
  b.at(a1, 'IN2', 'nb', 1);
  b.at(a1, 'IN3', 'nc', 1);
  b.at(a1, 'OUT', 'nc2', 1);
  b.port('NS', 'output', 'ns', 1);
  b.port('NC2', 'output', 'nc2', 1);
  const circuit = b.finish({ erc: false });

  const report = mineSubcircuits(circuit, lib, chips, { minOccurrences: 1 });
  const near = report.patterns.find((p) => p.inputs === 3 && p.outputs === 2);
  assert(near !== undefined, 'the near-adder fragment was not reported');
  const nearMatch = near.matchedChip;
  assert(nearMatch === null || !nearMatch.identical, 'a fragment that computes the wrong carry must not be called identical to the full adder');
  const nearBehaviour = near.behaviour;
  assert(nearBehaviour !== null, 'the near-adder fragment was not measured');
  assertEqual(nearBehaviour.rows.join(' ') === fullAdderRows().join(' '), false, 'its measured rows differ from the full adder\'s');
});

test('a block contained in a larger reported block is labelled, not hidden', () => {
  // A full adder is two half adders and an OR, so a sheet of full adders really does
  // contain three findings. All three are reported; what must not happen is presenting
  // them as three independent chances to de-duplicate the same gates.
  const report = mineSubcircuits(flatAdders(4), lib, chips, {});
  const adder = matched(report.patterns, 'full_adder');
  assert(adder !== undefined, 'the full adder was not found');
  assertEqual(adder.subBlockOf, undefined, 'the largest block is not a sub-block of anything reported');
  const halves = report.patterns.filter((p) => p.matchedChip?.id === 'half_adder');
  assert(halves.length >= 1, `the half adders inside it were expected too, got ${report.patterns.map((p) => p.description).join(', ')}`);
  for (const half of halves) assertEqual(half.subBlockOf, adder.id, 'each half adder names the full adder that contains it');
  const text = miningToText(report);
  assert(/sub-block of/.test(text), 'the text report says so, so a reader does not act on the smaller block first');
});

/** A pattern with just enough filled in to test containment on its own. */
function stubPattern(id: string, occurrences: number[][]): SubcircuitPattern {
  const make = (elements: number[]): PatternOccurrence => ({
    root: elements[0] ?? 0,
    elements,
    refs: [],
    paths: [],
    onSheet: true,
    externalInputs: [],
    outputs: [],
    externalInputNames: [],
    outputNames: [],
  });
  return {
    id,
    description: id,
    kinds: [],
    size: occurrences[0]?.length ?? 0,
    inputs: 0,
    outputs: 0,
    count: occurrences.length,
    occurrences: occurrences.map(make),
    behaviour: null,
    matchedChip: null,
    suggestedChip: null,
    mergedFrom: [],
    saving: { elementsPerOccurrence: 0, elementsTotal: 0, componentsPerOccurrence: 0, componentsTotal: 0, instancesAdded: occurrences.length, replaceable: occurrences.length },
  };
}

test('containment is decided occurrence by occurrence, not by shape', () => {
  const small = stubPattern('small', [[0, 1], [2, 3]]);
  const large = stubPattern('large', [[0, 1, 4], [2, 3, 5]]);
  markSubBlocks([small, large]);
  assertEqual(small.subBlockOf, 'large', 'every occurrence of the small pattern sits inside one of the large');
  assertEqual(large.subBlockOf, undefined, 'and not the other way round');

  // One occurrence outside is enough to break the claim.
  const partial = stubPattern('partial', [[0, 1], [8, 9]]);
  const other = stubPattern('other', [[0, 1, 4]]);
  markSubBlocks([partial, other]);
  assertEqual(partial.subBlockOf, undefined, 'a pattern with one occurrence outside is not a sub-block');

  // Same size is not containment, even when the elements are the same.
  const twinA = stubPattern('twin-a', [[6, 7]]);
  const twinB = stubPattern('twin-b', [[6, 7]]);
  markSubBlocks([twinA, twinB]);
  assertEqual(twinA.subBlockOf, undefined, 'two patterns of the same size label neither');
  assertEqual(twinB.subBlockOf, undefined, 'in either order');
});

test('colour refinement is what makes two cones comparable, and it is stable', () => {
  const graph = buildLogicGraph(flatten(flatAdders(2), lib, chips, { metadata: true }));
  const colours = refineColours(graph, adjacency(graph), 3);
  assertEqual(colours.length, graph.elements.length, 'one colour per element');
  // Two adders: the XOR that computes an intermediate term and the XOR that computes a
  // port-driven sum see different neighbourhoods, so they must not share a colour.
  const distinct = new Set(colours);
  assert(distinct.size >= 2, `a two-adder sheet should have elements of more than one refined colour, got ${distinct.size}`);
  assertEqual(refineColours(graph, adjacency(graph), 3).join(','), colours.join(','), 'refinement is deterministic');
});

test('a sheet with nothing repeated reports nothing', () => {
  const b = new CircuitBuilder(lib, 'lonely');
  b.port('IN', 'input', 'in', 1);
  const not1 = b.add('not_gate', {}, [0, 0]);
  b.at(not1, 'IN1', 'in', 1);
  b.at(not1, 'OUT', 'out', 1);
  b.port('OUT', 'output', 'out', 1);
  const report = mineSubcircuits(b.finish({ erc: false }), lib, chips, {});
  assertEqual(report.patterns.length, 0, 'a single inverter is not a repeated subcircuit');
  assert(report.conesExamined >= 1, 'the report still says how many cones were grown');
});

test('the text report states what was measured and what was assumed', () => {
  const report = mineSubcircuits(flatAdders(4), lib, chips, {});
  const text = miningToText(report);
  assert(/FULL_ADDER/i.test(text), 'the report names the chip it matched');
  assert(/identical/i.test(text), 'the report says the match is behavioural');
  assert(/Scope/i.test(text), 'the report has a scope section');
  assert(/not a proof of isomorphism/i.test(text), 'the report states the limit of the structural test');
  assert(/Analogue circuitry is not mined/i.test(text), 'the report states what is out of reach');
});
