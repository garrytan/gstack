import { ClaudeAdapter, claudeExecEnvironment } from './claude';
import type { AvailabilityCheck, ProviderAdapter, RunOpts, RunResult, TokenUsage } from './types';
import { estimateCostUsd, pricingRow } from '../pricing';
import { resolveClaudeCommand } from '../../../lib/claude-bin';

/**
 * Gateway adapter: the Claude Code harness (`claude -p`) pointed at an
 * Anthropic-compatible gateway, so a non-Anthropic model runs in the same
 * agent loop as the Claude arms. OpenRouter by default
 * (GSTACK_GATEWAY_BASE_URL overrides the endpoint; the key is OPENROUTER_API_KEY).
 *
 * The child never sees an Anthropic credential: ANTHROPIC_API_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN and GSTACK_ANTHROPIC_API_KEY are dropped and the
 * gateway key travels as ANTHROPIC_AUTH_TOKEN. Every Claude Code model alias
 * and the subagent model are pinned to the arm's model, and a run that billed
 * any other model is reported as a MODEL_MIX error instead of a result.
 */
export const GATEWAY_MODELS = {
  particle: 'particle-ai/particle-1',
  deepseek: 'deepseek/deepseek-v4.1-flash-1017',
} as const;
export type GatewayName = keyof typeof GATEWAY_MODELS;

export const GATEWAY_DEFAULT_BASE_URL = 'https://openrouter.ai/api';
export const GATEWAY_KEY_ENV = 'OPENROUTER_API_KEY';
const ANTHROPIC_CREDENTIALS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GSTACK_ANTHROPIC_API_KEY'] as const;

/** The variables a gateway run sets on top of any child env; blank credentials override inherited ones. */
export function gatewayOverrides(model: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = source[GATEWAY_KEY_ENV];
  if (!key) throw new Error(`${GATEWAY_KEY_ENV} is not set`);
  return {
    ANTHROPIC_BASE_URL: source.GSTACK_GATEWAY_BASE_URL || GATEWAY_DEFAULT_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/** A complete child env for a gateway run: the source env without Anthropic credentials, plus gatewayOverrides. */
export function gatewayEnvironment(model: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && !(ANTHROPIC_CREDENTIALS as readonly string[]).includes(k)) env[k] = v;
  }
  return { ...env, ...gatewayOverrides(model, source) };
}

/** Models a run billed besides the one it asked for (aliases compared without a provider prefix). */
export function foreignModels(requested: string, billed: string[] | undefined): string[] {
  const bare = (id: string) => id.toLowerCase().replace(/^[a-z-]+\//, '');
  return (billed ?? []).filter(id => bare(id) !== bare(requested));
}

export class GatewayAdapter implements ProviderAdapter {
  readonly family = 'claude' as const;
  readonly model: string;
  private readonly harness: ClaudeAdapter;

  constructor(readonly name: GatewayName, private readonly source: NodeJS.ProcessEnv = process.env) {
    this.model = GATEWAY_MODELS[name];
    this.harness = new ClaudeAdapter({
      environment: opts => gatewayEnvironment(this.model, claudeExecEnvironment(opts, this.source)),
      strict: true,
    });
  }

  async available(): Promise<AvailabilityCheck> {
    if (!this.source[GATEWAY_KEY_ENV]) {
      return { ok: false, reason: `${GATEWAY_KEY_ENV} is not set. Create a key at https://openrouter.ai/keys and export it.` };
    }
    if (!resolveClaudeCommand()) {
      return { ok: false, reason: 'claude CLI not found on PATH (the gateway arms run in Claude Code). Install: npm i -g @anthropic-ai/claude-code' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    if (opts.csoProducer) {
      return { output: '', tokens: { input: 0, output: 0 }, durationMs: 0, toolCalls: 0, modelUsed: this.model, error: { code: 'unknown', reason: 'gateway providers do not run CSO producers' } };
    }
    const result = await this.harness.run({ ...opts, model: this.model, extraArgs: [...(opts.extraArgs ?? []), '--setting-sources', ''] });
    const foreign = foreignModels(this.model, result.modelsBilled);
    if (!result.error && foreign.length) {
      return { ...result, error: { code: 'unknown', reason: `MODEL_MIX: the run also billed ${foreign.join(', ')}` } };
    }
    return result;
  }

  /** Cache writes are billed at the input rate: the gateway's providers publish no separate write price (as the model panel prices them). */
  estimateCost(tokens: TokenUsage, model?: string): number {
    const id = model ?? this.model;
    const writeRate = pricingRow(id)?.input_per_mtok ?? 0;
    return +(estimateCostUsd(tokens, id) + (tokens.cacheWrite ?? 0) * writeRate / 1_000_000).toFixed(6);
  }
}
