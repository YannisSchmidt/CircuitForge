/**
 * The bench meters: voltmeter, ammeter, wattmeter, thermometer.
 *
 * Two ways to read a quantity exist in this engine and both are supported, because
 * a user does both:
 *
 * 1. **Placed instruments.** `voltmeter`, `ammeter`, `wattmeter`, `probe`,
 *    `thermometer` and `logic_probe` are components in the library. `findMeters`
 *    locates every instance in a flattened netlist and `readPlacedMeters` reports
 *    what each one reads at the DC operating point. A meter placed on the schematic
 *    is part of the design and exports with it.
 * 2. **Virtual instruments.** `measure(sim, …)` reads any node, element or thermal
 *    node without placing a component — the equivalent of clipping a meter on while
 *    probing.
 *
 * Loading is stated, not assumed. An ideal voltmeter draws no current and an ideal
 * ammeter has no burden voltage, which is what the engine models when `rin`/`rshunt`
 * are 0. A meter with a finite input resistance *does* load the circuit, and the
 * reading says so — the number is then the voltage at the loaded node, not the
 * open-circuit voltage.
 *
 * The wattmeter is the one instrument here that computes something the solver does
 * not already provide: real power is the time-weighted mean of v·i, apparent power
 * is Vrms·Irms, and reactive power comes from shifting the current trace by a quarter
 * period. That shift is exact for a single sinusoid and an approximation for anything
 * else, so the result carries the measured period and the note that says what the
 * shift assumed.
 */

import { Accuracy } from '../core/labels.js';
import type { CircuitSimulator } from '../sim/solver.js';
import type { FlatNetlist } from '../sim/netlist.js';
import { elementThermalNode } from '../sim/paramslots.js';
import { elementName, elementNodes, nodeNameAt, resolveProbe } from '../sim/netlist.js';
import { Oscilloscope, type CaptureOptions, type ChannelRequest } from './scope.js';
import { formatHz, formatSeconds, formatReading, measureFrequency, resampleUniform, traceStats, valueAt, type Trace, type TraceStats } from './measure.js';

/** The spec ids the engine ships as instruments. */
export const METER_SPEC_IDS = ['voltmeter', 'ammeter', 'wattmeter', 'probe', 'thermometer', 'logic_probe'] as const;

export type MeterSpecId = (typeof METER_SPEC_IDS)[number];

export interface PlacedMeter {
  specId: string;
  /** Instance reference designator, e.g. `VM1`. */
  ref: string;
  /** Path-qualified instance name. */
  path: string;
  /** The element this instance lowered to (−1 if it is a pure observer). */
  element: number;
  /** The nodes the instrument is connected to. */
  nodes: number[];
  /** Node names, for the readout. */
  nodeNames: string[];
  /** Its parameters as placed. */
  params: Record<string, unknown>;
  /** The label the user gave it, if any. */
  label: string;
}

/** Every instrument instance in a flattened netlist. */
export function findMeters(nl: FlatNetlist): PlacedMeter[] {
  const wanted = new Set<string>(METER_SPEC_IDS);
  const out: PlacedMeter[] = [];
  for (const inst of nl.instances) {
    if (!wanted.has(inst.specId)) continue;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inst.params ?? {})) params[k] = v;
    const nodes: number[] = [];
    for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount && e < nl.elementCount; e++) {
      const en = elementNodes(nl, e);
      for (let i = 0; i < en.length; i++) if (!nodes.includes(en[i])) nodes.push(en[i]);
    }
    out.push({
      specId: inst.specId,
      ref: inst.ref,
      path: inst.path,
      element: inst.elementCount > 0 ? inst.elementStart : -1,
      nodes,
      nodeNames: nodes.map((n) => nodeNameAt(nl, n)),
      params,
      label: String(params['label'] ?? ''),
    });
  }
  return out;
}

/** One reading from one instrument. */
export interface MeterReading {
  /** Instrument kind, as shown in the UI. */
  instrument: string;
  /** What was measured. */
  quantity: 'voltage' | 'current' | 'power' | 'temperature' | 'logic';
  /** The measured object (node name, element name, thermal node). */
  target: string;
  /** Where the instrument came from: a placed component or a virtual probe. */
  source: 'placed' | 'virtual';
  ref: string | null;
  unit: string;
  /** DC operating-point value. */
  dc: number | null;
  /** Time-weighted statistics over a transient record, when one was taken. */
  stats: TraceStats | null;
  /** Frequency measured on the trace, when it is periodic. */
  frequency: number | null;
  /** How the value was obtained. */
  method: string;
  accuracy: Accuracy;
  /** What the reading does not include. */
  note: string;
  /** Extra quantities an instrument computes (power factor, reactive power…). */
  extras: Array<{ name: string; value: number | null; unit: string; note: string }>;
}

/**
 * Read every placed instrument at the DC operating point.
 *
 * The circuit must already be solved (`dcSolve`); this function does not solve it,
 * because an instrument that quietly re-solves the circuit can invalidate a state
 * the caller was in the middle of using.
 */
export function readPlacedMeters(sim: CircuitSimulator): MeterReading[] {
  const nl = sim.nl;
  const out: MeterReading[] = [];
  for (const m of findMeters(nl)) {
    const loading = loadingNote(m);
    switch (m.specId) {
      case 'voltmeter': {
        const pos = m.nodes[0];
        const neg = m.nodes.length > 1 ? m.nodes[1] : 0;
        if (pos === undefined) {
          out.push(unreadable('Voltmeter', m, 'the voltmeter is not connected to any node'));
          break;
        }
        const v = sim.v[pos] - sim.v[neg ?? 0];
        out.push({
          instrument: 'Voltmeter',
          quantity: 'voltage',
          target: `${nodeNameAt(nl, pos)}${neg ? ` − ${nodeNameAt(nl, neg)}` : ' (to ground)'}`,
          source: 'placed',
          ref: m.ref,
          unit: 'V',
          dc: v,
          stats: null,
          frequency: null,
          method: 'node voltage difference at the DC operating point',
          accuracy: Accuracy.REALISTIC,
          note: loading,
          extras: [],
        });
        break;
      }
      case 'ammeter': {
        const e = m.element;
        if (e < 0) {
          out.push(unreadable('Ammeter', m, 'the ammeter lowered to no element (both terminals on the same node?)'));
          break;
        }
        const i = sim.state.elementCurrent[e] ?? 0;
        out.push({
          instrument: 'Ammeter',
          quantity: 'current',
          target: m.path,
          source: 'placed',
          ref: m.ref,
          unit: 'A',
          dc: i,
          stats: null,
          frequency: null,
          method: 'branch current through the meter element at the DC operating point (positive = into the + terminal)',
          accuracy: Accuracy.REALISTIC,
          note: loading,
          extras: [{ name: 'burden voltage', value: i * Number(m.params['rshunt'] ?? 0), unit: 'V', note: 'I × rshunt; 0 for an ideal meter' }],
        });
        break;
      }
      case 'wattmeter': {
        const e = m.element;
        if (e < 0) {
          out.push(unreadable('Wattmeter', m, 'the wattmeter lowered to no element'));
          break;
        }
        const p = sim.state.elementPower[e] ?? 0;
        out.push({
          instrument: 'Wattmeter',
          quantity: 'power',
          target: m.path,
          source: 'placed',
          ref: m.ref,
          unit: 'W',
          dc: p,
          stats: null,
          frequency: null,
          method: 'V × I of the meter element at the DC operating point, signed as absorbed power',
          accuracy: Accuracy.REALISTIC,
          note: `${loading} A negative value means the measured branch delivers power to the rest of the circuit; the sign is not an error.`,
          extras: [],
        });
        break;
      }
      case 'probe': {
        const kind = String(m.params['kind'] ?? 'voltage');
        const node = m.nodes[0] ?? 0;
        if (kind === 'voltage') {
          out.push({
            instrument: 'Probe',
            quantity: 'voltage',
            target: nodeNameAt(nl, node),
            source: 'placed',
            ref: m.ref,
            unit: 'V',
            dc: sim.v[node] ?? 0,
            stats: null,
            frequency: null,
            method: 'node voltage at the DC operating point',
            accuracy: Accuracy.REALISTIC,
            note: 'a probe is a pure observer: it adds no element and loads nothing',
            extras: [],
          });
        } else if (kind === 'logic') {
          const vth = Number(m.params['threshold'] ?? 1.65);
          const v = sim.v[node] ?? 0;
          out.push({
            instrument: 'Probe',
            quantity: 'logic',
            target: nodeNameAt(nl, node),
            source: 'placed',
            ref: m.ref,
            unit: 'level',
            dc: v > vth ? 1 : 0,
            stats: null,
            frequency: null,
            method: `electrical level compared with the ${formatReading(vth, 'V')} threshold`,
            accuracy: Accuracy.APPROXIMATED,
            note: `the level is a threshold decision on a node voltage, not a logic evaluation: a node between the rails reads as whichever side of ${formatReading(vth, 'V')} it is on`,
            extras: [{ name: 'node voltage', value: v, unit: 'V', note: 'the analogue value behind the level' }],
          });
        } else {
          out.push(unreadable('Probe', m, `a probe set to '${kind}' needs a transient capture, not a DC readout — use measureTransient`));
        }
        break;
      }
      case 'thermometer': {
        const e = m.element;
        const t = e >= 0 ? sim.elementTemperature(e) : nl.ambient ?? sim.opts.ambient;
        const ideal = m.params['ideal'] !== false;
        out.push({
          instrument: 'Thermometer',
          quantity: 'temperature',
          target: e >= 0 ? elementName(nl, e) : 'ambient',
          source: 'placed',
          ref: m.ref,
          unit: '°C',
          dc: t,
          stats: null,
          frequency: null,
          method: ideal
            ? 'direct readout of the thermal node the element is attached to (level 3)'
            : 'NTC-divider output converted back to a temperature using the declared sensitivity',
          accuracy: ideal ? Accuracy.APPROXIMATED : Accuracy.APPROXIMATED,
          note: ideal
            ? 'the temperature is the lumped-RC thermal node temperature, uniform across the device: no spatial gradient is modeled'
            : `the NTC mode reports the voltage a ${formatReading(Number(m.params['sens'] ?? 0.01), 'V')}/°C divider would produce; the conversion back to °C assumes that same linear sensitivity`,
          extras: [{ name: 'ambient', value: nl.ambient ?? sim.opts.ambient, unit: '°C', note: 'the reference the thermal network was built for' }],
        });
        break;
      }
      case 'logic_probe': {
        const node = m.nodes[0] ?? 0;
        const vth = Number(m.params['threshold'] ?? 1.65);
        const v = sim.v[node] ?? 0;
        out.push({
          instrument: 'Logic Probe',
          quantity: 'logic',
          target: nodeNameAt(nl, node),
          source: 'placed',
          ref: m.ref,
          unit: 'level',
          dc: v > vth ? 1 : 0,
          stats: null,
          frequency: null,
          method: `node voltage against a ${formatReading(vth, 'V')} threshold`,
          accuracy: Accuracy.APPROXIMATED,
          note: 'a two-level decision on an analogue node: an intermediate voltage reads as 0 or 1 with no X state',
          extras: [{ name: 'node voltage', value: v, unit: 'V', note: 'the analogue value behind the level' }],
        });
        break;
      }
    }
  }
  return out;
}

function unreadable(instrument: string, m: PlacedMeter, why: string): MeterReading {
  return {
    instrument,
    quantity: 'voltage',
    target: m.path,
    source: 'placed',
    ref: m.ref,
    unit: '—',
    dc: null,
    stats: null,
    frequency: null,
    method: 'not measured',
    accuracy: Accuracy.NOT_MODELED,
    note: why,
    extras: [],
  };
}

function loadingNote(m: PlacedMeter): string {
  const rin = Number(m.params['rin'] ?? 0);
  const rshunt = Number(m.params['rshunt'] ?? 0);
  if (m.specId === 'voltmeter') {
    return rin > 0
      ? `input resistance ${formatReading(rin, 'Ω')}: the meter loads the circuit and this is the loaded voltage, not the open-circuit one`
      : 'ideal (infinite input resistance): the meter draws no current and does not load the circuit';
  }
  if (m.specId === 'ammeter') {
    return rshunt > 0
      ? `shunt ${formatReading(rshunt, 'Ω')}: the meter inserts a burden voltage in series with the branch`
      : 'ideal (zero burden voltage): the meter does not disturb the branch it measures';
  }
  if (m.specId === 'wattmeter') {
    return rshunt > 0 ? `current sense shunt ${formatReading(rshunt, 'Ω')} in series with the measured branch` : 'ideal voltage and current sensing';
  }
  return 'a pure observer: it adds no element to the netlist';
}

/** A virtual measurement request (no component placed). */
export interface VirtualMeasureRequest {
  quantity: 'voltage' | 'current' | 'power' | 'temperature';
  target: string;
  /** For a voltage: measure across this element instead of at a node. */
  differential?: boolean;
  name?: string;
}

/** Read one or more quantities at the DC operating point, without placing components. */
export function measure(sim: CircuitSimulator, requests: VirtualMeasureRequest[]): MeterReading[] {
  const nl = sim.nl;
  const out: MeterReading[] = [];
  for (const r of requests) {
    const probe = resolveProbe(nl, r.target);
    const instrument = r.quantity === 'voltage' ? 'Voltmeter' : r.quantity === 'current' ? 'Ammeter' : r.quantity === 'power' ? 'Wattmeter' : 'Thermometer';
    if (!probe) {
      out.push({
        instrument,
        quantity: r.quantity,
        target: r.target,
        source: 'virtual',
        ref: null,
        unit: '—',
        dc: null,
        stats: null,
        frequency: null,
        method: 'not measured',
        accuracy: Accuracy.NOT_MODELED,
        note: `'${r.target}' does not resolve to a node, element or thermal node in this netlist`,
        extras: [],
      });
      continue;
    }
    const unit = r.quantity === 'voltage' ? 'V' : r.quantity === 'current' ? 'A' : r.quantity === 'power' ? 'W' : '°C';
    let value = 0;
    let method = '';
    switch (r.quantity) {
      case 'voltage': {
        if (probe.kind === 'node') {
          value = sim.v[probe.index] ?? 0;
          method = `node voltage at the DC operating point (reference: ${nl.hasGroundReference ? 'an explicit ground symbol' : 'the solver gmin — this netlist has no 0 V reference'})`;
        } else if (probe.kind === 'element') {
          const nodes = elementNodes(nl, probe.index);
          value = (sim.v[nodes[0]] ?? 0) - (sim.v[nodes[nodes.length - 1]] ?? 0);
          method = 'voltage across the element at the DC operating point';
        } else {
          value = sim.thermalNodeTemperature(probe.index);
          method = 'thermal node temperature';
        }
        break;
      }
      case 'current':
        if (probe.kind !== 'element') {
          value = NaN;
          method = 'a current needs an element target';
        } else {
          value = sim.state.elementCurrent[probe.index] ?? 0;
          method = 'element current at the DC operating point (positive = into the first node)';
        }
        break;
      case 'power':
        if (probe.kind !== 'element') {
          value = NaN;
          method = 'a power reading needs an element target';
        } else {
          value = sim.state.elementPower[probe.index] ?? 0;
          method = 'element V × I at the DC operating point, signed as absorbed';
        }
        break;
      case 'temperature':
        if (probe.kind === 'element') {
          value = sim.elementTemperature(probe.index);
          method = 'the element thermal node temperature, or the ambient when the element has no thermal node';
        } else {
          value = sim.thermalNodeTemperature(probe.index);
          method = 'thermal node temperature';
        }
        break;
    }
    out.push({
      instrument: r.name ?? instrument,
      quantity: r.quantity,
      target: probe.name,
      source: 'virtual',
      ref: null,
      unit,
      dc: Number.isFinite(value) ? value : null,
      stats: null,
      frequency: null,
      method,
      accuracy: Number.isFinite(value) ? Accuracy.REALISTIC : Accuracy.NOT_MODELED,
      note: Number.isFinite(value)
        ? 'an ideal virtual meter: it reads the solver state and adds no element, so it cannot load the circuit'
        : method,
      extras: [],
    });
  }
  return out;
}

export interface TransientMeasureResult {
  readings: MeterReading[];
  scope: Oscilloscope;
  capture: ReturnType<Oscilloscope['run']> | null;
}

/**
 * Measure quantities over a transient, with full statistics.
 *
 * The placed meters are captured too, so a schematic that shows a voltmeter gets
 * the same numbers the virtual probe would report on the same node — one solver run
 * for all of them, on one time base.
 */
export function measureTransient(
  sim: CircuitSimulator,
  requests: VirtualMeasureRequest[],
  opts: CaptureOptions & { includePlacedMeters?: boolean },
): TransientMeasureResult {
  const scope = new Oscilloscope(sim);
  const channels: ChannelRequest[] = requests.map((r) => ({
    measure: r.quantity === 'temperature' ? 'temperature' : r.quantity,
    target: r.target,
    differential: r.differential,
    name: r.name,
  }));
  const added = scope.addChannels(channels);
  const placedStart = added.length;
  if (opts.includePlacedMeters !== false) {
    for (const m of findMeters(sim.nl)) {
      if (m.specId === 'voltmeter' && m.nodes.length >= 1) {
        scope.addChannel({ measure: 'voltage', target: nodeNameAt(sim.nl, m.nodes[0]), name: `${m.ref} (voltmeter)` });
      } else if (m.specId === 'ammeter' && m.element >= 0) {
        scope.addChannel({ measure: 'current', target: `element:${m.path}`, name: `${m.ref} (ammeter)` });
      } else if (m.specId === 'wattmeter' && m.element >= 0) {
        scope.addChannel({ measure: 'power', target: `element:${m.path}`, name: `${m.ref} (wattmeter)` });
      } else if (m.specId === 'thermometer' && m.element >= 0) {
        scope.addChannel({ measure: 'temperature', target: `thermal:${m.path}`, name: `${m.ref} (thermometer)` });
      }
    }
  }
  const capture = scope.run(opts);
  const readings: MeterReading[] = [];
  for (let i = 0; i < scope.channelCount; i++) {
    const c = scope.channels()[i];
    const t = scope.trace(i);
    const stats = t ? traceStats(t) : null;
    const freq = t ? measureFrequency(t) : null;
    const placed = i >= placedStart;
    readings.push({
      instrument: c.name,
      quantity: c.request.measure === 'logic' ? 'logic' : (c.request.measure as MeterReading['quantity']),
      target: c.probe?.name ?? c.request.target,
      source: placed ? 'placed' : 'virtual',
      ref: null,
      unit: c.unit,
      dc: stats ? stats.first : null,
      stats,
      frequency: freq?.frequency ?? null,
      method: stats ? stats.method : c.error ?? 'not measured',
      accuracy: stats ? Accuracy.APPROXIMATED : Accuracy.NOT_MODELED,
      note: c.error ?? (freq?.frequency !== null && freq ? `periodic at ${formatHz(freq.frequency)} over ${freq.cycles} cycle(s)` : freq?.note ?? ''),
      extras: [],
    });
  }
  return { readings, scope, capture };
}

/**
 * Power measurements over a record: real, reactive, apparent and the power factor.
 *
 * Real power is the time-weighted mean of the instantaneous product v(t)·i(t) —
 * which is what a wattmeter integrates, and what the solver's own `pelem` trace
 * already gives. Reactive power is not a solver quantity: it is computed here by
 * shifting the current by a quarter of the measured period and taking the mean of
 * v(t)·i(t + T/4). For a single sinusoid that is exactly Q; for a waveform with
 * harmonics each harmonic contributes at its own phase and the number is the
 * fundamental's Q only if the record is dominated by it. The note states this
 * rather than presenting Q as a general truth.
 */
export interface PowerReading {
  /** Real (active) power, W. */
  real: number;
  /** Reactive power, var. */
  reactive: number | null;
  /** Apparent power, VA. */
  apparent: number;
  /** Power factor, −1…1. */
  powerFactor: number | null;
  /** Energy over the record, J. */
  energy: number;
  /** The period the quarter-cycle shift was referred to, s. */
  period: number | null;
  voltage: TraceStats | null;
  current: TraceStats | null;
  method: string;
  accuracy: Accuracy;
  note: string;
}

export function measurePower(voltage: Trace, current: Trace): PowerReading {
  const n = Math.min(voltage.times.length, current.times.length);
  if (n < 2) {
    return {
      real: NaN, reactive: null, apparent: NaN, powerFactor: null, energy: 0, period: null,
      voltage: null, current: null, method: 'no record', accuracy: Accuracy.NOT_MODELED,
      note: 'fewer than two samples: no power can be integrated',
    };
  }
  // Both traces come from the same solver run, so index i is the same instant.
  let intP = 0;
  let duration = 0;
  for (let i = 1; i < n; i++) {
    const dt = voltage.times[i] - voltage.times[i - 1];
    if (!(dt > 0)) continue;
    duration += dt;
    const p0 = voltage.values[i - 1] * current.values[i - 1];
    const p1 = voltage.values[i] * current.values[i];
    intP += 0.5 * (p0 + p1) * dt;
  }
  const real = duration > 0 ? intP / duration : NaN;
  const vStats = traceStats(voltage);
  const iStats = traceStats(current);
  const apparent = vStats.acRms * iStats.acRms;
  const freq = measureFrequency(voltage);
  const period = freq.period;
  let reactive: number | null = null;
  if (period && period > 0 && duration >= period) {
    // Quarter-period shift of the current, on a uniform grid so the shift is exact
    // in time rather than in samples.
    const points = 512;
    const gv = resampleUniform(voltage, voltage.times[0], voltage.times[0] + period, points);
    const gi = resampleUniform(current, current.times[0], current.times[0] + period, points);
    const shift = Math.round(points / 4);
    let s = 0;
    for (let k = 0; k < points; k++) {
      const v = gv[k] - vStats.mean;
      const i = gi[(k + shift) % points] - iStats.mean;
      s += v * i;
    }
    reactive = s / points;
  }
  const pf = apparent > 0 ? real / apparent : null;
  return {
    real,
    reactive,
    apparent,
    powerFactor: pf,
    energy: intP,
    period: period ?? null,
    voltage: vStats,
    current: iStats,
    method:
      `real power = ∫v·i·dt / ∫dt over ${formatSeconds(duration)} (${n} samples, trapezoidal); ` +
      `apparent = Vrms(ac) × Irms(ac); ` +
      (reactive !== null
        ? `reactive = mean of (v−V̄)·(i−Ī) with the current shifted by a quarter of the measured ${formatSeconds(period ?? NaN)} period`
        : 'reactive = not computed (no period was measured, or the record is shorter than one period)'),
    accuracy: Accuracy.APPROXIMATED,
    note:
      (reactive !== null
        ? `the quarter-period shift makes Q exact for a single sinusoid; with harmonics present it reports the fundamental's reactive power and ignores the rest. `
        : 'Q is unavailable, so the power factor is the ratio of real to apparent power without a phase angle. ') +
      `apparent power uses the AC RMS of each trace, so a DC-only circuit reads apparent = 0 and the power factor is undefined. ` +
      `real power is signed as absorbed: negative means the measured pair delivers power.`,
  };
}

/** Steady-state thermal reading for one element, with the path it was computed over. */
export interface ThermalReading {
  target: string;
  /** Junction temperature, °C. */
  temperature: number;
  /** Ambient, °C. */
  ambient: number;
  /** Rise above ambient, K. */
  rise: number;
  /** Power dissipated at that operating point, W. */
  power: number;
  /** Thermal resistance to ambient actually used, K/W. */
  rth: number | null;
  /** Whether the steady-state iteration converged. */
  converged: boolean;
  iterations: number;
  method: string;
  accuracy: Accuracy;
  note: string;
}

/**
 * The thermometer reading at thermal steady state.
 *
 * This runs `solveThermalSteadyState`, which iterates the electrical solve and the
 * thermal network until the temperatures stop moving: the temperature depends on the
 * power and the power depends on the temperature. Reading a single electrical
 * solution's power and multiplying by Rth would assume the device stays cold, and
 * under-report the temperature of anything whose resistance rises with it.
 */
export function measureThermalSteadyState(sim: CircuitSimulator, target: string): ThermalReading | null {
  const nl = sim.nl;
  const probe = resolveProbe(nl, target);
  if (!probe) return null;
  const steady = sim.solveThermalSteadyState();
  const e = probe.kind === 'element' ? probe.index : probe.kind === 'thermal' ? thermalElementOf(nl, probe.index) : -1;
  const ambient = nl.ambient ?? sim.opts.ambient;
  if (e < 0) {
    const t = probe.kind === 'thermal' ? sim.thermalNodeTemperature(probe.index) : ambient;
    return {
      target: probe.name,
      temperature: t,
      ambient,
      rise: t - ambient,
      power: 0,
      rth: null,
      converged: steady.converged,
      iterations: steady.iterations,
      method: 'thermal node temperature after the coupled steady-state iteration',
      accuracy: Accuracy.APPROXIMATED,
      note: 'this target is not an element, so no dissipation or thermal resistance is attributed to it',
    };
  }
  const t = sim.elementTemperature(e);
  // `thermalPower()` is the array the thermal network actually integrates, which
  // for a device whose electrical power is not fully dissipated (a source, or a
  // capacitor storing energy) differs from `elementPower`.
  const p = sim.state.elementPower[e] ?? sim.thermalPower()[e] ?? 0;
  const rth = t > ambient && p > 0 ? (t - ambient) / p : null;
  return {
    target: probe.name,
    temperature: t,
    ambient,
    rise: t - ambient,
    power: p,
    rth,
    converged: steady.converged,
    iterations: steady.iterations,
    method:
      `electrical and thermal networks iterated together to steady state (${steady.iterations} iteration(s), ` +
      `${steady.converged ? 'converged' : 'did NOT converge'}); the temperature is the lumped thermal node the element is attached to`,
    accuracy: Accuracy.APPROXIMATED,
    note:
      (rth !== null
        ? `the effective resistance to ambient at this operating point is ${formatReading(rth, 'K/W')} (ΔT / P), which is the declared Rth only if the element has a single path to ambient. `
        : 'no dissipation at this operating point, so no thermal resistance can be inferred. ') +
      'the model is lumped: one temperature per thermal node, no spatial gradient inside the device, and no convection or radiation model beyond the declared Rth.',
  };
}

/**
 * The element attached to a thermal node.
 *
 * The mapping lives in each element's parameter block (the same slot the solver
 * reads through `elementThermalNode`), so finding it means scanning — which is fine
 * for an instrument readout and would be far too slow to do inside a solver step.
 */
function thermalElementOf(nl: FlatNetlist, thermalNode: number): number {
  for (let e = 0; e < nl.elementCount; e++) {
    if (elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params) === thermalNode) return e;
  }
  return -1;
}

/** The text form of a list of readings — what the console and the CLI print. */
export function readingsToText(readings: MeterReading[]): string {
  if (readings.length === 0) return 'no instruments to read';
  const lines: string[] = ['INSTRUMENTS'];
  for (const r of readings) {
    const head = `${r.instrument}${r.ref ? ` ${r.ref}` : ''} [${r.source}] → ${r.target}`;
    if (r.dc === null && !r.stats) {
      lines.push(`  ${head}`);
      lines.push(`      NOT MEASURED (${r.accuracy}) — ${r.note}`);
      continue;
    }
    lines.push(`  ${head}`);
    if (r.dc !== null) lines.push(`      DC ${formatReading(r.dc, r.unit)}`);
    if (r.stats) {
      lines.push(
        `      mean ${formatReading(r.stats.mean, r.unit)}  RMS ${formatReading(r.stats.rms, r.unit)}  ` +
          `min ${formatReading(r.stats.min, r.unit)}  max ${formatReading(r.stats.max, r.unit)}  pk-pk ${formatReading(r.stats.peakToPeak, r.unit)}`,
      );
    }
    if (r.frequency !== null) lines.push(`      f ${formatHz(r.frequency)}`);
    for (const x of r.extras) {
      lines.push(`      ${x.name}: ${x.value === null ? '—' : formatReading(x.value, x.unit)} — ${x.note}`);
    }
    lines.push(`      method: ${r.method}`);
    lines.push(`      accuracy: ${r.accuracy} — ${r.note}`);
  }
  return lines.join('\n');
}

/** The text form of a power reading. */
export function powerToText(p: PowerReading): string {
  const lines = ['POWER'];
  lines.push(`  real (active)     ${Number.isFinite(p.real) ? formatReading(p.real, 'W') : '—'}`);
  lines.push(`  reactive          ${p.reactive === null ? 'not computed' : `${formatReading(p.reactive, 'var')}`}`);
  lines.push(`  apparent          ${Number.isFinite(p.apparent) ? formatReading(p.apparent, 'VA') : '—'}`);
  lines.push(`  power factor      ${p.powerFactor === null ? 'undefined (no apparent power)' : p.powerFactor.toFixed(4)}`);
  lines.push(`  energy in record  ${formatReading(p.energy, 'J')} over ${p.voltage ? formatSeconds(p.voltage.duration) : '—'}`);
  if (p.period !== null) lines.push(`  period            ${formatSeconds(p.period)}`);
  lines.push(`  method: ${p.method}`);
  lines.push(`  accuracy: ${p.accuracy} — ${p.note}`);
  return lines.join('\n');
}

/** The text form of a thermal reading. */
export function thermalToText(t: ThermalReading): string {
  return [
    'THERMOMETER',
    `  ${t.target}`,
    `      T ${t.temperature.toFixed(3)} °C (ambient ${t.ambient.toFixed(2)} °C, rise ${t.rise.toFixed(3)} K)`,
    `      P ${formatReading(t.power, 'W')}${t.rth !== null ? `  effective Rth ${formatReading(t.rth, 'K/W')}` : ''}`,
    `      steady state: ${t.iterations} iteration(s), ${t.converged ? 'converged' : 'NOT converged'}`,
    `      method: ${t.method}`,
    `      accuracy: ${t.accuracy} — ${t.note}`,
  ].join('\n');
}

export { valueAt };
