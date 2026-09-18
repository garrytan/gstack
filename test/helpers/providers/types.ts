import * as path from 'node:path';

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
  /** Producer-only execution policy. Omit to preserve each adapter's defaults. */
  csoProducer?: {
    /** The one explicit state directory exposed outside the source worktree. */
    stateDirectory: string;
    /** Exact validated per-cell source root. Providers may grant only this path read-only. */
    sourceDirectory: string;
    /** Absolute immutable launcher path admitted by the producer. */
    helperLauncher: string;
    /** Exact adjacent generation manifest read by the launcher. */
    helperGeneration: string;
    /** Exact provider command whose bytes/version are bound into the receipt. */
    providerCommand: { executable: string; argsPrefix: string[] };
  };
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

export const CSO_PRODUCER_SHELL_ENV = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ',
  'GSTACK_HOME', 'GSTACK_SESSION_KIND', 'GSTACK_HEADLESS',
] as const;
const CSO_AUTH_ENV: Record<Family, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  gpt: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
};

export function validateCsoProducerStateDirectory(stateDirectory: string): string {
  if (!path.isAbsolute(stateDirectory) || path.normalize(stateDirectory) !== stateDirectory) {
    throw new Error('CSO producer state directory must be an absolute normalized path');
  }
  return stateDirectory;
}

export function csoProducerStateDirectory(opts: RunOpts): string | undefined {
  if (!opts.csoProducer) return undefined;
  csoProducerHelperLauncher(opts);
  csoProducerHelperGeneration(opts);
  csoProducerSourceDirectory(opts);
  csoProducerProviderCommand(opts);
  return validateCsoProducerStateDirectory(opts.csoProducer.stateDirectory);
}

export function csoProducerSourceDirectory(opts: RunOpts): string | undefined {
  if (!opts.csoProducer) return undefined;
  return validateCsoProducerStateDirectory(opts.csoProducer.sourceDirectory);
}

export function csoProducerHelperHome(opts: RunOpts): string | undefined {
  const stateDirectory = csoProducerStateDirectory(opts);
  return stateDirectory ? path.join(stateDirectory, 'cso-home') : undefined;
}

export function csoProducerProviderCommand(opts: RunOpts): { executable: string; argsPrefix: string[] } | undefined {
  if (!opts.csoProducer) return undefined;
  const command = opts.csoProducer.providerCommand;
  if (!command || !path.isAbsolute(command.executable) || path.normalize(command.executable) !== command.executable ||
      !Array.isArray(command.argsPrefix) || command.argsPrefix.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('CSO producer provider command must be an absolute normalized trusted path');
  }
  return { executable: command.executable, argsPrefix: [...command.argsPrefix] };
}

export function csoProducerHelperLauncher(opts: RunOpts): string | undefined {
  if (!opts.csoProducer) return undefined;
  const launcher = opts.csoProducer.helperLauncher;
  if (typeof launcher !== 'string') throw new Error('CSO producer helper launcher must be an absolute normalized trusted path');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  if (!path.isAbsolute(launcher) || path.normalize(launcher) !== launcher || path.basename(launcher) !== `gstack-cso-launcher${suffix}` ||
      !/^[A-Za-z0-9_./:\\-]+$/.test(launcher)) {
    throw new Error('CSO producer helper launcher must be an absolute normalized trusted path');
  }
  return launcher;
}

export function csoProducerHelperGeneration(opts: RunOpts): string | undefined {
  if (!opts.csoProducer) return undefined;
  const generation = opts.csoProducer.helperGeneration;
  const launcher = csoProducerHelperLauncher(opts);
  if (typeof generation !== 'string' || !path.isAbsolute(generation) || path.normalize(generation) !== generation ||
      path.basename(generation) !== '.gstack-cso-generation' || path.dirname(generation) !== path.dirname(launcher!) ||
      !/^[A-Za-z0-9_./:\\-]+$/.test(generation)) {
    throw new Error('CSO producer helper generation must be the exact adjacent absolute normalized trusted path');
  }
  return generation;
}

/** Copy only execution inputs needed by the selected producer host. */
export function csoProducerChildEnvironment(
  family: Family,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of [...CSO_PRODUCER_SHELL_ENV, ...CSO_AUTH_ENV[family]]) {
    const value = source[key];
    if (typeof value === 'string' && !value.includes('\0')) output[key] = value;
  }
  return output;
}

export interface ProviderAdapter {
  /** Stable name used in output tables and config (e.g., 'claude', 'gpt', 'gemini'). */
  readonly name: string;
  /** Model family this adapter targets. */
  readonly family: Family;
  /**
   * Check whether the provider's CLI binary is present and authenticated.
   * Should never block >2s. Non-throwing: returns { ok: false, reason } on failure.
   */
  available(opts?: RunOpts): Promise<AvailabilityCheck>;
  /** Run a prompt and return normalized RunResult. Non-throwing. Errors go in result.error. */
  run(opts: RunOpts): Promise<RunResult>;
  /** Estimate USD cost for the reported token usage and model. */
  estimateCost(tokens: TokenUsage, model?: string): number;
}
