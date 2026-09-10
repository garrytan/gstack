/**
 * make-pdf — shared types.
 *
 * No runtime code. Imports are safe from any module.
 */

export type PageSize = "letter" | "a4" | "legal" | "tabloid";
export type FontMode = "sans"; // v1: Helvetica only. Future: "serif" | "custom".

/**
 * Options for `$P generate` — the public CLI contract.
 * Matches the flag set documented in the CEO plan.
 */
export type OutputFormat = "pdf" | "html" | "docx";

export interface GenerateOptions {
  input: string;                  // markdown input path
  output?: string;                // output path (default: /tmp/<slug>.<ext>)

  // Output format (NOT --format, which is a --page-size alias):
  //   pdf  — print-quality PDF through the browser: Aside, else gstack's own (default)
  //   html — single self-contained file, zero network references
  //   docx — content-fidelity Word document (diagrams embedded as PNG)
  to?: OutputFormat;

  // Page layout
  margins?: string;               // "1in" | "72pt" | "25mm" | "2.54cm"
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  pageSize?: PageSize;            // default "letter"

  // Document structure
  cover?: boolean;
  toc?: boolean;
  noChapterBreaks?: boolean;      // default: chapter breaks ON

  // Branding
  watermark?: string;             // e.g. "DRAFT"
  headerTemplate?: string;        // raw HTML
  footerTemplate?: string;        // raw HTML, mutex with pageNumbers
  confidential?: boolean;         // default: true

  // Output control
  pageNumbers?: boolean;          // default: true
  tagged?: boolean;               // default: true (accessible PDF)
  outline?: boolean;              // default: true (PDF bookmarks)
  quiet?: boolean;                // suppress progress on stderr
  verbose?: boolean;              // per-stage timings on stderr

  // Network
  allowNetwork?: boolean;         // default: false

  // Strict mode (eng-review D6.1): missing/remote images hard-fail instead of
  // warn + placeholder. For CI docs pipelines that need determinism.
  strict?: boolean;               // default: false

  // Metadata
  title?: string;
  author?: string;
  date?: string;                  // ISO-ish; default: today
}

/**
 * Options for `$P preview`.
 */
export interface PreviewOptions {
  input: string;
  quiet?: boolean;
  verbose?: boolean;
  // Same render flags as generate so preview matches output
  cover?: boolean;
  toc?: boolean;
  watermark?: string;
  noChapterBreaks?: boolean;
  confidential?: boolean;
  pageNumbers?: boolean;
  allowNetwork?: boolean;
  title?: string;
  author?: string;
  date?: string;
}

/**
 * Exit codes for $P generate.
 * Mirror these in orchestrator error paths.
 */
export const ExitCode = {
  Success: 0,
  BadArgs: 1,
  RenderError: 2,
  PagedJsTimeout: 3,
  BrowserUnavailable: 4,
} as const;
export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

/**
 * No browser at all: Aside is not installed or not open AND gstack's own
 * headless browser is not built (exit 4). The message (lib/aside-render's
 * NO_BROWSER text) names both remedies. A render that fails while a browser
 * IS available is a plain Error (exit 2).
 */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}
