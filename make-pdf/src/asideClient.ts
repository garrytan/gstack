/**
 * make-pdf's render client: final HTML → PDF through lib/aside-render's
 * `render()` — the Aside browser (macOS 15+, aside.com) when it is running,
 * otherwise gstack's own headless browser (the browse daemon; GSTACK_BROWSE_BIN
 * / BROWSE_BIN override where it lives). The HTML is staged into a private
 * dir, served over loopback for the duration of the render, printed, and the
 * PDF copied to `output`. No browser at all is exit 4 (BrowserUnavailableError).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  NO_BROWSER,
  PAGE_NUMBER_FOOTER,
  lengthToInches,
  paperInches,
  render,
  renderTmpDir,
  type PdfStepOptions,
  type RenderEngine,
} from "../../lib/aside-render";
import { BrowserUnavailableError } from "./types";

export interface PdfOptions {
  output: string;
  format?: string;
  width?: string;
  height?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  pageNumbers?: boolean;
  tagged?: boolean;
  outline?: boolean;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  /** Wait (≤3s, non-fatal) for Paged.js before printing. */
  toc?: boolean;
}

/**
 * make-pdf's option shape → CDP Page.printToPDF options (inches). Same
 * mapping the browse `pdf` command applies: Letter when no size is
 * given, empty `<div></div>` for whichever header/footer slot is unset so
 * Chromium never prints its default URL/date, margins default to none.
 */
export function pdfStepOptions(opts: PdfOptions): PdfStepOptions {
  const o: PdfStepOptions = {};

  if (opts.format) {
    const paper = paperInches(opts.format);
    if (!paper) throw new Error(`unknown page size: ${opts.format}`);
    [o.paperWidth, o.paperHeight] = paper;
  } else if (opts.width && opts.height) {
    o.paperWidth = lengthToInches(opts.width);
    o.paperHeight = lengthToInches(opts.height);
  } else {
    [o.paperWidth, o.paperHeight] = paperInches("letter")!;
  }

  o.marginTop = lengthToInches(opts.marginTop) ?? 0;
  o.marginRight = lengthToInches(opts.marginRight) ?? 0;
  o.marginBottom = lengthToInches(opts.marginBottom) ?? 0;
  o.marginLeft = lengthToInches(opts.marginLeft) ?? 0;

  if (opts.headerTemplate !== undefined || opts.footerTemplate !== undefined || opts.pageNumbers === true) {
    o.displayHeaderFooter = true;
    o.headerTemplate = opts.headerTemplate ?? "<div></div>";
    o.footerTemplate = opts.pageNumbers ? PAGE_NUMBER_FOOTER : (opts.footerTemplate ?? "<div></div>");
  }

  if (opts.tagged === true) o.generateTaggedPDF = true;
  if (opts.outline === true) o.generateDocumentOutline = true;
  if (opts.printBackground === true) o.printBackground = true;
  if (opts.preferCSSPageSize === true) o.preferCSSPageSize = true;
  if (opts.toc === true) o.waitForPagedJs = true;
  return o;
}

/**
 * Render a self-contained HTML document to `opts.output`. Everything the page
 * needs must be inline (the orchestrator inlines images as data URIs): only
 * the staging dir is served.
 */
export async function renderPdf(
  html: string,
  opts: PdfOptions,
  renderFn: typeof render = render,
): Promise<RenderEngine | undefined> {
  const dir = fs.mkdtempSync(path.join(renderTmpDir(), "make-pdf-"));
  try {
    const file = path.join(dir, "document.html");
    fs.writeFileSync(file, html, "utf8");
    const result = await renderFn({
      file,
      steps: [{ kind: "pdf", out: path.resolve(opts.output), options: pdfStepOptions(opts) }],
    });
    if (!result.ok) throw renderFailure(result.error ?? "unknown error");
    return result.engine;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Classify a failed render: a BrowserUnavailableError (exit 4) when neither
 * browser could run at all, otherwise a plain render error (exit 2).
 */
export function renderFailure(detail: string): Error {
  return detail.startsWith(NO_BROWSER)
    ? new BrowserUnavailableError(detail)
    : new Error(`PDF render failed: ${detail}`);
}
