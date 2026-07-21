import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck, RunError } from './types';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * GPT adapter — wraps the OpenAI `codex` CLI (`codex exec`) in plain-text mode.
 *
 * Captures stdout as the answer; no JSON-event parsing. Scoring is Braintrust's job.
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
    const args = ['exec', opts.prompt, '-C', opts.workdir, '-s', 'read-only', '--skip-git-repo-check'];
    if (opts.model) args.push('-m', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('codex', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return {
        output: out.trim(),
        durationMs: Date.now() - start,
        modelUsed: opts.model ?? 'gpt',
      };
    } catch (err: unknown) {
      return this.errorResult(Date.now() - start, err, opts.model);
    }
  }

  private errorResult(durationMs: number, err: unknown, model?: string): RunResult {
    const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
    const stderr = e.stderr?.toString() ?? '';
    let code: RunError;
    if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') code = 'timeout';
    else if (/unauthorized|auth|login/i.test(stderr)) code = 'auth';
    else if (/rate[- ]?limit|429/i.test(stderr)) code = 'rate_limit';
    else code = 'unknown';
    const reason = code === 'timeout' ? 'exceeded timeout' : (e.message ?? stderr ?? 'unknown').slice(0, 400);
    return { output: '', durationMs, modelUsed: model ?? 'gpt', error: { code, reason } };
  }
}
