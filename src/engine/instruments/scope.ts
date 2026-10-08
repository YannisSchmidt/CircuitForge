/**
 * The oscilloscope: channels, capture, measurement, cursors, zoom, CSV.
 *
 * An oscilloscope in this engine is not a drawing widget. It is a set of channel
 * specifications that become `TransientRequest`s, one solver run that produces the
 * traces, and the measurement layer of `measure.ts` applied to them. Everything the
 * GUI shows is a number computed here, so the readouts and the export cannot
 * disagree with the display.
 *
 * Three properties are deliberate:
 *
 * - **One run per capture, not one per channel.** Every channel is sampled by the
 *   same solver pass, so all channels share the same time base and the same adaptive
 *   steps. Measuring each channel separately would compare traces taken at
 *   different step sequences, and a phase or delay reading between them would be
 *   meaningless.
 * - **An unresolved channel is an error on that channel, not a silent zero.** A
 *   probe name that matches nothing (or several elements of one instance) leaves the
 *   channel with `error` set and no trace, and the report prints the reason. A trace
 *   of zeros would look like a valid measurement of a dead node.
 * - **Zoom and cursors operate on the captured record.** They never re-run the
 *   solver or interpolate beyond what was captured, so a zoomed frequency reading is
 *   the same reading over a sub-interval — and says how many periods that interval
 *   contained.
 */

import { Accuracy, type Diagnostic } from '../core/labels.js';
import type { CircuitSimulator, TransientRequest } from '../sim/solver.js';
import { elementName, elementNodes, nodeNameAt, probeFailure, resolveProbe } from '../sim/netlist.js';
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
  type CursorResult,
  type DutyResult,
  type EdgeResult,
  type FrequencyOptions,
  type FrequencyResult,
  type PhaseResult,
  type Trace,
  type TraceStats,
} from './measure.js';
import { amplitudeSpectrum, totalHarmonicDistortion, type AmplitudeSpectrum, type SpectrumOptions, type ThdResult, type WindowKind } from './fft.js';

/** What a channel measures. */
export type ChannelMeasure = 'voltage' | 'current' | 'power' | 'temperature' | 'logic';

export interface ChannelRequest {
  /** Display name; derived from the target when omitted. */
  name?: string;
  measure: ChannelMeasure;
  /**
   * Probe target: a node name for a voltage, an instance path for a current, a
   * power or a temperature. `node:`, `element:` and `thermal:` prefixes force the
   * interpretation.
   */
  target: string;
  /** For a voltage across an element rather than at a node. */
  differential?: boolean;
  /** Vertical scale in the UI (volts, amps, watts or °C per division). */
  voltsPerDiv?: number;
  /** Vertical offset in the UI. */
  offset?: number;
  /** Trace colour hint for the UI. */
  color?: string;
  visible?: boolean;
}

export interface Channel {
  request: ChannelRequest;
  /** Resolved probe, or null when the target could not be resolved. */
  probe: { kind: 'node' | 'element' | 'thermal'; index: number; name: string; via: string } | null;
  /** The solver request built from the probe, or null. */
  solverRequest: TransientRequest | null;
  /** Why the channel has no trace. */
  error: string | null;
  /** The captured trace, or null. */
  trace: Trace | null;
  /** Display name actually used. */
  name: string;
  unit: string;
}

export interface CaptureOptions {
  /** Stop time, s. */
  tstop: number;
  /**
   * Number of points the record should hold.
   *
   * By default this sets a uniform output grid over the whole run (`tstop /
   * (maxSamples − 1)`), so the record always covers what was asked for. The solver
   * still adapts its internal step for accuracy; only the *sampling* is uniform.
   * Pass `outputInterval` explicitly to choose the grid yourself.
   */
  maxSamples?: number;
  /** Uniform output grid interval, s. Overrides `maxSamples`. */
  outputInterval?: number;
  /**
   * Continue from wherever the simulator currently is instead of starting a fresh
   * run. Off by default: `transient()` resumes from the previous run's end time, so
   * a second capture on the same simulator would otherwise start at t = the first
   * run's tstop and, unless the new tstop is larger, produce a one-sample record.
   */
  continueFrom?: boolean;
  /** Sample every accepted solver step instead of on a grid. */
  sampleEveryStep?: boolean;
  initialStep?: number;
  maxStep?: number;
}

export interface CaptureResult {
  ok: boolean;
  tstop: number;
  samples: number;
  steps: number;
  rejectedSteps: number;
  wallMs: number;
  /** The time the record actually reaches; equal to `tstop` unless it was truncated. */
  coveredUntil: number;
  /** The output grid interval used, or null when every solver step was sampled. */
  outputInterval: number | null;
  /** The time base shared by every channel. */
  times: Float64Array;
  diagnostics: Diagnostic[];
  convergence: { iterations: number; worstVoltageError: number; converged: boolean; gminUsed: number };
  channels: Channel[];
  /** What the capture cannot tell you. */
  notes: string[];
}

const UNIT_OF: Record<ChannelMeasure, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  temperature: '°C',
  logic: 'level',
};

/** The default trace colours, in channel order — the GUI palette. */
export const CHANNEL_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#f06292', '#ba68c8', '#fff176', '#4db6ac', '#ff8a65'];

export class Oscilloscope {
  private chans: Channel[] = [];
  private captured: CaptureResult | null = null;
  private view: { t0: number; t1: number } | null = null;
  private cursorTimes: [number, number] | null = null;
  private readonly sim: CircuitSimulator;

  constructor(sim: CircuitSimulator) {
    this.sim = sim;
  }

  /** Number of channels configured. */
  get channelCount(): number {
    return this.chans.length;
  }

  /** All channels, resolved or not. */
  channels(): readonly Channel[] {
    return this.chans;
  }

  /** The last capture, or null. */
  capture(): CaptureResult | null {
    return this.captured;
  }

  /**
   * Add a channel and resolve its probe immediately.
   *
   * Resolution happens at configuration time, not at capture time, so a bad target
   * is reported as soon as the user types it.
   */
  addChannel(request: ChannelRequest): Channel {
    const nl = this.sim.nl;
    const measure = request.measure;
    const unit = UNIT_OF[measure] ?? 'V';
    const probe = resolveProbe(nl, request.target);
    let error: string | null = null;
    let solverRequest: TransientRequest | null = null;
    let name = request.name ?? request.target;

    if (!probe) {
      error = probeFailure(nl, request.target);
    } else {
      // A differential voltage on an element target means "the voltage across it":
      // the request needs both of the element's nodes, which only the netlist knows.
      let index2 = probe.index2;
      if (measure === 'voltage' && request.differential === true && probe.kind === 'element' && index2 === undefined) {
        const nodes = elementNodes(nl, probe.index);
        if (nodes.length >= 2) index2 = nodes[nodes.length - 1];
      }
      name = request.name ?? defaultChannelName(measure, probe, request.differential === true);
      solverRequest = buildRequest(measure, probe.index, index2, name, nl, request.differential === true);
      if (!solverRequest) error = `a ${measure} cannot be measured on ${probe.name}`;
    }
    const channel: Channel = {
      request,
      probe: probe ? { kind: probe.kind, index: probe.index, name: probe.name, via: probe.via } : null,
      solverRequest,
      error,
      trace: null,
      name,
      unit,
    };
    if (!request.color) request.color = CHANNEL_COLORS[this.chans.length % CHANNEL_COLORS.length];
    if (request.visible === undefined) request.visible = true;
    this.chans.push(channel);
    return channel;
  }

  /** Add several channels at once. */
  addChannels(requests: ChannelRequest[]): Channel[] {
    return requests.map((r) => this.addChannel(r));
  }

  removeChannel(index: number): boolean {
    if (index < 0 || index >= this.chans.length) return false;
    this.chans.splice(index, 1);
    return true;
  }

  clearChannels(): void {
    this.chans.length = 0;
    this.captured = null;
    this.view = null;
  }

  /**
   * Run the transient and capture every channel on one shared time base.
   *
   * Channels with no solver request are left without a trace and keep their error.
   */
  run(opts: CaptureOptions): CaptureResult {
    const t0 = Date.now();
    const nl = this.sim.nl;
    const notes: string[] = [];
    if (!opts.continueFrom) {
      this.sim.resetTransient();
    } else if (this.sim.state.time > 0) {
      notes.push(`this capture continues a previous run from t = ${formatSeconds(this.sim.state.time)}: the traces start there, not at 0`);
    }
    const requests: TransientRequest[] = [];
    const requestIndex: number[] = [];
    for (let i = 0; i < this.chans.length; i++) {
      const c = this.chans[i];
      c.trace = null;
      if (c.solverRequest) {
        requestIndex.push(requests.length);
        requests.push(c.solverRequest);
      } else {
        requestIndex.push(-1);
      }
    }
    if (requests.length === 0) {
      notes.push('no channel resolved to a measurable quantity: nothing was simulated');
      notes.push('every capture starts from a fresh transient (time, reactive state and thermal state reset) unless continueFrom is set');
      this.captured = {
        ok: false, tstop: opts.tstop, samples: 0, steps: 0, rejectedSteps: 0, wallMs: Date.now() - t0, coveredUntil: 0, outputInterval: null,
        times: new Float64Array(0), diagnostics: [], convergence: { iterations: 0, worstVoltageError: NaN, converged: false, gminUsed: 0 },
        channels: this.chans, notes,
      };
      return this.captured;
    }
    // The output grid: `maxSamples` means "this many points over the whole run",
    // not "stop recording when the buffer is full". Without a grid the solver
    // samples every accepted step, and a run that needs more steps than the buffer
    // holds is silently truncated — the record then covers part of the requested
    // interval while every reading is reported as if it covered all of it.
    let outputInterval = opts.outputInterval ?? 0;
    if (!(outputInterval > 0) && !opts.sampleEveryStep && opts.maxSamples && opts.maxSamples > 1) {
      outputInterval = opts.tstop / (opts.maxSamples - 1);
    }
    const result = this.sim.transient(opts.tstop, requests, {
      maxSamples: opts.maxSamples,
      initialStep: opts.initialStep,
      maxStep: opts.maxStep,
      ...(outputInterval > 0 ? { outputInterval } : {}),
    });
    for (let i = 0; i < this.chans.length; i++) {
      const c = this.chans[i];
      const k = requestIndex[i];
      if (k < 0 || k >= result.values.length) continue;
      c.trace = {
        name: c.name,
        unit: c.unit,
        times: result.times,
        values: result.values[k],
        kind: c.request.measure === 'temperature' ? 'temperature' : c.request.measure === 'current' ? 'current' : c.request.measure === 'power' ? 'power' : c.request.measure === 'logic' ? 'logic' : 'voltage',
        target: c.probe?.name ?? c.request.target,
      };
    }
    if (!result.ok) notes.push('the transient did not converge cleanly; the traces are the last accepted state and are marked as such');
    if (result.truncatedAt !== null) {
      notes.push(
        `the record was truncated at ${formatSeconds(result.truncatedAt)} of the requested ${formatSeconds(opts.tstop)}: ` +
          `maxSamples was reached before the end of the run, so every reading below covers only that part`,
      );
    } else if (result.outputInterval !== null) {
      notes.push(
        `${result.sampleCount} samples on a uniform ${formatSeconds(result.outputInterval)} grid over the whole run ` +
          `(${result.steps} solver steps, of which ${result.rejected} rejected — the internal step still adapts for accuracy)`,
      );
    }
    if (result.rejected > 0) notes.push(`${result.rejected} step(s) were rejected and retried: the sample spacing is uneven by construction`);
    if (result.times.length < 2) notes.push('the record has fewer than two samples, so no interval exists to measure over');
    const maxStep = largestStep(result.times);
    if (maxStep > 0) {
      notes.push(`the coarsest interval in the record is ${formatSeconds(maxStep)}: features shorter than that may be missing between samples`);
    }
    if (nl.thermalNodeCount === 0 && this.chans.some((c) => c.request.measure === 'temperature')) {
      notes.push('a temperature channel was requested but the netlist has no thermal network: the trace is the circuit ambient at every sample, not a device temperature');
    }
    this.captured = {
      ok: result.ok,
      tstop: opts.tstop,
      samples: result.sampleCount,
      steps: result.steps,
      rejectedSteps: result.rejected,
      wallMs: Date.now() - t0 + result.wallMs,
      coveredUntil: result.times.length > 0 ? result.times[result.times.length - 1] : 0,
      outputInterval: result.outputInterval,
      times: result.times,
      diagnostics: result.diagnostics,
      convergence: {
        iterations: result.convergence.iterations,
        worstVoltageError: result.convergence.worstVoltageError,
        converged: result.convergence.converged,
        gminUsed: this.sim.gminUsed(),
      },
      channels: this.chans,
      notes,
    };
    this.view = null;
    return this.captured;
  }

  // ---- view ---------------------------------------------------------------

  /** Set the horizontal viewport (zoom). Both traces and measurements follow it. */
  zoom(t0: number, t1: number): void {
    const a = Math.min(t0, t1);
    const b = Math.max(t0, t1);
    this.view = b > a ? { t0: a, t1: b } : null;
  }

  resetZoom(): void {
    this.view = null;
  }

  get viewport(): { t0: number; t1: number } | null {
    return this.view;
  }

  /** Set the two time cursors. */
  setCursors(t1: number, t2: number): void {
    this.cursorTimes = [t1, t2];
  }

  get cursors(): [number, number] | null {
    return this.cursorTimes;
  }

  /** The trace of a channel, clipped to the viewport when one is set. */
  trace(index: number): Trace | null {
    const c = this.chans[index];
    if (!c || !c.trace) return null;
    if (!this.view) return c.trace;
    return clipTrace(c.trace, this.view.t0, this.view.t1);
  }

  /** The traces of every channel that has one, clipped to the viewport. */
  traces(): Trace[] {
    const out: Trace[] = [];
    for (let i = 0; i < this.chans.length; i++) {
      const t = this.trace(i);
      if (t) out.push(t);
    }
    return out;
  }

  // ---- measurements -------------------------------------------------------

  stats(index: number): TraceStats | null {
    const t = this.trace(index);
    return t ? traceStats(t) : null;
  }

  frequency(index: number, opts: FrequencyOptions = {}): FrequencyResult | null {
    const t = this.trace(index);
    return t ? measureFrequency(t, opts) : null;
  }

  edges(index: number, referenceIndex?: number): EdgeResult | null {
    const t = this.trace(index);
    if (!t) return null;
    const ref = referenceIndex !== undefined ? this.trace(referenceIndex) ?? undefined : undefined;
    return measureEdges(t, ref);
  }

  duty(index: number): DutyResult | null {
    const t = this.trace(index);
    return t ? measureDutyCycle(t) : null;
  }

  phase(indexA: number, indexB: number): PhaseResult | null {
    const a = this.trace(indexA);
    const b = this.trace(indexB);
    if (!a || !b) return null;
    return measurePhase(a, b);
  }

  cursorsAt(index: number, t1?: number, t2?: number): CursorResult | null {
    const tr = this.trace(index);
    if (!tr) return null;
    const c = this.cursorTimes;
    const a = t1 ?? c?.[0];
    const b = t2 ?? c?.[1];
    if (a === undefined || b === undefined) return null;
    return measureCursors(tr, a, b);
  }

  /** Amplitude spectrum of a channel over the viewport, resampled to a uniform grid. */
  spectrum(index: number, opts: { window?: WindowKind; points?: number; reference?: number; removeDc?: boolean } = {}): SpectrumReading | null {
    const t = this.trace(index);
    if (!t || t.values.length < 2) return null;
    const points = Math.max(16, opts.points ?? 1024);
    const duration = t.times[t.times.length - 1] - t.times[0];
    if (!(duration > 0)) return null;
    const uniform = resampleUniform(t, t.times[0], t.times[t.times.length - 1], points);
    const sampleRate = effectiveSampleRate(t, points);
    if (!(sampleRate > 0)) return null;
    const specOptions: SpectrumOptions = {
      sampleRate,
      window: opts.window ?? 'hann',
      reference: opts.reference,
      removeDc: opts.removeDc ?? false,
    };
    const spec = amplitudeSpectrum(uniform, specOptions);
    // Peak bin above DC.
    let peakIndex = 1;
    let peak = -Infinity;
    for (let k = 1; k < spec.amplitudes.length; k++) {
      if (spec.amplitudes[k] > peak) {
        peak = spec.amplitudes[k];
        peakIndex = k;
      }
    }
    const largestStep = maxStepOf(t.times);
    const thd = peak > 0 ? totalHarmonicDistortion(spec, spec.frequencies[peakIndex], sampleRate) : null;
    return {
      channel: t.name,
      unit: t.unit,
      spectrum: spec,
      sampleRate,
      points,
      peakHz: spec.frequencies[peakIndex],
      peakAmplitude: Math.max(peak, 0),
      peakDb: spec.magnitudesDb[peakIndex],
      nyquistHz: sampleRate / 2,
      thd,
      notes: [
        `${t.values.length} adaptive samples were linearly resampled to ${points} uniform points over ${formatSeconds(duration)} before the transform; ` +
          `interpolation attenuates content above ~${formatHz(0.5 / Math.max(largestStep, 1e-30))}, so the spectrum is not trustworthy near ${formatHz(sampleRate / 2)}`,
        `bin spacing ${formatHz(spec.binHz)} (after padding); true resolution ${formatHz(spec.trueResolutionHz)} from the ${formatSeconds(duration)} record`,
        `${spec.window.kind} window: amplitudes are corrected by its coherent gain, with up to ${Math.abs(spec.window.scallopingLossDb).toFixed(2)} dB scalloping loss for a tone between bins`,
        `the DC bin reads the time-average of the record${opts.removeDc ? ' with the mean removed, so it reads ~0' : ''}`,
      ],
    };
  }

  /** Everything the scope measures, as one report. */
  report(opts: { verbose?: boolean } = {}): ScopeReport {
    const cap = this.captured;
    const rows: ChannelReading[] = [];
    for (let i = 0; i < this.chans.length; i++) {
      const c = this.chans[i];
      const t = this.trace(i);
      if (!t) {
        rows.push({
          index: i, name: c.name, unit: c.unit, target: c.request.target, measure: c.request.measure,
          error: c.error ?? 'no trace was captured', stats: null, frequency: null, edges: null, duty: null,
        });
        continue;
      }
      rows.push({
        index: i,
        name: c.name,
        unit: c.unit,
        target: c.probe?.name ?? c.request.target,
        measure: c.request.measure,
        resolvedVia: c.probe?.via ?? null,
        error: null,
        stats: traceStats(t),
        frequency: measureFrequency(t),
        edges: measureEdges(t),
        duty: measureDutyCycle(t),
      });
    }
    const phases: Array<{ a: number; b: number; result: PhaseResult }> = [];
    if (rows.length >= 2) {
      // The phase between the first two traces with a measurable period: the pair a
      // user almost always means (a clock and a data line).
      const withPeriod = rows.filter((r) => r.frequency?.period !== null && r.frequency?.period !== undefined);
      if (withPeriod.length >= 2) {
        const res = this.phase(withPeriod[0].index, withPeriod[1].index);
        if (res) phases.push({ a: withPeriod[0].index, b: withPeriod[1].index, result: res });
      }
    }
    return {
      captured: cap
        ? {
            ok: cap.ok,
            tstop: cap.tstop,
            samples: cap.samples,
            steps: cap.steps,
            rejectedSteps: cap.rejectedSteps,
            wallMs: cap.wallMs,
            coveredUntil: cap.coveredUntil,
            outputInterval: cap.outputInterval,
            viewport: this.view,
            convergence: cap.convergence,
            diagnostics: cap.diagnostics,
            notes: cap.notes,
          }
        : null,
      channels: rows,
      phases,
      cursors: this.cursorTimes
        ? rows.filter((r) => r.stats).map((r) => ({ channel: r.index, ...(this.cursorsAt(r.index) as CursorResult) }))
        : [],
      accuracy: Accuracy.APPROXIMATED,
      accuracyNote:
        'every reading is computed from the solver samples by trapezoidal integration and interpolated crossing detection: ' +
        'it is exact for the record and approximate for the continuous waveform, bounded by the largest step in that record',
      verbose: opts.verbose === true,
    };
  }

  /** The report as text, for the console dock and the CLI. */
  toText(opts: { verbose?: boolean } = {}): string {
    return scopeReportToText(this.report(opts));
  }

  // ---- export -------------------------------------------------------------

  /**
   * CSV of the time base and every visible channel, over the viewport.
   *
   * The header carries the provenance: units per column, the solver options, the
   * sample count, and the fact that the time base is adaptive. A CSV of numbers
   * with no units and no method is how a measurement gets misread later.
   */
  toCsv(opts: { delimiter?: string; includeHeader?: boolean; visibleOnly?: boolean } = {}): string {
    const d = opts.delimiter ?? ',';
    const cap = this.captured;
    const lines: string[] = [];
    if (opts.includeHeader !== false) {
      lines.push(`# CircuitForge oscilloscope export`);
      lines.push(`# circuit=${csvEscape(this.sim.nl.name, d)}`);
      lines.push(`# samples=${cap?.samples ?? 0}${this.view ? ` viewport=${this.view.t0.toExponential(6)}..${this.view.t1.toExponential(6)} s` : ' viewport=full record'}`);
      lines.push(`# time base=adaptive (the solver chooses each step); column "time" is in seconds`);
      if (cap) {
        lines.push(`# convergence: ${cap.convergence.converged ? 'converged' : 'NOT converged'}, worst |dV| = ${cap.convergence.worstVoltageError.toExponential(3)} V, gmin = ${cap.convergence.gminUsed.toExponential(3)} S`);
        for (const n of cap.notes) lines.push(`# note: ${csvEscape(n, d)}`);
      }
    }
    const columns: Array<{ channel: Channel; trace: Trace }> = [];
    for (let i = 0; i < this.chans.length; i++) {
      const c = this.chans[i];
      if (opts.visibleOnly !== false && c.request.visible === false) continue;
      const t = this.trace(i);
      if (t) columns.push({ channel: c, trace: t });
    }
    lines.push(['time_s', ...columns.map((c) => csvEscape(`${c.channel.name}_${c.channel.unit.replace('/', '_')}`, d))].join(d));
    if (columns.length === 0) return lines.join('\n') + '\n';
    const base = columns[0].trace;
    for (let i = 0; i < base.times.length; i++) {
      const row: string[] = [base.times[i].toExponential(9)];
      for (const c of columns) {
        // Every channel shares the solver time base, so index i is the same instant;
        // if a trace is somehow shorter, interpolate rather than emit a blank.
        const v = i < c.trace.values.length ? c.trace.values[i] : valueAtTime(c.trace, base.times[i]);
        row.push(Number.isFinite(v) ? v.toExponential(9) : '');
      }
      lines.push(row.join(d));
    }
    return lines.join('\n') + '\n';
  }
}

export interface SpectrumReading {
  channel: string;
  unit: string;
  spectrum: AmplitudeSpectrum;
  sampleRate: number;
  points: number;
  peakHz: number;
  peakAmplitude: number;
  peakDb: number;
  nyquistHz: number;
  thd: ThdResult | null;
  notes: string[];
}

export interface ChannelReading {
  index: number;
  name: string;
  unit: string;
  target: string;
  measure: ChannelMeasure;
  resolvedVia?: string | null;
  error: string | null;
  stats: TraceStats | null;
  frequency: FrequencyResult | null;
  edges: EdgeResult | null;
  duty: DutyResult | null;
}

export interface ScopeReport {
  captured: {
    ok: boolean;
    tstop: number;
    samples: number;
    steps: number;
    rejectedSteps: number;
    wallMs: number;
    coveredUntil: number;
    outputInterval: number | null;
    viewport: { t0: number; t1: number } | null;
    convergence: { iterations: number; worstVoltageError: number; converged: boolean; gminUsed: number };
    diagnostics: Diagnostic[];
    notes: string[];
  } | null;
  channels: ChannelReading[];
  phases: Array<{ a: number; b: number; result: PhaseResult }>;
  cursors: Array<{ channel: number } & CursorResult>;
  accuracy: Accuracy;
  accuracyNote: string;
  verbose: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function defaultChannelName(measure: ChannelMeasure, probe: { kind: string; name: string }, differential: boolean): string {
  switch (measure) {
    case 'voltage':
      return differential ? `V(${probe.name})` : `V ${probe.name}`;
    case 'current':
      return `I ${probe.name}`;
    case 'power':
      return `P ${probe.name}`;
    case 'temperature':
      return `T ${probe.name}`;
    case 'logic':
      return `logic ${probe.name}`;
  }
}

function buildRequest(
  measure: ChannelMeasure,
  index: number,
  index2: number | undefined,
  name: string,
  nl: { nodeCount: number; nodes: Int32Array; nodeCountPerElement: Uint8Array; elementCount: number; kind: Uint8Array },
  differential: boolean,
): TransientRequest | null {
  const key = `${measure}:${name}`;
  switch (measure) {
    case 'voltage': {
      if (index2 !== undefined && index2 >= 0) {
        return { key, kind: 'vnet', index, index2 };
      }
      if (differential) return null;
      if (index < 0 || index >= nl.nodeCount) return null;
      return { key, kind: 'vnode', index };
    }
    case 'current':
      if (index < 0 || index >= nl.elementCount) return null;
      return { key, kind: 'igeneric', index };
    case 'power':
      if (index < 0 || index >= nl.elementCount) return null;
      return { key, kind: 'pelem', index };
    case 'temperature':
      if (index < 0) return null;
      return { key, kind: 'temp', index };
    case 'logic':
      if (index < 0 || index >= nl.elementCount) return null;
      return { key, kind: 'logic', index };
  }
}

function largestStep(times: Float64Array): number {
  let m = 0;
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    if (dt > m) m = dt;
  }
  return m;
}

const maxStepOf = largestStep;

function clipTrace(t: Trace, t0: number, t1: number): Trace {
  if (t.times.length === 0) return t;
  let a = 0;
  while (a < t.times.length && t.times[a] < t0) a++;
  let b = t.times.length - 1;
  while (b > a && t.times[b] > t1) b--;
  if (a >= b) return { ...t, times: new Float64Array(0), values: new Float64Array(0) };
  return { ...t, times: t.times.subarray(a, b + 1), values: t.values.subarray(a, b + 1) };
}

function valueAtTime(t: Trace, time: number): number {
  const { times, values } = t;
  if (times.length === 0) return NaN;
  if (time <= times[0]) return values[0];
  if (time >= times[times.length - 1]) return values[values.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const frac = times[hi] === times[lo] ? 0 : (time - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + frac * (values[hi] - values[lo]);
}

function csvEscape(s: string, delimiter: string): string {
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** The text form of a scope report: what the console dock and the CLI print. */
export function scopeReportToText(report: ScopeReport): string {
  const out: string[] = [];
  out.push('OSCILLOSCOPE');
  const cap = report.captured;
  if (!cap) {
    out.push('  no capture has been run yet');
  } else {
    out.push(
      `  record: ${cap.samples} samples covering ${formatSeconds(cap.coveredUntil)} of ${formatSeconds(cap.tstop)}, ` +
        `${cap.steps} steps (${cap.rejectedSteps} rejected), ${cap.wallMs.toFixed(1)} ms — ` +
        `${cap.convergence.converged ? 'converged' : 'NOT CONVERGED'} ` +
        `(worst |dV| ${cap.convergence.worstVoltageError.toExponential(2)} V, gmin ${cap.convergence.gminUsed.toExponential(2)} S)`,
    );
    if (cap.outputInterval !== null) out.push(`  sampling: uniform grid, ${formatSeconds(cap.outputInterval)} per point`);
    if (cap.coveredUntil < cap.tstop * (1 - 1e-9)) {
      out.push(`  WARNING: the record covers only ${((cap.coveredUntil / cap.tstop) * 100).toFixed(1)} % of the requested run`);
    }
    if (cap.viewport) out.push(`  viewport: ${formatSeconds(cap.viewport.t0)} … ${formatSeconds(cap.viewport.t1)}`);
  }
  for (const c of report.channels) {
    if (c.error) {
      out.push(`  [${c.index}] ${c.name} — NOT MEASURED: ${c.error}`);
      continue;
    }
    const s = c.stats!;
    out.push(`  [${c.index}] ${c.name} (${c.measure} at ${c.target})`);
    out.push(
      `      mean ${formatReading(s.mean, c.unit)}  RMS ${formatReading(s.rms, c.unit)}  AC RMS ${formatReading(s.acRms, c.unit)}  ` +
        `min ${formatReading(s.min, c.unit)}  max ${formatReading(s.max, c.unit)}  pk-pk ${formatReading(s.peakToPeak, c.unit)}`,
    );
    const f = c.frequency;
    if (f && f.frequency !== null) {
      out.push(
        `      f ${formatHz(f.frequency)}  T ${formatSeconds(f.period ?? NaN)}  amplitude ${formatReading(f.amplitude ?? NaN, c.unit)}  ` +
          `${f.cycles} period(s), jitter σ ${formatSeconds(f.periodStdDev)}`,
      );
    } else if (f) {
      out.push(`      f — ${f.note}`);
    }
    if (f && f.frequency !== null && !f.settled) {
      out.push(`      WARNING: this channel has not settled — the reading includes the circuit's startup transient`);
    }
    if (c.edges) {
      const e = c.edges;
      const parts: string[] = [];
      if (e.riseTime !== null) parts.push(`tr ${formatSeconds(e.riseTime)}`);
      if (e.fallTime !== null) parts.push(`tf ${formatSeconds(e.fallTime)}`);
      if (e.overshootPercent !== null) parts.push(`overshoot ${e.overshootPercent.toFixed(1)} %`);
      if (e.undershootPercent !== null) parts.push(`undershoot ${e.undershootPercent.toFixed(1)} %`);
      if (parts.length) out.push(`      edges: ${parts.join('  ')}`);
    }
    if (c.duty?.dutyPercent !== null && c.duty !== null && c.measure === 'logic') {
      out.push(`      duty ${c.duty.dutyPercent.toFixed(2)} % (time above ${formatReading(c.duty.threshold, c.unit)})`);
    }
    if (report.verbose) {
      out.push(`      method: ${s.method}`);
      if (f) out.push(`      frequency method: ${f.method}; ${f.note}`);
    }
  }
  for (const p of report.phases) {
    const r = p.result;
    if (r.degrees === null) {
      out.push(`  phase [${p.a}]→[${p.b}]: not measurable — ${r.note}`);
    } else {
      out.push(
        `  phase [${p.a}]→[${p.b}]: ${r.degrees.toFixed(2)}° (${formatSeconds(r.timeShift ?? NaN)} shift over a ${formatSeconds(r.period)} period, correlation ${r.correlation.toFixed(3)})`,
      );
      if (report.verbose) out.push(`      method: ${r.method}; ${r.note}`);
    }
  }
  for (const c of report.cursors) {
    out.push(
      `  cursors [${c.channel}]: t1 ${formatSeconds(c.t1)} t2 ${formatSeconds(c.t2)}  Δt ${formatSeconds(c.dt)}  1/Δt ${c.frequency !== null ? formatHz(c.frequency) : '—'}  ` +
        `Δv ${formatReading(c.dv, c.unit)}${c.slope !== null ? `  dv/dt ${formatReading(c.slope, `${c.unit}/s`)}` : ''}`,
    );
  }
  if (cap) for (const n of cap.notes) out.push(`  note: ${n}`);
  out.push(`  accuracy: ${report.accuracy} — ${report.accuracyNote}`);
  return out.join('\n');
}

/** Convenience: capture a node voltage and return its statistics. */
export function quickMeasure(
  sim: CircuitSimulator,
  target: string,
  measure: ChannelMeasure,
  tstop: number,
  opts: { maxSamples?: number } = {},
): { stats: TraceStats | null; error: string | null } {
  const scope = new Oscilloscope(sim);
  const c = scope.addChannel({ measure, target });
  if (c.error) return { stats: null, error: c.error };
  scope.run({ tstop, maxSamples: opts.maxSamples });
  return { stats: scope.stats(0), error: null };
}

export { elementName, nodeNameAt, elementNodes };
