/**
 * Talking to the server.
 *
 * Thin on purpose: relative URLs only (the page may be served through a proxy under
 * any host), JSON in and out, and every failure surfaced as an `ApiError` carrying
 * the engine's own diagnostic code so the console can print `CF4005: …` instead of a
 * generic "request failed".
 *
 * What goes over HTTP and what does not is a deliberate split. Editing and simulating
 * happen in the browser against the same engine module the CLI uses, because a
 * round trip per click would make the editor feel broken. The server owns the two
 * things a browser cannot: files on disk, and long jobs that must survive a closed
 * tab — which is why saving, opening and the job queue are the endpoints that matter.
 */

export class ApiError extends Error {
  constructor(code, message, hint, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    throw new ApiError('NET', `cannot reach the server at ${path}: ${err && err.message ? err.message : String(err)}`, 'Is `circuitforge serve` still running?', 0);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  if (!response.ok) {
    const error = (payload && payload.error) || {};
    throw new ApiError(error.code || `HTTP${response.status}`, error.message || text || response.statusText, error.hint, response.status);
  }
  return payload;
}

export function get(path) {
  return request(path, { method: 'GET', headers: { accept: 'application/json' } });
}

export function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  health: () => get('/api/health'),
  library: () => get('/api/library'),
  chips: () => get('/api/chips'),
  examples: () => get('/api/examples'),
  specs: () => get('/api/specs'),
  profiles: () => get('/api/profiles'),
  projects: () => get('/api/projects'),
  openProject: (file) => post('/api/project/open', { file }),
  saveProject: (file, document) => post('/api/project/save', { file, document }),
  simulate: (document, opts) => post('/api/simulate', { document, ...opts }),
  analyze: (document) => post('/api/analyze', { document }),
  validate: (body) => post('/api/validate', body),
  optimize: (body) => post('/api/optimize', body),
  synth: (body) => post('/api/synth', body),
  exportAs: (document, format, params) => post('/api/export', { document, format, params }),
  jobs: () => get('/api/jobs'),
  jobHistory: (limit = 50) => get(`/api/jobs/history?limit=${limit}`),
  enqueue: (kind, name, spec, priority = 0) => post('/api/jobs/enqueue', { kind, name, spec, priority }),
  pauseJob: (id) => post(`/api/jobs/${encodeURIComponent(id)}/pause`, {}),
  resumeJob: (id) => post(`/api/jobs/${encodeURIComponent(id)}/resume`, {}),
  cancelJob: (id) => post(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
  priorityJob: (id, priority) => post(`/api/jobs/${encodeURIComponent(id)}/priority`, { priority }),
  reorderJob: (id, index) => post(`/api/jobs/${encodeURIComponent(id)}/reorder`, { index }),
  resumeInterrupted: (id) => post(`/api/jobs/${encodeURIComponent(id)}/resume-interrupted`, {}),
  benchmark: (suite = 'quick', repeats = 1) => get(`/api/benchmark?suite=${encodeURIComponent(suite)}&repeats=${repeats}`),
};

/** Offer a text document to the browser as a download. */
export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}

// ---------------------------------------------------------------------------
// Formatting shared by the panels
// ---------------------------------------------------------------------------

const SI = [
  { f: 1e12, s: 'T' },
  { f: 1e9, s: 'G' },
  { f: 1e6, s: 'M' },
  { f: 1e3, s: 'k' },
  { f: 1, s: '' },
  { f: 1e-3, s: 'm' },
  { f: 1e-6, s: 'µ' },
  { f: 1e-9, s: 'n' },
  { f: 1e-12, s: 'p' },
  { f: 1e-15, s: 'f' },
];

/** An engineering-formatted quantity: 4.7e-9 with unit "A" reads "4.70 nA". */
export function eng(value, unit = '', digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return `0${unit ? ` ${unit}` : ''}`;
  const abs = Math.abs(value);
  for (const step of SI) {
    if (abs >= step.f) {
      const scaled = value / step.f;
      const text = Math.abs(scaled) >= 100 ? scaled.toFixed(Math.max(0, digits - 3)) : scaled.toPrecision(digits);
      return `${text.replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m))} ${step.s}${unit}`.trim();
    }
  }
  const last = SI[SI.length - 1];
  return `${(value / last.f).toPrecision(digits)} ${last.s}${unit}`.trim();
}

export function fmtNumber(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}.${String(Math.floor((ms % 1000) / 100))}s`;
}

export function pct(part, whole, digits = 1) {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(digits)} %`;
}

/** Escape text going into innerHTML; every value from the engine is untrusted here. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
