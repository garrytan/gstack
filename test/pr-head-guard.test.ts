import { describe, expect, test } from 'bun:test';
import { assertProviderHeadSnapshot, validateProviderHeadSnapshot } from '../lib/provider-access';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';

function raw(overrides: Record<string, unknown> = {}) {
  return {
    number: 123, state: 'OPEN', baseRefName: 'main', baseRefOid: BASE,
    headRefName: 'feature', headRefOid: HEAD, headRepository: { id: 'R_123', nameWithOwner: 'Konghak/PortfolioOps' }, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeQueueEntry: null,
    ...overrides,
  };
}

describe('authoritative remote PR head guard', () => {
  test('freezes exact full OIDs, protected target ref, and null automation state', () => {
    const snapshot = validateProviderHeadSnapshot({
      repositoryNameWithOwner: 'Konghak/PortfolioOps', repositoryNodeId: 'R_123',
      viewerPermission: 'WRITE', repositorySelector: 'Konghak/PortfolioOps',
      targetRef: 'origin/main', pullRequest: raw(),
    });
    expect(snapshot.headRefOid).toBe(HEAD);
    expect(snapshot.baseRefOid).toBe(BASE);
    expect(snapshot.targetRef).toBe('origin/main');
    expect(snapshot.headRepositoryNodeId).toBe('R_123');
    expect(snapshot.autoMergeRequest).toBeNull();
    expect(snapshot.mergeQueueEntry).toBeNull();
  });

  test('rejects short SHAs and moved head/base/target or automation state', () => {
    expect(() => validateProviderHeadSnapshot({
      repositoryNameWithOwner: 'Konghak/PortfolioOps', repositoryNodeId: 'R_123',
      viewerPermission: 'WRITE', repositorySelector: 'Konghak/PortfolioOps',
      targetRef: 'origin/main', pullRequest: raw({ headRefOid: '1111111' }),
    })).toThrow('provider_oid_invalid');
    const base = validateProviderHeadSnapshot({
      repositoryNameWithOwner: 'Konghak/PortfolioOps', repositoryNodeId: 'R_123',
      viewerPermission: 'WRITE', repositorySelector: 'Konghak/PortfolioOps',
      targetRef: 'origin/main', pullRequest: raw(),
    });
    for (const moved of [
      { ...base, headRefOid: '3333333333333333333333333333333333333333' },
      { ...base, baseRefOid: '4444444444444444444444444444444444444444' },
      { ...base, targetRef: 'upstream/main' },
      { ...base, headRepositoryNodeId: 'R_fork' },
      { ...base, autoMergeRequest: { id: 'AM_1', state: 'ENABLED' } },
      { ...base, mergeQueueEntry: { id: 'MQ_1', state: 'QUEUED', headOid: HEAD, baseOid: BASE, groupOid: null } },
    ]) expect(() => assertProviderHeadSnapshot(moved, {
      prNumber: 123, expectedHeadOid: HEAD, expectedBaseOid: BASE,
      expectedTargetRef: 'origin/main', expectedHeadRepositoryNodeId: 'R_123', requireAutomationNull: true,
    })).toThrow();
    expect(() => validateProviderHeadSnapshot({ repositoryNameWithOwner: 'Konghak/PortfolioOps', repositoryNodeId: 'R_123', viewerPermission: 'WRITE', repositorySelector: 'Konghak/PortfolioOps', targetRef: 'origin/main', pullRequest: raw({ headRepository: null }) })).toThrow('provider_head_repository_invalid');
  });
});
