/**
 * Coverage for PR #1620 — Post-failure PR-state check after `gh pr merge`
 * non-zero exit.
 *
 * The fix lives in land-and-deploy/SKILL.md.tmpl as Step §4a-postfail.
 * After ANY non-zero `gh pr merge`, the skill must query authoritative PR
 * state via `gh pr view --json state,mergeCommit,mergedAt,mergedBy` and
 * branch on the result instead of retrying `gh pr merge` (cli/cli#3442,
 * cli/cli#13380).
 *
 * Static invariants pin:
 *   - §4a-postfail header present
 *   - Universal invariant text + reference to upstream gh bugs
 *   - All three state branches (MERGED, OPEN, CLOSED) named explicitly
 *   - MERGED branch: capture merge SHA via mergeCommit.oid
 *   - MERGED branch: non-destructive worktree cleanup with uncommitted-work guard
 *   - MERGED branch: continues to §4a CI watch
 *   - OPEN branch: checks autoMergeRequest before treating as failure
 *   - CLOSED branch: STOPs
 *   - Hard rule: never retry `gh pr merge`
 *   - .tmpl edit propagated to generated SKILL.md (atomic per T-Codex-3)
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TMPL = path.join(ROOT, "land-and-deploy", "SKILL.md.tmpl");
const MD = path.join(ROOT, "land-and-deploy", "SKILL.md");

function readTmpl(): string {
  return fs.readFileSync(TMPL, "utf-8");
}
function readMd(): string {
  return fs.readFileSync(MD, "utf-8");
}

describe("PR #1620 §4a-postfail in land-and-deploy template", () => {
  test("§4a-postfail header present in template", () => {
    expect(readTmpl()).toMatch(/### 4a-postfail: Post-failure PR-state check/);
  });

  test("§4a-postfail comes before §4a (Merge queue detection)", () => {
    const body = readTmpl();
    const postfail = body.indexOf("### 4a-postfail:");
    const queue = body.indexOf("### 4a: Merge queue detection");
    expect(postfail).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(postfail).toBeLessThan(queue);
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

  test("MERGED branch continues to §4a CI auto-deploy detection", () => {
    const body = readTmpl();
    expect(body).toMatch(/continue to §4a/);
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

  test("Generated SKILL.md carries the §4a-postfail section (atomic regen per T-Codex-3)", () => {
    const md = readMd();
    expect(md).toMatch(/### 4a-postfail: Post-failure PR-state check/);
    expect(md).toMatch(/state == "MERGED"/);
  });
});
