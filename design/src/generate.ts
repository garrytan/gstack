/**
 * Generate UI mockups via OpenAI Responses API with image_generation tool.
 */

import fs from "fs";
import path from "path";
import { ImageProviderOption, requireImageProvider } from "./auth";
import { parseBrief } from "./brief";
import { callImageGeneration } from "./image-provider";
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
  backend?: ImageProviderOption;
}

export interface GenerateResult {
  outputPath: string;
  sessionFile: string;
  responseId: string;
  checkResult?: { pass: boolean; issues: string };
}

/**
 * Generate a single mockup from a brief.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const provider = await requireImageProvider(options.backend);

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
    const result = await callImageGeneration(provider, prompt, size, quality, options.output);
    const responseId = result.responseId;
    let imageBuffer: Buffer;
    if (result.imageData) {
      imageBuffer = Buffer.from(result.imageData, "base64");
      const outputDir = path.dirname(options.output);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(options.output, imageBuffer);
    } else {
      imageBuffer = fs.readFileSync(options.output);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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
