/**
 * Coverage for PR #1620 — Post-failure PR-state check after `gh pr merge`
 * non-zero exit.
 *
 * The fix lives in land-and-deploy/sections/merge-and-deploy.md.tmpl as Step
 * §4a-postfail (the Step 4/5 body was carved out of the skeleton into an
 * on-demand section — prompt-token-load-reduction carve; the skeleton keeps
 * only the STOP-Read pointer). After ANY non-zero `gh pr merge`, the skill
 * must query authoritative PR state via
 * `gh pr view --json state,mergeCommit,mergedAt,mergedBy` and
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
const TMPL = path.join(ROOT, "land-and-deploy", "sections", "merge-and-deploy.md.tmpl");
const MD = path.join(ROOT, "land-and-deploy", "sections", "merge-and-deploy.md");

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

  // #2656: the failed merge carried --delete-branch; the recovery path must
  // reconcile the remote branch instead of silently dropping that half.
  // #2696: that reconciliation must target the PR head repository, not the
  // base checkout's origin, because fork branches do not exist in origin.
  test("MERGED branch reconciles the PR head repository (ls-remote, confirm-first delete)", () => {
    const body = readTmpl();
    expect(body).toMatch(/gh pr view --json headRepositoryOwner,headRepository,headRefName/);
    // gh leaves .headRepository.nameWithOwner empty (verified live, gh 2.83) —
    // owner/name is composed from headRepositoryOwner.login + headRepository.name.
    expect(body).toMatch(/headRepositoryOwner\.login/);
    expect(body).not.toMatch(/\[\.headRepository\.nameWithOwner/);
    expect(body).toMatch(/git ls-remote --heads "https:\/\/github\.com\/<head-repository>\.git" "<head-branch>"/);
    expect(body).toMatch(/git push "https:\/\/github\.com\/<head-repository>\.git" --delete "<head-branch>"/);
    expect(body).not.toMatch(/git ls-remote --heads origin/);
    expect(body).not.toMatch(/git push origin --delete/);
    // Confirm-first: deletion is offered, never unilateral.
    expect(body).toMatch(/Delete it\?/);
  });

  test("MERGED branch reconciliation distinguishes branch-absent from check-failed", () => {
    const body = readTmpl();
    // exit 0 + empty output = already clean (idempotent re-runs)...
    expect(body).toMatch(/already been cleaned up/);
    // ...non-zero exit = unknown state, never read as a clean branch.
    expect(body).toMatch(/Couldn't verify remote branch state/);
    expect(body).toMatch(/never read a failed check as a clean branch/);
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

  test("Generated merge-and-deploy.md carries the §4a-postfail section (atomic regen per T-Codex-3)", () => {
    const md = readMd();
    expect(md).toMatch(/### 4a-postfail: Post-failure PR-state check/);
    expect(md).toMatch(/state == "MERGED"/);
    expect(md).toMatch(/headRepositoryOwner\.login/);
    expect(md).not.toMatch(/git ls-remote --heads origin/);
  });
});
