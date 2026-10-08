/**
 * The view transform: zoom, pan, fit, and picking.
 *
 * A sheet lives in world units and a screen lives in pixels; this is the whole
 * relationship between them, kept in one place so the canvas, the hit tests and the
 * SVG export cannot disagree about where something is.
 *
 *   screen = (world − view.origin) × view.scale
 *
 * The transform is immutable: every operation returns a new one, which is what makes
 * an undoable editor and a testable renderer the same code.
 */

import type { Bounds, Point, RenderNode, RenderPort, RenderWire, SheetLayout } from './types.js';
import { boundsHeight, boundsWidth } from './types.js';

export interface Viewport {
  width: number;
  height: number;
}

export interface ViewTransform {
  /** World coordinate at the top-left of the viewport. */
  x: number;
  y: number;
  /** Pixels per world unit. */
  scale: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 40;

export function view(x = 0, y = 0, scale = 1): ViewTransform {
  return { x, y, scale: clampScale(scale) };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function worldToScreen(v: ViewTransform, p: Point): Point {
  return { x: (p.x - v.x) * v.scale, y: (p.y - v.y) * v.scale };
}

export function screenToWorld(v: ViewTransform, p: Point): Point {
  return { x: p.x / v.scale + v.x, y: p.y / v.scale + v.y };
}

/** Zoom keeping the world point under `screen` fixed — the wheel-zoom users expect. */
export function zoomAt(v: ViewTransform, screen: Point, factor: number): ViewTransform {
  const before = screenToWorld(v, screen);
  const scale = clampScale(v.scale * factor);
  if (scale === v.scale) return v;
  return { x: before.x - screen.x / scale, y: before.y - screen.y / scale, scale };
}

export function panBy(v: ViewTransform, dxScreen: number, dyScreen: number): ViewTransform {
  return { x: v.x - dxScreen / v.scale, y: v.y - dyScreen / v.scale, scale: v.scale };
}

/** Fit a world rectangle into a viewport, keeping the aspect ratio, with padding. */
export function fitBounds(bounds: Bounds, viewport: Viewport, padding = 40): ViewTransform {
  const w = Math.max(1, boundsWidth(bounds));
  const h = Math.max(1, boundsHeight(bounds));
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(availW / w, availH / h));
  return {
    x: bounds.minX + w / 2 - viewport.width / 2 / scale,
    y: bounds.minY + h / 2 - viewport.height / 2 / scale,
    scale,
  };
}

/** The world rectangle currently on screen. */
export function visibleBounds(v: ViewTransform, viewport: Viewport): Bounds {
  const a = screenToWorld(v, { x: 0, y: 0 });
  const b = screenToWorld(v, { x: viewport.width, y: viewport.height });
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Cull to what is on screen: the reason a hundred-thousand-component sheet can be drawn. */
export function visibleNodes(layout: SheetLayout, v: ViewTransform, viewport: Viewport): RenderNode[] {
  const vis = visibleBounds(v, viewport);
  return layout.nodes.filter((n) => intersects(nodeBounds(n), vis));
}

export function visibleWires(layout: SheetLayout, v: ViewTransform, viewport: Viewport): RenderWire[] {
  const vis = visibleBounds(v, viewport);
  return layout.wires.filter((w) => intersects(wireBounds(w), vis));
}

/** Bounds of a wire, over every branch and lane it is drawn as. */
export function wireBounds(w: RenderWire): Bounds {
  let b = polylineBounds(w.points);
  for (const branch of w.branches) b = unionBounds(b, polylineBounds(branch));
  for (const lane of w.lanes) b = unionBounds(b, polylineBounds(lane));
  return b;
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function nodeBounds(n: RenderNode): Bounds {
  const hw = Math.max(n.w, n.h) / 2 + 4;
  // A rotated block sweeps a wider box; using the diagonal keeps the cull safe
  // without recomputing the rotated corners for every test.
  const half = n.rotation % 180 === 0 ? Math.max(n.w / 2, n.h / 2) : Math.hypot(n.w, n.h) / 2;
  const r = Math.max(hw, half);
  return { minX: n.x - r, minY: n.y - r, maxX: n.x + r, maxY: n.y + r };
}

export function polylineBounds(points: Point[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export type PickKind = 'node' | 'port' | 'wire' | 'sheet-port' | 'none';

export interface PickResult {
  kind: PickKind;
  nodeId?: string;
  portName?: string;
  net?: string;
  /** World distance to the picked feature; 0 for a hit inside a block. */
  distance: number;
}

const NONE: PickResult = { kind: 'none', distance: Infinity };

/** Distance from a point to a segment, in world units. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distanceToSegment(p, points[i - 1], points[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * What is under a world point.
 *
 * Precedence is explicit, not incidental: a port beats a wire, a wire beats a block.
 * It has to be, because a wire starts exactly at the port it connects — at distance
 * zero — so ordering by distance alone would always return the wire and make ports
 * unclickable. Within one kind the closest feature wins.
 *
 * `tolerance` is in world units, so it should be derived from a pixel tolerance
 * divided by the scale: a fixed world tolerance is unusable when zoomed out.
 */
export function pick(layout: SheetLayout, world: Point, tolerance = 6): PickResult {
  let best: PickResult = NONE;
  const better = (candidate: PickResult): boolean => {
    if (best.kind === 'none') return true;
    const a = PICK_RANK[candidate.kind];
    const b = PICK_RANK[best.kind];
    return a < b || (a === b && candidate.distance < best.distance);
  };
  for (const n of layout.nodes) {
    for (const p of n.ports) {
      const d = Math.hypot(world.x - p.x, world.y - p.y);
      if (d <= tolerance && better({ kind: 'port', nodeId: n.id, portName: p.name, net: p.net, distance: d })) {
        best = { kind: 'port', nodeId: n.id, portName: p.name, net: p.net, distance: d };
      }
    }
  }
  for (const sp of layout.sheetPorts) {
    const d = Math.hypot(world.x - sp.x, world.y - sp.y);
    if (d <= tolerance && better({ kind: 'sheet-port', net: sp.net, portName: sp.name, distance: d })) {
      best = { kind: 'sheet-port', net: sp.net, portName: sp.name, distance: d };
    }
  }
  for (const w of layout.wires) {
    let d = distanceToPolyline(world, w.points);
    for (const branch of w.branches) d = Math.min(d, distanceToPolyline(world, branch));
    if (d <= tolerance && better({ kind: 'wire', net: w.net, distance: d })) best = { kind: 'wire', net: w.net, distance: d };
  }
  if (best.kind === 'none') {
    for (const n of layout.nodes) {
      if (insideNode(n, world)) return { kind: 'node', nodeId: n.id, distance: 0 };
    }
  }
  return best;
}

const PICK_RANK: Record<PickKind, number> = { port: 0, 'sheet-port': 1, wire: 2, node: 3, none: 4 };

/** Point-in-block, honouring rotation by testing in the block's own frame. */
export function insideNode(n: RenderNode, p: Point): boolean {
  const dx = p.x - n.x;
  const dy = p.y - n.y;
  const rad = (-n.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const hw = n.w / 2;
  const hh = n.h / 2;
  return lx >= -hw && lx <= hw && ly >= -hh && ly <= hh;
}

/** The port of a node by name, or null. */
export function portOf(n: RenderNode, name: string): RenderPort | null {
  for (const p of n.ports) if (p.name === name) return p;
  return null;
}
