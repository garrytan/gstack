import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Claude adapter — wraps the `claude` CLI via claude -p.
 *
 * For brevity and to avoid duplicating the full stream-json parser, this adapter
 * uses claude CLI in non-interactive mode (--print) with the simpler JSON output
 * format. If richer event-level metrics are needed (per-tool timing etc.),
 * swap to session-runner's full stream-json parser.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude';
  readonly family = 'claude' as const;

  async available(): Promise<AvailabilityCheck> {
    // Binary on PATH?
    const res = spawnSync('sh', ['-c', 'command -v claude'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'claude CLI not found on PATH. Install from https://claude.ai/download or npm i -g @anthropic-ai/claude-code' };
    }
    // Auth sniff: ~/.claude/.credentials.json OR ANTHROPIC_API_KEY
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const hasCreds = fs.existsSync(credsPath);
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    if (!hasCreds && !hasKey) {
      return { ok: false, reason: 'No Claude auth found. Log in via `claude` interactive session, or export ANTHROPIC_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    const args = ['-p', '--output-format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('claude', args, {
        input: opts.prompt,
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = this.parseOutput(out);
      return {
        output: parsed.output,
        tokens: parsed.tokens,
        durationMs: Date.now() - start,
        toolCalls: parsed.toolCalls,
        modelUsed: parsed.modelUsed || opts.model || 'claude-opus-4-7',
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'auth', reason: stderr.slice(0, 400) }, opts.model);
      }
      if (/rate[- ]?limit|429/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'rate_limit', reason: stderr.slice(0, 400) }, opts.model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: (e.message ?? stderr ?? 'unknown').slice(0, 400) }, opts.model);
    }
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? 'claude-opus-4-7');
  }

  /**
   * Parse claude -p --output-format json output. Shape (as of 2026-04):
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
