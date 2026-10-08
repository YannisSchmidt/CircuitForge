/**
 * The CIRCUIT pane: what the sheet looks like and what the mouse does to it.
 *
 * This module owns three things and nothing else — the view transform, the cached
 * layout, and the pointer interactions. Drawing is the engine's `render.drawSheet`
 * through a canvas backend, so the picture on screen is produced by the same code
 * that writes an exported SVG; hit testing is the engine's `render.pick`, so clicking
 * what you see is not a second interpretation of the geometry.
 *
 * The layout is cached against `circuit.revision`, which the engine bumps on every
 * structural change. A sheet of a thousand blocks costs about 120 ms to lay out, so
 * recomputing it per frame would make dragging unusable: while dragging, blocks are
 * moved in the cached layout directly and a full re-layout is throttled, then forced
 * once on release. Correctness is not traded for smoothness — the geometry converges
 * to the real routing as soon as the pointer stops.
 */

import * as cf from '/engine/index.js';
import { sizeCanvas } from '/engine/render/canvas.js';

const R = cf.render;

const PAN_BUTTONS = new Set([1, 2]);

export class SheetView {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.editor = hooks.editor;
    this.view = R.view(0, 0, 10);
    this.state = null;
    this.options = {
      grid: true,
      labels: true,
      values: true,
      level: 'hierarchical',
      portSides: 'top-bottom',
      theme: 'dark',
      snap: true,
      snapGrid: 20,
      cull: true,
    };
    this.layout = null;
    this.layoutKey = '';
    this.lastLayoutMs = 0;
    this.armed = null;
    this.hover = null;
    this.pendingWire = null;
    this.box = null;
    this.drag = null;
    this.panning = null;
    this.spaceDown = false;
    this.needsDraw = true;
    this.lastStats = null;
    this.lastDragLayout = 0;
    this.cssSize = { w: 0, h: 0 };
    this.dpr = 1;
    this.bindEvents();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---- sizing and the frame loop -----------------------------------------

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssSize.w && h === this.cssSize.h) return false;
    this.cssSize = { w, h };
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    sizeCanvas(this.canvas, w, h, this.dpr);
    this.requestDraw();
    return true;
  }

  get viewport() {
    return { width: this.cssSize.w || 1, height: this.cssSize.h || 1 };
  }

  loop() {
    this.resize();
    if (this.needsDraw) {
      this.needsDraw = false;
      try {
        this.draw();
      } catch (err) {
        this.hooks.onLog && this.hooks.onLog(`drawing the sheet failed: ${err && err.message ? err.message : String(err)}`, 'error');
      }
    }
    requestAnimationFrame(this.loop);
  }

  requestDraw() {
    this.needsDraw = true;
  }

  // ---- layout ------------------------------------------------------------

  /** The layout for the sheet being edited, recomputed only when something changed. */
  ensureLayout(force = false) {
    const circuit = this.editor.circuit;
    const key = [
      circuit.revision,
      this.editor.layers.length,
      this.options.level,
      this.options.portSides,
      this.options.snapGrid,
    ].join('|');
    if (!force && this.layout && key === this.layoutKey) return this.layout;
    const t0 = performance.now();
    this.layout = R.layoutCircuit(circuit, this.editor.lib, this.editor.chips, {
      level: this.options.level,
      portSides: this.options.portSides,
      autoLayout: 'needed',
      grid: this.options.snapGrid,
    });
    this.lastLayoutMs = performance.now() - t0;
    this.layoutKey = key;
    return this.layout;
  }

  /** A full re-layout, throttled while the pointer is down. */
  relayoutThrottled(intervalMs) {
    const now = performance.now();
    if (now - this.lastDragLayout < intervalMs) return false;
    this.lastDragLayout = now;
    this.ensureLayout(true);
    this.requestDraw();
    return true;
  }

  invalidate() {
    this.layoutKey = '';
    this.requestDraw();
  }

  // ---- drawing ------------------------------------------------------------

  draw() {
    const layout = this.ensureLayout();
    const ctx2d = this.canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const backend = new R.CanvasContext(ctx2d, this.cssSize.w, this.cssSize.h);
    const stats = R.drawSheet(backend, layout, {
      view: this.view,
      viewport: this.viewport,
      theme: this.options.theme,
      state: this.mergedState(),
      showGrid: this.options.grid,
      showLabels: this.options.labels,
      showValues: this.options.values,
      cull: this.options.cull,
    });
    this.lastStats = stats;
    this.drawOverlays(ctx2d, layout);
    if (this.hooks.onFrame) this.hooks.onFrame(stats, layout);
  }

  /** Selection, hover and the live simulation state, in one object. */
  mergedState() {
    const base = this.state ? { nets: { ...this.state.nets }, nodes: { ...this.state.nodes } } : { nets: {}, nodes: {} };
    base.selected = this.editor.selection.length > 0 ? [...this.editor.selection] : undefined;
    base.hovered = this.hover && this.hover.kind === 'node' ? this.hover.nodeId : null;
    return base;
  }

  drawOverlays(ctx, layout) {
    const theme = R.themeByName(this.options.theme);
    const toScreen = (p) => R.worldToScreen(this.view, p);
    const line = (a, b, color, width, dash) => {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };

    // The selected net is drawn again, on top, in the accent colour: a sheet with a
    // hundred wires needs the one you clicked to be unmistakable.
    if (this.editor.selectedNet) {
      const wire = layout.wires.find((w) => w.net === this.editor.selectedNet);
      if (wire) {
        const branches = wire.branches.length > 0 ? wire.branches : [wire.points];
        for (const branch of branches) {
          if (branch.length < 2) continue;
          const pts = branch.map(toScreen);
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([]);
          ctx.strokeStyle = theme.colors.accent;
          ctx.lineWidth = Math.max(2.5, theme.widths.bus * this.view.scale);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // A wire being drawn follows the cursor with the same orthogonal routing the
    // finished wire will use, so what you see is what you will get.
    if (this.pendingWire) {
      const node = layout.nodes.find((n) => n.id === this.pendingWire.nodeId);
      const port = node && node.ports.find((p) => p.name === this.pendingWire.port);
      if (port) {
        const cursor = this.cursorWorld || { x: port.x, y: port.y };
        const preview = R.routeOrthogonal(port, port.side, cursor, nearestSide(port, cursor), { channel: 0 });
        const pts = preview.map(toScreen);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = theme.colors.accent;
        ctx.lineWidth = Math.max(1.6, theme.widths.wire * this.view.scale);
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // The component about to be placed, as a ghost at the snapped position.
    if (this.armed && this.cursorWorld) {
      const p = this.snap(this.cursorWorld);
      const s = toScreen(p);
      const w = 60 * this.view.scale;
      const h = 40 * this.view.scale;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = theme.colors.accent;
      ctx.fillStyle = theme.node.chipFill;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(s.x - w / 2, s.y - h / 2, w, h, 5) : ctx.rect(s.x - w / 2, s.y - h / 2, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.colors.text;
      ctx.font = `600 ${Math.max(9, 11 * Math.min(1.4, this.view.scale / 10))}px ${theme.font.family}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.armed.label || this.armed.type, s.x, s.y);
      ctx.restore();
    }

    // Box selection.
    if (this.box) {
      const a = toScreen(this.box.from);
      const b = toScreen(this.box.to);
      ctx.save();
      ctx.fillStyle = 'rgba(108,196,255,0.10)';
      ctx.strokeStyle = theme.colors.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    }

    // The hovered port gets a ring, because a port is small and aiming at it is the
    // one interaction that must not be guesswork.
    if (this.hover && this.hover.kind === 'port') {
      const node = layout.nodes.find((n) => n.id === this.hover.nodeId);
      const port = node && node.ports.find((p) => p.name === this.hover.portName);
      if (port) {
        const s = toScreen(port);
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = theme.node.hovered;
        ctx.lineWidth = 1.6;
        ctx.arc(s.x, s.y, Math.max(5, 6 * Math.min(1.5, this.view.scale / 10)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    void line;
  }

  snap(p) {
    if (!this.options.snap || !this.options.snapGrid) return { x: p.x, y: p.y };
    const g = this.options.snapGrid;
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  }

  // ---- view control --------------------------------------------------------

  fit(padding = 60) {
    const layout = this.ensureLayout();
    this.view = R.fitBounds(layout.bounds, this.viewport, padding);
    this.requestDraw();
    if (this.hooks.onView) this.hooks.onView(this.view);
  }

  zoomBy(factor, atScreen) {
    const at = atScreen || { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    this.view = R.zoomAt(this.view, at, factor);
    this.requestDraw();
    if (this.hooks.onView) this.hooks.onView(this.view);
  }

  setScale(scale) {
    this.view = R.zoomAt(this.view, { x: this.viewport.width / 2, y: this.viewport.height / 2 }, scale / this.view.scale);
    this.requestDraw();
    if (this.hooks.onView) this.hooks.onView(this.view);
  }

  panBy(dxScreen, dyScreen) {
    this.view = R.panBy(this.view, dxScreen, dyScreen);
    this.requestDraw();
  }

  centerOn(world) {
    this.view = {
      x: world.x - this.viewport.width / 2 / this.view.scale,
      y: world.y - this.viewport.height / 2 / this.view.scale,
      scale: this.view.scale,
    };
    this.requestDraw();
  }

  /** Frame the selection, or the whole sheet when nothing is selected. */
  focusSelection() {
    const layout = this.ensureLayout();
    if (this.editor.selection.length === 0) return this.fit();
    const nodes = layout.nodes.filter((n) => this.editor.selection.includes(n.ref) || this.editor.selection.includes(n.id));
    if (nodes.length === 0) return this.fit();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.w);
      minY = Math.min(minY, n.y - n.h);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    this.view = R.fitBounds({ minX, minY, maxX, maxY }, this.viewport, 120);
    this.requestDraw();
  }

  setState(state) {
    this.state = state;
    this.requestDraw();
  }

  clearState() {
    this.state = null;
    this.requestDraw();
  }

  setOption(key, value) {
    this.options[key] = value;
    if (key === 'level' || key === 'portSides' || key === 'snapGrid') this.invalidate();
    this.requestDraw();
  }

  arm(item) {
    this.armed = item;
    this.pendingWire = null;
    this.canvas.classList.toggle('placing', !!item);
    this.requestDraw();
  }

  // ---- events --------------------------------------------------------------

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointerleave', () => this.onPointerLeave());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hooks.onContextMenu && this.hooks.onContextMenu(e, this.pickAt(e));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        this.spaceDown = true;
        c.classList.add('panning');
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        if (this.armed) this.arm(null);
        else if (this.pendingWire) this.cancelWire();
        else this.editor.clearSelection();
        this.requestDraw();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        c.classList.remove('panning');
      }
    });
  }

  screenPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  worldPoint(e) {
    return R.screenToWorld(this.view, this.screenPoint(e));
  }

  pickAt(e) {
    const layout = this.ensureLayout();
    const world = this.worldPoint(e);
    const tolerance = Math.max(4 / this.view.scale, 4);
    return R.pick(layout, world, tolerance);
  }

  onPointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const screen = this.screenPoint(e);
    const world = this.worldPoint(e);
    this.cursorWorld = world;

    if (PAN_BUTTONS.has(e.button) || this.spaceDown) {
      this.panning = { screen, view: { ...this.view } };
      this.canvas.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;

    // Placing an armed component wins over anything under the cursor.
    if (this.armed) {
      const p = this.snap(world);
      this.hooks.onPlace && this.hooks.onPlace(this.armed, p);
      if (!e.shiftKey) this.arm(null);
      return;
    }

    const hit = this.pickAt(e);
    if (hit.kind === 'port') {
      if (e.altKey) {
        this.hooks.onDisconnectPort && this.hooks.onDisconnectPort(hit);
        return;
      }
      if (this.pendingWire) this.finishWire(hit);
      else this.startWire(hit);
      return;
    }
    if (this.pendingWire) {
      // Clicking anywhere that is not a port abandons the wire rather than leaving it
      // hanging: an unfinished connection is worse than none.
      this.cancelWire();
    }
    if (hit.kind === 'node') {
      const ref = this.refOf(hit.nodeId);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!additive && !this.editor.selection.includes(ref)) this.editor.select([ref]);
      else if (additive) this.editor.select([ref], true);
      this.hooks.onSelect && this.hooks.onSelect();
      this.editor.beginTransaction();
      this.drag = {
        mode: 'move',
        startWorld: world,
        refs: [...this.editor.selection],
        origins: new Map(),
      };
      for (const r of this.drag.refs) {
        const inst = this.editor.byRef(r);
        if (inst) this.drag.origins.set(r, { x: inst.x, y: inst.y });
      }
      this.requestDraw();
      return;
    }
    if (hit.kind === 'wire' || hit.kind === 'sheet-port') {
      this.editor.selectNet(hit.net || '');
      this.hooks.onSelect && this.hooks.onSelect();
      this.requestDraw();
      return;
    }
    // Empty space: box select, or clear the selection on a plain click.
    if (!e.shiftKey && this.editor.selection.length > 0) {
      this.editor.clearSelection();
      this.hooks.onSelect && this.hooks.onSelect();
    }
    this.box = { from: world, to: world };
    this.drag = { mode: 'box' };
    this.requestDraw();
  }

  onPointerMove(e) {
    const screen = this.screenPoint(e);
    const world = this.worldPoint(e);
    this.cursorWorld = world;
    if (this.hooks.onCursor) this.hooks.onCursor(world, screen);

    if (this.panning) {
      const dx = screen.x - this.panning.screen.x;
      const dy = screen.y - this.panning.screen.y;
      this.view = { x: this.panning.view.x - dx / this.panning.view.scale, y: this.panning.view.y - dy / this.panning.view.scale, scale: this.panning.view.scale };
      this.requestDraw();
      return;
    }

    if (this.drag && this.drag.mode === 'move') {
      const dx = world.x - this.drag.startWorld.x;
      const dy = world.y - this.drag.startWorld.y;
      for (const ref of this.drag.refs) {
        const origin = this.drag.origins.get(ref);
        if (!origin) continue;
        this.editor.moveLive(ref, origin.x + dx, origin.y + dy, this.options.snap ? this.options.snapGrid : 0);
      }
      // Move the cached layout's blocks straight away for immediate feedback, and
      // re-route their wires on a throttle so a big sheet stays draggable.
      const layout = this.layout;
      if (layout) {
        for (const ref of this.drag.refs) {
          const inst = this.editor.byRef(ref);
          const node = layout.nodes.find((n) => n.id === ref || n.ref === ref);
          if (inst && node) R.moveNode(node, inst.x, inst.y);
        }
        this.relayoutThrottled(layout.nodes.length > 400 ? 140 : 45);
      }
      this.requestDraw();
      return;
    }

    if (this.drag && this.drag.mode === 'box') {
      this.box.to = world;
      this.requestDraw();
      return;
    }

    const hit = this.pickAt(e);
    const changed = JSON.stringify(hit) !== JSON.stringify(this.hover);
    this.hover = hit.kind === 'none' ? null : hit;
    if (this.hooks.onHover) this.hooks.onHover(this.hover, screen);
    if (changed) this.requestDraw();
    else this.requestDraw();
  }

  onPointerUp(e) {
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // A pointer that left the window may already be released.
    }
    if (this.panning) {
      this.panning = null;
      this.canvas.classList.remove('panning');
      return;
    }
    if (this.drag && this.drag.mode === 'move') {
      this.editor.endTransaction('move');
      this.ensureLayout(true);
      this.drag = null;
      this.requestDraw();
      this.hooks.onChange && this.hooks.onChange('move');
      return;
    }
    if (this.drag && this.drag.mode === 'box') {
      const inside = this.boxContents();
      if (inside.length > 0) this.editor.select(inside, e.shiftKey);
      this.box = null;
      this.drag = null;
      this.requestDraw();
      this.hooks.onSelect && this.hooks.onSelect();
    }
  }

  onPointerLeave() {
    this.hover = null;
    if (this.hooks.onHover) this.hooks.onHover(null, null);
    this.requestDraw();
  }

  onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.0025 : 0.0016));
    this.zoomBy(factor, this.screenPoint(e));
  }

  onDoubleClick(e) {
    const hit = this.pickAt(e);
    if (hit.kind === 'node' && this.hooks.onOpen) this.hooks.onOpen(this.refOf(hit.nodeId));
  }

  boxContents() {
    const layout = this.ensureLayout();
    if (!this.box) return [];
    const minX = Math.min(this.box.from.x, this.box.to.x);
    const maxX = Math.max(this.box.from.x, this.box.to.x);
    const minY = Math.min(this.box.from.y, this.box.to.y);
    const maxY = Math.max(this.box.from.y, this.box.to.y);
    const refs = [];
    for (const n of layout.nodes) {
      if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) refs.push(n.ref);
    }
    return refs;
  }

  /** The layout identifies nodes by ref at the hierarchical level and by path when
   * flattened; the editor only knows references, so map back. */
  refOf(nodeId) {
    const layout = this.layout;
    const node = layout && layout.nodes.find((n) => n.id === nodeId);
    return node ? node.ref : nodeId;
  }

  startWire(hit) {
    const layout = this.ensureLayout();
    const node = layout.nodes.find((n) => n.id === hit.nodeId);
    if (!node) return;
    this.pendingWire = { nodeId: node.id, ref: node.ref, port: hit.portName };
    this.canvas.classList.add('wiring');
    this.requestDraw();
    if (this.hooks.onWire) this.hooks.onWire(this.pendingWire, null);
  }

  finishWire(hit) {
    const start = this.pendingWire;
    this.pendingWire = null;
    this.canvas.classList.remove('wiring');
    if (!start) return;
    const layout = this.ensureLayout();
    const node = layout.nodes.find((n) => n.id === hit.nodeId);
    if (!node) return;
    if (this.hooks.onWire) this.hooks.onWire(start, { nodeId: node.id, ref: node.ref, port: hit.portName });
    this.requestDraw();
  }

  cancelWire() {
    this.pendingWire = null;
    this.canvas.classList.remove('wiring');
    this.requestDraw();
    if (this.hooks.onWire) this.hooks.onWire(null, null);
  }
}

/** Which side a rubber-band wire should arrive from, given where the cursor is. */
function nearestSide(port, cursor) {
  const dx = cursor.x - port.x;
  const dy = cursor.y - port.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

export { R };
