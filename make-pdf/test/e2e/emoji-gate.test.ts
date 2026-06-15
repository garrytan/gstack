/**
 * Emoji render gate — proves emoji code points render as real color glyphs in
 * the output PDF instead of .notdef tofu boxes (▯). This is the regression gate
 * for fix/make-pdf-emoji-tofu.
 *
 * Why not just check pdftotext? Because text extraction is a FALSE oracle for
 * emoji: Skia preserves the Unicode in the text cluster even when the displayed
 * glyph is .notdef, so pdftotext can report the emoji survived on a render that
 * actually drew tofu. Verified empirically on macOS — pdftotext extracts 😀
 * regardless of whether a color font was available.
 *
 * Two assertions that DO distinguish a real render from tofu:
 *   1. pdffonts shows an emoji family embedded in the PDF (the cascade selected
 *      a real emoji font — AppleColorEmoji as Type 3 on macOS, NotoColorEmoji
 *      on Linux). Missing-fallback => no emoji font embedded.
 *   2. pdftoppm rasterizes the page and we count saturated (colored) pixels.
 *      A color-emoji render has hundreds (measured: ~1650 at 100dpi); a tofu
 *      render is a monochrome black outline on white (~0 saturated). Tolerant
 *      threshold, not an exact-pixel fixture diff, to dodge cross-platform AA
 *      and font-version variance.
 *
 * Note: pdfimages -list is intentionally NOT used — macOS embeds color emoji as
 * Type 3 fonts, so pdfimages lists nothing even on a correct render.
 *
 * Gating: runs only when the compiled binary + browse + pdffonts + pdftoppm are
 * available AND a color-emoji font is installed for Chromium to fall back to.
 * In CI (process.env.CI set) missing prerequisites are a HARD FAILURE, not a
 * skip — CI is expected to install poppler-utils + fonts-noto-color-emoji, so a
 * silent skip there would let the tofu regression ship behind a green build.
 * Local dev without those tools skips cleanly.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePopplerTool } from "../../src/pdftotext";

const FIXTURE = path.resolve(__dirname, "../fixtures/emoji-gate.md");
const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");
const BROWSE_BIN = path.join(ROOT, "browse/dist/browse");

// Saturated-pixel floor. Measured ~1650 at 100dpi for the fixture's color
// emoji; a tofu render yields ~0. 200 sits well clear of both.
const SATURATED_PIXEL_FLOOR = 200;
// A pixel is "colored" when its max-min channel spread exceeds this. Black text,
// gray rules, and white background all stay near 0; color emoji spike high.
const SATURATION_DELTA = 40;
// Per-child wall-clock bound. Bun's test timeout doesn't reliably interrupt a
// synchronous execFileSync, so each child gets its own ceiling — a wedged
// browser/poppler binary (or a hostile GSTACK_*_BIN override) fails instead of
// hanging the whole job.
const CHILD_TIMEOUT_MS = 25_000;

/** Is a color-emoji font available for Chromium to fall back to? */
function emojiFontAvailable(): boolean {
  if (process.platform === "darwin") {
    return fs.existsSync("/System/Library/Fonts/Apple Color Emoji.ttc");
  }
  if (process.platform === "linux") {
    const fcMatch = Bun.which("fc-match");
    if (!fcMatch) return false;
    try {
      const out = execFileSync(
        fcMatch,
        ["-f", "%{color}\n", ":lang=und-zsye:charset=1F600"],
        { encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
      );
      return /true/i.test(out);
    } catch {
      return false;
    }
  }
  return false;
}

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  if (!fs.existsSync(BROWSE_BIN)) return { ok: false, reason: `browse binary missing (${BROWSE_BIN}).` };
  if (!fs.existsSync(FIXTURE)) return { ok: false, reason: `fixture missing (${FIXTURE}).` };
  if (!resolvePopplerTool("pdffonts")) return { ok: false, reason: "pdffonts not found (install poppler-utils)." };
  if (!resolvePopplerTool("pdftoppm")) return { ok: false, reason: "pdftoppm not found (install poppler-utils)." };
  if (!emojiFontAvailable()) return { ok: false, reason: "no color-emoji font installed; run ./setup (Linux) or install one." };
  return { ok: true };
}

/**
 * Count pixels in a P6 (binary) PPM whose RGB channel spread exceeds delta.
 * Validates the header and buffer length so malformed/variant output is a hard
 * diagnostic (thrown), never a silently-wrong count.
 */
function countSaturatedPixels(ppmPath: string, delta: number): number {
  const b = fs.readFileSync(ppmPath);
  let i = 0;
  const skipWhitespaceAndComments = () => {
    for (;;) {
      while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x09 || b[i] === 0x0d)) i++;
      if (b[i] === 0x23) { // '#': comment runs to end of line
        while (i < b.length && b[i] !== 0x0a) i++;
        continue;
      }
      break;
    }
  };
  const token = (): string => {
    skipWhitespaceAndComments();
    const s = i;
    while (i < b.length && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x09 && b[i] !== 0x0d) i++;
    return b.slice(s, i).toString("ascii");
  };
  const magic = token();
  if (magic !== "P6") throw new Error(`expected P6 PPM, got "${magic}"`);
  const w = Number(token());
  const h = Number(token());
  const maxval = Number(token());
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(`invalid PPM dimensions: ${w}x${h}`);
  }
  if (maxval !== 255) {
    // pdftoppm emits 8-bit P6 (maxval 255). 16-bit would be 2 bytes/channel and
    // would break the byte math below — fail loudly rather than miscount.
    throw new Error(`unexpected PPM maxval ${maxval} (expected 255)`);
  }
  i++; // single whitespace byte after maxval precedes the pixel block
  const total = w * h;
  if (b.length - i < total * 3) {
    throw new Error(`PPM pixel buffer too short: have ${b.length - i}, need ${total * 3}`);
  }
  let sat = 0;
  for (let p = 0; p < total; p++) {
    const o = i + p * 3;
    const r = b[o], g = b[o + 1], bl = b[o + 2];
    if (Math.max(r, g, bl) - Math.min(r, g, bl) > delta) sat++;
  }
  return sat;
}

describe("emoji render gate", () => {
  const avail = prerequisitesAvailable();

  test.skipIf(!avail.ok)("emoji render as color glyphs, not tofu", () => {
    if (!avail.ok) return; // type narrowing
    // Private temp dir under /tmp: browse's validateOutputPath only allows
    // /tmp and /private/tmp (not os.tmpdir()'s /var/folders), and mkdtemp
    // dodges the predictable-path symlink/collision risk.
    const workDir = fs.mkdtempSync("/tmp/make-pdf-emoji-gate-");
    const outputPdf = path.join(workDir, "out.pdf");
    const ppmPrefix = path.join(workDir, "page");
    const ppmPath = `${ppmPrefix}.ppm`;
    try {
      execFileSync(PDF_BIN, ["generate", FIXTURE, outputPdf, "--quiet"], {
        encoding: "utf8",
        env: { ...process.env, BROWSE_BIN },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      });
      expect(fs.existsSync(outputPdf)).toBe(true);

      // 1. An emoji family must be embedded — the cascade found a real emoji
      //    font instead of falling through to .notdef.
      const pdffonts = resolvePopplerTool("pdffonts")!;
      const fontList = execFileSync(pdffonts, [outputPdf], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      if (!/emoji/i.test(fontList)) {
        process.stderr.write(`\n--- pdffonts ---\n${fontList}\n--- END ---\n`);
      }
      expect(/emoji/i.test(fontList)).toBe(true);

      // 2. The page must actually rasterize to color, not a monochrome tofu box.
      const pdftoppm = resolvePopplerTool("pdftoppm")!;
      execFileSync(pdftoppm, ["-r", "100", "-singlefile", outputPdf, ppmPrefix], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      });
      expect(fs.existsSync(ppmPath)).toBe(true);
      const saturated = countSaturatedPixels(ppmPath, SATURATION_DELTA);
      if (saturated < SATURATED_PIXEL_FLOOR) {
        process.stderr.write(`\n[emoji-gate] saturated pixels: ${saturated} (floor ${SATURATED_PIXEL_FLOOR})\n`);
      }
      expect(saturated).toBeGreaterThanOrEqual(SATURATED_PIXEL_FLOOR);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60000);

  if (!avail.ok) {
    // In CI, missing prerequisites are a hard failure — a silent skip would let
    // the Linux tofu regression ship behind a green build. Locally, just warn.
    test("emoji gate prerequisites are present (hard-required in CI)", () => {
      if (process.env.CI) {
        throw new Error(`emoji gate prerequisites missing in CI: ${avail.reason}`);
      }
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
