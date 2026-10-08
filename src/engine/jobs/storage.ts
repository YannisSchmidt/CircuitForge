/**
 * Job persistence.
 *
 * The queue itself never touches a filesystem: it writes through a `JobStorage`,
 * so the same code runs in Node (files), in a browser (IndexedDB / OPFS behind an
 * adapter) and in tests (memory). Writes are atomic — a checkpoint that lands
 * half-written would be worse than no checkpoint at all, because the queue would
 * then "resume" from corrupt JSON.
 */

import { ENGINE_VERSION } from '../util/version.js';
import { isNode } from '../util/platform.js';

export interface JobStorage {
  /** Read a key; null when absent. */
  read(key: string): string | null;
  /** Write a key atomically. */
  write(key: string, text: string): void;
  /** Remove a key; false when it did not exist. */
  remove(key: string): boolean;
  /** Keys under a prefix, without the prefix. */
  list(prefix: string): string[];
  /** True when writes really reach durable media (false for the memory store). */
  readonly durable: boolean;
  /** Where the data lives, for the UI ("saved to data/jobs"). */
  readonly location: string;
}

/** In-memory store: tests, and browsers without a persistence adapter. */
export class MemoryStorage implements JobStorage {
  private map = new Map<string, string>();
  readonly durable = false;
  readonly location = 'memory (not persisted)';

  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, text: string): void {
    this.map.set(key, text);
  }
  remove(key: string): boolean {
    return this.map.delete(key);
  }
  list(prefix: string): string[] {
    const out: string[] = [];
    for (const k of this.map.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    return out.sort();
  }
  clear(): void {
    this.map.clear();
  }
}

type NodeFs = {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string): void;
  renameSync(a: string, b: string): void;
  unlinkSync(p: string): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): string | undefined;
  readdirSync(p: string): string[];
  statSync(p: string): { isDirectory(): boolean; mtimeMs: number };
};

/** Resolve `node:fs` without a static import (the browser bundle must not see it). */
function nodeFs(): NodeFs | null {
  if (!isNode) return null;
  try {
    const p = globalThis.process as { getBuiltinModule?: (m: string) => unknown };
    const mod = p.getBuiltinModule?.('node:fs');
    if (mod) return mod as NodeFs;
  } catch {
    /* fall through */
  }
  return null;
}

function join(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    const clean = part.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    out.push(clean);
  }
  const absolute = parts[0]?.startsWith('/') || /^[A-Za-z]:/.test(parts[0] ?? '');
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * File-backed store. Keys map to `<dir>/<key>.json`; a key containing `/` becomes
 * a sub-directory, which is how checkpoints and history are kept apart.
 */
export class FileStorage implements JobStorage {
  readonly durable = true;
  readonly location: string;
  private fs: NodeFs;
  private dir: string;

  constructor(dir: string, fs?: NodeFs) {
    const resolved = fs ?? nodeFs();
    if (!resolved) throw new Error('FileStorage needs a Node.js runtime (or an injected fs implementation)');
    this.fs = resolved;
    this.dir = dir;
    this.location = dir;
    this.fs.mkdirSync(dir, { recursive: true });
  }

  private pathOf(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  read(key: string): string | null {
    const p = this.pathOf(key);
    try {
      return this.fs.existsSync(p) ? this.fs.readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomic write: `<key>.json.tmp` then rename. A crash between the two leaves
   * the previous good copy in place, and the tmp file is ignored on resume.
   */
  write(key: string, text: string): void {
    const p = this.pathOf(key);
    const tmp = `${p}.tmp`;
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent) this.fs.mkdirSync(parent, { recursive: true });
    this.fs.writeFileSync(tmp, text);
    this.fs.renameSync(tmp, p);
  }

  remove(key: string): boolean {
    const p = this.pathOf(key);
    if (!this.fs.existsSync(p)) return false;
    this.fs.unlinkSync(p);
    return true;
  }

  list(prefix: string): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      const abs = rel ? join(this.dir, rel) : this.dir;
      let entries: string[] = [];
      try {
        entries = this.fs.readdirSync(abs);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.endsWith('.tmp')) continue;
        const relKey = rel ? `${rel}/${name}` : name;
        const absKey = join(this.dir, relKey);
        let isDir = false;
        try {
          isDir = this.fs.statSync(absKey).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(relKey);
        else if (relKey.endsWith('.json')) out.push(relKey.slice(0, -'.json'.length));
      }
    };
    walk('');
    return out.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  }
}

/** The key layout of a queue directory. */
export const QUEUE_KEY = 'queue';
export const checkpointKey = (id: string): string => `checkpoints/${id}`;
export const historyKey = (id: string): string => `history/${id}`;
export const CHECKPOINT_PREFIX = 'checkpoints/';
export const HISTORY_PREFIX = 'history/';

/** Header written into every persisted document, so a stale file is detectable. */
export function persistHeader(): { engineVersion: string; savedAt: string } {
  return { engineVersion: ENGINE_VERSION, savedAt: new Date().toISOString() };
}

export { nodeFs };
