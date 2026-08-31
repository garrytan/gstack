/**
 * design/src/flag-utils.ts — integer-flag contract (#2032, eng-review 7A/8A).
 *
 * Lives under test/ (NOT design/test/) deliberately: design/test/ is invisible
 * to the bun test glob, scripts/test-free-shards TEST_ROOTS, and every CI
 * workflow (eng-review 11A), so a tripwire there guards nothing. flag-utils is
 * a pure module, so importing it from here is clean.
 *
 * The bug class: the design CLI parser yields string | true | undefined;
 * parseInt produced NaN that flowed silently into loop bounds and setTimeout —
 * `variants --count abc` generated ZERO variants and exited 0, `generate
 * --retry abc` was a silent no-op, `serve --timeout abc` died at boot.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import { parseIntFlag } from "../design/src/flag-utils";

const ROOT = path.resolve(import.meta.dir, "..");

const COUNT_SPEC = { name: "count", def: 3, min: 1, max: 7 } as const;
const RETRY_SPEC = { name: "retry", def: 0, min: 0 } as const;
const TIMEOUT_SPEC = { name: "timeout", def: 600, min: 1 } as const;

describe("parseIntFlag contract (#2032, codex 17a-c)", () => {
  test("undefined → default (flag absent)", () => {
    expect(parseIntFlag(undefined, COUNT_SPEC)).toEqual({ ok: true, value: 3 });
    expect(parseIntFlag(undefined, RETRY_SPEC)).toEqual({ ok: true, value: 0 });
  });

  test("non-numeric string → error, never a silent default ('--count abc')", () => {
    const r = parseIntFlag("abc", COUNT_SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"abc" is not an integer');
  });

  test("bare flag (parser yields true) → error 'requires a value'", () => {
    const r = parseIntFlag(true, COUNT_SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("requires a value");
  });

  test("empty string → error 'requires a value'", () => {
    const r = parseIntFlag("", COUNT_SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("requires a value");
  });

  test("non-integer '3.7' → error (rejected, not silently truncated to 3)", () => {
    const r = parseIntFlag("3.7", COUNT_SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not an integer");
  });

  test("below min → error ('--count 0' billed the user for 1 they asked 0 of; now loud)", () => {
    expect(parseIntFlag("0", COUNT_SPEC).ok).toBe(false);
    expect(parseIntFlag("-2", COUNT_SPEC).ok).toBe(false);
    // retry allows 0 (min: 0)
    expect(parseIntFlag("0", RETRY_SPEC)).toEqual({ ok: true, value: 0 });
  });

  test("above max → clamp WITH warning (capability limit, not a user mistake)", () => {
    const r = parseIntFlag("99", COUNT_SPEC);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(7);
      expect(r.warning).toContain("exceeds the maximum");
    }
  });

  test("in-range integers pass through untouched", () => {
    expect(parseIntFlag("3", COUNT_SPEC)).toEqual({ ok: true, value: 3 });
    expect(parseIntFlag(5, COUNT_SPEC)).toEqual({ ok: true, value: 5 });
    expect(parseIntFlag("120", TIMEOUT_SPEC)).toEqual({ ok: true, value: 120 });
  });

  test("retry-NaN and timeout-NaN are errors, not silent no-ops (#2032 siblings)", () => {
    // Pre-fix: --retry abc → generate() loop never ran (attempt <= NaN),
    // printed null, exited 0. --timeout abc → setTimeout(NaN) ≈ immediate
    // SERVE_TIMEOUT. Both members of the same NaN class, same file.
    expect(parseIntFlag("abc", RETRY_SPEC).ok).toBe(false);
    expect(parseIntFlag("abc", TIMEOUT_SPEC).ok).toBe(false);
  });

  test("NaN number input (legacy pre-parsed callers) → error", () => {
    expect(parseIntFlag(Number.NaN, COUNT_SPEC).ok).toBe(false);
  });
});

describe("normalizeIntFlag CLI wrapper (exit-1 semantics)", () => {
  function runWrapper(rawExpr: string, specExpr: string): { status: number; stderr: string } {
    // Forward slashes: a raw Windows ROOT embeds backslashes into the eval
    // string where they act as ESCAPES ("D:\\a\\gstack" imports as
    // "D:agstack" — first Windows lane run). Import specifiers accept
    // forward slashes on every platform.
    const script = `
      import { normalizeIntFlag } from "${ROOT.replaceAll('\\', '/')}/design/src/flag-utils";
      const v = normalizeIntFlag(${rawExpr}, ${specExpr});
      console.log("VALUE:" + v);
    `;
    const res = spawnSync("bun", ["-e", script], { encoding: "utf-8", cwd: ROOT });
    return { status: res.status ?? -1, stderr: res.stderr ?? "" };
  }

  test("invalid input exits 1 with the error on stderr", () => {
    const r = runWrapper('"abc"', '{ name: "count", def: 3, min: 1, max: 7 }');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not an integer");
  });

  test("clamp warns on stderr but exits 0", () => {
    const r = runWrapper('"99"', '{ name: "count", def: 3, min: 1, max: 7 }');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("exceeds the maximum");
  });
});
