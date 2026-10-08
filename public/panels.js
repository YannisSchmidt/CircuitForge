/**
 * The two side panels: the component browser and the inspector.
 *
 * Both are rendered from the engine's own data rather than from a hand-written list.
 * The palette is the library, so a component added to the registry appears in it with
 * its real parameters and its declared accuracy; the inspector is the selected
 * instance, so what it shows is what the engine will simulate. Neither panel keeps a
 * second copy of the truth, which is the only way a fifty-three-component library and
 * a nineteen-chip reference project stay in step with what is on the sheet.
 *
 * Rendering is innerHTML with every interpolated value escaped, and event handling is
 * delegated on the container: a panel with a hundred rows cannot afford a hundred
 * listeners, and a rebuild must not lose the search text or the scroll position.
 */

import * as cf from '/engine/index.js';
import { esc, eng, fmtNumber } from './api.js';

const CATEGORY_ORDER = ['chip', 'digital', 'memory', 'passive', 'source', 'semiconductor', 'instrument', 'electromechanical', 'other'];

const CATEGORY_LABEL = {
  chip: 'Chips',
  digital: 'Digital logic',
  memory: 'Memory',
  passive: 'Passive',
  source: 'Sources',
  semiconductor: 'Semiconductors',
  instrument: 'Instruments',
  electromechanical: 'Electromechanical',
  other: 'Other',
};

const ACCURACY_CLASS = {
  REALISTIC: 'ok',
  APPROXIMATED: 'info',
  IDEALIZED: 'warn',
  NOT_MODELED: 'bad',
};

function glyphOf(spec) {
  const name = String(spec.name || spec.id || '?');
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 3) || spec.id.slice(0, 3)).toUpperCase();
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export class Palette {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.tab = 'components';
    this.query = '';
    this.tabsEl = document.getElementById('left-tabs');
    this.searchEl = document.getElementById('palette-search');
    this.buildTabs();
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  buildTabs() {
    const tabs = [
      { id: 'components', label: 'Components' },
      { id: 'chips', label: 'Chips' },
      { id: 'examples', label: 'Examples' },
    ];
    this.tabsEl.innerHTML = tabs
      .map((t) => `<div class="panel-tab${t.id === this.tab ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</div>`)
      .join('');
    this.tabsEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-tab]');
      if (!el) return;
      this.tab = el.dataset.tab;
      this.buildTabsActive();
      this.render();
    });
  }

  buildTabsActive() {
    for (const el of this.tabsEl.querySelectorAll('[data-tab]')) el.classList.toggle('active', el.dataset.tab === this.tab);
    this.searchEl.placeholder =
      this.tab === 'components' ? 'Search components…' : this.tab === 'chips' ? 'Search chips…' : 'Search examples…';
  }

  onClick(e) {
    const item = e.target.closest('[data-place]');
    if (item) {
      const kind = item.dataset.place;
      const id = item.dataset.id;
      if (kind === 'spec') this.app.armComponent(id);
      else if (kind === 'chip') this.app.armChip(id);
      return;
    }
    const open = e.target.closest('[data-open-chip]');
    if (open) {
      this.app.editor.openChip(open.dataset.openChip);
      this.app.afterEdit('open-chip');
      return;
    }
    const example = e.target.closest('[data-example]');
    if (example) this.app.loadExample(example.dataset.example);
  }

  onDoubleClick(e) {
    const item = e.target.closest('[data-place="chip"]');
    if (item) {
      this.app.editor.openChip(item.dataset.id);
      this.app.afterEdit('open-chip');
    }
  }

  render() {
    const editor = this.app.editor;
    if (this.tab === 'components') this.root.innerHTML = this.componentsHtml(editor);
    else if (this.tab === 'chips') this.root.innerHTML = this.chipsHtml(editor);
    else this.root.innerHTML = this.examplesHtml();
  }

  matches(text) {
    if (!this.query) return true;
    return text.toLowerCase().includes(this.query);
  }

  componentsHtml(editor) {
    const groups = new Map();
    for (const spec of editor.lib.all()) {
      if (!this.matches(`${spec.id} ${spec.name} ${spec.category} ${spec.description ?? ''} ${(spec.keywords ?? []).join(' ')}`)) continue;
      const key = spec.category || 'other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(spec);
    }
    const keys = [...groups.keys()].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
    if (keys.length === 0) return `<div class="empty">No component matches “${esc(this.query)}”.</div>`;
    let total = 0;
    const html = keys
      .map((key) => {
        const list = groups.get(key).sort((a, b) => a.name.localeCompare(b.name));
        total += list.length;
        return `<div class="group-title">${esc(CATEGORY_LABEL[key] ?? key)} <span class="count">${list.length}</span></div>` + list.map((s) => this.specRow(s, editor)).join('');
      })
      .join('');
    return `<div style="padding:6px 8px">${html}</div><div class="empty">${total} component type(s) in the library</div>`;
  }

  specRow(spec, editor) {
    const armed = this.app.armed && this.app.armed.type === spec.id ? ' armed' : '';
    const acc = spec.accuracy ? `<span class="badge ${ACCURACY_CLASS[spec.accuracy] ?? ''}" title="Declared accuracy of the default model">${esc(spec.accuracy)}</span>` : '';
    const pins = (spec.pins ?? []).length;
    const support = spec.support ? [spec.support.logic ? 'L0' : null, spec.support.electrical ? 'L1' : null, spec.support.thermal ? 'L3' : null].filter(Boolean).join(' ') : '';
    return `<div class="palette-item${armed}" data-place="spec" data-id="${esc(spec.id)}" title="${esc(spec.description ?? '')}">
      <div class="glyph">${esc(glyphOf(spec))}</div>
      <div class="meta">
        <div class="name">${esc(spec.name)}</div>
        <div class="sub">${esc(spec.refPrefix ?? '')} · ${pins} pin${pins === 1 ? '' : 's'}${support ? ` · ${esc(support)}` : ''}</div>
      </div>
      ${acc}
    </div>`;
    void editor;
  }

  chipsHtml(editor) {
    const chips = editor.chips.all().filter((c) => this.matches(`${c.def.id} ${c.def.name} ${c.def.description ?? ''}`));
    if (chips.length === 0) {
      return `<div class="empty">No chip definition yet.<br/><br/>Load the reference library (Circuit ▸ Load reference library) or save the current sheet as a chip (File ▸ Save sheet as chip…).</div>`;
    }
    const rows = chips
      .sort((a, b) => a.def.name.localeCompare(b.def.name))
      .map((chip) => {
        const ports = chip.def.ports ?? [];
        const inputs = ports.filter((p) => p.direction === 'input').length;
        const outputs = ports.filter((p) => p.direction === 'output').length;
        const params = chip.def.params ?? [];
        const armed = this.app.armed && this.app.armed.chip === chip.def.id ? ' armed' : '';
        return `<div class="palette-item${armed}" data-place="chip" data-id="${esc(chip.def.id)}" title="${esc(chip.def.description ?? '')} — double-click to open">
          <div class="glyph">IC</div>
          <div class="meta">
            <div class="name">${esc(chip.def.name)}</div>
            <div class="sub">v${esc(chip.def.version)} · ${inputs}↓ ${outputs}↑${params.length ? ` · ${params.map((p) => esc(p.id ?? p.name)).join(',')}` : ''}</div>
          </div>
          <button data-open-chip="${esc(chip.def.id)}" title="Open this chip's implementation">open</button>
        </div>`;
      })
      .join('');
    return `<div style="padding:6px 8px"><div class="group-title">Chip definitions <span class="count">${chips.length}</span></div>${rows}</div>
      <div class="empty">Click to place an instance · double-click or “open” to edit the definition</div>`;
  }

  examplesHtml() {
    const examples = (cf.EXAMPLES ?? []).filter((x) => this.matches(`${x.id} ${x.name} ${x.description ?? ''} ${x.category} ${(x.demonstrates ?? []).join(' ')}`));
    if (examples.length === 0) return `<div class="empty">No example matches “${esc(this.query)}”.</div>`;
    const byCategory = new Map();
    for (const x of examples) {
      if (!byCategory.has(x.category)) byCategory.set(x.category, []);
      byCategory.get(x.category).push(x);
    }
    let html = '';
    for (const [category, list] of byCategory) {
      html += `<div class="group-title">${esc(category)} <span class="count">${list.length}</span></div>`;
      for (const x of list) {
        html += `<div class="palette-item" data-example="${esc(x.id)}" title="${esc(x.description ?? '')}">
          <div class="glyph">L${x.level}</div>
          <div class="meta">
            <div class="name">${esc(x.name)}</div>
            <div class="sub">${esc(x.id)}${x.expected && x.expected.length ? ` · ${x.expected.length} check(s)` : ''}</div>
          </div>
        </div>`;
      }
    }
    return `<div style="padding:6px 8px">${html}</div><div class="empty">Each example carries the readings it must reproduce, with their independent derivation.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.tabsEl = document.getElementById('right-tabs');
    this.app = app;
    this.tab = 'inspector';
    this.tabs = [
      { id: 'inspector', label: 'Inspector' },
      { id: 'nets', label: 'Nets' },
      { id: 'model', label: 'Model' },
    ];
    this.tabsEl.innerHTML = this.tabs.map((t) => `<div class="panel-tab${t.id === this.tab ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</div>`).join('');
    this.tabsEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-tab]');
      if (!el) return;
      this.tab = el.dataset.tab;
      for (const t of this.tabsEl.querySelectorAll('[data-tab]')) t.classList.toggle('active', t.dataset.tab === this.tab);
      this.render();
    });
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('input', (e) => this.onChange(e));
    root.addEventListener('click', (e) => this.onClick(e));
  }

  render() {
    const scroll = this.root.scrollTop;
    this.paint();
    this.root.scrollTop = scroll;
  }

  paint() {
    if (this.tab === 'nets') this.root.innerHTML = this.netsHtml();
    else if (this.tab === 'model') this.root.innerHTML = this.modelHtml();
    else this.root.innerHTML = this.inspectorHtml();
  }

  onChange(e) {
    const el = e.target;
    const ref = el.dataset.ref;
    if (!ref) return;
    const editor = this.app.editor;
    if (el.dataset.param) {
      const spec = editor.lib.get(editor.byRef(ref)?.specId ?? '');
      const param = (spec?.params ?? []).find((p) => p.id === el.dataset.param);
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (param?.kind === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          this.app.log(`${ref}.${el.dataset.param}: “${value}” is not a number`, 'error');
          this.render();
          return;
        }
        value = n;
      }
      const ok = editor.setParam(ref, el.dataset.param, value);
      this.app.log(ok ? `${ref}.${el.dataset.param} = ${String(value)}` : `${ref}.${el.dataset.param} was not changed`, ok ? 'info' : 'warn');
      this.app.afterEdit('param');
      return;
    }
    if (el.dataset.field === 'bits') {
      const n = Math.max(1, Math.round(Number(el.value) || 1));
      editor.setBits(ref, n);
      this.app.afterEdit('bits');
      return;
    }
    if (el.dataset.field === 'ref') {
      const next = String(el.value || '').trim();
      if (!next || next === ref) return;
      if (editor.setRef(ref, next)) this.app.log(`renamed ${ref} → ${next}`, 'info');
      this.app.afterEdit('ref');
      return;
    }
    if (el.dataset.field === 'rotation') {
      editor.rotate([ref], Number(el.value) || 0);
      this.app.afterEdit('rotate');
    }
  }

  onClick(e) {
    const el = e.target;
    const editor = this.app.editor;
    if (el.dataset.selectNet) {
      editor.selectNet(el.dataset.selectNet);
      this.app.view.requestDraw();
      this.render();
      return;
    }
    if (el.dataset.disconnectRef) {
      editor.disconnect(el.dataset.disconnectRef, el.dataset.disconnectPin || undefined);
      this.app.log(`disconnected ${el.dataset.disconnectRef}${el.dataset.disconnectPin ? '.' + el.dataset.disconnectPin : ''}`, 'info');
      this.app.afterEdit('disconnect');
      return;
    }
    if (el.dataset.addPort) {
      this.app.promptPort();
      return;
    }
    if (el.dataset.openRef) {
      if (editor.open(el.dataset.openRef)) this.app.afterEdit('open');
      else this.render();
      return;
    }
    if (el.dataset.ercNow) {
      this.app.runErc();
      return;
    }
    if (el.dataset.removePort) {
      if (editor.removePort(el.dataset.removePort)) this.app.log(`removed port ${el.dataset.removePort}`, 'info');
      this.app.afterEdit('remove-port');
      return;
    }
    // Buttons that act on the selection go through the same command runner the menu
    // and the keyboard use, so one action has one implementation.
    if (el.dataset.act) {
      const map = { rotate: 'edit.rotate', duplicate: 'edit.duplicate', delete: 'edit.delete', disconnect: 'edit.disconnect' };
      const id = map[el.dataset.act];
      if (id) this.app.runCommand(id);
      return;
    }
    if (el.dataset.focusRef) {
      const inst = editor.byRef(el.dataset.focusRef);
      if (inst) this.app.view.centerOn({ x: inst.x, y: inst.y });
      return;
    }
    const row = el.closest('tr[data-net]');
    if (row) {
      editor.selectNet(row.dataset.net);
      this.app.view.requestDraw();
      this.render();
    }
  }

  inspectorHtml() {
    const editor = this.app.editor;
    const selection = editor.selection;
    if (editor.selectedNet) return this.netHtml(editor.selectedNet);
    if (selection.length === 0) return this.sheetHtml();
    if (selection.length > 1) return this.multiHtml(selection);
    return this.componentHtml(selection[0]);
  }

  sheetHtml() {
    const editor = this.app.editor;
    const c = editor.circuit;
    const ports = c.allPorts();
    const erc = this.app.lastErc;
    const bits = c.allComponents().reduce((a, x) => a + Math.max(1, x.bits), 0);
    return `<div class="card">
      <header>Sheet <span class="badge info">${esc(editor.path.join(' › '))}</span></header>
      <div class="body">
        <dl class="kv">
          <dt>Name</dt><dd>${esc(c.name)}</dd>
          <dt>Components</dt><dd>${c.componentCount()} (${bits} physical)</dd>
          <dt>Nets</dt><dd>${c.netCount()}</dd>
          <dt>Ports</dt><dd>${ports.length}</dd>
          <dt>Revision</dt><dd>${c.revision}</dd>
          <dt>Fingerprint</dt><dd>${esc(c.fingerprint(editor.lib))}</dd>
          <dt>Digital</dt><dd>${c.isDigital(editor.lib, editor.chips) ? 'yes' : 'no'}</dd>
        </dl>
      </div>
    </div>
    <div class="card">
      <header>Circuit ports <button data-add-port="1">add…</button></header>
      <div class="body tight">
        ${
          ports.length === 0
            ? `<div class="empty">This sheet has no ports. A chip needs at least one to be usable from the level above.</div>`
            : ports
                .map((p) => {
                  const net = c.getNet(p.net);
                  return `<div class="pin-row"><span class="dir ${esc(p.direction)}"></span>
            <span>${esc(p.name)} <span class="net">${p.width > 1 ? `[${p.width}]` : ''} ${esc(net?.name ?? '')}</span></span>
            <span>${net ? `<button data-select-net="${esc(net.name)}" title="Select the net this port drives">net</button>` : ''}
            <button data-remove-port="${esc(p.name)}" title="Remove this port">✕</button></span></div>`;
                })
                .join('')
        }
      </div>
    </div>
    ${
      erc
        ? `<div class="card"><header>ERC <span class="badge ${erc.errors ? 'bad' : erc.warnings ? 'warn' : 'ok'}">${erc.errors} error · ${erc.warnings} warn</span></header>
      <div class="body tight">${erc.diagnostics.slice(0, 12).map((d) => `<div class="log-line ${d.severity}"><span class="src">${esc(d.code)}</span><span>${esc(d.message)}</span></div>`).join('') || '<div class="empty">No diagnostic.</div>'}</div></div>`
        : `<div class="card"><header>ERC</header><div class="body tight"><div class="empty">Not run yet.</div><button data-erc-now="1" style="width:100%">Run electrical rules check</button></div></div>`
    }
    <div class="card"><header>Hint</header><div class="body tight"><div class="empty" style="text-align:left">Click a component to inspect it · click a port and then another port to wire them · double-click a chip to open it · scroll to zoom, space-drag to pan.</div></div></div>`;
  }

  multiHtml(refs) {
    const editor = this.app.editor;
    const rows = refs
      .map((ref) => {
        const inst = editor.byRef(ref);
        if (!inst) return '';
        const spec = editor.lib.get(inst.specId);
        return `<div class="pin-row"><span class="dir ${esc(spec?.category === 'chip' ? 'output' : 'input')}"></span>
          <span>${esc(ref)} <span class="net">${esc(spec?.name ?? inst.specId)}</span></span>
          <button data-focus-ref="${esc(ref)}" title="Centre the view on it">◎</button></div>`;
      })
      .join('');
    return `<div class="card"><header>Selection <span class="badge info">${refs.length}</span></header>
      <div class="body tight">
        <div class="tgroup" style="margin-bottom:6px">
          <button data-act="rotate">Rotate 90°</button>
          <button data-act="duplicate">Duplicate</button>
          <button data-act="delete" class="danger">Delete</button>
        </div>
        ${rows}
      </div></div>
      <div class="empty">Operations apply to all ${refs.length} components.</div>`;
  }

  componentHtml(ref) {
    const editor = this.app.editor;
    const inst = editor.byRef(ref);
    if (!inst) return `<div class="empty">“${esc(ref)}” is no longer on this sheet.</div>`;
    const spec = editor.lib.get(inst.specId);
    const chip = editor.chipOf(inst);
    const measured = this.app.measurements?.nodes?.[ref] ?? null;
    const pins = (spec?.pins ?? []).map((p) => {
      const net = editor.circuit.netOf(inst.id, p.name);
      const state = net ? this.app.measurements?.nets?.[net.name] : null;
      const value = state && state.value !== undefined ? valueBadge(state) : '';
      const voltage = state && state.voltage !== undefined && state.voltage !== null ? `<span class="net">${eng(state.voltage, 'V')}</span>` : '';
      return `<div class="pin-row">
        <span class="dir ${esc(p.direction)}" title="${esc(p.direction)}"></span>
        <span>${esc(p.name)} ${p.width > 1 ? `<span class="net">[${p.width}]</span>` : ''} ${value} ${voltage}</span>
        <span>${net ? `<button data-select-net="${esc(net.name)}" title="Select this net">${esc(net.name || 'net#' + net.id)}</button>` : `<span class="net none">unconnected</span>`}</span>
      </div>`;
    });
    const params = (spec?.params ?? [])
      .map((p) => {
        const value = inst.params[p.id] !== undefined ? inst.params[p.id] : p.default;
        const control = paramControl(p, value, ref);
        return `<div class="param-row"><label title="${esc(p.description ?? '')}">${esc(p.label ?? p.id)}</label>${control}</div>`;
      })
      .join('');
    return `<div class="card">
      <header>${esc(spec?.name ?? inst.specId)} <span class="badge">${esc(ref)}</span></header>
      <div class="body">
        <dl class="kv">
          <dt>Type</dt><dd>${esc(inst.specId)}</dd>
          ${chip ? `<dt>Chip</dt><dd>${esc(chip.def.id)} v${esc(chip.def.version)}</dd>` : ''}
          <dt>Category</dt><dd>${esc(spec?.category ?? '—')}</dd>
          <dt>Position</dt><dd>${fmtNumber(inst.x)}, ${fmtNumber(inst.y)}</dd>
          <dt>Rotation</dt><dd><select data-ref="${esc(ref)}" data-field="rotation">
            ${[0, 90, 180, 270].map((r) => `<option value="${r}"${inst.rotation === r ? ' selected' : ''}>${r}°</option>`).join('')}
          </select></dd>
          <dt>Bits</dt><dd><input type="number" min="1" step="1" value="${inst.bits}" data-ref="${esc(ref)}" data-field="bits" /></dd>
          <dt>Reference</dt><dd><input type="text" value="${esc(ref)}" data-ref="${esc(ref)}" data-field="ref" spellcheck="false" /></dd>
          ${spec?.accuracy ? `<dt>Accuracy</dt><dd><span class="badge ${ACCURACY_CLASS[spec.accuracy] ?? ''}">${esc(spec.accuracy)}</span></dd>` : ''}
        </dl>
        ${spec?.description ? `<div class="note" style="margin-top:8px">${esc(spec.description)}</div>` : ''}
        ${measured ? measuredCard(measured) : ''}
        <div class="tgroup" style="margin-top:8px">
          ${chip ? `<button data-open-ref="${esc(ref)}">Open chip</button>` : ''}
          <button data-act="rotate">Rotate</button>
          <button data-act="duplicate">Duplicate</button>
          <button data-act="delete" class="danger">Delete</button>
        </div>
      </div>
    </div>
    <div class="card"><header>Parameters <span class="count">${(spec?.params ?? []).length}</span></header>
      <div class="body tight">${params || '<div class="empty">This component takes no parameter.</div>'}</div>
    </div>
    <div class="card"><header>Pins <span class="count">${(spec?.pins ?? []).length}</span></header>
      <div class="body tight">${pins.join('') || '<div class="empty">No pin is declared for this type.</div>'}</div>
    </div>
    ${spec?.model ? modelCard(spec) : ''}`;
  }

  netHtml(name) {
    const editor = this.app.editor;
    const net = editor.circuit.allNets().find((n) => n.name === name);
    if (!net) return `<div class="empty">No net named “${esc(name)}”.</div>`;
    const connections = [];
    for (const c of editor.circuit.allComponents()) {
      const spec = editor.lib.get(c.specId);
      for (const p of spec?.pins ?? []) {
        const attached = editor.circuit.netOf(c.id, p.name);
        if (attached && attached.id === net.id) connections.push({ ref: c.ref, pin: p.name, direction: p.direction });
      }
    }
    const state = this.app.measurements?.nets?.[name];
    const drivers = connections.filter((c) => c.direction === 'output' || c.direction === 'supply');
    return `<div class="card"><header>Net <span class="badge info">${esc(name || `net#${net.id}`)}</span></header>
      <div class="body">
        <dl class="kv">
          <dt>Width</dt><dd>${net.width} bit</dd>
          <dt>Class</dt><dd>${esc(net.netClass ?? '—')}</dd>
          <dt>Connections</dt><dd>${connections.length}</dd>
          <dt>Drivers</dt><dd>${drivers.length}${drivers.length === 0 ? ' <span class="badge warn">undriven</span>' : drivers.length > 1 ? ' <span class="badge bad">contested</span>' : ''}</dd>
          ${state ? `<dt>Value</dt><dd>${state.word ? esc(state.word) : state.value === undefined ? '—' : esc(String(state.value))}</dd>` : ''}
          ${state && state.voltage !== undefined && state.voltage !== null ? `<dt>Voltage</dt><dd>${eng(state.voltage, 'V')}</dd>` : ''}
          ${state && state.temperature !== undefined && state.temperature !== null ? `<dt>Temperature</dt><dd>${fmtNumber(state.temperature, 1)} °C</dd>` : ''}
        </dl>
      </div></div>
      <div class="card"><header>Attached pins</header><div class="body tight">
        ${connections.map((c) => `<div class="pin-row"><span class="dir ${esc(c.direction)}"></span><span>${esc(c.ref)}.${esc(c.pin)}</span>
          <button data-disconnect-ref="${esc(c.ref)}" data-disconnect-pin="${esc(c.pin)}" title="Detach this pin from the net">✕</button></div>`).join('') || '<div class="empty">Nothing is attached.</div>'}
      </div></div>`;
  }

  netsHtml() {
    const editor = this.app.editor;
    const nets = editor.circuit.allNets();
    if (nets.length === 0) return `<div class="empty">This sheet has no net yet.</div>`;
    const rows = nets
      .map((n) => {
        const connections = editor.circuit.allComponents().reduce((count, c) => {
          const spec = editor.lib.get(c.specId);
          for (const p of spec?.pins ?? []) if (editor.circuit.netOf(c.id, p.name)?.id === n.id) count++;
          return count;
        }, 0);
        const state = this.app.measurements?.nets?.[n.name];
        return `<tr data-net="${esc(n.name)}"><td class="txt">${esc(n.name || `net#${n.id}`)}</td><td class="num">${n.width}</td><td class="num">${connections}</td><td class="txt">${state ? esc(state.word ?? String(state.value ?? '')) : ''}</td></tr>`;
      })
      .join('');
    return `<div class="card"><header>Nets <span class="count">${nets.length}</span></header>
      <div class="body tight"><table class="grid"><thead><tr><th>Name</th><th class="num">Bits</th><th class="num">Pins</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  modelHtml() {
    const editor = this.app.editor;
    const ref = editor.selection[0];
    const inst = ref ? editor.byRef(ref) : undefined;
    if (!inst) return `<div class="empty">Select a component to see the model behind it: what it computes, what it approximates, where it stops being valid, and which parameters you can change.</div>`;
    const spec = editor.lib.get(inst.specId);
    if (!spec?.model) return `<div class="empty">No model card is declared for ${esc(inst.specId)}.</div>`;
    return modelCard(spec);
  }
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

function valueBadge(state) {
  if (state.word) return `<span class="badge info" title="bus value">${esc(state.word)}</span>`;
  if (state.value === 1) return `<span class="badge ok">1</span>`;
  if (state.value === 0) return `<span class="badge">0</span>`;
  if (state.value === 'X') return `<span class="badge warn">X</span>`;
  if (state.value === 'Z') return `<span class="badge warn">Z</span>`;
  return '';
}

function measuredCard(m) {
  const rows = [];
  if (m.power !== undefined && m.power !== null) rows.push(['Power', eng(m.power, 'W')]);
  if (m.temperature !== undefined && m.temperature !== null) rows.push(['Temperature', `${fmtNumber(m.temperature, 1)} °C`]);
  if (m.current !== undefined && m.current !== null) rows.push(['Current', eng(m.current, 'A')]);
  if (m.voltage !== undefined && m.voltage !== null) rows.push(['Voltage', eng(m.voltage, 'V')]);
  if (rows.length === 0) return '';
  return `<div class="note" style="margin-top:8px"><b>Measured</b><dl class="kv" style="margin-top:4px">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
}

function modelCard(spec) {
  const model = spec.model;
  const claims = (model.claims ?? [])
    .map(
      (c) => `<tr><td class="txt">${esc(c.phenomenon)}</td><td><span class="badge ${ACCURACY_CLASS[c.level] ?? ''}">${esc(c.level)}</span></td>
        <td class="txt">${esc(c.detail ?? '')}${c.validity ? `<br/><span style="color:var(--text-faint)">valid: ${esc(c.validity)}</span>` : ''}</td></tr>`,
    )
    .join('');
  const params = (model.parameters ?? []).map((p) => `<tr><td class="txt">${esc(p.name)}</td><td>${esc(p.unit ?? '')}</td><td class="txt">${esc(p.meaning ?? '')}</td></tr>`).join('');
  const limits = (model.limitations ?? []).map((l) => `<li>${esc(l)}</li>`).join('');
  const equations = (model.equations ?? []).map((e) => `<li><code>${esc(e)}</code></li>`).join('');
  const refs = (model.references ?? []).map((r) => `<li>${esc(r)}</li>`).join('');
  return `<div class="card"><header>Model accuracy <span class="badge ${ACCURACY_CLASS[spec.accuracy] ?? ''}">${esc(spec.accuracy ?? '—')}</span></header>
    <div class="body tight">
      <dl class="kv"><dt>Family</dt><dd>${esc(model.family ?? '—')}</dd><dt>Version</dt><dd>${esc(model.version ?? '—')}</dd>
      <dt>Levels</dt><dd>${(model.levels ?? []).map((l) => `L${l}`).join(', ') || '—'}</dd></dl>
      ${claims ? `<table class="grid" style="margin-top:8px"><thead><tr><th>Phenomenon</th><th>Class</th><th>What is computed</th></tr></thead><tbody>${claims}</tbody></table>` : ''}
      ${limits ? `<div class="note warn" style="margin-top:8px"><b>Limitations</b><ul style="margin:4px 0 0 16px;padding:0">${limits}</ul></div>` : ''}
      ${equations ? `<div class="note" style="margin-top:8px"><b>Equations implemented</b><ul style="margin:4px 0 0 16px;padding:0">${equations}</ul></div>` : ''}
      ${params ? `<table class="grid" style="margin-top:8px"><thead><tr><th>Parameter</th><th>Unit</th><th>Meaning</th></tr></thead><tbody>${params}</tbody></table>` : ''}
      ${refs ? `<div class="note" style="margin-top:8px"><b>References</b><ul style="margin:4px 0 0 16px;padding:0">${refs}</ul></div>` : ''}
    </div></div>`;
}

function paramControl(p, value, ref) {
  const id = `data-ref="${esc(ref)}" data-param="${esc(p.id)}"`;
  const title = `title="${esc(p.description ?? '')}"`;
  if (p.kind === 'boolean') {
    return `<label style="justify-self:end"><input type="checkbox" ${id} ${title} ${value ? 'checked' : ''} /></label>`;
  }
  if (p.kind === 'choice' && Array.isArray(p.options)) {
    return `<select ${id} ${title}>${p.options.map((o) => `<option value="${esc(o)}"${String(o) === String(value) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (p.kind === 'string') {
    return `<input type="text" ${id} ${title} value="${esc(value ?? '')}" spellcheck="false" />`;
  }
  const step = p.step ?? 'any';
  const unit = p.unit ? `<span class="unit">${esc(p.unit)}</span>` : '';
  return `<span style="display:flex;gap:4px;align-items:center"><input type="number" ${id} ${title} value="${esc(value ?? '')}" step="${esc(step)}"${p.min !== undefined ? ` min="${esc(p.min)}"` : ''}${p.max !== undefined ? ` max="${esc(p.max)}"` : ''} />${unit}</span>`;
}

export { valueBadge, modelCard };
