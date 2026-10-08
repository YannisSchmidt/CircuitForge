/**
 * The command registry: every action the laboratory offers, once.
 *
 * Menus, toolbar buttons, keyboard shortcuts and the command palette are all views
 * onto this table, which is why they cannot disagree about what a key does or whether
 * an action exists. The browser layer binds a handler to each id; a test asserts that
 * every menu entry names a real command, that no two commands claim the same
 * shortcut, and that nothing is offered without a label — because a menu item whose
 * handler was never bound is a button that does nothing, and that is the failure mode
 * a registry like this exists to prevent.
 *
 * Key strings are normalized: lowercase, modifiers in the order `ctrl+alt+shift+key`.
 */

export type CommandGroup = 'file' | 'edit' | 'view' | 'circuit' | 'simulate' | 'analyze' | 'optimize' | 'jobs' | 'window' | 'help';

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Keyboard shortcut, normalized. */
  key?: string;
  /** One line for a tooltip or the palette. */
  hint?: string;
  /** Whether the command can run right now; the UI dims it when this is false. */
  enabled?: (state: CommandState) => boolean;
}

/** What a command may need to know to decide whether it applies. */
export interface CommandState {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selection: number;
  depth: number;
  canGoUp: boolean;
  running: boolean;
  jobs: number;
  hasFile: boolean;
}

export const ALWAYS: (state: CommandState) => boolean = () => true;

export const COMMANDS: Command[] = [
  // ---- file ----
  { id: 'file.new', label: 'New project', group: 'file', key: 'ctrl+alt+n', hint: 'Start an empty sheet, discarding the current one' },
  { id: 'file.open', label: 'Open…', group: 'file', key: 'ctrl+o', hint: 'Load a .cfproj.json from the data directory' },
  { id: 'file.save', label: 'Save', group: 'file', key: 'ctrl+s', hint: 'Write the project to its file' },
  { id: 'file.saveAs', label: 'Save as…', group: 'file', key: 'ctrl+shift+s', hint: 'Write the project under a new name' },
  { id: 'file.importDocument', label: 'Import circuit document…', group: 'file', hint: 'Load a .cfcircuit.json sheet into the current level' },
  { id: 'file.export', label: 'Export…', group: 'file', key: 'ctrl+e', hint: 'SPICE, JSON, BOM, schematic or SVG of the current sheet' },
  { id: 'file.saveChip', label: 'Save sheet as chip…', group: 'file', hint: 'Make the current sheet a reusable hierarchical chip' },
  { id: 'file.close', label: 'Close sheet', group: 'file', key: 'ctrl+w', hint: 'Leave the current hierarchy level', enabled: (s) => s.canGoUp },

  // ---- edit ----
  { id: 'edit.undo', label: 'Undo', group: 'edit', key: 'ctrl+z', hint: 'Restore the sheet as it was before the last edit', enabled: (s) => s.canUndo },
  { id: 'edit.redo', label: 'Redo', group: 'edit', key: 'ctrl+shift+z', hint: 'Re-apply the edit that was undone', enabled: (s) => s.canRedo },
  { id: 'edit.selectAll', label: 'Select all', group: 'edit', key: 'ctrl+a', hint: 'Select every component on this sheet' },
  { id: 'edit.delete', label: 'Delete', group: 'edit', key: 'delete', hint: 'Remove the selection and prune the nets it left empty', enabled: (s) => s.selection > 0 },
  { id: 'edit.rotate', label: 'Rotate 90°', group: 'edit', key: 'r', hint: 'Rotate the selection clockwise', enabled: (s) => s.selection > 0 },
  { id: 'edit.rotateBack', label: 'Rotate −90°', group: 'edit', key: 'shift+r', hint: 'Rotate the selection anticlockwise', enabled: (s) => s.selection > 0 },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'edit', key: 'ctrl+d', hint: 'Place a copy of the selection one grid step away', enabled: (s) => s.selection > 0 },
  { id: 'edit.disconnect', label: 'Disconnect selection', group: 'edit', hint: 'Detach every pin of the selected components', enabled: (s) => s.selection > 0 },
  { id: 'edit.addPort', label: 'Add circuit port…', group: 'edit', key: 'p', hint: 'Add an input or output port to this sheet' },

  // ---- view ----
  { id: 'view.fit', label: 'Fit sheet', group: 'view', key: 'f', hint: 'Zoom so the whole sheet is on screen' },
  { id: 'view.zoomIn', label: 'Zoom in', group: 'view', key: 'ctrl+=', hint: 'Zoom in around the centre of the view' },
  { id: 'view.zoomOut', label: 'Zoom out', group: 'view', key: 'ctrl+-', hint: 'Zoom out around the centre of the view' },
  { id: 'view.zoom100', label: 'Zoom 100 %', group: 'view', key: 'ctrl+0', hint: 'One sheet unit per pixel times ten' },
  { id: 'view.grid', label: 'Toggle grid', group: 'view', key: 'g', hint: 'Show or hide the placement grid' },
  { id: 'view.snap', label: 'Toggle snapping', group: 'view', hint: 'Snap placed and moved components to the grid' },
  { id: 'view.labels', label: 'Toggle labels', group: 'view', hint: 'Show or hide reference and value labels' },
  { id: 'view.theme', label: 'Toggle theme', group: 'view', hint: 'Switch between the dark and the light palette' },
  { id: 'view.level', label: 'Schematic level…', group: 'view', hint: 'Hierarchical, flattened, or full electrical' },

  // ---- circuit ----
  { id: 'circuit.open', label: 'Open selection', group: 'circuit', key: 'enter', hint: 'Drill into the chip under the cursor', enabled: (s) => s.selection > 0 },
  { id: 'circuit.up', label: 'Up one level', group: 'circuit', key: 'backspace', hint: 'Back out to the sheet that opened this one', enabled: (s) => s.canGoUp },
  { id: 'circuit.erc', label: 'Run ERC', group: 'circuit', key: 'ctrl+shift+e', hint: 'Electrical rules check: undriven nets, conflicts, width mismatches' },
  { id: 'circuit.commitChip', label: 'Update chip definition', group: 'circuit', key: 'ctrl+shift+u', hint: 'Write this edited implementation back as a new chip version', enabled: (s) => s.depth > 0 },
  { id: 'circuit.flatten', label: 'Show flattened netlist', group: 'circuit', hint: 'Expand every chip and report the element counts' },
  { id: 'circuit.reference', label: 'Load reference library', group: 'circuit', hint: 'Add the 19 reference designs to this project' },

  // ---- simulate ----
  { id: 'sim.run', label: 'Run logic', group: 'simulate', key: 'ctrl+enter', hint: 'Settle level 0 and colour every wire by its value' },
  { id: 'sim.stop', label: 'Stop', group: 'simulate', key: 'ctrl+.', hint: 'Clear the simulated values from the sheet', enabled: (s) => s.running },
  { id: 'sim.step', label: 'Step one tick', group: 'simulate', key: 'ctrl+shift+enter', hint: 'Advance registers by one clock tick' },
  { id: 'sim.dc', label: 'DC operating point', group: 'simulate', hint: 'Level 1: solve the node voltages and the power of every element' },
  { id: 'sim.transient', label: 'Transient sweep…', group: 'simulate', hint: 'Level 1: run a time sweep and plot it in the oscilloscope' },
  { id: 'sim.thermal', label: 'Thermal steady state', group: 'simulate', hint: 'Level 3: solve the thermal network and badge hot components' },
  { id: 'sim.toggle', label: 'Toggle selected input', group: 'simulate', key: 't', hint: 'Flip a driven input between 0, 1 and X', enabled: (s) => s.running },
  { id: 'sim.clock', label: 'Run clock', group: 'simulate', hint: 'Drive the sheet clock continuously until stopped' },

  // ---- analyze ----
  { id: 'analyze.run', label: 'Analyze circuit', group: 'analyze', key: 'ctrl+shift+a', hint: 'Critical path, unused components, fan-out, redundancy, risk' },
  { id: 'analyze.criticalPath', label: 'Show critical path', group: 'analyze', hint: 'Highlight the longest gate chain and its declared delay' },
  { id: 'analyze.unused', label: 'Select unused components', group: 'analyze', hint: 'Select everything the outputs do not depend on' },
  { id: 'analyze.stats', label: 'Statistics', group: 'analyze', hint: 'Per-circuit counts and measured totals' },

  // ---- optimize ----
  { id: 'optimize.run', label: 'Optimize design…', group: 'optimize', key: 'ctrl+shift+o', hint: 'Multi-objective search against a behavioural specification' },
  { id: 'optimize.why', label: 'Why this design?', group: 'optimize', hint: 'The measured deltas against the runner-up, nothing else' },
  { id: 'optimize.synth', label: 'Reverse-engineer a spec…', group: 'optimize', hint: 'From A[7:0], B[7:0] → Y = A + B to a validated chip' },
  { id: 'optimize.apply', label: 'Apply best candidate', group: 'optimize', hint: 'Insert the best design found as a chip on this sheet' },

  // ---- jobs ----
  { id: 'jobs.show', label: 'Job queue', group: 'jobs', key: 'ctrl+shift+j', hint: 'Open the jobs dock' },
  { id: 'jobs.pause', label: 'Pause active job', group: 'jobs', hint: 'Checkpoint and pause the running job', enabled: (s) => s.jobs > 0 },
  { id: 'jobs.resume', label: 'Resume job', group: 'jobs', hint: 'Continue a paused or interrupted job', enabled: (s) => s.jobs > 0 },
  { id: 'jobs.cancel', label: 'Cancel active job', group: 'jobs', hint: 'Stop the running job and keep its checkpoint', enabled: (s) => s.jobs > 0 },
  { id: 'jobs.benchmark', label: 'Run benchmark…', group: 'jobs', hint: 'Measure the engine itself: quick, full, scaling or stress' },

  // ---- window ----
  { id: 'window.components', label: 'Components panel', group: 'window', hint: 'Show or hide the component browser' },
  { id: 'window.inspector', label: 'Inspector panel', group: 'window', hint: 'Show or hide the inspector' },
  { id: 'window.console', label: 'Console dock', group: 'window', key: 'ctrl+`', hint: 'Show or hide the console' },
  { id: 'window.scope', label: 'Oscilloscope dock', group: 'window', hint: 'Show or hide the oscilloscope' },
  { id: 'window.simulation', label: 'Simulation dock', group: 'window', hint: 'Show or hide the simulation results' },

  // ---- help ----
  { id: 'help.about', label: 'About CircuitForge', group: 'help', hint: 'Version, platform, and what this build claims' },
  { id: 'help.docs', label: 'Documentation', group: 'help', hint: 'The twelve documents that describe the engine' },
  { id: 'help.limits', label: 'Known limitations', group: 'help', hint: 'What the models do not do, stated plainly' },
  { id: 'help.accuracy', label: 'Accuracy of this sheet', group: 'help', hint: 'The accuracy class of every model on the current sheet' },
];

export interface MenuDefinition {
  id: string;
  label: string;
  items: Array<string | '-'>;
}

export const MENUS: MenuDefinition[] = [
  { id: 'file', label: 'File', items: ['file.new', 'file.open', 'file.save', 'file.saveAs', '-', 'file.importDocument', 'file.export', '-', 'file.saveChip', '-', 'file.close'] },
  { id: 'edit', label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.selectAll', 'edit.duplicate', 'edit.delete', '-', 'edit.rotate', 'edit.rotateBack', 'edit.disconnect', '-', 'edit.addPort'] },
  { id: 'view', label: 'View', items: ['view.fit', 'view.zoomIn', 'view.zoomOut', 'view.zoom100', '-', 'view.grid', 'view.snap', 'view.labels', 'view.theme', '-', 'view.level'] },
  { id: 'circuit', label: 'Circuit', items: ['circuit.open', 'circuit.up', '-', 'circuit.erc', 'circuit.flatten', 'circuit.commitChip', '-', 'circuit.reference'] },
  { id: 'simulate', label: 'Simulate', items: ['sim.run', 'sim.step', 'sim.stop', '-', 'sim.dc', 'sim.transient', 'sim.thermal', '-', 'sim.toggle', 'sim.clock'] },
  { id: 'analyze', label: 'Analyze', items: ['analyze.run', 'analyze.criticalPath', 'analyze.unused', 'analyze.stats'] },
  { id: 'optimize', label: 'Optimize', items: ['optimize.run', 'optimize.synth', '-', 'optimize.why', 'optimize.apply'] },
  { id: 'jobs', label: 'Jobs', items: ['jobs.show', 'jobs.benchmark', '-', 'jobs.pause', 'jobs.resume', 'jobs.cancel'] },
  { id: 'window', label: 'Window', items: ['window.components', 'window.inspector', '-', 'window.simulation', 'window.scope', 'window.console'] },
  { id: 'help', label: 'Help', items: ['help.about', 'help.accuracy', 'help.docs', 'help.limits'] },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id);
}

/** Normalize a key event into the registry's key format. */
export function normalizeKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  let key = event.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  // `shift+r` is a distinct command from `r`, so shift stays in the string; for a
  // plain letter the shift state is what produced the capital, and both forms are
  // registered explicitly where they differ.
  parts.push(key);
  return parts.join('+');
}

/** Shortcut → command id, for the key handler. */
export function keymap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of COMMANDS) if (c.key) map.set(c.key, c.id);
  return map;
}

/** Every command whose group matches, in declaration order. */
export function commandsInGroup(group: CommandGroup): Command[] {
  return COMMANDS.filter((c) => c.group === group);
}

/** What a menu shows, with separators resolved. */
export function menuItems(menu: MenuDefinition): Array<{ kind: 'item' | 'separator'; command?: Command; label?: string }> {
  return menu.items.map((id) => {
    if (id === '-') return { kind: 'separator' as const };
    const command = commandById(id);
    return command ? { kind: 'item' as const, command, label: command.label } : { kind: 'item' as const, label: `missing command "${id}"` };
  });
}

/** A flat list for the command palette, ordered by group then label. */
export function paletteEntries(): Array<{ id: string; label: string; group: CommandGroup; key?: string; hint?: string }> {
  return COMMANDS.map((c) => ({ id: c.id, label: c.label, group: c.group, key: c.key, hint: c.hint })).sort(
    (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
  );
}
