/**
 * The canvas backend.
 *
 * The same `DrawContext` the SVG backend implements, over a 2D canvas, so the editor
 * on screen and the exported picture are produced by one drawing pass. Coordinates
 * are world units and the caller sets the transform — `scale` then `translate`, in
 * that order, which is what makes `screen = (world − origin) × scale` come out the
 * same in both backends.
 *
 * Line widths and font sizes given to a context are world units, and a canvas
 * transform scales them, so a wire is two units thick whether the sheet is zoomed to
 * fill a monitor or reduced to a thumbnail. That is a deliberate choice: a sheet that
 * changes its stroke weights when you zoom looks like a different drawing.
 *
 * The DOM types used here come from the `lib: ["DOM"]` in tsconfig, but nothing is
 * imported, so this module stays loadable in a process that has no DOM at all — the
 * GUI passes the context in.
 */

import type { DrawContext, DrawStyle } from './backend.js';
import type { Point } from './types.js';

/** What this backend needs from a canvas context; a subset, so it can be faked. */
export interface Canvas2DLike {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  strokeRect?(x: number, y: number, w: number, h: number): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number | number[]): void;
  setLineDash(segments: number[]): void;
  fillStyle: string | CanvasGradientLike;
  strokeStyle: string | CanvasGradientLike;
  lineWidth: number;
  globalAlpha: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

/** Enough of a gradient to keep the type honest without importing the DOM. */
export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}

export class CanvasContext implements DrawContext {
  readonly width: number;
  readonly height: number;
  /** Drawing operations issued, so a frame can report what it cost. */
  ops = 0;
  private depth = 0;

  constructor(private readonly ctx: Canvas2DLike, width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  save(): void {
    this.ctx.save();
    this.depth++;
  }

  restore(): void {
    if (this.depth <= 0) return;
    this.ctx.restore();
    this.depth--;
  }

  /** Restore every level saved, so a failed frame cannot leak transform state. */
  restoreAll(): void {
    while (this.depth > 0) this.restore();
  }

  translate(dx: number, dy: number): void {
    this.ctx.translate(dx, dy);
  }

  scale(factor: number): void {
    this.ctx.scale(factor, factor);
  }

  clear(color: string): void {
    this.ops++;
    this.save();
    this.resetTransform();
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.restore();
  }

  private resetTransform(): void {
    // A clear covers the surface, whatever the caller's transform is: the canvas
    // transform is dropped for the fill and put back by restore().
    const ctx = this.ctx as Canvas2DLike & { setTransform?(a: number, b: number, c: number, d: number, e: number, f: number): void };
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  }

  private apply(style: DrawStyle | undefined, filled: boolean): void {
    const ctx = this.ctx;
    ctx.globalAlpha = style?.opacity ?? 1;
    if (style?.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.width ?? 1;
      ctx.setLineDash(style?.dash ?? []);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (filled) ctx.stroke();
    }
    if (style?.fill) {
      ctx.fillStyle = style.fill;
      if (filled) ctx.fill();
    }
  }

  rect(x: number, y: number, w: number, h: number, style?: DrawStyle): void {
    this.ops++;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + w, y);
    this.ctx.lineTo(x + w, y + h);
    this.ctx.lineTo(x, y + h);
    this.ctx.closePath();
    this.apply(style, true);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, style?: DrawStyle): void {
    this.ops++;
    const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    this.ctx.beginPath();
    if (typeof this.ctx.roundRect === 'function') {
      this.ctx.roundRect(x, y, w, h, radius);
    } else {
      // A backend without roundRect still gets rounded corners: four arcs and four
      // lines, which is what the method would have done.
      this.ctx.moveTo(x + radius, y);
      this.ctx.lineTo(x + w - radius, y);
      this.ctx.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
      this.ctx.lineTo(x + w, y + h - radius);
      this.ctx.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
      this.ctx.lineTo(x + radius, y + h);
      this.ctx.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
      this.ctx.lineTo(x, y + radius);
      this.ctx.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
    }
    this.ctx.closePath();
    this.apply(style, true);
  }

  circle(cx: number, cy: number, r: number, style?: DrawStyle): void {
    this.ops++;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
    this.ctx.closePath();
    this.apply(style, true);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, style?: DrawStyle): void {
    this.ops++;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, Math.abs(r), (a0 * Math.PI) / 180, (a1 * Math.PI) / 180, a1 < a0);
    this.apply(style, true);
  }

  line(x1: number, y1: number, x2: number, y2: number, style?: DrawStyle): void {
    this.ops++;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.apply(style, true);
  }

  polyline(points: Point[], style?: DrawStyle, cornerRadius = 0): void {
    if (points.length < 2) return;
    this.ops++;
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    if (cornerRadius > 0) {
      for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        const next = points[i + 1];
        const dIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        const dOut = Math.hypot(next.x - cur.x, next.y - cur.y);
        const r = Math.min(cornerRadius, dIn / 2, dOut / 2);
        if (r <= 1e-6) {
          this.ctx.lineTo(cur.x, cur.y);
          continue;
        }
        this.ctx.lineTo(cur.x + ((prev.x - cur.x) / dIn) * r, cur.y + ((prev.y - cur.y) / dIn) * r);
        this.ctx.quadraticCurveTo(cur.x, cur.y, cur.x + ((next.x - cur.x) / dOut) * r, cur.y + ((next.y - cur.y) / dOut) * r);
      }
    }
    const last = points[points.length - 1];
    this.ctx.lineTo(last.x, last.y);
    this.apply(style, true);
  }

  polygon(points: Point[], style?: DrawStyle): void {
    if (points.length < 2) return;
    this.ops++;
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.ctx.lineTo(points[i].x, points[i].y);
    this.ctx.closePath();
    this.apply(style, true);
  }

  text(x: number, y: number, value: string, style?: DrawStyle): void {
    this.ops++;
    const ctx = this.ctx;
    ctx.font = `${style?.weight ? `${style.weight} ` : ''}${style?.size ?? 10}px ${style?.font ?? 'Inter, "Segoe UI", system-ui, sans-serif'}`;
    ctx.textAlign = style?.anchor === 'start' ? 'left' : style?.anchor === 'end' ? 'right' : 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = style?.opacity ?? 1;
    ctx.fillStyle = style?.stroke ?? style?.fill ?? '#000';
    ctx.fillText(value, x, y);
  }
}

/**
 * Device-pixel-ratio aware sizing.
 *
 * A canvas whose backing store is the CSS size looks blurry on a high-DPI screen,
 * which for a sheet of thin wires means unreadable. This sets the backing store to
 * the device size and scales the context so drawing code can keep using CSS pixels.
 */
export function sizeCanvas(canvas: { width: number; height: number; style?: { width: string; height: string } }, cssWidth: number, cssHeight: number, dpr = 1): void {
  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  if (canvas.style) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}
