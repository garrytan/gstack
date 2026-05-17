/**
 * Generate UI mockups via OpenAI (gpt-4o) or MiniMax (image-01).
 * OpenAI is tried first; falls back to MiniMax if OpenAI is unavailable or fails.
 * Both can be configured via ~/.gstack/
 */

import fs from "fs";
import path from "path";
import { resolveApiKey, resolveMiniMaxApiKey } from "./auth";
import { parseBrief } from "./brief";
import { createSession, sessionPath } from "./session";
import { checkMockup } from "./check";

const MINIMAX_API_HOST = process.env.MINIMAX_API_HOST || "https://api.minimaxi.com";

export interface GenerateOptions {
  brief?: string;
  briefFile?: string;
  output: string;
  check?: boolean;
  retry?: number;
  size?: string;
  quality?: string;
}

export interface GenerateResult {
  outputPath: string;
  sessionFile: string;
  responseId: string;
  checkResult?: { pass: boolean; issues: string };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function normalizeSizeForProvider(
  size: string | undefined,
  provider: "openai" | "minimax",
): string {
  if (!size) {
    return provider === "minimax" ? "9:16" : "1536x1024";
  }

  const normalized = size.trim().toLowerCase();

  if (provider === "minimax") {
    const dimensions = normalized.match(/^(\d+)x(\d+)$/);
    if (!dimensions) {
      return normalized;
    }

    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
  }

  const ratio = normalized.match(/^(\d+):(\d+)$/);
  if (!ratio) {
    return normalized;
  }

  const width = Number(ratio[1]);
  const height = Number(ratio[2]);

  if (width === height) {
    return "1024x1024";
  }

  return width > height ? "1536x1024" : "1024x1536";
}

/**
 * Probe a provider by making a lightweight actual API call to verify the key works.
 * Returns true if the call succeeds, false otherwise.
 */
async function probeProvider(
  apiKey: string,
  provider: "openai" | "minimax",
  size: string,
): Promise<boolean> {
  const probePrompt = "A simple red circle on white background";
  try {
    if (provider === "openai") {
      await callOpenAIImageGeneration(apiKey, probePrompt, size, "medium");
    } else {
      await callMiniMaxImageGeneration(apiKey, probePrompt, size, "medium");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Call MiniMax Image API (image-01).
 * Returns base64 image data.
 */
async function callMiniMaxImageGeneration(
  apiKey: string,
  prompt: string,
  size: string, // e.g. "9:16", "1:1", "16:9"
  quality: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(`${MINIMAX_API_HOST}/v1/image_generation`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "image-01",
        prompt: prompt,
        aspect_ratio: size,
        response_format: "base64",
        n: 1,
        quality: quality === "high" ? "high" : "medium",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error (${response.status}): ${error}`);
    }

    const data = await response.json() as any;

    const statusCode = data.base_resp?.status_code;
    if (statusCode !== 0 && statusCode !== undefined) {
      const msg = data.base_resp?.status_msg || "Unknown error";
      throw new Error(`MiniMax API error (code ${statusCode}): ${msg}`);
    }

    const imageBase64 = data.data?.image_base64?.[0];
    if (!imageBase64) {
      throw new Error("No image data in MiniMax response");
    }

    return {
      responseId: data.id || `minimax-${Date.now()}`,
      imageData: imageBase64,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call OpenAI Responses API with image_generation tool.
 * Returns the response ID and base64 image data.
 */
async function callOpenAIImageGeneration(
  apiKey: string,
  prompt: string,
  size: string,
  quality: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: prompt,
        tools: [{
          type: "image_generation",
          size,
          quality,
        }],
      }),
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
      throw new Error(`API error (${response.status}): ${error.slice(0, 200)}`);
    }

    const data = await response.json() as any;

    const imageItem = data.output?.find((item: any) =>
      item.type === "image_generation_call"
    );

    if (!imageItem?.result) {
      throw new Error(
        `No image data in response. Output types: ${data.output?.map((o: any) => o.type).join(", ") || "none"}`
      );
    }

    return {
      responseId: data.id,
      imageData: imageItem.result,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a single mockup from a brief.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  // Parse the brief
  const prompt = options.briefFile
    ? parseBrief(options.briefFile, true)
    : parseBrief(options.brief!, false);

  const quality = options.quality || "high";
  const maxRetries = options.retry ?? 0;

  // Probe for available provider: OpenAI first, then MiniMax
  const openAIKey = resolveApiKey();
  const miniMaxKey = resolveMiniMaxApiKey();

  let provider: "openai" | "minimax" | null = null;
  let apiKey: string | null = null;

  if (openAIKey) {
    const openAISize = normalizeSizeForProvider(options.size, "openai");
    console.error(`Probing OpenAI...`);
    if (await probeProvider(openAIKey, "openai", openAISize)) {
      provider = "openai";
      apiKey = openAIKey;
    }
  }

  if (!provider && miniMaxKey) {
    const miniMaxSize = normalizeSizeForProvider(options.size, "minimax");
    console.error(`Probing MiniMax...`);
    if (await probeProvider(miniMaxKey, "minimax", miniMaxSize)) {
      provider = "minimax";
      apiKey = miniMaxKey;
    }
  }

  if (!provider) {
    console.error(`Image generation requires one of the following API keys:`);
    console.error(`- OpenAI: ~/.gstack/openai.json → { "api_key": "sk-..." }`);
    console.error(`- MiniMax: ~/.gstack/minimax.json → { "api_key": "sk-cp-..." }`);
    console.error(`Run $D setup to configure.`);
    process.exit(1);
  }

  let lastResult: GenerateResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.error(`Retry ${attempt}/${maxRetries}...`);
    }

    // Generate the image
    const startTime = Date.now();
    let responseId: string;
    let imageData: string;
    const size = normalizeSizeForProvider(options.size, provider);

    if (provider === "minimax") {
      const result = await callMiniMaxImageGeneration(apiKey!, prompt, size, quality);
      responseId = result.responseId;
      imageData = result.imageData;
    } else {
      const result = await callOpenAIImageGeneration(apiKey!, prompt, size, quality);
      responseId = result.responseId;
      imageData = result.imageData;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Write to disk
    const outputDir = path.dirname(options.output);
    fs.mkdirSync(outputDir, { recursive: true });
    const imageBuffer = Buffer.from(imageData, "base64");
    fs.writeFileSync(options.output, imageBuffer);

    // Create session
    const session = createSession(responseId, prompt, options.output);

    const model = provider === "minimax" ? "MiniMax-image-01" : "OpenAI-gpt-4o";
    console.error(`Generated via ${model} (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`);

    lastResult = {
      outputPath: options.output,
      sessionFile: sessionPath(session.id),
      responseId,
    };

    // Quality check if requested
    if (options.check) {
      const checkResult = await checkMockup(options.output, prompt);
      lastResult.checkResult = checkResult;

      if (checkResult.pass) {
        console.error(`Quality check: PASS`);
        break;
      } else {
        console.error(`Quality check: FAIL — ${checkResult.issues}`);
        if (attempt < maxRetries) {
          console.error("Will retry...");
        }
      }
    } else {
      break;
    }
  }

  // Output result as JSON to stdout
  console.log(JSON.stringify(lastResult, null, 2));
  return lastResult!;
}
