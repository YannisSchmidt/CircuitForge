/**
 * Time-domain measurements: what an instrument reads off a captured trace.
 *
 * The solver returns **adaptively spaced** samples — it takes small steps where
 * the circuit changes fast and large ones where nothing happens. Every number
 * here is computed accordingly, and this is the single most important correctness
 * decision in the instrument layer:
 *
 * - Averages and RMS are **time-weighted** (trapezoidal over t), not sample
 *   averages. Averaging samples would weight a slow, coarsely sampled interval as
 *   heavily as a fast, finely sampled one and report the wrong RMS for any
 *   waveform the solver stepped unevenly — which is every real transient.
 * - Frequency, edges and phase locate events by **linear interpolation between
 *   samples**, so their accuracy is bounded by the step size at the crossing, not
 *   by the average step size. The bound is reported (`timingResolution`).
 * - The FFT in `fft.ts` needs a uniform grid, so `resampleUniform` builds one and
 *   says it did: a spectral reading is only as good as that interpolation.
 *
 * Nothing here extrapolates. If a measurement needs more of the waveform than was
 * captured (a period longer than the record, a crossing that never happens), the
 * result says so instead of returning a number.
 */

import { Accuracy } from '../core/labels.js';

/** A captured trace: one quantity over time. */
export interface Trace {
  /** Channel name as shown on the instrument. */
  name: string;
  /** Physical unit of `values`. */
  unit: string;
  /** Sample times, seconds, strictly increasing. */
  times: Float64Array;
  /** Sample values. */
  values: Float64Array;
  /** What the trace is. */
  kind: 'voltage' | 'current' | 'power' | 'temperature' | 'logic' | 'time';
  /** Where it was measured (a node, an element, a thermal node). */
  target: string;
}

export interface TraceStats {
  unit: string;
  count: number;
  /** Time-weighted mean (trapezoidal). This is the reading. */
  mean: number;
  /** Plain sample average, kept so the difference is visible. */
  sampleMean: number;
  /** Time-weighted RMS: sqrt(∫v²dt / ∫dt). */
  rms: number;
  /** RMS of the AC component only (DC removed by the time-weighted mean). */
  acRms: number;
  min: number;
  max: number;
  peakToPeak: number;
  /** Time-weighted standard deviation. */
  stdDev: number;
  first: number;
  last: number;
  tStart: number;
  tEnd: number;
  duration: number;
  /** Mean sample interval, s. */
  meanStep: number;
  /** Largest sample interval, s — the coarsest place in the record. */
  maxStep: number;
  /** Equivalent uniform sample rate from the record length, Hz. */
  sampleRate: number;
  /** How the numbers were computed, in one line. */
  method: string;
  accuracy: Accuracy;
}

/**
 * Descriptive statistics of a trace.
 *
 * With fewer than two samples there is no interval to weight, so the values are
 * reported as the single sample and the method says so.
 */
export function traceStats(trace: Trace): TraceStats {
  const { times, values, unit } = trace;
  const n = values.length;
  if (n === 0) {
    return {
      unit, count: 0, mean: NaN, sampleMean: NaN, rms: NaN, acRms: NaN, min: NaN, max: NaN,
      peakToPeak: NaN, stdDev: NaN, first: NaN, last: NaN, tStart: NaN, tEnd: NaN,
      duration: 0, meanStep: 0, maxStep: 0, sampleRate: 0,
      method: 'no samples were captured',
      accuracy: Accuracy.NOT_MODELED,
    };
  }
  let min = Infinity;
  let max = -Infinity;
  let sampleSum = 0;
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sampleSum += v;
    if (i > 0) {
      const dt = times[i] - times[i - 1];
      if (dt > maxStep) maxStep = dt;
    }
  }
  const tStart = times[0];
  const tEnd = times[n - 1];
  const duration = tEnd - tStart;
  if (n === 1 || !(duration > 0)) {
    const v = values[0];
    return {
      unit, count: n, mean: v, sampleMean: v, rms: Math.abs(v), acRms: 0, min, max,
      peakToPeak: max - min, stdDev: 0, first: v, last: v, tStart, tEnd, duration,
      meanStep: 0, maxStep: 0, sampleRate: 0,
      method: `a single sample at t = ${formatSeconds(tStart)}: no interval exists to weight, so mean and RMS are that sample`,
      accuracy: Accuracy.APPROXIMATED,
    };
  }
  // Trapezoidal integrals over time.
  let intV = 0;
  let intV2 = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0)) continue;
    intV += 0.5 * (values[i] + values[i - 1]) * dt;
    intV2 += 0.5 * (values[i] * values[i] + values[i - 1] * values[i - 1]) * dt;
  }
  const mean = intV / duration;
  const meanSquare = intV2 / duration;
  const rms = Math.sqrt(Math.max(meanSquare, 0));
  // AC RMS via the time-weighted second moment about the mean, again integrated
  // rather than averaged over samples.
  let intDev2 = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0)) continue;
    const d0 = values[i - 1] - mean;
    const d1 = values[i] - mean;
    intDev2 += 0.5 * (d0 * d0 + d1 * d1) * dt;
  }
  const stdDev = Math.sqrt(Math.max(intDev2 / duration, 0));
  return {
    unit,
    count: n,
    mean,
    sampleMean: sampleSum / n,
    rms,
    acRms: stdDev,
    min: Number.isFinite(min) ? min : NaN,
    max: Number.isFinite(max) ? max : NaN,
    peakToPeak: Number.isFinite(min) && Number.isFinite(max) ? max - min : NaN,
    stdDev,
    first: values[0],
    last: values[n - 1],
    tStart,
    tEnd,
    duration,
    meanStep: duration / (n - 1),
    maxStep,
    sampleRate: duration > 0 ? (n - 1) / duration : 0,
    method:
      `time-weighted over ${n} adaptive samples spanning ${formatSeconds(duration)} ` +
      `(∫v·dt/∫dt for the mean, √(∫v²·dt/∫dt) for RMS, trapezoidal); ` +
      `the coarsest interval in the record is ${formatSeconds(maxStep)}`,
    accuracy: Accuracy.APPROXIMATED,
  };
}

/**
 * Low and high levels of a trace from its 1st and 99th percentiles.
 *
 * Used wherever a threshold has to sit between the two levels of a waveform: the
 * extremes would put it wherever a single outlier sample happens to be. Sorting the
 * window is O(N log N) on a copy, which for an instrument reading a record once is
 * nothing next to the simulation that produced it.
 */
export function robustLevels(values: Float64Array, lo = 0, hi = values.length - 1): { low: number; high: number; p1: number; p99: number } {
  const count = hi - lo + 1;
  if (count <= 0) return { low: NaN, high: NaN, p1: NaN, p99: NaN };
  if (count < 8) {
    // Too few samples for a percentile to mean anything: fall back to the extremes,
    // which is what a short record can honestly offer.
    let min = Infinity;
    let max = -Infinity;
    for (let i = lo; i <= hi; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    return { low: min, high: max, p1: min, p99: max };
  }
  const sorted = Float64Array.from(values.subarray(lo, hi + 1)).sort();
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx];
  };
  return { low: at(0.01), high: at(0.99), p1: at(0.01), p99: at(0.99) };
}

export interface FrequencyResult {
  /** Frequency, Hz; null when it could not be measured. */
  frequency: number | null;
  /** Mean period, s. */
  period: number | null;
  /** Number of periods observed (crossings / 2 for a full cycle). */
  cycles: number;
  /** Standard deviation of the measured periods, s — the jitter. */
  periodStdDev: number;
  /** The first measured period, s. */
  firstPeriod: number | null;
  /** The last measured period, s. */
  lastPeriod: number | null;
  /**
   * True when the record looks like steady state: the first and last periods agree
   * to within 2 % and the period jitter is under 1 %.
   *
   * A circuit switched on at t = 0 does not start in steady state — an RC filter
   * driven by a sine that begins at zero has a natural response that decays with the
   * circuit's own time constant. Over a short record that transient shifts the first
   * crossing, and the frequency read from it is the frequency of the *record*, not of
   * the source. This flag is how an instrument says which of the two it measured.
   */
  settled: boolean;
  /** Amplitude seen at the crossings (half the peak-to-peak of the AC part). */
  amplitude: number | null;
  /** The step size at the crossings, s: the timing resolution of this reading. */
  timingResolution: number;
  /** Rising-edge crossing times, s. */
  crossings: number[];
  method: string;
  accuracy: Accuracy;
  /** Why the measurement is null, when it is. */
  note: string;
}

export interface FrequencyOptions {
  /** Crossing threshold; the midpoint of the record's own levels by default. */
  threshold?: number;
  /** Hysteresis band, in trace units, to reject noise re-crossings. 1 % of the span by default. */
  hysteresis?: number;
  /** Maximum number of crossings to record (a very long record need not store them all). */
  maxCrossings?: number;
  /**
   * Which part of the record to measure: all of it (`'all'`, the default), only the
   * last period, or an explicit interval.
   *
   * A circuit switched on at t = 0 does not start in steady state, and the startup
   * transient is part of the record. Measuring over all of it therefore measures the
   * record, not the source: the transient can put an extra threshold crossing near
   * the beginning and shift every period that follows. `'last'` is the honest way to
   * ask for the settled frequency, and `settled` says whether the two would differ.
   */
  over?: 'all' | 'last' | { t0: number; t1: number };
}

/**
 * Frequency, period and amplitude by hysteresis zero-crossing with linear
 * interpolation.
 *
 * The threshold defaults to the midpoint between the record's extremes, so the
 * same call works on a 0–3.3 V logic waveform and on a ±1 V sine. Hysteresis
 * rejects ringing: a crossing is only counted once the trace has left the band
 * around the threshold, which is what stops a noisy edge from reading as several
 * cycles.
 *
 * The measurement needs at least two same-direction crossings (one full period).
 * With fewer, `frequency` is null and the note says the record is shorter than one
 * period — it never extrapolates a frequency from a single edge.
 */
export function measureFrequency(trace: Trace, opts: FrequencyOptions = {}): FrequencyResult {
  const { times, values } = trace;
  const n = values.length;
  const none = (note: string): FrequencyResult => ({
    frequency: null, period: null, cycles: 0, periodStdDev: 0, firstPeriod: null, lastPeriod: null, settled: false,
    amplitude: null, timingResolution: 0, crossings: [],
    method: 'hysteresis zero-crossing with linear interpolation', accuracy: Accuracy.APPROXIMATED, note,
  });
  if (n < 3) return none(`only ${n} sample(s): a period needs at least two crossings`);
  // Restrict to the requested window first: the levels, the threshold and the
  // crossings all follow it, so "the frequency over the last period" means exactly
  // that and not "the frequency over the record with a note about the last period".
  let lo = 0;
  let hi = n - 1;
  const over = opts.over ?? 'all';
  if (over !== 'all') {
    if (typeof over === 'object') {
      while (lo < hi && times[lo] < over.t0) lo++;
      while (hi > lo && times[hi] > over.t1) hi--;
    } else {
      // 'last': the settled tail, estimated from the record's own zero crossings in a
      // first pass. Two passes rather than one, because the period is what defines the
      // window and the window is what the period is measured over.
      //
      // The window is several periods, not one. A single period contains at most two
      // rising crossings and often only one — which is no period at all — so a
      // "measure the last period" option would usually return nothing. Five periods, or
      // a quarter of the record if that is larger, gives a mean period worth quoting
      // while still excluding the startup transient at the beginning.
      const rough = measureFrequency(trace, { ...opts, over: 'all' });
      const span = times[n - 1] - times[0];
      const period = rough.period ?? span;
      const want = Math.min(span, Math.max(5 * period, span / 4));
      const from = times[n - 1] - want;
      while (lo < hi && times[lo] < from) lo++;
    }
    if (hi - lo < 2) return none(`the requested window holds ${hi - lo + 1} sample(s): not enough for a period`);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return none('the trace has no finite samples');
  const span = max - min;
  if (!(span > 0)) return none(`the trace is constant at ${min} ${trace.unit}: there is nothing to cross`);
  // The threshold comes from the 1st and 99th percentiles rather than the extremes,
  // so a single glitch sample — a rejected step, a spike at a switching instant —
  // does not move the level every crossing is measured against. The extremes are
  // still used for the reported amplitude, which is a different question.
  const levels = robustLevels(values, lo, hi);
  const threshold = Number.isFinite(opts.threshold ?? NaN) ? (opts.threshold as number) : (levels.low + levels.high) / 2;
  const hysteresis = Number.isFinite(opts.hysteresis ?? NaN) ? Math.abs(opts.hysteresis as number) : (levels.high - levels.low) * 0.01;
  const maxCrossings = opts.maxCrossings ?? 100_000;

  const crossings: number[] = [];
  let res = 0;
  // Direction: +1 = waiting for a rising crossing, −1 = waiting for a falling one.
  // The initial state comes from the first sample alone: a waveform that starts
  // exactly on the threshold (a sine at t = 0, the common case) would otherwise be
  // treated as "already crossed" and the first period of the record dropped.
  let armed: 1 | -1 = values[lo] <= threshold ? 1 : -1;
  // Hysteresis: after a crossing is counted, the trace must leave the band around
  // the threshold before another one in the same direction can count. Without it,
  // ringing or solver noise on an edge reads as several cycles and the frequency
  // comes out high. The first crossing is exempt — the record's own start is the
  // confirmation that the trace was on the low side.
  let confirmedLow = values[lo] <= threshold;
  let confirmedHigh = values[lo] >= threshold;
  // A record that starts exactly on the threshold and immediately rises (a sine
  // sampled from t = 0, the common case) has a crossing at its first sample that no
  // pair of samples can detect, because detection needs a sample *before* it. Without
  // this the first period of every such record is dropped and the period count is one
  // short.
  if (armed === 1 && values[lo] === threshold && hi > lo && values[lo + 1] > threshold) {
    crossings.push(times[lo]);
    armed = -1;
    confirmedLow = false;
  }
  for (let i = lo + 1; i <= hi && crossings.length < maxCrossings; i++) {
    const v0 = values[i - 1];
    const v1 = values[i];
    if (v1 <= threshold - hysteresis) confirmedLow = true;
    if (v1 >= threshold + hysteresis) confirmedHigh = true;
    if (armed === 1 && confirmedLow && v0 < threshold && v1 >= threshold) {
      const frac = v1 === v0 ? 0 : (threshold - v0) / (v1 - v0);
      const t = times[i - 1] + frac * (times[i] - times[i - 1]);
      crossings.push(t);
      res = Math.max(res, times[i] - times[i - 1]);
      armed = -1;
      confirmedLow = false;
    } else if (armed === -1 && confirmedHigh && v0 > threshold && v1 <= threshold) {
      armed = 1;
      confirmedHigh = false;
    }
  }
  const amplitude = span / 2;
  if (crossings.length < 2) {
    return {
      frequency: null, period: null, cycles: crossings.length > 0 ? 0.5 : 0, periodStdDev: 0,
      firstPeriod: null, lastPeriod: null, settled: false,
      amplitude, timingResolution: res, crossings,
      method: `hysteresis zero-crossing at ${threshold.toPrecision(4)} ${trace.unit} ± ${hysteresis.toPrecision(3)}`,
      accuracy: Accuracy.APPROXIMATED,
      note: `${crossings.length} rising crossing(s) in a ${formatSeconds(times[hi] - times[lo])} record: shorter than one period, so no frequency can be measured without extrapolating`,
    };
  }
  const periods: number[] = [];
  for (let i = 1; i < crossings.length; i++) periods.push(crossings[i] - crossings[i - 1]);
  // The mean period comes from the first and last crossing, not from averaging the
  // individual ones. Both are estimates of the same quantity, but a single misplaced
  // crossing — a startup transient on the first edge, ringing on one of them — is
  // divided by the number of periods here instead of by one, so a record of N periods
  // is N times more tolerant of a bad edge. The individual periods are still kept,
  // and their spread is reported as jitter.
  const meanPeriod = (crossings[crossings.length - 1] - crossings[0]) / periods.length;
  let variance = 0;
  for (const p of periods) variance += (p - meanPeriod) ** 2;
  const periodStdDev = Math.sqrt(variance / periods.length);
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];
  const drift = meanPeriod > 0 ? Math.abs(lastPeriod - firstPeriod) / meanPeriod : 0;
  const jitter = meanPeriod > 0 ? periodStdDev / meanPeriod : 0;
  const settled = drift <= 0.02 && jitter <= 0.01;
  return {
    frequency: meanPeriod > 0 ? 1 / meanPeriod : null,
    period: meanPeriod,
    cycles: periods.length,
    periodStdDev,
    firstPeriod,
    lastPeriod,
    settled,
    amplitude,
    timingResolution: res,
    crossings,
    method:
      `${periods.length} period(s) from rising hysteresis crossings of ${threshold.toPrecision(4)} ${trace.unit} ` +
      (over === 'all' ? '' : `over the ${typeof over === 'object' ? `window ${formatSeconds(over.t0)}…${formatSeconds(over.t1)}` : 'last period'} `) +
      `(band ±${hysteresis.toPrecision(3)}), each located by linear interpolation between samples; the mean period is ` +
      `(last crossing − first crossing) / ${periods.length}, so a single misplaced edge costs 1/${periods.length} of the error`,
    accuracy: Accuracy.APPROXIMATED,
    note:
      `the crossing time is interpolated inside a step of at most ${formatSeconds(res)}, so the period carries that uncertainty; ` +
      `period jitter σ = ${formatSeconds(periodStdDev)}` +
      (settled
        ? ''
        : `. NOT SETTLED: the first period (${formatSeconds(firstPeriod)}) differs from the last (${formatSeconds(lastPeriod)}) by ` +
          `${(drift * 100).toFixed(1)} %, so the record contains a transient — the frequency quoted is that of this record, ` +
          `which is not the source frequency until the transient has decayed. Measure over a longer record, or ignore the first periods.`),
  };
}

export interface EdgeResult {
  /** 10 %→90 % rise time, s; null if no rising edge was found. */
  riseTime: number | null;
  /** 90 %→10 % fall time, s. */
  fallTime: number | null;
  /** Propagation delay from the reference trace's 50 % point to this trace's, s. */
  delayFromReference: number | null;
  /** Overshoot beyond the final high level, in % of the swing. */
  overshootPercent: number | null;
  /** Undershoot below the low level, in % of the swing. */
  undershootPercent: number | null;
  /** The levels the thresholds were taken between. */
  lowLevel: number;
  highLevel: number;
  swing: number;
  edgesFound: number;
  method: string;
  accuracy: Accuracy;
  note: string;
}

/**
 * Rise/fall times between the 10 % and 90 % levels, and overshoot.
 *
 * The levels come from the record's own extremes, which is the right reference for
 * a logic waveform but only an approximation for a sine that never settles: the
 * note says which case applies. `reference` is an optional second trace (a clock,
 * typically) whose 50 % crossing defines t = 0 for the propagation delay.
 */
export function measureEdges(trace: Trace, reference?: Trace): EdgeResult {
  const { times, values } = trace;
  const n = values.length;
  const empty = (note: string, low = NaN, high = NaN): EdgeResult => ({
    riseTime: null, fallTime: null, delayFromReference: null, overshootPercent: null, undershootPercent: null,
    lowLevel: low, highLevel: high, swing: Number.isFinite(high) && Number.isFinite(low) ? high - low : NaN,
    edgesFound: 0, method: '10 %/90 % threshold crossing with linear interpolation', accuracy: Accuracy.APPROXIMATED, note,
  });
  if (n < 3) return empty(`only ${n} sample(s)`);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const swing = max - min;
  if (!(swing > 0)) return empty('the trace never changes level', min, max);
  const t10 = min + 0.1 * swing;
  const t50 = min + 0.5 * swing;
  const t90 = min + 0.9 * swing;

  const crossTime = (level: number, rising: boolean, from = 0): number | null => {
    for (let i = Math.max(1, from); i < n; i++) {
      const v0 = values[i - 1];
      const v1 = values[i];
      const hit = rising ? v0 < level && v1 >= level : v0 > level && v1 <= level;
      if (hit) {
        const frac = v1 === v0 ? 0 : (level - v0) / (v1 - v0);
        return times[i - 1] + frac * (times[i] - times[i - 1]);
      }
    }
    return null;
  };

  let riseTime: number | null = null;
  let fallTime: number | null = null;
  let edges = 0;
  let searchFrom = 0;
  while (edges < 64) {
    const a = crossTime(t10, true, searchFrom);
    if (a === null) break;
    const b = crossTime(t90, true, searchFrom);
    if (b !== null && b > a) {
      riseTime = riseTime === null ? b - a : Math.max(riseTime, b - a);
      edges++;
    }
    const c = crossTime(t90, false, searchFrom);
    if (c !== null) {
      const d = crossTime(t10, false, searchFrom);
      if (d !== null && d > c) {
        fallTime = fallTime === null ? d - c : Math.max(fallTime, d - c);
        edges++;
      }
    }
    // Advance past this region so the next pass finds the next edge.
    let next = searchFrom + 1;
    while (next < n && times[next] < (b ?? a)) next++;
    if (next <= searchFrom) break;
    searchFrom = next;
  }

  // Overshoot/undershoot relative to the levels the trace settles at.
  const settledHigh = values[n - 1];
  let over: number | null = null;
  let under: number | null = null;
  if (settledHigh > min + 0.5 * swing) {
    over = Math.max(0, ((max - settledHigh) / swing) * 100);
  } else {
    under = Math.max(0, ((settledHigh - min) / swing) * 100);
  }

  let delay: number | null = null;
  if (reference) {
    const r50 = crossTimeOf(reference, min + 0.5 * swing, true) ?? crossTimeOf(reference, min + 0.5 * swing, false);
    const s50 = crossTime(t50, true) ?? crossTime(t50, false);
    if (r50 !== null && s50 !== null) delay = s50 - r50;
  }
  return {
    riseTime,
    fallTime,
    delayFromReference: delay,
    overshootPercent: over,
    undershootPercent: under,
    lowLevel: min,
    highLevel: max,
    swing,
    edgesFound: edges,
    method: `10 %/90 % of the record's own ${min.toPrecision(4)}…${max.toPrecision(4)} ${trace.unit} swing, interpolated crossings`,
    accuracy: Accuracy.APPROXIMATED,
    note:
      `the levels are this record's extremes, not a settled logic high/low: for a waveform that never reaches its rails the ` +
      `10 %/90 % points are relative to what it did reach. ${edges} edge(s) found; the slowest is reported.` +
      (reference ? (delay === null ? ' The reference trace gave no 50 % crossing, so no delay is quoted.' : ` Delay is measured from the reference's 50 % crossing.`) : ''),
  };
}

function crossTimeOf(trace: Trace, level: number, rising: boolean): number | null {
  const { times, values } = trace;
  for (let i = 1; i < values.length; i++) {
    const v0 = values[i - 1];
    const v1 = values[i];
    const hit = rising ? v0 < level && v1 >= level : v0 > level && v1 <= level;
    if (hit) {
      const frac = v1 === v0 ? 0 : (level - v0) / (v1 - v0);
      return times[i - 1] + frac * (times[i] - times[i - 1]);
    }
  }
  return null;
}

export interface PhaseResult {
  /**
   * Phase of the second trace relative to the first, in degrees, in (−180, 180].
   *
   * The electrical convention: **negative means the second trace lags** (its peaks
   * come later). An RC low-pass therefore reads a negative angle, which is what a
   * bench instrument shows.
   */
  degrees: number | null;
  /** The same angle in radians. */
  radians: number | null;
  /**
   * Time shift in seconds, **positive when the second trace lags** — a delay.
   * `degrees = −360 · timeShift / period`, so the two fields carry opposite signs by
   * convention and both are stated wherever they are printed.
   */
  timeShift: number | null;
  /** The period the phase was referred to, s. */
  period: number;
  /** Which part of the record the comparison was made over. */
  windowStart: number;
  windowEnd: number;
  /** Normalised cross-correlation peak, 0…1: how well the two traces actually match. */
  correlation: number;
  method: string;
  accuracy: Accuracy;
  note: string;
}

export interface PhaseOptions {
  /**
   * Which part of the overlapping record to compare: the last whole period
   * (`'last'`, the default — steady state), the first (`'first'`), or an explicit
   * interval. A circuit switched on at t = 0 has a startup transient, and comparing
   * over it measures the transient rather than the transfer function.
   */
  over?: 'first' | 'last' | { t0: number; t1: number };
  /** Resampling grid for the correlation. 256 points ≈ 1.4° before interpolation. */
  points?: number;
}

/**
 * Phase between two traces, by cross-correlation over one period.
 *
 * Cross-correlation is used rather than comparing zero-crossing times because it does
 * not assume a sinusoid: it finds the shift that best superimposes the two records,
 * whatever their shape. The correlation peak is reported alongside, so a phase read
 * off two unrelated signals is visibly meaningless instead of quietly wrong.
 *
 * Both traces are resampled onto a common uniform grid first — a correlation over
 * adaptively spaced samples would weight the coarse intervals, and the two traces
 * would not even share an index for the same instant.
 */
export function measurePhase(a: Trace, b: Trace, opts: PhaseOptions = {}): PhaseResult {
  const none = (note: string, period = 0, correlation = 0, windowStart = 0, windowEnd = 0): PhaseResult => ({
    degrees: null, radians: null, timeShift: null, period, correlation, windowStart, windowEnd,
    method: 'normalised circular cross-correlation on a common uniform grid', accuracy: Accuracy.APPROXIMATED, note,
  });
  const t0 = Math.max(a.times[0] ?? 0, b.times[0] ?? 0);
  const t1 = Math.min(a.times[a.times.length - 1] ?? 0, b.times[b.times.length - 1] ?? 0);
  if (!(t1 > t0)) return none('the two traces do not overlap in time');
  const fa = measureFrequency(a);
  const fb = measureFrequency(b);
  const period = fa.period ?? fb.period ?? t1 - t0;
  if (!(period > 0)) return none('neither trace has a measurable period');
  if (t1 - t0 < period) {
    return none(`the overlap is ${formatSeconds(t1 - t0)}, shorter than one period (${formatSeconds(period)}): a phase shift would be ambiguous`, period);
  }
  const over = opts.over ?? 'last';
  let w0: number;
  let w1: number;
  if (typeof over === 'object') {
    w0 = Math.max(t0, over.t0);
    w1 = Math.min(t1, over.t1);
  } else if (over === 'first') {
    w0 = t0;
    w1 = t0 + period;
  } else {
    w1 = t1;
    w0 = t1 - period;
  }
  if (!(w1 > w0)) return none('the requested comparison window is empty', period, 0, w0, w1);

  // 256 points is enough to locate a correlation peak to ~1.4° and keeps the O(N²)
  // search cheap; `points` raises it when a finer angle is needed.
  const n = Math.max(16, opts.points ?? 256);
  const ga = resampleUniform(a, w0, w1, n);
  const gb = resampleUniform(b, w0, w1, n);
  // Remove the mean so the correlation measures shape, not offset: two traces with
  // different DC levels are otherwise correlated by that difference alone.
  const ma = meanOf(ga);
  const mb = meanOf(gb);
  const xa = new Float64Array(n);
  const xb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xa[i] = ga[i] - ma;
    xb[i] = gb[i] - mb;
  }
  const na = normOf(xa);
  const nb = normOf(xb);
  if (!(na > 0) || !(nb > 0)) return none('one of the traces is constant over the comparison window', period, 0, w0, w1);

  const corrAt = (lag: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += xa[i] * xb[(i + ((lag % n) + n) % n) % n];
    return s / (na * nb);
  };
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = 0; lag < n; lag++) {
    const c = corrAt(lag);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  // Parabolic interpolation around the peak for sub-sample lag accuracy.
  const y0 = corrAt(bestLag - 1);
  const y1 = best;
  const y2 = corrAt(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const frac = Math.abs(denom) > 1e-18 ? (0.5 * (y0 - y2)) / denom : 0;
  // A lag beyond half the record is a lead: the circular correlation cannot tell the
  // two apart, so the shorter way round is the physical one.
  let lagSamples = bestLag + Math.max(-0.5, Math.min(0.5, frac));
  if (lagSamples > n / 2) lagSamples -= n;
  const shift = (lagSamples / n) * (w1 - w0);
  const degrees = -((shift / (w1 - w0)) * 360);
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  return {
    degrees: wrapped,
    radians: (wrapped * Math.PI) / 180,
    timeShift: shift,
    period,
    windowStart: w0,
    windowEnd: w1,
    correlation: Math.max(-1, Math.min(1, best)),
    method:
      `circular cross-correlation of ${formatSeconds(w1 - w0)} (${typeof over === 'object' ? 'the requested window' : over === 'first' ? 'the first period' : 'the last period'} of the overlap) ` +
      `resampled to ${n} uniform points, means removed, peak refined by parabolic interpolation`,
    accuracy: Accuracy.APPROXIMATED,
    note:
      `degrees are φ(second) − φ(first): negative means the second trace lags. timeShift is the same fact as a delay, so it ` +
      `carries the opposite sign. The comparison window is one period because a circular correlation over a non-integer number ` +
      `of periods biases the peak; the correlation peak is ${best.toFixed(3)}, and below ~0.5 the two waveforms are not the same ` +
      `shape and the angle describes a shift that is not physically meaningful. Resolution is ${(360 / n).toFixed(2)}° before ` +
      `interpolation.` +
      (over === 'last' ? ' The last period was used so that a startup transient at the beginning of the record is not measured as a phase shift.' : ''),
  };
}

function meanOf(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return v.length ? s / v.length : 0;
}

function normOf(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** Duty cycle of a two-level waveform, from the time spent above the midpoint. */
export interface DutyResult {
  dutyPercent: number | null;
  highTime: number;
  lowTime: number;
  threshold: number;
  method: string;
  note: string;
}

export function measureDutyCycle(trace: Trace): DutyResult {
  const { times, values } = trace;
  const n = values.length;
  if (n < 2) return { dutyPercent: null, highTime: 0, lowTime: 0, threshold: NaN, method: 'time above the midpoint threshold', note: `${n} sample(s)` };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const threshold = min + (max - min) / 2;
  let high = 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0)) continue;
    total += dt;
    // Trapezoidal weighting of the fraction of the interval spent above threshold,
    // so a step that straddles the threshold contributes proportionally.
    const h0 = values[i - 1] > threshold ? 1 : 0;
    const h1 = values[i] > threshold ? 1 : 0;
    high += 0.5 * (h0 + h1) * dt;
  }
  if (!(total > 0)) return { dutyPercent: null, highTime: 0, lowTime: 0, threshold, method: 'time above the midpoint threshold', note: 'the record has zero duration' };
  return {
    dutyPercent: (high / total) * 100,
    highTime: high,
    lowTime: total - high,
    threshold,
    method: `time-weighted fraction above ${threshold.toPrecision(4)} ${trace.unit} (the midpoint of the record's own ${min.toPrecision(4)}…${max.toPrecision(4)} range)`,
    note: 'meaningful for a two-level waveform; for a sine it reads ~50 % by construction, not because of any symmetry measurement',
  };
}

/**
 * Resample a trace onto a uniform grid by linear interpolation.
 *
 * The FFT and the cross-correlation both require uniform sampling and the solver
 * does not produce it. Interpolation is exact at the samples and linear between
 * them, so it attenuates content near the coarsest step — which is why every
 * spectral reading reports the largest step in the record.
 */
export function resampleUniform(trace: Trace, t0: number, t1: number, count: number): Float64Array {
  const out = new Float64Array(Math.max(0, count));
  const { times, values } = trace;
  if (count <= 0 || times.length === 0) return out;
  if (times.length === 1) {
    out.fill(values[0]);
    return out;
  }
  let j = 0;
  const span = t1 - t0;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? t0 : t0 + (span * i) / (count - 1);
    while (j < times.length - 2 && times[j + 1] < t) j++;
    if (t <= times[0]) {
      out[i] = values[0];
    } else if (t >= times[times.length - 1]) {
      out[i] = values[values.length - 1];
    } else {
      const a = times[j];
      const b = times[j + 1];
      const frac = b === a ? 0 : (t - a) / (b - a);
      out[i] = values[j] + frac * (values[j + 1] - values[j]);
    }
  }
  return out;
}

export interface CursorResult {
  t1: number;
  t2: number;
  /** t2 − t1, s. */
  dt: number;
  /** 1/|dt|, Hz — the frequency the cursor pair implies. */
  frequency: number | null;
  /** Value at each cursor, interpolated. */
  v1: number;
  v2: number;
  dv: number;
  /** dv/dt, unit per second. */
  slope: number | null;
  unit: string;
  note: string;
}

/** Two time cursors on a trace, with the derived quantities an oscilloscope shows. */
export function measureCursors(trace: Trace, t1: number, t2: number): CursorResult {
  const a = Math.min(t1, t2);
  const b = Math.max(t1, t2);
  const v1 = valueAt(trace, a);
  const v2 = valueAt(trace, b);
  const dt = b - a;
  return {
    t1: a,
    t2: b,
    dt,
    frequency: dt > 0 ? 1 / dt : null,
    v1,
    v2,
    dv: v2 - v1,
    slope: dt > 0 ? (v2 - v1) / dt : null,
    unit: trace.unit,
    note: dt > 0 ? `both cursor values are linearly interpolated between samples` : 'the two cursors are at the same time',
  };
}

/** Interpolated value at a time, clamped to the record. */
export function valueAt(trace: Trace, t: number): number {
  const { times, values } = trace;
  const n = times.length;
  if (n === 0) return NaN;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const frac = times[hi] === times[lo] ? 0 : (t - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + frac * (values[hi] - values[lo]);
}

/** The sample rate a spectral reading should use for this trace (uniform-grid equivalent). */
export function effectiveSampleRate(trace: Trace, points: number): number {
  const duration = trace.times.length > 1 ? trace.times[trace.times.length - 1] - trace.times[0] : 0;
  if (!(duration > 0) || points < 2) return 0;
  return (points - 1) / duration;
}

// ---------------------------------------------------------------------------
// Formatting shared by every instrument readout
// ---------------------------------------------------------------------------

const TIME_UNITS: Array<[number, string]> = [
  [1, 's'], [1e3, 'ms'], [1e6, 'µs'], [1e9, 'ns'], [1e12, 'ps'],
];

/** Format a duration with an SI prefix. */
export function formatSeconds(t: number): string {
  if (!Number.isFinite(t)) return '—';
  if (t === 0) return '0 s';
  const abs = Math.abs(t);
  // Walk from seconds down to picoseconds and take the first prefix that brings the
  // value to at least 1. Walking the other way — which an earlier version did —
  // always matched picoseconds and printed "1500000.000 ps" for 1.5 µs.
  for (const [scale, suffix] of TIME_UNITS) {
    if (abs * scale >= 1) return `${(t * scale).toFixed(abs * scale >= 100 ? 1 : 3)} ${suffix}`;
  }
  return `${t.toExponential(3)} s`;
}

const FREQ_UNITS: Array<[number, string]> = [
  [1e-9, 'GHz'], [1e-6, 'MHz'], [1e-3, 'kHz'], [1, 'Hz'], [1e3, 'mHz'],
];

/** Format a frequency with an SI prefix. */
export function formatHz(f: number): string {
  if (!Number.isFinite(f)) return '—';
  if (f === 0) return '0 Hz';
  const abs = Math.abs(f);
  for (const [scale, suffix] of FREQ_UNITS) {
    if (abs >= 1 / scale) return `${(f * scale).toFixed(3)} ${suffix}`;
  }
  return `${f.toExponential(3)} Hz`;
}

/**
 * Format a reading with an SI prefix and a free-form unit string.
 *
 * Not the same function as `formatValue` in `util/units.ts`, which takes a typed
 * `UnitName`: an instrument reports whatever its channel happens to measure, and
 * that includes display units the typed table does not carry ('level' for a logic
 * channel, '°C' for a thermometer, 'var' for reactive power). Two formatters with
 * the same name in one barrel is how a caller silently gets the wrong one, so this
 * one is named for what it formats.
 */
export function formatReading(v: number, unit: string): string {
  if (!Number.isFinite(v)) return `— ${unit}`;
  if (v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  const prefixes: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  for (const [scale, p] of prefixes) {
    if (abs >= scale) return `${(v / scale).toFixed(4)} ${p}${unit}`;
  }
  return `${v.toExponential(3)} ${unit}`;
}
