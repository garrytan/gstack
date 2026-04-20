/**
 * Provider adapter interface — uniform contract for Claude, GPT, Gemini.
 *
 * Each adapter wraps an existing runner (session-runner.ts, codex-session-runner.ts,
 * gemini-session-runner.ts) and normalizes its per-provider result shape into the
 * RunResult below. The benchmark harness only talks to adapters through this
 * interface, never to the underlying runners directly.
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

export interface TokenUsage {
  input: number;
  output: number;
  /** Cached input tokens (Anthropic/OpenAI support). Undefined if provider doesn't report. */
  cached?: number;
}

export type RunError =
  | 'auth'       // Credentials missing or invalid.
  | 'timeout'    // Exceeded timeoutMs.
  | 'rate_limit' // Provider rate-limited us; backoff exceeded.
  | 'binary_missing' // CLI not found on PATH.
  | 'unknown';   // Catch-all with reason populated.

export interface RunResult {
  /** Provider's textual output for the prompt. */
  output: string;
  /** Normalized token usage. 0s if unreported. */
  tokens: TokenUsage;
  /** Wall-clock duration. */
  durationMs: number;
  /** Count of tool/function calls made during the run (0 if unsupported). */
  toolCalls: number;
  /** Actual model ID the provider reports using (may be a variant of the family). */
  modelUsed: string;
  /** If the run failed, error code + human reason. output/tokens may be partial. */
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
  /** Estimate USD cost for the reported token usage and model. */
  estimateCost(tokens: TokenUsage, model?: string): number;
}
