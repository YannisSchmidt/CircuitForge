/**
 * Data exports: waveform tables and measurement reports.
 *
 * The rule everywhere in CircuitForge is that a number is exported with the
 * conditions that produced it. A waveform CSV therefore starts with `#` comment
 * lines naming the circuit, the engine, the level that produced the samples and
 * the stimulus; the consumer can keep them (most tools skip `#`) or strip them,
 * but they are never silently absent.
 */

import { ENGINE_VERSION } from '../util/version.js';
import { Accuracy } from '../core/labels.js';

export interface Waveform {
  name: string;
  unit: string;
  /** Sample times (s). */
  t: Float64Array | number[];
  /** One trace per signal. */
  signals: Array<{ name: string; unit: string; values: Float64Array | number[]; kind?: 'voltage' | 'current' | 'power' | 'temperature' | 'logic' | 'other' }>;
}

export interface WaveformExportOptions {
  /** Circuit / measurement name, put in the header. */
  circuit?: string;
  /** Simulation level that produced the samples (0–3), if known. */
  level?: number;
  /** Accuracy class of the samples, if known. */
  accuracy?: Accuracy;
  /** Stimulus description (sources, sweeps, seeds). */
  stimulus?: string;
  /** Decimal separator: '.' for tools, ',' for spreadsheet locales. */
  decimalComma?: boolean;
  /** Include the header comment block. */
  header?: boolean;
}

export function waveformToCsv(wave: Waveform, options: WaveformExportOptions = {}): string {
  const header = options.header ?? true;
  const sep = options.decimalComma ? ';' : ',';
  const fmt = (v: number): string => {
    const s = Number.isFinite(v) ? String(v) : v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
    return options.decimalComma ? s.replace('.', ',') : s;
  };
  const out: string[] = [];
  if (header) {
    out.push(`# CircuitForge waveform export: ${wave.name}`);
    out.push(`# engine ${ENGINE_VERSION} · generated ${new Date().toISOString()}`);
    if (options.circuit) out.push(`# circuit: ${options.circuit}`);
    if (options.level !== undefined) out.push(`# simulation level: L${options.level}`);
    if (options.accuracy) out.push(`# accuracy: ${options.accuracy}`);
    if (options.stimulus) out.push(`# stimulus: ${options.stimulus}`);
    out.push(`# columns: time [s]${wave.signals.map((s) => `, ${s.name} [${s.unit}]`).join('')}`);
  }
  out.push(['time', ...wave.signals.map((s) => s.name)].join(sep));
  out.push(['s', ...wave.signals.map((s) => s.unit)].join(sep));
  const n = wave.t.length;
  for (let i = 0; i < n; i++) {
    const row = [fmt(Number(wave.t[i]))];
    for (const signal of wave.signals) row.push(signal.values[i] === undefined ? '' : fmt(Number(signal.values[i])));
    out.push(row.join(sep));
  }
  return `${out.join('\n')}\n`;
}

export interface ReportSection {
  title: string;
  /** Key/value rows, in order. */
  rows: Array<[string, string]>;
  notes?: string[];
}

export interface ReportOptions {
  title: string;
  subtitle?: string;
  sections: ReportSection[];
  generatedAt?: string;
}

/** A plain-text report: readable in a terminal, diffable in git. */
export function reportToText(report: ReportOptions): string {
  const out: string[] = [];
  out.push(report.title.toUpperCase());
  if (report.subtitle) out.push(report.subtitle);
  out.push(`engine ${ENGINE_VERSION} · generated ${report.generatedAt ?? new Date().toISOString()}`);
  for (const section of report.sections) {
    out.push('');
    out.push(section.title);
    out.push('-'.repeat(section.title.length));
    const width = Math.max(0, ...section.rows.map(([k]) => k.length));
    for (const [k, v] of section.rows) out.push(`${k.padEnd(width)} : ${v}`);
    for (const note of section.notes ?? []) out.push(`note: ${note}`);
  }
  return `${out.join('\n')}\n`;
}

/** A report as JSON, for tools: same content, structured. */
export function reportToJson(report: ReportOptions): string {
  return `${JSON.stringify({ ...report, engine: ENGINE_VERSION, generatedAt: report.generatedAt ?? new Date().toISOString() }, null, 2)}\n`;
}
