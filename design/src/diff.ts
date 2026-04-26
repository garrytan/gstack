/**
 * Visual diff between two mockups via the current design provider's vision.
 * Identifies what changed between design iterations or between an approved
 * mockup and the live implementation.
 */

import fs from "fs";
import { getProvider } from "./providers/factory";
import { ProviderError } from "./providers/provider";

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
  const provider = getProvider();
  const beforeData = fs.readFileSync(beforePath).toString("base64");
  const afterData = fs.readFileSync(afterPath).toString("base64");

  const prompt = `Compare these two UI images. The first is the BEFORE (or design intent), the second is the AFTER (or actual implementation). Return valid JSON only:

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
Focus on layout, typography, colors, spacing, and element presence/absence. Ignore rendering differences (anti-aliasing, sub-pixel).`;

  try {
    const { text } = await provider.vision({
      prompt,
      images: [
        { data: beforeData, mimeType: "image/png" },
        { data: afterData, mimeType: "image/png" },
      ],
      maxTokens: 600,
      jsonMode: true,
    });
    return JSON.parse(text) as DiffResult;
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error(`Diff vision error: ${err.message.slice(0, 200)}`);
      return { differences: [], summary: "Diff unavailable", matchScore: -1 };
    }
    throw err;
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
