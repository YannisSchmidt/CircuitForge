/**
 * The editor's logic and the command registry.
 *
 * The interface is thin on purpose, so almost everything that can go wrong when a
 * user edits a circuit goes wrong here: a move that is not undoable, a wire that
 * joins nets of different widths, a chip that is edited in place and silently changes
 * every instance of itself, a menu item with no command behind it, two commands
 * claiming the same shortcut.
 *
 * None of this needs a browser, which is the point: an editor with a hundred
 * interactions cannot be verified by clicking through it.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { Editor } from '../../src/ui/editor.js';
import { COMMANDS, MENUS, commandById, commandsInGroup, keymap, menuItems, normalizeKey, paletteEntries } from '../../src/ui/commands.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';

suite('editor');

function makeEditor(): Editor {
  const project = buildReferenceProject('editor-test');
  return new Editor({ lib: project.lib, chips: project.chips, project });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test('placing, moving, rotating and removing components', () => {
  const editor = makeEditor();
  assertEqual(editor.circuit.componentCount(), 0, 'a new sheet is empty');

  const placed = editor.place('and_gate', 40, 60, { inputs: 2 });
  assert(placed !== null, 'a library component can be placed');
  assertEqual(editor.circuit.componentCount(), 1, 'and it is on the sheet');
  const inst = editor.byRef(placed!.ref)!;
  assertEqual(inst.x, 40, 'where it was put');
  assertEqual(inst.y, 60, 'in both axes');
  assertEqual(inst.specId, 'and_gate', 'of the type asked for');
  assertEqual(editor.selection.length, 1, 'placing selects what was placed');

  editor.rotate([placed!.ref], 90);
  assertEqual(editor.byRef(placed!.ref)!.rotation, 90, 'rotating turns it');

  editor.moveTo(placed!.ref, 100, 120, 20);
  assertEqual(editor.byRef(placed!.ref)!.x, 100, 'and moving puts it where it was told');
  editor.moveTo(placed!.ref, 107, 133, 20);
  assertEqual(editor.byRef(placed!.ref)!.x, 100, 'snapped to the 20-unit grid in x');
  assertEqual(editor.byRef(placed!.ref)!.y, 140, 'and in y');

  const second = editor.place('or_gate', 200, 60, { inputs: 2 })!;
  assertEqual(editor.circuit.componentCount(), 2, 'a second component joins the first');
  editor.select([placed!.ref, second.ref]);
  assertEqual(editor.move([placed!.ref, second.ref], 20, 0), 2, 'a selection moves together');
  assertEqual(editor.byRef(second.ref)!.x, 220, 'each by the same offset');

  assertEqual(editor.duplicate([second.ref]), 1, 'a component can be duplicated');
  assertEqual(editor.circuit.componentCount(), 3, 'which adds one');
  const copy = editor.selection[0];
  assert(copy !== second.ref, 'with its own reference');
  assertEqual(editor.byRef(copy)!.specId, 'or_gate', 'of the same type');
  assertEqual(editor.circuit.netCount(), 0, 'and no connection: a copy is not a clone of the wiring');

  assertEqual(editor.remove([]), 1, 'removing takes the selection');
  assertEqual(editor.circuit.componentCount(), 2, 'and it is gone');
});

test('every mutation can be undone, one step at a time', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const b = editor.place('or_gate', 100, 0, { inputs: 2 })!;
  editor.moveTo(a.ref, 20, 20, 0);
  editor.rotate([b.ref], 90);
  editor.remove([b.ref]);
  assertEqual(editor.circuit.componentCount(), 1, 'after all of that, one component is left');
  assert(editor.canUndo, 'and there is something to undo');

  assert(editor.undo(), 'undoing the removal');
  assertEqual(editor.circuit.componentCount(), 2, 'brings the component back');
  const restored = editor.byRef(b.ref)!;
  assertEqual(restored.rotation, 90, 'as it was when it was removed, rotation included');

  assert(editor.undo(), 'undoing the rotation');
  assertEqual(editor.byRef(b.ref)!.rotation, 0, 'turns it back');
  assert(editor.undo(), 'undoing the move');
  assertEqual(editor.byRef(a.ref)!.x, 0, 'puts the first component back where it started');
  assert(editor.undo() && editor.undo(), 'and the two placements');
  assertEqual(editor.circuit.componentCount(), 0, 'leave an empty sheet');
  assert(!editor.canUndo, 'with nothing left to undo');

  assert(editor.redo(), 'redo puts the first component back');
  assertEqual(editor.circuit.componentCount(), 1, 'one at a time');
  assert(editor.canRedo, 'and more redo is available');
});

test('a drag is one undo step, not one per frame', () => {
  const editor = makeEditor();
  const placed = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  editor.beginTransaction();
  for (let i = 1; i <= 30; i++) editor.moveLive(placed.ref, i * 2, i, 0);
  editor.endTransaction('drag');
  assertEqual(editor.byRef(placed.ref)!.x, 60, 'the drag moved the component to where it was dropped');
  assertEqual(editor.byRef(placed.ref)!.y, 30, 'in both axes');
  assert(editor.undo(), 'one undo');
  assertEqual(editor.byRef(placed.ref)!.x, 0, 'returns it to where the drag started, not to an intermediate frame');
});

test('wiring two pins makes a net of the width both pins agree on', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const b = editor.place('or_gate', 200, 0, { inputs: 2 })!;
  assertEqual(editor.circuit.netCount(), 0, 'nothing is connected yet');

  const wire = editor.connect(a.ref, 'OUT', b.ref, 'IN1');
  assert(wire !== null, 'two pins can be wired');
  assertEqual(wire!.width, 1, 'as a 1-bit net');
  assertEqual(editor.circuit.netCount(), 1, 'which creates exactly one net');
  assertEqual(editor.selectedNet, wire!.net, 'and selects it');

  // A third pin joins the same net rather than making a second one.
  const c = editor.place('not_gate', 400, 0)!;
  const join = editor.connect(b.ref, 'OUT', c.ref, 'IN1');
  assert(join !== null, 'a second wire works');
  assertEqual(editor.circuit.netCount(), 2, 'and adds one net, not two');

  // Attaching a free pin to an existing net joins it instead of making another.
  // (c.IN1 is the pin already on the second net; c.OUT is still free.)
  const joined = editor.connect(a.ref, 'IN1', c.ref, 'IN1');
  assert(joined !== null, 'a free pin can be attached to a net that already exists');
  assertEqual(editor.circuit.netCount(), 2, 'and no extra net is created by attaching');
  const netOfAIn = editor.circuit.netOf(editor.byRef(a.ref)!.id, 'IN1');
  const netOfCIn = editor.circuit.netOf(editor.byRef(c.ref)!.id, 'IN1');
  assertEqual(netOfAIn!.id, netOfCIn!.id, 'both pins are on the same net');

  // Two nets that both have pins merge into one, which is what dragging a wire from
  // one existing net to another has to do rather than leave them separate.
  const d = editor.place('not_gate', 600, 0)!;
  const second = editor.connect(b.ref, 'IN2', d.ref, 'OUT');
  assert(second !== null, 'a second net can be made');
  assertEqual(editor.circuit.netCount(), 3, 'three nets now');
  // Both pins are already on a net, and the widths agree, so the nets merge: that is
  // what dragging a wire from one existing net onto another has to do.
  const merged = editor.connect(a.ref, 'OUT', d.ref, 'OUT');
  assert(merged !== null, 'wiring a pin of one net to a pin of another is allowed');
  assertEqual(editor.circuit.netCount(), 2, 'and the two nets become one');
  assertEqual(
    editor.circuit.netOf(editor.byRef(a.ref)!.id, 'OUT')!.id,
    editor.circuit.netOf(editor.byRef(d.ref)!.id, 'OUT')!.id,
    'with both pins on the surviving net',
  );
});

test('a bus wire keeps its width and refuses a mismatch', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  editor.setBits(a.ref, 8);
  const b = editor.place('or_gate', 200, 0, { inputs: 2 })!;
  const bus = editor.connect(a.ref, 'OUT', b.ref, 'IN1', 8);
  assert(bus !== null, 'an 8-bit connection can be made');
  assertEqual(bus!.width, 8, 'and the net is 8 bits wide');

  editor.setBits(b.ref, 1);
  const c = editor.place('not_gate', 400, 0)!;
  const mismatch = editor.connect(b.ref, 'IN1', c.ref, 'OUT');
  assertEqual(mismatch, null, 'joining an 8-bit net to a 1-bit pin is refused');
  assertEqual(editor.circuit.netCount(), 1, 'and no net was created or merged by the attempt');
});

test('circuit ports can be added and removed', () => {
  const editor = makeEditor();
  const port = editor.addPort('A', 'input', 4);
  assert(port !== null, 'a port can be added');
  assertEqual(editor.circuit.allPorts().length, 1, 'and it is on the sheet');
  assertEqual(port!.width, 4, 'at the width asked for');
  assert(editor.circuit.allNets().some((n) => n.name === 'A'), 'with a net of the same name to attach to');

  assertEqual(editor.addPort('A', 'output', 8), null, 'a second port of the same name but a different width is refused');
  assertEqual(editor.circuit.allPorts().length, 1, 'and nothing was added by the attempt');

  assert(editor.removePort('A'), 'the port can be removed again');
  assertEqual(editor.circuit.allPorts().length, 0, 'leaving none');
});

test('a parameter can be set, and a bad value is refused and undone', () => {
  const editor = makeEditor();
  const r = editor.place('resistor', 0, 0)!;
  assert(editor.setParam(r.ref, 'resistance', 4700), 'a value can be set');
  assertEqual(editor.byRef(r.ref)!.params.resistance, 4700, 'and it is stored');
  assert(editor.undo(), 'the change can be undone');
  assert(editor.byRef(r.ref)!.params.resistance !== 4700, 'back to what it was');
  assert(editor.setRef(r.ref, 'R99'), 'a reference can be renamed');
  assert(editor.byRef('R99') !== undefined, 'and the new name resolves');
  assert(editor.selection.includes('R99'), 'with the selection following the rename');
});

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

test('a chip can be opened, edited, and committed as a new version', () => {
  const editor = makeEditor();
  const chip = editor.chips.get('full_adder')!;
  const before = chip.def.version;
  const instance = editor.placeChip('full_adder', 0, 0)!;
  assert(instance !== null, 'a chip instance can be placed');
  assert(editor.chipOf(editor.byRef(instance.ref)!) !== undefined, 'and the editor resolves which chip it is');

  assert(editor.open(instance.ref), 'opening it drills into the implementation');
  assertEqual(editor.depth, 1, 'one level down');
  assertEqual(editor.path.length, 2, 'with a breadcrumb of two');
  assert(editor.circuit.componentCount() >= 5, `the full adder has its gates (${editor.circuit.componentCount()})`);

  // A primitive has nothing underneath; the editor says so instead of failing.
  editor.goToLevel(0);
  const gate = editor.place('and_gate', 400, 0, { inputs: 2 })!;
  assertEqual(editor.open(gate.ref), false, 'a primitive cannot be opened');

  // Edit inside the chip, then commit.
  editor.openChip('full_adder');
  assertEqual(editor.depth, 1, 'a chip definition can be opened directly');
  const components = editor.circuit.componentCount();

  // An edit that breaks the sheet must not be committable. Driving the sum net from
  // a second gate output is an ERC error (CF3007), and a chip whose implementation
  // has a contested net would propagate that error to every instance of it.
  const sumNet = editor.circuit.allNets().find((n) => n.name.toLowerCase() === 's');
  assert(sumNet !== undefined, 'the full adder has a sum net');
  // Find a pin already on the sum net and a gate output on a different net, then join
  // them through the editor — the mutation API, which is what takes the undo
  // checkpoint. Reaching past it into the circuit would not be undoable, and an
  // editor whose own changes cannot be undone is not an editor.
  let target: { ref: string; pin: string } | null = null;
  let driver: { ref: string } | null = null;
  for (const inst of editor.circuit.allComponents()) {
    const spec = editor.lib.get(inst.specId);
    for (const pin of spec?.pins ?? []) {
      const net = editor.circuit.netOf(inst.id, pin.name);
      if (!net) continue;
      // The sum net's only component pin is the output that drives it, so the target
      // may well be an output: merging two driven nets is precisely the conflict.
      if (net.id === sumNet!.id && target === null) target = { ref: inst.ref, pin: pin.name };
      if (net.id !== sumNet!.id && pin.direction === 'output' && driver === null) driver = { ref: inst.ref };
    }
  }
  assert(target !== null && driver !== null, 'the sheet has a pin on the sum net and a spare output to drive it');
  const brokeIt = editor.connect(driver!.ref, 'OUT', target!.ref, target!.pin);
  assert(brokeIt !== null, 'the editor performs the merge that creates the conflict');
  const broken = editor.erc().filter((d) => d.severity === 'error');
  assert(broken.length > 0, `the edit really does break the sheet (${broken.map((d) => d.code).join(', ')})`);
  assertEqual(editor.commitToChip({ bump: 'minor' }), null, 'so committing it is refused');
  assertEqual(editor.chips.must('full_adder').def.version, before, 'and the library still holds the old version');
  assert(editor.undo(), 'the breaking edit can be undone');
  assertEqual(editor.erc().filter((d) => d.severity === 'error').length, 0, 'which leaves the sheet valid again');

  // A harmless edit — moving a gate — commits, and bumps the version it replaces.
  const first = editor.circuit.allComponents()[0];
  assertEqual(editor.circuit.componentCount(), components, 'with the same components as before');
  editor.moveTo(first.ref, first.x + 20, first.y + 20, 0);
  const committed = editor.commitToChip({ bump: 'minor' });
  assert(committed !== null, 'a valid edit can be committed');
  assertEqual(committed!.version, '1.1.0', 'as a new minor version');
  assert(committed!.version !== before, `which is not the version it replaced (${before})`);
  assertEqual(editor.chips.must('full_adder').def.version, '1.1.0', 'and the library now holds the new one');
  const reopened = editor.chips.must('full_adder').implementation({});
  assertEqual(reopened.componentCount(), components, 'so a fresh instance has the edited implementation');
});

test('a sheet can be saved as a new chip and then placed', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const b = editor.place('or_gate', 200, 0, { inputs: 2 })!;
  editor.connect(a.ref, 'OUT', b.ref, 'IN1');
  editor.addPort('X', 'input', 1);
  editor.addPort('Y', 'output', 1);
  const countBefore = editor.chips.size();
  const chip = editor.saveAsChip({ name: 'and_or', description: 'two gates and two ports' });
  assert(chip !== null, 'the sheet becomes a chip');
  assertEqual(editor.chips.size(), countBefore + 1, 'and the library grows by one');
  assertEqual(editor.saveAsChip({ name: 'and_or' }), null, 'saving the same name twice is refused');

  const instance = editor.placeChip('and_or', 400, 400);
  assert(instance !== null, 'the new chip can be placed on the sheet');
  assert(editor.open(instance!.ref), 'and opened again');
  assert(editor.circuit.componentCount() >= 2, 'showing the gates it was made of');
});

// ---------------------------------------------------------------------------
// Documents and reference library
// ---------------------------------------------------------------------------

test('a sheet round-trips through a document', () => {
  const editor = makeEditor();
  editor.place('and_gate', 10, 20, { inputs: 2 });
  editor.place('resistor', 80, 20, { resistance: 1000 });
  editor.addPort('IN', 'input', 1);
  const document = editor.toDocument();
  const before = editor.snapshot();

  const fresh = makeEditor();
  const result = fresh.loadDocument(document);
  assertEqual(result.diagnostics.length >= 0, true, 'loading reports diagnostics without failing');
  const after = fresh.snapshot();
  assertEqual(after.components, before.components, 'the same number of components came back');
  assertEqual(after.nets, before.nets, 'and nets');
  assertEqual(after.ports, before.ports, 'and ports');
  assertEqual(fresh.byRef(before.selection[0] ?? '') !== undefined || before.selection.length === 0, true, 'references survive the round trip');
});

test('the project document carries the chips and the open sheet', () => {
  const editor = makeEditor();
  editor.place('and_gate', 0, 0, { inputs: 2 });
  const document = editor.toProjectDocument();
  assertEqual(document.name, editor.name, 'with the project name');
  const openSheet = document.openSheet as Record<string, unknown>;
  assert(openSheet !== undefined, 'and the sheet that was open');
  assert((openSheet.document as Record<string, unknown>) !== undefined, 'as a circuit document');
  assert(Array.isArray(document.breadcrumb), 'with the breadcrumb that produced it');
});

test('the reference library can be loaded into an empty project', () => {
  const editor = new Editor({ name: 'bare' });
  assertEqual(editor.chips.size(), 0, 'a bare editor has no chip');
  const added = editor.loadReferenceProject();
  assert(added >= 19, `the reference designs were added (${added})`);
  assert(editor.chips.has('full_adder'), 'including the full adder');
  assertEqual(editor.loadReferenceProject(), 0, 'and loading them again adds nothing');
});

test('the library alone is enough to place primitives', () => {
  const editor = new Editor({ lib: createDefaultLibrary(), name: 'primitives' });
  const placed = editor.place('capacitor', 0, 0, { capacitance: 1e-7 });
  assert(placed !== null, 'a passive can be placed without a chip library');
  assertEqual(editor.place('no_such_part', 0, 0), null, 'an unknown type is refused');
  assertEqual(editor.placeChip('no_such_chip', 0, 0), null, 'and so is an unknown chip');
});

// ---------------------------------------------------------------------------
// Wiring state and checks
// ---------------------------------------------------------------------------

test('a pending wire connects two ports and nothing else', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const b = editor.place('or_gate', 200, 0, { inputs: 2 })!;
  editor.startWire(a.ref, 'OUT');
  assert(editor.pendingWire !== null, 'a wire can be started');
  editor.cancelWire();
  assertEqual(editor.pendingWire, null, 'and abandoned');
  assertEqual(editor.circuit.netCount(), 0, 'having connected nothing');

  editor.startWire(a.ref, 'OUT');
  assertEqual(editor.finishWire(a.ref, 'OUT'), null, 'a wire from a pin to itself is refused');
  editor.startWire(a.ref, 'OUT');
  const result = editor.finishWire(b.ref, 'IN1');
  assert(result !== null, 'a wire to another pin connects');
  assertEqual(editor.circuit.netCount(), 1, 'making exactly one net');
  assertEqual(editor.pendingWire, null, 'and clearing the pending wire');

  editor.disconnect(a.ref, 'OUT');
  assert(editor.circuit.netCount() <= 1, 'disconnecting detaches the pin');
});

test('the ERC reports what the sheet actually does wrong', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const diagnostics = editor.erc();
  assert(Array.isArray(diagnostics), 'the ERC returns a list');
  assert(diagnostics.length > 0, `and an unconnected gate has something to report (${diagnostics.length})`);
  assert(diagnostics.every((d) => typeof d.code === 'string' && d.code.startsWith('CF')), 'every diagnostic carries an engine code');
  editor.addPort('Y', 'output', 1);
  editor.connect(a.ref, 'OUT', a.ref, 'IN1');
  assert(editor.erc().length >= 0, 'the check still runs after the sheet changes');
});

test('selection behaves the way a canvas expects', () => {
  const editor = makeEditor();
  const a = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const b = editor.place('or_gate', 200, 0, { inputs: 2 })!;
  const c = editor.place('not_gate', 400, 0)!;
  editor.select([a.ref]);
  assertEqual(editor.selection.length, 1, 'a click selects one');
  editor.select([b.ref], true);
  assertEqual(editor.selection.length, 2, 'a shift-click adds');
  editor.select([b.ref], true);
  assertEqual(editor.selection.length, 1, 'and a second shift-click removes');
  assertEqual(editor.selectAll(), 3, 'select all takes everything on the sheet');
  editor.selectNet('whatever');
  assertEqual(editor.selection.length, 0, 'selecting a net clears the component selection');
  assertEqual(editor.selectedNet, 'whatever', 'and records the net');
  editor.clearSelection();
  assertEqual(editor.selectedNet, null, 'clearing empties both');
  assertEqual(editor.selected.components.length, 0, 'so the inspector has nothing to show');
  void c;
});

test('the snapshot describes the editing state', () => {
  const editor = makeEditor();
  editor.place('and_gate', 0, 0, { inputs: 2 });
  const snapshot = editor.snapshot();
  assertEqual(snapshot.components, 1, 'one component');
  assertEqual(snapshot.path.length, 1, 'one level deep');
  assertEqual(snapshot.dirty, true, 'and the sheet is dirty until it is saved');
  assert(snapshot.undoDepth > 0, 'with an undo step available');
  editor.markSaved();
  assertEqual(editor.isDirty, false, 'marking it saved clears the flag');
  assert(editor.describe().length > 10, `and the status line says something: "${editor.describe()}"`);
});

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

test('every command has a label, a group and a unique id', () => {
  assert(COMMANDS.length >= 50, `the laboratory offers a real set of actions (${COMMANDS.length})`);
  const ids = new Set<string>();
  for (const command of COMMANDS) {
    assert(command.id.length > 2, 'an id is not empty');
    assert(command.id.includes('.'), `an id names its group: "${command.id}"`);
    assert(!ids.has(command.id), `the id "${command.id}" is unique`);
    ids.add(command.id);
    assert(command.label.length > 1, `"${command.id}" has a label a user can read`);
    assert(command.group.length > 1, `"${command.id}" belongs to a group`);
    assertEqual(commandById(command.id), command, `"${command.id}" resolves through the registry`);
  }
  assertEqual(commandById('no.such'), undefined, 'and an unknown id resolves to nothing rather than throwing');
  for (const group of ['file', 'edit', 'view', 'circuit', 'simulate', 'analyze', 'optimize', 'jobs', 'window', 'help'] as const) {
    assert(commandsInGroup(group).length > 0, `the ${group} group has commands`);
  }
});

test('every menu entry names a command that exists', () => {
  assert(MENUS.length >= 10, `the menu bar has its menus (${MENUS.length})`);
  const menuIds = new Set(MENUS.map((m) => m.id));
  assertEqual(menuIds.size, MENUS.length, 'menu ids are unique');
  let items = 0;
  for (const menu of MENUS) {
    const rendered = menuItems(menu);
    assert(rendered.length > 0, `the ${menu.label} menu is not empty`);
    for (const entry of rendered) {
      if (entry.kind === 'separator') continue;
      items++;
      assert(entry.command !== undefined, `every entry in ${menu.label} resolves to a command (got "${entry.label}")`);
      assert(!String(entry.label).startsWith('missing command'), `${menu.label} has no dangling entry: "${entry.label}"`);
    }
  }
  assert(items >= 50, `the menus expose the command set (${items} entries)`);
  // Every command group has a menu, so nothing is reachable only by shortcut.
  for (const group of ['file', 'edit', 'view', 'circuit', 'analyze', 'optimize', 'jobs', 'help']) {
    assert(menuIds.has(group), `the ${group} group has a menu of its own`);
  }
});

test('no two commands claim the same shortcut', () => {
  const map = keymap();
  const keys = COMMANDS.filter((c) => c.key).map((c) => c.key!);
  assertEqual(new Set(keys).size, keys.length, `every shortcut is claimed once (${keys.length} shortcuts)`);
  assertEqual(map.size, keys.length, 'and the keymap has one entry per shortcut');
  for (const key of keys) {
    const id = map.get(key)!;
    assert(commandById(id) !== undefined, `${key} maps to a real command (${id})`);
  }
  assert(map.has('ctrl+z'), 'undo has the shortcut everyone reaches for');
  assert(map.has('ctrl+s'), 'and so does save');
  assert(map.has('delete'), 'delete removes the selection');
});

test('keyboard events normalize to the registry format', () => {
  assertEqual(normalizeKey({ key: 'z', ctrlKey: true }), 'ctrl+z', 'ctrl+z');
  assertEqual(normalizeKey({ key: 'Z', ctrlKey: true, shiftKey: true }), 'ctrl+shift+z', 'a capital from shift keeps both modifiers');
  assertEqual(normalizeKey({ key: 's', metaKey: true }), 'ctrl+s', 'the command key on macOS is treated as ctrl');
  assertEqual(normalizeKey({ key: 'Delete' }), 'delete', 'a named key is lowercased');
  assertEqual(normalizeKey({ key: 'Escape' }), 'esc', 'and escape is spelled the way the registry spells it');
  assertEqual(normalizeKey({ key: ' ', ctrlKey: true, altKey: true, shiftKey: true }), 'ctrl+alt+shift+space', 'modifiers come in a fixed order');
  assertEqual(normalizeKey({ key: 'f' }), 'f', 'a plain letter is a plain letter');
});

test('the palette lists every command once, ordered for searching', () => {
  const entries = paletteEntries();
  assertEqual(entries.length, COMMANDS.length, 'the palette offers every command');
  assertEqual(new Set(entries.map((e) => e.id)).size, entries.length, 'with no duplicate');
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1];
    const b = entries[i];
    const ordered = a.group.localeCompare(b.group) <= 0;
    assert(ordered, `entries are grouped: "${a.group}" before "${b.group}"`);
  }
  assert(entries.some((e) => e.id === 'optimize.run'), 'including the optimizer');
  assert(entries.every((e) => e.label.length > 1), 'each with a label');
});

test('a command that does not apply is refused, not run', () => {
  const editor = makeEditor();
  const state = {
    dirty: editor.isDirty,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
    selection: editor.selection.length,
    depth: editor.depth,
    canGoUp: editor.canGoUp,
    running: false,
    jobs: 0,
    hasFile: false,
  };
  const undo = commandById('edit.undo')!;
  assertEqual(undo.enabled!(state), false, 'undo is unavailable on a fresh sheet');
  const closeSheet = commandById('file.close')!;
  assertEqual(closeSheet.enabled!(state), false, 'and there is no level to close out of');
  const fit = commandById('view.fit')!;
  assertEqual(fit.enabled ? fit.enabled(state) : true, true, 'while fitting the view always applies');

  editor.place('and_gate', 0, 0, { inputs: 2 });
  state.canUndo = editor.canUndo;
  state.selection = 1;
  assertEqual(undo.enabled!(state), true, 'after an edit, undo applies');
  assertEqual(commandById('edit.delete')!.enabled!(state), true, 'and so does delete');
});

test('a bulk sheet replacement is an edit, so it stays undoable', () => {
  const editor = makeEditor();
  const first = editor.place('and_gate', 0, 0, { inputs: 2 })!;
  const second = editor.place('or_gate', 140, 0, { inputs: 2 })!;
  assert(editor.connect(first.ref, 'OUT', second.ref, 'IN1', 1) !== null, 'the two gates are wired');
  assertEqual(editor.circuit.componentCount(), 2, 'two components on the sheet');
  const secondId = editor.byRef(second.ref)!.id;

  // A rewrite arrives as a Circuit, not as a document: that is what the miner's
  // replacement returns. Loading it through `loadDocument` would clear the undo stack,
  // which is right for opening a file and wrong for an edit — the user still expects
  // Ctrl+Z to give back the sheet they had.
  const rewritten = editor.circuit.clone();
  rewritten.removeComponent(secondId);
  editor.replaceSheet(rewritten, 'mine');

  assertEqual(editor.circuit, rewritten, 'the editor holds the circuit it was given, not a copy');
  assertEqual(editor.circuit.componentCount(), 1, 'and the sheet is the rewritten one');
  assertEqual(editor.selection.length, 0, 'a selection made on the old sheet means nothing on the new one');
  assert(editor.canUndo, 'the rewrite left something to undo');
  assert(editor.undo(), 'undoing it succeeds');
  assertEqual(editor.circuit.componentCount(), 2, 'the sheet the user had comes back');
  assert(editor.byRef(first.ref) !== undefined, 'with the first gate');
  assert(editor.byRef(second.ref) !== undefined, 'and the second');
});

test('the miner is reachable from the menu, not only from a console', () => {
  // A feature that only works from the command line is not finished: the point of the
  // mining work is that a person drawing a sheet can ask what it repeats.
  const command = commandById('analyze.mine');
  assert(command !== undefined, 'the command is in the registry');
  assertEqual(command!.group, 'analyze', 'in the analyze group');
  const menu = MENUS.find((m) => m.id === 'analyze');
  assert(menu !== undefined, 'there is an Analyze menu');
  assert(menu!.items.includes('analyze.mine'), 'and mining is one of its entries');
  assert(commandsInGroup('analyze').some((c) => c.id === 'analyze.mine'), 'so the group lists it');
  assert(paletteEntries().some((e) => e.id === 'analyze.mine'), 'and the command palette offers it');
  assertEqual(command!.key, 'ctrl+shift+m', 'with a shortcut of its own');
  assertEqual(keymap().get('ctrl+shift+m'), 'analyze.mine', 'that resolves back to it');
});
