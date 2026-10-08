/**
 * The shapes a rendered sheet is made of.
 *
 * This module is geometry, not pixels: it turns a circuit into positioned blocks
 * with ports on named sides and wires as orthogonal polylines, in sheet units, and
 * it knows nothing about how any of it is rasterised. Two backends draw the same
 * layout — a 2D canvas in the GUI and an SVG string headlessly — which is what
 * makes the drawing testable without a browser and keeps the editor and the export
 * from disagreeing about where a wire runs.
 *
 * Sheet units are the units component positions are authored in. The library draws
 * symbols in a smaller "symbol" space (a gate body spans −1…1), and `SYMBOL_SCALE`
 * in the theme is the factor between them; 10 matches the spacing the reference
 * designs were laid out on, so symbols neither overlap nor drift apart.
 */

import type { SymbolShape } from '../core/library.js';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Which edge of a block a port sits on. */
export type PortSide = 'top' | 'bottom' | 'left' | 'right';

/** Four-state logic value, as level 0 reports it. */
export type LogicValue = 0 | 1 | 'X' | 'Z';

export interface RenderPort {
  name: string;
  direction: 'input' | 'output' | 'bidirectional' | 'passive' | 'supply' | 'ground';
  side: PortSide;
  /** Connection point in sheet units, already rotated and offset. */
  x: number;
  y: number;
  /** Bus lanes; 1 for a scalar pin. */
  width: number;
  /** Net attached on this sheet, when there is one. */
  net?: string;
  /** True when the pin may be left unconnected without a warning. */
  optional?: boolean;
  /** Index along the edge, for stable ordering in inspectors and hit tests. */
  index: number;
}

export interface RenderNode {
  /** Unique within the layout: the reference designator, or a path for a flattened sheet. */
  id: string;
  ref: string;
  /** Chip name or type name, as drawn on the block. */
  label: string;
  /** Dominant parameter, formatted, e.g. "10 kΩ" — drawn under the label. */
  value?: string;
  /** Library category: chip, gate, passive, source, semiconductor, instrument… */
  kind: string;
  /** Library type id. */
  type: string;
  /** Chip this block instantiates, at the hierarchical level. */
  chip?: string;
  /** Body centre, sheet units. */
  x: number;
  y: number;
  /** Body extent, sheet units. */
  w: number;
  h: number;
  rotation: 0 | 90 | 180 | 270;
  mirrorX?: boolean;
  mirrorY?: boolean;
  ports: RenderPort[];
  /** Authored symbol, in symbol units, centred on the body. */
  symbol: SymbolShape[];
  /** Vector multiplier: this block is `bits` physical copies. */
  bits: number;
  /** Hierarchy depth this block was taken from. */
  depth: number;
  /** Names of the ports this sheet actually connects. */
  connectedPorts: string[];
  /** True when the position was chosen by the auto-layout, not authored. */
  autoPlaced: boolean;
}

export interface WireEndpoint {
  node: string;
  port: string;
}

export interface RenderWire {
  net: string;
  /** Bus width; 1 for a scalar net. */
  width: number;
  /**
   * The trunk: the longest branch, from the driver to its furthest load. Every
   * segment is axis-aligned.
   */
  points: Point[];
  /**
   * One polyline per load, each axis-aligned on its own. A net with several loads is
   * a tree, and folding the branches into a single polyline would connect the end of
   * one branch to the start of the next — a diagonal run that no wire on a sheet
   * ever makes. Branches are drawn, hit-tested and bounded as the geometry they are.
   */
  branches: Point[][];
  /** One polyline per lane for a bus; empty for a scalar wire. */
  lanes: Point[][];
  endpoints: WireEndpoint[];
  /** False when nothing on the sheet drives this net. */
  driven: boolean;
  /** True when more than one output drives it. */
  conflict: boolean;
  /** Whether the geometry came from the routing pass or from authored wire points. */
  routed: 'auto' | 'authored';
  /** True when the net is a circuit port (drawn with an off-page connector). */
  isPort?: boolean;
}

/** A circuit-level port, drawn as an off-page connector at the sheet edge. */
export interface RenderSheetPort {
  name: string;
  direction: string;
  width: number;
  net?: string;
  x: number;
  y: number;
  side: PortSide;
}

export interface LayoutStats {
  nodes: number;
  wires: number;
  lanes: number;
  ports: number;
  autoPlaced: number;
  /** Blocks the auto-layout had to move because they sat on top of each other. */
  overlapsResolved: number;
  /** Wires whose two ends could not be routed orthogonally and fell back to a direct segment. */
  unrouted: number;
}

export interface SheetLayout {
  name: string;
  level: 'hierarchical' | 'flattened' | 'electrical';
  nodes: RenderNode[];
  wires: RenderWire[];
  sheetPorts: RenderSheetPort[];
  bounds: Bounds;
  stats: LayoutStats;
  style: {
    /** How chip ports were projected: the Lague look puts inputs on top. */
    portSides: 'top-bottom' | 'left-right';
    symbolScale: number;
    grid: number;
  };
  /** Anything a reader of the geometry should know (unplaced blocks, unknown types…). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Live state, drawn over the geometry
// ---------------------------------------------------------------------------

/** What a net was measured to be doing. Absent fields were not measured. */
export interface NetState {
  value?: LogicValue | 'bus';
  /** Bit pattern for a bus, most significant first, e.g. "01X1". */
  word?: string;
  voltage?: number | null;
  temperature?: number | null;
  driven?: boolean;
}

/** What a component was measured to be doing. */
export interface NodeState {
  temperature?: number | null;
  power?: number | null;
  /** Above the thermal limit the analysis was given. */
  hot?: boolean;
  /** A diagnostic attached to this component, shown as a badge. */
  error?: string | null;
}

export interface SheetState {
  nets: Record<string, NetState>;
  nodes: Record<string, NodeState>;
  selected?: string[];
  hovered?: string | null;
}

export function emptyState(): SheetState {
  return { nets: {}, nodes: {}, selected: [], hovered: null };
}

export function boundsOf(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

export function boundsWidth(b: Bounds): number {
  return b.maxX - b.minX;
}

export function boundsHeight(b: Bounds): number {
  return b.maxY - b.minY;
}

export function expandBounds(b: Bounds, p: Point): Bounds {
  return {
    minX: Math.min(b.minX, p.x),
    minY: Math.min(b.minY, p.y),
    maxX: Math.max(b.maxX, p.x),
    maxY: Math.max(b.maxY, p.y),
  };
}
