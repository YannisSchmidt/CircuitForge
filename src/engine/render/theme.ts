/**
 * The look of a sheet, and the numbers that fix its geometry.
 *
 * One palette and one set of sizes, shared by the GUI, the SVG exporter and the
 * tests, so a block is the same shape everywhere and a colour always means the same
 * thing: green is a determined high, blue-grey a determined low, amber an unknown,
 * red a floating or contested net. Nothing here is decorative guesswork — the wire
 * colours are the four logic states level 0 reports, plus the two faults the ERC
 * reports (undriven and multiply driven).
 *
 * The dark theme is the default because it is what the reference for this
 * interface — Sebastian Lague's Digital Logic Sim — uses, and because a sheet of
 * brightly coloured wires on a light background is hard to read at the zoom levels a
 * hierarchical design needs.
 */

import type { LogicValue } from './types.js';

/** Sheet units per symbol unit: the library draws a gate body across −1…1. */
export const SYMBOL_SCALE = 10;

/** Layout constants, in sheet units. */
export const LAYOUT = {
  /** Placement grid the auto-layout snaps to. */
  grid: 20,
  /** Wire stub leaving a port before the first bend. */
  stub: 14,
  /** Gap between parallel wire runs in the same channel. */
  laneGap: 4,
  /** Gap between lanes of one bus. */
  busLaneGap: 2.4,
  /** Minimum gap kept between two blocks by the auto-layout. */
  nodeGap: 24,
  /** Corner radius of a block, in sheet units. */
  blockRadius: 4,
  /** Corner radius applied to a wire bend, in sheet units. */
  wireRadius: 5,
  /** How far a port sits outside the block body. */
  portReach: 10,
  /** Size of the square drawn at a connection point. */
  portSize: 4,
  /** Spacing between chip ports projected onto the top and bottom edges. */
  chipPortSpacing: 12,
  /** Minimum block width, however few ports it has. */
  minBlockWidth: 60,
  /** Minimum block height. */
  minBlockHeight: 36,
} as const;

export interface ThemeColors {
  canvas: string;
  grid: string;
  gridMajor: string;
  panel: string;
  text: string;
  textDim: string;
  accent: string;
}

export interface ThemeWire {
  idle: string;
  zero: string;
  one: string;
  unknown: string;
  floating: string;
  bus: string;
  undriven: string;
  conflict: string;
  selected: string;
}

export interface ThemeNode {
  fill: string;
  stroke: string;
  chipFill: string;
  chipStroke: string;
  text: string;
  textDim: string;
  port: string;
  portConnected: string;
  selected: string;
  hovered: string;
  hot: string;
  error: string;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  wire: ThemeWire;
  node: ThemeNode;
  /** Stroke widths, in sheet units. */
  widths: {
    wire: number;
    bus: number;
    outline: number;
    symbol: number;
    selection: number;
  };
  font: {
    family: string;
    /** Label size in sheet units. */
    label: number;
    value: number;
    port: number;
    badge: number;
  };
}

export const DARK_THEME: Theme = {
  name: 'dark',
  colors: {
    canvas: '#1b1d23',
    grid: '#23262e',
    gridMajor: '#2b2f39',
    panel: '#22252c',
    text: '#e6e8ee',
    textDim: '#9aa1b1',
    accent: '#6cc4ff',
  },
  wire: {
    idle: '#5a6172',
    zero: '#7d879b',
    one: '#4ade80',
    unknown: '#fbbf24',
    floating: '#94a3b8',
    bus: '#60a5fa',
    undriven: '#f59e0b',
    conflict: '#f87171',
    selected: '#6cc4ff',
  },
  node: {
    fill: '#2a2e37',
    stroke: '#4b5261',
    chipFill: '#2f3542',
    chipStroke: '#6cc4ff',
    text: '#e6e8ee',
    textDim: '#9aa1b1',
    port: '#8b93a5',
    portConnected: '#d7dce6',
    selected: '#6cc4ff',
    hovered: '#8fd4ff',
    hot: '#f87171',
    error: '#fbbf24',
  },
  widths: { wire: 2.2, bus: 3.2, outline: 1.6, symbol: 1.6, selection: 2.4 },
  font: { family: 'Inter, "Segoe UI", system-ui, sans-serif', label: 11, value: 8.5, port: 7.5, badge: 8 },
};

export const LIGHT_THEME: Theme = {
  ...DARK_THEME,
  name: 'light',
  colors: {
    canvas: '#f6f7f9',
    grid: '#e6e8ee',
    gridMajor: '#d6dae2',
    panel: '#ffffff',
    text: '#1b1d23',
    textDim: '#5d6577',
    accent: '#1d7fc4',
  },
  wire: {
    idle: '#98a0b0',
    zero: '#5d6577',
    one: '#16a34a',
    unknown: '#d97706',
    floating: '#94a3b8',
    bus: '#2563eb',
    undriven: '#d97706',
    conflict: '#dc2626',
    selected: '#1d7fc4',
  },
  node: {
    fill: '#ffffff',
    stroke: '#b6bcc9',
    chipFill: '#f2f5fa',
    chipStroke: '#1d7fc4',
    text: '#1b1d23',
    textDim: '#5d6577',
    port: '#6b7280',
    portConnected: '#1f2937',
    selected: '#1d7fc4',
    hovered: '#3b95d8',
    hot: '#dc2626',
    error: '#d97706',
  },
};

export const THEMES: Record<string, Theme> = { dark: DARK_THEME, light: LIGHT_THEME };

export function themeByName(name: string | undefined): Theme {
  return (name && THEMES[name]) || DARK_THEME;
}

/** The colour a net is drawn in, given what was measured about it. */
export function wireColor(theme: Theme, state: { value?: LogicValue | 'bus'; driven?: boolean } | undefined, wire: { width: number; driven: boolean; conflict: boolean; isPort?: boolean }): string {
  if (wire.conflict) return theme.wire.conflict;
  if (!wire.driven && !wire.isPort) return theme.wire.undriven;
  if (!state) return wire.width > 1 ? theme.wire.bus : theme.wire.idle;
  if (state.value === 'bus') return theme.wire.bus;
  if (state.value === 1) return theme.wire.one;
  if (state.value === 0) return theme.wire.zero;
  if (state.value === 'X') return theme.wire.unknown;
  if (state.value === 'Z') return theme.wire.floating;
  if (state.driven === false) return theme.wire.undriven;
  return wire.width > 1 ? theme.wire.bus : theme.wire.idle;
}
