/**
 * Circuit simulator: DC operating point, transient analysis, and the Newton loop.
 *
 * Honesty notes that matter for using the results:
 *   - If Newton converges, the reported solution satisfies the discretised
 *     equations; the *discretisation* error is controlled by the LTE-based time
 *     step controller and the integration scheme (backward Euler by default).
 *   - If Newton does not converge, the solver does NOT return the last iterate as
 *     if it were a solution: it reports failure with the failing nodes and the
 *     number of iterations, and the caller decides.
 *   - gmin is a numerical aid. Every result that required gmin > the requested
 *     value is flagged, because gmin adds a physical shunt conductance that is
 *     not part of the circuit.
 */

import type { FlatNetlist } from './netlist.js';
import { SparseMatrix, DenseLu } from './matrix.js';
import { stampElement, recordElementState, type SimState } from './elements.js';
import { NODE_STRIDE, SRC_SLOTS, elementThermalNode } from './paramslots.js';
import { Diagnostic, Severity, error, info, warn } from '../core/labels.js';
import { profiler } from '../util/profiler.js';

export type Integration = 'be' | 'trap';

export interface SolverOptions {
  reltol: number;
  vntol: number;
  abstol: number;
  gmin: number;
  maxIterations: number;
  integration: Integration;
  /** LTE control: larger = looser steps. */
  trtol: number;
  /** Maximum number of steps before the transient gives up. */
  maxSteps: number;
  initialStep: number;
  minStep: number;
  maxStep: number;
  /** Use the dense solver for small systems (faster, simpler). */
  denseThreshold: number;
  /** Skip the DC operating point (start from zero). */
  skipInitialDc: boolean;
  /** Temperature used for elements without their own thermal node (°C). */
  ambient: number;
  /** Enable the thermal network (level 3). */
  thermal: boolean;
  /** Maximum outer iterations for the electro-thermal coupling. */
  thermalIterations: number;
  /** Thermal convergence tolerance in °C. */
  thermalTol: number;
  /**
   * Settle the electro-thermal steady state as part of the DC operating point
   * (power → temperature → parameters → power). Off when a caller only wants the
   * ambient-temperature electrical point; a thermal network that never ran is
   * then reported as "not solved", never as 0 °C of self-heating.
   */
  thermalCoupling: boolean;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  reltol: 1e-3,
  vntol: 1e-6,
  abstol: 1e-12,
  gmin: 1e-12,
  maxIterations: 200,
  integration: 'be',
  trtol: 7,
  maxSteps: 1000000,
  initialStep: 0,
  minStep: 1e-18,
  maxStep: 0,
  denseThreshold: 0,
  skipInitialDc: false,
  ambient: 25,
  thermal: true,
  thermalIterations: 20,
  thermalTol: 0.01,
  thermalCoupling: true,
};

export interface ConvergenceReport {
  converged: boolean;
  iterations: number;
  /** Worst voltage residual at the last iteration. */
  worstVoltageError: number;
  /** Node with the worst error (global node index). */
  worstNode: number;
  /** gmin actually used (may be above the requested value). */
  gminUsed: number;
  /** True when source stepping was needed to obtain an answer. */
  usedSourceStepping: boolean;
  usedGminStepping: boolean;
  /** Number of rejected time steps before acceptance (transient only). */
  rejectedSteps: number;
  singular: boolean;
  singularNodes: number[];
  /**
   * Electro-thermal steady state of the same solve, when the netlist has a
   * thermal network (level 3). Absent means "no thermal network in this circuit".
   */
  thermal?: {
    iterations: number;
    /** Worst temperature move of the last thermal iteration (°C). */
    worstTemperatureChange: number;
    converged: boolean;
    /** Hottest junction of the thermal network (°C). */
    maxTemperature: number;
  };
}

export interface TransientRequest {
  key: string;
  kind: 'vnode' | 'vnet' | 'v3' | 'igeneric' | 'ieleme' | 'pelem' | 'temp' | 'logic' | 'time';
  /** Node index, element index, thermal node, or -1. */
  index: number;
  /** Second node for differential / pair measurements. */
  index2?: number;
}

export interface TransientResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  convergence: ConvergenceReport;
  /** Sample times (s). */
  times: Float64Array;
  /** One Float64Array per request, same length as `times`. */
  values: Float64Array[];
  sampleCount: number;
  steps: number;
  rejected: number;
  acceptedSteps: number;
  /**
   * The output grid interval the samples were taken on, or null when every accepted
   * step was sampled.
   */
  outputInterval: number | null;
  /**
   * The time the record was cut short at, or null when it covers `tstop`.
   *
   * A record that stops early is a different measurement from one that does not:
   * an instrument computing a frequency, an RMS or a spectrum over a truncated
   * window would report the numbers for that window while the caller believes they
   * cover the run they asked for. This field is what makes the difference visible.
   */
  truncatedAt: number | null;
  wallMs: number;
  finalVoltages: Float64Array;
  finalCurrents: Float64Array;
  /**
   * Net energy absorbed by each element over the run (J), indexed by element:
   * positive = dissipated/stored, negative = delivered (so a supply that drives
   * a load is negative). The sum over all elements is the energy balance and
   * closes for ideal R/C/L networks; a controlled source with an ideal control
   * port can deliver energy it never absorbed, which is a documented property of
   * that model, not an integration error.
   */
  elementEnergy: Float64Array;
  /** Charge integrated through each source (C) — battery state of charge. */
  elementCharge: Float64Array;
}

// ---------------------------------------------------------------------------

export class CircuitSimulator {
  nl: FlatNetlist;
  opts: SolverOptions;
  matrix: SparseMatrix;
  private dense: DenseLu | null = null;
  rhs: Float64Array;
  v: Float64Array;
  vOld: Float64Array;
  ib: Float64Array;
  ibOld: Float64Array;
  x: Float64Array;
  state: SimState;
  /** Thermal node temperatures (°C). */
  thermalTemp: Float64Array;
  private diagnostics: Diagnostic[] = [];
  private lastGmin = 0;

  constructor(nl: FlatNetlist, options: Partial<SolverOptions> = {}) {
    this.nl = nl;
    this.opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
    // A flattened netlist carries the ambient its thermal network was built for.
    // Unless the caller overrides it, the electrical solve runs at *that*
    // ambient: inheriting a different one (25 vs 27 °C, say) would report every
    // device temperature against a reference the thermal network never used.
    if (options.ambient === undefined && nl.ambient !== undefined) this.opts.ambient = nl.ambient;
    const n = nl.nodeCount - 1; // ground has no row
    const unknown = n + nl.branchCount;
    this.matrix = new SparseMatrix(unknown, 8);
    if (this.opts.denseThreshold > 0 && unknown <= this.opts.denseThreshold) {
      this.dense = new DenseLu(unknown);
    }
    this.rhs = new Float64Array(unknown);
    this.v = new Float64Array(nl.nodeCount);
    this.vOld = new Float64Array(nl.nodeCount);
    this.ib = new Float64Array(Math.max(1, nl.branchCount));
    this.ibOld = new Float64Array(Math.max(1, nl.branchCount));
    this.x = new Float64Array(unknown);
    this.residual = new Float64Array(unknown);
    this.rowScale = new Float64Array(unknown);
    this.thermalTemp = new Float64Array(Math.max(1, nl.thermalNodeCount));
    this.thermalTemp.fill((nl.ambient ?? this.opts.ambient) + 273.15);
    this.state = {
      nl,
      m: this.matrix,
      rhs: this.rhs,
      v: this.v,
      ib: this.ib,
      vOld: this.vOld,
      ibOld: this.ibOld,
      tempEl: new Float64Array(nl.elementCount),
      ambient: this.opts.ambient,
      time: 0,
      dt: 0,
      mode: 'dc',
      integration: this.opts.integration === 'trap' ? 1 : 0,
      gmin: this.opts.gmin,
      elementCurrent: new Float64Array(nl.elementCount),
      elementPower: new Float64Array(nl.elementCount),
      iteration: 0,
      noiseScale: 1,
      useCapacitances: true,
      jacobianOnly: false,
      noLimiting: false,
    };
  }

  /**
   * Return the simulator to the state a *new* transient starts from.
   *
   * `transient()` continues from wherever the previous run left off: it only takes
   * the initial DC operating point when `state.time === 0`. Running a second capture
   * on the same simulator therefore starts at the first run's end time, and if the
   * new `tstop` is not larger the loop body never executes — the caller gets a
   * one-sample record and no error. That is exactly what an instrument does when it
   * captures twice, so the reset is explicit and complete: time, reactive state
   * (capacitor voltages, inductor currents), the thermal network and the solution
   * vectors all go back to "nothing has happened yet".
   */
  resetTransient(): void {
    const nl = this.nl;
    const ambient = nl.ambient ?? this.opts.ambient;
    this.state.time = 0;
    this.state.dt = 0;
    this.state.iteration = 0;
    nl.state.fill(0);
    this.state.tempEl.fill(ambient);
    this.state.elementCurrent.fill(0);
    this.state.elementPower.fill(0);
    this.thermalTemp.fill(ambient + 273.15);
    nl.thermalTemperature.fill(ambient + 273.15);
    this.v.fill(0);
    this.vOld.fill(0);
    this.ib.fill(0);
    this.ibOld.fill(0);
    this.x.fill(0);
    this.lastGmin = 0;
    this.resetDiagnostics();
  }

  /**
   * Temperature (degC) the given element is at: its thermal node when it has one
   * (level 3), otherwise the circuit ambient. This is the temperature the device
   * models were evaluated at, not a separate estimate.
   */
  elementTemperature(e: number): number {
    const nl = this.nl;
    const th = elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params);
    if (th >= 0 && th < nl.thermalNodeCount) return nl.thermalTemperature[th] - 273.15;
    return nl.ambient ?? this.opts.ambient;
  }

  /** Temperature (degC) of a thermal node (level 3), or the ambient. */
  thermalNodeTemperature(node: number): number {
    if (node < 0 || node >= this.nl.thermalNodeCount) return this.nl.ambient ?? this.opts.ambient;
    return this.nl.thermalTemperature[node] - 273.15;
  }

  /** gmin actually used by the last solve (S); compare with `opts.gmin`. */
  gminUsed(): number {
    return this.lastGmin;
  }

  diagnosticsSnapshot(): Diagnostic[] {
    return this.diagnostics;
  }

  /** Debug helper: assemble in the current state and dump the matrix and RHS. */
  debugDump(): { size: number; entries: Array<[number, number, number]>; rhs: number[] } {
    this.assemble();
    const entries: Array<[number, number, number]> = [];
    this.matrix.forEachEntry((r, c, v) => {
      if (v !== 0) entries.push([r, c, v]);
    });
    return { size: this.matrix.size, entries, rhs: Array.from(this.rhs) };
  }

  private resetDiagnostics(): void {
    this.diagnostics = [];
  }

  // -------------------------------------------------------------------------
  // Assembly and solve
  // -------------------------------------------------------------------------

  /** Stamp every element and add gmin to the node diagonals. */
  assemble(): void {
    const nl = this.nl;
    this.matrix.clear();
    this.rhs.fill(0);
    for (let e = 0; e < nl.elementCount; e++) stampElement(this.state, e);
    // Serial (node) resistances: gmin to ground keeps the matrix non-singular
    // for floating sub-circuits. It is a numerical aid, reported when > 1e-9 S.
    const gmin = this.state.gmin;
    if (gmin > 0) {
      const nodeRows = nl.nodeCount - 1;
      for (let r = 0; r < nodeRows; r++) this.matrix.add(r, r, gmin);
    }
  }

  private solveLinear(): boolean {
    if (this.dense) {
      // Transcribe the sparse entries into the dense matrix.
      this.dense.zero();
      this.matrix.forEachEntry((r, c, v) => this.dense!.add(r, c, v));
      if (!this.dense.factorize()) return false;
      return this.dense.solve(this.rhs, this.x);
    }
    if (!this.matrix.factorize({ reuseOrder: true })) return false;
    return this.matrix.solve(this.rhs, this.x);
  }

  private updateSolutionFromX(): void {
    const nl = this.nl;
    for (let node = 1; node < nl.nodeCount; node++) this.v[node] = this.x[node - 1];
    for (let b = 0; b < nl.branchCount; b++) this.ib[b] = this.x[nl.nodeCount - 1 + b];
  }

  /** Scratch vectors for the residual test. */
  private readonly residual: Float64Array;
  private readonly rowScale: Float64Array;
  /** Residual metric of the last residualWorst() call (for reporting). */
  private lastResidual = Infinity;

  /**
   * Relative residual of the nonlinear system at the *current* iterate, in the
   * same dimensionless form as the step-size test (so `< 1` means converged).
   *
   * The matrix is re-stamped at the current solution before the residual is
   * formed, so the companion-model loading reflects the iterate being tested.
   * Node rows are KCL (amps, compared against reltol·rowCurrent + abstol), the
   * branch rows are KVL (volts, compared against reltol·rowVoltage + vntol).
   */
  private residualWorst(): number {
    const nl = this.nl;
    const { reltol, vntol, abstol } = this.opts;
    // Bypass the junction limiters: they belong to the step control, not to the
    // model, and with them active the residual would be measured against the
    // limited voltages and could hide a large mismatch.
    this.state.noLimiting = true;
    try {
      this.assemble();
    } finally {
      this.state.noLimiting = false;
    }
    const n = this.x.length;
    const r = this.residual;
    const scale = this.rowScale;
    r.fill(0);
    scale.fill(0);
    this.matrix.forEachEntry((row, col, value) => {
      if (value === 0) return;
      const t = value * this.x[col];
      r[row] += t;
      scale[row] += Math.abs(t);
    });
    for (let i = 0; i < n; i++) {
      r[i] -= this.rhs[i];
      scale[i] += Math.abs(this.rhs[i]);
    }
    const nodeRows = nl.nodeCount - 1;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const tol = i < nodeRows ? reltol * scale[i] + abstol : reltol * scale[i] + vntol;
      const metric = Math.abs(r[i]) / tol;
      if (metric > worst) worst = metric;
    }
    this.lastResidual = worst;
    return worst;
  }

  /**
   * One Newton–Raphson attempt. Returns the convergence metrics.
   * The caller decides what to do with a failure.
   */
  private newtonOnce(maxIter: number, damping = 1): { converged: boolean; iterations: number; worst: number; worstNode: number; singular: boolean; singularNodes: number[] } {
    const nl = this.nl;
    const { reltol, vntol, abstol } = this.opts;
    let worst = Infinity;
    let worstNode = -1;
    let prevWorst = Infinity;
    let growing = 0;
    let singular = false;
    const singularNodes: number[] = [];

    for (let iter = 0; iter < maxIter; iter++) {
      this.state.iteration = iter;
      this.assemble();
      if (!this.solveLinear()) {
        singular = true;
        if (singularNodes.length < 8) {
          for (let node = 1; node < Math.min(nl.nodeCount, 12) && singularNodes.length < 8; node++) {
            if (!Number.isFinite(this.v[node])) singularNodes.push(node);
          }
        }
        return { converged: false, iterations: iter + 1, worst: Infinity, worstNode: -1, singular, singularNodes };
      }
      // Save the previous iterate for the convergence check.
      this.vOld.set(this.v);
      this.ibOld.set(this.ib);
      this.updateSolutionFromX();

      // Damp the update when the error keeps growing (a simple, documented
      // global damping on top of the device-level limiting).
      if (damping < 1) {
        for (let node = 1; node < nl.nodeCount; node++) this.v[node] = this.vOld[node] + damping * (this.v[node] - this.vOld[node]);
        for (let b = 0; b < nl.branchCount; b++) this.ib[b] = this.ibOld[b] + damping * (this.ib[b] - this.ibOld[b]);
      }

      worst = 0;
      worstNode = -1;
      for (let node = 1; node < nl.nodeCount; node++) {
        const a = this.v[node];
        const b = this.vOld[node];
        if (!Number.isFinite(a)) return { converged: false, iterations: iter + 1, worst: Infinity, worstNode: node, singular: true, singularNodes: [node] };
        const err = Math.abs(a - b) / (reltol * Math.max(Math.abs(a), Math.abs(b)) + vntol);
        if (err > worst) {
          worst = err;
          worstNode = node;
        }
      }
      for (let b = 0; b < nl.branchCount; b++) {
        const a = this.ib[b];
        const p = this.ibOld[b];
        const err = Math.abs(a - p) / (reltol * Math.max(Math.abs(a), Math.abs(p)) + abstol);
        if (err > worst) {
          worst = err;
          worstNode = -1;
        }
      }
      if (worst < 1) {
        // The step-size test alone is not a convergence proof: a device pushed
        // outside its linearisation region (a junction the limiter cannot move,
        // an exponential that has run away) can produce a vanishing step while
        // the node equations are off by orders of magnitude. SPICE therefore
        // also tests the residual of the nonlinear system - here by re-stamping
        // at the candidate iterate and measuring A·x − b, which is exactly the
        // Newton residual (KCL at the nodes, KVL on the branch rows).
        if (this.residualWorst() < 1) {
          return { converged: true, iterations: iter + 1, worst, worstNode, singular: false, singularNodes: [] };
        }
        worst = Math.max(worst, this.lastResidual);
      }
      if (worst >= prevWorst) growing++;
      else growing = 0;
      prevWorst = worst;
      if (growing >= 5) {
        // Switch to damped iteration for the remaining attempts.
        damping = 0.25;
        growing = 0;
      }
    }
    return { converged: false, iterations: maxIter, worst, worstNode, singular: false, singularNodes: [] };
  }

  // -------------------------------------------------------------------------
  // DC operating point
  // -------------------------------------------------------------------------

  /**
   * DC operating point. Strategy (in order):
   *   1. direct Newton from the current state;
   *   2. gmin stepping (1e-3 → 1e-12), each stage continuing from the last;
   *   3. source stepping (all independent sources ramped 0 → 1 in steps).
   * The method actually used is recorded in the convergence report.
   */
  dcSolve(options: { quiet?: boolean } = {}): ConvergenceReport {
    const h = profiler.begin('sim.dc');
    this.resetDiagnostics();
    this.state.mode = 'dc';
    this.state.dt = 0;
    this.state.time = 0;
    // DC: capacitors open, inductors short, sources at their t=0 value.
    let usedGminStepping = false;
    let usedSourceStepping = false;
    let result = { converged: false, iterations: 0, worst: Infinity, worstNode: -1, singular: false, singularNodes: [] as number[] };

    this.lastGmin = this.opts.gmin;
    this.state.gmin = this.opts.gmin;
    if (this.opts.thermal) this.applyThermalCoupling();

    result = this.newtonOnce(this.opts.maxIterations);
    if (!result.converged) {
      // --- gmin stepping ---
      usedGminStepping = true;
      const ladder = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10, 1e-11, this.opts.gmin];
      this.v.fill(0);
      this.ib.fill(0);
      for (const g of ladder) {
        this.state.gmin = Math.max(g, this.opts.gmin);
        result = this.newtonOnce(this.opts.maxIterations);
        if (!result.converged) break;
      }
      this.lastGmin = this.state.gmin;
    }
    if (!result.converged) {
      // --- source stepping ---
      usedSourceStepping = true;
      this.v.fill(0);
      this.ib.fill(0);
      this.state.gmin = Math.max(this.opts.gmin, 1e-9);
      const steps = 20;
      let ok = true;
      for (let k = 1; k <= steps; k++) {
        this.sourceScale = k / steps;
        result = this.newtonOnce(this.opts.maxIterations);
        if (!result.converged) {
          ok = false;
          break;
        }
      }
      this.sourceScale = 1;
      this.lastGmin = this.state.gmin;
      if (ok) {
        this.state.gmin = this.opts.gmin;
        result = this.newtonOnce(this.opts.maxIterations);
      }
    }
    this.state.gmin = this.opts.gmin;
    this.sourceScale = 1;

    if (!result.converged) {
      this.diagnostics.push(
        error('CF6001', `DC operating point did not converge after ${result.iterations} iterations (worst relative error ${Number.isFinite(result.worst) ? result.worst.toExponential(2) : 'inf'})`, {
          hint: result.singular
            ? 'The system is singular: check for floating nodes, shorted voltage sources or a missing ground reference.'
            : 'Try increasing maxIterations, relaxing reltol, or checking for a circuit that has no stable DC solution (e.g. a pure oscillator).',
          data: { worstNode: result.worstNode, gmin: this.lastGmin },
        }),
      );
    }
    // Record the device states from the converged solution.
    for (let e = 0; e < this.nl.elementCount; e++) recordElementState(this.state, e);
    this.state.time = 0;
    this.updateThermalFromPower();

    h.end();
    profiler.count('sim.dc.iterations', result.iterations);
    return {
      converged: result.converged,
      iterations: result.iterations,
      worstVoltageError: result.worst,
      worstNode: result.worstNode,
      gminUsed: this.lastGmin,
      usedGminStepping,
      usedSourceStepping,
      rejectedSteps: 0,
      singular: result.singular,
      singularNodes: result.singularNodes,
      thermal: this.thermalReport(),
    };
  }

  /** Source scale used by source stepping (1 = nominal). */
  private sourceScale = 1;

  // -------------------------------------------------------------------------
  // Transient
  // -------------------------------------------------------------------------

  /**
   * Transient analysis with LTE-controlled adaptive time stepping.
   *
   * The step controller compares the second difference of every reactive
   * variable against a tolerance derived from reltol/vntol, then scales dt by
   * sqrt(tol/err). Steps that fail to converge are halved and retried; the
   * number of rejections is reported.
   */
  transient(
    tstop: number,
    requests: TransientRequest[],
    options: { maxSamples?: number; initialStep?: number; maxStep?: number; outputInterval?: number } = {},
  ): TransientResult {
    const h = profiler.begin('sim.transient');
    this.resetDiagnostics();
    const nl = this.nl;
    const t0 = Date.now();
    const maxSamples = options.maxSamples ?? 200000;
    const times = new Float64Array(maxSamples);
    const values = requests.map(() => new Float64Array(maxSamples));
    let samples = 0;

    this.state.mode = 'tran';
    this.state.integration = this.opts.integration === 'trap' ? 1 : 0;

    // Initial condition from the DC operating point (unless the caller already
    // set a state, e.g. when continuing a previous run).
    if (!this.opts.skipInitialDc && this.state.time === 0) {
      this.dcSolve();
      // `dcSolve` puts the element stamps in DC mode (capacitors open, inductors
      // short, junction capacitances dropped) and leaves them there. Restoring the
      // transient mode is not optional: without it the whole run is solved as a
      // resistive network driven by time-varying sources, so a capacitor never
      // charges, an inductor never resists a current change, and every transient
      // reading — filter response, rise time, ripple, inrush — is wrong while still
      // looking plausible. `dt` and `time` are reset by the loop below.
      this.state.mode = 'tran';
      this.state.integration = this.opts.integration === 'trap' ? 1 : 0;
    }

    // `initialStep` / `maxStep` use 0 as "choose for me" (that is what the
    // option defaults are), so a literal 0 must never be used as a step size:
    // doing so collapsed the timestep to minStep and the run crawled at 1e-18 s
    // per step without ever reaching tstop.
    const reqInitial = options.initialStep ?? this.opts.initialStep;
    const reqMax = options.maxStep ?? this.opts.maxStep;
    let dt = reqInitial && reqInitial > 0 ? reqInitial : Math.max(tstop / 1000, 1e-12);
    const maxStep = reqMax && reqMax > 0 ? reqMax : tstop / 20;
    if (dt <= 0) dt = Math.max(tstop / 1000, 1e-12);
    const thermalTau = this.opts.thermal && nl.thermalNodeCount > 0 ? this.thermalTimeConstant() : Infinity;
    let t = this.state.time;
    let steps = 0;
    let rejected = 0;
    let accepted = 0;
    const elementEnergy = new Float64Array(nl.elementCount);
    const elementCharge = new Float64Array(nl.elementCount);

    // Reactive-element history for the step controller.
    const capHistory = new Float64Array(nl.elementCount); // previous dV
    const capHasHistory = new Uint8Array(nl.elementCount);

    // Output grid. When `outputInterval` is given the record is sampled on a
    // uniform grid and the stepper is forced to land exactly on the grid points,
    // which decouples the record length from the internal step sequence: the caller
    // gets `tstop/outputInterval + 1` samples covering the whole run, however many
    // steps the accuracy controller needed in between. That is how SPICE's
    // `tran tstep tstop` works, and it is the only way `maxSamples` can mean "this
    // many points over that interval" instead of "stop recording part way through".
    let interval = Number.isFinite(options.outputInterval ?? NaN) ? (options.outputInterval as number) : 0;
    if (interval > 0) {
      const needed = Math.floor(tstop / interval) + 1;
      if (needed > maxSamples) {
        interval = tstop / Math.max(1, maxSamples - 1);
      }
    }
    let nextOut = 1;
    // Held in an object rather than a `let`: TypeScript's control-flow analysis
    // narrows a `let` that is only assigned inside a closure to its initial value,
    // which made the truncation check below compare `null` with `null` and type the
    // result as `never`.
    const truncation: { at: number | null } = { at: null };

    const collect = (time: number) => {
      if (samples >= maxSamples) {
        if (truncation.at === null) truncation.at = time;
        return;
      }
      times[samples] = time;
      for (let r = 0; r < requests.length; r++) {
        values[r][samples] = this.measure(requests[r]);
      }
      samples++;
    };

    collect(t);
    let lastConvergence = this.lastConvergence;

    while (t < tstop - 1e-18 && steps < this.opts.maxSteps) {
      steps++;
      let dtTry = Math.min(dt, maxStep, tstop - t);
      // Do not step over a source breakpoint.
      const bp = this.nextBreakpoint(t);
      if (bp !== null && t + dtTry > bp) dtTry = Math.max(this.opts.minStep, bp - t);
      // Land exactly on the next output grid point, so no sample is interpolated
      // and none is skipped.
      if (interval > 0) {
        const tOut = nextOut * interval;
        if (tOut <= tstop && t + dtTry > tOut) dtTry = Math.max(this.opts.minStep, tOut - t);
      }
      if (dtTry <= 0) dtTry = this.opts.minStep;
      this.state.dt = dtTry;
      this.state.time = t + dtTry;
      this.state.gmin = this.opts.gmin;
      if (this.opts.thermal && nl.thermalNodeCount > 0) this.applyThermalCoupling();

      const res = this.newtonOnce(this.opts.maxIterations);
      if (!res.converged) {
        rejected++;
        dt = dtTry / 4;
        if (dt < this.opts.minStep || rejected > 60) {
          this.diagnostics.push(
            error('CF6002', `transient analysis stalled at t = ${(t + dtTry).toExponential(3)} s: the timestep fell to ${dt.toExponential(3)} s without converging`, {
              hint: 'This usually indicates a discontinuity the solver cannot resolve (ideal switch + ideal source) or an unstable feedback loop.',
            }),
          );
          this.state.time = t;
          this.state.dt = 0;
          h.end();
          return this.finishTransient(false, requests, times, values, samples, steps, rejected, accepted, elementEnergy, elementCharge, res, t, t0, interval > 0 ? interval : null, truncation.at);
        }
        this.state.time = t;
        continue;
      }

      // ---- accept the step ----
      const dtAccepted = dtTry;
      t += dtAccepted;
      accepted++;
      this.state.time = t;
      this.state.dt = dtAccepted;
      for (let e = 0; e < nl.elementCount; e++) recordElementState(this.state, e);
      // Energy / charge bookkeeping for the reports and for battery state of charge.
      for (let e = 0; e < nl.elementCount; e++) {
        elementEnergy[e] += this.state.elementPower[e] * dtAccepted;
        if (nl.kind[e] === 31 /* current source */ || nl.kind[e] === 30 /* voltage source */) {
          elementCharge[e] += this.state.elementCurrent[e] * dtAccepted;
        }
      }
      // Thermal network update (level 3).
      if (this.opts.thermal && nl.thermalNodeCount > 0) this.integrateThermal(dtAccepted);
      if (interval > 0) {
        while (nextOut * interval <= t + 1e-15 && nextOut * interval <= tstop + 1e-15) {
          collect(nextOut * interval);
          nextOut++;
        }
      } else {
        collect(t);
      }
      lastConvergence = res;

      // ---- LTE-based step control ----
      let worstRatio = 0;
      for (let e = 0; e < nl.elementCount; e++) {
        const k = nl.kind[e];
        if (k !== 2 && k !== 3 && k !== 5) continue; // capacitors, inductors, transformers
        const st = nl.state.subarray(nl.stateOffset[e], nl.stateOffset[e] + 24);
        const vNow = st[0];
        const dv = vNow - (capHasHistory[e] ? capHistory[e] : vNow);
        capHistory[e] = vNow;
        capHasHistory[e] = 1;
        if (Math.abs(dv) > 0) {
          const scale = Math.max(Math.abs(vNow), 1e-6);
          worstRatio = Math.max(worstRatio, Math.abs(dv) / (this.opts.reltol * scale + this.opts.vntol));
        }
      }
      let dtNext: number;
      if (worstRatio > 0) {
        // err ∝ dt² for the second-difference estimator: scale by sqrt.
        dtNext = dtAccepted * Math.min(4, Math.max(0.25, Math.sqrt(this.opts.trtol / worstRatio)));
      } else {
        dtNext = dtAccepted * 2;
      }
      dt = Math.min(maxStep, Math.max(this.opts.minStep, dtNext));
      // The thermal network is integrated with the *same* step (implicit Euler,
      // unconditionally stable but only first-order accurate). Without a limit
      // the step controller — which only watches C/L elements — would happily
      // take steps far longer than a device's thermal time constant and report a
      // temperature ramp that is qualitatively right but quantitatively wrong.
      // Ten steps per time constant keeps the lumped model's error small.
      if (thermalTau < Infinity) dt = Math.max(this.opts.minStep, Math.min(dt, thermalTau / 10));
    }

    this.lastConvergence = lastConvergence;
    const truncatedAt = truncation.at;
    if (truncatedAt !== null && truncatedAt < tstop - 1e-15) {
      this.diagnostics.push(
        warn(
          'CF6011',
          `the transient record was truncated: maxSamples = ${maxSamples} was reached at t = ${truncatedAt.toExponential(4)} s, ` +
            `so the ${samples} samples cover ${((truncatedAt / tstop) * 100).toFixed(1)} % of the requested ${tstop.toExponential(4)} s ` +
            `(the simulation itself ran on to ${t.toExponential(4)} s in ${accepted} accepted steps)`,
          {
            hint: 'Raise maxSamples, or pass outputInterval = tstop / (maxSamples − 1) to sample on a uniform grid over the whole run.',
          },
        ),
      );
    }
    h.end();
    profiler.count('sim.tran.steps', accepted);
    profiler.count('sim.tran.rejected', rejected);
    return this.finishTransient(true, requests, times, values, samples, steps, rejected, accepted, elementEnergy, elementCharge, lastConvergence, t, t0, interval > 0 ? interval : null, truncation.at);
  }

  private lastConvergence: { converged: boolean; iterations: number; worst: number; worstNode: number; singular: boolean; singularNodes: number[] } = {
    converged: true,
    iterations: 0,
    worst: 0,
    worstNode: -1,
    singular: false,
    singularNodes: [],
  };

  private finishTransient(
    ok: boolean,
    requests: TransientRequest[],
    times: Float64Array,
    values: Float64Array[],
    samples: number,
    steps: number,
    rejected: number,
    accepted: number,
    elementEnergy: Float64Array,
    elementCharge: Float64Array,
    conv: { converged: boolean; iterations: number; worst: number; worstNode: number; singular: boolean; singularNodes: number[] },
    tFinal: number,
    t0: number,
    outputInterval: number | null = null,
    truncatedAt: number | null = null,
  ): TransientResult {
    this.lastConvergence = conv;
    const timesOut = times.slice(0, samples);
    const valuesOut = values.map((v) => v.slice(0, samples));
    return {
      ok,
      diagnostics: this.diagnostics,
      convergence: {
        converged: conv.converged,
        iterations: conv.iterations,
        worstVoltageError: conv.worst,
        worstNode: conv.worstNode,
        gminUsed: this.lastGmin,
        usedGminStepping: false,
        usedSourceStepping: false,
        rejectedSteps: rejected,
        singular: conv.singular,
        singularNodes: conv.singularNodes,
      },
      times: timesOut,
      values: valuesOut,
      sampleCount: samples,
      steps,
      rejected,
      acceptedSteps: accepted,
      outputInterval,
      truncatedAt,
      wallMs: Date.now() - t0,
      finalVoltages: this.v.slice(),
      finalCurrents: this.ib.slice(),
      elementEnergy,
      elementCharge,
    };
  }

  /** Next time at which a source waveform has a breakpoint (edge) after `t`. */
  private nextBreakpoint(t: number): number | null {
    const nl = this.nl;
    let best: number | null = null;
    for (let e = 0; e < nl.elementCount; e++) {
      const k = nl.kind[e];
      if (k !== 30 && k !== 31 && k !== 67) continue;
      const o = nl.paramOffset[e];
      const p = nl.params;
      const family = p[o + 2 /* SRC_SLOTS.family */];
      if (family === 1 || family === 3) continue; // current sources do not force time points
      const wave = p[o + 1];
      if (wave === 8) {
        // An arbitrary waveform has corners of its own: the stepper must land on
        // them or a PWL edge can fall inside a step and be smoothed away, which
        // would show up as a slower edge than the user wrote.
        const handle = p[o + SRC_SLOTS.table];
        const delay = p[o + 9];
        const tables = nl.waveTables;
        if (Number.isFinite(handle) && handle >= 0 && tables && handle < tables.length) {
          const table = tables[handle];
          for (let i = 0; i + 1 < table.length; i += 2) {
            const edge = table[i] + delay;
            if (edge > t + 1e-18 && (best === null || edge < best)) best = edge;
          }
        }
        continue;
      }
      if (wave !== 2 && wave !== 5 && wave !== 6) continue;
      const freq = p[o + 4];
      const duty = p[o + 6];
      const delay = p[o + 9];
      const period = 1 / Math.max(1e-12, freq);
      if (!Number.isFinite(period) || period <= 0) continue;
      const local = t - delay;
      const idx = Math.floor(local / period);
      for (let k2 = idx; k2 <= idx + 2; k2++) {
        const edgeUp = delay + k2 * period;
        const edgeDown = delay + k2 * period + duty * period;
        for (const edge of [edgeUp, edgeDown]) {
          if (edge > t + 1e-18 && (best === null || edge < best)) best = edge;
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Measurement
  // -------------------------------------------------------------------------

  /** Evaluate one trace request against the current solution. */
  measure(req: TransientRequest): number {
    const nl = this.nl;
    switch (req.kind) {
      case 'vnode':
        return this.v[Math.max(0, Math.min(nl.nodeCount - 1, req.index))];
      case 'vnet':
        return this.v[Math.max(0, Math.min(nl.nodeCount - 1, req.index))] - this.v[Math.max(0, Math.min(nl.nodeCount - 1, req.index2 ?? 0))];
      case 'ieleme':
        return this.state.elementCurrent[req.index] ?? 0;
      case 'pelem':
        return this.state.elementPower[req.index] ?? 0;
      case 'temp':
        return this.thermalTemp[req.index] - 273.15;
      case 'logic': {
        const n = nl.nodes.subarray(req.index * NODE_STRIDE, req.index * NODE_STRIDE + nl.nodeCountPerElement[req.index]);
        const vth = nl.params[nl.paramOffset[req.index] + 3];
        return this.v[n[nl.nodeCountPerElement[req.index] - 1]] > vth ? 1 : 0;
      }
      case 'igeneric': {
        const e = req.index;
        if (e < 0 || e >= nl.elementCount) return 0;
        const br = nl.branchIndex[e];
        if (br >= 0) return this.ib[br];
        return this.state.elementCurrent[e];
      }
      case 'v3':
        return this.v[req.index];
      case 'time':
        return this.state.time;
      default:
        return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Thermal network (level 3)
  // -------------------------------------------------------------------------

  /**
   * Inject the currently dissipated power of every self-heating element into its
   * thermal node. Called before each electrical solve; the outer loop iterates
   * electrical ↔ thermal until the temperature stops moving.
   */
  private applyThermalCoupling(): void {
    const nl = this.nl;
    // The temperatures live in thermalTemp; device models read them through
    // nl.thermalTemperature, which the caller keeps in sync.
    for (let i = 0; i < nl.thermalNodeCount; i++) nl.thermalTemperature[i] = this.thermalTemp[i];
  }

  /**
   * Close the power → temperature loop after an electrical solve.
   *
   * The DC point is first computed at ambient. Every element that owns a
   * thermal node then injects its *measured* dissipation into that node and the
   * lumped thermal network is solved; device models that read their own
   * temperature (every semiconductor, and any passive with a `tc1`/`tc2`
   * coefficient) are re-evaluated at the new temperatures, which changes their
   * power, and so on until nothing moves by more than `thermalTol`.
   *
   * The circuit must have a thermal network for this to do anything: a netlist
   * built without one keeps every element at the ambient temperature, and the
   * convergence report then has no `thermal` block rather than a zero.
   */
  private updateThermalFromPower(): void {
    const nl = this.nl;
    if (!this.opts.thermal || !this.opts.thermalCoupling) return;
    if (nl.thermalNodeCount === 0) return;
    this.solveThermalSteadyState();
  }

  /** Steady-state thermal report of the present solve, or undefined. */
  private thermalReport(): ConvergenceReport['thermal'] {
    const nl = this.nl;
    if (!this.opts.thermal || nl.thermalNodeCount === 0) return undefined;
    return {
      iterations: this.lastThermalIterations,
      worstTemperatureChange: this.lastThermalDelta,
      converged: this.opts.thermalCoupling && this.lastThermalIterations > 0 && this.lastThermalDelta < this.opts.thermalTol,
      maxTemperature: this.maxTemperature(),
    };
  }

  /**
   * Heat injected into every thermal node by the present solution (W).
   *
   * Measured: the per-element dissipation that the device models computed while
   * stamping (`state.elementPower`), summed over the elements that share a
   * thermal node. Nothing is estimated here.
   */
  thermalPower(): Float64Array {
    const nl = this.nl;
    const power = new Float64Array(Math.max(1, nl.thermalNodeCount));
    for (let e = 0; e < nl.elementCount; e++) {
      const th = elementThermalNode(nl.kind[e], nl.paramOffset[e], nl.params);
      if (th >= 0 && th < nl.thermalNodeCount) power[th] += this.state.elementPower[e];
    }
    return power;
  }

  /** Explicit/implicit thermal integration for one accepted time step. */
  private integrateThermal(dt: number): void {
    const nl = this.nl;
    if (nl.thermalNodeCount === 0 || dt <= 0) return;
    const power = this.thermalPower();
    const ambientK = (nl.ambient ?? this.opts.ambient) + 273.15;
    // Implicit Euler on the lumped network: (C/dt + Σ1/R)·T^{n+1} = P + C/dt·T^n + Σ T_k/R
    const links = nl.thermalLinks;
    const orphan: number[] = [];
    for (let i = 0; i < nl.thermalNodeCount; i++) {
      const cth = nl.thermalCth[i];
      const rthAmb = nl.thermalRthAmbient[i];
      let g = 0;
      let rhs = power[i];
      if (cth > 0) {
        g += cth / dt;
        rhs += (cth / dt) * this.thermalTemp[i];
      }
      if (rthAmb > 0) {
        g += 1 / rthAmb;
        rhs += ambientK / rthAmb;
      }
      // Links to neighbouring thermal nodes (Jacobi-style update: neighbours use
      // their current value, which is the standard approach for a small network
      // and converges quickly because thermal time constants are slow).
      for (let l = 0; l < links.length; l += 2) {
        if (links[l] === i) {
          const other = links[l + 1];
          const r = nl.thermalLinkRth[l / 2];
          if (other < 0) {
            g += 1 / r;
            rhs += ambientK / r;
          } else if (other < nl.thermalNodeCount) {
            g += 1 / r;
            rhs += this.thermalTemp[other] / r;
          }
        } else if (links[l + 1] === i) {
          const other = links[l];
          const r = nl.thermalLinkRth[l / 2];
          if (other < 0) {
            g += 1 / r;
            rhs += ambientK / r;
          } else if (other < nl.thermalNodeCount) {
            g += 1 / r;
            rhs += this.thermalTemp[other] / r;
          }
        }
      }
      if (g > 0) this.thermalTemp[i] = rhs / g;
      else orphan.push(i);
    }
    if (orphan.length > 0 && !this.orphanThermalReported) {
      this.orphanThermalReported = true;
      this.diagnostics.push(
        warn('CF5303', `${orphan.length} thermal node(s) have no path to ambient, so their temperature is not modelled`, {
          hint: 'A device thermal node is only meaningful when it can lose heat: give every self-heating device an rth > 0 (junction-ambient) or link it to a heatsink node.',
          data: { nodes: orphan.join(',') },
        }),
      );
    }
    for (let i = 0; i < nl.thermalNodeCount; i++) nl.thermalTemperature[i] = this.thermalTemp[i];
  }

  private orphanThermalReported = false;

  /**
   * Electro-thermal steady state (level 3): iterate the electrical operating
   * point and the lumped thermal network against each other until the junction
   * temperatures stop moving.
   *
   * Method (documented in docs/SIMULATION.md):
   *   - the thermal network is solved with implicit Euler at a very large step
   *     (`dt → ∞`), which is exactly its steady state: G·T = P + T_amb/R_amb;
   *   - every iteration re-solves the electrical problem with the new device
   *     temperatures, so the coupling is two-way (power → temperature →
   *     parameters → power);
   *   - the loop stops when no node moves by more than `thermalTol` (°C), and at
   *     most `thermalIterations` times. If it has not settled by then the result
   *     is reported as *not converged* rather than presented as an answer.
   */
  solveThermalSteadyState(): { iterations: number; maxTemperature: number; converged: boolean } {
    const nl = this.nl;
    if (nl.thermalNodeCount === 0) {
      return { iterations: 0, maxTemperature: nl.ambient ?? this.opts.ambient, converged: true };
    }
    const maxIter = Math.max(1, this.opts.thermalIterations);
    let delta = Infinity;
    let iterations = 0;
    let converged = false;
    for (let iter = 0; iter < maxIter; iter++) {
      const before = this.thermalTemp.slice(0, nl.thermalNodeCount);
      this.integrateThermal(1e9); // very large dt = steady state
      delta = 0;
      for (let i = 0; i < nl.thermalNodeCount; i++) delta = Math.max(delta, Math.abs(this.thermalTemp[i] - before[i]));
      iterations = iter + 1;
      this.applyThermalCoupling();
      if (delta < this.opts.thermalTol) {
        converged = true;
        break;
      }
      // Re-solve the electrical problem with the new temperatures.
      const r = this.newtonOnce(this.opts.maxIterations);
      if (!r.converged) {
        this.diagnostics.push(
          warn('CF6003', 'electro-thermal iteration did not converge; the reported temperatures may be inaccurate', {
            hint: 'Lower thermalIterations or relax reltol if the electrical point itself is the problem.',
            data: { iteration: iterations, temperatureChange: delta },
          }),
        );
        break;
      }
      for (let e = 0; e < nl.elementCount; e++) recordElementState(this.state, e);
    }
    if (!converged && delta >= this.opts.thermalTol) {
      this.diagnostics.push(
        warn('CF6004', `electro-thermal steady state did not settle in ${maxIter} iterations (last change ${delta.toFixed(3)} °C)`, {
          hint: 'The result is a snapshot of the last iteration, not a converged thermal steady state. Raise thermalIterations or check for a device whose power runs away with temperature.',
          data: { iterations: maxIter, temperatureChange: delta },
        }),
      );
    }
    this.lastThermalIterations = iterations;
    this.lastThermalDelta = Number.isFinite(delta) ? delta : 0;
    return { iterations, maxTemperature: this.maxTemperature(), converged };
  }

  /** Iterations the last electro-thermal solve used (0 when there is no thermal network). */
  lastThermalIterations = 0;
  /** Temperature change (K) of the last electro-thermal iteration. */
  lastThermalDelta = 0;

  /**
   * Shortest thermal time constant of the netlist (seconds), or Infinity when
   * there is no thermal network. A node's constant is `Cth / Σ(1/Rth)` over its
   * own link to ambient and the links it shares with other thermal nodes.
   */
  private thermalTimeConstant(): number {
    const nl = this.nl;
    let tau = Infinity;
    for (let i = 0; i < nl.thermalNodeCount; i++) {
      const cth = nl.thermalCth[i];
      if (!(cth > 0)) continue;
      let g = nl.thermalRthAmbient[i] > 0 ? 1 / nl.thermalRthAmbient[i] : 0;
      for (let l = 0; l < nl.thermalLinks.length; l += 2) {
        if (nl.thermalLinks[l] === i || nl.thermalLinks[l + 1] === i) g += 1 / nl.thermalLinkRth[l / 2];
      }
      if (g > 0) tau = Math.min(tau, cth / g);
    }
    return tau;
  }

  /**
   * Put every thermal node back at ambient and re-seed the device states.
   *
   * Used to start a thermal transient from cold (and by the UI when the user
   * resets a run): the electrical solution is left untouched, only the level-3
   * state is cleared.
   */
  resetThermalToAmbient(): void {
    const nl = this.nl;
    const ambientK = (nl.ambient ?? this.opts.ambient) + 273.15;
    for (let i = 0; i < nl.thermalNodeCount; i++) {
      this.thermalTemp[i] = ambientK;
      nl.thermalTemperature[i] = ambientK;
    }
    this.lastThermalIterations = 0;
    this.lastThermalDelta = 0;
    this.orphanThermalReported = false;
  }

  /** Hottest thermal node temperature (°C). */
  maxTemperature(): number {
    let max = -Infinity;
    for (let i = 0; i < this.nl.thermalNodeCount; i++) max = Math.max(max, this.thermalTemp[i] - 273.15);
    return this.nl.thermalNodeCount ? max : this.nl.ambient ?? this.opts.ambient;
  }

  /** Per-element power dissipation snapshot (W). */
  powers(): Float64Array {
    return this.state.elementPower;
  }

  /** Set the initial voltage of a node (used by tests and by `.ic` style setups). */
  setInitialVoltage(node: number, volts: number): void {
    if (node > 0 && node < this.v.length) this.v[node] = volts;
  }

  /** Total elapsed simulated time. */
  get time(): number {
    return this.state.time;
  }
  set time(t: number) {
    this.state.time = t;
  }
}

export { info, Severity };
