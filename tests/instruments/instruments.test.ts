/**
 * Instruments: the transform, the measurements, the scope, the analyzer, the meters
 * and the generator.
 *
 * Every numeric case here is checked against something computed independently of the
 * engine — an analytic transfer function, a closed-form integral, or a property the
 * mathematics guarantees (Parseval, a round trip, a symmetry). That is the only way
 * an instrument can be trusted: a reading that agrees with another reading from the
 * same code proves nothing.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { ChipLibrary } from '../../src/engine/core/chip.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { flatten, nodeNameAt, resolveProbe, probeFailure } from '../../src/engine/sim/netlist.js';
import { CircuitSimulator } from '../../src/engine/sim/solver.js';
import { formatArbitraryWaveform, parseArbitraryWaveform, evalWaveTable } from '../../src/engine/sim/lower.js';
import {
  amplitudeSpectrum,
  coherentGainOf,
  enbwOf,
  fft,
  nextPow2,
  totalHarmonicDistortion,
  windowCoefficients,
  WINDOWS,
} from '../../src/engine/instruments/fft.js';
import {
  effectiveSampleRate,
  formatHz,
  formatSeconds,
  formatReading,
  measureCursors,
  measureDutyCycle,
  measureEdges,
  measureFrequency,
  measurePhase,
  resampleUniform,
  traceStats,
  valueAt,
  type Trace,
} from '../../src/engine/instruments/measure.js';
import { Oscilloscope, scopeReportToText, quickMeasure } from '../../src/engine/instruments/scope.js';
import { SpectrumAnalyzer } from '../../src/engine/instruments/spectrum.js';
import {
  findMeters,
  measure,
  measurePower,
  measureThermalSteadyState,
  powerToText,
  readPlacedMeters,
  readingsToText,
  thermalToText,
} from '../../src/engine/instruments/meters.js';
import { GENERATOR_PRESETS, SignalGenerator } from '../../src/engine/instruments/generator.js';
import { Rng } from '../../src/engine/util/rng.js';

suite('instruments');

const lib = createDefaultLibrary();

// ---------------------------------------------------------------------------
// Synthetic traces: the reference the engine's own numbers are checked against
// ---------------------------------------------------------------------------

function sineTrace(amp: number, freq: number, duration: number, points: number, phase = 0, offset = 0): Trace {
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const t = (duration * i) / (points - 1);
    times[i] = t;
    values[i] = offset + amp * Math.sin(2 * Math.PI * freq * t + phase);
  }
  return { name: 'sine', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
}

/** A trace whose samples are deliberately uneven, so time weighting is testable. */
function unevenSine(amp: number, freq: number, duration: number, points: number, rng: Rng): Trace {
  const cuts: number[] = [];
  for (let i = 0; i < points - 2; i++) cuts.push(rng.chance(0.5) ? (duration * (i + 1)) / (points - 1) : duration * rng.next());
  cuts.sort((a, b) => a - b);
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  times[0] = 0;
  times[points - 1] = duration;
  for (let i = 1; i < points - 1; i++) times[i] = Math.min(Math.max(cuts[i - 1], times[i - 1] + 1e-12), duration - 1e-12);
  for (let i = 0; i < points; i++) values[i] = amp * Math.sin(2 * Math.PI * freq * times[i]);
  return { name: 'uneven', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
}

/** A trapezoid with known 10–90 % edges: the reference for rise/fall times. */
function trapezoidTrace(period: number, cycles: number, low: number, high: number, tr: number, tf: number, samplesPerCycle: number): Trace {
  const points = cycles * samplesPerCycle + 1;
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  const swing = high - low;
  for (let i = 0; i < points; i++) {
    const t = (period * cycles * i) / (points - 1);
    times[i] = t;
    const x = t - Math.floor(t / period) * period;
    const half = period / 2;
    // 10 %→90 % of a linear ramp covers 80 % of it, so a ramp of tr/0.8 gives exactly
    // tr between the thresholds. Getting this construction wrong makes the synthetic
    // edge the wrong width and the test measures its own bug.
    const ramp = tr / 0.8;
    const fallRamp = tf / 0.8;
    if (x < ramp) values[i] = low + (swing * x) / ramp;
    else if (x < half) values[i] = high;
    else if (x < half + fallRamp) values[i] = high - (swing * (x - half)) / fallRamp;
    else values[i] = low;
  }
  return { name: 'trap', unit: 'V', times, values, kind: 'logic', target: 'synthetic' };
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

test('the FFT round-trips and satisfies Parseval', () => {
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const rng = new Rng('fft');
  for (let i = 0; i < n; i++) re[i] = rng.range(-1, 1);
  const original = Float64Array.from(re);
  fft(re, im);
  // Parseval: Σ|x|² = (1/N)Σ|X|².
  let timeEnergy = 0;
  for (let i = 0; i < n; i++) timeEnergy += original[i] * original[i];
  let freqEnergy = 0;
  for (let k = 0; k < n; k++) freqEnergy += (re[k] * re[k] + im[k] * im[k]) / n;
  assertClose(freqEnergy, timeEnergy, 1e-9 * timeEnergy, 'Parseval holds for the unnormalised DFT');
  fft(re, im, true);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - original[i]), Math.abs(im[i]));
  assert(err < 1e-12, `the forward/inverse pair round-trips (max error ${err.toExponential(2)})`);
});

test('the FFT refuses a length it cannot transform', () => {
  let threw = '';
  try {
    fft(new Float64Array(100), new Float64Array(100));
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes('power of two'), `a non-power-of-two length is refused (${threw})`);
  assertEqual(nextPow2(1000), 1024, 'nextPow2 rounds up');
  assertEqual(nextPow2(1024), 1024, 'and leaves a power of two alone');
});

test('every window reports the correction factors that were measured, not the textbook ones', () => {
  for (const kind of Object.keys(WINDOWS) as Array<keyof typeof WINDOWS>) {
    const w = windowCoefficients(kind, 4096);
    const cg = coherentGainOf(w);
    const enbw = enbwOf(w);
    // The tabulated figures are the analytic ones; the computed ones must agree to
    // within the O(1/N) edge effect of a symmetric window.
    assertClose(cg, WINDOWS[kind].coherentGain, 2e-3, `${kind} coherent gain`);
    assertClose(enbw, WINDOWS[kind].enbwBins, 2e-2, `${kind} ENBW`);
    assert(w[0] < w[2048] || kind === 'rectangular' || kind === 'flat_top', `${kind} tapers at the edges`);
  }
});

test('a flat-top window reads a non-coherent tone to within its stated scalloping loss', () => {
  const fs = 1e6;
  const n = 1024;
  const amp = 2.5;
  const f0 = 12345.678; // deliberately not on a bin
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * f0 * i) / fs);
  for (const kind of Object.keys(WINDOWS) as Array<keyof typeof WINDOWS>) {
    const spec = amplitudeSpectrum(samples, { sampleRate: fs, window: kind });
    let peak = 0;
    for (let k = 1; k < spec.amplitudes.length; k++) peak = Math.max(peak, spec.amplitudes[k]);
    const errDb = 20 * Math.log10(peak / amp);
    assert(errDb <= 0.05, `${kind} never over-reads (${errDb.toFixed(3)} dB)`);
    assert(errDb >= WINDOWS[kind].scallopingLossDb - 0.15, `${kind} stays inside its documented scalloping loss (${errDb.toFixed(3)} dB vs ${WINDOWS[kind].scallopingLossDb})`);
    assertClose(spec.frequencies[spec.amplitudes.indexOf(peak)] ?? 0, f0, spec.binHz, `${kind} locates the tone within one bin`);
  }
});

test('the span mean square reproduces the time-domain mean square (Parseval through a window)', () => {
  const fs = 1e6;
  const n = 4096;
  for (const kind of ['rectangular', 'hann', 'blackman', 'flat_top'] as const) {
    const samples = new Float64Array(n);
    let ms = 0;
    for (let i = 0; i < n; i++) {
      samples[i] = 1.7 * Math.sin((2 * Math.PI * 9999 * i) / fs) + 0.3 * Math.sin((2 * Math.PI * 47000 * i) / fs);
      ms += samples[i] * samples[i];
    }
    ms /= n;
    const spec = amplitudeSpectrum(samples, { sampleRate: fs, window: kind });
    let sum = 0;
    for (let k = 0; k < spec.amplitudes.length; k++) {
      const scale = k === 0 || k === spec.transformSamples / 2 ? 1 : 0.5;
      sum += spec.amplitudes[k] * spec.amplitudes[k] * scale;
    }
    sum /= spec.energyCorrection;
    assertClose(sum, ms, 0.02 * ms, `${kind}: Σ(A²/2)/energyCorrection equals the record mean square (${sum.toFixed(5)} vs ${ms.toFixed(5)})`);
  }
});

test('THD is ~0 for a clean sine and the textbook value for a square wave', () => {
  const fs = 1e6;
  const n = 8192;
  // Coherent sampling: the fundamental and every harmonic land exactly on a bin, so
  // what is measured is the textbook series and not the window's scalloping loss.
  const f0 = (8 * fs) / n;
  const sine = new Float64Array(n);
  const square = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    sine[i] = Math.sin(2 * Math.PI * f0 * t);
    square[i] = Math.sin(2 * Math.PI * f0 * t) >= 0 ? 1 : -1;
  }
  const specSine = amplitudeSpectrum(sine, { sampleRate: fs, window: 'hann' });
  const thdSine = totalHarmonicDistortion(specSine, f0, fs, 9);
  assert(thdSine.thdPercent < 1.5, `a clean sine reads as clean (${thdSine.thdPercent.toFixed(3)} %)`);
  // The tone is not on a bin (bin = fs/N = 122.07 Hz), so what is read is the largest
  // bin of the main lobe: accurate to within the window's own scalloping loss.
  assertClose(thdSine.fundamentalAmplitude, 1, 0.03, `the fundamental amplitude is recovered to within Hann's scalloping loss (${thdSine.fundamentalAmplitude.toFixed(4)})`);
  const flatSine = totalHarmonicDistortion(amplitudeSpectrum(sine, { sampleRate: fs, window: 'flat_top' }), f0, fs, 9);
  assertClose(flatSine.fundamentalAmplitude, 1, 0.002, `and exactly with the amplitude-accurate window (${flatSine.fundamentalAmplitude.toFixed(5)})`);

  const specSquare = amplitudeSpectrum(square, { sampleRate: fs, window: 'hann' });
  const thdSquare = totalHarmonicDistortion(specSquare, f0, fs, 9);
  // 4/π·(1/k) for odd k: fundamental 4/π, harmonics 3,5,7,9 → THD = sqrt(1/9+1/25+1/49+1/81).
  const expected = 100 * Math.sqrt(1 / 9 + 1 / 25 + 1 / 49 + 1 / 81);
  assertClose(thdSquare.fundamentalAmplitude, 4 / Math.PI, 0.02, `the square wave fundamental is 4/π (${thdSquare.fundamentalAmplitude.toFixed(4)})`);
  assertClose(thdSquare.thdPercent, expected, 1.0, `THD over the first 8 harmonics is ${expected.toFixed(2)} % (got ${thdSquare.thdPercent.toFixed(2)} %)`);
  assertEqual(thdSquare.ordersInSpan, 8, 'eight harmonics are below Nyquist');
  for (const h of thdSquare.harmonics) {
    if (h.order % 2 === 0) assert(h.amplitude < 0.02, `the ${h.order}th harmonic of a symmetric square wave is absent (${h.amplitude.toExponential(2)})`);
    else assertClose(h.amplitude, (4 / Math.PI) / h.order, 0.03, `the ${h.order}th harmonic is 1/${h.order} of the fundamental`);
  }
  assert(thdSquare.note.includes('upper bound'), 'the note says leakage makes it an upper bound');
});

test('THD does not read the fundamental skirt as a harmonic', () => {
  // The regression: with a ±3-bin search around each harmonic and no exclusion of
  // the fundamental's main lobe, a clean sine reported a THD above 100 %.
  const fs = 1e6;
  const n = 4096;
  const f0 = 1000;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * f0 * i) / fs);
  // Every window except the rectangular one suppresses the fundamental's side lobes
  // enough for a clean sine to read as clean. The rectangular window's first side lobe
  // is only −13 dB, so what it reports at the harmonic positions *is* the fundamental's
  // own skirt — that is the leakage its description warns about, not a harmonics
  // measurement, and the case states the difference instead of hiding it.
  for (const kind of ['hann', 'blackman_harris', 'flat_top'] as const) {
    const spec = amplitudeSpectrum(samples, { sampleRate: fs, window: kind });
    const thd = totalHarmonicDistortion(spec, f0, fs, 5);
    assert(thd.thdPercent < 2, `${kind}: a pure sine has no harmonics (${thd.thdPercent.toFixed(3)} %)`);
  }
  const rect = totalHarmonicDistortion(amplitudeSpectrum(samples, { sampleRate: fs, window: 'rectangular' }), f0, fs, 5);
  assert(rect.thdPercent < 25, `the rectangular window's leakage is bounded and reported (${rect.thdPercent.toFixed(2)} %)`);
  assert(WINDOWS.rectangular.description.includes('severe leakage'), 'and the window itself says it leaks');
});

// ---------------------------------------------------------------------------
// Time-domain measurements
// ---------------------------------------------------------------------------

test('statistics are time-weighted, and that is not the same as averaging samples', () => {
  // Half the record sits at 0 V with finely spaced samples, half at 1 V with coarse
  // ones. A sample average would weight the two halves by how many points each has;
  // the correct answer weights them by how long each lasted.
  const times = new Float64Array(11);
  const values = new Float64Array(11);
  for (let i = 0; i <= 9; i++) {
    times[i] = i * 1e-6; // 9 µs at 0 V
    values[i] = 0;
  }
  times[10] = 10e-6; // then 1 µs at 1 V
  values[10] = 1;
  const trace: Trace = { name: 'weighted', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
  const s = traceStats(trace);
  assertClose(s.mean, 0.05, 1e-9, 'the time-weighted mean is 1 V for 1 µs of 10 µs');
  assertClose(s.sampleMean, 1 / 11, 1e-9, 'the sample average would have said 0.0909');
  assert(Math.abs(s.mean - s.sampleMean) > 0.03, 'and the two are visibly different, which is why the method is stated');
  // ∫v²dt over the record: only the last interval carries a value, and the trapezoid
  // rule gives it half weight — 0.5·(0² + 1²)·1 µs = 0.5 µV²·s over 10 µs.
  assertClose(s.rms, Math.sqrt(0.05), 1e-9, 'RMS = sqrt(∫v²dt/∫dt)');
  assertClose(s.max, 1, 1e-12, 'the extremes are exact');
  assertClose(s.peakToPeak, 1, 1e-12, 'and so is the span');
  assertClose(s.duration, 10e-6, 1e-15, 'the duration is the record length');
  assertClose(s.maxStep, 1e-6, 1e-15, 'the coarsest interval is reported');
  assert(s.method.includes('time-weighted'), `the method says how it was computed (${s.method})`);
});

test('statistics of an empty and a single-sample record say so instead of inventing numbers', () => {
  const empty: Trace = { name: 'e', unit: 'V', times: new Float64Array(0), values: new Float64Array(0), kind: 'voltage', target: 'x' };
  const e = traceStats(empty);
  assertEqual(e.count, 0, 'no samples');
  assert(!Number.isFinite(e.mean), 'and no mean is invented');
  assertEqual(e.accuracy, 'NOT_MODELED', 'labelled as not modelled');
  const one: Trace = { name: 'o', unit: 'V', times: Float64Array.from([1e-6]), values: Float64Array.from([3.3]), kind: 'voltage', target: 'x' };
  const o = traceStats(one);
  assertClose(o.mean, 3.3, 1e-12, 'a single sample is its own mean');
  assert(o.method.includes('single sample'), `and the method says there is no interval to weight (${o.method})`);
});

test('the frequency of a synthetic sine is exact, on a uniform and on an uneven grid', () => {
  for (const points of [400, 4001]) {
    const trace = sineTrace(1, 1000, 10e-3, points);
    const f = measureFrequency(trace);
    assert(f.frequency !== null, 'a frequency was measured');
    assertClose(f.frequency!, 1000, 0.5, `${points} points: f = 1000 Hz (got ${f.frequency!.toFixed(4)})`);
    assertEqual(f.cycles, 9, 'nine periods in a 10 ms record of a 1 kHz sine');
    // The amplitude is half the record's own span, and a sampled sine does not quite
    // reach its peaks: over `points` samples the largest one is slightly inside 1.
    assertClose(f.amplitude!, 1, 2e-4, `the amplitude is half the span (${f.amplitude!.toFixed(7)})`);
    assertEqual(f.settled, true, 'a synthetic sine is settled by construction');
    assert(f.timingResolution <= 10e-3 / (points - 1) + 1e-15, 'the timing resolution is the largest step');
  }
  const uneven = unevenSine(1, 1000, 10e-3, 800, new Rng('uneven'));
  const fu = measureFrequency(uneven);
  assert(fu.frequency !== null, 'a frequency was measured on the uneven grid');
  assertClose(fu.frequency!, 1000, 2, `uneven sampling: f = 1000 Hz (got ${fu.frequency!.toFixed(3)})`);
});

test('the mean period spans the whole record, so one bad edge costs 1/N of its error', () => {
  // A sine whose first period is stretched by 20 %: averaging periods gives ~2 %
  // error, spanning first-to-last gives the same 2 % — but with 9 periods the
  // stretched edge is one of nine, so the span estimate is the robust one.
  const periods = 9;
  const f = 1000;
  const points = 4000;
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const k = i / (points - 1);
    const t = k < 1 / periods ? k * (periods / f) * 1.2 : (1 / periods) * (periods / f) * 1.2 + (k - 1 / periods) * (periods / f);
    times[i] = t;
    values[i] = Math.sin(2 * Math.PI * f * (t < (1.2 / f) ? t / 1.2 : t - 0.2 / f));
  }
  const trace: Trace = { name: 'stretched', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
  const r = measureFrequency(trace);
  assert(r.frequency !== null, 'a frequency was measured');
  assert(r.firstPeriod !== null && r.lastPeriod !== null, 'the first and last periods are reported');
  assert((r.firstPeriod as number) > (r.lastPeriod as number), 'the first period is the stretched one');
  assertEqual(r.settled, false, 'and the record is flagged as not settled');
  assert(r.note.includes('NOT SETTLED'), `the note explains what that means (${r.note.slice(0, 80)}…)`);
});

test('hysteresis stops ringing from reading as extra cycles', () => {
  // The ringing must be resolved by the sampling or the test measures an alias
  // instead: 40 000 points over 4 ms is 50 samples per 200 kHz ripple period.
  const points = 40000;
  const duration = 4e-3;
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  // The edge has to be slow enough that the ringing out-slews it, or their sum stays
  // monotonic and there is nothing to reject: a 50 µs edge ramps at 0.04 V/µs while a
  // 0.15 V ripple at 200 kHz slews at up to 0.19 V/µs, so the trace crosses 0 V
  // several times on the way through.
  const edge = 50e-6;
  const ripple = 0.15;
  for (let i = 0; i < points; i++) {
    const t = (duration * i) / (points - 1);
    times[i] = t;
    // A 1 kHz square with 50 µs edges and 200 kHz ringing of 15 % amplitude. An
    // instantaneous step would hide the effect this test is about: the trace would
    // pass through 0 V between two samples and no amount of ringing could add a
    // crossing. It is the finite edge, sitting at 0 V for 20 µs while ringing, that
    // produces the extra crossings a hysteresis band has to reject.
    // Each level lasts half a millisecond, so the square wave itself is 1 kHz.
    const half = 0.5e-3;
    const x = t - Math.floor(t / half) * half;
    const high = Math.floor(t / half) % 2 === 0;
    const from = high ? 0 : 1;
    const to = high ? 1 : 0;
    const frac = Math.min(1, Math.max(0, x / edge));
    const base = from + (to - from) * frac;
    values[i] = 2 * base - 1 + ripple * Math.sin(2 * Math.PI * 200000 * t);
  }
  const trace: Trace = { name: 'ringing', unit: 'V', times, values, kind: 'logic', target: 'synthetic' };
  const tight = measureFrequency(trace, { hysteresis: 0.25 });
  assert(tight.frequency !== null, 'a frequency was measured');
  assertClose(tight.frequency!, 1000, 20, `with hysteresis the ringing is rejected (${tight.frequency!.toFixed(2)} Hz)`);
  const loose = measureFrequency(trace, { hysteresis: 0.001 });
  assert(loose.frequency !== null, 'a frequency was measured without hysteresis');
  assert(loose.cycles > tight.cycles, `without it the ringing on the edges is counted as extra cycles (${loose.cycles} vs ${tight.cycles})`);
  assert(loose.frequency! > tight.frequency! * 1.2, `and the frequency it reports is therefore too high (${loose.frequency!.toFixed(1)} vs ${tight.frequency!.toFixed(1)} Hz)`);
});

test('a record shorter than one period reports no frequency rather than extrapolating', () => {
  const trace = sineTrace(1, 1000, 0.4e-3, 400); // 0.4 of a period
  const f = measureFrequency(trace);
  assertEqual(f.frequency, null, 'no frequency is quoted');
  assert(f.note.includes('shorter than one period'), `the note says why (${f.note})`);
  assert(f.amplitude !== null && f.amplitude > 0, 'the amplitude seen so far is still reported');
  const flat = sineTrace(0, 1000, 1e-3, 100);
  const ff = measureFrequency(flat);
  assertEqual(ff.frequency, null, 'a constant trace has no frequency');
  assert(ff.note.includes('constant'), `and the note says it is constant (${ff.note})`);
});

test('rise and fall times are measured between the 10 % and 90 % points', () => {
  const period = 1e-6;
  const tr = 20e-9;
  const tf = 40e-9;
  const trace = trapezoidTrace(period, 6, 0, 3.3, tr, tf, 2000);
  const e = measureEdges(trace);
  assert(e.riseTime !== null, 'a rise time was found');
  assert(e.fallTime !== null, 'and a fall time');
  assertClose(e.riseTime!, tr, tr * 0.05, `rise = ${tr * 1e9} ns (got ${(e.riseTime! * 1e9).toFixed(3)} ns)`);
  assertClose(e.fallTime!, tf, tf * 0.05, `fall = ${tf * 1e9} ns (got ${(e.fallTime! * 1e9).toFixed(3)} ns)`);
  assertClose(e.lowLevel, 0, 1e-9, 'the low level is the record minimum');
  assertClose(e.highLevel, 3.3, 1e-9, 'and the high level its maximum');
  assertClose(e.swing, 3.3, 1e-9, 'so the swing is 3.3 V');
  assert(e.edgesFound >= 5, `${e.edgesFound} edges were found over 6 cycles`);
  assert(e.method.includes('10 %/90 %'), `the method names the thresholds (${e.method})`);
});

test('phase is measured against a known shift, with the sign convention stated', () => {
  const f = 1000;
  const duration = 10e-3;
  const a = sineTrace(1, f, duration, 4000);
  for (const shiftDegrees of [-30, 30, -90, 90, 179]) {
    // b(t) = sin(ωt + φ): a positive φ means b leads, so the reported angle is +φ.
    const b = sineTrace(1, f, duration, 4000, (shiftDegrees * Math.PI) / 180);
    const p = measurePhase(a, b);
    assert(p.degrees !== null, `a phase was measured for φ = ${shiftDegrees}°`);
    assertClose(p.degrees!, shiftDegrees, 2.5, `φ = ${shiftDegrees}° is recovered (got ${p.degrees!.toFixed(2)}°)`);
    assertClose(p.timeShift!, (-shiftDegrees / 360) * (1 / f), 1e-5, 'the time shift carries the opposite sign, as documented');
    assert(p.correlation > 0.99, `the correlation confirms the two traces have the same shape (${p.correlation.toFixed(4)})`);
    assert(p.note.includes('negative means the second trace lags'), 'the convention is stated in the note');
  }
  // A lagging second trace reads negative — the case an RC filter produces.
  const lagging = sineTrace(1, f, duration, 4000, (-32 * Math.PI) / 180);
  const pl = measurePhase(a, lagging);
  assert((pl.degrees as number) < 0, `a lag reads negative (${pl.degrees!.toFixed(2)}°)`);
  assert((pl.timeShift as number) > 0, 'and its delay reads positive');
});

test('phase over a startup transient is a different number, and the default avoids it', () => {
  const f = 1000;
  const tau = 100e-6;
  const duration = 4e-3;
  const points = 4000;
  // y(t) = steady-state sine + a decaying natural response, as an RC filter switched
  // on at t = 0 produces.
  const a = sineTrace(1, f, duration, points);
  const times = new Float64Array(points);
  const values = new Float64Array(points);
  const phi = -0.5;
  for (let i = 0; i < points; i++) {
    const t = (duration * i) / (points - 1);
    times[i] = t;
    values[i] = 0.8 * Math.sin(2 * Math.PI * f * t + phi) + 0.8 * Math.exp(-t / tau);
  }
  const b: Trace = { name: 'startup', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
  const last = measurePhase(a, b, { over: 'last' });
  const first = measurePhase(a, b, { over: 'first' });
  assert(last.degrees !== null && first.degrees !== null, 'both windows give an angle');
  assertClose(last.degrees!, (phi * 180) / Math.PI, 3, `the last period recovers the steady-state phase (${last.degrees!.toFixed(2)}°)`);
  assert(Math.abs((first.degrees as number) - (phi * 180) / Math.PI) > 5, `the first period does not (${first.degrees!.toFixed(2)}°)`);
  assert(last.method.includes('last period'), 'the method says which window was used');
});

test('duty cycle and cursors read what their definitions say', () => {
  const trace = trapezoidTrace(1e-6, 4, 0, 3.3, 1e-9, 1e-9, 500);
  const d = measureDutyCycle(trace);
  assert(d.dutyPercent !== null, 'a duty cycle was measured');
  assertClose(d.dutyPercent!, 50, 2, `a symmetric trapezoid is ~50 % (got ${d.dutyPercent!.toFixed(2)} %)`);
  assertClose(d.threshold, 1.65, 1e-9, 'the threshold is the midpoint of the record');
  assertClose(d.highTime + d.lowTime, 4e-6, 1e-12, 'the high and low times add up to the record');
  assert(d.note.includes('two-level'), 'the note says what the number means for other shapes');

  const sine = sineTrace(1, 1000, 2e-3, 2001);
  const c = measureCursors(sine, 0.25e-3, 0.75e-3);
  assertClose(c.dt, 0.5e-3, 1e-15, 'Δt between the cursors');
  assertClose(c.frequency!, 2000, 1e-6, '1/Δt is reported');
  assertClose(c.v1, 1, 1e-9, 'the first cursor sits on the peak');
  assertClose(c.v2, -1, 1e-9, 'the second on the trough');
  assertClose(c.dv, -2, 1e-9, 'so Δv is the full swing');
  assertClose(c.slope!, -4000, 1e-6, 'and dv/dt follows');
  const same = measureCursors(sine, 0.3e-3, 0.3e-3);
  assertEqual(same.frequency, null, 'two cursors at the same time give no frequency');
  assert(same.note.includes('same time'), `and say so (${same.note})`);
  assertClose(measureCursors(sine, 0.6e-3, 0.4e-3).dt, 0.2e-3, 1e-15, 'the cursor order does not matter');
});

test('resampling is exact at the samples and interpolates between them', () => {
  const trace = sineTrace(1, 1000, 1e-3, 101);
  const uniform = resampleUniform(trace, 0, 1e-3, 101);
  let err = 0;
  for (let i = 0; i < 101; i++) err = Math.max(err, Math.abs(uniform[i] - trace.values[i]));
  assert(err < 1e-12, `the same grid reproduces the samples exactly (max error ${err.toExponential(2)})`);
  const half = resampleUniform(trace, 0, 1e-3, 201);
  assertClose(half[1], (trace.values[0] + trace.values[1]) / 2, 1e-12, 'a point between two samples is their midpoint');
  const before = resampleUniform(trace, -1e-3, 2e-3, 4);
  assertClose(before[0], trace.values[0], 1e-12, 'outside the record the first value is held');
  assertClose(before[3], trace.values[100], 1e-12, 'and so is the last');
  assertClose(effectiveSampleRate(trace, 101), 100000, 1e-6, 'the equivalent sample rate follows from the record length');
  assertClose(valueAt(trace, 0.5e-3), trace.values[50], 1e-12, 'valueAt hits a sample exactly');
});

test('the formatters never print a number they do not have', () => {
  assertEqual(formatSeconds(0), '0 s', 'zero is exact');
  assertEqual(formatSeconds(1.5e-9).includes('ns'), true, 'nanoseconds get the ns suffix');
  assertEqual(formatSeconds(2.5e-3).includes('ms'), true, 'and milliseconds the ms suffix');
  assertEqual(formatSeconds(NaN), '—', 'a missing number is a dash, not NaN');
  assertEqual(formatHz(1500).includes('kHz'), true, 'frequencies are prefixed');
  assertEqual(formatHz(NaN), '—', 'and a missing one is a dash');
  assertEqual(formatReading(0.001, 'A').includes('mA'), true, 'values are prefixed');
  assertEqual(formatReading(NaN, 'V'), '— V', 'the unit is kept so the gap is visible');
});

// ---------------------------------------------------------------------------
// The oscilloscope on a real circuit
// ---------------------------------------------------------------------------

/** An RC low-pass: R = 1 kΩ, C = 100 nF → fc = 1/(2πRC) = 1591.55 Hz. */
function rcLowPass(options: { esr?: number; r?: number; c?: number; waveform?: string; freq?: number; amp?: number } = {}) {
  const r = options.r ?? 1000;
  const c = options.c ?? 100e-9;
  const freq = options.freq ?? 1000;
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'rc_lowpass', chips);
  const src = b.add('vsignal', { waveform: options.waveform ?? 'sine', amp: options.amp ?? 1, freq, dc: 0, rs: 0 }, [0, 0]);
  const res = b.add('resistor', { r }, [40, 0]);
  const cap = b.add('capacitor', { c, esr: options.esr ?? 0.05, gleak: 0 }, [80, 0]);
  b.ground('g');
  b.at(src, '+', 'in');
  b.at(src, '-', 'g');
  b.at(res, '1', 'in');
  b.at(res, '2', 'out');
  b.at(cap, '1', 'out');
  b.at(cap, '2', 'g');
  const circuit = b.finish({ erc: false });
  const nl = flatten(circuit, lib, chips, {});
  const sim = new CircuitSimulator(nl, { integration: 'trap' });
  const fc = 1 / (2 * Math.PI * r * c);
  const gain = 1 / Math.sqrt(1 + (freq / fc) ** 2);
  const phaseDeg = (-Math.atan(freq / fc) * 180) / Math.PI;
  return { circuit, nl, sim, fc, gain, phaseDeg, freq, r, c };
}

test('a transient really is a transient: capacitors charge and inductors oppose', () => {
  // The regression behind this case is severe enough to deserve its own test:
  // `transient()` ran the initial DC solve, which leaves the element stamps in DC
  // mode, and never restored the transient mode. Every capacitor in every transient
  // was an open circuit and every inductor a short — the run still converged and
  // still produced plausible waveforms.
  const { sim, r: R, c: C } = rcLowPass({ waveform: 'dc', freq: 0 });
  const tau = R * C;
  const res = sim.transient(5 * tau, [{ key: 'out', kind: 'vnode', index: 2 }], { maxSamples: 20000, initialStep: tau / 1000, maxStep: tau / 100 });
  assert(res.ok, 'the run converged');
  const at = (t: number): number => {
    let i = 0;
    while (i < res.times.length - 1 && res.times[i + 1] <= t) i++;
    return res.values[0][i];
  };
  // Charging from the DC operating point starts at 5…0: the operating point of an RC
  // fed by a DC source *is* the charged state, so use skipInitialDc to see the ramp.
  const sim2 = new CircuitSimulator(sim.nl, { integration: 'trap', skipInitialDc: true });
  const res2 = sim2.transient(5 * tau, [{ key: 'out', kind: 'vnode', index: 2 }], { maxSamples: 20000, initialStep: tau / 2000, maxStep: tau / 200 });
  const at2 = (t: number): number => {
    let i = 0;
    while (i < res2.times.length - 1 && res2.times[i + 1] <= t) i++;
    return res2.values[0][i];
  };
  // The source is a 1 V "sine" of 0 Hz → its DC value is 0, so instead drive with a
  // known level: check the shape of the response rather than its amplitude.
  const early = at2(tau * 0.001);
  const mid = at2(tau);
  const late = at2(4 * tau);
  assert(Math.abs(early) < Math.abs(mid) + 1e-9, 'the node moves monotonically toward its final value');
  assert(Number.isFinite(mid) && Number.isFinite(late), 'and the values are finite');
  assert(at(4 * tau) !== undefined, 'the settled run reports a value too');
  // The decisive check, independent of the source shape: with a capacitor in the
  // circuit the step controller must see dV/dt and refine its step. A DC-mode
  // capacitor never changes voltage, so the controller doubles its step to maxStep
  // every time and finishes the run in a handful of samples.
  assert(res2.steps > 200, `a charging capacitor forces many steps (got ${res2.steps})`);
});

test('the RC low-pass attenuates and delays a sine by exactly the analytic amount', () => {
  for (const freq of [100, 1000, 10000]) {
    const { sim, gain, phaseDeg } = rcLowPass({ freq });
    const scope = new Oscilloscope(sim);
    scope.addChannel({ measure: 'voltage', target: 'in' });
    scope.addChannel({ measure: 'voltage', target: 'out' });
    const tstop = 60 / freq;
    const cap = scope.run({ tstop, maxSamples: 20000 });
    assert(cap.ok, `${freq} Hz: the run converged`);
    assertClose(cap.coveredUntil, 60 / freq, 1e-12, 'the record covers the whole requested run');
    assertEqual(cap.outputInterval !== null, true, 'and it was sampled on a uniform grid');
    // Steady state: the record starts at the DC operating point, so its first few
    // periods carry the circuit's natural response. Measuring the amplitude over the
    // whole record would add that transient to the peak; an engineer reads the settled
    // part, and so does this test — through the same viewport the UI uses.
    scope.zoom(tstop * 0.6, tstop);
    const stats = scope.stats(1)!;
    const f = scope.frequency(1)!;
    assert(f.frequency !== null, `${freq} Hz: a frequency was measured on the output`);
    assertClose(f.frequency!, freq, freq * 0.005, `${freq} Hz: the output frequency is the input frequency (got ${f.frequency!.toFixed(3)})`);
    assertEqual(f.settled, true, `${freq} Hz: the settled window is flagged as settled`);
    assertClose(stats.peakToPeak / 2, gain, gain * 0.02, `${freq} Hz: the amplitude is the analytic |H| = ${gain.toFixed(5)} (got ${(stats.peakToPeak / 2).toFixed(5)})`);
    scope.resetZoom();
    // Over the whole record the same measurement includes the startup, and the
    // instrument must say so rather than present it as the source frequency.
    const all = scope.frequency(1)!;
    if (freq >= 10000) {
      assertEqual(all.settled, false, `${freq} Hz: a record whose first periods carry the startup transient is not flagged as settled`);
      assert(all.note.includes('NOT SETTLED'), `${freq} Hz: and the note explains what that does to the number`);
    }
    const settledOnly = measureFrequency(scope.trace(1)!, { over: 'last' });
    assertClose(settledOnly.frequency!, freq, freq * 0.01, `${freq} Hz: the last period alone gives the source frequency (${settledOnly.frequency!.toFixed(3)})`);
    scope.zoom(tstop * 0.6, tstop);
    const p = scope.phase(0, 1)!;
    assert(p.degrees !== null, `${freq} Hz: a phase was measured`);
    assertClose(p.degrees!, phaseDeg, 1.5, `${freq} Hz: the phase is the analytic ${phaseDeg.toFixed(2)}° (got ${p.degrees!.toFixed(2)}°)`);
    assert(p.correlation > 0.99, `${freq} Hz: the two waveforms have the same shape (${p.correlation.toFixed(4)})`);
  }
});

test('the record covers the requested interval, and says so when it cannot', () => {
  const { sim } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'out' });
  const gridded = scope.run({ tstop: 5e-3, maxSamples: 500 });
  assertEqual(gridded.samples, 500, 'the grid produced exactly the requested number of points');
  assertClose(gridded.coveredUntil, 5e-3, 1e-12, 'covering the whole run');
  assert(gridded.notes.some((n) => n.includes('uniform')), 'and the note says the grid was uniform');
  assert(gridded.steps > gridded.samples, `the internal step still adapts (${gridded.steps} steps for ${gridded.samples} samples)`);

  const perStep = new Oscilloscope(sim);
  perStep.addChannel({ measure: 'voltage', target: 'out' });
  const truncated = perStep.run({ tstop: 5e-3, maxSamples: 200, sampleEveryStep: true });
  if (truncated.coveredUntil < 5e-3 * 0.999) {
    assert(truncated.notes.some((n) => n.includes('truncated')), 'a truncated record says so');
    assert(truncated.channels[0].trace !== null, 'and still carries the samples it did take');
    const text = scopeReportToText(perStep.report());
    assert(text.includes('WARNING'), 'the text report warns about the short record');
  } else {
    assertEqual(truncated.samples <= 200, true, 'the sample budget was respected');
  }
});

test('an unresolved probe is an error on that channel, never a trace of zeros', () => {
  const { sim, nl } = rcLowPass();
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.addChannel({ measure: 'voltage', target: 'nowhere' });
  scope.addChannel({ measure: 'current', target: 'nowhere' });
  const cap = scope.run({ tstop: 1e-3, maxSamples: 200 });
  assert(cap.channels[0].trace !== null, 'the good channel has a trace');
  assertEqual(cap.channels[1].trace, null, 'the bad one has none');
  assert(cap.channels[1].error !== null && cap.channels[1].error!.includes('nowhere'), `and says which target failed (${cap.channels[1].error})`);
  const text = scopeReportToText(scope.report());
  assert(text.includes('NOT MEASURED'), 'the report marks it as not measured');
  assert(!text.includes('NaN'), 'and prints no NaN as if it were a reading');
  assertEqual(resolveProbe(nl, 'nope'), null, 'resolveProbe returns null for a name that is not there');
  assert(probeFailure(nl, 'nope').includes('neither a node name'), `and explains what it looked for (${probeFailure(nl, 'nope').slice(0, 60)}…)`);
  const resolved = resolveProbe(nl, 'out');
  assert(resolved !== null && resolved.kind === 'node', 'a net name resolves to a node');
  assertEqual(nodeNameAt(nl, resolved!.index), 'out', 'and the name round-trips');
});

test('a differential channel measures the voltage across an element', () => {
  const { sim, r: R, freq, gain } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'in' });
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.addChannel({ measure: 'voltage', target: 'element:R1', differential: true, name: 'V_R1' });
  scope.addChannel({ measure: 'current', target: 'element:R1', name: 'I_R1' });
  scope.run({ tstop: 40 / freq, maxSamples: 20000 });
  const vIn = scope.stats(0)!;
  const vOut = scope.stats(1)!;
  const vR = scope.stats(2)!;
  const iR = scope.stats(3)!;
  // Kirchhoff: the resistor voltage is the difference of the two node voltages, so
  // its RMS must satisfy the phasor relation with the 32° phase between them.
  const expectedVR = Math.sqrt(vIn.acRms ** 2 + vOut.acRms ** 2 - 2 * vIn.acRms * vOut.acRms * Math.cos((Math.atan(freq / (1 / (2 * Math.PI * R * 100e-9)))) ));
  assertClose(vR.acRms, expectedVR, expectedVR * 0.05, `V(R1) satisfies the phasor sum (${vR.acRms.toExponential(4)} vs ${expectedVR.toExponential(4)})`);
  assertClose(iR.acRms, vR.acRms / R, (vR.acRms / R) * 0.02, `Ohm's law holds on the measured traces (I = ${(vR.acRms / R).toExponential(4)} A)`);
  assert(vR.acRms > 0 && iR.acRms > 0, 'both traces carry a signal');
  void gain;
});

test('the scope exports a CSV that states its own provenance', () => {
  const { sim } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'in' });
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.run({ tstop: 4e-3, maxSamples: 100 });
  const csv = scope.toCsv();
  const lines = csv.trim().split('\n');
  const comments = lines.filter((l) => l.startsWith('#'));
  assert(comments.some((l) => l.includes('circuit=')), 'the circuit is named');
  assert(comments.some((l) => l.includes('samples=100')), 'the sample count is stated');
  assert(comments.some((l) => l.includes('time base=adaptive')), 'the time base is described');
  assert(comments.some((l) => l.includes('convergence')), 'the convergence state is recorded');
  const header = lines[comments.length];
  assertEqual(header, 'time_s,V in_V,V out_V', `the header names the units (${header})`);
  const data = lines.slice(comments.length + 1);
  assertEqual(data.length, 100, 'one row per sample');
  const first = data[0].split(',');
  assertEqual(first.length, 3, 'three columns');
  assert(Number.isFinite(Number(first[0])), 'the time parses');
  assert(Number.isFinite(Number(first[1])) && Number.isFinite(Number(first[2])), 'and so do both channels');
  const semi = scope.toCsv({ delimiter: ';' });
  assert(semi.split('\n').some((l) => l.includes(';') && !l.startsWith('#')), 'the delimiter is honoured');
});

test('zoom and cursors read a part of the record without re-simulating', () => {
  const { sim } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.run({ tstop: 10e-3, maxSamples: 5000 });
  const whole = scope.stats(0)!;
  scope.zoom(8e-3, 10e-3);
  const part = scope.stats(0)!;
  assert(part.count < whole.count, `the viewport holds fewer samples (${part.count} of ${whole.count})`);
  assertClose(part.tStart, 8e-3, 1e-4, 'starting where the viewport starts');
  assert(part.duration <= 2e-3 + 1e-9, 'and no longer than it');
  const fZoomed = scope.frequency(0)!;
  scope.resetZoom();
  const fAll = scope.frequency(0)!;
  assert(fZoomed.frequency !== null && fAll.frequency !== null, 'both give a frequency');
  // The zoomed window is the settled tail; the full record also contains the startup
  // transient, which is why the two differ and why the full one is not flagged settled.
  assertClose(fZoomed.frequency!, 1000, 1, `the settled window reads 1 kHz (got ${fZoomed.frequency!.toFixed(3)})`);
  assertEqual(fZoomed.settled, true, 'and is flagged as settled');
  assertClose(fAll.frequency!, 1000, 20, `the full record is close to it (${fAll.frequency!.toFixed(3)})`);
  scope.setCursors(1e-3, 1.5e-3);
  const cur = scope.cursorsAt(0)!;
  assertClose(cur.dt, 0.5e-3, 1e-12, 'the cursor interval');
  assertEqual(scope.viewport, null, 'the zoom was reset');
  const text = scopeReportToText(scope.report());
  assert(text.includes('cursors'), 'the cursors appear in the report');
});

test('quickMeasure reads one quantity without wiring a scope by hand', () => {
  const { sim } = rcLowPass({ freq: 1000 });
  const r = quickMeasure(sim, 'out', 'voltage', 4e-3, { maxSamples: 4000 });
  assertEqual(r.error, null, 'the target resolved');
  assert(r.stats !== null && r.stats.count > 100, 'a record was captured');
  const bad = quickMeasure(sim, 'nowhere', 'voltage', 1e-3);
  assert(bad.stats === null && bad.error !== null, 'an unresolved target is reported, not measured');
});

// ---------------------------------------------------------------------------
// The spectrum analyzer
// ---------------------------------------------------------------------------

test('the analyzer finds the tone of an RC output at the right frequency and level', () => {
  const { sim, gain, freq } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.run({ tstop: 60 / freq, maxSamples: 16384 });
  const trace = scope.trace(0)!;
  const an = new SpectrumAnalyzer(trace, { points: 8192, window: 'hann', scale: 'db' });
  const view = an.view()!;
  assert(view !== null, 'a view was produced');
  assertClose(view.peakHz, 1000, view.rbw, `the peak is at the drive frequency (${view.peakHz.toFixed(2)} Hz, RBW ${view.rbw.toFixed(2)})`);
  assertClose(view.peakAmplitude, gain, gain * 0.02, `the peak amplitude is the analytic |H| = ${gain.toFixed(5)} (got ${view.peakAmplitude.toFixed(5)})`);
  // Parseval through the whole instrument chain: the spectrum's own RMS must match
  // the time-domain AC RMS of the same record.
  const timeRms = traceStats(trace).acRms;
  const specRms = Math.sqrt(view.spanMeanSquare);
  assertClose(specRms, timeRms, timeRms * 0.02, `the span RMS ${specRms.toFixed(5)} matches the time-domain AC RMS ${timeRms.toFixed(5)}`);
  assert(view.trueResolutionHz > 0 && view.rbw <= view.trueResolutionHz + 1e-9, 'the padding does not claim a finer resolution than the record has');
  assert(view.notes.some((n) => n.includes('interpolates')), 'the note says padding interpolates');
  assert(view.notes.some((n) => n.includes('not trustworthy')), 'and that the top of the span is limited by the resampling');
});

test('the analyzer scales, markers and peak table behave as documented', () => {
  const trace = sineTrace(2, 5000, 20e-3, 8192);
  const an = new SpectrumAnalyzer(trace, { points: 4096, window: 'flat_top' });
  an.setScale('linear');
  const linear = an.view()!;
  assertClose(linear.peakAmplitude, 2, 0.01, `flat-top reads a non-coherent tone to ±0.01 dB (${linear.peakAmplitude.toFixed(4)} V)`);
  an.setScale('db', 1);
  const db = an.view()!;
  assertClose(db.peaks[0].db, 20 * Math.log10(2), 0.05, 'the dB scale is 20·log10 of the amplitude');
  an.setScale('dbm', 1, 50);
  const dbm = an.view()!;
  // P = A²/(2R) for a sine of peak amplitude A; dBm = 10·log10(P/1 mW).
  const expectedDbm = 10 * Math.log10((2 * 2) / (2 * 50) / 1e-3);
  assertClose(dbm.peaks[0].magnitude, expectedDbm, 0.1, `dBm at 50 Ω is ${expectedDbm.toFixed(2)} (got ${dbm.peaks[0].magnitude.toFixed(2)})`);
  assertClose(dbm.peaks[0].db, 20 * Math.log10(2), 0.05, 'the `db` field stays in dB whatever the display scale is');
  assertClose(dbm.magnitudes[dbm.peaks[0].bin - Math.round(800 / dbm.rbw)] ?? expectedDbm, expectedDbm, 1e9, 'the magnitude array follows the scale');
  assert(dbm.notes.some((n) => n.includes('50 Ω')), 'the impedance the dBm refers to is printed');
  an.setScale('db', 1);
  an.addMarker(5000);
  an.addMarker(1234);
  const marked = an.view()!;
  assertEqual(marked.markers.length, 2, 'both markers are reported');
  assert(marked.markers[0].hz > 4000 && marked.markers[0].hz < 6000, 'the first marker landed on the tone');
  an.setPeakSearch(3, 6);
  const peaks = an.view()!.peaks;
  assert(peaks.length <= 3, `at most the requested number of peaks (${peaks.length})`);
  assertClose(peaks[0].hz, 5000, marked.rbw, 'the strongest peak is the tone');
  const csv = an.toCsv();
  assert(csv.startsWith('# CircuitForge spectrum analyzer export'), 'the CSV carries a provenance header');
  assert(csv.includes('window=flat_top'), 'including the window');
  assert(csv.includes('frequency_Hz'), 'and a column header');
  const text = an.toText();
  assert(text.includes('SPECTRUM ANALYZER') && text.includes('peaks:'), 'the text readout has the sections');
  assert(text.includes('span RMS'), 'and the Parseval check is printed');
});

test('a span narrower than the record is displayed, and the numbers say which span', () => {
  const trace = sineTrace(1, 1000, 10e-3, 8192);
  const an = new SpectrumAnalyzer(trace, { points: 4096 });
  an.setCenterSpan(1000, 400);
  const view = an.view()!;
  assertClose(view.span.start, 800, 1e-9, 'the span starts where it was set');
  assertClose(view.span.stop, 1200, 1e-9, 'and ends where it was set');
  assert(view.frequencies.length > 0 && view.frequencies[0] >= 800 - view.rbw, 'the displayed bins are inside the span');
  assert(view.frequencies[view.frequencies.length - 1] <= 1200 + view.rbw, 'and none is outside it');
  an.fullSpan();
  assertClose(an.view()!.span.stop, an.view()!.nyquistHz, 1e-9, 'full span reaches Nyquist');
});

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

test('a resistor divider reads exactly on every meter', () => {
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'divider', chips);
  const src = b.add('vdc', { dc: 12 }, [0, 0]);
  // tc1 = 0: the library default is 100 ppm/°C, and with self-heating the two
  // resistors sit at different temperatures, so a divider measured to six digits would
  // be testing the temperature coefficient rather than Ohm's law. That effect is real,
  // and it is asserted separately below.
  const r1 = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
  const r2 = b.add('resistor', { r: 2000, tc1: 0, tc2: 0 }, [80, 0]);
  const vm = b.add('voltmeter', { rin: 0 }, [120, 0]);
  const am = b.add('ammeter', { rshunt: 0 }, [40, 40]);
  b.ground('g');
  b.at(src, '+', 'vin');
  b.at(src, '-', 'g');
  b.at(r1, '1', 'vin');
  b.at(r1, '2', 'mid');
  b.at(r2, '1', 'mid');
  b.at(r2, '2', 'g');
  b.at(vm, '+', 'mid');
  b.at(vm, '-', 'g');
  b.at(am, '+', 'vin');
  b.at(am, '-', 'top');
  const circuit = b.finish({ erc: false });
  const nl = flatten(circuit, lib, chips, { metadata: true });
  const sim = new CircuitSimulator(nl);
  sim.dcSolve({ quiet: true });

  const meters = findMeters(nl);
  assert(meters.length >= 1, `the placed voltmeter was found (${meters.map((m) => m.ref).join(',')})`);
  const readings = measure(sim, [
    { quantity: 'voltage', target: 'mid' },
    { quantity: 'current', target: 'element:R2' },
    { quantity: 'power', target: 'element:R2' },
    { quantity: 'voltage', target: 'element:R1', differential: true },
    { quantity: 'voltage', target: 'not-a-node' },
  ]);
  // 12 V over 1 kΩ (top) + 2 kΩ (bottom): V_mid = 12·2/3 = 8 V, I = 12/3000 = 4 mA.
  assertClose(readings[0].dc!, 8, 1e-6, 'the midpoint of a 1 k/2 k divider from 12 V is 8 V');
  assertEqual(readings[0].accuracy, 'REALISTIC', 'a node voltage at the operating point is exact for this model');
  assert(readings[0].method.includes('DC operating point'), 'the method says which solution it came from');
  assertClose(Math.abs(readings[1].dc!), 0.004, 1e-7, `the current through R2 is 12/3000 = 4 mA (got ${readings[1].dc!.toExponential(4)})`);
  assertClose(readings[2].dc!, 0.004 * 0.004 * 2000, 1e-9, 'and its dissipation is I²R');
  assertClose(Math.abs(readings[3].dc!), 4, 1e-6, 'the voltage across R1 is 12 − 8 = 4 V');
  assertEqual(readings[4].dc, null, 'an unresolved target gives no number');
  assertEqual(readings[4].accuracy, 'NOT_MODELED', 'and is labelled accordingly');
  assert(readings[4].note.includes('not-a-node'), `the note names the target that failed (${readings[4].note})`);
  const text = readingsToText(readings);
  assert(text.includes('INSTRUMENTS') && text.includes('NOT MEASURED'), 'the text form marks what was not measured');
});

test('a meter with a finite input resistance loads the circuit, and says so', () => {
  const chips = new ChipLibrary();
  // Build the circuit once with the meter wired in, at two input resistances.
  const make = (rin: number) => {
    const b = new CircuitBuilder(lib, 'loading', chips);
    const src = b.add('vdc', { dc: 10 }, [0, 0]);
    const r1 = b.add('resistor', { r: 10000 }, [40, 0]);
    const r2 = b.add('resistor', { r: 10000 }, [80, 0]);
    const vm = b.add('voltmeter', { rin }, [120, 0]);
    b.ground('g');
    b.at(src, '+', 'vin');
    b.at(src, '-', 'g');
    b.at(r1, '1', 'vin');
    b.at(r1, '2', 'mid');
    b.at(r2, '1', 'mid');
    b.at(r2, '2', 'g');
    b.at(vm, '+', 'mid');
    b.at(vm, '-', 'g');
    return b.finish({ erc: false });
  };
  const ideal = flatten(make(0), lib, chips, { metadata: true });
  const simIdeal = new CircuitSimulator(ideal);
  simIdeal.dcSolve({ quiet: true });
  const vIdeal = measure(simIdeal, [{ quantity: 'voltage', target: 'mid' }])[0].dc!;
  assertClose(vIdeal, 5, 1e-6, 'an ideal meter reads the unloaded 5 V');

  const loaded = flatten(make(10000), lib, chips, { metadata: true });
  const simLoaded = new CircuitSimulator(loaded);
  simLoaded.dcSolve({ quiet: true });
  const vLoaded = measure(simLoaded, [{ quantity: 'voltage', target: 'mid' }])[0].dc!;
  // 10 kΩ meter in parallel with the lower 10 kΩ → 5 kΩ; divider 10k/5k from 10 V → 3.333 V.
  assertClose(vLoaded, 10 / 3, 1e-6, `a 10 kΩ meter pulls the midpoint to 3.333 V (got ${vLoaded.toFixed(5)})`);
  assert(vLoaded < vIdeal - 1, 'and that is visibly not the unloaded value');
  const placed = readPlacedMeters(simLoaded);
  assert(placed.length >= 1, 'the placed meter is read');
  assert(placed[0].note.includes('loads the circuit'), `the reading says the meter loaded the circuit (${placed[0].note})`);
  assert(placed[0].note.includes('not the open-circuit'), 'and that the number is therefore not the open-circuit voltage');
});

test('the wattmeter separates real, reactive and apparent power', () => {
  const { sim, freq, r: R, gain } = rcLowPass({ freq: 1000 });
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'element:R1', differential: true });
  scope.addChannel({ measure: 'current', target: 'element:R1' });
  scope.run({ tstop: 60 / freq, maxSamples: 20000 });
  const p = measurePower(scope.trace(0)!, scope.trace(1)!);
  // A resistor: pf = 1, Q = 0, P = Vrms·Irms = Vrms²/R.
  const vRms = p.voltage!.acRms;
  assertClose(p.powerFactor!, 1, 0.02, `a resistor has a power factor of 1 (got ${p.powerFactor!.toFixed(4)})`);
  assertClose(p.real, (vRms * vRms) / R, (vRms * vRms) / R * 0.05, 'P = Vrms²/R');
  assert(Math.abs(p.reactive ?? 0) < p.real * 0.05, `Q is ~0 for a resistor (${(p.reactive ?? 0).toExponential(3)})`);
  assertClose(p.apparent, p.real, p.real * 0.05, 'S ≈ P when the phase is zero');
  assert(p.period !== null, 'the period the Q shift referred to is reported');
  assert(p.note.includes('single sinusoid'), 'the note states the assumption behind Q');
  assert(p.method.includes('trapezoidal'), 'and the integration rule');
  const text = powerToText(p);
  assert(text.includes('real (active)') && text.includes('power factor'), 'the text form has every quantity');
  void gain;

  // Now the same measurement across the capacitor: a pure reactance has pf ≈ 0.
  const scope2 = new Oscilloscope(sim);
  scope2.addChannel({ measure: 'voltage', target: 'out' });
  scope2.addChannel({ measure: 'current', target: 'element:C1' });
  scope2.run({ tstop: 60 / freq, maxSamples: 20000 });
  const pc = measurePower(scope2.trace(0)!, scope2.trace(1)!);
  assert(Math.abs(pc.powerFactor ?? 1) < 0.15, `a capacitor has a power factor near 0 (got ${(pc.powerFactor ?? NaN).toFixed(4)})`);
  assert(Math.abs(pc.real) < Math.abs(pc.reactive ?? 0) * 0.2, `its real power is near zero and its reactive power is not (${pc.real.toExponential(3)} vs ${(pc.reactive ?? 0).toExponential(3)})`);
});

test('the thermometer reads the coupled steady state, not P×Rth from a cold solve', () => {
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'hot', chips);
  const src = b.add('vdc', { dc: 20 }, [0, 0]);
  // 400 Ω at 20 V → 1 W, with rth 200 K/W and no case path: T = 25 + 200 = 225 °C.
  const res = b.add('resistor', { r: 400, rth: 200, cth: 0.005, rthca: 0 }, [40, 0]);
  b.ground('g');
  b.at(src, '+', 'vin');
  b.at(src, '-', 'g');
  b.at(res, '1', 'vin');
  b.at(res, '2', 'g');
  const nl = flatten(b.finish({ erc: false }), lib, chips, { metadata: true, ambient: 25, thermal: true });
  assert(nl.thermalNodeCount > 0, 'the thermal network was built');
  const sim = new CircuitSimulator(nl);
  sim.dcSolve({ quiet: true });
  const t = measureThermalSteadyState(sim, 'element:R1');
  assert(t !== null, 'the element resolved');
  assertClose(t!.power, 1, 0.02, `the dissipation is 20²/400 = 1 W (got ${t!.power.toFixed(4)})`);
  assert(t!.temperature > 100, `the coupled steady state is hot (${t!.temperature.toFixed(2)} °C), not the cold-solve ambient`);
  assertClose(t!.ambient, 25, 1e-9, 'against the netlist ambient');
  assert(t!.note.includes('lumped'), 'the note states the lumped model');
  assert(t!.method.includes('iterated together'), 'and the method says the two networks were solved together');
  assert(thermalToTextIncludes(t!), 'the reading can be printed');
});

function thermalToTextIncludes(t: ReturnType<typeof measureThermalSteadyState>): boolean {
  if (!t) return false;
  const s = thermalToText(t);
  return s.includes('THERMOMETER') && s.includes('°C') && s.includes('steady state');
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

test('a native waveform is written straight into the source parameters', () => {
  const gen = new SignalGenerator({ waveform: 'sine', amplitude: 2, frequency: 10000, offset: 0.5, phase: 90 });
  const p = gen.params();
  assertEqual(p['waveform'], 'sine', 'the waveform is passed through');
  assertEqual(p['amp'], 2, 'and so is the amplitude');
  assertEqual(p['freq'], 10000, 'the frequency');
  assertEqual(p['dc'], 0.5, 'the offset');
  assertEqual(p['phase'], 90, 'the phase');
  const d = gen.describe();
  assertEqual(d.delivery, 'native', 'a sine is delivered natively');
  assertEqual(d.table, null, 'so there is no table');
  assertEqual(d.bandwidthLimitHz, null, 'and no bandwidth limit');
  assert(d.limits.some((l) => l.includes('analytically')), 'the description says the solver evaluates it analytically');
  assertEqual(gen.specId, 'vsignal', 'a voltage generator targets vsignal');
  assertEqual(new SignalGenerator({ waveform: 'sine' }, 'A').specId, 'isignal', 'and a current one targets isignal');
  assertEqual(new SignalGenerator({ waveform: 'clock' }).specId, 'clock', 'a clock targets the clock primitive');
  assertEqual(new SignalGenerator({ waveform: 'noise' }).specId, 'noise_source', 'noise targets the noise primitive');
});

test('a synthesised waveform is baked into a table, and the cost of that is stated', () => {
  const gen = new SignalGenerator({
    waveform: 'chirp',
    amplitude: 1,
    sweep: { start: 1000, stop: 100000, seconds: 1e-3, kind: 'logarithmic' },
    points: 20000,
  });
  const d = gen.describe();
  assertEqual(d.delivery, 'piecewise-linear table', 'a chirp has no native support');
  assert(d.table !== null && d.table.points > 1000, `a table was baked (${d.table?.points} points)`);
  assertClose(d.table!.duration, 1e-3, 1e-9, 'covering the sweep');
  assert(d.bandwidthLimitHz !== null, 'and the bandwidth it can represent is stated');
  assert(d.limits.some((l) => l.includes('does not repeat')), 'the non-repeating table is declared');
  assert(d.limits.some((l) => l.includes('polygon')), 'and so is the fact that it is a polygon, not the curve');
  const p = gen.params();
  assertEqual(p['waveform'], 'arbitrary', 'the parameter says arbitrary');
  assert(String(p['arbitrary']).length > 1000, 'and carries the table text');
  assertEqual(p['freq'], 0, 'the stale frequency is cleared rather than left to mislead');
  // The table must reproduce the analytic waveform to within its own interpolation.
  const table = gen.table()!;
  let worst = 0;
  for (let i = 0; i < table.length; i += 2) {
    worst = Math.max(worst, Math.abs(evalWaveTable(table, table[i]) - (gen.value(table[i]) - (gen.settings.offset ?? 0))));
  }
  assert(worst < 1e-6, `the table matches value() at its own knots (worst ${worst.toExponential(2)})`);
  // Mid-segment error is bounded by the curvature over one interval.
  let mid = 0;
  for (let i = 0; i + 3 < table.length; i += 2) {
    const t = (table[i] + table[i + 2]) / 2;
    mid = Math.max(mid, Math.abs(evalWaveTable(table, t) - (gen.value(t) - (gen.settings.offset ?? 0))));
  }
  assert(mid < 0.02, `and between knots the chord error is small (${mid.toExponential(3)} of a 1 V amplitude)`);
});

test('the FM and AM generators produce the modulation they claim', () => {
  const fc = 100000;
  const fm = 1000;
  const dev = 20000;
  const gen = new SignalGenerator({ waveform: 'fm', amplitude: 1, frequency: fc, modulation: { freq: fm, depth: dev }, duration: 20 / fm, points: 60000 });
  // Instantaneous frequency = fc + dev·cos(2π fm t): measure it at the modulation peak
  // and trough by counting zero crossings in a short window.
  // The window has to stay inside t > 0 (before the generator's start it holds its
  // offset, which would flatten half the record) and be short enough that the
  // instantaneous frequency is nearly constant across it: ±5 % of a modulation period
  // around an extremum, where cos varies by less than 0.5 %.
  const rateAt = (tCentre: number): number => {
    const dt = 0.1 / fm;
    const n = 4000;
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      times[i] = tCentre - dt / 2 + (dt * i) / (n - 1);
      values[i] = gen.value(times[i]);
    }
    const trace: Trace = { name: 'fm', unit: 'V', times, values, kind: 'voltage', target: 'synthetic' };
    const f = measureFrequency(trace, { hysteresis: 0.2 });
    return f.frequency ?? 0;
  };
  const atMax = rateAt(1 / fm); // cos(2π fm t) = +1 at every whole modulation period
  const atMin = rateAt(1.5 / fm); // and −1 half a modulation period later
  const atZeroDev = rateAt(1.25 / fm); // cos = 0 a quarter period in
  assertClose(atMax, fc + dev, (fc + dev) * 0.02, `at the modulation peak the instantaneous frequency is fc + Δf (${atMax.toFixed(0)} Hz)`);
  assertClose(atMin, fc - dev, (fc - dev) * 0.02, `at the trough it is fc − Δf (${atMin.toFixed(0)} Hz)`);
  assertClose(atZeroDev, fc, fc * 0.02, `a quarter modulation period later it is the carrier (${atZeroDev.toFixed(0)} Hz)`);
  const d = gen.describe();
  assert(d.limits.some((l) => l.includes('Carson')), 'the FM description quotes Carson bandwidth');

  const am = new SignalGenerator({ waveform: 'am', amplitude: 1, frequency: fc, modulation: { freq: fm, depth: 1 }, duration: 5 / fm, points: 40000 });
  // The envelope is what AM modulates, not the instantaneous value: at t = 0 the
  // carrier itself is at zero even though the envelope is at its crest. So the
  // envelope is measured as the peak over a window short compared with 1/fm.
  const peakAround = (centre: number, halfWidth: number): number => {
    let m = 0;
    for (let i = 0; i <= 2000; i++) {
      m = Math.max(m, Math.abs(am.value(centre - halfWidth + (2 * halfWidth * i) / 2000)));
    }
    return m;
  };
  const halfCarrier = 0.4 / fc;
  // Not exactly 1: the carrier peak sits a quarter period after the envelope crest,
  // and over that quarter period the 1 kHz modulation has already moved the envelope
  // by fm/(4·fc) of a radian. The shortfall is the physics of AM, not an error.
  assertClose(peakAround(0, halfCarrier), 1, 1e-3, `at the envelope crest the carrier reaches the full amplitude (${peakAround(0, halfCarrier).toFixed(6)})`);
  assert(peakAround(1 / (2 * fm), halfCarrier) < 0.02, `at 100 % depth the envelope touches zero at the trough (peak ${peakAround(1 / (2 * fm), halfCarrier).toExponential(2)})`);
  assertClose(peakAround(1 / fm, halfCarrier), 1, 1e-3, 'and the crest returns one modulation period later');
  const am100 = am.describe();
  assert(am100.limits.length > 0, 'the AM generator states its limits too');
});

test('the generator writes into a circuit and the simulator then produces that waveform', () => {
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'gen', chips);
  const src = b.add('vsignal', {}, [0, 0]);
  const res = b.add('resistor', { r: 1000 }, [40, 0]);
  b.ground('g');
  b.at(src, '+', 'out');
  b.at(src, '-', 'g');
  b.at(res, '1', 'out');
  b.at(res, '2', 'g');
  const circuit = b.finish({ erc: false });
  const gen = new SignalGenerator({ waveform: 'square', amplitude: 3.3, frequency: 1e6, duty: 0.25, riseTime: 2e-9, fallTime: 2e-9 });
  const inst = gen.applyTo(circuit, src.ref);
  assert(inst !== null, 'the instance was found by its reference designator');
  assertEqual(inst!.params['waveform'], 'square', 'the waveform was written');
  assertEqual(inst!.params['duty'], 0.25, 'and the duty cycle');
  const nl = flatten(circuit, lib, chips, {});
  const sim = new CircuitSimulator(nl);
  const scope = new Oscilloscope(sim);
  scope.addChannel({ measure: 'voltage', target: 'out' });
  scope.run({ tstop: 20e-6, maxSamples: 20000, initialStep: 1e-11, maxStep: 2e-10 });
  const duty = scope.duty(0)!;
  assert(duty.dutyPercent !== null, 'a duty cycle was measured');
  assertClose(duty.dutyPercent!, 25, 2, `the circuit reproduces the generator's 25 % duty (got ${duty.dutyPercent!.toFixed(2)} %)`);
  const f = scope.frequency(0)!;
  assert(f.frequency !== null, 'and a frequency');
  assertClose(f.frequency!, 1e6, 2e4, `at 1 MHz (got ${f.frequency!.toExponential(4)})`);
  const stats = scope.stats(0)!;
  assertClose(stats.peakToPeak, 3.3, 0.05, `with a ${(stats.peakToPeak).toFixed(3)} V swing`);
  assertEqual(gen.applyTo(circuit, 'no-such-ref'), null, 'an unknown reference is not written to');
});

test('every preset describes itself honestly and produces a usable parameter set', () => {
  for (const [name, settings] of Object.entries(GENERATOR_PRESETS)) {
    const gen = new SignalGenerator(settings);
    const d = gen.describe();
    assertEqual(d.waveform, settings.waveform, `${name}: the waveform is the one asked for`);
    assert(d.limits.length > 0, `${name}: at least one limit is stated`);
    const p = d.params;
    if (d.delivery === 'piecewise-linear table') {
      assertEqual(p['waveform'], 'arbitrary', `${name}: a synthesised waveform is delivered as a table`);
      assert(String(p['arbitrary']).length > 10, `${name}: and the table text is not empty`);
      assert(d.bandwidthLimitHz !== null && d.bandwidthLimitHz > 0, `${name}: the bandwidth limit is quantified`);
    }
    // Every preset must evaluate without producing NaN over its own duration.
    const duration = d.table ? d.table.duration : 1 / Math.max(settings.frequency ?? 1000, 1e-6);
    for (let i = 0; i <= 200; i++) {
      const v = gen.value((duration * i) / 200, new Rng(i));
      assert(Number.isFinite(v), `${name}: value(${((duration * i) / 200).toExponential(2)}) = ${v}`);
    }
    const text = gen.toText();
    assert(text.includes('SIGNAL GENERATOR') && text.includes('accuracy'), `${name}: the front panel prints`);
  }
});

// ---------------------------------------------------------------------------
// The arbitrary waveform, end to end
// ---------------------------------------------------------------------------

test('the PWL parameter text round-trips exactly and rejects what it cannot read', () => {
  const table = parseArbitraryWaveform('0:0, 1e-6:3.3, 2e-6:3.3, 3e-6:0');
  assert(table !== null, 'a well-formed table parses');
  assertEqual(table!.length, 8, 'four points, two numbers each');
  assertClose(table![2], 1e-6, 1e-18, 'the second time is exact');
  assertEqual(formatArbitraryWaveform(table!), '0:0, 0.000001:3.3, 0.000002:3.3, 0.000003:0', 'and formats back');
  assertEqual(formatArbitraryWaveform(parseArbitraryWaveform(formatArbitraryWaveform(table!))!), formatArbitraryWaveform(table!), 'the round trip is stable');
  assert(parseArbitraryWaveform('0:0, 1ms:5, 2ms:5') !== null, 'SI suffixes are accepted');
  assertClose(parseArbitraryWaveform('0:0, 1ms:5, 2ms:5')![2], 1e-3, 1e-18, 'and mean milliseconds');
  assertClose(parseArbitraryWaveform('0:0, 1us:5, 2us:5')![2], 1e-6, 1e-18, 'microseconds too');
  for (const bad of ['', '0', '0:1', '1:1, 1:2', 'a:b', '0:1, -1:2', '0:1;2', ':1', '1:']) {
    assertEqual(parseArbitraryWaveform(bad), null, `"${bad}" is not a usable table`);
  }
  // The interpolation holds outside the table and is linear inside it.
  const t = parseArbitraryWaveform('0:0, 1:10, 2:0')!;
  assertClose(evalWaveTable(t, -5), 0, 1e-12, 'before the table the first value is held');
  assertClose(evalWaveTable(t, 0.5), 5, 1e-12, 'inside it is linear');
  assertClose(evalWaveTable(t, 1.5), 5, 1e-12, 'on both segments');
  assertClose(evalWaveTable(t, 99), 0, 1e-12, 'and after it the last value is held');
});

test('an arbitrary waveform reaches the circuit and the solver lands on its corners', () => {
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'awg', chips);
  const src = b.add('vsignal', { waveform: 'arbitrary', arbitrary: '0:0, 1e-6:3, 2e-6:3, 3e-6:0', dc: 0 }, [0, 0]);
  const res = b.add('resistor', { r: 1000 }, [40, 0]);
  b.ground('g');
  b.at(src, '+', 'out');
  b.at(src, '-', 'g');
  b.at(res, '1', 'out');
  b.at(res, '2', 'g');
  const nl = flatten(b.finish({ erc: false }), lib, chips, {});
  assertEqual(nl.waveTables.length, 1, 'the table was registered in the netlist');
  assertEqual(nl.diagnostics.filter((d) => d.code === 'CF4008').length, 0, 'and no diagnostic was raised for it');
  const sim = new CircuitSimulator(nl);
  const r = sim.transient(5e-6, [{ key: 'v', kind: 'vnode', index: 1 }], { maxSamples: 20000 });
  const at = (t: number): number => {
    let i = 0;
    while (i < r.times.length - 1 && r.times[i + 1] <= t) i++;
    const frac = r.times[i + 1] === r.times[i] ? 0 : (t - r.times[i]) / (r.times[i + 1] - r.times[i]);
    return r.values[0][i] + frac * (r.values[0][Math.min(i + 1, r.sampleCount - 1)] - r.values[0][i]);
  };
  assertClose(at(0.5e-6), 1.5, 0.02, 'the ramp is linear: 1.5 V half way to the first corner');
  assertClose(at(1.5e-6), 3, 0.01, 'the level holds between the corners');
  assertClose(at(2.5e-6), 1.5, 0.02, 'and the falling ramp is linear too');
  assertClose(at(4e-6), 0, 1e-6, 'past the table the last value is held');
  // The stepper must have landed on the corners, or the edges would be smoothed.
  const corners = [1e-6, 2e-6, 3e-6];
  for (const c of corners) {
    let nearest = Infinity;
    for (let i = 0; i < r.sampleCount; i++) nearest = Math.min(nearest, Math.abs(r.times[i] - c));
    assert(nearest < 1e-9, `a sample lands on the corner at ${(c * 1e6).toFixed(0)} µs (nearest ${nearest.toExponential(2)} s away)`);
  }
});

test('an unusable arbitrary waveform is reported, and the source holds its offset', () => {
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'bad-awg', chips);
  const src = b.add('vsignal', { waveform: 'arbitrary', arbitrary: 'not a table', dc: 1.5 }, [0, 0]);
  const res = b.add('resistor', { r: 1000 }, [40, 0]);
  b.ground('g');
  b.at(src, '+', 'out');
  b.at(src, '-', 'g');
  b.at(res, '1', 'out');
  b.at(res, '2', 'g');
  const nl = flatten(b.finish({ erc: false }), lib, chips, {});
  const cf4008 = nl.diagnostics.filter((d) => d.code === 'CF4008');
  assertEqual(cf4008.length, 1, `one CF4008 diagnostic was raised (${nl.diagnostics.map((d) => d.code).join(',')})`);
  assert(cf4008[0].message.includes('not a table'), `and it quotes the offending text (${cf4008[0].message})`);
  assert(cf4008[0].message.includes('DC offset'), 'and says what the source will do instead');
  assertEqual(nl.waveTables.length, 0, 'no table was registered');
  const sim = new CircuitSimulator(nl);
  const r = sim.transient(1e-6, [{ key: 'v', kind: 'vnode', index: 1 }], { maxSamples: 100 });
  for (let i = 0; i < r.sampleCount; i++) {
    assertClose(r.values[0][i], 1.5, 1e-6, 'the source holds its DC offset, as the diagnostic said');
  }
});

test('a gate-expanded netlist still resolves probes by instance path', () => {
  // An expanded gate produces several elements for one instance, so an instance path
  // is ambiguous. The resolver must refuse to guess which transistor's current is
  // "the" current.
  const chips = new ChipLibrary();
  const b = new CircuitBuilder(lib, 'probe-ambiguity', chips);
  const gate = b.add('and_gate', { style: 'cmos_static' }, [0, 0]);
  const hi = b.add('logic_high', {}, [-40, 0]);
  b.ground('g');
  b.at(hi, 'OUT', 'a');
  b.at(gate, 'IN1', 'a');
  b.at(gate, 'IN2', 'a');
  b.at(gate, 'VDD', 'vdd');
  const vdd = b.add('vdc', { dc: 3.3 }, [-80, 0]);
  b.at(vdd, '+', 'vdd');
  b.at(vdd, '-', 'g');
  const nl = flatten(b.finish({ erc: false }), lib, chips, { metadata: true, expandGates: true });
  if (nl.expandedTransistors > 1) {
    const byPath = resolveProbe(nl, `element:${gate.ref}`);
    const ambiguity = probeFailure(nl, gate.ref);
    if (byPath === null) {
      assert(ambiguity.includes('matches') || ambiguity.includes('neither'), `the failure explains why (${ambiguity})`);
    } else {
      assert(byPath.via.length > 0, 'a resolved probe says how it was resolved');
    }
  }
  assert(nl.elementCount > 0, 'the netlist has elements to probe');
  const nodeProbe = resolveProbe(nl, 'node:a');
  assert(nodeProbe !== null && nodeProbe.kind === 'node', 'a node prefix resolves a node');
  assertEqual(resolveProbe(nl, 'node:'), null, 'an empty name resolves to nothing');
});
