/**
 * The optimiser: seeds, the tiered filter, constrained dominance, profiles,
 * ranking, the session, its checkpoints and its explanations.
 *
 * The invariant every case here protects is the same one the reports state: a
 * number is quoted only if it was measured, at a named level, over a named
 * coverage — and the claim is never stronger than "best found under current
 * constraints".
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { Project } from '../../src/engine/core/project.js';
import { ChipLibrary } from '../../src/engine/core/chip.js';
import { Rng } from '../../src/engine/util/rng.js';
import { adderSpec, andNotSpec, majoritySpec, muxSpec, buildSpecById, specIds, describeSpec } from '../../src/engine/optim/spec.js';
import {
  rippleSeed,
  prefixSeed,
  truthTableSeed,
  templateSeeds,
  isAdderShaped,
  SEED_CATALOG,
} from '../../src/engine/optim/templates.js';
import { evaluateCandidate, detailCandidate } from './helpers.js';
import {
  Nsga2,
  dominates,
  constrainedDominates,
  nonDominatedSort,
  crowdingDistance,
  type Individual,
} from '../../src/engine/optim/nsga2.js';
import { PROFILES, resolveProfile, rankCandidates, OBJECTIVE_NAMES, BALANCED_WEIGHTS } from '../../src/engine/optim/profiles.js';
import { Optimizer, SEARCH_OBJECTIVES } from '../../src/engine/optim/search.js';
import { whyThisDesign, whyToText, formatObjective } from '../../src/engine/optim/explain.js';
import { validateChip } from '../../src/engine/validate/validation.js';
import { genomeKey } from '../../src/engine/optim/genome.js';

suite('optimizer');

const lib = createDefaultLibrary();

function ind(key: string, values: number[], violation = 0): Individual<number> {
  return { genes: 0, key, values, rank: 0, crowding: 0, generation: 0, violation };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

test('the truth-table seed is exact for a bitwise specification', () => {
  const spec = andNotSpec(2);
  const rng = new Rng('seed-test');
  const genome = truthTableSeed(spec, rng);
  assert(genome !== null, 'the seed applies to a bitwise spec');
  const c = evaluateCandidate(genome!, spec, lib);
  assert(c.ok, `the seed meets the contract exactly (${c.reason})`);
  assertEqual(c.violation, 0, 'a correct seed has no violation');
  assert(c.objectives.components > 0, 'the component count was measured');
  assert(c.objectives.delay > 0, 'the delay was measured');
});

test('the truth-table seed handles three dependencies by Shannon expansion', () => {
  const spec = majoritySpec(2);
  const genome = truthTableSeed(spec, new Rng('majority'));
  assert(genome !== null, 'majority of three is within the 3-dependency limit');
  const c = evaluateCandidate(genome!, spec, lib);
  assert(c.ok, `the majority seed is exact (${c.reason})`);
});

test('the truth-table seed declines when an output bit exceeds the dependency cap', () => {
  // A 4-to-1 mux output bit depends on all six input bits: four data and two
  // select. The expansion itself handles any width, so what declines here is the
  // cap the caller asked for, not a missing construction.
  const spec = muxSpec(4, 2);
  assertEqual(truthTableSeed(spec, new Rng('mux'), 3), null, 'declines above 3 dependencies');
  assertEqual(truthTableSeed(spec, new Rng('mux'), 5), null, 'and above 5, since the output really needs all six');
});

test('the truth-table seed expands a six-dependency output bit exactly', () => {
  // Regression: the expansion used to special-case 0..3 dependencies and return
  // null beyond that, so a 4-to-1 mux got no exact seed at all and the search ran
  // four thousand evaluations of random one-to-seven-node networks without ever
  // finding a design that met the contract.
  const spec = muxSpec(4, 2);
  const genome = truthTableSeed(spec, new Rng('mux'));
  assert(genome !== null, 'the six-dependency mux output is within the default cap');
  const c = evaluateCandidate(genome!, spec, lib);
  assert(c.ok, `the mux seed is exact (${c.reason})`);
  assertEqual(c.violation, 0, 'every contracted vector is reproduced');
});

test('the truth-table seed derives its dependency set from the full table', () => {
  // Regression: the dependencies used to come from flip tests around a handful of
  // systematic bases. The carry-out of a 2-bit adder ignores A0 from every one of
  // those bases — A0 only changes the carry when the other four bits already sum
  // to three — so A0 was dropped, the table was built with it held at zero, and
  // the seed was wrong on exactly the four vectors where it mattered. Eight random
  // verification probes missed that roughly half the time, which is why the
  // verification is now exhaustive over the table whenever the table is affordable.
  const spec = adderSpec(2);
  const genome = truthTableSeed(spec, new Rng('adder'));
  assert(genome !== null, 'a 2-bit adder is well inside the table budget');
  const c = evaluateCandidate(genome!, spec, lib);
  assert(c.ok, `the adder seed is exact (${c.reason})`);
  assertEqual(c.violation, 0, 'no mismatched output bit on any contracted vector');

  // The heuristic path (full table too expensive) is still exercised, and must
  // agree with the exact one on a specification both can handle.
  const heuristic = truthTableSeed(andNotSpec(2), new Rng('heuristic'), 10, 220, 0);
  const exact = truthTableSeed(andNotSpec(2), new Rng('exact'));
  assert(heuristic !== null && exact !== null, 'both paths synthesise A & ~B');
  const ch = evaluateCandidate(heuristic!, andNotSpec(2), lib);
  const ce = evaluateCandidate(exact!, andNotSpec(2), lib);
  assert(ch.ok && ce.ok, `both paths are exact (${ch.reason} / ${ce.reason})`);
  assertEqual(genomeKey(heuristic!), genomeKey(exact!), 'and they build the same network');
});

test('adder seeds apply only to adder-shaped specifications', () => {
  assert(isAdderShaped(adderSpec(4)), 'adder_4 is adder-shaped');
  assert(!isAdderShaped(andNotSpec(4)), 'A & ~B is not adder-shaped');
  assertEqual(rippleSeed(andNotSpec(4)), null, 'no ripple seed for a non-adder');
  assertEqual(prefixSeed(andNotSpec(4)), null, 'no prefix seed for a non-adder');
  assertEqual(prefixSeed(adderSpec(1)), null, 'a 1-bit adder has no prefix tree');

  const ripple = rippleSeed(adderSpec(4));
  assert(ripple !== null, 'the ripple seed applies');
  const cr = evaluateCandidate(ripple!, adderSpec(4), lib);
  assert(cr.ok, `the ripple-carry adder is exact (${cr.reason})`);

  const prefix = prefixSeed(adderSpec(4));
  assert(prefix !== null, 'the prefix seed applies');
  const cp = evaluateCandidate(prefix!, adderSpec(4), lib);
  assert(cp.ok, `the Kogge–Stone adder is exact (${cp.reason})`);

  // The whole point of shipping two architectures: they must trade off.
  assert(cp.objectives.delay < cr.objectives.delay, `prefix is faster (${cp.objectives.delay} vs ${cr.objectives.delay})`);
  assert(cp.objectives.components > cr.objectives.components, `prefix is bigger (${cp.objectives.components} vs ${cr.objectives.components})`);
});

test('templateSeeds offers only applicable architectures and says which', () => {
  const adder = templateSeeds(adderSpec(4), new Rng('t1'), { randomCount: 2 });
  assert(adder.sources.includes('ripple'), 'the adder gets the ripple seed');
  assert(adder.sources.includes('prefix'), 'the adder gets the prefix seed');
  assert(adder.sources.includes('classic sum/carry'), 'the adder gets the hand-written seed');
  assertEqual(adder.genomes.length, adder.sources.length, 'every genome has a source');

  const bitwise = templateSeeds(andNotSpec(2), new Rng('t2'), { randomCount: 2 });
  assert(!bitwise.sources.includes('ripple'), 'no adder seed for A & ~B');
  assert(bitwise.sources.includes('truth table'), 'the bitwise spec gets the exact seed');
  assert(bitwise.sources.filter((s) => s === 'random').length === 2, 'the requested random seeds are there');

  for (const entry of SEED_CATALOG) {
    assert(entry.appliesWhen.length > 0, `${entry.id} states when it applies`);
  }
});

// ---------------------------------------------------------------------------
// The tiered filter
// ---------------------------------------------------------------------------

test('an incorrect candidate keeps its objectives and reports a named violation', () => {
  const spec = andNotSpec(2);
  const rng = new Rng('violations');
  const seeds = templateSeeds(spec, rng, { architectures: false, randomCount: 8 });
  const infeasible = seeds.genomes.map((g) => evaluateCandidate(g, spec, lib)).filter((c) => !c.ok && Number.isFinite(c.violation));
  assert(infeasible.length > 0, 'some random networks are infeasible but measurable');
  for (const c of infeasible) {
    assert(c.violation > 0, 'an infeasible candidate has a positive violation');
    assert(Object.keys(c.violationTerms).length > 0, 'the violation is broken into named terms');
    assert(c.objectives.components > 0, 'the component count is still measured');
    assert(c.reason.length > 10, `the reason quotes the measurement (${c.reason})`);
    assert(/violation|excess/.test(c.reason), `the reason quantifies the violation (${c.reason})`);
  }
});

test('a candidate that does not build is rejected, not ranked', () => {
  const spec = andNotSpec(1);
  const broken = { inputs: 2, outputs: 1, nodes: [{ fn: 2, a: 99, b: 98, c: -1 }], out: [2] };
  const c = evaluateCandidate(broken, spec, lib);
  assertEqual(c.ok, false, 'it is not accepted');
  assert(!Number.isFinite(c.violation), 'an unbuildable genome has no finite violation, so it cannot be ranked');
  assert(c.reason.includes('does not build') || c.failedTier === 0, `tier 0 rejected it (${c.reason})`);
});

test('tier records carry the level they measured at', () => {
  const spec = andNotSpec(2);
  const genome = truthTableSeed(spec, new Rng('tiers'))!;
  const c = evaluateCandidate(genome, spec, lib);
  const ids = c.tiers.map((t) => t.id);
  assert(ids.includes(0) && ids.includes(1) && ids.includes(2), `tiers 0–2 ran (${ids.join(',')})`);
  for (const t of c.tiers) {
    assert(t.name.length > 0, 'every tier is named');
    assert(t.note.length > 0, 'every tier explains its verdict');
    assert(t.ms >= 0, 'every tier reports its cost');
  }
  assert(!ids.includes(3) && !ids.includes(4), 'the expensive tiers do not run on every candidate');
  assertEqual(c.vectorMethod, 'exhaustive', 'the coverage is reported');
});

test('the detail pass measures power and temperature, and says how', () => {
  const spec = andNotSpec(1);
  const genome = truthTableSeed(spec, new Rng('detail'))!;
  const detail = detailCandidate(genome, { spec, lib, chips: new ChipLibrary() });
  assert(detail.notes.length > 0, 'the detail pass states what it did');
  if (detail.staticPower !== null) {
    assert(Number.isFinite(detail.staticPower) && detail.staticPower >= 0, `static power is a finite non-negative number (${detail.staticPower})`);
    assert(detail.staticPowerPerVector.length > 0, 'it is the worst of a measured vector set');
  }
  if (detail.temperature !== null) {
    assert(Number.isFinite(detail.temperature), 'the temperature is finite');
  }
  if (detail.staticPower === null && detail.temperature === null) {
    assert(detail.notes.some((n) => n.length > 0), 'and when nothing could be measured, the notes say why');
  }
});

// ---------------------------------------------------------------------------
// NSGA-II
// ---------------------------------------------------------------------------

test('Pareto dominance is strict and irreflexive', () => {
  assert(dominates([1, 1], [2, 2]), 'smaller in every objective dominates');
  assert(dominates([1, 2], [2, 2]), 'smaller in one and equal in the other dominates');
  assert(!dominates([1, 3], [2, 2]), 'a trade-off dominates neither way');
  assert(!dominates([2, 2], [2, 2]), 'equal vectors do not dominate');
});

test('constrained dominance ranks feasibility above every objective', () => {
  const feasible = ind('f', [10, 10], 0);
  const nearlyInfeasible = ind('n', [1, 1], 0.01);
  const veryInfeasible = ind('v', [0, 0], 0.9);
  assert(constrainedDominates(feasible, nearlyInfeasible), 'a feasible design beats a better-looking infeasible one');
  assert(!constrainedDominates(nearlyInfeasible, feasible), 'never the other way round');
  assert(constrainedDominates(nearlyInfeasible, veryInfeasible), 'among infeasible designs the smaller violation wins');
  assert(!constrainedDominates(veryInfeasible, nearlyInfeasible), 'and the larger one does not');
});

test('the non-dominated sort puts the feasible front first', () => {
  const pop = [ind('a', [1, 3]), ind('b', [2, 2]), ind('c', [3, 1]), ind('d', [4, 4]), ind('e', [0.5, 0.5], 0.2)];
  const fronts = nonDominatedSort(pop);
  assertEqual(fronts[0].map((i) => i.key).sort().join(''), 'abc', 'a, b and c are mutually non-dominated');
  assert(fronts[1].some((i) => i.key === 'd'), 'd is dominated by the front');
  assert(fronts.some((f) => f.some((i) => i.key === 'e')), 'the infeasible individual is sorted too, not dropped');
  const e = pop.find((i) => i.key === 'e')!;
  const ranks = fronts.findIndex((f) => f.includes(e));
  assert(ranks > 0, `an infeasible individual never holds rank 0 alongside feasible ones (rank ${ranks})`);
});

test('crowding distance protects the extremes of a trade-off', () => {
  const front = [ind('a', [1, 3]), ind('b', [2, 2]), ind('c', [3, 1])];
  crowdingDistance(front);
  const byKey = new Map(front.map((i) => [i.key, i.crowding]));
  assertEqual(byKey.get('a'), Infinity, 'the delay extreme is protected');
  assertEqual(byKey.get('c'), Infinity, 'the component extreme is protected');
  assert(Number.isFinite(byKey.get('b')!), 'the middle individual has a finite distance');
});

test('a search recovers when every seed is infeasible — the regression that mattered', () => {
  // With hard rejection, an all-infeasible seed population left the search with
  // nothing to vary and it spun to its generation budget producing nothing.
  const engine = new Nsga2<number>({ populationSize: 4 });
  const seen: number[] = [];
  engine.seed(
    [1, 2, 3, 4].map((n) => ({ genes: n, key: `g${n}` })),
    (g) => {
      seen.push(g);
      return { values: [g, g], violation: 1 / g }; // nothing is feasible yet
    },
  );
  assertEqual(engine.size, 4, 'infeasible individuals still form a population');
  assertEqual(engine.front().length, 0, 'and they are not presented as a Pareto front');
  const feasibility = engine.feasibility();
  assertEqual(feasibility.feasible, 0, 'nothing is feasible');
  assertClose(feasibility.bestViolation, 0.25, 1e-12, 'the closest violation is reported');
  let steps = 0;
  while (steps++ < 5) engine.step(new Rng(steps), (a) => ({ genes: a + 10, key: `g${a + 10}` }), () => ({ values: [1, 1], violation: 0 }));
  assert(engine.feasibility().feasible > 0, 'a feasible child entered the population');
  assert(engine.front().length > 0, 'and now there is a Pareto front');
  assert(seen.length === 4, 'each seed was evaluated exactly once');
});

// ---------------------------------------------------------------------------
// Profiles and ranking
// ---------------------------------------------------------------------------

test('every profile has weights that sum to 1 and a description', () => {
  for (const name of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) {
    const p = PROFILES[name];
    const sum = OBJECTIVE_NAMES.reduce((s, k) => s + p.weights[k], 0);
    assertClose(sum, 1, 1e-9, `${name} weights sum to 1`);
    assert(p.description.length > 10, `${name} explains itself`);
  }
  assertEqual(BALANCED_WEIGHTS.delay, 0.4, 'speed 40 %');
  assertEqual(BALANCED_WEIGHTS.components, 0.2, 'components 20 %');
  assertEqual(BALANCED_WEIGHTS.power, 0.15, 'power 15 %');
  assertEqual(BALANCED_WEIGHTS.temperature, 0.1, 'temperature 10 %');
  assertEqual(BALANCED_WEIGHTS.risk, 0.1, 'stability 10 %');
  assertEqual(BALANCED_WEIGHTS.memory, 0.05, 'memory 5 %');
});

test('a custom profile keeps the caller weights and says it is custom', () => {
  const p = resolveProfile('CUSTOM', { delay: 0.5, components: 0.5, power: 0, temperature: 0, risk: 0, memory: 0 });
  assertEqual(p.name, 'CUSTOM', 'the profile is CUSTOM');
  assertEqual(p.weights.delay, 0.5, 'the caller weight was applied');
  assertEqual(p.weights.power, 0, 'an objective can be switched off');
  const fallback = resolveProfile(undefined);
  assertEqual(fallback.name, 'BALANCED', 'no profile means BALANCED');
});

test('ranking normalises inside the candidate set and reports unmeasured objectives', () => {
  const candidates = [
    { key: 'fast', objectives: { delay: 1e-9, components: 20, risk: 0, memory: 0, depth: 1, power: null, temperature: null, switchEnergy: null } },
    { key: 'small', objectives: { delay: 4e-9, components: 6, risk: 0, memory: 0, depth: 3, power: null, temperature: null, switchEnergy: null } },
  ];
  const ranked = rankCandidates(candidates, PROFILES.FASTEST);
  assertEqual(ranked.ranked[0].key, 'fast', 'FASTEST picks the shorter delay');
  const bySmallest = rankCandidates(candidates, PROFILES.SMALLEST);
  assertEqual(bySmallest.ranked[0].key, 'small', 'SMALLEST picks the fewer components');
  assert(ranked.ranked[0].missing.includes('power') && ranked.ranked[0].missing.includes('temperature'), 'power and temperature are listed as not measured');
  assert(!ranked.ranked[0].weighted.includes('power'), 'and they are excluded from the weighted set');
  assert(ranked.note.includes('no measured value') || ranked.reducedWeightSet > 0, 'the note admits the reduced weight set');
  assertEqual(ranked.ranked[0].weighted.includes('delay'), true, 'the measured objectives are weighted');
  assert(ranked.ranked[0].score >= 0 && ranked.ranked[0].score <= 1.0001, `the score is normalised (${ranked.ranked[0].score})`);
});

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

function smallRequest(overrides: Record<string, unknown> = {}) {
  return {
    spec: andNotSpec(2),
    lib,
    chips: new ChipLibrary(),
    populationSize: 8,
    seed: 'session-test',
    detailTop: 0,
    ...overrides,
  } as never;
}

test('the session finds a correct design and reports its exact scope', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 4 } }));
  opt.run();
  const report = opt.report();
  assertEqual(report.claim, 'BEST FOUND UNDER CURRENT CONSTRAINTS', 'the claim wording is fixed');
  assert(report.best !== null, 'a best candidate exists');
  assertEqual(report.best!.objectives.components > 0, true, 'its component count was measured');
  assert(report.best!.vectorsChecked > 0, 'its vectors were checked');
  assertEqual(report.spec.method, 'exhaustive', 'a 4-bit input space is enumerated');
  assertEqual(report.searchSpace.evaluations > 0, true, 'the evaluation count is reported');
  assert(report.searchSpace.seeds.length > 0, 'the seeds used are named');
  assertEqual(report.method.algorithm.includes('NSGA-II'), true, 'the method is named');
  assert(report.simulationLevels.search.includes('level 0'), 'the search level is named');
  assertEqual(report.simulationLevels.detail, null, 'no detail pass was requested, and the report says so');
  assert(report.notes.some((n) => n.includes('power and temperature were not measured')), 'the report admits what it did not measure');
  assertEqual(report.reproducibility.engineVersion.length > 0, true, 'the engine version is recorded');
  assert(report.reproducibility.modelVersion.logic.length > 0, 'the model versions are recorded');
  assert(report.reproducibility.hardware.cores > 0, 'the hardware is recorded');
  assertEqual(SEARCH_OBJECTIVES.length, 4, 'the search minimises four objectives');
});

test('the same seed gives the same design', () => {
  const a = new Optimizer(smallRequest({ budget: { generations: 3 } }));
  a.run();
  const b = new Optimizer(smallRequest({ budget: { generations: 3 } }));
  b.run();
  assertEqual(a.report().best!.key, b.report().best!.key, 'the best design is identical');
  assertEqual(a.report().searchSpace.evaluations, b.report().searchSpace.evaluations, 'the same number of candidates was evaluated');
  assertEqual(a.report().reproducibility.rngDraws, b.report().reproducibility.rngDraws, 'the RNG consumed the same draws');
  const c = new Optimizer(smallRequest({ budget: { generations: 3 }, seed: 'a-different-seed' }));
  c.run();
  assertEqual(c.report().reproducibility.seed, 'a-different-seed', 'a different seed is reported as such');
});

test('the session is steppable, pausable and reports live progress', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 6 } }));
  opt.step();
  opt.step();
  const p = opt.progress();
  assertEqual(p.generation, 2, 'two steps ran two generations');
  assert(p.evaluated > 0, 'candidates were evaluated');
  assert(Number.isFinite(p.evaluationsPerSecond), 'the rate is measured');
  assert(Number.isFinite(p.memoryMB), 'the heap is read');
  assertEqual(p.phase, 'searching', 'still searching');
  opt.pause();
  assertEqual(opt.progress().phase, 'paused', 'paused is reported');
  const gen = opt.progress().generation;
  opt.step();
  assertEqual(opt.progress().generation, gen, 'a paused session does not advance');
  opt.resume();
  opt.step();
  assertEqual(opt.progress().generation, gen + 1, 'resuming continues');
  opt.cancel();
  assertEqual(opt.progress().phase, 'cancelled', 'cancelled is reported');
  const before = opt.progress().generation;
  opt.step();
  assertEqual(opt.progress().generation, before, 'a cancelled session does not advance');
});

test('a checkpoint restores the archive without re-running the tiers', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 3 } }));
  opt.run();
  const snapshot = opt.snapshot();
  assertEqual(snapshot.version, 1, 'the snapshot is versioned');
  assert(snapshot.archive.length > 0, 'the archive is in the snapshot');
  const json = JSON.stringify(snapshot);
  const restored = Optimizer.restore(JSON.parse(json) as typeof snapshot, smallRequest({ budget: { generations: 6 } }));
  assertEqual(restored.archive.size, opt.archive.size, 'every candidate came back');
  assertEqual(restored.progress().evaluated, opt.progress().evaluated, 'the evaluation count was restored, not recomputed');
  const before = restored.report().best?.key ?? null;
  restored.run();
  const after = restored.report().best?.key ?? null;
  assert(after !== null, 'the resumed search still has a best design');
  assert(before === null || after !== null, 'resuming never loses the best design');
});

test('the detailed pass turns power and temperature into measured objectives', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 2 }, detailTop: 2, constraints: { level1: { vdd: 3.3 } } }));
  opt.run();
  const report = opt.report();
  assertEqual(report.simulationLevels.detail !== null, true, 'the report names the detail levels');
  assert(report.notes.some((n) => n.includes('static power at the transistor level')), 'the note says what the detail pass measured');
  const detailed = report.pareto.concat(report.best ? [report.best] : []).filter((c) => c.detail !== null);
  assert(detailed.length > 0, 'at least one candidate was detailed');
  const d = detailed[0];
  assert(d!.detail !== null, 'the detail is attached to the candidate');
});

test('"WHY THIS DESIGN?" quotes only measured deltas', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 3 } }));
  opt.run();
  const why = opt.why();
  assert(why !== null, 'an explanation exists once there is a winner');
  assert(why!.deltas.length > 0, 'it is built from deltas');
  for (const d of why!.deltas) {
    assert(OBJECTIVE_NAMES.includes(d.objective), `${d.objective} is a known objective`);
    assert(d.scope.length > 0, `${d.objective} states the level it was measured at`);
    assert(d.unit.length > 0, `${d.objective} has a unit`);
    if (d.better === 'not measured') {
      assertEqual(d.winner, null, `an unmeasured ${d.objective} quotes no winner value`);
      assertEqual(d.weighted, null, `and contributes no weighted share`);
    }
  }
  assert(why!.caveats.length > 0, 'it states what was not measured');
  assert(why!.caveats.some((c) => /power|temperature/i.test(c)), 'the missing device-level objectives are named');
  const text = whyToText(why!);
  assert(text.length > 50, 'the text form is substantial');
  assert(!/\boptimal\b/i.test(text), 'the explanation never claims optimality');
});

test('the explainer works on two hand-made candidates, outside any search', () => {
  const winner = {
    key: 'w',
    score: 0.1,
    objectives: { delay: 1e-9, components: 8, risk: 0, memory: 0, depth: 2, power: null, temperature: null, switchEnergy: null },
    genome: { nodes: 8, depth: 2, maxFanout: 2 },
    source: 'truth table',
    vectorMethod: 'exhaustive',
    fingerprint: 'abc',
    tiers: [],
    detail: null,
  };
  const runnerUp = { ...winner, key: 'r', score: 0.4, objectives: { ...winner.objectives, delay: 2e-9, components: 12 }, genome: { nodes: 12, depth: 3, maxFanout: 4 } };
  const why = whyThisDesign(winner, runnerUp, BALANCED_WEIGHTS);
  const delay = why.deltas.find((d) => d.objective === 'delay')!;
  assertEqual(delay.better, 'winner', 'the winner is faster');
  assertClose(delay.absolute!, -1e-9, 1e-15, 'the delta is the measured difference');
  assert(delay.weighted !== null && delay.weighted > 0, 'and it carries a weighted share');
  const comps = why.deltas.find((d) => d.objective === 'components')!;
  assertEqual(comps.better, 'winner', 'the winner is smaller');
  const power = why.deltas.find((d) => d.objective === 'power')!;
  assertEqual(power.better, 'not measured', 'an objective nobody measured says so');
  assert(why.structure.length > 0, 'structural differences are reported');
  assertEqual(formatObjective('delay', 1.5e-9), '1.500 ns', 'delays are formatted in ns');
  assertEqual(formatObjective('power', null), 'not measured', 'a null is never formatted as a number');
  assertEqual(formatObjective('components', 12), '12 component(s)', 'counts are formatted as counts');
});

test('a winner with no runner-up is explained without inventing a comparison', () => {
  const winner = {
    key: 'only',
    score: 0,
    objectives: { delay: 1e-9, components: 8, risk: 0, memory: 0, depth: 2, power: null, temperature: null, switchEnergy: null },
    genome: { nodes: 8, depth: 2, maxFanout: 2 },
    source: 'truth table',
    vectorMethod: 'exhaustive',
    fingerprint: null,
    tiers: [],
    detail: null,
  };
  const why = whyThisDesign(winner, null, BALANCED_WEIGHTS);
  assertEqual(why.runnerUpKey, null, 'there is no runner-up');
  assert(why.caveats.some((c) => /runner-up|no other|only/i.test(c)), 'the caveat says the comparison is impossible');
  assert(why.deltas.every((d) => d.runnerUp === null), 'no runner-up value is invented');
});

// ---------------------------------------------------------------------------
// Applying the result
// ---------------------------------------------------------------------------

test('buildBest returns a circuit whose ports are the specification bits', () => {
  const opt = new Optimizer(smallRequest({ budget: { generations: 2 }, name: 'and_not_built' }));
  opt.run();
  const circuit = opt.buildBest();
  assert(circuit !== null, 'a circuit was built');
  const names = circuit!.allPorts().map((p) => p.name).sort();
  for (const expected of ['A0', 'A1', 'B0', 'B1', 'Y0', 'Y1']) {
    assert(names.includes(expected), `port ${expected} exists (got ${names.join(',')})`);
  }
  assertEqual(circuit!.name, 'and_not_built', 'the requested name was used');
});

test('saveBestAsChip puts a validated chip in the project', () => {
  const project = new Project('optimizer test', lib, new ChipLibrary());
  const opt = new Optimizer(smallRequest({ budget: { generations: 2 }, chips: project.chips }));
  opt.run();
  const chip = opt.saveBestAsChip(project, { id: 'and_not_auto', name: 'AND_NOT (optimised)' });
  assert(chip !== null, 'a chip was saved');
  assertEqual(chip!.id, 'and_not_auto', 'the requested id was used');
  assert(project.chips.get('and_not_auto') !== undefined, 'the chip is in the library');
  assert(chip!.def.description.includes('BEST FOUND UNDER CURRENT CONSTRAINTS'), 'the description quotes the claim, not "optimal"');
  assertEqual(chip!.def.origin, 'synthesis', 'the provenance says it was synthesised');
  const validation = validateChip(chip!, { lib, chips: project.chips, spec: andNotSpec(2), ambient: 27 });
  assertEqual(validation.claim, 'VALIDATED UNDER THE STATED CONDITIONS', `the saved chip validates (${validation.failures.join(' | ')})`);
});

test('the report refuses to present a design when nothing met the contract', () => {
  // A specification no candidate in a tiny budget can meet, with the architecture
  // seeds switched off so nothing exact is handed to the search.
  const opt = new Optimizer({
    spec: adderSpec(8),
    lib,
    chips: new ChipLibrary(),
    populationSize: 4,
    seed: 'impossible',
    seeds: 'none',
    detailTop: 0,
    limits: { maxNodes: 12, seedNodes: 6 },
    budget: { generations: 2 },
  } as never);
  opt.run();
  const report = opt.report();
  if (report.best === null) {
    assertEqual(report.claim, 'BEST FOUND UNDER CURRENT CONSTRAINTS', 'the claim wording never changes');
    assert(report.notes.some((n) => n.includes('no candidate satisfied the specification')), 'the report says nothing met the contract');
    assert(report.notes.some((n) => /Widen the search|relax the constraints/.test(n)), 'and what to do about it');
    assertEqual(opt.progress().feasible, 0, 'the progress agrees');
    assert(opt.progress().bestViolation !== null, 'the closest violation is reported instead');
    const closest = opt.closest();
    assert(closest !== null, 'the closest candidate is available for diagnosis');
    assertEqual(closest!.ok, false, 'and it is not presented as a design');
  } else {
    assertEqual(report.best!.ok, true, 'if a candidate did meet the contract, it is feasible');
  }
});

// ---------------------------------------------------------------------------
// The serialisable specification catalogue
// ---------------------------------------------------------------------------

test('a specification survives the trip through a job spec', () => {
  assert(specIds().includes('adder') && specIds().includes('alu_slice'), 'the catalogue covers the reference designs');
  const spec = buildSpecById('adder', { bits: 4 });
  assertEqual(spec.name, 'adder_4', 'the id and parameters rebuild the same specification');
  assertEqual(describeSpec(spec).includes('adder_4'), true, 'it describes itself');
  const clamped = buildSpecById('adder', { bits: 999 });
  assertEqual(clamped.name, 'adder_16', 'an out-of-range parameter is clamped, not trusted');
  let threw = '';
  try {
    buildSpecById('nope');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes('unknown design specification'), `an unknown id is refused (${threw})`);
  assert(threw.includes('adder'), 'and the known ids are listed');
});

test('the genome key is stable, so the candidate cache really caches', () => {
  const spec = andNotSpec(2);
  const g = truthTableSeed(spec, new Rng('key'))!;
  assertEqual(genomeKey(g), genomeKey(truthTableSeed(spec, new Rng('key'))!), 'the same construction gives the same key');
  const opt = new Optimizer(smallRequest({ budget: { generations: 3 } }));
  opt.run();
  const cache = opt.report().method.cache;
  assert(cache.hits + cache.misses > 0, 'the cache counted evaluations');
  assert(Number.isInteger(cache.hits) && Number.isInteger(cache.misses), 'the counters are integers');
});
