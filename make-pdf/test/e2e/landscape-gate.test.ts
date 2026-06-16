/**
 * Landscape promotion gate — proves the conservative auto-landscape policy
 * end-to-end through the compiled binary, asserted on pdfinfo per-page boxes
 * (the only oracle that can't lie about orientation).
 *
 * The fixture encodes one of each decision:
 *   - wide screenshot, no alt hint    → MUST stay portrait (false-positive guard)
 *   - wide image, alt "architecture diagram" → promotes
 *   - small image with {page=landscape}      → promotes (directive force)
 *   - wide mermaid sequence diagram          → promotes (provenance automatic)
 *   - wide mermaid with page=portrait fence  → MUST stay portrait (veto)
 *
 * Also runs the --toc combo: Paged.js isn't shipped in v1 (TOC renders
 * without page numbers, browse falls through after 3s), so named-page
 * landscape must survive a --toc run unchanged. If Paged.js ever lands and
 * re-paginates, this is the test that catches the interaction.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePopplerTool } from "../../src/pdftotext";

const FIXTURE = path.resolve(__dirname, "../fixtures/landscape-gate.md");
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
  if (!resolvePopplerTool("pdfinfo")) return { ok: false, reason: "pdfinfo not found (install poppler-utils)." };
  if (!resolvePopplerTool("pdftotext")) return { ok: false, reason: "pdftotext not found (install poppler-utils)." };
  return { ok: true };
}

interface PageBox {
  page: number;
  width: number;
  height: number;
}

function pageBoxes(pdfPath: string): PageBox[] {
  const pdfinfo = resolvePopplerTool("pdfinfo")!;
  const out = execFileSync(pdfinfo, ["-f", "1", "-l", "99", pdfPath], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  const boxes: PageBox[] = [];
  for (const m of out.matchAll(/Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/g)) {
    boxes.push({ page: Number(m[1]), width: parseFloat(m[2]), height: parseFloat(m[3]) });
  }
  if (boxes.length === 0) throw new Error(`pdfinfo reported no page sizes:\n${out}`);
  return boxes;
}

const isLandscape = (b: PageBox) => b.width > b.height;

function generate(args: string[], outputPdf: string): void {
  execFileSync(PDF_BIN, ["generate", FIXTURE, outputPdf, "--quiet", ...args], {
    encoding: "utf8",
    env: { ...process.env, BROWSE_BIN },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
  });
}

describe("landscape promotion gate", () => {
  const avail = prerequisitesAvailable();

  test.skipIf(!avail.ok)("exactly the promoted blocks get landscape pages", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-landscape-gate-");
    const outputPdf = path.join(workDir, "out.pdf");
    try {
      generate([], outputPdf);
      const boxes = pageBoxes(outputPdf);
      const landscape = boxes.filter(isLandscape);
      const portrait = boxes.filter((b) => !isLandscape(b));

      // Three promotions: alt-hinted image, directive-forced image, wide diagram.
      expect(landscape.length).toBe(3);
      // First page (intro + screenshot) and the veto'd diagram stay portrait.
      expect(portrait.length).toBeGreaterThanOrEqual(2);
      expect(isLandscape(boxes[0])).toBe(false);

      // The veto'd diagram rendered on SOME portrait page and NO landscape
      // page — the actual invariant. (Asserting a specific page index breaks
      // spuriously when font metrics shift pagination.)
      const pdftotext = resolvePopplerTool("pdftotext")!;
      const pageText = (page: number) =>
        execFileSync(pdftotext, ["-f", String(page), "-l", String(page), outputPdf, "-"], {
          encoding: "utf8",
          timeout: CHILD_TIMEOUT_MS,
        });
      expect(portrait.some((b) => pageText(b.page).includes("vetoalpha"))).toBe(true);
      expect(landscape.some((b) => pageText(b.page).includes("vetoalpha"))).toBe(false);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  test.skipIf(!avail.ok)("--toc combo: TOC renders and landscape promotion survives", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-landscape-toc-");
    const outputPdf = path.join(workDir, "out.pdf");
    try {
      generate(["--toc"], outputPdf);
      const boxes = pageBoxes(outputPdf);
      expect(boxes.filter(isLandscape).length).toBe(3);

      const pdftotext = resolvePopplerTool("pdftotext")!;
      const text = execFileSync(pdftotext, [outputPdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      // TOC heading extracts uppercase (small-caps styling).
      expect(text.toUpperCase()).toContain("CONTENTS");
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  if (!avail.ok) {
    test("landscape gate prerequisites are present (hard-required in CI)", () => {
      if (process.env.CI) {
        throw new Error(`landscape gate prerequisites missing in CI: ${avail.reason}`);
      }
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
