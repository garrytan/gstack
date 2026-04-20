/**
 * Generate UI mockups via OpenAI Responses API with image_generation tool.
 */

import fs from "fs";
import path from "path";
import { requireApiKey } from "./auth";
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
 * Call OpenAI Responses API with image_generation tool.
 * Returns the response ID and base64 image data.
 */
async function callImageGeneration(
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
  const apiKey = requireApiKey();

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
    const { responseId, imageData } = await callImageGeneration(apiKey, prompt, size, quality);
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
