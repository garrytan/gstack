/**
 * Screenshot-to-Mockup Evolution.
 * Takes a screenshot of the live site and generates a mockup showing
 * how it SHOULD look based on a design brief.
 * Starts from reality, not blank canvas.
 */

import fs from "fs";
import { openaiUrl, requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { imageRequestBody, modelRejectionHint, visionRequestBody } from "./models";
import { emitResult, exitCodeFor, newAccounting, persistImage, recordOutcome, type ExitCode } from "./persist";

export interface EvolveOptions {
  screenshot: string;  // Path to current site screenshot
  brief: string;       // What to change ("make it calmer", "fix the hierarchy")
  output: string;      // Output path for evolved mockup
}

/**
 * Generate an evolved mockup from an existing screenshot + brief.
 * Sends the screenshot as context to the image model with image generation,
 * asking it to produce a new version incorporating the brief's changes.
 */
export async function evolve(options: EvolveOptions): Promise<ExitCode> {
  const acct = newAccounting(1);
  let outputPath: string | null = null;

  try {
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
    const evolvedPrompt = evolvePrompt(analysis, options.brief);

    const imageData = await requestEvolvedImage(apiKey, evolvedPrompt);
    const outcome = persistImage(imageData, options.output);
    outputPath = recordOutcome(acct, outcome);
    if (outcome.ok) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`Generated (${elapsed}s, ${(outcome.bytes / 1024).toFixed(0)}KB) → ${outcome.path}`);
    }
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.error(reason);
    acct.failures.push({ file: options.output, reason });
  }

  return emitResult({
    outputPath,
    sourceScreenshot: options.screenshot,
    brief: options.brief,
    attempts: acct.saved.map(p => ({ path: p })),
    requested: acct.requested,
    saved: acct.saved,
    selected: outputPath,
    failures: acct.failures,
    recovered: acct.recovered,
  }, exitCodeFor(outputPath !== null, acct.saved.length));
}

async function requestEvolvedImage(apiKey: string, evolvedPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);

  try {
    const response = await receiptedFetch("evolve-image-request", openaiUrl("responses"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: imageRequestBody(evolvedPrompt, { size: "1536x1024", quality: "high" }),
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
      throw new Error(`API error (${response.status}): ${error.slice(0, 300)}${modelRejectionHint(response.status, error, "image")}`);
    }

    const data = await response.json() as any;
    const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

    if (!imageItem?.result) {
      throw new Error("No image data in response");
    }
    return imageItem.result;
  } finally {
    clearTimeout(timeout);
  }
}

/** The image prompt for an evolved mockup: the analyzed current design plus the requested changes. */
export function evolvePrompt(analysis: string, brief: string): string {
  return [
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
}

/**
 * Analyze a screenshot to produce a detailed description for re-generation.
 */
export async function analyzeScreenshot(
  apiKey: string,
  imageBase64: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  batchSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const signal = batchSignal ? AbortSignal.any([controller.signal, batchSignal]) : controller.signal;

  try {
    const response = await receiptedFetch("evolve-screenshot-analysis-request", openaiUrl("chat/completions"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: visionRequestBody([{
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
      }], 400),
      signal,
    }, fetchFn);

    if (!response.ok) {
      const error = await response.text();
      console.error(`  Screenshot analysis failed (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "vision")}`);
      return "Unable to analyze screenshot";
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || "Unable to analyze screenshot";
  } finally {
    clearTimeout(timeout);
  }
}
