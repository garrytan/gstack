/**
 * `$P setup` — guided smoke test.
 *
 * Flow (per the CEO plan CLI UX spec):
 *   1. Verify browse binary exists and responds
 *   2. Verify Chromium launches by opening a blank file: page
 *   3. Verify pdftotext is installed (warn, don't fail)
 *   4. Generate a smoke-test PDF from an inline 2-paragraph fixture
 *   5. Open it
 *   6. Print a 3-command cheatsheet
 */

import * as path from "node:path";
import * as fs from "node:fs";

import * as browseClient from "./browseClient";
import { resolvePdftotext, PdftotextUnavailableError } from "./pdftotext";
import { generate } from "./orchestrator";

export async function runSetup(): Promise<void> {
  process.stderr.write("make-pdf setup — verifying install\n\n");

  // 1. Resolve browse binary
  process.stderr.write("  [1/5] Checking browse binary...");
  try {
    const bin = browseClient.resolveBrowseBin();
    process.stderr.write(` OK (${bin})\n`);
  } catch (err: any) {
    process.stderr.write(" FAIL\n");
    process.stderr.write(`\n${err.message}\n`);
    process.exit(4);
  }

  // 2. Chromium smoke (navigate a dedicated tab to a throwaway blank page)
  process.stderr.write("  [2/5] Launching Chromium...");
  let chromiumTab: number | null = null;
  // browse only permits http:, https: and file: URLs, and confines file: paths
  // to the safe-dirs allowlist, so "about:blank" is rejected on both counts.
  // A blank file: page under PAYLOAD_TMP_DIR is the network-free equivalent.
  const smokePage = path.join(browseClient.PAYLOAD_TMP_DIR, `make-pdf-smoke-${process.pid}.html`);
  try {
    fs.writeFileSync(smokePage, "<!doctype html><title>make-pdf smoke</title>");
    chromiumTab = browseClient.newtab(`file://${smokePage}`);
    process.stderr.write(` OK (tab ${chromiumTab})\n`);
  } catch (err: any) {
    process.stderr.write(" FAIL\n");
    process.stderr.write(`\nChromium failed to launch: ${err.message}\n`);
    process.stderr.write("\nTo fix: run gstack setup from the gstack repo:\n");
    process.stderr.write("  cd ~/.claude/skills/gstack && ./setup\n");
    process.exit(4);
  } finally {
    if (chromiumTab !== null) {
      try { browseClient.closetab(chromiumTab); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(smokePage); } catch { /* best-effort cleanup */ }
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
  const fixturePath = path.join(browseClient.PAYLOAD_TMP_DIR, `make-pdf-smoke-${process.pid}.md`);
  const outPath = path.join(browseClient.PAYLOAD_TMP_DIR, `make-pdf-smoke-${process.pid}.pdf`);
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
