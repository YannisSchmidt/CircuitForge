#!/usr/bin/env node
/**
 * CircuitForge — command-line entry point.
 *
 * One program, three ways in:
 *
 *   circuitforge start                  build if needed, then serve the GUI
 *   circuitforge simulate --file x.json solve a design and report what it does
 *   circuitforge optimize --spec adder  search for a design meeting a spec
 *
 * `start` is the whole promise of the project in one command: if `dist/` is not
 * there it is built first (installing the two dev dependencies if the sandbox or a
 * fresh clone has no `node_modules`), so a person who just cloned this repository
 * types one thing and gets a running laboratory. Nothing here is a wrapper around a
 * missing feature — every command below does the work in the engine and prints what
 * the engine measured.
 *
 * Two rules shaped this file:
 *
 * - A number printed by the CLI came from a solve, a measurement or a count. Where
 *   the engine could not produce one, the CLI prints `n/a` and the reason, rather
 *   than a plausible-looking zero.
 * - Every command accepts `--json`, because a laboratory that cannot be scripted is
 *   a demo. The JSON is the same data the text renderer shows, not a subset of it.
 *
 * This file is plain JavaScript on purpose: it is the thing that runs before the
 * TypeScript has been compiled, so it cannot depend on the compiler having run.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const ENGINE_ENTRY = path.join(DIST, 'engine', 'index.js');
const SERVER_ENTRY = path.join(DIST, 'server', 'index.js');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------------------
// Getting the engine loaded
// ---------------------------------------------------------------------------

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function warn(line) {
  process.stderr.write(`${line}\n`);
}

/** Print an error the way a tool should: what failed, then what to do about it. */
function fail(message, hint) {
  warn(`circuitforge: ${message}`);
  if (hint) warn(`            ${hint}`);
  process.exit(1);
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.error) fail(`could not run ${command}: ${res.error.message}`);
  return res.status ?? 1;
}

/**
 * Make sure `dist/` exists, building it if it does not.
 *
 * The build is attempted rather than demanded: a published package ships `dist/`
 * and has no TypeScript installed, and in that case the check simply passes. Only
 * when the compiled engine is missing *and* the sources are present does this
 * install and compile, which is what makes `npm start` work on a fresh clone.
 */
function ensureBuild({ quiet = false } = {}) {
  if (fs.existsSync(ENGINE_ENTRY)) return;
  if (!fs.existsSync(path.join(ROOT, 'src', 'engine'))) {
    fail(
      'the compiled engine is missing and so are the sources',
      'reinstall the package, or run `npm run build` in a checkout that has src/',
    );
  }
  if (!quiet) say('dist/ not found — building CircuitForge (once per checkout)…');
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    if (!fs.existsSync(path.join(ROOT, 'package.json'))) fail('no package.json — cannot install the build dependencies');
    if (!quiet) say('  installing build dependencies (typescript, @types/node)…');
    const status = run(process.env.npm_execpath ?? 'npm', ['install', '--no-audit', '--no-fund'], { stdio: quiet ? 'ignore' : 'inherit' });
    if (status !== 0) fail('npm install failed', 'install Node.js >= 20 and TypeScript 5.6+, then run `npm run build`');
  }
  if (!fs.existsSync(tsc)) fail('typescript is not installed', 'run `npm install` then `npm run build`');
  const t0 = Date.now();
  const status = run(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: quiet ? 'ignore' : 'inherit' });
  if (status !== 0) fail('the build reported errors', 'fix them, or run `npm run check` to see them without emitting');
  if (!fs.existsSync(ENGINE_ENTRY)) fail('the build produced no engine entry point', `expected ${ENGINE_ENTRY}`);
  if (!quiet) say(`  built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function loadEngine() {
  ensureBuild();
  try {
    return await import(pathToFileURL(ENGINE_ENTRY).href);
  } catch (err) {
    fail(`the engine could not be loaded: ${err instanceof Error ? err.message : String(err)}`, 'run `npm run build` to rebuild dist/ from src/');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Parse `--flag value`, `--flag=value`, `--flag` (boolean) and positionals.
 *
 * A repeated flag accumulates into an array, which is what `--param bits=4
 * --param profile=fast` and `--probe in --probe out` need. `--` stops flag parsing,
 * so a file named `--odd.json` can still be passed.
 */
function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  const put = (name, value) => {
    const existing = flags[name];
    if (existing === undefined) flags[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else flags[name] = [existing, value];
  };
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositional || !a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      onlyPositional = true;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      put(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      put(name, true);
    } else {
      put(name, next);
      i++;
    }
  }
  return { flags, positional };
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (flags, name, fallback = undefined) => {
  const v = flags[name];
  return typeof v === 'string' ? v : fallback;
};
const bool = (flags, name) => {
  const v = flags[name];
  return v === true || v === 'true' || v === '1' || v === 'yes';
};
/**
 * A number from a flag, with unit suffixes accepted.
 *
 * `--tstop 5ms` and `--tstop 0.005` mean the same thing, and making a person write
 * scientific notation for a time constant is how unit mistakes get into a session.
 */
function num(flags, name, fallback = undefined) {
  const raw = str(flags, name);
  if (raw === undefined) return fallback;
  return parseQuantity(raw, name);
}

const PREFIXES = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, meg: 1e6, g: 1e9, t: 1e12 };

function parseQuantity(raw, what) {
  const text = String(raw).trim().replace(/_/g, '');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Zµ%]*)$/.exec(text);
  if (!m) fail(`--${what}: "${raw}" is not a number`, 'examples: 4.7, 1e-6, 100n, 4.7k, 5ms');
  let value = Number(m[1]);
  const unit = m[2];
  if (unit) {
    const seconds = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
    if (seconds[unit.toLowerCase()]) value *= 1;
    else if (unit.endsWith('s') && PREFIXES[unit.slice(0, -1)] !== undefined) value *= PREFIXES[unit.slice(0, -1)];
    else if (PREFIXES[unit] !== undefined) value *= PREFIXES[unit];
    else if (unit === '%') value /= 100;
    else if (unit.toLowerCase() === 'hz') value *= 1;
    else if (unit.toLowerCase() === 'v' || unit.toLowerCase() === 'a' || unit.toLowerCase() === 'w') value *= 1;
    else fail(`--${what}: unknown unit "${unit}" in "${raw}"`, 'use a plain number, or a metric prefix (p n u m k meg) optionally followed by s');
  }
  if (!Number.isFinite(value)) fail(`--${what}: "${raw}" did not parse to a finite number`);
  return value;
}

/** `--param bits=4 --param name=adder` → `{ bits: 4, name: 'adder' }`. */
function parseParams(flags) {
  const out = {};
  for (const entry of asArray(flags.param ?? flags.params)) {
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq <= 0) fail(`--param "${text}" is not name=value`);
    const name = text.slice(0, eq).trim();
    const raw = text.slice(eq + 1).trim();
    const asNumber = Number(raw);
    out[name] = raw !== '' && Number.isFinite(asNumber) ? asNumber : raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small output helpers
// ---------------------------------------------------------------------------

/** Write to `--out` when given, otherwise to stdout. Directories are created. */
function emit(text, flags, label = 'output') {
  const target = str(flags, 'out');
  if (!target) {
    say(text.replace(/\n$/, ''));
    return;
  }
  const abs = path.resolve(process.cwd(), target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  if (!bool(flags, 'quiet')) say(`${label} written to ${path.relative(process.cwd(), abs) || abs}`);
}

const isJson = (flags) => bool(flags, 'json');

function emitJson(value, flags) {
  emit(`${JSON.stringify(value, jsonReplacer, 2)}\n`, flags, 'json');
}

/**
 * JSON that survives contact with the engine's data.
 *
 * Sets and Maps become arrays and objects, `undefined` becomes `null`, and a
 * circular reference (a frame pointing at its parent) becomes a marker instead of
 * throwing away the whole report.
 */
function jsonReplacer(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return [...value];
  return value;
}

/** A fixed-width text table, because aligned columns are readable and JSON is not. */
function table(rows, headers, align = []) {
  if (rows.length === 0) return headers ? `${headers.join('   ')}\n(no rows)\n` : '(no rows)\n';
  const cells = headers ? [headers.map((h) => String(h)), ...rows.map((r) => r.map((c) => (c === null || c === undefined ? 'n/a' : String(c))))] : rows.map((r) => r.map((c) => (c === null || c === undefined ? 'n/a' : String(c))));
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r) =>
    r
      .map((c, i) => {
        const text = (c ?? '').toString();
        return align[i] === 'r' ? text.padStart(widths[i]) : text.padEnd(widths[i]);
      })
      .join('   ')
      .trimEnd();
  const out = [];
  if (headers) {
    out.push(line(cells[0]));
    out.push(widths.map((w) => '-'.repeat(w)).join('   '));
  }
  for (const r of cells.slice(headers ? 1 : 0)) out.push(line(r));
  return `${out.join('\n')}\n`;
}

/** Format a number for humans: SI prefix, and `n/a` when there is nothing to show. */
function fmt(value, unit = '', digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  if (value === 0) return `0${unit ? ` ${unit}` : ''}`;
  const abs = Math.abs(value);
  const steps = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
  ];
  for (const [factor, prefix] of steps) {
    if (abs >= factor) {
      const scaled = value / factor;
      return `${scaled.toPrecision(digits).replace(/\.?0+$/, '')} ${prefix}${unit}`.trim();
    }
  }
  return `${value.toExponential(2)} ${unit}`.trim();
}

const pct = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(digits)} %`);

// ---------------------------------------------------------------------------
// Resolving "which circuit are we talking about"
// ---------------------------------------------------------------------------

/**
 * Every command that works on a design goes through here.
 *
 * The input can be a project file, one of the worked examples, a reference chip by
 * id, or the built-in demo CPU when nothing at all was given. Resolving it in one
 * place is what keeps `simulate`, `analyze`, `validate` and `export` agreeing about
 * what they were asked to look at — and about which chip library the design needs,
 * which is the part that silently produces "unknown component type" when it is
 * guessed per command.
 */
async function loadSubject(cf, flags, positional) {
  const params = parseParams(flags);
  const lib = cf.createDefaultLibrary();
  const chips = new cf.ChipLibrary();
  const project = new cf.Project('circuitforge cli', lib, chips);

  const file = str(flags, 'file') ?? positional.find((p) => p.includes('/') || p.includes('\\') || /\.(json|circuitforge|cfproj)$/i.test(p));
  const exampleId = str(flags, 'example');
  const chipId = str(flags, 'chip');

  if (file) {
    const abs = path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) fail(`no such file: ${file}`, 'pass a project file saved by `circuitforge export --format project`');
    const text = fs.readFileSync(abs, 'utf8');
    const loaded = cf.loadProjectText(text, { lib, chips, name: path.basename(abs) });
    // `LoadResult.errors` and `.warnings` are *counts*; the messages live in
    // `diagnostics`. Iterating the counts used to throw on every `--file` load.
    for (const d of loaded.diagnostics ?? []) {
      const code = d.code ? ` [${d.code}]` : '';
      if (d.severity === 'error') warn(`  load error${code}: ${d.message}`);
      else if (d.severity === 'warning') warn(`  load warning${code}: ${d.message}`);
      else warn(`  load note${code}: ${d.message}`);
    }
    const chipCount = loaded.project?.chips ? loaded.project.chips.all().length : 0;
    if (loaded.errors > 0 && !loaded.project?.sheet && chipCount === 0) {
      fail(`${file} could not be loaded`, `${loaded.errors} error(s) reported above`);
    }
    const p = loaded.project;
    const circuit = pickCircuit(cf, p, chipId, params, flags);
    return { project: p, lib: p.lib ?? lib, chips: p.chips ?? chips, circuit, name: circuit.name || p.name || path.basename(abs), source: `file:${path.relative(process.cwd(), abs) || abs}` };
  }

  if (exampleId) {
    const example = cf.exampleById(exampleId);
    if (!example) fail(`no example called "${exampleId}"`, `try: ${cf.exampleIds().join(', ')}`);
    // The example installs the reference chips it needs into the library it is
    // given, which is why the same `chips` object is used for the build and for
    // every later flatten.
    const circuit = example.build(lib, chips);
    return { project, lib, chips, circuit, name: example.name, source: `example:${example.id}`, example };
  }

  if (chipId || bool(flags, 'demo') || (!flags.spec && positional.length === 0 && bool(flags, 'default'))) {
    const id = chipId ?? 'cpu8';
    const reference = cf.buildReferenceProject('circuitforge cli reference');
    const chip = reference.chips.get(id);
    if (!chip) fail(`no reference chip called "${id}"`, `try: ${reference.chips.all().map((c) => c.id).join(', ')}`);
    for (const c of reference.chips.all()) if (!chips.has(c.id)) chips.add(c);
    const circuit = chip.implementation(params);
    return { project, lib, chips, circuit, name: `${chip.name} v${chip.version}`, source: `chip:${id}`, chip };
  }

  // Nothing given: the demo CPU is the most complete design in the box, and saying
  // so out loud is better than either failing or quietly picking something small.
  if (!bool(flags, 'quiet')) say('no input given — using the built-in 8-bit demo CPU (`--file`, `--example` or `--chip` to choose another)');
  return loadSubject(cf, { ...flags, chip: 'cpu8' }, []);
}

/** Which circuit of a loaded project a command should work on. */
function pickCircuit(cf, project, chipId, params, flags) {
  if (chipId) {
    const chip = project.chips.get(chipId);
    if (!chip) fail(`the project has no chip called "${chipId}"`, `it has: ${project.chips.all().map((c) => c.id).join(', ') || '(none)'}`);
    return chip.implementation(params);
  }
  if (project.activeChip) {
    const chip = project.chips.get(project.activeChip);
    if (chip) return chip.implementation(params);
  }
  if (project.sheet) return project.sheet;
  const all = project.chips.all();
  if (all.length === 1) return all[0].implementation(params);
  if (all.length > 1) {
    fail(
      'the project has no sheet and several chips — say which one',
      `--chip <id>, one of: ${all.map((c) => c.id).join(', ')}`,
    );
  }
  void cf;
  void flags;
  fail('the project contains neither a sheet nor a chip', 'nothing to simulate');
  return null;
}

/**
 * What the numbers just printed are worth, per model.
 *
 * Assembled from the model cards of the parts that were actually instantiated, not
 * from one global label. Two things are kept apart, because conflating them is how a
 * tool ends up either over-claiming or uselessly pessimistic:
 *
 * - the model's **declared class** (`spec.accuracy`) — the headline for that part;
 * - the class of each **phenomenon** the card claims — so "NOT_MODELED" is attached
 *   to the phenomenon it refers to (aging, drift, noise) instead of smearing the
 *   whole device. A resistor whose static I-V is exact to machine precision and
 *   whose long-term drift is not modelled at all is APPROXIMATED with one declared
 *   gap, and that is what gets printed.
 */
function accuracyOfWhatWasSolved(cf, lib, nl) {
  void cf;
  const counts = new Map();
  for (const inst of nl.instances) counts.set(inst.specId, (counts.get(inst.specId) ?? 0) + 1);
  const order = ['REALISTIC', 'APPROXIMATED', 'IDEALIZED', 'NOT_MODELED'];
  const models = [];
  const notModeled = [];
  let weakest = 'REALISTIC';
  for (const [id, count] of [...counts.entries()].sort()) {
    const spec = lib.get(id);
    if (!spec) {
      notModeled.push({ model: id, phenomenon: 'everything', detail: 'no model in the library, so nothing about it was computed' });
      weakest = 'NOT_MODELED';
      continue;
    }
    const declared = String(spec.accuracy ?? 'NOT_MODELED');
    if (order.indexOf(declared) > order.indexOf(weakest)) weakest = declared;
    const claims = spec.model?.claims ?? [];
    for (const c of claims) {
      if (String(c.level) === 'NOT_MODELED') notModeled.push({ model: id, phenomenon: c.phenomenon, detail: c.detail });
    }
    if (!spec.support?.electrical && !spec.support?.logic) {
      notModeled.push({ model: id, phenomenon: 'electrical and logic behaviour', detail: 'the spec declares neither an electrical nor a logic model' });
    }
    models.push({
      id,
      count,
      accuracy: declared,
      family: spec.model?.family ?? '(no model card)',
      version: spec.model?.version ?? '?',
      claims: claims.map((c) => ({ phenomenon: c.phenomenon, level: String(c.level), detail: c.detail, validity: c.validity ?? null })),
      limitations: spec.model?.limitations ?? ['the model card declares no limitations, which is itself a claim worth checking'],
    });
  }
  return { weakest, models, notModeled };
}

/** Flatten a subject the way every command needs it, with the options made explicit. */
function flattenSubject(cf, subject, flags) {
  const thermal = bool(flags, 'thermal');
  const ambient = num(flags, 'ambient', 27);
  const nl = cf.flatten(subject.circuit, subject.lib, subject.chips, {
    metadata: true,
    thermal,
    ambient,
    expandGates: str(flags, 'gate-style') !== 'ideal' || bool(flags, 'expand-gates'),
  });
  // Gate expansion is a two-condition feature and the second condition lives on the
  // gate, not on the command line: say so whenever the engine reports it.
  for (const d of nl.diagnostics) {
    if (d.code === 'CF6012' || d.code === 'CF6013') warn(`  ${d.code} ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
  }
  const errors = nl.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0 && !bool(flags, 'force')) {
    for (const d of errors.slice(0, 12)) warn(`  ${d.code} ${d.message}`);
    if (errors.length > 12) warn(`  … and ${errors.length - 12} more`);
    fail('the netlist has errors, so any number printed next would be fiction', 'fix them, or pass --force to proceed anyway');
  }
  return nl;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS = {
  help: { summary: 'show this help', fn: cmdHelp },
  version: { summary: 'print the engine, format and schema versions', fn: cmdVersion },
  about: { summary: 'what this program is, and what it does and does not model', fn: cmdAbout },
  doctor: { summary: 'check the installation and run the known-answer self-tests', fn: cmdDoctor },
  list: { summary: 'list components, chips, examples, specs or instruments', fn: cmdList },
  examples: { summary: 'show the worked examples, verify them, or write them to disk', fn: cmdExamples },
  simulate: { summary: 'solve a design: DC operating point, transient, thermal', fn: cmdSimulate },
  analyze: { summary: 'critical path, unused parts, loops, slow/hot/power zones', fn: cmdAnalyze },
  mine: { summary: 'find repeated subcircuits, match them to chips, offer replacement', fn: cmdMine },
  validate: { summary: 'run the validation gate on a circuit or a chip', fn: cmdValidate },
  optimize: { summary: 'search for a design meeting a behavioural spec', fn: cmdOptimize },
  synth: { summary: 'spec → search → detail → validate → chip (auto design)', fn: cmdSynth },
  export: { summary: 'schematic, BOM, SPICE netlist, project file, waveform CSV', fn: cmdExport },
  benchmark: { summary: 'measure the engine itself: solver, logic, scaling, memory', fn: cmdBenchmark },
  jobs: { summary: 'inspect the persisted job queue and its checkpoints', fn: cmdJobs },
  serve: { summary: 'start the HTTP server and the graphical laboratory', fn: cmdServe },
  start: { summary: 'the one-command launch: build if needed, then serve', fn: cmdServe },
};

function cmdHelp(cf, flags, positional) {
  const name = 'circuitforge';
  const out = [];
  out.push(`CircuitForge ${cf ? cf.VERSION : ''} — electronic circuit design, simulation, synthesis and optimization`);
  out.push('');
  out.push('USAGE');
  out.push(`  ${name} <command> [options]`);
  out.push('');
  out.push('COMMANDS');
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [cmd, spec] of Object.entries(COMMANDS)) out.push(`  ${cmd.padEnd(width)}   ${spec.summary}`);
  out.push('');
  out.push('CHOOSING WHAT TO WORK ON (simulate, analyze, validate, export)');
  out.push('  --file PATH            a project file (.json) saved by this program');
  out.push('  --example ID           one of the worked examples (`circuitforge list --what examples`)');
  out.push('  --chip ID              a reference chip, e.g. cpu8, alu_n, ripple_adder');
  out.push('  --param name=value     a chip parameter, repeatable (e.g. --param bits=8)');
  out.push('  (no input)             the built-in 8-bit demo CPU');
  out.push('');
  out.push('SIMULATION');
  out.push('  --transient TSTOP      run a transient for TSTOP (5ms, 1e-3, 200u)');
  out.push('  --probe TARGET         a net, a ref (R1) or an element path; repeatable');
  out.push('  --measure voltage|current|power|temp|logic   what the probes record (voltage)');
  out.push('  --samples N            points in the record (20000)');
  out.push('  --thermal              build the thermal network and report temperatures');
  out.push('  --ambient C            ambient temperature for the thermal solve (27)');
  out.push('  --gate-style STYLE     cmos_static | ideal — the `style` parameter gates are built with');
  out.push('  --expand-gates         let flattening expand gates into CMOS transistor networks;');
  out.push('                         a gate expands only if its own style is not ideal, and the');
  out.push('                         netlist says so (CF6012 expanded, CF6013 nothing expanded)');
  out.push('');
  out.push('SYNTHESIS AND OPTIMIZATION');
  out.push('  --spec ID              a behavioural spec (`circuitforge list --what specs`)');
  out.push('  --profile NAME         FASTEST | SMALLEST | LOW_POWER | LOW_TEMPERATURE | MOST_STABLE | BALANCED');
  out.push('  --budget N             candidate evaluations to spend (2000)');
  out.push('  --population N         NSGA-II population size (48)');
  out.push('  --seed N               make the search reproducible');
  out.push('  --why                  explain the winner against the runner-up, from measured deltas');
  out.push('  --save-as ID           validate the winner and save it as a chip in a project file');
  out.push('');
  out.push('OUTPUT');
  out.push('  --json                 structured output instead of text');
  out.push('  --out PATH             write to a file instead of stdout');
  out.push('  --format FMT           export format (`circuitforge export --list-formats`)');
  out.push('  --verbose              include the long form of a report');
  out.push('');
  out.push('SERVER');
  out.push('  --port N               port for `serve` (8080)');
  out.push('');
  out.push('  Flags for `mine`:');
  out.push('  --min N                report a pattern only from N occurrences (2)');
  out.push('  --depth N              fan-in cone depth that defines a pattern (3)');
  out.push('  --max-inputs N         widest cone to consider, in external inputs (5)');
  out.push('  --max N                cap on patterns reported, best first (24)');
  out.push('  --pattern ID           which pattern to act on with --replace');
  out.push('  --replace              replace identical matches with the chip they matched');
  out.push('  --chip ID              chip to instantiate instead of the matched one');
  out.push('  --limit N              replace at most N occurrences');
  out.push('  --host ADDR            bind address (0.0.0.0)');
  out.push('  --no-open              do not try to open a browser');
  out.push('');
  out.push('EXAMPLES');
  out.push(`  ${name} start`);
  out.push(`  ${name} doctor`);
  out.push(`  ${name} simulate --example voltage_divider`);
  out.push(`  ${name} simulate --example rc_lowpass --transient 60ms --probe in --probe out`);
  out.push(`  ${name} analyze --chip cpu8 --verbose`);
  out.push(`  ${name} optimize --spec adder --param bits=4 --profile FASTEST --budget 3000 --why`);
  out.push(`  ${name} synth --spec xor --save-as my_xor --out designs/xor.json`);
  out.push(`  ${name} export --chip cpu8 --format bom --out cpu8-bom.csv`);
  out.push(`  ${name} examples --check`);
  out.push(`  ${name} benchmark --suite quick`);
  say(out.join('\n'));
  return 0;
}

function cmdVersion(cf) {
  say(`CircuitForge ${cf.VERSION}`);
  say(`  engine        ${cf.ENGINE_VERSION}`);
  // The format ids are strings ("circuitforge.circuit") and the schema version is
  // separate: a file carries both, and a loader rejects what it cannot parse.
  say(`  circuit file  ${cf.CIRCUIT_FORMAT} · schema ${cf.SCHEMA_VERSION}`);
  say(`  project file  ${cf.PROJECT_FORMAT} · schema ${cf.SCHEMA_VERSION}`);
  const models = cf.MODEL_VERSIONS ?? {};
  for (const [k, v] of Object.entries(models)) say(`  model ${k.padEnd(9)} ${v}`);
  say(`  node          ${process.version} (${process.platform}/${process.arch})`);
  return 0;
}

function cmdAbout(cf) {
  const info = cf.about();
  const lib = cf.createDefaultLibrary();
  const specs = lib.all();
  const reference = cf.buildReferenceProject('about');
  const out = [];
  out.push('CIRCUITFORGE');
  out.push(`version ${info.version} · ${info.platform}`);
  out.push('');
  out.push('WHAT IT IS');
  out.push('  A circuit laboratory: a component library, a hierarchical circuit model, four');
  out.push('  simulation levels, a synthesis and optimization engine, a validation gate, an');
  out.push('  analyzer, exporters and instruments. It runs headless from this CLI and as a');
  out.push('  graphical editor served by `circuitforge start`.');
  out.push('');
  out.push('SIMULATION LEVELS');
  for (const level of info.simulationLevels) out.push(`  ${level}`);
  out.push('');
  out.push('ACCURACY CLASSES (declared per model, never inferred from a good-looking number)');
  for (const a of info.accuracyClasses) out.push(`  ${a}`);
  out.push('');
  out.push('IN THE BOX');
  out.push(`  ${specs.length} component models in ${new Set(specs.map((s) => s.category)).size} categories`);
  out.push(`  ${reference.chips.all().length} reference chips (${reference.chips.all().map((c) => c.id).join(', ')})`);
  out.push(`  ${cf.exampleIds().length} worked examples with self-checked expectations`);
  out.push(`  ${cf.specIds().length} behavioural specs for synthesis`);
  out.push('');
  out.push('HOW IT REPORTS');
  out.push('  A number is printed only when something measured it. Where a model approximates,');
  out.push('  the result carries its accuracy class and the approximation is stated; where a');
  out.push('  quantity was not measured, the field is null and the text says why.');
  out.push('  Optimization results are claimed as "BEST FOUND UNDER CURRENT CONSTRAINTS" with');
  out.push('  the constraints, the search space, the method, the candidate count and the');
  out.push('  simulation level attached — never as "optimal", which is not a statement anybody');
  out.push('  can check.');
  say(out.join('\n'));
  return 0;
}

/**
 * Installation and known-answer self-test.
 *
 * The point of `doctor` is not "does it run" but "does it still compute the things
 * whose answers are known independently". A solver that converges to a wrong number
 * passes every smoke test and fails here, which is why the divider, the RC filter
 * and the transient window are checked against closed forms rather than against
 * each other.
 */
async function cmdDoctor(cf, flags) {
  const checks = [];
  const trace = bool(flags, 'verbose') || !!process.env.CIRCUITFORGE_DEBUG;
  const check = (name, fn) => {
    if (trace) warn(`  … ${name}`);
    const t0 = Date.now();
    try {
      const detail = fn();
      checks.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0 });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
    }
    if (trace) warn(`    ${checks[checks.length - 1].ok ? 'ok' : 'FAIL'} in ${Date.now() - t0} ms`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  check('node.js >= 20', () => {
    if (!(major >= 20)) throw new Error(`found ${process.version}`);
    return process.version;
  });
  check('compiled engine present', () => (fs.existsSync(ENGINE_ENTRY) ? path.relative(ROOT, ENGINE_ENTRY) : (() => { throw new Error('dist/engine/index.js missing — run `npm run build`'); })()));
  check('public assets present', () => {
    if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) throw new Error('public/index.html missing — the GUI cannot be served');
    return `${fs.readdirSync(PUBLIC_DIR).length} file(s) in public/`;
  });
  check('workspace writable', () => {
    const dir = path.join(ROOT, '.circuitforge-cache');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `doctor-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return dir;
  });

  const lib = cf.createDefaultLibrary();
  check('component library loads', () => {
    const specs = lib.all();
    if (specs.length < 20) throw new Error(`only ${specs.length} models`);
    const missing = specs.filter((s) => !s.model || !s.accuracy);
    if (missing.length) throw new Error(`${missing.length} model(s) without a model card or accuracy class`);
    return `${specs.length} models, every one with a model card and an accuracy class`;
  });

  let chips = null;
  check('reference chip library builds', () => {
    const t0 = Date.now();
    const project = cf.buildReferenceProject('doctor');
    chips = project.chips;
    const n = project.chips.all().length;
    if (n < 15) throw new Error(`only ${n} chips`);
    return `${n} chips in ${Date.now() - t0} ms`;
  });

  // Known answer 1: a resistive divider. 12 V over 1 kΩ and 2 kΩ puts the midpoint
  // at exactly 8 V, and the pair burns exactly 48 mW.
  check('DC solve: divider = 8 V, 48 mW', () => {
    const example = cf.exampleById('voltage_divider');
    const nl = cf.flatten(example.build(lib, new cf.ChipLibrary()), lib, undefined, { metadata: true });
    const sim = new cf.CircuitSimulator(nl);
    sim.dcSolve({ quiet: true });
    const stats = cf.circuitStats(nl, { lib, sim });
    const dissipated = stats.stats.electrical.totalDissipated;
    let mid = null;
    for (let n = 1; n < nl.nodeCount; n++) if (cf.nodeNameAt(nl, n) === 'mid') mid = sim.v[n];
    if (mid === null) throw new Error('no node called "mid"');
    if (Math.abs(mid - 8) > 1e-6) throw new Error(`midpoint ${mid} V, expected 8 V`);
    if (dissipated === null || Math.abs(dissipated - 0.048) > 1e-9) throw new Error(`dissipation ${dissipated} W, expected 0.048 W`);
    return `${mid.toFixed(9)} V, ${dissipated.toExponential(4)} W`;
  });

  // Known answer 2: a first-order filter at 1 kHz. |H| = 0.8467 and the phase lags
  // by atan(ωRC) = 32.14°. Both come from the same transfer function, so a solver
  // that got either one wrong is not accidentally right about the other.
  check('transient + FFT: RC filter amplitude and phase', () => {
    const example = cf.exampleById('rc_lowpass');
    const nl = cf.flatten(example.build(lib, new cf.ChipLibrary()), lib, undefined, { metadata: true });
    const scope = new cf.Oscilloscope(new cf.CircuitSimulator(nl, { integration: 'trap' }));
    scope.addChannel({ measure: 'voltage', target: 'in' });
    scope.addChannel({ measure: 'voltage', target: 'out' });
    scope.run({ tstop: 0.06, maxSamples: 20000 });
    const amp = scope.stats(1)?.peakToPeak / 2;
    const phase = scope.phase(0, 1)?.degrees;
    const freq = scope.frequency(1)?.frequency;
    if (amp === undefined || Math.abs(amp - 0.8467) > 0.02) throw new Error(`amplitude ${amp}, expected 0.8467 ± 0.02`);
    if (phase === undefined || Math.abs(phase + 32.14) > 1.0) throw new Error(`phase ${phase}°, expected −32.14° ± 1°`);
    if (freq === undefined || Math.abs(freq - 1000) > 10) throw new Error(`frequency ${freq} Hz, expected 1000 ± 10 Hz`);
    return `|H| ${amp.toFixed(4)}, ${phase.toFixed(2)}°, ${freq.toFixed(1)} Hz`;
  });

  // Known answer 3: the record must cover the window that was asked for. A
  // transient that silently stops early is worse than one that fails, because every
  // measurement taken over it looks reasonable.
  check('transient record covers the requested window', () => {
    const example = cf.exampleById('rc_charge');
    const nl = cf.flatten(example.build(lib, new cf.ChipLibrary()), lib, undefined, { metadata: true });
    const sim = new cf.CircuitSimulator(nl, { integration: 'trap', skipInitialDc: true });
    const res = sim.transient(5e-3, [{ key: 't', kind: 'time', index: -1 }], { maxSamples: 4000 });
    const covered = res.times[res.times.length - 1];
    if (res.truncatedAt !== null && res.truncatedAt !== undefined) throw new Error(`record truncated at ${res.truncatedAt}`);
    if (!(covered >= 5e-3 - 1e-9)) throw new Error(`record ends at ${covered}, asked for 5e-3`);
    return `${res.times.length} samples to ${covered * 1000} ms, ${res.steps} steps, ${res.rejected} rejected`;
  });

  check('logic level 0: a full adder is a full adder', () => {
    const chip = chips?.get('full_adder');
    if (!chip) throw new Error('the reference library has no full_adder');
    const circuit = chip.implementation({});
    const nl = cf.flatten(circuit, lib, chips, { metadata: true });
    const graph = cf.buildLogicGraph(nl);
    if (graph.loopElements.length) throw new Error(`${graph.loopElements.length} element(s) in a combinational loop`);
    // All eight input combinations at once: level 0 is bit-parallel, so vector i of
    // a driven net carries combination i. A=0xAA, B=0xCC, CIN=0xF0 is the standard
    // 3-bit Gray-free ordering, and every output is read back per vector rather than
    // assumed from a single case.
    // Net labels are matched case-insensitively and by alias: the reference adder
    // calls them a/b/ci/s/co, a hand-drawn sheet would call them A/B/CIN/SUM/COUT,
    // and a check that only accepted one spelling would pass on the wrong circuit.
    const aliases = { A: ['a', 'ina', 'x'], B: ['b', 'inb', 'y'], CIN: ['ci', 'cin', 'carryin'], SUM: ['s', 'sum', 'y'], COUT: ['co', 'cout', 'carryout'] };
    const netOf = (names) => {
      for (let n = 0; n < graph.netCount; n++) {
        const label = (graph.netName(n) ?? '').toLowerCase();
        const bare = label.includes('/') ? label.slice(label.lastIndexOf('/') + 1) : label.includes('.') ? label.slice(label.lastIndexOf('.') + 1) : label;
        if (names.includes(bare)) return n;
      }
      return -1;
    };
    const keys = ['A', 'B', 'CIN', 'SUM', 'COUT'];
    const wanted = keys.map((k) => netOf(aliases[k]));
    const missing = keys.filter((_, i) => wanted[i] < 0);
    if (missing.length) throw new Error(`no net called ${missing.join(', ')} in the flattened adder`);
    const [a, b, cin, sum, cout] = wanted;
    const sim = new cf.LogicVectorSim(graph);
    sim.drive(a, 0xaa);
    sim.drive(b, 0xcc);
    sim.drive(cin, 0xf0);
    sim.run(1);
    sim.settle();
    let wrong = 0;
    const detail = [];
    for (let i = 0; i < 8; i++) {
      const av = (0xaa >> i) & 1;
      const bv = (0xcc >> i) & 1;
      const cv = (0xf0 >> i) & 1;
      const total = av + bv + cv;
      const gotSum = sim.sample(sum, i);
      const gotCout = sim.sample(cout, i);
      if (gotSum !== (total & 1) || gotCout !== (total > 1 ? 1 : 0)) {
        wrong++;
        detail.push(`${av}+${bv}+${cv} → ${gotSum}/${gotCout}`);
      }
    }
    if (wrong > 0) throw new Error(`${wrong} of 8 vectors wrong (${detail.join(', ')})`);
    return `8 of 8 vectors correct, ${graph.stats.gates} gates, ${graph.stats.levels} levels`;
  });

  check('hierarchy flattens: cpu8 → elements', () => {
    const chip = chips?.get('cpu8');
    if (!chip) throw new Error('the reference library has no cpu8');
    const nl = cf.flatten(chip.implementation({}), lib, chips, { metadata: true, expandGates: false });
    const errors = nl.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('; '));
    if (nl.elementCount < 100) throw new Error(`only ${nl.elementCount} elements`);
    const depth = nl.instances.reduce((m, i) => Math.max(m, i.depth ?? 0), 0);
    return `${nl.elementCount} elements, ${nl.instances.length} instance(s), depth ${depth}, fingerprint ${cf.netlistFingerprint(nl).slice(0, 12)}`;
  });

  check('serialization round-trips a project', () => {
    const project = cf.buildReferenceProject('doctor round-trip');
    const text = cf.saveProjectText(project);
    const loaded = cf.loadProjectText(text);
    if (loaded.errors?.length) throw new Error(`${loaded.errors.length} load error(s)`);
    const before = project.chips.all().map((c) => c.id).sort().join(',');
    const after = loaded.project.chips.all().map((c) => c.id).sort().join(',');
    if (before !== after) throw new Error('the chip set changed');
    return `${(text.length / 1024).toFixed(0)} KiB, ${loaded.project.chips.all().length} chips intact`;
  });

  check('optimizer finds a working 2-input gate', () => {
    const spec = cf.buildSpecById('and_not', {});
    const opt = new cf.Optimizer({
      spec, lib, chips: chips ?? new cf.ChipLibrary(), name: 'doctor', profile: 'BALANCED',
      seed: 1234, populationSize: 16, budget: { evaluations: 200, milliseconds: 20000 }, detailTop: 0,
    });
    opt.run();
    const report = opt.report();
    if (!report.best) throw new Error('no candidate satisfied the spec');
    if (report.best.violations && report.best.violations.length) throw new Error(`best candidate violates ${report.best.violations.join(', ')}`);
    return `best ${report.best.name ?? report.best.key} · ${report.searchSpace.evaluations} evaluations · seed ${report.reproducibility.seed}`;
  });

  check('profiler measures itself', () => {
    // `profiler` is the singleton; `Profiler` is its class. The probe has to appear
    // in the report with a non-zero sample count, or the percentages the profiler
    // prints for a simulation are decoration.
    cf.profiler.enable();
    cf.profiler.reset();
    const h = cf.profiler.begin('doctor.probe');
    let acc = 0;
    for (let i = 0; i < 200000; i++) acc += Math.sqrt(i);
    h.end(acc > 0 ? 'count' : undefined);
    const entry = cf.profiler.get('doctor.probe');
    if (!entry) throw new Error('the probe did not appear in the profiler report');
    if (!(entry.calls >= 1)) throw new Error(`recorded ${entry.calls ?? 0} call(s)`);
    const formatted = cf.profiler.format();
    cf.profiler.reset();
    if (!formatted.includes('doctor.probe')) throw new Error('the formatted report omits the probe');
    return `${entry.calls} call(s), ${formatted.split('\n').length - 1} line(s) of report`;
  });

  if (bool(flags, 'full')) {
    check('every worked example meets its stated expectations', async () => {
      const failures = [];
      let n = 0;
      for (const example of cf.EXAMPLES) {
        const result = await cf.checkExample(example, lib, new cf.ChipLibrary());
        n += result.cases.length;
        for (const c of result.cases) if (!c.pass) failures.push(`${example.id}/${c.quantity}: ${c.note}`);
      }
      if (failures.length) throw new Error(`${failures.length} of ${n} failed: ${failures.join('; ')}`);
      return `${n} quantities across ${cf.EXAMPLES.length} examples`;
    });
  }

  // `check` may be async; await them in order so the report is deterministic.
  for (const c of checks) {
    if (c.detail instanceof Promise) c.detail = await c.detail.catch((e) => { c.ok = false; return e instanceof Error ? e.message : String(e); });
  }

  if (isJson(flags)) {
    emitJson({ ok: checks.every((c) => c.ok), checks }, flags);
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  say('CIRCUITFORGE DOCTOR');
  say(`  ${cf.VERSION} · node ${process.version} · ${cf.platformSummary(cf.detectPlatform())}`);
  say('');
  for (const c of checks) {
    say(`  ${c.ok ? ' ok ' : 'FAIL'}  ${c.name.padEnd(52)} ${c.ok ? c.detail : ''}`.trimEnd());
    if (!c.ok) say(`        ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  say('');
  say(failed === 0 ? `  ${checks.length} checks passed${bool(flags, 'full') ? '' : ' (add --full to verify every worked example)'}` : `  ${failed} of ${checks.length} checks FAILED`);
  return failed === 0 ? 0 : 1;
}

function cmdList(cf, flags) {
  const what = (str(flags, 'what') ?? 'components').toLowerCase();
  const lib = cf.createDefaultLibrary();

  if (what === 'components' || what === 'all') {
    const specs = lib.all();
    const byCategory = new Map();
    for (const s of specs) {
      if (!byCategory.has(s.category)) byCategory.set(s.category, []);
      byCategory.get(s.category).push(s);
    }
    if (isJson(flags)) {
      emitJson({ components: specs.map((s) => ({ id: s.id, name: s.name, category: s.category, accuracy: s.accuracy, pins: s.pins.map((p) => p.name), params: s.params.map((p) => p.name), description: s.description })) }, flags);
    } else {
      say(`COMPONENT LIBRARY — ${specs.length} models`);
      for (const [category, list] of [...byCategory.entries()].sort()) {
        say('');
        say(`  ${category.toUpperCase()} (${list.length})`);
        const rows = list.sort((a, b) => a.id.localeCompare(b.id)).map((s) => [
          `    ${s.id}`,
          s.name,
          String(s.accuracy ?? '?'),
          s.pins.map((p) => p.name).join(' '),
        ]);
        say(table(rows, ['    id', 'name', 'accuracy', 'pins']).replace(/^/gm, (l) => l).trimEnd());
      }
    }
    if (what !== 'all') return 0;
  }

  if (what === 'chips' || what === 'all') {
    const project = cf.buildReferenceProject('list');
    const list = project.chips.all();
    if (isJson(flags)) {
      emitJson({ chips: list.map((c) => ({ id: c.id, name: c.name, version: c.version, description: c.def.description, ports: c.ports.map((p) => ({ name: p.name, direction: p.direction, width: p.width })), params: c.params.map((p) => p.name) })) }, flags);
    } else {
      say('');
      say(`REFERENCE CHIPS — ${list.length}`);
      const rows = list.map((c) => [`  ${c.id}`, `v${c.version}`, c.ports.map((p) => `${p.name}${p.width > 1 ? `[${p.width}]` : ''}`).join(' '), c.def.description.slice(0, 58)]);
      say(table(rows, ['  id', 'ver', 'ports', 'description']).trimEnd());
    }
    if (what !== 'all') return 0;
  }

  if (what === 'examples' || what === 'all') {
    const list = cf.EXAMPLES;
    if (isJson(flags)) {
      emitJson({ examples: list.map((e) => ({ id: e.id, name: e.name, category: e.category, level: e.level, description: e.description, demonstrates: e.demonstrates, expected: e.expected })) }, flags);
    } else {
      say('');
      say(`WORKED EXAMPLES — ${list.length}`);
      const rows = list.map((e) => [`  ${e.id}`, e.category, `L${e.level}`, e.name]);
      say(table(rows, ['  id', 'category', 'lvl', 'name']).trimEnd());
    }
    if (what !== 'all') return 0;
  }

  if (what === 'specs' || what === 'all') {
    const list = cf.SPEC_CATALOG;
    if (isJson(flags)) {
      emitJson({ specs: list.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params.map((p) => ({ name: p.name, default: p.default, min: p.min, max: p.max })) })) }, flags);
    } else {
      say('');
      say(`BEHAVIOURAL SPECS FOR SYNTHESIS — ${list.length}`);
      const rows = list.map((s) => [`  ${s.id}`, s.params.map((p) => `${p.name}=${p.default ?? '?'}`).join(' ') || '—', s.description]);
      say(table(rows, ['  id', 'params', 'description']).trimEnd());
    }
    if (what !== 'all') return 0;
  }

  if (what === 'instruments' || what === 'all') {
    const meters = cf.METER_SPEC_IDS ?? [];
    const waves = [...(cf.NATIVE_WAVEFORMS ?? []), ...(cf.SYNTHESISED_WAVEFORMS ?? [])];
    const windows = Object.keys(cf.WINDOWS ?? {});
    if (isJson(flags)) {
      emitJson({ instruments: { meters, waveforms: waves, windows, presets: (cf.GENERATOR_PRESETS ?? []).map((p) => p.id ?? p.name) } }, flags);
    } else {
      say('');
      say('INSTRUMENTS');
      say(`  meter primitives   ${meters.join(', ')}`);
      say(`  oscilloscope       multi-channel voltage / current / power / temperature / logic, zoom, cursors, CSV`);
      say(`  spectrum analyzer  windows: ${windows.join(', ')}`);
      say(`  signal generator   ${waves.join(', ')}`);
      say(`  generator presets  ${(cf.GENERATOR_PRESETS ?? []).map((p) => p.id ?? p.name).join(', ')}`);
    }
    if (what !== 'all') return 0;
  }

  if (!['components', 'chips', 'examples', 'specs', 'instruments', 'all'].includes(what)) {
    fail(`--what "${what}" is not a thing I can list`, 'try: components, chips, examples, specs, instruments, all');
  }
  return 0;
}

async function cmdExamples(cf, flags) {
  const lib = cf.createDefaultLibrary();
  const only = str(flags, 'id');
  const list = only ? [cf.exampleById(only)].filter(Boolean) : cf.EXAMPLES;
  if (only && list.length === 0) fail(`no example called "${only}"`, `try: ${cf.exampleIds().join(', ')}`);

  if (bool(flags, 'check')) {
    const results = [];
    for (const example of list) results.push(await cf.checkExample(example, lib, new cf.ChipLibrary()));
    if (isJson(flags)) {
      emitJson({ examples: results, totals: totals(results) }, flags);
    } else {
      say('EXAMPLE EXPECTATIONS — measured against closed forms written independently of the engine');
      for (const r of results) {
        say('');
        say(`  ${r.name} (${r.id}) — ${r.passed} passed, ${r.failed} failed, ${r.skipped} not measured, ${r.ms} ms`);
        const rows = r.cases.map((c) => [
          `    ${c.quantity}`,
          `${c.expected.toPrecision(5)} ${c.unit}`,
          c.measured === null ? 'not measured' : `${c.measured.toPrecision(5)} ${c.unit}`,
          `±${(c.tolerance * 100).toFixed(2)} %`,
          c.measured === null ? 'SKIP' : c.pass ? 'ok' : 'FAIL',
        ]);
        say(table(rows).trimEnd());
        for (const c of r.cases.filter((x) => !x.pass)) say(`      ${c.quantity}: ${c.note}`);
        for (const c of r.cases) if (c.source) say(`      source · ${c.quantity}: ${c.source}`);
        for (const l of r.limits) say(`      limit · ${l}`);
      }
      const t = totals(results);
      say('');
      say(`  TOTAL ${t.passed} passed, ${t.failed} failed, ${t.skipped} not measured across ${results.length} example(s)`);
      if (t.failed > 0) return 1;
    }
    return 0;
  }

  const writeDir = str(flags, 'write');
  if (writeDir) {
    const dir = path.resolve(process.cwd(), writeDir);
    fs.mkdirSync(dir, { recursive: true });
    const index = [];
    for (const example of list) {
      const chips = new cf.ChipLibrary();
      const circuit = example.build(lib, chips);
      const project = new cf.Project(example.name, lib, chips);
      project.sheet = circuit;
      const text = cf.saveProjectText(project, { circuit, notes: example.description });
      const file = path.join(dir, `${example.id}.cfproj.json`);
      fs.writeFileSync(file, text, 'utf8');
      index.push({
        id: example.id, name: example.name, category: example.category, level: example.level,
        description: example.description, demonstrates: example.demonstrates,
        file: path.basename(file), components: circuit.componentCount(),
        expected: example.expected.map((e) => ({ quantity: e.quantity, key: e.key, value: e.value, tolerance: e.tolerance, unit: e.unit, source: e.source })),
      });
      if (!bool(flags, 'quiet')) say(`  ${example.id.padEnd(20)} ${String(circuit.componentCount()).padStart(4)} components → ${path.relative(process.cwd(), file)}`);
    }
    fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify({ generatedBy: `CircuitForge ${cf.VERSION}`, engineVersion: cf.ENGINE_VERSION, examples: index }, null, 2)}\n`, 'utf8');
    if (!bool(flags, 'quiet')) say(`${list.length} example(s) written to ${path.relative(process.cwd(), dir) || dir}`);
    return 0;
  }

  if (isJson(flags)) {
    emitJson({ examples: list.map((e) => ({ id: e.id, name: e.name, category: e.category, level: e.level, description: e.description, demonstrates: e.demonstrates, expected: e.expected })) }, flags);
    return 0;
  }
  say(`WORKED EXAMPLES — ${list.length}`);
  say('  every expectation below is checked by `circuitforge examples --check`');
  for (const example of list) {
    say('');
    say(`  ${example.id} — ${example.name}  [${example.category}, level ${example.level}]`);
    say(`    ${example.description}`);
    for (const d of example.demonstrates) say(`    · ${d}`);
    if (bool(flags, 'verbose')) {
      for (const e of example.expected) say(`    expects ${e.quantity} = ${e.value} ${e.unit} ±${(e.tolerance * 100).toFixed(2)} % — ${e.source}`);
    }
  }
  return 0;
}

function totals(results) {
  return results.reduce((a, r) => ({ passed: a.passed + r.passed, failed: a.failed + r.failed, skipped: a.skipped + r.skipped, ms: a.ms + r.ms }), { passed: 0, failed: 0, skipped: 0, ms: 0 });
}

async function cmdSimulate(cf, flags, positional) {
  const subject = await loadSubject(cf, flags, positional);
  const nl = flattenSubject(cf, subject, flags);
  const gateStyle = str(flags, 'gate-style', 'cmos_static');
  const sim = new cf.CircuitSimulator(nl, {
    integration: str(flags, 'integration', 'trap'),
    ambient: num(flags, 'ambient', 27),
  });
  const dc = sim.dcSolve({ quiet: bool(flags, 'quiet') });

  const tstop = num(flags, 'transient');
  let scope = null;
  let capture = null;
  if (tstop !== undefined) {
    const probes = asArray(flags.probe);
    const measure = str(flags, 'measure', 'voltage');
    scope = new cf.Oscilloscope(sim);
    if (probes.length === 0) {
      // No probe named: record every named net, up to a sane cap, and say that the
      // choice was made here rather than pretending the user asked for it.
      const nets = [];
      for (let n = 1; n < nl.nodeCount && nets.length < 8; n++) {
        const name = cf.nodeNameAt(nl, n);
        if (name && !name.startsWith('node ')) nets.push(name);
      }
      if (nets.length === 0) fail('nothing to probe: the netlist has no named nets', 'pass --probe <net|ref> explicitly');
      if (!bool(flags, 'quiet')) say(`  no --probe given: recording ${nets.join(', ')}`);
      for (const t of nets) scope.addChannel({ measure, target: t });
    } else {
      for (const t of probes) scope.addChannel({ measure, target: t });
    }
    capture = scope.run({ tstop, maxSamples: num(flags, 'samples', 20000) });
  }

  if (bool(flags, 'thermal')) {
    sim.solveThermalSteadyState?.();
  }

  const stats = cf.circuitStats(nl, { lib: subject.lib, sim, graph: null });
  const accuracy = accuracyOfWhatWasSolved(cf, subject.lib, nl);

  if (isJson(flags)) {
    const nodes = [];
    for (let n = 1; n < nl.nodeCount; n++) nodes.push({ node: n, name: cf.nodeNameAt(nl, n), volts: sim.v[n] });
    const elements = [];
    for (const inst of nl.instances) {
      for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount; e++) {
        elements.push({
          ref: inst.ref, path: inst.path, spec: inst.specId, element: e, kind: nl.kind[e],
          current: sim.state.elementCurrent[e] ?? null, power: sim.state.elementPower[e] ?? null,
          temperature: sim.elementTemperature?.(e) ?? null,
        });
      }
    }
    emitJson({
      source: subject.source, name: subject.name,
      netlist: { components: nl.instances.length, elements: nl.elementCount, nodes: nl.nodeCount, depth: nl.instances.reduce((m, i) => Math.max(m, i.depth ?? 0), 0), fingerprint: cf.netlistFingerprint(nl) },
      dc: { converged: dc?.converged ?? null, iterations: dc?.iterations ?? null, nodes, elements },
      stats: stats.stats,
      accuracy: accuracy ?? null,
      transient: capture ? { tstop, samples: capture.samples ?? null, truncatedAt: capture.truncatedAt ?? null, notes: capture.notes ?? [], channels: scope.report({ verbose: bool(flags, 'verbose') }) } : null,
      diagnostics: nl.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    }, flags);
    return 0;
  }

  const out = [];
  out.push(`SIMULATION — ${subject.name}`);
  out.push(`  source ${subject.source} · engine ${cf.ENGINE_VERSION} · level ${bool(flags, 'thermal') ? 'L3 electro-thermal' : tstop !== undefined ? 'L1 electrical transient' : 'L1 electrical DC'}`);
  out.push('');
  out.push('NETLIST');
  out.push(`  components ${nl.instances.length} · elements ${nl.elementCount} · nodes ${nl.nodeCount} · depth ${nl.instances.reduce((m, i) => Math.max(m, i.depth ?? 0), 0)}`);
  out.push(`  fingerprint ${cf.netlistFingerprint(nl)}`);
  const diagCounts = nl.diagnostics.reduce((a, d) => ((a[d.severity] = (a[d.severity] ?? 0) + 1), a), {});
  out.push(`  diagnostics ${Object.entries(diagCounts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  out.push('');
  out.push('DC OPERATING POINT');
  out.push(`  converged ${dc?.converged ?? 'n/a'} · iterations ${dc?.iterations ?? 'n/a'} · gmin ${fmt(sim.gminUsed?.(), 'S')}`);
  const nodeRows = [];
  for (let n = 1; n < nl.nodeCount; n++) {
    const name = cf.nodeNameAt(nl, n);
    if (!bool(flags, 'all') && name.startsWith('node ') && nl.nodeCount > 24) continue;
    nodeRows.push([`  ${name}`, fmt(sim.v[n], 'V'), `#${n}`]);
  }
  out.push(table(nodeRows, ['  node', 'voltage', 'index']).trimEnd());
  out.push('');
  out.push('ELEMENTS');
  const elRows = [];
  const maxRows = bool(flags, 'all') ? Infinity : 40;
  let shown = 0;
  for (const inst of nl.instances) {
    for (let e = inst.elementStart; e < inst.elementStart + inst.elementCount && shown < maxRows; e++, shown++) {
      const temp = bool(flags, 'thermal') ? sim.elementTemperature?.(e) ?? null : null;
      elRows.push([`  ${inst.path}`, inst.specId, fmt(sim.state.elementCurrent[e] ?? null, 'A'), fmt(sim.state.elementPower[e] ?? null, 'W'), temp === null ? '—' : `${temp.toFixed(2)} °C`]);
    }
  }
  out.push(table(elRows, ['  element', 'spec', 'current', 'power', 'temperature'], ['l', 'l', 'r', 'r', 'r']).trimEnd());
  if (shown >= maxRows) out.push(`  … ${nl.elementCount - shown} more element(s); pass --all to see them`);
  out.push('');
  out.push('TOTALS');
  const el = stats.stats.electrical;
  out.push(`  dissipated ${fmt(el.totalDissipated, 'W')} · supplied ${fmt(el.totalSupplied, 'W')} · net ${fmt(el.totalPower, 'W')}`);
  out.push(`  dissipating elements ${el.dissipatingElements ?? 'n/a'} of ${el.analogElements} analog (${el.digitalElements} digital, no electrical model)`);
  if (stats.stats.thermal) {
    out.push(`  thermal nodes ${stats.stats.thermal.nodes} · max temperature ${stats.stats.thermal.maxTemperature === null ? 'n/a' : `${stats.stats.thermal.maxTemperature.toFixed(2)} °C`} · ambient ${stats.stats.thermal.ambient} °C`);
  }
  out.push(`  note: net power over every element is ~0 because a source reports negative absorbed power; it is a conservation check, not a consumption figure`);
  out.push('');
  out.push('ACCURACY OF WHAT WAS JUST COMPUTED');
  out.push(`  weakest declared class among the models used: ${accuracy.weakest}`);
  for (const row of accuracy.models) {
    out.push(`  ${row.id.padEnd(18)} ${String(row.accuracy).padEnd(13)} ${row.family} v${row.version} · ${row.count} instance(s)`);
    if (bool(flags, 'verbose')) {
      for (const c of row.claims) {
        out.push(`      ${String(c.level).padEnd(13)} ${c.phenomenon}${c.validity ? ` — valid ${c.validity}` : ''}`);
        out.push(`                    ${c.detail}`);
      }
      for (const l of row.limitations) out.push(`      limit: ${l}`);
    }
  }
  if (accuracy.notModeled.length) {
    out.push('  DECLARED GAPS — these phenomena were not computed at all:');
    for (const n of accuracy.notModeled) out.push(`      ${n.model} · ${n.phenomenon}: ${n.detail}`);
  } else {
    out.push('  no model in this design declares a phenomenon it does not compute');
  }
  if (!bool(flags, 'verbose')) out.push('  (pass --verbose for every claim, its validity range and the model limitations)');

  if (scope && capture) {
    out.push('');
    out.push(`TRANSIENT — ${fmt(tstop, 's')} stop, ${capture.samples ?? '?'} samples`);
    for (const note of capture.notes ?? []) out.push(`  note: ${note}`);
    const report = scope.report({ verbose: bool(flags, 'verbose') });
    out.push(cf.scopeReportToText(report).trimEnd());
    if (str(flags, 'format', 'text').toLowerCase() === 'csv' || str(flags, 'csv')) {
      emit(scope.toCsv(), flags, 'waveform csv');
      return 0;
    }
  }

  emit(`${out.join('\n')}\n`, flags, 'simulation');
  void gateStyle;
  return 0;
}

async function cmdAnalyze(cf, flags, positional) {
  const subject = await loadSubject(cf, flags, positional);
  const nl = flattenSubject(cf, subject, flags);
  const sim = new cf.CircuitSimulator(nl, { ambient: num(flags, 'ambient', 27) });
  let dc = null;
  try {
    dc = sim.dcSolve({ quiet: true });
  } catch (err) {
    warn(`  the DC operating point did not solve (${err instanceof Error ? err.message : String(err)}); power and temperature zones will be reported as not measured`);
  }
  const constraints = {
    maxFanout: num(flags, 'max-fanout', 16),
    ambient: num(flags, 'ambient', 27),
  };
  const report = cf.analyzeNetlist(nl, {
    lib: subject.lib,
    sim: dc ? sim : null,
    constraints,
    highFanout: num(flags, 'high-fanout', 8),
    timingModel: str(flags, 'timing-model', 'declared'),
  });
  if (isJson(flags)) {
    emitJson({ source: subject.source, name: subject.name, report }, flags);
    return 0;
  }
  const text = cf.analysisToText(report, { verbose: bool(flags, 'verbose') });
  emit(`ANALYSIS — ${subject.name} (from ${subject.source})\n\n${text}`, flags, 'analysis');
  return 0;
}

/**
 * Find the subcircuits a design repeats, work out what each one computes by measuring
 * it, and say which chip — if any — computes the same thing.
 *
 * Replacement happens only when asked for, and only for occurrences that live on the
 * sheet being mined: an occurrence inside a chip expansion belongs to another sheet,
 * and editing it from here would change every instance of that chip. The report says
 * how many were replaced and how many were skipped, with the reason for each skip.
 */
async function cmdMine(cf, flags, positional) {
  const subject = await loadSubject(cf, flags, positional);
  const report = cf.mining.mineSubcircuits(subject.circuit, subject.lib, subject.chips, {
    depth: num(flags, 'depth', 3),
    minOccurrences: num(flags, 'min', 2),
    maxPatterns: num(flags, 'max', 24),
    maxPatternInputs: num(flags, 'max-inputs', 5),
    maxPatternSize: num(flags, 'max-size', 12),
    measure: !bool(flags, 'no-measure'),
    matchChips: !bool(flags, 'no-match'),
  });

  const wantReplace = flags.replace !== undefined && flags.replace !== false;
  let replacement = null;
  if (wantReplace) {
    const patternId = str(flags, 'pattern');
    const candidates = report.patterns.filter((p) => p.matchedChip?.identical || patternId);
    const pattern = patternId ? report.patterns.find((p) => p.id === patternId) : candidates[0];
    if (!pattern) {
      warn('nothing to replace: no pattern matched a chip identically. `mine` reports near matches with how many rows differ, and never substitutes on a near match.');
    } else {
      replacement = cf.mining.replacePatternWithChip(subject.circuit, subject.lib, subject.chips, pattern, {
        chipId: str(flags, 'chip') ?? undefined,
        limit: flags.limit === undefined ? undefined : num(flags, 'limit', 0) || undefined,
      });
      replacement.patternId = pattern.id;
      replacement.description = pattern.description;
    }
  }

  if (isJson(flags)) {
    emitJson(
      {
        source: subject.source,
        name: subject.name,
        report,
        replacement: replacement
          ? {
              patternId: replacement.patternId,
              description: replacement.description,
              chipId: replacement.chipId,
              replaced: replacement.replaced,
              skipped: replacement.skipped,
              componentsBefore: replacement.componentsBefore,
              componentsAfter: replacement.componentsAfter,
              netsBefore: replacement.netsBefore,
              netsAfter: replacement.netsAfter,
              diagnostics: replacement.diagnostics,
              notes: replacement.notes,
            }
          : null,
      },
      flags,
    );
    return 0;
  }

  const lines = [`REPEATED SUBCIRCUITS — ${subject.name} (from ${subject.source})`, '', cf.mining.miningToText(report)];
  if (replacement) {
    lines.push('', `Replacement of ${replacement.patternId} (${replacement.description}) with ${replacement.chipId}:`);
    for (const note of replacement.notes) lines.push(`  - ${note}`);
    lines.push(`  ${replacement.componentsBefore} component(s) -> ${replacement.componentsAfter}, ${replacement.netsBefore} net(s) -> ${replacement.netsAfter}`);
    const errors = replacement.diagnostics.filter((d) => d.severity === 'error');
    lines.push(`  ERC after replacement: ${errors.length} error(s), ${replacement.diagnostics.filter((d) => d.severity === 'warning').length} warning(s)`);
    if (replacement.replaced > 0) {
      const out = str(flags, 'out');
      const document = cf.circuitToDocument(replacement.circuit);
      if (out) {
        lines.push('', `The replaced sheet was written as a circuit document.`);
        emit(`${lines.join('\n')}\n`, { ...flags, out: undefined }, 'mining');
        emitJson(document, flags);
        return 0;
      }
      lines.push('', 'Nothing was written: pass --replace with --out <file.json> to keep the replaced sheet.');
    }
  } else if (wantReplace) {
    lines.push('', 'No replacement was performed.');
  }
  emit(`${lines.join('\n')}\n`, flags, 'mining');
  return 0;
}

async function cmdValidate(cf, flags, positional) {
  const subject = await loadSubject(cf, flags, positional);
  const levels = asArray(flags.level ?? flags.levels).map((l) => String(l));
  const specId = str(flags, 'spec');
  // A spec is only used when one was named: inferring "the chip must do this" from
  // its own implementation would make the validation a tautology.
  const spec = specId ? cf.buildSpecById(specId, parseParams(flags)) : undefined;
  const validation = cf.validateCircuit(
    {
      circuit: subject.circuit,
      name: subject.name,
      kind: subject.chip ? 'chip' : 'circuit',
      chipId: subject.chip?.id,
      chipVersion: subject.chip?.version,
    },
    {
      lib: subject.lib,
      chips: subject.chips,
      spec: spec ?? undefined,
      params: parseParams(flags),
      seed: num(flags, 'seed', 1),
      levels: levels.length ? levels : undefined,
      exhaustiveBitLimit: num(flags, 'exhaustive-bits', 4),
      randomVectors: num(flags, 'random-vectors', 200),
      // No gate style is forced unless one was asked for. Forcing `cmos_static`
      // expands every gate into transistors, which removes the behavioural logic
      // elements the level-0 checks read, so the whole logic contract comes back
      // undetermined — a harness artefact that looks like a dead design. The engine's
      // own default runs level 0 on the authored gates and level 1 on the expanded
      // network, which is the pair of views a validation needs.
      gateStyle: str(flags, 'gate-style'),
    },
  );
  if (isJson(flags)) {
    emitJson({ source: subject.source, name: subject.name, validation }, flags);
    return validation.claim === 'FAILED VALIDATION' ? 1 : 0;
  }
  const text = cf.validationToText(validation, { verbose: bool(flags, 'verbose') });
  emit(`VALIDATION — ${subject.name} (from ${subject.source})\n\n${text}`, flags, 'validation');
  return validation.claim === 'FAILED VALIDATION' ? 1 : 0;
}

/** Build an optimizer request from CLI flags, with every default stated. */
function optimizerRequest(cf, flags, subject) {
  const specId = str(flags, 'spec');
  if (!specId) fail('optimize needs --spec', `available: ${cf.specIds().join(', ')}`);
  const spec = cf.buildSpecById(specId, parseParams(flags));
  return {
    spec,
    lib: subject?.lib ?? cf.createDefaultLibrary(),
    chips: subject?.chips ?? cf.buildReferenceProject('optimize').chips,
    name: str(flags, 'name', `${specId} design`),
    profile: (str(flags, 'profile', 'BALANCED')).toUpperCase(),
    seed: num(flags, 'seed', 20260101),
    populationSize: num(flags, 'population', 48),
    // `budget` is a set of stopping conditions, not a count: passing a bare number
    // leaves every limit undefined and the search runs forever. Both a candidate
    // budget and a wall-clock ceiling are set, so a run always ends.
    budget: budgetOf(cf, flags),
    detailTop: num(flags, 'detail-top', 3),
    constraints: {
      maxFanout: num(flags, 'max-fanout', 16),
      ambient: num(flags, 'ambient', 27),
      maxComponents: num(flags, 'max-components'),
      maxDepth: num(flags, 'max-depth'),
      maxDelay: num(flags, 'max-delay'),
    },
  };
}

/**
 * The search's stopping conditions.
 *
 * Always at least two: a candidate budget and a wall-clock ceiling. A search with no
 * ceiling does not stop, and a CLI that hangs is worse than one that reports a
 * smaller number of evaluations. `--budget N` and `--time-limit SECONDS` override
 * the defaults; `--no-time-limit` removes the clock so a run can be reproduced
 * exactly on a slower machine.
 */
function budgetOf(cf, flags) {
  void cf;
  const evaluations = num(flags, 'budget', 2000);
  const generations = num(flags, 'generations');
  const budget = { evaluations };
  if (generations !== undefined) budget.generations = generations;
  if (!bool(flags, 'no-time-limit')) budget.milliseconds = num(flags, 'time-limit', 120) * 1000;
  return budget;
}

function printOptimization(cf, report, why, flags) {
  const out = [];
  out.push(report.claim);
  out.push('');
  out.push('SPEC');
  out.push(`  ${report.spec.name} — ${report.spec.description}`);
  out.push(`  ${report.spec.vectors} behaviour vectors · equivalence by ${report.spec.method}`);
  out.push(`  note: ${report.spec.note}`);
  out.push('');
  out.push('SEARCH SPACE');
  out.push(`  genome ${report.searchSpace.genome}`);
  out.push(`  gate functions ${report.searchSpace.functions.join(', ')}`);
  out.push(`  max nodes ${report.searchSpace.maxNodes} · population ${report.searchSpace.populationSize} · generations ${report.searchSpace.generations}`);
  out.push(`  evaluations ${report.searchSpace.evaluations} · distinct candidates ${report.searchSpace.distinctCandidates}`);
  out.push(`  seeds ${report.searchSpace.seeds.join(', ') || 'none'}`);
  out.push('');
  out.push('METHOD');
  out.push(`  ${report.method.algorithm} · selection ${report.method.selection} · variation ${report.method.variation}`);
  out.push(`  cache ${report.method.cache.hits} hits / ${report.method.cache.misses} misses`);
  out.push(`  tiers ${Object.entries(report.method.tiers).map(([k, v]) => `${k}:${v}`).join(' → ')}`);
  out.push(`  simulation levels: search ${report.simulationLevels.search}${report.simulationLevels.detail ? `, detail ${report.simulationLevels.detail}` : ''}`);
  out.push('');
  out.push('RANKING');
  out.push(`  profile ${report.ranking.profile} · criteria ${report.ranking.criteria}`);
  out.push(`  weights ${Object.entries(report.ranking.weights).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}`);
  out.push(`  note: ${report.ranking.note}`);
  out.push('');
  out.push('CONSTRAINTS');
  const set = Object.entries(report.constraints).filter(([, v]) => v !== undefined && v !== null);
  const unset = Object.entries(report.constraints).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  out.push(`  ${set.map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
  if (unset.length) out.push(`  not set, so not enforced: ${unset.join(', ')}`);
  out.push('');
  // Every field below is one the evaluator measured. `null` is printed as "not
  // measured at this tier" rather than as a zero, because a candidate that never
  // reached tier 3 has no power figure and inventing one is the thing this report
  // exists to avoid.
  const candidate = (c, label) => {
    if (!c) {
      out.push(`${label}: none — no candidate satisfied the spec under these constraints`);
      return;
    }
    const o = c.objectives ?? {};
    out.push(`${label}  (rank ${c.rank}, score ${Number(c.score ?? NaN).toFixed(4)}, ${c.ok ? 'meets the spec and every constraint' : 'DOES NOT meet the spec or a constraint'})`);
    const rows = [
      ['  genome', c.key, `generation ${c.generation}, from "${c.source}"`],
      ['  components', o.components === undefined ? null : o.components, 'primitive parts a BOM would list (tier 2)'],
      ['  critical-path delay', o.delay === undefined || o.delay === null ? null : fmt(o.delay, 's'), 'declared-delay model under the genome’s load (tier 2)'],
      ['  logic depth', o.depth === undefined ? null : o.depth, 'levels on the longest path (tier 2)'],
      ['  structural risk', o.risk === undefined ? null : Number(o.risk).toFixed(2), 'dimensionless (tier 2)'],
      ['  register bits', o.memory === undefined ? null : o.memory, '0 for a pure combinational network'],
      ['  worst static power', o.power === null || o.power === undefined ? null : fmt(o.power, 'W'), o.power === null || o.power === undefined ? 'not measured: the candidate did not reach tier 3' : 'transistor-level DC operating point (tier 3)'],
      ['  hottest junction', o.temperature === null || o.temperature === undefined ? null : `${Number(o.temperature).toFixed(2)} °C`, o.temperature === null || o.temperature === undefined ? 'not measured: the candidate did not reach tier 4' : 'level-3 steady state (tier 4)'],
      ['  switching energy', o.switchEnergy === null || o.switchEnergy === undefined ? null : fmt(o.switchEnergy, 'J'), o.switchEnergy === null || o.switchEnergy === undefined ? 'not measured: the candidate did not reach tier 4' : 'one full input transition (tier 4)'],
      ['  genome shape', `${c.genome?.nodes ?? '?'} nodes`, `depth ${c.genome?.depth ?? '?'}, max fan-out ${c.genome?.maxFanout ?? '?'}`],
      ['  behaviour', `${c.vectorsChecked ?? 0} vector(s)`, c.vectorMethod ?? ''],
      ['  fingerprint', c.fingerprint ?? 'not built', ''],
    ];
    out.push(table(rows, ['  ', 'value', 'what it is'], ['l', 'r', 'l']).trimEnd());
    const terms = Object.entries(c.violationTerms ?? {}).filter(([, v]) => v > 0);
    out.push(`  constraint violations: ${terms.length === 0 ? 'none' : terms.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (c.reason) out.push(`  evaluator: ${c.reason}`);
    if (c.tiers?.length) {
      out.push('  tiers:');
      for (const t of c.tiers) out.push(`    ${t.passed ? 'pass' : 'STOP'}  T${t.id} ${t.name} (${t.ms} ms)${t.note ? ` — ${t.note}` : ''}`);
    }
    if (c.detail) {
      out.push('  detail pass (tiers 3–4):');
      out.push(`    worst vector #${c.detail.worstVectorIndex} · static ${fmt(c.detail.staticPower, 'W')} · thermal ${c.detail.thermalConverged ? 'converged' : 'DID NOT CONVERGE'} · ${fmt(c.detail.switchEnergy, 'J')} per transition`);
      out.push(`    ${c.detail.transientNote}`);
      for (const n of c.detail.notes ?? []) out.push(`    note: ${n}`);
    } else {
      out.push('  detail pass: not run for this candidate, so power, temperature and switching energy were never measured');
    }
  };
  candidate(report.best, 'BEST FOUND');
  out.push('');
  candidate(report.runnerUp, 'RUNNER-UP');
  if (report.pareto?.length) {
    out.push('');
    out.push(`PARETO FRONT — ${report.pareto.length} candidate(s) not dominated on every objective`);
    const rows = report.pareto.slice(0, 12).map((c) => [
      `  ${c.key.slice(0, 16)}`,
      c.objectives?.components ?? 'n/a',
      c.objectives?.delay === undefined || c.objectives?.delay === null ? 'n/a' : fmt(c.objectives.delay, 's'),
      c.objectives?.depth ?? 'n/a',
      c.objectives?.power === undefined || c.objectives?.power === null ? 'not measured' : fmt(c.objectives.power, 'W'),
      c.objectives?.risk ?? 'n/a',
      c.source ?? '',
    ]);
    out.push(table(rows, ['  genome', 'parts', 'delay', 'depth', 'static power', 'risk', 'from'], ['l', 'r', 'r', 'r', 'r', 'r', 'l']).trimEnd());
    if (report.pareto.length > 12) out.push(`  … and ${report.pareto.length - 12} more`);
    out.push('  "not dominated" means no other candidate is better on every objective at once;');
    out.push('  it is not a claim that any of these is the best possible design.');
  }
  out.push('');
  out.push('REPRODUCIBILITY');
  out.push(`  seed ${report.reproducibility.seed} · rng draws ${report.reproducibility.rngDraws}`);
  out.push(`  engine ${report.reproducibility.engineVersion} · models ${Object.entries(report.reproducibility.modelVersion).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  out.push(`  hardware ${report.reproducibility.hardware.cores} core(s) [${report.reproducibility.hardware.cpu}] on ${report.reproducibility.hardware.platform}`);
  out.push(`  cpu ${report.reproducibility.cpuMs} ms · wall ${report.reproducibility.wallMs} ms`);
  if (report.notes?.length) {
    out.push('');
    out.push('NOTES');
    for (const n of report.notes) out.push(`  · ${n}`);
  }
  if (why) {
    out.push('');
    out.push('WHY THIS DESIGN');
    out.push(`  winner ${why.winnerKey} versus ${why.runnerUpKey ?? '(no runner-up)'}`);
    for (const s of why.sentences) out.push(`  ${s}`);
    if (why.deltas?.length) {
      // Each row is one measured objective in the profile's weight order, with its
      // own unit and the scope it was measured at. `better` is the comparison the
      // engine made; nothing here re-derives it, and "not measured" stays visible.
      const rows = why.deltas.map((d) => [
        `  ${d.objective}`,
        d.winner === null || d.winner === undefined ? 'not measured' : `${d.winner.toPrecision(5)} ${d.unit}`.trim(),
        d.runnerUp === null || d.runnerUp === undefined ? 'not measured' : `${d.runnerUp.toPrecision(5)} ${d.unit}`.trim(),
        d.absolute === null || d.absolute === undefined ? 'n/a' : `${d.absolute.toPrecision(4)} ${d.unit}`.trim(),
        d.relative === null || d.relative === undefined ? 'n/a' : `${(d.relative * 100).toFixed(2)} %`,
        d.weighted === null || d.weighted === undefined ? 'n/a' : Number(d.weighted).toPrecision(4),
        d.better,
      ]);
      out.push(table(rows, ['  objective', 'winner', 'runner-up', 'difference', 'relative', 'score effect', 'better'], ['l', 'r', 'r', 'r', 'r', 'r', 'l']).trimEnd());
      for (const d of why.deltas) if (d.scope) out.push(`    ${d.objective}: ${d.scope}`);
    }
    for (const s of why.structure ?? []) out.push(`  structure: ${s}`);
    if (why.caveats?.length) {
      out.push('  NOT MEASURED, SO NOT CLAIMED:');
      for (const c of why.caveats) out.push(`    · ${c}`);
    }
  }
  return `${out.join('\n')}\n`;
}

async function cmdOptimize(cf, flags, positional) {
  void positional;
  const request = optimizerRequest(cf, flags, null);
  const opt = new cf.Optimizer(request);
  if (!bool(flags, 'quiet')) {
    const b = request.budget;
    const stops = [b.evaluations !== undefined ? `${b.evaluations} evaluations` : null, b.generations !== undefined ? `${b.generations} generations` : null, b.milliseconds !== undefined ? `${(b.milliseconds / 1000).toFixed(0)} s ceiling` : null].filter(Boolean);
    say(`optimizing "${request.spec.name}" with profile ${request.profile}, stopping at ${stops.join(' or ')}, seed ${request.seed}…`);
  }
  const t0 = Date.now();
  opt.run();
  const report = opt.report();
  const why = bool(flags, 'why') ? opt.why() : null;
  if (isJson(flags)) {
    emitJson({ report, why }, flags);
    return report.best ? 0 : 1;
  }
  const text = printOptimization(cf, report, why, flags);
  emit(`${text}  (search took ${((Date.now() - t0) / 1000).toFixed(1)} s)\n`, flags, 'optimization report');
  return report.best ? 0 : 1;
}

/**
 * Auto design: spec → search → detail → validate → chip → project file.
 *
 * This is the pipeline the specification calls "reverse engineering" and "AUTO
 * DESIGN": a behavioural description goes in and a validated, saved, exportable
 * design comes out. Each stage prints what it produced and what it refused to
 * claim, and the run stops rather than saving a chip that failed validation —
 * saving an unvalidated chip is how a library fills up with things nobody can
 * trust.
 */
async function cmdSynth(cf, flags, positional) {
  const stages = [];
  const stage = (name, fn) => {
    const t0 = Date.now();
    if (!bool(flags, 'quiet')) say(`  ${name}…`);
    const value = fn();
    stages.push({ stage: name, ms: Date.now() - t0 });
    return value;
  };

  const specId = str(flags, 'spec');
  if (!specId) fail('synth needs --spec', `available: ${cf.specIds().join(', ')}`);
  const params = parseParams(flags);
  say(`SYNTHESIS — behavioural spec "${specId}"${Object.keys(params).length ? ` with ${JSON.stringify(params)}` : ''}`);

  const lib = cf.createDefaultLibrary();
  const chips = cf.buildReferenceProject('synth').chips;
  const spec = stage('reading the spec', () => cf.buildSpecById(specId, params));
  say(`    ${spec.name} — ${spec.description}`);
  // The vector count and the equivalence method are properties of the *plan* the
  // search builds, not of the spec object, so they are reported after the search
  // rather than guessed here from fields that do not exist.
  say(`    inputs  ${spec.inputs.map((i) => `${i.name}[${i.width}]`).join(' ')}`);
  say(`    outputs ${spec.outputs.map((o) => `${o.name}[${o.width}]`).join(' ')}`);

  const request = {
    spec, lib, chips,
    name: str(flags, 'name', `${specId} (synthesised)`),
    profile: (str(flags, 'profile', 'BALANCED')).toUpperCase(),
    seed: num(flags, 'seed', 20260101),
    populationSize: num(flags, 'population', 48),
    budget: budgetOf(cf, flags),
    detailTop: num(flags, 'detail-top', 3),
    constraints: { maxFanout: num(flags, 'max-fanout', 16), ambient: num(flags, 'ambient', 27) },
  };
  const opt = new cf.Optimizer(request);
  stage('searching', () => opt.run());
  const report = opt.report();
  say(`    ${report.spec.vectors} behaviour vector(s), equivalence by ${report.spec.method}`);
  say(`    ${report.searchSpace.evaluations} evaluations, ${report.searchSpace.distinctCandidates} distinct candidates, ${report.pareto?.length ?? 0} on the Pareto front`);
  if (!report.best) {
    say('    no candidate satisfied the spec under these constraints');
    say('    nothing was saved: a design that does not meet its specification is not a result');
    if (isJson(flags)) emitJson({ ok: false, report, stages }, flags);
    return 1;
  }
  const bo = report.best.objectives ?? {};
  say(`    best: ${report.best.key} — ${bo.components ?? '?'} component(s), ${bo.delay === undefined || bo.delay === null ? 'delay not measured' : fmt(bo.delay, 's')}, depth ${bo.depth ?? '?'}`);

  // `buildBest` returns the circuit itself. The gate style is stated because it
  // decides whether the sheet holds behavioural gates or transistor networks, and the
  // two are different designs with different numbers.
  const gateStyle = str(flags, 'gate-style');
  const circuit = stage('building the winner as a circuit', () => opt.buildBest(gateStyle ? { gateStyle } : {}));
  if (!circuit) fail('the winner could not be built into a circuit', 'the search ranked a genome whose implementation failed to lower');
  say(`    ${circuit.componentCount()} component(s) on the sheet, gate style ${gateStyle ?? 'as authored'}`);

  const validation = stage('validating', () =>
    cf.validateCircuit(
      { circuit, name: request.name, kind: 'chip', chipId: str(flags, 'save-as', `${specId}_synth`) },
      // Same rule as `validate`: the search already built this candidate at the
      // electrical level, so the gate style is only forced when the user asks.
      { lib, chips, spec, params, seed: num(flags, 'seed', 1), gateStyle: str(flags, 'gate-style') },
    ),
  );
  say(`    ${validation.claim}`);
  const t = validation.totals;
  say(`    ${t.passed} case(s) passed, ${t.failed} failed, ${t.skipped} not measured, over ${t.ran} check(s) run and ${t.skippedChecks} skipped`);
  say(`    conditions: ${validation.conditions.vectors.total} vector(s) (${validation.conditions.vectors.method}), seed ${validation.conditions.seed}, ambient ${validation.conditions.ambient} °C, Vdd ${validation.conditions.vdd} V, gate style "${validation.conditions.gateStyle}"`);
  for (const f of validation.failures ?? []) say(`    FAIL ${f}`);
  if (bool(flags, 'verbose')) say(cf.validationToText(validation, { verbose: true }).trimEnd().replace(/^/gm, '    '));

  if (validation.claim === 'FAILED VALIDATION' && !bool(flags, 'force')) {
    say('    the design failed validation, so it was NOT saved');
    say('    pass --force to save it anyway, marked as unvalidated');
    if (isJson(flags)) emitJson({ ok: false, report, validation, stages }, flags);
    return 1;
  }

  const chipId = str(flags, 'save-as', `${specId}_synth`);
  const project = new cf.Project(`${chipId} synthesis`, lib, chips);
  // Saved from the circuit that was just validated, not rebuilt by the optimizer:
  // `saveBestAsChip` builds its own copy at the default gate style, and saving a
  // different circuit from the one the verdict refers to would make the chip's
  // description a claim about something else.
  const saved = stage('saving as a chip', () =>
    project.saveAsChip(circuit, {
      id: chipId,
      name: str(flags, 'name', `${spec.name} (synthesised)`),
      description:
        `Synthesised by CircuitForge ${cf.ENGINE_VERSION} from the "${specId}" spec ` +
        `(${report.spec.vectors} vectors, ${report.spec.method}) under profile ${report.ranking.profile}, ` +
        `seed ${report.reproducibility.seed}, ${report.searchSpace.evaluations} evaluations. ` +
        `${report.claim}: ${bo.components ?? '?'} components, ${bo.delay === undefined || bo.delay === null ? 'delay not measured' : `${(bo.delay * 1e9).toFixed(3)} ns`}. ` +
        `Validation: ${validation.claim}.`,
      tags: ['generated', 'optimised', `profile:${report.ranking.profile}`],
      origin: 'synthesis',
      overwrite: bool(flags, 'overwrite'),
    }),
  );
  project.sheet = circuit;
  say(`    chip "${saved.id}" v${saved.version} — ${saved.ports.length} port(s), ${saved.def.circuit.componentCount()} component(s)`);

  const text = cf.saveProjectText(project, { circuit, notes: `${request.name} — ${report.claim.toLowerCase()}` });
  const target = str(flags, 'out', `data/synthesis/${chipId}.cfproj.json`);
  const abs = path.resolve(process.cwd(), target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  say(`    project written to ${path.relative(process.cwd(), abs) || abs}`);

  const why = opt.why();
  if (why) {
    say('');
    say('WHY THIS DESIGN');
    for (const s of why.sentences) say(`    ${s}`);
    for (const c of why.caveats ?? []) say(`    not claimed: ${c}`);
  }
  say('');
  say(`  ${report.claim}`);
  say(`  constraints ${Object.entries(report.constraints).map(([k, v]) => `${k}=${v}`).join(' ')} · profile ${report.ranking.profile} · seed ${report.reproducibility.seed}`);
  say(`  stages ${stages.map((s) => `${s.stage} ${s.ms} ms`).join(', ')}`);

  if (isJson(flags)) {
    emitJson({ ok: true, chipId, file: target, report, validation, why, stages }, flags);
  }
  return 0;
}

const EXPORT_FORMATS = [
  ['project', 'the design as a CircuitForge project file (exact reconstruction)'],
  ['schematic-hierarchical', 'the sheet as drawn: blocks, ports, wires, hierarchy kept'],
  ['schematic-flattened', 'every leaf component with its resolved coordinates'],
  ['schematic-electrical', 'the full electrical sheet: refs, values, coords, rotation, nets, parameters'],
  ['schematic-csv', 'the electrical sheet as two CSV tables (components, nets)'],
  ['bom', 'aggregated bill of materials (CSV)'],
  ['bom-detailed', 'one row per instance (CSV)'],
  ['bom-text', 'the BOM as a readable table'],
  ['spice', 'a SPICE netlist, with the unsupported constructs listed'],
  ['waveform', 'a transient record as CSV (needs --transient and --probe)'],
  ['report', 'the simulation report as text'],
  ['stats', 'per-component and per-circuit statistics as JSON'],
];

async function cmdExport(cf, flags, positional) {
  const format = (str(flags, 'format') ?? 'project').toLowerCase();
  if (bool(flags, 'list-formats')) {
    if (isJson(flags)) emitJson({ formats: EXPORT_FORMATS.map(([id, description]) => ({ id, description })) }, flags);
    else {
      say('EXPORT FORMATS');
      say(table(EXPORT_FORMATS.map(([id, d]) => [`  ${id}`, d]), ['  id', 'what it produces']).trimEnd());
    }
    return 0;
  }
  if (!EXPORT_FORMATS.some(([id]) => id === format)) {
    fail(`unknown --format "${format}"`, `try: ${EXPORT_FORMATS.map(([id]) => id).join(', ')}`);
  }

  const subject = await loadSubject(cf, flags, positional);
  const pretty = !bool(flags, 'minify');

  if (format === 'project') {
    const project = subject.project?.chips?.all().length || subject.project?.sheet ? subject.project : new cf.Project(subject.name, subject.lib, subject.chips);
    if (!project.sheet) project.sheet = subject.circuit;
    emit(cf.saveProjectText(project, { circuit: subject.circuit, notes: `exported from ${subject.source}` }), flags, 'project file');
    return 0;
  }

  if (format === 'stats') {
    const nl = flattenSubject(cf, subject, flags);
    const sim = new cf.CircuitSimulator(nl, { ambient: num(flags, 'ambient', 27) });
    try { sim.dcSolve({ quiet: true }); } catch { /* reported as not measured below */ }
    const stats = cf.circuitStats(nl, { lib: subject.lib, sim });
    emitJson({ source: subject.source, name: subject.name, stats }, flags);
    return 0;
  }

  const nl = flattenSubject(cf, subject, flags);

  if (format.startsWith('schematic')) {
    const level = format === 'schematic-hierarchical' ? 'hierarchical' : format === 'schematic-flattened' ? 'flattened' : 'electrical';
    if (format === 'schematic-csv') {
      const sheet = cf.exportSchematicElectrical(nl);
      const components = cf.schematicComponentsToCsv(sheet);
      const nets = cf.schematicNetsToCsv(sheet);
      const target = str(flags, 'out');
      if (target) {
        const base = target.replace(/\.csv$/i, '');
        fs.mkdirSync(path.dirname(path.resolve(process.cwd(), base)), { recursive: true });
        fs.writeFileSync(`${base}-components.csv`, components, 'utf8');
        fs.writeFileSync(`${base}-nets.csv`, nets, 'utf8');
        say(`schematic CSV written to ${base}-components.csv and ${base}-nets.csv`);
      } else {
        say('COMPONENTS');
        say(components.trimEnd());
        say('');
        say('NETS');
        say(nets.trimEnd());
      }
      return 0;
    }
    const sheet = level === 'hierarchical' ? cf.exportSchematicHierarchical(subject.circuit, subject.lib) : level === 'flattened' ? cf.exportSchematicFlattened(nl) : cf.exportSchematicElectrical(nl);
    const json = cf.schematicToJson(sheet, pretty);
    if (isJson(flags)) {
      emit(json, flags, `${level} schematic`);
    } else {
      emit(json, flags, `${level} schematic`);
    }
    const counts = countSheet(sheet);
    if (!bool(flags, 'quiet') && str(flags, 'out')) {
      say(`  ${counts.components} component(s), ${counts.nets} net(s), ${counts.wires} wire segment(s), level ${level}`);
    }
    return 0;
  }

  if (format.startsWith('bom')) {
    const bom = cf.buildBomFromNetlist(nl, { lib: subject.lib });
    if (format === 'bom-text') {
      emit(cf.bomToText(bom), flags, 'bill of materials');
      return 0;
    }
    const kind = format === 'bom-detailed' ? 'detailed' : 'aggregated';
    if (isJson(flags)) {
      emitJson(bom, flags);
      return 0;
    }
    emit(cf.bomToCsv(bom, kind), flags, `bill of materials (${kind})`);
    return 0;
  }

  if (format === 'spice') {
    const result = cf.exportSpiceNetlist(nl, { title: `${subject.name} — exported by CircuitForge ${cf.ENGINE_VERSION}` });
    const text = typeof result === 'string' ? result : result.text ?? result.netlist ?? JSON.stringify(result, null, 2);
    emit(text, flags, 'SPICE netlist');
    if (!bool(flags, 'quiet') && typeof result === 'object' && result.notes?.length) {
      for (const n of result.notes) warn(`  note: ${n}`);
    }
    return 0;
  }

  if (format === 'waveform' || format === 'report') {
    const tstop = num(flags, 'transient');
    if (tstop === undefined) fail(`--format ${format} needs --transient TSTOP`, 'e.g. --transient 5ms --probe out');
    const sim = new cf.CircuitSimulator(nl, { integration: str(flags, 'integration', 'trap'), ambient: num(flags, 'ambient', 27) });
    const scope = new cf.Oscilloscope(sim);
    const probes = asArray(flags.probe);
    if (probes.length === 0) fail(`--format ${format} needs at least one --probe`, 'a net name, a reference designator, or an element path');
    for (const t of probes) scope.addChannel({ measure: str(flags, 'measure', 'voltage'), target: t });
    const capture = scope.run({ tstop, maxSamples: num(flags, 'samples', 20000) });
    if (format === 'waveform') {
      emit(scope.toCsv(), flags, 'waveform CSV');
      return 0;
    }
    const sections = [
      { title: 'CAPTURE', rows: [['stop time', fmt(tstop, 's')], ['samples', String(capture.samples ?? scope.trace(0)?.times.length ?? 0)], ['truncated at', capture.truncatedAt === null || capture.truncatedAt === undefined ? 'no — the record covers the requested window' : fmt(capture.truncatedAt, 's')]], notes: capture.notes ?? [] },
    ];
    emit(cf.reportToText({ title: `TRANSIENT REPORT — ${subject.name}`, subtitle: `from ${subject.source}`, sections }), flags, 'report');
    say(cf.scopeReportToText(scope.report({ verbose: bool(flags, 'verbose') })).trimEnd());
    return 0;
  }

  fail(`--format ${format} is listed but not implemented`, 'this is a bug in the CLI, not a limitation of the engine');
  return 1;
}

function countSheet(sheet) {
  const components = sheet?.components?.length ?? 0;
  const nets = sheet?.nets?.length ?? 0;
  let wires = 0;
  for (const n of sheet?.nets ?? []) wires += n.wires?.length ?? n.segments?.length ?? 0;
  return { components, nets, wires };
}

async function cmdBenchmark(cf, flags) {
  const suite = str(flags, 'suite', 'quick');
  let bench;
  try {
    bench = await import(pathToFileURL(path.join(DIST, 'engine', 'bench', 'index.js')).href);
  } catch {
    bench = null;
  }
  if (!bench?.runBenchmarkSuite) {
    fail('the benchmark module is not built', 'run `npm run build`, or `circuitforge doctor` to see what is missing');
  }
  const result = await bench.runBenchmarkSuite({
    suite,
    json: isJson(flags),
    sizes: asArray(flags.size).map((s) => Number(s)),
    repeats: num(flags, 'repeats', 3),
    quiet: bool(flags, 'quiet'),
    onProgress: bool(flags, 'quiet') ? undefined : (line) => say(`  ${line}`),
  });
  if (isJson(flags)) {
    emitJson(result, flags);
    return 0;
  }
  emit(bench.benchmarkToText ? bench.benchmarkToText(result) : `${JSON.stringify(result, null, 2)}\n`, flags, 'benchmark');
  return 0;
}

/** A progress record as one honest line: what was tested, what is left, and the ETA. */
function progressOf(progress) {
  if (!progress) return 'n/a';
  const parts = [];
  if (progress.fraction !== undefined && progress.fraction !== null) parts.push(`${(progress.fraction * 100).toFixed(1)} %`);
  else if (progress.done !== undefined && progress.total) parts.push(`${progress.done}/${progress.total}`);
  if (progress.tested !== undefined) parts.push(`${progress.tested} tested`);
  if (progress.remaining !== undefined) parts.push(`${progress.remaining} left`);
  if (progress.etaMs !== undefined && progress.etaMs !== null) parts.push(`eta ${(progress.etaMs / 1000).toFixed(0)} s`);
  return parts.join(', ') || JSON.stringify(progress).slice(0, 40);
}

async function cmdJobs(cf, flags) {
  const dir = str(flags, 'dir', path.join(ROOT, '.circuitforge-cache', 'jobs'));
  if (bool(flags, 'clear')) {
    if (fs.existsSync(dir)) {
      const n = fs.readdirSync(dir).length;
      fs.rmSync(dir, { recursive: true, force: true });
      say(`removed ${n} persisted job file(s) from ${path.relative(ROOT, dir)}`);
    } else {
      say('no persisted jobs');
    }
    return 0;
  }
  const storage = new cf.FileStorage(dir);
  const queue = new cf.JobQueue(storage);
  const restored = queue.restore();
  const snapshot = queue.snapshot();
  const history = queue.historyEntries(num(flags, 'limit', 20));
  if (isJson(flags)) {
    emitJson({ dir, restored, jobs: snapshot.jobs, history }, flags);
    return 0;
  }
  say('JOB QUEUE');
  say(`  storage ${path.relative(process.cwd(), dir) || dir} (durable: ${storage.durable})`);
  say(`  restored ${restored.jobs} job(s) and ${restored.history} history entr(ies); ${restored.interrupted.length} interrupted by a crash`);
  if (snapshot.jobs.length === 0 && history.length === 0) {
    say('  no jobs: nothing persisted, nothing queued');
    say('  a job appears here when an optimization or a validation run is queued, and it');
    say('  survives a crash — `circuitforge jobs` then reports it as resumable');
    return 0;
  }
  if (snapshot.jobs.length) {
    say('');
    say('  QUEUED AND RUNNING');
    const rows = snapshot.jobs.map((j) => [
      `  ${j.id}`, j.kind, j.state, String(j.priority), progressOf(j.progress), j.name,
    ]);
    say(table(rows, ['  id', 'kind', 'state', 'prio', 'progress', 'name'], ['l', 'l', 'l', 'r', 'r', 'l']).trimEnd());
  }
  if (history.length) {
    say('');
    say('  HISTORY');
    const rows = history.map((h) => [
      `  ${h.id}`, h.kind, h.state, `${(h.elapsedMs / 1000).toFixed(1)} s`, h.resumable ? 'resumable' : '', (h.summary ?? h.error ?? '').slice(0, 46),
    ]);
    say(table(rows, ['  id', 'kind', 'state', 'elapsed', 'resume', 'summary'], ['l', 'l', 'l', 'r', 'l', 'l']).trimEnd());
  }
  for (const j of restored.interrupted) {
    say('');
    say(`  Previous job detected: ${j.id} (${j.kind}, ${j.name}) was interrupted at ${progressOf(j.progress)}.`);
    say(`  Resume it with: circuitforge jobs --resume ${j.id}`);
  }
  const resumeId = str(flags, 'resume');
  if (resumeId) {
    const ok = queue.resumeInterrupted(resumeId) || queue.resume(resumeId);
    say(ok ? `  resumed ${resumeId}` : `  could not resume ${resumeId}: no checkpoint for it`);
    return ok ? 0 : 1;
  }
  return 0;
}

async function cmdServe(cf, flags) {
  const port = num(flags, 'port', 8080);
  const host = str(flags, 'host', '0.0.0.0');
  let server;
  try {
    server = await import(pathToFileURL(SERVER_ENTRY).href);
  } catch (err) {
    fail(
      `the server module is not built: ${err instanceof Error ? err.message : String(err)}`,
      'run `npm run build`; the GUI lives in src/server and src/ui and compiles to dist/server',
    );
  }
  if (!server?.startServer) fail('dist/server/index.js exports no startServer()', 'the server module is incomplete');
  const running = await server.startServer({
    port,
    host,
    publicDir: PUBLIC_DIR,
    open: !bool(flags, 'no-open'),
    quiet: bool(flags, 'quiet'),
    engine: cf,
  });
  // `main()` ends with process.exit(code), so a command that returns kills whatever
  // it started. Serving must not return: it stays alive until a signal arrives, then
  // closes the server (flushing the job queue's checkpoints) and lets the process end.
  await new Promise((resolve) => {
    let closing = false;
    const stop = (signal) => {
      if (closing) return;
      closing = true;
      if (!bool(flags, 'quiet')) say(`${signal} received — closing the laboratory`);
      Promise.resolve(running && running.close ? running.close() : undefined)
        .catch(() => undefined)
        .then(resolve);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usageAndExit(code) {
  cmdHelp(null, {}, []);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0] ?? (bool(flags, 'help') ? 'help' : 'start');

  if (bool(flags, 'version') || bool(flags, 'v')) {
    ensureBuild({ quiet: true });
    const cf = await loadEngine();
    process.exit(cmdVersion(cf));
  }
  if (command === 'help' || bool(flags, 'help') || command === '--help' || command === '-h') {
    // Help must work without a build: it is the first thing anybody types.
    let cf = null;
    try {
      if (fs.existsSync(ENGINE_ENTRY)) cf = await import(pathToFileURL(ENGINE_ENTRY).href);
    } catch {
      cf = null;
    }
    process.exit(cmdHelp(cf, flags, positional));
  }

  const spec = COMMANDS[command];
  if (!spec) {
    warn(`circuitforge: unknown command "${command}"`);
    warn('');
    usageAndExit(1);
  }

  ensureBuild({ quiet: bool(flags, 'quiet') });
  const cf = await loadEngine();
  const rest = positional.slice(1);
  let code = 0;
  try {
    code = await spec.fn(cf, flags, rest, command);
  } catch (err) {
    if (err && err.name === 'AssertionError') warn(`${err.message}`);
    else if (err && typeof err.code === 'string' && /^CF\d+$/.test(err.code)) warn(`${err.code}: ${err.message}`);
    else if (err instanceof Error) {
      warn(`circuitforge: ${err.message}`);
      if (bool(flags, 'stack') || process.env.CIRCUITFORGE_DEBUG) warn(err.stack ?? '');
      else warn('            (pass --stack for the trace)');
    } else warn(`circuitforge: ${JSON.stringify(err)}`);
    code = 1;
  }
  process.exit(typeof code === 'number' ? code : 0);
}

main();
