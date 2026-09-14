/**
 * Design Memory — extract visual language from approved mockups into DESIGN.md.
 *
 * After a mockup is approved, uses GPT-4o vision to extract:
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
import { requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { parseDesignMd, detectFormat, renderDesignMd, spliceSection, specSkeleton, tokensFlat, slug, DesignMdEditRefused } from "../../lib/design-md";
import { atomicWriteSync } from "../../lib/fs-atomic";

/** The section the extraction owns in DESIGN.md (replaced on every run). */
export const EXTRACTED_SECTION_HEADING = "Extracted Design Language";

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
  const apiKey = requireApiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await receiptedFetch("memory-distill-request", "https://api.openai.com/v1/chat/completions", {
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
              image_url: { url: `data:image/png;base64,${imageData}` },
            },
            {
              type: "text",
              text: `Analyze this UI mockup and extract the design language. Return valid JSON only, no markdown:

{
  "colors": [{"name": "primary", "hex": "#...", "usage": "buttons, links"}, ...],
  "typography": [{"role": "heading", "family": "...", "size": "...", "weight": "..."}, ...],
  "spacing": ["8px base unit", "16px between sections", ...],
  "layout": ["left-aligned content", "max-width 1200px", ...],
  "mood": "one sentence describing the overall feel"
}

Extract real values from what you see. Be specific about hex colors and font sizes.`,
            },
          ],
        }],
        max_tokens: 800,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Vision extraction failed (${response.status})`);
      return defaultDesign();
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    // The model's JSON is unvalidated: default the arrays and coerce the strings so a null name
    // cannot throw after the paid vision call.
    const raw = JSON.parse(content) as Partial<Record<keyof ExtractedDesign, unknown>>;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    return {
      colors: list(raw.colors).map((c) => ({ name: str((c as Record<string, unknown>)?.name), hex: str((c as Record<string, unknown>)?.hex), usage: str((c as Record<string, unknown>)?.usage) })),
      typography: list(raw.typography).map((t) => ({ role: str((t as Record<string, unknown>)?.role), family: str((t as Record<string, unknown>)?.family), size: str((t as Record<string, unknown>)?.size), weight: str((t as Record<string, unknown>)?.weight) })),
      spacing: list(raw.spacing).map(str),
      layout: list(raw.layout).map(str),
      mood: str(raw.mood),
    };
  } catch (err: any) {
    console.error(`Design extraction error: ${err.message}`);
    return defaultDesign();
  } finally {
    clearTimeout(timeout);
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
 *
 * Existing file (spec, legacy, or anything at all): the "## Extracted Design
 * Language" section is spliced in at the text level through lib/design-md.ts,
 * so every other byte of the user's file (front matter, section order, prose)
 * is untouched; the section is replaced in place on a rerun, appended otherwise.
 * New file: a spec-format skeleton whose tokens come from the extraction
 * (colors by name, typography by role) plus the extracted section.
 */
export function updateDesignMd(
  repoRoot: string,
  extracted: ExtractedDesign,
  sourceMockup: string,
): void {
  const linkPath = path.join(repoRoot, "DESIGN.md");
  const timestamp = new Date().toISOString().split("T")[0];
  const body = formatExtractedSection(extracted, sourceMockup, timestamp);

  if (fs.existsSync(linkPath)) {
    const designPath = fs.realpathSync(linkPath); // edit the file behind a symlink, never replace the link
    let next: string;
    try {
      next = spliceSection(fs.readFileSync(designPath, "utf-8"), EXTRACTED_SECTION_HEADING, body);
    } catch (err) {
      if (err instanceof DesignMdEditRefused) { console.error(`DESIGN.md not updated: ${err.message}`); return; }
      throw err;
    }
    atomicWriteSync(designPath, next);
    console.error(`Updated DESIGN.md with extracted design language`);
    return;
  }
  const designPath = linkPath;

  const colors: Record<string, string> = {};
  for (const c of extracted.colors ?? []) {
    const key = slug(String(c.name ?? ""));
    if (key !== "token" && /^#[0-9a-fA-F]{3,8}$/.test(c.hex) && !(key in colors)) colors[key] = c.hex;
  }
  const typography: Record<string, Record<string, string>> = {};
  for (const t of extracted.typography ?? []) {
    const role = slug(String(t.role ?? ""));
    if (role === "token" || typography[role]) continue;
    const entry: Record<string, string> = { fontFamily: t.family };
    if (t.size) entry.fontSize = t.size;
    if (t.weight) entry.fontWeight = t.weight;
    typography[role] = entry;
  }
  const frontmatter: Record<string, unknown> = {};
  if (Object.keys(colors).length) frontmatter.colors = colors;
  if (Object.keys(typography).length) frontmatter.typography = typography;
  const doc = specSkeleton("Design System", frontmatter, [
    { heading: "Overview", body: `${extracted.mood}\n\nCreated by the gstack designer from an approved mockup (${path.basename(sourceMockup)}) on ${timestamp}.` },
    { heading: EXTRACTED_SECTION_HEADING, body },
  ]);
  atomicWriteSync(designPath, renderDesignMd(doc));
  console.error(`Created DESIGN.md with extracted design language`);
}

function formatExtractedSection(
  extracted: ExtractedDesign,
  sourceMockup: string,
  date: string,
): string {
  const lines: string[] = [
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
  const doc = parseDesignMd(content);
  if (detectFormat(doc).format === "spec") {
    // Spec file: the normative tokens first, then the Overview prose. Both fit
    // the brief far better than the first 2000 bytes of YAML would.
    const { tokens } = tokensFlat(doc.frontmatter);
    const tokenLines = Object.entries(tokens).map(([k, v]) => `${k}: ${v}`).join("; ");
    const overview = doc.sections.find((s) => s.canonical === "Overview")?.body ?? "";
    return `Tokens: ${tokenLines}. ${overview}`.slice(0, 2000);
  }
  // Truncate to first 2000 chars to keep brief reasonable
  return content.slice(0, 2000);
}
