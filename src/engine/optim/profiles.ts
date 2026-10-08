/**
 * Optimisation profiles: what the user is willing to trade.
 *
 * The weights are a *decision*, not a measurement, and the report always prints
 * them next to the ranking they produced. Two rules keep this honest:
 *
 *   1. an objective that was not measured for a candidate (power before the
 *      detailed pass, say) contributes no weight for that candidate, and the
 *      remaining weights are renormalised — the report says how many candidates
 *      were ranked with a reduced weight set;
 *   2. normalisation is min–max over the candidate set being ranked, so a score
 *      is only ever comparable inside that set. The scores are therefore reported
 *      as *ranks with their weights*, never as an absolute quality.
 */

import type { Objectives } from './cost.js';

export type ProfileName =
  | 'FASTEST'
  | 'SMALLEST'
  | 'LOW_POWER'
  | 'LOW_TEMPERATURE'
  | 'MOST_STABLE'
  | 'BALANCED'
  | 'CUSTOM';

export interface ObjectiveWeights {
  delay: number;
  components: number;
  power: number;
  temperature: number;
  risk: number;
  memory: number;
}

export const OBJECTIVE_NAMES: Array<keyof ObjectiveWeights> = [
  'delay',
  'components',
  'power',
  'temperature',
  'risk',
  'memory',
];

export interface ProfileSpec {
  name: ProfileName;
  description: string;
  weights: ObjectiveWeights;
}

/** The user-facing default: speed first, then size, then power, then heat. */
export const BALANCED_WEIGHTS: ObjectiveWeights = {
  delay: 0.4,
  components: 0.2,
  power: 0.15,
  temperature: 0.1,
  risk: 0.1,
  memory: 0.05,
};

export const PROFILES: Record<ProfileName, ProfileSpec> = {
  FASTEST: {
    name: 'FASTEST',
    description: 'the shortest critical path the search found; size, power and heat are only tie-breakers',
    weights: { delay: 0.8, components: 0.06, power: 0.05, temperature: 0.03, risk: 0.05, memory: 0.01 },
  },
  SMALLEST: {
    name: 'SMALLEST',
    description: 'the fewest components; timing still matters, but only after size',
    weights: { delay: 0.15, components: 0.65, power: 0.08, temperature: 0.05, risk: 0.05, memory: 0.02 },
  },
  LOW_POWER: {
    name: 'LOW_POWER',
    description: 'the least energy per operation, measured at the transistor level (static + switching)',
    weights: { delay: 0.12, components: 0.08, power: 0.55, temperature: 0.15, risk: 0.06, memory: 0.04 },
  },
  LOW_TEMPERATURE: {
    name: 'LOW_TEMPERATURE',
    description: 'the coldest junction under the level-3 electro-thermal steady state',
    weights: { delay: 0.12, components: 0.08, power: 0.15, temperature: 0.55, risk: 0.06, memory: 0.04 },
  },
  MOST_STABLE: {
    name: 'MOST_STABLE',
    description: 'the least structural risk (fan-out, redundancy, wasted inputs) — the design most likely to behave the same on every corner',
    weights: { delay: 0.15, components: 0.1, power: 0.1, temperature: 0.05, risk: 0.55, memory: 0.05 },
  },
  BALANCED: {
    name: 'BALANCED',
    description: 'speed 40 %, components 20 %, power 15 %, temperature 10 %, stability 10 %, memory 5 %',
    weights: { ...BALANCED_WEIGHTS },
  },
  CUSTOM: {
    name: 'CUSTOM',
    description: 'weights supplied by the caller',
    weights: { ...BALANCED_WEIGHTS },
  },
};

export function resolveProfile(profile: ProfileName | ProfileSpec | undefined, custom?: Partial<ObjectiveWeights>): ProfileSpec {
  if (profile === undefined) return PROFILES.BALANCED;
  if (typeof profile === 'string') {
    const spec = PROFILES[profile] ?? PROFILES.BALANCED;
    return custom ? { ...spec, weights: { ...spec.weights, ...custom } } : spec;
  }
  return custom ? { ...profile, weights: { ...profile.weights, ...custom } } : profile;
}

/** Normalised objective value in [0,1] (1 = the worst in the set). */
function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  if (max - min <= 0) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export interface RankInput {
  key: string;
  objectives: Objectives;
}

export interface RankedCandidate {
  key: string;
  /** Weighted sum of normalised objectives: 0 = best in this set, 1 = worst. */
  score: number;
  /** Per-objective normalised values that produced the score. */
  normalized: Partial<Record<keyof ObjectiveWeights, number>>;
  /** Objectives that were actually measured and therefore weighted. */
  weighted: Array<keyof ObjectiveWeights>;
  /** Objectives skipped because they were never measured for this candidate. */
  missing: Array<keyof ObjectiveWeights>;
}

export interface RankingResult {
  ranked: RankedCandidate[];
  weights: ObjectiveWeights;
  /** Ranges used for normalisation (min/max per objective). */
  ranges: Partial<Record<keyof ObjectiveWeights, { min: number; max: number }>>;
  /** How many candidates were ranked with at least one objective missing. */
  reducedWeightSet: number;
  note: string;
}

/**
 * Rank candidates by a profile.
 *
 * `memory` is only meaningful for sequential designs; for a combinational
 * specification every candidate has 0 and the objective drops out of the
 * normalisation (its range is empty), which the note states.
 */
export function rankCandidates(candidates: readonly RankInput[], profile: ProfileSpec): RankingResult {
  const ranges: Partial<Record<keyof ObjectiveWeights, { min: number; max: number }>> = {};
  for (const name of OBJECTIVE_NAMES) {
    let min = Infinity;
    let max = -Infinity;
    let seen = 0;
    for (const c of candidates) {
      const v = c.objectives[name];
      if (v === null || v === undefined || !Number.isFinite(v as number)) continue;
      min = Math.min(min, v as number);
      max = Math.max(max, v as number);
      seen++;
    }
    if (seen > 0) ranges[name] = { min, max };
  }
  let reduced = 0;
  const ranked = candidates.map<RankedCandidate>((c) => {
    const normalized: Partial<Record<keyof ObjectiveWeights, number>> = {};
    const weighted: Array<keyof ObjectiveWeights> = [];
    const missing: Array<keyof ObjectiveWeights> = [];
    let weightSum = 0;
    let total = 0;
    for (const name of OBJECTIVE_NAMES) {
      const w = profile.weights[name] ?? 0;
      if (w <= 0) continue;
      const v = c.objectives[name];
      const range = ranges[name];
      if (v === null || v === undefined || !Number.isFinite(v as number) || !range) {
        missing.push(name);
        continue;
      }
      const n = normalize(v as number, range.min, range.max);
      normalized[name] = n;
      weighted.push(name);
      total += w * n;
      weightSum += w;
    }
    if (missing.length > 0) reduced++;
    return {
      key: c.key,
      score: weightSum > 0 ? total / weightSum : 1,
      normalized,
      weighted,
      missing,
    };
  });
  ranked.sort((a, b) => a.score - b.score);
  const skipped = OBJECTIVE_NAMES.filter((n) => profile.weights[n] > 0 && !ranges[n]);
  const note =
    `${ranked.length} candidate(s) ranked by the ${profile.name} profile (weights ${OBJECTIVE_NAMES.filter((n) => profile.weights[n] > 0)
      .map((n) => `${n} ${(profile.weights[n] * 100).toFixed(0)} %`)
      .join(', ')}); normalisation is min–max inside this candidate set only` +
    (skipped.length > 0 ? `; ${skipped.join(', ')} has no measured value anywhere, so it is not weighted` : '') +
    (reduced > 0 ? `; ${reduced} candidate(s) were ranked with a reduced weight set because an objective was not measured` : '');
  return { ranked, weights: profile.weights, ranges, reducedWeightSet: reduced, note };
}

/** Human line for one ranking entry. */
export function describeRanking(ranked: RankedCandidate, objectives: Objectives): string {
  const parts: string[] = [];
  if (ranked.normalized.delay !== undefined) parts.push(`delay ${(objectives.delay * 1e9).toFixed(3)} ns`);
  parts.push(`components ${objectives.components}`);
  if (objectives.power !== null) parts.push(`static ${(objectives.power * 1e6).toFixed(3)} µW`);
  if (objectives.switchEnergy !== null) parts.push(`switch ${(objectives.switchEnergy * 1e12).toFixed(3)} pJ/period`);
  if (objectives.temperature !== null) parts.push(`Tj ${objectives.temperature.toFixed(2)} °C`);
  parts.push(`risk ${objectives.risk.toFixed(2)}`);
  return `score ${ranked.score.toFixed(4)} — ${parts.join(', ')}`;
}
