import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type GeminiStreamParse = {
  output: string;
  tokens: { input: number; output: number };
  toolCalls: number;
  modelUsed?: string;
};

/**
 * Parse gemini NDJSON stream events (exported for unit tests).
 *
 * Current CLI (`--output-format stream-json`) emits:
 *   init  → model
 *   message { role, content, delta? } → concat assistant content
 *   tool_use → increment toolCalls
 *   result { stats: { input_tokens, output_tokens } } → tokens
 *
 * Legacy shape (still accepted):
 *   message { text } → concat text
 *   result { usage: { input_token_count, output_token_count } } → tokens
 */
export function parseGeminiStreamJson(raw: string): GeminiStreamParse {
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
      if (obj.type === 'init') {
        if (typeof obj.model === 'string' && obj.model) modelUsed = obj.model;
      } else if (obj.type === 'message') {
        // Current CLI: content + role. Role guard is required — the CLI echoes
        // the user prompt as role:'user', which must not land in output.
        if (obj.role === 'assistant' && typeof obj.content === 'string') {
          output += obj.content;
        } else if (typeof obj.text === 'string' && obj.role !== 'user') {
          // Legacy text field (no role, or assistant).
          output += obj.text;
        }
      } else if (obj.type === 'tool_use') {
        toolCalls += 1;
      } else if (obj.type === 'result') {
        const u = obj.usage ?? obj.stats ?? {};
        input += u.input_token_count ?? u.input_tokens ?? u.prompt_tokens ?? 0;
        out += u.output_token_count ?? u.output_tokens ?? u.completion_tokens ?? 0;
        if (typeof obj.model === 'string' && obj.model) modelUsed = obj.model;
      }
    } catch {
      // skip malformed lines
    }
  }
  return { output, tokens: { input, output: out }, toolCalls, modelUsed };
}

/**
 * Map a raw stream-json dump to a RunResult, including the empty-success
 * hardening from #2159. Exported so adapter e2e can exercise the full
 * post-CLI path without a live gemini binary.
 */
export function resultFromGeminiStream(
  raw: string,
  opts: { model?: string; durationMs?: number } = {},
): RunResult {
  const parsed = parseGeminiStreamJson(raw);
  const modelUsed = parsed.modelUsed || opts.model || 'gemini-2.5-pro';
  const durationMs = opts.durationMs ?? 0;
  if (!parsed.output.trim()) {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed,
      error: { code: 'unknown', reason: 'empty output from gemini CLI (exit 0)' },
    };
  }
  return {
    output: parsed.output,
    tokens: parsed.tokens,
    durationMs,
    toolCalls: parsed.toolCalls,
    modelUsed,
  };
}

/**
 * Gemini adapter — wraps the `gemini` CLI.
 *
 * Auth: GEMINI_API_KEY / GOOGLE_API_KEY (preferred), or ~/.gemini oauth.
 *   Personal OAuth free-tier is no longer supported by gemini CLI — use an
 *   AI Studio API key. Antigravity is a separate product/quota path.
 *
 * Headless flags always passed:
 *   --output-format stream-json  — NDJSON events (message/tool_use/result)
 *   --yolo                       — auto-approve tools (non-interactive)
 *   --skip-trust                 — trust cwd for this session; required when
 *                                  workdir is a temp/untrusted folder (benchmarks
 *                                  use mkdtemp). Without it headless gemini exits
 *                                  before calling the model.
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
    // CLI accepts either name; Google AI Studio keys are usually GEMINI_API_KEY.
    const hasKey = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    if (!hasCfg && !hasKey) {
      return {
        ok: false,
        reason:
          'No Gemini auth found. Export GEMINI_API_KEY (or GOOGLE_API_KEY) from https://aistudio.google.com/app/apikey — personal OAuth free-tier is no longer supported by gemini CLI.',
      };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Default to --yolo (non-interactive) and stream-json output so we can parse
    // tokens + tool calls. --skip-trust is required for headless/temp workdirs
    // (gemini CLI otherwise exits: "not running in a trusted directory").
    // Callers can override via extraArgs.
    const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--yolo', '--skip-trust'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      const out = execFileSync('gemini', args, {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          // Prefer GEMINI_API_KEY when only that is set (CLI reads both).
          ...(process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY
            ? { GOOGLE_API_KEY: process.env.GEMINI_API_KEY }
            : {}),
        },
      });
      return resultFromGeminiStream(out, { model: opts.model, durationMs: Date.now() - start });
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login|api key|ineligibletier|no longer supported/i.test(stderr)) {
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
      modelUsed: model ?? 'gemini-2.5-pro',
      error,
    };
  }
}
