/**
 * The HTTP server behind the graphical laboratory.
 *
 * Three jobs, in this order of importance:
 *
 *   1. Serve the editor. `public/index.html` and its modules are static files, and
 *      the compiled engine is served as ES modules under `/engine/*` so the browser
 *      imports the *same* code the CLI runs. That is not a shortcut: an editor that
 *      simulated circuits with its own copy of the logic would be a second
 *      implementation to keep honest, and the numbers on screen would not be the
 *      numbers the engine produces.
 *   2. Own what a browser cannot: files on disk, and long jobs. `/api/project/*`
 *      reads and writes `.cfproj.json`, and the job queue runs optimizations,
 *      validations and benchmarks server-side with checkpoints, so a job survives a
 *      closed tab and a crashed process.
 *   3. Report the truth about itself. `/api/health` says which engine version is
 *      running, on what platform, with which GPU backend; every failure carries the
 *      engine's own diagnostic code rather than a generic 500.
 *
 * Nothing here is bound to a framework: `node:http`, a path map and a MIME table,
 * because a dependency-free project that installs in seconds is worth more than a
 * router library. Paths are resolved and containment-checked before any file is
 * read, so `..` cannot escape the served roots.
 *
 * `src/` never imports a Node builtin statically — the engine has to stay loadable
 * in a browser — so the builtins are fetched through `process.getBuiltinModule`,
 * which is what the rest of the engine does for the same reason.
 */

type HttpServer = {
  listen(port: number, host: string, cb: () => void): unknown;
  close(cb?: (err?: Error) => void): unknown;
  address(): { port: number } | string | null;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
};

type Incoming = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: (arg?: unknown) => void): void;
};

type Outgoing = {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  end(body?: string | Uint8Array): void;
};

export interface ServerOptions {
  /** TCP port; 0 asks the OS for a free one, which is what the tests use. */
  port?: number;
  /** Interface to bind. Defaults to every interface, so a preview proxy can reach it. */
  host?: string;
  /** Directory holding index.html and the editor's modules. */
  publicDir?: string;
  /** Where compiled engine modules are served from. Defaults to `dist/engine`. */
  engineDir?: string;
  /** Where projects and job checkpoints are persisted. Defaults to `./data`. */
  dataDir?: string;
  /** Try to open a browser. Best effort, and never fatal. */
  open?: boolean;
  quiet?: boolean;
  /** The engine module namespace, when the caller already loaded it. */
  engine?: EngineLike;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  /** Number of requests served, for the console dock and the tests. */
  requests(): number;
  close(): Promise<void>;
}

/** The slice of the engine the server uses, typed structurally so the CLI can hand
 * over the module namespace it already loaded without a circular import. */
export interface EngineLike {
  VERSION?: string;
  ENGINE_VERSION?: string;
  about?(): Record<string, unknown>;
  [key: string]: unknown;
}

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  names: string[];
  handler: (ctx: RequestContext) => unknown | Promise<unknown>;
}

interface RequestContext {
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: Record<string, unknown>;
  engine: EngineLike;
  state: ServerState;
}

interface ServerState {
  engine: EngineLike;
  dataDir: string;
  queue: QueueLike | null;
  startedAt: number;
  requests: number;
  log: (line: string) => void;
}

interface QueueLike {
  enqueue(kind: string, name: string, spec: Record<string, unknown>, opts?: Record<string, unknown>): { id: string };
  snapshot(): Record<string, unknown>;
  queueProgress(): Record<string, unknown>;
  historyEntries(limit?: number): unknown[];
  pause(id?: string): boolean;
  resume(id: string): boolean;
  cancel(id: string): boolean;
  setPriority(id: string, priority: number): boolean;
  reorder(id: string, index: number): boolean;
  detectInterrupted(): unknown[];
  resumeInterrupted(id: string): boolean;
  pump(ms: number): number;
  save(): void;
  restore(): { jobs: number; history: number; interrupted: unknown[] };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const DEFAULT_MAX_BODY = 64 * 1024 * 1024;

function builtin<T>(name: string): T {
  const mod = (process as unknown as { getBuiltinModule?: (n: string) => unknown }).getBuiltinModule?.(name);
  if (!mod) throw new Error(`the Node builtin "${name}" is not available in this process`);
  return mod as T;
}

/**
 * Start the laboratory server.
 *
 * Resolves once the port is listening, so a caller can print a URL that works
 * immediately. `port: 0` binds an ephemeral port and the resolved number is
 * reported back.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const http = builtin<{ createServer(cb: (req: Incoming, res: Outgoing) => void): HttpServer }>('node:http');
  const fs = builtin<typeof import('node:fs')>('node:fs');
  const path = builtin<typeof import('node:path')>('node:path');
  const host = options.host ?? '0.0.0.0';
  const quiet = options.quiet ?? false;
  const log = (line: string): void => {
    if (!quiet) process.stdout.write(`${line}\n`);
  };

  const here = new URL('.', import.meta.url);
  // The compiled server sits at <root>/dist/server in a build and at
  // <root>/dist-test/src/server in the test build, so a fixed number of ".." would
  // point at the wrong place in one of them. The root is found by walking up to the
  // package manifest, which is where it is in both.
  const rootDir = findProjectRoot(path, here.pathname);
  const engineDir = options.engineDir ?? path.resolve(here.pathname, '..', 'engine');
  const uiDir = path.resolve(here.pathname, '..', 'ui');
  const publicDir = options.publicDir ?? path.resolve(rootDir, 'public');
  const dataDir = options.dataDir ?? path.resolve(rootDir, 'data');

  const engine = options.engine ?? ((await import('../engine/index.js')) as unknown as EngineLike);
  const state: ServerState = { engine, dataDir, queue: null, startedAt: Date.now(), requests: 0, log };

  // The job queue is what makes a long optimization survive a closed tab. It is
  // built lazily so that a server used only for editing pays nothing for it, and a
  // failure to create the checkpoint directory downgrades to in-memory storage with
  // a line in the log rather than a server that will not start.
  const queue = await createQueue(engine, dataDir, fs, path, log);
  state.queue = queue;

  const routes = buildRoutes();

  const server = http.createServer((req, res) => {
    state.requests++;
    void handle(req, res, { routes, state, fs, path, publicDir, engineDir, uiDir, maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY });
  });
  server.on('error', (err: unknown) => {
    log(`server error: ${err instanceof Error ? err.message : String(err)}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    (server as unknown as { once(e: string, cb: (err: Error) => void): void }).once('error', onError);
    server.listen(options.port ?? 8080, host, () => {
      (server as unknown as { off?(e: string, cb: unknown): void }).off?.('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 8080);
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shownHost}:${port}/`;

  if (queue) {
    // Pump jobs in short slices on a timer, so a long optimization yields to HTTP
    // requests and the GUI can poll progress instead of waiting blind.
    const timer = setInterval(() => {
      try {
        queue.pump(20);
      } catch (err) {
        log(`job pump failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 25);
    timer.unref?.();
  }

  log(`CircuitForge ${String(engine.VERSION ?? engine.ENGINE_VERSION ?? '')} — laboratory served at ${url}`);
  log(`  editor    ${publicDir}`);
  log(`  engine    ${engineDir} (served as ES modules under /engine/)`);
  log(`  data      ${dataDir}`);
  log(`  jobs      ${queue ? 'queue running, checkpoints persisted' : 'in-memory only (see the log above)'}`);
  if (options.open) await openBrowser(url, log);

  return {
    url,
    host,
    port,
    requests: () => state.requests,
    close: async () => {
      try {
        queue?.save();
      } catch {
        // A checkpoint that cannot be written at shutdown is not worth failing the
        // shutdown for; the queue checkpoints as it goes.
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The directory holding the package manifest, found by walking up.
 *
 * Used to locate `public/` and `data/` without assuming how many directories the
 * build put between them and this module. If no manifest is found — a bundled or a
 * relocated install — the module's own grandparent is the fallback, and the startup
 * log says which directory is being served, so a wrong guess is visible at once.
 */
function findProjectRoot(path: typeof import('node:path'), fromDir: string): string {
  const fs = builtin<typeof import('node:fs')>('node:fs');
  let dir = path.resolve(fromDir);
  for (let i = 0; i < 8; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(fromDir, '..', '..');
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface HandleDeps {
  routes: Route[];
  state: ServerState;
  fs: typeof import('node:fs');
  path: typeof import('node:path');
  publicDir: string;
  engineDir: string;
  uiDir: string;
  maxBodyBytes: number;
}

async function handle(req: Incoming, res: Outgoing, deps: HandleDeps): Promise<void> {
  const { fs, path, state } = deps;
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: { code: 'HTTP400', message: 'malformed request URL' } });
  }
  const pathname = decodeURIComponent(url.pathname);

  // Anything a browser might request that this server does not have gets a 404 with
  // a body, so the console dock can say what was missing instead of failing quietly.
  try {
    // The twelve documents are served as they are on disk, with a listing so the
    // Help menu can enumerate them rather than hard-coding a file name list that
    // would drift from the repository.
    if (pathname === '/docs' || pathname === '/docs/') {
      const dir = path.resolve(deps.publicDir, '..', 'docs');
      if (fs.existsSync(dir)) {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .sort();
        const body = `<!doctype html><meta charset="utf-8"><title>CircuitForge documentation</title>
<style>body{background:#14161b;color:#e6e8ee;font:14px Inter,system-ui,sans-serif;padding:32px}a{color:#6cc4ff;display:block;padding:4px 0}h1{font-size:18px}</style>
<h1>CircuitForge documentation</h1>${files.map((f) => `<a href="/docs/${f}">${f}</a>`).join('')}`;
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME['.html']);
        res.end(body);
        return;
      }
    }
    if (pathname.startsWith('/docs/')) {
      const dir = path.resolve(deps.publicDir, '..', 'docs');
      const file = safeResolve(path, dir, pathname.slice('/docs/'.length));
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, fs, file);
    }

    if (pathname.startsWith('/api/')) {
      const route = matchRoute(deps.routes, method, pathname);
      if (!route) return sendJson(res, 404, { error: { code: 'HTTP404', message: `no API route for ${method} ${pathname}` } });
      const body = method === 'POST' ? await readBody(req, deps.maxBodyBytes) : {};
      const ctx: RequestContext = { path: pathname, query: url.searchParams, params: route.params, body, engine: state.engine, state };
      const result = await route.route.handler(ctx);
      return sendJson(res, 200, result ?? { ok: true });
    }

    // Static files: the editor, then the engine modules the editor imports.
    // The editor imports the compiled engine as ES modules, and the engine's barrel
    // re-exports the UI logic from ../ui, so both directories are served: a browser
    // resolving /engine/index.js will ask for /ui/editor.js next to it.
    const roots: Array<{ prefix: string; dir: string }> = [
      { prefix: '/engine/', dir: deps.engineDir },
      { prefix: '/ui/', dir: deps.uiDir },
      { prefix: '/', dir: deps.publicDir },
    ];
    for (const root of roots) {
      if (!pathname.startsWith(root.prefix)) continue;
      const rel = pathname.slice(root.prefix.length) || 'index.html';
      const file = safeResolve(path, root.dir, rel);
      if (!file) return sendJson(res, 400, { error: { code: 'HTTP400', message: 'path escapes the served directory' } });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      return sendFile(res, fs, file);
    }
    return sendJson(res, 404, { error: { code: 'HTTP404', message: `nothing is served at ${pathname}` } });
  } catch (err) {
    return sendJson(res, statusOf(err), errorBody(err));
  }
}

/** Resolve inside a root, refusing anything that walks out of it. */
function safeResolve(path: typeof import('node:path'), root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function matchRoute(routes: Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.names.forEach((n, i) => {
      params[n] = m[i + 1] ?? '';
    });
    return { route, params };
  }
  return null;
}

function readBody(req: Incoming, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on('data', (chunk: unknown) => {
      const buf = chunk as Uint8Array;
      size += buf.length;
      if (size > maxBytes) {
        reject(httpError(413, 'HTTP413', `the request body is larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks as unknown as Uint8Array[]).toString('utf8');
      try {
        const parsed = JSON.parse(text) as unknown;
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed });
      } catch (err) {
        reject(httpError(400, 'HTTP400', `the body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', (err: unknown) => reject(httpError(400, 'HTTP400', String(err))));
  });
}

function sendJson(res: Outgoing, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  // The editor is served from the same origin as the API; a browser extension or a
  // dev proxy may not be, and there is no secret here to protect — every endpoint is
  // a computation over a document the caller supplied.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendFile(res: Outgoing, fs: typeof import('node:fs'), file: string): void {
  const data = fs.readFileSync(file);
  const ext = file.slice(file.lastIndexOf('.'));
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Engine modules are rebuilt between runs; a stale copy in a browser cache is the
  // kind of bug that makes a user doubt a correct result.
  res.setHeader('Cache-Control', ext === '.html' ? 'no-store' : 'no-cache');
  res.end(data);
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A refusal with a reason and, where there is one, a way forward.
 *
 * The hint matters: "400 bad request" tells a caller nothing, while "this would
 * block the event loop — enqueue a job instead" tells them what to do next.
 */
function httpError(status: number, code: string, message: string, hint?: string): HttpError {
  return new HttpError(status, code, message, hint);
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const code = (err as { code?: string })?.code;
  if (typeof code === 'string' && /^CF\d+$/.test(code)) return 422;
  return 500;
}

/** An error body the GUI can show: the engine's own code and message when it has one. */
function errorBody(err: unknown): { error: { code: string; message: string; hint?: string } } {
  if (err instanceof HttpError) return { error: { code: err.code, message: err.message, hint: err.hint } };
  const e = err as { code?: string; message?: string; hint?: string; name?: string };
  const code = typeof e?.code === 'string' ? e.code : 'CF0000';
  const message = e?.message ?? String(err);
  return { error: { code, message, hint: e?.hint } };
}

// ---------------------------------------------------------------------------
// The job queue
// ---------------------------------------------------------------------------

async function createQueue(
  engine: EngineLike,
  dataDir: string,
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  log: (line: string) => void,
): Promise<QueueLike | null> {
  try {
    const jobsDir = path.join(dataDir, 'jobs');
    let storage: unknown;
    try {
      fs.mkdirSync(jobsDir, { recursive: true });
      const FileStorage = engine.FileStorage as new (dir: string) => unknown;
      storage = new FileStorage(jobsDir);
    } catch (err) {
      log(`job checkpoints will stay in memory: ${err instanceof Error ? err.message : String(err)}`);
      const MemoryStorage = engine.MemoryStorage as new () => unknown;
      storage = new MemoryStorage();
    }
    const JobQueue = engine.JobQueue as new (storage: unknown, options: Record<string, unknown>) => QueueLike;
    const queue = new JobQueue(storage, { autoSaveMs: 2000, autoSaveSteps: 50 });
    const makeContext = engine.makeContext as (project?: unknown) => unknown;
    const project = buildServerProject(engine);
    const registerDefaultTasks = engine.registerDefaultTasks as (q: QueueLike, ctx: unknown) => QueueLike;
    registerDefaultTasks(queue, makeContext(project));
    const restored = queue.restore();
    if (restored.jobs > 0 || restored.interrupted.length > 0) {
      log(`job queue restored: ${restored.jobs} job(s), ${restored.history} history entry(ies), ${restored.interrupted.length} interrupted`);
    }
    return queue;
  } catch (err) {
    log(`the job queue could not be started: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** A project holding the reference chips, so jobs can validate and synthesize against them. */
function buildServerProject(engine: EngineLike): unknown {
  try {
    const build = engine.buildReferenceProject as (name: string) => unknown;
    return build('server');
  } catch {
    return undefined;
  }
}

/** Try to open a browser; a sandbox without one is not an error. */
async function openBrowser(url: string, log: (line: string) => void): Promise<void> {
  try {
    const { spawn } = builtin<typeof import('node:child_process')>('node:child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => log(`no browser could be opened (${cmd}); open ${url} yourself`));
    child.unref?.();
  } catch {
    log(`no browser could be opened; open ${url} yourself`);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const get = (p: string, handler: Route['handler']): void => {
    routes.push(route('GET', p, handler));
  };
  const post = (p: string, handler: Route['handler']): void => {
    routes.push(route('POST', p, handler));
  };

  get('/api/health', (ctx) => {
    const e = ctx.engine;
    const about = typeof e.about === 'function' ? e.about() : {};
    // platformSummary() takes a PlatformInfo and returns one line of text; calling it
    // with no argument reads a field of undefined. The structural EngineLike type
    // cannot see that, so the call is spelled out here the way the CLI spells it.
    const detectPlatform = e.detectPlatform as (() => Record<string, unknown>) | undefined;
    const info = detectPlatform ? detectPlatform() : {};
    const summarize = e.platformSummary as ((p: Record<string, unknown>) => string) | undefined;
    const platform = { info, summary: summarize ? summarize(info) : 'unknown' };
    const gpu = typeof e.gpuProbe === 'function' ? (e.gpuProbe as () => Record<string, unknown>)() : {};
    return {
      ok: true,
      version: String(e.VERSION ?? e.ENGINE_VERSION ?? 'unknown'),
      about,
      platform,
      gpu,
      uptimeMs: Date.now() - ctx.state.startedAt,
      requests: ctx.state.requests,
      queue: ctx.state.queue ? ctx.state.queue.queueProgress() : null,
      dataDir: ctx.state.dataDir,
      node: process.version,
    };
  });

  get('/api/library', (ctx) => ({ specs: librarySummary(ctx.engine) }));

  get('/api/chips', (ctx) => ({ chips: referenceChips(ctx.engine) }));

  get('/api/examples', (ctx) => {
    const examples = (ctx.engine.EXAMPLES as Array<Record<string, unknown>>) ?? [];
    return {
      examples: examples.map((x) => ({
        id: x.id,
        name: x.name,
        group: x.group,
        description: x.description,
        level: x.level,
        accuracy: x.accuracy,
        tags: x.tags,
      })),
    };
  });

  get('/api/specs', (ctx) => {
    const build = ctx.engine.buildSpecById as ((id: string, params?: Record<string, unknown>) => Record<string, unknown>) | undefined;
    const ids = ['mux', 'adder', 'subtractor', 'comparator', 'alu_slice', 'and_not', 'majority'];
    const specs: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      try {
        const s = build?.(id, {}) as Record<string, unknown> | undefined;
        if (!s) continue;
        specs.push({
          id,
          name: s.name,
          description: s.description,
          inputs: (s.inputs as Array<Record<string, unknown>>)?.map((p) => ({ name: p.name, width: p.width })),
          outputs: (s.outputs as Array<Record<string, unknown>>)?.map((p) => ({ name: p.name, width: p.width })),
          params: (s.params as Array<Record<string, unknown>>)?.map((p) => ({ id: p.id, label: p.label, kind: p.kind, default: p.default, min: p.min, max: p.max })),
        });
      } catch {
        // A spec that cannot be built without parameters is still listed, so the
        // editor can offer it and ask for the parameter.
        specs.push({ id, name: id, params: [] });
      }
    }
    return { specs };
  });

  get('/api/profiles', (ctx) => {
    const profiles = (ctx.engine.OPTIMIZATION_PROFILES ?? ctx.engine.PROFILES) as Record<string, Record<string, unknown>> | undefined;
    const out: Array<Record<string, unknown>> = [];
    if (profiles) {
      for (const [name, p] of Object.entries(profiles)) {
        out.push({ name, description: p.description, weights: p.weights });
      }
    }
    return { profiles: out };
  });

  // ---- circuit work -------------------------------------------------------

  post('/api/simulate', (ctx) => simulateDocument(ctx));

  post('/api/analyze', (ctx) => {
    const { circuit, lib, chips } = circuitFromBody(ctx);
    const analyzeCircuit = ctx.engine.analyzeCircuit as (c: unknown, l: unknown, ch: unknown) => Record<string, unknown>;
    return { analysis: analyzeCircuit(circuit, lib, chips) };
  });

  /**
   * Mine a sheet for the subcircuits it repeats.
   *
   * The report is the engine's own, unchanged: what each block looks like, how many
   * times it occurs, what it computes (measured, not assumed), and which library chip
   * computes the same thing. With `replace: true` the identical matches are substituted
   * and the answer carries the rewritten circuit document, how many occurrences were
   * replaced, and every one that was skipped with the reason — an occurrence inside a
   * chip expansion belongs to another sheet and is never edited from here. A *near*
   * match is reported with the number of rows that differ and is never substituted:
   * asking to replace one is a 409, not a silent approximation.
   */
  post('/api/mine', (ctx) => {
    const body = ctx.body;
    const e = ctx.engine;
    const { circuit, lib, chips } = circuitFromBody(ctx);
    const mining = e.mining as
      | {
          mineSubcircuits: (
            c: unknown,
            l: unknown,
            ch: unknown,
            o: Record<string, unknown>,
          ) => {
            patterns: Array<{
              id: string;
              description: string;
              count: number;
              size: number;
              inputs: number;
              outputs: number;
              matchedChip: { id: string; identical: boolean; differingRows: number } | null;
              suggestedChip: { id: string; name: string } | null;
              saving: { replaceable: number; componentsTotal: number };
            }>;
            matched: number;
          };
          replacePatternWithChip: (
            c: unknown,
            l: unknown,
            ch: unknown,
            pattern: unknown,
            o: Record<string, unknown>,
          ) => Record<string, unknown> & { circuit: unknown; replaced: number; skipped: Array<{ occurrence: number; reason: string }> };
        }
      | undefined;
    if (!mining) {
      throw httpError(501, 'CF501', 'this engine build does not expose the subcircuit miner', 'Rebuild the engine with `npm run build`; the miner lives in src/engine/mining.');
    }
    const whole = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback);
    const report = mining.mineSubcircuits(circuit, lib, chips, {
      depth: whole(body.depth, 3),
      minOccurrences: whole(body.minOccurrences, 2),
      maxPatterns: whole(body.maxPatterns, 24),
      maxPatternInputs: whole(body.maxPatternInputs, 5),
      maxPatternSize: whole(body.maxPatternSize, 12),
      measure: body.measure !== false,
      matchChips: body.matchChips !== false,
    });

    const out: Record<string, unknown> = { report };
    if (body.replace === true) {
      const wanted = typeof body.pattern === 'string' && body.pattern.length > 0 ? body.pattern : undefined;
      const pattern = wanted ? report.patterns.find((p) => p.id === wanted) : report.patterns.find((p) => p.matchedChip?.identical === true);
      if (!pattern) {
        throw httpError(
          409,
          'CF409',
          wanted ? `this report has no pattern with id "${wanted}"` : 'no pattern in this sheet matched a library chip identically, so there is nothing to substitute',
          'A near match is reported with the number of truth-table rows that differ, and is never replaced automatically: save it as a new chip instead.',
        );
      }
      const result = mining.replacePatternWithChip(circuit, lib, chips, pattern, {
        chipId: typeof body.chip === 'string' && body.chip.length > 0 ? body.chip : undefined,
        limit: typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.max(0, Math.round(body.limit)) : undefined,
      });
      const toDocument = e.circuitToDocument as ((c: unknown) => unknown) | undefined;
      out.replacement = {
        patternId: pattern.id,
        description: pattern.description,
        chipId: result.chipId,
        replaced: result.replaced,
        skipped: result.skipped,
        componentsBefore: result.componentsBefore,
        componentsAfter: result.componentsAfter,
        netsBefore: result.netsBefore,
        netsAfter: result.netsAfter,
        diagnostics: result.diagnostics,
        notes: result.notes,
        document: toDocument ? toDocument(result.circuit) : null,
      };
    }
    return out;
  });

  post('/api/validate', (ctx) => {
    const body = ctx.body;
    const lib = defaultLibrary(ctx);
    const chips = chipLibraryOf(ctx, body);
    let chip: unknown;
    if (typeof body.chip === 'string') {
      chip = (chips as { get(id: string): unknown }).get(body.chip);
      if (!chip) throw httpError(404, 'CF404', `no chip named "${body.chip}" in the project`);
    } else if (body.chip && typeof body.chip === 'object') {
      chip = body.chip;
    } else {
      const { circuit } = circuitFromBody(ctx);
      chip = { id: 'adhoc', name: 'Ad hoc', version: '1.0.0', description: 'validated from a document', ports: [], params: [], implementation: () => circuit };
    }
    const spec = typeof body.spec === 'string' ? (ctx.engine.buildSpecById as (id: string, p?: unknown) => unknown)(body.spec, body.params ?? {}) : undefined;
    const validateChip = ctx.engine.validateChip as (chip: unknown, opts: Record<string, unknown>) => Record<string, unknown>;
    return { validation: validateChip(chip, { lib, chips, spec, params: body.params ?? {}, seed: body.seed ?? 1234, levels: body.levels }) };
  });

  post('/api/optimize', (ctx) => {
    const body = ctx.body;
    const lib = defaultLibrary(ctx);
    const chips = chipLibraryOf(ctx, body);
    const buildSpecById = ctx.engine.buildSpecById as (id: string, params?: Record<string, unknown>) => Record<string, unknown>;
    const specId = String(body.spec ?? 'and_not');
    const spec = buildSpecById(specId, (body.params ?? {}) as Record<string, unknown>);
    const Optimizer = ctx.engine.Optimizer as new (req: Record<string, unknown>) => {
      run(): void;
      report(): Record<string, unknown>;
      why(): Record<string, unknown>;
      buildBest(): unknown;
    };
    const budget = budgetOf(body);
    // run() is synchronous and holds the event loop, so a large budget is refused
    // here rather than freezing the editor for everyone: long searches belong in the
    // job queue, which checkpoints, reports progress and survives a closed tab.
    const evaluations = Number(budget.evaluations ?? 0);
    if (evaluations > 5000) {
      throw httpError(400, 'CF400', `${evaluations} evaluations would block this server's event loop`, 'POST /api/jobs/enqueue with kind "optimize" instead: it runs in slices, reports progress and can be paused, resumed or cancelled.');
    }
    const opt = new Optimizer({
      spec,
      lib,
      chips,
      name: body.name ?? `${specId}_server`,
      profile: body.profile ?? 'BALANCED',
      weights: body.weights,
      seed: body.seed ?? 1234,
      populationSize: body.population ?? 24,
      budget,
      detailTop: body.detailTop ?? 3,
      seeds: body.seeds ?? 'auto',
    });
    opt.run();
    const circuitToDocument = ctx.engine.circuitToDocument as (c: unknown) => Record<string, unknown>;
    const best = opt.buildBest();
    return {
      report: opt.report(),
      why: opt.why(),
      document: best ? circuitToDocument(best) : null,
    };
  });

  post('/api/synth', (ctx) => {
    // Reverse engineering: a behavioural specification becomes an architecture, an
    // optimized implementation, a validation report and a saved chip. The same path
    // the CLI's `synth` verb takes, so a GUI result and a CLI result agree.
    const body = ctx.body;
    const lib = defaultLibrary(ctx);
    const chips = chipLibraryOf(ctx, body);
    const buildSpecById = ctx.engine.buildSpecById as (id: string, params?: Record<string, unknown>) => Record<string, unknown>;
    const specId = String(body.spec ?? 'mux');
    const spec = buildSpecById(specId, (body.params ?? {}) as Record<string, unknown>);
    const Optimizer = ctx.engine.Optimizer as new (req: Record<string, unknown>) => {
      run(): void;
      report(): Record<string, unknown>;
      why(): Record<string, unknown>;
      buildBest(): unknown;
      saveBestAsChip(opts?: Record<string, unknown>): unknown;
    };
    const synthBudget = budgetOf(body);
    if (Number(synthBudget.evaluations ?? 0) > 5000) {
      throw httpError(400, 'CF400', `${synthBudget.evaluations} evaluations would block this server's event loop`, 'POST /api/jobs/enqueue with kind "optimize" and saveAsChip: true instead.');
    }
    const opt = new Optimizer({
      spec,
      lib,
      chips,
      name: String(body.name ?? `${specId}_synth`),
      profile: body.profile ?? 'BALANCED',
      seed: body.seed ?? 1234,
      populationSize: body.population ?? 24,
      budget: synthBudget,
      detailTop: body.detailTop ?? 3,
    });
    opt.run();
    {
      const validateChip = ctx.engine.validateChip as (chip: unknown, opts: Record<string, unknown>) => Record<string, unknown>;
      const projectToDocument = ctx.engine.projectToDocument as (p: unknown) => Record<string, unknown>;
      const chip = opt.saveBestAsChip({ chips, lib });
      let validation: Record<string, unknown> | null = null;
      if (chip) {
        try {
          validation = validateChip(chip, { lib, chips, spec, params: body.params ?? {}, seed: body.seed ?? 1234 });
        } catch (err) {
          validation = { error: errorBody(err).error };
        }
      }
      return { report: opt.report(), why: opt.why(), chip, validation, project: chip ? projectToDocument(chipsProjectOf(ctx, chips)) : null };
    }
  });

  post('/api/export', (ctx) => {
    const body = ctx.body;
    const format = String(body.format ?? 'spice');
    const { circuit, lib, chips } = circuitFromBody(ctx);
    const e = ctx.engine;
    const params = (body.params ?? {}) as Record<string, unknown>;
    switch (format) {
      case 'spice': {
        // The SPICE exporter writes the netlist the simulator would run, so it takes
        // a flattened netlist, not a circuit: exporting a chip instance as one line
        // would hide every element inside it.
        const flatten = e.flatten as (c: unknown, l: unknown, ch: unknown, o?: Record<string, unknown>) => unknown;
        const nl = flatten(circuit, lib, chips, { expandGates: params.expandGates === true, ambient: Number(params.ambient ?? 25), metadata: true });
        const text = (e.exportSpiceNetlist as (n: unknown, o?: Record<string, unknown>) => string)(nl, {
          title: `${String((circuit as { name?: string }).name ?? 'circuit')} — exported by CircuitForge`,
        });
        return { format, text };
      }
      case 'json':
        return { format, text: JSON.stringify((e.circuitToDocument as (c: unknown) => unknown)(circuit), null, 2) };
      case 'bom':
        return { format, text: JSON.stringify((e.buildBomFromCircuit as (c: unknown, l: unknown) => unknown)(circuit, lib), null, 2) };
      case 'schematic':
      case 'schematic-hierarchical':
        return { format, text: JSON.stringify((e.exportSchematicHierarchical as (c: unknown, l: unknown) => unknown)(circuit, lib), null, 2) };
      case 'svg': {
        const render = e.render as Record<string, unknown>;
        const layoutCircuit = render.layoutCircuit as (c: unknown, l: unknown, ch: unknown, o?: unknown) => Record<string, unknown>;
        const renderCircuitToSvg = render.renderCircuitToSvg as (c: unknown, l: unknown, ch: unknown, o?: unknown) => { svg: string };
        const layout = layoutCircuit(circuit, lib, chips, { level: params.level ?? 'hierarchical' });
        const viewport = { width: Number(params.width ?? 1600), height: Number(params.height ?? 1000) };
        const fitBounds = render.fitBounds as (b: unknown, v: unknown, p?: number) => unknown;
        return { format: 'svg', text: renderCircuitToSvg(circuit, lib, chips, { viewport, view: fitBounds(layout.bounds, viewport, 40), level: params.level ?? 'hierarchical' }).svg };
      }
      default:
        throw httpError(400, 'CF400', `unknown export format "${format}"`);
    }
  });

  // ---- projects on disk ---------------------------------------------------

  post('/api/project/save', (ctx) => {
    const fs = builtin<typeof import('node:fs')>('node:fs');
    const path = builtin<typeof import('node:path')>('node:path');
    const file = String(ctx.body.file ?? '');
    const document = ctx.body.document;
    if (!file) throw httpError(400, 'CF400', 'a file name is required');
    if (!document || typeof document !== 'object') throw httpError(400, 'CF400', 'a project document is required');
    const target = projectPath(ctx, path, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document, null, 2), 'utf8');
    return { ok: true, file: path.relative(ctx.state.dataDir, target), bytes: fs.statSync(target).size };
  });

  post('/api/project/open', (ctx) => {
    const fs = builtin<typeof import('node:fs')>('node:fs');
    const path = builtin<typeof import('node:path')>('node:path');
    const file = String(ctx.body.file ?? '');
    if (!file) throw httpError(400, 'CF400', 'a file name is required');
    const target = projectPath(ctx, path, file);
    if (!fs.existsSync(target)) throw httpError(404, 'CF404', `no project file at ${file}`);
    const text = fs.readFileSync(target, 'utf8');
    return { file: path.relative(ctx.state.dataDir, target), bytes: text.length, document: JSON.parse(text) };
  });

  get('/api/projects', (ctx) => {
    const fs = builtin<typeof import('node:fs')>('node:fs');
    const path = builtin<typeof import('node:path')>('node:path');
    const dir = ctx.state.dataDir;
    const out: Array<{ file: string; bytes: number; modifiedAt: string }> = [];
    if (fs.existsSync(dir)) {
      const walk = (d: string, depth: number): void => {
        if (depth > 4) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'jobs') walk(full, depth + 1);
          } else if (/\.cfproj\.json$|\.cfcircuit\.json$/.test(entry.name)) {
            const st = fs.statSync(full);
            out.push({ file: path.relative(dir, full), bytes: st.size, modifiedAt: st.mtime.toISOString() });
          }
        }
      };
      walk(dir, 0);
    }
    return { dataDir: dir, projects: out.sort((a, b) => a.file.localeCompare(b.file)) };
  });

  // ---- jobs ---------------------------------------------------------------

  get('/api/jobs', (ctx) => {
    const q = requireQueue(ctx);
    return { progress: q.queueProgress(), snapshot: q.snapshot(), interrupted: q.detectInterrupted() };
  });

  post('/api/jobs/enqueue', (ctx) => {
    const q = requireQueue(ctx);
    const kind = String(ctx.body.kind ?? 'optimize');
    const name = String(ctx.body.name ?? kind);
    const job = q.enqueue(kind, name, (ctx.body.spec ?? {}) as Record<string, unknown>, {
      priority: Number(ctx.body.priority ?? 0),
    } as Record<string, unknown>);
    return { job };
  });

  post('/api/jobs/:id/pause', (ctx) => ({ ok: requireQueue(ctx).pause(ctx.params.id) }));
  post('/api/jobs/:id/resume', (ctx) => ({ ok: requireQueue(ctx).resume(String(ctx.params.id)) }));
  post('/api/jobs/:id/cancel', (ctx) => ({ ok: requireQueue(ctx).cancel(String(ctx.params.id)) }));
  post('/api/jobs/:id/priority', (ctx) => ({ ok: requireQueue(ctx).setPriority(String(ctx.params.id), Number(ctx.body.priority ?? 0)) }));
  post('/api/jobs/:id/reorder', (ctx) => ({ ok: requireQueue(ctx).reorder(String(ctx.params.id), Number(ctx.body.index ?? 0)) }));
  post('/api/jobs/:id/resume-interrupted', (ctx) => ({ ok: requireQueue(ctx).resumeInterrupted(String(ctx.params.id)) }));
  get('/api/jobs/history', (ctx) => ({ history: requireQueue(ctx).historyEntries(Number(ctx.query.get('limit') ?? 50)) }));

  // ---- benchmarks ---------------------------------------------------------

  get('/api/benchmark', (ctx) => {
    const runBenchmarkSuite = ctx.engine.runBenchmarkSuite as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const suite = ctx.query.get('suite') ?? 'quick';
    const repeats = Number(ctx.query.get('repeats') ?? 1);
    const sizes = (ctx.query.get('size') ?? '').split(',').filter(Boolean).map(Number);
    return runBenchmarkSuite({ suite, repeats, quiet: true, sizes: sizes.length > 0 ? sizes : undefined });
  });

  return routes;
}

function route(method: 'GET' | 'POST', p: string, handler: Route['handler']): Route {
  const names: string[] = [];
  const pattern = new RegExp(
    '^' +
      p
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '/?$',
  );
  return { method, pattern, names, handler };
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function requireQueue(ctx: RequestContext): QueueLike {
  if (!ctx.state.queue) throw httpError(503, 'CF503', 'the job queue is not running on this server; see the server log for why');
  return ctx.state.queue;
}

function projectPath(ctx: RequestContext, path: typeof import('node:path'), file: string): string {
  const dir = ctx.state.dataDir;
  const target = safeResolve(path, dir, file);
  if (!target) throw httpError(400, 'CF400', 'the file name escapes the data directory');
  return target;
}

function defaultLibrary(ctx: RequestContext): unknown {
  const create = ctx.engine.createDefaultLibrary as () => unknown;
  return create();
}

/** The chip library a request should work against: the reference project, unless the
 * request carries its own chips. */
function chipLibraryOf(ctx: RequestContext, body: Record<string, unknown>): unknown {
  const e = ctx.engine;
  if (Array.isArray(body.chips) && body.chips.length > 0) {
    const ChipLibrary = e.ChipLibrary as new () => { add(chip: unknown): unknown };
    const lib = new ChipLibrary();
    for (const chip of body.chips) lib.add(chip);
    return lib;
  }
  const build = e.buildReferenceProject as (name: string) => { chips: unknown };
  return build('server').chips;
}

function chipsProjectOf(ctx: RequestContext, chips: unknown): unknown {
  const Project = ctx.engine.Project as new (name: string, lib: unknown, chips: unknown) => unknown;
  return new Project('server', defaultLibrary(ctx), chips);
}

function budgetOf(body: Record<string, unknown>): Record<string, unknown> {
  const budget = body.budget;
  if (budget && typeof budget === 'object') return budget as Record<string, unknown>;
  // A bare number used to mean "evaluations" and, taken literally as a budget
  // object, produced an unbounded search. Numbers are mapped explicitly.
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) return { evaluations: budget };
  return { evaluations: Number(body.evaluations ?? 400), seconds: Number(body.seconds ?? 120) };
}

/** Rebuild a circuit from a posted document, which is what every /api route takes. */
/**
 * A component library and a chip library that know each other.
 *
 * These have to be built as a pair. Placing a chip on a sheet needs that chip's
 * component spec in the library, and a default library carries only primitives — so a
 * request that arrives with a document and no chips of its own is answered with the
 * reference project's two libraries, which are in sync by construction. A request that
 * brings its own chips gets their specs registered into a fresh library, for the same
 * reason. Getting this wrong is not loud: the work simply refuses to place anything.
 */
function libraryPair(ctx: RequestContext, body: Record<string, unknown>): { lib: unknown; chips: unknown } {
  const e = ctx.engine;
  const build = e.buildReferenceProject as (name: string) => { lib: unknown; chips: unknown };
  if (Array.isArray(body.chips) && body.chips.length > 0) {
    const ChipLibrary = e.ChipLibrary as new () => { add(chip: unknown): unknown };
    const chips = new ChipLibrary();
    for (const chip of body.chips) chips.add(chip);
    const lib = defaultLibrary(ctx) as {
      register(spec: unknown): void;
      get(id: string): unknown;
    };
    const chipSpec = e.chipSpec as
      | ((chipId: string, name: string, description: string, ports: readonly unknown[], params?: unknown) => unknown)
      | undefined;
    if (chipSpec) {
      for (const raw of body.chips as Array<Record<string, unknown>>) {
        const def = (raw.def ?? raw) as Record<string, unknown>;
        const id = String(def.id ?? raw.id ?? '');
        if (!id || lib.get(id)) continue;
        lib.register(chipSpec(id, String(def.name ?? id), String(def.description ?? ''), (def.ports ?? []) as unknown[], def.params ?? []));
      }
    }
    return { lib, chips };
  }
  const project = build('server');
  return { lib: project.lib, chips: project.chips };
}

function circuitFromBody(ctx: RequestContext): { circuit: unknown; lib: unknown; chips: unknown } {
  const e = ctx.engine;
  const document = ctx.body.document;
  if (!document || typeof document !== 'object') throw httpError(400, 'CF400', 'the request needs a circuit document');
  const { lib, chips } = libraryPair(ctx, ctx.body);
  const fromDocument = e.circuitFromDocument as (doc: unknown, lib: unknown, chips: unknown) => { circuit: unknown; diagnostics: unknown[] };
  const result = fromDocument(document, lib, chips);
  return { circuit: result.circuit, lib, chips };
}

/** The component library, reduced to what an editor palette needs. */
function librarySummary(engine: EngineLike): Array<Record<string, unknown>> {
  const lib = (engine.createDefaultLibrary as () => { all(): Array<Record<string, unknown>> })();
  return lib.all().map((spec) => ({
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    refPrefix: spec.refPrefix,
    pins: (spec.pins as Array<Record<string, unknown>>)?.map((p) => ({
      name: p.name,
      direction: p.direction,
      width: p.width ?? 1,
      optional: p.optional ?? false,
      description: p.description,
    })),
    params: (spec.params as Array<Record<string, unknown>>)?.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      default: p.default,
      min: p.min,
      max: p.max,
      step: p.step,
      unit: p.unit,
      options: p.options,
      description: p.description,
    })),
    accuracy: spec.accuracy,
    support: spec.support,
  }));
}

/** The reference chip library: what the "open a reference design" menu lists. */
function referenceChips(engine: EngineLike): Array<Record<string, unknown>> {
  // ChipLibrary has no ids(): all() is the enumeration, and each chip carries its own
  // definition, so the list is built from the definitions rather than from keys.
  const project = (engine.buildReferenceProject as (name: string) => { chips: { all(): Array<{ def: Record<string, unknown> }> } })('server');
  return project.chips.all().map((chip) => {
    const def = (chip.def ?? chip) as Record<string, unknown>;
    const id = String(def.id ?? '');
    return {
      id,
      name: def.name,
      version: def.version,
      description: def.description,
      ports: def.ports,
      params: def.params,
      metrics: def.metrics,
    };
  });
}

/**
 * Simulate a posted document.
 *
 * The levels asked for are the levels run: `0` settles the logic and reports a truth
 * table, `1` adds the DC operating point and a transient sweep, `3` adds the thermal
 * steady state. Accuracy is reported per model, from the library declarations, so the
 * answer says what it is and what it is not.
 */
function simulateDocument(ctx: RequestContext): Record<string, unknown> {
  const e = ctx.engine;
  const { circuit, lib, chips } = circuitFromBody(ctx);
  const body = ctx.body;
  const levels = new Set(Array.isArray(body.levels) ? (body.levels as number[]) : [0, 1]);
  const ambient = Number(body.ambient ?? 25);
  const flatten = e.flatten as (c: unknown, l: unknown, ch: unknown, o?: Record<string, unknown>) => Record<string, unknown>;
  const nl = flatten(circuit, lib, chips, { expandGates: body.expandGates === true, ambient, thermal: levels.has(3), metadata: true });
  const netlistStats = e.netlistStats as (n: unknown) => Record<string, unknown>;
  const out: Record<string, unknown> = { netlist: netlistStats(nl) };

  const CircuitSimulator = e.CircuitSimulator as new (n: unknown, o?: Record<string, unknown>) => {
    dcSolve(o?: Record<string, unknown>): Record<string, unknown>;
    transient(tstop: number, reqs: unknown, o?: Record<string, unknown>): Record<string, unknown>;
    solveThermalSteadyState(): Record<string, unknown>;
    powers(): unknown;
    v: Float64Array;
  };

  if (levels.has(1) || levels.has(3)) {
    const sim = new CircuitSimulator(nl, { ambient });
    const dc = sim.dcSolve({ quiet: true });
    const nodeNameAt = e.nodeNameAt as (n: unknown, i: number) => string;
    const nodeCount = Number((nl as { nodeCount?: number }).nodeCount ?? 0);
    const voltages: Array<{ node: number; name: string; voltage: number }> = [];
    for (let i = 0; i < nodeCount; i++) {
      voltages.push({ node: i, name: nodeNameAt(nl, i), voltage: sim.v[i] ?? 0 });
    }
    out.dc = {
      converged: dc.converged,
      iterations: dc.iterations,
      residual: dc.residual,
      voltages,
      // circuitStats() takes the netlist and the *solved simulator* as an option:
      // the simulator is the only source of power and temperature, and passing it as
      // the first argument reads a netlist field off an object that has none.
      totalPower: totalDissipatedOf(e, nl, sim, lib),
      electrical: electricalStatsOf(e, nl, sim, lib),
    };
    if (levels.has(3)) {
      const thermal = sim.solveThermalSteadyState();
      out.thermal = thermal;
    }
    const tstop = Number(body.tstop ?? 0);
    if (tstop > 0) {
      const requests = Array.isArray(body.probes) ? body.probes : [];
      const tran = sim.transient(tstop, requests, {
        maxSamples: Number(body.maxSamples ?? 2000),
        maxStep: body.maxStep === undefined ? undefined : Number(body.maxStep),
        outputInterval: body.outputInterval === undefined ? undefined : Number(body.outputInterval),
      });
      out.transient = tran;
    }
  }

  if (levels.has(0)) {
    out.logic = logicTable(ctx, nl, body);
  }

  // reportAccuracy() summarises a *validation* report, which this route does not
  // produce, so the accuracy here is what the models on this sheet declare, level by
  // level. A declaration is not a measurement of this design, and saying so is the
  // point of including the note.
  out.accuracy = {
    levelsRun: [...levels].sort((a, b) => a - b),
    declared: declaredAccuracyOf(nl, lib),
    weakest: weakestDeclared(nl, lib),
    note: 'Accuracy classes are declared by each model, not measured on this design. A level that was not run reports nothing.',
  };
  return out;
}

/**
 * Settle the logic and report a truth table over the sheet's inputs.
 *
 * The level-0 engine is bit-parallel: one settle evaluates 32 input vectors at once,
 * so the table is built by encoding combination k into lane k of every input and
 * settling once. `drive()` and `word()` take *node indices*, not net names — passing
 * a name is silently ignored, which produces a table of X that reads as "this design
 * does not work" instead of as a mistake in the caller.
 *
 * More than five inputs cannot be shown exhaustively in 32 lanes, and the table says
 * so rather than pretending to be complete.
 */
function logicTable(ctx: RequestContext, nl: unknown, body: Record<string, unknown>): Record<string, unknown> {
  const e = ctx.engine;
  const buildLogicGraph = e.buildLogicGraph as (n: unknown) => unknown;
  const graph = buildLogicGraph(nl) as {
    inputs: number[];
    outputs: number[];
    netName(node: number): string;
    elements: unknown[];
    stats?: { gates?: number; sequential?: number; levels?: number; loops?: number };
    loopElements?: unknown[];
    diagnostics?: Array<{ code: string; severity: string; message: string }>;
  };
  // settle() and run() return nothing: level 0 iterates to a fixed point and reports
  // what it found through the graph's own diagnostics, not through a result object.
  const LogicVectorSim = e.LogicVectorSim as new (g: unknown, o?: Record<string, unknown>) => {
    drive(node: number, ones: number, unknown?: number): void;
    release(node: number): void;
    settle(): void;
    run(ticks?: number): void;
    /** 0 and 1 come back as numbers, X and Z as strings; both are normalized. */
    sample(node: number, lane: number): string | number;
    word(node: number): string;
  };
  const sim = new LogicVectorSim(graph, { loopIterations: Number(body.loopIterations ?? 8) });

  const uniq = (nodes: number[]): number[] => {
    const out: number[] = [];
    for (const n of nodes ?? []) if (!out.includes(n)) out.push(n);
    return out;
  };
  const nameOf = (n: number): string => {
    const name = graph.netName(n);
    return name && !name.startsWith('#') ? name : `node${n}`;
  };
  const inputNodes = Array.isArray(body.inputNodes) ? (body.inputNodes as number[]) : uniq(graph.inputs);
  const outputNodes = Array.isArray(body.outputNodes) ? (body.outputNodes as number[]) : uniq(graph.outputs);

  const lanes = Math.min(32, 1 << Math.min(inputNodes.length, 5));
  const truncated = inputNodes.length > 5;
  for (let i = 0; i < inputNodes.length; i++) {
    let ones = 0;
    for (let k = 0; k < lanes; k++) if (((k >> i) & 1) === 1) ones |= 1 << k;
    sim.drive(inputNodes[i], ones >>> 0, 0);
  }
  sim.settle();
  const rows: Array<Record<string, string>> = [];
  for (let k = 0; k < lanes; k++) {
    const row: Record<string, string> = {};
    inputNodes.forEach((n, i) => {
      row[nameOf(n)] = String((k >> i) & 1);
    });
    for (const n of outputNodes) row[nameOf(n)] = String(sim.sample(n, k));
    rows.push(row);
  }
  // A second pass with every input at 0 gives the sheet's idle state, which is what
  // the editor colours when nothing is being driven.
  for (const n of inputNodes) sim.drive(n, 0, 0);
  sim.settle();
  const idle: Record<string, string> = {};
  for (const n of [...inputNodes, ...outputNodes]) idle[nameOf(n)] = String(sim.sample(n, 0));

  return {
    inputs: inputNodes.map(nameOf),
    outputs: outputNodes.map(nameOf),
    rows,
    idle,
    lanes,
    truncated,
    stats: graph.stats ?? null,
    elements: graph.elements.length,
    loops: (graph.loopElements ?? []).length,
    diagnostics: (graph.diagnostics ?? []).map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    note: truncated
      ? `Only ${lanes} of ${1 << inputNodes.length} input combinations are shown: 32 lanes is what one settle evaluates. The simulation itself is not truncated.`
      : undefined,
  };
}

/**
 * The level-1 power split, straight from the statistics pass.
 *
 * `analogElements` and `digitalElements` are reported alongside the totals because a
 * sheet of digital primitives dissipates nothing in level 1 — there is no analogue
 * element to compute a current through — and a bare `0 W` would read as a failure to
 * measure rather than as the correct answer for that sheet.
 */
function electricalStatsOf(engine: EngineLike, nl: unknown, sim: unknown, lib: unknown): Record<string, unknown> | null {
  const stats = engine.circuitStats as ((n: unknown, o: Record<string, unknown>) => { stats?: { electrical?: Record<string, unknown> } }) | undefined;
  if (!stats) return null;
  try {
    return stats(nl, { sim, lib }).stats?.electrical ?? null;
  } catch {
    return null;
  }
}

/** The weakest accuracy class declared by any model in the netlist. */
function weakestDeclared(nl: unknown, lib: unknown): string | null {
  const order = ['NOT_MODELED', 'IDEALIZED', 'APPROXIMATED', 'REALISTIC'];
  let weakest: string | null = null;
  for (const entry of declaredAccuracyOf(nl, lib)) {
    // `accuracy` is the Accuracy enum value itself — a string — with the per-claim
    // levels carried separately in `model.claims`.
    const raw = entry.accuracy as string | { class?: string } | null;
    const level = typeof raw === 'string' ? raw : String((raw as { class?: string } | null)?.class ?? '');
    if (!level) continue;
    if (weakest === null || order.indexOf(level) < order.indexOf(weakest)) weakest = level;
  }
  return weakest;
}

/** Total power absorbed, from the solved simulator; null when it cannot be computed. */
function totalDissipatedOf(engine: EngineLike, nl: unknown, sim: unknown, lib: unknown): number | null {
  const stats = engine.circuitStats as ((n: unknown, o: Record<string, unknown>) => { stats?: { electrical?: { totalDissipated?: number; analogElements?: number } } }) | undefined;
  if (!stats) return null;
  try {
    const electrical = stats(nl, { sim, lib }).stats?.electrical;
    const value = electrical?.totalDissipated;
    // A purely digital sheet dissipates nothing in level 1: there is no analogue
    // element to compute a power from. Zero is the measured answer, not a gap.
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    // A sheet the statistics pass cannot handle (no analogue element, no solved
    // simulator) reports nothing rather than a number that would be invented.
    return null;
  }
}

/** The accuracy classes the models in this netlist declare, so an answer carries its
 * own caveat instead of the caller having to guess it. */
function declaredAccuracyOf(nl: unknown, lib: unknown): Array<Record<string, unknown>> {
  try {
    const library = lib as { get(id: string): Record<string, unknown> | undefined };
    const netlist = nl as { instances?: Array<{ specId?: string; ref?: string }> };
    const seen = new Map<string, Record<string, unknown>>();
    for (const inst of netlist.instances ?? []) {
      const id = inst.specId;
      if (!id || seen.has(id)) continue;
      const spec = library.get(id);
      if (!spec) continue;
      const accuracy = spec.accuracy as string | undefined;
      const model = spec.model as { family?: string; version?: string; claims?: Array<{ phenomenon: string; level: string; detail: string }> } | undefined;
      if (accuracy || model) {
        seen.set(id, {
          type: id,
          name: spec.name,
          instances: (netlist.instances ?? []).filter((i) => i.specId === id).length,
          accuracy: accuracy ?? null,
          model: model ? { family: model.family, version: model.version, claims: model.claims } : null,
        });
      }
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}
