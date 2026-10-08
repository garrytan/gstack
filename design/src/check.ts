/**
 * Vision-based quality gate for generated mockups.
 * Uses an OpenAI vision model (design/src/models.ts) to verify text readability, layout completeness, and visual coherence.
 */

import fs from "fs";
import { openaiUrl, requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { modelRejectionHint, visionRequestBody } from "./models";

/** `pass` stays true when the check could not run; `status: "skipped"` marks that
 * no automated validation happened, so callers never count it as validated. */
export interface CheckResult {
  pass: boolean;
  status: "pass" | "fail" | "skipped";
  issues: string;
}

export interface CheckOptions {
  apiKey?: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/**
 * Check a generated mockup against the original brief.
 */
export async function checkMockup(imagePath: string, brief: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const apiKey = opts.apiKey ?? requireApiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;

  try {
    const response = await receiptedFetch("check-screenshot-request", openaiUrl("chat/completions"), {
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
            image_url: { url: `data:image/png;base64,${imageData}` },
          },
          {
            type: "text",
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
          },
        ],
      }], 200),
      signal,
    }, opts.fetchFn);

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 403 && error.includes("organization must be verified")) {
        console.error("OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify.");
        return { pass: true, status: "skipped", issues: "OpenAI org not verified — vision check skipped" };
      }
      // Non-blocking: if vision check fails, default to PASS with warning
      console.error(`Vision check API error (${response.status}): ${error}${modelRejectionHint(response.status, error, "vision")}`);
      return { pass: true, status: "skipped", issues: "Vision check unavailable — skipped" };
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content?.trim() || "";

    if (content.startsWith("PASS")) {
      return { pass: true, status: "pass", issues: "" };
    }

    // Extract issues after "FAIL:"
    const issues = content.replace(/^FAIL:\s*/i, "").trim();
    return { pass: false, status: "fail", issues: issues || content };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Standalone check command: check an existing image against a brief.
 */
export async function checkCommand(imagePath: string, brief: string): Promise<void> {
  const result = await checkMockup(imagePath, brief);
  console.log(JSON.stringify(result, null, 2));
}
