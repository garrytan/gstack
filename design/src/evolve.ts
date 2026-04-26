/**
 * Screenshot-to-Mockup Evolution.
 *
 * Takes a screenshot of a live site and generates a mockup showing how it
 * SHOULD look based on a design brief. Starts from reality, not a blank canvas.
 *
 * Two paths depending on provider capability:
 *
 * - Native path (Gemini supportsImageRef()=true): pass the screenshot as an
 *   inlineData part alongside the brief in a single generateContent call.
 *   One network request, true image-to-image.
 *
 * - Fallback path (OpenAI supportsImageRef()=false): vision-then-generate.
 *   First describe the screenshot via vision, then pass the description plus
 *   the brief into a pure text-to-image call. Two network requests.
 */

import fs from "fs";
import path from "path";
import { getProvider } from "./providers/factory";
import type { DesignProvider } from "./providers/provider";

export interface EvolveOptions {
  screenshot: string;  // Path to current site screenshot
  brief: string;       // What to change ("make it calmer", "fix the hierarchy")
  output: string;      // Output path for evolved mockup
}

export async function evolve(options: EvolveOptions): Promise<void> {
  const provider = getProvider();
  const screenshotData = fs.readFileSync(options.screenshot).toString("base64");

  console.error(`Evolving ${options.screenshot} [${provider.name}] with: "${options.brief}"`);
  const startTime = Date.now();

  let imageData: string;

  if (provider.supportsImageRef()) {
    imageData = await evolveNative(provider, screenshotData, options.brief);
  } else {
    imageData = await evolveViaAnalyze(provider, screenshotData, options.brief);
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const imageBuffer = Buffer.from(imageData, "base64");
  fs.writeFileSync(options.output, imageBuffer);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(
    `Generated [${provider.name}] (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`,
  );

  console.log(JSON.stringify({
    outputPath: options.output,
    sourceScreenshot: options.screenshot,
    provider: provider.name,
    path: provider.supportsImageRef() ? "native-image-ref" : "vision-then-generate",
    brief: options.brief,
  }, null, 2));
}

/**
 * Native image-to-image: the provider accepts a reference image directly.
 * One call, one provider round trip.
 */
async function evolveNative(
  provider: DesignProvider,
  screenshotBase64: string,
  brief: string,
): Promise<string> {
  const prompt = [
    "Generate a pixel-perfect UI mockup that is an improved version of the reference image.",
    "",
    "REQUESTED CHANGES:",
    brief,
    "",
    "Keep the existing layout structure but apply the requested changes.",
    "The result should look like a real production UI. All text must be readable.",
  ].join("\n");

  const { imageData } = await provider.generateImage({
    prompt,
    size: "1536x1024",
    quality: "high",
    referenceImage: { data: screenshotBase64, mimeType: "image/png" },
  });
  return imageData;
}

/**
 * Fallback: describe the screenshot via vision, then generate from text only.
 * Two calls, preserves the legacy behavior for OpenAI.
 */
async function evolveViaAnalyze(
  provider: DesignProvider,
  screenshotBase64: string,
  brief: string,
): Promise<string> {
  const analysisResult = await provider.vision({
    prompt:
      "Describe this UI in detail for re-creation. Include: overall layout structure, "
      + "color scheme (hex values), typography (sizes, weights), specific text content visible, "
      + "spacing between elements, alignment patterns, and any decorative elements. "
      + "Be precise enough that someone could recreate this UI from your description alone. "
      + "200 words max.",
    images: [{ data: screenshotBase64, mimeType: "image/png" }],
    maxTokens: 400,
  });
  const analysis = analysisResult.text || "Unable to analyze screenshot";
  console.error(`  Analyzed current design: ${analysis.slice(0, 100)}...`);

  const evolvedPrompt = [
    "Generate a pixel-perfect UI mockup that is an improved version of an existing design.",
    "",
    "CURRENT DESIGN (what exists now):",
    analysis,
    "",
    "REQUESTED CHANGES:",
    brief,
    "",
    "Generate a new mockup that keeps the existing layout structure but applies the requested changes.",
    "The result should look like a real production UI. All text must be readable.",
    "1536x1024 pixels.",
  ].join("\n");

  const { imageData } = await provider.generateImage({
    prompt: evolvedPrompt,
    size: "1536x1024",
    quality: "high",
  });
  return imageData;
}
