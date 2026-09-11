import { describe, expect, test } from 'bun:test';
import { ensureValidator } from '../lib/validator-runner';

describe('remote profile hard gate', () => {
  test('a missing paid grant performs no validator spawn and creates no receipt', () => {
    let spawns = 0, appends = 0; const now = '2026-09-07T00:00:00.000Z';
    const result = ensureValidator({ validatorId: 'hard', effect: 'paid_model', argv: ['/usr/bin/true'], cwd: '/', currentRecord: null, evidenceContext: { repo_id: 'r', branch_ref: 'b', base_sha: 'a'.repeat(40), merge_base_sha: 'a'.repeat(40), local_head_sha: 'b'.repeat(40), remote_pr_head_sha: 'b'.repeat(40), tree: 'c'.repeat(40), wtree: 'd'.repeat(40), dirty: false, capability: { id: 'hard', version: '1' }, validator: { id: 'hard', version: '1' }, profile_hash: null, semantic_policy_hash: 'e'.repeat(64), lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'private', coverage: { semantic_roles: ['code'], files: [] }, started_at: now, completed_at: now, expires_at: null } }, { spawn: () => { spawns++; return { exitCode: 0 }; }, append: () => appends++ });
    expect(result).toMatchObject({ disposition: 'grant_required', spawned: false }); expect(spawns).toBe(0); expect(appends).toBe(0);
  });
});
