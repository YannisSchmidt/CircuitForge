/**
 * The bottom dock: simulation results, the oscilloscope, the analyzer, the job queue
 * and the console.
 *
 * Every number in these panes comes from the engine, in the browser, from the same
 * modules the CLI runs: `flatten` and `LogicVectorSim` for level 0, `CircuitSimulator`
 * for the DC point and the transient sweep, `Oscilloscope` for the measurements on a
 * capture, `analyzeCircuit` for the report, and the server's job queue for anything
 * long enough that it should survive a closed tab.
 *
 * What is not measured is not shown. A level that was not run leaves its table empty
 * and says so; an objective the optimizer never scored is printed as "not measured"
 * rather than as a zero. The oscilloscope prints the convergence of the run that
 * produced its traces, because a waveform from a solve that did not converge is a
 * picture of a guess.
 */

import * as cf from '/engine/index.js';
import { api, download, eng, esc, fmtBytes, fmtDuration, fmtMs, fmtNumber, pct } from './api.js';

const CHANNEL_COLORS = ['#6cc4ff', '#fbbf24', '#4ade80', '#f06292', '#ba68c8', '#fff176', '#4db6ac', '#ff8a65'];

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export class ConsolePane {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.entries = [];
    this.limit = 3000;
    this.filter = '';
    this.severity = 'all';
    root.innerHTML = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <input type="search" id="console-filter" placeholder="Filter…" spellcheck="false" style="flex:1" />
        <select id="console-severity">
          <option value="all">all</option><option value="info">info</option>
          <option value="warn">warnings</option><option value="error">errors</option>
        </select>
        <button id="console-copy">Copy</button>
        <button id="console-save">Save</button>
        <button id="console-clear" class="danger">Clear</button>
      </div>
      <div id="console" class="card" style="margin:0"><div class="body tight" id="console-lines"></div></div>`;
    this.lines = root.querySelector('#console-lines');
    root.querySelector('#console-filter').addEventListener('input', (e) => {
      this.filter = e.target.value.toLowerCase();
      this.repaint();
    });
    root.querySelector('#console-severity').addEventListener('change', (e) => {
      this.severity = e.target.value;
      this.repaint();
    });
    root.querySelector('#console-clear').addEventListener('click', () => {
      this.entries = [];
      this.repaint();
    });
    root.querySelector('#console-copy').addEventListener('click', () => this.copy());
    root.querySelector('#console-save').addEventListener('click', () => download(`circuitforge-console-${Date.now()}.log`, this.asText(), 'text/plain'));
    this.log('CircuitForge console ready. Every line below was produced by the engine or by an action you took; nothing is invented.', 'ok', 'console');
  }

  visible() {
    return this.entries.filter((e) => {
      if (this.severity !== 'all' && e.severity !== this.severity && !(this.severity === 'info' && e.severity === 'ok')) return false;
      if (!this.filter) return true;
      return `${e.source} ${e.message}`.toLowerCase().includes(this.filter);
    });
  }

  repaint() {
    const rows = this.visible();
    this.lines.innerHTML =
      rows.length === 0
        ? '<div class="empty">Nothing to show.</div>'
        : rows
            .map(
              (e) =>
                `<div class="log-line ${esc(e.severity)}"><span class="ts">${esc(e.time)}</span><span class="src">${esc(e.source)}</span><span>${esc(e.message)}</span></div>`,
            )
            .join('');
    this.root.scrollTop = this.root.scrollHeight;
  }

  log(message, severity = 'info', source = 'app') {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    this.entries.push({ time, message: String(message), severity, source });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    // Appending one line is cheap; repainting thousands of them per message is not.
    if (this.visible().length === this.entries.length || this.entries.length < 400) this.repaint();
    else this.repaint();
  }

  asText() {
    return this.entries.map((e) => `[${e.time}] ${e.severity.toUpperCase().padEnd(5)} ${e.source}: ${e.message}`).join('\n');
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.asText());
      this.log('console copied to the clipboard', 'ok', 'console');
    } catch {
      this.log('the browser refused clipboard access; use Save instead', 'warn', 'console');
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export class SimulationPane {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.options = { logic: true, electrical: false, thermal: false, expandGates: false, ambient: 25, tstop: 0, maxSamples: 1000, truthTable: true, maxRows: 64 };
    this.last = null;
    this.error = null;
    this.ms = 0;
    root.innerHTML = this.controlsHtml();
    this.body = document.createElement('div');
    this.body.id = 'sim-results';
    root.appendChild(this.body);
    root.addEventListener('change', (e) => this.onControl(e));
    root.addEventListener('click', (e) => this.onButton(e));
    this.renderResults();
  }

  controlsHtml() {
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <button class="primary" data-sim="run">▶ Run</button>
      <button data-sim="step">Step tick</button>
      <button data-sim="clock">Clock</button>
      <button data-sim="stop" class="danger">Stop</button>
      <span class="tsep"></span>
      <label><input type="checkbox" data-opt="logic" checked /> L0 logic</label>
      <label><input type="checkbox" data-opt="electrical" /> L1 electrical</label>
      <label><input type="checkbox" data-opt="thermal" /> L3 thermal</label>
      <label title="Flattening expands a gate into its CMOS transistor network only when that gate's own 'style' parameter is not the default 'ideal' (for example cmos_static, set in the Inspector). Ticking this on a sheet of default gates changes nothing, and the console then says so (CF6013) instead of leaving you to guess."><input type="checkbox" data-opt="expandGates" /> expand gates to transistors (gate needs style ≠ ideal)</label>
      <label><input type="checkbox" data-opt="truthTable" checked /> truth table</label>
      <span class="tsep"></span>
      <label>ambient <input type="number" data-opt="ambient" value="25" step="1" style="width:64px" /> °C</label>
      <label>tstop <input type="number" data-opt="tstop" value="0" step="0.001" style="width:80px" /> s</label>
      <label>samples <input type="number" data-opt="maxSamples" value="1000" step="100" style="width:80px" /></label>
    </div>`;
  }

  onControl(e) {
    const el = e.target;
    const key = el.dataset.opt;
    if (!key) return;
    const value = el.type === 'checkbox' ? el.checked : Number(el.value);
    this.options[key] = value;
    if (key === 'thermal' && value) this.options.electrical = true;
  }

  onButton(e) {
    const el = e.target.closest('[data-sim]');
    if (!el) return;
    const action = el.dataset.sim;
    if (action === 'run') this.run();
    else if (action === 'stop') this.stop();
    else if (action === 'step') this.step();
    else if (action === 'clock') this.toggleClock();
  }

  stop() {
    this.last = null;
    this.error = null;
    this.app.setMeasurements(null);
    this.app.log('simulation state cleared from the sheet', 'info', 'sim');
    this.stopClock();
    this.renderResults();
  }

  /** Build the netlist the sheet implies, at the level asked for. */
  netlist() {
    const editor = this.app.editor;
    return cf.flatten(editor.circuit, editor.lib, editor.chips, {
      expandGates: this.options.expandGates,
      ambient: this.options.ambient,
      thermal: this.options.thermal,
      metadata: true,
    });
  }

  run() {
    const t0 = performance.now();
    this.error = null;
    try {
      const nl = this.netlist();
      // The netlist carries the truth about what flattening did, including whether the
      // gate expansion just asked for actually happened. Surface it rather than letting
      // a ticked box imply a transistor-level netlist that was never built.
      for (const d of nl.diagnostics ?? []) {
        if (d.code === 'CF6012' || d.code === 'CF6013') {
          this.app.log(`${d.code} ${d.message}${d.hint ? ` — ${d.hint}` : ''}`, d.severity === 'warning' ? 'warn' : 'info', 'sim');
        }
      }
      const result = { netlist: cf.netlistStats(nl), logic: null, dc: null, thermal: null, transient: null, accuracy: [] };
      const nets = {};
      const nodes = {};

      if (this.options.logic) {
        // drive()/sample()/word() take NODE INDICES, not net names: a name is out of
        // range and silently ignored, which would paint the whole sheet unknown and
        // read as a design that does not work. Names are kept for display and for
        // mapping values back onto the wires, which are keyed by net name.
        const graph = cf.buildLogicGraph(nl);
        const sim = new cf.LogicVectorSim(graph, { loopIterations: 8 });
        this.logicSim = sim;
        this.logicGraph = graph;
        const uniq = (list) => [...new Set(list ?? [])];
        this.inputNodes = uniq(graph.inputs);
        this.outputNodes = uniq(graph.outputs);
        this.nameOf = (node) => {
          const name = graph.netName(node);
          return name && !name.startsWith('#') ? name : `node${node}`;
        };
        this.inputNets = this.inputNodes.map(this.nameOf);
        this.outputNets = this.outputNodes.map(this.nameOf);
        this.nodeByName = new Map();
        for (const node of [...this.inputNodes, ...this.outputNodes]) this.nodeByName.set(this.nameOf(node), node);
        this.inputValues = this.inputValues ?? new Map();
        this.applyInputs();
        // settle() returns nothing: what it found is in the graph's diagnostics.
        sim.settle();
        // Every node the logic graph carries gets a value, so every wire on the sheet
        // is coloured by what was actually settled rather than by what was guessed.
        const words = {};
        for (let node = 0; node < graph.netCount; node++) {
          const name = this.nameOf(node);
          if (name.startsWith('node')) continue;
          try {
            // sample() returns 0 and 1 as numbers and X and Z as strings.
            const value = String(sim.sample(node, 0));
            words[name] = value;
            nets[name] = { value: valueOfWord(value), word: value, driven: true };
          } catch {
            // A node the logic engine does not carry (an analogue net, a supply) is
            // not a logic value; leaving it out is truer than inventing one.
          }
        }
        let table = null;
        if (this.options.truthTable && this.inputNodes.length > 0) {
          // The engine is bit-parallel over 32 vectors, so up to five inputs are
          // exhaustive in a single settle: combination k is encoded in lane k.
          const exhaustive = this.inputNodes.length <= 5;
          const lanes = exhaustive ? 1 << this.inputNodes.length : 32;
          table = { inputs: this.inputNets, outputs: this.outputNets, rows: [], exhaustive, lanes };
          for (let i = 0; i < this.inputNodes.length; i++) {
            let ones = 0;
            for (let k = 0; k < lanes; k++) if (((k >> i) & 1) === 1) ones |= 1 << k;
            sim.drive(this.inputNodes[i], ones >>> 0, 0);
          }
          sim.settle();
          for (let k = 0; k < lanes; k++) {
            const row = { inputs: this.inputNodes.map((n, i) => String((k >> i) & 1)), outputs: {} };
            for (let o = 0; o < this.outputNodes.length; o++) row.outputs[this.outputNets[o]] = String(sim.sample(this.outputNodes[o], k));
            table.rows.push(row);
          }
          this.applyInputs();
          sim.settle();
        }
        result.logic = {
          inputs: this.inputNets,
          outputs: this.outputNets,
          words,
          diagnostics: (graph.diagnostics ?? []).map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
          stats: graph.stats ?? null,
          elements: (graph.elements ?? []).length,
          loops: (graph.loopElements ?? []).length,
          table,
        };
      }

      if (this.options.electrical) {
        const sim = new cf.CircuitSimulator(nl, { ambient: this.options.ambient });
        this.sim = sim;
        const dc = sim.dcSolve({ quiet: true });
        const voltages = [];
        for (let i = 0; i < nl.nodeCount; i++) {
          const name = cf.nodeNameAt(nl, i);
          voltages.push({ node: i, name, voltage: sim.v[i] ?? 0 });
          if (name) nets[name] = { ...(nets[name] ?? {}), voltage: sim.v[i] ?? 0 };
        }
        const powers = sim.powers();
        const powerRows = [];
        let totalDissipated = 0;
        for (const key of Object.keys(powers)) {
          const p = powers[key];
          if (!Number.isFinite(p)) continue;
          if (p > 0) totalDissipated += p;
          const index = Number(key);
          powerRows.push({ element: index, name: safeName(nl, index), power: p });
        }
        powerRows.sort((a, b) => Math.abs(b.power) - Math.abs(a.power));
        let stats = null;
        try {
          stats = cf.circuitStats(nl, { sim, lib: this.app.editor.lib });
        } catch (err) {
          this.app.log(`statistics could not be computed: ${err.message}`, 'warn', 'sim');
        }
        result.dc = {
          converged: dc.converged,
          iterations: dc.iterations,
          worstVoltageError: dc.worstVoltageError,
          worstNode: dc.worstNode,
          gminUsed: dc.gminUsed,
          singular: dc.singular,
          singularNodes: dc.singularNodes ?? [],
          voltages,
          powers: powerRows.slice(0, 200),
          totalDissipated,
          stats: stats ? stats.stats : null,
        };
        if (this.options.thermal) {
          try {
            const thermal = sim.solveThermalSteadyState();
            result.thermal = thermal;
            const rows = thermal.temperatures ?? thermal.rows ?? [];
            if (Array.isArray(rows)) {
              for (const row of rows) {
                const ref = row.ref ?? row.name ?? row.path;
                if (ref && Number.isFinite(row.temperature)) nodes[ref] = { ...(nodes[ref] ?? {}), temperature: row.temperature, hot: row.hot === true };
              }
            }
          } catch (err) {
            result.thermal = { error: `${err.code ? err.code + ': ' : ''}${err.message}` };
            this.app.log(`the thermal solve failed: ${err.message}`, 'warn', 'sim');
          }
        }
        if (this.options.tstop > 0) {
          try {
            const scope = new cf.Oscilloscope(sim);
            const probes = this.app.autoProbes ? this.app.autoProbes(nl) : [];
            for (const p of probes) scope.addChannel(p);
            const capture = scope.run({ tstop: this.options.tstop, maxSamples: this.options.maxSamples });
            result.transient = { capture, scope, probes };
            this.app.scope.setScope(scope, capture);
          } catch (err) {
            result.transient = { error: `${err.code ? err.code + ': ' : ''}${err.message}` };
            this.app.log(`the transient sweep failed: ${err.message}`, 'warn', 'sim');
          }
        }
      }

      // Per-component power and temperature badges, from what was actually solved.
      if (result.dc) {
        const byRef = new Map();
        for (const inst of this.app.editor.circuit.allComponents()) byRef.set(inst.ref, inst);
        for (const row of result.dc.powers) {
          const ref = refOfElement(nl, row.element);
          if (ref && byRef.has(ref)) nodes[ref] = { ...(nodes[ref] ?? {}), power: row.power };
        }
      }

      this.ms = performance.now() - t0;
      this.last = result;
      this.app.setMeasurements({ nets, nodes });
      this.app.log(
        `simulated ${result.netlist.instances ?? 0} instance(s), ${result.netlist.elements ?? 0} element(s) in ${fmtMs(this.ms)}${result.dc ? ` · DC ${result.dc.converged ? 'converged' : 'DID NOT CONVERGE'} in ${result.dc.iterations} iteration(s)` : ''}${result.logic ? ` · ${result.logic.outputs.length} logic output(s)` : ''}`,
        result.dc && !result.dc.converged ? 'warn' : 'ok',
        'sim',
      );
      if (result.dc && !result.dc.converged) {
        this.app.log(`the DC solve stopped at ${result.dc.iterations} iterations with a worst voltage error of ${eng(result.dc.worstVoltageError, 'V')}; the voltages below are the last iterate, not a solution`, 'error', 'sim');
      }
    } catch (err) {
      this.error = err;
      this.ms = performance.now() - t0;
      this.app.log(`simulation failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'sim');
    }
    this.renderResults();
  }

  /** Advance every register by one clock tick, keeping the driven inputs. */
  step() {
    if (!this.logicSim) {
      this.options.logic = true;
      this.run();
      if (!this.logicSim) return;
    }
    this.logicSim.run(1);
    this.refreshWords();
    this.app.log(`advanced 1 tick (registers latched, then the combinational cloud settled again)`, 'info', 'sim');
    this.renderResults();
  }

  toggleClock() {
    if (this.clockTimer) {
      this.stopClock();
      return;
    }
    if (!this.logicSim) {
      this.options.logic = true;
      this.run();
      if (!this.logicSim) return;
    }
    const clkName = (this.inputNets ?? []).find((n) => /clk|clock/i.test(n));
    if (!clkName) {
      this.app.log('no net on this sheet looks like a clock (name containing "clk"); drive one manually or rename it', 'warn', 'sim');
      return;
    }
    const clk = this.nodeByName.get(clkName);
    let phase = 0;
    this.clockTimer = setInterval(() => {
      phase ^= 1;
      this.logicSim.drive(clk, phase, 0);
      this.logicSim.run(1);
      this.refreshWords();
      this.app.view.requestDraw();
      this.renderWordsOnly();
    }, 250);
    this.app.log(`clock running on ${clkName} at 2 Hz (one tick per 500 ms of wall time; the tick itself is instantaneous in level 0)`, 'info', 'sim');
  }

  stopClock() {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
      this.app.log('clock stopped', 'info', 'sim');
    }
  }

  /** Drive every input node to the value the user has chosen (0 by default). */
  applyInputs() {
    if (!this.logicSim) return;
    for (const node of this.inputNodes ?? []) {
      const want = this.inputValues.get(node);
      if (want === 'X') this.logicSim.drive(node, 0, ~0);
      else if (want === 1) this.logicSim.drive(node, 1, 0);
      else this.logicSim.drive(node, 0, 0);
    }
  }

  refreshWords() {
    if (!this.logicSim || !this.last || !this.last.logic) return;
    const nets = {};
    for (let node = 0; node < this.logicGraph.netCount; node++) {
      const name = this.nameOf(node);
      if (name.startsWith('node')) continue;
      try {
        const value = String(this.logicSim.sample(node, 0));
        this.last.logic.words[name] = value;
        nets[name] = { value: valueOfWord(value), word: value };
      } catch {
        /* not a logic net */
      }
    }
    // Keep the electrical readings that were already there.
    const existing = this.app.measurements ?? { nets: {}, nodes: {} };
    this.app.setMeasurements({ nets: { ...existing.nets, ...nets }, nodes: existing.nodes ?? {} });
  }

  /** Flip a driven input between 0, 1 and X — the interactive part of level 0. */
  toggleInput(netName) {
    if (!this.logicSim) {
      this.app.log('run the logic simulation before toggling an input', 'warn', 'sim');
      return false;
    }
    const node = this.nodeByName ? this.nodeByName.get(netName) : undefined;
    if (node === undefined || !(this.inputNodes ?? []).includes(node)) {
      this.app.log(`"${netName}" is not a logic input of this sheet`, 'warn', 'sim');
      return false;
    }
    const current = this.inputValues.get(node) ?? 0;
    const next = current === 0 ? 1 : current === 1 ? 'X' : 0;
    this.inputValues.set(node, next);
    this.applyInputs();
    this.logicSim.settle();
    this.refreshWords();
    this.app.log(`${netName} driven to ${String(next)}`, 'info', 'sim');
    this.app.view.requestDraw();
    this.renderResults();
    return true;
  }

  renderWordsOnly() {
    const el = this.body.querySelector('#sim-words');
    if (el && this.last && this.last.logic) el.innerHTML = this.wordsHtml(this.last.logic);
  }

  renderResults() {
    if (this.error) {
      this.body.innerHTML = `<div class="note bad"><b>${esc(this.error.code ?? 'ERROR')}</b> — ${esc(this.error.message)}${this.error.hint ? `<br/><span style="color:var(--text-dim)">${esc(this.error.hint)}</span>` : ''}</div>`;
      return;
    }
    if (!this.last) {
      this.body.innerHTML = `<div class="empty">Nothing has been simulated yet.<br/><br/>Choose the levels above and press <b>Run</b>. Level 0 settles the four-state logic and colours every wire; level 1 solves the DC operating point; level 3 adds the thermal steady state. Each level says what its models do and do not claim.</div>`;
      return;
    }
    const r = this.last;
    const parts = [];
    parts.push(`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
      <span class="badge info">${fmtMs(this.ms)}</span>
      <span class="badge">${r.netlist.instances ?? 0} instances</span>
      <span class="badge">${r.netlist.elements ?? 0} elements</span>
      <span class="badge">${r.netlist.nets ?? r.netlist.nodeCount ?? 0} nets</span>
      ${r.netlist.expandedTransistors ? `<span class="badge">${r.netlist.expandedTransistors} transistors</span>` : ''}
      ${r.dc ? `<span class="badge ${r.dc.converged ? 'ok' : 'bad'}">DC ${r.dc.converged ? 'converged' : 'not converged'}</span>` : ''}
      ${r.dc ? `<span class="badge">${r.dc.iterations} iterations</span>` : ''}
      ${r.dc ? `<span class="badge">Σ dissipated ${eng(r.dc.totalDissipated, 'W')}</span>` : ''}
      ${r.logic ? `<span class="badge ${r.logic.loops > 0 ? 'warn' : 'ok'}">L0 ${r.logic.elements ?? 0} logic elements · ${r.logic.stats?.levels ?? 0} levels${r.logic.loops ? ` · ${r.logic.loops} in a loop` : ''}</span>` : ''}
      ${r.thermal && !r.thermal.error ? `<span class="badge ok">thermal solved</span>` : ''}
      ${r.thermal && r.thermal.error ? `<span class="badge bad">thermal: ${esc(r.thermal.error)}</span>` : ''}
      ${r.transient && r.transient.error ? `<span class="badge bad">transient: ${esc(r.transient.error)}</span>` : ''}
    </div>`);
    if (r.logic) {
      parts.push(`<div class="card"><header>Level 0 — four-state logic <span class="count">${r.logic.inputs.length} in · ${r.logic.outputs.length} out</span></header>
        <div class="body tight" id="sim-words">${this.wordsHtml(r.logic)}</div></div>`);
      if (r.logic.table) parts.push(this.tableHtml(r.logic.table));
      for (const d of r.logic.diagnostics ?? []) {
        parts.push(`<div class="note ${d.severity === 'error' ? 'bad' : 'warn'}"><b>${esc(d.code)}</b> — ${esc(d.message)}</div>`);
      }
      if (r.logic.loops > 0) {
        parts.push(`<div class="note warn">${r.logic.loops} element(s) sit in a combinational loop. Level 0 iterates to a fixed point, so a loop is reported as unsettled rather than oscillated; the values on it are the last iterate.</div>`);
      }
      if (r.logic.table && r.logic.table.exhaustive === false) {
        parts.push(`<div class="note warn">The truth table shows 32 of ${1 << r.logic.inputs.length} input combinations: the level-0 engine evaluates 32 vectors per settle, so five inputs are exhaustive and more are not. Use the CLI's validation for an exhaustive check of a wider sheet.</div>`);
      }
    }
    if (r.dc) {
      parts.push(`<div class="card"><header>Level 1 — DC operating point ${r.dc.converged ? '' : '<span class="badge bad">NOT CONVERGED</span>'}</header>
        <div class="body tight">
        <dl class="kv" style="margin-bottom:6px">
          <dt>Iterations</dt><dd>${r.dc.iterations}</dd>
          <dt>Worst |ΔV|</dt><dd>${eng(r.dc.worstVoltageError, 'V')}</dd>
          <dt>Worst node</dt><dd>${esc(String(r.dc.worstNode ?? '—'))}</dd>
          <dt>gmin used</dt><dd>${eng(r.dc.gminUsed, 'S')}</dd>
          <dt>Singular</dt><dd>${r.dc.singular ? `<span class="badge bad">yes: ${esc((r.dc.singularNodes ?? []).join(', '))}</span>` : 'no'}</dd>
        </dl>
        ${voltageTable(r.dc.voltages)}
        ${powerTable(r.dc.powers, r.dc.totalDissipated)}
        </div></div>`);
    }
    if (r.thermal && !r.thermal.error) parts.push(thermalCard(r.thermal));
    if (r.dc && r.dc.stats) parts.push(statsCard(r.dc.stats));
    this.body.innerHTML = parts.join('');
    this.body.querySelectorAll('[data-toggle-net]').forEach((el) => {
      el.addEventListener('click', () => this.toggleInput(el.dataset.toggleNet));
    });
  }

  wordsHtml(logic) {
    const rows = [];
    for (const n of logic.inputs) {
      const word = logic.words[n] ?? '?';
      rows.push(`<div class="pin-row"><span class="dir input"></span><span>${esc(n)} <span class="net">input</span></span>
        <button data-toggle-net="${esc(n)}" title="Cycle 0 → 1 → X">${esc(word)}</button></div>`);
    }
    for (const n of logic.outputs) {
      const word = logic.words[n] ?? '?';
      const cls = word === '1' ? 'ok' : /[xz]/i.test(word) ? 'warn' : '';
      rows.push(`<div class="pin-row"><span class="dir output"></span><span>${esc(n)} <span class="net">output</span></span><span class="badge ${cls}">${esc(word)}</span></div>`);
    }
    return rows.join('') || '<div class="empty">This sheet has no logic input or output.</div>';
  }

  tableHtml(table) {
    const head = [...table.inputs, ...table.outputs].map((n) => `<th>${esc(n)}</th>`).join('');
    const rows = table.rows
      .map((r) => `<tr>${r.inputs.map((v) => `<td class="num">${esc(v)}</td>`).join('')}${table.outputs.map((n) => `<td class="num">${esc(r.outputs[n] ?? '')}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="card"><header>Truth table <span class="count">${table.rows.length} row(s)</span></header>
      <div class="body tight"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
      ${table.rows.length >= 64 ? '<div class="note warn" style="margin-top:6px">Truncated at 64 rows: a full table for this many inputs would not fit. The simulation itself is not truncated.</div>' : ''}
      </div></div>`;
  }
}

function valueOfWord(word) {
  if (!word) return 'X';
  if (word.length > 1) return 'bus';
  if (word === '1') return 1;
  if (word === '0') return 0;
  if (word.toLowerCase() === 'z') return 'Z';
  return 'X';
}

function safeName(nl, elementIndex) {
  try {
    return cf.elementName(nl, elementIndex);
  } catch {
    return `e${elementIndex}`;
  }
}

function refOfElement(nl, elementIndex) {
  try {
    const inst = nl.elementInstance ? nl.elementInstance[elementIndex] : null;
    if (inst !== null && inst !== undefined && nl.instances && nl.instances[inst]) {
      const path = nl.instances[inst].path ?? '';
      return path.split('/')[0] || null;
    }
  } catch {
    /* provenance was not recorded for this element */
  }
  return null;
}

function voltageTable(voltages) {
  if (!voltages || voltages.length === 0) return '<div class="empty">No node voltage.</div>';
  return `<table class="grid"><thead><tr><th class="num">Node</th><th>Name</th><th class="num">Voltage</th></tr></thead><tbody>${voltages
    .map((v) => `<tr><td class="num">${v.node}</td><td class="txt">${esc(v.name)}</td><td class="num">${eng(v.voltage, 'V')}</td></tr>`)
    .join('')}</tbody></table>`;
}

function powerTable(powers, total) {
  if (!powers || powers.length === 0) return '<div class="empty">No element power was computed.</div>';
  return `<div class="group-title">Element power <span class="count">Σ dissipated ${eng(total, 'W')}</span></div>
    <table class="grid"><thead><tr><th class="num">Element</th><th>Name</th><th class="num">Power</th></tr></thead><tbody>${powers
      .slice(0, 60)
      .map((p) => `<tr><td class="num">${p.element}</td><td class="txt">${esc(p.name)}</td><td class="num" style="color:${p.power > 0 ? 'var(--warn)' : 'var(--text-dim)'}">${eng(p.power, 'W')}</td></tr>`)
      .join('')}</tbody></table>
    <div class="note" style="margin-top:6px">Power is signed: positive is absorbed, negative is delivered. Σ dissipated counts absorption only.</div>`;
}

function thermalCard(thermal) {
  const rows = thermal.temperatures ?? thermal.rows ?? [];
  const max = thermal.maxTemperature ?? (Array.isArray(rows) ? Math.max(...rows.map((r) => r.temperature ?? -Infinity)) : null);
  return `<div class="card"><header>Level 3 — thermal steady state ${Number.isFinite(max) ? `<span class="badge ${max > 125 ? 'bad' : 'ok'}">max ${fmtNumber(max, 1)} °C</span>` : ''}</header>
    <div class="body tight">
      <dl class="kv"><dt>Ambient</dt><dd>${fmtNumber(thermal.ambient ?? 25, 1)} °C</dd>
      <dt>Nodes</dt><dd>${Array.isArray(rows) ? rows.length : thermal.nodeCount ?? '—'}</dd>
      <dt>Converged</dt><dd>${thermal.converged === false ? '<span class="badge bad">no</span>' : 'yes'}</dd></dl>
      ${
        Array.isArray(rows) && rows.length > 0
          ? `<table class="grid" style="margin-top:6px"><thead><tr><th>Instance</th><th class="num">Power</th><th class="num">Rth</th><th class="num">T</th></tr></thead><tbody>${rows
              .slice(0, 60)
              .map((r) => `<tr><td class="txt">${esc(r.ref ?? r.name ?? r.path ?? '')}</td><td class="num">${eng(r.power ?? 0, 'W')}</td><td class="num">${eng(r.rth ?? r.rthJa ?? 0, 'K/W')}</td><td class="num" style="color:${r.hot ? 'var(--bad)' : 'inherit'}">${fmtNumber(r.temperature ?? 0, 1)} °C</td></tr>`)
              .join('')}</tbody></table>`
          : ''
      }
      <div class="note warn" style="margin-top:6px">Lumped RC thermal network: one node per instance, steady state only. Transient thermal mass is modelled when a sweep is run, and the coupling is two-way only where the model declares it.</div>
    </div></div>`;
}

function statsCard(stats) {
  const rows = [
    ['Instances', stats.instances],
    ['Distinct types', stats.distinctSpecs],
    ['Elements', stats.elements],
    ['Nets', stats.nets],
    ['Ports', stats.ports],
    ['Hierarchy depth', stats.hierarchyDepth],
    ['Models', stats.models],
    ['Expanded transistors', stats.expandedTransistors],
  ];
  return `<div class="card"><header>Circuit statistics <span class="count">measured</span></header>
    <div class="body tight"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v ?? '—'))}</dd>`).join('')}</dl>
    ${stats.fanout ? `<div class="group-title">Fan-out</div><dl class="kv"><dt>Max</dt><dd>${stats.fanout.max ?? '—'}</dd><dt>Average</dt><dd>${fmtNumber(stats.fanout.average ?? 0, 2)}</dd><dt>Nets with no consumer</dt><dd>${stats.fanout.unconsumed ?? stats.fanout.noConsumer ?? '—'}</dd></dl>` : ''}
    </div></div>`;
}

// ---------------------------------------------------------------------------
// Oscilloscope
// ---------------------------------------------------------------------------

export class ScopePane {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.scope = null;
    this.capture = null;
    this.channels = [];
    this.tstop = 0.01;
    this.maxSamples = 2000;
    this.showCursors = true;
    this.cursors = null;
    this.zoomRange = null;
    this.canvas = document.getElementById('scope-canvas');
    this.toolbar = document.getElementById('scope-toolbar');
    this.readout = document.getElementById('scope-readout');
    this.toolbar.innerHTML = `
      <label>measure
        <select id="scope-measure">
          <option value="voltage">voltage</option><option value="current">current</option>
          <option value="power">power</option><option value="temperature">temperature</option>
          <option value="logic">logic</option>
        </select>
      </label>
      <input type="text" id="scope-target" placeholder="target: node name or instance path" style="width:220px" spellcheck="false" />
      <button id="scope-add">Add channel</button>
      <span class="tsep"></span>
      <label>tstop <input type="number" id="scope-tstop" value="0.01" step="0.001" style="width:82px" /> s</label>
      <label>samples <input type="number" id="scope-samples" value="2000" step="100" style="width:80px" /></label>
      <button class="primary" id="scope-run">Capture</button>
      <span class="tsep"></span>
      <button id="scope-reset">Reset zoom</button>
      <button id="scope-cursors">Cursors</button>
      <button id="scope-spectrum">Spectrum</button>
      <button id="scope-csv">CSV</button>
      <button id="scope-text">Text report</button>
      <span id="scope-channels" style="display:flex;gap:4px;flex-wrap:wrap"></span>`;
    this.toolbar.querySelector('#scope-add').addEventListener('click', () => this.addChannel());
    this.toolbar.querySelector('#scope-run').addEventListener('click', () => this.run());
    this.toolbar.querySelector('#scope-reset').addEventListener('click', () => this.resetZoom());
    this.toolbar.querySelector('#scope-cursors').addEventListener('click', () => {
      this.showCursors = !this.showCursors;
      this.draw();
    });
    this.toolbar.querySelector('#scope-csv').addEventListener('click', () => this.exportCsv());
    this.toolbar.querySelector('#scope-text').addEventListener('click', () => this.exportText());
    this.toolbar.querySelector('#scope-spectrum').addEventListener('click', () => this.showSpectrum());
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', () => this.onUp());
    this.canvas.addEventListener('dblclick', () => this.resetZoom());
    this.readout.innerHTML = '<span class="empty" style="padding:0">No capture yet.</span>';
  }

  setScope(scope, capture) {
    this.scope = scope;
    this.capture = capture;
    this.channels = scope.channels().map((c, i) => ({ ...c.request, index: i, color: c.request.color ?? CHANNEL_COLORS[i % CHANNEL_COLORS.length], visible: c.request.visible !== false }));
    this.renderChannels();
    this.draw();
    this.renderReadout();
    this.app.log(`oscilloscope received a capture from the simulation dock: ${this.channels.length} channel(s)`, 'info', 'scope');
  }

  addChannel() {
    const measure = this.toolbar.querySelector('#scope-measure').value;
    const target = this.toolbar.querySelector('#scope-target').value.trim();
    if (!target) {
      this.app.log('a channel needs a target: a node name for a voltage, an instance path for a current, a power or a temperature', 'warn', 'scope');
      return;
    }
    this.channels.push({ measure, target, name: target, visible: true, color: CHANNEL_COLORS[this.channels.length % CHANNEL_COLORS.length] });
    this.toolbar.querySelector('#scope-target').value = '';
    this.renderChannels();
    this.app.log(`channel added: ${measure} at ${target}`, 'info', 'scope');
  }

  renderChannels() {
    const el = this.toolbar.querySelector('#scope-channels');
    el.innerHTML = this.channels
      .map(
        (c, i) =>
          `<span class="badge" style="border-color:${c.color};color:${c.color}">${esc(c.name ?? c.target)}<a href="#" data-remove-channel="${i}" style="margin-left:5px;color:inherit;text-decoration:none" title="Remove">✕</a></span>`,
      )
      .join('');
    el.querySelectorAll('[data-remove-channel]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.channels.splice(Number(a.dataset.removeChannel), 1);
        this.renderChannels();
      }),
    );
  }

  run() {
    if (this.channels.length === 0) {
      this.app.log('add at least one channel before capturing', 'warn', 'scope');
      return;
    }
    this.tstop = Number(this.toolbar.querySelector('#scope-tstop').value) || 0.01;
    this.maxSamples = Number(this.toolbar.querySelector('#scope-samples').value) || 2000;
    const editor = this.app.editor;
    try {
      const t0 = performance.now();
      const sim = this.app.simulation;
      const wantsThermal = this.channels.some((c) => c.measure === 'temperature');
      const nl = cf.flatten(editor.circuit, editor.lib, editor.chips, { ambient: sim?.options.ambient ?? 25, thermal: wantsThermal, metadata: true });
      const simulator = new cf.CircuitSimulator(nl, { ambient: sim?.options.ambient ?? 25 });
      simulator.dcSolve({ quiet: true });
      const scope = new cf.Oscilloscope(simulator);
      for (const c of this.channels) scope.addChannel({ measure: c.measure, target: c.target, name: c.name, color: c.color, visible: c.visible });
      const capture = scope.run({ tstop: this.tstop, maxSamples: this.maxSamples });
      this.scope = scope;
      this.capture = capture;
      this.zoomRange = null;
      this.cursors = null;
      const ms = performance.now() - t0;
      const unresolved = scope.channels().filter((c) => !c.probe);
      this.app.log(
        `captured ${this.channels.length} channel(s) over ${eng(this.tstop, 's')} in ${fmtMs(ms)}${capture && capture.samples ? ` · ${capture.samples} samples, ${capture.steps} accepted steps, ${capture.rejectedSteps ?? 0} rejected` : ''}`,
        'ok',
        'scope',
      );
      if (unresolved.length > 0) {
        this.app.log(`${unresolved.length} channel target(s) could not be resolved: ${unresolved.map((c) => c.request.target).join(', ')}`, 'error', 'scope');
      }
      if (capture && capture.convergence && capture.convergence.converged === false) {
        this.app.log(`the run behind these traces did not converge (worst voltage error ${eng(capture.convergence.worstVoltageError, 'V')}); the waveforms are the last iterate, not a solution`, 'error', 'scope');
      }
      this.draw();
      this.renderReadout();
    } catch (err) {
      this.app.log(`capture failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'scope');
    }
  }

  /** Called by the dock when it becomes visible, so the plot matches its box. */
  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round((rect.height - 4) * dpr));
    this.canvas.style.width = `${Math.round(rect.width)}px`;
    this.canvas.style.height = `${Math.round(rect.height - 4)}px`;
    this.dpr = dpr;
    this.draw();
  }

  traces() {
    if (!this.scope) return [];
    const out = [];
    for (let i = 0; i < this.channels.length; i++) {
      const trace = this.scope.trace(i);
      if (trace) out.push({ index: i, trace, channel: this.channels[i] });
    }
    return out;
  }

  timeRange() {
    const traces = this.traces();
    if (traces.length === 0) return null;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const { trace } of traces) {
      if (trace.times.length === 0) continue;
      t0 = Math.min(t0, trace.times[0]);
      t1 = Math.max(t1, trace.times[trace.times.length - 1]);
    }
    if (!Number.isFinite(t0)) return null;
    return this.zoomRange ?? { t0, t1 };
  }

  draw() {
    if (!this.canvas.width) this.resize();
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.dpr || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg-input').trim() || '#171a20';
    ctx.fillRect(0, 0, w, h);
    const range = this.timeRange();
    const pad = { l: 54, r: 12, t: 10, b: 22 };
    const plotW = Math.max(10, w - pad.l - pad.r);
    const plotH = Math.max(10, h - pad.t - pad.b);
    const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#9aa1b1';
    const gridColor = getComputedStyle(document.body).getPropertyValue('--line-soft').trim() || '#23262e';

    if (!range) {
      ctx.fillStyle = textColor;
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No capture. Add a channel and press Capture.', w / 2, h / 2);
      return;
    }

    const traces = this.traces().filter((t) => t.trace.times.length > 0);
    // Each channel gets its own vertical division of the plot, which is what a real
    // scope does when the channels have different units: volts and degrees Celsius
    // cannot share an axis.
    const perChannel = traces.length > 0 ? plotH / traces.length : plotH;
    const xOf = (t) => pad.l + ((t - range.t0) / Math.max(1e-18, range.t1 - range.t0)) * plotW;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = textColor;
    for (let i = 0; i <= 10; i++) {
      const x = pad.l + (i / 10) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      if (i % 2 === 0) {
        const t = range.t0 + (i / 10) * (range.t1 - range.t0);
        ctx.textAlign = 'center';
        ctx.fillText(eng(t, 's'), x, h - 7);
      }
    }

    traces.forEach(({ trace, channel, index }, slot) => {
      const top = pad.t + slot * perChannel;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < trace.values.length; i++) {
        const v = trace.values[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min)) return;
      if (max - min < 1e-12) {
        max = min + 1;
        min = min - 1;
      }
      const margin = (max - min) * 0.12;
      min -= margin;
      max += margin;
      const yOf = (v) => top + perChannel - ((v - min) / (max - min)) * (perChannel - 6) - 3;
      // Horizontal graticule and the axis labels for this channel.
      ctx.strokeStyle = gridColor;
      for (let i = 0; i <= 4; i++) {
        const y = top + (i / 4) * perChannel;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + plotW, y);
        ctx.stroke();
      }
      ctx.fillStyle = channel.color;
      ctx.textAlign = 'left';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`${channel.name ?? channel.target} (${trace.unit})`, pad.l + 4, top + 11);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      ctx.fillText(eng(max, ''), pad.l - 5, top + 11);
      ctx.fillText(eng(min, ''), pad.l - 5, top + perChannel - 3);
      // The trace itself.
      ctx.beginPath();
      ctx.strokeStyle = channel.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      let started = false;
      for (let i = 0; i < trace.times.length; i++) {
        const t = trace.times[i];
        if (t < range.t0 || t > range.t1) continue;
        const x = xOf(t);
        const y = yOf(trace.values[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      void index;
    });

    // Cursors: two vertical lines with the interval and its reciprocal between them.
    if (this.showCursors && this.cursors) {
      const { t1, t2 } = this.cursors;
      ctx.strokeStyle = '#e6e8ee';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      for (const t of [t1, t2]) {
        const x = xOf(t);
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + plotH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const dt = Math.abs(t2 - t1);
      ctx.fillStyle = '#e6e8ee';
      ctx.textAlign = 'left';
      ctx.fillText(`Δt ${eng(dt, 's')}   1/Δt ${dt > 0 ? eng(1 / dt, 'Hz') : '—'}`, pad.l + 6, pad.t + plotH - 6);
    }
    this.plot = { pad, plotW, plotH, range };
  }

  onDown(e) {
    if (!this.plot) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = this.plot.range.t0 + ((x - this.plot.pad.l) / this.plot.plotW) * (this.plot.range.t1 - this.plot.range.t0);
    this.drag = { from: t, to: t, x0: x };
    if (e.shiftKey) this.cursors = { t1: t, t2: t };
  }

  onMove(e) {
    if (!this.drag || !this.plot) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = this.plot.range.t0 + ((x - this.plot.pad.l) / this.plot.plotW) * (this.plot.range.t1 - this.plot.range.t0);
    this.drag.to = t;
    if (this.cursors) {
      this.cursors.t2 = t;
      this.draw();
      this.renderReadout();
    }
  }

  onUp() {
    if (!this.drag) return;
    const { from, to } = this.drag;
    this.drag = null;
    if (this.cursors) return;
    if (Math.abs(to - from) < (this.plot?.range.t1 - this.plot?.range.t0 ?? 1) * 0.01) return;
    this.zoomRange = { t0: Math.min(from, to), t1: Math.max(from, to) };
    if (this.scope) this.scope.zoom(this.zoomRange.t0, this.zoomRange.t1);
    this.draw();
    this.renderReadout();
    this.app.log(`oscilloscope zoomed to ${eng(this.zoomRange.t0, 's')} … ${eng(this.zoomRange.t1, 's')}`, 'info', 'scope');
  }

  resetZoom() {
    this.zoomRange = null;
    if (this.scope) this.scope.resetZoom();
    this.draw();
    this.renderReadout();
  }

  renderReadout() {
    if (!this.scope) {
      this.readout.innerHTML = '<span class="empty" style="padding:0">No capture yet.</span>';
      return;
    }
    const parts = [];
    for (let i = 0; i < this.channels.length; i++) {
      const stats = this.scope.stats(i);
      const freq = this.scope.frequency(i);
      const duty = this.scope.duty(i);
      if (!stats) {
        parts.push(`<span><b style="color:${this.channels[i].color}">${esc(this.channels[i].name ?? this.channels[i].target)}</b> — not resolved</span>`);
        continue;
      }
      parts.push(
        `<span><b style="color:${this.channels[i].color}">${esc(this.channels[i].name ?? this.channels[i].target)}</b> ` +
          `mean <b>${eng(stats.mean, stats.unit)}</b> · rms <b>${eng(stats.rms, stats.unit)}</b> · min <b>${eng(stats.min, stats.unit)}</b> · max <b>${eng(stats.max, stats.unit)}</b> · pp <b>${eng(stats.peakToPeak, stats.unit)}</b>` +
          (freq && freq.frequency ? ` · f <b>${eng(freq.frequency, 'Hz')}</b> · T <b>${eng(1 / freq.frequency, 's')}</b>${freq.method ? ` (${esc(freq.method)})` : ''}` : '') +
          (duty && Number.isFinite(duty.dutyCycle) ? ` · duty <b>${pct(duty.dutyCycle * 100, 100, 1)}</b>` : '') +
          `</span>`,
      );
    }
    if (this.cursors) {
      const dt = Math.abs(this.cursors.t2 - this.cursors.t1);
      parts.push(`<span>cursors Δt <b>${eng(dt, 's')}</b> · 1/Δt <b>${dt > 0 ? eng(1 / dt, 'Hz') : '—'}</b></span>`);
    }
    if (this.capture) {
      const c = this.capture;
      parts.push(
        `<span>capture <b>${c.samples ?? '—'}</b> samples · <b>${c.steps ?? '—'}</b> accepted · <b>${c.rejectedSteps ?? 0}</b> rejected · ${c.convergence ? (c.convergence.converged ? '<b>converged</b>' : '<b style="color:var(--bad)">NOT converged</b>') : ''} · ${fmtMs(c.wallMs ?? 0)}</span>`,
      );
      if (c.notes && c.notes.length > 0) parts.push(`<span style="color:var(--text-faint)">${esc(c.notes.join(' · '))}</span>`);
    }
    this.readout.innerHTML = parts.join('');
  }

  exportCsv() {
    if (!this.scope) return this.app.log('nothing captured to export', 'warn', 'scope');
    const csv = this.scope.toCsv({ includeHeader: true });
    const bytes = download(`circuitforge-scope-${Date.now()}.csv`, csv, 'text/csv');
    this.app.log(`exported ${fmtBytes(bytes)} of CSV (${csv.split('\n').length - 1} line(s))`, 'ok', 'scope');
  }

  exportText() {
    if (!this.scope) return this.app.log('nothing captured to report', 'warn', 'scope');
    const text = this.scope.toText({ verbose: true });
    download(`circuitforge-scope-${Date.now()}.txt`, text, 'text/plain');
    this.app.log('exported the oscilloscope text report', 'ok', 'scope');
    this.app.showText('Oscilloscope report', text);
  }

  showSpectrum() {
    if (!this.scope) return this.app.log('nothing captured to analyse', 'warn', 'scope');
    const index = this.channels.findIndex((c) => c.measure === 'voltage');
    const reading = this.scope.spectrum(index >= 0 ? index : 0, { window: 'hann', removeDc: true });
    if (!reading) return this.app.log('the spectrum could not be computed for this channel', 'warn', 'scope');
    const lines = [
      `Channel: ${reading.name ?? this.channels[index >= 0 ? index : 0]?.target ?? '?'}`,
      `Window: ${reading.window ?? 'hann'}   points: ${reading.points ?? '?'}   ENBW: ${reading.enbwHz !== undefined ? eng(reading.enbwHz, 'Hz') : '—'}`,
      `Peak: ${eng(reading.peakHz ?? reading.fundamentalHz ?? 0, 'Hz')} at ${eng(reading.peakMagnitude ?? 0, reading.unit ?? '')}`,
      reading.thd ? `THD: ${pct(reading.thd.thd ?? reading.thd.percent ?? 0, 100, 3)} over ${reading.thd.orders ?? '?'} order(s)` : 'THD: not computed',
      '',
      'Top spectral lines:',
      ...(reading.lines ?? reading.peaks ?? [])
        .slice(0, 14)
        .map((l, i) => `  ${String(i + 1).padStart(2)}. ${eng(l.frequency ?? l.hz ?? 0, 'Hz')}  ${eng(l.magnitude ?? l.amplitude ?? 0, '')}`),
    ];
    this.app.showText('Spectrum', lines.join('\n'));
    this.app.log(`spectrum computed: peak ${eng(reading.peakHz ?? reading.fundamentalHz ?? 0, 'Hz')}${reading.thd ? `, THD ${pct(reading.thd.thd ?? reading.thd.percent ?? 0, 100, 3)}` : ''}`, 'info', 'scope');
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export class AnalysisPane {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.report = null;
    this.mining = null;
    root.innerHTML = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <button class="primary" data-an="run">Analyze circuit</button>
        <button data-an="critical">Highlight critical path</button>
        <button data-an="unused">Select unused components</button>
        <button data-an="mine" title="Grow fan-in cones over the flattened logic, group them by a canonical form, measure what each one computes, and compare it with the chip library">Find repeated subcircuits</button>
        <button data-an="save">Save report</button>
        <span id="an-summary" class="badge"></span>
      </div><div id="an-body"><div class="empty">Run the analyzer to get the critical path, unused components, redundant connections, fan-out risks, loops and constraint violations — with the timing model that produced them named.</div></div>
      <div id="an-mine"></div>`;
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-an]');
      if (!el) return;
      const action = el.dataset.an;
      if (action === 'run') this.run();
      else if (action === 'critical') this.highlightCritical();
      else if (action === 'unused') this.selectUnused();
      else if (action === 'mine') this.mine();
      else if (action === 'save') this.save();
      return;
    });
    // Replacement and extraction are offered per pattern, inside the mining cards.
    root.addEventListener('click', (e) => {
      const replace = e.target.closest('[data-mine-replace]');
      if (replace && !replace.disabled) {
        this.replacePattern(replace.dataset.mineReplace);
        return;
      }
      const extract = e.target.closest('[data-mine-extract]');
      if (extract && !extract.disabled) this.extractPattern(extract.dataset.mineExtract);
    });
  }

  /**
   * Find the subcircuits this sheet repeats, and say which chip computes the same thing.
   *
   * The identity test is a measured one: each block's truth table is produced by
   * simulating it at level 0 and compared with the library chip's, row by row. A block
   * that matches on every row is offered for replacement; one that differs on some rows
   * is reported with the number of rows that differ and is *not* offered, because
   * substituting it would change what the circuit computes.
   */
  mine() {
    const editor = this.app.editor;
    try {
      const t0 = performance.now();
      this.mining = cf.mining.mineSubcircuits(editor.circuit, editor.lib, editor.chips, {});
      // A mined pattern is a list of element indices into *this* circuit. Editing the
      // sheet invalidates them, and acting on stale indices would rewrite the wrong
      // gates — so the revision is remembered and checked before any replacement.
      this.miningRevision = editor.circuit.revision;
      const r = this.mining;
      const identical = r.patterns.filter((p) => p.matchedChip?.identical && !p.subBlockOf).length;
      this.app.log(
        `mined ${editor.circuit.name} in ${fmtMs(performance.now() - t0)}: ${r.patterns.length} repeated block(s), ${r.matched} matched a library chip, ${identical} identical and replaceable`,
        r.patterns.length === 0 ? 'info' : 'ok',
        'analyze',
      );
      for (const note of r.notes) this.app.log(`  ${note}`, 'info', 'analyze');
      this.renderMining();
    } catch (err) {
      this.app.log(`mining failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'analyze');
    }
  }

  renderMining() {
    const host = this.root.querySelector('#an-mine');
    const r = this.mining;
    if (!host) return;
    if (!r) {
      host.innerHTML = '';
      return;
    }
    if (r.patterns.length === 0) {
      host.innerHTML = `<div class="card"><header>Repeated subcircuits</header><div class="body"><div class="empty">Nothing repeats within the searched depth. ${esc(r.notes[0] ?? '')}</div></div></div>`;
      return;
    }
    const cards = r.patterns.map((p) => {
      const chip = p.matchedChip;
      const badge = chip
        ? chip.identical
          ? `<span class="badge ok">identical to ${esc(chip.id)} v${esc(chip.version)}</span>`
          : `<span class="badge warn">differs from ${esc(chip.id)} on ${chip.differingRows} row(s)</span>`
        : `<span class="badge">no chip computes this — a new one would be ${esc(p.suggestedChip?.name ?? '?')}</span>`;
      const replaceable = p.saving.replaceable > 0 && chip?.identical && !p.subBlockOf;
      // Extraction needs an occurrence on this sheet to copy, and a measured pattern to
      // check the copy against: an unmeasured block cannot be verified, so it is not
      // offered as a chip.
      const extractable = p.saving.replaceable > 0 && p.behaviour?.measured === true && p.behaviour?.complete === true;
      const table = p.behaviour?.rows?.length
        ? `<div class="group-title">Measured truth table</div><pre class="code" style="max-height:96px">${esc(p.behaviour.rows.slice(0, 32).join(' '))}${p.behaviour.rows.length > 32 ? ' …' : ''}</pre>`
        : '';
      const behaviour = p.behaviour?.measured
        ? `${p.behaviour.inputs} in → ${p.behaviour.outputs} out, ${p.behaviour.rows.length} combination(s) measured${p.behaviour.complete ? ' exhaustively' : ', not exhaustive'}`
        : `NOT MEASURED — ${p.behaviour?.reason ?? 'unknown'}`;
      const why = replaceable
        ? `Replace all ${p.saving.replaceable} occurrence(s) with ${chip?.id ?? 'the chip'}. Undoable: the sheet before the rewrite is checkpointed.`
        : chip?.identical
          ? p.subBlockOf
            ? 'Sub-block of a larger reported pattern: replacing this first would break it.'
            : 'No occurrence of this pattern is on this sheet — they live inside chip expansions, which belong to another sheet.'
          : 'Not identical to any library chip, so it will not be substituted.';
      return `<div class="card">
        <header>${esc(p.description)} <span class="badge info">${p.count}× · ${p.size} element(s)</span> ${badge}</header>
        <div class="body tight">
          <dl class="kv">
            <dt>Behaviour</dt><dd>${esc(behaviour)}</dd>
            <dt>On this sheet</dt><dd>${p.saving.replaceable} of ${p.count} occurrence(s)</dd>
            <dt>Would remove</dt><dd>about ${p.saving.componentsTotal} component(s)</dd>
            ${p.subBlockOf ? `<dt>Sub-block of</dt><dd>[${esc(p.subBlockOf)}]</dd>` : ''}
          </dl>
          ${table}
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
            <button data-mine-replace="${esc(p.id)}" ${replaceable ? '' : 'disabled'}>${chip?.identical ? `Replace with ${esc(chip.id)}` : 'No identical chip'}</button>
            <button data-mine-extract="${esc(p.id)}" ${extractable ? '' : 'disabled'} title="${extractable ? `Build a chip out of one occurrence, measure it again to prove it computes the same thing, and register it in both libraries. Afterwards the search matches this block against the new chip, and replacement becomes available.` : p.behaviour?.measured ? 'No occurrence of this pattern is on this sheet' : 'The block was not measured, so a copy could not be verified'}">Save as new chip</button>
            <span class="note">${esc(why)}</span>
          </div>
        </div>
      </div>`;
    });
    host.innerHTML = `<div class="card"><header>Repeated subcircuits <span class="badge">${r.elements} logic element(s) · ${r.ms.toFixed(1)} ms</span></header><div class="body"><div class="empty">Blocks the sheet repeats, what each one computes (measured at level 0), and the library chip that computes the same thing. Equality of shape is a strong test but not a proof of isomorphism; the measured truth table is what confirms a match.</div></div></div>${cards.join('')}`;
  }

  /**
   * Build a chip out of one occurrence of a pattern.
   *
   * This is the other half of de-duplication: matching only helps when somebody already
   * wrote a chip for the block a design repeats. The engine copies the components, turns
   * the nets that crossed the boundary into ports, and then **measures the copy** — if it
   * does not reproduce the pattern's truth table row for row, nothing is registered and
   * the console says how many rows differ.
   */
  extractPattern(patternId) {
    const editor = this.app.editor;
    const pattern = this.mining?.patterns.find((p) => p.id === patternId);
    if (!pattern) {
      this.app.log(`no mined pattern "${patternId}" — run the search again`, 'warn', 'analyze');
      return;
    }
    if (editor.circuit.revision !== this.miningRevision) {
      this.app.log(`the sheet changed since the search (revision ${this.miningRevision} → ${editor.circuit.revision}), so the pattern's element indices are stale; run "Find repeated subcircuits" again`, 'warn', 'analyze');
      this.mining = null;
      this.renderMining();
      return;
    }
    try {
      const result = cf.mining.extractPatternAsChip(editor.circuit, editor.lib, editor.chips, pattern, {});
      for (const note of result.notes) this.app.log(`  ${note}`, 'info', 'analyze');
      for (const d of result.diagnostics) {
        if (d.severity === 'error') this.app.log(`  ${d.code ?? ''} ${d.message}${d.hint ? ` — ${d.hint}` : ''}`, 'error', 'analyze');
        else if (d.severity === 'warning') this.app.log(`  ${d.code ?? ''} ${d.message}`, 'warn', 'analyze');
      }
      if (!result.chip) {
        this.app.log(`extraction refused: the chip was not registered`, 'warn', 'analyze');
        return;
      }
      const ports = result.chip.def.ports.map((pt) => `${pt.name} (${pt.direction})`).join(', ');
      this.app.log(
        `chip ${result.chipId} v${result.chip.def.version} created from ${pattern.id} and verified by measurement (${result.measured.rows.length} row(s), ${result.differingRows} differing): ${ports}`,
        'ok',
        'analyze',
      );
      this.app.palette?.render();
      // Re-mining is what makes the new chip useful: the same block now matches a chip in
      // the library identically, so the replacement button enables itself.
      this.mine();
    } catch (err) {
      this.app.log(`extraction failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'analyze');
    }
  }

  /**
   * Substitute a pattern with the chip it matched.
   *
   * The engine returns a rewritten circuit rather than editing in place, so the editor
   * swaps the sheet through `replaceSheet`, which checkpoints first: a bulk rewrite is
   * an edit, and Ctrl+Z has to give the sheet back.
   */
  replacePattern(patternId) {
    const editor = this.app.editor;
    const pattern = this.mining?.patterns.find((p) => p.id === patternId);
    if (!pattern) {
      this.app.log(`no mined pattern "${patternId}" — run the search again`, 'warn', 'analyze');
      return;
    }
    if (!pattern.matchedChip?.identical) {
      this.app.log(`refusing to replace ${patternId}: it is not identical to any chip, so substituting it would change what the circuit computes`, 'warn', 'analyze');
      return;
    }
    if (editor.circuit.revision !== this.miningRevision) {
      this.app.log(`the sheet changed since the search (revision ${this.miningRevision} → ${editor.circuit.revision}), so the pattern's element indices are stale; run "Find repeated subcircuits" again`, 'warn', 'analyze');
      this.mining = null;
      this.renderMining();
      return;
    }
    try {
      const result = cf.mining.replacePatternWithChip(editor.circuit, editor.lib, editor.chips, pattern, {});
      editor.replaceSheet(result.circuit, 'mine');
      for (const note of result.notes) this.app.log(`  ${note}`, 'info', 'analyze');
      for (const d of result.diagnostics) {
        if (d.severity === 'error' || d.severity === 'warning') this.app.log(`  ${d.code ?? ''} ${d.message}`, d.severity === 'error' ? 'error' : 'warn', 'analyze');
      }
      this.app.log(
        `replaced ${result.replaced} of ${pattern.count} occurrence(s) with ${result.chipId}: ${result.componentsBefore} component(s) became ${result.componentsAfter}, ${result.netsBefore} net(s) became ${result.netsAfter}`,
        result.replaced > 0 ? 'ok' : 'warn',
        'analyze',
      );
      if (result.skipped.length > 0) {
        this.app.log(`  ${result.skipped.length} occurrence(s) skipped: ${result.skipped.slice(0, 3).map((k) => k.reason).join('; ')}${result.skipped.length > 3 ? '; …' : ''}`, 'info', 'analyze');
      }
      this.app.view?.invalidate?.();
      this.mine();
    } catch (err) {
      this.app.log(`replacement failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'analyze');
    }
  }

  run() {
    const editor = this.app.editor;
    try {
      const t0 = performance.now();
      this.report = cf.analyzeCircuit(editor.circuit, editor.lib, editor.chips);
      const ms = performance.now() - t0;
      this.app.log(`analysis of ${this.report.name} finished in ${fmtMs(ms)}: ${this.report.counts.errors} error(s), ${this.report.counts.warnings} warning(s), ${this.report.counts.infos} information item(s)`, this.report.counts.errors > 0 ? 'warn' : 'ok', 'analyze');
      this.render();
    } catch (err) {
      this.app.log(`analysis failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'analyze');
    }
  }

  render() {
    const r = this.report;
    const body = this.root.querySelector('#an-body');
    const summary = this.root.querySelector('#an-summary');
    if (!r) return;
    summary.className = `badge ${r.counts.errors ? 'bad' : r.counts.warnings ? 'warn' : 'ok'}`;
    summary.textContent = `${r.counts.errors} err · ${r.counts.warnings} warn · ${r.counts.infos} info`;
    const timing = r.timing ?? {};
    const cp = timing.criticalPath ?? null;
    const parts = [];
    parts.push(`<div class="card"><header>Summary</header><div class="body tight"><pre class="code" style="max-height:200px">${esc(r.summary ?? '')}</pre></div></div>`);
    if (cp) {
      parts.push(`<div class="card"><header>Critical path <span class="badge ${cp.delay > 0 ? 'info' : 'warn'}">${fmtNumber(cp.delay * 1e9, 3)} ns over ${cp.stages} stage(s)</span></header>
        <div class="body tight">
          <dl class="kv"><dt>From</dt><dd>${esc(cp.startNet ?? '—')} (${esc(cp.startKind ?? '—')})</dd>
          <dt>To</dt><dd>${esc(cp.endNet ?? '—')} (${esc(cp.endKind ?? '—')})</dd>
          <dt>Clock bound</dt><dd>${timing.clockPeriod ? `period ≥ ${fmtNumber(timing.clockPeriod * 1e9, 3)} ns` : '—'}${timing.maxFrequency ? ` · ≤ ${eng(timing.maxFrequency, 'Hz')}` : ''}</dd>
          <dt>Combinational</dt><dd>${timing.combinationalDelay !== undefined ? fmtNumber(timing.combinationalDelay * 1e9, 3) + ' ns' : '—'}</dd></dl>
          <div class="group-title">Chain</div>
          <pre class="code" style="max-height:180px">${esc((cp.chain ?? []).join('\n'))}</pre>
          ${cp.delay === 0 ? `<div class="note warn">The path delay is 0 because every element on it declares no delay. Under the “${esc(r.timingModel?.name ?? 'declared delays')}” model that is a lower bound, not a measurement: no propagation time is claimed.</div>` : ''}
          <div class="note">Timing model: <b>${esc(r.timingModel?.name ?? '—')}</b> — ${esc(r.timingModel?.description ?? '')}</div>
        </div></div>`);
    }
    const zones = r.zones ?? {};
    if ((zones.slow?.length ?? 0) + (zones.hot?.length ?? 0) + (zones.power?.length ?? 0) > 0) {
      parts.push(`<div class="card"><header>Zones</header><div class="body tight">
        ${zoneTable('Slow', zones.slow)}${zoneTable('Hot', zones.hot)}${zoneTable('Power', zones.power)}
      </div></div>`);
    }
    if (r.findings && r.findings.length > 0) {
      parts.push(`<div class="card"><header>Findings <span class="count">${r.findings.length}</span></header><div class="body tight">
        <table class="grid"><thead><tr><th>Code</th><th>Severity</th><th>Category</th><th>Title</th><th>Detail</th></tr></thead><tbody>
        ${r.findings
          .map(
            (f) =>
              `<tr><td>${esc(f.code)}</td><td class="txt"><span class="badge ${f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'}">${esc(f.severity)}</span></td><td class="txt">${esc(f.category)}</td><td class="txt">${esc(f.title)}</td><td class="txt" style="white-space:normal">${esc(f.detail ?? '')}</td></tr>`,
          )
          .join('')}
        </tbody></table></div></div>`);
    }
    if (r.specs && r.specs.length > 0) {
      parts.push(`<div class="card"><header>By component type <span class="count">${r.specs.length}</span></header><div class="body tight">
        <table class="grid"><thead><tr><th>Type</th><th class="num">Instances</th><th class="num">Unused</th><th class="num">Elements</th><th class="num">Worst arrival</th><th class="num">Power</th></tr></thead><tbody>
        ${r.specs.map((s) => `<tr><td class="txt">${esc(s.name ?? s.specId)}</td><td class="num">${s.instances}</td><td class="num">${s.unusedInstances ?? 0}</td><td class="num">${s.elements ?? 0}</td><td class="num">${s.worstArrival !== undefined ? fmtNumber(s.worstArrival * 1e9, 3) + ' ns' : '—'}</td><td class="num">${s.totalPower !== undefined && s.totalPower !== null ? eng(s.totalPower, 'W') : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>`);
    }
    if (r.constraints && r.constraints.length > 0) {
      parts.push(`<div class="card"><header>Constraint violations</header><div class="body tight"><table class="grid"><tbody>${r.constraints.map((c) => `<tr><td class="txt">${esc(c.name ?? c.constraint ?? JSON.stringify(c))}</td><td class="txt">${esc(c.detail ?? c.message ?? '')}</td></tr>`).join('')}</tbody></table></div></div>`);
    }
    body.innerHTML = parts.join('');
  }

  highlightCritical() {
    const cp = this.report?.timing?.criticalPath;
    if (!cp) return this.app.log('run the analyzer first', 'warn', 'analyze');
    const refs = new Set();
    for (const step of cp.chain ?? []) {
      const match = /([A-Za-z]+[0-9]+)/.exec(String(step));
      if (match) refs.add(match[1]);
    }
    const known = [...refs].filter((r) => this.app.editor.byRef(r));
    if (known.length === 0) {
      this.app.log(`the critical path names ${refs.size} step(s) but none of them is a reference on this sheet (paths are hierarchical); the chain is printed in the report`, 'warn', 'analyze');
      return;
    }
    this.app.editor.select(known);
    this.app.view.focusSelection();
    this.app.log(`selected ${known.length} component(s) on the critical path`, 'info', 'analyze');
  }

  selectUnused() {
    const instances = this.report?.instances ?? [];
    const unused = instances.filter((i) => i.unused === true || (i.unusedOutputs ?? 0) > 0 || i.unreachable === true).map((i) => String(i.path ?? i.ref).split('/')[0]);
    const known = [...new Set(unused)].filter((r) => this.app.editor.byRef(r));
    if (known.length === 0) {
      this.app.log('the analyzer found no unused component that maps to a reference on this sheet', 'info', 'analyze');
      return;
    }
    this.app.editor.select(known);
    this.app.view.focusSelection();
    this.app.log(`selected ${known.length} component(s) the analyzer reports as unused`, 'info', 'analyze');
  }

  save() {
    if (!this.report) return this.app.log('nothing analyzed to save', 'warn', 'analyze');
    download(`circuitforge-analysis-${Date.now()}.json`, JSON.stringify(this.report, null, 2), 'application/json');
    this.app.log('analysis saved as JSON', 'ok', 'analyze');
  }
}

function zoneTable(title, rows) {
  if (!rows || rows.length === 0) return '';
  return `<div class="group-title">${esc(title)} <span class="count">${rows.length}</span></div>
    <table class="grid"><tbody>${rows.slice(0, 20).map((r) => `<tr><td class="txt">${esc(r.path ?? r.ref ?? r.name ?? '')}</td><td class="num">${esc(String(r.value ?? r.delay ?? r.temperature ?? r.power ?? ''))}</td><td class="txt">${esc(r.unit ?? '')}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export class JobsPane {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.poll = null;
    this.snapshot = null;
    this.progress = null;
    this.interrupted = [];
    root.innerHTML = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <span class="group-title" style="margin:0">Enqueue</span>
        <select id="job-kind">
          <option value="optimize">optimize</option><option value="validate">validate</option>
          <option value="simulate">simulate</option><option value="analyze">analyze</option>
          <option value="export">export</option><option value="benchmark">benchmark</option>
        </select>
        <select id="job-spec"></select>
        <select id="job-profile"></select>
        <label>budget <input type="number" id="job-budget" value="400" step="50" style="width:80px" /></label>
        <label>population <input type="number" id="job-pop" value="24" step="4" style="width:64px" /></label>
        <label>seed <input type="text" id="job-seed" value="1234" style="width:70px" /></label>
        <label><input type="checkbox" id="job-chip" /> save as chip</label>
        <button class="primary" id="job-enqueue">Enqueue</button>
        <span class="tsep"></span>
        <button id="job-refresh">Refresh</button>
        <label><input type="checkbox" id="job-autopoll" checked /> poll</label>
        <span id="job-progress-summary" class="badge"></span>
      </div>
      <div id="job-interrupted"></div>
      <div id="job-list"></div>
      <div id="job-history"></div>`;
    root.querySelector('#job-kind').addEventListener('change', () => this.syncKind());
    root.querySelector('#job-enqueue').addEventListener('click', () => this.enqueue());
    root.querySelector('#job-refresh').addEventListener('click', () => this.refresh());
    root.querySelector('#job-autopoll').addEventListener('change', (e) => this.setAutoPoll(e.target.checked));
    root.addEventListener('click', (e) => this.onClick(e));
    this.syncKind();
    this.refresh();
    this.setAutoPoll(true);
  }

  syncKind() {
    const kind = this.root.querySelector('#job-kind').value;
    const specEl = this.root.querySelector('#job-spec');
    const profileEl = this.root.querySelector('#job-profile');
    const optimizeLike = kind === 'optimize' || kind === 'validate';
    specEl.style.display = optimizeLike ? '' : 'none';
    profileEl.style.display = kind === 'optimize' ? '' : 'none';
    if (optimizeLike && specEl.options.length === 0) {
      for (const id of ['mux', 'adder', 'subtractor', 'comparator', 'alu_slice', 'and_not', 'majority']) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id;
        specEl.appendChild(o);
      }
    }
    if (kind === 'optimize' && profileEl.options.length === 0) {
      for (const p of ['BALANCED', 'FASTEST', 'SMALLEST', 'LOW_POWER', 'LOW_TEMPERATURE', 'MOST_STABLE']) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        profileEl.appendChild(o);
      }
    }
  }

  async enqueue() {
    const kind = this.root.querySelector('#job-kind').value;
    const specId = this.root.querySelector('#job-spec').value || 'and_not';
    const profile = this.root.querySelector('#job-profile').value || 'BALANCED';
    const evaluations = Number(this.root.querySelector('#job-budget').value) || 400;
    const populationSize = Number(this.root.querySelector('#job-pop').value) || 24;
    const seed = this.root.querySelector('#job-seed').value || '1234';
    const saveAsChip = this.root.querySelector('#job-chip').checked;
    let spec = {};
    let name = kind;
    if (kind === 'optimize') {
      spec = { specId, params: this.app.paramValuesFor(specId), profile, seed, populationSize, evaluations, detailTop: 3, saveAsChip, chipId: saveAsChip ? `${specId}_synth` : undefined };
      name = `optimize ${specId} (${profile}, ${evaluations} evals)`;
    } else if (kind === 'validate') {
      spec = { chipId: specId, specId, params: this.app.paramValuesFor(specId), seed, levels: { logic: true, electrical: true, timing: true, thermal: false } };
      name = `validate ${specId}`;
    } else if (kind === 'simulate') {
      spec = { circuit: this.app.editor.toDocument(), tstop: this.app.simulation?.options.tstop || 0, ambient: this.app.simulation?.options.ambient ?? 25, expandGates: false };
      name = `simulate ${this.app.editor.circuit.name}`;
    } else if (kind === 'analyze') {
      spec = { circuit: this.app.editor.toDocument(), verbose: true };
      name = `analyze ${this.app.editor.circuit.name}`;
    } else if (kind === 'export') {
      spec = { circuit: this.app.editor.toDocument(), level: this.app.view.options.level, artefacts: ['schematic', 'bom', 'spice'] };
      name = `export ${this.app.editor.circuit.name}`;
    } else if (kind === 'benchmark') {
      spec = { suite: 'quick', repeats: 1 };
      name = 'benchmark quick';
    }
    try {
      const result = await api.enqueue(kind, name, spec);
      this.app.log(`enqueued job ${result.job.id}: ${name}`, 'ok', 'jobs');
      this.refresh();
    } catch (err) {
      this.app.log(`enqueuing failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'jobs');
    }
  }

  setAutoPoll(on) {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (on) this.poll = setInterval(() => this.refresh(true), 1200);
  }

  async refresh(quiet = false) {
    try {
      const data = await api.jobs();
      this.snapshot = data.snapshot;
      this.progress = data.progress;
      this.interrupted = data.interrupted ?? [];
      this.render();
    } catch (err) {
      if (!quiet) this.app.log(`the job queue could not be reached: ${err.message}`, 'warn', 'jobs');
      this.root.querySelector('#job-list').innerHTML = `<div class="note bad">${esc(err.message)}${err.hint ? `<br/>${esc(err.hint)}` : ''}</div>`;
    }
  }

  render() {
    const jobs = this.snapshot?.jobs ?? [];
    const history = this.snapshot?.history ?? [];
    const summary = this.root.querySelector('#job-progress-summary');
    const p = this.progress ?? {};
    summary.textContent = `${p.jobs ?? jobs.length} job(s) · ${p.queuedCount ?? 0} queued · ${p.running ? 'running' : 'idle'} · ${fmtBytes((p.ramMB ?? 0) * 1024 * 1024)} RAM`;
    this.root.querySelector('#job-interrupted').innerHTML =
      this.interrupted.length > 0
        ? `<div class="note warn"><b>Previous job detected.</b> ${this.interrupted.length} job(s) were interrupted — most likely by a process that stopped. ${this.interrupted
            .map((i) => `<div>${esc(i.description ?? i.job?.name ?? i.job?.id ?? '')} <button data-resume-interrupted="${esc(i.job?.id ?? '')}"${i.resumable === false ? ' disabled title="no checkpoint to resume from"' : ''}>Resume</button></div>`)
            .join('')}</div>`
        : '';
    this.root.querySelector('#job-list').innerHTML =
      jobs.length === 0
        ? '<div class="empty">The queue is empty. Enqueue an optimization, a validation, a simulation, an analysis, an export or a benchmark above.</div>'
        : `<table class="grid"><thead><tr><th>Job</th><th>Kind</th><th>State</th><th style="min-width:120px">Progress</th><th class="num">Tested</th><th class="num">Rejected</th><th>Best</th><th class="num">ETA</th><th class="num">Elapsed</th><th>Actions</th></tr></thead><tbody>${jobs
            .map((j) => {
              const pr = j.progress ?? {};
              const fraction = pr.fraction !== null && pr.fraction !== undefined ? Math.max(0, Math.min(1, pr.fraction)) : j.state === 'done' ? 1 : 0;
              return `<tr>
                <td class="txt">${esc(j.name)}<br/><span style="color:var(--text-faint)">${esc(j.id)}</span></td>
                <td>${esc(j.kind)}</td>
                <td class="txt"><span class="badge ${stateClass(j.state)}">${esc(j.state)}</span>${j.error ? `<br/><span style="color:var(--bad)">${esc(j.error)}</span>` : ''}</td>
                <td><div class="bar"><i style="width:${(fraction * 100).toFixed(1)}%"></i></div><span style="font-size:10px;color:var(--text-faint)">${pct(fraction * 100, 100, 0)}</span></td>
                <td class="num">${pr.tested ?? 0}</td>
                <td class="num">${pr.rejected ?? 0}</td>
                <td class="txt">${pr.best ? `${esc(pr.best.label)} ${fmtNumber(pr.best.value, 4)} ${esc(pr.best.unit ?? '')}` : '—'}</td>
                <td class="num">${pr.etaMs !== null && pr.etaMs !== undefined ? fmtDuration(pr.etaMs) : '—'}</td>
                <td class="num">${fmtDuration(pr.elapsedMs ?? 0)}</td>
                <td><button data-job-pause="${esc(j.id)}">⏸</button> <button data-job-resume="${esc(j.id)}">▶</button> <button data-job-cancel="${esc(j.id)}" class="danger">✕</button> <button data-job-result="${esc(j.id)}">result</button></td>
              </tr>`;
            })
            .join('')}</tbody></table>`;
    this.root.querySelector('#job-history').innerHTML =
      history.length === 0
        ? ''
        : `<div class="group-title">History <span class="count">${history.length}</span></div>
      <table class="grid"><thead><tr><th>Job</th><th>State</th><th>Finished</th><th>Summary</th></tr></thead><tbody>${history
        .slice(0, 20)
        .map((h) => `<tr><td class="txt">${esc(h.name ?? h.id)}</td><td class="txt"><span class="badge ${stateClass(h.state)}">${esc(h.state)}</span></td><td class="txt">${esc(h.finishedAt ?? '')}</td><td class="txt" style="white-space:normal">${esc(h.summary ?? '')}</td></tr>`)
        .join('')}</tbody></table>`;
  }

  async onClick(e) {
    const el = e.target;
    const id = el.dataset.jobPause || el.dataset.jobResume || el.dataset.jobCancel || el.dataset.resumeInterrupted;
    if (!id && !el.dataset.jobResult) return;
    try {
      if (el.dataset.jobPause) {
        await api.pauseJob(id);
        this.app.log(`job ${id} paused; its checkpoint is on disk`, 'info', 'jobs');
      } else if (el.dataset.jobResume) {
        await api.resumeJob(id);
        this.app.log(`job ${id} resumed`, 'info', 'jobs');
      } else if (el.dataset.jobCancel) {
        await api.cancelJob(id);
        this.app.log(`job ${id} cancelled`, 'warn', 'jobs');
      } else if (el.dataset.resumeInterrupted) {
        await api.resumeInterrupted(id);
        this.app.log(`interrupted job ${id} resumed from its checkpoint`, 'ok', 'jobs');
      } else if (el.dataset.jobResult) {
        const job = (this.snapshot?.jobs ?? []).find((j) => j.id === el.dataset.jobResult);
        const text = job ? JSON.stringify({ id: job.id, name: job.name, state: job.state, summary: job.summary, error: job.error, progress: job.progress, result: job.result }, null, 2) : 'no such job';
        this.app.showText(`Job ${el.dataset.jobResult}`, text);
      }
      this.refresh(true);
    } catch (err) {
      this.app.log(`the job action failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'jobs');
    }
  }
}

function stateClass(state) {
  if (state === 'done') return 'ok';
  if (state === 'failed' || state === 'cancelled') return 'bad';
  if (state === 'running') return 'info';
  if (state === 'paused' || state === 'interrupted') return 'warn';
  return '';
}

export { CHANNEL_COLORS };
