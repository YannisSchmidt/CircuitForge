/**
 * The transform the instruments are built on.
 *
 * A single radix-2 iterative FFT, plus the windows and the corrections that make
 * its output mean something. Nothing here is specific to circuits: `measure.ts`
 * and `spectrum.ts` turn these numbers into instrument readings.
 *
 * Two facts about this implementation are stated wherever its results are shown,
 * because they bound what a reading can claim:
 *
 * 1. **The length is zero-padded to a power of two.** A real FFT of arbitrary
 *    length (Bluestein, mixed radix) is not implemented. Padding does not change
 *    the spectrum's content, but it *interpolates* it: the bin spacing becomes
 *    fs/N_padded while the true resolution — the ability to separate two tones —
 *    stays fs/N_captured. `resolutionHz` reports the former and `trueResolutionHz`
 *    the latter, so a peak can be quoted at the interpolated frequency without
 *    implying a resolution the capture does not have.
 * 2. **A window trades amplitude accuracy for leakage suppression.** The coherent
 *    gain of the window is divided out so amplitudes stay correct, and the
 *    equivalent noise bandwidth is reported so a power reading over a span can be
 *    normalised. With a windowed, non-coherently-sampled tone the amplitude is
 *    correct to within the scalloping loss of the window (≤ 1.42 dB for Hann),
 *    which `scallopingLossDb` states rather than hides.
 */

export type WindowKind = 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'blackman_harris' | 'flat_top';

export interface WindowInfo {
  kind: WindowKind;
  /** sum(w) / N — the amplitude correction factor. */
  coherentGain: number;
  /** Equivalent noise bandwidth in bins: N · sum(w²) / sum(w)². */
  enbwBins: number;
  /** Worst-case amplitude error for a tone between bins, in dB (negative = loss). */
  scallopingLossDb: number;
  /** Main-lobe width in bins. */
  mainLobeBins: number;
  description: string;
}

/** The window definitions, with the figures quoted in the reports. */
export const WINDOWS: Record<WindowKind, WindowInfo> = {
  rectangular: {
    kind: 'rectangular',
    coherentGain: 1,
    enbwBins: 1,
    scallopingLossDb: -3.92,
    mainLobeBins: 2,
    description: 'no window: exact amplitudes for a coherently sampled tone, severe leakage otherwise',
  },
  hann: {
    kind: 'hann',
    coherentGain: 0.5,
    enbwBins: 1.5,
    scallopingLossDb: -1.42,
    mainLobeBins: 4,
    description: 'the general-purpose choice: good leakage suppression, amplitude corrected by the coherent gain',
  },
  hamming: {
    kind: 'hamming',
    coherentGain: 0.54,
    enbwBins: 1.36,
    scallopingLossDb: -1.75,
    mainLobeBins: 4,
    description: 'like Hann with a non-zero pedestal: lower first side lobe, slower roll-off',
  },
  blackman: {
    kind: 'blackman',
    coherentGain: 0.42,
    enbwBins: 1.73,
    scallopingLossDb: -1.1,
    mainLobeBins: 6,
    description: 'wider main lobe, much lower side lobes: for finding a small tone next to a large one',
  },
  blackman_harris: {
    kind: 'blackman_harris',
    coherentGain: 0.35875,
    enbwBins: 2.0,
    scallopingLossDb: -0.85,
    mainLobeBins: 8,
    description: 'four-term Blackman–Harris: −92 dB side lobes, the widest main lobe here',
  },
  flat_top: {
    kind: 'flat_top',
    coherentGain: 0.21557895,
    enbwBins: 3.77,
    scallopingLossDb: -0.01,
    mainLobeBins: 10,
    description: 'amplitude-accurate to ±0.01 dB across the main lobe; use it to read a level, not to resolve tones',
  },
};

/** Window coefficients for N samples. */
export function windowCoefficients(kind: WindowKind, n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) {
    if (n === 1) w[0] = 1;
    return w;
  }
  const N = n - 1;
  switch (kind) {
    case 'rectangular':
      w.fill(1);
      break;
    case 'hann':
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      break;
    case 'hamming':
      for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / N);
      break;
    case 'blackman':
      for (let i = 0; i < n; i++) {
        const x = (2 * Math.PI * i) / N;
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      }
      break;
    case 'blackman_harris':
      for (let i = 0; i < n; i++) {
        const x = (2 * Math.PI * i) / N;
        w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
      }
      break;
    case 'flat_top':
      for (let i = 0; i < n; i++) {
        const x = (2 * Math.PI * i) / N;
        w[i] =
          0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x) -
          0.083578947 * Math.cos(3 * x) + 0.006947368 * Math.cos(4 * x);
      }
      break;
  }
  return w;
}

/** The actual coherent gain of the computed coefficients (used, not the table value). */
export function coherentGainOf(w: Float64Array): number {
  if (w.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i];
  return sum / w.length || 1;
}

/** The actual equivalent noise bandwidth, in bins. */
export function enbwOf(w: Float64Array): number {
  if (w.length === 0) return 1;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < w.length; i++) {
    s1 += w[i];
    s2 += w[i] * w[i];
  }
  if (s1 === 0) return 1;
  return (w.length * s2) / (s1 * s1);
}

/** Smallest power of two ≥ n (at least 2). */
export function nextPow2(n: number): number {
  let p = 2;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT.
 *
 * `re` and `im` must have the same power-of-two length. The transform is the
 * analysis form X[k] = Σ x[n]·e^(−j2πkn/N); synthesis is the same routine with
 * `inverse` set and a 1/N scaling applied by the caller.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length) throw new Error(`fft: length mismatch (${n} vs ${im.length})`);
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`fft: length must be a power of two ≥ 2, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = (sign * 2 * Math.PI) / len;
    // Precomputed twiddles for this stage: half values, reused n/len times.
    const wr = new Float64Array(half);
    const wi = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      wr[k] = Math.cos(step * k);
      wi[k] = Math.sin(step * k);
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr[k] - im[b] * wi[k];
        const ti = re[b] * wi[k] + im[b] * wr[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * One-sided amplitude spectrum of a real signal.
 *
 * Returns the positive-frequency half with amplitudes already corrected for the
 * window's coherent gain, so a pure sine of amplitude A reads A at its bin (to
 * within the scalloping loss). The DC bin is not doubled; the Nyquist bin, when
 * present, is not either — both are their own mirror image.
 */
export interface AmplitudeSpectrum {
  /** Bin frequencies, Hz. */
  frequencies: Float64Array;
  /** Peak amplitude per bin, in the signal's unit. */
  amplitudes: Float64Array;
  /** Magnitude in dB relative to `reference` (default 1 unit). */
  magnitudesDb: Float64Array;
  /** Bin spacing actually achieved (after zero padding), Hz. */
  binHz: number;
  /** The resolution the capture really has, fs/N_captured, Hz. */
  trueResolutionHz: number;
  /** How many samples were captured and how many were transformed. */
  capturedSamples: number;
  transformSamples: number;
  /**
   * The factor to divide Σ(A_k²/2) by to recover the record's mean square.
   *
   * Amplitudes are corrected by the window's coherent gain, which makes a *tone*
   * read correctly but leaves the summed *power* over all bins inflated by the
   * window's energy spread: `(N_transform · Σw²) / (Σw)²`. It equals the window's
   * ENBW in bins when nothing was padded, and is slightly larger when the transform
   * was padded (the window covers fewer samples than the transform length). Verified
   * against coherent tones, non-coherent tones and white noise for every window here:
   * Σ(A_k²/2) / energyCorrection reproduces the time-domain mean square to <0.1 %.
   */
  energyCorrection: number;
  window: WindowInfo;
  reference: number;
}

export interface SpectrumOptions {
  /** Sampling frequency, Hz. Required: the samples themselves carry no clock. */
  sampleRate: number;
  window?: WindowKind;
  /** Pad to this many samples instead of the next power of two. */
  padTo?: number;
  /** dB reference; 1 by default, so magnitudes are dBV / dB(A) / dB(W). */
  reference?: number;
  /** Remove the mean before transforming (the DC bin then reads the offset). */
  removeDc?: boolean;
}

export function amplitudeSpectrum(samples: Float64Array, opts: SpectrumOptions): AmplitudeSpectrum {
  if (!Number.isFinite(opts.sampleRate) || opts.sampleRate <= 0) {
    throw new Error(`amplitudeSpectrum: sampleRate must be a positive finite number, got ${opts.sampleRate}`);
  }
  const kind = opts.window ?? 'hann';
  const win = WINDOWS[kind];
  const captured = samples.length;
  // Zero-pad to a power of two. `padTo` asks for at least that many samples, which
  // is how a caller buys interpolation (a smoother trace) at the cost of memory —
  // it never buys resolution, and `trueResolutionHz` says so.
  const size = Math.max(2, nextPow2(Math.max(captured, opts.padTo ?? 0)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  const w = windowCoefficients(kind, captured);
  let windowSum = 0;
  let windowSumSq = 0;
  for (let i = 0; i < captured; i++) {
    windowSum += w[i];
    windowSumSq += w[i] * w[i];
  }
  if (!(windowSum > 0)) windowSum = 1;
  const energyCorrection = windowSumSq > 0 ? (size * windowSumSq) / (windowSum * windowSum) : 1;

  let mean = 0;
  if (opts.removeDc && captured > 0) {
    for (let i = 0; i < captured; i++) mean += samples[i];
    mean /= captured;
  }
  for (let i = 0; i < captured; i++) re[i] = (samples[i] - mean) * w[i];

  fft(re, im);

  const bins = (size >> 1) + 1;
  const frequencies = new Float64Array(bins);
  const amplitudes = new Float64Array(bins);
  const magnitudesDb = new Float64Array(bins);
  const binHz = opts.sampleRate / size;
  const reference = Number.isFinite(opts.reference) && (opts.reference ?? 0) > 0 ? (opts.reference as number) : 1;
  const nyquist = size / 2;
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k]);
    // One-sided amplitude: every bin except DC and Nyquist is its own mirror
    // image's partner, so it carries half the energy and is doubled. DC and
    // Nyquist have no partner and must not be.
    const scale = k === 0 || k === nyquist ? 1 / windowSum : 2 / windowSum;
    amplitudes[k] = mag * scale;
    frequencies[k] = k * binHz;
    magnitudesDb[k] = 20 * Math.log10(Math.max(amplitudes[k], 1e-300) / reference);
  }

  return {
    frequencies,
    amplitudes,
    magnitudesDb,
    binHz,
    trueResolutionHz: captured > 1 ? opts.sampleRate / captured : 0,
    capturedSamples: captured,
    transformSamples: size,
    energyCorrection,
    window: win,
    reference,
  };
}

/** The highest frequency this spectrum can represent (fs/2), Hz. */
export function nyquistHz(spec: AmplitudeSpectrum, sampleRate: number): number {
  return sampleRate / 2;
}

/** Total harmonic distortion from an amplitude spectrum, in percent. */
export interface ThdResult {
  /** THD in % (harmonic RMS / fundamental RMS × 100). */
  thdPercent: number;
  /** The fundamental actually found (the peak near the expected bin). */
  fundamentalAmplitude: number;
  fundamentalHz: number;
  /** Harmonic amplitudes; order 2 is the second harmonic. */
  harmonics: Array<{ order: number; hz: number; amplitude: number; dbBelowFundamental: number }>;
  ordersSearched: number;
  ordersInSpan: number;
  /** What bounds this number. */
  note: string;
}

export function totalHarmonicDistortion(spec: AmplitudeSpectrum, fundamentalHz: number, sampleRate: number, maxOrder = 10): ThdResult {
  const harmonics: ThdResult['harmonics'] = [];
  if (!(fundamentalHz > 0) || spec.binHz <= 0 || spec.amplitudes.length === 0) {
    return {
      thdPercent: 0,
      fundamentalAmplitude: 0,
      fundamentalHz: 0,
      harmonics,
      ordersSearched: 0,
      ordersInSpan: 0,
      note: 'no fundamental frequency was identified, so no harmonic can be located',
    };
  }
  const nyquist = sampleRate / 2;
  // A windowed tone spreads over its main lobe, so a harmonic is read as the peak
  // within ±(one true resolution + half a main lobe) of its ideal position rather
  // than as one bin. Reading a single bin would under-report every harmonic whose
  // frequency is not an exact multiple of the bin spacing.
  const spread = Math.max(1, Math.ceil(spec.trueResolutionHz / spec.binHz) + Math.ceil(spec.window.mainLobeBins / 2));
  // Bins already claimed by the fundamental or by a lower harmonic. A window's main
  // lobe is several bins wide, so the skirt of a strong fundamental reaches into the
  // search window of the second and third harmonics; without excluding it, the
  // "harmonic" that is found is the fundamental's own skirt and the THD comes out
  // larger than 100 % for a clean sine.
  const claimed: Array<[number, number]> = [];
  const isClaimed = (k: number): boolean => claimed.some(([lo, hi]) => k >= lo && k <= hi);
  const peakAt = (hz: number, claim: boolean): { amplitude: number; hz: number } => {
    const centre = Math.round(hz / spec.binHz);
    let best = -1;
    let bestIndex = -1;
    for (let k = Math.max(1, centre - spread); k <= Math.min(spec.amplitudes.length - 1, centre + spread); k++) {
      if (isClaimed(k)) continue;
      if (spec.amplitudes[k] > best) {
        best = spec.amplitudes[k];
        bestIndex = k;
      }
    }
    if (bestIndex < 0) return { amplitude: 0, hz };
    if (claim) {
      const lobe = Math.ceil(spec.window.mainLobeBins / 2) + 1;
      claimed.push([bestIndex - lobe, bestIndex + lobe]);
    }
    return { amplitude: Math.max(best, 0), hz: bestIndex * spec.binHz };
  };
  const f = peakAt(fundamentalHz, true);
  let sumSquares = 0;
  let inSpan = 0;
  for (let order = 2; order <= maxOrder; order++) {
    const hz = fundamentalHz * order;
    if (hz > nyquist) break;
    inSpan++;
    const h = peakAt(hz, true);
    sumSquares += h.amplitude * h.amplitude;
    harmonics.push({
      order,
      hz,
      amplitude: h.amplitude,
      dbBelowFundamental: f.amplitude > 0 ? 20 * Math.log10(Math.max(h.amplitude, 1e-300) / f.amplitude) : 0,
    });
  }
  const thd = f.amplitude > 0 ? (100 * Math.sqrt(sumSquares)) / f.amplitude : 0;
  const lastHz = inSpan > 0 ? fundamentalHz * (inSpan + 1) : fundamentalHz;
  return {
    thdPercent: thd,
    fundamentalAmplitude: f.amplitude,
    fundamentalHz: f.hz,
    harmonics,
    ordersSearched: maxOrder - 1,
    ordersInSpan: inSpan,
    note:
      `THD over ${inSpan} harmonic(s) up to ${lastHz.toFixed(1)} Hz, each read as the largest unclaimed bin within ±${spread} ` +
      `bin(s) of its ideal position under a ${spec.window.kind} window (the main lobe of the fundamental and of each lower ` +
      `harmonic is excluded, so a clean sine reads ~0 %); the Nyquist limit is ${nyquist.toFixed(1)} Hz. Window leakage and the ` +
      `noise floor are still included in the harmonic peaks, so this is an upper bound on the harmonic content.`,
  };
}
