/**
 * Generate UI mockups via the current design provider (Gemini or OpenAI).
 *
 * Provider selection is handled by ./providers/factory — this file only cares
 * about brief parsing, retry/quality-check flow, and writing the result to disk.
 */

import fs from "fs";
import path from "path";
import { parseBrief } from "./brief";
import { createSession, sessionPath } from "./session";
import { checkMockup } from "./check";
import { getProvider } from "./providers/factory";

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
 * Generate a single mockup from a brief.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const provider = getProvider();

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

    const startTime = Date.now();
    const { responseId, imageData } = await provider.generateImage({
      prompt,
      size,
      quality,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Write to disk
    const outputDir = path.dirname(options.output);
    fs.mkdirSync(outputDir, { recursive: true });
    const imageBuffer = Buffer.from(imageData, "base64");
    fs.writeFileSync(options.output, imageBuffer);

    const session = createSession(responseId, prompt, options.output);

    console.error(
      `Generated [${provider.name}] (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`,
    );

    lastResult = {
      outputPath: options.output,
      sessionFile: sessionPath(session.id),
      responseId,
    };

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

  console.log(JSON.stringify(lastResult, null, 2));
  return lastResult!;
}
