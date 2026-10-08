/**
 * Circuit builder — a compact, readable way to construct circuits in code.
 *
 * Used by the examples, the synthesis generators, the pattern-replacement code
 * and (through a thin adapter) by the UI when it applies an edit. Nets are named
 * by the caller; connecting two pins to the same name joins them, which is how
 * schematics are described in text.
 */

import { Circuit, type ComponentInstance, type Net, type Point } from './circuit.js';
import type { ChipLibrary } from './chip.js';
import type { ComponentSpec, Library, ParamBag } from './library.js';
import { specDefaults } from './registry.js';
import { error, type Diagnostic } from './labels.js';

export interface PinRef {
  component: ComponentInstance;
  pin: string;
}

export class CircuitBuilder {
  readonly circuit: Circuit;
  private netsByName = new Map<string, Net>();
  private pinToNet = new Map<ComponentInstance, Map<string, string>>();
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private lib: Library,
    name = 'untitled',
    /**
     * Optional chip library, needed to run the ERC on hierarchical circuits: a
     * chip instance's pins are the ports of its implementation for its own
     * parameters, which the static component spec does not know.
     */
    private chips?: ChipLibrary,
  ) {
    this.circuit = new Circuit(name);
  }

  /** The static spec of a component type, with the pins of the default build. */
  spec(specId: string): ComponentSpec | undefined {
    return this.lib.get(specId);
  }

  /** Add a component instance. */
  add(specId: string, params: ParamBag = {}, position: Point | [number, number] = { x: 0, y: 0 }, options: { ref?: string; bits?: number; rotation?: 0 | 90 | 180 | 270; chipRef?: string } = {}): ComponentInstance {
    const spec = this.lib.get(specId);
    if (!spec) throw new Error(`unknown component type "${specId}"`);
    // Preset first, then the caller's explicit parameters: a value the caller
    // passed must never be overwritten by a variant preset (that silently
    // ignored e.g. an explicit rd = 0 on a transistor).
    const merged = { ...specDefaults(spec), ...params };
    const pos: Point = Array.isArray(position) ? { x: position[0], y: position[1] } : position;
    const inst = this.circuit.addComponent(spec, merged, pos, {
      ref: options.ref,
      bits: options.bits,
      rotation: options.rotation,
      chipRef: options.chipRef,
    });
    this.pinToNet.set(inst, new Map());
    return inst;
  }

  /** Get or create a named net. */
  net(name: string, width = 1): Net {
    let net = this.netsByName.get(name);
    if (!net) {
      net = this.circuit.createNet(name, width);
      this.netsByName.set(name, net);
    } else if (width > net.width) {
      net.width = width;
    }
    return net;
  }

  /** Connect one pin of a component to a named net. */
  at(inst: ComponentInstance, pin: string, netName: string, width = 1): this {
    const net = this.net(netName, width);
    // `Circuit.connect` detaches the pin from wherever it was and prunes the nets
    // left empty — two scans of every net on the sheet, per pin. A builder knows
    // both answers already: it tracks what it wired, and it prunes once in
    // `finish()`. Going through `attach` keeps construction linear in the number
    // of pins, which is what lets a sheet of a hundred thousand components be
    // built at all.
    let m = this.pinToNet.get(inst);
    if (!m) {
      m = new Map();
      this.pinToNet.set(inst, m);
    }
    const previous = m.get(pin);
    if (previous !== undefined && previous !== netName) {
      const old = this.netsByName.get(previous);
      if (old) this.circuit.detach(inst.id, pin, old.id);
    }
    this.circuit.attach(inst.id, pin, net.id);
    m.set(pin, netName);
    return this;
  }

  /** Connect several pins at once: `wires([a,'A','n1'], [b,'B','n2'])`. */
  wires(...connections: Array<[ComponentInstance, string, string]>): this {
    for (const [inst, pin, netName] of connections) this.at(inst, pin, netName);
    return this;
  }

  /**
   * Add a ground symbol bound to `netName` — the usual way to reference node 0.
   * A ground symbol that is not connected to the net it names is a classic and
   * silent mistake, so this helper wires it in one step.
   */
  /**
   * Add the ground-reference component and connect its single pin (`0`) to
   * `netName`. Returns the *instance*: returning the builder would make
   * `b.at(b.ground(), 'GND', ...)` compile while connecting nothing.
   */
  ground(netName = 'gnd', position: Point | [number, number] = { x: 0, y: 0 }): ComponentInstance {
    const inst = this.add('ground', {}, position);
    this.at(inst, '0', netName);
    return inst;
  }

  /** Declare a circuit-level port (binds to a named net). */
  port(name: string, direction: 'input' | 'output' | 'bidirectional', netName: string, width = 1, electrical: 'analog' | 'digital' | 'supply' | 'ground' | 'any' = 'digital'): void {
    const net = this.net(netName, width);
    const p = this.circuit.addPort(name, direction, width, net.id, electrical);
    p.description = '';
  }

  /**
   * Add a chip instance (spec is generated by the registry from the chip).
   *
   * `bits = N` instantiates N copies of the implementation bound lane by lane,
   * so a 1-bit adder chip with `bits: 8` really is an 8-bit adder made of eight
   * one-bit adders — not eight parallel copies of the same thing.
   */
  addChip(
    spec: ComponentSpec,
    params: ParamBag,
    position: Point,
    ref?: string,
    options: { bits?: number } = {},
  ): ComponentInstance {
    const inst = this.circuit.addComponent(spec, params, position, { ref, chipRef: spec.id, bits: options.bits ?? 1 });
    this.pinToNet.set(inst, new Map());
    return inst;
  }

  /** Final verification: the circuit must be buildable, so run the ERC. */
  finish(options: { erc?: boolean } = {}): Circuit {
    if (options.erc !== false) {
      const diags = this.circuit.erc(this.lib, this.chips);
      for (const d of diags) {
        if (d.severity === 'error') this.diagnostics.push(d);
      }
    }
    this.circuit.pruneEmptyNets();
    return this.circuit;
  }

  /** Convenience: net by name (must already exist). */
  getNet(name: string): Net | undefined {
    return this.netsByName.get(name);
  }
}

/**
 * Wire a chain of nets to a list of pins of one component, e.g. for a bus:
 * `connectBus(b, gate, 'IN1', 'data', 8)` is not supported (pins are scalar) —
 * vector instances are the supported path.
 */
export function noop(): void {
  /* placeholder for future helpers */
}

export { error };
