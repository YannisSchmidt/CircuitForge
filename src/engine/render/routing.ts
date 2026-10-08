/**
 * Wire routing.
 *
 * Wires are orthogonal polylines with a short stub out of each port, which is what
 * makes a sheet readable at a glance and what the reference interface for this
 * project draws. The router is deliberately simple and fully deterministic: it never
 * claims a crossing-free result, because finding one is a general routing problem,
 * and a sheet that pretends otherwise is a sheet that hides a wire behind another.
 * What it does guarantee is stated here and tested:
 *
 *   - every segment is axis-aligned, so a wire never cuts diagonally across blocks;
 *   - the first and last segments leave and enter their ports perpendicular to the
 *     edge the port sits on;
 *   - parallel runs in the same channel are offset by `laneGap`, in a stable order
 *     derived from the endpoints, so two wires do not draw on top of each other and
 *     the same sheet routes the same way every time;
 *   - a bus is drawn as one polyline per lane, offset by `busLaneGap`.
 *
 * Crossings are counted and reported instead of being resolved: `crossings()` gives
 * the analysis pass a real number to warn about, which is more honest than a router
 * that silently fails on a dense sheet.
 */

import type { Bounds, Point, PortSide, RenderWire } from './types.js';
import { LAYOUT } from './theme.js';

export interface RouteOptions {
  stub?: number;
  laneGap?: number;
  busLaneGap?: number;
  /** Channel index this wire occupies, for offsetting parallel runs. */
  channel?: number;
}

/** Outward unit vector for a port side. */
export function sideVector(side: PortSide): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** Whether a side leaves vertically (top/bottom) or horizontally (left/right). */
export function isVertical(side: PortSide): boolean {
  return side === 'top' || side === 'bottom';
}

function pushIfNew(points: Point[], p: Point): void {
  const last = points[points.length - 1];
  if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
}

/**
 * Route one wire between two ports.
 *
 * The path leaves `from` along its stub, turns once or twice, and enters `to` along
 * its stub. When both ports face the same way the router uses a shared channel
 * between them; when they face each other it goes straight across, with a Z-bend if
 * they are offset laterally.
 */
export function routeOrthogonal(from: Point, fromSide: PortSide, to: Point, toSide: PortSide, opts: RouteOptions = {}): Point[] {
  const stub = opts.stub ?? LAYOUT.stub;
  const gap = (opts.laneGap ?? LAYOUT.laneGap) * (opts.channel ?? 0);
  const av = sideVector(fromSide);
  const bv = sideVector(toSide);
  const start: Point = { x: from.x + av.x * stub, y: from.y + av.y * stub };
  const end: Point = { x: to.x + bv.x * stub, y: to.y + bv.y * stub };
  const points: Point[] = [{ x: from.x, y: from.y }, start];
  const fromVertical = isVertical(fromSide);
  const toVertical = isVertical(toSide);
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

  if (fromVertical === toVertical) {
    // Same axis on both ends: either the ports face each other, in which case the
    // wire crosses the gap between them, or they face the same way, in which case it
    // has to go around — on a channel outside both, never through the blocks.
    const facing = fromVertical ? av.y !== bv.y && Math.sign(to.y - from.y) === av.y : av.x !== bv.x && Math.sign(to.x - from.x) === av.x;
    if (fromVertical) {
      if (facing && same(start.x, end.x)) {
        pushIfNew(points, end);
      } else if (facing) {
        const midY = (start.y + end.y) / 2 + (av.y > 0 ? gap : -gap);
        pushIfNew(points, { x: start.x, y: midY });
        pushIfNew(points, { x: end.x, y: midY });
        pushIfNew(points, end);
      } else {
        const outward = av.y > 0 ? 1 : -1;
        const midY = outward > 0 ? Math.max(start.y, end.y) + stub + gap : Math.min(start.y, end.y) - stub - gap;
        pushIfNew(points, { x: start.x, y: midY });
        pushIfNew(points, { x: end.x, y: midY });
        pushIfNew(points, end);
      }
    } else if (facing && same(start.y, end.y)) {
      pushIfNew(points, end);
    } else if (facing) {
      const midX = (start.x + end.x) / 2 + (av.x > 0 ? gap : -gap);
      pushIfNew(points, { x: midX, y: start.y });
      pushIfNew(points, { x: midX, y: end.y });
      pushIfNew(points, end);
    } else {
      const outward = av.x > 0 ? 1 : -1;
      const midX = outward > 0 ? Math.max(start.x, end.x) + stub + gap : Math.min(start.x, end.x) - stub - gap;
      pushIfNew(points, { x: midX, y: start.y });
      pushIfNew(points, { x: midX, y: end.y });
      pushIfNew(points, end);
    }
  } else {
    // An L: leave one way, arrive the other. The corner takes the coordinate of the
    // stub it meets, so both segments stay on the axis they left from.
    const corner: Point = fromVertical ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
    pushIfNew(points, corner);
    pushIfNew(points, end);
  }

  pushIfNew(points, { x: to.x, y: to.y });
  return dedupe(points);
}

/**
 * Whether every segment of a polyline is axis-aligned — the invariant the router
 * guarantees and the tests check, because a single diagonal run on a sheet reads as
 * a mistake even when the connection is right.
 */
export function isOrthogonal(points: Point[], tolerance = 1e-9): boolean {
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i].x - points[i - 1].x);
    const dy = Math.abs(points[i].y - points[i - 1].y);
    if (dx > tolerance && dy > tolerance) return false;
  }
  return true;
}

/** Drop consecutive duplicates and collinear mid-points. */
export function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    const prev = out[out.length - 2];
    if (prev && collinear(prev, last!, p)) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

function collinear(a: Point, b: Point, c: Point): boolean {
  return (Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - c.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - c.y) < 1e-9);
}

/**
 * Offset the lanes of a bus around its centre polyline.
 *
 * Lanes are offset perpendicular to each segment, so a bus reads as a ribbon rather
 * than as one wire that happens to be wide.
 */
export function busLanes(points: Point[], width: number, gap = LAYOUT.busLaneGap): Point[][] {
  if (width <= 1) return [];
  const lanes: Point[][] = [];
  const span = (width - 1) * gap;
  for (let i = 0; i < width; i++) {
    const offset = -span / 2 + i * gap;
    lanes.push(
      points.map((p, idx) => {
        const prev = points[Math.max(0, idx - 1)];
        const next = points[Math.min(points.length - 1, idx + 1)];
        const vertical = Math.abs(next.x - prev.x) < 1e-9;
        return vertical ? { x: p.x + offset, y: p.y } : { x: p.x, y: p.y + offset };
      }),
    );
  }
  return lanes;
}

/** Total length of a polyline, in world units. */
export function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

/**
 * A stable channel index for a wire, so the same sheet routes the same way and
 * parallel wires separate instead of overprinting.
 *
 * Derived from the endpoints, not from an insertion counter: a sheet edited in a
 * different order still routes identically, which matters for a fingerprint.
 */
export function channelOf(net: string, from: Point, to: Point, modulus = 5): number {
  let h = 2166136261;
  for (let i = 0; i < net.length; i++) {
    h ^= net.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= Math.round(from.x * 4) + Math.round(from.y * 4) * 31 + Math.round(to.x * 4) * 131 + Math.round(to.y * 4) * 7;
  return Math.abs(h) % modulus;
}

/**
 * Insert rounded corners into an orthogonal polyline.
 *
 * Returns the same points with two extra points per corner, so a drawing backend
 * that only knows straight lines still produces the rounded look; a backend with
 * arc support can use `arcCorners` instead.
 */
export function roundedCorners(points: Point[], radius = LAYOUT.wireRadius): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const rIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const rOut = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, rIn / 2, rOut / 2);
    if (r <= 0.01) {
      out.push(cur);
      continue;
    }
    out.push({ x: cur.x + ((prev.x - cur.x) / rIn) * r, y: cur.y + ((prev.y - cur.y) / rIn) * r });
    out.push({ x: cur.x + ((next.x - cur.x) / rOut) * r, y: cur.y + ((next.y - cur.y) / rOut) * r });
  }
  out.push(points[points.length - 1]);
  return out;
}

/** How many times two wires cross, counting a shared endpoint as no crossing. */
export function crossings(a: RenderWire, b: RenderWire): number {
  const as = a.branches.length > 0 ? a.branches : [a.points];
  const bs = b.branches.length > 0 ? b.branches : [b.points];
  let n = 0;
  for (const pa of as) {
    for (const pb of bs) {
      for (let i = 1; i < pa.length; i++) {
        for (let j = 1; j < pb.length; j++) {
          if (segmentsCross(pa[i - 1], pa[i], pb[j - 1], pb[j])) n++;
        }
      }
    }
  }
  return n;
}

/**
 * Whether two axis-aligned segments cross properly (not merely touch).
 *
 * Orthogonal routing means every segment is horizontal or vertical, so the test is
 * a span comparison rather than a general orientation test — and it excludes the
 * T-junctions a bus makes on purpose.
 */
export function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const h1 = Math.abs(p1.y - p2.y) < 1e-9;
  const h2 = Math.abs(p3.y - p4.y) < 1e-9;
  if (h1 === h2) return false; // parallel: they overlap or they do not, neither is a crossing
  const h = h1 ? { a: p1, b: p2 } : { a: p3, b: p4 };
  const v = h1 ? { a: p3, b: p4 } : { a: p1, b: p2 };
  const hx0 = Math.min(h.a.x, h.b.x);
  const hx1 = Math.max(h.a.x, h.b.x);
  const vy0 = Math.min(v.a.y, v.b.y);
  const vy1 = Math.max(v.a.y, v.b.y);
  const x = v.a.x;
  const y = h.a.y;
  return x > hx0 + 1e-9 && x < hx1 - 1e-9 && y > vy0 + 1e-9 && y < vy1 - 1e-9;
}

/** Total crossings across a set of wires, capped so a dense sheet cannot stall. */
export function countCrossings(wires: RenderWire[], cap = 2000): { crossings: number; capped: boolean } {
  let total = 0;
  let capped = false;
  outer: for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      total += crossings(wires[i], wires[j]);
      if (total > cap) {
        capped = true;
        break outer;
      }
    }
  }
  return { crossings: total, capped };
}

/** Bounds of a set of wires, for fitting the view. */
export function wiresBounds(wires: RenderWire[]): Bounds | null {
  if (wires.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of wires) {
    for (const p of w.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}
