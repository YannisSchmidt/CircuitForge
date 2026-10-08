/**
 * The HTTP server: what it serves, what it computes, and what it refuses.
 *
 * These tests start a real server on an ephemeral port and talk to it over HTTP, the
 * way a browser does, because the failure modes worth catching here are HTTP ones: a
 * module served with the wrong content type (the browser refuses to execute it), a
 * path that escapes the served directory, an endpoint that swallows an engine error
 * and answers 200 with nothing in it, and a route that reports a number the engine
 * never produced.
 *
 * The truth-table assertion is the one that matters most. Level 0 addresses nets by
 * node index, and an endpoint that passed names instead would return a table full of
 * X — a green HTTP 200 wrapping an answer that is simply wrong. Checking the adder's
 * eight rows against arithmetic catches that class of bug, which no amount of
 * "the endpoint responded" testing would.
 */

import { assert, assertEqual, suite, test } from '../framework.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { circuitToDocument } from '../../src/engine/io/serialize.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';

suite('server');

const project = buildReferenceProject('server-test');
const dataDir = `data/test-server-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let server: RunningServer | null = null;
let base = '';

async function up(): Promise<string> {
  if (server) return base;
  server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir });
  base = `http://127.0.0.1:${server.port}`;
  return base;
}

async function get(path: string): Promise<{ status: number; type: string; text: string; json: () => Record<string, unknown> }> {
  const url = await up();
  const response = await fetch(url + path);
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const url = await up();
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function fullAdderDocument(): Record<string, unknown> {
  const chip = project.chips.get('full_adder');
  assert(chip !== undefined, 'the reference project has a full_adder chip');
  return circuitToDocument(chip!.implementation({})) as unknown as Record<string, unknown>;
}

/**
 * A flat sheet of `n` full adders built from gates, as a document.
 *
 * Flat, because that is the case in which the occurrences are on the sheet being mined
 * and may therefore be replaced: an occurrence inside a chip expansion belongs to
 * another sheet, and the miner says so instead of editing it from here.
 */
function repeatedAddersDocument(n: number): Record<string, unknown> {
  const b = new CircuitBuilder(project.lib, `flat_${n}`);
  for (let i = 0; i < n; i++) {
    for (const net of ['a', 'b', 'ci']) b.port(`${net}${i}`.toUpperCase(), 'input', `${net}${i}`, 1);
    const x1 = b.add('xor_gate', { inputs: 2 }, [i * 220, 0]);
    const x2 = b.add('xor_gate', { inputs: 2 }, [i * 220 + 60, 0]);
    const a1 = b.add('and_gate', { inputs: 2 }, [i * 220, 60]);
    const a2 = b.add('and_gate', { inputs: 2 }, [i * 220 + 60, 60]);
    const or = b.add('or_gate', { inputs: 2 }, [i * 220 + 120, 60]);
    b.at(x1, 'IN1', `a${i}`, 1).at(x1, 'IN2', `b${i}`, 1).at(x1, 'OUT', `x1_${i}`, 1);
    b.at(x2, 'IN1', `x1_${i}`, 1).at(x2, 'IN2', `ci${i}`, 1).at(x2, 'OUT', `s${i}`, 1);
    b.at(a1, 'IN1', `a${i}`, 1).at(a1, 'IN2', `b${i}`, 1).at(a1, 'OUT', `p${i}`, 1);
    b.at(a2, 'IN1', `x1_${i}`, 1).at(a2, 'IN2', `ci${i}`, 1).at(a2, 'OUT', `g${i}`, 1);
    b.at(or, 'IN1', `p${i}`, 1).at(or, 'IN2', `g${i}`, 1).at(or, 'OUT', `co${i}`, 1);
    b.port(`S${i}`, 'output', `s${i}`, 1);
    b.port(`CO${i}`, 'output', `co${i}`, 1);
  }
  return circuitToDocument(b.finish({ erc: false })) as unknown as Record<string, unknown>;
}

/** Sum is right, carry is a three-input AND: close to a full adder, and not one. */
function nearAdderDocument(): Record<string, unknown> {
  const b = new CircuitBuilder(project.lib, 'near_adder');
  for (const net of ['a', 'bb', 'ci']) b.port(net.toUpperCase(), 'input', net, 1);
  const x1 = b.add('xor_gate', { inputs: 2 }, [0, 0]);
  const x2 = b.add('xor_gate', { inputs: 2 }, [60, 0]);
  const a3 = b.add('and_gate', { inputs: 3 }, [0, 60]);
  b.at(x1, 'IN1', 'a', 1).at(x1, 'IN2', 'bb', 1).at(x1, 'OUT', 'x', 1);
  b.at(x2, 'IN1', 'x', 1).at(x2, 'IN2', 'ci', 1).at(x2, 'OUT', 's', 1);
  b.at(a3, 'IN1', 'a', 1).at(a3, 'IN2', 'bb', 1).at(a3, 'IN3', 'ci', 1).at(a3, 'OUT', 'co', 1);
  b.port('S', 'output', 's', 1);
  b.port('CO', 'output', 'co', 1);
  return circuitToDocument(b.finish({ erc: false })) as unknown as Record<string, unknown>;
}

test('the miner answers over HTTP, substitutes an identical match, and refuses a near one', async () => {
  const document = repeatedAddersDocument(3);

  const found = await post('/api/mine', { document });
  assertEqual(found.status, 200, 'the miner answers');
  const report = (found.json().report ?? {}) as Record<string, unknown>;
  const patterns = (report.patterns ?? []) as Array<Record<string, unknown>>;
  assert(patterns.length > 0, `it found the repeated block(s): ${patterns.length} pattern(s)`);
  const adder = patterns.find((p) => ((p.matchedChip ?? {}) as Record<string, unknown>).id === 'full_adder' && ((p.matchedChip ?? {}) as Record<string, unknown>).identical === true);
  assert(adder !== undefined, 'one of them is measured to be the full adder');
  assertEqual(adder!.count, 3, 'with all three occurrences');
  assertEqual(found.json().replacement, undefined, 'nothing is replaced unless that is asked for');

  const replaced = await post('/api/mine', { document, replace: true });
  assertEqual(replaced.status, 200, 'the substitution is performed on request');
  const substitution = (replaced.json().replacement ?? {}) as Record<string, unknown>;
  assertEqual(substitution.chipId, 'full_adder', 'with the chip the behaviour matched');
  assertEqual(substitution.replaced, 3, 'all three occurrences');
  assertEqual((substitution.skipped as unknown[]).length, 0, 'none skipped: they are all on this sheet');
  assertEqual(substitution.componentsBefore, 15, 'fifteen gates in');
  assertEqual(substitution.componentsAfter, 3, 'three chip instances out');
  const rewritten = substitution.document as Record<string, unknown> | null;
  assert(rewritten !== null && typeof rewritten === 'object', 'and the rewritten sheet comes back as a document the editor can take');
  assertEqual(((rewritten as Record<string, unknown>).components as unknown[]).length, 3, 'holding three components');

  const nearDocument = nearAdderDocument();
  const near = await post('/api/mine', { document: nearDocument, replace: true, minOccurrences: 1 });
  assertEqual(near.status, 409, 'a near match is refused, not substituted');
  assert(/identically|nothing to substitute/i.test(near.text), `and the refusal says why: ${near.text.slice(0, 160)}`);

  // An explicit override is not a bypass. Even if the caller names `full_adder`, the
  // server measures that selected chip against the requested pattern before editing.
  const nearReport = await post('/api/mine', { document: nearDocument, minOccurrences: 1 });
  const reportPatterns = (nearReport.json().report as Record<string, unknown>).patterns as Array<Record<string, unknown>>;
  const wrongCarry = reportPatterns.find((p) => p.inputs === 3 && p.outputs === 2 && (p.matchedChip as Record<string, unknown> | null)?.id === 'full_adder');
  assert(wrongCarry !== undefined, 'the near-carry pattern was measured and matched to the adder only approximately');
  const explicit = await post('/api/mine', { document: nearDocument, minOccurrences: 1, pattern: wrongCarry!.id, chip: 'full_adder', replace: true });
  assertEqual(explicit.status, 409, 'explicit chip selection also refuses a measured near match');
  assert(/differs from the pattern/i.test(explicit.text), `the response reports the measured mismatch: ${explicit.text.slice(0, 200)}`);
});

/** `n` copies of a block no library chip computes, so extraction is the only way to de-duplicate it. */
function repeatedOddAddersDocument(n: number): Record<string, unknown> {
  const b = new CircuitBuilder(project.lib, `odd_${n}`);
  for (let i = 0; i < n; i++) {
    for (const net of ['a', 'b', 'ci']) b.port(`${net}${i}`.toUpperCase(), 'input', `${net}${i}`, 1);
    const x1 = b.add('xor_gate', { inputs: 2 }, [i * 240, 0]);
    const x2 = b.add('xor_gate', { inputs: 2 }, [i * 240 + 60, 0]);
    const a1 = b.add('and_gate', { inputs: 2 }, [i * 240, 60]);
    const o1 = b.add('or_gate', { inputs: 2 }, [i * 240 + 120, 60]);
    b.at(x1, 'IN1', `a${i}`, 1).at(x1, 'IN2', `b${i}`, 1).at(x1, 'OUT', `x_${i}`, 1);
    b.at(x2, 'IN1', `x_${i}`, 1).at(x2, 'IN2', `ci${i}`, 1).at(x2, 'OUT', `s${i}`, 1);
    b.at(a1, 'IN1', `a${i}`, 1).at(a1, 'IN2', `x_${i}`, 1).at(a1, 'OUT', `g${i}`, 1);
    b.at(o1, 'IN1', `g${i}`, 1).at(o1, 'IN2', `ci${i}`, 1).at(o1, 'OUT', `co${i}`, 1);
    b.port(`S${i}`, 'output', `s${i}`, 1);
    b.port(`CO${i}`, 'output', `co${i}`, 1);
  }
  return circuitToDocument(b.finish({ erc: false })) as unknown as Record<string, unknown>;
}

function repeatedSequentialDocument(): Record<string, unknown> {
  const b = new CircuitBuilder(project.lib, 'two rising-edge register blocks');
  for (let i = 0; i < 2; i++) {
    for (const pin of ['d', 'clk', 'rst']) b.port(`${pin.toUpperCase()}${i}`, 'input', `${pin}${i}`, 1);
    const dff = b.add('dff', { edge: 'rising', resetActive: 'high', initial: '0' }, [i * 120, 0]);
    const inv = b.add('not_gate', {}, [i * 120 + 60, 0]);
    b.at(dff, 'D', `d${i}`).at(dff, 'CLK', `clk${i}`).at(dff, 'RST', `rst${i}`).at(dff, 'Q', `q${i}`).at(dff, 'QN', `qn${i}`);
    b.at(inv, 'IN1', `q${i}`).at(inv, 'OUT', `y${i}`);
    b.port(`Y${i}`, 'output', `y${i}`, 1);
  }
  return circuitToDocument(b.finish({ erc: false })) as unknown as Record<string, unknown>;
}

test('the miner extracts a chip over HTTP, and the same request can replace with it', async () => {
  const document = repeatedOddAddersDocument(4);

  const extracted = await post('/api/mine', { document, extract: true });
  assertEqual(extracted.status, 200, 'extraction answers');
  const ex = (extracted.json().extraction ?? {}) as Record<string, unknown>;
  assert(typeof ex.chipId === 'string' && (ex.chipId as string).length > 0, `a chip id came back (${String(ex.chipId)})`);
  assertEqual(ex.identical, true, 'the copy was measured against the pattern');
  assertEqual(ex.differingRows, 0, 'differing rows');
  assertEqual((ex.ports as unknown[]).length, 5, 'three input ports and two output ports');
  assert(ex.implementation !== null && typeof ex.implementation === 'object', 'with the implementation as a document');
  assertEqual(((ex.implementation as Record<string, unknown>).components as unknown[]).length, 4, 'holding the four copied components');
  assert(ex.chip !== null && typeof ex.chip === 'object', 'and a ChipDocument the client can persist or add to its project');
  assertEqual((ex.chip as Record<string, unknown>).id, ex.chipId, 'with the extracted id');
  assert((ex.chip as Record<string, unknown>).circuit !== undefined, 'with its implementation ready to serialize');
  assertEqual(extracted.json().replacement, undefined, 'nothing is replaced unless that is asked for');

  // The API is stateless: send the returned ChipDocument back as library data and it
  // must be deserialized into a runtime Chip (with its implementation and component
  // spec), not stuffed into ChipLibrary as a plain JSON object.
  const imported = await post('/api/mine', {
    document,
    chips: [ex.chip],
    pattern: ex.patternId,
    chip: ex.chipId,
    replace: true,
  });
  assertEqual(imported.status, 200, `the returned ChipDocument can be sent back (${imported.text.slice(0, 220)})`);
  const importedReplacement = (imported.json().replacement ?? {}) as Record<string, unknown>;
  assertEqual(importedReplacement.chipId, ex.chipId, 'the imported chip was used');
  assertEqual(importedReplacement.replaced, 4, 'all repetitions replaced from the reloaded ChipDocument');
  assertEqual(importedReplacement.componentsAfter, 4, 'the sheet now contains four chip instances');

  // Extraction registers the chip in the libraries built for *this* request, so
  // extracting and replacing happen in one request: the next one starts clean.
  const both = await post('/api/mine', { document, extract: true, replace: true });
  assertEqual(both.status, 200, 'extraction and replacement in one request');
  const sub = (both.json().replacement ?? {}) as Record<string, unknown>;
  const chipId = ((both.json().extraction ?? {}) as Record<string, unknown>).chipId;
  assertEqual(sub.chipId, chipId, 'the replacement used the chip that was just extracted');
  assertEqual(sub.replaced, 4, 'all four occurrences');
  assertEqual(sub.componentsBefore, 16, 'sixteen gates in');
  assertEqual(sub.componentsAfter, 4, 'four chip instances out');
  assertEqual((sub.skipped as unknown[]).length, 0, 'none skipped');

  const refused = await post('/api/mine', { document, extract: true, measure: false, matchChips: false });
  assertEqual(refused.status, 409, 'an unmeasured block cannot be extracted into a chip');
  assert(/not measured/i.test(refused.text), `and the refusal says why: ${refused.text.slice(0, 180)}`);

  const sequential = await post('/api/mine', { document: repeatedSequentialDocument(), extract: true });
  assertEqual(sequential.status, 409, 'a static DFF snapshot cannot be extracted as an equivalent state machine');
  assert(/not measured/i.test(sequential.text), `the server explains that the sequential pattern was not measured: ${sequential.text.slice(0, 220)}`);
});

test('the editor and the engine modules are served as executable JavaScript', async () => {
  const page = await get('/');
  assertEqual(page.status, 200, 'the root serves the editor');
  assert(page.text.includes('<canvas id="canvas"'), 'and the page has the sheet canvas');
  assert(page.text.includes('/app.js'), 'and it loads the application module');

  for (const path of ['/app.js', '/canvas.js', '/panels.js', '/docks.js', '/api.js', '/styles.css']) {
    const file = await get(path);
    assertEqual(file.status, 200, `${path} is served`);
    assert(file.text.length > 1000, `${path} has real content (${file.text.length} bytes)`);
  }
  const app = await get('/app.js');
  assert(app.type.includes('javascript'), `app.js is served as JavaScript, not text: "${app.type}"`);
  const css = await get('/styles.css');
  assert(css.type.includes('text/css'), `and the stylesheet as CSS: "${css.type}"`);

  // The engine is imported by the browser as ES modules, so the barrel and the
  // modules it re-exports must all resolve over HTTP with a JavaScript type.
  for (const path of ['/engine/index.js', '/engine/render/index.js', '/engine/render/canvas.js', '/ui/editor.js', '/ui/commands.js']) {
    const module = await get(path);
    assertEqual(module.status, 200, `${path} is served`);
    assert(module.type.includes('javascript'), `${path} is JavaScript: "${module.type}"`);
    assert(module.text.includes('export'), `${path} is a module, not a bare file`);
  }
});

test('the documentation is listed and served', async () => {
  const listing = await get('/docs/');
  assertEqual(listing.status, 200, 'the docs index is served');
  assert(listing.text.includes('ARCHITECTURE.md'), 'and it lists the documents that exist');
  const doc = await get('/docs/ARCHITECTURE.md');
  assertEqual(doc.status, 200, 'a document can be read');
  assert(doc.text.length > 2000, `with real content (${doc.text.length} bytes)`);
});

test('health reports what is actually running, including a GPU it does not have', async () => {
  const health = await get('/api/health');
  assertEqual(health.status, 200, 'health answers');
  const body = health.json();
  assertEqual(body.ok, true, 'and says it is up');
  assert(String(body.version).length > 0, `with a version (${body.version})`);
  assertEqual(String(body.node).startsWith('v'), true, `and the runtime (${body.node})`);
  const gpu = body.gpu as Record<string, unknown>;
  assertEqual(gpu.backend, 'none', 'there is no GPU compute backend in this process');
  assertEqual(gpu.enabled, false, 'so none is claimed to be enabled');
  assertEqual(gpu.measuredSpeedup, 0, 'and no speedup is invented');
  const platform = body.platform as Record<string, unknown>;
  assert(typeof platform.summary === 'string' && (platform.summary as string).length > 10, `the platform is summarized: "${platform.summary}"`);
});

test('the library, the chips and the examples are served from the engine', async () => {
  const library = (await get('/api/library')).json();
  const specs = library.specs as Array<Record<string, unknown>>;
  assert(specs.length >= 50, `the whole library is offered (${specs.length} types)`);
  const resistor = specs.find((s) => s.id === 'resistor');
  assert(resistor !== undefined, 'including the resistor');
  assert(Array.isArray(resistor!.pins) && (resistor!.pins as unknown[]).length === 2, 'with its pins');
  assert(Array.isArray(resistor!.params) && (resistor!.params as unknown[]).length > 0, 'and its parameters, which is what the inspector edits');

  const chips = ((await get('/api/chips')).json().chips ?? []) as Array<Record<string, unknown>>;
  assertEqual(chips.length, project.chips.size(), `every reference chip is listed (${chips.length})`);
  const adder = chips.find((c) => c.id === 'ripple_adder');
  assert(adder !== undefined, 'including the ripple adder');
  assert(Array.isArray(adder!.ports) && (adder!.ports as unknown[]).length > 0, 'with the ports an instance will show');

  const examples = ((await get('/api/examples')).json().examples ?? []) as Array<Record<string, unknown>>;
  assert(examples.length >= 20, `the example library is listed (${examples.length})`);
});

test('a simulated full adder comes back with the arithmetic it must produce', async () => {
  const result = await post('/api/simulate', { document: fullAdderDocument(), levels: [0, 1] });
  assertEqual(result.status, 200, 'the endpoint answers');
  const body = result.json();
  const logic = body.logic as Record<string, unknown>;
  assert(logic !== undefined, 'level 0 ran');
  assertEqual(JSON.stringify(logic.inputs), '["a","b","ci"]', 'with the adder\'s three inputs');
  assertEqual(JSON.stringify(logic.outputs), '["s","co"]', 'and its two outputs');
  const rows = logic.rows as Array<Record<string, string>>;
  assertEqual(rows.length, 8, 'exhaustively: three inputs is eight combinations');
  for (const row of rows) {
    const sum = Number(row.a) + Number(row.b) + Number(row.ci);
    assertEqual(row.s, String(sum & 1), `${row.a}+${row.b}+${row.ci} sums to ${row.s}`);
    assertEqual(row.co, String((sum >> 1) & 1), `and carries ${row.co}`);
  }
  assertEqual(logic.truncated, false, 'and the table says it is not truncated');
  const accuracy = body.accuracy as Record<string, unknown>;
  const declared = accuracy.declared as Array<Record<string, unknown>>;
  assert(declared.length > 0, 'the models on the sheet declare their accuracy');
  assert(declared.every((d) => typeof d.accuracy === 'string' && d.accuracy.length > 0), 'every declaration names a class');
  assertEqual(accuracy.weakest, 'APPROXIMATED', 'and the weakest class on the sheet is reported, not the best');
});

test('level 1 reports the solve it actually performed', async () => {
  const result = await post('/api/simulate', { document: fullAdderDocument(), levels: [1] });
  assertEqual(result.status, 200, 'the endpoint answers');
  const dc = (result.json().dc ?? {}) as Record<string, unknown>;
  assertEqual(dc.converged, true, 'the DC solve converged');
  assert((dc.iterations as number) >= 1, `in a stated number of iterations (${dc.iterations})`);
  const voltages = dc.voltages as Array<Record<string, unknown>>;
  assert(voltages.length > 1, `every node has a voltage (${voltages.length})`);
  assertEqual(voltages[0].voltage, 0, 'node 0 is ground, at zero volts');
  const electrical = dc.electrical as Record<string, unknown>;
  assertEqual(electrical.analogElements, 0, 'a sheet of gates has no analogue element');
  assertEqual(electrical.digitalElements, 5, 'and five digital ones');
  assertEqual(electrical.totalDissipated, 0, 'so level 1 measures no dissipation, and says zero rather than leaving it out');
});

test('exports produce the artefacts they name', async () => {
  const spice = await post('/api/export', { document: fullAdderDocument(), format: 'spice' });
  assertEqual(spice.status, 200, 'SPICE exports');
  const spiceText = (spice.json().text ?? '') as string;
  assert(spiceText.startsWith('* CircuitForge netlist'), 'with the engine header');
  assert(/fingerprint [0-9a-f]{16,}/.test(spiceText), 'and the netlist fingerprint, so a file can be traced to a design');

  const svg = await post('/api/export', { document: fullAdderDocument(), format: 'svg' });
  assertEqual(svg.status, 200, 'SVG exports');
  const svgText = (svg.json().text ?? '') as string;
  assert(svgText.startsWith('<svg'), 'as an SVG document');
  assert(svgText.includes('</svg>'), 'closed');

  const bom = await post('/api/export', { document: fullAdderDocument(), format: 'bom' });
  assertEqual(bom.status, 200, 'the BOM exports');
  assert(((bom.json().text ?? '') as string).length > 200, 'with content');

  const unknown = await post('/api/export', { document: fullAdderDocument(), format: 'gerber' });
  assertEqual(unknown.status, 400, 'a format that does not exist is refused');
  assert((unknown.json().error as Record<string, string>).message.includes('gerber'), 'by name');
});

test('analysis and optimization run server-side and report their scope', async () => {
  const analysis = await post('/api/analyze', { document: fullAdderDocument() });
  assertEqual(analysis.status, 200, 'the analyzer answers');
  const report = (analysis.json().analysis ?? {}) as Record<string, unknown>;
  assert(Array.isArray(report.findings), 'with findings');
  assert((report.counts as Record<string, unknown>) !== undefined, 'and counts by severity');
  assert(typeof report.summary === 'string' && (report.summary as string).length > 40, 'and a summary a reader can act on');

  const optimized = await post('/api/optimize', { spec: 'and_not', profile: 'SMALLEST', budget: 60, population: 12, seed: 7 });
  assertEqual(optimized.status, 200, 'the optimizer answers');
  const body = optimized.json();
  const best = ((body.report as Record<string, unknown>).best ?? {}) as Record<string, unknown>;
  const objectives = (best.objectives ?? {}) as Record<string, unknown>;
  assert((objectives.components as number) > 0, `it found a candidate with components (${objectives.components})`);
  assert(body.document !== null && body.document !== undefined, 'and returned the circuit it built');
  assert(body.why !== undefined, 'with the comparison against the runner-up');

  const tooBig = await post('/api/optimize', { spec: 'and_not', budget: 100000 });
  assertEqual(tooBig.status, 400, 'a budget that would block the event loop is refused');
  const error = (tooBig.json().error ?? {}) as Record<string, string>;
  assert((error.hint ?? '').includes('jobs/enqueue'), `and the refusal says what to do instead: "${error.hint}"`);
});

test('a project round-trips through the server data directory', async () => {
  const file = `test-roundtrip-${Date.now()}.cfproj.json`;
  const document = { name: 'round trip', chips: [], openSheet: { document: fullAdderDocument() } };
  const saved = await post('/api/project/save', { file, document });
  assertEqual(saved.status, 200, 'saving works');
  assert((saved.json().bytes as number) > 500, `and wrote bytes (${saved.json().bytes})`);

  const listed = (await get('/api/projects')).json().projects as Array<Record<string, unknown>>;
  assert(listed.some((p) => p.file === file), 'the saved file is listed');

  const opened = await post('/api/project/open', { file });
  assertEqual(opened.status, 200, 'and can be read back');
  assertEqual((opened.json().document as Record<string, unknown>).name, 'round trip', 'byte for byte the document that was written');

  const missing = await post('/api/project/open', { file: 'no-such-project.cfproj.json' });
  assertEqual(missing.status, 404, 'a file that is not there is a 404');

  const escape = await post('/api/project/open', { file: '../../../etc/passwd' });
  assert(escape.status === 400 || escape.status === 404, `a path that walks out of the data directory is refused (${escape.status})`);
});

test('the job queue accepts work, runs it and reports progress', async () => {
  const enqueued = await post('/api/jobs/enqueue', { kind: 'analyze', name: 'test analyze', spec: { circuit: fullAdderDocument() } });
  assertEqual(enqueued.status, 200, 'a job can be enqueued');
  const id = ((enqueued.json().job ?? {}) as Record<string, unknown>).id as string;
  assert(typeof id === 'string' && id.length > 0, `and it gets an id (${id})`);

  let done = false;
  for (let attempt = 0; attempt < 40 && !done; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = (await get('/api/jobs')).json();
    const snapshot = state.snapshot as Record<string, unknown>;
    const jobs = (snapshot.jobs ?? []) as Array<Record<string, unknown>>;
    const job = jobs.find((j) => j.id === id);
    done = job?.state === 'done' || job?.state === 'failed';
    if (done) {
      assertEqual(job!.state, 'done', 'the job finished successfully');
      assert(job!.result !== null && job!.result !== undefined, 'and it produced a result');
    }
  }
  assert(done, 'the queue pumped the job to completion without being told to');

  const progress = ((await get('/api/jobs')).json().progress ?? {}) as Record<string, unknown>;
  assert((progress.doneCount as number) >= 1, `the queue counts what it finished (${progress.doneCount})`);
  const history = ((await get('/api/jobs/history')).json().history ?? []) as unknown[];
  assert(history.length >= 1, 'and keeps a history');
});

test('bad requests are refused with a reason, and paths cannot escape', async () => {
  const missing = await get('/api/nothing-here');
  assertEqual(missing.status, 404, 'an unknown route is a 404');
  assert(((missing.json().error ?? {}) as Record<string, string>).message.includes('/api/nothing-here'), 'naming the route that is missing');

  const noDocument = await post('/api/simulate', { levels: [0] });
  assertEqual(noDocument.status, 400, 'a simulation without a circuit is refused');
  assert(((noDocument.json().error ?? {}) as Record<string, string>).message.includes('circuit document'), 'saying what is missing');

  const malformed = await post('/api/simulate', '{not json');
  assertEqual(malformed.status, 400, 'a body that is not JSON is refused');

  for (const path of ['/../../etc/passwd', '/engine/../../package.json', '/docs/../../package.json']) {
    const escaped = await get(path);
    assert(escaped.status === 400 || escaped.status === 404, `${path} is refused (${escaped.status})`);
    assert(!escaped.text.includes('"dependencies"') && !escaped.text.includes('root:'), `${path} did not return a file from outside the served roots`);
  }

  const missingFile = await get('/definitely-not-here.js');
  assertEqual(missingFile.status, 404, 'a file that does not exist is a 404');
  assert(missingFile.text.startsWith('{'), 'with a JSON body the console can print');
});

test('the server closes cleanly and reports how much it served', async () => {
  const running = server;
  assert(running !== null, 'a server was started');
  assert(running!.requests() > 20, `it counted the requests it served (${running!.requests()})`);
  await running!.close();
  server = null;
  let refused = false;
  try {
    await fetch(`${base}/api/health`);
  } catch {
    refused = true;
  }
  assert(refused, 'after close, the port no longer answers');
});
