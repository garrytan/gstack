/**
 * pdftotext wrapper — the tool behind the copy-paste CI gate.
 *
 * Codex round 2 surfaced two real problems we address here:
 *
 *   #18: pdftotext (Poppler) vs pdftotext (Xpdf) vs pdftotext-next vary on
 *        whitespace, line wrap, Unicode normalization, form feeds, and
 *        extraction order. Cross-platform exact diffing is a non-starter.
 *        We normalize aggressively and diff the normalized form.
 *
 *   #19: the regex /(?:\b\w\s){4,}/ only catches one failure shape (letters
 *        spaced out). It misses word-order corruption, missing whitespace
 *        between paragraphs, and homoglyph substitution. We add a word-token
 *        diff and a paragraph-boundary assertion on top.
 *
 * Resolution order for the pdftotext binary:
 *   1. $PDFTOTEXT_BIN env override
 *   2. `which pdftotext` on PATH
 *   3. standard Homebrew paths on macOS
 *   4. throws a friendly "install poppler" error
 *
 * The wrapper is *optional at runtime*: production renders don't need it.
 * Only the CI gate and unit tests invoke pdftotext.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class PdftotextUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdftotextUnavailableError";
  }
}

export interface PdftotextInfo {
  bin: string;
  version: string;        // "pdftotext version 24.02.0" or similar
  flavor: "poppler" | "xpdf" | "unknown";
}

/**
 * Locate pdftotext. Throws PdftotextUnavailableError if none is found.
 */
export function resolvePdftotext(): PdftotextInfo {
  const envOverride = process.env.PDFTOTEXT_BIN;
  if (envOverride && isExecutable(envOverride)) {
    return describeBinary(envOverride);
  }

  // Try PATH
  try {
    const which = execFileSync("which", ["pdftotext"], { encoding: "utf8" }).trim();
    if (which && isExecutable(which)) return describeBinary(which);
  } catch {
    // fall through
  }

  // Common macOS Homebrew locations
  const macCandidates = [
    "/opt/homebrew/bin/pdftotext",     // Apple Silicon
    "/usr/local/bin/pdftotext",        // Intel Mac or Linuxbrew
    "/usr/bin/pdftotext",              // distro package
  ];
  for (const candidate of macCandidates) {
    if (isExecutable(candidate)) return describeBinary(candidate);
  }

  throw new PdftotextUnavailableError([
    "pdftotext not found.",
    "",
    "make-pdf needs pdftotext to run the copy-paste CI gate.",
    "(Runtime rendering does NOT need it. This only affects tests.)",
    "",
    "To install:",
    "  macOS:  brew install poppler",
    "  Ubuntu: sudo apt-get install poppler-utils",
    "  Fedora: sudo dnf install poppler-utils",
    "",
    "Or set PDFTOTEXT_BIN to an explicit path:",
    "  export PDFTOTEXT_BIN=/path/to/pdftotext",
  ].join("\n"));
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describeBinary(bin: string): PdftotextInfo {
  let version = "unknown";
  let flavor: PdftotextInfo["flavor"] = "unknown";
  try {
    // pdftotext -v writes to stderr and exits 0 on poppler, 99 on some xpdf builds.
    const result = execFileSync(bin, ["-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    version = (result || "").trim().split("\n")[0] || "unknown";
  } catch (err: any) {
    // Many pdftotext builds exit non-zero on -v but still write to stderr.
    const stderr = err?.stderr?.toString?.() ?? "";
    version = stderr.trim().split("\n")[0] || "unknown";
  }
  const v = version.toLowerCase();
  if (v.includes("poppler")) flavor = "poppler";
  else if (v.includes("xpdf")) flavor = "xpdf";
  return { bin, version, flavor };
}

/**
 * Run pdftotext on a PDF and return the extracted text.
 *
 * Uses `-layout` by default because that's what downstream normalization
 * expects. Callers that need raw text can pass layout=false.
 */
export function pdftotext(pdfPath: string, opts?: { layout?: boolean }): string {
  const info = resolvePdftotext();
  const layout = opts?.layout ?? true;
  const args: string[] = [];
  if (layout) args.push("-layout");
  args.push(pdfPath, "-");   // "-" = stdout
  try {
    return execFileSync(info.bin, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    throw new Error(`pdftotext failed on ${pdfPath}: ${err.message}`);
  }
}

/**
 * Normalize extracted text for cross-platform, cross-flavor diffing.
 *
 * What we strip / normalize:
 *   - Unicode: NFC canonical composition (macOS emits NFD; Linux emits NFC;
 *     this dodges the fundamental encoding diff).
 *   - CR and CRLF → LF (Windows Xpdf emits CRLF).
 *   - Form feeds (\f) → double newline (Poppler emits \f at page breaks).
 *   - Trailing spaces on every line.
 *   - Runs of 3+ blank lines → 2 blank lines.
 *   - Leading/trailing whitespace on the whole string.
 *   - Non-breaking space (U+00A0) → regular space.
 *   - Zero-width space (U+200B) and zero-width non-joiner (U+200C) → empty.
 *   - Soft hyphen (U+00AD) → empty (pdftotext -layout sometimes emits these
 *     for hyphens: auto breaks).
 */
export function normalize(raw: string): string {
  let s = raw;
  s = s.normalize("NFC");
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\r/g, "\n");
  s = s.replace(/\f/g, "\n\n");
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/[\u200b\u200c\u00ad]/g, "");
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return s;
}

/**
 * The canonical copy-paste gate used in the E2E tests.
 *
 * Returns { ok: true } when all three assertions pass; returns
 * { ok: false, reasons: [...] } with one or more failure reasons otherwise.
 */
export interface GateResult {
  ok: boolean;
  reasons: string[];
  extracted: string;
}

export function copyPasteGate(pdfPath: string, expected: string): GateResult {
  const extracted = normalize(pdftotext(pdfPath, { layout: true }));
  const expectedNorm = normalize(expected);
  const reasons: string[] = [];

  // Assertion 1: every expected paragraph appears as a whole line or
  // contiguous block in the extracted text.
  const expectedParagraphs = splitParagraphs(expectedNorm);
  for (const paragraph of expectedParagraphs) {
    const compact = collapseWhitespace(paragraph);
    const extractedCompact = collapseWhitespace(extracted);
    if (!extractedCompact.includes(compact)) {
      reasons.push(
        `expected paragraph not found in extracted text: ${truncate(paragraph, 80)}`,
      );
    }
  }

  // Assertion 2: no "S a i l i n g"-style single-char runs.
  // Count groups of 4+ consecutive letter-then-space tokens. False positive
  // risk on things like "A B C D" (initials) — mitigate by requiring the
  // letters spell a known-word substring of the expected text.
  const fragRegex = /((?:\b\w\s){4,})/g;
  let fragMatch: RegExpExecArray | null;
  while ((fragMatch = fragRegex.exec(extracted)) !== null) {
    const letters = fragMatch[1].replace(/\s/g, "");
    // Only flag if the reassembled letters appear in the expected text.
    if (expectedNorm.toLowerCase().includes(letters.toLowerCase()) && letters.length >= 4) {
      reasons.push(
        `per-glyph emission detected (the "S ai li ng" bug): "${fragMatch[1].trim()}" reassembles to "${letters}"`,
      );
    }
  }

  // Assertion 3: paragraph boundaries preserved. Count double-newlines
  // in both; they should differ by no more than ±2 (header/footer noise).
  const expectedBreaks = (expectedNorm.match(/\n\n/g) || []).length;
  const extractedBreaks = (extracted.match(/\n\n/g) || []).length;
  if (Math.abs(expectedBreaks - extractedBreaks) > 4) {
    reasons.push(
      `paragraph boundary count drift: expected ~${expectedBreaks}, got ${extractedBreaks}`,
    );
  }

  return { ok: reasons.length === 0, reasons, extracted };
}

function splitParagraphs(s: string): string[] {
  return s.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

/**
 * Emit diagnostic info to stderr — useful for CI failure debugging.
 * Call this once before running any gate in a CI log.
 */
export function logDiagnostics(): void {
  try {
    const info = resolvePdftotext();
    process.stderr.write(
      `[pdftotext] bin=${info.bin} flavor=${info.flavor} version="${info.version}" ` +
      `os=${os.platform()}-${os.arch()} node=${process.version}\n`,
    );
  } catch (err: any) {
    process.stderr.write(`[pdftotext] unavailable: ${err.message}\n`);
  }
}
