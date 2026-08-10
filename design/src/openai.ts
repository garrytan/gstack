/**
 * Shared OpenAI transport for the design CLI.
 *
 * Every design command talks to one of two endpoints — the Responses API with
 * the image_generation tool, or chat/completions with a vision message — and
 * each one previously carried its own copy of the abort-timeout dance, the
 * 403 "organization must be verified" special case, and the
 * image_generation_call result extraction. They live here once.
 */

export const RESPONSES_URL = "https://api.openai.com/v1/responses";
export const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

const TEXT_MODEL = "gpt-4o";
const IMAGE_MODEL = "gpt-image-2";

export const DEFAULT_IMAGE_SIZE = "1536x1024";
export const DEFAULT_IMAGE_QUALITY = "high";

/** Image generation is slow; vision calls are not. */
export const IMAGE_TIMEOUT_MS = 240_000;
export const VISION_TIMEOUT_MS = 60_000;

const ORG_VERIFICATION_MESSAGE =
  "OpenAI organization verification required.\n"
  + "Go to https://platform.openai.com/settings/organization to verify.\n"
  + "After verification, wait up to 15 minutes for access to propagate.";

export interface GeneratedImage {
  responseId: string;
  imageData: string;  // base64 PNG
}

export function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/** gpt-image-2 tool spec shared by every generation path. */
export function imageGenerationTool(size: string, quality: string) {
  return { type: "image_generation", model: IMAGE_MODEL, size, quality };
}

/** Org verification is a distinct failure: callers surface it as guidance, not a bug. */
export function isOrgVerificationError(status: number, body: string): boolean {
  return status === 403 && body.includes("organization must be verified");
}

export function apiErrorMessage(status: number, body: string): string {
  if (isOrgVerificationError(status, body)) return ORG_VERIFICATION_MESSAGE;
  return `API error (${status}): ${body.slice(0, 300)}`;
}

/** Read the error body off a non-OK response and turn it into a typed Error. */
export async function apiError(response: Response): Promise<Error> {
  return new Error(apiErrorMessage(response.status, await response.text()));
}

/** Run `fn` with an AbortSignal that fires after `ms`, always clearing the timer. */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/** Pull the base64 PNG out of a Responses API payload. */
export function extractGeneratedImage(data: any, label = "response"): GeneratedImage {
  const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");
  if (!imageItem?.result) {
    const types = data.output?.map((o: any) => o.type).join(", ") || "none";
    throw new Error(`No image data in ${label}. Output types: ${types}`);
  }
  return { responseId: data.id, imageData: imageItem.result };
}

export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  quality?: string;
  /** Thread onto a prior Responses API turn instead of starting fresh. */
  previousResponseId?: string;
  /** Label used in the "no image data" error, e.g. "threaded response". */
  label?: string;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Generate one image via the Responses API. Throws on transport errors, on a
 * non-OK status, and when the payload carries no image.
 */
export async function generateImage(
  apiKey: string,
  options: GenerateImageOptions,
): Promise<GeneratedImage> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return withTimeout(IMAGE_TIMEOUT_MS, async (signal) => {
    const body: Record<string, unknown> = {
      model: TEXT_MODEL,
      input: options.prompt,
      tools: [imageGenerationTool(
        options.size ?? DEFAULT_IMAGE_SIZE,
        options.quality ?? DEFAULT_IMAGE_QUALITY,
      )],
    };
    if (options.previousResponseId) body.previous_response_id = options.previousResponseId;

    const response = await fetchFn(RESPONSES_URL, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) throw await apiError(response);
    return extractGeneratedImage(await response.json(), options.label);
  });
}

export interface VisionRequest {
  imageBase64: string;
  /** Instruction text sent alongside the image. */
  text: string;
  maxTokens: number;
  /** Ask the model for a JSON object response. */
  json?: boolean;
  timeoutMs?: number;
}

export type VisionResult =
  | { ok: true; content: string }
  | { ok: false; status: number; body: string; orgUnverified: boolean };

/**
 * Send one image + one instruction to the vision model. Non-OK responses come
 * back as data rather than exceptions — every caller degrades instead of
 * failing the command.
 */
export async function visionRequest(
  apiKey: string,
  request: VisionRequest,
): Promise<VisionResult> {
  return withTimeout(request.timeoutMs ?? VISION_TIMEOUT_MS, async (signal) => {
    const body: Record<string, unknown> = {
      model: TEXT_MODEL,
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${request.imageBase64}` },
          },
          { type: "text", text: request.text },
        ],
      }],
      max_tokens: request.maxTokens,
    };
    if (request.json) body.response_format = { type: "json_object" };

    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        status: response.status,
        body: text,
        orgUnverified: isOrgVerificationError(response.status, text),
      };
    }

    const data = await response.json() as any;
    return { ok: true, content: data.choices?.[0]?.message?.content?.trim() || "" };
  });
}
