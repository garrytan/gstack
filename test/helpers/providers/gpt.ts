import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * GPT adapter — wraps the OpenAI `codex` CLI (codex exec with --json output).
 *
 * Codex uses ~/.codex/ for auth (not OPENAI_API_KEY). The --json flag emits
 * JSONL events; we parse `turn.completed` for usage and `agent_message` / etc.
 * for output aggregation.
 */
export class GptAdapter implements ProviderAdapter {
  readonly name = 'gpt';
  readonly family = 'gpt' as const;

  async available(): Promise<AvailabilityCheck> {
    const res = spawnSync('sh', ['-c', 'command -v codex'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'codex CLI not found on PATH. Install: npm i -g @openai/codex' };
    }
    // Auth sniff: ~/.codex/ should contain auth state after `codex login`
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) {
      return { ok: false, reason: 'No ~/.codex/ found. Run `codex login` to authenticate via ChatGPT.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // `-s read-only` is load-bearing safety. With `--skip-git-repo-check` we
    // bypass codex's interactive trust prompt for unknown directories (benchmarks
    // often run in temp dirs / non-git paths), so the read-only sandbox is now
    // the only boundary preventing codex from mutating the workdir. If you ever
    // remove `-s read-only`, drop `--skip-git-repo-check` too.
    const args = ['exec', opts.prompt, '-C', opts.workdir, '-s', 'read-only', '--skip-git-repo-check', '--json'];
    if (opts.model) args.push('-m', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('codex', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = this.parseJsonl(out);
      return {
        output: parsed.output,
        tokens: parsed.tokens,
        durationMs: Date.now() - start,
        toolCalls: parsed.toolCalls,
        modelUsed: parsed.modelUsed || opts.model || 'gpt-5.4',
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
    return estimateCostUsd(tokens, model ?? 'gpt-5.4');
  }

  /**
   * Parse codex exec --json JSONL stream.
   * Key events:
   *   - item.completed with item.type === 'agent_message' → text output
   *   - item.completed with item.type === 'command_execution' → tool call
   *   - turn.completed → usage.input_tokens, usage.output_tokens
   *   - thread.started → session id (not used here)
   */
  private parseJsonl(raw: string): { output: string; tokens: { input: number; output: number }; toolCalls: number; modelUsed?: string } {
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
        if (obj.type === 'item.completed' && obj.item) {
          if (obj.item.type === 'agent_message' && typeof obj.item.text === 'string') {
            output += (output ? '\n' : '') + obj.item.text;
          } else if (obj.item.type === 'command_execution') {
            toolCalls += 1;
          }
        } else if (obj.type === 'turn.completed') {
          const u = obj.usage ?? {};
          input += u.input_tokens ?? 0;
          out += u.output_tokens ?? 0;
          if (obj.model) modelUsed = obj.model;
        }
      } catch {
        // skip malformed lines — codex stderr can leak in
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
      modelUsed: model ?? 'gpt-5.4',
      error,
    };
  }
}
