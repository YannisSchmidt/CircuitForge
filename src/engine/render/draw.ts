/**
 * Drawing a laid-out sheet.
 *
 * One pass, in a fixed order: background, grid, wires, blocks, ports, labels,
 * badges, selection. Wires go under blocks so a wire that runs behind an IC reads as
 * behind it, and labels go last so nothing covers them.
 *
 * The pass is culled: only the blocks and wires inside the viewport are visited,
 * which is what lets a sheet of a hundred thousand components be drawn at all. What
 * was culled is counted in the returned stats rather than left implicit, so a frame
 * time can be read against the work that actually happened.
 *
 * Text below `minLabelPixels` on screen is skipped. That is not a shortcut: at the
 * zoom level where a whole CPU fits on screen, a 7-unit port name is a grey smudge,
 * and drawing ten thousand of them costs frames to produce noise.
 */

import type { DrawContext, DrawStyle } from './backend.js';
import { SvgContext } from './backend.js';
import { LAYOUT, themeByName, wireColor, type Theme } from './theme.js';
import type { SheetLayout, RenderNode, Point, SheetState } from './types.js';
import type { Viewport, ViewTransform } from './view.js';
import { visibleNodes, visibleWires } from './view.js';
import { rotatePoint } from './layout.js';
import type { SymbolShape } from '../core/library.js';

export interface DrawOptions {
  view: ViewTransform;
  viewport: Viewport;
  theme?: Theme | string;
  /** Live values, temperatures and selection; absent draws the sheet idle. */
  state?: SheetState;
  showGrid?: boolean;
  showLabels?: boolean;
  showValues?: boolean;
  showPorts?: boolean;
  /** Skip what is off screen. Default true; tests turn it off to count everything. */
  cull?: boolean;
  /** World-unit corner radius for wire bends; 0 draws sharp corners. */
  wireRadius?: number;
  /** Smallest text worth drawing, in screen pixels. Default 5. */
  minLabelPixels?: number;
}

export interface DrawStats {
  nodes: number;
  wires: number;
  lanes: number;
  ports: number;
  texts: number;
  shapes: number;
  culledNodes: number;
  culledWires: number;
  /** Drawing operations issued to the context. */
  ops: number;
  ms: number;
}

const clock: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

export function drawSheet(ctx: DrawContext, layout: SheetLayout, options: DrawOptions): DrawStats {
  const t0 = clock();
  const theme = typeof options.theme === 'string' || options.theme === undefined ? themeByName(options.theme as string | undefined) : options.theme;
  const view = options.view;
  const cull = options.cull !== false;
  const minLabel = options.minLabelPixels ?? 5;
  const stats: DrawStats = {
    nodes: 0,
    wires: 0,
    lanes: 0,
    ports: 0,
    texts: 0,
    shapes: 0,
    culledNodes: 0,
    culledWires: 0,
    ops: 0,
    ms: 0,
  };
  const state = options.state;

  ctx.clear(theme.colors.canvas);
  // Scale first, then translate in world units: the context applies the translation
  // through the current scale, which is what makes screen = (world − origin) × scale.
  ctx.save();
  ctx.scale(view.scale);
  ctx.translate(-view.x, -view.y);

  if (options.showGrid !== false) drawGrid(ctx, layout, view, options.viewport, theme);

  const nodes = cull ? visibleNodes(layout, view, options.viewport) : layout.nodes;
  const wires = cull ? visibleWires(layout, view, options.viewport) : layout.wires;
  stats.culledNodes = layout.nodes.length - nodes.length;
  stats.culledWires = layout.wires.length - wires.length;

  // ---- wires -------------------------------------------------------------
  const radius = options.wireRadius ?? LAYOUT.wireRadius;
  for (const w of wires) {
    const netState = state?.nets[w.net];
    const color = wireColor(theme, netState, w);
    const width = w.width > 1 ? theme.widths.bus : theme.widths.wire;
    if (w.lanes.length > 1) {
      // A bus is drawn lane by lane, so it reads as a ribbon of signals rather than
      // as one thick line that happens to be wide.
      for (const lane of w.lanes) {
        if (lane.length < 2) continue;
        ctx.polyline(lane, { stroke: color, width: theme.widths.wire, opacity: 0.9 }, radius);
        stats.lanes++;
        stats.ops++;
      }
    } else {
      const branches = w.branches.length > 0 ? w.branches : [w.points];
      for (const branch of branches) {
        if (branch.length < 2) continue;
        ctx.polyline(branch, { stroke: color, width }, radius);
        stats.ops++;
      }
    }
    stats.wires++;
  }

  // ---- blocks ------------------------------------------------------------
  const labelSize = theme.font.label;
  const drawText = labelSize * view.scale >= minLabel;
  for (const n of nodes) {
    drawNode(ctx, n, theme, view, state, {
      scale: layout.style.symbolScale,
      labels: (options.showLabels !== false) && drawText,
      values: (options.showValues ?? true) && theme.font.value * view.scale >= minLabel,
      ports: options.showPorts !== false,
      portSize: Math.max(1.5, LAYOUT.portSize),
    });
    stats.nodes++;
    stats.shapes++;
    stats.ports += n.ports.length;
  }

  // ---- circuit ports -----------------------------------------------------
  for (const sp of layout.sheetPorts) {
    const w = 46;
    const h = 22;
    ctx.roundRect(sp.x - w / 2, sp.y - h / 2, w, h, 4, { fill: theme.colors.panel, stroke: theme.colors.accent, width: theme.widths.outline });
    if (drawText) {
      ctx.text(sp.x, sp.y, sp.width > 1 ? `${sp.name}[${sp.width}]` : sp.name, {
        stroke: theme.colors.text,
        size: theme.font.port,
        anchor: 'middle',
      });
      stats.texts++;
    }
    stats.ops += 2;
  }

  ctx.restore();
  stats.ops += (ctx as { ops?: number }).ops ?? 0;
  stats.ms = clock() - t0;
  return stats;
}

function drawGrid(ctx: DrawContext, layout: SheetLayout, view: ViewTransform, viewport: Viewport, theme: Theme): void {
  // A grid whose cells would be a pixel apart is noise, so the step doubles until
  // cells are at least eight pixels wide on screen.
  let step = layout.style.grid || LAYOUT.grid;
  while (step * view.scale < 8 && step < 1e6) step *= 2;
  const x0 = Math.floor(view.x / step) * step;
  const y0 = Math.floor(view.y / step) * step;
  const x1 = view.x + viewport.width / view.scale;
  const y1 = view.y + viewport.height / view.scale;
  const style: DrawStyle = { stroke: theme.colors.grid, width: 1 / view.scale };
  for (let x = x0; x <= x1; x += step) ctx.line(x, y0, x, y1, style);
  for (let y = y0; y <= y1; y += step) ctx.line(x0, y, x1, y, style);
}

interface NodeDrawOptions {
  scale: number;
  labels: boolean;
  values: boolean;
  ports: boolean;
  portSize: number;
}

function drawNode(ctx: DrawContext, n: RenderNode, theme: Theme, view: ViewTransform, state: SheetState | undefined, opts: NodeDrawOptions): void {
  const isChip = n.kind === 'chip';
  const nodeState = state?.nodes[n.id];
  const selected = state?.selected?.includes(n.id) ?? false;
  const hovered = state?.hovered === n.id;

  // Body. A chip is the rounded block the reference interface draws; a primitive is
  // drawn by its own symbol, so only its selection plate is a rectangle.
  if (isChip || selected || hovered) {
    const stroke = selected ? theme.node.selected : hovered ? theme.node.hovered : isChip ? theme.node.chipStroke : 'transparent';
    const fill = isChip ? theme.node.chipFill : 'transparent';
    ctx.roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, LAYOUT.blockRadius, {
      fill,
      stroke: stroke === 'transparent' ? undefined : stroke,
      width: selected || hovered ? theme.widths.selection : theme.widths.outline,
      opacity: selected ? 1 : isChip ? 1 : 0.35,
    });
  }

  // Authored symbol, mapped from symbol space into sheet space and rotated with the
  // block. Text shapes in the symbol are the label, so no second label is drawn.
  let symbolText = false;
  for (const sh of n.symbol) {
    if (sh.k === 'text') symbolText = true;
    drawShape(ctx, sh, n, opts.scale, theme);
  }

  // Ports: a small square at each connection point, bright when the sheet connects it.
  if (opts.ports) {
    const connected = new Set(n.connectedPorts);
    for (const p of n.ports) {
      const on = connected.has(p.name);
      const size = opts.portSize * (p.width > 1 ? 1.35 : 1);
      ctx.rect(p.x - size / 2, p.y - size / 2, size, size, {
        fill: on ? theme.node.portConnected : theme.node.port,
        stroke: p.width > 1 ? theme.wire.bus : undefined,
        width: p.width > 1 ? theme.widths.outline : undefined,
      });
    }
  }

  // Label and value, when the symbol does not already carry the name.
  if (opts.labels && !symbolText) {
    ctx.text(n.x, n.y - (opts.values && n.value ? theme.font.value * 0.7 : 0), n.label, {
      stroke: theme.node.text,
      size: theme.font.label,
      anchor: 'middle',
      weight: 600,
    });
    if (opts.values && n.value) {
      ctx.text(n.x, n.y + theme.font.label * 0.9, n.value, { stroke: theme.node.textDim, size: theme.font.value, anchor: 'middle' });
    }
  }
  if (opts.labels && n.bits > 1) {
    // A vector instance is `bits` physical copies; the badge says so instead of
    // letting a reader count one block as one component.
    ctx.text(n.x + n.w / 2 - 6, n.y - n.h / 2 + 6, `×${n.bits}`, { stroke: theme.colors.accent, size: theme.font.badge, anchor: 'end' });
  }

  // Badges: only what was measured. A hot block is hot because the thermal solve said
  // so; an error badge carries the diagnostic code.
  if (nodeState?.hot) {
    ctx.circle(n.x + n.w / 2 - 4, n.y - n.h / 2 + 4, 3.2, { fill: theme.node.hot });
  }
  if (nodeState?.error) {
    ctx.circle(n.x - n.w / 2 + 4, n.y - n.h / 2 + 4, 3.2, { fill: theme.node.error });
  }
  void view;
}

function drawShape(ctx: DrawContext, sh: SymbolShape, n: RenderNode, scale: number, theme: Theme): void {
  const map = (x: number, y: number): Point => {
    const r = rotatePoint({ x: x * scale, y: y * scale }, n.rotation);
    return { x: n.x + r.x * (n.mirrorX ? -1 : 1), y: n.y + r.y * (n.mirrorY ? -1 : 1) };
  };
  const stroke = theme.node.stroke;
  switch (sh.k) {
    case 'line': {
      const a = map(sh.x1, sh.y1);
      const b = map(sh.x2, sh.y2);
      ctx.line(a.x, a.y, b.x, b.y, { stroke, width: (sh.t ?? 0.15) * scale, dash: sh.dash ? [4, 3] : undefined });
      break;
    }
    case 'poly': {
      const pts: Point[] = [];
      for (let i = 0; i < sh.pts.length; i += 2) pts.push(map(sh.pts[i], sh.pts[i + 1]));
      if (sh.fill) ctx.polygon(pts, { fill: theme.node.fill, stroke, width: (sh.t ?? 0.15) * scale });
      else ctx.polyline(pts, { stroke, width: (sh.t ?? 0.15) * scale });
      break;
    }
    case 'filled': {
      const pts: Point[] = [];
      for (let i = 0; i < sh.pts.length; i += 2) pts.push(map(sh.pts[i], sh.pts[i + 1]));
      ctx.polygon(pts, { fill: theme.node.fill, stroke });
      break;
    }
    case 'rect': {
      if (n.rotation === 0 && !n.mirrorX && !n.mirrorY) {
        ctx.roundRect(n.x + sh.x * scale, n.y + sh.y * scale, sh.w * scale, sh.h * scale, (sh.r ?? 0) * scale, {
          fill: theme.node.fill,
          stroke,
          width: (sh.t ?? 0.15) * scale,
        });
      } else {
        const a = map(sh.x, sh.y);
        const b = map(sh.x + sh.w, sh.y);
        const c = map(sh.x + sh.w, sh.y + sh.h);
        const d = map(sh.x, sh.y + sh.h);
        ctx.polygon([a, b, c, d], { fill: theme.node.fill, stroke, width: (sh.t ?? 0.15) * scale });
      }
      break;
    }
    case 'circle': {
      const c = map(sh.cx, sh.cy);
      ctx.circle(c.x, c.y, sh.r * scale, { fill: sh.fill ? theme.node.fill : undefined, stroke, width: (sh.t ?? 0.15) * scale });
      break;
    }
    case 'arc': {
      const c = map(sh.cx, sh.cy);
      ctx.arc(c.x, c.y, sh.r * scale, sh.a0 + n.rotation, sh.a1 + n.rotation, { stroke, width: (sh.t ?? 0.15) * scale });
      break;
    }
    case 'text': {
      const p = map(sh.x, sh.y);
      ctx.text(p.x, p.y, sh.s, {
        stroke: theme.node.text,
        size: (sh.size ?? 0.9) * scale,
        anchor: sh.anchor === 'l' ? 'start' : sh.anchor === 'r' ? 'end' : 'middle',
        weight: sh.weight,
      });
      break;
    }
    default:
      break;
  }
}

/**
 * Render a sheet to a standalone SVG document.
 *
 * This is the headless path: the same geometry the GUI draws, produced as text, so a
 * sheet can be exported, diffed in a test, or embedded in a report without a browser.
 */
export function renderToSvg(layout: SheetLayout, options: DrawOptions): { svg: string; stats: DrawStats } {
  const ctx = new SvgContext(options.viewport.width, options.viewport.height);
  const stats = drawSheet(ctx, layout, options);
  return { svg: ctx.toString(), stats };
}
