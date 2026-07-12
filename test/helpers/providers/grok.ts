import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type GrokParsedOutput = {
  output: string;
  tokens: { input: number; output: number; cached?: number };
  toolCalls: number;
  modelUsed?: string;
};

/**
 * Parse Grok headless stdout.
 *
 * Characterized 2026-07 against grok 0.2.93:
 *   --output-format json →
 *     { text, stopReason, sessionId, requestId, thought? }
 *   --output-format streaming-json →
 *     NDJSON {type:"thought"|"text"|"end", ...} — end has stopReason/sessionId
 * Neither shape exposes usage today. When a future CLI adds usage, accept
 * common field names (input_tokens/output_tokens, prompt_tokens/completion_tokens,
 * nested usage object). Never invent token counts from prompt/output length.
 */
export function parseGrokOutput(raw: string): GrokParsedOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { output: '', tokens: { input: 0, output: 0 }, toolCalls: 0 };
  }

  // Single JSON object (default headless json format)
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return parseGrokJsonObject(obj as Record<string, unknown>);
    }
  } catch {
    // fall through to NDJSON / plain text
  }

  // streaming-json NDJSON lines
  if (trimmed.includes('\n') || trimmed.startsWith('{')) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    let looksNdjson = 0;
    let textParts: string[] = [];
    let tokens = { input: 0, output: 0 } as { input: number; output: number; cached?: number };
    let toolCalls = 0;
    let modelUsed: string | undefined;
    let sawUsage = false;

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        looksNdjson++;
        const t = ev.type;
        if (t === 'text' && typeof ev.data === 'string') {
          textParts.push(ev.data);
        } else if (t === 'message' && typeof ev.data === 'string') {
          textParts.push(ev.data);
        } else if (typeof ev.text === 'string') {
          textParts.push(ev.text);
        }
        const fromEv = extractUsage(ev);
        if (fromEv) {
          tokens = fromEv.tokens;
          sawUsage = true;
          if (fromEv.cached !== undefined) tokens = { ...tokens, cached: fromEv.cached };
        }
        if (typeof ev.model === 'string') modelUsed = ev.model;
        if (typeof ev.modelUsed === 'string') modelUsed = ev.modelUsed;
        if (typeof ev.num_turns === 'number') toolCalls = ev.num_turns;
        if (typeof ev.tool_calls === 'number') toolCalls = ev.tool_calls;
        if (typeof ev.toolCallCount === 'number') toolCalls = ev.toolCallCount;
      } catch {
        // non-JSON line — ignore for NDJSON path
      }
    }

    if (looksNdjson > 0 && (textParts.length > 0 || sawUsage || lines.length === looksNdjson)) {
      return {
        output: textParts.join(''),
        tokens: sawUsage ? tokens : { input: 0, output: 0 },
        toolCalls,
        modelUsed,
      };
    }
  }

  // Plain text fallback — zero tokens (do not estimate from length)
  return { output: raw, tokens: { input: 0, output: 0 }, toolCalls: 0 };
}

function parseGrokJsonObject(obj: Record<string, unknown>): GrokParsedOutput {
  // Preferred text fields for Grok Build; also accept Claude-like `result`
  let output = '';
  if (typeof obj.text === 'string') output = obj.text;
  else if (typeof obj.result === 'string') output = obj.result;
  else if (typeof obj.message === 'string') output = obj.message;
  else if (obj.result != null) output = String(obj.result);

  const usage = extractUsage(obj);
  const tokens = usage
    ? { input: usage.tokens.input, output: usage.tokens.output, ...(usage.cached !== undefined ? { cached: usage.cached } : {}) }
    : { input: 0, output: 0 };

  const toolCalls =
    (typeof obj.num_turns === 'number' ? obj.num_turns : undefined) ??
    (typeof obj.tool_calls === 'number' ? obj.tool_calls : undefined) ??
    (typeof obj.toolCallCount === 'number' ? obj.toolCallCount : undefined) ??
    0;

  const modelUsed =
    (typeof obj.model === 'string' ? obj.model : undefined) ??
    (typeof obj.modelUsed === 'string' ? obj.modelUsed : undefined) ??
    (typeof obj.model_id === 'string' ? obj.model_id : undefined);

  return { output, tokens, toolCalls, modelUsed };
}

function numField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

/** Extract token usage from a JSON object if present; otherwise undefined. */
function extractUsage(
  obj: Record<string, unknown>,
): { tokens: { input: number; output: number }; cached?: number } | undefined {
  const nested =
    obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)
      ? (obj.usage as Record<string, unknown>)
      : null;

  const sources = nested ? [nested, obj] : [obj];
  for (const src of sources) {
    const input = numField(
      src,
      'input_tokens',
      'prompt_tokens',
      'inputTokens',
      'promptTokens',
      'input_token_count',
    );
    const output = numField(
      src,
      'output_tokens',
      'completion_tokens',
      'outputTokens',
      'completionTokens',
      'output_token_count',
    );
    if (input !== undefined || output !== undefined) {
      const cached = numField(
        src,
        'cache_read_input_tokens',
        'cached_prompt_tokens',
        'cached_tokens',
        'cached',
      );
      return {
        tokens: { input: input ?? 0, output: output ?? 0 },
        ...(cached !== undefined ? { cached } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Structural auth check only — never log file or env values.
 * Valid auth.json: non-empty JSON object with ≥1 key (OAuth shapes use URL keys).
 * Reject: missing, empty/whitespace, invalid JSON, null, arrays, {}.
 */
export function isStructurallyValidGrokAuthFile(authPath: string): boolean {
  try {
    if (!fs.existsSync(authPath)) return false;
    const raw = fs.readFileSync(authPath, 'utf-8');
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.keys(parsed as object).length > 0;
  } catch {
    return false;
  }
}

function hasNonBlankEnvKey(): boolean {
  const xai = process.env.XAI_API_KEY?.trim();
  const grok = process.env.GROK_API_KEY?.trim();
  return !!(xai || grok);
}

/**
 * Grok adapter — wraps the `grok` CLI via -p / --single / --prompt-file.
 *
 * Auth readiness: CLI present + (structurally valid ~/.grok/auth.json OR
 * non-blank XAI_API_KEY / GROK_API_KEY after trim). Never log secret values.
 * No network probe in available().
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
    const hasValidAuthFile = isStructurallyValidGrokAuthFile(authPath);
    const hasKey = hasNonBlankEnvKey();
    if (!hasValidAuthFile && !hasKey) {
      return {
        ok: false,
        reason:
          'No Grok auth found. Log in via `grok` interactive session (non-empty auth.json), or export a non-blank XAI_API_KEY / GROK_API_KEY.',
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
    // Request JSON so we can parse usage when the CLI exposes it (currently often omitted).
    args.push('--output-format', 'json');
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
      const raw = typeof out === 'string' ? out : String(out);
      const parsed = parseGrokOutput(raw);
      return {
        output: parsed.output,
        tokens: parsed.tokens,
        durationMs: Date.now() - start,
        toolCalls: parsed.toolCalls,
        modelUsed: parsed.modelUsed || opts.model || 'grok',
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
