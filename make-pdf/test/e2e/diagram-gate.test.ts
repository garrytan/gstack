/**
 * Diagram render gate — proves the diagram pre-pass works end-to-end through
 * the compiled binary: mermaid fences render as vector SVG (not raw code),
 * multiple fences coexist (id-collision check), render=false keeps source,
 * a broken fence yields a visible diagnostic block, and a relative local
 * image actually renders (CRITICAL regression — pre-pass D1 fixed the
 * setContent/about:blank path where relative images silently 404'd).
 *
 * Oracles (per the emoji-gate lessons — text extraction alone lies):
 *   1. pdftotext: node labels from BOTH diagrams present (vector text made it
 *      into the PDF), diagnostic title present, raw mermaid only where
 *      render=false kept it.
 *   2. pdftoppm + saturated-pixel count: the red fixture image rasterizes to
 *      colored pixels — text extraction can't fake that.
 *
 * Free-tier deterministic gate: runs under plain `bun test` when the compiled
 * binaries + poppler are available; hard-fails in CI when missing.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePopplerTool } from "../../src/pdftotext";

const FIXTURE = path.resolve(__dirname, "../fixtures/diagram-gate.md");
const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");
const BROWSE_BIN = path.join(ROOT, "browse/dist/browse");
const BUNDLE = path.join(ROOT, "lib/diagram-render/dist/diagram-render.html");

const CHILD_TIMEOUT_MS = 60_000;
// The 80x40 red fixture image at 100dpi occupies ~80x40 px of strong red.
// Floor sits well below that but far above AA noise.
const SATURATED_PIXEL_FLOOR = 500;
const SATURATION_DELTA = 60;

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  if (!fs.existsSync(BROWSE_BIN)) return { ok: false, reason: `browse binary missing (${BROWSE_BIN}).` };
  if (!fs.existsSync(BUNDLE)) return { ok: false, reason: `diagram-render bundle missing (${BUNDLE}). Run bun run build:diagram-render.` };
  if (!fs.existsSync(FIXTURE)) return { ok: false, reason: `fixture missing (${FIXTURE}).` };
  if (!resolvePopplerTool("pdftotext")) return { ok: false, reason: "pdftotext not found (install poppler-utils)." };
  if (!resolvePopplerTool("pdftoppm")) return { ok: false, reason: "pdftoppm not found (install poppler-utils)." };
  return { ok: true };
}

function countSaturatedPixels(ppmPath: string, delta: number): number {
  const b = fs.readFileSync(ppmPath);
  let i = 0;
  const token = (): string => {
    while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x09 || b[i] === 0x0d)) i++;
    if (b[i] === 0x23) { while (i < b.length && b[i] !== 0x0a) i++; return token(); }
    const s = i;
    while (i < b.length && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x09 && b[i] !== 0x0d) i++;
    return b.slice(s, i).toString("ascii");
  };
  if (token() !== "P6") throw new Error("expected P6 PPM");
  const w = Number(token());
  const h = Number(token());
  if (Number(token()) !== 255) throw new Error("expected 8-bit PPM");
  i++;
  let sat = 0;
  for (let p = 0; p < w * h; p++) {
    const o = i + p * 3;
    if (Math.max(b[o], b[o + 1], b[o + 2]) - Math.min(b[o], b[o + 1], b[o + 2]) > delta) sat++;
  }
  return sat;
}

describe("diagram render gate", () => {
  const avail = prerequisitesAvailable();

  test.skipIf(!avail.ok)("mermaid fences render as vector diagrams; images and diagnostics behave", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-diagram-gate-");
    const outputPdf = path.join(workDir, "out.pdf");
    const ppmPrefix = path.join(workDir, "page");
    try {
      // No --quiet: stderr carries the downscale warning asserted below.
      const run = Bun.spawnSync([PDF_BIN, "generate", FIXTURE, outputPdf], {
        env: { ...process.env, BROWSE_BIN },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(run.stderr);
      if (run.exitCode !== 0) {
        throw new Error(`generate failed (exit ${run.exitCode}):\n${stderr}`);
      }
      expect(fs.existsSync(outputPdf)).toBe(true);

      // 0. Print-resolution downscale fired on the 4200px noise photo — this
      //    is the only live coverage of __downscaleRaster AND the chunked
      //    jsViaBuffer transport (the data URI exceeds the 100KB argv path).
      expect(stderr).toMatch(/downscaled huge-noise\.png 4200px → \d+px/);

      const pdftotext = resolvePopplerTool("pdftotext")!;
      const text = execFileSync(pdftotext, [outputPdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });

      // 1. Vector text from BOTH diagrams (multi-fence + id-collision check).
      //    The broken fence sits BETWEEN them in the fixture, so the second
      //    diagram rendering at all proves the reset contract (D6.2): the
      //    bundle page reloaded after the failure and kept working.
      for (const label of ["gatealphanode", "gatebetanode", "gategammanode", "gatedeltanode", "gateepsilonnode"]) {
        expect(text).toContain(label);
      }

      // 1b. The excalidraw fence rendered through exportToSvg (vector text
      //     from the scene file, plus its caption).
      expect(text).toContain("excalialphanode");
      expect(text).toContain("excalibetanode");
      expect(text).toContain("Converted flowchart");

      // 2. Rendered fences must NOT ship raw mermaid/scene JSON; render=false must.
      expect(text).not.toContain("GATEALPHA[");
      expect(text).not.toContain('"type":"excalidraw"');
      expect(text).toContain("RAWKEPT");
      expect(text).toContain("ASCODE");

      // 3. The broken fence produced a visible diagnostic, not silence.
      expect(text).toContain("Diagram failed to render (mermaid)");

      // 4. CRITICAL regression: the relative image rasterizes to color.
      const pdftoppm = resolvePopplerTool("pdftoppm")!;
      execFileSync(pdftoppm, ["-r", "100", "-f", "1", "-l", "1", "-singlefile", outputPdf, ppmPrefix], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      });
      const saturated = countSaturatedPixels(`${ppmPrefix}.ppm`, SATURATION_DELTA);
      if (saturated < SATURATED_PIXEL_FLOOR) {
        process.stderr.write(`\n[diagram-gate] saturated pixels: ${saturated} (floor ${SATURATED_PIXEL_FLOOR})\n`);
      }
      expect(saturated).toBeGreaterThanOrEqual(SATURATED_PIXEL_FLOOR);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  test.skipIf(!avail.ok)("--strict fails on a missing image with a non-zero exit", () => {
    if (!avail.ok) return;
    const workDir = fs.mkdtempSync("/tmp/make-pdf-diagram-strict-");
    const md = path.join(workDir, "doc.md");
    fs.writeFileSync(md, "# T\n\n![gone](./does-not-exist.png)\n");
    try {
      let failed = false;
      try {
        execFileSync(PDF_BIN, ["generate", md, path.join(workDir, "out.pdf"), "--quiet", "--strict"], {
          encoding: "utf8",
          env: { ...process.env, BROWSE_BIN },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: CHILD_TIMEOUT_MS,
        });
      } catch (err: any) {
        failed = true;
        const stderr = err.stderr?.toString() ?? "";
        expect(stderr).toContain("image not found");
      }
      expect(failed).toBe(true);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120000);

  if (!avail.ok) {
    test("diagram gate prerequisites are present (hard-required in CI)", () => {
      if (process.env.CI) {
        throw new Error(`diagram gate prerequisites missing in CI: ${avail.reason}`);
      }
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
