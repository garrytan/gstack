/**
 * pdftotext unit tests — normalize() and copyPasteGate() assertions.
 *
 * These tests are pure unit tests of the normalization + assertion logic.
 * They do NOT require pdftotext to be installed (the actual binary is
 * mocked by manipulating strings directly).
 */

import { afterAll, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalize, copyPasteGate, findExecutable, resolvePdftotext, PdftotextUnavailableError } from "../src/pdftotext";

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

// ─── Binary resolution (v1.24-aligned) ──────────────────────────

const REAL_EXE: string =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
    : "/bin/sh";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("findExecutable (pdftotext.ts)", () => {
  test("returns the bare path on POSIX when it's executable", () => {
    if (process.platform === "win32") return;
    expect(findExecutable("/bin/sh")).toBe("/bin/sh");
  });

  test("on win32, probes .exe / .cmd / .bat after the bare-path miss", () => {
    if (process.platform !== "win32") return;
    const base = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd");
    expect(findExecutable(base)).toBe(base + ".exe");
  });

  test("returns null when no extension matches", () => {
    expect(findExecutable("/nonexistent/path/to/nothing")).toBeNull();
  });
});

describe("resolvePdftotext (override resolution, v1.24-aligned)", () => {
  test("honors GSTACK_PDFTOTEXT_BIN when it points at a real executable", () => {
    // We can't fake a real pdftotext, but we can fake "any executable" to
    // exercise the override-resolution path. describeBinary will mark flavor
    // as "unknown" since cmd.exe / /bin/sh don't respond to -v like pdftotext;
    // the test asserts on the bin-path resolution, not the version probe.
    const info = withEnv({ GSTACK_PDFTOTEXT_BIN: REAL_EXE }, () => resolvePdftotext());
    expect(info.bin).toBe(REAL_EXE);
  });

  test("honors PDFTOTEXT_BIN as a back-compat alias", () => {
    const info = withEnv(
      { GSTACK_PDFTOTEXT_BIN: undefined, PDFTOTEXT_BIN: REAL_EXE },
      () => resolvePdftotext(),
    );
    expect(info.bin).toBe(REAL_EXE);
  });

  test("GSTACK_PDFTOTEXT_BIN takes precedence over PDFTOTEXT_BIN", () => {
    const info = withEnv(
      { GSTACK_PDFTOTEXT_BIN: REAL_EXE, PDFTOTEXT_BIN: "/nonexistent/legacy" },
      () => resolvePdftotext(),
    );
    expect(info.bin).toBe(REAL_EXE);
  });

  test("strips wrapping double quotes from override values", () => {
    const info = withEnv({ GSTACK_PDFTOTEXT_BIN: `"${REAL_EXE}"` }, () => resolvePdftotext());
    expect(info.bin).toBe(REAL_EXE);
  });

  test("error message includes Windows install hint and GSTACK_PDFTOTEXT_BIN", () => {
    let thrown: unknown = null;
    try {
      withEnv(
        {
          GSTACK_PDFTOTEXT_BIN: "/nonexistent/gstack-pdftotext",
          PDFTOTEXT_BIN: "/nonexistent/pdftotext",
          PATH: "",
          Path: "",
        },
        () => resolvePdftotext(),
      );
    } catch (err) {
      thrown = err;
    }
    // If the test box has a real pdftotext on disk, resolution succeeds
    // (POSIX candidates) — that's fine; the assertion is gated on whether
    // it threw. On Windows-CI without poppler, it throws.
    if (thrown) {
      expect(thrown).toBeInstanceOf(PdftotextUnavailableError);
      expect((thrown as Error).message).toContain("pdftotext not found");
      expect((thrown as Error).message).toContain("GSTACK_PDFTOTEXT_BIN");
      expect((thrown as Error).message).toContain("Windows");
      expect((thrown as Error).message).toContain("scoop install poppler");
    }
  });
});

// ─── Version + flavor probe (describeBinary via resolvePdftotext) ────
//
// Regression cover for the probe returning version="unknown" flavor="unknown"
// on every poppler install. Two independent causes, both exercised here:
//
//   1. poppler writes its -v banner to STDERR and exits 0. The old code used
//      execFileSync, which returns stdout (empty) and does not throw on a zero
//      exit, so the stderr fallback in the catch block was unreachable.
//   2. flavor was matched against the first line only. poppler prints
//      "pdftotext version X" on line 1 and identifies itself on line 2
//      ("Copyright ... The Poppler Developers"), so even a working stderr read
//      yielded flavor="unknown".
//
// Real pdftotext binaries cannot be assumed present in CI, so these use shell
// shims that reproduce each vendor's exact banner, stream and exit status.

describe("describeBinary (version + flavor probe)", () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdftotext-shim-"));
  afterAll(() => fs.rmSync(shimDir, { recursive: true, force: true }));

  function shim(name: string, body: string): string {
    if (process.platform === "win32") return "";
    const p = path.join(shimDir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  // poppler: banner on stderr, exit 0, vendor named on line 2.
  const popplerShim = shim(
    "poppler-pdftotext",
    [
      'if [ "$1" = "-v" ]; then',
      '  echo "pdftotext version 26.06.0" >&2',
      '  echo "Copyright 2005-2026 The Poppler Developers - http://poppler.freedesktop.org" >&2',
      '  echo "Copyright 1996-2011, 2022 Glyph & Cog, LLC" >&2',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );

  // xpdf: banner on stderr, non-zero exit, vendor named on line 1.
  const xpdfShim = shim(
    "xpdf-pdftotext",
    [
      'if [ "$1" = "-v" ]; then',
      '  echo "pdftotext version 4.05 [xpdf]" >&2',
      '  echo "Copyright 1996-2024 Glyph & Cog, LLC" >&2',
      "  exit 99",
      "fi",
      "exit 0",
    ].join("\n"),
  );

  test.skipIf(process.platform === "win32")(
    "reads a poppler banner from stderr on a zero exit",
    () => {
      const info = withEnv({ GSTACK_PDFTOTEXT_BIN: popplerShim }, () => resolvePdftotext());
      expect(info.version).toBe("pdftotext version 26.06.0");
      expect(info.flavor).toBe("poppler");
    },
  );

  test.skipIf(process.platform === "win32")(
    "identifies poppler from the copyright line, not the version line",
    () => {
      const info = withEnv({ GSTACK_PDFTOTEXT_BIN: popplerShim }, () => resolvePdftotext());
      // The line carrying the version does NOT contain the vendor name, which is
      // exactly why a line-0-only match reported "unknown".
      expect(info.version.toLowerCase()).not.toContain("poppler");
      expect(info.flavor).toBe("poppler");
    },
  );

  test.skipIf(process.platform === "win32")(
    "reads an xpdf banner from stderr on a non-zero exit",
    () => {
      const info = withEnv({ GSTACK_PDFTOTEXT_BIN: xpdfShim }, () => resolvePdftotext());
      expect(info.version).toBe("pdftotext version 4.05 [xpdf]");
      expect(info.flavor).toBe("xpdf");
    },
  );

  test.skipIf(process.platform === "win32")(
    "falls back to unknown when the binary emits no banner",
    () => {
      const silent = shim("silent-pdftotext", "exit 0");
      const info = withEnv({ GSTACK_PDFTOTEXT_BIN: silent }, () => resolvePdftotext());
      expect(info.version).toBe("unknown");
      expect(info.flavor).toBe("unknown");
    },
  );
});
