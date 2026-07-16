/**
 * Orchestrator — ties render, browseClient, and filesystem together.
 *
 *   generate(opts): markdown → PDF on disk. Returns output path.
 *   preview(opts):  markdown → HTML, opens it in a browser.
 *
 * Progress indication (per DX spec):
 *   - stdout: ONLY the output path, printed by cli.ts after this returns.
 *   - stderr: spinner + per-stage status lines, unless opts.quiet.
 *   - --verbose: stage timings.
 *
 * Tab lifecycle: every generate opens a dedicated tab via $B newtab --json,
 * runs load-html/js/pdf against --tab-id <N>, and closes the tab in a
 * try/finally. Parallel $P generate calls never race on the active tab.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

import { render } from "./render";
import { screenCss } from "./print-css";
import type { GenerateOptions, PreviewOptions } from "./types";
import { ExitCode } from "./types";
import * as browseClient from "./browseClient";
import {
  RenderTab,
  contentWidthInches,
  convertDiagnosticsForDocx,
  extractDiagramFences,
  inlineLocalImages,
  landscapeContentBox,
  rasterizeDiagramFigures,
  renderFenceSlots,
  substituteSlots,
} from "./diagram-prepass";
import { applyImagePolicy } from "./image-policy";

class ProgressReporter {
  private readonly quiet: boolean;
  private readonly verbose: boolean;
  private readonly stageStart = new Map<string, number>();
  private readonly totalStart: number;
  constructor(opts: { quiet?: boolean; verbose?: boolean }) {
    this.quiet = opts.quiet === true;
    this.verbose = opts.verbose === true;
    this.totalStart = Date.now();
  }
  begin(stage: string): void {
    this.stageStart.set(stage, Date.now());
    if (this.quiet) return;
    process.stderr.write(`\r\x1b[K${stage}...`);
  }
  end(stage: string, extra?: string): void {
    const start = this.stageStart.get(stage) ?? Date.now();
    const ms = Date.now() - start;
    if (this.quiet) return;
    if (this.verbose) {
      process.stderr.write(`\r\x1b[K${stage} (${ms}ms)${extra ? ` — ${extra}` : ""}\n`);
    }
  }
  done(extra: string): void {
    if (this.quiet) return;
    const total = ((Date.now() - this.totalStart) / 1000).toFixed(1);
    process.stderr.write(`\r\x1b[KDone in ${total}s. ${extra}\n`);
  }
  fail(stage: string, err: Error): void {
    if (!this.quiet) process.stderr.write("\r\x1b[K");
    // Always emit failure info, even in quiet mode — this is an error path.
    process.stderr.write(`${stage} failed: ${err.message}\n`);
  }
}

/**
 * generate — full pipeline. Returns the output PDF path on success.
 */
export async function generate(opts: GenerateOptions): Promise<string> {
  const progress = new ProgressReporter(opts);
  const input = path.resolve(opts.input);

  if (!fs.existsSync(input)) {
    throw new Error(`input file not found: ${input}`);
  }

  const to = opts.to ?? "pdf";
  const outputPath = path.resolve(
    opts.output ?? path.join(os.tmpdir(), `${deriveSlug(input)}.${to}`),
  );

  // Stage 1: read markdown
  progress.begin("Reading markdown");
  const markdown = fs.readFileSync(input, "utf8");
  progress.end("Reading markdown");

  // Stage 1.5: diagram pre-pass — extract ```mermaid/```excalidraw fences and
  // swap in placeholder tokens. Rendering happens after the tab opens below.
  const extraction = extractDiagramFences(markdown);

  // Stage 2: render HTML
  progress.begin("Rendering HTML");
  const rendered = render({
    markdown: extraction.markdown,
    title: opts.title,
    author: opts.author,
    date: opts.date,
    cover: opts.cover,
    toc: opts.toc,
    watermark: opts.watermark,
    noChapterBreaks: opts.noChapterBreaks,
    confidential: opts.confidential,
    pageSize: opts.pageSize,
    margins: opts.margins,
    marginTop: opts.marginTop,
    marginRight: opts.marginRight,
    marginBottom: opts.marginBottom,
    marginLeft: opts.marginLeft,
    pageNumbers: opts.pageNumbers,
    footerTemplate: opts.footerTemplate,
  });
  progress.end("Rendering HTML", `${rendered.meta.wordCount} words`);

  // Stage 2.5: render diagram fences in a dedicated bundle tab, substitute
  // slots, then inline + probe + (if oversized) downscale local images.
  // The bundle tab is lazy: image-only documents open it only when a raster
  // actually needs print-resolution downscaling (eng-review D4).
  const warn = (msg: string) => {
    if (!opts.quiet) process.stderr.write(`\r\x1b[K[make-pdf] warning: ${msg}\n`);
  };
  let renderTab: RenderTab | null = null;
  let hasLandscape = false;
  const getRenderTab = (): RenderTab | null => {
    if (renderTab) return renderTab;
    try {
      renderTab = RenderTab.open();
    } catch (err: any) {
      warn(`diagram-render tab unavailable: ${String(err?.message ?? err).split("\n")[0]}`);
      return null;
    }
    return renderTab;
  };

  let finalHtml = rendered.html;
  try {
    if (extraction.fences.length > 0) {
      progress.begin(`Rendering ${extraction.fences.length} diagram(s)`);
      const tab = getRenderTab();
      if (tab) {
        const slots = renderFenceSlots(extraction.fences, tab, warn);
        finalHtml = substituteSlots(finalHtml, slots);
      } else {
        // No bundle/tab: visible diagnostic beats silent raw tokens.
        const slots = new Map(
          extraction.fences.map((f) => [
            f.token,
            `<figure class="diagram diagram-error" role="img" aria-label="diagram ${f.ordinal} (not rendered)">` +
            `<figcaption class="diagram-error-title">Diagram not rendered (${f.lang}) — diagram-render bundle unavailable</figcaption></figure>`,
          ]),
        );
        finalHtml = substituteSlots(finalHtml, slots);
      }
      progress.end(`Rendering ${extraction.fences.length} diagram(s)`);
    }

    progress.begin("Inlining images");
    const contentWidthIn = contentWidthInches(opts);
    finalHtml = inlineLocalImages(finalHtml, {
      inputDir: path.dirname(input),
      strict: opts.strict === true,
      allowNetwork: opts.allowNetwork === true,
      contentWidthIn,
      warn,
      getTab: getRenderTab,
    });
    progress.end("Inlining images");

    // Width directives + conservative auto-landscape (image-policy).
    const policy = applyImagePolicy(finalHtml, {
      contentWidthIn,
      landscape: landscapeContentBox(opts),
      warn,
    });
    finalHtml = policy.html;
    hasLandscape = policy.hasLandscape;

    // DOCX needs rasters, not inline SVG (Word's SVG support is unreliable) —
    // do it while the render tab is still open.
    if (to === "docx") {
      const needsRaster = /<figure class="diagram"|data:image\/svg\+xml/.test(finalHtml);
      if (needsRaster) {
        progress.begin("Rasterizing diagrams for DOCX");
        const tab = getRenderTab();
        if (tab) {
          finalHtml = rasterizeDiagramFigures(finalHtml, tab, contentWidthIn, warn);
        } else {
          warn("docx: no render tab — diagrams keep their source text form");
        }
        progress.end("Rasterizing diagrams for DOCX");
      }
      finalHtml = convertDiagnosticsForDocx(finalHtml);
    }
  } finally {
    renderTab?.close();
  }

  // ─── --to html: write the self-contained document, no print round-trip ──
  if (to === "html") {
    const withScreenLayer = finalHtml.replace(
      "</style>",
      `</style>\n<style>\n${screenCss()}\n</style>`,
    );
    fs.writeFileSync(outputPath, withScreenLayer, "utf8");
    const kb = Math.round(fs.statSync(outputPath).size / 1024);
    progress.done(`${rendered.meta.wordCount} words · ${kb}KB · ${outputPath}`);
    return outputPath;
  }

  // ─── --to docx: content-fidelity conversion (eng-review P8) ────────────
  if (to === "docx") {
    // Print-only surfaces don't survive the conversion. The watermark div
    // would degrade to a literal body paragraph reading "DRAFT" (worse than
    // absent) — strip it. Warn once about print-only flags that were set.
    finalHtml = finalHtml.replace(/<div class="watermark">[\s\S]*?<\/div>/, "");
    const printOnly: string[] = [];
    if (opts.watermark) printOnly.push("--watermark");
    if (opts.headerTemplate) printOnly.push("--header-template");
    if (opts.footerTemplate) printOnly.push("--footer-template");
    if (opts.pageSize) printOnly.push("--page-size");
    if (opts.margins || opts.marginTop || opts.marginRight || opts.marginBottom || opts.marginLeft) printOnly.push("--margins");
    if (printOnly.length > 0) {
      warn(`docx is content-fidelity: ${printOnly.join(", ")} do not apply to Word output`);
    }
    progress.begin("Converting to DOCX");
    const { default: HTMLtoDOCX } = await import("html-to-docx");
    const buf = await HTMLtoDOCX(finalHtml, null, {
      title: rendered.meta.title,
      creator: rendered.meta.author || undefined,
    });
    const bytes: Uint8Array = buf instanceof Uint8Array ? buf : new Uint8Array(await (buf as Blob).arrayBuffer());
    fs.writeFileSync(outputPath, bytes);
    progress.end("Converting to DOCX");
    const kb = Math.round(fs.statSync(outputPath).size / 1024);
    progress.done(`${rendered.meta.wordCount} words · ${kb}KB · ${outputPath} (content fidelity — layout is Word's)`);
    return outputPath;
  }

  // Stage 3: write HTML to a tmp file browse can read
  // (We don't actually write it; we pass inline via --from-file JSON.)
  // But for preview mode and debugging, we still write to tmp.
  const htmlTmp = tmpFile("html");
  fs.writeFileSync(htmlTmp, finalHtml, "utf8");

  // Stage 4: spin up a dedicated tab, load HTML, (wait for Paged.js if TOC),
  // then emit PDF. Always close the tab.
  progress.begin("Opening tab");
  const tabId = browseClient.newtab();
  progress.end("Opening tab", `tabId=${tabId}`);

  try {
    progress.begin("Loading HTML into Chromium");
    browseClient.loadHtml({
      html: finalHtml,
      waitUntil: "domcontentloaded",
      tabId,
    });
    progress.end("Loading HTML into Chromium");

    if (opts.toc) {
      progress.begin("Paginating with Paged.js");
      // Browse's $B pdf already waits internally when --toc is passed.
      // We pass toc=true to browseClient.pdf() below.
      progress.end("Paginating with Paged.js", "Paged.js after");
    }

    progress.begin("Generating PDF");
    browseClient.pdf({
      output: outputPath,
      tabId,
      format: opts.pageSize ?? "letter",
      marginTop: opts.marginTop ?? opts.margins ?? "1in",
      marginRight: opts.marginRight ?? opts.margins ?? "1in",
      marginBottom: opts.marginBottom ?? opts.margins ?? "1in",
      marginLeft: opts.marginLeft ?? opts.margins ?? "1in",
      headerTemplate: opts.headerTemplate,
      footerTemplate: opts.footerTemplate,
      // CSS is the single source of truth for page numbers (see print-css.ts
      // @bottom-center). Chromium's native numbering always off to avoid double
      // footers. The CSS layer honors pageNumbers + footerTemplate via render().
      pageNumbers: false,
      tagged: opts.tagged !== false,
      outline: opts.outline !== false,
      printBackground: !!opts.watermark,
      // Named landscape pages only take effect when Chromium honors CSS page
      // sizes. Flip it ONLY when a promotion exists — minimal behavior change
      // for every other document.
      preferCSSPageSize: hasLandscape ? true : undefined,
      toc: opts.toc,
    });
    progress.end("Generating PDF");

    const stat = fs.statSync(outputPath);
    const kb = Math.round(stat.size / 1024);
    progress.done(`${rendered.meta.wordCount} words · ${kb}KB · ${outputPath}`);
  } finally {
    // Always clean up the tab — even on crash, timeout, or Chromium hang.
    try {
      browseClient.closetab(tabId);
    } catch {
      // best-effort; we already exited the main path
    }
    // Cleanup tmp HTML
    try { fs.unlinkSync(htmlTmp); } catch { /* best-effort */ }
  }

  return outputPath;
}

/**
 * preview — render HTML and open it. No PDF round trip.
 */
export async function preview(opts: PreviewOptions): Promise<string> {
  const progress = new ProgressReporter(opts);
  const input = path.resolve(opts.input);
  if (!fs.existsSync(input)) {
    throw new Error(`input file not found: ${input}`);
  }

  progress.begin("Rendering HTML");
  const markdown = fs.readFileSync(input, "utf8");
  // Preview deliberately skips the diagram/image pre-pass (no browse daemon
  // round-trip — preview is the fast loop). Be loud about the divergence so
  // nobody signs off on a preview that lacks what the PDF will have.
  if (!opts.quiet) {
    const fenceCount = extractDiagramFences(markdown).fences.length;
    const hasLocalImages = /!\[[^\]]*\]\((?!https?:|data:)[^)]+\)/.test(markdown);
    if (fenceCount > 0 || hasLocalImages) {
      process.stderr.write(
        `[make-pdf] preview note: ${fenceCount > 0 ? `${fenceCount} diagram fence(s) shown as code` : ""}` +
        `${fenceCount > 0 && hasLocalImages ? "; " : ""}` +
        `${hasLocalImages ? "local images may not resolve from the preview location" : ""}` +
        ` — \`generate\` renders them fully.\n`,
      );
    }
  }
  const rendered = render({
    markdown,
    title: opts.title,
    author: opts.author,
    date: opts.date,
    cover: opts.cover,
    toc: opts.toc,
    watermark: opts.watermark,
    noChapterBreaks: opts.noChapterBreaks,
    confidential: opts.confidential,
    pageNumbers: opts.pageNumbers,
  });
  progress.end("Rendering HTML", `${rendered.meta.wordCount} words`);

  // Write to a stable path under /tmp so the user can reload in the same tab.
  const previewPath = path.join(os.tmpdir(), `make-pdf-preview-${deriveSlug(input)}.html`);
  fs.writeFileSync(previewPath, rendered.html, "utf8");

  progress.begin("Opening preview");
  tryOpen(previewPath);
  progress.end("Opening preview");

  progress.done(`Preview at ${previewPath}`);
  return previewPath;
}

// ─── helpers ──────────────────────────────────────────────

function deriveSlug(p: string): string {
  const base = path.basename(p).replace(/\.[^.]+$/, "");
  return base.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 64) || "document";
}

function tmpFile(ext: string): string {
  const hash = crypto.randomBytes(6).toString("hex");
  return path.join(os.tmpdir(), `make-pdf-${process.pid}-${hash}.${ext}`);
}

function tryOpen(pathOrUrl: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" :
              platform === "win32" ? "cmd" :
              "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", pathOrUrl] : [pathOrUrl];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Non-fatal; the caller already has the path and will print it.
  }
}

/** Setup-only re-export so cli.ts can dynamic-import without another file. */
export { ExitCode };
