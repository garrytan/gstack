/**
 * Design Memory — extract visual language from approved mockups into DESIGN.md.
 *
 * After a mockup is approved, uses the current design provider's vision
 * capability to extract:
 * - Color palette (hex values)
 * - Typography (font families, sizes, weights)
 * - Spacing patterns (padding, margins, gaps)
 * - Layout conventions (grid, alignment, hierarchy)
 *
 * If DESIGN.md exists, merges extracted patterns with existing design system.
 * If no DESIGN.md, creates one from the extracted patterns.
 */

import fs from "fs";
import path from "path";
import { getProvider } from "./providers/factory";
import { ProviderError } from "./providers/provider";

export interface ExtractedDesign {
  colors: { name: string; hex: string; usage: string }[];
  typography: { role: string; family: string; size: string; weight: string }[];
  spacing: string[];
  layout: string[];
  mood: string;
}

/**
 * Extract visual language from an approved mockup PNG.
 */
export async function extractDesignLanguage(imagePath: string): Promise<ExtractedDesign> {
  const provider = getProvider();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const prompt = `Analyze this UI mockup and extract the design language. Return valid JSON only, no markdown:

{
  "colors": [{"name": "primary", "hex": "#...", "usage": "buttons, links"}, ...],
  "typography": [{"role": "heading", "family": "...", "size": "...", "weight": "..."}, ...],
  "spacing": ["8px base unit", "16px between sections", ...],
  "layout": ["left-aligned content", "max-width 1200px", ...],
  "mood": "one sentence describing the overall feel"
}

Extract real values from what you see. Be specific about hex colors and font sizes.`;

  try {
    const { text } = await provider.vision({
      prompt,
      images: [{ data: imageData, mimeType: "image/png" }],
      maxTokens: 800,
      jsonMode: true,
    });
    return JSON.parse(text) as ExtractedDesign;
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error(`Vision extraction failed (${provider.name}): ${err.message.slice(0, 200)}`);
      return defaultDesign();
    }
    console.error(`Design extraction error: ${(err as Error)?.message || err}`);
    return defaultDesign();
  }
}

function defaultDesign(): ExtractedDesign {
  return {
    colors: [],
    typography: [],
    spacing: [],
    layout: [],
    mood: "Unable to extract design language",
  };
}

/**
 * Write or update DESIGN.md with extracted design patterns.
 * If DESIGN.md exists, appends an "Extracted from mockup" section.
 * If not, creates a new one.
 */
export function updateDesignMd(
  repoRoot: string,
  extracted: ExtractedDesign,
  sourceMockup: string,
): void {
  const designPath = path.join(repoRoot, "DESIGN.md");
  const timestamp = new Date().toISOString().split("T")[0];

  const section = formatExtractedSection(extracted, sourceMockup, timestamp);

  if (fs.existsSync(designPath)) {
    // Append to existing DESIGN.md
    const existing = fs.readFileSync(designPath, "utf-8");

    // Check if there's already an extracted section, replace it
    const marker = "## Extracted Design Language";
    if (existing.includes(marker)) {
      const before = existing.split(marker)[0];
      fs.writeFileSync(designPath, before.trimEnd() + "\n\n" + section);
    } else {
      fs.writeFileSync(designPath, existing.trimEnd() + "\n\n" + section);
    }
    console.error(`Updated DESIGN.md with extracted design language`);
  } else {
    // Create new DESIGN.md
    const content = `# Design System

${section}`;
    fs.writeFileSync(designPath, content);
    console.error(`Created DESIGN.md with extracted design language`);
  }
}

function formatExtractedSection(
  extracted: ExtractedDesign,
  sourceMockup: string,
  date: string,
): string {
  const lines: string[] = [
    "## Extracted Design Language",
    `*Auto-extracted from approved mockup on ${date}*`,
    `*Source: ${path.basename(sourceMockup)}*`,
    "",
    `**Mood:** ${extracted.mood}`,
    "",
  ];

  if (extracted.colors.length > 0) {
    lines.push("### Colors", "");
    lines.push("| Name | Hex | Usage |");
    lines.push("|------|-----|-------|");
    for (const c of extracted.colors) {
      lines.push(`| ${c.name} | \`${c.hex}\` | ${c.usage} |`);
    }
    lines.push("");
  }

  if (extracted.typography.length > 0) {
    lines.push("### Typography", "");
    lines.push("| Role | Family | Size | Weight |");
    lines.push("|------|--------|------|--------|");
    for (const t of extracted.typography) {
      lines.push(`| ${t.role} | ${t.family} | ${t.size} | ${t.weight} |`);
    }
    lines.push("");
  }

  if (extracted.spacing.length > 0) {
    lines.push("### Spacing", "");
    for (const s of extracted.spacing) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  if (extracted.layout.length > 0) {
    lines.push("### Layout", "");
    for (const l of extracted.layout) {
      lines.push(`- ${l}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Read DESIGN.md and return it as a constraint string for brief construction.
 * If no DESIGN.md exists, returns null (explore wide).
 */
export function readDesignConstraints(repoRoot: string): string | null {
  const designPath = path.join(repoRoot, "DESIGN.md");
  if (!fs.existsSync(designPath)) return null;

  const content = fs.readFileSync(designPath, "utf-8");
  // Truncate to first 2000 chars to keep brief reasonable
  return content.slice(0, 2000);
}
