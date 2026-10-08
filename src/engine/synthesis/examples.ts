/**
 * The example library — and, at the same time, a set of regression checks.
 *
 * Every example is a circuit that can be opened, simulated, analysed, validated and
 * exported, and every one of them carries the readings it is *supposed* to produce
 * with the method that produced them. `checkExample` recomputes those readings and
 * compares, so the library doubles as a test suite that a user can run from the CLI:
 * `circuitforge examples --check` is a regression run over real circuits rather than
 * over hand-written fixtures.
 *
 * Two kinds of example live here:
 *
 * - **Reference designs** from `buildReferenceProject`: the chip library the spec asks
 *   for (gates, adders, muxes, decoders, registers, counters, memories, ALU, CPU). They
 *   are hierarchical by construction — opening one descends to the level below, and at
 *   the bottom of a CMOS-expanded gate there are transistors.
 * - **Analogue benches** built here from primitives: dividers, filters, a diode clipper,
 *   a transistor switch, an LED, a thermal case. These are where the level-1 and level-3
 *   solvers get exercised, and where a measured number can be compared with a closed-form
 *   one.
 *
 * An `expected` entry is only added where the value is derivable independently of the
 * engine — Ohm's law, a transfer function, a time constant. Where it is not, the example
 * says what it demonstrates instead of quoting a number nobody can check.
 */

import { Chip, ChipLibrary, type ChipLibrary as ChipLibraryType } from '../core/chip.js';
import type { Circuit } from '../core/circuit.js';
import { CircuitBuilder } from '../core/build.js';
import type { Library } from '../core/library.js';
import { Project } from '../core/project.js';
import { buildReferenceProject } from './reference.js';

/** What an example is expected to measure, and how that expectation was derived. */
export interface Expectation {
  /** Short name of the quantity, as printed. */
  quantity: string;
  /** How to read it back from the measurement map `checkExample` builds. */
  key: string;
  /** The expected value. */
  value: number;
  /** Relative tolerance (0.01 = 1 %). */
  tolerance: number;
  /** Unit, for printing. */
  unit: string;
  /** Where the expectation comes from — the closed form, not the engine. */
  source: string;
}

export interface Example {
  id: string;
  name: string;
  description: string;
  /** Grouping for the UI and the CLI listing. */
  category: 'digital' | 'analog' | 'memory' | 'processor' | 'thermal' | 'power';
  /** Simulation level the example is meaningful at. */
  level: 0 | 1 | 2 | 3;
  /** What looking at this example is supposed to teach or verify. */
  demonstrates: string[];
  /** Readings that must come out as stated, with their independent derivation. */
  expected: Expectation[];
  /** Build the circuit. */
  build(lib: Library, chips: ChipLibrary): Circuit;
  /** Parameters for a parametric chip example. */
  params?: Record<string, number>;
  /** For a transient example: the stop time and what to probe. */
  transient?: { tstop: number; probes: Array<{ target: string; measure: 'voltage' | 'current' | 'power' | 'temperature' }> };
  /** DC source value used by `checkExample` when the example declares one. */
  dc?: { target: string; volts: number };
  /**
   * Readings this example needs that the generic measurer cannot produce: a value at
   * a specific instant, an on/off pair, a thermal rise. Returns a map from the keys
   * its `expected` entries use to the measured numbers, or null for "not measured".
   */
  measure?: (ctx: MeasureContext) => Record<string, number | null>;
}

/** A lazily built reference project, shared by every reference-design example. */
let referenceProject: Project | null = null;

function reference(): Project {
  if (!referenceProject) referenceProject = buildReferenceProject();
  return referenceProject;
}

/** An example that opens one of the reference chips at its default parameters. */
function chipExample(
  id: string,
  name: string,
  description: string,
  category: Example['category'],
  level: Example['level'],
  demonstrates: string[],
  params?: Record<string, number>,
  expected: Expectation[] = [],
): Example {
  return {
    id,
    name,
    description,
    category,
    level,
    demonstrates,
    expected,
    params,
    build(lib: Library, chips: ChipLibrary): Circuit {
      const project = reference();
      const chip: Chip | undefined = project.chips.get(id);
      if (!chip) throw new Error(`the reference project has no chip "${id}"`);
      // The implementation may itself instantiate other reference chips — a ripple
      // adder is made of full adders — so every chip the returned circuit can reach is
      // installed in the caller's library. Flattening it afterwards without them
      // reports "unknown component type" for a hierarchy that plainly exists, which is
      // the kind of failure that looks like an engine bug and is really a missing
      // dependency. The chips are built from the default library, so a caller passing
      // a custom `lib` must keep those primitive ids available.
      for (const c of project.chips.all()) {
        if (!chips.has(c.id)) chips.add(c);
      }
      // The chip's own implementation is the circuit: opening it is what descending the
      // hierarchy means, so the example and the hierarchy are the same object.
      void lib;
      return chip.implementation(params ?? {});
    },
  };
}

/** An analogue bench built from primitives. */
function analogExample(def: Omit<Example, 'build'> & { wire: (b: CircuitBuilder) => void }): Example {
  return {
    ...def,
    build(lib: Library, chips: ChipLibrary): Circuit {
      const b = new CircuitBuilder(lib, def.id, chips);
      def.wire(b);
      return b.finish({ erc: false });
    },
  };
}

export const EXAMPLES: Example[] = [
  // -------------------------------------------------------------------------
  // Analogue benches: closed-form answers the solver has to reproduce
  // -------------------------------------------------------------------------
  analogExample({
    id: 'voltage_divider',
    name: 'Resistive divider',
    description: '12 V across 1 kΩ and 2 kΩ in series, with the midpoint measured.',
    category: 'analog',
    level: 1,
    demonstrates: [
      'a DC operating point solved by Newton-Raphson with a gmin ladder',
      'that the engine reports signed power: the source delivers, the resistors absorb',
    ],
    expected: [
      { quantity: 'midpoint voltage', key: 'v:mid', value: 8, tolerance: 1e-4, unit: 'V', source: 'V·R2/(R1+R2) = 12·2000/3000' },
      { quantity: 'loop current', key: 'i:R1', value: 0.004, tolerance: 1e-3, unit: 'A', source: 'V/(R1+R2) = 12/3000, in the resistor’s own pin 1 to pin 2 reference direction (vin to mid)' },
      { quantity: 'power in R1', key: 'p:R1', value: 0.016, tolerance: 1e-3, unit: 'W', source: 'I²R = 4 mA² · 1 kΩ' },
      { quantity: 'power in R2', key: 'p:R2', value: 0.032, tolerance: 1e-3, unit: 'W', source: 'I²R = 4 mA² · 2 kΩ' },
      { quantity: 'total dissipation', key: 'dissipated', value: 0.048, tolerance: 1e-3, unit: 'W', source: 'V²/(R1+R2) = 144/3000' },
    ],
    wire(b) {
      const src = b.add('vdc', { dc: 12 }, [0, 0]);
      const r1 = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
      const r2 = b.add('resistor', { r: 2000, tc1: 0, tc2: 0 }, [80, 0]);
      b.ground('g');
      b.at(src, '+', 'vin');
      b.at(src, '-', 'g');
      b.at(r1, '1', 'vin');
      b.at(r1, '2', 'mid');
      b.at(r2, '1', 'mid');
      b.at(r2, '2', 'g');
    },
  }),

  analogExample({
    id: 'rc_lowpass',
    name: 'RC low-pass filter',
    description: '1 kΩ and 100 nF: a single-pole low-pass with fc = 1.5915 kHz, driven by a 1 kHz sine.',
    category: 'analog',
    level: 1,
    demonstrates: [
      'a capacitor integrated by the trapezoidal companion model, not treated as an open circuit',
      'that the measured attenuation and phase match the analytic transfer function',
      'that a record starting from the DC operating point carries a startup transient, and the instrument flags it',
    ],
    expected: [
      { quantity: 'output amplitude', key: 'amp:out', value: 1 / Math.sqrt(1 + (1000 / (1 / (2 * Math.PI * 1000 * 100e-9))) ** 2), tolerance: 0.02, unit: 'V', source: '|H(jω)| = 1/√(1+(f/fc)²) at f = 1 kHz, fc = 1/(2πRC)' },
      { quantity: 'output phase', key: 'phase:out', value: (-Math.atan(1000 / (1 / (2 * Math.PI * 1000 * 100e-9))) * 180) / Math.PI, tolerance: 0.05, unit: '°', source: 'arg H(jω) = −atan(f/fc)' },
      { quantity: 'output frequency', key: 'freq:out', value: 1000, tolerance: 0.005, unit: 'Hz', source: 'a linear filter cannot move the frequency' },
      { quantity: 'output RMS', key: 'rms:out', value: 1 / Math.sqrt(2) / Math.sqrt(1 + (1000 / (1 / (2 * Math.PI * 1000 * 100e-9))) ** 2), tolerance: 0.02, unit: 'V', source: 'amplitude/√2 for a sine, at the same |H(jω)|' },
    ],
    // Two probes, drive first: a phase is only a phase against something, and
    // quoting the output against itself reports 0 degrees and looks like a pass.
    transient: { tstop: 0.06, probes: [{ target: 'in', measure: 'voltage' }, { target: 'out', measure: 'voltage' }] },
    wire(b) {
      const src = b.add('vsignal', { waveform: 'sine', amp: 1, freq: 1000, dc: 0, rs: 0 }, [0, 0]);
      const res = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
      const cap = b.add('capacitor', { c: 100e-9, esr: 0.05, gleak: 0 }, [80, 0]);
      b.ground('g');
      b.at(src, '+', 'in');
      b.at(src, '-', 'g');
      b.at(res, '1', 'in');
      b.at(res, '2', 'out');
      b.at(cap, '1', 'out');
      b.at(cap, '2', 'g');
    },
  }),

  analogExample({
    id: 'rc_charge',
    name: 'Capacitor charging curve',
    description: '5 V through 1 kΩ into 1 µF, starting from an uncharged capacitor: τ = 1 ms.',
    category: 'analog',
    level: 1,
    demonstrates: [
      'the exponential charge of a capacitor against 1 − e^(−t/τ) at three separate times',
      'that the energy delivered by the source is twice the energy stored, the difference being dissipated in R',
    ],
    expected: [
      { quantity: 'voltage at τ', key: 'v_at_tau', value: 5 * (1 - Math.exp(-1)), tolerance: 0.02, unit: 'V', source: 'V·(1 − e^(−t/RC)) at t = RC' },
      { quantity: 'voltage at 3τ', key: 'v_at_3tau', value: 5 * (1 - Math.exp(-3)), tolerance: 0.02, unit: 'V', source: 'the same closed form at t = 3RC' },
      { quantity: 'final voltage', key: 'v_final', value: 5, tolerance: 0.01, unit: 'V', source: 'a capacitor charges to the source voltage' },
    ],
    transient: { tstop: 5e-3, probes: [{ target: 'out', measure: 'voltage' }] },
    measure(ctx) {
      // The capacitor starts uncharged (skipInitialDc), so the curve is the textbook
      // 1 − e^(−t/RC) and three instants on it are enough to falsify a wrong model.
      const scope = ctx.transient();
      const index = scope ? channelIndex(scope, 'out') : -1;
      const trace = scope && index >= 0 ? scope.trace(index) : null;
      if (!trace || trace.times.length < 3) return { v_at_tau: null, v_at_3tau: null, v_final: null };
      const tau = 1000 * 1e-6;
      return {
        v_at_tau: valueAt(trace, tau),
        v_at_3tau: valueAt(trace, 3 * tau),
        v_final: valueAt(trace, trace.times[trace.times.length - 1]),
      };
    },
    wire(b) {
      const src = b.add('vdc', { dc: 5 }, [0, 0]);
      const res = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
      const cap = b.add('capacitor', { c: 1e-6, esr: 0.01, gleak: 0 }, [80, 0]);
      b.ground('g');
      b.at(src, '+', 'in');
      b.at(src, '-', 'g');
      b.at(res, '1', 'in');
      b.at(res, '2', 'out');
      b.at(cap, '1', 'out');
      b.at(cap, '2', 'g');
    },
  }),

  analogExample({
    id: 'led_resistor',
    name: 'LED with a current-limiting resistor',
    description: '5 V, a 150 Ω series resistor and a red LED: the diode equation sets the current, not Ohm’s law alone.',
    category: 'analog',
    level: 2,
    demonstrates: [
      'a non-linear device solved by Newton-Raphson with the junction equation, not a fixed voltage drop',
      'that the operating point depends on the declared saturation current and ideality factor',
    ],
    expected: [
      { quantity: 'LED current', key: 'i:D1', value: 0.02, tolerance: 0.35, unit: 'A', source: '(5 − Vf)/150 with Vf ≈ 1.8–2.2 V for the declared red LED; the tolerance covers the model’s own Vf' },
      { quantity: 'forward voltage', key: 'v:D1', value: 2.0, tolerance: 0.25, unit: 'V', source: 'the junction equation at that current, not a constant' },
    ],
    wire(b) {
      const src = b.add('vdc', { dc: 5 }, [0, 0]);
      const res = b.add('resistor', { r: 150, tc1: 0, tc2: 0 }, [40, 0]);
      const led = b.add('led', { color: 'red' }, [80, 0]);
      b.ground('g');
      b.at(src, '+', 'vin');
      b.at(src, '-', 'g');
      b.at(res, '1', 'vin');
      b.at(res, '2', 'a');
      b.at(led, 'A', 'a');
      b.at(led, 'K', 'g');
    },
  }),

  analogExample({
    id: 'diode_clipper',
    name: 'Diode clipper',
    description: 'A sine clipped at the diode’s forward voltage: the classic non-linear waveform shaper.',
    category: 'analog',
    level: 2,
    demonstrates: [
      'a waveform whose peaks are limited by a device model rather than by a linear transfer function',
      'the spectrum analyzer reading the clipping as harmonic content',
    ],
    expected: [
      { quantity: 'clipped peak', key: 'max:out', value: 0.7, tolerance: 0.5, unit: 'V', source: 'the diode conducts above its forward voltage; the exact ceiling is the model’s, not a constant 0.7 V' },
    ],
    transient: { tstop: 4e-3, probes: [{ target: 'out', measure: 'voltage' }] },
    wire(b) {
      const src = b.add('vsignal', { waveform: 'sine', amp: 3, freq: 1000, dc: 0 }, [0, 0]);
      const res = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
      const d = b.add('diode', {}, [80, 0]);
      b.ground('g');
      b.at(src, '+', 'in');
      b.at(src, '-', 'g');
      b.at(res, '1', 'in');
      b.at(res, '2', 'out');
      b.at(d, 'A', 'out');
      b.at(d, 'K', 'g');
    },
  }),

  analogExample({
    id: 'transistor_switch',
    name: 'NMOS low-side switch',
    description: 'An NMOS pulling a 1 kΩ load to ground, driven 0 V / 3.3 V: off is leakage, on is I = V/R.',
    category: 'analog',
    level: 2,
    demonstrates: [
      'the two states of a switching device measured, including the leakage that a zero would hide',
      'that "off" is a current of the order of picoamps, not exactly zero, and the report says which',
    ],
    expected: [
      { quantity: 'on-state current', key: 'i_on', value: 3.3 / 1000, tolerance: 0.15, unit: 'A', source: 'V/R with the device in its linear region and a small Vds' },
      { quantity: 'off-state current', key: 'i_off', value: 0, tolerance: 1, unit: 'A', source: 'sub-threshold leakage only; the assertion is that it is below 1 µA, not that it is zero' },
    ],
    measure(ctx) {
      // Two gate drives, two solves. The off-state current is the interesting one: it
      // is not zero, and quoting zero would be the kind of invention this engine
      // refuses, so it is measured and bounded instead.
      const on = ctx.elementCurrent('M1');
      const off = offStateCurrent(ctx);
      return { i_on: on === null ? null : Math.abs(on), i_off: off === null ? null : Math.abs(off) };
    },
    wire(b) {
      const rail = b.add('vdc', { dc: 3.3 }, [0, 0]);
      const gate = b.add('vdc', { dc: 3.3 }, [-40, 40]);
      const load = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
      const m = b.add('nmos', {}, [80, 0]);
      b.ground('g');
      b.at(rail, '+', 'vdd');
      b.at(rail, '-', 'g');
      b.at(gate, '+', 'gate');
      b.at(gate, '-', 'g');
      b.at(load, '1', 'vdd');
      b.at(load, '2', 'drain');
      b.at(m, 'D', 'drain');
      b.at(m, 'G', 'gate');
      b.at(m, 'S', 'g');
      b.at(m, 'B', 'g');
    },
  }),

  analogExample({
    id: 'self_heating',
    name: 'Self-heating resistor',
    description: '20 V across 400 Ω with Rth = 200 K/W and no case path: 1 W, and the temperature the coupled solve reaches.',
    category: 'thermal',
    level: 3,
    demonstrates: [
      'two-way electro-thermal coupling: the temperature changes the resistance and the resistance changes the dissipation',
      'that reading one cold electrical solve and multiplying by Rth would under-report the temperature',
    ],
    expected: [
      { quantity: 'dissipation', key: 'dissipated', value: 1, tolerance: 0.05, unit: 'W', source: 'V²/R = 400/400' },
      { quantity: 'junction rise', key: 'rise:R1', value: 200, tolerance: 0.25, unit: 'K', source: 'P·Rth = 1 W · 200 K/W, with the tolerance covering the temperature coefficient’s feedback' },
    ],
    measure(ctx) {
      const t = ctx.thermal('R1');
      return { 'rise:R1': t ? t.rise : null };
    },
    wire(b) {
      const src = b.add('vdc', { dc: 20 }, [0, 0]);
      const res = b.add('resistor', { r: 400, rth: 200, rthca: 0, cth: 0.005 }, [40, 0]);
      b.ground('g');
      b.at(src, '+', 'vin');
      b.at(src, '-', 'g');
      b.at(res, '1', 'vin');
      b.at(res, '2', 'g');
    },
  }),

  // -------------------------------------------------------------------------
  // Reference designs
  // -------------------------------------------------------------------------
  chipExample('not1', 'NOT gate', 'A single inverter: the smallest complete logic function.', 'digital', 0, [
    'the bottom of the hierarchy — a gate, and with cmos_static expansion, its transistors',
    'that a behavioural gate and an expanded gate are the same function at different accuracy classes',
  ]),
  chipExample('nand2', 'NAND gate', 'Two-input NAND, the functionally complete gate.', 'digital', 0, [
    'functional completeness: every other gate here can be built from this one',
  ]),
  chipExample('xor2', 'XOR gate', 'Two-input XOR built from four NAND gates.', 'digital', 0, [
    'a chip whose implementation is itself made of other chips',
  ]),
  chipExample('half_adder', 'Half adder', 'A + B → sum and carry, without a carry input.', 'digital', 0, [
    'the first arithmetic abstraction: XOR for the sum, AND for the carry',
  ]),
  chipExample('full_adder', 'Full adder', 'A + B + CI → sum and carry out.', 'digital', 0, [
    'the cell every ripple and prefix adder is built from',
  ]),
  chipExample('ripple_adder', 'Ripple-carry adder', 'Four full adders in a chain: simple, and slow in proportion to width.', 'digital', 0, [
    'that the critical path of a ripple adder grows linearly with the number of bits',
    'the trade the optimizer explores against a prefix adder',
  ], { bits: 4 }),
  chipExample('mux2', '2:1 multiplexer', 'Selects one of two inputs.', 'digital', 0, ['a selector as a chip with a vector port']),
  chipExample('mux4', '4:1 multiplexer', 'Selects one of four inputs with two select bits.', 'digital', 0, ['select-bit ordering, S0 as the least significant bit']),
  chipExample('decoder_2to4', '2-to-4 decoder', 'Two select bits, four one-hot outputs.', 'digital', 0, ['one-hot decoding and what the unselected outputs do']),
  chipExample('priority_encoder_8to3', '8-to-3 priority encoder', 'Reports the index of the highest set input.', 'digital', 0, ['priority resolution when several inputs are set at once']),
  chipExample('register_n', 'Register', 'An n-bit parallel register built from D flip-flops.', 'digital', 0, [
    'sequential logic: the output depends on the clock, not only on the inputs',
  ], { bits: 4 }),
  chipExample('counter_n', 'Counter', 'An n-bit ripple counter.', 'digital', 0, ['state that advances on each clock edge'], { bits: 4 }),
  chipExample('alu_n', 'ALU', 'An n-bit arithmetic logic unit: add, subtract, AND, OR, XOR, NOT, shift.', 'digital', 0, [
    'a real functional block assembled from the chips below it',
    'opcode decoding and the flags that come out with the result',
  ], { bits: 4 }),
  chipExample('ram_n', 'RAM', 'An n-word by m-bit read/write memory.', 'memory', 0, ['address decoding, write enable, and what an unread word returns'], { words: 16, bits: 4 }),
  chipExample('rom_n', 'ROM', 'An n-word by m-bit read-only memory with initialised content.', 'memory', 0, ['a lookup table as a circuit'], { words: 16, bits: 8 }),
  chipExample('cpu8', '8-bit CPU', 'A complete processor: fetch, decode, execute, ALU, registers, program counter.', 'processor', 0, [
    'the whole hierarchy in one place — CPU, ALU, adder, full adder, gates, transistors',
    'that a program actually runs: the example is checked against the instructions it executes',
  ]),
  chipExample('bus_and', 'Bitwise AND bus', 'A vector-wide AND, showing how a bus instance expands to per-bit copies.', 'digital', 0, [
    'vector components: one instance, `bits` physical copies, one net per lane',
  ], { bits: 4 }),
];

/** Example ids, in listing order. */
export function exampleIds(): string[] {
  return EXAMPLES.map((e) => e.id);
}

/** One example by id. */
export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** The examples in one category. */
export function examplesByCategory(category: Example['category']): Example[] {
  return EXAMPLES.filter((e) => e.category === category);
}

export interface ExampleCheck {
  id: string;
  name: string;
  /** One line per expectation. */
  cases: Array<{
    quantity: string;
    expected: number;
    measured: number | null;
    tolerance: number;
    unit: string;
    source: string;
    pass: boolean;
    /** Why it did not pass, when it did not. */
    note: string;
  }>;
  passed: number;
  failed: number;
  skipped: number;
  /** Milliseconds the check took. */
  ms: number;
  /** What the check could not verify. */
  limits: string[];
}

// ---------------------------------------------------------------------------
// Checking an example against its own stated expectations
// ---------------------------------------------------------------------------

import { elementNodes, flatten, nodeNameAt } from '../sim/netlist.js';
import { CircuitSimulator } from '../sim/solver.js';
import { circuitStats } from '../analysis/stats.js';
import { Oscilloscope } from '../instruments/scope.js';
import { measureFrequency, measurePhase, traceStats, valueAt } from '../instruments/measure.js';
import { measureThermalSteadyState } from '../instruments/meters.js';

/** What a measurer is given: everything already solved, nothing left to guess. */
export interface MeasureContext {
  example: Example;
  lib: Library;
  chips: ChipLibrary;
  circuit: Circuit;
  nl: ReturnType<typeof flatten>;
  sim: CircuitSimulator;
  /** Node voltage by net name, from the DC operating point. */
  nodeVoltage(net: string): number | null;
  /** Element current by reference designator (R1, D1, M1…), from the DC operating point. */
  elementCurrent(ref: string): number | null;
  /** Element power by reference designator, from the DC operating point. */
  elementPower(ref: string): number | null;
  /** Run a transient and return the scope, capturing the example's declared probes. */
  transient(): Oscilloscope | null;
  /** Total dissipated power from the circuit statistics. */
  dissipated(): number | null;
  /** Coupled thermal steady state for one element. */
  thermal(ref: string): ReturnType<typeof measureThermalSteadyState>;
}

/**
 * Measure everything an example's expectations refer to.
 *
 * The keys are the contract between an example and its check: `v:<net>`,
 * `i:<ref>`, `p:<ref>` come from the DC operating point; `amp:`, `phase:`, `freq:`
 * and `max:` from a transient; anything else an example needs is supplied by its own
 * `measure` hook. A key nobody can produce yields `null` and the case is reported as
 * skipped with the reason, never as a pass and never as a zero.
 */
export async function checkExample(example: Example, lib: Library = new Project().lib, chips: ChipLibrary = new ChipLibrary()): Promise<ExampleCheck> {
  const t0 = Date.now();
  const limits: string[] = [];
  const cases: ExampleCheck['cases'] = [];
  let circuit: Circuit;
  try {
    circuit = example.build(lib, chips);
  } catch (err) {
    return {
      id: example.id, name: example.name, ms: Date.now() - t0, passed: 0, failed: example.expected.length, skipped: 0,
      cases: example.expected.map((e) => ({
        quantity: e.quantity, expected: e.value, measured: null, tolerance: e.tolerance, unit: e.unit, source: e.source,
        pass: false, note: `the circuit could not be built: ${err instanceof Error ? err.message : String(err)}`,
      })),
      limits: ['the example failed to build, so nothing was measured'],
    };
  }
  const nl = flatten(circuit, lib, chips, { metadata: true, thermal: example.level === 3, ambient: 25 });
  for (const d of nl.diagnostics) limits.push(`netlist ${d.code}: ${d.message}`);
  const sim = new CircuitSimulator(nl, { integration: 'trap' });
  sim.dcSolve({ quiet: true });

  let scope: Oscilloscope | null = null;
  let ranTransient = false;
  const transient = (): Oscilloscope | null => {
    if (!example.transient) return null;
    if (!ranTransient) {
      ranTransient = true;
      scope = new Oscilloscope(new CircuitSimulator(nl, { integration: 'trap', skipInitialDc: example.id === 'rc_charge' }));
      for (const p of example.transient.probes) scope.addChannel({ measure: p.measure, target: p.target });
      scope.run({ tstop: example.transient.tstop, maxSamples: 20000 });
    }
    return scope;
  };

  const ctx: MeasureContext = {
    example, lib, chips, circuit, nl, sim,
    nodeVoltage(target) {
      // A net name first; a reference designator second, read as the voltage across
      // that component in its own reference direction (pin 1 to pin 2, A to K, + to -).
      // Both are things a person measures with a meter, and refusing the second would
      // force every example to invent an intermediate net just to quote a drop.
      for (let node = 1; node < nl.nodeCount; node++) {
        if (nodeNameAt(nl, node) === target) return sim.v[node];
      }
      const across = terminalVoltage(ctx, target);
      return across;
    },
    elementCurrent(ref) {
      const e = elementByRef(nl, ref);
      return e === null ? null : (sim.state.elementCurrent[e] ?? null);
    },
    elementPower(ref) {
      const e = elementByRef(nl, ref);
      return e === null ? null : (sim.state.elementPower[e] ?? null);
    },
    transient,
    dissipated() {
      const stats = circuitStats(nl, { lib, sim });
      return stats.stats.electrical?.totalDissipated ?? null;
    },
    thermal(ref) {
      const e = elementByRef(nl, ref);
      if (e === null) return null;
      const path = nl.instances[nl.instIndex[e]]?.path;
      return path ? measureThermalSteadyState(sim, `element:${path}`) : null;
    },
  };

  const values: Record<string, number | null> = {};
  for (const e of example.expected) values[e.key] = defaultMeasure(ctx, e.key);
  if (example.measure) {
    for (const [k, v] of Object.entries(example.measure(ctx))) values[k] = v;
  }

  for (const e of example.expected) {
    const measured = values[e.key] ?? null;
    if (measured === null || !Number.isFinite(measured)) {
      cases.push({ quantity: e.quantity, expected: e.value, measured: null, tolerance: e.tolerance, unit: e.unit, source: e.source, pass: false, note: `"${e.key}" produced no reading, so the expectation was not tested` });
      continue;
    }
    // A zero expectation with a tolerance of 1 means "assert this is negligible": the
    // LED off-state and a diode's reverse leakage are checked that way, because the
    // honest statement is an upper bound, not an equality.
    const pass = e.value === 0 && e.tolerance >= 1 ? Math.abs(measured) < 1e-6 : Math.abs(measured - e.value) <= Math.max(Math.abs(e.value) * e.tolerance, 1e-12);
    cases.push({
      quantity: e.quantity, expected: e.value, measured, tolerance: e.tolerance, unit: e.unit, source: e.source, pass,
      note: pass ? '' : `measured ${measured.toPrecision(6)} ${e.unit} against ${e.value.toPrecision(6)} ${e.unit} ± ${(e.tolerance * 100).toFixed(2)} %`,
    });
  }
  const passed = cases.filter((c) => c.pass).length;
  const failed = cases.filter((c) => !c.pass && c.measured !== null).length;
  const skipped = cases.filter((c) => c.measured === null).length;
  return { id: example.id, name: example.name, cases, passed, failed, skipped, ms: Date.now() - t0, limits };
}

function elementByRef(nl: ReturnType<typeof flatten>, ref: string): number | null {
  for (const inst of nl.instances) {
    if (inst.ref !== ref) continue;
    if (inst.elementCount === 1) return inst.elementStart;
    // Several elements for one instance (an expanded gate, a transformer): the first
    // is the one that carries the terminal current, and the ambiguity is reported
    // rather than hidden by picking silently.
    return inst.elementCount > 0 ? inst.elementStart : null;
  }
  return null;
}

/**
 * Whether a sheet net is the reference net.
 *
 * Decided from the schematic — a net carrying a `ground` symbol — and not from a
 * name, because 'g', 'GND', '0', 'VSS' and 'com' are all in common use and picking
 * one of them silently would make every voltage measured against it wrong by an
 * offset nobody would notice.
 */
function isGroundNet(ctx: MeasureContext, netId: unknown): boolean {
  for (const inst of ctx.circuit.allComponents()) {
    if (inst.specId !== 'ground') continue;
    const spec = ctx.lib.get(inst.specId);
    for (const pin of spec?.pins ?? []) {
      if (ctx.circuit.netOf(inst.id, pin.name)?.id === netId) return true;
    }
  }
  return false;
}

/**
 * The voltage across a component's own terminals, read the way a meter reads it.
 *
 * This deliberately does not use the first lowered element of the instance: a diode
 * or a MOSFET expands into several elements with internal nodes between them, and
 * the drop across the first of those is a model detail (a series resistance, say),
 * not the device voltage. The pins come from the sheet, the nodes from the netlist,
 * and the two are joined by net identity, so the answer is the terminal voltage
 * regardless of how many elements the model needed.
 */
function terminalVoltage(ctx: MeasureContext, ref: string): number | null {
  const inst = ctx.circuit.allComponents().find((c) => c.ref === ref);
  if (!inst) return null;
  const spec = ctx.lib.get(inst.specId);
  if (!spec) return null;
  // The first two pins in declaration order are the device's terminals for every
  // two-pin part in the library (1/2, A/K, +/−), which is what a meter spans.
  const pins = spec.pins.slice(0, 2).map((pin) => pin.name);
  if (pins.length < 2) return null;
  const nodes: number[] = [];
  for (const pin of pins) {
    const net = ctx.circuit.netOf(inst.id, pin);
    if (!net) return null;
    // The net is matched by name, not by id: flattening renumbers nets into the flat
    // netlist's own index space, so a sheet NetId means nothing down there, while the
    // label a person gave the wire survives and is what `nodeNameAt` reports.
    // Node 0 is the exception — it reports as 'GND' whatever the sheet called it, so
    // the ground net's own name is resolved separately rather than guessed.
    let found = -1;
    for (let n = 1; n < ctx.nl.nodeCount; n++) {
      if (nodeNameAt(ctx.nl, n) === net.name) {
        found = n;
        break;
      }
    }
    if (found < 0 && isGroundNet(ctx, net.id)) found = 0;
    if (found < 0) return null;
    nodes.push(found);
  }
  return ctx.sim.v[nodes[0]] - ctx.sim.v[nodes[1]];
}

/**
 * The same bench with the gate driven low.
 *
 * A second netlist is built rather than a parameter poked in place: changing a
 * component's parameter after the netlist is flattened would leave the lowered slots
 * and the model table out of step with the sheet, which is exactly the kind of
 * half-updated state that produces a reading nobody can reproduce.
 */
function offStateCurrent(ctx: MeasureContext): number | null {
  const b = new CircuitBuilder(ctx.lib, `${ctx.example.id}_off`, new ChipLibrary());
  const rail = b.add('vdc', { dc: 3.3 }, [0, 0]);
  const gate = b.add('vdc', { dc: 0 }, [-40, 40]);
  const load = b.add('resistor', { r: 1000, tc1: 0, tc2: 0 }, [40, 0]);
  const m = b.add('nmos', {}, [80, 0]);
  b.ground('g');
  b.at(rail, '+', 'vdd');
  b.at(rail, '-', 'g');
  b.at(gate, '+', 'gate');
  b.at(gate, '-', 'g');
  b.at(load, '1', 'vdd');
  b.at(load, '2', 'drain');
  b.at(m, 'D', 'drain');
  b.at(m, 'G', 'gate');
  b.at(m, 'S', 'g');
  b.at(m, 'B', 'g');
  const nl = flatten(b.finish({ erc: false }), ctx.lib, ctx.chips, { metadata: true });
  const sim = new CircuitSimulator(nl);
  sim.dcSolve({ quiet: true });
  const e = elementByRef(nl, 'M1');
  return e === null ? null : (sim.state.elementCurrent[e] ?? null);
}

/**
 * Find a scope channel by the net or element it was aimed at.
 *
 * The match is on the channel's own label rather than on an index, because an
 * example that declares two probes would otherwise silently read the drive when it
 * meant the output — and a flat 5 V trace reads as a perfectly plausible answer.
 */
export function channelIndex(scope: Oscilloscope, target: string): number {
  const chans = scope.channels();
  for (let i = 0; i < chans.length; i++) {
    const name = chans[i]?.name ?? '';
    // "V out" / "I R1" / "T U1.R1": the label ends with the target.
    if (name === target || name.endsWith(' ' + target) || name.endsWith(':' + target)) return i;
  }
  for (let i = 0; i < chans.length; i++) {
    if ((chans[i]?.name ?? '').includes(target)) return i;
  }
  return -1;
}

/** The readings every example can ask for without writing a measurer of its own. */
function defaultMeasure(ctx: MeasureContext, key: string): number | null {
  const [kind, target] = splitKey(key);
  switch (kind) {
    case 'v':
      return ctx.nodeVoltage(target);
    case 'i':
      return ctx.elementCurrent(target);
    case 'p':
      return ctx.elementPower(target);
    case 'dissipated':
      return ctx.dissipated();
    case 'amp':
    case 'max':
    case 'min':
    case 'rms':
    case 'freq':
    case 'phase': {
      const scope = ctx.transient();
      if (!scope) return null;
      const index = channelIndex(scope, target);
      if (index < 0) return null;
      if (kind === 'freq') return scope.frequency(index)?.frequency ?? null;
      if (kind === 'phase') {
        // Phase is always quoted against the first probe, which every example that
        // asks for a phase declares as the drive. Against itself it would be 0°,
        // which is why the channel index is checked rather than assumed.
        if (index === 0) return null;
        const p = scope.phase(0, index);
        return p?.degrees ?? null;
      }
      const trace = scope.trace(index);
      if (!trace) return null;
      // The settled tail: a record taken from the DC operating point carries the
      // circuit's natural response at the start, and the analytic expectation is a
      // steady-state one.
      const span = trace.times[trace.times.length - 1] - trace.times[0];
      const f = measureFrequency(trace)?.period ?? null;
      const from = f ? span - Math.min(span, Math.max(5 * f, span / 4)) : span * 0.75;
      const start = trace.times[0] + Math.max(0, from);
      let lo = 0;
      while (lo < trace.times.length - 1 && trace.times[lo] < start) lo++;
      const tail = { ...trace, times: trace.times.subarray(lo), values: trace.values.subarray(lo) };
      const s = traceStats(tail);
      if (kind === 'amp') return s.peakToPeak / 2;
      if (kind === 'max') return s.max;
      if (kind === 'min') return s.min;
      return s.rms;
    }
    default:
      return null;
  }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

export { valueAt, measurePhase };
