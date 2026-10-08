/**
 * Platform capability probing.
 *
 * The engine must run identically with or without a GPU and with any number of
 * cores. This module reports *what is actually available*, and — importantly —
 * `gpu.enabled` starts as `false` and is only turned on after a benchmark has
 * measured that the GPU path is actually faster on this machine. CircuitForge
 * never claims GPU acceleration it did not measure (spec §14).
 */

export interface CpuInfo {
  /** Logical cores visible to the runtime. */
  cores: number;
  /** Best-effort model string, or 'unknown'. */
  model: string;
  /** Node version / browser UA. */
  runtime: string;
}

export interface GpuInfo {
  /** A GPU backend exists (WebGPU adapter or WebGL2 context). */
  available: boolean;
  backend: 'webgpu' | 'webgl2' | 'none';
  vendor: string;
  renderer: string;
  /** Whether compute dispatch is supported (WebGPU) or only rendering (WebGL2). */
  compute: boolean;
  /** True only after a benchmark proved the GPU path faster for this task. */
  enabled: boolean;
  /** Measured speedup of GPU vs CPU from the last benchmark (1.0 = equal). */
  measuredSpeedup: number;
  /** Reason for the current decision — always displayed to the user. */
  notes: string[];
}

export interface MemoryInfo {
  /** Bytes of JS heap currently used (Node) — best effort. */
  heapUsed: number;
  /** Total heap size limit, if known. */
  heapTotal: number;
  /** System memory in bytes, if detectable (0 = unknown). */
  systemTotal: number;
  /** Free system memory in bytes (0 = unknown). */
  systemFree: number;
}

export interface PlatformInfo {
  cpu: CpuInfo;
  gpu: GpuInfo;
  memory: MemoryInfo;
  node: boolean;
  browser: boolean;
  hasWorkerThreads: boolean;
  hasSharedArrayBuffer: boolean;
  hasWebGPU: boolean;
  hasWebGL2: boolean;
  measuredAt: string;
}

export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
export const isNode = !isBrowser && typeof process !== 'undefined' && !!process.versions?.node;

/** Number of usable cores. */
export function cpuCores(): number {
  if (isNode) {
    try {
      // navigator.hardwareConcurrency is unavailable in Node.
      const os = (globalThis as any).process;
      if (os?.availableParallelism) return Math.max(1, os.availableParallelism());
      if (os?.env?.CIRCUITFORGE_CORES) return Math.max(1, Number(os.env.CIRCUITFORGE_CORES));
    } catch {
      /* fall through */
    }
    return 2;
  }
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return Math.max(1, Math.min(32, navigator.hardwareConcurrency));
  }
  return 1;
}

function runtimeString(): string {
  if (isNode) return `node ${(globalThis as any).process.versions.node}`;
  if (typeof navigator !== 'undefined') return `browser ${navigator.userAgent.slice(0, 120)}`;
  return 'unknown';
}

/** Memory statistics, best effort (documented as such in the UI). */
export function memoryInfo(): MemoryInfo {
  const info: MemoryInfo = { heapUsed: 0, heapTotal: 0, systemTotal: 0, systemFree: 0 };
  if (isNode) {
    const p = (globalThis as any).process;
    if (p?.memoryUsage) {
      const m = p.memoryUsage();
      info.heapUsed = m.heapUsed ?? 0;
      info.heapTotal = m.heapTotal ?? 0;
      info.systemTotal = m.rss ? Math.max(m.rss, m.heapTotal) : m.heapTotal;
    }
  } else if (typeof performance !== 'undefined') {
    const perf = performance as any;
    if (perf.memory) {
      info.heapUsed = perf.memory.usedJSHeapSize ?? 0;
      info.heapTotal = perf.memory.totalJSHeapSize ?? 0;
      info.systemTotal = perf.memory.jsHeapSizeLimit ?? 0;
    }
  }
  return info;
}

/** Static (non-benchmarked) view of GPU availability; `enabled` stays false. */
export function gpuProbe(): GpuInfo {
  const info: GpuInfo = {
    available: false,
    backend: 'none',
    vendor: 'unknown',
    renderer: 'unknown',
    compute: false,
    enabled: false,
    measuredSpeedup: 0,
    notes: [],
  };
  if (isBrowser) {
    const nav = navigator as any;
    if (typeof nav.gpu !== 'undefined') {
      info.available = true;
      info.backend = 'webgpu';
      info.compute = true;
      info.notes.push('WebGPU API present. Adapter information is resolved asynchronously.');
    } else {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (gl) {
          info.available = true;
          info.backend = 'webgl2';
          info.compute = false;
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            info.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? 'unknown');
            info.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? 'unknown');
          }
          info.notes.push('WebGL2 available (rendering only; compute requires WebGPU).');
        }
      } catch {
        info.notes.push('No WebGL2 context could be created.');
      }
    }
  } else {
    info.notes.push('Node.js runtime: no GPU compute backend. CPU worker threads are used instead.');
  }
  info.notes.push('GPU stays disabled until a benchmark measures a speed-up > 1.05x for the target task.');
  return info;
}

/** Full platform snapshot. */
export function detectPlatform(): PlatformInfo {
  const gpu = gpuProbe();
  return {
    cpu: { cores: cpuCores(), model: cpuModel(), runtime: runtimeString() },
    gpu,
    memory: memoryInfo(),
    node: isNode,
    browser: isBrowser,
    hasWorkerThreads: isNode ? true : typeof Worker !== 'undefined',
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hasWebGPU: gpu.backend === 'webgpu',
    hasWebGL2: gpu.backend === 'webgl2' || (isBrowser && !!document.createElement('canvas').getContext('webgl2')),
    measuredAt: new Date().toISOString(),
  };
}

function cpuModel(): string {
  if (!isNode) return typeof navigator !== 'undefined' ? 'browser CPU' : 'unknown';
  try {
    const fs = (globalThis as any).process?.getBuiltinModule?.('node:fs');
    if (fs) {
      const txt = fs.readFileSync('/proc/cpuinfo', 'utf8') as string;
      const m = /model name\s*:\s*(.+)/.exec(txt);
      if (m) return m[1].trim();
    }
  } catch {
    /* not available (non-Linux) */
  }
  return 'unknown';
}

/** Human-readable one-liner used in reports and the About dialog. */
export function platformSummary(p: PlatformInfo): string {
  const gpu = p.gpu.available
    ? `${p.gpu.backend}${p.gpu.renderer !== 'unknown' ? ` (${p.gpu.renderer})` : ''}${p.gpu.enabled ? ', enabled' : ', disabled (not benchmarked faster)'}`
    : 'none';
  return `${p.cpu.cores} core(s) [${p.cpu.model}] · ${p.cpu.runtime} · GPU: ${gpu}`;
}
