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

// #2679: three skill-content mktemp sites ran unguarded. An empty result
// ("" on mktemp failure) silently disabled the redaction pass (redact-doc
// resolver + ship pr-body) and — the destructive one — made /gstack-upgrade's
// vendored path clone to "/gstack", fail the swap, then `rm -rf` BOTH the
// live install's backup and "". Guards must abort loudly; the upgrade block
// must also restore the backup when the swap fails (same failure class:
// backup deletion after a failed mv).
describe("#2679: skill-content mktemp guards", () => {
  test("redact-doc resolver guards REDACT_FILE=$(mktemp) with a loud exit", () => {
    // The guard line contains a ${sink.noun} interpolation in the resolver
    // source, so match to end-of-line rather than [^}]* (which stops at the
    // interpolation's closing brace).
    const body = readScript("scripts/resolvers/redact-doc.ts");
    expect(body).toMatch(/REDACT_FILE=\$\(mktemp\)\s*\|\|\s*\{.*exit 1/);
    // And the rendered output (interpolation resolved) carries the guard too.
    const rendered = readScript("spec/sections/gate-and-file.md");
    expect(rendered).toMatch(/REDACT_FILE=\$\(mktemp\)\s*\|\|\s*\{[^}]*exit 1/);
  });

  test("ship pr-body template guards PR_BODY_FILE=$(mktemp) with a loud exit", () => {
    const body = readScript("ship/sections/pr-body.md.tmpl");
    expect(body).toMatch(/PR_BODY_FILE=\$\(mktemp\)\s*\|\|\s*\{[^}]*exit 1/);
  });

  test("ship pr-body GitLab path sends the SCANNED file, never a re-rendered heredoc", () => {
    const body = readScript("ship/sections/pr-body.md.tmpl");
    expect(body).toContain('-d "$(cat "$PR_BODY_FILE")"');
    expect(body).not.toMatch(/glab mr create[^\n]*-d "\$\(cat <<'EOF'/);
  });

  test("gstack-upgrade vendored block guards mktemp -d and clone with loud aborts", () => {
    const body = readScript("gstack-upgrade/SKILL.md.tmpl");
    expect(body).toMatch(/TMP_DIR=\$\(mktemp -d\)\s*\|\|\s*\{[^}]*exit 1/);
    expect(body).toMatch(/git clone[^\n]*\|\|\s*\{[^}]*exit 1/);
  });

  test("gstack-upgrade vendored block restores the backup on a failed swap (no unconditional backup rm)", () => {
    const body = readScript("gstack-upgrade/SKILL.md.tmpl");
    expect(body).toMatch(/if mv "\$TMP_DIR\/gstack" "\$INSTALL_DIR"; then/);
    expect(body).toMatch(/mv "\$INSTALL_DIR\.bak" "\$INSTALL_DIR"/);
    // The backup rm must live inside the success branch, not after the block.
    const block = body.slice(body.indexOf('if mv "$TMP_DIR/gstack"'));
    const successRm = block.indexOf('rm -rf "$INSTALL_DIR.bak"');
    const elseBranch = block.indexOf("else");
    expect(successRm).toBeGreaterThan(-1);
    expect(successRm).toBeLessThan(elseBranch);
  });

  test("runtime: the guarded assignment aborts when mktemp fails", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const script = `mktemp() { return 1; }
TMP_DIR=$(mktemp -d) || { echo "ERROR: mktemp failed — aborting upgrade (install untouched)." >&2; exit 1; }
echo "SHOULD NOT REACH: $TMP_DIR"`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mktemp failed");
    expect(r.stdout).not.toContain("SHOULD NOT REACH");
  });

  test("runtime: gstack-redact --from-file '' errors loudly instead of falling through to stdin", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(
      "bun",
      [path.join(ROOT, "bin", "gstack-redact"), "--from-file", "", "--json"],
      { encoding: "utf-8", input: "placeholder stdin content (never read on the error path)", timeout: 15_000 },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("non-empty path");
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
