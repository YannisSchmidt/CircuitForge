/**
 * Finding the subcircuits a design repeats, and replacing them with a chip.
 *
 * A designer who copies a full adder a hundred and eighty-four times has written a
 * hundred and eighty-four opportunities for a mistake and a hundred and eighty-four
 * places a change has to be made by hand. This module finds those repetitions, works
 * out what each one *computes* by simulating it, and says which existing chip — if
 * any — computes the same thing. Replacement is offered, never applied silently: the
 * report says how many components would go and how many instances would come.
 *
 * How it works, and how far the method reaches:
 *
 *   1. The sheet is flattened and its logic graph built, so repetitions are found
 *      among the elements the simulator actually evaluates, not among the symbols.
 *   2. Elements are coloured by refinement: a colour starts as the element's kind and
 *      gate function, and each round folds in the colours of what drives it and what
 *      it drives. Equal colours after `depth` rounds mean equal local structure —
 *      this is a heuristic, not a proof of isomorphism, and the report says so.
 *   3. A pattern is the fan-in cone of a root element, bounded by the same depth, and
 *      two cones are the same pattern when their canonical forms match: the colour of
 *      every element in the cone plus which slot of which other cone element feeds
 *      each input, with inputs from outside numbered in a deterministic order.
 *   4. Cones are then *merged* when two roots read exactly the same external nets:
 *      that is what turns a carry cone and a sum cone, which share a, b and ci, into
 *      one three-input two-output pattern — the full adder — instead of reporting two
 *      half patterns that no chip corresponds to.
 *   5. Every candidate is measured: its external inputs are driven through all
 *      combinations the level-0 engine can hold in one settle (32 lanes, so up to
 *      five inputs exhaustively) and its outputs sampled. A pattern with more inputs
 *      than that is reported as *not measured*, with the reason, rather than being
 *      matched on structure alone.
 *   6. Matching against the chip library compares measured behaviour, element by
 *      element of the truth table, so a chip is suggested because it computes the same
 *      function — not because its name looked plausible.
 *
 * What it does not do: it does not find patterns that have no distinguished output
 * element, it does not look deeper than `depth`, and it does not consider analogue
 * circuitry at all. Those limits are in the report's notes, because a tool that
 * reports "no repetition found" must also say where it looked.
 */

import { ChipLibrary, type Chip } from '../core/chip.js';
import { Circuit, type ComponentInstance } from '../core/circuit.js';
import type { Library } from '../core/library.js';
import type { Diagnostic } from '../core/labels.js';
import { buildLogicGraph, LogicVectorSim, LOGIC_FN, type LogicElement, type LogicGraph } from '../analysis/logic.js';
import { flatten } from '../sim/netlist.js';

export interface MiningOptions {
  /** Fan-in cone depth that defines a pattern. Default 3. */
  depth?: number;
  /** How many times a pattern must occur to be reported. Default 2. */
  minOccurrences?: number;
  /** Cap on reported patterns, best first. Default 24. */
  maxPatterns?: number;
  /** Measure each candidate's behaviour by simulation. Default true. */
  measure?: boolean;
  /** Compare measured behaviour against the chip library. Default true. */
  matchChips?: boolean;
  /** Inputs above this are not measured exhaustively in one settle. Default 5. */
  maxMeasuredInputs?: number;
  /** A cone grows no further than this many external inputs. Default 5. */
  maxPatternInputs?: number;
  /** A cone holds at most this many elements. Default 12. */
  maxPatternSize?: number;
  /**
   * Extra external inputs a cone may hold *while growing*, before it is required to
   * fit `maxPatternInputs` once complete. Default 1: enough for a net that is
   * external only until the element driving it joins the cone.
   */
  coneSlack?: number;
  /** Expand gate primitives into transistors before mining. Default false. */
  expandGates?: boolean;
  ambient?: number;
  /** Merge cones that read the same external nets into one multi-output pattern. Default true. */
  mergeOutputs?: boolean;
}

export interface PatternOccurrence {
  /** Element index of the pattern's root, or of the first root for a merged pattern. */
  root: number;
  /** Logic element indices inside the pattern. */
  elements: number[];
  /** Component references, for occurrences that live on the mined sheet. */
  refs: string[];
  /** Hierarchical paths of every element, for occurrences that do not. */
  paths: string[];
  /** True when every element is a component of the mined sheet itself. */
  onSheet: boolean;
  /** Net indices read from outside the pattern, in canonical order. */
  externalInputs: number[];
  /** Net indices the pattern drives that something outside reads. */
  outputs: number[];
  /** The same nets by name, which is what a replacement wires to. */
  externalInputNames: string[];
  outputNames: string[];
}

export interface PatternBehaviour {
  inputs: number;
  outputs: number;
  /** One row per input combination, values as '0' | '1' | 'X' | 'Z'. */
  rows: string[];
  /** Whether every combination of the inputs was evaluated. */
  complete: boolean;
  lanes: number;
  measured: boolean;
  /** Why it was not measured, when it was not. */
  reason?: string;
}

export interface MatchedChip {
  id: string;
  name: string;
  version: string;
  /** True when the measured truth tables are identical, row for row. */
  identical: boolean;
  /** Rows that differ, when they do. */
  differingRows?: number;
  /**
   * Which pattern input feeds which chip input port, when the match needed a
   * permutation. Port order is a naming convention, not part of the function, so a
   * full adder whose cone happened to enumerate ci before a is still a full adder —
   * and a replacement has to wire it in the order that actually matched.
   */
  inputPermutation?: number[];
  outputPermutation?: number[];
  note: string;
}

export interface SubcircuitPattern {
  id: string;
  /** Human-readable structure, e.g. "XOR·XOR + AND·AND + OR (3 in, 2 out)". */
  description: string;
  /** Gate roles in the pattern, sorted. */
  kinds: string[];
  size: number;
  inputs: number;
  outputs: number;
  count: number;
  occurrences: PatternOccurrence[];
  behaviour: PatternBehaviour | null;
  matchedChip: MatchedChip | null;
  suggestedChip: { id: string; name: string; ports: Array<{ name: string; direction: 'input' | 'output'; width: number }> } | null;
  /** Patterns merged into this one, when it is a merged pattern. */
  mergedFrom: string[];
  saving: {
    /** Elements removed per occurrence, counting the chip instance as one. */
    elementsPerOccurrence: number;
    elementsTotal: number;
    componentsPerOccurrence: number;
    componentsTotal: number;
    instancesAdded: number;
    /** Occurrences that could actually be replaced on the mined sheet. */
    replaceable: number;
  };
}

export interface MiningReport {
  circuit: string;
  fingerprint: string;
  elements: number;
  nets: number;
  instances: number;
  /** Cones examined, and distinct canonical forms found. */
  conesExamined: number;
  distinctForms: number;
  patterns: SubcircuitPattern[];
  /** Patterns whose behaviour matched a chip in the library. */
  matched: number;
  ms: number;
  notes: string[];
}

const FN_NAMES: Record<number, string> = {
  [LOGIC_FN.BUF]: 'BUF',
  [LOGIC_FN.NOT]: 'NOT',
  [LOGIC_FN.AND]: 'AND',
  [LOGIC_FN.NAND]: 'NAND',
  [LOGIC_FN.OR]: 'OR',
  [LOGIC_FN.NOR]: 'NOR',
  [LOGIC_FN.XOR]: 'XOR',
  [LOGIC_FN.XNOR]: 'XNOR',
  [LOGIC_FN.TRISTATE]: 'TRI',
  [LOGIC_FN.CONST_HIGH]: 'ONE',
  [LOGIC_FN.CONST_LOW]: 'ZERO',
};

/** Symmetric functions: their input order carries no information. */
const SYMMETRIC = new Set<number>([LOGIC_FN.AND, LOGIC_FN.NAND, LOGIC_FN.OR, LOGIC_FN.NOR, LOGIC_FN.XOR, LOGIC_FN.XNOR]);

function fnName(element: LogicElement): string {
  if (element.kind === 'gate') return FN_NAMES[element.fn] ?? `FN${element.fn}`;
  if (element.kind === 'mux') return `MUX${1 << element.selects.length}`;
  if (element.kind === 'demux') return element.decoder ? `DEC${element.outputs.length}` : `DEMUX${element.outputs.length}`;
  if (element.kind === 'dff') return 'DFF';
  if (element.kind === 'latch') return 'DLATCH';
  return element.kind.toUpperCase();
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface Adjacency {
  /** Element index driving each net, or -1. */
  driverOfNet: Int32Array;
  /** Elements reading each net. */
  consumersOfNet: number[][];
  /** Provenance: which flat instance produced each element. */
  instanceOfElement: Int32Array;
  paths: string[];
  refs: string[];
  depths: number[];
}

function adjacency(graph: LogicGraph): Adjacency {
  const netCount = graph.netCount;
  const driverOfNet = new Int32Array(netCount).fill(-1);
  const consumersOfNet: number[][] = Array.from({ length: netCount }, () => []);
  for (const element of graph.elements) {
    for (const out of element.outputs) if (out >= 0 && out < netCount) driverOfNet[out] = element.index;
    for (const input of element.inputs) if (input >= 0 && input < netCount) consumersOfNet[input].push(element.index);
    if (element.enable >= 0 && element.enable < netCount) consumersOfNet[element.enable].push(element.index);
    if (element.clk >= 0 && element.clk < netCount) consumersOfNet[element.clk].push(element.index);
    if (element.rst >= 0 && element.rst < netCount) consumersOfNet[element.rst].push(element.index);
    for (const sel of element.selects) if (sel >= 0 && sel < netCount) consumersOfNet[sel].push(element.index);
  }
  const netlist = graph.netlist;
  const instanceOfElement = new Int32Array(netlist.elementCount).fill(-1);
  const paths: string[] = [];
  const refs: string[] = [];
  const depths: number[] = [];
  for (let i = 0; i < netlist.instances.length; i++) {
    const inst = netlist.instances[i];
    paths.push(inst.path ?? inst.ref ?? `#${i}`);
    refs.push(inst.ref ?? `#${i}`);
    depths.push(inst.depth ?? 1);
    for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) instanceOfElement[e] = i;
  }
  return { driverOfNet, consumersOfNet, instanceOfElement, paths, refs, depths };
}

/**
 * Colour elements by refinement.
 *
 * Round 0 is what the element is. Each later round folds in the colours of what
 * drives it and what it drives, so after `rounds` two elements have the same colour
 * only if their neighbourhoods to that distance look the same.
 */
function refineColours(graph: LogicGraph, adj: Adjacency, rounds: number): string[] {
  let colours = graph.elements.map((e) => `${e.kind}:${e.kind === 'gate' ? e.fn : `${e.inputs.length}/${e.outputs.length}`}:${e.inputs.length}`);
  for (let round = 0; round < rounds; round++) {
    const next: string[] = new Array(colours.length);
    for (const element of graph.elements) {
      const fanin: string[] = [];
      const push = (net: number, slot: number): void => {
        const driver = net >= 0 && net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1;
        fanin.push(driver >= 0 ? `${slot}:${colours[driver]}` : `${slot}:ext`);
      };
      element.inputs.forEach(push);
      element.selects.forEach((net, i) => push(net, 100 + i));
      if (element.clk >= 0) push(element.clk, 200);
      if (element.rst >= 0) push(element.rst, 201);
      if (element.enable >= 0) push(element.enable, 202);
      // A symmetric gate says nothing by its input order, so its fan-in is sorted;
      // anything else keeps slot order, because a mux select is not a data input.
      const symmetric = element.kind === 'gate' && SYMMETRIC.has(element.fn);
      const faninKey = symmetric ? [...fanin].sort().join(',') : fanin.join(',');
      const fanout: string[] = [];
      for (const out of element.outputs) {
        if (out < 0 || out >= adj.consumersOfNet.length) continue;
        for (const consumer of adj.consumersOfNet[out]) fanout.push(colours[consumer]);
      }
      next[element.index] = hash(`${colours[element.index]}|${faninKey}|${[...fanout].sort().join(',')}`);
    }
    colours = next;
  }
  return colours;
}

/** Every net an element reads, data and control alike. */
function netsReadBy(element: LogicElement): number[] {
  const nets = [...element.inputs, ...element.selects];
  if (element.clk >= 0) nets.push(element.clk);
  if (element.rst >= 0) nets.push(element.rst);
  if (element.enable >= 0) nets.push(element.enable);
  return nets;
}

/** How many distinct nets a set of elements reads from outside itself. */
function externalInputCount(graph: LogicGraph, adj: Adjacency, members: Set<number>): number {
  const external = new Set<number>();
  for (const index of members) {
    for (const net of netsReadBy(graph.elements[index])) {
      if (net < 0) continue;
      const driver = net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1;
      if (driver < 0 || !members.has(driver)) external.add(net);
    }
  }
  return external.size;
}

/**
 * The fan-in cone of a root, up to `depth` levels and up to `maxInputs` external
 * inputs.
 *
 * The input budget is what makes the result usable, and it is the reason this is a
 * cone and not simply "everything upstream". In a ripple adder the carry net is
 * driven by the previous stage, so an unbounded fan-in walk crosses the whole chain
 * and returns a pattern with a dozen inputs that nothing can be compared against.
 * Stopping when the next ancestor would push the external inputs over the budget is
 * exactly the decision a designer makes when they say "the carry-in is a port of this
 * block": it turns the sum cone and the carry cone of one stage into two patterns
 * over a, b and ci, which then merge into a full adder.
 *
 * Elements are returned in index order, so the canonical form of two equal cones is
 * the same string.
 */
function coneOf(graph: LogicGraph, adj: Adjacency, root: number, depth: number, maxInputs: number, maxSize: number, slack = 1): number[] {
  const seen = new Set<number>([root]);
  const distance = new Map<number, number>([[root, 0]]);
  let frontier = [root];
  for (let level = 0; level < depth; level++) {
    // Grow to a fixed point rather than in one pass. Adding an element can make
    // another one affordable: a carry cone cannot take the AND that reads the
    // internal XOR until that XOR is inside, because until then the XOR's own inputs
    // count as external. A single pass would reject it and never look again, and the
    // cone would depend on the order elements were visited — which would make two
    // identical structures hash differently.
    let grew = true;
    let next: number[] = [];
    while (grew) {
      grew = false;
      for (const index of frontier) {
        for (const net of netsReadBy(graph.elements[index])) {
          const driver = net >= 0 && net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1;
          if (driver < 0 || seen.has(driver)) continue;
          if (seen.size + 1 > maxSize) continue;
          seen.add(driver);
          // Undo the addition if it took the cone over its input budget: the net stays
          // external, which is what makes it a port of the pattern.
          //
          // The budget is checked with `slack` extra inputs during growth, because a
          // net can be external only temporarily: a carry cone cannot admit the AND
          // that reads the internal XOR until that XOR joins, and until then the XOR's
          // own inputs count as external. Judging that intermediate state by the final
          // budget would make the full adder unreachable. The cone is still required
          // to fit the budget once it is complete, so nothing over-wide is reported.
          if (externalInputCount(graph, adj, seen) > maxInputs + slack) {
            seen.delete(driver);
            continue;
          }
          distance.set(driver, level + 1);
          next.push(driver);
          grew = true;
        }
      }
    }
    if (next.length === 0) break;
    frontier = [...new Set(next)].sort((a, b) => a - b);
    next = [];
  }
  return pruneToBudget(graph, adj, seen, distance, root, maxInputs);
}

/**
 * Bring a grown cone back inside its input budget.
 *
 * Growing with slack can end too wide: a cone that reached across a carry chain holds
 * more external inputs than the budget allows even though a smaller cone rooted the
 * same way fits. Discarding it would throw away the pattern that was actually being
 * looked for, so the elements farthest from the root are dropped until it fits —
 * farthest first, with ties broken by index, so the result does not depend on the
 * order the graph happened to be walked in.
 */
function pruneToBudget(graph: LogicGraph, adj: Adjacency, seen: Set<number>, distance: Map<number, number>, root: number, maxInputs: number): number[] {
  const members = new Set(seen);
  let guard = members.size + 1;
  while (members.size > 1 && externalInputCount(graph, adj, members) > maxInputs && guard-- > 0) {
    let victim = -1;
    let victimDistance = -1;
    for (const index of members) {
      if (index === root) continue;
      const d = distance.get(index) ?? 0;
      if (d > victimDistance || (d === victimDistance && index > victim)) {
        victimDistance = d;
        victim = index;
      }
    }
    if (victim < 0) break;
    members.delete(victim);
  }
  return [...members].sort((a, b) => a - b);
}

/**
 * A canonical description of a cone: which element plays which role, and what feeds
 * each of its inputs — another cone element, or the k-th net from outside.
 */
function canonicalCone(graph: LogicGraph, adj: Adjacency, cone: number[], colours: string[]): { key: string; externalInputs: number[]; outputs: number[] } {
  const members = new Set(cone);
  const order = [...cone];
  const slot = new Map<number, number>();
  order.forEach((index, i) => slot.set(index, i));
  const external: number[] = [];
  const externalSlot = new Map<number, number>();
  const parts: string[] = [];
  for (const index of order) {
    const element = graph.elements[index];
    const nets: Array<{ net: number; slot: number }> = [];
    element.inputs.forEach((net, i) => nets.push({ net, slot: i }));
    element.selects.forEach((net, i) => nets.push({ net, slot: 100 + i }));
    if (element.clk >= 0) nets.push({ net: element.clk, slot: 200 });
    if (element.rst >= 0) nets.push({ net: element.rst, slot: 201 });
    if (element.enable >= 0) nets.push({ net: element.enable, slot: 202 });
    const encoded = nets.map(({ net, slot: s }) => {
      const driver = net >= 0 && net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1;
      if (driver >= 0 && members.has(driver)) return `${s}>${slot.get(driver)}`;
      if (net < 0) return `${s}>none`;
      if (!externalSlot.has(net)) {
        externalSlot.set(net, external.length);
        external.push(net);
      }
      return `${s}>x${externalSlot.get(net)}`;
    });
    const symmetric = element.kind === 'gate' && SYMMETRIC.has(element.fn);
    const body = symmetric ? [...encoded].sort().join(' ') : encoded.join(' ');
    parts.push(`${colours[index]}:${fnName(element)}[${body}]`);
  }
  // Outputs: nets of cone elements that something outside reads, or that the sheet
  // exports. Ordered by cone slot then net, so the form is stable.
  const outputs: number[] = [];
  for (const index of order) {
    const element = graph.elements[index];
    for (const out of element.outputs) {
      if (out < 0 || out >= adj.consumersOfNet.length) continue;
      const outside = adj.consumersOfNet[out].some((c) => !members.has(c));
      if (outside) outputs.push(out);
    }
  }
  return { key: parts.join('|'), externalInputs: external, outputs: outputs.sort((a, b) => a - b) };
}

/**
 * Mine a circuit for repeated subcircuits.
 *
 * @param circuit the sheet to look at; it is flattened first, so repetitions inside
 *   chip instances are found too
 */
export function mineSubcircuits(circuit: Circuit, lib: Library, chips?: ChipLibrary, options: MiningOptions = {}): MiningReport {
  const t0 = now();
  const depth = Math.max(1, Math.round(options.depth ?? 3));
  const minOccurrences = Math.max(2, Math.round(options.minOccurrences ?? 2));
  const maxPatterns = Math.max(1, Math.round(options.maxPatterns ?? 24));
  const measure = options.measure !== false;
  const matchChips = options.matchChips !== false;
  const maxInputs = Math.max(1, Math.round(options.maxMeasuredInputs ?? 5));
  const maxPatternInputs = Math.max(1, Math.round(options.maxPatternInputs ?? 5));
  const maxPatternSize = Math.max(2, Math.round(options.maxPatternSize ?? 12));
  const coneSlack = Math.max(0, Math.round(options.coneSlack ?? 1));
  const mergeOutputs = options.mergeOutputs !== false;
  const notes: string[] = [];

  const netlist = flatten(circuit, lib, chips ?? new ChipLibrary(), {
    expandGates: options.expandGates === true,
    ambient: options.ambient ?? 25,
    metadata: true,
  });
  const graph = buildLogicGraph(netlist);
  const adj = adjacency(graph);
  const colours = refineColours(graph, adj, depth);

  // ---- cones at several input budgets --------------------------------------
  //
  // The budget is what stops a cone walking the whole carry chain, and there is no
  // single right value: a two-input gate pair and a five-input ALU slice are both
  // worth finding. So cones are grown at each budget from 2 up to the maximum, and
  // the patterns are merged, preferring the smaller ones — a pattern that fits in a
  // tighter budget is more reusable, and reporting both a full adder and the
  // six-element thing that contains one would only bury the finding.
  const budgets: number[] = [];
  for (let b = 2; b <= maxPatternInputs; b++) budgets.push(b);

  const patterns: SubcircuitPattern[] = [];
  const sim = measure || matchChips ? new LogicVectorSim(graph, { loopIterations: 8 }) : null;
  const claimed = new Set<number>();
  let conesExamined = 0;
  const distinctForms = new Set<string>();

  const emit = (
    id: string,
    description: string,
    kinds: string[],
    elements: number[],
    externalInputs: number[],
    outputs: number[],
    occurrences: PatternOccurrence[],
    mergedFrom: string[],
  ): void => {
    const behaviour = sim ? measureBehaviour(sim, graph, externalInputs, outputs, maxInputs) : null;
    const matched = matchChips && behaviour && behaviour.measured ? matchAgainstChips(chips, lib, behaviour, notes) : null;
    const onSheet = occurrences.filter((o) => o.onSheet);
    patterns.push({
      id,
      description,
      kinds,
      size: elements.length,
      inputs: externalInputs.length,
      outputs: outputs.length,
      count: occurrences.length,
      occurrences,
      behaviour,
      matchedChip: matched,
      suggestedChip: suggestChip(id, kinds, externalInputs.length, outputs.length, matched),
      mergedFrom,
      saving: {
        elementsPerOccurrence: Math.max(0, elements.length - 1),
        elementsTotal: Math.max(0, elements.length - 1) * occurrences.length,
        componentsPerOccurrence: onSheet.length > 0 ? Math.max(0, new Set(onSheet[0].refs).size - 1) : 0,
        componentsTotal: onSheet.reduce((a, o) => a + Math.max(0, new Set(o.refs).size - 1), 0),
        instancesAdded: occurrences.length,
        replaceable: onSheet.length,
      },
    });
    for (const e of elements) claimed.add(e);
  };

  for (const budget of budgets) {
    interface Cone {
      root: number;
      elements: number[];
      key: string;
      externalInputs: number[];
      outputs: number[];
    }
    const groups = new Map<string, Cone[]>();
    for (const element of graph.elements) {
      const cone = coneOf(graph, adj, element.index, depth, budget, maxPatternSize, coneSlack);
      conesExamined++;
      if (cone.length < 2) continue;
      const canonical = canonicalCone(graph, adj, cone, colours);
      if (canonical.externalInputs.length > budget) continue;
      distinctForms.add(canonical.key);
      const record: Cone = { root: element.index, elements: cone, ...canonical };
      const list = groups.get(canonical.key);
      if (list) list.push(record);
      else groups.set(canonical.key, [record]);
    }

    // Merge cones that read exactly the same external nets: a sum cone and a carry
    // cone over a, b and ci are one full adder, not two half findings.
    const mergedGroups = new Map<string, Array<{ roots: number[]; elements: number[]; externalInputs: number[]; outputs: number[]; from: string[] }>>();
    if (mergeOutputs) {
      // One bucket per *occurrence*: the cones that read one particular set of nets.
      // A bucket is one copy of a wider pattern; the pattern repeats as often as there
      // are buckets with the same set of cone forms.
      const buckets = new Map<string, Array<Cone & { key: string }>>();
      for (const [key, cones] of groups) {
        for (const cone of cones) {
          const signature = cone.externalInputs.slice().sort((a, b) => a - b).join(',');
          const list = buckets.get(signature);
          if (list) list.push({ ...cone, key });
          else buckets.set(signature, [{ ...cone, key }]);
        }
      }
      // Group buckets by the set of cone forms they contain, so that the eight stages
      // of a ripple adder become eight occurrences of one merged pattern.
      const byForm = new Map<string, Array<Array<Cone & { key: string }>>>();
      for (const [, cones] of buckets) {
        const keys = [...new Set(cones.map((c) => c.key))];
        if (keys.length < 2) continue;
        // One cone per form: a bucket that holds two cones of the same form is not a
        // single copy of the pattern.
        if (keys.length !== cones.length) continue;
        const form = keys.slice().sort().join('+');
        const list = byForm.get(form);
        if (list) list.push(cones);
        else byForm.set(form, [cones]);
      }
      for (const [form, occurrencesOfForm] of byForm) {
        if (occurrencesOfForm.length < minOccurrences) continue;
        const first = occurrencesOfForm[0];
        const union = [...new Set(first.flatMap((c) => c.elements))].sort((a, b) => a - b);
        if (union.length < 2 || union.length > maxPatternSize) continue;
        const record = {
          roots: first.map((c) => c.root),
          elements: union,
          externalInputs: first[0].externalInputs.slice().sort((a, b) => a - b),
          outputs: [...new Set(first.flatMap((c) => c.outputs))].sort((a, b) => a - b),
          from: form.split('+'),
        };
        // One record per occurrence, so the pattern reports how often it really occurs.
        const records = occurrencesOfForm.map((cones) => ({
          roots: cones.map((c) => c.root),
          elements: [...new Set(cones.flatMap((c) => c.elements))].sort((a, b) => a - b),
          externalInputs: cones[0].externalInputs.slice().sort((a, b) => a - b),
          outputs: [...new Set(cones.flatMap((c) => c.outputs))].sort((a, b) => a - b),
          from: form.split('+'),
        }));
        void record;
        const list = mergedGroups.get(form);
        if (list) list.push(...records);
        else mergedGroups.set(form, records);
      }
    }

    for (const [key, records] of mergedGroups) {
      if (records.length < minOccurrences) continue;
      // All records of one form have the same shape; the first describes it.
      const first = records[0];
      // A merged pattern that merely repeats elements an earlier, tighter pattern
      // already claimed adds noise; the tight one is the finding worth acting on.
      if (first.elements.every((e) => claimed.has(e))) continue;
      const occurrences = records.map((m) => occurrenceOf(graph, adj, m.roots[0], m.elements, m.externalInputs, m.outputs));
      const kinds = first.elements.map((i) => fnName(graph.elements[i])).sort();
      emit(
        `m${hash(key)}`,
        `${describeKinds(kinds)} (${first.externalInputs.length} in, ${first.outputs.length} out)`,
        kinds,
        first.elements,
        first.externalInputs,
        first.outputs,
        occurrences,
        first.from.map((f) => `c${hash(f)}`),
      );
    }

    for (const [key, cones] of groups) {
      if (cones.length < minOccurrences) continue;
      const first = cones[0];
      if (first.elements.every((e) => claimed.has(e))) continue;
      const occurrences = cones.map((c) => occurrenceOf(graph, adj, c.root, c.elements, c.externalInputs, c.outputs));
      const kinds = first.elements.map((i) => fnName(graph.elements[i])).sort();
      emit(
        `c${hash(key)}`,
        `${describeKinds(kinds)} (${first.externalInputs.length} in, ${first.outputs.length} out)`,
        kinds,
        first.elements,
        first.externalInputs,
        first.outputs,
        occurrences,
        [],
      );
    }
  }

  if (budgets.length > 1) {
    notes.push(`cones were grown at external-input budgets ${budgets.join(', ')}: a pattern found at a smaller budget is the more reusable one, and larger patterns that only repeat its elements are dropped.`);
  }

  patterns.sort((a, b) => b.saving.elementsTotal - a.saving.elementsTotal || b.count - a.count);
  const kept = patterns.slice(0, maxPatterns);
  if (patterns.length > kept.length) notes.push(`${patterns.length - kept.length} further pattern(s) were found and are not listed; raise maxPatterns to see them.`);

  notes.unshift(
    `Grew ${conesExamined} fan-in cone(s) up to depth ${depth}, bounded at ${maxPatternInputs} external input(s) and ${maxPatternSize} element(s); ${distinctForms.size} distinct form(s), of which ${kept.length} repeat at least ${minOccurrences} time(s).`,
    'Patterns are found among flattened logic elements. Analogue circuitry is not mined, and a pattern with no distinguished output element is out of reach of this method.',
    'Equality of two cones is decided by colour refinement plus a canonical form: a strong structural test, not a proof of isomorphism. Behaviour, where measured, is what confirms a match.',
  );

  return {
    circuit: circuit.name,
    fingerprint: netlist.fingerprint,
    elements: graph.elements.length,
    nets: graph.netCount,
    instances: netlist.instances.length,
    conesExamined,
    distinctForms: distinctForms.size,
    patterns: kept,
    matched: kept.filter((p) => p.matchedChip?.identical).length,
    ms: now() - t0,
    notes,
  };
}

function describeKinds(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => (n > 1 ? `${n}×${k}` : k))
    .join(' + ');
}

function occurrenceOf(graph: LogicGraph, adj: Adjacency, root: number, elements: number[], externalInputs: number[], outputs: number[]): PatternOccurrence {
  const refs: string[] = [];
  const paths: string[] = [];
  let onSheet = true;
  for (const index of elements) {
    const element = graph.elements[index];
    const instance = adj.instanceOfElement[element.element];
    if (instance < 0) {
      onSheet = false;
      paths.push(`#${element.element}`);
      continue;
    }
    const path = adj.paths[instance] ?? `#${instance}`;
    const ref = adj.refs[instance] ?? `#${instance}`;
    paths.push(path);
    if (!refs.includes(ref)) refs.push(ref);
    if ((adj.depths[instance] ?? 1) !== 1) onSheet = false;
  }
  return {
    root,
    elements: [...elements],
    refs,
    paths,
    onSheet,
    externalInputs: [...externalInputs],
    outputs: [...outputs],
    externalInputNames: externalInputs.map((n) => graph.netName(n)),
    outputNames: outputs.map((n) => graph.netName(n)),
  };
}

/**
 * Measure a pattern by driving its external inputs through every combination the
 * level-0 engine holds in one settle.
 */
function measureBehaviour(sim: LogicVectorSim, graph: LogicGraph, externalInputs: number[], outputs: number[], maxInputs: number): PatternBehaviour {
  if (externalInputs.length === 0 || outputs.length === 0) {
    return { inputs: externalInputs.length, outputs: outputs.length, rows: [], complete: false, lanes: 0, measured: false, reason: 'a pattern needs at least one input and one output to be measured' };
  }
  if (externalInputs.length > maxInputs) {
    return {
      inputs: externalInputs.length,
      outputs: outputs.length,
      rows: [],
      complete: false,
      lanes: 0,
      measured: false,
      reason: `${externalInputs.length} inputs would need ${1 << externalInputs.length} vectors; the level-0 engine settles 32 at a time and this report only claims exhaustive measurement up to ${maxInputs}`,
    };
  }
  const lanes = 1 << externalInputs.length;
  try {
    externalInputs.forEach((net, i) => {
      let ones = 0;
      for (let k = 0; k < lanes; k++) if (((k >> i) & 1) === 1) ones |= 1 << k;
      sim.drive(net, ones >>> 0, 0);
    });
    sim.settle();
    const rows: string[] = [];
    for (let k = 0; k < lanes; k++) {
      rows.push(outputs.map((net) => String(sim.sample(net, k))).join(''));
    }
    for (const net of externalInputs) sim.release(net);
    sim.settle();
    return { inputs: externalInputs.length, outputs: outputs.length, rows, complete: true, lanes, measured: true };
  } catch (err) {
    return {
      inputs: externalInputs.length,
      outputs: outputs.length,
      rows: [],
      complete: false,
      lanes,
      measured: false,
      reason: `the measurement failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  void graph;
}

/** All index permutations of length n; n is at most 5 here, so 120 at worst. */
function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  const out: number[][] = [];
  const build = (prefix: number[], remaining: number[]): void => {
    if (remaining.length === 0) {
      out.push(prefix);
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      build([...prefix, remaining[i]], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
    }
  };
  build([], Array.from({ length: n }, (_, i) => i));
  return out;
}

/**
 * Reorder a measured truth table: `inputPermutation[j]` is the pattern input that
 * becomes the j-th input of the reordered table, and `outputPermutation` reorders the
 * output characters of every row the same way.
 */
function permuteRows(rows: string[], inputs: number, inputPermutation: number[], outputPermutation: number[]): string[] {
  const out: string[] = new Array(rows.length);
  for (let k = 0; k < rows.length; k++) {
    let source = 0;
    for (let j = 0; j < inputs; j++) if (((k >> j) & 1) === 1) source |= 1 << inputPermutation[j];
    const row = rows[source] ?? '';
    out[k] = outputPermutation.map((o) => row[o] ?? '?').join('');
  }
  return out;
}

/**
 * Compare a measured behaviour against every chip the library can offer, allowing a
 * permutation of inputs and of outputs.
 *
 * Without that, a correct match depends on the order a breadth-first walk happened to
 * enumerate the cone's external nets — a detail of the mining, not of the function.
 * The permutation that matched is kept, because wiring a replacement chip in the
 * canonical order rather than the matched one would silently build a different
 * circuit.
 */
function matchAgainstChips(chips: ChipLibrary | undefined, lib: Library, behaviour: PatternBehaviour, notes: string[]): MatchedChip | null {
  if (!chips || chips.size() === 0) return null;
  let best: MatchedChip | null = null;
  const inputPerms = behaviour.inputs <= 5 ? permutations(behaviour.inputs) : [[...Array(behaviour.inputs).keys()]];
  const outputPerms = behaviour.outputs <= 4 ? permutations(behaviour.outputs) : [[...Array(behaviour.outputs).keys()]];
  for (const chip of chips.all()) {
    const candidate = chipBehaviour(chip, lib, chips, behaviour.inputs, behaviour.outputs);
    if (!candidate || candidate.rows.length !== behaviour.rows.length) continue;
    let identical = false;
    let chosenIn: number[] | undefined;
    let chosenOut: number[] | undefined;
    let bestDiffering = candidate.rows.length;
    outer: for (const inPerm of inputPerms) {
      for (const outPerm of outputPerms) {
        const permuted = inPerm.every((v, i) => v === i) && outPerm.every((v, i) => v === i) ? behaviour.rows : permuteRows(behaviour.rows, behaviour.inputs, inPerm, outPerm);
        let differing = 0;
        for (let i = 0; i < permuted.length; i++) if (permuted[i] !== candidate.rows[i]) differing++;
        if (differing === 0) {
          identical = true;
          chosenIn = inPerm;
          chosenOut = outPerm;
          bestDiffering = 0;
          break outer;
        }
        if (differing < bestDiffering) {
          bestDiffering = differing;
          chosenIn = inPerm;
          chosenOut = outPerm;
        }
      }
    }
    const permutedLabel =
      identical && chosenIn && chosenOut && !(chosenIn.every((v, i) => v === i) && chosenOut.every((v, i) => v === i))
        ? `, with inputs matched in the order [${chosenIn.join(',')}] and outputs as [${chosenOut.join(',')}]`
        : '';
    const entry: MatchedChip = {
      id: chip.def.id,
      name: chip.def.name,
      version: chip.def.version,
      identical,
      differingRows: bestDiffering,
      inputPermutation: chosenIn,
      outputPermutation: chosenOut,
      note: identical
        ? `measured truth tables are identical over all ${behaviour.rows.length} input combination(s)${permutedLabel}`
        : `${bestDiffering} of ${behaviour.rows.length} row(s) differ at the closest port ordering`,
    };
    if (identical) return entry;
    if (!best || entry.differingRows! < best.differingRows!) best = entry;
  }
  if (best && !best.identical) {
    notes.push(`the closest chip to a pattern was ${best.name} with ${best.differingRows} differing row(s); it is reported as a near match, not as a suggestion to substitute.`);
  }
  return best;
}

const chipBehaviourCache = new Map<string, PatternBehaviour | null>();

/** Measure a chip's own behaviour, the same way a pattern is measured. */
function chipBehaviour(chip: Chip, lib: Library, chips: ChipLibrary, inputs: number, outputs: number): PatternBehaviour | null {
  const ports = chip.def.ports ?? [];
  const chipInputs = ports.filter((p) => p.direction === 'input' && (p.width ?? 1) === 1);
  const chipOutputs = ports.filter((p) => p.direction === 'output' && (p.width ?? 1) === 1);
  if (chipInputs.length !== inputs || chipOutputs.length !== outputs) return null;
  const cacheKey = `${chip.def.id}@${chip.def.version}:${inputs}x${outputs}`;
  if (chipBehaviourCache.has(cacheKey)) return chipBehaviourCache.get(cacheKey) ?? null;
  let behaviour: PatternBehaviour | null = null;
  try {
    const implementation = chip.implementation(chip.defaultParams());
    const netlist = flatten(implementation, lib, chips, { metadata: true });
    const graph = buildLogicGraph(netlist);
    const sim = new LogicVectorSim(graph, { loopIterations: 8 });
    const inputNets = graph.inputs.slice(0, inputs);
    const outputNets = graph.outputs.slice(0, outputs);
    if (inputNets.length === inputs && outputNets.length === outputs) {
      behaviour = measureBehaviour(sim, graph, inputNets, outputNets, Math.max(inputs, 5));
    }
  } catch {
    behaviour = null;
  }
  chipBehaviourCache.set(cacheKey, behaviour);
  return behaviour;
}

/** What to call a chip built from this pattern, and which ports it would have. */
function suggestChip(id: string, kinds: string[], inputs: number, outputs: number, matched: MatchedChip | null): SubcircuitPattern['suggestedChip'] {
  if (matched?.identical) {
    return {
      id: matched.id,
      name: matched.name,
      ports: [
        ...Array.from({ length: inputs }, (_, i) => ({ name: `I${i}`, direction: 'input' as const, width: 1 })),
        ...Array.from({ length: outputs }, (_, i) => ({ name: `O${i}`, direction: 'output' as const, width: 1 })),
      ],
    };
  }
  const stem = kinds.filter((k, i, a) => a.indexOf(k) === i).join('_').slice(0, 24) || 'BLOCK';
  return {
    id: `${stem.toLowerCase()}_${inputs}x${outputs}_${id.slice(0, 6)}`,
    name: `${stem}_${inputs}X${outputs}`,
    ports: [
      ...Array.from({ length: inputs }, (_, i) => ({ name: `I${i}`, direction: 'input' as const, width: 1 })),
      ...Array.from({ length: outputs }, (_, i) => ({ name: `O${i}`, direction: 'output' as const, width: 1 })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

export interface ReplaceOptions {
  /** Chip to instantiate. Defaults to the chip the pattern matched, if it matched one. */
  chipId?: string;
  /** Replace at most this many occurrences. */
  limit?: number;
}

export interface ReplaceResult {
  circuit: Circuit;
  chipId: string;
  replaced: number;
  skipped: Array<{ occurrence: number; reason: string }>;
  componentsBefore: number;
  componentsAfter: number;
  netsBefore: number;
  netsAfter: number;
  diagnostics: Diagnostic[];
  notes: string[];
}

/**
 * Replace every occurrence of a pattern that lives on this sheet with one chip
 * instance.
 *
 * The wiring is taken from the occurrence's own nets: input k of the chip is
 * connected to the k-th external net the pattern read, and output k to the k-th net
 * it drove. That correspondence is the one the behaviour match verified — the truth
 * tables were compared row by row in the same order — so a chip suggested as
 * identical is wired the way it was measured.
 *
 * Occurrences inside a chip expansion are skipped, with the reason: their components
 * belong to another sheet, and editing them from here would change every instance of
 * that chip, which is not what "replace this repetition" means.
 */
export function replacePatternWithChip(circuit: Circuit, lib: Library, chips: ChipLibrary, pattern: SubcircuitPattern, options: ReplaceOptions = {}): ReplaceResult {
  const notes: string[] = [];
  const chipId = options.chipId ?? (pattern.matchedChip?.identical ? pattern.matchedChip.id : pattern.suggestedChip?.id);
  const skipped: Array<{ occurrence: number; reason: string }> = [];
  const before = { components: circuit.componentCount(), nets: circuit.netCount() };

  if (!chipId) {
    return refuse(circuit, '', before, pattern, 'the pattern matched no chip and no chipId was given', notes);
  }
  const chip = chips.get(chipId);
  if (!chip) {
    return refuse(circuit, chipId, before, pattern, `no chip "${chipId}" is in the library`, notes);
  }
  const spec = lib.get(chipId);
  if (!spec) {
    return refuse(circuit, chipId, before, pattern, `the library has no component spec for "${chipId}", so it cannot be placed on a sheet`, notes);
  }
  const chipInputs = (chip.def.ports ?? []).filter((p) => p.direction === 'input');
  const chipOutputs = (chip.def.ports ?? []).filter((p) => p.direction === 'output');
  if (chipInputs.length !== pattern.inputs || chipOutputs.length !== pattern.outputs) {
    return refuse(
      circuit,
      chipId,
      before,
      pattern,
      `${chipId} has ${chipInputs.length} input(s) and ${chipOutputs.length} output(s), but the pattern reads ${pattern.inputs} and drives ${pattern.outputs}`,
      notes,
    );
  }

  const result = circuit.clone();
  result.name = `${circuit.name} (replaced)`;
  const limit = options.limit ?? pattern.occurrences.length;
  const consumed = new Set<string>();
  let replaced = 0;

  pattern.occurrences.forEach((occurrence, index) => {
    if (replaced >= limit) {
      skipped.push({ occurrence: index, reason: 'the replacement limit was reached' });
      return;
    }
    if (!occurrence.onSheet) {
      skipped.push({ occurrence: index, reason: `it lives inside a chip expansion (${occurrence.paths[0] ?? '?'}), not on this sheet` });
      return;
    }
    if (occurrence.refs.some((r) => consumed.has(r))) {
      skipped.push({ occurrence: index, reason: 'its components overlap an occurrence already replaced' });
      return;
    }
    const victims = result.allComponents().filter((c) => occurrence.refs.includes(c.ref));
    if (victims.length === 0) {
      skipped.push({ occurrence: index, reason: 'none of its components are on this sheet any more' });
      return;
    }
    // Nets are resolved before anything is removed: removing the last component on a
    // net is what makes the net disappear, and the chip needs those names.
    const inputNets = occurrence.externalInputNames.map((name) => findNet(result, name));
    const outputNets = occurrence.outputNames.map((name) => findNet(result, name));
    const missing = [...occurrence.externalInputNames, ...occurrence.outputNames].filter((n, i) => [...inputNets, ...outputNets][i] === undefined);
    if (missing.length > 0) {
      skipped.push({ occurrence: index, reason: `its net(s) ${missing.join(', ')} are not on this sheet` });
      return;
    }
    const position = { x: victims[0].x, y: victims[0].y };
    result.removeComponents(victims.map((v) => v.id));
    const instance = result.addComponent(spec, chip.defaultParams(), position, { chipRef: chipId });
    // The matched permutation, when the match needed one: chip port j takes the
    // pattern net the permutation says it corresponds to. Wiring in canonical order
    // instead would build a different circuit that looks like the one measured.
    const inPerm = pattern.matchedChip?.identical && pattern.matchedChip.inputPermutation ? pattern.matchedChip.inputPermutation : null;
    const outPerm = pattern.matchedChip?.identical && pattern.matchedChip.outputPermutation ? pattern.matchedChip.outputPermutation : null;
    chipInputs.forEach((port, j) => {
      const net = inPerm ? inputNets[inPerm[j]] : inputNets[j];
      if (net) result.connect(instance.id, port.name, net.id);
    });
    chipOutputs.forEach((port, j) => {
      const net = outPerm ? outputNets[outPerm[j]] : outputNets[j];
      if (net) result.connect(instance.id, port.name, net.id);
    });
    for (const ref of occurrence.refs) consumed.add(ref);
    replaced++;
  });

  const after = { components: result.componentCount(), nets: result.netCount() };
  const diagnostics = result.erc(lib, chips);
  notes.push(`replaced ${replaced} of ${pattern.occurrences.length} occurrence(s) with ${chipId}; ${skipped.length} skipped.`);
  notes.push(
    `${before.components} component(s) became ${after.components} and ${before.nets} net(s) became ${after.nets}.`,
  );
  if (skipped.length > 0) {
    notes.push(`skipped: ${skipped.slice(0, 3).map((s) => `#${s.occurrence} (${s.reason})`).join('; ')}${skipped.length > 3 ? '; …' : ''}`);
  }
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    notes.push(`the result has ${errors.length} ERC error(s), the first being ${errors[0].code}: ${errors[0].message}. Replacement is offered, not imposed: review it before keeping it.`);
  }
  return {
    circuit: result,
    chipId,
    replaced,
    skipped,
    componentsBefore: before.components,
    componentsAfter: after.components,
    netsBefore: before.nets,
    netsAfter: after.nets,
    diagnostics,
    notes,
  };
}

function refuse(circuit: Circuit, chipId: string, before: { components: number; nets: number }, pattern: SubcircuitPattern, reason: string, notes: string[]): ReplaceResult {
  notes.push(`nothing was replaced: ${reason}.`);
  return {
    circuit,
    chipId,
    replaced: 0,
    skipped: pattern.occurrences.map((_, i) => ({ occurrence: i, reason })),
    componentsBefore: before.components,
    componentsAfter: before.components,
    netsBefore: before.nets,
    netsAfter: before.nets,
    diagnostics: [],
    notes,
  };
}

function findNet(circuit: Circuit, name: string) {
  for (const net of circuit.allNets()) if (net.name === name) return net;
  return undefined;
}

function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** A short, honest summary of a mining report, for the CLI and the console dock. */
export function miningToText(report: MiningReport): string {
  const lines: string[] = [];
  lines.push(`Repeated subcircuits in ${report.circuit} (fingerprint ${report.fingerprint})`);
  lines.push(`${report.elements} logic element(s), ${report.nets} net(s), ${report.instances} instance(s) — mined in ${report.ms.toFixed(1)} ms`);
  lines.push('');
  if (report.patterns.length === 0) {
    lines.push('No subcircuit repeats at least twice within the searched depth.');
  }
  for (const pattern of report.patterns) {
    lines.push(`[${pattern.id}] ${pattern.description} — ${pattern.count} occurrence(s), ${pattern.size} element(s)`);
    if (pattern.behaviour?.measured) {
      lines.push(`  behaviour: ${pattern.behaviour.inputs} input(s) → ${pattern.behaviour.outputs} output(s), ${pattern.behaviour.rows.length} combination(s) measured${pattern.behaviour.complete ? ' exhaustively' : ' (not exhaustive)'}`);
      lines.push(`  truth table: ${pattern.behaviour.rows.slice(0, 16).join(' ')}${pattern.behaviour.rows.length > 16 ? ' …' : ''}`);
    } else if (pattern.behaviour) {
      lines.push(`  behaviour: NOT MEASURED — ${pattern.behaviour.reason}`);
    }
    if (pattern.matchedChip) {
      lines.push(`  chip: ${pattern.matchedChip.name} (${pattern.matchedChip.id} v${pattern.matchedChip.version}) — ${pattern.matchedChip.note}`);
    } else {
      lines.push(`  chip: no library chip computes this; a new one would be called ${pattern.suggestedChip?.name ?? '?'}`);
    }
    lines.push(`  replacing all ${pattern.saving.replaceable} replaceable occurrence(s) would remove about ${pattern.saving.componentsTotal} component(s)`);
  }
  lines.push('');
  lines.push('Scope:');
  for (const note of report.notes) lines.push(`  - ${note}`);
  return lines.join('\n');
}
