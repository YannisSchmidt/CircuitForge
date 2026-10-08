/**
 * Device model table.
 *
 * A million transistors usually share a handful of *parameter sets*: the physics
 * (threshold, mobility, capacitances…) is per-model, while the geometry and the
 * thermal node are per-instance. Storing the physics once per model instead of
 * once per element is what makes large transistor-level simulations fit in
 * memory, and it is exactly how SPICE `.model` cards work.
 *
 * Models are deduplicated by content, so two instances with identical parameters
 * share one entry, and editing one instance's parameter creates a new entry for
 * that instance only (never mutating the shared one — that would corrupt other
 * instances).
 */

import { GrowF64 } from './grow.js';
import { StructuralHash } from '../util/hash.js';

/** Fixed stride for model parameter blocks (slots are shared with element slots). */
export const MODEL_STRIDE = 48;

export class ModelTable {
  private map = new Map<string, number>();
  private keys: string[] = [];
  private kinds: number[] = [];
  private data: GrowF64;
  count = 0;

  constructor(capacityModels = 16) {
    this.data = new GrowF64(capacityModels * MODEL_STRIDE);
  }

  /**
   * Intern a model. `params` must contain MODEL_STRIDE values laid out with the
   * element kind's slot table. `key` is a content hash (call `keyOf`).
   */
  intern(kind: number, key: string, params: Float64Array): number {
    const existing = this.map.get(key);
    if (existing !== undefined && this.kinds[existing] === kind) {
      // Guard against a hash collision: verify the stored block is identical.
      const off = existing * MODEL_STRIDE;
      let same = true;
      for (let i = 0; i < MODEL_STRIDE; i++) {
        if (this.data.data[off + i] !== params[i]) {
          same = false;
          break;
        }
      }
      if (same) return existing;
    }
    const idx = this.count++;
    this.map.set(key, idx);
    this.keys.push(key);
    this.kinds.push(kind);
    this.data.ensure(MODEL_STRIDE);
    this.data.data.set(params.subarray(0, MODEL_STRIDE), this.data.length);
    this.data.length += MODEL_STRIDE;
    return idx;
  }

  /** Content key for a parameter block. */
  static keyOf(kind: number, params: Float64Array, stride: number): string {
    const h = new StructuralHash();
    h.int32(kind);
    for (let i = 0; i < stride; i++) {
      const v = params[i];
      // Quantise: 1e-9 relative resolution is far below any meaningful device
      // parameter difference and keeps keys stable across floating-point noise.
      h.int32(Math.round(v * 1e9) | 0);
      h.int32(Math.round((v * 1e9) / 4294967296) | 0);
    }
    return h.hex();
  }

  toArray(): Float64Array {
    return this.data.toArray();
  }

  keyAt(index: number): string {
    return this.keys[index] ?? '';
  }
}

/** Read a model parameter by slot. */
export function modelParam(models: Float64Array, modelIndex: number, slot: number): number {
  if (modelIndex < 0) return 0;
  return models[modelIndex * MODEL_STRIDE + slot] ?? 0;
}
