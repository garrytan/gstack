import { describe, test, expect } from 'bun:test';
import {
  detectRegime,
  planSubmit,
  classifyLand,
  buildLandState,
  validateConsume,
  isTrunkQueueCheck,
  trunkQueueCheckName,
  LAND_STATE_SCHEMA_VERSION,
  type LandState,
} from '../lib/merge';

describe('detectRegime', () => {
  test('explicit config key wins over everything', () => {
    const r = detectRegime({
      base: 'main',
      configRegime: 'github',
      checks: [{ name: trunkQueueCheckName('main'), state: 'PENDING' }], // would say trunk
      trunkYaml: 'merge:\n  required_statuses: [ci]',
      githubMergeQueue: false,
    });
    expect(r.regime).toBe('github');
    expect(r.source).toBe('config');
  });

  test('invalid config key is ignored and falls through to live signals', () => {
    const r = detectRegime({
      base: 'main',
      configRegime: 'banana',
      checks: [{ name: 'Trunk Merge Queue (main)' }],
      trunkYaml: null,
    });
    expect(r.regime).toBe('trunk');
    expect(r.source).toBe('trunk-status-check');
  });

  test('trunk status check on the PR → trunk (even on a non-main base)', () => {
    const r = detectRegime({
      base: 'develop',
      checks: [{ name: 'Trunk Merge Queue (develop)', state: 'TESTING' }],
      trunkYaml: null,
    });
    expect(r.regime).toBe('trunk');
    expect(r.source).toBe('trunk-status-check');
  });

  test('.trunk/trunk.yaml with a merge: section → trunk (secondary signal)', () => {
    const r = detectRegime({
      base: 'main',
      checks: [{ name: 'build' }, { name: 'test' }],
      trunkYaml: 'version: 0.1\nmerge:\n  required_statuses:\n    - build\n',
    });
    expect(r.regime).toBe('trunk');
    expect(r.source).toBe('trunk-yaml');
  });

  test('bare .trunk/trunk.yaml WITHOUT a merge: section is NOT trunk (check-only false positive guard)', () => {
    const r = detectRegime({
      base: 'main',
      checks: [{ name: 'build' }],
      trunkYaml: 'version: 0.1\ncli:\n  version: 1.22.0\nlint:\n  enabled:\n    - eslint\n',
    });
    expect(r.regime).toBe('none');
    expect(r.source).toBe('default');
  });

  test('github branch-protection merge queue → github', () => {
    const r = detectRegime({
      base: 'main',
      checks: [{ name: 'build' }],
      trunkYaml: null,
      githubMergeQueue: true,
    });
    expect(r.regime).toBe('github');
    expect(r.source).toBe('github-branch-protection');
  });

  test('no signals → none', () => {
    const r = detectRegime({ base: 'main', checks: [], trunkYaml: null });
    expect(r.regime).toBe('none');
    expect(r.source).toBe('default');
  });
});

describe('isTrunkQueueCheck', () => {
  test('matches the queue check name for any branch', () => {
    expect(isTrunkQueueCheck('Trunk Merge Queue (main)')).toBe(true);
    expect(isTrunkQueueCheck('Trunk Merge Queue (release/v2)')).toBe(true);
  });
  test('does not match unrelated checks', () => {
    expect(isTrunkQueueCheck('Trunk Check')).toBe(false);
    expect(isTrunkQueueCheck('build')).toBe(false);
    expect(isTrunkQueueCheck(undefined)).toBe(false);
  });
});

describe('planSubmit', () => {
  test('none → single direct squash with branch delete', () => {
    const p = planSubmit('none', 42);
    expect(p.deleteBranch).toBe(true);
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0].args).toEqual(['pr', 'merge', '42', '--squash', '--delete-branch']);
  });

  test('github → auto-merge first, squash fallback', () => {
    const p = planSubmit('github', 42);
    expect(p.deleteBranch).toBe(true);
    expect(p.candidates[0].args).toContain('--auto');
    expect(p.candidates[1].args).toContain('--squash');
  });

  test('trunk is comment-first and never deletes the branch', () => {
    const p = planSubmit('trunk', 7, { trunkCliAvailable: false, trunkToken: false });
    expect(p.deleteBranch).toBe(false);
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0].cmd).toBe('gh');
    expect(p.candidates[0].args).toEqual(['pr', 'comment', '7', '--body', '/trunk merge']);
    // No gh pr merge anywhere in the trunk plan.
    expect(p.candidates.some((c) => c.args.includes('merge') && c.cmd === 'gh' && c.args.includes('pr') && c.args[1] === 'merge')).toBe(false);
  });

  test('trunk adds CLI then REST as opportunistic fallbacks, in order', () => {
    const p = planSubmit('trunk', 7, { trunkCliAvailable: true, trunkToken: true });
    expect(p.candidates.map((c) => c.cmd)).toEqual(['gh', 'trunk', 'trunk-rest']);
  });

  test('trunk priority threads into the comment body and CLI', () => {
    const p = planSubmit('trunk', 7, { trunkCliAvailable: true, priority: 'high' });
    expect(p.candidates[0].args).toContain('/trunk merge --priority=high');
    expect(p.candidates[1].args).toEqual(['merge', '7', '--priority', 'high']);
  });
});

describe('classifyLand', () => {
  test('MERGED with a merge SHA → landed', () => {
    const c = classifyLand({ state: 'MERGED', mergeCommitOid: 'abc123', baseContainsHead: false });
    expect(c.status).toBe('landed');
  });

  test('MERGED with null SHA but base contains head → landed (rebase-merge case, H3)', () => {
    const c = classifyLand({ state: 'MERGED', mergeCommitOid: null, baseContainsHead: true });
    expect(c.status).toBe('landed');
  });

  test('MERGED but SHA not visible and base does not yet contain head → pending (squash lag)', () => {
    const c = classifyLand({ state: 'MERGED', mergeCommitOid: null, baseContainsHead: false });
    expect(c.status).toBe('pending');
  });

  test('OPEN with a failed queue check → ejected', () => {
    const c = classifyLand({
      state: 'OPEN',
      mergeCommitOid: null,
      baseContainsHead: false,
      queueCheck: { name: 'Trunk Merge Queue (main)', state: 'FAILURE' },
    });
    expect(c.status).toBe('ejected');
  });

  test('OPEN with a cancelled queue check → ejected', () => {
    const c = classifyLand({
      state: 'OPEN',
      mergeCommitOid: null,
      baseContainsHead: false,
      queueCheck: { name: 'Trunk Merge Queue (main)', bucket: 'CANCELLED' },
    });
    expect(c.status).toBe('ejected');
  });

  test('OPEN with a still-testing queue check → pending', () => {
    const c = classifyLand({
      state: 'OPEN',
      mergeCommitOid: null,
      baseContainsHead: false,
      queueCheck: { name: 'Trunk Merge Queue (main)', state: 'IN_PROGRESS' },
    });
    expect(c.status).toBe('pending');
  });

  test('CLOSED → closed', () => {
    const c = classifyLand({ state: 'CLOSED', mergeCommitOid: null, baseContainsHead: false });
    expect(c.status).toBe('closed');
  });
});

describe('buildLandState', () => {
  const base = {
    pr: 12,
    sha: 'deadbeef',
    headRefOid: 'cafe',
    base: 'main',
    head_branch: 'feat/x',
    repo: 'owner/name',
    regime: 'trunk' as const,
    ts: '2026-05-31T00:00:00.000Z',
  };

  test('assembles a schema-versioned state', () => {
    const s = buildLandState(base);
    expect(s.schema_version).toBe(LAND_STATE_SCHEMA_VERSION);
    expect(s.sha).toBe('deadbeef');
    expect(s.repo).toBe('owner/name');
    // scope is intentionally absent (T2 — parent recomputes diff-scope).
    expect('scope' in s).toBe(false);
  });

  test('refuses to build with an empty SHA (handoff would silently kill revert)', () => {
    expect(() => buildLandState({ ...base, sha: '' })).toThrow(/empty merge SHA/);
  });
});

describe('validateConsume', () => {
  const now = Date.parse('2026-05-31T01:00:00.000Z');
  const good: LandState = {
    schema_version: LAND_STATE_SCHEMA_VERSION,
    pr: 12,
    sha: 'deadbeef',
    headRefOid: 'cafe',
    base: 'main',
    head_branch: 'feat/x',
    repo: 'owner/name',
    regime: 'trunk',
    ts: '2026-05-31T00:30:00.000Z',
  };

  test('accepts a matching recent state', () => {
    expect(validateConsume(good, { pr: 12, repo: 'owner/name' }, now).ok).toBe(true);
  });

  test('rejects when no state file', () => {
    const v = validateConsume(null, { pr: 12, repo: 'owner/name' }, now);
    expect(v.ok).toBe(false);
  });

  test('rejects a state for a different PR (stale-state-drives-wrong-deploy, H5)', () => {
    const v = validateConsume(good, { pr: 99, repo: 'owner/name' }, now);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/PR #12/);
  });

  test('rejects a state for a different repo', () => {
    const v = validateConsume(good, { pr: 12, repo: 'other/name' }, now);
    expect(v.ok).toBe(false);
  });

  test('rejects a stale state past max age', () => {
    const stale = { ...good, ts: '2026-05-30T00:00:00.000Z' };
    const v = validateConsume(stale, { pr: 12, repo: 'owner/name' }, now);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/stale/);
  });

  test('rejects an empty SHA', () => {
    const v = validateConsume({ ...good, sha: '' }, { pr: 12, repo: 'owner/name' }, now);
    expect(v.ok).toBe(false);
  });

  test('rejects a schema_version mismatch', () => {
    const v = validateConsume({ ...good, schema_version: 99 }, { pr: 12, repo: 'owner/name' }, now);
    expect(v.ok).toBe(false);
  });
});
