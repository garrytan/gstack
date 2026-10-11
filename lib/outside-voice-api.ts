/**
 * outside-voice-api — the `api` runner's transport (plan B3): one direct
 * model call with OPENAI_API_KEY or ANTHROPIC_API_KEY, chosen by the model's
 * family. It is a supplied-input review: the model sees the prompt bytes and
 * nothing else (no repository, no tools), and the runner labels the record so
 * it is never silently equal to a repo-reading review. Every send writes an
 * egress receipt first (lib/egress-receipt.ts). Base URLs honor the providers'
 * own environment variables (OPENAI_BASE_URL, ANTHROPIC_BASE_URL) so a test
 * can point them at a local server.
 */
import { sha256Hex, writeReceipt } from './egress-receipt';
import { modelFamily, type ModelFamily } from './outside-voice-runner';

export interface ApiCallRequest { model: string; prompt: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal; maxTokens?: number }
export interface ApiUsage { input_tokens?: number; output_tokens?: number }
export interface ApiCallResult { text: string; model: string; usage: ApiUsage; provider: 'openai' | 'anthropic'; status: number }

export const API_FAMILIES: readonly ModelFamily[] = ['openai', 'anthropic'];

export function apiKeyFor(family: ModelFamily, env: Record<string, string | undefined> = process.env): { key: string; provider: 'openai' | 'anthropic' } | undefined {
  if (family === 'openai' && env.OPENAI_API_KEY) return { key: env.OPENAI_API_KEY, provider: 'openai' };
  if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return { key: env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  return undefined;
}

function receipted(url: string, body: string, provider: string): void {
  try {
    writeReceipt({
      sink: 'outside-voice-api', host: new URL(url).host, payloadClass: 'review-prompt', bytes: Buffer.byteLength(body), sha256: sha256Hex(body),
      consent: `user ran gstack-outside-voice --runner api (${provider.toUpperCase()}_API_KEY configured)`,
    });
  } catch (err) {
    process.stderr.write(`[outside-voice] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);
  }
}

async function post(url: string, headers: Record<string, string>, body: string, req: ApiCallRequest, provider: string): Promise<{ status: number; json: any }> {
  receipted(url, body, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${req.timeoutMs} ms`)), req.timeoutMs);
  req.signal?.addEventListener('abort', () => controller.abort(req.signal!.reason), { once: true });
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally { clearTimeout(timer); }
}

/** One call; throws with the provider's error text on a non-2xx status. */
export async function callModel(req: ApiCallRequest): Promise<ApiCallResult> {
  const env = req.env ?? process.env;
  const family = modelFamily(req.model);
  const auth = apiKeyFor(family, env);
  if (!auth) throw new Error(`no API key for model family ${family} (set ${family === 'anthropic' ? 'ANTHROPIC_API_KEY' : family === 'openai' ? 'OPENAI_API_KEY' : 'OPENAI_API_KEY or ANTHROPIC_API_KEY and name a model from that family'})`);
  const model = req.model.includes('/') ? req.model.slice(req.model.indexOf('/') + 1) : req.model;
  if (auth.provider === 'anthropic') {
    const base = (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const body = JSON.stringify({ model, max_tokens: req.maxTokens ?? 8192, messages: [{ role: 'user', content: req.prompt }] });
    const { status, json } = await post(`${base}/v1/messages`, { 'x-api-key': auth.key, 'anthropic-version': '2023-06-01' }, body, req, 'anthropic');
    if (status < 200 || status >= 300) throw new Error(`anthropic ${status}: ${json?.error?.message ?? json?.raw ?? JSON.stringify(json)}`);
    const text = Array.isArray(json?.content) ? json.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
    return { text, model: typeof json?.model === 'string' ? json.model : model, usage: { input_tokens: json?.usage?.input_tokens, output_tokens: json?.usage?.output_tokens }, provider: 'anthropic', status };
  }
  const base = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: req.prompt }] });
  const { status, json } = await post(`${base}/chat/completions`, { authorization: `Bearer ${auth.key}` }, body, req, 'openai');
  if (status < 200 || status >= 300) throw new Error(`openai ${status}: ${json?.error?.message ?? json?.raw ?? JSON.stringify(json)}`);
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('\n') : '';
  return { text, model: typeof json?.model === 'string' ? json.model : model, usage: { input_tokens: json?.usage?.prompt_tokens, output_tokens: json?.usage?.completion_tokens }, provider: 'openai', status };
}
