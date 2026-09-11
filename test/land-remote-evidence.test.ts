import { describe, expect, test } from 'bun:test';
import { buildEvidenceRecord, inspectShipHandoff } from '../lib/evidence-envelope';

describe('land remote evidence', () => {
  test('binds the handoff to one exact remote PR head', () => {
    const base = 'a'.repeat(40), head = 'b'.repeat(40), now = '2026-09-07T00:00:00.000Z';
    const record = buildEvidenceRecord({
      repo_id: 'github.com/o/r', branch_ref: 'feature', base_sha: base,
      merge_base_sha: base, local_head_sha: head, remote_pr_head_sha: head,
      tree: 'c'.repeat(40), wtree: 'd'.repeat(40), dirty: false,
      capability: { id: 'delivery.pr_open', version: '1' },
      validator: { id: 'gstack.ship-handoff', version: '1' },
      profile_hash: '1'.repeat(64), semantic_policy_hash: 'e'.repeat(64),
      lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {},
      environment_class: 'provider', coverage: { semantic_roles: ['code'], files: [] },
      started_at: now, completed_at: now, expires_at: null,
      handoff: {
        stage: 'ship', state_root_id: `state_${'0'.repeat(32)}`, pr_number: 3, base_ref: 'origin/main',
        provider_identity: { repository_node_id: 'R_1', repository_name_with_owner: 'o/r', head_repository_node_id: 'R_1', head_repository_name_with_owner: 'o/r', head_ref_name: 'feature' },
        manifest_hash: 'f'.repeat(64), review_run_ids: [], validation_run_ids: [],
        release: { applicable: false, mode: 'none', version: null, title_policy: 'free' },
        release_write: null,
      },
      caller: { command_argv: ['handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] },
    });
    expect(inspectShipHandoff([record], {
      repoId: 'github.com/o/r', pr: 3, baseRef: 'origin/main',
      baseSha: base, remotePrHeadSha: head,
    })).toMatchObject({ current: true });
    expect(inspectShipHandoff([record], {
      repoId: 'github.com/o/r', pr: 3, baseRef: 'origin/main',
      baseSha: base, remotePrHeadSha: '9'.repeat(40),
    })).toEqual({ current: false, blocker: 'ship_handoff_missing_or_stale' });
  });
});
