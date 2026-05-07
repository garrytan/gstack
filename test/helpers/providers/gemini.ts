import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Gemini adapter — prefers the Generative Language HTTP API when an API key
 * is set, falls back to the `gemini` CLI for OAuth-only users.
 *
 * Why two paths: the OAuth tier hits hard daily quotas on gemini-2.5-pro
 * after a handful of calls, and the CLI's stream-json output reports 0/0
 * tokens for OAuth runs. The HTTP path with GEMINI_API_KEY bypasses both —
 * paid quotas and full usage data. CLI fallback keeps personal-tier free-OAuth
 * users working out of the box.
 *
 * Auth precedence:
 *   1. GEMINI_API_KEY  → HTTP path (preferred)
 *   2. GOOGLE_API_KEY  → HTTP path
 *   3. ~/.gemini/oauth_creds.json or ~/.config/gemini/  → CLI path
 */
const GENLANG_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-pro';

interface GenLangResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';
  readonly family = 'gemini' as const;

  async available(): Promise<AvailabilityCheck> {
    if (this.apiKey()) return { ok: true };

    const res = spawnSync('sh', ['-c', 'command -v gemini'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'gemini CLI not found on PATH. Install per https://github.com/google-gemini/gemini-cli, or export GEMINI_API_KEY.' };
    }
    const legacyCfgDir = path.join(os.homedir(), '.config', 'gemini');
    const newOauth = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(legacyCfgDir) && !fs.existsSync(newOauth)) {
      return { ok: false, reason: 'No Gemini auth found. Log in via `gemini` interactive session, or export GEMINI_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    return this.apiKey() ? this.runHttp(opts) : this.runCli(opts);
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? DEFAULT_MODEL);
  }

  private apiKey(): string | undefined {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  }

  private async runHttp(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    const key = this.apiKey()!;
    const model = opts.model ?? DEFAULT_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const res = await fetch(`${GENLANG_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: opts.prompt }] }] }),
        signal: controller.signal,
      });

      const durationMs = Date.now() - start;
      const bodyText = await res.text();

      if (!res.ok) {
        const reason = bodyText.slice(0, 400) || `${res.status} ${res.statusText}`;
        if (res.status === 401 || res.status === 403) {
          return this.emptyResult(durationMs, { code: 'auth', reason }, model);
        }
        if (res.status === 429) {
          return this.emptyResult(durationMs, { code: 'rate_limit', reason }, model);
        }
        return this.emptyResult(durationMs, { code: 'unknown', reason }, model);
      }

      const data = JSON.parse(bodyText) as GenLangResponse;
      const output = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');

      const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const candidates = data.usageMetadata?.candidatesTokenCount ?? 0;
      // Reasoning ("thoughts") tokens are billed as output by Google. Fold them in
      // so cost estimation matches the real bill.
      const thoughts = data.usageMetadata?.thoughtsTokenCount ?? 0;
      const cached = data.usageMetadata?.cachedContentTokenCount;

      return {
        output,
        tokens: {
          input: promptTokens,
          output: candidates + thoughts,
          ...(cached !== undefined ? { cached } : {}),
        },
        durationMs,
        toolCalls: 0,
        modelUsed: data.modelVersion ?? model,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: (e.message ?? 'unknown').slice(0, 400) }, model);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runCli(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
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
        modelUsed: parsed.modelUsed || opts.model || DEFAULT_MODEL,
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
      modelUsed: model ?? DEFAULT_MODEL,
      error,
    };
  }
}
