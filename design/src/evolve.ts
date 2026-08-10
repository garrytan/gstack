/**
 * Screenshot-to-Mockup Evolution.
 * Takes a screenshot of the live site and generates a mockup showing
 * how it SHOULD look based on a design brief.
 * Starts from reality, not blank canvas.
 */

import fs from "fs";
import path from "path";
import { requireApiKey } from "./auth";
import { generateImage, visionRequest } from "./openai";

export interface EvolveOptions {
  screenshot: string;  // Path to current site screenshot
  brief: string;       // What to change ("make it calmer", "fix the hierarchy")
  output: string;      // Output path for evolved mockup
}

/**
 * Generate an evolved mockup from an existing screenshot + brief.
 * Sends the screenshot as context to GPT-4o with image generation,
 * asking it to produce a new version incorporating the brief's changes.
 */
export async function evolve(options: EvolveOptions): Promise<void> {
  const apiKey = requireApiKey();
  const screenshotData = fs.readFileSync(options.screenshot).toString("base64");

  console.error(`Evolving ${options.screenshot} with: "${options.brief}"`);
  const startTime = Date.now();

  // Use the Responses API with both a text prompt referencing the screenshot
  // and the image_generation tool to produce the evolved version.
  // Since we can't send reference images directly to image_generation,
  // we describe the current state in detail first via vision, then generate.

  // Step 1: Analyze current screenshot
  const analysis = await analyzeScreenshot(apiKey, screenshotData);
  console.error(`  Analyzed current design: ${analysis.slice(0, 100)}...`);

  // Step 2: Generate evolved version using analysis + brief
  const evolvedPrompt = [
    "Generate a pixel-perfect UI mockup that is an improved version of an existing design.",
    "",
    "CURRENT DESIGN (what exists now):",
    analysis,
    "",
    "REQUESTED CHANGES:",
    options.brief,
    "",
    "Generate a new mockup that keeps the existing layout structure but applies the requested changes.",
    "The result should look like a real production UI. All text must be readable.",
    "1536x1024 pixels.",
  ].join("\n");

  const { imageData } = await generateImage(apiKey, { prompt: evolvedPrompt });

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const imageBuffer = Buffer.from(imageData, "base64");
  fs.writeFileSync(options.output, imageBuffer);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`Generated (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`);

  console.log(JSON.stringify({
    outputPath: options.output,
    sourceScreenshot: options.screenshot,
    brief: options.brief,
  }, null, 2));
}

/**
 * Analyze a screenshot to produce a detailed description for re-generation.
 */
async function analyzeScreenshot(apiKey: string, imageBase64: string): Promise<string> {
  const result = await visionRequest(apiKey, {
    imageBase64,
    maxTokens: 400,
    timeoutMs: 30_000,
    text: `Describe this UI in detail for re-creation. Include: overall layout structure, color scheme (hex values), typography (sizes, weights), specific text content visible, spacing between elements, alignment patterns, and any decorative elements. Be precise enough that someone could recreate this UI from your description alone. 200 words max.`,
  });

  if (!result.ok) return "Unable to analyze screenshot";
  return result.content || "Unable to analyze screenshot";
}
