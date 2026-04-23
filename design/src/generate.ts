/**
 * Generate UI mockups via pluggable image provider.
 * Supports OpenAI (Responses API) and Seedream (Volcengine Ark).
 */

import fs from "fs";
import path from "path";
import { parseBrief } from "./brief";
import { createSession, sessionPath } from "./session";
import { checkMockup } from "./check";
import { type ProviderName, createProvider } from "./providers";

export interface GenerateOptions {
  brief?: string;
  briefFile?: string;
  output: string;
  check?: boolean;
  retry?: number;
  size?: string;
  quality?: string;
  provider?: ProviderName;
}

export interface GenerateResult {
  outputPath: string;
  sessionFile: string;
  responseId: string;
  provider: string;
  checkResult?: { pass: boolean; issues: string };
}

/**
 * Generate a single mockup from a brief.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const providerName = options.provider || "openai";
  const provider = createProvider(providerName);

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
    const { id: responseId, imageData } = await provider.generateImage({
      prompt, size, quality,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Write to disk
    const outputDir = path.dirname(options.output);
    fs.mkdirSync(outputDir, { recursive: true });
    const imageBuffer = Buffer.from(imageData, "base64");
    fs.writeFileSync(options.output, imageBuffer);

    // Create session
    const session = createSession(responseId, prompt, options.output);

    console.error(`Generated via ${providerName} (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`);

    lastResult = {
      outputPath: options.output,
      sessionFile: sessionPath(session.id),
      responseId,
      provider: providerName,
    };

    // Quality check if requested (always uses OpenAI vision)
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
