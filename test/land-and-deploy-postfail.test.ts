/**
 * ECPE v3 post-failure reconciliation after the closed direct-merge adapter
 * returns non-zero. The provider may have accepted the mutation even when the
 * response was lost, so only a fresh read is permitted; a second merge or any
 * cleanup mutation is forbidden.
 *
 * The fix lives in land-and-deploy/sections/merge-and-deploy.md.tmpl as Step
 * §4a-postfail (the Step 4/5 body was carved out of the skeleton into an
 * on-demand section — prompt-token-load-reduction carve; the skeleton keeps
 * only the STOP-Read pointer). After ANY non-zero direct-adapter exit, the skill
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
 *   - MERGED branch: no branch or worktree cleanup
 *   - MERGED branch: continues to §4a merge-queue detection
 *   - OPEN branch: checks autoMergeRequest before treating as failure
 *   - CLOSED branch: STOPs
 *   - Hard rule: never issue a second merge mutation
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

  test("Universal invariant is bound to the closed direct adapter", () => {
    const body = readTmpl();
    expect(body).toMatch(/Universal invariant/);
    expect(body).toMatch(/non-zero direct adapter exit/);
    expect(body).toMatch(/do not retry or/);
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

  test("MERGED reconciliation performs no branch or worktree cleanup", () => {
    const body = readTmpl();
    expect(body).toMatch(/cleanup are outside landing/);
    expect(body).toMatch(/without deleting, moving, pruning/);
    expect(body).not.toMatch(/git push origin --delete/);
    expect(body).not.toMatch(/git worktree remove/);
  });

  test("MERGED branch continues to §4a merge-queue detection", () => {
    const body = readTmpl();
    expect(body).toMatch(/continue to §4a/);
  });

  test("the mutation path is one head-CAS direct request without auto-merge", () => {
    const body = readTmpl();
    expect(body).toMatch(/one head-CAS direct squash request/);
    expect(body).toMatch(/never enables auto-merge/);
    expect(body).not.toMatch(/^gh pr merge\b/m);
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

  test("Hard rule: never issue a second merge mutation after non-zero exit", () => {
    const body = readTmpl();
    expect(body).toMatch(/never issue a second merge mutation/);
  });

  test("Generated merge-and-deploy.md carries the §4a-postfail section (atomic regen per T-Codex-3)", () => {
    const md = readMd();
    expect(md).toMatch(/### 4a-postfail: Post-failure PR-state check/);
    expect(md).toMatch(/state == "MERGED"/);
    expect(md).toMatch(/cleanup are outside landing/);
    expect(md).not.toMatch(/git ls-remote --heads origin/);
  });

  test("generated flow reconciles first and uses the direct mutation at most once", () => {
    for (const body of [readTmpl(), readMd()]) {
      const reconcile = body.indexOf('gstack-effect-scope provider-merge reconcile');
      const direct = body.indexOf('gstack-effect-scope provider-merge direct');
      expect(reconcile).toBeGreaterThan(-1);
      expect(direct).toBeGreaterThan(reconcile);
      expect(body.match(/gstack-effect-scope provider-merge direct/g)).toHaveLength(1);
      const directBranch = body.slice(direct, body.indexOf('; then', direct));
      expect(directBranch).not.toContain('|| exit 1');
    }
  });
});
