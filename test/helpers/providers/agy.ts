import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Agy adapter — wraps the `agy` CLI using `agy --print`.
 *
 * Auth comes from ~/.gemini/oauth_creds.json.
 */
export class AgyAdapter implements ProviderAdapter {
  readonly name = 'agy';
  readonly family = 'gemini' as const;

  async available(): Promise<AvailabilityCheck> {
    const res = spawnSync('sh', ['-c', 'command -v agy'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'agy CLI not found on PATH. Install per Google Antigravity instructions.' };
    }
    const newCfgDir = path.join(os.homedir(), '.gemini');
    const newOauth = path.join(newCfgDir, 'oauth_creds.json');
    const hasCfg = fs.existsSync(newOauth);
    if (!hasCfg) {
      return { ok: false, reason: 'No Agy auth found. Log in via `agy` or authenticate.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Benchmarks must never grant an agent write/tool approval in the caller's
    // workdir. Plan mode plus the terminal sandbox is Agy's read-only boundary.
    const args = ['--print', opts.prompt, '--mode', 'plan', '--sandbox'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs?.includes('--dangerously-skip-permissions')) {
      return this.emptyResult(0, {
        code: 'unknown',
        reason: '--dangerously-skip-permissions is not allowed in benchmarks',
      }, opts.model);
    }
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('agy', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });

      // Estimate tokens as agy does not output NDJSON/JSON tokens yet in print mode
      const inputTokens = Math.ceil(opts.prompt.length / 4);
      const outputTokens = Math.ceil(out.length / 4);

      return {
        output: out.trim(),
        tokens: { input: inputTokens, output: outputTokens },
        durationMs: Date.now() - start,
        toolCalls: 0,
        modelUsed: opts.model || 'gemini-2.5-flash',
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login|api key/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'auth', reason: stderr.slice(0, 400) }, opts.model);
      }
      if (/rate[- ]?limit|429|quota/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'rate_limit', reason: stderr.slice(0, 400) }, opts.model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: (e.message ?? stderr ?? 'unknown').slice(0, 400) }, opts.model);
    }
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? 'gemini-2.5-flash');
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? 'gemini-2.5-flash',
      error,
    };
  }
}
