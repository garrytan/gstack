import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck, RunError } from './types';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Gemini adapter — wraps the `gemini` CLI in plain-text mode.
 *
 * Auth comes from its OAuth files, ~/.gemini/.env, or GOOGLE_API_KEY/GEMINI_API_KEY.
 * We capture stdout as the answer and do not parse Gemini's stream-json schema —
 * that coupling broke every time Gemini reshuffled its event shape.
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
    const geminiEnv = path.join(newCfgDir, '.env');
    const hasCfg = fs.existsSync(legacyCfgDir) || fs.existsSync(newOauth);
    const hasEnvFileKey = fs.existsSync(geminiEnv)
      && /^(?:GOOGLE_API_KEY|GEMINI_API_KEY)\s*=/m.test(fs.readFileSync(geminiEnv, 'utf-8'));
    const hasKey = !!process.env.GOOGLE_API_KEY || !!process.env.GEMINI_API_KEY || hasEnvFileKey;
    if (!hasCfg && !hasKey) {
      return { ok: false, reason: 'No Gemini auth found. Log in via `gemini login` or export GOOGLE_API_KEY/GEMINI_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // --skip-trust lets the CLI run in disposable/non-git benchmark workdirs.
    // Plain -p is non-interactive; benchmark prompts are reasoning tasks, not file
    // ops, and the workdir is a throwaway temp dir.
    const args = ['-p', opts.prompt, '--skip-trust'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('gemini', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return {
        output: out.trim(),
        durationMs: Date.now() - start,
        modelUsed: opts.model ?? 'gemini',
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
    else if (/unauthorized|auth|login|api key/i.test(stderr)) code = 'auth';
    else if (/rate[- ]?limit|429|quota/i.test(stderr)) code = 'rate_limit';
    else code = 'unknown';
    const reason = code === 'timeout' ? 'exceeded timeout' : (e.message ?? stderr ?? 'unknown').slice(0, 400);
    return { output: '', durationMs, modelUsed: model ?? 'gemini', error: { code, reason } };
  }
}
