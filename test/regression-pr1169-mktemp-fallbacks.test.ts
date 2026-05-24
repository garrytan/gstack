/**
 * Regression tests for PR #1169 bugs #4 + #5 — predictable `$$`-based tmp
 * file fallbacks on mktemp failure.
 *
 * Per codex's pushback, the real invariant is not just "no `$$` token" — it's
 * "no `mktemp ... || echo <fallback-path>` shape at all, AND mktemp failure
 * exits cleanly." A future cleanup could swap `$$` for `$RANDOM` or a
 * hardcoded path and silently keep the foot-gun. The static checks below
 * lock the broader invariant.
 *
 * Runtime fake-bin tests for these two scripts would require setting up
 * SUPABASE_URL, JSONL fixtures, rate files, and config state — disproportionate
 * for the invariant. The static checks pin the actual shape of the bug.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function readScript(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("PR #1169 bug #4: gstack-telemetry-sync mktemp fallback", () => {
  const SCRIPT = "bin/gstack-telemetry-sync";

  test("no `mktemp ... || echo <path>` fallback shape anywhere in the script", () => {
    const body = readScript(SCRIPT);
    // Match: mktemp call, optional pipe, then `|| echo <quoted-or-bare-path>`
    // The fallback shape regardless of what the fallback path looks like
    // ($$, $RANDOM, hardcoded — all predictable).
    const fallback = body.match(/mktemp[^|\n]*\|\|\s*echo\s+["']?[^"'\n]*/);
    expect(fallback).toBeNull();
  });

  test("no `$$` PID interpolation appears anywhere in a /tmp path literal", () => {
    const body = readScript(SCRIPT);
    // Catches any /tmp-style path that uses the PID as part of the name.
    expect(body).not.toMatch(/\/tmp\/[^"'\s]*\$\$/);
  });

  test("mktemp failure path exits or skips this run", () => {
    const body = readScript(SCRIPT);
    // The mktemp invocation must be guarded by `|| { ... exit 0; }` or
    // equivalent. Match the multi-line guard immediately after `mktemp`.
    const guard = body.match(
      /mktemp\s+[^\n]+\)["']\s*\|\|\s*\{[^}]*exit\s+\d/
    );
    expect(guard).not.toBeNull();
  });

  test("trap cleans up the response file on EXIT (no leftover tmp on success)", () => {
    const body = readScript(SCRIPT);
    expect(body).toMatch(/trap\s+['"]rm\s+-f\s+"?\$RESP_FILE/);
  });
});

describe("PR #1169 bug #5: supabase/verify-rls.sh mktemp fallback", () => {
  const SCRIPT = "supabase/verify-rls.sh";

  test("no `mktemp ... || echo <path>` fallback shape", () => {
    const body = readScript(SCRIPT);
    const fallback = body.match(/mktemp[^|\n]*\|\|\s*echo\s+["']?[^"'\n]*/);
    expect(fallback).toBeNull();
  });

  test("no `$$` PID interpolation in /tmp path literals", () => {
    const body = readScript(SCRIPT);
    expect(body).not.toMatch(/\/tmp\/[^"'\s]*\$\$/);
  });

  test("mktemp failure path returns non-zero from check()", () => {
    const body = readScript(SCRIPT);
    // The check function must fail loudly — `return 1` (or `exit`) inside
    // the mktemp error handler. Same multi-line guard shape.
    const guard = body.match(
      /mktemp\s+[^\n]+\)["']\s*\|\|\s*\{[^}]*(?:return|exit)\s+\d/
    );
    expect(guard).not.toBeNull();
  });
});
