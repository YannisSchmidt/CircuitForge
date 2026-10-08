/**
 * Internal profiler.
 *
 * The specification requires that the software can profile its own engine and
 * report where time goes (logic evaluation / event queue / memory / propagation /
 * rendering …). This is a low-overhead, phase-based profiler:
 *
 *   const t = profiler.begin('logic.evaluate');
 *   ...
 *   t.end();
 *
 * Only enabled categories pay the cost when `enabled === false` (a single boolean
 * check + no timer reads). Timings use `performance.now()` when available so that
 * it also works in the browser.
 */

export interface PhaseStats {
  name: string;
  /** Total inclusive wall time in milliseconds. */
  totalMs: number;
  /** Number of completed samples. */
  calls: number;
  /** Min / max single sample, ms. */
  minMs: number;
  maxMs: number;
  /** Children time (for self-time computation). */
  childMs: number;
  /** Optional counted units (events, elements, netlists…). */
  units: number;
}

export interface ProfileReport {
  enabled: boolean;
  totalMs: number;
  phases: Array<PhaseStats & { selfMs: number; percent: number; selfPercent: number }>;
  /** Caller-annotated counters, e.g. events processed. */
  counters: Record<string, number>;
  /** Sample window start. */
  startedAt: number;
}

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

interface Frame {
  name: string;
  start: number;
  childMs: number;
}

export class Handle {
  constructor(
    private prof: Profiler,
    private frameIndex: number,
  ) {}

  /** End the phase. Returns elapsed ms. */
  end(units = 0): number {
    return this.prof['finish'](this.frameIndex, units);
  }
}

export class Profiler {
  enabled = false;

  private stats = new Map<string, PhaseStats>();
  private counters = new Map<string, number>();
  private stack: Frame[] = [];
  private framePool: Frame[] = [];
  private startedAt = 0;

  enable(): void {
    this.enabled = true;
    this.startedAt = now();
  }

  reset(): void {
    this.stats.clear();
    this.counters.clear();
    this.stack.length = 0;
    this.startedAt = now();
  }

  /** Begin a named phase. Always cheap: one Map lookup when enabled. */
  begin(name: string): Handle {
    if (!this.enabled) return new Handle(this, -1);
    const frame = this.framePool.pop() ?? { name: '', start: 0, childMs: 0 };
    frame.name = name;
    frame.start = now();
    frame.childMs = 0;
    this.stack.push(frame);
    return new Handle(this, this.stack.length - 1);
  }

  /** Convenience wrapper. */
  time<T>(name: string, fn: () => T): T {
    const h = this.begin(name);
    try {
      return fn();
    } finally {
      h.end();
    }
  }

  /** Measure a block with `try/finally`; returns the block's return value. */
  measure<T>(name: string, fn: () => T, units?: () => number): T {
    const h = this.begin(name);
    try {
      return fn();
    } finally {
      h.end(units ? units() : 0);
    }
  }

  private finish(frameIndex: number, units: number): number {
    if (frameIndex < 0 || !this.enabled) return 0;
    const frame = this.stack.pop();
    if (!frame) return 0;
    const elapsed = now() - frame.start;
    let st = this.stats.get(frame.name);
    if (!st) {
      st = { name: frame.name, totalMs: 0, calls: 0, minMs: Infinity, maxMs: 0, childMs: 0, units: 0 };
      this.stats.set(frame.name, st);
    }
    st.totalMs += elapsed;
    st.calls++;
    st.units += units;
    if (elapsed < st.minMs) st.minMs = elapsed;
    if (elapsed > st.maxMs) st.maxMs = elapsed;
    st.childMs += frame.childMs;
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.childMs += elapsed;
    frame.name = '';
    this.framePool.push(frame);
    return elapsed;
  }

  /** Increment a free-form counter (events processed, candidates simulated…). */
  count(name: string, delta = 1): void {
    if (!this.enabled) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  get(name: string): PhaseStats | undefined {
    return this.stats.get(name);
  }

  /** Snapshot of all phase stats, sorted by inclusive time. */
  report(): ProfileReport {
    const phases: Array<PhaseStats & { selfMs: number; percent: number; selfPercent: number }> = [];
    let grand = 0;
    for (const st of this.stats.values()) {
      // Top-level phases define the denominator: nested phases would otherwise
      // double count. We approximate by using the maximum inclusive time.
      if (st.totalMs > grand) grand = st.totalMs;
    }
    const totalMs = grand;
    for (const st of this.stats.values()) {
      const selfMs = Math.max(0, st.totalMs - st.childMs);
      phases.push({
        ...st,
        minMs: st.calls ? st.minMs : 0,
        selfMs,
        percent: totalMs > 0 ? (100 * st.totalMs) / totalMs : 0,
        selfPercent: totalMs > 0 ? (100 * selfMs) / totalMs : 0,
      });
    }
    phases.sort((a, b) => b.totalMs - a.totalMs);
    return {
      enabled: this.enabled,
      totalMs,
      phases,
      counters: Object.fromEntries(this.counters),
      startedAt: this.startedAt,
    };
  }

  /** Compact textual report, used by `circuitforge profile` and the UI console. */
  format(): string {
    const r = this.report();
    const lines: string[] = [];
    lines.push(`PROFILER (${r.totalMs.toFixed(1)} ms wall, ${r.phases.length} phases)`);
    lines.push('  phase                       total      self    calls     %');
    for (const p of r.phases.slice(0, 40)) {
      lines.push(
        `  ${p.name.padEnd(24)} ${p.totalMs.toFixed(2).padStart(9)}ms ${p.selfMs
          .toFixed(2)
          .padStart(9)}ms ${String(p.calls).padStart(8)} ${p.selfPercent.toFixed(1).padStart(5)}%`,
      );
    }
    const ck = Object.keys(r.counters);
    if (ck.length) {
      lines.push('  counters:');
      for (const k of ck) lines.push(`    ${k} = ${r.counters[k]}`);
    }
    return lines.join('\n');
  }
}

/** Process-wide profiler used by the engine and exposed to the UI. */
export const profiler = new Profiler();
