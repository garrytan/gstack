import { describe, expect, test } from 'bun:test';
import { buildEvidenceRecord, type EvidenceBuildInput } from '../lib/evidence-envelope';
import { ensureValidator } from '../lib/validator-runner';
import { ProcessLocalGrant, issueGrant } from '../lib/effect-scope';

const context: Omit<EvidenceBuildInput, 'caller'> = {
  repo_id: 'repo', branch_ref: 'main', base_sha: 'a'.repeat(40), merge_base_sha: 'a'.repeat(40), local_head_sha: 'b'.repeat(40), remote_pr_head_sha: null, tree: 'c'.repeat(40), wtree: 'd'.repeat(40), dirty: false,
  capability: { id: 'test.unit', version: '1' }, validator: { id: 'unit', version: 'e'.repeat(64) }, policy_version: 'evidence-policy.v2', profile_hash: null, semantic_policy_hash: 'f'.repeat(64), lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'local', coverage: { semantic_roles: ['code'], files: ['src/a.ts'] }, started_at: '2026-09-07T00:00:00.000Z', completed_at: '2026-09-07T00:00:01.000Z', expires_at: '2099-01-01T00:00:00.000Z',
};
const current = buildEvidenceRecord({ ...context, caller: { command_argv: ['tool', 'check'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
const binding = { validatorId: 'unit', effect: 'read' as const, argv: ['tool', 'check'], cwd: '/tmp', evidenceContext: context, currentRecord: current };

describe('check-first validator runner', () => {
  test('does not spawn when a current receipt exists', () => { let spawned = 0; const result = ensureValidator(binding, { spawn: () => { spawned++; return { exitCode: 0 }; }, append: () => {} }); expect(result.disposition).toBe('receipt_current'); expect(result.spawned).toBe(false); expect(spawned).toBe(0); });
  test('runs once and appends pass or fail evidence when stale', () => {
    const records: unknown[] = []; const stale = { ...binding, currentRecord: null };
    expect(ensureValidator(stale, { spawn: () => ({ exitCode: 0 }), append: (record) => records.push(record), now: () => ['2026-09-07T00:00:00.000Z', '2026-09-07T00:00:01.000Z'].shift()! })).toMatchObject({ disposition: 'live_pass', spawned: true, child_exit: 0 });
    expect((records[0] as any).result).toBe('pass');
    expect(ensureValidator(stale, { spawn: () => ({ exitCode: 7 }), append: (record) => records.push(record) })).toMatchObject({ disposition: 'live_fail', spawned: true, child_exit: 7 });
    expect((records[1] as any).result).toBe('fail');
  });
  test('paid validators need a matching one-use in-memory grant before spawn', () => {
    let spawned = 0; const paid = { ...binding, effect: 'paid_model' as const, validatorId: 'codex.review.v1', evidenceContext: { ...context, validator: { id: 'codex.review.v1', version: 'e'.repeat(64) } }, currentRecord: null };
    expect(ensureValidator(paid, { spawn: () => { spawned++; return { exitCode: 0 }; }, append: () => {} })).toMatchObject({ disposition: 'grant_required', spawned: false }); expect(spawned).toBe(0);
    const grant = new ProcessLocalGrant(issueGrant('review', 'paid_model', { validatorId: 'codex.review.v1' }));
    expect(ensureValidator(paid, { grant, spawn: () => { spawned++; return { exitCode: 0 }; }, append: () => {} }).disposition).toBe('live_pass'); expect(spawned).toBe(1);
    expect(() => ensureValidator(paid, { grant, spawn: () => ({ exitCode: 0 }), append: () => {} })).toThrow('effect_grant_replayed');
    expect(JSON.stringify(grant)).not.toContain('codex.review.v1');
  });
  test('profile paid grants bind every protected validator dimension', () => {
    let spawned = 0;
    const assertions = { repo_id: 'repo', target_ref: 'origin/main', target_sha: 'a'.repeat(40), lane: 'single_repo_code', validator_id: 'paid', validator_version: 'v1', capability_id: 'test.unit', capability_version: '1', semantic_policy_hash: 'f'.repeat(64) };
    const paid = { ...binding, effect: 'paid_model' as const, validatorId: 'paid', paidGrantAssertions: assertions, evidenceContext: { ...context, validator: { id: 'paid', version: 'v1' } }, currentRecord: null };
    const exact = new ProcessLocalGrant(issueGrant('review', 'paid_model', assertions));
    expect(ensureValidator(paid, { grant: exact, spawn: () => { spawned++; return { exitCode: 0 }; }, append: () => {} }).disposition).toBe('live_pass');
    expect(spawned).toBe(1);
    for (const key of Object.keys(assertions)) {
      const wrong = { ...assertions, [key]: `${assertions[key as keyof typeof assertions]}-wrong` };
      expect(() => ensureValidator(paid, { grant: new ProcessLocalGrant(issueGrant('review', 'paid_model', wrong)), spawn: () => { spawned++; return { exitCode: 0 }; }, append: () => {} })).toThrow('effect_grant_mismatch');
    }
    expect(spawned).toBe(1);
  });
});
