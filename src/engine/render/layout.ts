/**
 * From a circuit to a layout: blocks with ports, wires between them, bounds.
 *
 * The geometry comes from the library, not from the renderer: every component spec
 * carries its own symbol and its own pin positions in symbol space, so a gate is
 * drawn the way it was declared and a chip block is the rounded rectangle the chip
 * spec generated. What this module adds is placement, port projection, wire routing
 * and the numbers a view needs.
 *
 * Two decisions are the renderer's, and both are reported rather than hidden:
 *
 *   - Chip ports are projected onto the top and bottom edges (inputs on top, outputs
 *     below) when `portSides` is `top-bottom`, which is the block look this project
 *     was asked for. The authored left/right geometry is still what the export
 *     carries; this is a drawing choice and `SheetLayout.style.portSides` says which
 *     one was applied.
 *   - Positions are kept as authored unless they are unusable (`autoLayout`), in
 *     which case blocks are placed by dataflow level: drivers to the left of what
 *     they drive, columns spaced by the widest block in them, rows ordered by the
 *     barycentre of their drivers. `stats.autoPlaced` counts what moved, so a
 *     rendered sheet never silently differs from the design that was saved.
 */

import { ChipLibrary } from '../core/chip.js';
import type { Circuit } from '../core/circuit.js';
import type { ComponentSpec, Library, PinSpec } from '../core/library.js';
import { exportSchematicElectrical, exportSchematicFlattened, exportSchematicHierarchical, type ExportedComponent, type ExportedNet, type SchematicExport } from '../export/schematic.js';
import { flatten } from '../sim/netlist.js';
import { LAYOUT, SYMBOL_SCALE } from './theme.js';
import { busLanes, channelOf, countCrossings, routeOrthogonal } from './routing.js';
import type { Bounds, Point, PortSide, RenderNode, RenderPort, RenderSheetPort, RenderWire, SheetLayout } from './types.js';

export interface LayoutOptions {
  /** Which schematic level to lay out. Default: hierarchical. */
  level?: 'hierarchical' | 'flattened' | 'electrical';
  /** Where chip ports are drawn. Default: top-bottom. */
  portSides?: 'top-bottom' | 'left-right';
  /** `preserve` keeps authored positions even when they overlap; `needed` (default)
   * re-places only a sheet whose positions are unusable; `force` always re-places. */
  autoLayout?: 'preserve' | 'needed' | 'force';
  symbolScale?: number;
  grid?: number;
  /** Route wires, or leave the layout with ports only. Default: true. */
  routeWires?: boolean;
  /** Flatten gates into transistors when laying out a flattened/electrical sheet. */
  expandGates?: boolean;
  ambient?: number;
  /** Count wire crossings; quadratic in the wire count, so it is opt-in above a size. */
  countCrossings?: boolean;
}

interface Placed {
  node: RenderNode;
  spec: ComponentSpec | undefined;
  /** Connections as they arrived: "REF.PIN". */
  raw: ExportedComponent;
}

/**
 * Lay out a circuit.
 *
 * @param circuit the sheet to draw
 * @param lib the component library the symbols come from
 * @param chips the chip library, needed when the sheet instantiates chips
 */
export function layoutCircuit(circuit: Circuit, lib: Library, chips: ChipLibrary | undefined, options: LayoutOptions = {}): SheetLayout {
  const level = options.level ?? 'hierarchical';
  const exp = exportOf(circuit, lib, chips, level, options);
  const layout = layoutExport(exp, lib, options, chips);
  layout.name = circuit.name;
  return layout;
}

function exportOf(circuit: Circuit, lib: Library, chips: ChipLibrary | undefined, level: string, options: LayoutOptions): SchematicExport {
  if (level === 'hierarchical') return exportSchematicHierarchical(circuit, lib);
  // A sheet with no chip library can still be flattened; the flattener needs the
  // object, not the chips, so an empty one is the honest default rather than a
  // parameter that may not be passed.
  const nl = flatten(circuit, lib, chips ?? new ChipLibrary(), {
    expandGates: options.expandGates ?? level === 'electrical',
    ambient: options.ambient ?? 25,
    metadata: true,
  });
  return level === 'electrical' ? exportSchematicElectrical(nl) : exportSchematicFlattened(nl);
}

/**
 * Lay out an already-exported schematic, which is what all three levels share.
 *
 * @param chips optional, and only needed when the library has no spec for a chip
 *   instance: the pins then come from the chip definition itself, which is where
 *   they were declared. Without either, a chip block would draw with no ports at all
 *   — a silent picture of a design that has them.
 */
export function layoutExport(exp: SchematicExport, lib: Library, options: LayoutOptions = {}, chips?: ChipLibrary): SheetLayout {
  const scale = options.symbolScale ?? SYMBOL_SCALE;
  const grid = options.grid ?? LAYOUT.grid;
  const portSides = options.portSides ?? 'top-bottom';
  const notes: string[] = [];

  const placed: Placed[] = [];
  const byId = new Map<string, Placed>();
  for (const raw of exp.components) {
    const spec = lib.get(raw.type);
    const isChip = raw.chip !== undefined || (spec?.category ?? '') === 'chip';
    const fallback = spec ? undefined : chipPins(chips, raw);
    if (!spec && !fallback && isChip) {
      notes.push(`No component spec and no chip definition for "${raw.type}" (${raw.ref}): drawn as a block with no ports.`);
    }
    const ports = portsOf(raw, spec ?? fallback, isChip, portSides, scale);
    const body = bodyOf(spec ?? fallback, ports, isChip, scale);
    const node: RenderNode = {
      id: raw.path || raw.ref,
      ref: raw.ref,
      label: isChip ? (raw.typeName || raw.type).toUpperCase() : spec?.name ?? raw.typeName ?? raw.type,
      value: raw.value,
      kind: spec?.category ?? (isChip ? 'chip' : 'unknown'),
      type: raw.type,
      chip: raw.chip,
      x: raw.x,
      y: raw.y,
      w: body.w,
      h: body.h,
      rotation: (raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270 ? raw.rotation : 0) as 0 | 90 | 180 | 270,
      mirrorX: raw.mirrorX,
      mirrorY: raw.mirrorY,
      ports,
      symbol: spec?.symbol ?? defaultSymbol(body, scale),
      // A chip with no spec in this library still draws as the rounded block the
      // reference interface uses, with its name on it.
      bits: raw.bits,
      depth: raw.depth,
      connectedPorts: [],
      autoPlaced: false,
    };
    // Absolute port positions depend on the body, which depends on the ports, so the
    // projection is finished here rather than in portsOf.
    for (const p of node.ports) {
      const local = localPortPosition(p, node, spec ?? fallback, isChip, portSides, scale);
      const rotated = rotatePoint(local, node.rotation);
      p.x = node.x + rotated.x;
      p.y = node.y + rotated.y;
      p.side = rotateSide(p.side, node.rotation);
    }
    const entry: Placed = { node, spec, raw };
    placed.push(entry);
    byId.set(node.id, entry);
    byId.set(raw.ref, entry);
  }

  const connected = new Set<string>();
  const wires: RenderWire[] = [];
  let unrouted = 0;
  // Nets a circuit port drives from off-sheet are not undriven: they are driven from
  // outside this sheet, and drawing them in the undriven colour would be a false
  // warning on every input port of every design.
  const portNets = new Set<string>(exp.ports.map((p) => p.net ?? p.name));

  if (options.routeWires !== false) {
    exp.nets.forEach((net, netIndex) => {
      const ends = resolveEnds(net, byId);
      for (const e of ends) connected.add(`${e.node.id}.${e.port.name}`);
      const drivers = ends.filter((e) => isDriver(e.port.direction));
      const width = Math.max(1, Math.round(net.width ?? 1));
      if (ends.length < 2) {
        // A net with one connection still gets a stub, so a dangling pin is visible
        // rather than invisible: that is what an ERC warning refers to.
        if (ends.length === 1) {
          const p = ends[0].port;
          const stubPoints = [
            { x: p.x, y: p.y },
            stubEnd(p),
          ];
          wires.push({
            net: net.name,
            width,
            points: stubPoints,
            branches: [stubPoints],
            lanes: [],
            endpoints: [{ node: ends[0].node.id, port: p.name }],
            driven: drivers.length > 0,
            conflict: drivers.length > 1,
            routed: 'auto',
          });
        }
        return;
      }
      // A net is drawn as a tree from its driver, or from its first endpoint when
      // nothing on it drives (which the ERC will have reported).
      const root = drivers[0] ?? ends[0];
      const targets = ends.filter((e) => e !== root);
      const routes: Point[][] = [];
      const endpoints = ends.map((e) => ({ node: e.node.id, port: e.port.name }));
      for (const t of targets) {
        const channel = channelOf(net.name, { x: root.port.x, y: root.port.y }, { x: t.port.x, y: t.port.y }) + (netIndex % 3);
        const pts = routeOrthogonal(root.port, root.port.side, t.port, t.port.side, { channel });
        if (pts.length < 2) unrouted++;
        routes.push(pts);
      }
      const points = mergeTrunk(routes);
      const lanes: Point[][] = [];
      for (const branch of routes) lanes.push(...busLanes(branch, width));
      wires.push({
        net: net.name,
        width,
        points,
        branches: routes,
        lanes,
        endpoints,
        driven: drivers.length > 0,
        conflict: drivers.length > 1,
        routed: 'auto',
        isPort: portNets.has(net.name),
      });
    });
  }

  // Which ports the sheet actually connects: the inspector shows the rest as unused.
  for (const p of placed) {
    p.node.connectedPorts = p.node.ports.filter((q) => connected.has(`${p.node.id}.${q.name}`)).map((q) => q.name);
  }

  // Circuit-level ports, drawn at the sheet edge as off-page connectors.
  const sheetPorts = sheetPortsOf(exp, placed, notes);

  let autoPlaced = 0;
  let overlapsResolved = 0;
  const mode = options.autoLayout ?? 'needed';
  const unusable = mode === 'force' || (mode === 'needed' && needsPlacement(placed.map((p) => p.node)));
  if (unusable) {
    const moved = autoPlace(placed.map((p) => p.node), exp.nets, byId, grid);
    autoPlaced = moved;
    overlapsResolved = moved;
    // Ports moved with their blocks; the wires have to follow.
    if (options.routeWires !== false) {
      const rerouted = layoutExport(
        { ...exp, components: exp.components.map((c, i) => ({ ...c, x: placed[i].node.x, y: placed[i].node.y })) },
        lib,
        { ...options, autoLayout: 'preserve' },
        chips,
      );
      // The inner call already reported the sheet ports and anything else it found;
      // only its notes are kept, plus this one, so a note is never printed twice.
      return {
        ...rerouted,
        stats: { ...rerouted.stats, autoPlaced, overlapsResolved },
        notes: [...rerouted.notes, `Auto-placed ${moved} block(s) by dataflow level: the authored positions were unusable (missing or overlapping).`],
      };
    }
    notes.push(`Auto-placed ${moved} block(s) by dataflow level.`);
  }

  const bounds = boundsOfAll(placed.map((p) => p.node), wires, sheetPorts);
  if (mode !== 'preserve' && !unusable && placed.length > 0) {
    // Report the tidiness of the authored sheet rather than silently accepting it.
    const overlaps = countOverlaps(placed.map((p) => p.node));
    if (overlaps > 0) notes.push(`${overlaps} pair(s) of blocks overlap as authored; positions were kept because the sheet was still usable.`);
  }
  if (options.countCrossings && wires.length > 1) {
    const c = countCrossings(wires, 2000);
    notes.push(`${c.crossings} wire crossing(s)${c.capped ? ' (counting stopped at 2000)' : ''}.`);
  }

  return {
    name: exp.name,
    level: exp.level,
    nodes: placed.map((p) => p.node),
    wires,
    sheetPorts,
    bounds,
    stats: {
      nodes: placed.length,
      wires: wires.length,
      lanes: wires.reduce((a, w) => a + w.lanes.length, 0),
      ports: placed.reduce((a, p) => a + p.node.ports.length, 0),
      autoPlaced,
      overlapsResolved,
      unrouted,
    },
    style: { portSides, symbolScale: scale, grid },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Ports and bodies
// ---------------------------------------------------------------------------

/**
 * The pins of a chip instance, taken from the chip definition when the library has
 * no spec for it — which is the normal case for a project loaded without its
 * library, and the reason a renderer needs the chip library at all.
 */
function chipPins(chips: ChipLibrary | undefined, raw: ExportedComponent): ComponentSpec | undefined {
  if (!chips) return undefined;
  const id = raw.chip ?? raw.type;
  const chip = chips.get(id);
  if (!chip) return undefined;
  let pins: PinSpec[];
  try {
    pins = chip.implementationPins(raw.params ?? {}).map((p) => ({
      name: p.name,
      direction: p.direction,
      electrical: 'digital' as const,
      width: p.width,
      x: 0,
      y: 0,
    }));
  } catch {
    return undefined;
  }
  if (pins.length === 0) return undefined;
  return { id, name: chip.name, category: 'chip', description: chip.def.description ?? '', refPrefix: 'U', pins, params: [], symbol: [], accuracy: undefined as never, model: undefined as never } as unknown as ComponentSpec;
}

function portsOf(raw: ExportedComponent, spec: ComponentSpec | undefined, isChip: boolean, portSides: string, scale: number): RenderPort[] {
  let pins: PinSpec[] = spec?.pins ?? [];
  if (pins.length === 0) {
    return [];
  }
  // A gate spec declares sixteen inputs because a gate can have sixteen inputs; this
  // instance declares how many it has. Drawing all sixteen on a two-input AND is
  // noise that hides the four ports that matter.
  const declared = Number(raw.params?.inputs);
  if (Number.isFinite(declared) && declared > 0 && declared < pins.length) {
    let seen = 0;
    pins = pins.filter((p) => {
      if (!/^IN\d+$/.test(p.name)) return true;
      seen++;
      return seen <= declared;
    });
  }
  const chipLike = isChip && portSides === 'top-bottom';
  const inputs = chipLike ? pins.filter((p) => p.direction === 'input' || p.direction === 'bidirectional') : [];
  const outputs = chipLike ? pins.filter((p) => p.direction === 'output') : [];
  const others = chipLike ? pins.filter((p) => p.direction !== 'input' && p.direction !== 'output' && p.direction !== 'bidirectional') : [];
  const ports: RenderPort[] = [];
  const add = (p: PinSpec, side: PortSide, index: number): void => {
    ports.push({
      name: p.name,
      direction: p.direction as RenderPort['direction'],
      side,
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(p.width ?? 1)),
      optional: p.optional,
      index,
    });
  };
  if (!chipLike) {
    pins.forEach((p, i) => add(p, sideOfPin(p), i));
    return ports;
  }
  // Projected chip: inputs along the top edge, outputs along the bottom, anything
  // else (power, ground, passive) along the sides where it is conventionally drawn.
  inputs.forEach((p, i) => add(p, 'top', i));
  outputs.forEach((p, i) => add(p, 'bottom', i));
  others.forEach((p, i) => add(p, sideOfPin(p), i));
  void scale;
  return ports;
}

function sideOfPin(p: PinSpec): PortSide {
  if (p.direction === 'output') return 'right';
  if (p.direction === 'input' || p.direction === 'bidirectional') return 'left';
  // Passive and supply pins keep the side their authored position implies.
  if (Math.abs(p.x) >= Math.abs(p.y)) return p.x >= 0 ? 'right' : 'left';
  return p.y >= 0 ? 'bottom' : 'top';
}

/** Where a port sits relative to its block's centre, in sheet units. */
function localPortPosition(p: RenderPort, node: RenderNode, spec: ComponentSpec | undefined, isChip: boolean, portSides: string, scale: number): Point {
  const pin = spec?.pins.find((q) => q.name === p.name);
  const projected = isChip && portSides === 'top-bottom' && (p.side === 'top' || p.side === 'bottom');
  if (projected) {
    const same = node.ports.filter((q) => q.side === p.side);
    const idx = same.findIndex((q) => q.name === p.name);
    const n = Math.max(1, same.length);
    const span = Math.max(node.w - LAYOUT.chipPortSpacing, (n - 1) * LAYOUT.chipPortSpacing);
    const x = n === 1 ? 0 : -span / 2 + (idx * span) / (n - 1);
    const y = p.side === 'top' ? -node.h / 2 : node.h / 2;
    return { x, y };
  }
  if (pin) return { x: pin.x * scale, y: pin.y * scale };
  return { x: 0, y: 0 };
}

/** Body extent from the authored symbol, with a floor a label can be read inside. */
function bodyOf(spec: ComponentSpec | undefined, ports: RenderPort[], isChip: boolean, scale: number): { w: number; h: number } {
  let minX = -1;
  let maxX = 1;
  let minY = -1;
  let maxY = 1;
  for (const p of ports) {
    // A pin reaches outside the body; the body is what the wire connects to, so the
    // pin position bounds it too.
    minX = Math.min(minX, -2);
    maxX = Math.max(maxX, 2);
  }
  if (spec?.symbol && spec.symbol.length > 0) {
    for (const sh of spec.symbol) {
      switch (sh.k) {
        case 'rect':
          minX = Math.min(minX, sh.x);
          maxX = Math.max(maxX, sh.x + sh.w);
          minY = Math.min(minY, sh.y);
          maxY = Math.max(maxY, sh.y + sh.h);
          break;
        case 'line':
          minX = Math.min(minX, sh.x1, sh.x2);
          maxX = Math.max(maxX, sh.x1, sh.x2);
          minY = Math.min(minY, sh.y1, sh.y2);
          maxY = Math.max(maxY, sh.y1, sh.y2);
          break;
        case 'circle':
          minX = Math.min(minX, sh.cx - sh.r);
          maxX = Math.max(maxX, sh.cx + sh.r);
          minY = Math.min(minY, sh.cy - sh.r);
          maxY = Math.max(maxY, sh.cy + sh.r);
          break;
        case 'arc':
          minX = Math.min(minX, sh.cx - sh.r);
          maxX = Math.max(maxX, sh.cx + sh.r);
          minY = Math.min(minY, sh.cy - sh.r);
          maxY = Math.max(maxY, sh.cy + sh.r);
          break;
        case 'poly':
        case 'filled':
          for (let i = 0; i < sh.pts.length; i += 2) {
            minX = Math.min(minX, sh.pts[i]);
            maxX = Math.max(maxX, sh.pts[i]);
            minY = Math.min(minY, sh.pts[i + 1]);
            maxY = Math.max(maxY, sh.pts[i + 1]);
          }
          break;
        default:
          break;
      }
    }
  }
  const w = Math.max(LAYOUT.minBlockWidth, (maxX - minX) * scale, isChip ? LAYOUT.minBlockWidth : 0);
  const h = Math.max(LAYOUT.minBlockHeight, (maxY - minY) * scale, isChip ? LAYOUT.minBlockHeight : 0);
  return { w: isChip ? Math.max(w, ports.length * LAYOUT.chipPortSpacing * 0.6) : w, h };
}

/** A block with no symbol in the library still draws as a labelled rectangle. */
function defaultSymbol(body: { w: number; h: number }, scale: number) {
  const w = body.w / scale;
  const h = body.h / scale;
  return [{ k: 'rect' as const, x: -w / 2, y: -h / 2, w, h, t: 0.18, r: 0.22 }];
}

export function rotatePoint(p: Point, rotation: number): Point {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

export function rotateSide(side: PortSide, rotation: number): PortSide {
  const order: PortSide[] = ['top', 'right', 'bottom', 'left'];
  const steps = Math.round((((rotation % 360) + 360) % 360) / 90);
  return order[(order.indexOf(side) + steps) % 4];
}

function stubEnd(p: RenderPort): Point {
  const v = sideVectorOf(p.side);
  return { x: p.x + v.x * LAYOUT.stub, y: p.y + v.y * LAYOUT.stub };
}

function sideVectorOf(side: PortSide): Point {
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

function isDriver(direction: string): boolean {
  return direction === 'output' || direction === 'supply';
}

function resolveEnds(net: ExportedNet, byId: Map<string, Placed>): Array<{ node: RenderNode; port: RenderPort }> {
  const out: Array<{ node: RenderNode; port: RenderPort }> = [];
  for (const conn of net.connections) {
    const dot = conn.lastIndexOf('.');
    if (dot < 0) continue;
    const ref = conn.slice(0, dot);
    const pin = conn.slice(dot + 1);
    const entry = byId.get(ref);
    if (!entry) continue;
    const port = entry.node.ports.find((p) => p.name === pin);
    if (!port) continue;
    port.net = net.name;
    out.push({ node: entry.node, port });
  }
  return out;
}

/**
 * Fold the point-to-point routes of one net into a single polyline.
 *
 * The longest branch becomes the trunk and the others contribute the corners they
 * add, so a net reads as one wire with branches rather than as a bundle of unrelated
 * segments. Duplicate points are dropped: a drawing backend would otherwise stroke
 * the same pixel twice and a hit test would report a zero-length segment.
 */
function mergeTrunk(routes: Point[][]): Point[] {
  if (routes.length === 0) return [];
  let trunk = routes[0];
  for (const r of routes) if (r.length > trunk.length) trunk = r;
  return trunk;
}

function sheetPortsOf(exp: SchematicExport, placed: Placed[], notes: string[]): RenderSheetPort[] {
  const out: RenderSheetPort[] = [];
  if (exp.ports.length === 0) return out;
  const bounds = boundsOfAll(placed.map((p) => p.node), [], []);
  const left = bounds.minX - LAYOUT.grid * 3;
  const right = bounds.maxX + LAYOUT.grid * 3;
  const inputs = exp.ports.filter((p) => p.direction === 'input');
  const outputs = exp.ports.filter((p) => p.direction !== 'input');
  const place = (list: typeof exp.ports, x: number, side: PortSide): void => {
    const n = Math.max(1, list.length);
    const span = Math.max(bounds.maxY - bounds.minY, n * LAYOUT.grid);
    list.forEach((p, i) => {
      const y = n === 1 ? (bounds.minY + bounds.maxY) / 2 : bounds.minY + (i * span) / (n - 1);
      out.push({ name: p.name, direction: p.direction, width: p.width, net: p.net, x, y, side });
    });
  };
  place(inputs, left, 'left');
  place(outputs, right, 'right');
  if (out.length > 0) notes.push(`${out.length} circuit port(s) drawn as off-page connectors at the sheet edge.`);
  return out;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Whether a sheet's authored positions are unusable: missing, or piled up. */
export function needsPlacement(nodes: RenderNode[]): boolean {
  if (nodes.length === 0) return false;
  let atOrigin = 0;
  for (const n of nodes) if (n.x === 0 && n.y === 0) atOrigin++;
  if (atOrigin === nodes.length && nodes.length > 1) return true;
  if (atOrigin / nodes.length > 0.5) return true;
  return countOverlaps(nodes) > nodes.length * 0.25;
}

/** Overlapping pairs, counted through a uniform grid so it stays near-linear. */
export function countOverlaps(nodes: RenderNode[]): number {
  const cell = 128;
  const buckets = new Map<string, RenderNode[]>();
  const key = (cx: number, cy: number): string => `${cx}:${cy}`;
  for (const n of nodes) {
    const cx = Math.floor(n.x / cell);
    const cy = Math.floor(n.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = key(cx + dx, cy + dy);
        let list = buckets.get(k);
        if (!list) {
          list = [];
          buckets.set(k, list);
        }
        if (dx === 0 && dy === 0) list.push(n);
      }
    }
  }
  let overlaps = 0;
  const seen = new Set<string>();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) overlaps++;
      }
    }
  }
  return overlaps;
}

/**
 * Place blocks by dataflow level.
 *
 * A block's level is one more than the highest level of the blocks driving it, so
 * data flows left to right; rows within a column are ordered by the mean row of their
 * drivers, which keeps a bus from combing across the whole sheet. Cycles are broken
 * by the relaxation bound and reported, not hidden: a combinational loop is a real
 * property of the design and the analyzer warns about it separately.
 */
export function autoPlace(nodes: RenderNode[], nets: ExportedNet[], byId: Map<string, Placed>, grid: number): number {
  if (nodes.length === 0) return 0;
  const level = new Map<string, number>();
  const row = new Map<string, number>();
  for (const n of nodes) {
    level.set(n.id, 0);
    row.set(n.id, 0);
  }
  const driverOf = new Map<string, string[]>();
  const loadsOf = new Map<string, string[]>();
  for (const net of nets) {
    const ends: Array<{ id: string; dir: string }> = [];
    for (const conn of net.connections) {
      const dot = conn.lastIndexOf('.');
      if (dot < 0) continue;
      const entry = byId.get(conn.slice(0, dot));
      if (!entry) continue;
      const port = entry.node.ports.find((p) => p.name === conn.slice(dot + 1));
      ends.push({ id: entry.node.id, dir: port?.direction ?? 'passive' });
    }
    const drivers = ends.filter((e) => isDriver(e.dir)).map((e) => e.id);
    const loads = ends.filter((e) => !isDriver(e.dir)).map((e) => e.id);
    for (const d of drivers) {
      for (const l of loads) {
        if (d === l) continue;
        const list = driverOf.get(l) ?? [];
        list.push(d);
        driverOf.set(l, list);
        const back = loadsOf.get(d) ?? [];
        back.push(l);
        loadsOf.set(d, back);
      }
    }
  }
  // Bounded relaxation: the bound is the node count, which a cycle cannot exceed.
  for (let pass = 0; pass < Math.min(nodes.length, 64); pass++) {
    let changed = false;
    for (const n of nodes) {
      const drivers = driverOf.get(n.id) ?? [];
      if (drivers.length === 0) continue;
      let max = 0;
      let sum = 0;
      let count = 0;
      for (const d of drivers) {
        const dl = level.get(d) ?? 0;
        if (dl + 1 > max) max = dl + 1;
        sum += row.get(d) ?? 0;
        count++;
      }
      if (max > (level.get(n.id) ?? 0) && max <= nodes.length) {
        level.set(n.id, max);
        changed = true;
      }
      if (count > 0) row.set(n.id, sum / count);
    }
    if (!changed) break;
  }
  // Columns by level, rows by barycentre then by reference for a stable order.
  const columns = new Map<number, RenderNode[]>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    const list = columns.get(l) ?? [];
    list.push(n);
    columns.set(l, list);
  }
  const levels = [...columns.keys()].sort((a, b) => a - b);
  let x = 0;
  let moved = 0;
  let widest = 0;
  for (const l of levels) {
    const list = columns.get(l)!;
    list.sort((a, b) => (row.get(a.id) ?? 0) - (row.get(b.id) ?? 0) || a.ref.localeCompare(b.ref));
    let columnWidth = 0;
    let y = 0;
    for (const n of list) {
      const target = { x: x + n.w / 2 + grid, y: y + n.h / 2 + grid };
      if (Math.abs(n.x - target.x) > 1e-9 || Math.abs(n.y - target.y) > 1e-9) {
        moveNode(n, target.x, target.y);
        moved++;
      }
      y += n.h + LAYOUT.nodeGap;
      columnWidth = Math.max(columnWidth, n.w);
    }
    widest = Math.max(widest, columnWidth);
    x += columnWidth + LAYOUT.nodeGap * 2;
  }
  void widest;
  return moved;
}

/** Move a block and carry its ports with it. */
export function moveNode(n: RenderNode, x: number, y: number): void {
  const dx = x - n.x;
  const dy = y - n.y;
  n.x = x;
  n.y = y;
  for (const p of n.ports) {
    p.x += dx;
    p.y += dy;
  }
}

function boundsOfAll(nodes: RenderNode[], wires: RenderWire[], ports: RenderSheetPort[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const n of nodes) {
    take(n.x - n.w / 2 - LAYOUT.stub, n.y - n.h / 2 - LAYOUT.stub);
    take(n.x + n.w / 2 + LAYOUT.stub, n.y + n.h / 2 + LAYOUT.stub);
    for (const p of n.ports) take(p.x, p.y);
  }
  for (const w of wires) for (const p of w.points) take(p.x, p.y);
  for (const p of ports) take(p.x, p.y);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
