/**
 * Coverage for PR #1620 — Post-failure PR-state check after `gh pr merge`
 * non-zero exit.
 *
 * The merge step (and this invariant) moved out of /land-and-deploy into the
 * extracted /land skill (§4.2a). After ANY non-zero `gh pr merge`, the skill
 * must query authoritative PR state via
 * `gh pr view --json state,mergeCommit,mergedAt,mergedBy` and branch on the
 * result instead of retrying `gh pr merge` (cli/cli#3442, cli/cli#13380).
 *
 * Static invariants pin (now in /land):
 *   - §4.2a Post-failure PR-state check header present
 *   - Universal invariant text + reference to upstream gh bugs
 *   - All three state branches (MERGED, OPEN, CLOSED) named explicitly
 *   - MERGED branch: capture merge SHA via mergeCommit.oid
 *   - MERGED branch: non-destructive worktree cleanup with uncommitted-work guard
 *   - OPEN branch: checks autoMergeRequest before treating as failure
 *   - CLOSED branch: STOPs
 *   - Hard rule: never retry `gh pr merge`
 *   - .tmpl edit propagated to generated SKILL.md (atomic regen)
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TMPL = path.join(ROOT, "land", "SKILL.md.tmpl");
const MD = path.join(ROOT, "land", "SKILL.md");

function readTmpl(): string {
  return fs.readFileSync(TMPL, "utf-8");
}
function readMd(): string {
  return fs.readFileSync(MD, "utf-8");
}

describe("PR #1620 post-failure PR-state check in /land template", () => {
  test("post-failure header present in template", () => {
    expect(readTmpl()).toMatch(/### 4\.2a: Post-failure PR-state check/);
  });

  test("post-failure check comes before the landing step (4.3)", () => {
    const body = readTmpl();
    const postfail = body.indexOf("### 4.2a: Post-failure PR-state check");
    // 4.3 is the landing step (enqueue-and-return by default, or --watch). Match
    // the section number, not its title, so D4's rename doesn't break the order check.
    const landing = body.indexOf("### 4.3:");
    expect(postfail).toBeGreaterThan(-1);
    expect(landing).toBeGreaterThan(-1);
    expect(postfail).toBeLessThan(landing);
  });

  test("Universal invariant + upstream gh bug references", () => {
    const body = readTmpl();
    expect(body).toMatch(/Universal invariant/);
    expect(body).toMatch(/non-zero exit from `gh pr merge`/);
    expect(body).toMatch(/cli\/cli#3442/);
    expect(body).toMatch(/cli\/cli#13380/);
  });

  test("Authoritative state query uses gh pr view --json", () => {
    const body = readTmpl();
    expect(body).toMatch(/gh pr view --json state,mergeCommit,mergedAt,mergedBy/);
  });

  test("All three state branches named: MERGED, OPEN, CLOSED", () => {
    const body = readTmpl();
    expect(body).toMatch(/state == "MERGED"/);
    expect(body).toMatch(/state == "OPEN"/);
    expect(body).toMatch(/state == "CLOSED"/);
  });

  test("MERGED branch captures merge SHA via mergeCommit.oid", () => {
    const body = readTmpl();
    expect(body).toMatch(/gh pr view --json mergeCommit -q \.mergeCommit\.oid/);
  });

  test("MERGED worktree cleanup is non-destructive (uncommitted-work guard)", () => {
    const body = readTmpl();
    expect(body).toMatch(/uncommitted work/);
    expect(body).toMatch(/STOP worktree cleanup without removing/);
    expect(body).toMatch(/Do NOT use `--force`/);
    expect(body).toMatch(/Do NOT remove the user's primary working tree/);
  });

  test("OPEN branch checks autoMergeRequest before treating as failure", () => {
    const body = readTmpl();
    expect(body).toMatch(/gh pr view --json autoMergeRequest/);
    expect(body).toMatch(/auto-merge is enabled or merge queue is in use/);
  });

  test("CLOSED branch STOPs", () => {
    const body = readTmpl();
    expect(body).toMatch(/state == "CLOSED".*[\s\S]{0,200}STOP/);
  });

  test("Hard rule: never retry gh pr merge after non-zero exit", () => {
    const body = readTmpl();
    expect(body).toMatch(/never call `gh pr merge` a second time/);
  });

  test("Generated SKILL.md carries the post-failure section (atomic regen)", () => {
    const md = readMd();
    expect(md).toMatch(/### 4\.2a: Post-failure PR-state check/);
    expect(md).toMatch(/state == "MERGED"/);
  });
});
