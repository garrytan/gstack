/**
 * Combined-features copy-paste gate — the P0 CI gate.
 *
 * This test runs the compiled `make-pdf/dist/pdf` binary against a fixture
 * that has every v1 typography feature on (smartypants, hyphens, chapter
 * breaks, bold/italic, inline code, blockquote, lists, headings). It then
 * pipes the output through pdftotext and asserts the extracted text
 * matches the handwritten expected.txt.
 *
 * Codex round 2 told us this (not per-feature gates) is the real gate a
 * user actually cares about — features interact, and the combined
 * extraction is what predicts production quality.
 *
 * Gating: only runs when the compiled binary + a browser (Aside or browse) + pdftotext
 * are all available. Skipped cleanly otherwise (local dev, CI runners).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { copyPasteGate, resolvePdftotext } from "../../src/pdftotext";
import { browserAvailable, NO_BROWSER_REASON } from "./browser-available";

const FIXTURE = path.resolve(__dirname, "../fixtures/combined-gate.md");
const EXPECTED = path.resolve(__dirname, "../fixtures/combined-gate.expected.txt");
const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  // Aside (macOS) or gstack's own browse binary (what CI builds) — a skip only when neither exists.
  if (!browserAvailable()) return { ok: false, reason: NO_BROWSER_REASON };
  if (!fs.existsSync(FIXTURE)) return { ok: false, reason: `fixture missing (${FIXTURE}).` };
  if (!fs.existsSync(EXPECTED)) return { ok: false, reason: `expected.txt missing (${EXPECTED}).` };
  try { resolvePdftotext(); } catch (err: any) { return { ok: false, reason: err.message }; }
  return { ok: true };
}

describe("combined-features copy-paste gate", () => {
  const avail = prerequisitesAvailable();

  test.skipIf(!avail.ok)("fixture PDF extracts cleanly through pdftotext", () => {
    if (!avail.ok) return; // satisfies the type checker
    const outputPdf = path.join(os.tmpdir(), `make-pdf-combined-gate-${process.pid}.pdf`);
    try {
      execFileSync(PDF_BIN, ["generate", FIXTURE, outputPdf, "--quiet"], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(fs.existsSync(outputPdf)).toBe(true);

      const expected = fs.readFileSync(EXPECTED, "utf8");
      const result = copyPasteGate(outputPdf, expected);
      if (!result.ok) {
        // Attach the extracted text so CI logs make the failure diagnosable
        process.stderr.write(`\n--- EXTRACTED ---\n${result.extracted}\n--- END ---\n\n`);
        process.stderr.write(`--- REASONS ---\n${result.reasons.join("\n")}\n--- END ---\n`);
      }
      expect(result.ok).toBe(true);
    } finally {
      try { fs.unlinkSync(outputPdf); } catch { /* ignore */ }
    }
  }, 60000);

  if (!avail.ok) {
    test("prerequisites check", () => {
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
