/**
 * Image generation provider abstraction.
 *
 * Supports multiple backends:
 *   - openai: OpenAI Responses API (gpt-4o image_generation tool)
 *   - seedream: ByteDance Volcengine Ark API (Seedream text-to-image)
 *
 * Vision tasks (check, diff, memory, design-to-code) remain OpenAI-only
 * since Seedream is a pure image generation model with no vision capability.
 */

import { resolveApiKey, resolveArkApiKey } from "./auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderName = "openai" | "seedream";

export interface ImageGenResult {
  id: string;
  imageData: string; // base64-encoded PNG/JPEG
}

export interface ImageGenOptions {
  prompt: string;
  size: string;
  quality: string;
  signal?: AbortSignal;
  /** OpenAI-specific: thread continuation via previous response */
  previousResponseId?: string;
}

export interface ImageProvider {
  name: ProviderName;
  generateImage(options: ImageGenOptions): Promise<ImageGenResult>;
}

// ---------------------------------------------------------------------------
// Resolve provider from --provider flag or GSTACK_DESIGN_PROVIDER env
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ProviderName[] = ["openai", "seedream"];

export function resolveProvider(flag?: string): ProviderName {
  const name = (flag || process.env.GSTACK_DESIGN_PROVIDER || "openai").toLowerCase();
  if (!VALID_PROVIDERS.includes(name as ProviderName)) {
    console.error(`Unknown provider: ${name}. Valid: ${VALID_PROVIDERS.join(", ")}`);
    process.exit(1);
  }
  return name as ProviderName;
}

export function createProvider(name: ProviderName): ImageProvider {
  switch (name) {
    case "openai":
      return new OpenAIProvider();
    case "seedream":
      return new SeedreamProvider();
  }
}

/**
 * Require API key for a given provider. Exits with guidance if missing.
 */
export function requireProviderKey(provider: ProviderName): string {
  if (provider === "seedream") {
    const key = resolveArkApiKey();
    if (!key) {
      console.error("No Ark API key found for Seedream provider.");
      console.error("");
      console.error("Set ARK_API_KEY environment variable");
      console.error("  or save to ~/.gstack/ark.json: { \"api_key\": \"...\" }");
      console.error("");
      console.error("Get a key at: https://console.volcengine.com/ark");
      process.exit(1);
    }
    return key;
  }

  // OpenAI
  const key = resolveApiKey();
  if (!key) {
    console.error("No OpenAI API key found.");
    console.error("");
    console.error("Run: $D setup");
    console.error("  or save to ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }");
    console.error("  or set OPENAI_API_KEY environment variable");
    console.error("");
    console.error("Get a key at: https://platform.openai.com/api-keys");
    process.exit(1);
  }
  return key;
}

// ---------------------------------------------------------------------------
// OpenAI Provider — Responses API with image_generation tool
// ---------------------------------------------------------------------------

class OpenAIProvider implements ImageProvider {
  name: ProviderName = "openai";

  async generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
    const apiKey = requireProviderKey("openai");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    // Forward external signal
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const body: Record<string, unknown> = {
        model: "gpt-4o",
        input: options.prompt,
        tools: [{
          type: "image_generation",
          size: options.size,
          quality: options.quality,
        }],
      };
      if (options.previousResponseId) {
        body.previous_response_id = options.previousResponseId;
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 403 && error.includes("organization must be verified")) {
          throw new Error(
            "OpenAI organization verification required.\n"
            + "Go to https://platform.openai.com/settings/organization to verify.\n"
            + "After verification, wait up to 15 minutes for access to propagate.",
          );
        }
        throw new Error(`OpenAI API error (${response.status}): ${error.slice(0, 300)}`);
      }

      const data = await response.json() as any;
      const imageItem = data.output?.find((item: any) =>
        item.type === "image_generation_call"
      );

      if (!imageItem?.result) {
        throw new Error(
          `No image data in OpenAI response. Output types: ${data.output?.map((o: any) => o.type).join(", ") || "none"}`
        );
      }

      return { id: data.id, imageData: imageItem.result };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Seedream Provider — Volcengine Ark /images/generations
// ---------------------------------------------------------------------------

/**
 * Map OpenAI-style sizes to Seedream-supported sizes.
 * Seedream 5.0 requires minimum 3686400 pixels (~1920x1920).
 * We map to 2K+ resolutions maintaining aspect ratio.
 */
const SEEDREAM_SIZE_MAP: Record<string, string> = {
  "1536x1024": "2496x1664",   // 3:2 landscape → exact 3:2 at 2K
  "1024x1024": "2048x2048",   // 1:1 → 1:1 at 2K (min pixel requirement)
  "1024x1536": "1664x2496",   // 2:3 portrait → 2:3 at 2K
  "1792x1024": "2560x1440",   // ~16:9 → closest 16:9 at 2K
  "1024x1792": "1440x2560",   // ~9:16 portrait
};

function mapSeedreamSize(size: string): string {
  if (SEEDREAM_SIZE_MAP[size]) return SEEDREAM_SIZE_MAP[size];
  // Ensure minimum pixel count for unknown sizes
  const [w, h] = size.split("x").map(Number);
  if (w && h && w * h < 3686400) {
    const scale = Math.ceil(Math.sqrt(3686400 / (w * h)));
    return `${w * scale}x${h * scale}`;
  }
  return size;
}

const SEEDREAM_DEFAULT_MODEL = "doubao-seedream-5-0-260128";

class SeedreamProvider implements ImageProvider {
  name: ProviderName = "seedream";

  async generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
    const apiKey = requireProviderKey("seedream");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort());
    }

    const mappedSize = mapSeedreamSize(options.size);

    try {
      const response = await fetch(
        "https://ark.cn-beijing.volces.com/api/v3/images/generations",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL,
            prompt: options.prompt,
            size: mappedSize,
            response_format: "b64_json",
            seed: -1,
            watermark: false,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Seedream API error (${response.status}): ${error.slice(0, 300)}`);
      }

      const data = await response.json() as any;
      const imageItem = data.data?.[0];

      if (!imageItem?.b64_json) {
        throw new Error(
          `No image data in Seedream response: ${JSON.stringify(data).slice(0, 200)}`
        );
      }

      return {
        id: `seedream-${Date.now()}`,
        imageData: imageItem.b64_json,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
