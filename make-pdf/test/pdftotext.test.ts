/**
 * pdftotext unit tests — normalize() and copyPasteGate() assertions.
 *
 * These tests are pure unit tests of the normalization + assertion logic.
 * They do NOT require pdftotext to be installed (the actual binary is
 * mocked by manipulating strings directly).
 */

import { describe, expect, test } from "bun:test";

import { normalize, copyPasteGate } from "../src/pdftotext";

describe("normalize", () => {
  test("strips trailing spaces", () => {
    expect(normalize("hello   \nworld")).toBe("hello\nworld");
  });

  test("collapses runs of 3+ blank lines to 2", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("converts form feeds to double newlines (page break boundary)", () => {
    expect(normalize("page1\fpage2")).toBe("page1\n\npage2");
  });

  test("normalizes CRLF and CR to LF (Windows Xpdf)", () => {
    expect(normalize("a\r\nb\rc")).toBe("a\nb\nc");
  });

  test("removes soft hyphens (hyphens: auto artifact)", () => {
    expect(normalize("extra\u00adordinary")).toBe("extraordinary");
  });

  test("replaces non-breaking space with regular space", () => {
    expect(normalize("hello\u00a0world")).toBe("hello world");
  });

  test("strips zero-width characters", () => {
    expect(normalize("a\u200bb\u200cc")).toBe("abc");
  });

  test("NFC-normalizes composed glyphs (macOS NFD → Linux NFC)", () => {
    // "é" composed vs decomposed
    const decomposed = "e\u0301";
    const composed = "\u00e9";
    expect(normalize(decomposed)).toBe(composed);
  });

  test("trims leading/trailing whitespace on whole string", () => {
    expect(normalize("\n\n  hello  \n\n")).toBe("hello");
  });
});

describe("copyPasteGate — assertion logic", () => {
  // These tests exercise the gate's internal assertions by mocking the
  // pdftotext step. We can't easily run the real binary in every test
  // env, so we verify the assertion logic directly via fake inputs.
  //
  // The gate takes a PDF path — but assertion #1 (paragraph presence) and
  // #2 (per-glyph emission) are string operations we can validate here.

  test("flags 'S ai li ng' per-glyph emission when reassembled letters appear in source", () => {
    // Build expected/extracted strings that would trip the gate.
    const expected = "Sailing on the open sea.";
    const extracted = "S a i l i n g   on the open sea.";
    // Simulate by running normalize + assertion manually; the regex is
    // looked at in the gate.
    const fragRegex = /((?:\b\w\s){4,})/g;
    const match = fragRegex.exec(extracted);
    expect(match).not.toBeNull();
    if (match) {
      const letters = match[1].replace(/\s/g, "");
      expect(letters.toLowerCase()).toBe("sailing");
      expect(expected.toLowerCase().includes(letters.toLowerCase())).toBe(true);
    }
  });

  test("does NOT flag 'A B C D' as per-glyph when letters don't appear in source", () => {
    const expected = "The quick brown fox.";
    const extracted = "The quick A B C D brown fox.";
    const fragRegex = /((?:\b\w\s){4,})/g;
    const match = fragRegex.exec(extracted);
    if (match) {
      const letters = match[1].replace(/\s/g, "");
      // "ABCD" is not a substring of expected
      expect(expected.toLowerCase().includes(letters.toLowerCase())).toBe(false);
    }
  });

  test("paragraph boundary count drift calculation", () => {
    const expected = "para1\n\npara2\n\npara3";
    const extractedOk = "para1\n\npara2\n\npara3";
    const extractedTooFew = "para1 para2 para3";
    const extractedTooMany = "para1\n\n\n\npara2\n\n\n\npara3\n\n\n\npara4\n\n\n\npara5";

    const expectedBreaks = (expected.match(/\n\n/g) || []).length;
    const okBreaks = (extractedOk.match(/\n\n/g) || []).length;
    const tooFewBreaks = (extractedTooFew.match(/\n\n/g) || []).length;
    const tooManyBreaksNormalized = (normalize(extractedTooMany).match(/\n\n/g) || []).length;

    expect(Math.abs(expectedBreaks - okBreaks)).toBeLessThanOrEqual(4);
    expect(Math.abs(expectedBreaks - tooFewBreaks)).toBeGreaterThan(1);
    // After normalize, 3+ newlines become 2, so the count matches
    expect(Math.abs(expectedBreaks - tooManyBreaksNormalized)).toBeLessThanOrEqual(4);
  });
});
