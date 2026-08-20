/**
 * Regression tests for #1624 — /retro silently produced empty/misleading
 * output when "today" anchor was wrong or origin/<default> was stale.
 *
 * The fix is Step 0.5 in retro/SKILL.md.tmpl: four ordered pre-check
 * branches before any window analysis. These tests are static invariants
 * against the template body — they fail the build if the guard is removed,
 * weakened, or its ordering broken.
 *
 * Branches under test:
 *   1. no-remote skip          — git remote returns empty
 *   2. detached-HEAD skip      — git symbolic-ref --quiet HEAD returns empty
 *   3. fetch-fail warn         — git fetch origin <default> exits non-zero
 *   4. stale-base BLOCK        — fetch ok, latest commit older than window
 *
 * Each branch must short-circuit further checks (only one verdict wins) and
 * must surface a disclosure line on stderr so the narrative carries the
 * reason rather than silently misreporting.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RETRO_TMPL = path.join(ROOT, "retro", "SKILL.md.tmpl");
const RETRO_MD = path.join(ROOT, "retro", "SKILL.md");

function readTmpl(): string {
  return fs.readFileSync(RETRO_TMPL, "utf-8");
}

function readMd(): string {
  return fs.readFileSync(RETRO_MD, "utf-8");
}

describe("#1624 retro stale-base guard — Step 0.5 exists and is ordered before Step 1", () => {
  test("Step 0.5 header is present in template", () => {
    const body = readTmpl();
    expect(body).toMatch(/### Step 0\.5: Stale-base \+ bad-today-anchor pre-flight guard/);
  });

  test("Step 0.5 appears before Step 1: Gather Raw Data", () => {
    const body = readTmpl();
    const step05 = body.indexOf("### Step 0.5:");
    const step1 = body.indexOf("### Step 1: Gather Raw Data");
    expect(step05).toBeGreaterThan(-1);
    expect(step1).toBeGreaterThan(-1);
    expect(step05).toBeLessThan(step1);
  });

  test("regenerated SKILL.md carries the Step 0.5 guard", () => {
    const md = readMd();
    expect(md).toMatch(/Step 0\.5: Stale-base \+ bad-today-anchor pre-flight guard/);
  });
});

describe("#1624 retro guard — branch A: no-remote skip", () => {
  test("template checks for 'origin' remote absence and skips with disclosure", () => {
    const body = readTmpl();
    // Must check git remote for 'origin' and short-circuit
    expect(body).toMatch(/git remote[^|]*\|\s*grep -c '\^origin\$'/);
    expect(body).toMatch(/RETRO_GUARD: no 'origin' remote/);
  });

  test("no-remote skip sets a verdict variable that gates later checks", () => {
    const body = readTmpl();
    // The verdict variable must be set so later branches short-circuit
    expect(body).toMatch(/_RETRO_GUARD_VERDICT="skip-no-remote"/);
  });
});

describe("#1624 retro guard — branch B: detached-HEAD skip", () => {
  test("template checks for detached HEAD via git symbolic-ref", () => {
    const body = readTmpl();
    expect(body).toMatch(/git symbolic-ref --quiet HEAD/);
    expect(body).toMatch(/RETRO_GUARD: detached HEAD/);
  });

  test("detached-HEAD branch is gated by prior verdict check (ordering)", () => {
    const body = readTmpl();
    // The detached-HEAD block must be guarded by the verdict check so
    // no-remote always wins if both are true.
    const branchBStart = body.indexOf("# Pre-check B: detached HEAD");
    expect(branchBStart).toBeGreaterThan(-1);
    const branchBSlice = body.slice(branchBStart, branchBStart + 500);
    expect(branchBSlice).toMatch(/if \[ -z "\$_RETRO_GUARD_VERDICT" \]/);
  });
});

describe("#1624 retro guard — branch C: fetch-fail warn", () => {
  test("template warns and proceeds against last-known origin when fetch fails", () => {
    const body = readTmpl();
    // Match either `git fetch ... ||` or `if ! git fetch ...` shape.
    expect(body).toMatch(/(?:if !\s+|[^\n]*\|\|\s*)git fetch origin <default>|git fetch origin <default>[^\n]*--quiet 2>\/dev\/null; then/);
    expect(body).toMatch(/fetch[^\n]*failed[^\n]*offline/);
    expect(body).toMatch(/_RETRO_GUARD_VERDICT="warn-fetch-failed"/);
  });

  test("fetch-fail warn is gated by prior verdict check (ordering)", () => {
    const body = readTmpl();
    const branchCStart = body.indexOf("# Pre-check C: fetch origin");
    expect(branchCStart).toBeGreaterThan(-1);
    const branchCSlice = body.slice(branchCStart, branchCStart + 500);
    expect(branchCSlice).toMatch(/if \[ -z "\$_RETRO_GUARD_VERDICT" \]/);
  });
});

describe("#1624 retro guard — branch D: stale-base BLOCK", () => {
  test("template extracts latest origin/<default> commit date via git log -1 --format=%ci", () => {
    const body = readTmpl();
    // The BLOCK check must read the actual latest-commit date so the
    // disclosure is concrete (not generic).
    expect(body).toMatch(/git log -1 --format=%ci origin\/<default>/);
  });

  test("BLOCK prose names latest-commit date and instructs user remediation", () => {
    const body = readTmpl();
    // The BLOCK message must cite the date AND tell the user how to recover.
    // "Retro window is stale" is the canonical first line.
    expect(body).toMatch(/Retro window is stale/);
    expect(body).toMatch(/git fetch origin <default>/);
    expect(body).toMatch(/Confirm today's date/);
  });

  test("BLOCK branch is gated by prior verdict checks (ordering)", () => {
    const body = readTmpl();
    const branchDStart = body.indexOf("# Pre-check D:");
    expect(branchDStart).toBeGreaterThan(-1);
    const branchDSlice = body.slice(branchDStart, branchDStart + 800);
    expect(branchDSlice).toMatch(/if \[ -z "\$_RETRO_GUARD_VERDICT" \]/);
  });
});

describe("#1624 retro guard — disclosure must reach the narrative", () => {
  test("template names the skip paths that must carry a disclosure line", () => {
    const body = readTmpl();
    // The post-bash prose must explicitly tell the model to surface
    // these reasons in the retro output rather than silently dropping them.
    expect(body).toMatch(/skip-no-remote/);
    expect(body).toMatch(/skip-detached/);
    expect(body).toMatch(/warn-fetch-failed/);
    // The prose names disclosure + narrative together (either order) so the
    // retro output is never silently confidently-wrong.
    expect(body).toMatch(/(?:disclosure[\s\S]{0,200}narrative|narrative[\s\S]{0,200}disclosure)/);
  });
});
