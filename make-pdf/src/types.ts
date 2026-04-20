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
export interface GenerateOptions {
  input: string;                  // markdown input path
  output?: string;                // PDF output path (default: /tmp/<slug>.pdf)

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
  allowNetwork?: boolean;
  title?: string;
  author?: string;
  date?: string;
}

/**
 * Parsed page.pdf() options passed to browse.
 */
export interface BrowsePdfOptions {
  output: string;
  tabId: number;
  format?: PageSize;
  width?: string;
  height?: string;
  margins?: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
  headerTemplate?: string;
  footerTemplate?: string;
  pageNumbers?: boolean;
  displayHeaderFooter?: boolean;
  tagged?: boolean;
  outline?: boolean;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  toc?: boolean;                  // signals browse to wait for Paged.js
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
  BrowseUnavailable: 4,
} as const;
export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

/**
 * Structured error for browse CLI shell-out failures.
 */
export class BrowseClientError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(`browse ${command} exited ${exitCode}: ${stderr.trim()}`);
    this.name = "BrowseClientError";
  }
}
