/**
 * The design binary's provider seam: which image service a run talks to
 * (OpenAI or Gemini, picked by auth.ts resolveProvider) and how each call's
 * request is built and its response read. Call sites keep their own fetch,
 * timeouts and retry loops; this module only shapes requests, responses and
 * errors, so OpenAI requests stay byte-identical to what they were.
 *
 * Gemini image calls use the native generateContent API
 * (POST /v1beta/models/<model>:generateContent, responseModalities IMAGE,
 * imageConfig.aspectRatio); vision calls reuse the Chat Completions body on
 * Google's OpenAI-compatible endpoint (/v1beta/openai/chat/completions).
 * The key travels only in a header (x-goog-api-key or Authorization), never
 * in a URL, and OPENAI_BASE_URL never redirects a Gemini call.
 * Shapes: https://ai.google.dev/gemini-api/docs/image-generation and
 * https://ai.google.dev/gemini-api/docs/openai (checked 2026-10-31).
 */

import { openaiUrl, resolveGeminiKeyInfo, describeKeySource, type ProviderKey, type ProviderName } from "./auth";
import { DESIGN_RECEIPTS, type ReceiptSink } from "./receipted-fetch";
import {
  geminiAspectRatio,
  geminiModel,
  imageRequestBody,
  modelRejectionHint,
  REASONING_HEADROOM_TOKENS,
  visionRequestBody,
  type DesignCall,
} from "./models";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** A caller may pass a bare OpenAI key (the pre-provider API) or a resolved provider. */
export type DesignAuth = string | ProviderKey;

export function asProvider(auth: DesignAuth): ProviderKey {
  return typeof auth === "string" ? { provider: "openai", key: auth, source: "caller" } : auth;
}

export interface DesignRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
  receipt: ReceiptSink;
}

export interface ImageAsk {
  prompt: string;
  size: string;
  quality: string;
  /** Base64 PNGs sent with the prompt (Gemini only: the image to edit). */
  images?: string[];
  /** OpenAI only: continue a Responses API thread. */
  previousResponseId?: string;
}

const post = (url: string, headers: Record<string, string>, body: string, provider: ProviderName): DesignRequest => ({
  url,
  init: { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body },
  receipt: DESIGN_RECEIPTS[provider],
});

/** The request for one image call. Throws, before anything is sent, on a bad model override or size. */
export function imageRequest(auth: DesignAuth, ask: ImageAsk): DesignRequest {
  const p = asProvider(auth);
  if (p.provider === "openai") {
    const extra = ask.previousResponseId ? { previous_response_id: ask.previousResponseId } : {};
    return post(openaiUrl("responses"), { Authorization: `Bearer ${p.key}` },
      imageRequestBody(ask.prompt, { size: ask.size, quality: ask.quality }, extra), "openai");
  }
  const parts: unknown[] = (ask.images ?? []).map(data => ({ inlineData: { mimeType: "image/png", data } }));
  parts.push({ text: ask.prompt });
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: geminiAspectRatio(ask.size) } },
  });
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(geminiModel("image"))}:generateContent`;
  return post(url, { "x-goog-api-key": p.key }, body, "gemini");
}

/** The request for one vision call: the same Chat Completions body on either provider. */
export function visionRequest(auth: DesignAuth, messages: unknown[], visibleTokens: number, extra: Record<string, unknown> = {}): DesignRequest {
  const p = asProvider(auth);
  if (p.provider === "openai") {
    return post(openaiUrl("chat/completions"), { Authorization: `Bearer ${p.key}` }, visionRequestBody(messages, visibleTokens, extra), "openai");
  }
  const body = JSON.stringify({
    model: geminiModel("vision"),
    messages,
    max_completion_tokens: visibleTokens + REASONING_HEADROOM_TOKENS,
    ...extra,
  });
  return post(`${GEMINI_API_BASE}/openai/chat/completions`, { Authorization: `Bearer ${p.key}` }, body, "gemini");
}

/** A failure the caller must not pay to repeat (a safety block, a quota that will not refill soon). */
export class DesignImageError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const GEMINI_BLOCK_REASONS = new Set(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);

/**
 * The image in a successful response, or null when it held none (OpenAI: no
 * image_generation_call; Gemini: an empty answer with a normal finish). A
 * Gemini safety block or text-only answer throws a non-retryable
 * DesignImageError: asking again would buy the same refusal.
 */
export function readImage(auth: DesignAuth, data: any): { responseId: string; imageData: string } | null {
  const p = asProvider(auth);
  if (p.provider === "openai") {
    const item = data?.output?.find((o: any) => o.type === "image_generation_call");
    return item?.result ? { responseId: data.id, imageData: item.result } : null;
  }
  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new DesignImageError(`Gemini blocked this brief (${blocked}). Fix: rephrase the brief.`, false);
  const candidate = data?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts ?? [];
  const images = parts.filter(part => {
    const inline = part?.inlineData ?? part?.inline_data;
    return typeof inline?.data === "string" && String(inline.mimeType ?? inline.mime_type ?? "").startsWith("image/");
  });
  const image = images.findLast(part => part?.thought !== true) ?? images.at(-1);
  if (image) {
    const inline = image.inlineData ?? image.inline_data;
    const mime = inline.mimeType ?? inline.mime_type;
    if (mime !== "image/png") throw new DesignImageError(`Gemini returned ${mime}, not a PNG; nothing was saved.`, false);
    return { responseId: data.responseId || `gemini-${Date.now()}`, imageData: inline.data };
  }
  const finish = candidate?.finishReason;
  if (finish && GEMINI_BLOCK_REASONS.has(finish)) throw new DesignImageError(`Gemini blocked this brief (${finish}). Fix: rephrase the brief.`, false);
  const text = parts.map(part => part?.text).filter(Boolean).join(" ").trim();
  if (text) throw new DesignImageError(`Gemini answered with text instead of an image: ${text.slice(0, 200)}`, false);
  return null;
}

/** OpenAI's org-verification refusal (every OpenAI image model needs a verified organization). */
export function isOpenAiVerificationError(status: number, body: string): boolean {
  return status === 403 && body.includes("organization must be verified");
}

/** The last line of an OpenAI org-verification error: how to reach Gemini instead. */
export function geminiSwitchFix(): string {
  const gemini = resolveGeminiKeyInfo();
  if (gemini) return `Fix: a Gemini key is configured (${describeKeySource("gemini", gemini)}); set GSTACK_DESIGN_PROVIDER=gemini to use it.`;
  return "Fix: or use Gemini instead: get a free key at https://aistudio.google.com/apikey, run $D setup --provider gemini, then set GSTACK_DESIGN_PROVIDER=gemini.";
}

export interface ProviderFailure {
  message: string;
  retryable: boolean;
  /** Gemini's RetryInfo delay for a recoverable 429, uncapped (the caller caps it). */
  retryAfterMs?: number;
}

const retryDelayMs = (details: any[]): number | undefined => {
  const delay = details.find(d => typeof d?.retryDelay === "string")?.retryDelay as string | undefined;
  const seconds = delay ? Number.parseFloat(delay) : NaN;
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
};

/**
 * A Gemini HTTP failure as a message whose last line says how to fix it,
 * with whether repeating the request could succeed. Names the provider, the
 * model and where the key came from, never the key.
 */
export function geminiFailure(auth: DesignAuth, status: number, body: string, call: DesignCall): ProviderFailure {
  const p = asProvider(auth);
  let error: any = {};
  try { error = JSON.parse(body)?.error ?? {}; } catch { /* non-JSON body */ }
  const message = String(error.message ?? body).slice(0, 300);
  const details: any[] = Array.isArray(error.details) ? error.details : [];
  const reasons = details.map(d => d?.reason).filter(Boolean).join(" ");
  const model = geminiModel(call);
  const head = `Gemini API error (${status}, model ${model}, key from ${p.source}): ${message}`;
  if (/API_KEY_INVALID/.test(reasons) || /API key not valid/i.test(message)) {
    return { message: `${head}\nFix: create a key at https://aistudio.google.com/apikey and run $D setup --provider gemini. See docs/troubleshooting.md#design-gemini-key-rejected`, retryable: false };
  }
  if (status === 429) {
    const perDay = /PerDay/i.test(JSON.stringify(details)) || /limit: 0\b/.test(message);
    if (perDay) {
      return { message: `${head}\nFix: this key has no ${call} quota left today (free-tier keys may have none for image models); enable billing in Google AI Studio or set GSTACK_DESIGN_PROVIDER=openai. See docs/troubleshooting.md#design-gemini-quota`, retryable: false };
    }
    return { message: `Rate limited (429): ${message}`, retryable: true, retryAfterMs: retryDelayMs(details) };
  }
  if (status === 403 || /SERVICE_DISABLED|PERMISSION_DENIED/.test(reasons)) {
    return { message: `${head}\nFix: enable the Generative Language API for this key's Google Cloud project, or set GSTACK_DESIGN_PROVIDER=openai. See docs/troubleshooting.md#design-gemini-key-rejected`, retryable: false };
  }
  if (status === 400 && /location is not supported/i.test(message)) {
    return { message: `${head}\nFix: the Gemini API is not offered in your region; use OpenAI (set GSTACK_DESIGN_PROVIDER=openai).`, retryable: false };
  }
  if (status === 404) {
    const variable = call === "image" ? "GSTACK_DESIGN_IMAGE_MODEL" : "GSTACK_DESIGN_MODEL";
    return { message: `${head}\nFix: set ${variable} to a Gemini model your key can use, or unset it. See docs/troubleshooting.md#design-image-model-invalid`, retryable: false };
  }
  return { message: head, retryable: status >= 500 };
}

/** The suffix a vision caller appends to an HTTP error: OpenAI's model hint, or Gemini's mapped reason. */
export function visionErrorHint(auth: DesignAuth, status: number, body: string): string {
  const p = asProvider(auth);
  if (p.provider === "openai") return modelRejectionHint(status, body, "vision");
  return ` — ${geminiFailure(p, status, body, "vision").message.replace(/\n/g, " ")}`;
}
