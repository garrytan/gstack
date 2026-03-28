/**
 * Visual diff between two mockups using GPT-4o vision.
 * Identifies what changed between design iterations or between
 * an approved mockup and the live implementation.
 */

import fs from "fs";
import { requireApiKey } from "./auth";

export interface DiffResult {
  differences: { area: string; description: string; severity: string }[];
  summary: string;
  matchScore: number; // 0-100, how closely they match
}

/**
 * Compare two images and describe the visual differences.
 */
export async function diffMockups(
  beforePath: string,
  afterPath: string,
): Promise<DiffResult> {
  const apiKey = requireApiKey();
  const beforeData = fs.readFileSync(beforePath).toString("base64");
  const afterData = fs.readFileSync(afterPath).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

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
              type: "text",
              text: `Compare these two UI images. The first is the BEFORE (or design intent), the second is the AFTER (or actual implementation). Return valid JSON only:

{
  "differences": [
    {"area": "header", "description": "Font size changed from ~32px to ~24px", "severity": "high"},
    ...
  ],
  "summary": "one sentence overall assessment",
  "matchScore": 85
}

severity: "high" = noticeable to any user, "medium" = visible on close inspection, "low" = minor/pixel-level.
matchScore: 100 = identical, 0 = completely different.
Focus on layout, typography, colors, spacing, and element presence/absence. Ignore rendering differences (anti-aliasing, sub-pixel).`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${beforeData}` },
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${afterData}` },
            },
          ],
        }],
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Diff API error (${response.status}): ${error.slice(0, 200)}`);
      return { differences: [], summary: "Diff unavailable", matchScore: -1 };
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    return JSON.parse(content) as DiffResult;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verify a live implementation against an approved design mockup.
 * Combines diff with a pass/fail gate.
 */
export async function verifyAgainstMockup(
  mockupPath: string,
  screenshotPath: string,
): Promise<{ pass: boolean; matchScore: number; diff: DiffResult }> {
  const diff = await diffMockups(mockupPath, screenshotPath);

  // Pass if matchScore >= 70 and no high-severity differences
  const highSeverity = diff.differences.filter(d => d.severity === "high");
  const pass = diff.matchScore >= 70 && highSeverity.length === 0;

  return { pass, matchScore: diff.matchScore, diff };
}
