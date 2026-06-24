import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';

/**
 * Antigravity adapter — wraps Google's `agy` CLI.
 *
 * Google retired the standalone Gemini CLI for individuals and replaced it with
 * the Antigravity CLI (`agy`). Unlike `gemini`, `agy --print` emits PLAIN TEXT,
 * not stream-json — there is no `--output-format` flag (verified on agy 1.0.11,
 * `agy --help`). So this adapter cannot recover per-run token counts or tool-call
 * counts from the CLI; those are reported as 0. Output text is the whole stdout.
 *
 * Headless contract (verified against agy 1.0.11):
 *   agy -p "<prompt>" --dangerously-skip-permissions [--model "<name>"]
 *   -p/--print/--prompt   run a single prompt non-interactively, print response
 *   --dangerously-skip-permissions   auto-approve tool use (yolo equivalent)
 *   --model "<display name>"   e.g. "Gemini 3.1 Pro (High)" (see `agy models`)
 *   --print-timeout <dur>   print-mode wait timeout (Go duration, default 5m)
 *
 * Auth is configured at install / first TUI launch — there is no login flag and
 * no API key env var, so availability only checks that the binary is on PATH.
 *
 * Note: `agy -p` runs as a full agentic session (it may read workspace files when
 * a workspace is present). For controlled benchmark prompts, run it in an isolated
 * workdir.
 */
export class AntigravityAdapter implements ProviderAdapter {
  readonly name = 'antigravity';
  readonly family = 'antigravity' as const;

  async available(): Promise<AvailabilityCheck> {
    const res = spawnSync('sh', ['-c', 'command -v agy'], { timeout: 2000 });
    if (res.status !== 0) {
      return {
        ok: false,
        reason:
          'agy (Antigravity) CLI not found on PATH. Install per ' +
          'https://antigravity.google/docs/cli-getting-started ' +
          '(curl -fsSL https://antigravity.google/cli/install.sh | bash).',
      };
    }
    // agy stores its auth from install/TUI setup; there is no env-var or login
    // flag to probe non-interactively, so presence of the binary is the check.
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // --print runs one prompt non-interactively and prints plain text to stdout.
    // --dangerously-skip-permissions is the non-interactive yolo equivalent.
    const args = ['--print', opts.prompt, '--dangerously-skip-permissions'];
    if (opts.model) args.push('--model', opts.model);
    // Keep the CLI's own print-mode timeout in step with our wall-clock budget so
    // it doesn't hang past it. agy expects a Go duration string (e.g. "300s").
    args.push('--print-timeout', `${Math.max(1, Math.round(opts.timeoutMs / 1000))}s`);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('agy', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return {
        // agy --print emits plain text; the whole stdout is the response.
        output: out.trim(),
        // The CLI exposes no token/tool telemetry in print mode.
        tokens: { input: 0, output: 0 },
        durationMs: Date.now() - start,
        toolCalls: 0,
        modelUsed: opts.model || 'antigravity-default',
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login|not signed in|sign in/i.test(stderr)) {
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

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? 'antigravity-default',
      error,
    };
  }
}
