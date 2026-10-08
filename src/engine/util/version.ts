/**
 * Version and provenance constants.
 *
 * Every artefact CircuitForge produces (project file, job checkpoint, benchmark
 * record, export manifest) embeds these so that a result can always be traced to
 * the exact engine + model versions that produced it. This is a hard requirement
 * of the reproducibility section of the specification.
 */

/** Engine semantic version. Bump on any behavioural change of the engine. */
export const ENGINE_VERSION = '1.0.0';

/** Version of the on-disk project / export schema. Bump on incompatible changes. */
export const SCHEMA_VERSION = 1;

/**
 * Per-model versions. A model version changes whenever a device equation,
 * parameter meaning or default changes in a way that alters results.
 */
export const MODEL_VERSIONS = {
  /** Level 0 — 4-state event-driven logic. */
  logic: '1.0.0',
  /** Level 0b — bit-parallel 2-state logic (search filter). */
  bitlogic: '1.0.0',
  /** Level 1 — Modified Nodal Analysis solver. */
  mna: '1.0.0',
  /** Level 2 — semiconductor device equations. */
  devices: '1.0.0',
  /** Level 3 — lumped thermal RC network. */
  thermal: '1.0.0',
  /** Analytic timing estimator used by the timing filter. */
  timing: '1.0.0',
  /** Objective normalisation + ranking. */
  ranking: '1.0.0',
} as const;

export type ModelName = keyof typeof MODEL_VERSIONS;

export interface Provenance {
  engine: string;
  schema: number;
  models: Record<string, string>;
  /** ISO timestamp of production. */
  at: string;
  /** Free-form platform string (node version, browser, cores…). */
  platform: string;
}

export function provenance(platform = 'unknown'): Provenance {
  return {
    engine: ENGINE_VERSION,
    schema: SCHEMA_VERSION,
    models: { ...MODEL_VERSIONS },
    at: new Date().toISOString(),
    platform,
  };
}
