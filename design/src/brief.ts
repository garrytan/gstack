/**
 * Structured design brief — the interface between skill prose and image generation.
 */

export interface DesignBrief {
  goal: string;           // "Dashboard for coding assessment tool"
  audience: string;       // "Technical users, YC partners"
  style: string;          // "Dark theme, cream accents, minimal"
  elements: string[];     // ["builder name", "score badge", "narrative letter"]
  constraints?: string;   // "Max width 1024px, mobile-first"
  reference?: string;     // DESIGN.md excerpt or style reference text
  screenType: string;     // "desktop-dashboard" | "mobile-app" | "landing-page" | etc.
}

/**
 * Convert a structured brief to a prompt string for image generation.
 */
export function briefToPrompt(brief: DesignBrief): string {
  const lines: string[] = [
    `Generate a pixel-perfect UI mockup of a ${brief.screenType} for: ${brief.goal}.`,
    `Target audience: ${brief.audience}.`,
    `Visual style: ${brief.style}.`,
    `Required elements: ${brief.elements.join(", ")}.`,
  ];

  if (brief.constraints) {
    lines.push(`Constraints: ${brief.constraints}.`);
  }

  if (brief.reference) {
    lines.push(`Design reference: ${brief.reference}`);
  }

  lines.push(
    "The mockup should look like a real production UI, not a wireframe or concept art.",
    "All text must be readable. Layout must be clean and intentional.",
    "1536x1024 pixels."
  );

  return lines.join(" ");
}

/**
 * Parse a brief from either a plain text string or a JSON file path.
 */
export function parseBrief(input: string, isFile: boolean): string {
  if (!isFile) {
    // Plain text prompt — use directly
    return input;
  }

  // JSON file — parse and convert to prompt
  const raw = Bun.file(input);
  // We'll read it synchronously via fs since Bun.file is async
  const fs = require("fs");
  const content = fs.readFileSync(input, "utf-8");
  const brief: DesignBrief = JSON.parse(content);
  return briefToPrompt(brief);
}
