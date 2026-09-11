import { describe, expect, test } from 'bun:test';
import { FRESHNESS_REASON_PRIORITY, buildEvidenceRecord, evaluateFreshness, type EvidenceRecordV2 } from '../lib/evidence-envelope';

const protectedContext = {
  repo_id: 'github.com/acme/repo', branch_ref: 'feature/x', base_sha: 'a'.repeat(40), merge_base_sha: 'b'.repeat(40),
  local_head_sha: 'c'.repeat(40), remote_pr_head_sha: null, tree: 'd'.repeat(40), wtree: 'e'.repeat(40), dirty: false,
  capability: { id: 'test.unit', version: '1' }, validator: { id: 'unit', version: 'f'.repeat(64) },
  policy_version: 'evidence-policy.v2', profile_hash: '1'.repeat(64), semantic_policy_hash: '2'.repeat(64),
  lockfile_hashes: { 'bun.lock': '3'.repeat(64) }, dependency_fingerprints: {}, toolchain_fingerprint: { bun: '1.3.13' }, environment_class: 'local',
  coverage: { semantic_roles: ['code'] as const, files: ['src/a.ts'] }, started_at: '2026-09-07T00:00:00.000Z', completed_at: '2026-09-07T00:00:01.000Z', expires_at: '2026-09-08T00:00:00.000Z',
};

describe('EvidenceRecordV2', () => {
  test('adapter stamps protected fields, redacts persisted argv, and rejects unsafe artifacts', () => {
    const secret = 'ghp_' + 'A8bC2dE4fG6hI8jK0lM2nO4pQ6rS8tU0vW2x';
    const record = buildEvidenceRecord({
      ...protectedContext,
      caller: { repo_id: 'forged', tree: '0'.repeat(40), command_argv: ['tool', secret], result: 'pass', exit: 0, artifacts: ['reports/unit.json'], side_effects: [] },
    });
    expect(record.schema_version).toBe('ecpe.receipt.v2');
    expect(record.subject.repo_id).toBe('github.com/acme/repo'); expect(record.subject.tree).toBe('d'.repeat(40));
    expect(JSON.stringify(record)).not.toContain(secret); expect(record.inputs.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.ts).toBe(record.created_at); expect(record.command.toLowerCase()).toContain('redacted');
    expect(() => buildEvidenceRecord({ ...protectedContext, caller: { command_argv: ['ok'], result: 'pass', exit: 0, artifacts: ['/Users/me/token'], side_effects: [] } })).toThrow('evidence_artifact_invalid');
    expect(() => buildEvidenceRecord({ ...protectedContext, caller: { command_argv: ['ok'], result: 'pass', exit: 0, artifacts: ['../token'], side_effects: [] } })).toThrow('evidence_artifact_invalid');
  });

  test('freshness reports every mismatch in fixed priority order', () => {
    const record = buildEvidenceRecord({ ...protectedContext, caller: { command_argv: ['bun', 'test'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    const verdict = evaluateFreshness(record, {
      now: '2026-09-09T00:00:00.000Z', subject: { ...record.subject, tree: '9'.repeat(40), remote_pr_head_sha: '8'.repeat(40) },
      command_argv: ['bun', 'test', 'changed'], capability: { ...record.capability, version: '2' }, validator: { ...record.validator, version: '7'.repeat(64) },
      policy_version: 'changed', semantic_policy_hash: '6'.repeat(64), lockfile_hashes: { 'bun.lock': '5'.repeat(64) }, dependency_fingerprints: { dep: { repo_id: 'x', head_sha: 'a'.repeat(40), tree: 'b'.repeat(40), artifact_sha256: 'c'.repeat(64) } },
      toolchain_fingerprint: { bun: 'other' }, environment_class: 'ci', eval_binding: { suite_id: 's', evaluator_id: 'e', model_id: 'm', build_id: 'b' }, semantic_intersection: false, projection_matches: false,
    });
    expect(verdict.current).toBe(false); expect(verdict.primary_reason).toBe('expired');
    expect(verdict.reasons).toEqual(FRESHNESS_REASON_PRIORITY.filter((reason) => ['expired', 'subject_changed', 'remote_head_changed', 'command_changed', 'validator_changed', 'capability_changed', 'policy_changed', 'semantic_policy_changed', 'dependency_changed', 'lockfile_changed', 'toolchain_changed', 'environment_changed', 'build_changed', 'suite_changed', 'evaluator_changed', 'model_changed', 'semantic_intersection', 'projection_mismatch'].includes(reason)));
  });

  test('malformed, failed, missing, and exact current records are deterministic', () => {
    expect(evaluateFreshness(null, {} as any)).toMatchObject({ current: false, reasons: ['missing'], primary_reason: 'missing' });
    expect(evaluateFreshness({ schema_version: 'wrong' } as EvidenceRecordV2, {} as any).primary_reason).toBe('malformed');
    const record = buildEvidenceRecord({ ...protectedContext, caller: { command_argv: ['ok'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
    const expected = { now: record.created_at, subject: record.subject, command_argv: ['ok'], capability: record.capability, validator: record.validator, policy_version: record.policy_version, semantic_policy_hash: record.semantic_policy_hash, lockfile_hashes: record.inputs.lockfile_hashes, dependency_fingerprints: record.inputs.dependency_fingerprints, toolchain_fingerprint: record.inputs.toolchain_fingerprint, environment_class: record.inputs.environment_class, eval_binding: record.eval_binding, semantic_intersection: true, projection_matches: true };
    expect(evaluateFreshness(record, expected)).toMatchObject({ current: true, reasons: [], primary_reason: null, receipt_run_id: record.run_id });
    expect(evaluateFreshness({ ...record, result: 'fail', exit: 1 }, expected).primary_reason).toBe('failed');
  });
});
