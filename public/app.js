/**
 * The laboratory application.
 *
 * This file is the glue and nothing else: it builds the chrome from the engine's own
 * command registry, forwards what the user does to the editor, paints the sheet with
 * the renderer, and shows what the engine measured in the docks. Every calculation —
 * placement, routing, simulation, analysis, optimization — happens in the engine
 * modules loaded as ES modules from this same server, so the interface cannot drift
 * from the tool the CLI drives.
 *
 * Startup order matters and is deliberate: engine first, then the editor with the
 * reference library loaded, then the sheet view, then the panels and docks, then a
 * first design opened so the window is never empty. If any step fails, the console
 * pane says which one and why, because a blank canvas with no explanation is the
 * worst possible failure mode for a tool like this.
 */

import * as cf from '/engine/index.js';
import { api, download, esc, eng, fmtBytes, fmtMs, fmtNumber } from './api.js';
import { SheetView } from './canvas.js';
import { Palette, Inspector } from './panels.js';
import { ConsolePane, SimulationPane, ScopePane, AnalysisPane, JobsPane } from './docks.js';

const R = cf.render;
const UI = cf.ui;

class App {
  constructor() {
    this.version = String(cf.VERSION ?? cf.ENGINE_VERSION ?? 'unknown');
    this.armed = null;
    this.measurements = null;
    this.lastErc = null;
    this.lastOptimization = null;
    this.dockTab = 'simulation';
    this.leftTab = 'components';
    this.optimizer = null;
  }

  async boot() {
    this.console_ = new ConsolePane(document.getElementById('pane-console'), this);
    this.log = (message, severity = 'info', source = 'app') => this.console_.log(message, severity, source);
    this.log(`CircuitForge ${this.version} starting in the browser. Engine modules are loaded from this server, so what runs here is what the CLI runs.`, 'ok', 'boot');

    // 1. The editor, with the reference designs available immediately.
    const project = cf.buildReferenceProject('laboratory');
    this.editor = new UI.Editor({
      lib: project.lib,
      chips: project.chips,
      project,
      name: 'laboratory',
      onChange: (reason) => this.afterEdit(reason),
      onLog: (line, severity) => this.log(line, severity ?? 'info', 'editor'),
    });
    this.log(`reference library loaded: ${project.chips.size()} chip definition(s), ${project.lib.all().length} component type(s)`, 'info', 'boot');

    // 2. The sheet.
    const canvas = document.getElementById('canvas');
    this.view = new SheetView(canvas, {
      editor: this.editor,
      onLog: this.log,
      onSelect: () => {
        this.inspector.render();
        this.updateStatus();
        this.view.requestDraw();
      },
      onOpen: (ref) => {
        if (this.editor.open(ref)) this.afterEdit('open');
        else this.inspector.render();
      },
      onPlace: (item, p) => this.placeArmed(item, p),
      onWire: (from, to) => this.onWire(from, to),
      onHover: (hit, screen) => this.onHover(hit, screen),
      onCursor: (world) => this.onCursor(world),
      onView: (v) => this.updateStatus(v),
      onContextMenu: (e, hit) => this.onContextMenu(e, hit),
      onFrame: (stats) => {
        this.lastFrame = stats;
      },
      onChange: () => this.afterEdit('canvas'),
    });

    // 3. Panels and docks.
    this.palette = new Palette(document.getElementById('left-body'), this);
    this.inspector = new Inspector(document.getElementById('right-body'), this);
    this.simulation = new SimulationPane(document.getElementById('pane-simulation'), this);
    this.scope = new ScopePane(document.getElementById('pane-scope'), this);
    this.analysis = new AnalysisPane(document.getElementById('pane-analysis'), this);
    this.jobs = new JobsPane(document.getElementById('pane-jobs'), this);

    // 4. Chrome.
    this.buildMenus();
    this.buildToolbar();
    this.buildDockTabs();
    this.bindKeys();
    this.bindWindow();
    this.showDock('simulation');

    // 5. Health from the server, so the status bar says what is actually running.
    try {
      const health = await api.health();
      this.health = health;
      document.getElementById('engine-badge').textContent = `engine ${health.version} · ${health.platform?.os ?? ''} ${health.platform?.arch ?? ''} · gpu ${health.gpu?.backend ?? 'none'}`;
      document.getElementById('st-engine').innerHTML = `engine <b>${esc(health.version)}</b> · node ${esc(health.node ?? '')}`;
      if (health.gpu && health.gpu.enabled === false) {
        this.log(`no GPU compute backend is available (${health.gpu.backend ?? 'none'}): every simulation runs on the CPU, and no GPU speedup is claimed anywhere in this build`, 'info', 'boot');
      }
    } catch (err) {
      this.log(`the server did not answer /api/health: ${err.message}`, 'warn', 'boot');
      document.getElementById('engine-badge').textContent = `engine ${this.version} · server unreachable`;
    }

    // 6. Something on screen: the full adder, which is small enough to read and
    // hierarchical enough to open.
    await this.openChip('full_adder', { quiet: true });
    this.view.fit();
    this.afterEdit('boot');
    this.log('Ready. Double-click a chip to open it, click two ports to wire them, Ctrl+Enter to simulate.', 'ok', 'boot');
  }

  // ---------------------------------------------------------------- chrome

  commandState() {
    return {
      dirty: this.editor.isDirty,
      canUndo: this.editor.canUndo,
      canRedo: this.editor.canRedo,
      selection: this.editor.selection.length,
      depth: this.editor.depth,
      canGoUp: this.editor.canGoUp,
      running: this.measurements !== null,
      jobs: this.jobs?.snapshot?.jobs?.length ?? 0,
      hasFile: this.editor.file !== null,
    };
  }

  buildMenus() {
    const nav = document.getElementById('menus');
    nav.style.display = 'flex';
    nav.style.gap = '2px';
    nav.innerHTML = UI.MENUS.map(
      (m) => `<div class="menu" data-menu="${esc(m.id)}">${esc(m.label)}</div>`,
    ).join('');
    nav.addEventListener('click', (e) => {
      const el = e.target.closest('[data-menu]');
      if (!el) return;
      this.toggleMenu(el.dataset.menu);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) this.closeMenus();
    });
    document.getElementById('brand-version').textContent = this.version;
  }

  toggleMenu(id) {
    const existing = document.querySelector('.menu-popup');
    const wasOpen = existing && existing.dataset.menu === id;
    this.closeMenus();
    if (wasOpen) return;
    const menu = UI.MENUS.find((m) => m.id === id);
    const anchor = document.querySelector(`[data-menu="${id}"]`);
    if (!menu || !anchor) return;
    anchor.classList.add('open');
    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    popup.dataset.menu = id;
    const state = this.commandState();
    popup.innerHTML = UI.menuItems(menu)
      .map((item) => {
        if (item.kind === 'separator') return '<div class="menu-sep"></div>';
        if (!item.command) return `<div class="menu-item disabled"><span>${esc(item.label)}</span></div>`;
        const enabled = item.command.enabled ? item.command.enabled(state) : true;
        return `<div class="menu-item${enabled ? '' : ' disabled'}" data-command="${esc(item.command.id)}" title="${esc(item.command.hint ?? '')}">
          <span>${esc(item.command.label)}</span>${item.command.key ? `<span class="key">${esc(item.command.key)}</span>` : ''}</div>`;
      })
      .join('');
    popup.addEventListener('click', (e) => {
      const el = e.target.closest('[data-command]');
      if (!el || el.classList.contains('disabled')) return;
      this.closeMenus();
      this.runCommand(el.dataset.command);
    });
    anchor.appendChild(popup);
  }

  closeMenus() {
    for (const el of document.querySelectorAll('.menu-popup')) el.remove();
    for (const el of document.querySelectorAll('.menu.open')) el.classList.remove('open');
  }

  buildToolbar() {
    const groups = {
      'tb-file': [
        { id: 'file.new', label: 'New', icon: '＋' },
        { id: 'file.open', label: 'Open', icon: '📂' },
        { id: 'file.save', label: 'Save', icon: '💾' },
        { id: 'file.export', label: 'Export', icon: '⇩' },
      ],
      'tb-edit': [
        { id: 'edit.undo', label: 'Undo', icon: '↶' },
        { id: 'edit.redo', label: 'Redo', icon: '↷' },
        { id: 'edit.rotate', label: 'Rotate', icon: '⟳' },
        { id: 'edit.delete', label: 'Delete', icon: '🗑' },
      ],
      'tb-sim': [
        { id: 'sim.run', label: 'Run', icon: '▶', primary: true },
        { id: 'sim.step', label: 'Step', icon: '⏭' },
        { id: 'sim.dc', label: 'DC', icon: '⎓' },
        { id: 'sim.transient', label: 'Transient', icon: '∿' },
        { id: 'sim.stop', label: 'Stop', icon: '■' },
      ],
      'tb-view': [
        { id: 'view.fit', label: 'Fit', icon: '⛶' },
        { id: 'view.zoomIn', label: '+', icon: '＋' },
        { id: 'view.zoomOut', label: '−', icon: '−' },
        { id: 'view.grid', label: 'Grid', icon: '▦' },
      ],
    };
    for (const [id, buttons] of Object.entries(groups)) {
      const el = document.getElementById(id);
      el.innerHTML = buttons
        .map((b) => `<button data-command="${esc(b.id)}" class="${b.primary ? 'primary' : ''}" title="${esc(UI.commandById(b.id)?.hint ?? b.label)}"><span>${b.icon}</span>${esc(b.label)}</button>`)
        .join('');
    }
    const level = document.getElementById('tb-level');
    level.innerHTML = `<label style="color:var(--text-dim);font-size:11.5px">level
        <select id="level-select">
          <option value="hierarchical">hierarchical</option>
          <option value="flattened">flattened</option>
          <option value="electrical">electrical</option>
        </select></label>
      <button data-command="circuit.erc" title="Electrical rules check">ERC</button>
      <button data-command="analyze.run" title="Analyze">Analyze</button>
      <button data-command="optimize.run" title="Optimize">Optimize</button>`;
    level.querySelector('#level-select').addEventListener('change', (e) => {
      this.view.setOption('level', e.target.value);
      this.log(`schematic level set to ${e.target.value}: ${e.target.value === 'hierarchical' ? 'chip instances stay blocks' : e.target.value === 'flattened' ? 'chips are expanded, logical primitives stay' : 'every element the solver sees, including expanded transistors'}`, 'info', 'view');
      this.afterEdit('level');
    });
    document.getElementById('toolbar').addEventListener('click', (e) => {
      const el = e.target.closest('[data-command]');
      if (el) this.runCommand(el.dataset.command);
    });
    this.renderBreadcrumb();
  }

  renderBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    const path = this.editor.path;
    el.innerHTML = path
      .map((p, i) => `${i > 0 ? '<span class="sep">›</span>' : ''}<span class="crumb${i === path.length - 1 ? ' current' : ''}" data-level="${i}">${esc(p)}</span>`)
      .join('');
    el.querySelectorAll('.crumb:not(.current)').forEach((c) =>
      c.addEventListener('click', () => {
        this.editor.goToLevel(Number(c.dataset.level));
        this.afterEdit('level');
        this.view.fit();
      }),
    );
  }

  buildDockTabs() {
    const tabs = document.getElementById('dock-tabs');
    tabs.addEventListener('click', (e) => {
      const el = e.target.closest('.dock-tab');
      if (!el) return;
      this.showDock(el.dataset.pane);
    });
    document.getElementById('dock-actions').innerHTML = `<button id="dock-toggle" title="Collapse or expand the dock">▾</button>`;
    document.getElementById('dock-toggle').addEventListener('click', () => {
      document.body.classList.toggle('hide-dock');
      this.afterEdit('dock');
    });
    window.addEventListener('resize', () => {
      this.view.resize();
      if (this.dockTab === 'scope') this.scope.resize();
    });
  }

  showDock(name) {
    this.dockTab = name;
    document.body.classList.remove('hide-dock');
    for (const el of document.querySelectorAll('.dock-tab')) el.classList.toggle('active', el.dataset.pane === name);
    for (const el of document.querySelectorAll('.dock-pane')) el.classList.toggle('active', el.id === `pane-${name}`);
    if (name === 'scope') requestAnimationFrame(() => this.scope.resize());
    if (name === 'jobs') this.jobs.refresh(true);
  }

  bindKeys() {
    const map = UI.keymap();
    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const key = UI.normalizeKey(e);
      const id = map.get(key);
      if (id) {
        e.preventDefault();
        this.runCommand(id);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const step = e.shiftKey ? this.view.options.snapGrid || 20 : 2;
        const dx = (e.key === 'ArrowRight' ? step : 0) - (e.key === 'ArrowLeft' ? step : 0);
        const dy = (e.key === 'ArrowDown' ? step : 0) - (e.key === 'ArrowUp' ? step : 0);
        if (this.editor.selection.length > 0) {
          e.preventDefault();
          this.editor.beginTransaction();
          for (const ref of this.editor.selection) {
            const inst = this.editor.byRef(ref);
            if (inst) this.editor.moveLive(ref, inst.x + dx, inst.y + dy, 0);
          }
          this.editor.endTransaction('nudge');
          this.view.invalidate();
        }
      }
    });
  }

  bindWindow() {
    window.addEventListener('beforeunload', (e) => {
      if (this.editor.isDirty) {
        e.preventDefault();
        e.returnValue = 'The current design has unsaved changes.';
      }
    });
  }

  updateStatus(v) {
    const view = v ?? this.view.view;
    document.getElementById('st-sheet').textContent = this.editor.describe();
    document.getElementById('st-zoom').innerHTML = `zoom <b>${(view.scale * 10).toFixed(0)}%</b>${this.view.lastStats ? ` · ${this.view.lastStats.nodes}/${this.view.layout ? this.view.layout.nodes.length : 0} blocks` : ''}`;
    const dot = document.getElementById('st-dot');
    const state = document.getElementById('st-state');
    if (this.optimizer) {
      dot.className = 'dot warn';
      state.textContent = 'optimizing…';
    } else if (this.measurements) {
      dot.className = 'dot ok';
      state.textContent = 'simulated';
    } else if (this.editor.isDirty) {
      dot.className = 'dot warn';
      state.textContent = 'unsaved';
    } else {
      dot.className = 'dot';
      state.textContent = 'idle';
    }
    const acc = this.sheetAccuracy();
    document.getElementById('st-accuracy').innerHTML = `accuracy <b>${esc(acc)}</b>`;
    this.renderBreadcrumb();
  }

  onCursor(world) {
    document.getElementById('st-cursor').innerHTML = `x <b>${fmtNumber(world.x, 1)}</b> y <b>${fmtNumber(world.y, 1)}</b>`;
    const hud = document.getElementById('hud');
    const layout = this.view.layout;
    hud.innerHTML = `<span class="chip">${layout ? `${layout.stats.nodes} blocks · ${layout.stats.wires} nets · ${layout.stats.ports} ports` : '—'}</span>
      <span class="chip">${(this.view.view.scale * 10).toFixed(0)} %</span>
      ${this.view.lastLayoutMs > 16 ? `<span class="chip">layout ${fmtMs(this.view.lastLayoutMs)}</span>` : ''}
      ${this.armed ? `<span class="chip">placing ${esc(this.armed.label ?? this.armed.type)} — click to place, Esc to cancel</span>` : ''}`;
  }

  onHover(hit, screen) {
    const tip = document.getElementById('tooltip');
    if (!hit) {
      tip.style.display = 'none';
      document.getElementById('hint').textContent = '';
      return;
    }
    const layout = this.view.layout;
    let html = '';
    if (hit.kind === 'node') {
      const node = layout.nodes.find((n) => n.id === hit.nodeId);
      const inst = node && this.editor.byRef(node.ref);
      const spec = inst && this.editor.lib.get(inst.specId);
      const chip = inst ? this.editor.chipOf(inst) : null;
      html = `<div class="t-title">${esc(node?.label ?? '?')} <span style="color:var(--text-faint)">${esc(node?.ref ?? '')}</span></div>
        <div class="t-row">${esc(node?.type ?? '')}${chip ? ` · chip ${esc(chip.def.id)} v${esc(chip.def.version)}` : ''}${node && node.bits > 1 ? ` · ×${node.bits}` : ''}</div>
        ${spec?.description ? `<div class="t-note">${esc(spec.description)}</div>` : ''}
        ${spec?.accuracy ? `<div class="t-row">accuracy: ${esc(spec.accuracy)}</div>` : ''}
        ${chip ? `<div class="t-note">double-click to open the implementation</div>` : ''}`;
    } else if (hit.kind === 'port') {
      const node = layout.nodes.find((n) => n.id === hit.nodeId);
      const port = node?.ports.find((p) => p.name === hit.portName);
      const state = port?.net ? this.measurements?.nets?.[port.net] : null;
      html = `<div class="t-title">${esc(node?.ref ?? '')}.${esc(hit.portName ?? '')}</div>
        <div class="t-row">${esc(port?.direction ?? '')} · ${port?.width > 1 ? `${port.width} bits` : '1 bit'} · net ${esc(port?.net ?? 'unconnected')}</div>
        ${state ? `<div class="t-row">${state.word ? `value ${esc(state.word)}` : `value ${esc(String(state.value))}`}${state.voltage !== undefined && state.voltage !== null ? ` · ${eng(state.voltage, 'V')}` : ''}</div>` : ''}
        <div class="t-note">click to start a wire · alt-click to disconnect</div>`;
    } else if (hit.kind === 'wire' || hit.kind === 'sheet-port') {
      const wire = layout.wires.find((w) => w.net === hit.net);
      const state = this.measurements?.nets?.[hit.net];
      html = `<div class="t-title">net ${esc(hit.net ?? '')}</div>
        <div class="t-row">${wire ? `${wire.width} bit · ${wire.endpoints.length} pin(s)` : ''}${wire && !wire.driven ? ' · <span style="color:var(--warn)">no driver on this sheet</span>' : ''}${wire?.conflict ? ' · <span style="color:var(--bad)">more than one driver</span>' : ''}</div>
        ${state ? `<div class="t-row">${state.word ? esc(state.word) : esc(String(state.value ?? ''))}${state.voltage !== undefined && state.voltage !== null ? ` · ${eng(state.voltage, 'V')}` : ''}${state.temperature !== undefined && state.temperature !== null ? ` · ${fmtNumber(state.temperature, 1)} °C` : ''}</div>` : ''}`;
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const rect = document.getElementById('sheet').getBoundingClientRect();
    const x = screen ? screen.x : rect.width / 2;
    const y = screen ? screen.y : rect.height / 2;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 8, x + 14)}px`;
    tip.style.top = `${Math.min(rect.height - tip.offsetHeight - 8, y + 14)}px`;
    document.getElementById('hint').textContent = hit.kind === 'node' ? 'drag to move · R to rotate · Del to delete' : hit.kind === 'port' ? 'click to wire · alt-click to disconnect' : 'click to select the net';
  }

  onContextMenu(e, hit) {
    const items = [];
    if (hit && hit.kind === 'node') {
      const ref = this.view.refOf(hit.nodeId);
      items.push({ label: 'Open implementation', run: () => this.runCommand('circuit.open') });
      items.push({ label: 'Rotate 90°', run: () => this.editor.rotate([ref]) && this.afterEdit('rotate') });
      items.push({ label: 'Duplicate', run: () => this.runCommand('edit.duplicate') });
      items.push({ label: 'Delete', run: () => this.runCommand('edit.delete') });
      this.editor.select([ref]);
    } else if (hit && (hit.kind === 'wire' || hit.kind === 'sheet-port')) {
      items.push({ label: `Select net ${hit.net}`, run: () => this.editor.selectNet(hit.net) });
      items.push({ label: 'Probe this net in the oscilloscope', run: () => this.probeNet(hit.net) });
    } else {
      items.push({ label: 'Fit sheet', run: () => this.view.fit() });
      items.push({ label: 'Paste component…', run: () => this.showLeft('components') });
    }
    this.popupAt(e.clientX, e.clientY, items);
  }

  popupAt(x, y, items) {
    this.closeMenus();
    const menu = document.querySelector(`[data-menu="${'ctx'}"]`) ?? (() => {
      const el = document.createElement('div');
      el.className = 'menu';
      el.dataset.menu = 'ctx';
      el.style.position = 'fixed';
      el.style.left = '0';
      el.style.top = '0';
      el.style.padding = '0';
      document.body.appendChild(el);
      return el;
    })();
    menu.innerHTML = '';
    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    popup.dataset.menu = 'ctx';
    popup.style.position = 'fixed';
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    popup.innerHTML = items.map((it, i) => `<div class="menu-item" data-ctx="${i}"><span>${esc(it.label)}</span></div>`).join('');
    popup.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ctx]');
      if (!el) return;
      this.closeMenus();
      menu.remove();
      items[Number(el.dataset.ctx)].run();
    });
    document.body.appendChild(popup);
  }

  showLeft(tab) {
    this.palette.tab = tab;
    this.palette.buildTabsActive();
    this.palette.render();
    document.body.classList.remove('hide-left');
  }

  // ---------------------------------------------------------------- placement

  armComponent(specId) {
    const spec = this.editor.lib.get(specId);
    if (!spec) return;
    this.armed = { kind: 'spec', type: specId, label: spec.name, params: {} };
    this.view.arm(this.armed);
    this.log(`${spec.name} armed: click on the sheet to place it, Esc to cancel`, 'info', 'place');
    this.updateStatus();
  }

  armChip(chipId) {
    const chip = this.editor.chips.get(chipId);
    if (!chip) return;
    this.armed = { kind: 'chip', chip: chipId, type: chipId, label: chip.def.name, params: chip.defaultParams() };
    this.view.arm(this.armed);
    this.log(`${chip.def.name} armed: click on the sheet to place an instance`, 'info', 'place');
    this.updateStatus();
  }

  placeArmed(item, p) {
    if (item.kind === 'chip') {
      const params = { ...item.params };
      const result = this.editor.placeChip(item.chip, p.x, p.y, params);
      if (result) this.log(`placed ${item.chip} as ${result.ref} at (${fmtNumber(p.x)}, ${fmtNumber(p.y)})`, 'info', 'place');
    } else {
      const spec = this.editor.lib.get(item.type);
      const params = {};
      for (const p2 of spec?.params ?? []) if (p2.default !== undefined) params[p2.id] = p2.default;
      const result = this.editor.place(item.type, p.x, p.y, params);
      if (result) this.log(`placed ${spec?.name ?? item.type} as ${result.ref} at (${fmtNumber(p.x)}, ${fmtNumber(p.y)})`, 'info', 'place');
    }
    this.armed = null;
    this.view.arm(null);
    this.afterEdit('place');
  }

  onWire(from, to) {
    if (!from || !to) return;
    const result = this.editor.connect(from.ref, from.port, to.ref, to.port);
    if (result) {
      this.log(`wired ${from.ref}.${from.port} → ${to.ref}.${to.port} on net "${result.net}" (${result.width} bit)`, 'ok', 'wire');
      this.afterEdit('wire');
    }
  }

  // ---------------------------------------------------------------- commands

  runCommand(id) {
    const command = UI.commandById(id);
    if (!command) {
      this.log(`no command named "${id}"`, 'error', 'command');
      return;
    }
    const state = this.commandState();
    if (command.enabled && !command.enabled(state)) {
      this.log(`${command.label} does not apply right now`, 'warn', 'command');
      return;
    }
    const handler = this.handlers()[id];
    if (!handler) {
      this.log(`${command.label} is declared but has no handler in this build`, 'error', 'command');
      return;
    }
    try {
      const result = handler();
      if (result && typeof result.then === 'function') result.catch((err) => this.log(`${command.label} failed: ${err.message}`, 'error', 'command'));
    } catch (err) {
      this.log(`${command.label} failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'command');
    }
  }

  handlers() {
    return {
      'file.new': () => this.confirmDiscard(() => {
        this.editor.newProject('untitled');
        this.editor.loadReferenceProject();
        this.view.fit();
        this.log('new empty sheet', 'info', 'file');
      }),
      'file.open': () => this.openProjectDialog(),
      'file.save': () => this.saveProject(),
      'file.saveAs': () => this.saveProject(true),
      'file.importDocument': () => this.importDocument(),
      'file.export': () => this.exportDialog(),
      'file.saveChip': () => this.saveChipDialog(),
      'file.close': () => {
        this.editor.up();
        this.afterEdit('up');
        this.view.fit();
      },
      'edit.undo': () => {
        if (this.editor.undo()) this.afterEdit('undo');
      },
      'edit.redo': () => {
        if (this.editor.redo()) this.afterEdit('redo');
      },
      'edit.selectAll': () => {
        const n = this.editor.selectAll();
        this.log(`selected ${n} component(s)`, 'info', 'edit');
      },
      'edit.delete': () => {
        const n = this.editor.remove([]);
        if (n > 0) this.afterEdit('delete');
      },
      'edit.rotate': () => {
        if (this.editor.rotate([], 90) > 0) this.afterEdit('rotate');
      },
      'edit.rotateBack': () => {
        if (this.editor.rotate([], -90) > 0) this.afterEdit('rotate');
      },
      'edit.duplicate': () => {
        if (this.editor.duplicate([]) > 0) this.afterEdit('duplicate');
      },
      'edit.disconnect': () => {
        let n = 0;
        for (const ref of this.editor.selection) if (this.editor.disconnect(ref)) n++;
        if (n > 0) {
          this.log(`disconnected every pin of ${n} component(s)`, 'info', 'edit');
          this.afterEdit('disconnect');
        }
      },
      'edit.addPort': () => this.promptPort(),
      'view.fit': () => this.view.fit(),
      'view.zoomIn': () => this.view.zoomBy(1.25),
      'view.zoomOut': () => this.view.zoomBy(0.8),
      'view.zoom100': () => this.view.setScale(10),
      'view.grid': () => {
        this.view.setOption('grid', !this.view.options.grid);
        this.log(`grid ${this.view.options.grid ? 'shown' : 'hidden'}`, 'info', 'view');
      },
      'view.snap': () => {
        this.view.setOption('snap', !this.view.options.snap);
        this.log(`snapping to the ${this.view.options.snapGrid}-unit grid ${this.view.options.snap ? 'on' : 'off'}`, 'info', 'view');
      },
      'view.labels': () => {
        this.view.setOption('labels', !this.view.options.labels);
        this.view.setOption('values', this.view.options.labels);
        this.log(`labels ${this.view.options.labels ? 'shown' : 'hidden'}`, 'info', 'view');
      },
      'view.theme': () => {
        const next = this.view.options.theme === 'dark' ? 'light' : 'dark';
        this.view.setOption('theme', next);
        document.body.classList.toggle('light', next === 'light');
        this.log(`${next} theme`, 'info', 'view');
        if (this.dockTab === 'scope') this.scope.draw();
      },
      'view.level': () => this.levelDialog(),
      'circuit.open': () => {
        const ref = this.editor.selection[0];
        if (!ref) return this.log('select a component first', 'warn', 'circuit');
        if (this.editor.open(ref)) {
          this.afterEdit('open');
          this.view.fit();
        } else this.inspector.render();
      },
      'circuit.up': () => {
        if (this.editor.up()) {
          this.afterEdit('up');
          this.view.fit();
        }
      },
      'circuit.erc': () => this.runErc(),
      'circuit.commitChip': () => {
        const result = this.editor.commitToChip();
        if (result) this.log(`${result.chip.def.id} is now v${result.version}; every instance of it uses the new implementation the next time it is flattened`, 'ok', 'circuit');
      },
      'circuit.flatten': () => this.showFlattened(),
      'circuit.reference': () => {
        const added = this.editor.loadReferenceProject();
        this.palette.render();
        this.log(`reference library: ${added} chip definition(s) added`, 'info', 'circuit');
      },
      'sim.run': () => {
        this.showDock('simulation');
        this.simulation.run();
        this.updateStatus();
      },
      'sim.stop': () => {
        this.simulation.stop();
        this.updateStatus();
      },
      'sim.step': () => {
        this.showDock('simulation');
        this.simulation.step();
      },
      'sim.dc': () => {
        this.simulation.options.electrical = true;
        this.simulation.options.logic = false;
        this.showDock('simulation');
        this.simulation.run();
        this.updateStatus();
      },
      'sim.transient': () => this.transientDialog(),
      'sim.thermal': () => {
        this.simulation.options.electrical = true;
        this.simulation.options.thermal = true;
        this.showDock('simulation');
        this.simulation.run();
      },
      'sim.toggle': () => {
        const ref = this.editor.selection[0];
        if (!ref) return this.log('select the component whose input you want to toggle, or click its value in the Simulation dock', 'warn', 'sim');
        const inst = this.editor.byRef(ref);
        const spec = inst && this.editor.lib.get(inst.specId);
        const input = (spec?.pins ?? []).find((p) => p.direction === 'input');
        if (!input) return this.log(`${ref} has no input pin`, 'warn', 'sim');
        const net = this.editor.circuit.netOf(inst.id, input.name);
        if (!net) return this.log(`${ref}.${input.name} is not connected to a net`, 'warn', 'sim');
        this.simulation.toggleInput(net.name);
      },
      'sim.clock': () => this.simulation.toggleClock(),
      'analyze.run': () => {
        this.showDock('analysis');
        this.analysis.run();
      },
      'analyze.criticalPath': () => {
        this.showDock('analysis');
        this.analysis.highlightCritical();
      },
      'analyze.unused': () => {
        this.showDock('analysis');
        this.analysis.selectUnused();
      },
      'analyze.stats': () => this.showStats(),
      'optimize.run': () => this.optimizeDialog(),
      'optimize.why': () => this.showWhy(),
      'optimize.synth': () => this.synthDialog(),
      'optimize.apply': () => this.applyBest(),
      'jobs.show': () => this.showDock('jobs'),
      'jobs.pause': () => this.jobAction('pause'),
      'jobs.resume': () => this.jobAction('resume'),
      'jobs.cancel': () => this.jobAction('cancel'),
      'jobs.benchmark': () => this.benchmarkDialog(),
      'window.components': () => document.body.classList.toggle('hide-left'),
      'window.inspector': () => document.body.classList.toggle('hide-right'),
      'window.console': () => this.showDock('console'),
      'window.scope': () => this.showDock('scope'),
      'window.simulation': () => this.showDock('simulation'),
      'help.about': () => this.showAbout(),
      'help.docs': () => this.showDocs(),
      'help.limits': () => this.showLimits(),
      'help.accuracy': () => this.showAccuracy(),
    };
  }

  // ---------------------------------------------------------------- after edit

  afterEdit(reason) {
    this.view.invalidate();
    this.inspector.render();
    this.palette.render();
    this.updateStatus();
    if (this.measurements && reason !== 'select') {
      // Values measured from a previous netlist no longer describe this sheet, so
      // they are dropped rather than left on screen as if they still applied.
      if (['place', 'wire', 'delete', 'param', 'move', 'rotate', 'disconnect', 'undo', 'redo', 'load', 'new', 'open', 'up', 'level'].includes(reason)) {
        this.log(`the sheet changed (${reason}); the values on it were measured from the previous netlist and have been cleared`, 'info', 'sim');
        this.setMeasurements(null);
      }
    }
    void reason;
  }

  setMeasurements(state) {
    this.measurements = state;
    this.view.setState(state);
    this.inspector.render();
    this.updateStatus();
  }

  /** Probes to attach when a transient sweep is run without an explicit list. */
  autoProbes(nl) {
    const out = [];
    const ports = nl.ports ?? [];
    for (const p of ports.slice(0, 4)) out.push({ measure: 'voltage', target: p.name, name: p.name });
    if (out.length === 0) {
      for (let i = 1; i < Math.min(nl.nodeCount, 4); i++) out.push({ measure: 'voltage', target: cf.nodeNameAt(nl, i), name: cf.nodeNameAt(nl, i) });
    }
    return out;
  }

  probeNet(netName) {
    this.scope.channels.push({ measure: 'voltage', target: netName, name: netName, visible: true, color: null });
    this.scope.renderChannels();
    this.showDock('scope');
    this.log(`"${netName}" added as an oscilloscope channel; press Capture to sweep`, 'info', 'scope');
  }

  // ---------------------------------------------------------------- dialogs

  confirmDiscard(proceed) {
    if (!this.editor.isDirty) return proceed();
    this.dialog({
      title: 'Discard the current design?',
      body: `<div class="note warn">The current design has unsaved changes: ${esc(this.editor.describe())}.</div>`,
      buttons: [
        { label: 'Cancel' },
        { label: 'Save first', primary: true, run: async (close) => { await this.saveProject(); close(); proceed(); } },
        { label: 'Discard', danger: true, run: (close) => { close(); proceed(); } },
      ],
    });
  }

  dialog({ title, body, buttons = [], wide = false }) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal${wide ? ' wide' : ''}">
      <header><span>${esc(title)}</span><span class="x" data-close="1">✕</span></header>
      <div class="content">${body}</div>
      <footer>${buttons.map((b, i) => `<button data-btn="${i}" class="${b.primary ? 'primary' : ''}${b.danger ? ' danger' : ''}">${esc(b.label)}</button>`).join('')}</footer>
    </div>`;
    root.classList.add('open');
    const close = () => {
      root.classList.remove('open');
      root.innerHTML = '';
    };
    root.querySelector('[data-close]').addEventListener('click', close);
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
      const el = e.target.closest('[data-btn]');
      if (!el) return;
      const b = buttons[Number(el.dataset.btn)];
      if (b && b.run) b.run(close);
      else close();
    });
    return { root: root.querySelector('.modal'), close };
  }

  form(title, fields, submitLabel, onSubmit) {
    const body = fields
      .map((f) => {
        const id = `f-${f.id}`;
        if (f.kind === 'select') {
          return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-field="${esc(f.id)}">${(f.options ?? []).map((o) => `<option value="${esc(typeof o === 'object' ? o.value : o)}"${String(f.value) === String(typeof o === 'object' ? o.value : o) ? ' selected' : ''}>${esc(typeof o === 'object' ? o.label : o)}</option>`).join('')}</select>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
        }
        if (f.kind === 'checkbox') {
          return `<div class="field"><label><input type="checkbox" id="${id}" data-field="${esc(f.id)}" ${f.value ? 'checked' : ''} /> ${esc(f.label)}</label>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
        }
        if (f.kind === 'textarea') {
          return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea id="${id}" data-field="${esc(f.id)}" rows="${f.rows ?? 4}" spellcheck="false">${esc(f.value ?? '')}</textarea>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
        }
        return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="${f.kind === 'number' ? 'number' : 'text'}" id="${id}" data-field="${esc(f.id)}" value="${esc(f.value ?? '')}" ${f.step ? `step="${esc(f.step)}"` : ''} ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} spellcheck="false" />${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
      })
      .join('');
    const dlg = this.dialog({
      title,
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: submitLabel,
          primary: true,
          run: (close) => {
            const values = {};
            for (const f of fields) {
              const el = dlg.root.querySelector(`[data-field="${f.id}"]`);
              if (!el) continue;
              values[f.id] = f.kind === 'checkbox' ? el.checked : f.kind === 'number' ? Number(el.value) : el.value;
            }
            const keepOpen = onSubmit(values) === false;
            if (!keepOpen) close();
          },
        },
      ],
    });
    return dlg;
  }

  showText(title, text) {
    this.dialog({ title, body: `<pre class="code">${esc(text)}</pre>`, wide: true, buttons: [{ label: 'Copy', run: () => navigator.clipboard?.writeText(text) }, { label: 'Close', primary: true }] });
  }

  // ---------------------------------------------------------------- files

  async saveProject(asNew = false) {
    let file = this.editor.file;
    if (!file || asNew) {
      const existing = await this.listProjects();
      await new Promise((resolve) => {
        this.form(
          asNew ? 'Save project as' : 'Save project',
          [
            { id: 'file', label: 'File name (inside the server data directory)', value: file ?? `${this.editor.name}.cfproj.json`, help: existing.length ? `Existing: ${existing.slice(0, 6).join(', ')}` : 'Nothing has been saved on this server yet.' },
            { id: 'name', label: 'Project name', value: this.editor.name },
          ],
          'Save',
          (values) => {
            const target = String(values.file || '').trim();
            if (!target) {
              this.log('a file name is required', 'error', 'file');
              return false;
            }
            void this.writeProject(target, String(values.name || this.editor.name));
            resolve();
          },
        );
      });
      return;
    }
    await this.writeProject(file, this.editor.name);
  }

  async writeProject(file, name) {
    try {
      const document = this.editor.toProjectDocument();
      document.name = name;
      const result = await api.saveProject(file, document);
      this.editor.setFile(result.file);
      this.editor.markSaved();
      this.log(`saved ${result.file} (${fmtBytes(result.bytes)})`, 'ok', 'file');
      this.updateStatus();
    } catch (err) {
      this.log(`saving failed: ${err.code ? err.code + ': ' : ''}${err.message}${err.hint ? ` — ${err.hint}` : ''}`, 'error', 'file');
    }
  }

  async listProjects() {
    try {
      const data = await api.projects();
      return data.projects.map((p) => p.file);
    } catch {
      return [];
    }
  }

  async openProjectDialog() {
    let projects = [];
    try {
      projects = (await api.projects()).projects;
    } catch (err) {
      this.log(`the project list could not be read: ${err.message}`, 'error', 'file');
    }
    this.dialog({
      title: 'Open a project',
      body:
        projects.length === 0
          ? `<div class="empty">Nothing has been saved on this server yet. Use File ▸ Save to write the current design.</div>`
          : `<table class="grid"><thead><tr><th>File</th><th class="num">Size</th><th>Modified</th><th></th></tr></thead><tbody>${projects
              .map((p) => `<tr><td class="txt">${esc(p.file)}</td><td class="num">${fmtBytes(p.bytes)}</td><td class="txt">${esc(p.modifiedAt.slice(0, 19).replace('T', ' '))}</td><td><button data-open-file="${esc(p.file)}">Open</button></td></tr>`)
              .join('')}</tbody></table>`,
      buttons: [{ label: 'Close' }],
    });
    document.querySelectorAll('[data-open-file]').forEach((el) =>
      el.addEventListener('click', async () => {
        const file = el.dataset.openFile;
        try {
          const data = await api.openProject(file);
          await this.loadProjectDocument(data.document, file);
        } catch (err) {
          this.log(`opening ${file} failed: ${err.message}`, 'error', 'file');
        }
      }),
    );
  }

  async loadProjectDocument(document, file) {
    try {
      const loaded = cf.projectFromDocument ? cf.projectFromDocument(document, cf.createDefaultLibrary(), new cf.ChipLibrary()) : null;
      if (loaded) {
        const project = loaded.project ?? loaded;
        this.editor.project === project; // the editor keeps its own project; chips are merged below
        for (const chip of project.chips?.all?.() ?? []) if (!this.editor.chips.has(chip.def.id)) this.editor.chips.add(chip);
      }
      const sheet = document.openSheet?.document ?? document.circuit ?? null;
      if (sheet) {
        const result = this.editor.loadDocument(sheet);
        this.editor.setFile(file ?? null);
        this.editor.markSaved();
        this.view.fit();
        this.log(`opened ${file ?? 'the project'}: ${this.editor.describe()}${result.diagnostics.length ? ` with ${result.diagnostics.length} diagnostic(s)` : ''}`, 'ok', 'file');
        for (const d of result.diagnostics.slice(0, 8)) this.log(`${d.code}: ${d.message}`, d.severity === 'error' ? 'error' : 'warn', 'file');
      } else {
        this.log('the file contains no sheet document; nothing was loaded', 'warn', 'file');
      }
      this.palette.render();
    } catch (err) {
      this.log(`loading the project failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'file');
    }
  }

  importDocument() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const doc = JSON.parse(text);
        const sheet = doc.openSheet?.document ?? doc.circuit ?? doc;
        const result = this.editor.loadDocument(sheet);
        this.view.fit();
        this.log(`imported ${file.name}: ${this.editor.describe()} with ${result.diagnostics.length} diagnostic(s)`, 'ok', 'file');
      } catch (err) {
        this.log(`importing ${file.name} failed: ${err.message}`, 'error', 'file');
      }
    });
    input.click();
  }

  exportDialog() {
    const formats = [
      { value: 'spice', label: 'SPICE netlist (.cir)' },
      { value: 'json', label: 'Circuit document (.cfcircuit.json)' },
      { value: 'bom', label: 'Bill of materials (.json)' },
      { value: 'schematic', label: 'Schematic export, hierarchical (.json)' },
      { value: 'svg', label: 'Sheet picture (.svg)' },
      { value: 'analysis', label: 'Analysis report (.json)' },
      { value: 'validation', label: 'Validation report (.json)' },
    ];
    this.form(
      'Export the current sheet',
      [
        { id: 'format', label: 'Format', kind: 'select', options: formats, value: 'spice' },
        { id: 'level', label: 'Schematic level', kind: 'select', options: ['hierarchical', 'flattened', 'electrical'], value: this.view.options.level },
        { id: 'expand', label: 'Expand gates into transistors (electrical level)', kind: 'checkbox', value: false },
      ],
      'Export',
      (values) => {
        void this.doExport(values.format, values.level, values.expand);
      },
    );
  }

  async doExport(format, level, expand) {
    const editor = this.editor;
    const stamp = `${editor.circuit.name.replace(/[^a-z0-9._-]/gi, '_')}-${Date.now()}`;
    try {
      if (format === 'svg') {
        const out = R.renderCircuitToSvg(editor.circuit, editor.lib, editor.chips, {
          level,
          viewport: { width: 1600, height: 1000 },
          draw: { theme: this.view.options.theme },
        });
        const bytes = download(`${stamp}.svg`, out.svg, 'image/svg+xml');
        this.log(`exported ${fmtBytes(bytes)} of SVG: ${out.layout.stats.nodes} block(s), ${out.layout.stats.wires} net(s), ${out.stats.ops} drawing operation(s) in ${fmtMs(out.stats.ms)}`, 'ok', 'export');
        return;
      }
      if (format === 'json') {
        const bytes = download(`${stamp}.cfcircuit.json`, JSON.stringify(editor.toDocument(), null, 2), 'application/json');
        this.log(`exported the circuit document (${fmtBytes(bytes)})`, 'ok', 'export');
        return;
      }
      if (format === 'spice') {
        const text = cf.exportSpiceNetlist(editor.circuit, editor.lib, editor.chips, { level, expandGates: expand });
        const bytes = download(`${stamp}.cir`, text, 'text/plain');
        this.log(`exported a SPICE netlist (${fmtBytes(bytes)}, ${text.split('\n').length} line(s))`, 'ok', 'export');
        return;
      }
      if (format === 'bom') {
        const bom = cf.buildBomFromCircuit(editor.circuit, editor.lib);
        const bytes = download(`${stamp}.bom.json`, JSON.stringify(bom, null, 2), 'application/json');
        const lines = bom.aggregated ?? bom.lines ?? [];
        this.log(`exported the BOM (${fmtBytes(bytes)}, ${Array.isArray(lines) ? lines.length : 0} line(s))`, 'ok', 'export');
        return;
      }
      if (format === 'schematic') {
        const exp = level === 'hierarchical' ? cf.exportSchematicHierarchical(editor.circuit, editor.lib) : cf.exportSchematicFlattened(cf.flatten(editor.circuit, editor.lib, editor.chips, { expandGates: expand, metadata: true }));
        const bytes = download(`${stamp}.schematic.json`, JSON.stringify(exp, null, 2), 'application/json');
        this.log(`exported the ${level} schematic (${fmtBytes(bytes)}, ${exp.components.length} component(s), ${exp.nets.length} net(s), fingerprint ${exp.fingerprint})`, 'ok', 'export');
        return;
      }
      if (format === 'analysis') {
        this.analysis.run();
        if (!this.analysis.report) return;
        download(`${stamp}.analysis.json`, JSON.stringify(this.analysis.report, null, 2), 'application/json');
        this.log('exported the analysis report', 'ok', 'export');
        return;
      }
      if (format === 'validation') {
        const text = await api.validate({ circuit: editor.toDocument(), seed: 1234 });
        download(`${stamp}.validation.json`, JSON.stringify(text, null, 2), 'application/json');
        this.log('exported the validation report', 'ok', 'export');
      }
    } catch (err) {
      this.log(`the ${format} export failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'export');
    }
  }

  saveChipDialog() {
    this.form(
      'Save this sheet as a chip',
      [
        { id: 'name', label: 'Chip name', value: this.editor.circuit.name },
        { id: 'description', label: 'Description', value: '' },
      ],
      'Save as chip',
      (values) => {
        const chip = this.editor.saveAsChip({ name: String(values.name), description: String(values.description) });
        if (chip) this.palette.render();
        return !!chip;
      },
    );
  }

  promptPort() {
    this.form(
      'Add a circuit port',
      [
        { id: 'name', label: 'Port name (also the net name)', value: '' },
        { id: 'direction', label: 'Direction', kind: 'select', options: ['input', 'output', 'bidirectional'], value: 'input' },
        { id: 'width', label: 'Width in bits', kind: 'number', value: 1, min: 1, step: 1 },
      ],
      'Add port',
      (values) => {
        const port = this.editor.addPort(String(values.name).trim(), values.direction, Math.max(1, Math.round(Number(values.width) || 1)));
        return !!port;
      },
    );
  }

  levelDialog() {
    this.form(
      'Schematic level',
      [
        { id: 'level', label: 'Level', kind: 'select', options: [
          { value: 'hierarchical', label: 'hierarchical — chip instances stay blocks' },
          { value: 'flattened', label: 'flattened — chips expanded, logical primitives kept' },
          { value: 'electrical', label: 'electrical — every element the solver sees' },
        ], value: this.view.options.level },
        { id: 'portSides', label: 'Chip ports', kind: 'select', options: [
          { value: 'top-bottom', label: 'inputs on top, outputs below' },
          { value: 'left-right', label: 'inputs on the left, outputs on the right' },
        ], value: this.view.options.portSides },
        { id: 'snap', label: 'Snap to grid', kind: 'checkbox', value: this.view.options.snap },
      ],
      'Apply',
      (values) => {
        this.view.setOption('level', values.level);
        this.view.setOption('portSides', values.portSides);
        this.view.setOption('snap', values.snap);
        const select = document.getElementById('level-select');
        if (select) select.value = values.level;
        this.log(`schematic level ${values.level}, chip ports ${values.portSides}`, 'info', 'view');
        this.view.fit();
      },
    );
  }

  transientDialog() {
    this.form(
      'Transient sweep',
      [
        { id: 'tstop', label: 'Stop time, s', kind: 'number', value: this.simulation.options.tstop || 0.01, step: 'any' },
        { id: 'samples', label: 'Samples', kind: 'number', value: this.simulation.options.maxSamples, step: 100 },
        { id: 'channels', label: 'Channels (one per line: measure target, e.g. "voltage out")', kind: 'textarea', rows: 4, value: '' },
      ],
      'Run and plot',
      (values) => {
        const tstop = Number(values.tstop);
        if (!(tstop > 0)) {
          this.log('the stop time must be greater than zero', 'error', 'sim');
          return false;
        }
        this.simulation.options.tstop = tstop;
        this.simulation.options.maxSamples = Math.max(2, Math.round(Number(values.samples) || 1000));
        this.simulation.options.electrical = true;
        const lines = String(values.channels || '').split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          this.scope.channels = lines.map((l) => {
            const [measure, ...rest] = l.split(/\s+/);
            return { measure, target: rest.join(' '), name: rest.join(' '), visible: true, color: null };
          });
          this.scope.renderChannels();
        }
        this.scope.tstop = tstop;
        this.scope.maxSamples = this.simulation.options.maxSamples;
        this.showDock('scope');
        this.scope.run();
      },
    );
  }

  // ---------------------------------------------------------------- optimizer

  paramValuesFor(specId) {
    try {
      const spec = cf.buildSpecById(specId, {});
      const out = {};
      for (const p of spec.params ?? []) if (p.default !== undefined) out[p.id] = p.default;
      return out;
    } catch {
      return {};
    }
  }

  optimizeDialog() {
    const specs = ['mux', 'adder', 'subtractor', 'comparator', 'alu_slice', 'and_not', 'majority'];
    this.form(
      'Optimize a design against a specification',
      [
        { id: 'spec', label: 'Specification', kind: 'select', options: specs, value: 'adder' },
        { id: 'params', label: 'Parameters (JSON, e.g. {"bits":4})', value: '{"bits":2}' },
        { id: 'profile', label: 'Profile', kind: 'select', options: ['BALANCED', 'FASTEST', 'SMALLEST', 'LOW_POWER', 'LOW_TEMPERATURE', 'MOST_STABLE'], value: 'BALANCED', help: 'BALANCED weights speed 40 %, components 20 %, power 15 %, temperature 10 %, stability 10 %, memory 5 %.' },
        { id: 'evaluations', label: 'Evaluation budget', kind: 'number', value: 400, step: 50 },
        { id: 'population', label: 'Population size', kind: 'number', value: 24, step: 4 },
        { id: 'seed', label: 'Seed', value: '1234', help: 'The same seed, budget and specification reproduce the same search.' },
        { id: 'detail', label: 'Detail the top N electrically (tiers 3–4)', kind: 'number', value: 3, step: 1 },
      ],
      'Search',
      (values) => {
        void this.runOptimization(values);
      },
    );
  }

  async runOptimization(values, mode = 'optimize') {
    let params = {};
    try {
      params = values.params ? JSON.parse(values.params) : {};
    } catch (err) {
      this.log(`the parameters are not valid JSON: ${err.message}`, 'error', 'optim');
      return;
    }
    let spec;
    try {
      spec = cf.buildSpecById(String(values.spec), params);
    } catch (err) {
      this.log(`the specification could not be built: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'optim');
      return;
    }
    const budget = { evaluations: Math.max(1, Math.round(Number(values.evaluations) || 400)) };
    const optimizer = new cf.Optimizer({
      spec,
      lib: this.editor.lib,
      chips: this.editor.chips,
      name: `${values.spec}_${mode}`,
      profile: values.profile ?? 'BALANCED',
      seed: values.seed ?? '1234',
      populationSize: Math.max(4, Math.round(Number(values.population) || 24)),
      budget,
      detailTop: Math.max(0, Math.round(Number(values.detail ?? 3))),
    });
    this.optimizer = optimizer;
    this.showDock('console');
    this.log(`searching ${spec.name} under ${values.profile ?? 'BALANCED'}: budget ${budget.evaluations} evaluation(s), population ${values.population ?? 24}, seed ${values.seed ?? '1234'}`, 'info', 'optim');
    const t0 = performance.now();
    // Step the search from the frame loop so the interface stays responsive and the
    // progress line is real: it is read from the optimizer, not estimated.
    await new Promise((resolve) => {
      let lastLogged = 0;
      const tick = () => {
        if (!this.optimizer) return resolve();
        let guard = 0;
        try {
          while (guard++ < 12) {
            const done = optimizer.step();
            if (done) break;
          }
        } catch (err) {
          this.log(`the search stopped: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'optim');
          this.optimizer = null;
          return resolve();
        }
        const progress = optimizer.progress ? optimizer.progress() : null;
        if (progress && performance.now() - lastLogged > 900) {
          lastLogged = performance.now();
          this.updateStatus();
        }
        const finished = optimizer.finished ? optimizer.finished() : guard >= 12 && progress?.phase === 'done';
        if (finished) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const ms = performance.now() - t0;
    this.optimizer = null;
    let report;
    try {
      report = optimizer.report();
    } catch (err) {
      this.log(`the report could not be produced: ${err.message}`, 'error', 'optim');
      this.updateStatus();
      return;
    }
    this.lastOptimization = { optimizer, report, spec, params, mode };
    const best = report.best ?? {};
    const objectives = best.objectives ?? {};
    const fmtObj = (k) => (objectives[k] === null || objectives[k] === undefined ? `${k}: not measured` : `${k}: ${fmtNumber(objectives[k], 4)}`);
    this.log(
      `search finished in ${fmtMs(ms)}: ${report.evaluations ?? best.evaluations ?? '?'} evaluation(s), ${report.paretoSize ?? (report.front ?? []).length} on the front. Best ${best.id ?? '?'} — ${['delay', 'components', 'power', 'temperature', 'stabilityRisk', 'depth'].map(fmtObj).join(' · ')}`,
      'ok',
      'optim',
    );
    this.log(
      `This is the BEST FOUND UNDER CURRENT CONSTRAINTS: specification ${spec.name}, profile ${values.profile ?? 'BALANCED'}, budget ${budget.evaluations} evaluation(s), population ${values.population ?? 24}, seed ${values.seed ?? '1234'}, tiers 0–${report.detailTop ?? '?'}${objectives.power === null || objectives.power === undefined ? ', power not measured at this tier' : ''}. It is not claimed to be optimal.`,
      'info',
      'optim',
    );
    this.showOptimizationReport();
    this.updateStatus();
  }

  showOptimizationReport() {
    if (!this.lastOptimization) return this.log('no search has been run in this session', 'warn', 'optim');
    const { report, spec, params, mode } = this.lastOptimization;
    const best = report.best ?? {};
    const rows = (report.ranked ?? report.front ?? []).slice(0, 12);
    const obj = best.objectives ?? {};
    this.dialog({
      title: `Optimization result — ${spec.name} (${mode})`,
      wide: true,
      body: `<div class="note">BEST FOUND UNDER CURRENT CONSTRAINTS. Specification <b>${esc(spec.name)}</b>${Object.keys(params).length ? ` with ${esc(JSON.stringify(params))}` : ''}, profile <b>${esc(report.profile?.name ?? report.profileName ?? '—')}</b>, ${esc(String(report.evaluations ?? '?'))} evaluation(s), seed <b>${esc(String(report.reproducibility?.seed ?? report.seed ?? '—'))}</b>. Nothing here is claimed to be optimal: it is the best candidate this search scored.</div>
        <div class="card"><header>Best candidate <span class="badge info">${esc(String(best.id ?? '—'))}</span></header><div class="body">
          <dl class="kv">
            <dt>Components</dt><dd>${esc(String(obj.components ?? best.components ?? '—'))}</dd>
            <dt>Depth</dt><dd>${esc(String(obj.depth ?? best.depth ?? '—'))}</dd>
            <dt>Delay</dt><dd>${obj.delay !== undefined && obj.delay !== null ? fmtNumber(obj.delay * 1e9, 3) + ' ns' : '—'}</dd>
            <dt>Power</dt><dd>${obj.power !== undefined && obj.power !== null ? eng(obj.power, 'W') : 'not measured at this tier'}</dd>
            <dt>Temperature</dt><dd>${obj.temperature !== undefined && obj.temperature !== null ? fmtNumber(obj.temperature, 2) + ' °C' : 'not measured at this tier'}</dd>
            <dt>Stability risk</dt><dd>${obj.stabilityRisk !== undefined && obj.stabilityRisk !== null ? fmtNumber(obj.stabilityRisk, 3) : '—'}</dd>
            <dt>Genome</dt><dd style="font-size:10.5px">${esc(String(best.genome ?? best.key ?? '—')).slice(0, 120)}</dd>
          </dl>
        </div></div>
        ${rows.length ? `<div class="card"><header>Ranked candidates <span class="count">${rows.length}</span></header><div class="body tight">
          <table class="grid"><thead><tr><th>Id</th><th class="num">Components</th><th class="num">Delay</th><th class="num">Depth</th><th class="num">Risk</th><th class="num">Score</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td>${esc(String(r.id ?? '').slice(0, 16))}</td><td class="num">${esc(String(r.objectives?.components ?? r.components ?? ''))}</td><td class="num">${r.objectives?.delay !== undefined && r.objectives?.delay !== null ? fmtNumber(r.objectives.delay * 1e9, 3) + ' ns' : '—'}</td><td class="num">${esc(String(r.objectives?.depth ?? r.depth ?? ''))}</td><td class="num">${r.objectives?.stabilityRisk !== undefined && r.objectives?.stabilityRisk !== null ? fmtNumber(r.objectives.stabilityRisk, 3) : '—'}</td><td class="num">${fmtNumber(r.score ?? 0, 4)}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
        <div class="note warn">Objectives that were never scored are shown as “not measured”. Power and temperature need the electrical and thermal tiers, which run only on the detailed candidates.</div>`,
      buttons: [
        { label: 'Why this design?', run: () => this.showWhy() },
        { label: 'Apply as chip', primary: true, run: () => this.applyBest() },
        { label: 'Close' },
      ],
    });
  }

  showWhy() {
    if (!this.lastOptimization) return this.log('no search has been run in this session', 'warn', 'optim');
    let why;
    try {
      why = this.lastOptimization.optimizer.why();
    } catch (err) {
      return this.log(`the explanation could not be produced: ${err.message}`, 'error', 'optim');
    }
    const deltas = why.deltas ?? why.comparison ?? [];
    const lines = [
      `Winner: ${why.winner ?? why.best ?? '?'}`,
      `Runner-up: ${why.runnerUp ?? '?'}`,
      '',
      'Measured differences (nothing else is claimed):',
      ...(Array.isArray(deltas)
        ? deltas.map((d) => `  ${String(d.objective ?? d.name ?? '?').padEnd(16)} ${d.better ? 'better ' : 'worse  '} ${fmtNumber(d.relative !== undefined ? d.relative * 100 : 0, 2)} %  (${d.absolute !== undefined ? fmtNumber(d.absolute, 6) : '?'} ${d.unit ?? ''}, weighted ${fmtNumber(d.weighted ?? 0, 4)})${d.scope ? `  [${d.scope}]` : ''}`)
        : [`  ${JSON.stringify(why).slice(0, 400)}`]),
      '',
      why.note ?? 'The winner is the candidate with the best weighted score under the declared profile. No claim of optimality is made.',
    ];
    this.showText('Why this design?', lines.join('\n'));
    this.log('“Why this design?” answers only with measured deltas against the runner-up', 'info', 'optim');
  }

  applyBest() {
    if (!this.lastOptimization) return this.log('no search has been run in this session', 'warn', 'optim');
    const { optimizer, spec } = this.lastOptimization;
    let circuit = null;
    try {
      circuit = optimizer.buildBest();
    } catch (err) {
      return this.log(`the best candidate could not be built: ${err.message}`, 'error', 'optim');
    }
    if (!circuit) return this.log('the search produced no buildable candidate', 'warn', 'optim');
    const id = `${spec.id ?? spec.name}_synth`;
    try {
      const chip = this.editor.project.saveAsChip(circuit, { id, name: circuit.name || id, description: `Synthesized for ${spec.name}; best found under the declared constraints.`, overwrite: true });
      this.log(`saved the best candidate as chip ${chip.def.id} v${chip.def.version} (${circuit.componentCount()} component(s))`, 'ok', 'optim');
      const placed = this.editor.placeChip(chip.def.id, 0, 0, chip.defaultParams());
      if (placed) this.log(`placed an instance as ${placed.ref} on the current sheet`, 'ok', 'optim');
      this.palette.render();
      this.afterEdit('apply');
      this.view.fit();
    } catch (err) {
      this.log(`saving the chip failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'optim');
    }
  }

  synthDialog() {
    this.form(
      'Reverse engineering: from a behavioural specification to a validated chip',
      [
        { id: 'spec', label: 'Behaviour', kind: 'select', options: [
          { value: 'adder', label: 'Y = A + B (adder)' },
          { value: 'subtractor', label: 'Y = A − B (subtractor)' },
          { value: 'comparator', label: 'Y = compare(A, B)' },
          { value: 'alu_slice', label: 'ALU slice' },
          { value: 'mux', label: 'multiplexer' },
          { value: 'and_not', label: 'Y = A AND NOT B' },
          { value: 'majority', label: 'majority vote' },
        ], value: 'adder' },
        { id: 'params', label: 'Widths (JSON)', value: '{"bits":4}', help: 'For example {"bits":8} gives A[7:0], B[7:0] → Y = A + B.' },
        { id: 'profile', label: 'Profile', kind: 'select', options: ['BALANCED', 'FASTEST', 'SMALLEST', 'LOW_POWER', 'LOW_TEMPERATURE', 'MOST_STABLE'], value: 'BALANCED' },
        { id: 'evaluations', label: 'Evaluation budget', kind: 'number', value: 600, step: 50 },
        { id: 'population', label: 'Population', kind: 'number', value: 24, step: 4 },
        { id: 'seed', label: 'Seed', value: '1234' },
        { id: 'validate', label: 'Validate the result before saving', kind: 'checkbox', value: true },
      ],
      'Synthesize',
      (values) => {
        void this.synthesize(values);
      },
    );
  }

  async synthesize(values) {
    this.showDock('console');
    this.log(`reverse engineering: ${values.spec} ${values.params} → architecture → optimize → simulate → validate → save chip`, 'info', 'synth');
    await this.runOptimization(values, 'synth');
    if (!this.lastOptimization) return;
    if (!values.validate) return;
    const { optimizer, spec, params } = this.lastOptimization;
    let chip = null;
    try {
      chip = optimizer.saveBestAsChip ? optimizer.saveBestAsChip({ chips: this.editor.chips, lib: this.editor.lib }) : null;
    } catch (err) {
      this.log(`saving the chip failed: ${err.message}`, 'error', 'synth');
    }
    if (!chip) {
      const circuit = optimizer.buildBest();
      if (!circuit) return;
      chip = this.editor.project.saveAsChip(circuit, { id: `${spec.id}_synth`, name: `${spec.name} (synthesized)`, description: 'Produced by reverse engineering from a behavioural specification.', overwrite: true });
    }
    this.log(`chip ${chip.def.id} v${chip.def.version} saved; validating it against the specification it was synthesized for`, 'info', 'synth');
    try {
      const report = cf.validateChip(chip, { lib: this.editor.lib, chips: this.editor.chips, spec, params, seed: Number(values.seed) || 1234 });
      const totals = report.totals ?? {};
      this.log(
        `validation: ${totals.passed ?? 0} passed, ${totals.failed ?? 0} failed, ${totals.skipped ?? 0} skipped${report.accuracy ? ` · accuracy ${report.accuracy}` : ''}`,
        (totals.failed ?? 0) > 0 ? 'error' : 'ok',
        'synth',
      );
      this.showText(`Validation of ${chip.def.id}`, cf.reportAccuracy ? `${cf.validationToText ? cf.validationToText(report) : JSON.stringify(report.totals ?? report, null, 2)}` : JSON.stringify(report, null, 2));
      this.palette.render();
    } catch (err) {
      this.log(`validation failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'synth');
    }
  }

  benchmarkDialog() {
    this.form(
      'Benchmark the engine',
      [
        { id: 'suite', label: 'Suite', kind: 'select', options: [
          { value: 'quick', label: 'quick — a few seconds' },
          { value: 'full', label: 'full — every group, about two minutes' },
          { value: 'scaling', label: 'scaling — 10 to 1 000 000 components' },
          { value: 'stress', label: 'stress — the whole decade sweep' },
        ], value: 'quick' },
        { id: 'repeats', label: 'Repeats per case', kind: 'number', value: 1, step: 1 },
        { id: 'where', label: 'Run', kind: 'select', options: [
          { value: 'job', label: 'as a server job (survives a closed tab, shows progress)' },
          { value: 'browser', label: 'in this browser tab (blocks the interface while it runs)' },
        ], value: 'job' },
      ],
      'Run benchmark',
      (values) => {
        if (values.where === 'job') {
          void api.enqueue('benchmark', `benchmark ${values.suite}`, { suite: values.suite, repeats: Number(values.repeats) || 1 }).then(
            (r) => {
              this.log(`benchmark enqueued as job ${r.job.id}; watch it in the Jobs dock`, 'ok', 'bench');
              this.showDock('jobs');
              this.jobs.refresh();
            },
            (err) => this.log(`enqueuing the benchmark failed: ${err.message}`, 'error', 'bench'),
          );
          return;
        }
        this.log(`running the ${values.suite} suite in this tab; the interface will be unresponsive until it finishes`, 'warn', 'bench');
        setTimeout(async () => {
          try {
            const report = await cf.runBenchmarkSuite({ suite: values.suite, repeats: Number(values.repeats) || 1, quiet: true });
            this.lastBenchmark = report;
            this.showText(`Benchmark — ${values.suite}`, cf.benchmarkToText(report));
            this.log(`benchmark finished: ${report.cases.filter((c) => c.ran).length} case(s) measured, ${report.cases.filter((c) => !c.ran).length} not measured`, 'ok', 'bench');
          } catch (err) {
            this.log(`the benchmark failed: ${err.message}`, 'error', 'bench');
          }
        }, 60);
      },
    );
  }

  async jobAction(action) {
    const jobs = this.jobs.snapshot?.jobs ?? [];
    const target = jobs.find((j) => j.state === 'running') ?? jobs.find((j) => j.state === 'queued' || j.state === 'paused');
    if (!target) return this.log(`no job to ${action}`, 'warn', 'jobs');
    try {
      if (action === 'pause') await api.pauseJob(target.id);
      else if (action === 'resume') await api.resumeJob(target.id);
      else await api.cancelJob(target.id);
      this.log(`job ${target.id} ${action} requested`, 'info', 'jobs');
      this.jobs.refresh(true);
    } catch (err) {
      this.log(`the ${action} failed: ${err.message}`, 'error', 'jobs');
    }
  }

  // ---------------------------------------------------------------- reports

  runErc() {
    const diagnostics = this.editor.erc();
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    this.lastErc = { errors: errors.length, warnings: warnings.length, diagnostics };
    this.log(`ERC: ${errors.length} error(s), ${warnings.length} warning(s), ${diagnostics.length - errors.length - warnings.length} information item(s)`, errors.length ? 'error' : warnings.length ? 'warn' : 'ok', 'erc');
    for (const d of diagnostics.slice(0, 30)) this.log(`${d.code}: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`, d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'info', 'erc');
    if (diagnostics.length > 30) this.log(`… and ${diagnostics.length - 30} more; the full list is in the inspector's ERC card`, 'info', 'erc');
    this.inspector.render();
  }

  showFlattened() {
    const editor = this.editor;
    const nl = cf.flatten(editor.circuit, editor.lib, editor.chips, { metadata: true });
    const stats = cf.netlistStats(nl);
    this.showText(
      'Flattened netlist',
      [
        `Sheet: ${editor.circuit.name}`,
        `Fingerprint: ${nl.fingerprint}`,
        '',
        JSON.stringify(stats, null, 2),
        '',
        'Flattening expands every chip instance and every vector bit into the',
        'elements the solver actually works on. Nothing is simulated here.',
      ].join('\n'),
    );
    this.log(`flattened to ${stats.elements ?? '?'} element(s) over ${stats.instances ?? '?'} instance(s) and ${stats.nets ?? stats.nodeCount ?? '?'} net(s)`, 'info', 'circuit');
  }

  showStats() {
    const editor = this.editor;
    const nl = cf.flatten(editor.circuit, editor.lib, editor.chips, { metadata: true, ambient: 25 });
    const stats = cf.circuitStats(nl, { lib: editor.lib });
    this.showText('Circuit statistics', JSON.stringify(stats.stats, null, 2));
    this.log('statistics computed from the flattened netlist; power and temperature are absent because nothing was solved', 'info', 'stats');
  }

  /** The weakest accuracy declared by any model on this sheet. */
  sheetAccuracy() {
    const editor = this.editor;
    const accs = new Set();
    for (const inst of editor.circuit.allComponents()) {
      const spec = editor.lib.get(inst.specId);
      if (spec?.accuracy) accs.add(spec.accuracy);
      const chip = editor.chipOf(inst);
      if (chip) accs.add('APPROXIMATED');
    }
    if (accs.size === 0) return '—';
    const order = ['NOT_MODELED', 'IDEALIZED', 'APPROXIMATED', 'REALISTIC'];
    let weakest = 'REALISTIC';
    for (const a of accs) if (order.indexOf(a) < order.indexOf(weakest)) weakest = a;
    return weakest;
  }

  showAccuracy() {
    const editor = this.editor;
    const seen = new Map();
    for (const inst of editor.circuit.allComponents()) {
      const spec = editor.lib.get(inst.specId);
      if (!spec || seen.has(spec.id)) continue;
      seen.set(spec.id, spec);
    }
    const lines = ['Model accuracy declared by every type on this sheet', ''];
    for (const spec of seen.values()) {
      lines.push(`${spec.name} (${spec.id}) — ${spec.accuracy}`);
      lines.push(`  model: ${spec.model?.family ?? '—'} v${spec.model?.version ?? '—'}; levels ${(spec.model?.levels ?? []).join(', ') || '—'}`);
      for (const claim of spec.model?.claims ?? []) {
        lines.push(`  ${claim.phenomenon}: ${claim.level} — ${claim.detail}${claim.validity ? ` (valid: ${claim.validity})` : ''}`);
      }
      for (const limit of spec.model?.limitations ?? []) lines.push(`  limitation: ${limit}`);
      lines.push('');
    }
    lines.push(`Weakest class on this sheet: ${this.sheetAccuracy()}`);
    lines.push('');
    lines.push('A class is a declaration by the model, not a measurement of this design.');
    this.showText('Accuracy of this sheet', lines.join('\n'));
  }

  showAbout() {
    const about = typeof cf.about === 'function' ? cf.about() : {};
    const health = this.health ?? {};
    this.dialog({
      title: 'About CircuitForge',
      wide: true,
      body: `<div class="note">An electronic circuit design, simulation, synthesis and optimization laboratory. One engine, three interfaces: this editor, the command line, and the module other programs import.</div>
        <dl class="kv">
          <dt>Version</dt><dd>${esc(this.version)}</dd>
          <dt>Engine</dt><dd>${esc(JSON.stringify(about.engine ?? about.version ?? ''))}</dd>
          <dt>Platform</dt><dd>${esc(JSON.stringify(health.platform ?? {}))}</dd>
          <dt>GPU</dt><dd>${esc(JSON.stringify(health.gpu ?? {}))}</dd>
          <dt>Library</dt><dd>${this.editor.lib.all().length} component type(s)</dd>
          <dt>Chips</dt><dd>${this.editor.chips.size()} definition(s)</dd>
          <dt>Examples</dt><dd>${(cf.EXAMPLES ?? []).length}</dd>
        </dl>
        <div class="group-title">What this build claims</div>
        <div class="note warn">Four simulation levels: 0 four-state logic, 1 electrical (MNA, Newton-Raphson, transient), 2 device-level where a model exists, 3 lumped-RC thermal. Every model declares its accuracy class and its limitations; nothing is simulated that is only an arbitrary approximation, and no statistic is invented. Results are reported as “best found under current constraints”, never as optimal.</div>`,
      buttons: [{ label: 'Known limitations', run: () => this.showLimits() }, { label: 'Close', primary: true }],
    });
  }

  async showDocs() {
    let files = [];
    try {
      const response = await fetch('/docs/');
      if (response.ok) {
        const text = await response.text();
        files = [...text.matchAll(/href="([^"]+\.md)"/g)].map((m) => m[1]);
      }
    } catch {
      files = [];
    }
    if (files.length === 0) files = ['README.md', 'ARCHITECTURE.md', 'SIMULATION.md', 'PHYSICS.md', 'OPTIMIZATION.md', 'GPU.md', 'SCHEMATIC_EXPORT.md', 'FORMAT.md', 'DEVELOPER_GUIDE.md', 'USER_GUIDE.md', 'BENCHMARKS.md', 'KNOWN_LIMITATIONS.md'];
    this.dialog({
      title: 'Documentation',
      wide: true,
      body: `<div class="note">Twelve documents describe the engine: what it computes, what it approximates, and what it does not do at all.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${files.map((f) => `<button data-doc="${esc(f)}" style="justify-content:flex-start">${esc(f)}</button>`).join('')}</div>`,
      buttons: [{ label: 'Close', primary: true }],
    });
    document.querySelectorAll('[data-doc]').forEach((el) =>
      el.addEventListener('click', async () => {
        try {
          const response = await fetch(`/docs/${el.dataset.doc}`);
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          this.showText(el.dataset.doc, await response.text());
        } catch (err) {
          this.log(`${el.dataset.doc} could not be read from the server: ${err.message}`, 'warn', 'docs');
        }
      }),
    );
  }

  showLimits() {
    const text = [
      'Known limitations of this build',
      '',
      'Level 0 (logic): four-state, bit-parallel, event-free. It settles by iterating',
      'to a fixed point, so a combinational loop is reported as unsettled rather than',
      'oscillated. Delays are the declared delays of the elements; a declared 0 means',
      'the model does not model delay, and a critical path over such elements is a',
      'lower bound, not a measurement.',
      '',
      'Level 1 (electrical): modified nodal analysis with Newton-Raphson, a gmin ladder',
      'and source stepping. It is a DC and transient solver, not a microwave or',
      'distributed-element solver: no transmission lines, no S-parameters, no',
      'frequency-dependent interconnect. Inductors are handled as companion models,',
      'which limits the step size a stiff converter can take.',
      '',
      'Level 2 (devices): MOSFETs use a Shichman–Hodges class model (no BSIM short-',
      'channel effects, no gate tunnelling), BJTs a Gummel–Poon subset (no excess',
      'phase, no substrate network), diodes a single-junction exponential with',
      'junction and diffusion capacitance. Each declares its validity range.',
      '',
      'Level 3 (thermal): a lumped RC network, one node per instance, coupled to the',
      'electrical solve. It is steady state or a coarse transient; there is no spatial',
      'gradient inside a package, no airflow modelling, and no package-to-package',
      'coupling beyond the declared Rth.',
      '',
      'GPU: no compute backend is present in this build, so gpuProbe() reports',
      'backend "none", enabled false and no speedup is claimed anywhere. Everything',
      'runs on the CPU.',
      '',
      'Optimization: a seeded NSGA-II over a genome catalogue, with tiered filters.',
      'It reports the best candidate it scored under the declared constraints, budget,',
      'population and seed. It does not prove optimality and does not search',
      'architectures outside its catalogue.',
      '',
      'Rendering: the sheet is laid out and drawn headlessly as well as on a canvas.',
      'Wire crossings are counted and reported, not eliminated: the router does not',
      'solve a general crossing-minimisation problem.',
      '',
      'Scale: the engine is linear in the number of components for building,',
      'flattening, logic evaluation and serialisation, measured up to 100 000',
      'components in this environment. A million-component sheet needs more heap than',
      'the default V8 limit allows; the benchmark refuses that size with the numbers',
      'behind the refusal instead of being killed.',
    ].join('\n');
    this.showText('Known limitations', text);
  }

  // ---------------------------------------------------------------- examples

  async loadExample(id) {
    const example = (cf.EXAMPLES ?? []).find((x) => x.id === id);
    if (!example) return this.log(`no example named "${id}"`, 'error', 'examples');
    const proceed = () => {
      try {
        const circuit = example.build(this.editor.lib, this.editor.chips);
        const doc = cf.circuitToDocument(circuit);
        const result = this.editor.loadDocument(doc);
        this.editor.setFile(null);
        this.view.fit();
        this.log(`loaded the example “${example.name}”: ${this.editor.describe()}`, 'ok', 'examples');
        this.log(`${example.description}`, 'info', 'examples');
        for (const d of example.demonstrates ?? []) this.log(`demonstrates: ${d}`, 'info', 'examples');
        for (const d of result.diagnostics.slice(0, 6)) this.log(`${d.code}: ${d.message}`, d.severity === 'error' ? 'error' : 'warn', 'examples');
        if (example.expected && example.expected.length > 0) {
          this.log(`${example.expected.length} reading(s) are expected from this example; run the simulation and compare them with the values in the dock`, 'info', 'examples');
        }
        if (example.transient) {
          this.simulation.options.tstop = example.transient.tstop;
          this.simulation.options.electrical = example.level >= 1;
          this.scope.channels = example.transient.probes.map((p) => ({ ...p, name: p.target, visible: true }));
          this.scope.renderChannels();
          this.log(`this example declares a transient sweep: tstop ${eng(example.transient.tstop, 's')} with ${example.transient.probes.length} probe(s), now loaded into the oscilloscope`, 'info', 'examples');
        }
        this.showDock('simulation');
      } catch (err) {
        this.log(`building the example failed: ${err.code ? err.code + ': ' : ''}${err.message}`, 'error', 'examples');
      }
    };
    if (this.editor.circuit.componentCount() > 0 && this.editor.isDirty) this.confirmDiscard(proceed);
    else proceed();
  }

  async openChip(chipId, opts = {}) {
    const chip = this.editor.chips.get(chipId);
    if (!chip) {
      this.log(`no chip named "${chipId}"`, 'warn', 'boot');
      return;
    }
    try {
      const circuit = chip.implementation(chip.defaultParams());
      const doc = cf.circuitToDocument(circuit);
      this.editor.loadDocument(doc);
      this.editor.layers[this.editor.layers.length - 1].chipId = chipId;
      this.editor.layers[this.editor.layers.length - 1].title = chip.def.name;
      if (!opts.quiet) this.log(`opened ${chip.def.name} v${chip.def.version}`, 'info', 'boot');
    } catch (err) {
      this.log(`opening ${chipId} failed: ${err.message}`, 'error', 'boot');
    }
  }
}

function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

const app = new App();
window.circuitforge = app;

app.boot().catch((err) => {
  const pane = document.getElementById('pane-console');
  const line = document.createElement('div');
  line.className = 'log-line error';
  line.textContent = `startup failed: ${err && err.stack ? err.stack : String(err)}`;
  if (pane) pane.appendChild(line);
  document.getElementById('st-state').textContent = 'startup failed';
  // eslint-disable-next-line no-console
  console.error(err);
});

export { app };
