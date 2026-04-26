import type {
  DesignProvider,
  ImageGenOptions,
  ImageGenResult,
  VisionOptions,
  VisionResult,
} from "./provider";
import { ProviderError } from "./provider";

const IMAGE_TIMEOUT_MS = 120_000;
const VISION_TIMEOUT_MS = 60_000;

const ORG_VERIFY_HINT =
  "OpenAI organization verification required.\n"
  + "Go to https://platform.openai.com/settings/organization to verify.\n"
  + "After verification, wait up to 15 minutes for access to propagate.";

/** Transient HTTP statuses that callers should treat as worth retrying with backoff. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** True if an error is an AbortController-driven timeout (DOMException or generic). */
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
function normalizeError(err: unknown, name: "openai", context: string, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAbortError(err)) {
    return new ProviderError(`${context} request timed out after ${timeoutMs}ms`, undefined, name, true);
  }
  const msg = (err as Error)?.message || String(err);
  return new ProviderError(`${context} transport error: ${msg}`, undefined, name, true);
}

export class OpenAIProvider implements DesignProvider {
  readonly name = "openai" as const;

  constructor(private readonly apiKey: string) {}

  supportsImageRef(): boolean {
    return false;
  }

  supportsThreading(): boolean {
    return true;
  }

  async generateImage(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (opts.referenceImage) {
      throw new ProviderError(
        "OpenAI image_generation tool does not accept reference images directly. "
        + "Callers must use vision-then-generate (see evolve.ts).",
        undefined, "openai", false,
      );
    }

    const size = opts.size || "1536x1024";
    const quality = opts.quality || "high";

    const body: Record<string, unknown> = {
      model: "gpt-4o",
      input: opts.prompt,
      tools: [{ type: "image_generation", size, quality }],
    };
    if (opts.previousResponseId) {
      body.previous_response_id = opts.previousResponseId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 403 && error.includes("organization must be verified")) {
          throw new ProviderError(ORG_VERIFY_HINT, 403, "openai", false);
        }
        throw new ProviderError(
          `OpenAI API error (${response.status}): ${error.slice(0, 300)}`,
          response.status, "openai", isTransient(response.status),
        );
      }

      const data = await response.json() as any;
      const imageItem = data.output?.find(
        (item: any) => item.type === "image_generation_call",
      );

      if (!imageItem?.result) {
        const outputTypes = data.output?.map((o: any) => o.type).join(", ") || "none";
        throw new ProviderError(
          `No image data in OpenAI response. Output types: ${outputTypes}`,
          undefined, "openai", false,
        );
      }

      return {
        imageData: imageItem.result,
        responseId: data.id,
        mimeType: "image/png",
      };
    } catch (err) {
      throw normalizeError(err, "openai", "OpenAI image", IMAGE_TIMEOUT_MS);
    } finally {
      clearTimeout(timeout);
    }
  }

  async vision(opts: VisionOptions): Promise<VisionResult> {
    const content: Array<Record<string, unknown>> = [];

    // Original call sites in diff.ts put the text BEFORE the images, while
    // check.ts/evolve.ts/memory.ts/design-to-code.ts put text AFTER images.
    // GPT-4o handles both orderings correctly, so we standardize on
    // images-first-then-text (the more common pattern in this codebase).
    for (const img of opts.images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      });
    }
    content.push({ type: "text", text: opts.prompt });

    const body: Record<string, unknown> = {
      model: "gpt-4o",
      messages: [{ role: "user", content }],
      max_tokens: opts.maxTokens ?? 400,
    };
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 403 && error.includes("organization must be verified")) {
          throw new ProviderError(ORG_VERIFY_HINT, 403, "openai", false);
        }
        throw new ProviderError(
          `OpenAI vision error (${response.status}): ${error.slice(0, 300)}`,
          response.status, "openai", isTransient(response.status),
        );
      }

      const data = await response.json() as any;
      const text = data.choices?.[0]?.message?.content?.trim() || "";
      return { text };
    } catch (err) {
      throw normalizeError(err, "openai", "OpenAI vision", VISION_TIMEOUT_MS);
    } finally {
      clearTimeout(timeout);
    }
  }
}
