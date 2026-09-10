/**
 * Orchestrator — ties render, the diagram pre-pass, asideClient, and the
 * filesystem together.
 *
 *   generate(opts): markdown → PDF on disk. Returns output path.
 *   preview(opts):  markdown → HTML, opens it in a browser.
 *
 * Progress indication (per DX spec):
 *   - stdout: ONLY the output path, printed by cli.ts after this returns.
 *   - stderr: spinner + per-stage status lines, unless opts.quiet.
 *   - --verbose: stage timings.
 *
 * Every browser step is its own lib/aside-render `render()` call (an Aside
 * script when Aside is running, otherwise a tab in gstack's own headless
 * browser; nothing persists between them): one batch for diagram fences, one
 * for oversized-image downscales, one for DOCX rasters, one print. Parallel
 * $P generate calls never share state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { render } from "./render";
import { screenCss } from "./print-css";
import type { GenerateOptions, PreviewOptions } from "./types";
import { ExitCode } from "./types";
import { pickEngine } from "../../lib/aside-render";
import { renderPdf } from "./asideClient";
import {
  bundleRunner,
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

/** Default output location (`$P generate letter.md` → /tmp/letter.pdf). */
export const OUTPUT_TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";

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
    opts.output ?? path.join(OUTPUT_TMP_DIR, `${deriveSlug(input)}.${to}`),
  );

  // Stage 1: read markdown
  progress.begin("Reading markdown");
  const markdown = fs.readFileSync(input, "utf8");
  progress.end("Reading markdown");

  // Stage 1.5: diagram pre-pass — extract ```mermaid/```excalidraw fences and
  // swap in placeholder tokens. Rendering happens in Stage 2.5 below.
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

  // Stage 2.5: render diagram fences through the bundle, substitute slots,
  // then inline + probe + (if oversized) downscale local images. The runner
  // resolves the bundle lazily, so image-only documents never touch it; a
  // missing bundle or missing browser surfaces per fence as a diagnostic block.
  const warn = (msg: string) => {
    if (!opts.quiet) process.stderr.write(`\r\x1b[K[make-pdf] warning: ${msg}\n`);
  };
  const run = bundleRunner();
  let hasLandscape = false;

  let finalHtml = rendered.html;
  if (extraction.fences.length > 0) {
    progress.begin(`Rendering ${extraction.fences.length} diagram(s)`);
    finalHtml = substituteSlots(finalHtml, await renderFenceSlots(extraction.fences, run, warn));
    progress.end(`Rendering ${extraction.fences.length} diagram(s)`);
  }

  progress.begin("Inlining images");
  const contentWidthIn = contentWidthInches(opts);
  finalHtml = await inlineLocalImages(finalHtml, {
    inputDir: path.dirname(input),
    strict: opts.strict === true,
    allowNetwork: opts.allowNetwork === true,
    contentWidthIn,
    warn,
    run,
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

  // DOCX needs rasters, not inline SVG (Word's SVG support is unreliable).
  if (to === "docx") {
    if (/<figure class="diagram"|data:image\/svg\+xml/.test(finalHtml)) {
      progress.begin("Rasterizing diagrams for DOCX");
      finalHtml = await rasterizeDiagramFigures(finalHtml, run, contentWidthIn, warn);
      progress.end("Rasterizing diagrams for DOCX");
    }
    finalHtml = convertDiagnosticsForDocx(finalHtml);
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

  // Stage 3: print — one render: serve the staged HTML over loopback, (wait
  // ≤3s for Paged.js if --toc), print through whichever browser is up.
  const engine = pickEngine().engine;
  const via = engine === "aside" ? "Aside" : engine === "browse" ? "gstack's browser" : "a browser";
  progress.begin(`Rendering PDF through ${via}`);
  const used = await renderPdf(finalHtml, {
    output: outputPath,
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
  progress.end(`Rendering PDF through ${via}`);
  if (used && used !== engine) {
    // render() fell back mid-run (Aside quit or its CLI could not start): say
    // which browser actually produced the file, since the label above was
    // decided before the render.
    process.stderr.write("  Aside was unavailable mid-run; the PDF was rendered through gstack's own browser.\n");
  }

  const kb = Math.round(fs.statSync(outputPath).size / 1024);
  progress.done(`${rendered.meta.wordCount} words · ${kb}KB · ${outputPath}`);

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
  // Preview deliberately skips the diagram/image pre-pass (no browser
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
  const previewPath = path.join(OUTPUT_TMP_DIR, `make-pdf-preview-${deriveSlug(input)}.html`);
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
