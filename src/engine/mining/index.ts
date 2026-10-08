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
 *   4. Cones are then *merged* when two roots read exactly the same external nets,
 *      which is how a carry cone and a sum cone over a, b and ci can become one
 *      three-input two-output pattern instead of two half patterns that no chip
 *      corresponds to.
 *
 *      Three details decide whether this works, and each was found by getting it
 *      wrong first. The labels a cone is described with are refined *inside the cone*
 *      only — a global refinement encodes the neighbourhood beyond it, and in a ripple
 *      chain no two stages have the same neighbourhood, so an eight-stage adder would
 *      report eight patterns of one occurrence instead of one pattern of eight. A net
 *      that leaves through a *port* is an output even when no element reads it, or the
 *      sum of a full adder would not count as one. And a cone may borrow one input
 *      while growing — the carry cone cannot admit the AND that reads the internal XOR
 *      until that XOR joins, and until then the XOR's own inputs count as external —
 *      but must fit the budget once complete, and the elements that only fit thanks to
 *      the allowance are the first to be pruned, which is what stops a cone walking the
 *      carry chain into the previous stage.
 *
 *      Verified: on a flat sheet of 184 full-adder gate clusters the miner reports one
 *      pattern of 184 occurrences, five elements, three inputs and two outputs, its
 *      measured truth table is identical to the `full_adder` chip's, and replacing all
 *      184 takes the sheet from 920 components to 184 with no ERC error and no change
 *      to the behaviour of any output.
 *   5. Every combinational candidate is measured: its external inputs are driven
 *      through all combinations the level-0 engine can hold in one settle (32 lanes,
 *      so up to five inputs exhaustively) and its outputs sampled. A wider pattern is
 *      reported as *not measured*, rather than being matched on structure alone.
 *      DFF/latch patterns are also *not measured*: one settle does not exercise a clock
 *      edge, and a snapshot of the power-on state is not evidence of equivalent state
 *      machines.
 *   6. Matching against the chip library compares measured combinational behaviour,
 *      element by element of the truth table, so a chip is suggested because it
 *      computes the same function — not because its name looked plausible. Sequential
 *      chips are not matched until a clocked equivalence procedure exists.
 *
 * What it does not do: it does not find patterns that have no distinguished output
 * element, it does not look deeper than `depth`, it does not consider analogue
 * circuitry at all, and it never suggests a substitution on a near match. Those limits
 * are in the report's notes, because a tool that reports "no repetition found" must
 * also say where it looked.
 */

import { ChipLibrary, makeChip, sanitizeChipId, type Chip } from '../core/chip.js';
import { Circuit, type ComponentInstance } from '../core/circuit.js';
import type { Library } from '../core/library.js';
import { error, info, warn, type Diagnostic } from '../core/labels.js';
import { CircuitBuilder } from '../core/build.js';
import { registerChip } from '../core/registry.js';
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
  /**
   * The id of a larger reported pattern that contains every occurrence of this one.
   *
   * A full adder is two half adders and an OR, so a sheet of full adders genuinely
   * contains three findings, each measurable and each matched to a real chip. What
   * would mislead is presenting them as three independent chances to de-duplicate the
   * same sheet: replacing the half adders first destroys the full adder they are part
   * of. Containment is therefore stated, and the larger pattern is the one to act on.
   */
  subBlockOf?: string;
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

/** Level-0 and declared-timing attributes that must agree before two cones are one pattern. */
function isSequential(element: LogicElement): boolean {
  return element.kind === 'dff' || element.kind === 'latch';
}

function logicSignature(element: LogicElement): string {
  return [
    element.kind,
    `fn=${element.fn}`,
    `io=${element.inputs.length}/${element.outputs.length}`,
    `sel=${element.selects.length}`,
    `channels=${element.channels}`,
    `decoder=${Number(element.decoder)}`,
    `activeLow=${Number(element.activeLow)}`,
    `resetLow=${Number(element.rstLow)}`,
    `falling=${Number(element.falling)}`,
    `initial=${element.initial}`,
    `setup=${element.setup}`,
    `tphl=${element.tphl}`,
    `tplh=${element.tplh}`,
  ].join(':');
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
  /**
   * Nets that leave the circuit through a port. A net driven by a pattern and read by
   * no *element* is still an output when the sheet exports it — without this, the sum
   * of a full adder, which nothing else on the sheet reads, would not count as one.
   */
  isPortNet: Uint8Array;
}

export function adjacency(graph: LogicGraph): Adjacency {
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
  const isPortNet = new Uint8Array(netCount);
  for (const node of graph.inputs ?? []) if (node >= 0 && node < netCount) isPortNet[node] = 1;
  for (const node of graph.outputs ?? []) if (node >= 0 && node < netCount) isPortNet[node] = 1;
  return { driverOfNet, consumersOfNet, instanceOfElement, paths, refs, depths, isPortNet };
}

/**
 * Colour elements by refinement.
 *
 * Round 0 is what the element is. Each later round folds in the colours of what
 * drives it and what it drives, so after `rounds` two elements have the same colour
 * only if their neighbourhoods to that distance look the same.
 */
export function refineColours(graph: LogicGraph, adj: Adjacency, rounds: number): string[] {
  let colours = graph.elements.map(logicSignature);
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
export function netsReadBy(element: LogicElement): number[] {
  const nets = [...element.inputs, ...element.selects];
  if (element.clk >= 0) nets.push(element.clk);
  if (element.rst >= 0) nets.push(element.rst);
  if (element.enable >= 0) nets.push(element.enable);
  return nets;
}

/** How many distinct nets a set of elements reads from outside itself. */
export function externalInputCount(graph: LogicGraph, adj: Adjacency, members: Set<number>): number {
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
export function coneOf(graph: LogicGraph, adj: Adjacency, root: number, depth: number, maxInputs: number, maxSize: number, slack = 1): number[] {
  const seen = new Set<number>([root]);
  const distance = new Map<number, number>([[root, 0]]);
  // Elements admitted only because the temporary allowance covered them. They are the
  // first to go when the cone has to shrink, which is what keeps a cone on its own
  // stage instead of walking the carry chain into the previous one.
  const borrowed = new Set<number>();
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
          const width = externalInputCount(graph, adj, seen);
          if (width > maxInputs + slack) {
            seen.delete(driver);
            continue;
          }
          if (width > maxInputs) borrowed.add(driver);
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
  return pruneToBudget(graph, adj, seen, distance, borrowed, root, maxInputs);
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
export function pruneToBudget(
  graph: LogicGraph,
  adj: Adjacency,
  seen: Set<number>,
  distance: Map<number, number>,
  borrowed: Set<number>,
  root: number,
  maxInputs: number,
): number[] {
  const members = new Set(seen);
  const dropped = new Set(borrowed);
  let guard = members.size + 1;
  while (members.size > 1 && externalInputCount(graph, adj, members) > maxInputs && guard-- > 0) {
    let victim = -1;
    let victimBorrowed = false;
    let victimDistance = -1;
    for (const index of members) {
      if (index === root) continue;
      const isBorrowed = dropped.has(index);
      const d = distance.get(index) ?? 0;
      const better =
        victim < 0 ||
        (isBorrowed && !victimBorrowed) ||
        (isBorrowed === victimBorrowed && d > victimDistance) ||
        (isBorrowed === victimBorrowed && d === victimDistance && index > victim);
      if (better) {
        victim = index;
        victimBorrowed = isBorrowed;
        victimDistance = d;
      }
    }
    if (victim < 0) break;
    members.delete(victim);
  }
  return [...members].sort((a, b) => a - b);
}

/**
 * A canonical description of a cone: which element plays which role, and what feeds
 * each of its inputs — another element of the cone, or the k-th net from outside.
 *
 * The labels used are refined **inside the cone only**: an element outside is `ext`,
 * whatever it is. That is what makes the form portable. A global refinement would
 * encode the neighbourhood beyond the cone, and in a ripple chain no two stages have
 * the same neighbourhood — stage 0's carry-in is a port and stage 7's carry-out is a
 * port, so every stage would hash differently and an eight-stage adder would report
 * eight patterns of one occurrence instead of one pattern of eight.
 *
 * Members are ordered by label rather than by index, so the form does not depend on
 * where in the netlist a copy happens to sit. External nets are numbered in the order
 * they are met walking that ordering, which gives every occurrence the same port order
 * — the order the behaviour is measured in, and the order a replacement wires by.
 */
export function canonicalCone(graph: LogicGraph, adj: Adjacency, cone: number[]): { key: string; externalInputs: number[]; outputs: number[] } {
  const members = new Set(cone);
  const driverOf = (net: number): number => (net >= 0 && net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1);
  const symmetric = (element: LogicElement): boolean => element.kind === 'gate' && SYMMETRIC.has(element.fn);

  let label = new Map<number, string>();
  for (const index of cone) {
    const element = graph.elements[index];
    label.set(index, logicSignature(element));
  }
  for (let round = 0; round < 3; round++) {
    const next = new Map<number, string>();
    for (const index of cone) {
      const element = graph.elements[index];
      const fanin = netsReadBy(element).map((net, slot) => {
        const driver = driverOf(net);
        return `${slot}:${driver >= 0 && members.has(driver) ? label.get(driver) : 'ext'}`;
      });
      const fanout: string[] = [];
      for (const out of element.outputs) {
        if (out < 0 || out >= adj.consumersOfNet.length) continue;
        for (const consumer of adj.consumersOfNet[out]) fanout.push(members.has(consumer) ? label.get(consumer) ?? 'ext' : 'ext');
      }
      next.set(index, hash(`${label.get(index)}|${symmetric(element) ? [...fanin].sort().join(',') : fanin.join(',')}|${[...fanout].sort().join(',')}`));
    }
    label = next;
  }

  const order = [...cone].sort((a, b) => {
    const la = label.get(a) ?? '';
    const lb = label.get(b) ?? '';
    return la < lb ? -1 : la > lb ? 1 : a - b;
  });
  const slotOf = new Map<number, number>();
  order.forEach((index, i) => slotOf.set(index, i));

  const external: number[] = [];
  const externalSlot = new Map<number, number>();
  const parts: string[] = [];
  for (const index of order) {
    const element = graph.elements[index];
    const encoded = netsReadBy(element).map((net, slot) => {
      const driver = driverOf(net);
      if (driver >= 0 && members.has(driver)) return `${slot}>${label.get(driver)}`;
      if (net < 0) return `${slot}>none`;
      if (!externalSlot.has(net)) {
        externalSlot.set(net, external.length);
        external.push(net);
      }
      return `${slot}>x${externalSlot.get(net)}`;
    });
    const body = symmetric(element) ? [...encoded].sort().join(' ') : encoded.join(' ');
    parts.push(`${label.get(index)}:${fnName(element)}[${body}]`);
  }
  void slotOf;
  return { key: parts.join('|'), externalInputs: external, outputs: patternOutputs(graph, adj, members) };
}

/**
 * The nets a set of elements reads from outside itself — its ports as an input.
 *
 * Ordered by the element that reads them and then by net, so two equal structures
 * produce the same order and the same canonical form.
 */
export function patternInputs(graph: LogicGraph, adj: Adjacency, members: Set<number> | number[]): number[] {
  const inside = members instanceof Set ? members : new Set(members);
  const order = [...inside].sort((a, b) => a - b);
  const external: number[] = [];
  for (const index of order) {
    const element = graph.elements[index];
    if (!element) continue;
    for (const net of netsReadBy(element)) {
      if (net < 0 || external.includes(net)) continue;
      const driver = net < adj.driverOfNet.length ? adj.driverOfNet[net] : -1;
      if (driver < 0 || !inside.has(driver)) external.push(net);
    }
  }
  return external;
}

/**
 * The nets a set of elements drives that something outside the set reads, plus the
 * nets the sheet exports as ports.
 *
 * Computed from the member set rather than accumulated from the cones it was built
 * from, because a net that is an output of one cone can be internal to their union:
 * the shared `x1` of a full adder is an output of the sum cone and of the carry cone
 * taken separately, and internal to the adder.
 */
export function patternOutputs(graph: LogicGraph, adj: Adjacency, members: Set<number> | number[]): number[] {
  const inside = members instanceof Set ? members : new Set(members);
  const outputs: number[] = [];
  for (const index of inside) {
    const element = graph.elements[index];
    if (!element) continue;
    for (const out of element.outputs) {
      if (out < 0 || out >= adj.consumersOfNet.length) continue;
      if (outputs.includes(out)) continue;
      const readOutside = adj.consumersOfNet[out].some((c) => !inside.has(c));
      if (readOutside || adj.isPortNet[out] === 1) outputs.push(out);
    }
  }
  return outputs.sort((a, b) => a - b);
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
  // One is allowed and means something different: with `minOccurrences: 1` the report
  // lists blocks worth turning into a chip, not just blocks worth de-duplicating.
  const minOccurrences = Math.max(1, Math.round(options.minOccurrences ?? 2));
  const maxPatterns = Math.max(1, Math.round(options.maxPatterns ?? 24));
  const measure = options.measure !== false;
  const requestedMatchChips = options.matchChips !== false;
  const matchChips = measure && requestedMatchChips;
  const notes: string[] = [];
  if (!measure && requestedMatchChips) notes.push('chip matching was skipped because measurement is disabled: a match is measured behaviour, not a structural guess.');
  const requestedMaxInputs = Number.isFinite(options.maxMeasuredInputs) ? Math.round(options.maxMeasuredInputs!) : 5;
  // The L0 engine settles 32 truth-table lanes at once. More than five input bits
  // cannot be called exhaustive by this bit-parallel measurement routine.
  const maxInputs = Math.min(5, Math.max(1, requestedMaxInputs));
  if (requestedMaxInputs > 5) notes.push(`maxMeasuredInputs ${requestedMaxInputs} was capped at 5: the L0 truth-table engine settles 32 input combinations at once; larger blocks are reported NOT MEASURED rather than sampled and called exhaustive.`);
  const maxPatternInputs = Math.max(1, Math.round(options.maxPatternInputs ?? 5));
  const maxPatternSize = Math.max(2, Math.round(options.maxPatternSize ?? 12));
  const coneSlack = Math.max(0, Math.round(options.coneSlack ?? 1));
  const mergeOutputs = options.mergeOutputs !== false;

  // Expansion is deliberately off, and there is no option to turn it on: mining reads
  // the logic graph, and a gate expanded into its CMOS network contributes transistors
  // instead of a logic element, so expanding would delete the very subject of the
  // analysis. Transistor-level detail is a different question, answered by the
  // electrical solver, not by this module.
  const netlist = flatten(circuit, lib, chips ?? new ChipLibrary(), {
    expandGates: false,
    ambient: options.ambient ?? 25,
    metadata: true,
  });
  const graph = buildLogicGraph(netlist);
  const adj = adjacency(graph);

  if (graph.elements.length === 0) {
    notes.push(
      'The flattened circuit contains no logic elements, so there is nothing to mine at this layer: it is either purely analogue (resistors, sources, diodes, transistors) or every gate in it was expanded into a transistor network. Mining reads the logic graph; transistor-level detail is the electrical solver\'s subject, not this module\'s.',
    );
  }

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
  let notedSequentialMeasurement = false;

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
    const sequentialCount = elements.reduce((count, index) => count + (isSequential(graph.elements[index]) ? 1 : 0), 0);
    const behaviour = !sim
      ? null
      : sequentialCount > 0
        ? {
            inputs: externalInputs.length,
            outputs: outputs.length,
            rows: [],
            complete: false,
            lanes: 0,
            measured: false,
            reason: `${sequentialCount} DFF/latch element(s) require clock transitions; a level-0 settle alone only samples the current state, so their behaviour is not measured.`,
          }
        : measureBehaviour(sim, graph, externalInputs, outputs, maxInputs);
    if (sequentialCount > 0 && !notedSequentialMeasurement) {
      notedSequentialMeasurement = true;
      notes.push('sequential patterns are reported structurally but not measured, matched, extracted or replaced: the current level-0 miner does not exercise clock transitions.');
    }
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
      // A single-element cone is kept as a merge candidate but never reported on its
      // own: one gate is not a subcircuit. It has to stay a candidate, because two
      // single-gate cones over the same inputs *are* a block — an XOR and an AND over
      // a and b are a half adder, and the library has a chip for exactly that.
      const canonical = canonicalCone(graph, adj, cone);
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
        // Inputs and outputs are recomputed over the union: a net that is an output
        // of one cone can be internal to the merged pattern, and a merged pattern's
        // ports are what the block it describes would actually have.
        const record = {
          roots: first.map((c) => c.root),
          elements: union,
          externalInputs: patternInputs(graph, adj, union),
          outputs: patternOutputs(graph, adj, union),
          from: form.split('+'),
        };
        // One record per occurrence, so the pattern reports how often it really occurs.
        const records = occurrencesOfForm.map((cones) => {
          const elements = [...new Set(cones.flatMap((c) => c.elements))].sort((a, b) => a - b);
          return {
            roots: cones.map((c) => c.root),
            elements,
            externalInputs: patternInputs(graph, adj, elements),
            outputs: patternOutputs(graph, adj, elements),
            from: form.split('+'),
          };
        });
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
      if (first.elements.length < 2) continue;
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
  const containment = markSubBlocks(patterns);
  if (containment.cutShort) {
    notes.push(`Containment labelling stopped after ${containment.tests} comparison(s): some patterns may be sub-blocks of a larger one without being marked. Nothing reported is wrong, only possibly less organised.`);
  }
  const kept = patterns.slice(0, maxPatterns);
  if (patterns.length > kept.length) notes.push(`${patterns.length - kept.length} further pattern(s) were found and are not listed; raise maxPatterns to see them.`);

  notes.unshift(
    `Grew ${conesExamined} fan-in cone(s) up to depth ${depth}, bounded at ${maxPatternInputs} external input(s) and ${maxPatternSize} element(s); ${distinctForms.size} distinct form(s), of which ${kept.length} ${minOccurrences === 1 ? 'appear at least once' : `repeat at least ${minOccurrences} time(s)`}.`,
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
  for (const chip of chips.all()) {
    const entry = matchOneChip(chip, lib, chips, behaviour);
    if (!entry) continue;
    if (entry.identical) return entry;
    if (!best || entry.differingRows! < best.differingRows!) best = entry;
  }
  if (best && !best.identical) {
    notes.push(`the closest chip to a pattern was ${best.name} with ${best.differingRows} differing row(s); it is reported as a near match, not as a suggestion to substitute.`);
  }
  return best;
}

/** Compare one specific chip with a measured pattern, including port permutations. */
function matchOneChip(chip: Chip, lib: Library, chips: ChipLibrary, behaviour: PatternBehaviour): MatchedChip | null {
  const candidate = chipBehaviour(chip, lib, chips, behaviour.inputs, behaviour.outputs);
  if (!candidate?.measured || !candidate.complete || candidate.rows.length !== behaviour.rows.length) return null;
  const inputPerms = behaviour.inputs <= 5 ? permutations(behaviour.inputs) : [[...Array(behaviour.inputs).keys()]];
  const outputPerms = behaviour.outputs <= 4 ? permutations(behaviour.outputs) : [[...Array(behaviour.outputs).keys()]];
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
  return {
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
}

const chipBehaviourCache = new Map<string, PatternBehaviour | null>();

/** Measure a chip's own behaviour, the same way a pattern is measured. */
function chipBehaviour(chip: Chip, lib: Library, chips: ChipLibrary, inputs: number, outputs: number): PatternBehaviour | null {
  const ports = chip.def.ports ?? [];
  const chipInputs = ports.filter((p) => p.direction === 'input' && (p.width ?? 1) === 1);
  const chipOutputs = ports.filter((p) => p.direction === 'output' && (p.width ?? 1) === 1);
  if (chipInputs.length !== inputs || chipOutputs.length !== outputs) return null;
  const cacheKey = `${chip.def.id}@${chip.def.version}:${chip.fingerprint(chip.defaultParams())}:${inputs}x${outputs}`;
  if (chipBehaviourCache.has(cacheKey)) return chipBehaviourCache.get(cacheKey) ?? null;
  let behaviour: PatternBehaviour | null = null;
  try {
    const implementation = chip.implementation(chip.defaultParams());
    const netlist = flatten(implementation, lib, chips, { metadata: true });
    const graph = buildLogicGraph(netlist);
    // A single settle does not exercise a DFF edge or latch transparency. Returning
    // a static snapshot here could match a different state machine with the same
    // power-on value, so sequential chips are deliberately ineligible for a mined
    // behaviour match until the miner has a clocked equivalence procedure.
    if (graph.elements.some(isSequential)) {
      behaviour = null;
    } else {
      const sim = new LogicVectorSim(graph, { loopIterations: 8 });
      const inputNets = graph.inputs.slice(0, inputs);
      const outputNets = graph.outputs.slice(0, outputs);
      if (inputNets.length === inputs && outputNets.length === outputs) {
        behaviour = measureBehaviour(sim, graph, inputNets, outputNets, Math.max(inputs, 5));
      }
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
  /**
   * Chip to instantiate. Defaults to the chip the pattern matched, if it matched one.
   * Whichever id is selected, the chip is measured against the pattern before any edit;
   * an explicit override cannot bypass the identity check.
   */
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
  const patternBehaviour = pattern.behaviour;
  if (!patternBehaviour?.measured || !patternBehaviour.complete) {
    return refuse(
      circuit,
      chipId,
      before,
      pattern,
      'the pattern has no exhaustive measured truth table, so a replacement cannot be verified',
      notes,
      'Run mining with measurement enabled and no more than five external inputs. Structural resemblance alone is never enough to substitute a chip.',
    );
  }
  const chipMatch = matchOneChip(chip, lib, chips, patternBehaviour);
  if (!chipMatch) {
    return refuse(
      circuit,
      chipId,
      before,
      pattern,
      `${chipId} could not be measured against the pattern`,
      notes,
      'A replacement is made only after both blocks are exhaustively measured at level 0. Check the chip implementation, its dependencies and the declared port widths.',
    );
  }
  if (!chipMatch.identical) {
    return refuse(
      circuit,
      chipId,
      before,
      pattern,
      `${chipId} differs from the pattern on ${chipMatch.differingRows ?? '?'} of ${patternBehaviour.rows.length} measured row(s)`,
      notes,
      'Near matches are reported, never substituted: choose a chip whose measured truth table is identical, or correct the block before replacing it.',
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
    const inPerm = chipMatch.inputPermutation;
    const outPerm = chipMatch.outputPermutation;
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

function refuse(
  circuit: Circuit,
  chipId: string,
  before: { components: number; nets: number },
  pattern: SubcircuitPattern,
  reason: string,
  notes: string[],
  hint?: string,
): ReplaceResult {
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
    diagnostics: [error('CF8024', reason, hint ? { hint } : undefined)],
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
/**
 * Label the patterns that are sub-blocks of a larger reported pattern.
 *
 * The test is containment of *occurrences*, not of shapes: every occurrence of the
 * smaller pattern has to sit inside some occurrence of the larger one. Two patterns can
 * describe the same gates in different places and neither contains the other, and a
 * half adder that is not part of any reported full adder is a finding in its own right.
 *
 * Candidate occurrences are found through an index from element to the occurrences that
 * contain it, so the cost follows the number of elements actually shared rather than the
 * product of the two occurrence counts — a sheet with thousands of repetitions stays
 * cheap to label.
 */
export function markSubBlocks(patterns: SubcircuitPattern[], testBudget = 2_000_000): { tests: number; cutShort: boolean } {
  const occurrenceSets = patterns.map((p) => p.occurrences.map((o) => new Set(o.elements)));
  const indexOf = patterns.map((p) => {
    const index = new Map<number, number[]>();
    p.occurrences.forEach((o, i) => {
      for (const e of o.elements) {
        const list = index.get(e);
        if (list) list.push(i);
        else index.set(e, [i]);
      }
    });
    return index;
  });

  let tests = 0;
  let cutShort = false;
  for (let i = 0; i < patterns.length && !cutShort; i++) {
    const small = patterns[i];
    if (small.occurrences.length === 0) continue;
    for (let j = 0; j < patterns.length; j++) {
      if (i === j) continue;
      const large = patterns[j];
      if (large.size <= small.size) continue;
      const sets = occurrenceSets[j];
      const index = indexOf[j];
      let contained = true;
      for (const candidate of occurrenceSets[i]) {
        let probe = -1;
        for (const e of candidate) {
          probe = e;
          break;
        }
        const hits = index.get(probe);
        if (!hits) {
          contained = false;
          break;
        }
        let found = false;
        for (const k of hits) {
          if (++tests > testBudget) {
            // Labelling is a convenience, not a result: it is worth less than a report
            // that takes seconds. Stop and say that some patterns were not compared.
            cutShort = true;
            break;
          }
          const superset = sets[k];
          let inside = true;
          for (const e of candidate) if (!superset.has(e)) { inside = false; break; }
          if (inside) { found = true; break; }
        }
        if (cutShort) break;
        if (!found) {
          contained = false;
          break;
        }
      }
      if (contained) {
        small.subBlockOf = large.id;
        break;
      }
    }
    if (cutShort) break;
  }
  return { tests, cutShort };
}

export interface ExtractOptions {
  /** Library id for the new chip. Defaults to the pattern's own suggestion. */
  chipId?: string;
  /** Display name. Defaults to the suggested name, or the id in capitals. */
  name?: string;
  description?: string;
  /**
   * Which occurrence becomes the implementation. Defaults to the first one that is on
   * the mined sheet, because that is the only kind that can be copied from here.
   */
  occurrence?: number;
  /** Widest input space to measure the new chip over (default 5, as in the search). */
  maxMeasuredInputs?: number;
}

export interface ExtractResult {
  chipId: string;
  /** The registered chip, or null when the extraction was refused. */
  chip: Chip | null;
  /** The circuit the chip implements, or null when the extraction was refused. */
  implementation: Circuit | null;
  /** What the implementation was measured to compute, in the pattern's port order. */
  measured: PatternBehaviour | null;
  /** True when that is row-for-row what the pattern was measured to compute. */
  identical: boolean;
  /** Rows that differ, or -1 when the comparison could not be made. */
  differingRows: number;
  diagnostics: Diagnostic[];
  notes: string[];
}

/**
 * Turn one occurrence of a mined pattern into a chip of its own, and register it.
 *
 * This is the other half of de-duplication. Matching against the library only helps when
 * somebody already wrote a chip for the block a design repeats; most of the time nobody
 * has, and the report can only say what a new chip would be called. Extraction builds it:
 * the components of one occurrence are copied into a new circuit, the nets that crossed
 * the block's boundary become its ports, and the result is registered in both libraries
 * so it can be instantiated, expanded, validated and saved like any other chip.
 *
 * Two rules keep this honest. The ports are declared in the pattern's canonical order —
 * the order `replacePatternWithChip` wires in — so extracting and then replacing produces
 * the circuit that was measured, not a permutation of it. And the new chip is *measured
 * after it is built*, by the same procedure that measured the pattern: if the rows do not
 * match, nothing is registered and the result says how many rows differ. A chip is a
 * promise about behaviour, so it is checked before it is kept, not after.
 */
export function extractPatternAsChip(
  circuit: Circuit,
  lib: Library,
  chips: ChipLibrary,
  pattern: SubcircuitPattern,
  options: ExtractOptions = {},
): ExtractResult {
  const notes: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const requestedId = sanitizeChipId(options.chipId ?? pattern.suggestedChip?.id ?? `pattern_${pattern.id}`);
  const requestedName = options.name?.trim() || pattern.suggestedChip?.name || requestedId.toUpperCase();
  const requestedMaxInputs = Number.isFinite(options.maxMeasuredInputs) ? Math.round(options.maxMeasuredInputs!) : 5;
  const maxInputs = Math.min(5, Math.max(1, requestedMaxInputs));
  if (requestedMaxInputs > 5) notes.push(`maxMeasuredInputs ${requestedMaxInputs} was capped at 5: this L0 truth-table measurement is exhaustive only up to 32 combinations.`);

  const refuse = (message: string, hint?: string): ExtractResult => {
    diagnostics.push(error('CF8021', message, hint ? { hint } : undefined));
    notes.push(`nothing was extracted: ${message}`);
    return {
      chipId: requestedId,
      chip: null,
      implementation: null,
      measured: null,
      identical: false,
      differingRows: -1,
      diagnostics,
      notes,
    };
  };

  const expected = pattern.behaviour;
  if (!expected || !expected.measured) {
    return refuse(
      'this pattern was not measured, so an extracted chip could not be checked against it',
      'Run the search with measurement on (the default). An extraction is registered only once its implementation has been measured to compute what the pattern was measured to compute.',
    );
  }
  if (!expected.complete) {
    return refuse(
      'the pattern has only a partial measurement, which is not enough to verify a new chip',
      'An extracted chip is registered only when the full truth table is measured. Reduce its number of inputs, or extend the measurement engine before asking for a sampled extraction.',
    );
  }

  const defaultOccurrence = options.occurrence === undefined;
  const index = defaultOccurrence
    ? pattern.occurrences.findIndex((o) => o.onSheet)
    : Number.isFinite(options.occurrence)
      ? Math.floor(options.occurrence!)
      : -1;
  if (!defaultOccurrence && (index < 0 || index >= pattern.occurrences.length)) {
    return refuse(
      `occurrence index ${String(options.occurrence)} is outside this pattern's ${pattern.occurrences.length} occurrence(s)`,
      'Use a zero-based index printed in the report, or omit occurrence to take the first one on this sheet.',
    );
  }
  if (defaultOccurrence && index < 0) {
    return refuse(
      pattern.occurrences.length > 0
        ? `every occurrence of this pattern lives inside a chip expansion (${pattern.occurrences[0]?.paths[0] ?? '?'}), not on this sheet`
        : 'this pattern has no occurrences',
      'Open the sheet that holds those components and extract from there: a chip is built from components, not from the insides of another chip.',
    );
  }
  const occurrence = pattern.occurrences[index];
  if (!occurrence) return refuse(`this pattern has no occurrence #${index}`);
  if (!occurrence.onSheet) {
    return refuse(
      `occurrence #${index} lives inside a chip expansion (${occurrence.paths[0] ?? '?'}), not on this sheet`,
      'Open the sheet that holds those components and extract from there: a chip is built from components, not from the insides of another chip.',
    );
  }

  const byRef = new Map<string, ComponentInstance>();
  for (const component of circuit.allComponents()) byRef.set(component.ref, component);
  const victims = occurrence.refs.map((ref) => byRef.get(ref));
  const missing = occurrence.refs.filter((_, i) => victims[i] === undefined);
  if (missing.length > 0) {
    return refuse(`the component(s) ${missing.join(', ')} are not on this sheet`, 'The sheet changed since the search was run; search again.');
  }

  // ---- the implementation ---------------------------------------------------
  //
  // Net names are carried over as they are: the nets that crossed the boundary become
  // ports bound to a net of the same name, and the nets that stayed inside stay inside.
  // Keeping the names is what makes the extracted chip readable next to the sheet it
  // came from, and what makes the port order below the pattern's own order.
  const builder = new CircuitBuilder(lib, requestedName, chips);
  const usedPortNames = new Set<string>();
  const portNameFor = (netName: string, fallback: string): string => {
    const base = netName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || fallback;
    let candidate = base;
    let n = 2;
    while (usedPortNames.has(candidate)) candidate = `${base}_${n++}`;
    usedPortNames.add(candidate);
    return candidate;
  };
  const inputPorts = occurrence.externalInputNames.map((netName, i) => {
    const net = findNet(circuit, netName);
    const portName = portNameFor(netName, `I${i}`);
    builder.port(portName, 'input', netName, net?.width ?? 1);
    return portName;
  });
  const outputPorts = occurrence.outputNames.map((netName, i) => {
    const net = findNet(circuit, netName);
    const portName = portNameFor(netName, `O${i}`);
    builder.port(portName, 'output', netName, net?.width ?? 1);
    return portName;
  });

  for (let i = 0; i < occurrence.refs.length; i++) {
    const source = victims[i] as ComponentInstance;
    const spec = lib.get(source.specId);
    if (!spec) {
      return refuse(`${source.ref} is a "${source.specId}", which the component library does not know`, 'The library that mined this circuit is not the one the component was placed from.');
    }
    const instance = builder.add(
      source.specId,
      { ...(source.params ?? {}) },
      { x: source.x, y: source.y },
      { bits: source.bits, rotation: (source.rotation ?? 0) as 0 | 90 | 180 | 270, chipRef: source.chipRef },
    );
    for (const pin of spec.pins) {
      const net = circuit.netOf(source.id, pin.name);
      if (net) builder.at(instance, pin.name, net.name, net.width);
    }
  }
  const implementation = builder.finish({ erc: false });

  const erc = implementation.erc(lib, chips);
  for (const d of erc) diagnostics.push(d);
  const ercErrors = erc.filter((d) => d.severity === 'error');
  if (ercErrors.length > 0) {
    return refuse(
      `the extracted sheet has ${ercErrors.length} ERC error(s), the first being ${ercErrors[0].code}: ${ercErrors[0].message}`,
      'A chip is a promise other sheets will rely on, so one that does not pass its own electrical rules check is not registered. Fix the source block, or extract a different occurrence.',
    );
  }

  // ---- measure what was just built, the way the pattern was measured --------
  const netlist = flatten(implementation, lib, chips, { expandGates: false, metadata: true });
  const graph = buildLogicGraph(netlist);
  const sequentialCount = graph.elements.filter(isSequential).length;
  if (sequentialCount > 0) {
    return refuse(
      `the extracted implementation contains ${sequentialCount} sequential element(s), whose behaviour cannot be proven by a single level-0 settle`,
      'Nothing was registered. A verified sequential chip needs clocked state-space or temporal equivalence testing; this miner currently verifies combinational truth tables only.',
    );
  }
  const nodeByName = (candidates: number[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const node of candidates) map.set(graph.netName(node), node);
    return map;
  };
  const inputsByName = nodeByName(graph.inputs);
  const outputsByName = nodeByName(graph.outputs);
  const inNodes = occurrence.externalInputNames.map((n) => inputsByName.get(n) ?? -1);
  const outNodes = occurrence.outputNames.map((n) => outputsByName.get(n) ?? -1);
  if (inNodes.some((n) => n < 0) || outNodes.some((n) => n < 0)) {
    return refuse(
      'the extracted chip does not expose every net the pattern reads and drives as a port of its own',
      'This usually means a net name is shared with something else on the sheet; extract a different occurrence or rename the net.',
    );
  }
  const sim = new LogicVectorSim(graph, { loopIterations: 8 });
  const measured = measureBehaviour(sim, graph, inNodes, outNodes, maxInputs);
  if (!measured.measured) {
    return refuse(`the extracted chip could not be simulated: ${measured.reason ?? 'unknown reason'}`);
  }
  if (!measured.complete) {
    return refuse(
      'the extracted chip was not exhaustively measured, so it cannot be verified against the pattern',
      'Nothing was registered. Exhaustive verification is the gate that separates an extracted component block from an asserted chip behaviour.',
    );
  }
  let differingRows = 0;
  const rows = Math.min(expected.rows.length, measured.rows.length);
  for (let k = 0; k < rows; k++) if (expected.rows[k] !== measured.rows[k]) differingRows++;
  if (expected.rows.length !== measured.rows.length) differingRows += Math.abs(expected.rows.length - measured.rows.length);
  if (differingRows > 0) {
    return refuse(
      `the extracted implementation differs from the pattern on ${differingRows} of ${Math.max(expected.rows.length, measured.rows.length)} measured row(s)`,
      'Nothing was registered. This should not happen — the block was copied component for component — so treat it as a bug report: the pattern, the occurrence and both truth tables are in the result.',
    );
  }

  // ---- register -------------------------------------------------------------
  const identity = freeChipIdentity(lib, chips, requestedId, requestedName, notes);
  const chipId = identity.id;
  const description =
    options.description ??
    `Extracted from "${circuit.name}": ${pattern.description}, ${pattern.size} element(s), ${occurrence.refs.length} component(s). Measured identical to the block it was cut from over ${measured.rows.length} input combination(s), exhaustively.`;
  const chip = makeChip({
    id: chipId,
    name: identity.name,
    description,
    circuit: implementation,
    tags: ['mined', 'extracted'],
    notes: `pattern ${pattern.id}, occurrence #${index}, source circuit "${circuit.name}".`,
  });
  registerChip(lib, chips, chip);

  notes.push(`extracted ${occurrence.refs.length} component(s) into chip "${chipId}" v${chip.def.version} with ${chip.def.ports.length} port(s): ${inputPorts.join(', ')} in, ${outputPorts.join(', ')} out.`);
  notes.push(
    `the implementation was re-measured after the copy and reproduces the pattern over ${measured.rows.length} combination(s)${measured.complete ? ' exhaustively' : ' (sampled: more inputs than the measurement budget)'}.`,
  );
  const others = pattern.saving.replaceable - 1;
  if (others > 0) notes.push(`${others} other occurrence(s) are on this sheet and can now be replaced with it.`);
  if (erc.length > 0) diagnostics.push(info('CF8022', `the extracted chip carries ${erc.length} ERC note(s), none of them an error`));
  if (pattern.count > pattern.saving.replaceable) {
    diagnostics.push(
      warn('CF8023', `${pattern.count - pattern.saving.replaceable} occurrence(s) of this pattern live inside chip expansions and were not candidates for extraction from this sheet`),
    );
  }

  return { chipId, chip, implementation, measured, identical: true, differingRows: 0, diagnostics, notes };
}

/** Choose a free id and display name; never overwrite a component or a chip by accident. */
function freeChipIdentity(
  lib: Library,
  chips: ChipLibrary,
  wantedId: string,
  wantedName: string,
  notes: string[],
): { id: string; name: string } {
  let id = wantedId;
  if (chips.has(id) || lib.has(id)) {
    let n = 2;
    while (chips.has(`${wantedId}_${n}`) || lib.has(`${wantedId}_${n}`)) n++;
    id = `${wantedId}_${n}`;
    notes.push(`"${wantedId}" is already used by a component or chip, so the extracted chip id is "${id}".`);
  }

  const baseName = wantedName.trim() || id.toUpperCase();
  let name = baseName;
  if (chips.has(name)) {
    let n = 2;
    while (chips.has(`${baseName} (${n})`)) n++;
    name = `${baseName} (${n})`;
    notes.push(`the display name "${baseName}" is already used by a chip, so the extracted chip is named "${name}".`);
  }
  return { id, name };
}

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
    if (pattern.subBlockOf) {
      lines.push(`  sub-block of [${pattern.subBlockOf}]: every occurrence sits inside that larger pattern, so replacing this one first would break it`);
    }
    lines.push(`  replacing all ${pattern.saving.replaceable} replaceable occurrence(s) would remove about ${pattern.saving.componentsTotal} component(s)`);
  }
  lines.push('');
  lines.push('Scope:');
  for (const note of report.notes) lines.push(`  - ${note}`);
  return lines.join('\n');
}

/**
 * What the miner sees, for inspection and for tests.
 *
 * The report describes patterns; this describes the cones the patterns were grown
 * from, which is the part that decides whether a full adder comes out as one block or
 * as two fragments. Exposed because a heuristic that cannot be looked at cannot be
 * argued with.
 */
export function inspectCones(circuit: Circuit, lib: Library, chips?: ChipLibrary, options: MiningOptions = {}): Array<{
  root: number;
  rootName: string;
  cone: number[];
  coneNames: string[];
  externalInputs: number[];
  externalInputNames: string[];
  outputs: number[];
  outputNames: string[];
  key: string;
}> {
  const depth = Math.max(1, Math.round(options.depth ?? 3));
  const budget = Math.max(1, Math.round(options.maxPatternInputs ?? 5));
  const maxSize = Math.max(2, Math.round(options.maxPatternSize ?? 12));
  const slack = Math.max(0, Math.round(options.coneSlack ?? 1));
  const netlist = flatten(circuit, lib, chips ?? new ChipLibrary(), { metadata: true });
  const graph = buildLogicGraph(netlist);
  const adj = adjacency(graph);
  const nameOf = (elementIndex: number): string => {
    const element = graph.elements[elementIndex];
    const instance = adj.instanceOfElement[element.element];
    const where = instance >= 0 ? adj.paths[instance] : `#${element.element}`;
    return `${where}:${fnName(element)}`;
  };
  const out = [];
  for (const element of graph.elements) {
    const cone = coneOf(graph, adj, element.index, depth, budget, maxSize, slack);
    const canonical = canonicalCone(graph, adj, cone);
    out.push({
      root: element.index,
      rootName: nameOf(element.index),
      cone,
      coneNames: cone.map(nameOf),
      externalInputs: canonical.externalInputs,
      externalInputNames: canonical.externalInputs.map((n) => graph.netName(n)),
      outputs: canonical.outputs,
      outputNames: canonical.outputs.map((n) => graph.netName(n)),
      key: canonical.key,
    });
  }
  return out;
}
