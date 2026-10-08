/**
 * Circuit — the central authoring data structure.
 *
 * A circuit owns components, nets and I/O ports. It is a *value*: deterministic
 * ids, canonical ordering, stable fingerprint. Two circuits with the same
 * structure hash identically, which is what the search cache, the deduplication
 * of candidates and the export manifests rely on.
 *
 * Multi-bit signals
 * -----------------
 * A net has a `width`. Width 1 is a normal wire; width N > 1 is a bus that the
 * flattener expands into N scalar nodes (`NET_12[0]` …). A component instance has
 * a `bits` multiplier: a gate with bits = 8 is eight physical gates sharing the
 * same parameters, wired to the 8 lanes of each bus. This is the same convention
 * HDLs use (`wire [7:0] a;`), and it is what makes an 8-bit adder cheap to draw
 * while keeping every lane a real, individually simulatable net.
 *
 * Connection rule: the effective width of a pin (pin.width × instance.bits) must
 * equal the width of the net it is attached to. Violations are reported as ERC
 * diagnostics, never silently fixed.
 */

import type { ComponentSpec, Library, ParamBag, ParamSpec, SymbolShape } from './library.js';
import { resolveParams, validateParams } from './library.js';
import { Accuracy, Diagnostic, Severity, error, info, warn } from './labels.js';
import { StructuralHash } from '../util/hash.js';


export type ComponentId = number;
export type NetId = number;
export type PortId = number;

export interface Point {
  x: number;
  y: number;
}

export interface ComponentInstance {
  id: ComponentId;
  /** Component type id into the library. */
  specId: string;
  /** Reference designator, e.g. 'R12'. Stable across edits. */
  ref: string;
  /** Sheet position (schematic millimetres). */
  x: number;
  y: number;
  /** Rotation in degrees: 0, 90, 180 or 270 (counter-clockwise). */
  rotation: 0 | 90 | 180 | 270;
  /** Mirror horizontally (applied before rotation). */
  mirrorX?: boolean;
  /** Mirror vertically. */
  mirrorY?: boolean;
  /** Parameter values (base SI units unless the unit is a label). */
  params: ParamBag;
  /** Vector width multiplier: this instance is `bits` physical copies. */
  bits: number;
  /** Bit order when expanding a vector: 0 = LSB first, or the given bit indices. */
  bitOrder?: 'lsb' | 'msb';
  /** Free-form label shown on the sheet (overrides the ref when set). */
  label?: string;
  /** User has pinned the position (drag-lock). */
  locked?: boolean;
  /** Names of parameters explicitly edited by the user (block preset overwrite). */
  touched?: string[];
  /** For chip instances: library key of the chip. */
  chipRef?: string;
  /** Arbitrary user metadata (kept in the project file). */
  meta?: Record<string, string | number | boolean>;
}

/**
 * The part of a chip library the ERC needs.
 *
 * A parametric chip's interface is a function of its parameters, so the static
 * component spec of a chip instance (built from the default parameter set) cannot
 * answer what pins it has, nor whether it is digital, without the chip itself.
 * Declared structurally so circuit.ts stays free of a runtime dependency on
 * chip.ts (which imports this module).
 */
export interface ChipLookup {
  get(idOrKey: string): ChipLookupEntry | undefined;
}

export interface ChipLookupEntry {
  readonly params: readonly ParamSpec[];
  implementation(params: ParamBag): Circuit;
  implementationPins(params: ParamBag): Array<{ name: string; direction: 'input' | 'output' | 'bidirectional'; width: number }>;
}

export interface PortRef {
  component: ComponentId;
  pin: string;
}

export interface Net {
  id: NetId;
  /** User-visible name; auto-generated as NET_<id> when not set. */
  name: string;
  width: number;
  ports: PortRef[];
  /** Net class used by the router and the ERC (e.g. 'power', 'clock'). */
  netClass?: string;
  /** True when the net is intentionally left without a driver (e.g. an input). */
  drivenByPort?: boolean;
}

export interface CircuitPort {
  id: PortId;
  name: string;
  direction: 'input' | 'output' | 'bidirectional';
  width: number;
  /** Net this port is attached to (must have the same width). */
  net: NetId;
  electrical?: 'analog' | 'digital' | 'supply' | 'ground' | 'any';
  description?: string;
}

export interface CircuitMeta {
  author?: string;
  created?: string;
  modified?: string;
  tags?: string[];
  notes?: string;
  /** Position of the block in its parent (set when a chip is instantiated). */
  origin?: Point;
}

/** Result of an edit operation: whether it succeeded and why. */
export interface EditResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  id?: number;
}

let refCounters = new Map<string, number>();

export class Circuit {
  name: string;
  description = '';
  meta: CircuitMeta = {};
  /** Hierarchical parent (set when this circuit is the implementation of a chip). */
  parentChip?: string;

  private components = new Map<ComponentId, ComponentInstance>();
  private nets = new Map<NetId, Net>();
  private ports = new Map<PortId, CircuitPort>();

  private nextComponentId = 1;
  private nextNetId = 1;
  private nextPortId = 1;

  /**
   * Reference designators currently in use, and how far each prefix has been
   * handed out.
   *
   * `nextRef` used to rebuild a set of every ref on the sheet for each component
   * added, which made construction quadratic: a 10 000-gate sheet spent 22.6 s in
   * the builder against 119 ms in the flattener. The set is now maintained as
   * components come and go, and the cursor makes the common case — the next ref
   * of a prefix nobody reused — a single lookup.
   */
  private refsInUse = new Set<string>();
  private refCursor = new Map<string, number>();

  /** Invalidation counter, bumped on every structural change (used for caches). */
  revision = 0;

  constructor(name = 'untitled') {
    this.name = name;
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  addComponent(
    spec: ComponentSpec,
    params: ParamBag,
    position: Point = { x: 0, y: 0 },
    options: { ref?: string; bits?: number; rotation?: ComponentInstance['rotation']; chipRef?: string } = {},
  ): ComponentInstance {
    const id = this.nextComponentId++;
    const inst: ComponentInstance = {
      id,
      specId: spec.id,
      ref: options.ref ?? this.nextRef(spec.refPrefix),
      x: position.x,
      y: position.y,
      rotation: options.rotation ?? 0,
      params: { ...params },
      bits: options.bits ?? 1,
      chipRef: options.chipRef,
    };
    this.components.set(id, inst);
    this.refsInUse.add(inst.ref);
    this.revision++;
    return inst;
  }

  /** Add an existing instance (used by paste and by the deserializer). */
  insertComponent(inst: ComponentInstance): void {
    this.components.set(inst.id, inst);
    this.refsInUse.add(inst.ref);
    this.nextComponentId = Math.max(this.nextComponentId, inst.id + 1);
    this.revision++;
  }

  getComponent(id: ComponentId): ComponentInstance | undefined {
    return this.components.get(id);
  }

  componentCount(): number {
    return this.components.size;
  }

  allComponents(): ComponentInstance[] {
    return [...this.components.values()].sort((a, b) => a.id - b.id);
  }

  /** Iterate without allocating (hot paths). */
  forEachComponent(fn: (c: ComponentInstance) => void): void {
    for (const c of this.components.values()) fn(c);
  }

  removeComponent(id: ComponentId): void {
    const gone = this.components.get(id);
    if (!gone || !this.components.delete(id)) return;
    this.refsInUse.delete(gone.ref);
    for (const net of this.nets.values()) {
      net.ports = net.ports.filter((p) => p.component !== id);
    }
    this.pruneEmptyNets();
    this.revision++;
  }

  /** Remove several components atomically (single revision bump). */
  removeComponents(ids: Iterable<ComponentId>): void {
    const set = new Set(ids);
    for (const id of set) {
      const gone = this.components.get(id);
      if (gone) this.refsInUse.delete(gone.ref);
      this.components.delete(id);
    }
    for (const net of this.nets.values()) net.ports = net.ports.filter((p) => !set.has(p.component));
    this.pruneEmptyNets();
    this.revision++;
  }

  moveComponent(id: ComponentId, x: number, y: number): void {
    const c = this.components.get(id);
    if (!c) return;
    c.x = x;
    c.y = y;
    this.revision++;
  }

  rotateComponent(id: ComponentId, delta = 90): void {
    const c = this.components.get(id);
    if (!c) return;
    const next = (((c.rotation + delta) % 360) + 360) % 360;
    c.rotation = next as ComponentInstance['rotation'];
    this.revision++;
  }

  setParam(id: ComponentId, name: string, value: number | string | boolean): void {
    const c = this.components.get(id);
    if (!c) return;
    c.params[name] = value;
    const t = new Set(c.touched ?? []);
    t.add(name);
    c.touched = [...t];
    this.revision++;
  }

  setBits(id: ComponentId, bits: number): void {
    const c = this.components.get(id);
    if (!c) return;
    c.bits = Math.max(1, Math.min(1024, Math.floor(bits)));
    this.revision++;
  }

  setRef(id: ComponentId, ref: string): void {
    const c = this.components.get(id);
    if (!c) return;
    this.refsInUse.delete(c.ref);
    c.ref = ref;
    this.refsInUse.add(ref);
    this.revision++;
  }

  // -------------------------------------------------------------------------
  // Nets
  // -------------------------------------------------------------------------

  createNet(name = '', width = 1): Net {
    const id = this.nextNetId++;
    const net: Net = { id, name: name || `NET_${id}`, width, ports: [] };
    this.nets.set(id, net);
    this.revision++;
    return net;
  }

  insertNet(net: Net): void {
    this.nets.set(net.id, net);
    this.nextNetId = Math.max(this.nextNetId, net.id + 1);
    this.revision++;
  }

  getNet(id: NetId): Net | undefined {
    return this.nets.get(id);
  }

  netCount(): number {
    return this.nets.size;
  }

  allNets(): Net[] {
    return [...this.nets.values()].sort((a, b) => a.id - b.id);
  }

  forEachNet(fn: (n: Net) => void): void {
    for (const n of this.nets.values()) fn(n);
  }

  /** Find the net a component pin currently belongs to. */
  netOf(component: ComponentId, pin: string): Net | undefined {
    for (const net of this.nets.values()) {
      for (const p of net.ports) if (p.component === component && p.pin === pin) return net;
    }
    return undefined;
  }

  /**
   * Connect a pin to a net. The pin is first disconnected from any other net, so
   * there is never a pin in two nets (the invariant the netlister relies on).
   */
  connect(component: ComponentId, pin: string, netId: NetId): EditResult {
    this.disconnect(component, pin, { keepEmpty: true });
    const result = this.attach(component, pin, netId);
    this.pruneEmptyNets();
    return result;
  }

  /**
   * Attach a pin to a net without detaching it from anywhere else and without
   * pruning empty nets.
   *
   * This is the primitive the deserializer and the paste path use: they restore a
   * known-good graph as one atomic pass, so per-pin garbage collection (which
   * would delete nets that are still waiting for their connections) must not run
   * in the middle of it. Attaching the same pin twice to the same net is a no-op.
   */
  attach(component: ComponentId, pin: string, netId: NetId): EditResult {
    const inst = this.components.get(component);
    if (!inst) return { ok: false, diagnostics: [error('CF2001', `component ${component} does not exist`)] };
    const net = this.nets.get(netId);
    if (!net) return { ok: false, diagnostics: [error('CF2002', `net ${netId} does not exist`)] };
    if (!net.ports.some((p) => p.component === component && p.pin === pin)) net.ports.push({ component, pin });
    this.revision++;
    return { ok: true, diagnostics: [], id: netId };
  }

  /**
   * Remove one pin from one named net, without looking at any other net.
   *
   * `disconnect` has to scan every net to find where a pin is, which is the right
   * behaviour for an editor that does not know and the wrong one for a builder
   * that does: constructing a sheet pin by pin through `disconnect` is quadratic
   * in the number of nets.
   */
  detach(component: ComponentId, pin: string, netId: NetId): boolean {
    const net = this.nets.get(netId);
    if (!net) return false;
    const before = net.ports.length;
    net.ports = net.ports.filter((p) => !(p.component === component && p.pin === pin));
    if (net.ports.length !== before) {
      this.revision++;
      return true;
    }
    return false;
  }

  /** Disconnect one pin (or all pins of a component when `pin` is omitted). */
  disconnect(component: ComponentId, pin?: string, opts: { keepEmpty?: boolean } = {}): void {
    for (const net of this.nets.values()) {
      const before = net.ports.length;
      net.ports = net.ports.filter((p) => !(p.component === component && (pin === undefined || p.pin === pin)));
      if (before !== net.ports.length && !opts.keepEmpty && net.ports.length === 0) {
        // Left empty on purpose: the net id stays valid until pruneEmptyNets().
      }
    }
    if (!opts.keepEmpty) this.pruneEmptyNets();
    this.revision++;
  }

  /** Merge two nets (they become one). Used by the editor when dropping a wire. */
  mergeNets(a: NetId, b: NetId): NetId {
    if (a === b) return a;
    const na = this.nets.get(a);
    const nb = this.nets.get(b);
    if (!na || !nb) throw new Error('mergeNets: unknown net');
    if (na.width !== nb.width) throw new Error(`cannot merge nets of different widths (${na.width} vs ${nb.width})`);
    for (const p of nb.ports) if (!na.ports.some((q) => q.component === p.component && q.pin === p.pin)) na.ports.push(p);
    this.nets.delete(b);
    for (const port of this.ports.values()) if (port.net === b) port.net = a;
    this.revision++;
    return a;
  }

  /** Automatic removal of nets that lost every connection (and of ports on them). */
  pruneEmptyNets(): number {
    // The set of nets a circuit port keeps alive is built once: testing each
    // empty net against every port made this quadratic in the number of ports.
    const keptByPort = new Set<NetId>();
    for (const p of this.ports.values()) keptByPort.add(p.net);
    let removed = 0;
    for (const [id, net] of [...this.nets]) {
      if (net.ports.length === 0 && !keptByPort.has(id)) {
        this.nets.delete(id);
        removed++;
      }
    }
    if (removed) this.revision++;
    return removed;
  }

  renameNet(id: NetId, name: string): EditResult {
    const net = this.nets.get(id);
    if (!net) return { ok: false, diagnostics: [error('CF2002', `net ${id} does not exist`)] };
    const trimmed = name.trim();
    if (trimmed === '') {
      net.name = `NET_${id}`;
      this.revision++;
      return { ok: true, diagnostics: [] };
    }
    const clash = [...this.nets.values()].find((n) => n !== net && n.name === trimmed);
    if (clash) {
      return {
        ok: false,
        diagnostics: [error('CF2003', `net name "${trimmed}" is already used by net ${clash.id}`, { target: { type: 'net', id: clash.id, name: clash.name } })],
      };
    }
    net.name = trimmed;
    this.revision++;
    return { ok: true, diagnostics: [] };
  }

  // -------------------------------------------------------------------------
  // Ports
  // -------------------------------------------------------------------------

  addPort(name: string, direction: CircuitPort['direction'], width = 1, netId?: NetId, electrical: CircuitPort['electrical'] = 'digital'): CircuitPort {
    const id = this.nextPortId++;
    let net = netId !== undefined ? this.nets.get(netId) : undefined;
    if (!net) net = this.createNet(name, width);
    const port: CircuitPort = { id, name, direction, width, net: net.id, electrical };
    this.ports.set(id, port);
    net.width = width === net.width ? net.width : Math.max(width, net.width);
    this.revision++;
    return port;
  }

  insertPort(port: CircuitPort): void {
    this.ports.set(port.id, port);
    this.nextPortId = Math.max(this.nextPortId, port.id + 1);
    this.revision++;
  }

  getPort(id: PortId): CircuitPort | undefined {
    return this.ports.get(id);
  }

  allPorts(): CircuitPort[] {
    return [...this.ports.values()].sort((a, b) => a.id - b.id);
  }

  removePort(id: PortId): void {
    this.ports.delete(id);
    this.revision++;
  }

  // -------------------------------------------------------------------------
  // Reference designators
  // -------------------------------------------------------------------------

  /** Next free designator for a prefix, e.g. R1, R2… */
  nextRef(prefix: string): string {
    let n = this.refCursor.get(prefix) ?? 1;
    while (this.refsInUse.has(`${prefix}${n}`)) n++;
    // The cursor parks just past the ref handed out, so a sheet built component by
    // component never rescans the refs it already passed. Refs inserted explicitly
    // below the cursor are still skipped, because `refsInUse` is the authority.
    this.refCursor.set(prefix, n + 1);
    this.refsInUse.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  }

  // -------------------------------------------------------------------------
  // Queries used by the netlister
  // -------------------------------------------------------------------------

  /** Effective width of a pin of an instance (pin width × instance bits). */
  effectivePinWidth(inst: ComponentInstance, pinWidth: number): number {
    return Math.max(1, pinWidth) * Math.max(1, inst.bits);
  }

  /** All pins of an instance with their resolved world coordinates. */
  pinPositions(lib: Library, inst: ComponentInstance): Array<{ name: string; x: number; y: number }> {
    const spec = lib.get(inst.specId);
    if (!spec) return [];
    const rad = (inst.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return spec.pins.map((p) => {
      const mx = (inst.mirrorX ? -p.x : p.x) * (inst.mirrorY ? -1 : 1);
      const my = inst.mirrorY ? -p.y : p.y;
      return {
        name: p.name,
        x: inst.x + mx * cos - my * sin,
        y: inst.y + mx * sin + my * cos,
      };
    });
  }

  /**
   * True when every component of this circuit is purely digital.
   *
   * Chip instances are resolved recursively through their implementation for
   * their own parameters, so "digital" is a statement about the hardware, not
   * about the label on a box. A component the library does not know makes the
   * answer conservative (`false`): an unknown part is never assumed harmless.
   */
  isDigital(lib: Library, chips?: ChipLookup, seen: Set<string> = new Set()): boolean {
    for (const inst of this.components.values()) {
      const spec = lib.get(inst.specId);
      // A chip instance whose id names no primitive is still digital when its
      // implementation is: that is the normal shape of a hierarchy (a ripple adder's
      // children are `full_adder` chips, not library primitives). Answering false
      // here made the ERC report "no ground reference" as a *warning* on a purely
      // logic circuit — where the absence of a ground is a fact about level 0, not a
      // defect — and that warning then failed the whole validation.
      const chipRef = inst.chipRef ?? (typeof inst.params['__chip'] === 'string' ? (inst.params['__chip'] as string) : spec?.id ?? inst.specId);
      if (spec && spec.category === 'digital') continue;
      if (spec && spec.category !== 'chip' && !inst.chipRef) return false;
      if (!chips) return false;
      if (seen.has(chipRef)) return false;
      const chip = chips.get(chipRef);
      if (!chip) return false;
      let impl: Circuit;
      try {
        impl = chip.implementation(resolveParams(chip.params, inst.params));
      } catch {
        // An implementation that cannot be generated for these parameters is not
        // something this predicate can decide; `erc` and `flatten` report it.
        return false;
      }
      const next = new Set(seen);
      next.add(chipRef);
      if (!impl.isDigital(lib, chips, next)) return false;
    }
    return true;
  }

  /**
   * Electrical rules check. This is deliberately conservative: it reports what it
   * can prove from the graph alone (unconnected pins, driver conflicts, width
   * mismatches, missing ground, floating nets…) and never guesses.
   */
  erc(lib: Library, chips?: ChipLookup): Diagnostic[] {
    const out: Diagnostic[] = [];
    const hasGround = [...this.components.values()].some((c) => c.specId === 'ground');
    if (!hasGround && this.components.size > 1) {
      // A purely digital circuit has no analog reference to speak of: the logic
      // level simulator works on 0/1/X/Z and never solves a matrix, so the missing
      // ground is a fact about the circuit, not a defect. Say it, at the right
      // severity, instead of warning about something that cannot break.
      const digitalOnly = this.isDigital(lib, chips);
      out.push(
        digitalOnly
          ? info('CF3001', 'digital-only circuit: there is no ground reference, which is normal for level-0 logic (an electrical analysis of it would float)')
          : warn('CF3001', 'circuit has no ground reference; the electrical simulator will auto-insert one at node 0'),
      );
    }

    for (const inst of this.components.values()) {
      const spec = lib.get(inst.specId);
      if (!spec) {
        // A chip instance is known to the project's chip library even when no
        // primitive spec of that name exists — the normal case for a chip built by
        // synthesis, and for the children of `chip.implementation()`, which name
        // other chips. `flatten` resolves them the same way, library first so a
        // primitive shadowing a chip id keeps its primitive meaning. An ERC that
        // could not would report a valid hierarchy as N unknown types and block the
        // validation of every hierarchical design, which is what it did.
        const chipRef = inst.chipRef ?? (typeof inst.params['__chip'] === 'string' ? (inst.params['__chip'] as string) : inst.specId);
        const chip = chips?.get(chipRef);
        if (!chip) {
          out.push(error('CF3002', `component ${inst.ref} references unknown type "${inst.specId}"`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
          continue;
        }
        const chipPins = chipPinsOf(chips, inst, chipRef);
        if (!chipPins) {
          // The chip exists but its interface could not be generated for these
          // parameters. Same meaning as at flatten time, so the same code.
          out.push(error('CF5005', `failed to generate the interface of ${inst.ref} (${chipRef}) for ${JSON.stringify(inst.params)}`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
          continue;
        }
        for (const pin of chipPins) {
          const net = this.netOf(inst.id, pin.name);
          if (!net) {
            out.push(warn('CF3004', `${inst.ref}.${pin.name} is not connected`, { target: { type: 'component', id: inst.id, name: inst.ref }, hint: `chip port, ${pin.direction}${pin.width > 1 ? `, width ${pin.width}` : ''}` }));
            continue;
          }
          const want = this.effectivePinWidth(inst, pin.width ?? 1);
          if (net.width !== want) {
            out.push(
              error('CF3005', `${inst.ref}.${pin.name} has width ${want} but net ${net.name} has width ${net.width}`, {
                target: { type: 'net', id: net.id, name: net.name },
                hint: 'Adjust the component bits or split/merge the bus explicitly.',
              }),
            );
          }
        }
        continue;
      }
      const issues = validateParams(spec, inst.params);
      for (const issue of issues) {
        out.push(error('CF3003', `${inst.ref}.${issue.param}: ${issue.message}`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
      }
      // For a chip instance the pin list is the implementation's port list for
      // this instance's parameters; the static spec only knows the default build.
      const implPins = chipPinsOf(chips, inst, spec.id);
      // For a chip instance the *implementation* defines the interface: a counter
      // instantiated with bits = 4 has four Q pins, and the four Q pins of the
      // default 8-bit build are not "unconnected" — they do not exist here.
      const pinsToCheck: Array<{ name: string; width?: number; optional?: boolean; description?: string }> = implPins
        ? implPins.map((p) => ({ name: p.name, width: p.width }))
        : [...spec.pins];
      for (const pin of pinsToCheck) {
        const net = this.netOf(inst.id, pin.name);
        if (!net) {
          if (!pin.optional && spec.category !== 'instrument' && spec.id !== 'probe') {
            out.push(warn('CF3004', `${inst.ref}.${pin.name} is not connected`, { target: { type: 'component', id: inst.id, name: inst.ref }, hint: pin.description }));
          }
          continue;
        }
        const want = this.effectivePinWidth(inst, pin.width ?? 1);
        if (net.width !== want) {
          out.push(
            error('CF3005', `${inst.ref}.${pin.name} has width ${want} but net ${net.name} has width ${net.width}`, {
              target: { type: 'net', id: net.id, name: net.name },
              hint: 'Adjust the component bits or split/merge the bus explicitly.',
            }),
          );
        }
      }
      if ((inst.bits ?? 1) > 1 && spec.category !== 'digital') {
        out.push(warn('CF3006', `${inst.ref} is a vector instance (bits = ${inst.bits}) of a non-digital component; this replicates a physical device ${inst.bits} times`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
      }
    }

    // A connection to a pin name that the component does not declare is a
    // dangling wire: it would silently do nothing, so it is an error. The same
    // pass reports inputs that are wired while the component reads fewer of them
    // (a gate with `inputs = 2` but three wires has a wire nobody reads).
    for (const net of this.nets.values()) {
      for (const port of net.ports) {
        const inst = this.components.get(port.component);
        if (!inst) continue;
        const spec = lib.get(inst.specId);
        if (!spec) continue;
        const pin = spec.pins.find((p) => p.name === port.pin);
        if (!pin) {
          // A chip's interface is the port list of the implementation for *this*
          // instance's parameters, which can differ from the default build (a ROM
          // built for 16 words has one address pin more than the default 8-word
          // ROM). Ask the lookup before calling the wire dangling.
          const allowed = chipPinsOf(chips, inst, spec.id);
          if (allowed?.some((p) => p.name === port.pin)) continue;
          out.push(
            error('CF3010', `${inst.ref}.${port.pin} is not a pin of ${spec.name}: the wire is dangling`, {
              target: { type: 'component', id: inst.id, name: inst.ref },
              hint: allowed
                ? `Pins of ${inst.ref} for these parameters: ${allowed.map((p) => p.name).join(', ')}`
                : `Pins of ${spec.name}: ${spec.pins.map((p) => p.name).join(', ')}`,
            }),
          );
          continue;
        }
        const usedParam = spec.params.find((p) => p.name === 'inputs');
        const match = /^IN(\d+)$/.exec(pin.name);
        if (usedParam && match) {
          const used = Number(inst.params['inputs'] ?? usedParam.default);
          if (Number.isFinite(used) && Number(match[1]) > used) {
            out.push(
              warn('CF3011', `${inst.ref}.${pin.name} is wired but ${inst.ref} reads only ${used} input(s)`, {
                target: { type: 'component', id: inst.id, name: inst.ref },
                hint: `Raise the "inputs" parameter of ${inst.ref} to at least ${match[1]} for the wire to be used.`,
              }),
            );
          }
        }
      }
    }

    for (const net of this.nets.values()) {
      // Driver conflict: two outputs of different kinds driving the same net.
      const drivers = net.ports
        .map((p) => ({ p, spec: lib.get(this.components.get(p.component)?.specId ?? '') }))
        .filter((x) => x.spec && isDriverPin(x.spec, x.p));
      const strong = drivers.filter((d) => !isOpenDrain(d.spec!));
      if (strong.length > 1) {
        out.push(
          error('CF3007', `net ${net.name} is driven by ${strong.length} outputs (${strong.map((d) => `${this.components.get(d.p.component)?.ref}.${d.p.pin}`).join(', ')})`, {
            target: { type: 'net', id: net.id, name: net.name },
          }),
        );
      }
      const hasDriver = drivers.length > 0 || (this.allPorts().some((p) => p.net === net.id && p.direction !== 'output'));
      if (!hasDriver && net.ports.length > 0) {
        out.push(info('CF3008', `net ${net.name} is floating (no driver)`, { target: { type: 'net', id: net.id, name: net.name } }));
      }
    }

    for (const port of this.ports.values()) {
      if (!this.nets.has(port.net)) {
        out.push(error('CF3009', `port ${port.name} references a missing net ${port.net}`, { target: { type: 'port', id: port.id, name: port.name } }));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Branding / identity
  // -------------------------------------------------------------------------

  /** Structural fingerprint. Order-independent, value-quantised to 1e-6. */
  fingerprint(lib?: Library): string {
    const h = new StructuralHash();
    h.string(this.name);
    h.int32(this.components.size);
    for (const c of this.allComponents()) {
      h.string(c.specId).int32(c.bits).int32(Math.round(c.rotation));
      h.bool(!!c.mirrorX).bool(!!c.mirrorY);
      h.string(c.chipRef ?? '');
      const keys = Object.keys(c.params).sort();
      for (const k of keys) {
        h.string(k);
        const v = c.params[k];
        if (typeof v === 'number') h.floatQuantised(v, 1e6);
        else if (typeof v === 'boolean') h.bool(v);
        else h.string(String(v));
      }
      // Position is included at 0.1 mm resolution: layouts matter for wire
      // length / parasitics, so two circuits that differ geometrically are not
      // considered identical.
      h.floatQuantised(c.x, 10).floatQuantised(c.y, 10);
    }
    // Nets, canonicalised by the sorted list of (component ref, pin) they carry,
    // so that id renaming does not change the fingerprint.
    const netKeys: string[] = [];
    for (const net of this.nets.values()) {
      const members = net.ports
        .map((p) => `${this.components.get(p.component)?.ref ?? '?'}.${p.pin}`)
        .sort()
        .join(',');
      netKeys.push(`${net.width}:${members}`);
    }
    netKeys.sort();
    for (const k of netKeys) h.string(k);
    const portKeys = this.allPorts()
      .map((p) => `${p.name}:${p.direction}:${p.width}:${this.nets.get(p.net)?.ports.map((q) => `${this.components.get(q.component)?.ref ?? '?'}.${q.pin}`).sort().join(',') ?? ''}`)
      .sort();
    for (const k of portKeys) h.string(k);
    void lib;
    return h.hex();
  }

  /** Deep copy (structural clone; ids are preserved so it can be diffed). */
  clone(): Circuit {
    const c = new Circuit(this.name);
    c.description = this.description;
    c.meta = JSON.parse(JSON.stringify(this.meta));
    c.parentChip = this.parentChip;
    for (const inst of this.components.values()) {
      c.components.set(inst.id, JSON.parse(JSON.stringify(inst)) as ComponentInstance);
    }
    for (const net of this.nets.values()) {
      c.nets.set(net.id, JSON.parse(JSON.stringify(net)) as Net);
    }
    for (const port of this.ports.values()) {
      c.ports.set(port.id, JSON.parse(JSON.stringify(port)) as CircuitPort);
    }
    c.nextComponentId = this.nextComponentId;
    c.nextNetId = this.nextNetId;
    c.nextPortId = this.nextPortId;
    return c;
  }

  /**
   * Copy of this circuit with fresh ids, ready to be inserted into another circuit
   * (or into itself). Returns the copy plus a mapping old→new id.
   */
  cloneWithNewIds(): { circuit: Circuit; componentMap: Map<ComponentId, ComponentId>; netMap: Map<NetId, NetId> } {
    const c = new Circuit(this.name);
    const componentMap = new Map<ComponentId, ComponentId>();
    const netMap = new Map<NetId, NetId>();
    for (const inst of this.components.values()) {
      const copy: ComponentInstance = JSON.parse(JSON.stringify(inst));
      copy.id = c.nextComponentId++;
      copy.ref = c.nextRef(inst.ref.replace(/\d+$/, ''));
      componentMap.set(inst.id, copy.id);
      c.components.set(copy.id, copy);
    }
    for (const net of this.nets.values()) {
      const copy: Net = { ...net, ports: net.ports.map((p) => ({ component: componentMap.get(p.component)!, pin: p.pin })) };
      copy.id = c.nextNetId++;
      copy.name = `NET_${copy.id}`;
      netMap.set(net.id, copy.id);
      c.nets.set(copy.id, copy);
    }
    for (const port of this.ports.values()) {
      const copy: CircuitPort = { ...port, id: c.nextPortId++, net: netMap.get(port.net)! };
      c.ports.set(copy.id, copy);
    }
    c.pruneEmptyNets();
    return { circuit: c, componentMap, netMap };
  }

  /** Statistics used by reports and the UI. */
  stats(lib: Library): {
    components: number;
    physicalComponents: number;
    nets: number;
    ports: number;
    byCategory: Record<string, number>;
    bySpec: Record<string, number>;
    hierarchyDepth: number;
    accuracy: Accuracy;
  } {
    const byCategory: Record<string, number> = {};
    const bySpec: Record<string, number> = {};
    let physical = 0;
    let accuracy = Accuracy.REALISTIC;
    for (const inst of this.components.values()) {
      const spec = lib.get(inst.specId);
      const cat = spec?.category ?? 'other';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      bySpec[inst.specId] = (bySpec[inst.specId] ?? 0) + 1;
      physical += Math.max(1, inst.bits);
      if (spec) accuracy = weaker(accuracy, spec.accuracy ?? Accuracy.APPROXIMATED);
    }
    return {
      components: this.components.size,
      physicalComponents: physical,
      nets: this.nets.size,
      ports: this.ports.size,
      byCategory,
      bySpec,
      hierarchyDepth: 1,
      accuracy,
    };
  }
}

function weaker(a: Accuracy, b: Accuracy): Accuracy {
  const rank: Record<Accuracy, number> = {
    [Accuracy.REALISTIC]: 3,
    [Accuracy.APPROXIMATED]: 2,
    [Accuracy.IDEALIZED]: 1,
    [Accuracy.NOT_MODELED]: 0,
  };
  return rank[a] <= rank[b] ? a : b;
}

function isDriverPin(spec: ComponentSpec, ref: PortRef): boolean {
  const pin = spec.pins.find((p) => p.name === ref.pin);
  return !!pin && (pin.direction === 'output' || (pin.direction === 'passive' && spec.category === 'source'));
}

function isOpenDrain(spec: ComponentSpec): boolean {
  return spec.id === 'tristate' || spec.id === 'logic_probe';
}

/** Compute the world position of a pin given an instance and its spec. */
export function pinWorld(inst: ComponentInstance, pin: { x: number; y: number }): Point {
  const rad = (inst.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = inst.mirrorX ? -pin.x : pin.x;
  const my = inst.mirrorY ? -pin.y : pin.y;
  return { x: inst.x + mx * cos - my * sin, y: inst.y + mx * sin + my * cos };
}

/** Symbol shapes for an instance, with rotation/mirror applied (UI + SVG export). */
export function transformedSymbol(shapes: readonly SymbolShape[], inst: ComponentInstance): SymbolShape[] {
  const rad = (inst.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tf = (x: number, y: number): [number, number] => {
    const mx = inst.mirrorX ? -x : x;
    const my = inst.mirrorY ? -y : y;
    return [inst.x + mx * cos - my * sin, inst.y + mx * sin + my * cos];
  };
  const out: SymbolShape[] = [];
  for (const s of shapes) {
    switch (s.k) {
      case 'line': {
        const [x1, y1] = tf(s.x1, s.y1);
        const [x2, y2] = tf(s.x2, s.y2);
        out.push({ ...s, x1, y1, x2, y2 });
        break;
      }
      case 'poly':
      case 'filled': {
        const pts: number[] = [];
        for (let i = 0; i < s.pts.length; i += 2) {
          const [x, y] = tf(s.pts[i], s.pts[i + 1]);
          pts.push(x, y);
        }
        out.push({ ...s, pts });
        break;
      }
      case 'rect': {
        const [x, y] = tf(s.x, s.y);
        const [x2, y2] = tf(s.x + s.w, s.y + s.h);
        out.push({ k: 'rect', x: Math.min(x, x2), y: Math.min(y, y2), w: Math.abs(x2 - x), h: Math.abs(y2 - y), t: s.t, r: s.r, fill: s.fill });
        break;
      }
      case 'circle': {
        const [cx, cy] = tf(s.cx, s.cy);
        out.push({ ...s, cx, cy });
        break;
      }
      case 'arc': {
        const [cx, cy] = tf(s.cx, s.cy);
        const delta = inst.rotation + (inst.mirrorX !== inst.mirrorY ? -2 * inst.rotation : 0);
        void delta;
        out.push({ k: 'arc', cx, cy, r: s.r, a0: s.a0 + inst.rotation, a1: s.a1 + inst.rotation, t: s.t });
        break;
      }
      case 'text': {
        const [x, y] = tf(s.x, s.y);
        out.push({ ...s, x, y, size: s.size });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Reset the module-level ref counters (used by tests for determinism). */
export function resetRefCounters(): void {
  refCounters = new Map<string, number>();
}

export { refCounters, Severity };

/**
 * Every pin name a component instance accepts.
 *
 * Primitives answer from their spec; chip instances from the implementation for
 * their own parameters (a parametric chip's interface follows its parameters).
 * Returns `null` when the component type is unknown to the library — the caller
 * reports that separately, because "unknown type" and "unknown pin" are
 * different problems with different fixes.
 */
export function allowedPinNames(lib: Library, chips: ChipLookup | undefined, inst: ComponentInstance): Set<string> | null {
  const spec = lib.get(inst.specId);
  if (!spec) return null;
  const implPins = chipPinsOf(chips, inst, spec.id);
  return new Set(implPins ? implPins.map((p) => p.name) : spec.pins.map((p) => p.name));
}

/**
 * The pins a chip instance really has.
 *
 * A parametric chip's interface depends on its parameters (a 16-word ROM has one
 * address pin more than the 8-word default), so the answer comes from the
 * implementation for the instance's own parameters, never from the static spec.
 * Returns `null` when the instance is not a resolvable chip, in which case the
 * caller falls back to the declared pins.
 */
function chipPinsOf(
  chips: ChipLookup | undefined,
  inst: ComponentInstance,
  specId: string,
): Array<{ name: string; direction: 'input' | 'output' | 'bidirectional'; width: number }> | null {
  if (!chips) return null;
  const chipRef = inst.chipRef ?? specId;
  const chip = chips.get(chipRef);
  if (!chip) return null;
  try {
    return chip.implementationPins(resolveParams(chip.params, inst.params));
  } catch {
    // A generator that cannot run for these parameters is a CF5005 at flatten
    // time; here the declared pins are the best available answer.
    return null;
  }
}
