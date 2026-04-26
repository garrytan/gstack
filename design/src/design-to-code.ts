/**
 * Design-to-Code Prompt Generator.
 *
 * Extracts implementation instructions from an approved mockup via the
 * current design provider's vision capability. Produces a structured JSON
 * prompt the agent can use to implement the design in real code.
 */

import fs from "fs";
import { readDesignConstraints } from "./memory";
import { getProvider } from "./providers/factory";

export interface DesignToCodeResult {
  implementationPrompt: string;
  colors: string[];
  typography: string[];
  layout: string[];
  components: string[];
}

/**
 * Generate a structured implementation prompt from an approved mockup.
 */
export async function generateDesignToCodePrompt(
  imagePath: string,
  repoRoot?: string,
): Promise<DesignToCodeResult> {
  const provider = getProvider();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  // Read DESIGN.md if available for additional context
  const designConstraints = repoRoot ? readDesignConstraints(repoRoot) : null;
  const contextBlock = designConstraints
    ? `\n\nExisting DESIGN.md (use these as constraints):\n${designConstraints}`
    : "";

  const prompt = `Analyze this approved UI mockup and generate a structured implementation prompt. Return valid JSON only:

{
  "implementationPrompt": "A detailed paragraph telling a developer exactly how to build this UI. Include specific CSS values, layout approach (flex/grid), component structure, and interaction behaviors. Reference the specific elements visible in the mockup.",
  "colors": ["#hex - usage", ...],
  "typography": ["role: family, size, weight", ...],
  "layout": ["description of layout pattern", ...],
  "components": ["component name - description", ...]
}

Be specific about every visual detail: exact hex colors, font sizes in px, spacing values, border-radius, shadows. The developer should be able to implement this without looking at the mockup again.${contextBlock}`;

  const { text } = await provider.vision({
    prompt,
    images: [{ data: imageData, mimeType: "image/png" }],
    maxTokens: 1000,
    jsonMode: true,
  });

  return JSON.parse(text) as DesignToCodeResult;
}
