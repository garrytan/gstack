/**
 * Provider interface for AI-powered design generation.
 *
 * Abstracts image generation and vision across OpenAI and Google Gemini.
 * Each provider implements a single class with four capability methods
 * (generateImage, vision, supportsImageRef, supportsThreading) and a name.
 *
 * Callers resolve a concrete provider via getProvider() in ./factory.
 */

export interface ImageGenOptions {
  prompt: string;
  /**
   * Size hint. OpenAI accepts "1536x1024" style. Gemini maps the ratio to the
   * nearest supported aspect ratio ("16:9", "9:16", "1:1", etc).
   */
  size?: string;
  /**
   * OpenAI-specific quality knob: "low" | "medium" | "high" | "auto".
   * Gemini ignores this.
   */
  quality?: string;
  /**
   * For multi-turn iteration on OpenAI: the response ID from a previous call.
   * Gemini has no equivalent and will THROW a ProviderError if this is set —
   * callers must detect threading support via supportsThreading() first and
   * fall back to the accumulated-prompt path when it returns false.
   */
  previousResponseId?: string;
  /**
   * Reference image for image-to-image generation. Gemini handles this natively
   * by passing inlineData alongside the text prompt. OpenAI does not support it
   * in the image_generation tool, so OpenAI callers must fall back to
   * vision-then-generate via two API calls.
   */
  referenceImage?: { data: string; mimeType: string };
}

export interface ImageGenResult {
  /** Base64-encoded image bytes, no data: prefix. */
  imageData: string;
  /**
   * Opaque provider-specific ID. Pass back via previousResponseId for threading.
   * Gemini returns a synthetic ID since it has no real response_id concept.
   */
  responseId: string;
  /** MIME type of the returned image (usually image/png). */
  mimeType: string;
}

export interface VisionOptions {
  prompt: string;
  images: Array<{ data: string; mimeType: string }>;
  /** Soft cap on output tokens. Defaults to 400. */
  maxTokens?: number;
  /**
   * Request a JSON response. OpenAI sets response_format:{type:"json_object"}.
   * Gemini sets generationConfig.responseMimeType:"application/json".
   */
  jsonMode?: boolean;
}

export interface VisionResult {
  /** Raw text output, trimmed. If jsonMode was requested, this is a JSON string. */
  text: string;
}

export interface DesignProvider {
  readonly name: "openai" | "gemini";

  /** True if the provider natively accepts a reference image for image-to-image. */
  supportsImageRef(): boolean;

  /** True if the provider supports response_id threading for multi-turn iteration. */
  supportsThreading(): boolean;

  generateImage(opts: ImageGenOptions): Promise<ImageGenResult>;
  vision(opts: VisionOptions): Promise<VisionResult>;
}

/** Where to get API keys. Used by factory errors and provider AUTH_HINTs. */
export const GEMINI_KEY_URL = "https://aistudio.google.com/app/apikey";
export const OPENAI_KEY_URL = "https://platform.openai.com/api-keys";

export type ProviderName = DesignProvider["name"];

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerName?: string,
    /**
     * Advisory metadata. Providers set this to true on transient errors (429,
     * 5xx, AbortError) so callers CAN implement retry-with-backoff if they
     * want to. Providers themselves do NOT retry — retry policy is left to
     * callers so the single-shot latency stays predictable for scripts and
     * pipelines. Treat this field as a hint, not an instruction.
     */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
