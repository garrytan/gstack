import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Grok adapter — wraps the `grok` CLI via -p / --single / --prompt-file.
 *
 * Auth readiness is boolean only: CLI present + (~/.grok/auth.json OR
 * XAI_API_KEY / GROK_API_KEY env names present). Never log token values.
 */
export class GrokAdapter implements ProviderAdapter {
  readonly name = 'grok';
  readonly family = 'grok' as const;

  async available(): Promise<AvailabilityCheck> {
    // Boolean PATH presence only — never log secrets. Bound to ≤2s like peer adapters.
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let hasBinary = which.status === 0;
    if (!hasBinary) {
      try {
        execFileSync('grok', ['--version'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        });
        hasBinary = true;
      } catch {
        hasBinary = false;
      }
    }
    if (!hasBinary) {
      return {
        ok: false,
        reason: 'grok CLI not found on PATH. Install Grok Build from xAI, or ensure `grok` is on PATH.',
      };
    }

    // Prefer HOME when set so hermetic tests / agent envs can isolate auth
    // discovery. Bun's os.homedir() ignores process.env.HOME (unlike Node).
    const home = process.env.HOME || os.homedir();
    const authPath = path.join(home, '.grok', 'auth.json');
    const hasAuthFile = fs.existsSync(authPath);
    // Presence of env *names* only — never read/log values
    const hasKey = !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
    if (!hasAuthFile && !hasKey) {
      return {
        ok: false,
        reason: 'No Grok auth found. Log in via `grok` interactive session, or export XAI_API_KEY / GROK_API_KEY.',
      };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Prefer --prompt-file for multi-line / large prompts (ARG_MAX + quoting).
    // Short single-line prompts use --single to avoid temp files.
    const useFile =
      opts.prompt.includes('\n') || opts.prompt.length > 2000 || Buffer.byteLength(opts.prompt, 'utf8') > 2000;
    let promptFile: string | null = null;
    let args: string[];
    if (useFile) {
      promptFile = path.join(
        os.tmpdir(),
        `gstack-grok-bench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      fs.writeFileSync(promptFile, opts.prompt, 'utf-8');
      args = ['--prompt-file', promptFile, '--cwd', opts.workdir];
    } else {
      args = ['--single', opts.prompt];
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('grok', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        // Pipe stderr so auth-shaped tokens never inherit onto the parent console
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GSTACK_HEADLESS: '1' },
      });
      return {
        output: typeof out === 'string' ? out : String(out),
        tokens: { input: 0, output: 0 },
        durationMs: Date.now() - start,
        toolCalls: 0,
        modelUsed: opts.model || 'grok',
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      // Never surface raw stderr for auth paths (may contain token-shaped text).
      const safeSlice = (s: string) => s.replace(/[A-Za-z0-9_\-]{20,}/g, '[redacted]').slice(0, 200);
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login|api.?key/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'auth', reason: 'authentication failed (details redacted)' }, opts.model);
      }
      if (/rate[- ]?limit|429/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'rate_limit', reason: safeSlice(stderr) }, opts.model);
      }
      if (/ENOENT|not found/i.test(e.message ?? '') || e.code === 'ENOENT') {
        return this.emptyResult(durationMs, { code: 'binary_missing', reason: 'grok CLI not found' }, opts.model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: safeSlice(e.message ?? stderr ?? 'unknown') }, opts.model);
    } finally {
      if (promptFile) {
        try {
          fs.unlinkSync(promptFile);
        } catch {
          // best-effort cleanup of temp prompt file
        }
      }
    }
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? 'grok');
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model || 'grok',
      error,
    };
  }
}
