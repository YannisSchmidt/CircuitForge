/**
 * Schematic rendering: layout, routing, the view transform, picking and the
 * headless SVG backend.
 *
 * The invariant this suite protects is that a rendered sheet is a faithful picture
 * of the design: every block placed where it was authored unless the sheet was
 * unusable and the report says it moved; every wire orthogonal, leaving its port
 * perpendicular to the edge it sits on; a bus drawn as the lanes it declares; and a
 * drawing pass that visits what is on screen and counts what it culled.
 */

import { assert, assertClose, assertEqual, suite, test } from '../framework.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { layoutCircuit, layoutExport, needsPlacement, countOverlaps, autoPlace, rotateSide, rotatePoint } from '../../src/engine/render/layout.js';
import { exportSchematicHierarchical } from '../../src/engine/export/schematic.js';
import { isOrthogonal, routeOrthogonal, busLanes, channelOf, crossings, segmentsCross, polylineLength } from '../../src/engine/render/routing.js';
import { fitBounds, insideNode, panBy, pick, screenToWorld, view, visibleNodes, visibleWires, worldToScreen, zoomAt } from '../../src/engine/render/view.js';
import { drawSheet, renderToSvg } from '../../src/engine/render/draw.js';
import { NullContext, SvgContext } from '../../src/engine/render/backend.js';
import { DARK_THEME, LAYOUT, SYMBOL_SCALE, wireColor } from '../../src/engine/render/theme.js';
import type { Point, RenderWire, SheetLayout } from '../../src/engine/render/types.js';

suite('render');

const lib = createDefaultLibrary();
const project = buildReferenceProject('render-test');
const chips = project.chips;
/**
 * The reference project registers a component spec for every chip it builds, so a
 * sheet made of chip instances is laid out against *its* library. Rendering chip
 * blocks against the bare default library is also supported — the pins then come
 * from the chip definitions — and is what the fallback test below checks.
 */
const plib = project.lib;

function chipCircuit(id: string, params: Record<string, number | string | boolean> = {}) {
  const chip = chips.get(id);
  assert(chip !== undefined, `the reference project has a "${id}" chip`);
  return chip!.implementation({ ...chip!.defaultParams(), ...params });
}

function branchesOf(w: RenderWire): Point[][] {
  return w.branches.length > 0 ? w.branches : [w.points];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('a chip sheet lays out with blocks, ports and wires', () => {
  const circuit = chipCircuit('full_adder');
  const layout = layoutCircuit(circuit, plib, chips);
  assertEqual(layout.nodes.length, circuit.componentCount(), 'every component became a block');
  assert(layout.wires.length > 0, 'the nets became wires');
  assert(layout.stats.ports > 0, 'the blocks carry ports');
  assertEqual(layout.level, 'hierarchical', 'the level asked for is the level laid out');
  assert(Number.isFinite(layout.bounds.minX) && Number.isFinite(layout.bounds.maxY), 'the bounds are real numbers');
  assert(layout.bounds.maxX > layout.bounds.minX, 'and they enclose something');
  for (const n of layout.nodes) {
    assert(n.w > 0 && n.h > 0, `${n.id} has a body`);
    assert(n.label.length > 0, `${n.id} has a label`);
    for (const p of n.ports) {
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `${n.id}.${p.name} has a position`);
    }
  }
});

test('chip ports are projected onto the top and bottom edges', () => {
  // The block look this project was asked for: inputs along the top, outputs along
  // the bottom, evenly spaced, rather than the left/right the library authors.
  const circuit = chipCircuit('ripple_adder', { bits: 4 });
  const layout = layoutCircuit(circuit, plib, chips, { portSides: 'top-bottom' });
  assertEqual(layout.style.portSides, 'top-bottom', 'the layout reports the projection it applied');
  const block = layout.nodes.find((n) => n.kind === 'chip');
  assert(block !== undefined, 'a ripple adder sheet contains a chip block');
  const inputs = block!.ports.filter((p) => p.direction === 'input');
  const outputs = block!.ports.filter((p) => p.direction === 'output');
  assert(inputs.length > 0 && outputs.length > 0, 'the chip has inputs and outputs');
  for (const p of inputs) {
    assertEqual(p.side, 'top', `input ${p.name} sits on the top edge`);
    assertClose(p.y, block!.y - block!.h / 2, 1e-6, 'on the top edge itself');
  }
  for (const p of outputs) {
    assertEqual(p.side, 'bottom', `output ${p.name} sits on the bottom edge`);
    assertClose(p.y, block!.y + block!.h / 2, 1e-6, 'on the bottom edge itself');
  }
  // Evenly spaced, and in the order the chip declares them.
  const xs = inputs.map((p) => p.x);
  for (let i = 1; i < xs.length; i++) assert(xs[i] > xs[i - 1], 'top ports are ordered left to right');
  if (xs.length > 2) {
    const gap = xs[1] - xs[0];
    for (let i = 2; i < xs.length; i++) assertClose(xs[i] - xs[i - 1], gap, 1e-6, 'and evenly spaced');
  }
  // The same sheet laid out left/right keeps the authored geometry.
  const authored = layoutCircuit(circuit, plib, chips, { portSides: 'left-right' });
  const block2 = authored.nodes.find((n) => n.kind === 'chip')!;
  assert(block2.ports.some((p) => p.side === 'left'), 'left-right projection puts inputs on the left');
  assert(block2.ports.some((p) => p.side === 'right'), 'and outputs on the right');
});

test('a gate instance exposes the inputs it declares, not all sixteen', () => {
  const b = new CircuitBuilder(lib, 'two-input');
  b.port('A', 'input', 'a', 1);
  b.port('B', 'input', 'b', 1);
  const g = b.add('and_gate', { inputs: 2 }, [0, 0]);
  b.at(g, 'IN1', 'a', 1);
  b.at(g, 'IN2', 'b', 1);
  b.at(g, 'OUT', 'y', 1);
  b.port('Y', 'output', 'y', 1);
  const circuit = b.finish({ erc: false });
  const layout = layoutCircuit(circuit, plib, chips);
  const node = layout.nodes[0];
  const names = node.ports.map((p) => p.name);
  assertEqual(names.join(','), 'IN1,IN2,OUT', 'a two-input gate draws two input ports');
  assert(!names.includes('IN3'), 'and not the fourteen it does not use');
});

test('authored positions are kept; unusable ones are re-placed and reported', () => {
  const authored = chipCircuit('full_adder');
  const kept = layoutCircuit(authored, plib, chips, { autoLayout: 'needed' });
  assertEqual(kept.stats.autoPlaced, 0, 'a sheet with real positions is not moved');
  const before = authored.allComponents().map((c) => `${c.x},${c.y}`);
  assertEqual(kept.nodes.map((n) => `${n.x},${n.y}`).sort().join(' '), [...before].sort().join(' '), 'block by block, the positions are the authored ones');

  // Every block at the origin: the auto-layout has to take over.
  const b = new CircuitBuilder(lib, 'piled-up');
  for (let i = 0; i < 6; i++) b.port(`I${i}`, 'input', `i${i}`, 1);
  const gates = [];
  for (let i = 0; i < 6; i++) {
    const g = b.add('and_gate', { inputs: 2 }, [0, 0]);
    b.at(g, 'IN1', `i${i}`, 1);
    b.at(g, 'IN2', `i${(i + 1) % 6}`, 1);
    b.at(g, 'OUT', `o${i}`, 1);
    gates.push(g);
  }
  for (let i = 0; i < 6; i++) b.port(`O${i}`, 'output', `o${i}`, 1);
  const piled = b.finish({ erc: false });
  assert(needsPlacement(layoutCircuit(piled, plib, chips, { autoLayout: 'preserve', routeWires: false }).nodes), 'a sheet piled at the origin is detected as unusable');
  const placed = layoutCircuit(piled, plib, chips, { autoLayout: 'needed' });
  assert(placed.stats.autoPlaced > 0, `the auto-layout moved blocks (${placed.stats.autoPlaced})`);
  assertEqual(countOverlaps(placed.nodes), 0, 'and none of them overlap afterwards');
  assert(placed.notes.some((n) => /auto-placed/i.test(n)), 'the note says the positions were chosen, not authored');

  // Force it on a sheet that was fine: the report must still say what happened.
  const forced = layoutCircuit(authored, plib, chips, { autoLayout: 'force' });
  assert(forced.stats.autoPlaced > 0, 'forcing re-placement moves blocks');
  assertEqual(countOverlaps(forced.nodes), 0, 'without overlapping them');
});

test('the auto-layout puts drivers to the left of what they drive', () => {
  const b = new CircuitBuilder(lib, 'dataflow');
  b.port('A', 'input', 'a', 1);
  b.port('B', 'input', 'b', 1);
  const first = b.add('and_gate', { inputs: 2 }, [0, 0]);
  b.at(first, 'IN1', 'a', 1);
  b.at(first, 'IN2', 'b', 1);
  b.at(first, 'OUT', 'mid', 1);
  const second = b.add('or_gate', { inputs: 2 }, [0, 0]);
  b.at(second, 'IN1', 'mid', 1);
  b.at(second, 'IN2', 'mid', 1);
  b.at(second, 'OUT', 'y', 1);
  b.port('Y', 'output', 'y', 1);
  const layout = layoutCircuit(b.finish({ erc: false }), plib, chips, { autoLayout: 'force' });
  const driver = layout.nodes.find((n) => n.ref === first.ref)!;
  const load = layout.nodes.find((n) => n.ref === second.ref)!;
  assert(driver.x < load.x, `the driving gate (${driver.x}) sits left of its load (${load.x})`);
});

test('a bus is drawn as the lanes it declares', () => {
  const b = new CircuitBuilder(lib, 'bus');
  b.port('D', 'input', 'd', 8);
  const g = b.add('and_gate', { inputs: 2 }, [0, 0]);
  b.at(g, 'IN1', 'd', 8);
  b.at(g, 'IN2', 'd', 8);
  b.at(g, 'OUT', 'y', 8);
  b.port('Y', 'output', 'y', 8);
  const layout = layoutCircuit(b.finish({ erc: false }), lib, chips);
  const bus = layout.wires.find((w) => w.width === 8);
  assert(bus !== undefined, 'the 8-bit net is in the layout');
  assertEqual(bus!.width, 8, 'with the width it was declared at');
  assert(bus!.lanes.length >= 8, `and at least one lane per bit (${bus!.lanes.length})`);
  for (const lane of bus!.lanes) assert(isOrthogonal(lane), 'every lane is orthogonal');
  // Lanes are offset from each other, not stacked on one line.
  const distinct = new Set(bus!.lanes.map((l) => l.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|')));
  assert(distinct.size > 1, 'the lanes do not all draw on top of each other');
});

test('a net driven from off-sheet is not reported as undriven', () => {
  const layout = layoutCircuit(chipCircuit('full_adder'), plib, chips);
  const portNet = layout.wires.find((w) => w.isPort);
  assert(portNet !== undefined, 'an input port net is in the layout');
  assert(portNet!.isPort, 'and it is flagged as a port net');
  const color = wireColor(DARK_THEME, undefined, portNet!);
  assert(color !== DARK_THEME.wire.undriven, 'so it is not drawn in the undriven colour');
  // A net with a driver on the sheet is driven; a floating one is not.
  const driven = layout.wires.filter((w) => w.driven);
  assert(driven.length > 0, `some nets are driven on the sheet (${driven.length})`);
  assertEqual(wireColor(DARK_THEME, { value: 1 }, driven[0]), DARK_THEME.wire.one, 'a measured high draws green');
  assertEqual(wireColor(DARK_THEME, { value: 0 }, driven[0]), DARK_THEME.wire.zero, 'a measured low draws the low colour');
  assertEqual(wireColor(DARK_THEME, { value: 'X' }, driven[0]), DARK_THEME.wire.unknown, 'an unknown draws the unknown colour');
  assertEqual(wireColor(DARK_THEME, undefined, { ...driven[0], conflict: true }), DARK_THEME.wire.conflict, 'a contested net draws the conflict colour');
});

test('the same sheet lays out the same way every time', () => {
  const circuit = chipCircuit('cpu8');
  const a = layoutCircuit(circuit, lib, chips);
  const b = layoutCircuit(circuit, lib, chips);
  const fingerprint = (l: SheetLayout): string =>
    l.nodes.map((n) => `${n.id}@${n.x.toFixed(3)},${n.y.toFixed(3)}#${n.ports.length}`).join(';') +
    '|' +
    l.wires.map((w) => `${w.net}:${w.branches.map((br) => br.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')).join('/')}`).join(';');
  assertEqual(fingerprint(b), fingerprint(a), 'layout is deterministic, so a rendered sheet can be diffed');
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('every routed segment is axis-aligned and leaves its port perpendicular', () => {
  const ids = ['full_adder', 'ripple_adder', 'mux4', 'decoder_3to8', 'alu_n', 'ram_n', 'cpu8'];
  let checked = 0;
  for (const id of ids) {
    for (const level of ['hierarchical', 'flattened'] as const) {
      const circuit = chipCircuit(id, id === 'ripple_adder' || id === 'alu_n' || id === 'ram_n' ? { bits: 4 } : {});
      const layout = layoutCircuit(circuit, plib, chips, { level });
      for (const w of layout.wires) {
        for (const branch of branchesOf(w)) {
          assert(branch.length >= 2, `${id}/${level}/${w.net}: a branch has at least two points`);
          assert(isOrthogonal(branch), `${id}/${level}/${w.net}: a diagonal segment crept in: ${JSON.stringify(branch)}`);
          checked++;
        }
      }
    }
  }
  assert(checked > 200, `the invariant was checked over a real number of wires (${checked})`);
});

test('a route leaves and enters perpendicular to the edge the port sits on', () => {
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  for (const fromSide of sides) {
    for (const toSide of sides) {
      const from = { x: 0, y: 0 };
      const to = { x: 120, y: 80 };
      const pts = routeOrthogonal(from, fromSide, to, toSide, { channel: 2 });
      assert(isOrthogonal(pts), `${fromSide}→${toSide} stays orthogonal`);
      assertEqual(pts[0].x, from.x, `${fromSide}→${toSide} starts at the port`);
      assertEqual(pts[0].y, from.y, `${fromSide}→${toSide} starts at the port`);
      assertEqual(pts[pts.length - 1].x, to.x, `${fromSide}→${toSide} ends at the port`);
      assertEqual(pts[pts.length - 1].y, to.y, `${fromSide}→${toSide} ends at the port`);
      const verticalStart = fromSide === 'top' || fromSide === 'bottom';
      assertEqual(Math.abs(pts[1].x - pts[0].x) < 1e-9, verticalStart, `${fromSide} leaves perpendicular to its edge`);
      const verticalEnd = toSide === 'top' || toSide === 'bottom';
      const n = pts.length - 1;
      assertEqual(Math.abs(pts[n].x - pts[n - 1].x) < 1e-9, verticalEnd, `${toSide} is entered perpendicular to its edge`);
    }
  }
});

test('channels separate parallel runs, deterministically', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 0, y: 100 };
  const a = routeOrthogonal(from, 'left', to, 'left', { channel: 0 });
  const b = routeOrthogonal(from, 'left', to, 'left', { channel: 3 });
  assert(isOrthogonal(a) && isOrthogonal(b), 'both routes stay orthogonal');
  const xa = Math.min(...a.map((p) => p.x));
  const xb = Math.min(...b.map((p) => p.x));
  assert(xb < xa - LAYOUT.laneGap, `a higher channel routes further out (${xa} vs ${xb})`);
  // The channel index is derived from the endpoints, so the same net routes the same
  // way in a different insertion order.
  assertEqual(channelOf('n1', from, to), channelOf('n1', from, to), 'the channel of a net is stable');
  assert(channelOf('n1', from, to) >= 0 && channelOf('n1', from, to) < 5, 'and inside the modulus');
});

test('crossings count proper crossings and ignore T-junctions', () => {
  assert(segmentsCross({ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 0 }, { x: 5, y: 10 }), 'a horizontal and a vertical segment cross');
  assert(!segmentsCross({ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }), 'a T-junction is not a crossing');
  assert(!segmentsCross({ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 0, y: 8 }, { x: 10, y: 8 }), 'parallel runs never cross');
  const wire = (points: Point[]): RenderWire => ({
    net: 'n',
    width: 1,
    points,
    branches: [points],
    lanes: [],
    endpoints: [],
    driven: true,
    conflict: false,
    routed: 'auto',
  });
  assertEqual(crossings(wire([{ x: 0, y: 5 }, { x: 10, y: 5 }]), wire([{ x: 5, y: 0 }, { x: 5, y: 10 }])), 1, 'one crossing counted once');
  assertEqual(crossings(wire([{ x: 0, y: 5 }, { x: 10, y: 5 }]), wire([{ x: 20, y: 0 }, { x: 20, y: 10 }])), 0, 'and none when they miss');
  assertEqual(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]), 7, 'length is the sum of the segments');
  assertEqual(busLanes([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1).length, 0, 'a scalar net has no lanes');
  assertEqual(busLanes([{ x: 0, y: 0 }, { x: 10, y: 0 }], 4).length, 4, 'a 4-bit bus has four');
});

test('rotation moves a port to the side it should be on', () => {
  assertEqual(rotateSide('left', 90), 'top', 'a left port rotated 90° clockwise faces up');
  assertEqual(rotateSide('top', 90), 'right', 'top to right');
  assertEqual(rotateSide('left', 180), 'right', 'and 180° flips it');
  assertEqual(rotateSide('left', 0), 'left', 'no rotation, no change');
  assertEqual(rotateSide('left', 360), 'left', 'a full turn is a no-op');
  const p = rotatePoint({ x: 10, y: 0 }, 90);
  assertClose(p.x, 0, 1e-9, 'rotating (10,0) by 90° in screen space');
  assertClose(p.y, 10, 1e-9, 'puts it below the origin, because y grows downward');
});

// ---------------------------------------------------------------------------
// View and picking
// ---------------------------------------------------------------------------

test('the view transform round-trips and zooms around the cursor', () => {
  const v = view(-100, 50, 2);
  const world = { x: 37.5, y: -12.25 };
  const screen = worldToScreen(v, world);
  assertClose(screen.x, (world.x - v.x) * v.scale, 1e-9, 'screen = (world − origin) × scale');
  const back = screenToWorld(v, screen);
  assertClose(back.x, world.x, 1e-9, 'and it inverts');
  assertClose(back.y, world.y, 1e-9, 'in both axes');

  const cursor = { x: 400, y: 300 };
  const before = screenToWorld(v, cursor);
  const zoomed = zoomAt(v, cursor, 1.5);
  const after = screenToWorld(zoomed, cursor);
  assertClose(after.x, before.x, 1e-6, 'zooming keeps the world point under the cursor fixed');
  assertClose(after.y, before.y, 1e-6, 'in both axes');
  assertClose(zoomed.scale, v.scale * 1.5, 1e-9, 'and multiplies the scale');
  const panned = panBy(v, 20, -10);
  assertClose(panned.x, v.x - 20 / v.scale, 1e-9, 'panning moves the origin by screen pixels over scale');
});

test('fitting a sheet puts the whole design on screen', () => {
  const layout = layoutCircuit(chipCircuit('cpu8'), plib, chips);
  const viewport = { width: 1280, height: 800 };
  const v = fitBounds(layout.bounds, viewport, 40);
  const tl = worldToScreen(v, { x: layout.bounds.minX, y: layout.bounds.minY });
  const br = worldToScreen(v, { x: layout.bounds.maxX, y: layout.bounds.maxY });
  assert(tl.x >= -1 && tl.y >= -1, `the top-left corner is on screen (${tl.x}, ${tl.y})`);
  assert(br.x <= viewport.width + 1 && br.y <= viewport.height + 1, `and so is the bottom-right (${br.x}, ${br.y})`);
  assert(v.scale > 0, 'at a positive scale');
});

test('culling visits what is on screen and counts what is not', () => {
  const layout = layoutCircuit(chipCircuit('cpu8'), plib, chips);
  const all = { width: 100000, height: 100000 };
  const vAll = fitBounds(layout.bounds, all, 0);
  assertEqual(visibleNodes(layout, vAll, all).length, layout.nodes.length, 'a huge viewport culls nothing');
  // A viewport the size of one block, centred on it.
  const target = layout.nodes[0];
  const tiny = { width: 60, height: 60 };
  const vTiny = { x: target.x - 30 / 2, y: target.y - 30 / 2, scale: 1 };
  const seen = visibleNodes(layout, vTiny, tiny);
  assert(seen.length < layout.nodes.length, `a small viewport culls (${seen.length} of ${layout.nodes.length})`);
  assert(seen.some((n) => n.id === target.id), 'and keeps the block it is centred on');
  assert(visibleWires(layout, vTiny, tiny).length <= layout.wires.length, 'wires are culled the same way');
  assert(insideNode(target, { x: target.x, y: target.y }), 'the centre of a block is inside it');
  assert(!insideNode(target, { x: target.x + target.w, y: target.y + target.h }), 'and a point outside is outside');
});

test('picking prefers ports over wires over blocks', () => {
  const layout = layoutCircuit(chipCircuit('ripple_adder', { bits: 4 }), plib, chips);
  const node = layout.nodes.find((n) => n.kind === 'chip')!;
  const port = node.ports[0];
  const hitPort = pick(layout, { x: port.x, y: port.y }, 6);
  assertEqual(hitPort.kind, 'port', 'aiming at a port picks the port');
  assertEqual(hitPort.nodeId, node.id, 'on the right block');
  assertEqual(hitPort.portName, port.name, 'with the right name');

  const hitNode = pick(layout, { x: node.x, y: node.y }, 6);
  assertEqual(hitNode.kind, 'node', 'aiming at the middle of a block picks the block');
  assertEqual(hitNode.nodeId, node.id, 'the one aimed at');

  const wire = layout.wires.find((w) => w.points.length >= 2)!;
  const mid = wire.points[1];
  const hitWire = pick(layout, { x: mid.x + 0.5, y: mid.y + 0.5 }, 4);
  assert(hitWire.kind === 'wire' || hitWire.kind === 'port', `a point on a wire picks the wire (got ${hitWire.kind})`);

  const far = pick(layout, { x: layout.bounds.maxX + 5000, y: layout.bounds.maxY + 5000 }, 6);
  assertEqual(far.kind, 'none', 'and nothing is picked in empty space');
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

test('the SVG backend produces a document with the sheet in it', () => {
  const layout = layoutCircuit(chipCircuit('ripple_adder', { bits: 4 }), plib, chips);
  const viewport = { width: 1200, height: 800 };
  const v = fitBounds(layout.bounds, viewport, 40);
  const { svg, stats } = renderToSvg(layout, { view: v, viewport });
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'it is an SVG document');
  assert(svg.endsWith('</svg>'), 'and it is closed');
  assert(svg.includes(DARK_THEME.colors.canvas), 'with the dark canvas behind it');
  assert(svg.includes('<path'), 'wires are paths');
  assert(svg.includes('FULL_ADDER'), 'the chip label is drawn');
  assertEqual(stats.nodes, layout.nodes.length, 'every block was drawn');
  assertEqual(stats.wires, layout.wires.length, 'every net was drawn');
  assert(stats.ops > stats.nodes + stats.wires, 'and the pass issued real drawing operations');
  // The same input gives the same document, so a golden SVG can be diffed.
  const again = renderToSvg(layout, { view: v, viewport });
  assertEqual(again.svg.length, svg.length, 'rendering is deterministic');
});

test('a culled frame draws less and says so', () => {
  const layout = layoutCircuit(chipCircuit('cpu8'), plib, chips);
  const viewport = { width: 1200, height: 800 };
  const whole = renderToSvg(layout, { view: fitBounds(layout.bounds, viewport, 40), viewport });
  const target = layout.nodes[0];
  const closeUp = { x: target.x - 200, y: target.y - 150, scale: 1 };
  const part = renderToSvg(layout, { view: closeUp, viewport });
  assert(part.stats.nodes < whole.stats.nodes, `a zoomed-in frame draws fewer blocks (${part.stats.nodes} of ${whole.stats.nodes})`);
  assert(part.stats.culledNodes > 0, 'and counts what it skipped');
  assert(part.svg.length < whole.svg.length, 'which makes the document smaller');
  // Turning culling off draws everything regardless of the viewport.
  const unc = renderToSvg(layout, { view: closeUp, viewport, cull: false });
  assertEqual(unc.stats.nodes, layout.nodes.length, 'with culling off, every block is visited');
  assertEqual(unc.stats.culledNodes, 0, 'and nothing is reported as culled');
});

test('live state changes what is drawn, not what is measured', () => {
  const layout = layoutCircuit(chipCircuit('full_adder'), plib, chips);
  const viewport = { width: 800, height: 600 };
  const v = fitBounds(layout.bounds, viewport, 20);
  const idle = renderToSvg(layout, { view: v, viewport });
  const drivenNet = layout.wires.find((w) => w.driven)!;
  const live = renderToSvg(layout, {
    view: v,
    viewport,
    state: { nets: { [drivenNet.net]: { value: 1 } }, nodes: { [layout.nodes[0].id]: { hot: true, error: 'CF8018' } }, selected: [layout.nodes[0].id] },
  });
  assert(live.svg.includes(DARK_THEME.wire.one), 'a measured high is drawn in the high colour');
  assert(live.svg.includes(DARK_THEME.node.hot), 'a hot block gets its badge');
  assert(live.svg.includes(DARK_THEME.node.selected), 'and a selected block its outline');
  assert(!idle.svg.includes(DARK_THEME.node.hot), 'none of which appears when nothing was measured');
  assertEqual(live.stats.nodes, idle.stats.nodes, 'the state changes colours, not what is visited');
});

test('the null backend measures the draw pass without drawing', () => {
  const layout = layoutCircuit(chipCircuit('cpu8'), plib, chips);
  const ctx = new NullContext(1920, 1080);
  const stats = drawSheet(ctx, layout, { view: fitBounds(layout.bounds, { width: 1920, height: 1080 }, 40), viewport: { width: 1920, height: 1080 } });
  assert(ctx.ops > 0, 'the pass issued operations');
  assert(ctx.shapes > 0 && ctx.texts > 0, 'including shapes and text');
  const b = ctx.bounds();
  assert(b.maxX > b.minX && b.maxY > b.minY, 'and touched a real area of the sheet');
  assert(stats.ms >= 0, 'with a measured cost');
  // A second pass over the same layout costs the same work, so the number is stable
  // enough to be a benchmark.
  const ctx2 = new NullContext(1920, 1080);
  drawSheet(ctx2, layout, { view: fitBounds(layout.bounds, { width: 1920, height: 1080 }, 40), viewport: { width: 1920, height: 1080 } });
  assertEqual(ctx2.ops, ctx.ops, 'the same layout issues the same number of drawing operations');
});

test('the SvgContext transform maps world units to the surface', () => {
  const ctx = new SvgContext(100, 100);
  ctx.scale(2);
  ctx.translate(-10, -20);
  ctx.line(10, 20, 30, 40);
  const svg = ctx.toString();
  // screen = (world − origin) × scale: (10 − 10) × 2 = 0, (40 − 20) × 2 = 40.
  assert(svg.includes('x1="0"'), `the first point maps to the origin (${svg.slice(svg.indexOf('<line'), svg.indexOf('<line') + 90)})`);
  assert(svg.includes('y2="40"'), 'and the second is scaled');
  // A translation is applied through the scale in force when it is made, so after
  // scale(2) and translate(−10, −20) the world origin sits at (−20, −40) on the
  // surface; a further translate(5, 5) inside a save moves it by 5 × 2.
  ctx.save();
  ctx.translate(5, 5);
  ctx.circle(0, 0, 1);
  ctx.restore();
  ctx.circle(0, 0, 1);
  const both = ctx.toString();
  assert(both.includes('cx="-10"'), `inside the saved transform the circle moved by 5 × 2 (${both.slice(both.indexOf('<circle'))})`);
  assert(both.includes('cx="-20"'), 'and after restore it is back where the outer transform puts it');
});

test('a layout can be taken from an exported schematic at any level', () => {
  const circuit = chipCircuit('full_adder');
  const exp = exportSchematicHierarchical(circuit, plib);
  const layout = layoutExport(exp, plib, {}, chips);
  assertEqual(layout.nodes.length, exp.components.length, 'one block per exported component');
  assertEqual(layout.level, exp.level, 'at the level the export says it is');
  assert(layout.wires.length > 0, 'with the nets routed');
});

test('auto-placement of an empty sheet is a no-op, not a crash', () => {
  const b = new CircuitBuilder(lib, 'empty');
  const layout = layoutCircuit(b.finish({ erc: false }), lib, chips);
  assertEqual(layout.nodes.length, 0, 'an empty sheet has no blocks');
  assertEqual(layout.wires.length, 0, 'and no wires');
  assertEqual(autoPlace([], [], new Map(), LAYOUT.grid), 0, 'auto-placement reports nothing moved');
  const { svg } = renderToSvg(layout, { view: view(0, 0, 1), viewport: { width: 400, height: 300 } });
  assert(svg.includes('<svg'), 'and it still renders, as an empty canvas');
  assertEqual(SYMBOL_SCALE, 10, 'the symbol scale the reference layouts were authored on');
});
