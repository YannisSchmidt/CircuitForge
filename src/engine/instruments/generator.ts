/**
 * The signal generator.
 *
 * A generator produces a waveform and puts it into a source component. The design
 * decision that matters is *how* it does that, because two of the three options
 * would be dishonest:
 *
 * 1. **Native waveforms** (dc, sine, square, triangle, sawtooth, pulse, clock,
 *    noise) are written straight into the source's parameters and evaluated
 *    analytically by the solver at every Newton iteration. No sampling, no
 *    interpolation, no bandwidth limit — this is the exact waveform.
 * 2. **Synthesised waveforms** (chirp/sweep, AM, FM, burst, and anything the caller
 *    defines point by point) have no native solver support. They are baked into a
 *    piecewise-linear table and written to the `arbitrary` parameter. The solver
 *    then interpolates that table, so the result is the requested waveform *sampled
 *    at the chosen interval* — and the description states the interval, the number
 *    of points and the frequency above which the table cannot represent the signal.
 * 3. Pretending option 2 is option 1 is what this module refuses to do: a table of
 *    200 points over a 10 MHz chirp is not a 10 MHz chirp, and every reading taken
 *    from it says so.
 *
 * The table also does not repeat: past its last point the source holds the final
 * value. A repeating synthesised waveform has to be baked for as many periods as the
 * simulation needs, and `describe()` reports the covered duration.
 */

import { Accuracy } from '../core/labels.js';
import { Rng } from '../util/rng.js';
import type { Circuit, ComponentInstance } from '../core/circuit.js';
import type { ParamBag } from '../core/library.js';
import { formatArbitraryWaveform, parseArbitraryWaveform } from '../sim/lower.js';
import { formatHz, formatSeconds, formatReading } from './measure.js';

/** Waveforms the solver evaluates analytically. */
export const NATIVE_WAVEFORMS = ['dc', 'sine', 'square', 'triangle', 'sawtooth', 'pulse', 'clock', 'noise'] as const;
/** Waveforms that must be baked into a PWL table. */
export const SYNTHESISED_WAVEFORMS = ['chirp', 'am', 'fm', 'burst', 'arbitrary'] as const;

export type GeneratorWaveform = (typeof NATIVE_WAVEFORMS)[number] | (typeof SYNTHESISED_WAVEFORMS)[number];

export interface SweepSettings {
  /** Start frequency, Hz. */
  start: number;
  /** Stop frequency, Hz. */
  stop: number;
  /** Sweep duration, s. */
  seconds: number;
  kind?: 'linear' | 'logarithmic';
}

export interface ModulationSettings {
  /** Modulating frequency, Hz. */
  freq: number;
  /**
   * AM: modulation depth 0…1 (1 = 100 %, the envelope touches zero).
   * FM: peak frequency deviation, Hz.
   */
  depth: number;
}

export interface BurstSettings {
  /** Number of carrier cycles per burst. */
  cycles: number;
  /** Burst repetition period, s (0 = a single burst). */
  repeatPeriod?: number;
}

export interface NoiseSettings {
  /** White density, V/√Hz or A/√Hz. */
  density: number;
  /** 1/f corner density at 1 Hz. */
  flicker?: number;
  bwLow?: number;
  bwHigh?: number;
}

export interface GeneratorSettings {
  waveform: GeneratorWaveform;
  /** DC offset, in the source unit. */
  offset?: number;
  /** Peak amplitude (sine), or half the swing (square/pulse), in the source unit. */
  amplitude?: number;
  /** Frequency, Hz (carrier for a modulated waveform). */
  frequency?: number;
  /** Phase, degrees. */
  phase?: number;
  /** Duty cycle 0…1 (square/pulse/clock). */
  duty?: number;
  /** Rise time 10–90 %, s. */
  riseTime?: number;
  /** Fall time 90–10 %, s. */
  fallTime?: number;
  /** Start delay, s. */
  delay?: number;
  /** Source series resistance, Ω (0 = ideal). */
  sourceResistance?: number;
  sweep?: SweepSettings;
  modulation?: ModulationSettings;
  burst?: BurstSettings;
  noise?: NoiseSettings;
  /**
   * For a synthesised waveform: how long to bake, s. Defaults to the sweep duration,
   * ten carrier periods, or 1 ms.
   */
  duration?: number;
  /** Table points for a synthesised waveform (2…100 000). Default 2 000. */
  points?: number;
  /** Explicit table for `arbitrary`. */
  table?: Float64Array | string;
  /** Seed for the noise preview, so two runs of a preview agree. */
  seed?: number | string;
  /** High level for the `clock` primitive, which takes levels rather than amplitude. */
  highLevel?: number;
  lowLevel?: number;
}

export interface GeneratorDescription {
  waveform: GeneratorWaveform;
  /** How the waveform reaches the solver. */
  delivery: 'native' | 'piecewise-linear table';
  unit: string;
  /** The parameters to write into the source component. */
  params: Record<string, unknown>;
  /** For a table: its length in points and the time it covers. */
  table: { points: number; duration: number; interval: number } | null;
  /** The frequency the delivery can represent, Hz; null when unlimited (native). */
  bandwidthLimitHz: number | null;
  accuracy: Accuracy;
  /** One line per approximation this delivery makes. */
  limits: string[];
}

/** A generator configured with one set of settings. */
export class SignalGenerator {
  readonly settings: Required<Pick<GeneratorSettings, 'waveform'>> & GeneratorSettings;
  private readonly unit: 'V' | 'A';

  /**
   * @param unit 'V' for a voltage source (`vsignal`), 'A' for a current source (`isignal`).
   */
  constructor(settings: GeneratorSettings, unit: 'V' | 'A' = 'V') {
    this.settings = { ...settings };
    this.unit = unit;
  }

  /** The spec id this generator should be written into. */
  get specId(): string {
    if (this.settings.waveform === 'clock') return 'clock';
    if (this.settings.waveform === 'noise') return 'noise_source';
    return this.unit === 'A' ? 'isignal' : 'vsignal';
  }

  /**
   * Instantaneous value at time t, evaluated analytically.
   *
   * For a native waveform this is exactly what the solver computes. For a
   * synthesised one it is the *ideal* waveform, which the table only approximates —
   * so `value()` is the reference the table is checked against, not a promise about
   * what the circuit will see.
   */
  value(t: number, rng?: Rng): number {
    const s = this.settings;
    const offset = s.offset ?? 0;
    const amp = s.amplitude ?? 1;
    const f = s.frequency ?? 1000;
    const phase = ((s.phase ?? 0) * Math.PI) / 180;
    const delay = s.delay ?? 0;
    const tt = t - delay;
    if (tt < 0) return offset;
    switch (s.waveform) {
      case 'dc':
        return offset + amp;
      case 'sine':
        return offset + amp * Math.sin(2 * Math.PI * f * tt + phase);
      case 'square':
      case 'pulse':
      case 'clock': {
        const period = 1 / Math.max(1e-12, f);
        const duty = clamp01(s.duty ?? 0.5);
        const tr = Math.max(0, s.riseTime ?? 0);
        const tf = Math.max(0, s.fallTime ?? 0);
        const x = tt - Math.floor(tt / period) * period;
        const th = duty * period;
        // The solver's own trapezoid: rise centred on the period boundary, fall
        // centred on the duty boundary. Reproduced here so `value()` agrees with the
        // simulation sample for sample.
        const rise = Math.max(1e-15, tr);
        const fall = Math.max(1e-15, tf);
        let v: number;
        if (x < th - fall / 2) v = 1;
        else if (x < th + fall / 2) v = 1 - (x - (th - fall / 2)) / fall;
        else if (x < period - rise / 2) v = 0;
        else v = (x - (period - rise / 2)) / rise;
        v = Math.max(0, Math.min(1, v));
        return offset + amp * v;
      }
      case 'triangle': {
        const period = 1 / Math.max(1e-12, f);
        const x = (tt - Math.floor(tt / period) * period) / period;
        return offset + amp * (x < 0.5 ? 4 * x - 1 : 3 - 4 * x);
      }
      case 'sawtooth': {
        const period = 1 / Math.max(1e-12, f);
        const x = (tt - Math.floor(tt / period) * period) / period;
        return offset + amp * (2 * x - 1);
      }
      case 'noise': {
        const density = s.noise?.density ?? 10e-9;
        const bwLow = s.noise?.bwLow ?? 0;
        const bwHigh = s.noise?.bwHigh ?? 1e6;
        const bw = Math.max(bwHigh - bwLow, 0);
        // σ = density·√BW, the same scaling the solver's noise element uses.
        const sigma = density * Math.sqrt(bw);
        // The RNG's own Gaussian, which is the same draw the solver's noise element
        // uses: a preview that sampled differently would not match the simulation.
        const r = rng ?? new Rng(s.seed ?? 'generator-noise');
        return offset + r.normal() * sigma;
      }
      case 'chirp': {
        const sw = s.sweep ?? { start: f, stop: f * 2, seconds: 1 };
        const duration = Math.max(sw.seconds, 1e-12);
        if (tt > duration) return offset + this.chirpValue(duration, sw, phase, amp);
        return offset + this.chirpValue(tt, sw, phase, amp);
      }
      case 'am': {
        const m = s.modulation ?? { freq: f / 10, depth: 0.5 };
        const depth = clamp01(m.depth);
        const envelope = 1 - depth / 2 + (depth / 2) * Math.cos(2 * Math.PI * m.freq * tt);
        // Standard AM: the carrier is scaled by (1 + m·cos)/normalised so that
        // depth = 1 reaches zero and depth = 0 is an unmodulated carrier at `amp`.
        return offset + amp * envelope * Math.sin(2 * Math.PI * f * tt + phase);
      }
      case 'fm': {
        const m = s.modulation ?? { freq: f / 10, depth: f / 10 };
        // Instantaneous frequency f + Δf·cos(2π fm t); the phase is its integral.
        const phaseDev = m.depth / Math.max(m.freq, 1e-12);
        return offset + amp * Math.sin(2 * Math.PI * f * tt + phaseDev * Math.sin(2 * Math.PI * m.freq * tt) + phase);
      }
      case 'burst': {
        const b = s.burst ?? { cycles: 10 };
        const period = 1 / Math.max(1e-12, f);
        const burstLength = b.cycles * period;
        const repeat = b.repeatPeriod && b.repeatPeriod > burstLength ? b.repeatPeriod : 0;
        if (repeat > 0) {
          const x = tt - Math.floor(tt / repeat) * repeat;
          if (x > burstLength) return offset;
          return offset + amp * Math.sin(2 * Math.PI * f * x + phase);
        }
        if (tt > burstLength) return offset;
        return offset + amp * Math.sin(2 * Math.PI * tt * f + phase);
      }
      case 'arbitrary': {
        const table = this.table();
        return table ? offset + evalTable(table, tt) : offset;
      }
    }
  }

  private chirpValue(t: number, sw: SweepSettings, phase: number, amp: number): number {
    const duration = Math.max(sw.seconds, 1e-12);
    const x = Math.min(1, Math.max(0, t / duration));
    if (sw.kind === 'logarithmic' && sw.start > 0 && sw.stop > 0) {
      // f(t) = f0·(f1/f0)^x; the phase is its integral, which for an exponential
      // sweep is f0·duration/ln(f1/f0)·((f1/f0)^x − 1).
      const ratio = sw.stop / sw.start;
      const ln = Math.log(ratio);
      const inst = sw.start * Math.pow(ratio, x);
      const ph = ln === 0 ? 2 * Math.PI * sw.start * t : (2 * Math.PI * sw.start * duration) / ln * (Math.pow(ratio, x) - 1);
      return amp * Math.sin(ph + phase) * (inst > 0 ? 1 : 1);
    }
    // Linear sweep f(t) = f0 + (f1−f0)·x; phase = 2π(f0·t + (f1−f0)·t²/(2·duration)).
    const k = (sw.stop - sw.start) / duration;
    const ph = 2 * Math.PI * (sw.start * t + (k * t * t) / 2);
    return amp * Math.sin(ph + phase);
  }

  /**
   * The PWL table for a synthesised waveform, or null for a native one.
   *
   * The sampling interval is chosen from the fastest thing in the waveform — the
   * carrier, the sweep end, the modulation, or the edges — so that the table holds
   * at least `pointsPerCycle` samples of the highest frequency present. Asking for
   * fewer points than that would alias the waveform, and the generator would then be
   * delivering something other than what it describes.
   */
  table(pointsPerCycle = 20): Float64Array | null {
    const s = this.settings;
    if (s.waveform === 'arbitrary') {
      if (typeof s.table === 'string') return parseArbitraryWaveform(s.table);
      if (s.table instanceof Float64Array) return s.table.length >= 4 ? s.table : null;
      return null;
    }
    if ((NATIVE_WAVEFORMS as readonly string[]).includes(s.waveform)) return null;
    const duration = this.duration();
    const fMax = this.highestFrequency();
    const needed = Math.max(2, Math.ceil(duration * fMax * pointsPerCycle));
    const points = Math.min(Math.max(s.points ?? 2000, Math.min(needed, 100_000)), 100_000);
    const n = Math.max(2, points);
    const out = new Float64Array(n * 2);
    const rng = new Rng(s.seed ?? 'generator');
    for (let i = 0; i < n; i++) {
      const t = (duration * i) / (n - 1);
      out[i * 2] = t;
      // `value()` includes the offset; the table carries the AC part only, because
      // the source adds `dc` to whatever the table returns.
      out[i * 2 + 1] = this.valueAtNoOffset(t, rng);
    }
    return out;
  }

  private valueAtNoOffset(t: number, rng: Rng): number {
    const offset = this.settings.offset ?? 0;
    return this.value(t + (this.settings.delay ?? 0), rng) - offset;
  }

  /** The highest frequency present in the waveform, Hz. */
  highestFrequency(): number {
    const s = this.settings;
    const carrier = s.frequency ?? 1000;
    switch (s.waveform) {
      case 'chirp':
        return Math.max(s.sweep?.start ?? carrier, s.sweep?.stop ?? carrier * 2);
      case 'am':
        // The AM spectrum has the carrier and two sidebands at ±fm.
        return carrier + (s.modulation?.freq ?? carrier / 10);
      case 'fm': {
        // Carson's rule: the occupied bandwidth is 2(Δf + fm), so the highest
        // significant component sits about Δf + fm above the carrier.
        const dev = s.modulation?.depth ?? carrier / 10;
        const fm = s.modulation?.freq ?? carrier / 10;
        return carrier + dev + fm;
      }
      case 'burst':
        return carrier;
      default:
        return carrier;
    }
  }

  /** How long a synthesised waveform is baked for, s. */
  duration(): number {
    const s = this.settings;
    if (Number.isFinite(s.duration) && (s.duration ?? 0) > 0) return s.duration as number;
    if (s.waveform === 'chirp' && s.sweep) return Math.max(s.sweep.seconds, 1e-9);
    if (s.waveform === 'burst') {
      const period = 1 / Math.max(1e-12, s.frequency ?? 1000);
      const burst = (s.burst?.cycles ?? 10) * period;
      const repeat = s.burst?.repeatPeriod ?? 0;
      return repeat > burst ? Math.max(repeat, burst) : burst;
    }
    const period = 1 / Math.max(1e-12, s.frequency ?? 1000);
    return Math.max(10 * period, 1e-6);
  }

  /**
   * The parameters to write into the source component.
   *
   * For a native waveform these are the generator's own settings mapped onto the
   * primitive's parameter names. For a synthesised one the table is baked and put in
   * the `arbitrary` parameter with `waveform: 'arbitrary'`.
   */
  params(): Record<string, unknown> {
    const s = this.settings;
    const unit = this.unit;
    if (s.waveform === 'clock') {
      const high = s.highLevel ?? (s.offset ?? 0) + (s.amplitude ?? 3.3);
      const low = s.lowLevel ?? (s.offset ?? 0);
      return {
        freq: positive(s.frequency ?? 1e6, 1e-3),
        vhigh: high,
        vlow: low,
        duty: clamp(s.duty ?? 0.5, 0.001, 0.999),
        tr: Math.max(0, s.riseTime ?? 1e-9),
        tf: Math.max(0, s.fallTime ?? 1e-9),
        rs: Math.max(0, s.sourceResistance ?? 0),
        jitter: 0,
        delay: Math.max(0, s.delay ?? 0),
      };
    }
    if (s.waveform === 'noise') {
      return {
        mode: unit === 'A' ? 'current' : 'voltage',
        density: Math.max(0, s.noise?.density ?? 10e-9),
        flicker: Math.max(0, s.noise?.flicker ?? 0),
        bwLow: Math.max(0, s.noise?.bwLow ?? 0),
        bwHigh: Math.max(0, s.noise?.bwHigh ?? 1e6),
      };
    }
    const native = (NATIVE_WAVEFORMS as readonly string[]).includes(s.waveform);
    const base: Record<string, unknown> = {
      dc: s.offset ?? 0,
      amp: s.amplitude ?? (unit === 'A' ? 1e-3 : 1),
      freq: Math.max(0, s.frequency ?? 1000),
      phase: s.phase ?? 0,
      duty: clamp01(s.duty ?? 0.5),
      tr: Math.max(0, s.riseTime ?? 1e-9),
      tf: Math.max(0, s.fallTime ?? 1e-9),
      delay: s.delay ?? 0,
      rs: Math.max(0, s.sourceResistance ?? 0),
      ac: unit === 'A' ? 1e-3 : 1,
    };
    if (native) {
      base['waveform'] = s.waveform;
      base['arbitrary'] = '';
      return base;
    }
    const table = this.table();
    base['waveform'] = 'arbitrary';
    base['arbitrary'] = table ? formatArbitraryWaveform(table) : '';
    // The table carries the waveform's own frequency content, so the source's
    // `freq` is not used; leaving a stale frequency in the parameters would mislead
    // anyone reading the saved circuit.
    base['freq'] = 0;
    base['amp'] = 0;
    return base;
  }

  /** What this generator delivers, and what that costs. */
  describe(): GeneratorDescription {
    const s = this.settings;
    const native = (NATIVE_WAVEFORMS as readonly string[]).includes(s.waveform);
    const limits: string[] = [];
    let table: GeneratorDescription['table'] = null;
    let bandwidth: number | null = null;
    if (native) {
      limits.push('the solver evaluates this waveform analytically at every iteration: no sampling and no interpolation error');
      if (s.waveform === 'square' || s.waveform === 'pulse' || s.waveform === 'clock') {
        limits.push('the edges are linear ramps between the 10 % and 90 % points; a real driver is closer to a tanh, so the delay through a threshold differs by up to ~10 % of the transition time');
        limits.push('the waveform is not band-limited: an instantaneous edge has infinite spectral content, and what the circuit sees is limited by the solver step, not by the generator');
      }
      if (s.waveform === 'noise') {
        limits.push('noise is Gaussian white (plus an optional 1/f term) scaled by σ = density·√BW: it reproduces the spectral density in the band, not a phase-noise spectrum or an arbitrary mask');
        limits.push('the samples are drawn from the seeded RNG, so two runs agree — which a real noise source does not');
      }
    } else {
      const t = this.table();
      if (t) {
        const points = t.length / 2;
        const duration = t[t.length - 2];
        const interval = points > 1 ? duration / (points - 1) : 0;
        table = { points, duration, interval };
        bandwidth = interval > 0 ? 0.5 / interval : null;
        limits.push(
          `delivered as a ${points}-point piecewise-linear table covering ${formatSeconds(duration)} (one point every ${formatSeconds(interval)}), ` +
            `interpolated linearly by the solver: content above ~${bandwidth !== null ? formatHz(bandwidth) : '—'} is not represented`,
        );
        limits.push(`the table was sampled at ≥20 points per cycle of the highest frequency present (${formatHz(this.highestFrequency())}), so the shape is not aliased — but it is a polygon, not the analytic curve`);
        limits.push('the table does not repeat: past its last point the source holds the final value. Bake a longer table for a longer run.');
      } else {
        limits.push('no table could be built from these settings, so the source will hold its DC offset — check the sweep, modulation or table parameters');
      }
      if (s.waveform === 'fm') {
        limits.push('FM is generated as the exact phase integral of the instantaneous frequency (Carson bandwidth quoted for the table sampling), not by a PLL or a lookup of Bessel sidebands');
      }
      if (s.waveform === 'chirp') {
        limits.push(s.sweep?.kind === 'logarithmic' ? 'the logarithmic sweep uses the exact exponential-sweep phase integral' : 'the linear sweep uses the exact quadratic phase integral');
      }
      if (s.waveform === 'burst') {
        limits.push('a burst is a gated sine: the envelope is a rectangle, so the spectrum has the sinc side lobes of a hard gate (no raised-cosine ramp is applied unless the caller bakes one)');
      }
    }
    if ((s.sourceResistance ?? 0) === 0) {
      limits.push('source resistance is 0 (an ideal source): it holds its voltage regardless of the load, which no real generator does');
    }
    return {
      waveform: s.waveform,
      delivery: native ? 'native' : 'piecewise-linear table',
      unit: this.unit,
      params: this.params(),
      table,
      bandwidthLimitHz: bandwidth,
      accuracy: native ? Accuracy.APPROXIMATED : Accuracy.APPROXIMATED,
      limits,
    };
  }

  /**
   * Write this generator into a source instance of a circuit.
   *
   * The instance is mutated in place (that is what a front-panel control means) and
   * returned. Parameters the target spec does not declare are dropped rather than
   * stored, so a `clock` generator written into a `clock` component does not leave
   * `arbitrary` behind.
   */
  applyTo(circuit: Circuit, ref: string): ComponentInstance | null {
    const inst = findInstance(circuit, ref);
    if (!inst) return null;
    const params = this.params();
    for (const [k, v] of Object.entries(params)) inst.params[k] = v as ParamBag[string];
    return inst;
  }

  /** The text readout of a generator, as shown on its front panel. */
  toText(): string {
    const d = this.describe();
    const s = this.settings;
    const out: string[] = ['SIGNAL GENERATOR'];
    out.push(`  waveform  ${d.waveform} (${d.delivery})`);
    const lines: string[] = [];
    if (s.offset !== undefined) lines.push(`offset ${formatReading(s.offset, d.unit)}`);
    if (s.amplitude !== undefined) lines.push(`amplitude ${formatReading(s.amplitude, d.unit)} peak`);
    if (s.frequency !== undefined) lines.push(`frequency ${formatHz(s.frequency)}`);
    if (s.phase !== undefined && s.phase !== 0) lines.push(`phase ${s.phase.toFixed(1)}°`);
    if (s.duty !== undefined) lines.push(`duty ${(s.duty * 100).toFixed(1)} %`);
    if (s.riseTime !== undefined) lines.push(`rise ${formatSeconds(s.riseTime)}`);
    if (s.fallTime !== undefined) lines.push(`fall ${formatSeconds(s.fallTime)}`);
    if (s.delay !== undefined && s.delay !== 0) lines.push(`delay ${formatSeconds(s.delay)}`);
    if (s.sourceResistance !== undefined) lines.push(`source R ${formatReading(s.sourceResistance, 'Ω')}`);
    if (s.sweep) lines.push(`sweep ${formatHz(s.sweep.start)} → ${formatHz(s.sweep.stop)} in ${formatSeconds(s.sweep.seconds)} (${s.sweep.kind ?? 'linear'})`);
    if (s.modulation) lines.push(`${s.waveform === 'fm' ? 'deviation' : 'depth'} ${s.waveform === 'fm' ? formatHz(s.modulation.depth) : `${(s.modulation.depth * 100).toFixed(1)} %`} at ${formatHz(s.modulation.freq)}`);
    if (s.burst) lines.push(`burst ${s.burst.cycles} cycle(s)${s.burst.repeatPeriod ? ` every ${formatSeconds(s.burst.repeatPeriod)}` : ''}`);
    if (s.noise) lines.push(`noise density ${s.noise.density.toExponential(3)} ${d.unit}/√Hz over ${formatHz(s.noise.bwLow ?? 0)}…${formatHz(s.noise.bwHigh ?? 1e6)}`);
    if (lines.length) out.push(`  ${lines.join('  ')}`);
    if (d.table) out.push(`  table     ${d.table.points} points over ${formatSeconds(d.table.duration)} (Δt ${formatSeconds(d.table.interval)})`);
    if (d.bandwidthLimitHz !== null) out.push(`  bandwidth ${formatHz(d.bandwidthLimitHz)} (set by the table interval)`);
    out.push(`  accuracy  ${d.accuracy}`);
    for (const l of d.limits) out.push(`  limit: ${l}`);
    return out.join('\n');
  }
}

/**
 * Find a component instance on a sheet by reference designator, id or label.
 *
 * The reference designator is what a user reads off the schematic, so it comes
 * first; the id and the label are fallbacks for generated circuits where the ref was
 * not assigned meaningfully.
 */
function findInstance(circuit: Circuit, ref: string): ComponentInstance | null {
  let found: ComponentInstance | null = null;
  const fallback: ComponentInstance[] = [];
  circuit.forEachComponent((inst) => {
    if (found) return;
    if (inst.ref === ref) found = inst;
    else if (String(inst.id) === ref || inst.label === ref) fallback.push(inst);
  });
  return found ?? fallback[0] ?? null;
}

function evalTable(table: Float64Array, t: number): number {
  const n = table.length >> 1;
  if (n === 0) return 0;
  if (t <= table[0]) return table[1];
  const last = (n - 1) * 2;
  if (t >= table[last]) return table[last + 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid * 2] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = table[lo * 2];
  const t1 = table[hi * 2];
  const span = t1 - t0;
  if (!(span > 0)) return table[lo * 2 + 1];
  return table[lo * 2 + 1] + ((t - t0) / span) * (table[hi * 2 + 1] - table[lo * 2 + 1]);
}



function clamp01(v: number): number {
  return clamp(Number.isFinite(v) ? v : 0, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function positive(v: number, min: number): number {
  return Number.isFinite(v) && v > 0 ? v : min;
}

/** Preset generators for the common bench cases. */
export const GENERATOR_PRESETS: Record<string, GeneratorSettings> = {
  'mains 50 Hz': { waveform: 'sine', amplitude: 325, frequency: 50, offset: 0 },
  'mains 60 Hz': { waveform: 'sine', amplitude: 170, frequency: 60, offset: 0 },
  'audio 1 kHz': { waveform: 'sine', amplitude: 1, frequency: 1000 },
  'logic clock 1 MHz': { waveform: 'clock', amplitude: 3.3, frequency: 1e6, duty: 0.5, riseTime: 1e-9, fallTime: 1e-9 },
  'logic clock 10 MHz': { waveform: 'clock', amplitude: 3.3, frequency: 1e7, duty: 0.5, riseTime: 5e-10, fallTime: 5e-10 },
  'step 3.3 V': { waveform: 'pulse', amplitude: 3.3, frequency: 100, duty: 0.5, riseTime: 1e-12, fallTime: 1e-12 },
  'sweep 1 Hz–1 MHz': { waveform: 'chirp', amplitude: 1, sweep: { start: 1, stop: 1e6, seconds: 1e-3, kind: 'logarithmic' }, points: 20000 },
  'AM 1 MHz / 1 kHz 80 %': { waveform: 'am', amplitude: 1, frequency: 1e6, modulation: { freq: 1000, depth: 0.8 } },
  'FM 10 MHz ±75 kHz': { waveform: 'fm', amplitude: 1, frequency: 1e7, modulation: { freq: 1000, depth: 75e3 } },
  'burst 5 MHz × 20': { waveform: 'burst', amplitude: 1, frequency: 5e6, burst: { cycles: 20 } },
  'white noise 10 nV/√Hz': { waveform: 'noise', noise: { density: 10e-9, bwLow: 0, bwHigh: 1e6 } },
};
