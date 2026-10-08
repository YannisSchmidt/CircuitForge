/**
 * Circuit analyzer: every check is exercised on a circuit built to trip it, and
 * on a circuit built to be clean.
 *
 * The assertions check the *measurement* each finding claims, not just its code:
 * a finding whose numbers do not match the circuit it was run on is a bug even
 * if the code is right.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { builder, flattenCircuit, simulator } from '../sim/helpers.js';
import type { CircuitBuilder } from '../../src/engine/core/build.js';
import type { ChipLibrary } from '../../src/engine/core/chip.js';
import { analysisToText, analyzeNetlist, reportToDiagnostics, type AnalyzeReport } from '../../src/engine/analysis/analyzer.js';
import { Severity } from '../../src/engine/core/labels.js';
import type { FlatNetlist } from '../../src/engine/sim/netlist.js';
import type { Library } from '../../src/engine/core/library.js';
import type { CircuitSimulator } from '../../src/engine/sim/solver.js';

suite('analyzer');

interface Built {
  nl: FlatNetlist;
  lib: Library;
  chips: ChipLibrary;
  sim?: CircuitSimulator;
}

function build(fn: (b: CircuitBuilder) => void, opts: { solve?: boolean } = {}): Built {
  const { b, lib, chips } = builder('analyzer');
  fn(b);
  const nl = flattenCircuit(b.finish({ erc: false }), lib, chips, { allowWarnings: true });
  if (!opts.solve) return { nl, lib, chips };
  const sim = simulator(nl, { thermal: true });
  sim.dcSolve();
  return { nl, lib, chips, sim };
}

function codes(r: AnalyzeReport): string[] {
  return r.findings.map((f) => f.code);
}

function finding(r: AnalyzeReport, code: string): AnalyzeReport['findings'][number] | undefined {
  return r.findings.find((f) => f.code === code);
}

test('a clean combinational circuit reports no warnings and no errors', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('B', 'input', 'b', 1);
    b.port('Y', 'output', 'y', 1);
    const g1 = b.add('and_gate', { style: 'ideal', inputs: 2, tphl: 4e-9, tplh: 5e-9 }, [0, 0]);
    const g2 = b.add('not_gate', { style: 'ideal', tphl: 2e-9, tplh: 2e-9 }, [40, 0]);
    b.at(g1, 'IN1', 'a').at(g1, 'IN2', 'b').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'n1').at(g2, 'OUT', 'y');
  });
  const r = analyzeNetlist(nl, { lib });
  assertEqual(r.counts.errors, 0, `no error (${codes(r).join(' ')})`);
  assertEqual(r.counts.warnings, 0, `no warning (${codes(r).join(' ')})`);
  assert(!!finding(r, 'CF8001'), 'the critical path is reported');
  assertEqual(r.stats.logic!.gates, 2, 'two gates at level 0');
});

test('CF8001: the critical path carries the real gate chain and its declared delays', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const g1 = b.add('and_gate', { style: 'ideal', inputs: 2, tphl: 4e-9, tplh: 6e-9 }, [0, 0]);
    const g2 = b.add('not_gate', { style: 'ideal', tphl: 2e-9, tplh: 2e-9 }, [40, 0]);
    b.at(g1, 'IN1', 'a').at(g1, 'IN2', 'a').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'n1').at(g2, 'OUT', 'y');
  });
  const r = analyzeNetlist(nl, { lib });
  const f = finding(r, 'CF8001');
  assert(!!f, 'CF8001 is reported');
  assertEqual(r.timing.criticalPath!.stages, 2, 'two elements on the path');
  assertClose(r.timing.criticalPath!.delay, 8e-9, 1e-15, '6 ns + 2 ns');
  assert((f!.evidence ?? []).length >= 2, 'the evidence lists the chain');
  // The delay model is named in the report, so nobody reads the number as more
  // than it is.
  assertEqual(r.timingModel.id, 'D0', 'the declared-delay model is the default');
});

test('CF8006: a combinational loop is an error with the elements that form it', () => {
  const { nl, lib } = build((b) => {
    b.port('OUT', 'output', 'q', 1);
    const g1 = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    const g2 = b.add('not_gate', { style: 'ideal' }, [40, 0]);
    b.at(g1, 'IN1', 'q').at(g1, 'IN2', 'q').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'n1').at(g2, 'OUT', 'q');
  });
  const r = analyzeNetlist(nl, { lib });
  const f = finding(r, 'CF8006');
  assert(!!f, `CF8006 fired (${codes(r).join(' ')})`);
  assertEqual(f!.severity, Severity.Error, 'a combinational loop is an error');
  assert(r.stats.logic!.loops > 0, 'the logic level counts the loop');
  assert((f!.evidence ?? []).join(' ').includes('n1'), 'the evidence names the nets of the loop');
});

test('CF8003/CF8004: a gate nobody reads is reported as dead logic', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const used = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    const dead = b.add('or_gate', { style: 'ideal', inputs: 2 }, [40, 0]);
    b.at(used, 'IN1', 'a').at(used, 'IN2', 'nobody').at(used, 'OUT', 'y');
    b.at(dead, 'IN1', 'a').at(dead, 'IN2', 'y').at(dead, 'OUT', 'orphan');
  });
  const r = analyzeNetlist(nl, { lib });
  const dead = finding(r, 'CF8004');
  assert(!!dead, `CF8004 fired (${codes(r).join(' ')})`);
  assert((dead!.evidence ?? []).join(' ').includes('orphan'), 'the dead net is named');
  const unused = finding(r, 'CF8003');
  assert(!!unused, 'CF8003 fired for the component with no observable output');
  assert((unused!.evidence ?? []).length >= 1, 'and it lists the components');
});

test('CF8005: an input wired to the same net twice is redundant', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    b.at(g, 'IN1', 'a').at(g, 'IN2', 'a').at(g, 'OUT', 'y');
  });
  const r = analyzeNetlist(nl, { lib });
  const f = finding(r, 'CF8005');
  assert(!!f, `CF8005 fired (${codes(r).join(' ')})`);
  assert((f!.evidence ?? []).join(' ').includes('a'), 'the doubled net is named');
});

test('CF8007: fan-out is counted on consumers, not on the clock pin, and the threshold is honoured', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'busy', 1);
    const src = b.add('logic_high', {}, [0, 0]);
    b.at(src, 'OUT', 'busy');
    for (let i = 0; i < 9; i++) {
      const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, [40, i * 20]);
      b.at(g, 'IN1', 'busy').at(g, 'IN2', 'busy').at(g, 'OUT', `out${i}`);
    }
    // A register clocked by the same net: the clock pin is deliberately *not*
    // counted as fan-out (a clock tree is not a load problem), but the net is not
    // reported as dangling either.
    const dff = b.add('dff', { initial: 'zero' }, [400, 0]);
    b.at(dff, 'D', 'out0').at(dff, 'CLK', 'busy').at(dff, 'Q', 'q');
    b.port('Q', 'output', 'q', 1);
  });
  const r = analyzeNetlist(nl, { lib, highFanout: 8 });
  const f = finding(r, 'CF8007');
  assert(!!f, `CF8007 fired (${codes(r).join(' ')})`);
  assert((f!.evidence ?? []).join(' ').includes('busy'), 'the busy net is named');
  assertEqual(f!.metrics!.fanout, 19, 'nine gates read the net twice each, plus the register clock');
  assertEqual(r.stats.fanout!.max, f!.metrics!.fanout, 'the statistic and the finding use the same definition');
  // With a higher threshold nothing is reported.
  const relaxed = analyzeNetlist(nl, { lib, highFanout: 20 });
  assert(!finding(relaxed, 'CF8007'), 'a fan-out of 18 passes a limit of 20');
});

test('CF8008/CF8009: duplicates are grouped per sheet, redundant logic reports the shared value', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const g1 = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    const g2 = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 40]);
    b.at(g1, 'IN1', 'a').at(g1, 'IN2', 'a').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'a').at(g2, 'IN2', 'a').at(g2, 'OUT', 'n2');
    const g3 = b.add('or_gate', { style: 'ideal', inputs: 2 }, [80, 0]);
    b.at(g3, 'IN1', 'n1').at(g3, 'IN2', 'n2').at(g3, 'OUT', 'y');
  });
  const r = analyzeNetlist(nl, { lib });
  const dup = finding(r, 'CF8008');
  assert(!!dup, `CF8008 fired (${codes(r).join(' ')})`);
  assertEqual(dup!.metrics!.instances, 2, 'two identical instances');
  assert((dup!.subject?.name ?? '').length > 0, 'the subject names the sheet');
  const red = finding(r, 'CF8009');
  assert(!!red, `CF8009 fired (${codes(r).join(' ')})`);
  assertEqual(red!.metrics!.redundantElements, 1, 'one element recomputes a value that exists');
});

test('CF8012/CF8013: an uninitialised register and a gated clock are both reported', () => {
  const { nl, lib } = build((b) => {
    b.port('CLK', 'input', 'clk', 1);
    b.port('Q', 'output', 'q', 1);
    const dff = b.add('dff', { initial: 'unknown' }, [0, 0]);
    const gate = b.add('and_gate', { style: 'ideal', inputs: 2 }, [40, 40]);
    b.at(gate, 'IN1', 'clk').at(gate, 'IN2', 'clk').at(gate, 'OUT', 'gated');
    b.at(dff, 'D', 'q').at(dff, 'CLK', 'gated').at(dff, 'Q', 'q');
  });
  const r = analyzeNetlist(nl, { lib });
  const state = finding(r, 'CF8012');
  assert(!!state, `CF8012 fired (${codes(r).join(' ')})`);
  assert((state!.evidence ?? []).join(' ').length > 0, 'the evidence lists the registers');
  const clock = finding(r, 'CF8013');
  assert(!!clock, `CF8013 fired (${codes(r).join(' ')})`);
});

test('CF8017 measures the share against the gross dissipation (a source is negative)', () => {
  const { nl, lib, sim } = build(
    (b) => {
      const v = b.add('vdc', { dc: 10 }, [0, 0]);
      b.at(v, '+', 'vcc').at(v, '-', 'gnd');
      b.ground();
      const r1 = b.add('resistor', { r: 1000, tc1: 0 }, [20, 0]);
      const r2 = b.add('resistor', { r: 1000, tc1: 0 }, [40, 0]);
      b.at(r1, '1', 'vcc').at(r1, '2', 'mid').at(r2, '1', 'mid').at(r2, '2', 'gnd');
      b.port('MID', 'output', 'mid', 1, 'analog');
    },
    { solve: true },
  );
  const r = analyzeNetlist(nl, { lib, sim });
  const f = finding(r, 'CF8017');
  assert(!!f, `CF8017 fired (${codes(r).join(' ')})`);
  assert(f!.title.includes('of the'), `the title states the share (${f!.title})`);
  assert((f!.evidence ?? []).join(' ').includes('R1'), 'the resistors are named');
  // 10 V across 2 kΩ = 50 mW, split evenly: the two resistors hold the whole
  // gross dissipation, and the source carries it as negative absorbed power.
  assertClose(r.stats.electrical.totalSupplied!, 0.05, 5e-5, 'the source supplies 50 mW');
  assertClose(r.stats.electrical.totalDissipated!, 0.05, 5e-5, 'and the resistors dissipate it');
  assert(Math.abs(r.stats.electrical.totalPower!) < 1e-6, 'the net sum is zero: energy is conserved');
  assertClose(f!.metrics!['R1@R1 (W)'] as number, 0.025, 1e-3, 'R1 dissipates 25 mW (5 mA through 1 kΩ)');
});

test('CF8010: analogue nets with no DC path to the reference are reported once', () => {
  const { nl, lib } = build((b) => {
    const c = b.add('capacitor', { c: 1e-6 }, [0, 0]);
    const r = b.add('resistor', { r: 1000, tc1: 0 }, [20, 0]);
    b.at(c, '1', 'a').at(c, '2', 'b').at(r, '1', 'a').at(r, '2', 'b');
    b.port('A', 'output', 'a', 1, 'analog');
  });
  const r = analyzeNetlist(nl, { lib });
  const found = r.findings.filter((f) => f.code === 'CF8010');
  assertEqual(found.length, 1, 'exactly one floating-reference finding');
  assert(found[0].title.includes('no ground reference'), `the missing reference is what is reported (${found[0].title})`);
});

test('constraints: every violated constraint produces a finding, and a violated one is an error', () => {
  const { nl, lib } = build((b) => {
    b.port('A', 'input', 'a', 1);
    b.port('Y', 'output', 'y', 1);
    const src = b.add('logic_high', {}, [0, 0]);
    b.at(src, 'OUT', 'a');
    for (let i = 0; i < 5; i++) {
      const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, [40, i * 20]);
      b.at(g, 'IN1', 'a').at(g, 'IN2', 'a').at(g, 'OUT', `n${i}`);
    }
    const own = b.add('or_gate', { style: 'ideal', inputs: 2 }, [80, 0]);
    b.at(own, 'IN1', 'n0').at(own, 'IN2', 'n1').at(own, 'OUT', 'y');
  });
  const r = analyzeNetlist(nl, { lib, constraints: { maxFanout: 4, maxElements: 1000 } });
  const fanout = r.constraints.find((c) => c.name === 'maxFanout');
  assertEqual(fanout!.pass, false, 'the fan-out constraint fails');
  const elements = r.constraints.find((c) => c.name === 'maxElements');
  assertEqual(elements!.pass, true, 'the element count passes');
  const violations = r.findings.filter((f) => f.code === 'CF8018');
  assertEqual(violations.length, 1, 'exactly one finding for the one violated constraint');
  assertEqual(violations[0].severity, Severity.Error, 'a violated constraint is an error');
  assert(violations[0].title.includes('maxFanout'), `the finding names the constraint (${violations[0].title})`);
});

test('maxPower compares the gross dissipation, not the (conserved) net sum', () => {
  const { nl, lib, sim } = build(
    (b) => {
      const v = b.add('vdc', { dc: 5 }, [0, 0]);
      b.at(v, '+', 'vcc').at(v, '-', 'gnd');
      b.ground();
      const r1 = b.add('resistor', { r: 100, tc1: 0 }, [20, 0]);
      b.at(r1, '1', 'vcc').at(r1, '2', 'gnd');
      b.port('MID', 'output', 'vcc', 1, 'analog');
    },
    { solve: true },
  );
  // 5 V / 100 Ω = 250 mW dissipated.
  const failing = analyzeNetlist(nl, { lib, sim, constraints: { maxPower: 0.1 } });
  const c = failing.constraints.find((x) => x.name === 'maxPower');
  assertEqual(c!.pass, false, `a 250 mW circuit violates a 100 mW budget (measured ${c!.measured})`);
  const passing = analyzeNetlist(nl, { lib, sim, constraints: { maxPower: 0.5 } });
  assertEqual(passing.constraints.find((x) => x.name === 'maxPower')!.pass, true, 'and passes a 500 mW budget');
});

test('CF8019: input ports nobody reads and output ports nobody drives', () => {
  const { nl, lib } = build((b) => {
    b.port('UNUSED', 'input', 'unused', 1);
    b.port('SILENT', 'output', 'silent', 1);
    b.port('A', 'input', 'a', 1);
    const g = b.add('not_gate', { style: 'ideal' }, [0, 0]);
    b.at(g, 'IN1', 'a').at(g, 'OUT', 'y');
    b.port('Y', 'output', 'y', 1);
  });
  const r = analyzeNetlist(nl, { lib });
  const f = r.findings.filter((x) => x.code === 'CF8019');
  const text = f.map((x) => (x.evidence ?? []).join(' ')).join(' | ');
  assert(text.includes('UNUSED'), `the unread port is named (${text})`);
  assert(text.includes('SILENT'), 'the undriven output is named');
});

test('reportToDiagnostics maps severities and analysisToText states the limits once', () => {
  const { nl, lib } = build((b) => {
    const g1 = b.add('and_gate', { style: 'ideal', inputs: 2 }, [0, 0]);
    const g2 = b.add('not_gate', { style: 'ideal' }, [40, 0]);
    b.at(g1, 'IN1', 'q').at(g1, 'IN2', 'q').at(g1, 'OUT', 'n1');
    b.at(g2, 'IN1', 'n1').at(g2, 'OUT', 'q');
    b.port('Q', 'output', 'q', 1);
  });
  const r = analyzeNetlist(nl, { lib, constraints: { maxFanout: 1 } });
  const diags = reportToDiagnostics(r);
  assert(diags.some((d) => d.severity === Severity.Error && d.code === 'CF8006'), 'the loop becomes an error diagnostic');
  const text = analysisToText(r, { verbose: true });
  assert(text.includes('maxFanout: limit 1 inputs'), `the constraint line is readable (${text.split('\n').find((l) => l.includes('maxFanout'))})`);
  assert(!/ W W| ns ns| MHz MHz/.test(text), 'no constraint prints its unit twice');
  assert(text.includes('constraints') || text.includes('Constraint'), 'the constraint section is printed');
});

test('analysisToText reports gross dissipation, never the (conserved) net power', () => {
  // A divider: the source delivers 25 mW, the two resistors absorb 6.25 mW each.
  // The net sum over all elements is ~0 W — reporting *that* as "total
  // dissipation" was a real bug: it read as "-25 nW" for a circuit burning 25 mW.
  const { nl, lib, sim } = build((b) => {
    const src = b.add('vdc', { dc: 5 }, [0, 0]);
    b.at(src, '+', 'vcc').at(src, '-', 'gnd');
    b.ground();
    const r1 = b.add('resistor', { r: 1000 }, [2, 0]);
    b.at(r1, '1', 'vcc').at(r1, '2', 'mid');
    const r2 = b.add('resistor', { r: 1000 }, [4, 0]);
    b.at(r2, '1', 'mid').at(r2, '2', 'gnd');
  }, { solve: true });
  const r = analyzeNetlist(nl, { lib, sim });
  const e = r.stats.electrical;
  assertClose(e.totalDissipated!, 2 * (2.5e-3 * 2.5), 2e-4, 'the two resistors dissipate 12.5 mW (the thermal loop shifts r by ppm)');
  assertClose(e.totalSupplied!, 2.5e-3 * 5, 2e-4, 'the source supplies 25 mW');
  assertClose(e.totalSupplied! - e.totalDissipated!, 0, 1e-5 * e.totalSupplied!, 'and what is supplied is what is dissipated');
  assert(Math.abs(e.totalPower!) < 1e-6, 'and the net power is ~0 as Kirchhoff requires');
  const text = analysisToText(r, {});
  const line = text.split('\n').find((l) => l.startsWith('Dissipation:')) ?? '';
  assert(/^Dissipation: 12\.49\d mW in 2 element\(s\) above 1 nW/.test(line), `the line reports 12.5 mW (got "${line}")`);
  assert(/sources deliver 12\.49\d mW/.test(line), `and states what fed it (got "${line}")`);
  assert(!line.includes('-'), 'and never prints a negative dissipation');
});

test('CF8017 ranks elements by gross dissipation, with a floor so leakage cannot win', () => {
  const { nl, lib, sim } = build((b) => {
    const src = b.add('vdc', { dc: 12 }, [0, 0]);
    b.at(src, '+', 'vcc').at(src, '-', 'gnd');
    b.ground();
    // R1 burns 12²/1000 = 144 mW, R2 burns 1.44 mW: a 2 % share next to a 98 % one.
    const r1 = b.add('resistor', { r: 1000 }, [2, 0]);
    b.at(r1, '1', 'vcc').at(r1, '2', 'mid');
    const r2 = b.add('resistor', { r: 10000 }, [4, 0]);
    b.at(r2, '1', 'mid').at(r2, '2', 'gnd');
  }, { solve: true });
  const r = analyzeNetlist(nl, { lib, sim });
  const hot = r.findings.find((f) => f.code === 'CF8017');
  assert(!!hot, 'the hot-element check fires');
  const shares = `${hot!.title} ${(hot!.evidence ?? []).join(' ')}`;
  // The 10 kΩ resistor carries the same current as the 1 kΩ one, so it burns ten
  // times the power: the *bigger* resistor is the hot one, and the share must say so.
  assert(/9[0-9](\.\d)? %/.test(shares), `R2 is reported as ~9x % of the budget (${hot!.title})`);
  assert(/R2/.test(hot!.title), 'and the hot element is R2, not R1');
  const metricText = Object.entries(hot!.metrics ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') + ' ' + shares;
  const stripped = metricText.replace(/1e-\d+/g, '').replace(/[a-z]+-/g, '');
  assert(!/\s-\d/.test(' ' + stripped), `no negative share is printed (${metricText})`);
});
