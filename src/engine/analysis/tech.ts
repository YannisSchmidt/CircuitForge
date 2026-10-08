/**
 * Delay models for the static timing analysis (STA).
 *
 * A timing report is only as good as the delays it uses, and the engine refuses
 * to mix the two things a delay can be:
 *
 *   D0 — `declaredDelays` (the default): every element contributes exactly the
 *        delay it declares (tphl / tplh / tckq / setup). If a model declares 0,
 *        the element contributes 0, the report lists it under `idealDelays` and
 *        the path is flagged: the total is then a **lower bound**, never a claim.
 *
 *   D1 — an explicit *delay table*: a per-function table the caller supplies.
 *        The engine ships one (`ILLUSTRATIVE_CMOS_TABLE`) so that a design built
 *        from ideal models can still be *ranked* for speed, but the table is
 *        labelled everywhere it is used: it is a declared technology assumption,
 *        not a measurement, and every report says which table produced its
 *        numbers. Replace it with your own table — `analyzeTiming` takes any
 *        function `(element, edge) => seconds`.
 *
 * Nothing here invents a physical delay: a table is an *input*, and the honesty
 * comes from naming it, keeping it replaceable and reporting it next to the
 * number it produced.
 */

import { LOGIC_FN, type LogicElement } from './logic.js';
import type { EdgeKind, TimingElementDelay, TimingModel } from './timing.js';

export interface DelayTable {
  /** Short id used in reports, e.g. 'T1'. */
  id: string;
  name: string;
  /** What the numbers are, and what they are not. */
  description: string;
  /** Delay per logic function, in seconds (`LOGIC_FN` values as keys). */
  byFunction: Record<number, TimingElementDelay>;
  /** Delay of a multiplexer / demultiplexer / decoder element. */
  mux: TimingElementDelay;
  /** Delay of a tristate buffer when enabled. */
  tristate: TimingElementDelay;
  /** Register clock-to-Q and setup used when a register declares 0. */
  register: { tckq: number; setup: number };
}

/**
 * An *illustrative* 5 V CMOS logic family: the few-nanosecond range of classic
 * 74-series logic. These numbers are a declared assumption used to compare
 * designs, not the characterisation of any real process; the table is named 'T1'
 * in every report and can be replaced wholesale.
 */
export const ILLUSTRATIVE_CMOS_TABLE: DelayTable = {
  id: 'T1',
  name: 'illustrative 5 V CMOS (≈74HC class)',
  description:
    'A synthetic delay table in the few-nanosecond range of classic 74-series CMOS logic. It is a *ranking aid* for designs whose models declare no delay: ' +
    'not a measurement, not a process characterisation, and no load or slew dependence.',
  byFunction: {
    [LOGIC_FN.BUF]: { tphl: 0.6e-9, tplh: 0.6e-9 },
    [LOGIC_FN.NOT]: { tphl: 0.6e-9, tplh: 0.6e-9 },
    [LOGIC_FN.AND]: { tphl: 0.9e-9, tplh: 1.0e-9 },
    [LOGIC_FN.NAND]: { tphl: 0.8e-9, tplh: 0.9e-9 },
    [LOGIC_FN.OR]: { tphl: 1.0e-9, tplh: 0.9e-9 },
    [LOGIC_FN.NOR]: { tphl: 0.9e-9, tplh: 0.8e-9 },
    [LOGIC_FN.XOR]: { tphl: 1.4e-9, tplh: 1.4e-9 },
    [LOGIC_FN.XNOR]: { tphl: 1.4e-9, tplh: 1.4e-9 },
    [LOGIC_FN.CONST_HIGH]: { tphl: 0, tplh: 0 },
    [LOGIC_FN.CONST_LOW]: { tphl: 0, tplh: 0 },
  },
  mux: { tphl: 1.0e-9, tplh: 1.0e-9 },
  tristate: { tphl: 0.8e-9, tplh: 0.8e-9 },
  register: { tckq: 2.0e-9, setup: 1.0e-9 },
};

/** Per-edge delay model built from a table. Elements that declare a delay keep it. */
export function tableTimingModel(table: DelayTable, opts: { overrideDeclared?: boolean } = {}): TimingModel {
  return (el: LogicElement, edge: EdgeKind): number => {
    const declared = edge === 'rise' ? el.tplh : el.tphl;
    if (!opts.overrideDeclared && declared > 0) return declared;
    switch (el.kind) {
      case 'mux':
      case 'demux': {
        const d = table.mux;
        // A wider selector costs one delay step per select bit: an explicit,
        // documented rule of the table, not a fitted model.
        const steps = Math.max(1, el.selects.length);
        return (edge === 'rise' ? d.tplh : d.tphl) * steps;
      }
      case 'tristate':
        return edge === 'rise' ? table.tristate.tplh : table.tristate.tphl;
      case 'dff':
      case 'latch':
        return table.register.tckq;
      default: {
        const d = table.byFunction[el.fn];
        if (!d) return 0;
        return edge === 'rise' ? d.tplh : d.tphl;
      }
    }
  };
}

/** Clock-to-Q model for a table (`0` when the register declares its own). */
export function tableClockToQ(table: DelayTable, overrideDeclared = false): (el: LogicElement) => number {
  return (el: LogicElement) => {
    const declared = Math.max(el.tplh, el.tphl);
    if (declared > 0 && !overrideDeclared) return declared;
    return table.register.tckq;
  };
}

/** Setup model for a table (`0` when the register declares its own). */
export function tableSetup(table: DelayTable, overrideDeclared = false): (el: LogicElement) => number {
  return (el: LogicElement) => {
    if (el.setup > 0 && !overrideDeclared) return el.setup;
    return table.register.setup;
  };
}

/** Everything `analyzeTiming` needs for one named timing model. */
export interface TimingModelSet {
  id: string;
  name: string;
  description: string;
  model: TimingModel;
  clockToQ: (el: LogicElement) => number;
  setup: (el: LogicElement) => number;
}

/** The default: use exactly what the models declare. */
export function declaredDelays(): TimingModelSet {
  return {
    id: 'D0',
    name: 'declared delays',
    description: 'Every element contributes the delay it declares (tphl/tplh/tckq/setup, from its parameters). A declared 0 means the model does not model delay: the path is then a lower bound.',
    model: (el, edge) => (edge === 'rise' ? el.tplh : el.tphl),
    clockToQ: (el) => Math.max(el.tplh, el.tphl),
    setup: (el) => Math.max(0, el.setup),
  };
}

/** A named table, with declared delays taking precedence unless overridden. */
export function tableDelays(table: DelayTable, opts: { overrideDeclared?: boolean } = {}): TimingModelSet {
  return {
    id: table.id,
    name: table.name,
    description: table.description,
    model: tableTimingModel(table, opts),
    clockToQ: tableClockToQ(table, opts.overrideDeclared ?? false),
    setup: tableSetup(table, opts.overrideDeclared ?? false),
  };
}

/** Resolve a model option: `'declared'`, `'illustrative'`, a table, or a set. */
export function resolveTimingModel(
  option: 'declared' | 'illustrative' | DelayTable | TimingModelSet | undefined,
): TimingModelSet {
  if (option === undefined || option === 'declared') return declaredDelays();
  if (option === 'illustrative') return tableDelays(ILLUSTRATIVE_CMOS_TABLE);
  if ('model' in option) return option;
  return tableDelays(option);
}
