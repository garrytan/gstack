import type { ProviderAdapter, RunOpts, RunResult, AvailabilityCheck } from './types';
import { estimateCostUsd } from '../pricing';

/**
 * Ollama adapter — wraps a local Ollama daemon's HTTP API.
 *
 * Unlike Claude/GPT/Gemini (which shell out to a CLI binary), Ollama exposes a
 * native HTTP server on `http://localhost:11434` by default. The adapter talks
 * directly via `fetch()`. No CLI dependency, no auth — the daemon is local.
 *
 * Default model: `qwen2.5-coder:7b` (general-purpose code-leaning model).
 * Override per-run via `RunOpts.model` or globally via `GSTACK_OLLAMA_MODEL`.
 * Override daemon URL via `GSTACK_OLLAMA_URL` (e.g. for a remote / non-default port).
 *
 * Tool-call counting is 0 — the `/api/generate` endpoint emits no tool events.
 * If a future benchmark needs tool calls, switch to `/api/chat` with `tools[]`.
 * Cost is always 0 — Ollama runs locally on the user's machine.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly name = 'ollama';
  readonly family = 'ollama' as const;

  private get baseUrl(): string {
    return (process.env.GSTACK_OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  }

  private get defaultModel(): string {
    return process.env.GSTACK_OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
  }

  async available(): Promise<AvailabilityCheck> {
    // Probe the tags endpoint with a tight timeout. A live daemon responds in
    // ~5-50ms; a missing one fails immediately with ECONNREFUSED.
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, reason: `Ollama daemon at ${this.baseUrl} returned HTTP ${res.status}. Is it healthy? Try \`ollama serve\`.` };
      }
      const body = await res.json() as { models?: Array<{ name: string }> };
      if (!body.models || body.models.length === 0) {
        return { ok: false, reason: `Ollama daemon at ${this.baseUrl} has no models pulled. Run \`ollama pull ${this.defaultModel}\`.` };
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/abort/i.test(msg)) {
        return { ok: false, reason: `Ollama daemon at ${this.baseUrl} did not respond within 2s. Start it with \`ollama serve\` or set GSTACK_OLLAMA_URL.` };
      }
      return { ok: false, reason: `Ollama daemon not reachable at ${this.baseUrl} (${msg.slice(0, 200)}). Install from https://ollama.com or set GSTACK_OLLAMA_URL.` };
    } finally {
      clearTimeout(tid);
    }
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    const model = opts.model ?? this.defaultModel;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), opts.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: opts.prompt,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const durationMs = Date.now() - start;
        if (res.status === 404) {
          return this.emptyResult(durationMs, model, { code: 'unknown', reason: `model '${model}' not found. Pull it with \`ollama pull ${model}\`. ${text.slice(0, 200)}` });
        }
        return this.emptyResult(durationMs, model, { code: 'unknown', reason: `HTTP ${res.status}: ${text.slice(0, 400)}` });
      }
      const body = await res.json() as {
        response?: string;
        model?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        done?: boolean;
      };
      return {
        output: body.response ?? '',
        tokens: {
          input: body.prompt_eval_count ?? 0,
          output: body.eval_count ?? 0,
        },
        durationMs: Date.now() - start,
        toolCalls: 0,
        modelUsed: body.model ?? model,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const msg = (err as Error).message ?? String(err);
      if (/abort/i.test(msg)) {
        return this.emptyResult(durationMs, model, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` });
      }
      if (/ECONNREFUSED|fetch failed|getaddrinfo/i.test(msg)) {
        return this.emptyResult(durationMs, model, { code: 'binary_missing', reason: `Ollama daemon not reachable at ${this.baseUrl}. Start it with \`ollama serve\`.` });
      }
      return this.emptyResult(durationMs, model, { code: 'unknown', reason: msg.slice(0, 400) });
    } finally {
      clearTimeout(tid);
    }
  }

  estimateCost(_tokens: { input: number; output: number; cached?: number }, model?: string): number {
    // Local inference — no API cost. Pass through to pricing table anyway so
    // future cloud-hosted Ollama runners (e.g. via paid GPU) can override.
    return estimateCostUsd(_tokens, model ?? this.defaultModel);
  }

  private emptyResult(durationMs: number, model: string, error: RunResult['error']): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model,
      error,
    };
  }
}
