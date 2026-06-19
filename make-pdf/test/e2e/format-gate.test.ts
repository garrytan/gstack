/**
 * Output-format gate for `--to html` and `--to docx` (eng-review P7/P8),
 * driven through the compiled binary against the diagram-gate fixture
 * (diagrams + relative image + broken fence + render=false fence).
 *
 * HTML contract: ONE self-contained file — zero network references, no
 * scripts, diagrams as inline SVG, images as data URIs, screen media layer.
 *
 * DOCX contract: content fidelity, not layout fidelity — valid OOXML zip,
 * document.xml carries headings/code/diagnostics, diagrams embedded as PNG
 * media. (A .docx is a zip: unzip -p is the oracle.)
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURE = path.resolve(__dirname, "../fixtures/diagram-gate.md");
const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");
const BROWSE_BIN = path.join(ROOT, "browse/dist/browse");
const BUNDLE = path.join(ROOT, "lib/diagram-render/dist/diagram-render.html");

const CHILD_TIMEOUT_MS = 60_000;

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  if (!fs.existsSync(BROWSE_BIN)) return { ok: false, reason: `browse binary missing (${BROWSE_BIN}).` };
  if (!fs.existsSync(BUNDLE)) return { ok: false, reason: `diagram-render bundle missing (${BUNDLE}).` };
  if (!fs.existsSync(FIXTURE)) return { ok: false, reason: `fixture missing (${FIXTURE}).` };
  if (!Bun.which("unzip")) return { ok: false, reason: "unzip not found (needed for docx zip checks)." };
  return { ok: true };
}

function generate(to: string, outputPath: string): void {
  execFileSync(PDF_BIN, ["generate", FIXTURE, outputPath, "--quiet", "--to", to], {
    encoding: "utf8",
    env: { ...process.env, BROWSE_BIN },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
  });
}

describe("output format gate", () => {
  const avail = prerequisitesAvailable();

  test.skipIf(!avail.ok)("--to html: single self-contained file, zero network refs", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-format-html-");
    const out = path.join(workDir, "out.html");
    try {
      generate("html", out);
      const html = fs.readFileSync(out, "utf8");

      // Zero network references and zero scripts. (The only http(s) tokens
      // allowed are XML namespace identifiers inside inline SVG, which are
      // never fetched.)
      const refs = html.match(/\b(?:src|href)\s*=\s*"https?:[^"]*"/gi) ?? [];
      expect(refs).toEqual([]);
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/<link\b/i);

      // Diagrams inline as vector SVG; images inline as data URIs.
      expect(html).toContain('<figure class="diagram"');
      expect(html).toMatch(/<svg/i);
      expect(html).toContain("data:image/png;base64,");

      // Screen layer present; diagnostic block survived.
      expect(html).toContain("@media screen");
      expect(html).toContain("Diagram failed to render (mermaid)");
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  test.skipIf(!avail.ok)("--to docx: valid OOXML with content + PNG diagram media", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-format-docx-");
    const out = path.join(workDir, "out.docx");
    try {
      generate("docx", out);

      const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      expect(listing).toContain("word/document.xml");
      expect(listing).toContain("[Content_Types].xml");
      // Diagram PNGs + fixture image land in media/.
      expect((listing.match(/word\/media\/image[^\s]*\.png/g) ?? []).length).toBeGreaterThanOrEqual(2);

      const xml = execFileSync("unzip", ["-p", out, "word/document.xml"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      const text = xml
        .replace(/<[^>]+>/g, " ")
        .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

      // Headings, render=false code, and the diagnostic all survive.
      expect(text).toContain("Diagram Gate");
      expect(text).toContain("RAWKEPT");
      expect(text).toContain("Diagram failed to render");
      // Rendered fences ship as images, not leaked source.
      expect(text).not.toContain("GATEALPHA[");
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  test.skipIf(!avail.ok)("--to rejects unknown formats with a --format disambiguation hint", () => {
    if (!avail.ok) return;
    let stderr = "";
    try {
      execFileSync(PDF_BIN, ["generate", FIXTURE, "--to", "epub"], {
        encoding: "utf8",
        env: { ...process.env, BROWSE_BIN },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      });
    } catch (err: any) {
      stderr = err.stderr?.toString() ?? "";
    }
    expect(stderr).toContain("invalid --to");
    expect(stderr).toContain("--page-size alias");
  }, 60000);

  if (!avail.ok) {
    test("format gate prerequisites are present (hard-required in CI)", () => {
      if (process.env.CI) {
        throw new Error(`format gate prerequisites missing in CI: ${avail.reason}`);
      }
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
