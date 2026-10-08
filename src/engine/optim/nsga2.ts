/**
 * NSGA-II: elitist multi-objective selection with fast non-dominated sorting and
 * crowding distance (Deb et al., 2002), written generically over any genome type.
 *
 * The algorithm is kept apart from the substrate it optimises so that the same
 * selection pressure can drive a logic network, an architecture template or a set
 * of component values. Nothing here knows what a circuit is.
 *
 * Why NSGA-II and not a weighted sum: the weights of a profile are a *decision*
 * the user makes after seeing the trade-off, not a fact about the design. The
 * search keeps the whole Pareto front, and the profile only sorts it.
 */

import type { Rng } from '../util/rng.js';

export interface Individual<T> {
  genes: T;
  /** Structural identity: two individuals with the same key are the same design. */
  key: string;
  /** Objective values, all minimised. */
  values: number[];
  /** Non-domination rank (0 = the front). */
  rank: number;
  /** Crowding distance inside the front (larger = more isolated = keep). */
  crowding: number;
  /** Generation in which the individual was created (for reports). */
  generation: number;
  /**
   * Summed constraint violation; 0 = feasible.
   *
   * Infeasible individuals stay in the population and are ranked by this amount
   * (Deb's constrained dominance). Dropping them instead is what makes a search
   * die on the spot when no seed happens to be correct: with nothing left to
   * vary, there is no gradient toward feasibility and every generation is empty.
   */
  violation: number;
  /** Set when the individual could not be evaluated at all (no objective vector). */
  rejected?: string;
}

export interface ConstraintViolation {
  /** Summed violation; 0 = feasible. Kept separate from the objectives. */
  amount: number;
}

export interface Nsga2Options {
  populationSize: number;
  /** Binary tournament size. */
  tournamentSize?: number;
  /** Probability that a child is a crossover of two parents instead of a mutation. */
  crossoverRate?: number;
  /**
   * Hard cap on variation attempts per generation, as a multiple of the
   * population size. Rejected children (a mutation that breaks the circuit) do
   * not enter the population, so without this cap a generation in which almost
   * everything is rejected would spin forever. A bounded generation is what makes
   * pause/resume and progress reporting meaningful.
   */
  maxAttemptsPerPopulation?: number;
}

/** Does `a` dominate `b`? (minimisation; equal vectors do not dominate) */
export function dominates(a: readonly number[], b: readonly number[]): boolean {
  let better = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return false;
    if (a[i] < b[i]) better = true;
  }
  return better;
}

/**
 * Constrained dominance (Deb et al., 2000):
 *   1. a feasible individual always dominates an infeasible one;
 *   2. two infeasible individuals are ordered by violation alone — a nearly
 *      correct design beats a very wrong one whatever its size or delay;
 *   3. two feasible individuals are ordered by the usual Pareto dominance.
 *
 * This is what gives a search a gradient toward feasibility instead of a cliff.
 */
export function constrainedDominates<T>(a: Individual<T>, b: Individual<T>): boolean {
  const af = a.violation <= 0;
  const bf = b.violation <= 0;
  if (af && !bf) return true;
  if (!af && bf) return false;
  if (!af && !bf) return a.violation < b.violation;
  return dominates(a.values, b.values);
}

/**
 * Fast non-dominated sort (Deb's O(MN²) procedure). Individuals with the same
 * objective vector are in the same front — no arbitrary tie-breaking.
 */
export function nonDominatedSort<T>(population: Individual<T>[]): Individual<T>[][] {
  const n = population.length;
  const dominated: number[][] = Array.from({ length: n }, () => []);
  const dominationCount = new Int32Array(n);
  const fronts: number[][] = [[]];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (constrainedDominates(population[i], population[j])) dominated[i].push(j);
      else if (constrainedDominates(population[j], population[i])) dominationCount[i]++;
    }
    if (dominationCount[i] === 0) {
      population[i].rank = 0;
      fronts[0].push(i);
    }
  }
  let f = 0;
  while (fronts[f] && fronts[f].length > 0) {
    const next: number[] = [];
    for (const i of fronts[f]) {
      for (const j of dominated[i]) {
        if (--dominationCount[j] === 0) {
          population[j].rank = f + 1;
          next.push(j);
        }
      }
    }
    f++;
    if (next.length > 0) fronts[f] = next;
    else break;
  }
  return fronts.filter((x) => x.length > 0).map((indices) => indices.map((i) => population[i]));
}

/**
 * Crowding distance of each front (boundary individuals get Infinity so the
 * extremes of a trade-off are never dropped by the selection).
 */
export function crowdingDistance<T>(front: Individual<T>[]): void {
  const n = front.length;
  for (const ind of front) ind.crowding = 0;
  if (n <= 2) {
    for (const ind of front) ind.crowding = Infinity;
    return;
  }
  const m = front[0].values.length;
  for (let k = 0; k < m; k++) {
    const order = [...front].sort((a, b) => a.values[k] - b.values[k]);
    order[0].crowding = Infinity;
    order[n - 1].crowding = Infinity;
    const span = order[n - 1].values[k] - order[0].values[k];
    if (span <= 0) continue;
    for (let i = 1; i < n - 1; i++) {
      if (!Number.isFinite(order[i].crowding)) continue;
      order[i].crowding += (order[i + 1].values[k] - order[i - 1].values[k]) / span;
    }
  }
}

/** Crowded-comparison operator: lower rank wins, then larger crowding distance. */
export function crowdedLess<T>(a: Individual<T>, b: Individual<T>): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank;
  return a.crowding > b.crowding;
}

/** What an evaluator returns: objectives, and how infeasible the candidate is. */
export type EvaluateResult = { values: number[]; violation?: number; rejected?: string };

export interface EvolutionStep<T> {
  /** Candidates actually evaluated in this step. */
  evaluated: number;
  /** Candidates rejected by the caller's evaluator. */
  rejected: number;
  /** Objective evaluations that came from the cache. */
  cached: number;
  /** Children proposed. */
  proposed: number;
  /** Size of the Pareto front after selection. */
  frontSize: number;
}

export class Nsga2<T> {
  readonly population: Individual<T>[] = [];
  generation = 0;
  /** Every individual ever evaluated, by key (the candidate cache lives here). */
  readonly archive = new Map<string, Individual<T>>();

  constructor(private opts: Nsga2Options) {}

  get size(): number {
    return this.population.length;
  }

  /**
   * Seed the population.
   *
   * `evaluate` returns the objective vector and, when the candidate breaks a
   * constraint, how much it breaks it by. An infeasible individual still enters
   * the population (constrained dominance ranks it below every feasible one and
   * above the ones that are worse), because that is the only gradient the search
   * has when no seed is correct. An individual that could not be evaluated at all
   * is kept in the archive — so it is never re-evaluated — but never enters the
   * population: with no objective vector there is nothing to rank.
   */
  seed(
    candidates: Array<{ genes: T; key: string }>,
    evaluate: (genes: T) => EvaluateResult,
  ): EvolutionStep<T> {
    const step: EvolutionStep<T> = { evaluated: 0, rejected: 0, cached: 0, proposed: 0, frontSize: 0 };
    for (const c of candidates) {
      step.proposed++;
      const existing = this.archive.get(c.key);
      if (existing) {
        step.cached++;
        continue;
      }
      const r = evaluate(c.genes);
      step.evaluated++;
      const ind: Individual<T> = {
        genes: c.genes,
        key: c.key,
        values: r.rejected ? [] : r.values,
        rank: 0,
        crowding: 0,
        generation: 0,
        violation: r.rejected ? Number.POSITIVE_INFINITY : Math.max(0, r.violation ?? 0),
        rejected: r.rejected,
      };
      this.archive.set(c.key, ind);
      if (r.rejected) {
        // Not evaluable at all: no objective vector, so nothing to rank against.
        step.rejected++;
        continue;
      }
      if (ind.violation > 0) step.rejected++;
      this.population.push(ind);
    }
    this.select();
    step.frontSize = this.front().length;
    return step;
  }

  /**
   * One generation: produce `populationSize` children from the current
   * population (tournament + variation), evaluate the new ones, then keep the
   * best `populationSize` individuals of parents ∪ children.
   */
  step(
    rng: Rng,
    produce: (a: T, b: T | null, rng: Rng) => { genes: T; key: string },
    evaluate: (genes: T) => EvaluateResult,
  ): EvolutionStep<T> {
    const step: EvolutionStep<T> = { evaluated: 0, rejected: 0, cached: 0, proposed: 0, frontSize: 0 };
    if (this.population.length === 0) {
      this.generation++;
      return step;
    }
    const children: Individual<T>[] = [];
    const crossoverRate = this.opts.crossoverRate ?? 0.5;
    const tournament = this.opts.tournamentSize ?? 2;
    const maxAttempts = Math.max(
      this.opts.populationSize,
      Math.round(this.opts.populationSize * (this.opts.maxAttemptsPerPopulation ?? 8)),
    );
    while (children.length < this.opts.populationSize && step.proposed < maxAttempts) {
      const a = this.tournament(rng, tournament);
      const useCrossover = rng.chance(crossoverRate) && this.population.length > 1;
      const b = useCrossover ? this.tournament(rng, tournament) : null;
      // A child identical to a parent is legal but wasteful: retry a bounded
      // number of times, then accept (the cache makes the retry free anyway).
      const child = produce(a.genes, b?.genes ?? null, rng);
      step.proposed++;
      const existing = this.archive.get(child.key);
      if (existing) {
        step.cached++;
        continue;
      }
      const r = evaluate(child.genes);
      step.evaluated++;
      const ind: Individual<T> = {
        genes: child.genes,
        key: child.key,
        values: r.rejected ? [] : r.values,
        rank: 0,
        crowding: 0,
        generation: this.generation + 1,
        violation: r.rejected ? Number.POSITIVE_INFINITY : Math.max(0, r.violation ?? 0),
        rejected: r.rejected,
      };
      this.archive.set(child.key, ind);
      if (r.rejected) {
        step.rejected++;
        continue;
      }
      if (ind.violation > 0) step.rejected++;
      children.push(ind);
    }
    // Environmental selection: parents ∪ children, best first.
    this.population.push(...children);
    this.select();
    this.generation++;
    step.frontSize = this.front().length;
    return step;
  }

  /** Turn any individual into a report line. */
  private tournament(rng: Rng, size: number): Individual<T> {
    let best: Individual<T> | null = null;
    for (let i = 0; i < size; i++) {
      const pick = this.population[rng.int(this.population.length)];
      if (!best || crowdedLess(pick, best)) best = pick;
    }
    return best!;
  }

  /** Rank + crowding + truncation to the population size. */
  private select(): void {
    const fronts = nonDominatedSort(this.population);
    const kept: Individual<T>[] = [];
    for (const front of fronts) {
      crowdingDistance(front);
      if (kept.length + front.length <= this.opts.populationSize) {
        kept.push(...front);
        continue;
      }
      const sorted = [...front].sort((a, b) => b.crowding - a.crowding);
      kept.push(...sorted.slice(0, this.opts.populationSize - kept.length));
      break;
    }
    // Deduplicate by key while preserving order (a child can equal a parent).
    const seen = new Set<string>();
    this.population.length = 0;
    for (const ind of kept) {
      if (seen.has(ind.key)) continue;
      seen.add(ind.key);
      this.population.push(ind);
    }
    for (const ind of this.population) if (!Number.isFinite(ind.crowding)) ind.crowding = ind.crowding;
  }

  /**
   * The current Pareto front (rank 0), feasible members only.
   *
   * An infeasible individual can hold rank 0 when the whole population is
   * infeasible; reporting it as part of a Pareto front would claim a trade-off
   * between designs that do not work.
   */
  front(): Individual<T>[] {
    return this.population.filter((i) => i.rank === 0 && i.violation <= 0);
  }

  /** Feasible members of the population, best rank first. */
  feasible(): Individual<T>[] {
    return this.population.filter((i) => i.violation <= 0).sort((a, b) => a.rank - b.rank || b.crowding - a.crowding);
  }

  /** Smallest violation in the population, and whether anything is feasible. */
  feasibility(): { feasible: number; infeasible: number; bestViolation: number } {
    let feasible = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const i of this.population) {
      if (i.violation <= 0) feasible++;
      else best = Math.min(best, i.violation);
    }
    return { feasible, infeasible: this.population.length - feasible, bestViolation: feasible > 0 ? 0 : best };
  }

  /** Every non-dominated individual ever evaluated, not just the current front. */
  archiveFront(): Individual<T>[] {
    // Feasible only: a Pareto front of designs that do not meet the contract
    // would be a trade-off between wrong answers.
    const alive = [...this.archive.values()].filter((i) => !i.rejected && i.values.length > 0 && i.violation <= 0);
    const fronts = nonDominatedSort(alive);
    return fronts[0] ?? [];
  }

  /** Objective ranges over the archive (used for normalisation in reports). */
  ranges(): Array<{ min: number; max: number }> {
    const alive = [...this.archive.values()].filter((i) => !i.rejected && i.values.length > 0 && i.violation <= 0);
    const m = alive.length > 0 ? alive[0].values.length : 0;
    const out: Array<{ min: number; max: number }> = [];
    for (let k = 0; k < m; k++) {
      let min = Infinity;
      let max = -Infinity;
      for (const ind of alive) {
        min = Math.min(min, ind.values[k]);
        max = Math.max(max, ind.values[k]);
      }
      out.push({ min, max });
    }
    return out;
  }
}
