/**
 * Regression for #1127 — Context Recovery looked up `<branch>-reviews.jsonl`
 * with the WRONG branch form, so review history for slashed branches
 * (feat/*, fix/*) was never reported.
 *
 * Two branch forms coexist and must not be confused:
 *   - `$BRANCH`  — from `eval gstack-slug`, sanitized to [a-zA-Z0-9._-]
 *     (`feat/foo` → `featfoo`). This is the form gstack-review-log (writer) and
 *     gstack-review-read (reader) use for `<branch>-reviews.jsonl` filenames, so
 *     the Context Recovery review lookup MUST use it too.
 *   - `$_BRANCH` — the raw `git branch --show-current` from the preamble, which
 *     is how timeline.jsonl records its `branch` field, so the timeline greps
 *     MUST keep using it.
 *
 * Before the fix, the review lookup used bare `$_BRANCH`, which (a) mismatched
 * the strip-form file gstack-review-log writes for slashed branches and (b) is
 * not even guaranteed to be defined inside this self-contained block. The fix
 * routes the review lookup through `$BRANCH` while leaving the timeline greps on
 * `$_BRANCH`. This test pins both halves so neither regresses.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateContextRecovery } from '../scripts/resolvers/preamble/generate-context-recovery';

function makeCtx(host: 'claude' | 'codex'): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: 2,
  };
}

describe('#1127 Context Recovery branch-form consistency', () => {
  for (const host of ['claude', 'codex'] as const) {
    test(`reviews.jsonl lookup uses canonical $BRANCH, not bare $_BRANCH (${host})`, () => {
      const out = generateContextRecovery(makeCtx(host));
      // The review line must reference the strip-form $BRANCH that
      // gstack-review-log/read write/read with.
      expect(out).toContain('${BRANCH}-reviews.jsonl');
      // ...and must NOT use the raw $_BRANCH, which mismatches for slashed branches.
      expect(out).not.toContain('${_BRANCH}-reviews.jsonl');
    });

    test(`$BRANCH is in scope: the block evals gstack-slug before use (${host})`, () => {
      const out = generateContextRecovery(makeCtx(host));
      const slugIdx = out.indexOf('gstack-slug');
      const reviewIdx = out.indexOf('${BRANCH}-reviews.jsonl');
      expect(slugIdx).toBeGreaterThan(-1);
      expect(reviewIdx).toBeGreaterThan(slugIdx);
    });

    test(`timeline.jsonl greps keep using raw $_BRANCH (${host})`, () => {
      const out = generateContextRecovery(makeCtx(host));
      // timeline.jsonl records the raw branch, so these greps must stay on
      // $_BRANCH — guard against an over-eager fix that converts them too.
      expect(out).toContain('${_BRANCH}');
      // But the raw form must no longer appear in the reviews filename.
      expect(out).not.toContain('${_BRANCH}-reviews.jsonl');
    });
  }
});
