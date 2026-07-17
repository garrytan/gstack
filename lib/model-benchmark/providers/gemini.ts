import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Gemini adapter — wraps the `gemini` CLI.
 *
 * Gemini CLI auth comes from either ~/.config/gemini/ or GOOGLE_API_KEY. Output
 * format is NDJSON with `message`/`tool_use`/`result` events when `--output-format
 * stream-json` is requested. This adapter uses a single-response form for simplicity
 * in benchmarks; richer streaming lives in gemini-session-runner.ts.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';
  readonly family = 'gemini' as const;

  async available(): Promise<AvailabilityCheck> {
    const res = spawnSync('sh', ['-c', 'command -v gemini'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'gemini CLI not found on PATH. Install per https://github.com/google-gemini/gemini-cli' };
    }
    const legacyCfgDir = path.join(os.homedir(), '.config', 'gemini');
    const newCfgDir = path.join(os.homedir(), '.gemini');
    const newOauth = path.join(newCfgDir, 'oauth_creds.json');
    const hasCfg = fs.existsSync(legacyCfgDir) || fs.existsSync(newOauth);
    const hasKey = !!process.env.GOOGLE_API_KEY;
    if (!hasCfg && !hasKey) {
      return { ok: false, reason: 'No Gemini auth found. Log in via `gemini login` or export GOOGLE_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Default to --yolo (non-interactive) and stream-json output so we can parse
    // tokens + tool calls. Callers can override via extraArgs.
    const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--yolo'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('gemini', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = this.parseStreamJson(out);
      return {
        output: parsed.output,
        tokens: parsed.tokens,
        durationMs: Date.now() - start,
        toolCalls: parsed.toolCalls,
        modelUsed: parsed.modelUsed || opts.model || 'gemini-2.5-pro',
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
    return estimateCostUsd(tokens, model ?? 'gemini-2.5-pro');
  }

  /**
   * Parse gemini NDJSON stream events:
   *   init  → session id (discarded here)
   *   message { delta: true, text } → concat to output
   *   tool_use { name } → increment toolCalls
   *   result { usage: { input_token_count, output_token_count } } → tokens
   */
  private parseStreamJson(raw: string): { output: string; tokens: { input: number; output: number }; toolCalls: number; modelUsed?: string } {
    let output = '';
    let input = 0;
    let out = 0;
    let toolCalls = 0;
    let modelUsed: string | undefined;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (obj.type === 'message' && typeof obj.text === 'string') {
          output += obj.text;
        } else if (obj.type === 'tool_use') {
          toolCalls += 1;
        } else if (obj.type === 'result') {
          const u = obj.usage ?? {};
          input += u.input_token_count ?? u.prompt_tokens ?? 0;
          out += u.output_token_count ?? u.completion_tokens ?? 0;
          if (obj.model) modelUsed = obj.model;
        }
      } catch {
        // skip malformed lines
      }
    }
    return { output, tokens: { input, output: out }, toolCalls, modelUsed };
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? 'gemini-2.5-pro',
      error,
    };
  }
}
