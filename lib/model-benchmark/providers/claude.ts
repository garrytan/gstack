import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck, RunError } from './types';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveClaudeCommand } from '../../../browse/src/claude-bin';

/**
 * Claude adapter — wraps the `claude` CLI via `claude -p` in plain-text mode.
 *
 * We capture stdout as the answer and do not parse Claude's JSON output shape:
 * scoring is Braintrust's job and it only needs the text.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude';
  readonly family = 'claude' as const;

  async available(): Promise<AvailabilityCheck> {
    // Binary on PATH (or GSTACK_CLAUDE_BIN override). Routes through the shared
    // resolver so Windows + override paths behave the same as production sites.
    const resolved = resolveClaudeCommand();
    if (!resolved) {
      return { ok: false, reason: 'claude CLI not found on PATH. Install from https://claude.ai/download or npm i -g @anthropic-ai/claude-code (or set GSTACK_CLAUDE_BIN)' };
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
    const resolved = resolveClaudeCommand();
    if (!resolved) {
      throw new Error('claude CLI not resolvable (set GSTACK_CLAUDE_BIN or install)');
    }
    const args = [...resolved.argsPrefix, '-p'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync(resolved.command, args, {
        input: opts.prompt,
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        // Default GSTACK_HEADLESS=1 so a benchmark run classifies as headless (an
        // AskUserQuestion failure BLOCKs rather than emitting unanswerable prose).
        env: { ...process.env, GSTACK_HEADLESS: '1' },
      });
      return {
        output: out.trim(),
        durationMs: Date.now() - start,
        modelUsed: opts.model ?? 'claude',
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
    return { output: '', durationMs, modelUsed: model ?? 'claude', error: { code, reason } };
  }
}
