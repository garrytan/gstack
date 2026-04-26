/**
 * Google Gemini provider: generativelanguage.googleapis.com generateContent.
 *
 * One endpoint handles all three modalities: text generation, image generation,
 * and vision. Image generation uses responseModalities:["IMAGE"] with an
 * optional imageConfig.aspectRatio. Vision uses inlineData parts in contents.
 * Image-to-image (evolve) combines both in a single call.
 *
 * Default image model: gemini-3-pro-image-preview ("Nano Banana 2").
 * Override via GSTACK_GEMINI_IMAGE_MODEL and GSTACK_GEMINI_VISION_MODEL.
 */

import type {
  DesignProvider,
  ImageGenOptions,
  ImageGenResult,
  VisionOptions,
  VisionResult,
} from "./provider";
import { GEMINI_KEY_URL, ProviderError } from "./provider";

const IMAGE_TIMEOUT_MS = 180_000;
const VISION_TIMEOUT_MS = 60_000;

// Read env vars lazily so tests can parametrize per-invocation.
function imageModel(): string {
  return process.env.GSTACK_GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
}
function visionModel(): string {
  return process.env.GSTACK_GEMINI_VISION_MODEL || "gemini-2.5-flash";
}
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const AUTH_HINT =
  "Gemini API key invalid or missing permissions.\n"
  + `Get a key at: ${GEMINI_KEY_URL}\n`
  + "Save to ~/.gstack/gemini.json as { \"api_key\": \"...\" } or set GEMINI_API_KEY.";

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

/**
 * Convert any thrown value from a fetch call site into a ProviderError so
 * callers can always rely on the retryable contract. Re-throws existing
 * ProviderErrors unchanged, wraps AbortError as a transient timeout, and
 * wraps everything else (raw TypeError, DNS/TLS/socket failures, etc.) as
 * a transient transport error.
 */
function normalizeError(err: unknown, context: string, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAbortError(err)) {
    return new ProviderError(`${context} request timed out after ${timeoutMs}ms`, undefined, "gemini", true);
  }
  const msg = (err as Error)?.message || String(err);
  return new ProviderError(`${context} transport error: ${msg}`, undefined, "gemini", true);
}

/**
 * Gemini 3 Pro Image supports: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
 * Map a "WIDTHxHEIGHT" string (OpenAI-style) to the nearest supported ratio.
 */
const SUPPORTED_RATIOS: Array<[string, number]> = [
  ["21:9", 21 / 9],
  ["16:9", 16 / 9],
  ["3:2", 3 / 2],
  ["4:3", 4 / 3],
  ["5:4", 5 / 4],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["3:4", 3 / 4],
  ["2:3", 2 / 3],
  ["9:16", 9 / 16],
];

function sizeToAspectRatio(size?: string): string {
  if (!size) return "16:9";
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return "16:9";
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return "16:9";

  const ratio = w / h;
  let best = SUPPORTED_RATIOS[0];
  let bestDelta = Math.abs(ratio - best[1]);
  for (const candidate of SUPPORTED_RATIOS) {
    const delta = Math.abs(ratio - candidate[1]);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best[0];
}

export class GeminiProvider implements DesignProvider {
  readonly name = "gemini" as const;

  constructor(private readonly apiKey: string) {}

  supportsImageRef(): boolean {
    return true;
  }

  supportsThreading(): boolean {
    // No response_id equivalent. Multi-turn is done by passing a full
    // contents[] conversation history, which callers can build themselves
    // if they need true threading. For now, iterate.ts falls back to the
    // accumulated-prompt path when the provider doesn't support threading.
    return false;
  }

  async generateImage(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (opts.previousResponseId) {
      throw new ProviderError(
        "Gemini does not support response_id threading. "
        + "Check supportsThreading() before passing previousResponseId, "
        + "or build a contents[] history yourself for multi-turn.",
        undefined, "gemini", false,
      );
    }

    const model = imageModel();
    const aspectRatio = sizeToAspectRatio(opts.size);

    const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }];
    if (opts.referenceImage) {
      parts.push({
        inlineData: {
          mimeType: opts.referenceImage.mimeType,
          data: opts.referenceImage.data,
        },
      });
    }

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio },
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${API_BASE}/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(AUTH_HINT, response.status, "gemini", false);
        }
        throw new ProviderError(
          `Gemini API error (${response.status}): ${error.slice(0, 300)}`,
          response.status, "gemini", isTransient(response.status),
        );
      }

      const data = await response.json() as any;
      const candidate = data.candidates?.[0];
      const responseParts = candidate?.content?.parts || [];

      // Response parts can have inlineData (camelCase, REST) or inline_data
      // (snake_case, older responses). Defend against both.
      const imagePart = responseParts.find(
        (p: any) => p.inlineData?.data || p.inline_data?.data,
      );
      const inline = imagePart?.inlineData || imagePart?.inline_data;

      if (!inline?.data) {
        const reason = candidate?.finishReason || "unknown";
        const blockReason = data.promptFeedback?.blockReason;
        const detail = blockReason
          ? `finishReason=${reason}, blockReason=${blockReason}`
          : `finishReason=${reason}`;
        throw new ProviderError(
          `No image data in Gemini response (${detail})`,
          undefined, "gemini", false,
        );
      }

      return {
        imageData: inline.data,
        // Gemini has no real response_id concept — always synthetic.
        responseId: `gemini-${Date.now()}`,
        mimeType: inline.mimeType || inline.mime_type || "image/png",
      };
    } catch (err) {
      throw normalizeError(err, "Gemini image", IMAGE_TIMEOUT_MS);
    } finally {
      clearTimeout(timeout);
    }
  }

  async vision(opts: VisionOptions): Promise<VisionResult> {
    const model = visionModel();

    const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }];
    for (const img of opts.images) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.data,
        },
      });
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: opts.maxTokens ?? 400,
    };
    if (opts.jsonMode) {
      generationConfig.responseMimeType = "application/json";
    }

    const body = {
      contents: [{ parts }],
      generationConfig,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${API_BASE}/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(AUTH_HINT, response.status, "gemini", false);
        }
        throw new ProviderError(
          `Gemini vision error (${response.status}): ${error.slice(0, 300)}`,
          response.status, "gemini", isTransient(response.status),
        );
      }

      const data = await response.json() as any;
      const responseParts = data.candidates?.[0]?.content?.parts || [];
      const textPart = responseParts.find((p: any) => typeof p.text === "string");
      const text = (textPart?.text || "").trim();
      return { text };
    } catch (err) {
      throw normalizeError(err, "Gemini vision", VISION_TIMEOUT_MS);
    } finally {
      clearTimeout(timeout);
    }
  }
}
