import { describe, expect, test } from 'bun:test';
import { evaluateCanaryPair } from '../lib/lane-canary';
import { createPromotionCanaryPending } from '../lib/promotion-landing';
import { afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('land canary assertion flow', () => {
  test('classifies a profile safety regression before any promotion', () => {
    expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'fail', durationMs: 90 } })).toMatchObject({ result: 'safety_regressed' });
  });

  test('opens only a pending gate from the exact reviewed promotion and verified merge checkpoint', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'promotion-landing-')); roots.push(stateRoot);
    const handoff = {
      current: true as const, receipt_run_id: `evidence-${'1'.repeat(32)}`, repo_id: 'portfolioops', pr: 7, base_ref: 'origin/main', base_sha: '2'.repeat(40), remote_pr_head_sha: '3'.repeat(40), manifest_hash: '4'.repeat(64), review_run_ids: [], validation_run_ids: [],
      release_decision: { applicable: false, mode: 'none' as const, version: null, title_policy: 'free' as const },
      candidate_profile: { git_blob_oid: '5'.repeat(40), schema_validation_hash: '6'.repeat(64) },
      promotion: { block_id: `block-${'7'.repeat(32)}`, lane: 'single_repo_code' as const, proof_id: `promotion-${'8'.repeat(32)}`, record_id: `promotion-write-${'9'.repeat(32)}`, before_profile_hash: 'a'.repeat(64), after_profile_hash: '6'.repeat(64), before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64), subject_head: 'd'.repeat(40), subject_tree: 'e'.repeat(40) },
    };
    const merge = { status: 'merged' as const, mergeSha: 'f'.repeat(40), expectedHeadOid: handoff.remote_pr_head_sha, expectedBaseOid: handoff.base_sha, intentId: '1'.repeat(64), baseAtomicity: 'verified' as const };
    const first = createPromotionCanaryPending({ stateRoot, handoff, merge });
    expect(first).toMatchObject({ phase: 'pending', execution_allowed: false, promotion_receipt_id: handoff.receipt_run_id });
    expect(createPromotionCanaryPending({ stateRoot, handoff, merge })).toMatchObject({ result: 'reused', state_id: first.state_id, promotion_checkpoint_id: first.promotion_checkpoint_id });
    expect(() => createPromotionCanaryPending({ stateRoot, handoff, merge: { ...merge, expectedHeadOid: '0'.repeat(40) } })).toThrow('promotion_landing_lineage_mismatch');
  });

  test('carries one immutable sample or activation assertion from receipt inspection into the sole merge call', () => {
    const readiness = readFileSync(join(import.meta.dir, '..', 'land-and-deploy', 'sections', 'readiness-gate.md.tmpl'), 'utf8');
    const merge = readFileSync(join(import.meta.dir, '..', 'land-and-deploy', 'sections', 'merge-and-deploy.md.tmpl'), 'utf8');
    const effect = readFileSync(join(import.meta.dir, '..', 'scripts', 'authority', 'effect-scope.ts'), 'utf8');
    const execution = readFileSync(join(import.meta.dir, '..', 'scripts', 'authority', 'execution-plan.ts'), 'utf8');
    expect(readiness).toContain('gstack-lane-canary inspect');
    expect(readiness).toContain('SHIP_CANARY_PROOF');
    expect(readiness).toContain('SHIP_CANARY_SAMPLE');
    expect(readiness).toContain('SHIP_HANDOFF_STATUS=0');
    expect(readiness).toContain('ship_handoff_missing_or_stale');
    expect(readiness).not.toContain('--expected-base "$PR_BASE_OID" --json) || exit 1');
    expect(readiness).toContain('SHIP_PROMOTION_BLOCK_ID');
    expect(readiness).toContain('"activation_landing_intent","activation_checkpointed","pending_superseded"');
    expect(merge).toContain('--assert-milestone-block "$SHIP_CANARY_BLOCK_ID" --assert-canary-proof "$SHIP_CANARY_PROOF"');
    expect(merge).toContain('--assert-milestone-block "$SHIP_CANARY_BLOCK_ID" --assert-canary-sample "$SHIP_CANARY_SAMPLE"');
    expect(merge).toContain('--assert-milestone-block "$SHIP_PROMOTION_BLOCK_ID"');
    expect(merge.match(/gstack-effect-scope provider-merge direct/g)).toHaveLength(1);
    expect(effect.indexOf("if (assertedCanaryProof && assertedCanarySample)")).toBeLessThan(effect.indexOf('const mergeProvider = () =>'));
    expect(effect.indexOf('reconcileCanaryActivationLanding')).toBeLessThan(effect.indexOf('const activation = await reconcileCanaryActivationLanding'));
    expect(effect).toContain('withMilestoneLandingJournal');
    expect(effect).toContain("milestoneLanding, reconcileOnly:mergeMode==='reconcile' });");
    const atomicClaim = execution.slice(execution.indexOf('await withActiveMilestoneOwner'), execution.indexOf('const preliminary'));
    expect(atomicClaim.indexOf('claimCanaryFocusedRun')).toBeLessThan(atomicClaim.indexOf('startFusedExecutionLifecycle'));
  });
});
