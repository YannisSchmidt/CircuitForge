/**
 * Drawing backends.
 *
 * `DrawContext` is the whole contract between the renderer and whatever produces
 * pixels: the GUI implements it over a 2D canvas (and a WebGL2 layer for the sheet
 * background), `SvgContext` implements it over an SVG string so a sheet can be
 * rendered, exported and diffed without a browser, and `NullContext` implements it
 * over nothing at all so the cost of the drawing pass can be measured — which is the
 * only honest way to benchmark rendering headlessly, and the reason the benchmark
 * suite can quote a number for the geometry and the draw calls while still saying
 * that rasterisation itself was not measured.
 *
 * Coordinates given to a context are world units; the transform the caller sets is
 * what maps them to the surface.
 */

import type { Point } from './types.js';

export interface DrawStyle {
  stroke?: string;
  fill?: string;
  /** Line width, world units. */
  width?: number;
  dash?: number[];
  opacity?: number;
  /** Text size, world units. */
  size?: number;
  font?: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: number;
}

export interface DrawContext {
  readonly width: number;
  readonly height: number;
  save(): void;
  restore(): void;
  translate(dx: number, dy: number): void;
  scale(factor: number): void;
  clear(color: string): void;
  rect(x: number, y: number, w: number, h: number, style?: DrawStyle): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, style?: DrawStyle): void;
  circle(cx: number, cy: number, r: number, style?: DrawStyle): void;
  /** Angles in degrees, measured clockwise from the positive x axis (screen space). */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, style?: DrawStyle): void;
  line(x1: number, y1: number, x2: number, y2: number, style?: DrawStyle): void;
  polyline(points: Point[], style?: DrawStyle, cornerRadius?: number): void;
  polygon(points: Point[], style?: DrawStyle): void;
  text(x: number, y: number, value: string, style?: DrawStyle): void;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

interface Transform {
  tx: number;
  ty: number;
  s: number;
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A context that accumulates an SVG document. */
export class SvgContext implements DrawContext {
  readonly width: number;
  readonly height: number;
  private parts: string[] = [];
  private stack: Transform[] = [];
  private cur: Transform = { tx: 0, ty: 0, s: 1 };
  private background = 'transparent';
  /** Count of drawing operations, for measurement and for tests. */
  ops = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  save(): void {
    this.stack.push({ ...this.cur });
  }

  restore(): void {
    const t = this.stack.pop();
    if (t) this.cur = t;
  }

  translate(dx: number, dy: number): void {
    this.cur = { ...this.cur, tx: this.cur.tx + dx * this.cur.s, ty: this.cur.ty + dy * this.cur.s };
  }

  scale(factor: number): void {
    this.cur = { ...this.cur, s: this.cur.s * factor };
  }

  clear(color: string): void {
    this.background = color;
  }

  private p(x: number, y: number): [number, number] {
    return [this.cur.tx + x * this.cur.s, this.cur.ty + y * this.cur.s];
  }

  private attrs(style: DrawStyle | undefined, scaleFactor = 1): string {
    const out: string[] = [];
    if (style?.fill) out.push(`fill="${style.fill}"`);
    else out.push('fill="none"');
    if (style?.stroke) out.push(`stroke="${style.stroke}"`);
    if (style?.width) out.push(`stroke-width="${num(style.width * this.cur.s * scaleFactor)}"`);
    if (style?.dash && style.dash.length > 0) out.push(`stroke-dasharray="${style.dash.map((d) => num(d * this.cur.s)).join(' ')}"`);
    if (style?.opacity !== undefined && style.opacity < 1) out.push(`opacity="${num(style.opacity)}"`);
    out.push('stroke-linecap="round" stroke-linejoin="round"');
    return out.join(' ');
  }

  rect(x: number, y: number, w: number, h: number, style?: DrawStyle): void {
    const [px, py] = this.p(x, y);
    this.ops++;
    this.parts.push(`<rect x="${num(px)}" y="${num(py)}" width="${num(w * this.cur.s)}" height="${num(h * this.cur.s)}" ${this.attrs(style)}/>`);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, style?: DrawStyle): void {
    const [px, py] = this.p(x, y);
    this.ops++;
    this.parts.push(
      `<rect x="${num(px)}" y="${num(py)}" width="${num(w * this.cur.s)}" height="${num(h * this.cur.s)}" rx="${num(Math.min(r, w / 2, h / 2) * this.cur.s)}" ${this.attrs(style)}/>`,
    );
  }

  circle(cx: number, cy: number, r: number, style?: DrawStyle): void {
    const [px, py] = this.p(cx, cy);
    this.ops++;
    this.parts.push(`<circle cx="${num(px)}" cy="${num(py)}" r="${num(r * this.cur.s)}" ${this.attrs(style)}/>`);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, style?: DrawStyle): void {
    const [px, py] = this.p(cx, cy);
    const rr = r * this.cur.s;
    const rad0 = (a0 * Math.PI) / 180;
    const rad1 = (a1 * Math.PI) / 180;
    const x0 = px + rr * Math.cos(rad0);
    const y0 = py + rr * Math.sin(rad0);
    const x1 = px + rr * Math.cos(rad1);
    const y1 = py + rr * Math.sin(rad1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const sweep = a1 > a0 ? 1 : 0;
    this.ops++;
    this.parts.push(`<path d="M ${num(x0)} ${num(y0)} A ${num(rr)} ${num(rr)} 0 ${large} ${sweep} ${num(x1)} ${num(y1)}" ${this.attrs(style)}/>`);
  }

  line(x1: number, y1: number, x2: number, y2: number, style?: DrawStyle): void {
    const [a, b] = this.p(x1, y1);
    const [c, d] = this.p(x2, y2);
    this.ops++;
    this.parts.push(`<line x1="${num(a)}" y1="${num(b)}" x2="${num(c)}" y2="${num(d)}" ${this.attrs(style)}/>`);
  }

  polyline(points: Point[], style?: DrawStyle, cornerRadius = 0): void {
    if (points.length < 2) return;
    this.ops++;
    if (cornerRadius > 0) {
      this.parts.push(`<path d="${this.roundedPath(points, cornerRadius)}" ${this.attrs(style)}/>`);
      return;
    }
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${num(this.p(p.x, p.y)[0])} ${num(this.p(p.x, p.y)[1])}`).join(' ');
    this.parts.push(`<path d="${d}" ${this.attrs(style)}/>`);
  }

  /** A path with quadratic corners, so a bus bend looks like the reference interface. */
  private roundedPath(points: Point[], radius: number): string {
    const out: string[] = [];
    const first = this.p(points[0].x, points[0].y);
    out.push(`M ${num(first[0])} ${num(first[1])}`);
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const dIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const dOut = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.min(radius, dIn / 2, dOut / 2);
      if (r <= 1e-6) {
        const c = this.p(cur.x, cur.y);
        out.push(`L ${num(c[0])} ${num(c[1])}`);
        continue;
      }
      const a = this.p(cur.x + ((prev.x - cur.x) / dIn) * r, cur.y + ((prev.y - cur.y) / dIn) * r);
      const b = this.p(cur.x + ((next.x - cur.x) / dOut) * r, cur.y + ((next.y - cur.y) / dOut) * r);
      const c = this.p(cur.x, cur.y);
      out.push(`L ${num(a[0])} ${num(a[1])} Q ${num(c[0])} ${num(c[1])} ${num(b[0])} ${num(b[1])}`);
    }
    const last = this.p(points[points.length - 1].x, points[points.length - 1].y);
    out.push(`L ${num(last[0])} ${num(last[1])}`);
    return out.join(' ');
  }

  polygon(points: Point[], style?: DrawStyle): void {
    if (points.length < 2) return;
    this.ops++;
    const pts = points.map((p) => this.p(p.x, p.y).map(num).join(',')).join(' ');
    this.parts.push(`<polygon points="${pts}" ${this.attrs(style)}/>`);
  }

  text(x: number, y: number, value: string, style?: DrawStyle): void {
    const [px, py] = this.p(x, y);
    this.ops++;
    const anchor = style?.anchor === 'start' ? 'start' : style?.anchor === 'end' ? 'end' : 'middle';
    const size = (style?.size ?? 10) * this.cur.s;
    const weight = style?.weight ? ` font-weight="${style.weight}"` : '';
    const family = style?.font ?? 'Inter, "Segoe UI", system-ui, sans-serif';
    const fill = style?.stroke ?? style?.fill ?? '#000';
    this.parts.push(
      `<text x="${num(px)}" y="${num(py)}" font-family="${escapeXml(family)}" font-size="${num(size)}" text-anchor="${anchor}"${weight} fill="${fill}" dominant-baseline="middle">${escapeXml(value)}</text>`,
    );
  }

  /** The finished document. */
  toString(): string {
    const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(this.width)}" height="${num(this.height)}" viewBox="0 0 ${num(this.width)} ${num(this.height)}">`;
    const bg = this.background && this.background !== 'transparent' ? `<rect x="0" y="0" width="${num(this.width)}" height="${num(this.height)}" fill="${this.background}"/>` : '';
    return `${head}${bg}${this.parts.join('')}</svg>`;
  }
}

// ---------------------------------------------------------------------------
// Null backend: counts and bounds, draws nothing
// ---------------------------------------------------------------------------

/**
 * A context that draws nothing and measures everything.
 *
 * Used by the benchmark suite and by the tests: it proves the draw pass visits the
 * geometry it should, at the cost it should, without needing a surface. It is not a
 * substitute for a rasteriser and does not pretend to be one — no pixel is produced.
 */
export class NullContext implements DrawContext {
  readonly width: number;
  readonly height: number;
  ops = 0;
  texts = 0;
  paths = 0;
  shapes = 0;
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  private stack: Transform[] = [];
  private cur: Transform = { tx: 0, ty: 0, s: 1 };

  constructor(width = 1920, height = 1080) {
    this.width = width;
    this.height = height;
  }

  save(): void {
    this.stack.push({ ...this.cur });
  }
  restore(): void {
    const t = this.stack.pop();
    if (t) this.cur = t;
  }
  translate(dx: number, dy: number): void {
    this.cur = { ...this.cur, tx: this.cur.tx + dx * this.cur.s, ty: this.cur.ty + dy * this.cur.s };
  }
  scale(factor: number): void {
    this.cur = { ...this.cur, s: this.cur.s * factor };
  }
  clear(): void {
    this.ops++;
  }
  private take(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops++;
    this.shapes++;
    this.take(x, y);
    this.take(x + w, y + h);
  }
  roundRect(x: number, y: number, w: number, h: number): void {
    this.rect(x, y, w, h);
  }
  circle(cx: number, cy: number, r: number): void {
    this.ops++;
    this.shapes++;
    this.take(cx - r, cy - r);
    this.take(cx + r, cy + r);
  }
  arc(cx: number, cy: number, r: number): void {
    this.circle(cx, cy, r);
  }
  line(x1: number, y1: number, x2: number, y2: number): void {
    this.ops++;
    this.paths++;
    this.take(x1, y1);
    this.take(x2, y2);
  }
  polyline(points: Point[]): void {
    this.ops++;
    this.paths++;
    for (const p of points) this.take(p.x, p.y);
  }
  polygon(points: Point[]): void {
    this.polyline(points);
  }
  text(x: number, y: number): void {
    this.ops++;
    this.texts++;
    this.take(x, y);
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    if (!Number.isFinite(this.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }
}
