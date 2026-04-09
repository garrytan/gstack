/**
 * Generate UI mockups via OpenAI GPT Image 1.5 or Google Gemini Nano Banana 2.
 *
 * Provider selection:
 * - openai: GPT Image 1.5 via Images API (best text rendering for UI mockups)
 * - gemini: Gemini 3.1 Flash Image via generateContent (fast, good quality, cheaper)
 *
 * See auth.ts for provider resolution order.
 */

import fs from "fs";
import path from "path";
import { requireProvider, type Provider } from "./auth";
import { parseBrief } from "./brief";
import { createSession, sessionPath } from "./session";
import { checkMockup } from "./check";

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

/**
 * Call OpenAI Images API with GPT Image 1.5.
 * Upgraded from gpt-4o Responses API to dedicated image model.
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
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size: size === "1536x1024" ? "1536x1024" : size,
        quality: quality === "high" ? "high" : "medium",
        output_format: "png",
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
      throw new Error(`OpenAI API error (${response.status}): ${error.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    // GPT Image models always return base64. Check both b64_json (DALL-E format) and b64 (GPT Image format).
    const imageData = data.data?.[0]?.b64_json || data.data?.[0]?.b64;

    if (!imageData) {
      throw new Error(`No image data in OpenAI response. Keys: ${JSON.stringify(Object.keys(data.data?.[0] || {}))}`);
    }

    return {
      responseId: data.created?.toString() || "openai-" + Date.now(),
      imageData,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Google Gemini API with Nano Banana 2 (Gemini 3.1 Flash Image).
 */
async function callGeminiImageGeneration(
  apiKey: string,
  prompt: string,
): Promise<{ responseId: string; imageData: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const model = "gemini-2.0-flash-exp";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${error.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith("image/"));

    if (!imagePart?.inlineData?.data) {
      throw new Error("No image data in Gemini response.");
    }

    return {
      responseId: "gemini-" + Date.now(),
      imageData: imagePart.inlineData.data,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Route to the correct provider.
 */
async function callImageGeneration(
  provider: Provider,
  apiKey: string,
  prompt: string,
  size: string,
  quality: string,
): Promise<{ responseId: string; imageData: string }> {
  if (provider === "gemini") {
    return callGeminiImageGeneration(apiKey, prompt);
  }
  return callOpenAIImageGeneration(apiKey, prompt, size, quality);
}

/**
 * Generate a single mockup from a brief.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { provider, apiKey } = requireProvider();
  console.error(`Using provider: ${provider}`);

  // Parse the brief
  const prompt = options.briefFile
    ? parseBrief(options.briefFile, true)
    : parseBrief(options.brief!, false);

  const size = options.size || "1536x1024";
  const quality = options.quality || "high";
  const maxRetries = options.retry ?? 0;

  let lastResult: GenerateResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.error(`Retry ${attempt}/${maxRetries}...`);
    }

    // Generate the image
    const startTime = Date.now();
    const { responseId, imageData } = await callImageGeneration(provider, apiKey, prompt, size, quality);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Write to disk
    const outputDir = path.dirname(options.output);
    fs.mkdirSync(outputDir, { recursive: true });
    const imageBuffer = Buffer.from(imageData, "base64");
    fs.writeFileSync(options.output, imageBuffer);

    // Create session
    const session = createSession(responseId, prompt, options.output);

    console.error(`Generated (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`);

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
