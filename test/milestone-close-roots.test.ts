import { describe, expect, test } from 'bun:test';
import { buildPilotReadiness } from '../lib/pilot-evaluation';

describe('milestone close roots', () => {
  test('binds readiness to all three canonical root identities', () => {
    const base: any = { blockJournalRevision: 'r1', compiledPolicyHash: 'p1', roster: ['portfolioops', 'cdo-os', 'harness-governance'], sourceRegistryHash: 's1', sourceCursorHash: 'c1', participantSubjectHashes: { portfolioops: 'a', 'cdo-os': 'b', 'harness-governance': 'c' }, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: 'state' } };
    const first = buildPilotReadiness(base); const moved = buildPilotReadiness({ ...base, roots: { ...base.roots, state_root_id: 'other' } });
    expect(first.ready).toBeTrue(); expect(first.readiness_id).not.toBe(moved.readiness_id);
  });
});
