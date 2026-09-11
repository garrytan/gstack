import { describe, expect, test } from 'bun:test';
import { canonicalProviderRemote, permissionSatisfies, validateProviderAccessSnapshot } from '../lib/provider-access';

describe('canonical provider access binding', () => {
  test('normalizes transport syntax while retaining canonical provider casing', () => {
    expect(canonicalProviderRemote('git@github.com:Konghak/PortfolioOps.git')).toEqual({
      host: 'github.com',
      owner: 'Konghak',
      repository: 'PortfolioOps',
      comparisonKey: 'github.com/konghak/portfolioops',
      repositorySelector: 'Konghak/PortfolioOps',
    });
    expect(canonicalProviderRemote('https://github.com/Konghak/PortfolioOps.git')).toEqual({
      host: 'github.com', owner: 'Konghak', repository: 'PortfolioOps',
      comparisonKey: 'github.com/konghak/portfolioops', repositorySelector: 'Konghak/PortfolioOps',
    });
  });

  test('does not case-fold identities for providers not declared case-insensitive', () => {
    const remote = canonicalProviderRemote('https://git.example.com/Owner/Repo.git');
    expect(remote.comparisonKey).toBe('git.example.com/Owner/Repo');
    expect(remote.repositorySelector).toBe('git.example.com/Owner/Repo');
  });

  test('preserves nested GitLab namespaces while GitHub remains owner/repository', () => {
    expect(canonicalProviderRemote('https://gitlab.com/Group/Subgroup/Repo.git')).toEqual({
      host: 'gitlab.com', owner: 'Group/Subgroup', repository: 'Repo',
      comparisonKey: 'gitlab.com/Group/Subgroup/Repo',
      repositorySelector: 'gitlab.com/Group/Subgroup/Repo',
    });
    expect(() => canonicalProviderRemote('https://github.com/Org/Subgroup/Repo.git')).toThrow('provider_remote_invalid');
  });

  test('binds exact PR, immutable repository id, and read-sufficient permission', () => {
    const remote = canonicalProviderRemote('ssh://git@github.com/Konghak/PortfolioOps.git');
    expect(validateProviderAccessSnapshot(remote, 123, {
      repository: { id: 'R_123', nameWithOwner: 'Konghak/PortfolioOps', viewerPermission: 'READ' },
      pullRequest: { number: 123, state: 'OPEN' },
    })).toEqual({
      repositoryNameWithOwner: 'Konghak/PortfolioOps', repositoryNodeId: 'R_123',
      viewerPermission: 'READ', prNumber: 123, prState: 'OPEN',
    });
  });

  test('rejects wrong owner, PR, permission, or closed state before checks can run', () => {
    const remote = canonicalProviderRemote('git@github.com:Konghak/PortfolioOps.git');
    const base = {
      repository: { id: 'R_123', nameWithOwner: 'Konghak/PortfolioOps', viewerPermission: 'READ' },
      pullRequest: { number: 123, state: 'OPEN' },
    };
    expect(() => validateProviderAccessSnapshot(remote, 123, {
      ...base, repository: { ...base.repository, nameWithOwner: 'Other/PortfolioOps' },
    })).toThrow('provider_auth_mismatch');
    expect(() => validateProviderAccessSnapshot(remote, 123, {
      ...base, pullRequest: { number: 124, state: 'OPEN' },
    })).toThrow('provider_pr_mismatch');
    expect(() => validateProviderAccessSnapshot(remote, 123, {
      ...base, repository: { ...base.repository, viewerPermission: 'NONE' },
    })).toThrow('provider_permission_missing');
    expect(() => validateProviderAccessSnapshot(remote, 123, {
      ...base, pullRequest: { number: 123, state: 'CLOSED' },
    })).toThrow('provider_pr_state_invalid');
  });

  test('freezes the provider permission floor by operation class', () => {
    expect(permissionSatisfies('READ', 'read')).toBe(true);
    expect(permissionSatisfies('TRIAGE', 'comment')).toBe(true);
    expect(permissionSatisfies('TRIAGE', 'merge')).toBe(false);
    expect(permissionSatisfies('WRITE', 'merge')).toBe(true);
    expect(permissionSatisfies('ADMIN', 'deploy')).toBe(true);
  });
});
