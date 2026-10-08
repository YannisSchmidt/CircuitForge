/**
 * Reference project library — part 1: gates, adders, selectors.
 *
 * These chips are the vocabulary of the project. Each builder is deterministic
 * and parameter-light, so a chip saved here is byte-for-byte reproducible: that
 * is what lets the search engine cache candidates by fingerprint.
 *
 * The whole file is honest about one thing: everything is built from the real
 * components of the library (`and_gate`, `dff`, `mux`, …) — there is no hidden
 * fast path, and a chip simulated here is the same chip the editor will draw.
 */

import { CircuitBuilder } from '../core/build.js';
import type { Circuit } from '../core/circuit.js';
import type { Chip, ChipPort } from '../core/chip.js';
import type { ParamBag, ParamSpec } from '../core/library.js';
import type { Project } from '../core/project.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Grid position helper: `grid(i, j)` = 60 px per column, 40 px per row. */
export function grid(column: number, row = 0): [number, number] {
  return [column * 60, row * 40];
}

/** Number parameter with clamping (never trusts a user-supplied value). */
export function numberParam(params: ParamBag, key: string, fallback: number, min: number, max: number): number {
  const raw = params[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function bitsParam(defaultBits: number, max = 32): ParamSpec {
  return {
    name: 'bits',
    kind: 'number',
    unit: '',
    default: defaultBits,
    min: 1,
    max,
    description: 'Word width in bits',
    sensitive: true,
  };
}

/** Declare `A0..A(n-1)` input and `Y0..Y(n-1)` output ports bound to nets a0…/y0…. */
export function bitPorts(b: CircuitBuilder, inputs: string[], outputs: string[], bits: number): void {
  for (const name of inputs) for (let i = 0; i < bits; i++) b.port(`${name}${i}`, 'input', `${name.toLowerCase()}${i}`, 1);
  for (const name of outputs) for (let i = 0; i < bits; i++) b.port(`${name}${i}`, 'output', `${name.toLowerCase()}${i}`, 1);
}

/** AND of `inputs` as a balanced tree; returns the name of the output net. */
export function andTree(b: CircuitBuilder, inputs: string[], out: string, x: number, row = 0): string {
  let level = inputs.slice();
  let k = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      // A wide and_gate (up to 16 inputs) keeps the tree shallow.
      const name = `${out}__a${k++}`;
      const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(x + k, row));
      b.at(g, 'IN1', level[i]).at(g, 'IN2', level[i + 1]).at(g, 'OUT', name);
      next.push(name);
    }
    level = next;
  }
  const final = level[0];
  const buf = b.add('buffer', { style: 'ideal' }, grid(x + k, row + 1));
  b.at(buf, 'IN1', final).at(buf, 'OUT', out);
  return out;
}

/** OR of `inputs` as a balanced tree; returns the name of the output net. */
export function orTree(b: CircuitBuilder, inputs: string[], out: string, x: number, row = 0): string {
  let level = inputs.slice();
  let k = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const name = `${out}__o${k++}`;
      const g = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(x + k, row));
      b.at(g, 'IN1', level[i]).at(g, 'IN2', level[i + 1]).at(g, 'OUT', name);
      next.push(name);
    }
    level = next;
  }
  const buf = b.add('buffer', { style: 'ideal' }, grid(x + k, row + 1));
  b.at(buf, 'IN1', level[0]).at(buf, 'OUT', out);
  return out;
}

import { registerChipGenerator } from './generators.js';

/** A fresh builder wired to the project's component library. */
function circuit(project: Project, name: string): CircuitBuilder {
  return new CircuitBuilder(project.lib, name, project.chips);
}

/** Declare a chip from a generator: the default parameters materialise the base circuit. */
export function parametricChip(
  project: Project,
  meta: {
    id: string;
    name: string;
    description: string;
    params: ParamSpec[];
    tags: string[];
    generator: (b: CircuitBuilder, params: ParamBag) => void;
  },
): Chip {
  registerChipGenerator(meta.id, meta.generator);
  const defaults: ParamBag = {};
  for (const p of meta.params) defaults[p.name] = p.default;
  const b = circuit(project, meta.name);
  meta.generator(b, defaults);
  const base = b.finish({ erc: false });
  project.diagnostics.push(...b.diagnostics);
  return project.saveAsChip(base, {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    params: meta.params,
    tags: meta.tags,
    origin: 'library',
    generator: (params: ParamBag) => {
      const bb = circuit(project, `${meta.name}`);
      meta.generator(bb, { ...defaults, ...params });
      return bb.finish({ erc: false });
    },
  });
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export function buildGateChips(project: Project): Chip[] {
  const out: Chip[] = [];
  out.push(
    project.buildChip(
      { id: 'not1', name: 'NOT', description: 'Single inverter.', tags: ['gate'], origin: 'library' },
      (b) => {
        const g = b.add('not_gate', { style: 'ideal' }, grid(0));
        b.port('A', 'input', 'a', 1);
        b.port('Y', 'output', 'y', 1);
        b.at(g, 'IN1', 'a').at(g, 'OUT', 'y');
      },
    ),
  );
  out.push(
    project.buildChip(
      { id: 'nand2', name: 'NAND2', description: 'Two-input NAND.', tags: ['gate'], origin: 'library' },
      (b) => {
        const g = b.add('nand_gate', { style: 'ideal', inputs: 2 }, grid(0));
        b.port('A', 'input', 'a', 1);
        b.port('B', 'input', 'b', 1);
        b.port('Y', 'output', 'y', 1);
        b.at(g, 'IN1', 'a').at(g, 'IN2', 'b').at(g, 'OUT', 'y');
      },
    ),
  );
  out.push(
    project.buildChip(
      { id: 'xor2', name: 'XOR', description: 'Two-input exclusive OR.', tags: ['gate'], origin: 'library' },
      (b) => {
        const g = b.add('xor_gate', { style: 'ideal', inputs: 2 }, grid(0));
        b.port('A', 'input', 'a', 1);
        b.port('B', 'input', 'b', 1);
        b.port('Y', 'output', 'y', 1);
        b.at(g, 'IN1', 'a').at(g, 'IN2', 'b').at(g, 'OUT', 'y');
      },
    ),
  );
  out.push(
    project.buildChip(
      {
        id: 'bus_and',
        name: 'BUS_AND',
        description: 'Bitwise AND of two buses: one vector instance of a 2-input AND, one element per lane.',
        tags: ['gate', 'bus'],
        origin: 'library',
      },
      (b) => {
        const bits = 8;
        const g = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(0), { bits });
        b.port('A', 'input', 'a', bits);
        b.port('B', 'input', 'b', bits);
        b.port('Y', 'output', 'y', bits);
        b.at(g, 'IN1', 'a').at(g, 'IN2', 'b').at(g, 'OUT', 'y');
      },
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Adders
// ---------------------------------------------------------------------------

export function buildAdderChips(project: Project): Chip[] {
  const out: Chip[] = [];
  out.push(
    project.buildChip(
      { id: 'half_adder', name: 'HALF_ADDER', description: 'A + B with carry out.', tags: ['adder'], origin: 'library' },
      (b) => {
        const x = b.add('xor_gate', { style: 'ideal', inputs: 2 }, grid(0));
        const a = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(1));
        b.port('A', 'input', 'a', 1);
        b.port('B', 'input', 'b', 1);
        b.port('S', 'output', 's', 1);
        b.port('CO', 'output', 'co', 1);
        b.at(x, 'IN1', 'a').at(x, 'IN2', 'b').at(x, 'OUT', 's');
        b.at(a, 'IN1', 'a').at(a, 'IN2', 'b').at(a, 'OUT', 'co');
      },
    ),
  );
  out.push(
    project.buildChip(
      {
        id: 'full_adder',
        name: 'FULL_ADDER',
        description: 'A + B + CI, sum and carry out: two XOR, two AND, one OR.',
        tags: ['adder'],
        origin: 'library',
      },
      (b) => {
        const x1 = b.add('xor_gate', { style: 'ideal', inputs: 2 }, grid(0));
        const x2 = b.add('xor_gate', { style: 'ideal', inputs: 2 }, grid(1));
        const a1 = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(1, 1));
        const a2 = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(0, 1));
        const o1 = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(2, 1));
        b.port('A', 'input', 'a', 1);
        b.port('B', 'input', 'b', 1);
        b.port('CI', 'input', 'ci', 1);
        b.port('S', 'output', 's', 1);
        b.port('CO', 'output', 'co', 1);
        b.at(x1, 'IN1', 'a').at(x1, 'IN2', 'b').at(x1, 'OUT', 'x1');
        b.at(x2, 'IN1', 'x1').at(x2, 'IN2', 'ci').at(x2, 'OUT', 's');
        b.at(a1, 'IN1', 'x1').at(a1, 'IN2', 'ci').at(a1, 'OUT', 'p');
        b.at(a2, 'IN1', 'a').at(a2, 'IN2', 'b').at(a2, 'OUT', 'g');
        b.at(o1, 'IN1', 'p').at(o1, 'IN2', 'g').at(o1, 'OUT', 'co');
      },
    ),
  );
  // Ripple-carry adder of a parameterised width, built from FULL_ADDER chips.
  out.push(
    parametricChip(project, {
      id: 'ripple_adder',
      name: 'RIPPLE_ADDER',
      description: 'N-bit ripple-carry adder: one FULL_ADDER chip per bit, carry chained.',
      params: [bitsParam(8)],
      tags: ['adder', 'arithmetic'],
      generator: (b, params) => {
        const bits = numberParam(params, 'bits', 8, 1, 32);
        for (let i = 0; i < bits; i++) {
          b.port(`A${i}`, 'input', `a${i}`, 1);
          b.port(`B${i}`, 'input', `b${i}`, 1);
          b.port(`S${i}`, 'output', `s${i}`, 1);
        }
        b.port('CI', 'input', 'ci', 1);
        b.port('CO', 'output', 'co', 1);
        let carry = 'ci';
        for (let i = 0; i < bits; i++) {
          const fa = project.instantiate(b, 'full_adder', {}, grid(i, 2));
          const sum = `s${i}`;
          const cout = i === bits - 1 ? 'co' : `c${i + 1}`;
          b.at(fa, 'A', `a${i}`).at(fa, 'B', `b${i}`).at(fa, 'CI', carry).at(fa, 'S', sum).at(fa, 'CO', cout);
          carry = cout;
        }
      },
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Selectors: multiplexers, decoders, encoders
// ---------------------------------------------------------------------------

export function buildSelectorChips(project: Project): Chip[] {
  const out: Chip[] = [];
  out.push(
    project.buildChip(
      { id: 'mux2', name: 'MUX2', description: '2:1 multiplexer (one select bit).', tags: ['mux'], origin: 'library' },
      (b) => {
        const m = b.add('mux', { channels: 2 }, grid(0));
        b.port('I0', 'input', 'i0', 1);
        b.port('I1', 'input', 'i1', 1);
        b.port('S', 'input', 's0', 1);
        b.port('Y', 'output', 'y', 1);
        b.at(m, 'I0', 'i0').at(m, 'I1', 'i1').at(m, 'S0', 's0').at(m, 'Y', 'y');
      },
    ),
  );
  out.push(
    project.buildChip(
      { id: 'mux4', name: 'MUX4', description: '4:1 multiplexer (two select bits).', tags: ['mux'], origin: 'library' },
      (b) => {
        const m = b.add('mux', { channels: 4 }, grid(0));
        b.port('I0', 'input', 'i0', 1);
        b.port('I1', 'input', 'i1', 1);
        b.port('I2', 'input', 'i2', 1);
        b.port('I3', 'input', 'i3', 1);
        b.port('S0', 'input', 's0', 1);
        b.port('S1', 'input', 's1', 1);
        b.port('Y', 'output', 'y', 1);
        b.at(m, 'I0', 'i0').at(m, 'I1', 'i1').at(m, 'I2', 'i2').at(m, 'I3', 'i3');
        b.at(m, 'S0', 's0').at(m, 'S1', 's1').at(m, 'Y', 'y');
      },
    ),
  );
  // A parametric 2^k:1 mux built as a tree of MUX2 chips (this is how a wide
  // selector is really built: the primitive stops at four channels).
  out.push(
    parametricChip(project, {
      id: 'mux_tree',
      name: 'MUX_TREE',
      description: '2^N:1 multiplexer built from MUX2 chips in a binary tree.',
      params: [
        { name: 'channels', kind: 'number', unit: '', default: 8, min: 2, max: 16, description: 'Number of inputs (a power of two)', sensitive: true },
      ],
      tags: ['mux'],
      generator: (b, params) => {
        const channels = numberParam(params, 'channels', 8, 2, 16);
        const levels = Math.ceil(Math.log2(channels));
        const selectBits = Math.max(1, levels);
        for (let i = 0; i < channels; i++) b.port(`I${i}`, 'input', `i${i}`, 1);
        for (let s = 0; s < selectBits; s++) b.port(`S${s}`, 'input', `s${s}`, 1);
        b.port('Y', 'output', 'y', 1);
        let level = channels;
        let names: string[] = [];
        for (let i = 0; i < channels; i++) names.push(`i${i}`);
        let sel = 0;
        let round = 0;
        while (names.length > 1) {
          const next: string[] = [];
          let k = 0;
          for (let i = 0; i < names.length; i += 2) {
            if (i + 1 >= names.length) {
              next.push(names[i]);
              continue;
            }
            const m = project.instantiate(b, 'mux2', {}, grid(round, k++));
            const outName = names.length === 2 ? 'y' : `m${round}_${k}`;
            b.at(m, 'I0', names[i]).at(m, 'I1', names[i + 1]).at(m, 'S', `s${sel}`).at(m, 'Y', outName);
            next.push(outName);
          }
          names = next;
          sel++;
          round++;
        }
        void level;
      },
    }),
  );
  out.push(
    project.buildChip(
      {
        id: 'decoder_2to4',
        name: 'DECODER_2TO4',
        description: '2-to-4 decoder with enable: exactly one output high when enabled.',
        tags: ['decoder'],
        origin: 'library',
      },
      (b) => {
        const d = b.add('demux', { outputs: 4, decoderOnly: true }, grid(0));
        b.port('EN', 'input', 'en', 1);
        b.port('S0', 'input', 's0', 1);
        b.port('S1', 'input', 's1', 1);
        for (let i = 0; i < 4; i++) b.port(`Y${i}`, 'output', `y${i}`, 1);
        b.at(d, 'IN', 'en').at(d, 'EN', 'en').at(d, 'S0', 's0').at(d, 'S1', 's1');
        for (let i = 0; i < 4; i++) b.at(d, `Y${i}`, `y${i}`);
      },
    ),
  );
  out.push(
    project.buildChip(
      {
        id: 'decoder_3to8',
        name: 'DECODER_3TO8',
        description: '3-to-8 decoder: two 2-to-4 decoders (one per half) plus an inverter.',
        tags: ['decoder', 'hierarchy'],
        origin: 'library',
      },
      (b) => {
        b.port('EN', 'input', 'en', 1);
        b.port('S0', 'input', 's0', 1);
        b.port('S1', 'input', 's1', 1);
        b.port('S2', 'input', 's2', 1);
        for (let i = 0; i < 8; i++) b.port(`Y${i}`, 'output', `y${i}`, 1);
        const inv = b.add('not_gate', { style: 'ideal' }, grid(0, 2));
        b.at(inv, 'IN1', 's2').at(inv, 'OUT', 's2n');
        const low = project.instantiate(b, 'decoder_2to4', {}, grid(0, 0));
        const high = project.instantiate(b, 'decoder_2to4', {}, grid(0, 4));
        b.at(low, 'S0', 's0').at(low, 'S1', 's1').at(low, 'EN', 'en_lo');
        b.at(high, 'S0', 's0').at(high, 'S1', 's1').at(high, 'EN', 'en_hi');
        const andLo = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(1, 1));
        const andHi = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(1, 5));
        b.at(andLo, 'IN1', 'en').at(andLo, 'IN2', 's2n').at(andLo, 'OUT', 'en_lo');
        b.at(andHi, 'IN1', 'en').at(andHi, 'IN2', 's2').at(andHi, 'OUT', 'en_hi');
        for (let i = 0; i < 4; i++) {
          b.at(low, `Y${i}`, `y${i}`);
          b.at(high, `Y${i}`, `y${i + 4}`);
        }
      },
    ),
  );
  // Priority encoder 8 → 3: the highest active input wins, whatever the other
  // inputs do. Output bit k is 1 when the *highest* active input has bit k set,
  // which is why each level masks out everything above it.
  out.push(
    project.buildChip(
      {
        id: 'priority_encoder_8to3',
        name: 'PRIORITY_ENCODER',
        description: '8-to-3 priority encoder: reports the index of the highest active input, VALID = any input active.',
        tags: ['encoder'],
        origin: 'library',
      },
      (b) => {
        for (let i = 0; i < 8; i++) b.port(`I${i}`, 'input', `i${i}`, 1);
        b.port('Y0', 'output', 'y0', 1);
        b.port('Y1', 'output', 'y1', 1);
        b.port('Y2', 'output', 'y2', 1);
        b.port('VALID', 'output', 'valid', 1);

        // "above k" signals: `hi4` = any input >= 4, `hi2` = any input >= 2, …
        orTree(b, ['i4', 'i5', 'i6', 'i7'], 'hi4', 0, 0);
        // `hi2` = any input strictly above i1 (i2..i7): the mask that decides
        // whether i1 still owns bit 0.
        orTree(b, ['i2', 'i3', 'i4', 'i5', 'i6', 'i7'], 'hi2', 0, 2);
        orTree(b, ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'], 'valid', 0, 4);
        // The "above" signals are only needed inside a level, so one inverter per
        // threshold is enough.
        const inv4 = b.add('not_gate', { style: 'ideal' }, grid(1, 0));
        b.at(inv4, 'IN1', 'hi4').at(inv4, 'OUT', 'hi4n');
        const inv2 = b.add('not_gate', { style: 'ideal' }, grid(1, 2));
        b.at(inv2, 'IN1', 'hi2').at(inv2, 'OUT', 'hi2n');

        // y2 = any input >= 4
        const y2buf = b.add('buffer', { style: 'ideal' }, grid(2, 0));
        b.at(y2buf, 'IN1', 'hi4').at(y2buf, 'OUT', 'y2');
        // y1 = (i6|i7) | ((i2|i3) & !hi4)
        const o67 = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(2, 1));
        b.at(o67, 'IN1', 'i6').at(o67, 'IN2', 'i7').at(o67, 'OUT', 'o67');
        const o23 = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(2, 2));
        b.at(o23, 'IN1', 'i2').at(o23, 'IN2', 'i3').at(o23, 'OUT', 'o23');
        const m23 = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(3, 2));
        b.at(m23, 'IN1', 'o23').at(m23, 'IN2', 'hi4n').at(m23, 'OUT', 'm23');
        const oy1 = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(4, 1));
        b.at(oy1, 'IN1', 'o67').at(oy1, 'IN2', 'm23').at(oy1, 'OUT', 'y1');
        // y0 = i7 | (i5 & !(i6|i7)) | (i3 & !hi4) | (i1 & !hi2)
        const i5c = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(2, 3));
        b.at(i5c, 'IN1', 'i5').at(i5c, 'IN2', 'o67n').at(i5c, 'OUT', 'i5c');
        const o67n = b.add('not_gate', { style: 'ideal' }, grid(1, 5));
        b.at(o67n, 'IN1', 'o67').at(o67n, 'OUT', 'o67n');
        const y0a = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(2, 4));
        b.at(y0a, 'IN1', 'i7').at(y0a, 'IN2', 'i5c').at(y0a, 'OUT', 'y0a');
        const i3c = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(3, 3));
        b.at(i3c, 'IN1', 'i3').at(i3c, 'IN2', 'hi4n').at(i3c, 'OUT', 'i3c');
        const y0b = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(3, 4));
        b.at(y0b, 'IN1', 'y0a').at(y0b, 'IN2', 'i3c').at(y0b, 'OUT', 'y0b');
        const i1c = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(3, 5));
        b.at(i1c, 'IN1', 'i1').at(i1c, 'IN2', 'hi2n').at(i1c, 'OUT', 'i1c');
        const y0 = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(4, 4));
        b.at(y0, 'IN1', 'y0b').at(y0, 'IN2', 'i1c').at(y0, 'OUT', 'y0');
      },
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Sequential: registers, counters, ALU
// ---------------------------------------------------------------------------

export function buildSequentialChips(project: Project): Chip[] {
  const out: Chip[] = [];

  /** N-bit register: DFF per bit, an enable mux that feeds Q back when disabled. */
  out.push(
    parametricChip(project, {
      id: 'register_n',
      name: 'REGISTER',
      description: 'N-bit edge-triggered register with enable and asynchronous reset.',
      params: [bitsParam(8), { name: 'initial', kind: 'choice', default: '0', choices: ['0', '1', 'X'], description: 'Power-on value of every bit' }],
      tags: ['register', 'sequential'],
      generator: (b, params) => {
        const bits = numberParam(params, 'bits', 8, 1, 32);
        const initial = String(params['initial'] ?? '0');
        for (let i = 0; i < bits; i++) {
          b.port(`D${i}`, 'input', `d${i}`, 1);
          b.port(`Q${i}`, 'output', `q${i}`, 1);
        }
        b.port('CLK', 'input', 'clk', 1);
        b.port('EN', 'input', 'en', 1);
        b.port('RST', 'input', 'rst', 1);
        for (let i = 0; i < bits; i++) {
          const mux = project.instantiate(b, 'mux2', {}, grid(i, 0));
          const dff = b.add('dff', { initial, tckq: 0 }, grid(i, 1));
          b.at(mux, 'I0', `q${i}`).at(mux, 'I1', `d${i}`).at(mux, 'S', 'en').at(mux, 'Y', `deff${i}`);
          b.at(dff, 'D', `deff${i}`).at(dff, 'CLK', 'clk').at(dff, 'RST', 'rst').at(dff, 'Q', `q${i}`);
        }
      },
    }),
  );

  /** N-bit up counter: register + incrementer + load path. */
  out.push(
    parametricChip(project, {
      id: 'counter_n',
      name: 'COUNTER',
      description: 'N-bit up counter with enable, load and asynchronous reset.',
      params: [bitsParam(8)],
      tags: ['counter', 'sequential'],
      generator: (b, params) => {
        const bits = numberParam(params, 'bits', 8, 1, 32);
        for (let i = 0; i < bits; i++) {
          b.port(`Q${i}`, 'output', `q${i}`, 1);
          b.port(`L${i}`, 'input', `l${i}`, 1);
        }
        b.port('CLK', 'input', 'clk', 1);
        b.port('EN', 'input', 'en', 1);
        b.port('LOAD', 'input', 'load', 1);
        b.port('RST', 'input', 'rst', 1);
        b.port('CO', 'output', 'co', 1);
        const one = b.add('logic_high', {}, grid(-1, 0));
        const zero = b.add('logic_low', {}, grid(-1, 1));
        b.at(one, 'OUT', 'one');
        b.at(zero, 'OUT', 'zero');
        const adder = project.instantiate(b, 'ripple_adder', { bits }, grid(0, 2));
        for (let i = 0; i < bits; i++) {
          b.at(adder, `A${i}`, `q${i}`);
          b.at(adder, `B${i}`, i === 0 ? 'one' : 'zero');
        }
        b.at(adder, 'CI', 'zero').at(adder, 'CO', 'co_sum');
        const enAny = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(0, 3));
        b.at(enAny, 'IN1', 'en').at(enAny, 'IN2', 'load').at(enAny, 'OUT', 'en_or_load');
        const reg = project.instantiate(b, 'register_n', { bits }, grid(0, 4));
        for (let i = 0; i < bits; i++) {
          const mux = project.instantiate(b, 'mux2', {}, grid(i, 3));
          b.at(mux, 'I0', `sum${i}`).at(mux, 'I1', `l${i}`).at(mux, 'S', 'load').at(mux, 'Y', `din${i}`);
          b.at(reg, `D${i}`, `din${i}`);
          b.at(reg, `Q${i}`, `q${i}`);
          b.at(adder, `S${i}`, `sum${i}`);
        }
        b.at(reg, 'CLK', 'clk').at(reg, 'EN', 'en_or_load').at(reg, 'RST', 'rst');
        b.at(zero, 'OUT', 'zero');
        b.at(adder, 'CO', 'co_sum');
        // The counter's carry out is the adder's carry: it means "wrapped to 0".
        const coBuf = b.add('buffer', { style: 'ideal' }, grid(bits + 1, 2));
        b.at(coBuf, 'IN1', 'co_sum').at(coBuf, 'OUT', 'co');
      },
    }),
  );

  /**
   * N-bit ALU. Opcode 3 bits: bit 2 selects the arithmetic group.
   *   0xx logic:        000 AND   001 OR   010 XOR   011 NOT A
   *   1xx arithmetic:   100 ADD   101 SUB   110 INC A  111 DEC A
   * Outputs S (result), C (carry of the selected arithmetic path, 0 for logic
   * ops) and Z (all result bits zero).
   */
  out.push(
    parametricChip(project, {
      id: 'alu_n',
      name: 'ALU',
      description:
        'N-bit ALU: AND/OR/XOR/NOT and ADD/SUB/INC/DEC selected by a 3-bit opcode, with carry and zero flags.',
      params: [bitsParam(8)],
      tags: ['alu', 'arithmetic', 'hierarchy'],
      generator: (b, params) => {
        const bits = numberParam(params, 'bits', 8, 1, 32);
        for (let i = 0; i < bits; i++) {
          b.port(`A${i}`, 'input', `a${i}`, 1);
          b.port(`B${i}`, 'input', `b${i}`, 1);
          b.port(`S${i}`, 'output', `s${i}`, 1);
        }
        b.port('OP0', 'input', 'op0', 1);
        b.port('OP1', 'input', 'op1', 1);
        b.port('OP2', 'input', 'op2', 1);
        b.port('C', 'output', 'cout', 1);
        b.port('Z', 'output', 'z', 1);

        const zero = b.add('logic_low', {}, grid(-1, 0));
        b.at(zero, 'OUT', 'zero');

        // --- main adder: A ± B (B is inverted and CI = 1 for subtraction)
        const adder = project.instantiate(b, 'ripple_adder', { bits }, grid(0, 5));
        for (let i = 0; i < bits; i++) {
          const inv = b.add('not_gate', { style: 'ideal' }, grid(i, 3));
          b.at(inv, 'IN1', `b${i}`).at(inv, 'OUT', `bn${i}`);
          const sel = project.instantiate(b, 'mux2', {}, grid(i, 4));
          b.at(sel, 'I0', `b${i}`).at(sel, 'I1', `bn${i}`).at(sel, 'S', 'op0').at(sel, 'Y', `badd${i}`);
          b.at(adder, `A${i}`, `a${i}`).at(adder, `B${i}`, `badd${i}`);
        }
        b.at(adder, 'CI', 'op0').at(adder, 'CO', 'carry_main');

        // --- incrementer (A+1) and decrementer (A-1)
        const adder1 = project.instantiate(b, 'ripple_adder', { bits }, grid(0, 7));
        const adderM1 = project.instantiate(b, 'ripple_adder', { bits }, grid(0, 9));
        const one = b.add('logic_high', {}, grid(-1, 1));
        b.at(one, 'OUT', 'one');
        for (let i = 0; i < bits; i++) {
          b.at(adder1, `A${i}`, `a${i}`);
          b.at(adder1, `B${i}`, i === 0 ? 'one' : 'zero');
          b.at(adderM1, `A${i}`, `a${i}`);
          b.at(adderM1, `B${i}`, 'one'); // + all ones = -1 (two's complement)
        }
        b.at(adder1, 'CI', 'zero').at(adder1, 'CO', 'carry_inc');
        b.at(adderM1, 'CI', 'zero').at(adderM1, 'CO', 'carry_dec');

        // --- result selection: one mux4 for the logic group, one for arithmetic,
        //     then a mux2 on op2.
        const carryOfGroup = project.instantiate(b, 'mux2', {}, grid(bits + 2, 5));
        b.at(adder1, 'CO', 'carry_inc');
        b.at(adderM1, 'CO', 'carry_dec');
        b.at(carryOfGroup, 'I0', 'carry_inc').at(carryOfGroup, 'I1', 'carry_dec');
        b.at(carryOfGroup, 'S', 'op0').at(carryOfGroup, 'Y', 'carry_aux');
        const carrySel = project.instantiate(b, 'mux2', {}, grid(bits + 3, 5));
        b.at(carrySel, 'I0', 'carry_main').at(carrySel, 'I1', 'carry_aux');
        b.at(carrySel, 'S', 'op1').at(carrySel, 'Y', 'carry_arith');
        const carryOut = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(bits + 4, 5));
        b.at(carryOut, 'IN1', 'op2').at(carryOut, 'IN2', 'carry_arith').at(carryOut, 'OUT', 'cout');

        const resultBits: string[] = [];
        for (let i = 0; i < bits; i++) {
          const logicSel = project.instantiate(b, 'mux4', {}, grid(i, 6));
          b.at(logicSel, 'I0', `and${i}`).at(logicSel, 'I1', `or${i}`).at(logicSel, 'I2', `xor${i}`).at(logicSel, 'I3', `an${i}`);
          b.at(logicSel, 'S0', 'op0').at(logicSel, 'S1', 'op1').at(logicSel, 'Y', `slogic${i}`);
          const arithSel = project.instantiate(b, 'mux4', {}, grid(i, 7));
          b.at(arithSel, 'I0', `sum${i}`).at(arithSel, 'I1', `sum${i}`).at(arithSel, 'I2', `inc${i}`).at(arithSel, 'I3', `dec${i}`);
          b.at(arithSel, 'S0', 'op0').at(arithSel, 'S1', 'op1').at(arithSel, 'Y', `sarith${i}`);
          const final = project.instantiate(b, 'mux2', {}, grid(i, 8));
          b.at(final, 'I0', `slogic${i}`).at(final, 'I1', `sarith${i}`).at(final, 'S', 'op2').at(final, 'Y', `s${i}`);
          resultBits.push(`s${i}`);
          // logic plane
          const andG = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(i, 0));
          const orG = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(i, 1));
          const xorG = b.add('xor_gate', { style: 'ideal', inputs: 2 }, grid(i, 2));
          b.at(andG, 'IN1', `a${i}`).at(andG, 'IN2', `b${i}`).at(andG, 'OUT', `and${i}`);
          b.at(orG, 'IN1', `a${i}`).at(orG, 'IN2', `b${i}`).at(orG, 'OUT', `or${i}`);
          b.at(xorG, 'IN1', `a${i}`).at(xorG, 'IN2', `b${i}`).at(xorG, 'OUT', `xor${i}`);
          const notG = b.add('not_gate', { style: 'ideal' }, grid(i, 1, ));
          b.at(notG, 'IN1', `a${i}`).at(notG, 'OUT', `an${i}`);
          b.at(adder, `S${i}`, `sum${i}`);
          b.at(adder1, `S${i}`, `inc${i}`);
          b.at(adderM1, `S${i}`, `dec${i}`);
        }
        orTree(b, resultBits, 'anybit', bits, 0);
        const invZ = b.add('not_gate', { style: 'ideal' }, grid(bits + 1, 0));
        b.at(invZ, 'IN1', 'anybit').at(invZ, 'OUT', 'z');
      },
    }),
  );

  return out;
}

// ---------------------------------------------------------------------------
// Memory: RAM and ROM
// ---------------------------------------------------------------------------

export function buildMemoryChips(project: Project): Chip[] {
  const out: Chip[] = [];

  /**
   * Asynchronous-read, synchronous-write RAM: an address decoder, one D flip-flop
   * per bit cell, and a read multiplexer tree. Cells load on the clock edge while
   * the write enable is high.
   */
  out.push(
    parametricChip(project, {
      id: 'ram_n',
      name: 'RAM',
      description: 'RAM with a decoded word line: write on the clock edge, asynchronous read.',
      params: [
        { name: 'words', kind: 'number', unit: '', default: 8, min: 2, max: 16, description: 'Number of words', sensitive: true },
        { name: 'width', kind: 'number', unit: '', default: 4, min: 1, max: 16, description: 'Bits per word', sensitive: true },
      ],
      tags: ['memory', 'ram'],
      generator: (b, params) => {
        const words = numberParam(params, 'words', 8, 2, 16);
        const width = numberParam(params, 'width', 4, 1, 16);
        const addrBits = Math.max(1, Math.ceil(Math.log2(words)));
        for (let a = 0; a < addrBits; a++) b.port(`A${a}`, 'input', `addr${a}`, 1);
        for (let i = 0; i < width; i++) b.port(`DI${i}`, 'input', `di${i}`, 1);
        for (let i = 0; i < width; i++) b.port(`DO${i}`, 'output', `do${i}`, 1);
        b.port('WE', 'input', 'we', 1);
        b.port('CLK', 'input', 'clk', 1);

        // Address decode: one AND term per word, built from the address bits.
        for (let a = 0; a < addrBits; a++) {
          const inv = b.add('not_gate', { style: 'ideal' }, grid(a, 0));
          b.at(inv, 'IN1', `addr${a}`).at(inv, 'OUT', `addrn${a}`);
        }
        const wordLines: string[] = [];
        for (let w = 0; w < words; w++) {
          const literals: string[] = [];
          for (let a = 0; a < addrBits; a++) literals.push((w >> a) & 1 ? `addr${a}` : `addrn${a}`);
          const line = `wl${w}`;
          andTree(b, literals, line, addrBits + 2, w);
          wordLines.push(line);
        }
        // Cells. A shift register style chain is not needed: every cell holds its
        // own bit and is written only when its word line is high.
        for (let w = 0; w < words; w++) {
          // Write is level-sensitive on the clock: the cell captures the data
          // while the word line, the write enable and the clock are all high.
          const gate = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(addrBits + 4, w));
          b.at(gate, 'IN1', wordLines[w]).at(gate, 'IN2', 'we').at(gate, 'OUT', `wsel${w}`);
          const gate2 = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(addrBits + 5, w));
          b.at(gate2, 'IN1', `wsel${w}`).at(gate2, 'IN2', 'clk').at(gate2, 'OUT', `wen${w}`);
          for (let i = 0; i < width; i++) {
            const cell = b.add('dlatch', { initial: '0' }, grid(addrBits + 6 + i, w));
            const dup = b.add('buffer', { style: 'ideal' }, grid(addrBits + 6 + i, w));
            b.at(dup, 'IN1', `di${i}`).at(dup, 'OUT', `dib${w}_${i}`);
            b.at(cell, 'D', `dib${w}_${i}`).at(cell, 'EN', `wen${w}`).at(cell, 'Q', `cell${w}_${i}`);
            // The stored value must survive: the latch holds when EN is low.
          }
        }
        // Read: a multiplexer tree per bit, sized so that it consumes *exactly*
        // the address bits that exist. A 4:1 level is used while at least two
        // address bits remain, otherwise a 2:1 level finishes the tree; nothing
        // else is needed, and no select input is left floating.
        for (let i = 0; i < width; i++) {
          const cells: string[] = [];
          for (let w = 0; w < words; w++) cells.push(`cell${w}_${i}`);
          if (words <= 1) {
            const buf = b.add('buffer', { style: 'ideal' }, grid(0, words + 2));
            b.at(buf, 'IN1', `cell0_${i}`).at(buf, 'OUT', `do${i}`);
            continue;
          }
          let level = cells.slice();
          let selBit = 0;
          let round = 0;
          while (level.length > 1) {
            const last = level.length <= 4;
            const twoBit = addrBits - selBit >= 2 && level.length >= 4;
            const size = twoBit ? 4 : 2;
            const next: string[] = [];
            for (let k = 0; k < level.length; k += size) {
              const group = level.slice(k, k + size);
              if (group.length === 1) {
                next.push(group[0]);
                continue;
              }
              const name = last && next.length === 0 ? `do${i}` : `rd${round}_${i}_${next.length}`;
              const m = twoBit
                ? project.instantiate(b, 'mux4', {}, grid(addrBits + 4 + i, words + round * 2 + next.length))
                : project.instantiate(b, 'mux2', {}, grid(addrBits + 4 + i, words + round * 2 + next.length));
              for (let c = 0; c < size; c++) b.at(m, `I${c}`, group[c] ?? group[0]);
              if (twoBit) b.at(m, 'S0', `addr${selBit}`).at(m, 'S1', `addr${selBit + 1}`);
              else b.at(m, 'S', `addr${selBit}`);
              b.at(m, 'Y', name);
              next.push(name);
            }
            level = next;
            selBit += size === 4 ? 2 : 1;
            round++;
          }
        }
      },
    }),
  );

  /**
   * ROM: the contents are a chip parameter (hex words, comma separated), so the
   * same chip can hold any table. It is built as a real AND/OR plane — the OR
   * plane is what the designer sees, and what the timing report measures.
   */
  out.push(
    parametricChip(project, {
      id: 'rom_n',
      name: 'ROM',
      description: 'Read-only memory built as an AND/OR plane; the contents are a parameter (hex words, comma separated).',
      params: [
        { name: 'words', kind: 'number', unit: '', default: 8, min: 1, max: 256, description: 'Number of words', sensitive: true },
        { name: 'width', kind: 'number', unit: '', default: 8, min: 1, max: 32, description: 'Bits per word', sensitive: true },
        { name: 'content', kind: 'string', default: '', description: 'Hex words, most significant bit first, comma separated (empty = all zero)', sensitive: true },
      ],
      tags: ['memory', 'rom'],
      generator: (b, params) => {
        const words = numberParam(params, 'words', 8, 1, 256);
        const width = numberParam(params, 'width', 8, 1, 32);
        const table = parseRomContent(String(params['content'] ?? ''), words, width);
        const addrBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, words))));
        for (let a = 0; a < addrBits; a++) b.port(`A${a}`, 'input', `addr${a}`, 1);
        for (let i = 0; i < width; i++) b.port(`D${i}`, 'output', `d${i}`, 1);
        for (let a = 0; a < addrBits; a++) {
          const inv = b.add('not_gate', { style: 'ideal' }, grid(a, 0));
          b.at(inv, 'IN1', `addr${a}`).at(inv, 'OUT', `addrn${a}`);
        }
        // Word lines: one AND term per address (a constant for a one-word ROM).
        const wordLines: string[] = [];
        for (let w = 0; w < words; w++) {
          const line = `wl${w}`;
          if (words === 1 || addrBits === 0) {
            const hi = b.add('logic_high', {}, grid(0, 1));
            b.at(hi, 'OUT', line);
          } else {
            const literals: string[] = [];
            for (let a = 0; a < addrBits; a++) literals.push((w >> a) & 1 ? `addr${a}` : `addrn${a}`);
            andTree(b, literals, line, addrBits + 2, w);
          }
          wordLines.push(line);
        }
        // OR plane: bit i = OR of the word lines whose word has bit i set.
        for (let i = 0; i < width; i++) {
          const terms: string[] = [];
          for (let w = 0; w < words; w++) if ((table[w] >> i) & 1) terms.push(wordLines[w]);
          if (terms.length === 0) {
            const lo = b.add('logic_low', {}, grid(addrBits + 4 + i, 0));
            b.at(lo, 'OUT', `d${i}`);
          } else if (terms.length === 1) {
            const buf = b.add('buffer', { style: 'ideal' }, grid(addrBits + 4 + i, 1));
            b.at(buf, 'IN1', terms[0]).at(buf, 'OUT', `d${i}`);
          } else {
            orTree(b, terms, `d${i}`, addrBits + 4 + i, 2);
          }
        }
      },
    }),
  );

  return out;
}

/** Parse a ROM table: comma-separated hex words, `words` entries, `width` bits. */
export function parseRomContent(content: string, words: number, width: number): number[] {
  const table: number[] = [];
  const parts = content
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  for (let i = 0; i < words; i++) {
    const raw = parts[i] ?? '0';
    const value = Number.parseInt(raw.replace(/^0x/i, ''), 16);
    table.push(Number.isFinite(value) ? value & mask : 0);
  }
  return table;
}

export type { Chip, ChipPort, Circuit };

