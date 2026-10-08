/**
 * The editor's logic, without a pixel of DOM in it.
 *
 * Everything that makes the graphical laboratory an editor rather than a picture
 * lives here: what is open, what is selected, what a click does, what can be undone,
 * and how deep into the hierarchy the user has drilled. The browser layer in
 * `public/app.js` is deliberately thin — it paints what this module says and forwards
 * events to it — so the behaviour can be tested headlessly, which is the only way an
 * editor with a hundred interactions gets verified at all.
 *
 * Two design decisions worth stating:
 *
 *   - Undo is a stack of documents, not of inverse operations. Every mutation
 *     snapshots the sheet as a serialised document and restores it wholesale. That
 *     costs a serialisation per edit, which at a thousand components is milliseconds,
 *     and it cannot be wrong in the way an inverse operation can be when the
 *     operation it inverts touched several nets. Each hierarchy layer keeps its own
 *     stack, because undoing inside a chip must not undo the sheet that opened it.
 *   - Opening a chip instance opens a *copy* of its implementation. Edits are local
 *     until `commitToChip()` writes them back as a new version, because silently
 *     changing every instance of a chip in a design because someone dragged a gate
 *     inside one of them is the kind of surprise an engineering tool must not have.
 */

import { ChipLibrary, bumpVersion, sanitizeChipId, type Chip } from '../engine/core/chip.js';
import { Circuit, type ComponentInstance, type CircuitPort } from '../engine/core/circuit.js';
import type { Library } from '../engine/core/library.js';
import { createDefaultLibrary } from '../engine/core/registry.js';
import { Project } from '../engine/core/project.js';
import { buildReferenceProject } from '../engine/synthesis/reference.js';
import { circuitFromDocument, circuitToDocument, type CircuitDocument } from '../engine/io/serialize.js';
import type { Diagnostic } from '../engine/core/labels.js';

export type ParamBag = Record<string, number | string | boolean>;

/** One level of the hierarchy the user has drilled into. */
export interface EditorLayer {
  /** What is being edited. */
  circuit: Circuit;
  /** Chip definition this layer came from, when it did. */
  chipId?: string;
  /** The instance reference on the parent sheet, when opened from one. */
  chipRef?: string;
  /** Parameters the instance was opened with. */
  params?: ParamBag;
  /** Breadcrumb label. */
  title: string;
  /** True when this layer's circuit has been edited since it was opened. */
  dirty: boolean;
  undo: string[];
  redo: string[];
}

export interface EditorOptions {
  lib?: Library;
  chips?: ChipLibrary;
  project?: Project;
  /** Name of the first, empty sheet. */
  name?: string;
  /** Called after any change the view should redraw for. */
  onChange?: (reason: string) => void;
  /** Called for anything the user should be told about, in order. */
  onLog?: (line: string, severity?: 'info' | 'warn' | 'error') => void;
  /** Undo depth per layer. */
  undoLimit?: number;
}

export interface SelectionInfo {
  refs: string[];
  components: ComponentInstance[];
  ports: CircuitPort[];
}

export interface PlaceResult {
  ref: string;
  id: number;
  diagnostics: Diagnostic[];
}

export interface ConnectResult {
  net: string;
  netId: number;
  width: number;
  diagnostics: Diagnostic[];
}

export class Editor {
  readonly lib: Library;
  readonly chips: ChipLibrary;
  readonly project: Project;
  readonly layers: EditorLayer[] = [];
  /** Selection is by reference designator, which is what the sheet shows. */
  selection: string[] = [];
  /** The net whose wire is highlighted, when one is. */
  selectedNet: string | null = null;
  /** The port a wire is being drawn from, while it is being drawn. */
  pendingWire: { ref: string; pin: string } | null = null;
  private undoLimit: number;
  private onChange: (reason: string) => void;
  private onLog: (line: string, severity?: 'info' | 'warn' | 'error') => void;
  /** Whole-project dirty flag: true when any layer was edited since the last save. */
  private dirty = false;
  private fileName: string | null = null;

  constructor(options: EditorOptions = {}) {
    this.lib = options.lib ?? createDefaultLibrary();
    const project = options.project ?? new Project(options.name ?? 'untitled', this.lib, options.chips ?? new ChipLibrary());
    this.project = project;
    this.chips = options.chips ?? project.chips;
    this.undoLimit = options.undoLimit ?? 200;
    this.onChange = options.onChange ?? (() => undefined);
    this.onLog = options.onLog ?? (() => undefined);
    const circuit = new Circuit(options.name ?? 'untitled');
    this.layers.push({ circuit, title: circuit.name, dirty: false, undo: [], redo: [] });
  }

  // ---- what is open -------------------------------------------------------

  get layer(): EditorLayer {
    return this.layers[this.layers.length - 1];
  }

  get circuit(): Circuit {
    return this.layer.circuit;
  }

  get name(): string {
    return this.project.name;
  }

  get depth(): number {
    return this.layers.length - 1;
  }

  /** Breadcrumb labels, outermost first. */
  get path(): string[] {
    return this.layers.map((l) => l.title);
  }

  get canGoUp(): boolean {
    return this.layers.length > 1;
  }

  get isDirty(): boolean {
    return this.dirty || this.layers.some((l) => l.dirty);
  }

  get file(): string | null {
    return this.fileName;
  }

  get canUndo(): boolean {
    return this.layer.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.layer.redo.length > 0;
  }

  log(line: string, severity: 'info' | 'warn' | 'error' = 'info'): void {
    this.onLog(line, severity);
  }

  // ---- documents ----------------------------------------------------------

  /** The whole project as a document: every chip plus the sheet being edited. */
  toProjectDocument(): Record<string, unknown> {
    const doc = projectToDocumentOf(this.project);
    return {
      ...doc,
      // The sheet on screen may be a chip implementation rather than the project's
      // own; recording it keeps a save/load round trip faithful to what the user sees.
      openSheet: { title: this.layer.title, chipId: this.layer.chipId ?? null, document: circuitToDocument(this.circuit) },
      breadcrumb: this.path,
      dirty: this.isDirty,
    };
  }

  /** The sheet being edited, as a document. */
  toDocument(): CircuitDocument {
    return circuitToDocument(this.circuit);
  }

  /** Replace the current sheet with a document, keeping the hierarchy above it. */
  loadDocument(doc: CircuitDocument): { diagnostics: Diagnostic[] } {
    const result = circuitFromDocument(doc, this.lib, this.chips);
    this.layer.circuit = result.circuit;
    this.layer.title = result.circuit.name;
    this.layer.undo = [];
    this.layer.redo = [];
    this.layer.dirty = false;
    this.selection = [];
    this.selectedNet = null;
    this.fileName = doc.name ? this.fileName : null;
    this.markChanged('load');
    return { diagnostics: result.diagnostics };
  }

  /**
   * Swap the current sheet for a circuit built elsewhere — the shape a bulk rewrite
   * arrives in, such as replacing every occurrence of a mined pattern with a chip.
   *
   * This is deliberately not `loadDocument`: loading a file starts a new history and
   * clears the undo stack, which is right for a file and wrong for an edit. A bulk
   * rewrite is an edit, so the sheet the user had is checkpointed first and Ctrl+Z
   * gives it back. The circuit is taken as it is — no re-serialization round trip —
   * because a rewrite of 900 components should not pay for one.
   */
  replaceSheet(circuit: Circuit, reason = 'replace'): void {
    this.checkpoint();
    this.layer.circuit = circuit;
    this.layer.title = circuit.name;
    this.selection = [];
    this.selectedNet = null;
    this.markChanged(reason);
  }

  /** A fresh empty sheet, discarding everything (the caller confirms first). */
  newProject(name = 'untitled'): void {
    this.layers.length = 0;
    const circuit = new Circuit(name);
    this.layers.push({ circuit, title: name, dirty: false, undo: [], redo: [] });
    this.selection = [];
    this.selectedNet = null;
    this.dirty = false;
    this.fileName = null;
    this.markChanged('new');
  }

  setFile(file: string | null): void {
    this.fileName = file;
  }

  markSaved(): void {
    this.dirty = false;
    for (const l of this.layers) l.dirty = false;
  }

  // ---- undo / redo --------------------------------------------------------

  /** Take the snapshot a mutation is about to invalidate. Called before changing. */
  private checkpoint(): void {
    const layer = this.layer;
    layer.undo.push(JSON.stringify(circuitToDocument(layer.circuit)));
    if (layer.undo.length > this.undoLimit) layer.undo.shift();
    layer.redo.length = 0;
  }

  /**
   * Take one snapshot for a multi-step interaction, then mutate freely.
   *
   * A drag moves a component dozens of times; recording each step would fill the undo
   * stack with intermediate positions the user never meant. The view calls this on
   * mouse-down and `endTransaction` on mouse-up, so one drag is one undo step.
   */
  beginTransaction(): void {
    this.checkpoint();
  }

  endTransaction(reason = 'drag'): void {
    this.markChanged(reason);
  }

  /** Move without snapshotting, for the frames of a drag inside a transaction. */
  moveLive(ref: string, x: number, y: number, grid = 0): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    const sx = grid > 0 ? Math.round(x / grid) * grid : x;
    const sy = grid > 0 ? Math.round(y / grid) * grid : y;
    if (sx === inst.x && sy === inst.y) return true;
    this.circuit.moveComponent(inst.id, sx, sy);
    this.layer.dirty = true;
    this.dirty = true;
    return true;
  }

  /** Copy the selection one grid step away, as new components with new references. */
  duplicate(refs: string[], offset = { x: 20, y: 20 }): number {
    const targets = refs.length > 0 ? refs : this.selection;
    if (targets.length === 0) return 0;
    this.checkpoint();
    const created: string[] = [];
    for (const ref of targets) {
      const inst = this.byRef(ref);
      if (!inst) continue;
      const spec = this.lib.get(inst.specId);
      if (!spec) continue;
      const copy = this.circuit.addComponent(spec, { ...inst.params }, { x: inst.x + offset.x, y: inst.y + offset.y }, {
        bits: inst.bits,
        rotation: inst.rotation,
        chipRef: inst.chipRef,
      });
      created.push(copy.ref);
    }
    this.selection = created;
    this.markChanged('duplicate');
    this.log(`duplicated ${created.length} component(s); the copies are unconnected, as a copy should be`, 'info');
    return created.length;
  }

  undo(): boolean {
    const layer = this.layer;
    const snapshot = layer.undo.pop();
    if (!snapshot) return false;
    layer.redo.push(JSON.stringify(circuitToDocument(layer.circuit)));
    this.restore(layer, snapshot, 'undo');
    return true;
  }

  redo(): boolean {
    const layer = this.layer;
    const snapshot = layer.redo.pop();
    if (!snapshot) return false;
    layer.undo.push(JSON.stringify(circuitToDocument(layer.circuit)));
    this.restore(layer, snapshot, 'redo');
    return true;
  }

  private restore(layer: EditorLayer, snapshot: string, reason: string): void {
    const doc = JSON.parse(snapshot) as CircuitDocument;
    const result = circuitFromDocument(doc, this.lib, this.chips);
    layer.circuit = result.circuit;
    // A selection referring to components that no longer exist would highlight
    // nothing and confuse the inspector, so it is pruned to what survived.
    const alive = new Set(result.circuit.allComponents().map((c) => c.ref));
    this.selection = this.selection.filter((r) => alive.has(r));
    if (this.selectedNet && !result.circuit.allNets().some((n) => n.name === this.selectedNet)) this.selectedNet = null;
    layer.dirty = true;
    this.dirty = true;
    if (result.diagnostics.length > 0) {
      this.log(`${reason} restored the sheet with ${result.diagnostics.length} diagnostic(s): ${result.diagnostics[0].message}`, 'warn');
    }
    this.markChanged(reason);
  }

  private markChanged(reason: string): void {
    this.layer.dirty = true;
    this.dirty = true;
    this.onChange(reason);
  }

  // ---- hierarchy ----------------------------------------------------------

  /**
   * Drill into a component: if it instantiates a chip, open the chip's
   * implementation. Returns false when the component is a primitive, which is not an
   * error — a resistor has nothing underneath it, and saying so is the answer.
   */
  open(ref: string): boolean {
    const inst = this.byRef(ref);
    if (!inst) {
      this.log(`no component with reference "${ref}" on this sheet`, 'error');
      return false;
    }
    const chip = this.chipOf(inst);
    if (!chip) {
      this.log(`${ref} is a ${inst.specId} primitive: there is nothing underneath it to open`, 'info');
      return false;
    }
    const params = (inst.params ?? {}) as ParamBag;
    let implementation: Circuit;
    try {
      implementation = chip.implementation(params);
    } catch (err) {
      this.log(`opening ${chip.def.id} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
    implementation.name = `${chip.def.name} (${ref})`;
    this.layers.push({
      circuit: implementation,
      chipId: chip.def.id,
      chipRef: ref,
      params,
      title: `${chip.def.name}:${ref}`,
      dirty: false,
      undo: [],
      redo: [],
    });
    this.selection = [];
    this.selectedNet = null;
    this.markChanged('open');
    this.log(`opened ${chip.def.id} v${chip.def.version} as ${ref} (${implementation.componentCount()} component(s))`, 'info');
    return true;
  }

  /** Open a chip definition directly, from the chip browser. */
  openChip(chipId: string): boolean {
    const chip = this.chips.get(chipId);
    if (!chip) {
      this.log(`no chip named "${chipId}"`, 'error');
      return false;
    }
    let implementation: Circuit;
    try {
      implementation = chip.implementation(chip.defaultParams());
    } catch (err) {
      this.log(`opening ${chipId} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
    implementation.name = chip.def.name;
    this.layers.push({ circuit: implementation, chipId, title: chip.def.name, dirty: false, undo: [], redo: [] });
    this.selection = [];
    this.markChanged('open-chip');
    return true;
  }

  /** Back out one level. Local edits are kept in the layer until committed. */
  up(): boolean {
    if (!this.canGoUp) return false;
    const leaving = this.layers.pop()!;
    if (leaving.dirty && leaving.chipId) {
      this.log(`${leaving.title} was edited but not committed: the changes stay in this session until "Update chip" is used`, 'warn');
    }
    this.selection = [];
    this.selectedNet = null;
    this.markChanged('up');
    return true;
  }

  /** Jump to a breadcrumb level; 0 is the outermost sheet. */
  goToLevel(level: number): boolean {
    const target = Math.max(0, Math.min(this.layers.length - 1, Math.round(level)));
    let moved = false;
    while (this.layers.length - 1 > target) {
      this.layers.pop();
      moved = true;
    }
    if (moved) {
      this.selection = [];
      this.markChanged('level');
    }
    return moved;
  }

  /**
   * Write the current layer back into its chip definition as a new version.
   *
   * Refuses to create a cycle: a chip that contains itself would make every
   * flattening infinite, and the library's own cycle check is what says so.
   */
  commitToChip(options: { bump?: 'major' | 'minor' | 'patch'; description?: string } = {}): { chip: Chip; version: string } | null {
    const layer = this.layer;
    if (!layer.chipId) {
      this.log('this sheet is not a chip implementation; use "Save as chip" to make one', 'warn');
      return null;
    }
    const existing = this.chips.get(layer.chipId);
    if (!existing) {
      this.log(`the chip "${layer.chipId}" is no longer in the library`, 'error');
      return null;
    }
    const erc = layer.circuit.erc(this.lib, this.chips);
    const errors = erc.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      this.log(`refusing to commit ${layer.chipId}: ${errors.length} ERC error(s), first is ${errors[0].code} "${errors[0].message}"`, 'error');
      return null;
    }
    const version = bumpVersion(existing.def.version, options.bump ?? 'minor');
    // A chip that contains itself makes every flattening infinite. The check is
    // against the chips this implementation actually instantiates — asking whether a
    // chip depends on itself is a different question, and always answers yes.
    for (const inst of layer.circuit.allComponents()) {
      const child = this.chipOf(inst);
      if (!child || child.def.id === layer.chipId) {
        if (child && child.def.id === layer.chipId) {
          this.log(`refusing to commit ${layer.chipId}: its own implementation instantiates it (${inst.ref}), which would flatten forever`, 'error');
          return null;
        }
        continue;
      }
      const cycle = this.chips.cycleCheck(layer.chipId, child.def.id);
      if (cycle.length > 0) {
        this.log(`refusing to commit ${layer.chipId}: using ${child.def.id} inside it would create a cycle — ${cycle[0].message}`, 'error');
        return null;
      }
    }
    const chip = this.project.saveAsChip(layer.circuit, {
      id: layer.chipId,
      name: existing.def.name,
      description: options.description ?? existing.def.description,
      version,
      overwrite: true,
    });
    layer.dirty = false;
    this.log(`committed ${layer.chipId} v${version}: ${layer.circuit.componentCount()} component(s), ${erc.length} ERC note(s)`, 'info');
    this.markChanged('commit');
    return { chip, version };
  }

  /** Save the current sheet as a new chip definition. */
  saveAsChip(options: { name?: string; id?: string; description?: string } = {}): Chip | null {
    const name = options.name ?? this.circuit.name;
    const id = options.id ?? sanitizeChipId(name);
    if (this.chips.has(id)) {
      this.log(`a chip named "${id}" already exists (v${this.chips.must(id).def.version}); choose another name or update it from inside`, 'warn');
      return null;
    }
    const erc = this.circuit.erc(this.lib, this.chips);
    const errors = erc.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      this.log(`refusing to save "${id}" as a chip: ${errors.length} ERC error(s), first is ${errors[0].code} "${errors[0].message}"`, 'error');
      return null;
    }
    const chip = this.project.saveAsChip(this.circuit, { id, name, description: options.description ?? '', overwrite: false });
    this.log(`saved "${name}" as chip ${id} v${chip.def.version} with ${this.circuit.allPorts().length} port(s) and ${erc.length} ERC note(s)`, 'info');
    this.markChanged('save-chip');
    return chip;
  }

  /** Which chip a component instantiates, resolved the way the engine resolves it:
   * the library first, then the instance's own chip reference, then its spec id. */
  chipOf(inst: ComponentInstance): Chip | undefined {
    const spec = this.lib.get(inst.specId);
    if (spec && spec.category === 'chip') return this.chips.get(spec.id);
    const id = inst.chipRef ?? (inst.params as ParamBag | undefined)?.__chip ?? inst.specId;
    return typeof id === 'string' ? this.chips.get(id) : undefined;
  }

  byRef(ref: string): ComponentInstance | undefined {
    for (const c of this.circuit.allComponents()) if (c.ref === ref) return c;
    return undefined;
  }

  byId(id: number): ComponentInstance | undefined {
    return this.circuit.getComponent(id);
  }

  // ---- mutations ----------------------------------------------------------

  /** Place a library component. */
  place(specId: string, x: number, y: number, params: ParamBag = {}, opts: { bits?: number; rotation?: number } = {}): PlaceResult | null {
    const spec = this.lib.get(specId);
    if (!spec) {
      this.log(`no component "${specId}" in the library`, 'error');
      return null;
    }
    this.checkpoint();
    const inst = this.circuit.addComponent(spec, params, { x, y }, {
      bits: opts.bits ?? 1,
      rotation: (opts.rotation ?? 0) as 0 | 90 | 180 | 270,
      chipRef: spec.category === 'chip' ? specId : undefined,
    });
    this.selection = [inst.ref];
    this.markChanged('place');
    return { ref: inst.ref, id: inst.id, diagnostics: [] };
  }

  /** Place a chip instance. */
  placeChip(chipId: string, x: number, y: number, params: ParamBag = {}): PlaceResult | null {
    const chip = this.chips.get(chipId);
    if (!chip) {
      this.log(`no chip "${chipId}" in the project`, 'error');
      return null;
    }
    const spec = this.lib.get(chipId);
    if (!spec) {
      this.log(`chip "${chipId}" has no component spec in the library, so it cannot be placed; re-register it with the project`, 'error');
      return null;
    }
    this.checkpoint();
    const merged: ParamBag = { ...chip.defaultParams(), ...params };
    const inst = this.circuit.addComponent(spec, merged, { x, y }, { chipRef: chipId, bits: Number(merged.bits ?? 1) > 1 ? Number(merged.bits) : 1 });
    this.selection = [inst.ref];
    this.markChanged('place-chip');
    return { ref: inst.ref, id: inst.id, diagnostics: [] };
  }

  move(refs: string[], dx: number, dy: number): number {
    const targets = refs.length > 0 ? refs : this.selection;
    if (targets.length === 0) return 0;
    this.checkpoint();
    let moved = 0;
    for (const ref of targets) {
      const inst = this.byRef(ref);
      if (!inst) continue;
      this.circuit.moveComponent(inst.id, inst.x + dx, inst.y + dy);
      moved++;
    }
    this.markChanged('move');
    return moved;
  }

  /** Move to an absolute position, snapping to the grid when one is given. */
  moveTo(ref: string, x: number, y: number, grid = 0): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    this.checkpoint();
    const sx = grid > 0 ? Math.round(x / grid) * grid : x;
    const sy = grid > 0 ? Math.round(y / grid) * grid : y;
    this.circuit.moveComponent(inst.id, sx, sy);
    this.markChanged('move-to');
    return true;
  }

  rotate(refs: string[], delta = 90): number {
    const targets = refs.length > 0 ? refs : this.selection;
    if (targets.length === 0) return 0;
    this.checkpoint();
    let n = 0;
    for (const ref of targets) {
      const inst = this.byRef(ref);
      if (!inst) continue;
      this.circuit.rotateComponent(inst.id, delta);
      n++;
    }
    this.markChanged('rotate');
    return n;
  }

  remove(refs: string[]): number {
    const targets = refs.length > 0 ? refs : this.selection;
    if (targets.length === 0) return 0;
    this.checkpoint();
    const ids: number[] = [];
    for (const ref of targets) {
      const inst = this.byRef(ref);
      if (inst) ids.push(inst.id);
    }
    this.circuit.removeComponents(ids);
    this.circuit.pruneEmptyNets();
    const removed = ids.length;
    this.selection = this.selection.filter((r) => !targets.includes(r));
    this.markChanged('remove');
    this.log(`removed ${removed} component(s)`, 'info');
    return removed;
  }

  setParam(ref: string, name: string, value: number | string | boolean): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    this.checkpoint();
    try {
      this.circuit.setParam(inst.id, name, value);
    } catch (err) {
      this.undo();
      this.log(`setting ${ref}.${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
    this.markChanged('param');
    return true;
  }

  setBits(ref: string, bits: number): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    this.checkpoint();
    this.circuit.setBits(inst.id, bits);
    this.markChanged('bits');
    return true;
  }

  setRef(ref: string, next: string): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    this.checkpoint();
    try {
      this.circuit.setRef(inst.id, next);
    } catch (err) {
      this.undo();
      this.log(`renaming ${ref} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
    this.selection = this.selection.map((r) => (r === ref ? next : r));
    this.markChanged('ref');
    return true;
  }

  // ---- wiring -------------------------------------------------------------

  /**
   * Connect two pins, reusing the net one of them is already on.
   *
   * Widths have to agree: joining a 1-bit pin to an 8-bit bus is a design error, not
   * a convenience, and the ERC would report it later anyway. The refusal is returned
   * as a diagnostic so the console can say exactly why nothing happened.
   */
  connect(refA: string, pinA: string, refB: string, pinB: string, width?: number): ConnectResult | null {
    const a = this.byRef(refA);
    const b = this.byRef(refB);
    if (!a || !b) {
      this.log(`cannot connect ${refA}.${pinA} to ${refB}.${pinB}: one of the components is not on this sheet`, 'error');
      return null;
    }
    const netA = this.circuit.netOf(a.id, pinA);
    const netB = this.circuit.netOf(b.id, pinB);
    if (netA && netB && netA.id !== netB.id) {
      if (netA.width !== netB.width) {
        this.log(`cannot join net "${netA.name}" (${netA.width} bit) to "${netB.name}" (${netB.width} bit): widths differ`, 'error');
        return null;
      }
      this.checkpoint();
      const merged = this.circuit.mergeNets(netA.id, netB.id);
      this.markChanged('merge');
      const net = this.circuit.getNet(merged);
      return { net: net?.name ?? `net#${merged}`, netId: merged, width: net?.width ?? 1, diagnostics: [] };
    }
    const keep = netA ?? netB;
    // Attaching a free pin to an existing net has to check widths too: the ERC would
    // report the mismatch later, but an editor that creates it in the first place is
    // an editor that lets a user build a broken design by clicking.
    if (keep) {
      const free = netA ? b : a;
      const freePin = netA ? pinB : pinA;
      const freeWidth = this.pinWidth(free, freePin);
      if (freeWidth !== keep.width) {
        this.log(
          `cannot attach ${free.ref}.${freePin} (${freeWidth} bit) to net "${keep.name || 'net#' + keep.id}" (${keep.width} bit): widths differ. Set the component's bits, or use a net of the same width.`,
          'error',
        );
        return null;
      }
    }
    this.checkpoint();
    let netId: number;
    let netName: string;
    let netWidth: number;
    if (keep) {
      netId = keep.id;
      netName = keep.name;
      netWidth = keep.width;
      const other = keep === netA ? b : a;
      const otherPin = keep === netA ? pinB : pinA;
      const result = this.circuit.connect(other.id, otherPin, netId);
      if (result && Array.isArray((result as { diagnostics?: Diagnostic[] }).diagnostics) && (result as { diagnostics: Diagnostic[] }).diagnostics.length > 0) {
        for (const d of (result as { diagnostics: Diagnostic[] }).diagnostics) this.log(`${d.code}: ${d.message}`, d.severity === 'error' ? 'error' : 'warn');
      }
    } else {
      const w = width ?? Math.max(this.pinWidth(a, pinA), this.pinWidth(b, pinB));
      const net = this.circuit.createNet('', w);
      netId = net.id;
      netName = net.name;
      netWidth = net.width;
      this.circuit.connect(a.id, pinA, netId);
      this.circuit.connect(b.id, pinB, netId);
    }
    this.selectedNet = netName;
    this.markChanged('connect');
    return { net: netName, netId, width: netWidth, diagnostics: [] };
  }

  /** Connect a pin to a named net, creating the net if it does not exist. */
  connectToNet(ref: string, pin: string, netName: string, width = 1): ConnectResult | null {
    const inst = this.byRef(ref);
    if (!inst) return null;
    this.checkpoint();
    let net = this.circuit.allNets().find((n) => n.name === netName);
    if (!net) net = this.circuit.createNet(netName, width);
    const result = this.circuit.connect(inst.id, pin, net.id);
    this.markChanged('connect-net');
    return {
      net: net.name,
      netId: net.id,
      width: net.width,
      diagnostics: Array.isArray((result as { diagnostics?: Diagnostic[] })?.diagnostics) ? (result as { diagnostics: Diagnostic[] }).diagnostics : [],
    };
  }

  disconnect(ref: string, pin?: string): boolean {
    const inst = this.byRef(ref);
    if (!inst) return false;
    this.checkpoint();
    this.circuit.disconnect(inst.id, pin);
    this.circuit.pruneEmptyNets();
    this.markChanged('disconnect');
    return true;
  }

  /** Add a circuit port (a sheet input/output), creating its net if needed. */
  addPort(name: string, direction: 'input' | 'output' | 'bidirectional', width = 1): CircuitPort | null {
    if (!name) {
      this.log('a port needs a name', 'error');
      return null;
    }
    this.checkpoint();
    let net = this.circuit.allNets().find((n) => n.name === name);
    if (!net) net = this.circuit.createNet(name, width);
    if (net.width !== width) {
      this.undo();
      this.log(`port "${name}" wants ${width} bit(s) but the net of that name is ${net.width} bit(s)`, 'error');
      return null;
    }
    const port = this.circuit.addPort(name, direction, width, net.id);
    this.markChanged('port');
    this.log(`added ${direction} port ${name}[${width}]`, 'info');
    return port;
  }

  removePort(name: string): boolean {
    const port = this.circuit.allPorts().find((p) => p.name === name);
    if (!port) return false;
    this.checkpoint();
    this.circuit.removePort(port.id);
    this.markChanged('remove-port');
    return true;
  }

  private pinWidth(inst: ComponentInstance, pin: string): number {
    const spec = this.lib.get(inst.specId);
    const p = spec?.pins.find((q) => q.name === pin);
    const w = p?.width ?? 1;
    return this.circuit.effectivePinWidth(inst, w);
  }

  /** Start drawing a wire from a port; the next `connectPending` finishes it. */
  startWire(ref: string, pin: string): void {
    this.pendingWire = { ref, pin };
    this.onChange('wire-start');
  }

  cancelWire(): void {
    this.pendingWire = null;
    this.onChange('wire-cancel');
  }

  finishWire(ref: string, pin: string): ConnectResult | null {
    const start = this.pendingWire;
    this.pendingWire = null;
    if (!start) return null;
    if (start.ref === ref && start.pin === pin) {
      this.log('a wire needs two different pins', 'warn');
      return null;
    }
    const result = this.connect(start.ref, start.pin, ref, pin);
    this.onChange('wire-end');
    return result;
  }

  // ---- selection ----------------------------------------------------------

  select(refs: string[], additive = false): void {
    if (!additive) {
      this.selection = [...refs];
    } else {
      const set = new Set(this.selection);
      for (const r of refs) if (set.has(r)) set.delete(r);
      else set.add(r);
      this.selection = [...set];
    }
    this.selectedNet = null;
    this.onChange('select');
  }

  selectNet(net: string): void {
    this.selectedNet = net;
    this.selection = [];
    this.onChange('select-net');
  }

  clearSelection(): void {
    if (this.selection.length === 0 && this.selectedNet === null) return;
    this.selection = [];
    this.selectedNet = null;
    this.onChange('select');
  }

  selectAll(): number {
    this.selection = this.circuit.allComponents().map((c) => c.ref);
    this.onChange('select');
    return this.selection.length;
  }

  get selected(): SelectionInfo {
    const components = this.selection.map((r) => this.byRef(r)).filter((c): c is ComponentInstance => c !== undefined);
    return { refs: [...this.selection], components, ports: this.circuit.allPorts() };
  }

  // ---- checks -------------------------------------------------------------

  /** Electrical rules check for the sheet being edited. */
  erc(): Diagnostic[] {
    return this.circuit.erc(this.lib, this.chips);
  }

  /** The reference designs, loaded into this project so they can be opened and edited. */
  loadReferenceProject(): number {
    const ref = buildReferenceProject(this.project.name);
    let added = 0;
    for (const chip of ref.chips.all()) {
      if (!this.chips.has(chip.def.id)) {
        this.chips.add(chip);
        added++;
      }
    }
    this.log(`the reference library now has ${this.chips.size()} chip definition(s) (${added} added)`, 'info');
    this.markChanged('reference');
    return added;
  }

  /** A short description for the status bar. */
  describe(): string {
    const c = this.circuit;
    const bits = c.allComponents().reduce((a, x) => a + Math.max(1, x.bits), 0);
    return `${this.path.join(' › ')} — ${c.componentCount()} component(s), ${bits} physical, ${c.netCount()} net(s), ${c.allPorts().length} port(s)${this.isDirty ? ' • unsaved' : ''}`;
  }

  /** Everything a test or an inspector needs about the current state, in one place. */
  snapshot(): {
    path: string[];
    name: string;
    components: number;
    nets: number;
    ports: number;
    selection: string[];
    selectedNet: string | null;
    undoDepth: number;
    redoDepth: number;
    dirty: boolean;
    chipId: string | null;
  } {
    return {
      path: this.path,
      name: this.circuit.name,
      components: this.circuit.componentCount(),
      nets: this.circuit.netCount(),
      ports: this.circuit.allPorts().length,
      selection: [...this.selection],
      selectedNet: this.selectedNet,
      undoDepth: this.layer.undo.length,
      redoDepth: this.layer.redo.length,
      dirty: this.isDirty,
      chipId: this.layer.chipId ?? null,
    };
  }
}

function projectToDocumentOf(project: Project): Record<string, unknown> {
  // Imported lazily through the project module to keep the io import list short; the
  // function is exported by the engine barrel and used by the CLI in the same way.
  const mod = project as unknown as { toDocument?: () => Record<string, unknown> };
  if (typeof mod.toDocument === 'function') return mod.toDocument();
  return { name: project.name, chips: project.chips.all().map((c) => chipSummary(c)) };
}

function chipSummary(chip: Chip): Record<string, unknown> {
  const def = chip.def;
  return {
    id: def.id,
    name: def.name,
    version: def.version,
    description: def.description,
    ports: def.ports,
    params: def.params,
    components: chip.stats().components,
  };
}
