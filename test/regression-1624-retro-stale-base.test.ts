/**
 * Regression tests for #1624 — /retro silently produced empty/misleading
 * output when "today" anchor was wrong or origin/<default> was stale.
 *
 * The guard survived the retro token-reduction wave in two halves:
 *   - LOCAL checks (remote present? detached HEAD? newest commit date on the
 *     analyzed ref) live in bin/gstack-retro-metrics, emitted as
 *     GUARD_REMOTE / GUARD_HEAD / GUARD_LATEST_COMMIT lines.
 *   - The FETCH (network op — kept in skill prose, never in the script) and
 *     the ordered skip/BLOCK decision rules live in retro/SKILL.md.tmpl
 *     (Step 0.5 fetch fence + Step 1 guard prose).
 *
 * These static invariants fail the build if the guard is removed, weakened,
 * or its ordering broken:
 *   1. no-remote skip          — script emits GUARD_REMOTE: none
 *   2. detached-HEAD skip      — script emits GUARD_HEAD: detached
 *   3. fetch-fail warn         — Step 0.5 fence discloses and proceeds
 *   4. stale-base BLOCK        — fetch ok + latest commit older than window
 *
 * Skip paths must carry a disclosure into the narrative; BLOCK must cite the
 * date and the remediation. Behavioral coverage of the script's guard
 * emissions lives in test/gstack-retro-metrics.test.ts.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RETRO_TMPL = path.join(ROOT, "retro", "SKILL.md.tmpl");
const METRICS_SCRIPT = path.join(ROOT, "bin", "gstack-retro-metrics");

function readTmpl(): string {
  return fs.readFileSync(RETRO_TMPL, "utf-8");
}

function readScript(): string {
  return fs.readFileSync(METRICS_SCRIPT, "utf-8");
}

describe("#1624 retro stale-base guard — pre-flight ordered before analysis", () => {
  test("Step 0.5 fetch pre-flight is present and precedes Step 1", () => {
    const body = readTmpl();
    const step05 = body.indexOf("### Step 0.5:");
    const step1 = body.indexOf("### Step 1: Gather");
    expect(step05).toBeGreaterThan(-1);
    expect(step1).toBeGreaterThan(-1);
    expect(step05).toBeLessThan(step1);
  });

  test("guard evaluation prose sits in Step 1 before the metric interpretation steps", () => {
    const body = readTmpl();
    const guard = body.indexOf("Stale-base + bad-today-anchor guard");
    const step2 = body.indexOf("### Step 2: Compute Metrics");
    expect(guard).toBeGreaterThan(-1);
    expect(step2).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(step2);
  });
});

describe("#1624 retro guard — branch A: no-remote skip", () => {
  test("script checks for 'origin' remote absence and emits GUARD_REMOTE", () => {
    const script = readScript();
    expect(script).toMatch(/git remote[^|]*\|\s*grep -c '\^origin\$'/);
    expect(script).toContain("GUARD_REMOTE: none");
    expect(script).toContain("GUARD_REMOTE: origin");
  });

  test("template prose treats GUARD_REMOTE: none as proceed-with-disclosure", () => {
    const body = readTmpl();
    expect(body).toMatch(/GUARD_REMOTE: none/);
  });
});

describe("#1624 retro guard — branch B: detached-HEAD skip", () => {
  test("script checks for detached HEAD via git symbolic-ref and emits GUARD_HEAD", () => {
    const script = readScript();
    expect(script).toMatch(/git symbolic-ref --quiet --short HEAD/);
    expect(script).toContain("GUARD_HEAD: detached");
  });

  test("template prose treats GUARD_HEAD: detached as proceed-with-disclosure", () => {
    const body = readTmpl();
    expect(body).toMatch(/GUARD_HEAD: detached/);
  });
});

describe("#1624 retro guard — branch C: fetch-fail warn", () => {
  test("fetch stays in skill prose (never in the script) and warns on failure", () => {
    const body = readTmpl();
    expect(body).toMatch(/git fetch origin <default> --quiet/);
    expect(body).toMatch(/RETRO_FETCH: failed[^\n]*offline/);
    // The script must stay local-reads-only: no fetch/pull/push/clone.
    const script = readScript();
    expect(script).not.toMatch(/(^|[;|&`($!]|\s)git(\s+-C\s+\S+)?\s+(push|pull|fetch|clone|ls-remote)\b/m);
  });

  test("fetch failure downgrades BLOCK to proceed (ordering)", () => {
    const body = readTmpl();
    // Rule 1 (skip paths incl. fetch-fail) must be evaluated before rule 2
    // (BLOCK), and BLOCK must be conditioned on the fetch having succeeded.
    const skipRule = body.indexOf("the Step 0.5 fetch failed");
    const blockRule = body.indexOf("Retro window is stale");
    expect(skipRule).toBeGreaterThan(-1);
    expect(blockRule).toBeGreaterThan(-1);
    expect(skipRule).toBeLessThan(blockRule);
    expect(body).toMatch(/fetch succeeded AND/);
  });
});

describe("#1624 retro guard — branch D: stale-base BLOCK", () => {
  test("script extracts the latest analyzed-ref commit date via git log -1 --format=%ci", () => {
    const script = readScript();
    expect(script).toMatch(/git log -1 --format=%ci/);
    expect(script).toContain("GUARD_LATEST_COMMIT:");
  });

  test("BLOCK prose names latest-commit date and instructs user remediation", () => {
    const body = readTmpl();
    expect(body).toMatch(/Retro window is stale/);
    expect(body).toMatch(/git fetch origin <default>/);
    expect(body).toMatch(/Confirm today's date/);
  });

  test("today comes from the session reminder, never the system clock", () => {
    const body = readTmpl();
    expect(body).toMatch(/session reminder/);
    expect(body).toMatch(/NEVER from `date`/);
  });
});

describe("#1624 retro guard — disclosure must reach the narrative", () => {
  test("skip paths carry a disclosure line into the retro output", () => {
    const body = readTmpl();
    // The prose ties disclosure + narrative together so the retro output is
    // never silently confidently-wrong on offline/local-only runs.
    expect(body).toMatch(/offline run, window not freshness-verified/);
    expect(body).toMatch(/(?:disclosure[\s\S]{0,200}narrative|narrative[\s\S]{0,200}disclosure)/);
  });

  test("non-default analyzed ref is disclosed (RETRO_REF)", () => {
    const body = readTmpl();
    expect(body).toMatch(/RETRO_REF/);
    const script = readScript();
    expect(script).toContain("RETRO_REF:");
  });
});
