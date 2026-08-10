/**
 * Vision-based quality gate for generated mockups.
 * Uses GPT-4o vision to verify text readability, layout completeness, and visual coherence.
 */

import fs from "fs";
import { requireApiKey } from "./auth";
import { visionRequest } from "./openai";

export interface CheckResult {
  pass: boolean;
  issues: string;
}

/**
 * Check a generated mockup against the original brief.
 */
export async function checkMockup(imagePath: string, brief: string): Promise<CheckResult> {
  const apiKey = requireApiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const result = await visionRequest(apiKey, {
    imageBase64: imageData,
    maxTokens: 200,
    text: [
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
    ].join("\n"),
  });

  if (!result.ok) {
    if (result.orgUnverified) {
      console.error("OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify.");
      return { pass: true, issues: "OpenAI org not verified — vision check skipped" };
    }
    // Non-blocking: if vision check fails, default to PASS with warning
    console.error(`Vision check API error (${result.status}): ${result.body}`);
    return { pass: true, issues: "Vision check unavailable — skipped" };
  }

  const content = result.content;
  if (content.startsWith("PASS")) {
    return { pass: true, issues: "" };
  }

  // Extract issues after "FAIL:"
  const issues = content.replace(/^FAIL:\s*/i, "").trim();
  return { pass: false, issues: issues || content };
}

/**
 * Standalone check command: check an existing image against a brief.
 */
export async function checkCommand(imagePath: string, brief: string): Promise<void> {
  const result = await checkMockup(imagePath, brief);
  console.log(JSON.stringify(result, null, 2));
}
