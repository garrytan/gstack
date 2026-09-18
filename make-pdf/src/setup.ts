/**
 * `$P setup` — guided smoke test.
 *
 * Flow:
 *   1. Find a browser: Aside (primary) or gstack's own headless browser (fallback)
 *   2. Render a tiny HTML page through it
 *   3. Verify pdftotext is installed (warn, don't fail)
 *   4. Generate a smoke-test PDF from an inline 2-paragraph fixture
 *   5. Print a 3-command cheatsheet
 */

import * as path from "node:path";
import * as fs from "node:fs";

import { NO_BROWSER_HELP, pickEngine, render, renderTmpDir } from "../../lib/aside-render";
import { ExitCode } from "./types";
import { resolvePdftotext, PdftotextUnavailableError } from "./pdftotext";
import { OUTPUT_TMP_DIR, generate } from "./orchestrator";

export async function runSetup(): Promise<void> {
  process.stderr.write("make-pdf setup — verifying install\n\n");

  // 1. A browser: Aside when it answers, else gstack's own
  process.stderr.write("  [1/5] Checking for a browser...");
  const engine = pickEngine();
  if (!engine.engine) {
    process.stderr.write(" FAIL\n");
    process.stderr.write(`\n${engine.error}\n`);
    process.exit(ExitCode.BrowserUnavailable);
  }
  const via = engine.engine === "aside" ? `Aside ${engine.version}` : "gstack browser";
  process.stderr.write(engine.engine === "aside"
    ? ` Aside OK (${engine.version})\n`
    : ` gstack browser OK (fallback: ${engine.bin}; Aside is not running)\n`);

  // 2. Render smoke: open a tiny page and read it back
  process.stderr.write(`  [2/5] Rendering through ${via}...`);
  const smokeDir = fs.mkdtempSync(path.join(renderTmpDir(), "make-pdf-setup-"));
  try {
    const file = path.join(smokeDir, "smoke.html");
    fs.writeFileSync(file, "<!doctype html><title>make-pdf smoke</title><p id=t>browser-ok</p>", "utf8");
    const r = await render({ file, steps: [{ kind: "eval", expression: "document.getElementById('t').textContent" }] });
    if (!r.ok || r.evals[0] !== "browser-ok") {
      throw new Error(r.error ?? `unexpected page text: ${r.evals[0]}`);
    }
    process.stderr.write(" OK\n");
  } catch (err: any) {
    process.stderr.write(" FAIL\n");
    process.stderr.write(`\n${via} could not render a page: ${err.message}\n`);
    process.stderr.write(`To fix: ${NO_BROWSER_HELP}\n`);
    process.exit(ExitCode.BrowserUnavailable);
  } finally {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }

  // 3. pdftotext (optional — CI gate only)
  process.stderr.write("  [3/5] Checking pdftotext (optional)...");
  try {
    const info = resolvePdftotext();
    process.stderr.write(` OK (${info.flavor}, ${info.version.split(" ").slice(-1)[0] || "version unknown"})\n`);
  } catch (err) {
    process.stderr.write(" SKIP\n");
    if (err instanceof PdftotextUnavailableError) {
      process.stderr.write(
        "    pdftotext not installed. This is optional — only the CI\n" +
        "    copy-paste gate needs it. To enable:\n" +
        "      macOS:  brew install poppler\n" +
        "      Ubuntu: sudo apt-get install poppler-utils\n",
      );
    }
  }

  // 4. Render smoke-test PDF
  process.stderr.write("  [4/5] Generating smoke-test PDF...\n");
  const fixture = [
    "# Hello from make-pdf",
    "",
    "This is a two-paragraph smoke test. If you can read this sentence in the PDF that just opened, the pipeline works end-to-end.",
    "",
    "The second paragraph contains curly quotes (\"hello\"), an em dash -- like this, and an ellipsis... all of which should render correctly.",
    "",
  ].join("\n");
  const fixturePath = path.join(OUTPUT_TMP_DIR, `make-pdf-smoke-${process.pid}.md`);
  const outPath = path.join(OUTPUT_TMP_DIR, `make-pdf-smoke-${process.pid}.pdf`);
  fs.writeFileSync(fixturePath, fixture, "utf8");

  try {
    await generate({
      input: fixturePath,
      output: outPath,
      quiet: true,
      pageNumbers: true,
    });
    process.stderr.write(`        PASSED. Smoke test saved to ${outPath}\n`);
  } catch (err: any) {
    process.stderr.write(`        FAILED: ${err.message}\n`);
    process.exit(2);
  } finally {
    try { fs.unlinkSync(fixturePath); } catch { /* ignore */ }
  }

  // 5. Cheatsheet
  process.stderr.write("  [5/5] All checks passed.\n\n");
  process.stderr.write([
    "make-pdf is ready. Try:",
    "  $P generate letter.md                  # default memo mode",
    "  $P generate --cover --toc essay.md     # full publication",
    "  $P generate --watermark DRAFT memo.md  # diagonal watermark",
    "",
    `Smoke-test PDF: ${outPath}`,
    "",
  ].join("\n"));
}
