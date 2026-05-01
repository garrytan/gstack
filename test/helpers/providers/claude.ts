import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';

/**
 * Claude adapter — disabled during the no-Claude temp migration.
 *
 * TEMP SWAP 2026-05-01: this originally wrapped Claude print mode. Use the
 * GPT/Codex provider for this run, or revert this block after the temp window.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude';
  readonly family = 'claude' as const;

  async available(): Promise<AvailabilityCheck> {
    return {
      ok: false,
      reason: 'Claude provider disabled by no-Claude temp migration. Use GPT/Codex provider for this run.',
    };
    // TEMP SWAP 2026-05-01: original availability check starts here when re-enabled.
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    return this.emptyResult(
      Date.now() - start,
      { code: 'unknown', reason: 'Claude print mode disabled by no-Claude temp migration' },
      opts.model,
    );
    // TEMP SWAP 2026-05-01: original run() constructed a Claude print-mode command and executed it.
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? 'claude-opus-4-7');
  }

  /**
   * Parse historical Claude print-mode JSON output. Shape (as of 2026-04):
   *   { type: "result", result: "<assistant text>", usage: { input_tokens, output_tokens, ... },
   *     num_turns, session_id, ... }
   * Older formats may differ — adapter is best-effort.
   */
  private parseOutput(raw: string): { output: string; tokens: { input: number; output: number; cached?: number }; toolCalls: number; modelUsed?: string } {
    try {
      const obj = JSON.parse(raw);
      const result = typeof obj.result === 'string' ? obj.result : String(obj.result ?? '');
      const u = obj.usage ?? {};
      return {
        output: result,
        tokens: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cached: u.cache_read_input_tokens,
        },
        toolCalls: obj.num_turns ?? 0,
        modelUsed: obj.model,
      };
    } catch {
      // Non-JSON output: treat as plain text.
      return { output: raw, tokens: { input: 0, output: 0 }, toolCalls: 0 };
    }
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? 'claude-opus-4-7',
      error,
    };
  }
}
