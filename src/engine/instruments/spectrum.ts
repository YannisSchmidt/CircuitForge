/**
 * The spectrum analyzer.
 *
 * A span/window/marker front end over the FFT in `fft.ts`. It exists as its own
 * instrument rather than as a scope method because the controls a user expects from
 * an analyzer — centre frequency and span, resolution bandwidth, a magnitude scale,
 * markers, a peak table — have no meaning on a time-domain trace, and because a
 * spectral reading has failure modes a time-domain reading does not.
 *
 * Those failure modes are reported rather than papered over:
 *
 * - **The solver's samples are not uniform.** They are linearly resampled onto the
 *   analyzer's grid before the transform. Interpolation is a low-pass filter whose
 *   cut-off is set by the coarsest step in the record, so the top of the span is not
 *   trustworthy. `notes` gives that frequency explicitly.
 * - **Zero padding interpolates, it does not resolve.** The bin spacing shown after
 *   padding is finer than the record's true resolution (fs/N_captured). Both numbers
 *   are reported, and a peak frequency quoted from the padded grid is an interpolated
 *   estimate.
 * - **A window trades amplitude accuracy for leakage.** The coherent gain is divided
 *   out, and the worst-case scalloping loss for the chosen window is stated, so a
 *   level read off a non-coherent tone is known to ±that many dB.
 * - **dBm needs an impedance.** Power in a 1 V²/R sense is only defined against a
 *   reference resistance; 50 Ω is the default and is printed with every dBm reading.
 */

import { Accuracy } from '../core/labels.js';
import {
  amplitudeSpectrum,
  totalHarmonicDistortion,
  WINDOWS,
  type AmplitudeSpectrum,
  type ThdResult,
  type WindowKind,
} from './fft.js';
import { effectiveSampleRate, formatHz, formatSeconds, formatReading, resampleUniform, type Trace } from './measure.js';

export type MagnitudeScale = 'db' | 'linear' | 'dbm';

export interface Marker {
  /** Marker frequency, Hz. */
  hz: number;
  /** Magnitude at the marker, in the current scale. */
  magnitude: number;
  /** Amplitude at the marker, in the trace's unit. */
  amplitude: number;
  /** Bin the marker landed on. */
  bin: number;
  label: string;
}

export interface Peak {
  hz: number;
  /** Peak amplitude in the trace's own unit — the scale-independent number. */
  amplitude: number;
  /** Magnitude in dB relative to the analyzer's `reference`, whatever the display scale is. */
  db: number;
  /** Magnitude in the display scale (db, dbm or linear). `db` is always dB. */
  magnitude: number;
  /** How far above the local noise floor this peak is, dB. */
  prominenceDb: number;
  bin: number;
}

export interface AnalyzerOptions {
  /** Resampling grid length; a power of two is used as-is. */
  points?: number;
  window?: WindowKind;
  scale?: MagnitudeScale;
  /** dB reference for the `db` scale, in the trace's unit (1 by default). */
  reference?: number;
  /** Reference resistance for the `dbm` scale, Ω. */
  impedance?: number;
  /** Remove the record mean before transforming. */
  removeDc?: boolean;
  /** Displayed span; the full record by default. */
  span?: { start: number; stop: number };
}

export interface SpectrumView {
  /** The trace this view was computed from. */
  channel: string;
  unit: string;
  scale: MagnitudeScale;
  reference: number;
  impedance: number;
  /** Frequencies in the span, Hz. */
  frequencies: Float64Array;
  /** Magnitudes in the span, in the current scale. */
  magnitudes: Float64Array;
  /** The same amplitudes in the trace's own unit, unscaled. */
  amplitudes: Float64Array;
  span: { start: number; stop: number };
  /** Resolution bandwidth: the bin spacing actually achieved, Hz. */
  rbw: number;
  /** The resolution the record really has, Hz. */
  trueResolutionHz: number;
  sampleRate: number;
  points: number;
  window: WindowKind;
  windowInfo: (typeof WINDOWS)[WindowKind];
  nyquistHz: number;
  markers: Marker[];
  peaks: Peak[];
  /** The largest bin magnitude in the span, and where. */
  peakHz: number;
  peakAmplitude: number;
  /**
   * Mean-square value of the span, in the trace unit squared: Σ(A_k²/2) over the
   * one-sided amplitudes, divided by the window's energy correction. Its square root
   * is the RMS of what the span contains, so for a full span it must match the
   * time-domain AC RMS of the same record — and the difference between the two is a
   * check on the resampling, the window and the padding all at once. Removing the DC
   * bin makes it the AC mean square.
   */
  spanMeanSquare: number;
  notes: string[];
  accuracy: Accuracy;
}

/**
 * A spectrum analyzer bound to one trace.
 *
 * The trace is captured once (by a scope or handed in directly) and every control
 * re-derives the view from it. Changing the span or the window never re-runs the
 * solver: an analyzer that silently re-simulated would produce readings the user
 * could not reproduce from the record they are looking at.
 */
export class SpectrumAnalyzer {
  private trace: Trace | null = null;
  private opts: Required<Pick<AnalyzerOptions, 'points' | 'window' | 'scale' | 'reference' | 'impedance' | 'removeDc'>> & { span: { start: number; stop: number } | null };
  private markerHz: number[] = [];
  private maxPeaks = 8;
  private minProminenceDb = 3;
  private cached: SpectrumView | null = null;
  private cachedKey = '';

  constructor(trace?: Trace, options: AnalyzerOptions = {}) {
    this.trace = trace ?? null;
    this.opts = {
      points: options.points ?? 1024,
      window: options.window ?? 'hann',
      scale: options.scale ?? 'db',
      reference: Number.isFinite(options.reference) && (options.reference ?? 0) > 0 ? (options.reference as number) : 1,
      impedance: Number.isFinite(options.impedance) && (options.impedance ?? 0) > 0 ? (options.impedance as number) : 50,
      removeDc: options.removeDc ?? false,
      span: options.span ?? null,
    };
  }

  setTrace(trace: Trace): this {
    this.trace = trace;
    this.cached = null;
    return this;
  }

  setWindow(kind: WindowKind): this {
    this.opts.window = kind;
    this.cached = null;
    return this;
  }

  setScale(scale: MagnitudeScale, reference?: number, impedance?: number): this {
    this.opts.scale = scale;
    if (Number.isFinite(reference) && (reference ?? 0) > 0) this.opts.reference = reference as number;
    if (Number.isFinite(impedance) && (impedance ?? 0) > 0) this.opts.impedance = impedance as number;
    this.cached = null;
    return this;
  }

  setPoints(points: number): this {
    this.opts.points = Math.max(16, Math.floor(points));
    this.cached = null;
    return this;
  }

  setRemoveDc(on: boolean): this {
    this.opts.removeDc = on;
    this.cached = null;
    return this;
  }

  /** Set the displayed span; frequencies outside it are still transformed, just not shown. */
  setSpan(start: number, stop: number): this {
    const a = Math.min(start, stop);
    const b = Math.max(start, stop);
    this.opts.span = b > a ? { start: a, stop: b } : null;
    this.cached = null;
    return this;
  }

  setCenterSpan(center: number, span: number): this {
    return this.setSpan(center - span / 2, center + span / 2);
  }

  fullSpan(): this {
    this.opts.span = null;
    this.cached = null;
    return this;
  }

  addMarker(hz: number): this {
    this.markerHz.push(hz);
    this.cached = null;
    return this;
  }

  clearMarkers(): this {
    this.markerHz.length = 0;
    this.cached = null;
    return this;
  }

  /** Peak-search settings. */
  setPeakSearch(maxPeaks: number, minProminenceDb: number): this {
    this.maxPeaks = Math.max(1, Math.floor(maxPeaks));
    this.minProminenceDb = minProminenceDb;
    this.cached = null;
    return this;
  }

  get options(): typeof this.opts {
    return { ...this.opts };
  }

  /** Compute (or return the cached) view. */
  view(): SpectrumView | null {
    const t = this.trace;
    if (!t || t.values.length < 2) return null;
    const key = [t.values.length, t.times[t.times.length - 1], this.opts.points, this.opts.window, this.opts.scale, this.opts.reference, this.opts.impedance, this.opts.removeDc, this.opts.span?.start ?? '', this.opts.span?.stop ?? '', this.markerHz.join('|'), this.maxPeaks, this.minProminenceDb].join(';');
    if (this.cached && this.cachedKey === key) return this.cached;

    const points = this.opts.points;
    const duration = t.times[t.times.length - 1] - t.times[0];
    const uniform = resampleUniform(t, t.times[0], t.times[t.times.length - 1], points);
    const sampleRate = effectiveSampleRate(t, points);
    if (!(sampleRate > 0) || !(duration > 0)) return null;
    const spec: AmplitudeSpectrum = amplitudeSpectrum(uniform, {
      sampleRate,
      window: this.opts.window,
      reference: this.opts.reference,
      removeDc: this.opts.removeDc,
    });

    const span = this.opts.span ?? { start: 0, stop: sampleRate / 2 };
    const start = Math.max(0, span.start);
    const stop = Math.min(sampleRate / 2, span.stop);
    const lo = Math.max(0, Math.floor(start / spec.binHz));
    const hi = Math.min(spec.amplitudes.length - 1, Math.ceil(stop / spec.binHz));
    const count = Math.max(0, hi - lo + 1);
    const frequencies = new Float64Array(count);
    const amplitudes = new Float64Array(count);
    const magnitudes = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const k = lo + i;
      frequencies[i] = spec.frequencies[k];
      amplitudes[i] = spec.amplitudes[k];
      magnitudes[i] = this.toScale(spec.amplitudes[k]);
    }

    // Peak search: a bin above both neighbours, ranked by prominence over the
    // median of the span (a noise-floor estimate that does not depend on the peak).
    const peaks: Peak[] = [];
    const sorted = Float64Array.from(amplitudes).sort();
    const median = sorted.length ? sorted[sorted.length >> 1] : 0;
    const floorDb = this.toScaleDb(median);
    for (let i = 1; i < count - 1; i++) {
      if (amplitudes[i] > amplitudes[i - 1] && amplitudes[i] >= amplitudes[i + 1]) {
        const db = this.toScaleDb(amplitudes[i]);
        const prominence = db - floorDb;
        if (prominence >= this.minProminenceDb || peaks.length === 0) {
          peaks.push({ hz: frequencies[i], amplitude: amplitudes[i], db, magnitude: this.toScale(amplitudes[i]), prominenceDb: prominence, bin: lo + i });
        }
      }
    }
    peaks.sort((a, b) => b.db - a.db);
    const top = peaks.slice(0, this.maxPeaks);

    const markers: Marker[] = this.markerHz.map((hz, i) => {
      const k = Math.max(0, Math.min(count - 1, Math.round((hz - (lo * spec.binHz)) / spec.binHz)));
      const amplitude = count > 0 ? amplitudes[k] : 0;
      return {
        hz: count > 0 ? frequencies[k] : hz,
        magnitude: this.toScale(amplitude),
        amplitude,
        bin: lo + k,
        label: `M${i + 1}`,
      };
    });

    // Mean-square value in the span. For one-sided peak amplitudes a bin carries
    // A²/2 of mean square (A² for DC and Nyquist, which have no mirror partner), so
    // summing that over the span reproduces the record's mean square — Parseval —
    // and gives a number that can be checked against the time-domain RMS. No
    // ENBW correction belongs here: ENBW describes how much *noise* a bin admits,
    // not how much signal energy it holds.
    let spanMeanSquare = 0;
    for (let i = 0; i < count; i++) {
      const k = lo + i;
      const scale = k === 0 || k === spec.transformSamples / 2 ? 1 : 0.5;
      spanMeanSquare += amplitudes[i] * amplitudes[i] * scale;
    }
    spanMeanSquare /= spec.energyCorrection;

    const largestStep = maxStep(t.times);
    const interpolationLimit = largestStep > 0 ? 0.5 / largestStep : sampleRate / 2;
    const notes = [
      `${t.values.length} adaptive samples linearly resampled to ${points} uniform points over ${formatSeconds(duration)} before the transform`,
      `RBW (bin spacing) ${formatHz(spec.binHz)}; true resolution from the record ${formatHz(spec.trueResolutionHz)} — padding interpolates between bins, it does not separate tones closer than that`,
      `${this.opts.window} window: amplitudes corrected by its coherent gain, ENBW ${spec.window.enbwBins.toFixed(2)} bins, energy correction ${spec.energyCorrection.toFixed(4)} (applied to the span mean square), worst-case scalloping loss ${Math.abs(spec.window.scallopingLossDb).toFixed(2)} dB`,
      `Nyquist limit ${formatHz(sampleRate / 2)}; the coarsest solver step is ${formatSeconds(largestStep)}, so content above ~${formatHz(interpolationLimit)} is attenuated by the resampling and is not trustworthy`,
      this.opts.scale === 'dbm'
        ? `dBm referred to ${this.opts.impedance} Ω: P = V²/R, so a level reading depends on that impedance being the real one`
        : this.opts.scale === 'db'
          ? `dB referred to ${formatReading(this.opts.reference, t.unit)}`
          : 'linear amplitude in the trace unit',
      `span ${formatHz(start)} … ${formatHz(stop)}; ${count} bin(s) displayed`,
    ];
    if (this.opts.removeDc) notes.push('the record mean was removed before the transform, so the DC bin reads ~0');

    const view: SpectrumView = {
      channel: t.name,
      unit: t.unit,
      scale: this.opts.scale,
      reference: this.opts.reference,
      impedance: this.opts.impedance,
      frequencies,
      magnitudes,
      amplitudes,
      span: { start, stop },
      rbw: spec.binHz,
      trueResolutionHz: spec.trueResolutionHz,
      sampleRate,
      points,
      window: this.opts.window,
      windowInfo: spec.window,
      nyquistHz: sampleRate / 2,
      markers,
      peaks: top,
      peakHz: top.length > 0 ? top[0].hz : 0,
      peakAmplitude: top.length > 0 ? top[0].amplitude : 0,
      spanMeanSquare,
      notes,
      accuracy: Accuracy.APPROXIMATED,
    };
    this.cached = view;
    this.cachedKey = key;
    return view;
  }

  /** Total harmonic distortion referred to a fundamental (the largest peak by default). */
  thd(fundamentalHz?: number, maxOrder = 10): ThdResult | null {
    const t = this.trace;
    if (!t || t.values.length < 2) return null;
    const points = this.opts.points;
    const uniform = resampleUniform(t, t.times[0], t.times[t.times.length - 1], points);
    const sampleRate = effectiveSampleRate(t, points);
    if (!(sampleRate > 0)) return null;
    const spec = amplitudeSpectrum(uniform, { sampleRate, window: this.opts.window, reference: this.opts.reference, removeDc: this.opts.removeDc });
    let f = fundamentalHz ?? NaN;
    if (!Number.isFinite(f)) {
      const view = this.view();
      f = view ? view.peakHz : 0;
    }
    return totalHarmonicDistortion(spec, f, sampleRate, maxOrder);
  }

  private toScale(amplitude: number): number {
    switch (this.opts.scale) {
      case 'linear':
        return amplitude;
      case 'dbm': {
        const p = (amplitude * amplitude) / (2 * this.opts.impedance);
        return 10 * Math.log10(Math.max(p, 1e-300) / 1e-3);
      }
      default:
        return 20 * Math.log10(Math.max(amplitude, 1e-300) / this.opts.reference);
    }
  }

  private toScaleDb(amplitude: number): number {
    const prev = this.opts.scale;
    this.opts.scale = 'db';
    const v = this.toScale(amplitude);
    this.opts.scale = prev;
    return v;
  }

  /** CSV of the current view: frequency and magnitude, with the provenance header. */
  toCsv(delimiter = ','): string {
    const view = this.view();
    const lines: string[] = [];
    lines.push('# CircuitForge spectrum analyzer export');
    if (!view) {
      lines.push('# no trace: nothing to export');
      return lines.join('\n') + '\n';
    }
    lines.push(`# channel=${view.channel} unit=${view.unit}`);
    lines.push(`# scale=${view.scale}${view.scale === 'dbm' ? ` impedance=${view.impedance} ohm` : view.scale === 'db' ? ` reference=${view.reference} ${view.unit}` : ''}`);
    lines.push(`# window=${view.window} rbw=${view.rbw.toExponential(6)} Hz true_resolution=${view.trueResolutionHz.toExponential(6)} Hz nyquist=${view.nyquistHz.toExponential(6)} Hz`);
    for (const n of view.notes) lines.push(`# note: ${n}`);
    lines.push(['frequency_Hz', `magnitude_${view.scale}`, `amplitude_${view.unit.replace('/', '_')}`].join(delimiter));
    for (let i = 0; i < view.frequencies.length; i++) {
      lines.push([view.frequencies[i].toExponential(9), view.magnitudes[i].toExponential(9), view.amplitudes[i].toExponential(9)].join(delimiter));
    }
    return lines.join('\n') + '\n';
  }

  /** The text readout. */
  toText(): string {
    const view = this.view();
    if (!view) return 'SPECTRUM ANALYZER\n  no trace was captured, so there is no spectrum to show';
    const out: string[] = ['SPECTRUM ANALYZER'];
    out.push(`  channel ${view.channel} (${view.unit}) — span ${formatHz(view.span.start)} … ${formatHz(view.span.stop)}, ${view.points} points`);
    out.push(`  scale ${view.scale}${view.scale === 'dbm' ? ` @ ${view.impedance} Ω` : view.scale === 'db' ? ` ref ${formatReading(view.reference, view.unit)}` : ''}   window ${view.window}   RBW ${formatHz(view.rbw)}`);
    if (view.peaks.length > 0) {
      out.push('  peaks:');
      for (const p of view.peaks) {
        out.push(
          `      ${formatHz(p.hz)}  ${p.magnitude.toFixed(2)} ${view.scale}  amplitude ${formatReading(p.amplitude, view.unit)}` +
            (view.scale === 'dbm' ? '' : `  (${p.db.toFixed(2)} dB)`) +
            `  +${p.prominenceDb.toFixed(1)} dB over the span median`,
        );
      }
    } else {
      out.push('  peaks: none above the search threshold');
    }
    for (const m of view.markers) {
      out.push(`  ${m.label}: ${formatHz(m.hz)} → ${m.magnitude.toFixed(3)} ${view.scale} (amplitude ${formatReading(m.amplitude, view.unit)})`);
    }
    const thd = this.thd();
    if (thd && thd.ordersInSpan > 0) {
      out.push(`  THD: ${thd.thdPercent.toFixed(3)} % — ${thd.note}`);
    }
    out.push(`  span RMS ${formatReading(Math.sqrt(Math.max(view.spanMeanSquare, 0)), view.unit)} (from the bins; compare with the time-domain AC RMS of the same record)`);
    for (const n of view.notes) out.push(`  note: ${n}`);
    out.push(`  accuracy: ${view.accuracy}`);
    return out.join('\n');
  }
}

function maxStep(times: Float64Array): number {
  let m = 0;
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    if (dt > m) m = dt;
  }
  return m;
}
