import { describe, expect, test } from 'bun:test';
import { buildEvidenceRecord, inspectShipHandoff, type EvidenceBuildInput } from '../lib/evidence-envelope';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const context: Omit<EvidenceBuildInput, 'caller'> = {
  repo_id: 'github.com/acme/repo', branch_ref: 'feature', base_sha: base, merge_base_sha: base, local_head_sha: head, remote_pr_head_sha: head, tree: 'c'.repeat(40), wtree: 'd'.repeat(40), dirty: false,
  capability: { id: 'delivery.pr_open', version: '1' }, validator: { id: 'gstack.ship-handoff', version: '1' }, policy_version: 'evidence-policy.v2', profile_hash: 'e'.repeat(64), semantic_policy_hash: 'f'.repeat(64), lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'provider', coverage: { semantic_roles: ['code'], files: ['src/a.ts'] }, started_at: '2026-09-07T00:00:00.000Z', completed_at: '2026-09-07T00:00:01.000Z', expires_at: null,
  handoff: { stage: 'ship', state_root_id: `state_${'0'.repeat(32)}`, pr_number: 17, base_ref: 'origin/main', provider_identity: { repository_node_id: 'R_base', repository_name_with_owner: 'acme/repo', head_repository_node_id: 'R_head', head_repository_name_with_owner: 'acme/repo', head_ref_name: 'feature' }, manifest_hash: '1'.repeat(64), evidence_run_ids: ['review-1', 'validation-1'], review_run_ids: ['review-1'], validation_run_ids: ['validation-1'], release: { applicable: false, mode: 'none', version: null, title_policy: 'free' }, release_write: null },
};
const receipt = buildEvidenceRecord({ ...context, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: ['pr_update'] } });

describe('typed ship handoff', () => {
  test('returns only the unique exact current remote-head payload', () => {
    expect(inspectShipHandoff([receipt], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head, repositoryNodeId: 'R_base', headRepositoryNodeId: 'R_head', headRefName: 'feature' })).toEqual({ current: true, receipt_run_id: receipt.run_id, state_root_id: context.handoff!.state_root_id, repo_id: context.repo_id, pr: 17, base_ref: 'origin/main', base_sha: base, remote_pr_head_sha: head, remote_pr_head_tree: 'c'.repeat(40), provider_identity: context.handoff!.provider_identity, profile_hash: 'e'.repeat(64), manifest_hash: '1'.repeat(64), review_run_ids: ['review-1'], validation_run_ids: ['validation-1'], release_decision: { applicable: false, mode: 'none', version: null, title_policy: 'free' }, release_write: null, candidate_profile: null, promotion: null, canary_subject: null });
  });

  test('requires exact provider identity and a complete owner-bound release write for active releases', () => {
    const releaseWrite = {
      allocation_id: `release-${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`,
      release_write_record_id: `release-write-${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`,
      release_write_result_hash: '2'.repeat(64), version: '1.2.3', before_wtree: '3'.repeat(40), after_wtree: context.tree,
      product_manifest_hash_before_release: '4'.repeat(64), release_projection_hash: '5'.repeat(64),
      changelog_proposal_sha256: '6'.repeat(64), changelog_insertion_sha256: '7'.repeat(64),
      planned_targets: [{ path: 'VERSION', format: 'plain_text', selector: 'whole_file' }],
      changelog_projection: { path: 'CHANGELOG.md', format: 'plain_text', selector: 'whole_file' },
      mutated_projections: [{ path: 'VERSION', format: 'plain_text', selector: 'whole_file' }, { path: 'CHANGELOG.md', format: 'plain_text', selector: 'whole_file' }],
      files: [
        { path: 'VERSION', mode: 0o644, after_sha256: '8'.repeat(64), projections: [{ path: 'VERSION', format: 'plain_text', selector: 'whole_file' }] },
        { path: 'CHANGELOG.md', mode: 0o644, after_sha256: '9'.repeat(64), projections: [{ path: 'CHANGELOG.md', format: 'plain_text', selector: 'whole_file' }] },
      ],
    };
    const active = buildEvidenceRecord({ ...context, handoff: { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: releaseWrite }, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    const exact = { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head, repositoryNodeId: 'R_base', headRepositoryNodeId: 'R_head', headRefName: 'feature' };
    expect(inspectShipHandoff([active], exact)).toMatchObject({ current: true, provider_identity: context.handoff!.provider_identity, release_write: releaseWrite });
    for (const malformed of [
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: null },
      { ...context.handoff, release: { applicable: false, mode: 'none', version: null, title_policy: 'free' }, release_write: releaseWrite },
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '9.9.9', title_policy: 'version_prefix' }, release_write: releaseWrite },
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: { ...releaseWrite, planned_targets: [] } },
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: { ...releaseWrite, changelog_proposal_sha256: null, changelog_insertion_sha256: null } },
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: { ...releaseWrite, files: [null] } },
      { ...context.handoff, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix' }, release_write: { ...releaseWrite, changelog_projection: { path: 'CHANGELOG.md', format: 'json', selector: '/version' }, mutated_projections: [releaseWrite.planned_targets[0], { path: 'CHANGELOG.md', format: 'json', selector: '/version' }], files: [{ ...releaseWrite.files[0] }, { ...releaseWrite.files[1], projections: [{ path: 'CHANGELOG.md', format: 'json', selector: '/version' }] }] } },
      { ...context.handoff, provider_identity: { ...(context.handoff!.provider_identity as object), head_repository_node_id: '' } },
    ]) {
      const row = buildEvidenceRecord({ ...context, handoff: malformed, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
      expect(inspectShipHandoff([row], exact)).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
    }
    expect(inspectShipHandoff([receipt], { ...exact, headRepositoryNodeId: 'R_fork' })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
    const extra = buildEvidenceRecord({ ...context, handoff: { ...context.handoff, provider_identity: { ...(context.handoff!.provider_identity as object), secret: 'provider-secret' }, release: { applicable: true, mode: 'per_pr', version: '1.2.3', title_policy: 'version_prefix', secret: 'decision-secret' }, release_write: { ...releaseWrite, raw_body: 'release-secret' } }, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    expect(JSON.stringify(inspectShipHandoff([extra], exact))).not.toContain('secret');
  });
  test('wrong head, wrong PR, duplicate, or incomplete rows return a content-free blocker', () => {
    for (const input of [{ pr: 18, remotePrHeadSha: head }, { pr: 17, remotePrHeadSha: '9'.repeat(40) }]) {
      const result = inspectShipHandoff([receipt], { repoId: context.repo_id, baseRef: 'origin/main', baseSha: base, ...input }); expect(result).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' }); expect(JSON.stringify(result)).not.toContain(head);
    }
    expect(inspectShipHandoff([receipt, receipt], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_ambiguous' });
    expect(inspectShipHandoff([{ ...receipt, handoff: { stage: 'ship' } } as any], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
    expect(inspectShipHandoff([receipt], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head, stateRootId: `state_${'9'.repeat(32)}` })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
    expect(inspectShipHandoff([null as any, { schema_version: 'ecpe.receipt.v2', result: 'pass', exit: 0 } as any], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
  });

  test('returns an exact promotion lineage only when the candidate-profile pair is complete', () => {
    const promotion = {
      block_id: `block-${'2'.repeat(32)}`,
      lane: 'single_repo_code',
      proof_id: `promotion-${'3'.repeat(32)}`,
      record_id: `promotion-write-${'4'.repeat(32)}`,
      before_profile_hash: '5'.repeat(64),
      after_profile_hash: '6'.repeat(64),
      before_sha256: '7'.repeat(64),
      after_sha256: '8'.repeat(64),
      subject_head: '9'.repeat(40),
      subject_tree: 'a'.repeat(40),
    };
    const promoted = buildEvidenceRecord({
      ...context,
      handoff: {
        ...context.handoff,
        candidate_profile: { git_blob_oid: 'b'.repeat(40), schema_validation_hash: promotion.after_profile_hash },
        promotion,
      },
      caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: ['provider_pr_observed'] },
    });
    expect(inspectShipHandoff([promoted], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toMatchObject({
      current: true,
      candidate_profile: { git_blob_oid: 'b'.repeat(40), schema_validation_hash: promotion.after_profile_hash },
      promotion,
    });
    for (const handoff of [
      { ...context.handoff, promotion },
      { ...context.handoff, candidate_profile: { git_blob_oid: 'b'.repeat(40), schema_validation_hash: 'f'.repeat(64) }, promotion },
      { ...context.handoff, candidate_profile: { git_blob_oid: 'b'.repeat(40), schema_validation_hash: promotion.after_profile_hash }, promotion: { ...promotion, record_id: 'invalid' } },
    ]) {
      const malformed = buildEvidenceRecord({ ...context, handoff, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
      expect(inspectShipHandoff([malformed], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
    }
  });

  test('binds a pre-ready canary subject to the exact receipt head, tree, profile, and focused run', () => {
    const canarySubject = { block_id: `block-${'2'.repeat(32)}`, lane: 'single_repo_code', focused_run_id: `focused-${'3'.repeat(32)}`, profile_hash: context.profile_hash!, promotion_proof_id: `promotion-${'4'.repeat(32)}`, subject_head: head, subject_tree: context.tree!, policy_hash: '5'.repeat(64) };
    const canaryReceipt = buildEvidenceRecord({ ...context, handoff: { ...context.handoff, canary_subject: canarySubject }, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: ['provider_pr_observed'] } });
    expect(inspectShipHandoff([canaryReceipt], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toMatchObject({ current: true, canary_subject: canarySubject, remote_pr_head_tree: context.tree, profile_hash: context.profile_hash });
    const wrong = buildEvidenceRecord({ ...context, handoff: { ...context.handoff, canary_subject: { ...canarySubject, subject_tree: '9'.repeat(40) } }, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    expect(inspectShipHandoff([wrong], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
  });

  test('rejects a receipt that mixes promotion and canary authority', () => {
    const promotion = { block_id: `block-${'2'.repeat(32)}`, lane: 'single_repo_code', proof_id: `promotion-${'3'.repeat(32)}`, record_id: `promotion-write-${'4'.repeat(32)}`, before_profile_hash: '5'.repeat(64), after_profile_hash: context.profile_hash!, before_sha256: '7'.repeat(64), after_sha256: '8'.repeat(64), subject_head: '9'.repeat(40), subject_tree: 'a'.repeat(40) };
    const canarySubject = { block_id: promotion.block_id, lane: 'single_repo_code', focused_run_id: `focused-${'3'.repeat(32)}`, profile_hash: context.profile_hash!, promotion_proof_id: promotion.proof_id, subject_head: head, subject_tree: context.tree!, policy_hash: '5'.repeat(64) };
    const mixed = buildEvidenceRecord({ ...context, handoff: { ...context.handoff, candidate_profile: { git_blob_oid: 'b'.repeat(40), schema_validation_hash: context.profile_hash! }, promotion, canary_subject: canarySubject }, caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    expect(inspectShipHandoff([mixed], { repoId: context.repo_id, pr: 17, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
  });
});
