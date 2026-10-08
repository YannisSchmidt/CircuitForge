/**
 * Accuracy labels and diagnostics — the honesty layer.
 *
 * The specification forbids claiming that something is physically simulated when
 * it is not. Every model therefore declares, phenomenon by phenomenon, which of
 * four accuracy classes applies:
 *
 *   REALISTIC     — the dominant physics is represented by the standard equations
 *                   used in production simulators (SPICE-class), validated
 *                   against analytic results in the test suite.
 *   APPROXIMATED  — a documented simplification with a stated validity domain.
 *   IDEALIZED     — deliberately perfect (zero resistance, infinite gain…), used
 *                   for speed or as a limit case.
 *   NOT_MODELED   — the phenomenon is absent from the model.
 *
 * The UI and every report show these labels next to any number they produce.
 */

export enum Accuracy {
  REALISTIC = 'REALISTIC',
  APPROXIMATED = 'APPROXIMATED',
  IDEALIZED = 'IDEALIZED',
  NOT_MODELED = 'NOT_MODELED',
}

/** Ordering from most to least faithful; used to aggregate claims. */
const ACCURACY_RANK: Record<Accuracy, number> = {
  [Accuracy.REALISTIC]: 3,
  [Accuracy.APPROXIMATED]: 2,
  [Accuracy.IDEALIZED]: 1,
  [Accuracy.NOT_MODELED]: 0,
};

export function weakerAccuracy(a: Accuracy, b: Accuracy): Accuracy {
  return ACCURACY_RANK[a] <= ACCURACY_RANK[b] ? a : b;
}

export function accuracyRank(a: Accuracy): number {
  return ACCURACY_RANK[a];
}

export function accuracyColor(a: Accuracy): string {
  switch (a) {
    case Accuracy.REALISTIC:
      return '#3fb950';
    case Accuracy.APPROXIMATED:
      return '#d29922';
    case Accuracy.IDEALIZED:
      return '#58a6ff';
    default:
      return '#f85149';
  }
}

/** A single claim a model makes about one phenomenon. */
export interface ModelClaim {
  /** What is claimed, e.g. 'static I-V', 'switching delay', 'self-heating'. */
  phenomenon: string;
  level: Accuracy;
  /** Exactly what is computed / omitted, in one sentence. */
  detail: string;
  /** Where the model stops being valid, e.g. '|Vds| < 6 V, Tj < 150 °C'. */
  validity?: string;
}

/**
 * Complete model description attached to every component spec and device model.
 * This is what the "MODEL ACCURACY" panel displays.
 */
export interface ModelCard {
  /** Model family identifier, e.g. 'Shichman–Hodges level 3 (subset)'. */
  family: string;
  /** Model version, part of the provenance record. */
  version: string;
  claims: ModelClaim[];
  /** Equations actually implemented (plain text / formula strings). */
  equations: string[];
  /** Parameters that influence the model, with units. */
  parameters: Array<{ name: string; unit: string; meaning: string; default?: number }>;
  /** Known limitations — always non-empty for honesty. */
  limitations: string[];
  /** Literature or reference implementation the model follows. */
  references: string[];
  /** Engine levels at which this model can run. */
  levels: number[];
}

/** Aggregate accuracy of a model card: the weakest claim among the given set. */
export function cardAccuracy(card: ModelCard, phenomena?: string[]): Accuracy {
  let acc: Accuracy = Accuracy.REALISTIC;
  let first = true;
  for (const c of card.claims) {
    if (phenomena && !phenomena.some((p) => c.phenomenon.toLowerCase().includes(p.toLowerCase()))) continue;
    acc = first ? c.level : weakerAccuracy(acc, c.level);
    first = false;
  }
  return first ? Accuracy.NOT_MODELED : acc;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export enum Severity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. 'CF1001'. */
  code: string;
  message: string;
  /** Object the diagnostic refers to (component / net / chip / block id). */
  target?: { type: string; id: string | number; name?: string };
  /** Optional hint for the user. */
  hint?: string;
  /** Optional structured data (values involved). */
  data?: Record<string, unknown>;
}

export function diag(
  severity: Severity,
  code: string,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic {
  return { severity, code, message, ...extra };
}

export const info = (code: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic =>
  diag(Severity.Info, code, message, extra);
export const warn = (code: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic =>
  diag(Severity.Warning, code, message, extra);
export const error = (code: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic =>
  diag(Severity.Error, code, message, extra);

/**
 * An Error that carries a diagnostic.
 *
 * Thrown diagnostics are real `Error`s (stack trace, `instanceof` works, callers
 * can catch them like anything else) that also expose the machine-readable code,
 * the hint and the target of the diagnostic they were built from.
 */
export class EngineError extends Error {
  readonly diagnostic: Diagnostic;
  readonly code: string;
  readonly hint?: string;
  constructor(diagnostic: Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = 'EngineError';
    this.diagnostic = diagnostic;
    this.code = diagnostic.code;
    this.hint = diagnostic.hint;
  }
}

/** Throw an error-level diagnostic. Used where an operation cannot continue. */
export function fail(code: string, message: string, extra: Partial<Diagnostic> = {}): never {
  throw new EngineError(diag(Severity.Error, code, message, extra));
}

export function countBySeverity(diags: readonly Diagnostic[]): Record<Severity, number> {
  const out: Record<Severity, number> = { [Severity.Info]: 0, [Severity.Warning]: 0, [Severity.Error]: 0 };
  for (const d of diags) out[d.severity]++;
  return out;
}

/**
 * Structured error thrown by the engine. Carries diagnostics so that the CLI and
 * the UI can show *every* problem of a design, not just the first one.
 */
export class CircuitForgeError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];
  readonly context?: Record<string, unknown>;

  constructor(code: string, message: string, diagnostics: Diagnostic[] = [], context?: Record<string, unknown>) {
    super(message);
    this.name = 'CircuitForgeError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.context = context;
  }

  static from(cause: unknown, code: string, context?: Record<string, unknown>): CircuitForgeError {
    if (cause instanceof CircuitForgeError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new CircuitForgeError(code, message, [], context);
  }
}
