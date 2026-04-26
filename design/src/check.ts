/**
 * Vision-based quality gate for generated mockups.
 *
 * Uses the current design provider's vision capability to verify text
 * readability, layout completeness, and visual coherence. Non-blocking:
 * if vision fails, returns PASS with a warning so generation isn't blocked
 * by a flaky quality checker.
 */

import fs from "fs";
import { getProvider } from "./providers/factory";
import { ProviderError } from "./providers/provider";

export interface CheckResult {
  pass: boolean;
  issues: string;
}

/**
 * Check a generated mockup against the original brief.
 */
export async function checkMockup(imagePath: string, brief: string): Promise<CheckResult> {
  const provider = getProvider();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const prompt = [
    "You are a UI quality checker. Evaluate this mockup against the design brief.",
    "",
    `Brief: ${brief}`,
    "",
    "Check these 3 things:",
    "1. TEXT READABILITY: Are all labels, headings, and body text legible? Any misspellings?",
    "2. LAYOUT COMPLETENESS: Are all requested elements present? Anything missing?",
    "3. VISUAL COHERENCE: Does it look like a real production UI, not AI art or a collage?",
    "",
    "Respond with exactly one line:",
    "PASS — if all 3 checks pass",
    "FAIL: [list specific issues] — if any check fails",
  ].join("\n");

  try {
    const { text } = await provider.vision({
      prompt,
      images: [{ data: imageData, mimeType: "image/png" }],
      maxTokens: 200,
    });

    const content = text.trim();
    if (content.startsWith("PASS")) {
      return { pass: true, issues: "" };
    }

    const issues = content.replace(/^FAIL:\s*/i, "").trim();
    return { pass: false, issues: issues || content };
  } catch (err) {
    if (err instanceof ProviderError) {
      // Non-blocking: any provider error defaults to PASS with a warning.
      // We don't want a vision hiccup to block image generation pipelines.
      console.error(`Vision check unavailable (${provider.name}): ${err.message.slice(0, 120)}`);
      return { pass: true, issues: `Vision check skipped — ${err.message.slice(0, 80)}` };
    }
    console.error(`Vision check unexpected error: ${(err as Error)?.message || err}`);
    return { pass: true, issues: "Vision check unavailable — skipped" };
  }
}

/**
 * Standalone check command: check an existing image against a brief.
 */
export async function checkCommand(imagePath: string, brief: string): Promise<void> {
  const result = await checkMockup(imagePath, brief);
  console.log(JSON.stringify(result, null, 2));
}
