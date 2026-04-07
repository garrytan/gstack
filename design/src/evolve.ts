/**
 * Screenshot-to-Mockup Evolution.
 * Takes a screenshot of the live site and generates a mockup showing
 * how it SHOULD look based on a design brief.
 * Starts from reality, not blank canvas.
 */

import fs from "fs";
import path from "path";
import { requireApiKey } from "./auth";

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
        input: evolvedPrompt,
        tools: [{ type: "image_generation", size: "1536x1024", quality: "high" }],
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
      throw new Error(`API error (${response.status}): ${error.slice(0, 300)}`);
    }

    const data = await response.json() as any;
    const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

    if (!imageItem?.result) {
      throw new Error("No image data in response");
    }

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const imageBuffer = Buffer.from(imageItem.result, "base64");
    fs.writeFileSync(options.output, imageBuffer);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`Generated (${elapsed}s, ${(imageBuffer.length / 1024).toFixed(0)}KB) → ${options.output}`);

    console.log(JSON.stringify({
      outputPath: options.output,
      sourceScreenshot: options.screenshot,
      brief: options.brief,
    }, null, 2));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Analyze a screenshot to produce a detailed description for re-generation.
 */
async function analyzeScreenshot(apiKey: string, imageBase64: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
            {
              type: "text",
              text: `Describe this UI in detail for re-creation. Include: overall layout structure, color scheme (hex values), typography (sizes, weights), specific text content visible, spacing between elements, alignment patterns, and any decorative elements. Be precise enough that someone could recreate this UI from your description alone. 200 words max.`,
            },
          ],
        }],
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return "Unable to analyze screenshot";
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || "Unable to analyze screenshot";
  } finally {
    clearTimeout(timeout);
  }
}
