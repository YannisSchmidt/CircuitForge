/**
 * "WHY THIS DESIGN?" — answered strictly from measured deltas against the
 * runner-up.
 *
 * This module is deliberately incapable of saying anything else: it only has the
 * two candidate reports in front of it, so every sentence it produces is a
 * difference between two numbers that were actually measured, on the level those
 * numbers came from. If a delta is zero, it says zero. If an objective was never
 * measured, it says so instead of guessing.
 */

import type { ObjectiveWeights } from './profiles.js';
import type { Objectives } from './cost.js';

/**
 * The part of a candidate report the explainer needs. Declared structurally so
 * that the explainer never depends on the search module (which depends on the
 * explainer's own claims), and so that it can also explain a single candidate
 * that never went through a search.
 */
export interface ExplainableCandidate {
  key: string;
  /** Final profile score inside its candidate set (lower = better). */
  score: number;
  objectives: Objectives;
  genome: { nodes: number; depth: number; maxFanout: number };
  source: string;
  vectorMethod: string;
  fingerprint: string | null;
  tiers: Array<{ id: number; name: string; passed: boolean; note: string }>;
  detail: unknown;
}


export interface ObjectiveDelta {
  objective: keyof ObjectiveWeights;
  better: 'winner' | 'runner-up' | 'equal' | 'not measured';
  winner: number | null;
  runnerUp: number | null;
  /** winner − runner-up, in the objective's own unit. */
  absolute: number | null;
  /** (winner − runnerUp) / max(|runnerUp|, eps), or null when not comparable. */
  relative: number | null;
  unit: string;
  /** Contribution to the score difference (weight × normalised gap). */
  weighted: number | null;
  /** What the number is, and at which level it was measured. */
  scope: string;
}

export interface WhyReport {
  winnerKey: string;
  runnerUpKey: string | null;
  /** One line per objective, in the profile's weight order. */
  deltas: ObjectiveDelta[];
  /** Structural differences that explain the deltas (both measured). */
  structure: string[];
  /** The explanation, in words, built only from the deltas above. */
  sentences: string[];
  /** What was not measured, so the comparison is not over-read. */
  caveats: string[];
}

const UNITS: Record<keyof ObjectiveWeights, string> = {
  delay: 's',
  components: 'component(s)',
  power: 'W',
  temperature: '°C',
  risk: 'risk point',
  memory: 'register bit(s)',
};

const SCOPES: Record<keyof ObjectiveWeights, string> = {
  delay: 'tier 2: declared-delay timing under the load model of the genome',
  components: 'tier 2: counted from the generated circuit (primitive components)',
  power: 'tier 3: worst-case static dissipation of the transistor-level implementation',
  temperature: 'tier 4: level-3 electro-thermal steady state at that operating point',
  risk: 'tier 2: structural risk terms (fan-out violations, redundancy, wasted inputs, undefined outputs, loops)',
  memory: 'tier 2: register bits in the design',
};

function valueOf(o: Objectives, key: keyof ObjectiveWeights): number | null {
  const v = o[key];
  if (v === null || v === undefined || !Number.isFinite(v as number)) {
    // `memory` is 0 for a combinational design, which is measured, not missing.
    if (key === 'memory' && typeof v === 'number') return v;
    return null;
  }
  return v as number;
}

/** Format a delta in the objective's own unit. */
export function formatObjective(key: keyof ObjectiveWeights, value: number | null): string {
  if (value === null) return 'not measured';
  switch (key) {
    case 'delay':
      return `${(value * 1e9).toFixed(3)} ns`;
    case 'power':
      return `${(value * 1e6).toFixed(4)} µW`;
    case 'temperature':
      return `${value.toFixed(3)} °C`;
    case 'components':
      return `${value.toFixed(0)} component(s)`;
    case 'memory':
      return `${value.toFixed(0)} bit(s)`;
    default:
      return value.toFixed(4);
  }
}

/**
 * Compare the winner with the runner-up.
 *
 * `weights` are the profile's weights; the weighted column is the objective's
 * share of the score gap, which is what makes the *ranking* explainable rather
 * than merely asserted.
 */
export function whyThisDesign(
  winner: ExplainableCandidate,
  runnerUp: ExplainableCandidate | null,
  weights: ObjectiveWeights,
): WhyReport {
  const order = (Object.keys(weights) as Array<keyof ObjectiveWeights>).sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
  const deltas: ObjectiveDelta[] = [];
  const caveats: string[] = [];
  for (const key of order) {
    const w = weights[key] ?? 0;
    if (w <= 0) continue;
    const a = valueOf(winner.objectives, key);
    const b = runnerUp ? valueOf(runnerUp.objectives, key) : null;
    if (a === null) {
      deltas.push({ objective: key, better: 'not measured', winner: null, runnerUp: b, absolute: null, relative: null, unit: UNITS[key], weighted: null, scope: SCOPES[key] });
      caveats.push(`${key}: never measured for the winning candidate (${SCOPES[key]}), so it contributes nothing to the comparison`);
      continue;
    }
    if (runnerUp === null || b === null) {
      deltas.push({ objective: key, better: 'winner', winner: a, runnerUp: b, absolute: null, relative: null, unit: UNITS[key], weighted: null, scope: SCOPES[key] });
      if (runnerUp === null) caveats.push('there is no runner-up: the search found a single feasible design');
      else caveats.push(`${key}: not measured for the runner-up (${SCOPES[key]}), so the gap is not quantified`);
      continue;
    }
    const absolute = a - b;
    const eps = Math.max(1e-30, Math.abs(b));
    const relative = absolute / eps;
    const equal = Math.abs(absolute) <= 1e-12 * Math.max(1, Math.abs(b));
    // Share of the score gap this objective accounts for: the weight times the
    // *relative* gap, normalised by the summed shares below.
    const weighted = w * relative;
    deltas.push({
      objective: key,
      better: equal ? 'equal' : absolute < 0 ? 'winner' : 'runner-up',
      winner: a,
      runnerUp: b,
      absolute,
      relative,
      unit: UNITS[key],
      weighted,
      scope: SCOPES[key],
    });
  }

  const shareTotal = deltas.reduce((a, d) => a + Math.abs(d.weighted ?? 0), 0);
  if (shareTotal > 0) {
    for (const d of deltas) if (d.weighted !== null) d.weighted = Math.abs(d.weighted) / shareTotal;
  }
  const structure: string[] = [];
  structure.push(`nodes: ${winner.genome.nodes} (winner) vs ${runnerUp ? runnerUp.genome.nodes : '—'} (runner-up)`);
  structure.push(`logic depth: ${winner.genome.depth} vs ${runnerUp ? runnerUp.genome.depth : '—'}`);
  structure.push(`worst fan-out: ${winner.genome.maxFanout} vs ${runnerUp ? runnerUp.genome.maxFanout : '—'}`);
  structure.push(`origin: ${winner.source}${runnerUp ? ` vs ${runnerUp.source}` : ''}`);

  const sentences: string[] = [];
  const meaningful = deltas.filter((d) => d.better !== 'not measured' && d.absolute !== null && Math.abs(d.absolute) > 0);
  const better = meaningful.filter((d) => d.better === 'winner').sort((a, b) => Math.abs(b.relative ?? 0) - Math.abs(a.relative ?? 0));
  const worse = meaningful.filter((d) => d.better === 'runner-up').sort((a, b) => Math.abs(b.relative ?? 0) - Math.abs(a.relative ?? 0));
  if (runnerUp === null) {
    sentences.push('Only one candidate met every constraint, so there is nothing to compare it against; the report lists its measured objectives and no claim of superiority.');
  } else {
    if (better.length > 0) {
      const d = better[0];
      sentences.push(
        `It wins mainly on ${d.objective}: ${formatObjective(d.objective, d.winner!)} against ${formatObjective(d.objective, d.runnerUp!)} ` +
          `(${d.absolute! < 0 ? '−' : '+'}${formatObjective(d.objective, Math.abs(d.absolute!))}${d.relative !== null ? `, ${(d.relative * 100).toFixed(1)} %` : ''}), measured as ${d.scope}.`,
      );
      for (const extra of better.slice(1, 3)) {
        sentences.push(
          `It is also better on ${extra.objective}: ${formatObjective(extra.objective, extra.winner!)} vs ${formatObjective(extra.objective, extra.runnerUp!)}.`,
        );
      }
    }
    if (worse.length > 0) {
      const d = worse[0];
      sentences.push(
        `It pays for that with ${d.objective}: ${formatObjective(d.objective, d.winner!)} against ${formatObjective(d.objective, d.runnerUp!)}` +
          `${d.relative !== null ? ` (${(d.relative * 100).toFixed(1)} %)` : ''}. That is the trade the profile's weights make: ` +
          `it accepted a worse ${d.objective} to win on ${better[0]?.objective ?? 'the other objectives'}.`,
      );
      for (const extra of worse.slice(1, 3)) {
        sentences.push(`It is also worse on ${extra.objective} (${formatObjective(extra.objective, extra.winner!)} vs ${formatObjective(extra.objective, extra.runnerUp!)}).`);
      }
    }
    if (better.length === 0 && worse.length === 0) {
      sentences.push('The two designs are indistinguishable on every measured objective; the ranking then follows the normalisation of equal values, not a physical difference.');
    }
    sentences.push(
      `Scores: ${winner.score.toFixed(4)} (winner) vs ${runnerUp.score.toFixed(4)} (runner-up), ` +
        `normalised min–max inside the candidate set, weights ${(Object.keys(weights) as Array<keyof ObjectiveWeights>)
          .filter((k) => weights[k] > 0)
          .map((k) => `${k} ${(weights[k] * 100).toFixed(0)} %`)
          .join(', ')}.`,
    );
  }
  if (!winner.detail) {
    caveats.push('the winning candidate has no detailed pass: power, temperature and switching energy were never measured for it');
  }
  if (runnerUp !== null && winner.fingerprint && runnerUp.fingerprint && winner.fingerprint === runnerUp.fingerprint) {
    caveats.push('the two candidates flatten to the same netlist fingerprint: they are the same circuit written two ways, not two designs');
  }
  if (winner.vectorMethod !== 'exhaustive') {
    caveats.push(`the behaviour contract was ${winner.vectorMethod}: correctness outside the checked vectors is not established`);
  }
  if (winner.tiers.some((t) => t.id >= 3 && !t.passed)) caveats.push('a detailed tier did not pass for the winner: see its tier notes');

  return { winnerKey: winner.key, runnerUpKey: runnerUp?.key ?? null, deltas, structure, sentences, caveats };
}

/** Plain-text rendering of a `WhyReport` (CLI, reports, console dock). */
export function whyToText(why: WhyReport): string {
  const lines: string[] = [];
  lines.push('WHY THIS DESIGN?');
  lines.push(`  winner ${why.winnerKey}${why.runnerUpKey ? `, compared with runner-up ${why.runnerUpKey}` : ' (no runner-up)'}`);
  lines.push('  measured deltas (winner → runner-up):');
  for (const d of why.deltas) {
    const arrow = d.better === 'equal' ? '=' : d.better === 'winner' ? 'better' : d.better === 'runner-up' ? 'worse' : 'n/a';
    lines.push(
      `    ${d.objective.padEnd(12)} ${formatObjective(d.objective, d.winner).padStart(16)} → ${formatObjective(d.objective, d.runnerUp).padStart(16)}  ${arrow}`,
    );
  }
  lines.push('  structure:');
  for (const s of why.structure) lines.push(`    ${s}`);
  lines.push('  explanation:');
  for (const s of why.sentences) lines.push(`    ${s}`);
  if (why.caveats.length > 0) {
    lines.push('  what this comparison does not cover:');
    for (const c of why.caveats) lines.push(`    - ${c}`);
  }
  return lines.join('\n');
}
