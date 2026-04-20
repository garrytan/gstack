/**
 * Command registry for make-pdf — single source of truth.
 *
 * Dependency graph:
 *   commands.ts ──▶ cli.ts (runtime dispatch)
 *              ──▶ gen-skill-docs.ts (generates usage table in SKILL.md)
 *              ──▶ tests (validation)
 *
 * Zero side effects. Safe to import from build scripts.
 */

export const COMMANDS = new Map<string, {
  description: string;
  usage: string;
  flags?: string[];
  category: "Primary" | "Setup";
}>([
  ["generate", {
    description: "Render a markdown file to a publication-quality PDF",
    usage: "generate <input.md> [output.pdf] [options]",
    category: "Primary",
    flags: [
      // Page layout
      "--margins", "--margin-top", "--margin-right", "--margin-bottom", "--margin-left",
      "--page-size", "--format",
      // Structure
      "--cover", "--toc", "--no-chapter-breaks",
      // Branding
      "--watermark", "--header-template", "--footer-template", "--no-confidential",
      // Output
      "--page-numbers", "--no-page-numbers", "--tagged", "--no-tagged",
      "--outline", "--no-outline", "--quiet", "--verbose",
      // Network
      "--allow-network",
      // Metadata
      "--title", "--author", "--date",
    ],
  }],
  ["preview", {
    description: "Render markdown to HTML and open it in the browser (fast iteration)",
    usage: "preview <input.md> [options]",
    category: "Primary",
    flags: [
      "--cover", "--toc", "--no-chapter-breaks", "--watermark",
      "--no-confidential", "--allow-network",
      "--title", "--author", "--date",
      "--quiet", "--verbose",
    ],
  }],
  ["setup", {
    description: "Verify browse + Chromium + pdftotext, then run a smoke test",
    usage: "setup",
    category: "Setup",
    flags: [],
  }],
  ["version", {
    description: "Print make-pdf version",
    usage: "version",
    category: "Setup",
    flags: [],
  }],
]);
