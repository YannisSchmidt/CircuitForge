/**
 * Flattened netlist — the execution model.
 *
 * The authoring `Circuit` is a readable object graph; the simulator needs a
 * structure-of-arrays, integer-indexed, allocation-free representation. `flatten`
 * performs that translation, recursively expanding chips and vector instances.
 *
 * Layout
 *   nodes       0 .. nodeCount-1     (node 0 is ground by convention)
 *   elements    0 .. elementCount-1  parallel typed arrays
 *   branches    voltage-defined elements get an extra current unknown
 *   models      deduplicated device parameter sets (physics shared by instances)
 *   thermal     lumped thermal network (junction/case/heatsink nodes)
 *   instances   provenance: which component produced which elements
 *
 * Everything here is deterministic: the same circuit always flattens to the same
 * arrays, which is what makes runs reproducible and caches meaningful.
 */

import type { Circuit, ComponentInstance, Net } from '../core/circuit.js';
import { allowedPinNames } from '../core/circuit.js';
import type { ComponentSpec, Library, ParamBag } from '../core/library.js';
import type { ChipLibrary } from '../core/chip.js';
import { resolvedChipParams } from '../core/chip.js';
import { Accuracy, Diagnostic, Severity, error, info, warn } from '../core/labels.js';
import { GrowF64, GrowI32, GrowU8, StringTable } from './grow.js';
import { layoutOf, NODE_STRIDE, STATE_STRIDE, elementThermalNode } from './paramslots.js';
import { Kind, KIND_NAME } from '../core/kinds.js';
import { MODEL_STRIDE, ModelTable } from './model.js';
import { lowerInstance, type ElementSink, type LowerContext } from './lower.js';
import { profiler } from '../util/profiler.js';
import { SRC_SLOTS, SRC_STRIDE } from './paramslots.js';

export { MODEL_STRIDE } from './model.js';

/** Lane index used to key (net, lane) → node mappings. */
const LANE_STRIDE = 4096;

export interface FlatInstance {
  id: number;
  ref: string;
  specId: string;
  path: string;
  depth: number;
  x: number;
  y: number;
  rotation: number;
  bits: number;
  params: ParamBag;
  chipRef?: string;
  elementStart: number;
  elementCount: number;
  parent: number;
  lane: number;
}

export interface FlatNetlist {
  /** Name of the root circuit this netlist was flattened from. */
  name: string;
  // ---- nodes ------------------------------------------------------------
  nodeCount: number;
  nodeNet: Int32Array;
  nodePath: Int32Array;
  nodeLane: Uint8Array;
  nodeDegree: Int32Array;
  /** Human-readable name of each node (path-qualified net name) — for reports/UI. */
  nodeName: Int32Array;
  nodeNames: string[];
  /**
   * 0 by convention: node 0 is the matrix reference, and every net a ground
   * symbol is attached to is mapped to it. It is *not* a sign that the circuit
   * has a reference of its own — see `hasGroundReference`.
   */
  groundNode: number;
  /**
   * True when a ground symbol ties a net that at least one other pin uses, i.e.
   * the circuit has an explicit 0 V reference. A circuit without one still gets
   * a solvable matrix (the solver's gmin holds it down), so this flag is what
   * the ERC and the analyzer use to say "this design floats" instead of
   * silently pretending the reference exists.
   */
  hasGroundReference: boolean;

  // ---- elements ---------------------------------------------------------
  elementCount: number;
  kind: Uint8Array;
  nodes: Int32Array;
  nodeCountPerElement: Uint8Array;
  paramOffset: Int32Array;
  params: Float64Array;
  stateOffset: Int32Array;
  state: Float64Array;
  branchIndex: Int32Array;
  branchCount: number;
  modelIndex: Int32Array;
  instIndex: Int32Array;
  modelParams: Float64Array;
  modelCount: number;

  // ---- thermal network --------------------------------------------------
  thermalNodeCount: number;
  /** Heat capacity of each thermal node (J/K); 0 = massless. */
  thermalCth: Float64Array;
  /** Thermal resistance of each node to ambient; 0 = none (open). */
  thermalRthAmbient: Float64Array;
  /** Thermal links, pairs of node indices (-1 = ambient). */
  thermalLinks: Int32Array;
  thermalLinkRth: Float64Array;
  /** Present temperature (K) of each thermal node — the level-3 state. */
  thermalTemperature: Float64Array;
  /** Ambient temperature (°C) of this netlist. */
  ambient: number;

  // ---- metadata ---------------------------------------------------------
  instances: FlatInstance[];
  paths: string[];
  specIds: string[];
  ports: Array<{ name: string; direction: string; node: number; width: number }>;
  diagnostics: Diagnostic[];
  fingerprint: string;
  options: Required<Omit<FlattenOptions, 'ambient'>> & { ambient: number };
  flattenMs: number;
  /** Number of transistors synthesised by gate expansion. */
  expandedTransistors: number;
  /**
   * Number of gate instances that were expanded. Zero with a non-zero request means
   * expansion was asked for and nothing qualified — which the netlist says out loud
   * with diagnostic CF6013 rather than leaving the caller to guess.
   */
  expandedGates: number;
  /** Gate instances that kept the default `ideal` style although expansion was asked for. */
  gatesLeftIdeal: number;
  /**
   * Piecewise-linear waveform tables, referenced by `SRC_SLOTS.table`.
   *
   * Each table is interleaved `[t0, v0, t1, v1, …]` with strictly increasing t.
   * They live beside the netlist rather than in the parameter array because a table
   * is variable-length and the parameter array is a fixed-stride SoA: putting one
   * there would either cap the waveform length or waste a stride per element.
   */
  waveTables: Float64Array[];
}

/**
 * Human-readable, path-qualified name of a node.
 *
 * `nodeName` stores `index + 1` into `nodeNames` (0 = the node has no name), so
 * a caller must never index `nodeNames` with the node itself.
 */
export function nodeNameAt(nl: FlatNetlist, node: number): string {
  if (node <= 0) return 'GND';
  const id = nl.nodeName[node];
  return id > 0 ? (nl.nodeNames[id - 1] ?? `node ${node}`) : `node ${node}`;
}

export interface FlattenOptions {
  metadata?: boolean;
  maxDepth?: number;
  expandGates?: boolean;
  ambient?: number;
  thermal?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<FlattenOptions, 'ambient'>> & { ambient: number } = {
  metadata: true,
  maxDepth: 128,
  expandGates: true,
  ambient: 25,
  thermal: true,
};

interface Frame {
  circuit: Circuit;
  path: string;
  pathIdx: number;
  nodes: Map<number, number>;
  /**
   * "componentId:pinName" → netId.
   *
   * Keyed by *name*, not by pin ordinal: a chip instance's pin list depends on
   * its parameters, so the static ordinal table of the component spec cannot be
   * used to address its pins.
   */
  pinNets: Map<string, number>;
}

class Builder implements ElementSink {
  nodeNet = new GrowI32(1 << 12);
  nodePath = new GrowI32(1 << 12);
  nodeLane = new GrowU8(1 << 12);
  nodeDegree = new GrowI32(1 << 12);

  kind = new GrowU8(1 << 12);
  nodes = new GrowI32((1 << 12) * NODE_STRIDE);
  nodeCountPerElement = new GrowU8(1 << 12);
  paramOffset = new GrowI32(1 << 12);
  params = new GrowF64((1 << 14) * 8);
  stateOffset = new GrowI32(1 << 12);
  state = new GrowF64((1 << 12) * STATE_STRIDE);
  branchIndex = new GrowI32(1 << 12);
  modelIndex = new GrowI32(1 << 12);
  instIndex = new GrowI32(1 << 12);

  models = new ModelTable();
  instances: FlatInstance[] = [];
  paths = new StringTable();
  specIds = new StringTable();
  diagnostics: Diagnostic[] = [];
  ports: FlatNetlist['ports'] = [];

  thermalCth = new GrowF64(64);
  thermalRthAmb = new GrowF64(64);
  thermalLinks = new GrowI32(64);
  thermalLinkR = new GrowF64(64);
  thermalNodeCount = 0;
  thermalNetMap = new Map<number, number>();
  /** Set when a ground symbol is attached to a net other pins also use. */
  hasGroundReference = false;

  branchCount = 0;
  nodeCount = 1;
  elementCount = 0;
  expandedTransistors = 0;
  /** Piecewise-linear waveform tables (see `FlatNetlist.waveTables`). */
  waveTables: Float64Array[] = [];
  /** True while a gate is being expanded to its transistor network. */
  private expanding = false;
  /** Gate instances handed to the CMOS expander. */
  expandedGates = 0;
  /** Gate instances that stayed ideal although expansion was requested. */
  idealGates = 0;

  /**
   * Register a PWL table and return its handle.
   *
   * The points are validated here, once, at flatten time: a table whose times are
   * not strictly increasing has no well-defined interpolation and would make the
   * source value depend on the direction the search came from.
   */
  addWaveTable(points: Float64Array): number {
    if (points.length < 4 || points.length % 2 !== 0) return -1;
    for (let i = 2; i < points.length; i += 2) {
      if (!(points[i] > points[i - 2])) return -1;
    }
    for (let i = 1; i < points.length; i += 2) {
      if (!Number.isFinite(points[i]) || !Number.isFinite(points[i - 1])) return -1;
    }
    this.waveTables.push(Float64Array.from(points));
    return this.waveTables.length - 1;
  }

  setExpanding(on: boolean): void {
    if (on && !this.expanding) this.expandedGates++;
    this.expanding = on;
  }

  countIdealGate(): void {
    this.idealGates++;
  }
  maxNodes = 1 << 23;

  srsSlots = SRC_SLOTS;
  srsStride = SRC_STRIDE;

  // supply rails created lazily for expanded gates
  vddNode = -1;
  vddVolts = 0;

  /** Root circuit, needed to attach the internal VDD rail. */
  root?: Circuit;

  private scratchNodes = new Int32Array(NODE_STRIDE);
  private scratchParams = new Float64Array(96);
  private scratchModel = new Float64Array(MODEL_STRIDE);

  constructor(private options: Required<Omit<FlattenOptions, 'ambient'>> & { ambient: number }) {
    // Node 0 is ground and always exists, so every per-node array is seeded with
    // it. Keep this in sync with newNode() or the arrays shift against each other.
    this.nodeNet.push(-1);
    this.nodeName.push(0);
    this.nodePath.push(0);
    this.nodeLane.push(0);
    this.nodeDegree.push(0);
  }

  nodeName = new GrowI32(1 << 12);
  nodeNames = new StringTable();

  newNode(netId: number, pathIdx: number, lane: number, name: string | null = null): number {
    const n = this.nodeCount++;
    if (n >= this.maxNodes) {
      throw new Error(`netlist exceeds the node limit (${this.maxNodes}); partition the design or raise the limit`);
    }
    this.nodeNet.push(netId);
    this.nodeName.push(name ? this.nodeNames.internNamed(name) : 0);
    this.nodePath.push(pathIdx);
    this.nodeLane.push(lane);
    this.nodeDegree.push(0);
    return n;
  }

  allocInternalNode(): number {
    return this.newNode(-1, 0, 0);
  }

  touchNode(n: number): void {
    if (n >= 0 && n < this.nodeDegree.length) this.nodeDegree.data[n]++;
  }

  addElement(
    kind: number,
    elementNodes: Int32Array,
    nodeCount: number,
    paramScratch: Float64Array | null,
    opts: { instIndex?: number; modelIndex?: number; branches?: number; stateInit?: Float64Array } = {},
  ): number {
    const layout = layoutOf(kind);
    if (!layout) throw new Error(`no parameter layout for element kind ${kind}`);
    if (nodeCount > NODE_STRIDE) throw new Error(`element kind ${kind} needs ${nodeCount} nodes (max ${NODE_STRIDE})`);

    const idx = this.elementCount++;
    // A MOSFET emitted while a gate is being expanded was synthesised by the
    // engine, not placed by the user: that is the distinction this counter exists
    // to make, and every report quoting it depends on it.
    if (this.expanding && kind === Kind.Mosfet) this.expandedTransistors++;
    this.kind.push(kind);
    this.nodes.pushMany(elementNodes, NODE_STRIDE);
    this.nodeCountPerElement.push(nodeCount);
    const pOff = this.params.length;
    this.paramOffset.push(pOff);
    if (paramScratch) this.params.pushMany(paramScratch, layout.stride);
    else {
      this.params.ensure(layout.stride);
      for (let i = 0; i < layout.stride; i++) this.params.data[this.params.length++] = 0;
    }
    const sOff = this.state.length;
    this.stateOffset.push(sOff);
    this.state.ensure(STATE_STRIDE);
    if (opts.stateInit) {
      this.state.data.set(opts.stateInit.subarray(0, STATE_STRIDE), this.state.length);
      this.state.length += STATE_STRIDE;
    } else {
      for (let i = 0; i < STATE_STRIDE; i++) this.state.data[this.state.length++] = 0;
    }
    const nBranches = opts.branches ?? 0;
    if (nBranches > 0) {
      this.branchIndex.push(this.branchCount);
      this.branchCount += nBranches;
    } else {
      this.branchIndex.push(-1);
    }
    this.modelIndex.push(opts.modelIndex ?? -1);
    this.instIndex.push(opts.instIndex ?? -1);
    for (let i = 0; i < nodeCount; i++) this.touchNode(elementNodes[i]);
    return idx;
  }

  registerModel(kind: number, key: string, params: Float64Array): number {
    return this.models.intern(kind, key, params);
  }

  scratchNodeBuffer(): Int32Array {
    return this.scratchNodes;
  }
  scratchParamBuffer(): Float64Array {
    return this.scratchParams;
  }
  modelScratch(): Float64Array {
    return this.scratchModel;
  }
  addDiagnostic(d: Diagnostic): void {
    this.diagnostics.push(d);
  }

  // --- thermal network ----------------------------------------------------

  thermalNode(cth: number, rthAmbient: number): number {
    const idx = this.thermalNodeCount++;
    this.thermalCth.push(Math.max(0, cth));
    // A positive resistance connects the node to ambient; 0 means "no path".
    this.thermalRthAmb.push(rthAmbient > 0 ? rthAmbient : 0);
    return idx;
  }

  thermalLink(a: number, b: number, rth: number): void {
    this.thermalLinks.push(a);
    this.thermalLinks.push(b);
    this.thermalLinkR.push(Math.max(1e-6, rth));
  }

  thermalSetCth(node: number, cth: number): void {
    if (node >= 0 && node < this.thermalCth.length) {
      // The capacitance of a shared node adds up (two sinks on the same node
      // really do have twice the mass).
      this.thermalCth.data[node] += Math.max(0, cth);
    }
  }

  thermalNodeForNet(netId: number): number {
    let n = this.thermalNetMap.get(netId);
    if (n === undefined) {
      n = this.thermalNode(0, 0);
      this.thermalNetMap.set(netId, n);
    }
    return n;
  }

  // --- supply rails -------------------------------------------------------

  supplyNode(which: 'vdd' | 'gnd', volts: number): number {
    if (which === 'gnd') return 0;
    if (this.vddNode >= 0) {
      if (Math.abs(this.vddVolts - volts) > 1e-6) {
        this.addDiagnostic(
          warn(
            'CF5301',
            `expanded gates request different supply voltages (${this.vddVolts} V and ${volts} V); the netlist uses ${this.vddVolts} V — split the design into separate supplies to avoid this`,
          ),
        );
      }
      return this.vddNode;
    }
    const node = this.newNode(-1, 0, 0);
    this.vddNode = node;
    this.vddVolts = volts;
    // A real voltage source drives the rail.
    const nb = this.scratchNodes;
    const pb = this.scratchParams;
    for (let i = 0; i < NODE_STRIDE; i++) nb[i] = -1;
    for (let i = 0; i < SRC_STRIDE; i++) pb[i] = 0;
    nb[0] = node;
    nb[1] = 0;
    pb[SRC_SLOTS.family] = 0;
    pb[SRC_SLOTS.waveform] = 0;
    pb[SRC_SLOTS.dc] = volts;
    pb[SRC_SLOTS.ac] = 0;
    this.addElement(Kind.VoltageSource, nb, 2, pb, { instIndex: -1, branches: 1 });
    this.addDiagnostic(
      info('CF5302', `internal supply rail created at ${volts} V for transistor-expanded gates`, {
        hint: 'Set the gate parameters (vdd, wn, wp) to control the expanded implementation; the rail is not shown in the schematic.',
      }),
    );
    return node;
  }
}

// ---------------------------------------------------------------------------

export function flatten(root: Circuit, lib: Library, chips: ChipLibrary, options: FlattenOptions = {}): FlatNetlist {
  const t0 = Date.now();
  const h = profiler.begin('netlist.flatten');
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const b = new Builder(opts);
  b.root = root;
  const rootPathIdx = b.paths.intern('');
  let instanceCount = 0;

  // Pin names accepted by a component instance, memoised per type/parameter set.
  const allowedPinCache = new Map<string, Set<string>>();
  const allowedPins = (inst: ComponentInstance): Set<string> | null => {
    const key = inst.chipRef ? `${inst.chipRef}|${inst.params['bits'] ?? ''}|${inst.params['words'] ?? ''}|${inst.params['width'] ?? ''}` : inst.specId;
    let names = allowedPinCache.get(key);
    if (!names) {
      const full = allowedPinNames(lib, chips, inst);
      if (!full) return null;
      names = full;
      allowedPinCache.set(key, names);
    }
    return names;
  };
  const reportedBadPins = new Set<string>();
  const reportBadPin = (inst: ComponentInstance, pin: string): void => {
    const key = `${inst.id}:${pin}`;
    if (reportedBadPins.has(key)) return;
    reportedBadPins.add(key);
    const names = allowedPins(inst);
    b.addDiagnostic(
      error('CF3010', `${inst.ref}.${pin} is not a pin of ${inst.chipRef ?? inst.specId}: the wire is dangling`, {
        target: { type: 'component', id: inst.id, name: inst.ref },
        hint: names ? `Pins: ${[...names].join(', ')}` : undefined,
      }),
    );
  };
  const pinNetsOf = (circuit: Circuit): Map<string, number> => buildPinNets(circuit, allowedPins, reportBadPin);

  const expand = (frame: Frame, parentInstance: number, depth: number): void => {
    if (depth > opts.maxDepth) {
      b.addDiagnostic(error('CF5001', `hierarchy depth ${depth} exceeds the limit (${opts.maxDepth}) at ${frame.path || 'root'}`));
      return;
    }
    const { circuit } = frame;

    const groundNets = new Set<number>();
    circuit.forEachComponent((inst) => {
      if (inst.specId === 'ground') {
        const net = circuit.netOf(inst.id, '0');
        if (net) {
          groundNets.add(net.id);
          // A ground symbol *alone* on a net references nothing: only a net that
          // other pins share gives the circuit a real 0 V reference.
          if (net.ports.length > 1) b.hasGroundReference = true;
        }
      }
    });

    const nodeForNet = (netId: number, lane: number): number => {
      if (netId < 0) return 0;
      if (groundNets.has(netId)) return 0;
      const key = netId * LANE_STRIDE + lane;
      let n = frame.nodes.get(key);
      if (n === undefined) {
        const local = frame.circuit.getNet(netId);
        const label = local ? (frame.path ? `${frame.path}/${local.name}` : local.name) : null;
        const name = label ? (lane > 0 ? `${label}[${lane}]` : label) : null;
        n = b.newNode(netId, frame.pathIdx, lane, name);
        frame.nodes.set(key, n);
      }
      return n;
    };

    const netOfPin = (inst: ComponentInstance, pinName: string): number =>
      frame.pinNets.get(`${inst.id}:${pinName}`) ?? -1;
    const nodeOfPin = (inst: ComponentInstance, pinName: string, lane = 0): number => {
      const netId = netOfPin(inst, pinName);
      if (netId < 0) return 0;
      const lanes = frame.circuit.getNet(netId)?.width ?? 1;
      return nodeForNet(netId, Math.min(lane, Math.max(0, lanes - 1)));
    };

    for (const inst of circuit.allComponents()) {
      let spec = lib.get(inst.specId);
      // A chip instance is resolvable from the chip library alone. Demanding a
      // matching primitive spec as well would make a chip unflattenable outside the
      // exact library it was authored in — and `chip.implementation()` returns
      // precisely such a circuit, since a ripple adder's children are named
      // `full_adder`, not a primitive. The lookup order stays library-first so a
      // primitive that shadows a chip id keeps its primitive meaning.
      const chipHint = inst.chipRef ?? (typeof inst.params['__chip'] === 'string' ? (inst.params['__chip'] as string) : null);
      const chipFallback = spec ? undefined : chips.get(chipHint ?? inst.specId);
      if (!spec && !chipFallback) {
        b.addDiagnostic(error('CF5002', `unknown component type "${inst.specId}" for ${inst.ref}`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
        continue;
      }

      const isChip = spec?.category === 'chip' || !!chipHint || !!chipFallback;
      const specId = spec?.id ?? inst.specId;
      const instIdx = instanceCount++;
      const pathIdx = b.paths.intern(frame.path ? `${frame.path}.${inst.ref}` : inst.ref);
      const record: FlatInstance = {
        id: inst.id,
        ref: inst.ref,
        specId,
        path: b.paths.list[pathIdx],
        depth: depth + 1,
        x: inst.x,
        y: inst.y,
        rotation: inst.rotation,
        bits: inst.bits,
        params: inst.params,
        chipRef: inst.chipRef,
        elementStart: b.elementCount,
        elementCount: 0,
        parent: parentInstance,
        lane: 0,
      };
      b.instances.push(record);
      b.specIds.intern(specId);

      if (isChip) {
        const chipRef = chipHint ?? specId;
        const chip = chips.get(chipRef);
        if (!chip) {
          b.addDiagnostic(error('CF5003', `chip "${chipRef}" instantiated by ${inst.ref} is not in the project library`, { target: { type: 'component', id: inst.id, name: inst.ref } }));
          continue;
        }
        let impl: Circuit;
        try {
          impl = chip.implementation(resolvedChipParams(chip, inst.params));
        } catch (err) {
          // A generator that throws (a missing dependency, a bad parameter) must
          // not abort the flatten: report it against the instance and move on.
          b.addDiagnostic(
            error('CF5005', `failed to generate ${inst.ref} (${chipRef}): ${err instanceof Error ? err.message : String(err)}`, {
              target: { type: 'component', id: inst.id, name: inst.ref },
            }),
          );
          continue;
        }
        const bits = Math.max(1, inst.bits);
        // The parent may connect the chip through buses; the local port nets are
        // bound lane by lane.
        // A chip instance with `bits = N` is N copies of the implementation,
        // bound lane by lane: copy c talks to lanes [c*w, c*w + w) of the parent
        // nets, where w is the declared width of the port. A width-1 chip with
        // bits = 4 is therefore a 4-bit wide instance of the same hardware, and a
        // width-4 chip is a 4-bit bus — the authoring model has one rule, not two.
        const makeChildFrame = (suffix: string, pathIdxLocal: number, copy: number): Frame => {
          const cf: Frame = {
            circuit: impl,
            path: record.path + suffix,
            pathIdx: pathIdxLocal,
            nodes: new Map(),
            pinNets: impl === frame.circuit ? frame.pinNets : pinNetsOf(impl),
          };
          // The interface of *this* instance is the port list of the resolved
          // implementation: a parametric chip may have more (or fewer) pins than
          // the default build of the same chip.
          for (const port of impl.allPorts()) {
            const parentNetId = netOfPin(inst, port.name);
            if (parentNetId < 0) continue;
            for (let lane = 0; lane < port.width; lane++) {
              cf.nodes.set(port.net * LANE_STRIDE + lane, nodeForNet(parentNetId, copy * port.width + lane));
            }
          }
          return cf;
        };
        for (let copy = 1; copy < bits; copy++) {
          expand(makeChildFrame(`[${copy}]`, b.paths.intern(`${record.path}[${copy}]`), copy), instIdx, depth + 1);
        }
        expand(makeChildFrame('', pathIdx, 0), instIdx, depth + 1);
        record.elementCount = b.elementCount - record.elementStart;
        continue;
      }

      // Reached only when `spec` resolved above: a chip instance continues earlier,
      // and the chip fallback is the only way `spec` can be undefined here.
      const ctx: LowerContext = {
        inst,
        spec: spec!,
        circuit,
        sink: b,
        netOf: netOfPin,
        nodeOf: nodeOfPin,
        nodeForNet,
        options: { expandGates: opts.expandGates, thermal: opts.thermal, ambient: opts.ambient, maxDepth: opts.maxDepth, metadata: opts.metadata },
        instanceIndex: instIdx,
        addDiagnostic: (d) => b.addDiagnostic(d),
        supplyNode: (which, volts) => b.supplyNode(which, volts),
      };
      try {
        // A primitive with `bits = N` is a vector instance: N copies of the same
        // element, each bound to the matching lane of the nets it is wired to.
        // Lane 0 is the instance itself, which keeps single-bit circuits and the
        // FlatInstance record unchanged.
        const lanes = Math.max(1, inst.bits);
        for (let lane = 0; lane < lanes; lane++) {
          const laneCtx: LowerContext = lane === 0 ? ctx : { ...ctx, nodeOf: (i, p) => nodeOfPin(i, p, lane) };
          lowerInstance(laneCtx);
        }
      } catch (err) {
        b.addDiagnostic(
          error('CF5005', `failed to instantiate ${inst.ref} (${specId}): ${err instanceof Error ? err.message : String(err)}`, {
            target: { type: 'component', id: inst.id, name: inst.ref },
          }),
        );
      }
      record.elementCount = b.elementCount - record.elementStart;
    }

    if (depth === 0) {
      for (const port of circuit.allPorts()) {
        const net = circuit.getNet(port.net);
        if (!net) continue;
        b.ports.push({ name: port.name, direction: port.direction, node: nodeForNet(net.id, 0), width: port.width });
      }
    }
  };

  const rootFrame: Frame = { circuit: root, path: '', pathIdx: rootPathIdx, nodes: new Map(), pinNets: pinNetsOf(root) };
  expand(rootFrame, -1, 0);

  const groundComponents = root.allComponents().filter((c) => c.specId === 'ground');
  const connectedGround = groundComponents.filter((c) => (root.netOf(c.id, '0')?.ports.length ?? 0) > 1);
  if (connectedGround.length === 0) {
    b.addDiagnostic(
      warn(
        'CF5004',
        groundComponents.length === 0
          ? 'no ground component in the top-level circuit: the solution is floating (only voltage differences are meaningful), the gmin conductance provides the reference'
          : 'the ground symbol is not connected to anything: the solution is floating, the gmin conductance provides an arbitrary reference',
      ),
    );
  }
  if (b.elementCount === 0) {
    b.addDiagnostic(error('CF5006', 'the circuit flattened to zero elements — nothing to simulate'));
  }

  const netlist: FlatNetlist = {
    name: root.name,
    nodeCount: b.nodeCount,
    nodeNet: b.nodeNet.toArray(),
    nodePath: b.nodePath.toArray(),
    nodeLane: b.nodeLane.toArray(),
    nodeDegree: b.nodeDegree.toArray(),
    nodeName: b.nodeName.toArray(),
    nodeNames: b.nodeNames.list,
    groundNode: 0,
    hasGroundReference: b.hasGroundReference,
    elementCount: b.elementCount,
    kind: b.kind.toArray(),
    nodes: b.nodes.toArray(),
    nodeCountPerElement: b.nodeCountPerElement.toArray(),
    paramOffset: b.paramOffset.toArray(),
    params: b.params.toArray(),
    stateOffset: b.stateOffset.toArray(),
    state: b.state.toArray(),
    branchIndex: b.branchIndex.toArray(),
    branchCount: b.branchCount,
    modelIndex: b.modelIndex.toArray(),
    instIndex: b.instIndex.toArray(),
    modelParams: b.models.toArray(),
    modelCount: b.models.count,
    thermalNodeCount: b.thermalNodeCount,
    thermalCth: b.thermalCth.toArray(),
    thermalRthAmbient: b.thermalRthAmb.toArray(),
    thermalLinks: b.thermalLinks.toArray(),
    thermalLinkRth: b.thermalLinkR.toArray(),
    thermalTemperature: new Float64Array(b.thermalNodeCount).fill(opts.ambient + 273.15),
    ambient: opts.ambient,
    instances: opts.metadata ? b.instances : [],
    paths: b.paths.list,
    specIds: b.specIds.list,
    ports: b.ports,
    diagnostics: b.diagnostics,
    fingerprint: '',
    options: opts,
    flattenMs: 0,
    expandedTransistors: b.expandedTransistors,
    expandedGates: b.expandedGates,
    gatesLeftIdeal: b.idealGates,
    waveTables: b.waveTables,
  };
  // Flattening with `expandGates` on is a *request*, not a result: a gate only expands
  // when its own `style` parameter is something other than the default `ideal`. Saying
  // so here is what keeps a user who ticks "expand gates to transistors" and gets an
  // unchanged netlist from believing the option silently did something.
  // A netlist with no gates in it has nothing to say about gate expansion: a resistive
  // divider flattened with the option on is not a request that went unmet, it is a
  // request that does not apply. Only gates that stayed ideal are worth reporting.
  if (opts.expandGates && b.expandedGates + b.idealGates > 0) {
    if (b.expandedTransistors > 0) {
      const also = b.idealGates > 0 ? `, and ${b.idealGates} gate instance(s) kept the default ideal style` : '';
      b.diagnostics.push(
        info('CF6012', `${b.expandedGates} gate instance(s) expanded into a CMOS transistor network, ${b.expandedTransistors} transistor(s) in total${also}`, {
          hint: 'A gate expands only when its own `style` parameter is not the default `ideal`, so one netlist can hold both ideal gates and transistor-level gates.',
        }),
      );
    } else {
      b.diagnostics.push(
        warn('CF6013', `gate expansion was requested but no gate expanded: ${b.idealGates} gate instance(s) kept the default ideal style`, {
          hint: 'A gate expands only when its own `style` parameter is not the default `ideal` (for example `cmos_static`). Set `style` on the gates, or leave expansion off.',
        }),
      );
    }
  }
  netlist.fingerprint = netlistFingerprint(netlist);
  netlist.flattenMs = Date.now() - t0;
  h.end();
  profiler.count('netlist.nodes', netlist.nodeCount);
  profiler.count('netlist.elements', netlist.elementCount);
  if (netlist.thermalNodeCount) profiler.count('netlist.thermalNodes', netlist.thermalNodeCount);
  return netlist;
}

/**
 * Precompute (component, pin) → net for a circuit (O(ports)).
 *
 * This pass is also the last line of defence against a wire to a pin that does
 * not exist. The ERC catches it for a hand-drawn circuit, but the synthesis and
 * search paths build circuits programmatically with the ERC switched off, and a
 * typo there would silently float a pin inside a generated chip. `allowed`
 * answers for one component instance; `report` turns a miss into a diagnostic.
 */
function buildPinNets(
  circuit: Circuit,
  allowed: (inst: ComponentInstance) => Set<string> | null,
  report?: (inst: ComponentInstance, pin: string) => void,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const net of circuit.allNets()) {
    for (const p of net.ports) {
      const inst = circuit.getComponent(p.component);
      if (inst && report) {
        const names = allowed(inst);
        if (names && !names.has(p.pin)) report(inst, p.pin);
      }
      map.set(`${p.component}:${p.pin}`, net.id);
    }
  }
  return map;
}

/** Structural fingerprint of a flattened netlist (cache key for the search). */
export function netlistFingerprint(nl: FlatNetlist): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let c = 0x85ebca6b;
  const mix = (v: number) => {
    const x = v | 0;
    a = Math.imul(a ^ x, 0x01000193) >>> 0;
    b = (Math.imul(b + x + 0x7feb352d, 0x846ca68b) >>> 0) ^ (b >>> 7);
    c = (Math.imul(c ^ (x + 0x27d4eb2f), 0x165667b1) >>> 0) ^ (c << 3);
  };
  mix(nl.nodeCount);
  mix(nl.elementCount);
  mix(nl.branchCount);
  for (let i = 0; i < nl.elementCount; i++) {
    mix(nl.kind[i]);
    const base = i * NODE_STRIDE;
    const n = nl.nodeCountPerElement[i];
    for (let k = 0; k < n; k++) mix(nl.nodes[base + k]);
    const layout = layoutOf(nl.kind[i]);
    if (layout) {
      const po = nl.paramOffset[i];
      for (let k = 0; k < layout.stride; k++) {
        const v = nl.params[po + k];
        if (!Number.isFinite(v)) {
          mix(0x7fffffff);
          continue;
        }
        mix(Math.round(v * 1e6) | 0);
        mix(Math.round((v * 1e6) / 4294967296) | 0);
      }
    }
    mix(nl.modelIndex[i]);
  }
  for (let m = 0; m < nl.modelCount * MODEL_STRIDE; m++) {
    const v = nl.modelParams[m];
    mix(Number.isFinite(v) ? Math.round(v * 1e6) | 0 : 0x7fffffff);
  }
  const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b) + hex(c);
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Element nodes as a view into the nodes array (no allocation). */
export function elementNodes(nl: FlatNetlist, e: number): Int32Array {
  return nl.nodes.subarray(e * NODE_STRIDE, e * NODE_STRIDE + nl.nodeCountPerElement[e]);
}

/** Human-readable element name, e.g. 'U3.M12 (MOSFET)'. */
export function elementName(nl: FlatNetlist, e: number): string {
  const inst = nl.instIndex[e];
  const name = KIND_NAME[nl.kind[e]] ?? `KIND_${nl.kind[e]}`;
  if (inst >= 0 && inst < nl.instances.length) return `${nl.instances[inst].path} (${name})`;
  return `#${e} (${name})`;
}

/** What a probe resolved to. */
export interface ProbeTarget {
  kind: 'node' | 'element' | 'thermal';
  /** Node index, element index or thermal node index. */
  index: number;
  /** The name the instrument should display. */
  name: string;
  /** How it was resolved (exact node name, unique instance path, …). */
  via: string;
  /** Second node for a differential voltage measurement, if the target has one. */
  index2?: number;
}

/**
 * Resolve a probe target written by a user or an instrument channel.
 *
 * Accepted forms: `node:<name>`, `element:<path>`, `thermal:<path>`, `<path>` or
 * `<name>`. An unprefixed target is tried as a node name first (node voltages are
 * what a scope channel usually wants), then as an instance path.
 *
 * A path that maps to several elements — a CMOS gate expands to four MOSFETs that
 * all belong to one instance — is **ambiguous and returns null with the candidates
 * listed**, rather than silently picking the first one. The caller then names the
 * element explicitly. Getting this wrong would report the drain current of an
 * arbitrary transistor as "the current through U3".
 */
export function resolveProbe(nl: FlatNetlist, target: string): ProbeTarget | null {
  const raw = String(target ?? '').trim();
  if (!raw) return null;
  const colon = raw.indexOf(':');
  const prefix = colon > 0 ? raw.slice(0, colon).toLowerCase() : '';
  const name = colon > 0 ? raw.slice(colon + 1).trim() : raw;
  if (!name) return null;

  const findNode = (n: string): number => {
    if (n === 'GND' || n === '0' || n.toLowerCase() === 'ground') return 0;
    for (let node = 1; node < nl.nodeCount; node++) {
      if (nodeNameAt(nl, node) === n) return node;
    }
    return -1;
  };
  const findElements = (path: string): number[] => {
    const hits: number[] = [];
    for (let e = 0; e < nl.elementCount; e++) {
      const inst = nl.instIndex[e];
      if (inst >= 0 && inst < nl.instances.length && nl.instances[inst].path === path) hits.push(e);
    }
    return hits;
  };
  const findThermal = (path: string): number => {
    for (let e = 0; e < nl.elementCount; e++) {
      const inst = nl.instIndex[e];
      if (inst >= 0 && inst < nl.instances.length && nl.instances[inst].path === path) {
        // The thermal node lives in the element's parameter block, not in a table:
        // `elementThermalNode` is the only accessor that reads it correctly.
        const t = elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params);
        if (t >= 0) return t;
      }
    }
    return -1;
  };

  if (prefix === 'node') {
    const node = findNode(name);
    return node >= 0 ? { kind: 'node', index: node, name: nodeNameAt(nl, node), via: 'exact node name' } : null;
  }
  if (prefix === 'element') {
    const hits = findElements(name);
    if (hits.length === 1) return { kind: 'element', index: hits[0], name: elementName(nl, hits[0]), via: 'unique instance path' };
    return null;
  }
  if (prefix === 'thermal') {
    const t = findThermal(name);
    return t >= 0 ? { kind: 'thermal', index: t, name: `${name} (junction)`, via: 'thermal node of the instance' } : null;
  }
  const node = findNode(name);
  if (node >= 0) return { kind: 'node', index: node, name: nodeNameAt(nl, node), via: 'matched a node name' };
  const hits = findElements(name);
  if (hits.length === 1) return { kind: 'element', index: hits[0], name: elementName(nl, hits[0]), via: 'matched a unique instance path' };
  return null;
}

/**
 * Why a probe could not be resolved, when it could not.
 *
 * Kept separate from `resolveProbe` so an instrument can report the reason instead
 * of "not found": an ambiguous path and a missing one need different fixes.
 */
export function probeFailure(nl: FlatNetlist, target: string): string {
  const raw = String(target ?? '').trim();
  const colon = raw.indexOf(':');
  const name = colon > 0 ? raw.slice(colon + 1).trim() : raw;
  const hits: number[] = [];
  for (let e = 0; e < nl.elementCount; e++) {
    const inst = nl.instIndex[e];
    if (inst >= 0 && inst < nl.instances.length && nl.instances[inst].path === name) hits.push(e);
  }
  if (hits.length > 1) {
    return `'${raw}' matches ${hits.length} elements of that instance (${hits.slice(0, 4).map((e) => elementName(nl, e)).join(', ')}${hits.length > 4 ? ', …' : ''}); name the element instead, e.g. element:${name}`;
  }
  if (hits.length === 0) {
    const sample: string[] = [];
    for (let node = 1; node < Math.min(nl.nodeCount, 4); node++) sample.push(nodeNameAt(nl, node));
    return `'${raw}' is neither a node name nor an instance path in this netlist (nodes include ${sample.join(', ')})`;
  }
  return `'${raw}' could not be resolved`;
}

export function netlistStats(nl: FlatNetlist): {
  nodes: number;
  elements: number;
  branches: number;
  models: number;
  thermalNodes: number;
  byKind: Record<string, number>;
  devices: { transistors: number; diodes: number; passive: number; sources: number; digital: number };
  accuracy: Accuracy;
} {
  const byKind: Record<string, number> = {};
  let transistors = 0;
  let diodes = 0;
  let passive = 0;
  let sources = 0;
  let digital = 0;
  for (let i = 0; i < nl.elementCount; i++) {
    const k = nl.kind[i];
    const name = KIND_NAME[k] ?? `KIND_${k}`;
    byKind[name] = (byKind[name] ?? 0) + 1;
    if (k === Kind.Mosfet || k === Kind.Bjt || k === Kind.Jfet) transistors++;
    else if (k === Kind.Diode || k === Kind.Led || k === Kind.Photodiode) diodes++;
    else if (k === Kind.Resistor || k === Kind.Capacitor || k === Kind.Inductor || k === Kind.Potentiometer || k === Kind.Transformer || k === Kind.NtcThermistor || k === Kind.Varistor) passive++;
    else if (k === Kind.VoltageSource || k === Kind.CurrentSource || k === Kind.NoiseSource) sources++;
    else if (k === Kind.LogicGate || k === Kind.LogicBuf || k === Kind.TriState || k === Kind.DFlipFlop || k === Kind.DLatch || k === Kind.Mux || k === Kind.Demux) digital++;
  }
  return {
    nodes: nl.nodeCount,
    elements: nl.elementCount,
    branches: nl.branchCount,
    models: nl.modelCount,
    thermalNodes: nl.thermalNodeCount,
    byKind,
    devices: { transistors, diodes, passive, sources, digital },
    accuracy: transistors > 0 ? Accuracy.REALISTIC : digital > 0 ? Accuracy.APPROXIMATED : Accuracy.REALISTIC,
  };
}

export { Severity, info };
