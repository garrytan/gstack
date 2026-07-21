/**
 * Provider adapter interface — uniform contract for Claude, GPT, Gemini.
 *
 * Adapters shell out to the provider's CLI and return its plain-text output. We
 * deliberately do NOT parse each vendor's proprietary JSON stream for tokens or
 * cost: that coupling is brittle (it breaks every time a vendor reshuffles its
 * output) and redundant — Braintrust owns scoring, and token/cost tracking
 * belongs to whatever instruments the actual model call. The CLI's text answer
 * is all the benchmark needs.
 */

export interface RunOpts {
  /** The prompt to send to the model. */
  prompt: string;
  /** Working directory passed to the underlying CLI. */
  workdir: string;
  /** Hard wall-clock timeout in ms. Default: 300000 (5 min). */
  timeoutMs: number;
  /** Specific model within the family, optional. Adapters pass through to provider. */
  model?: string;
  /** Extra flags per-provider (escape hatch for rare cases). Prefer staying generic. */
  extraArgs?: string[];
}

export type RunError =
  | 'auth'       // Credentials missing or invalid.
  | 'timeout'    // Exceeded timeoutMs.
  | 'rate_limit' // Provider rate-limited us; backoff exceeded.
  | 'binary_missing' // CLI not found on PATH.
  | 'unknown';   // Catch-all with reason populated.

export interface RunResult {
  /** Provider's plain-text output for the prompt. */
  output: string;
  /** Wall-clock duration. */
  durationMs: number;
  /** Model label — the requested model or the family name. Not parsed from output. */
  modelUsed: string;
  /** If the run failed, error code + human reason. output may be empty/partial. */
  error?: { code: RunError; reason: string };
}

export interface AvailabilityCheck {
  ok: boolean;
  /** When !ok: short reason shown to user. Includes install / login / env var hint. */
  reason?: string;
}

export type Family = 'claude' | 'gpt' | 'gemini';

export interface ProviderAdapter {
  /** Stable name used in output tables and config (e.g., 'claude', 'gpt', 'gemini'). */
  readonly name: string;
  /** Model family this adapter targets. */
  readonly family: Family;
  /**
   * Check whether the provider's CLI binary is present and authenticated.
   * Should never block >2s. Non-throwing: returns { ok: false, reason } on failure.
   */
  available(): Promise<AvailabilityCheck>;
  /** Run a prompt and return normalized RunResult. Non-throwing. Errors go in result.error. */
  run(opts: RunOpts): Promise<RunResult>;
}
