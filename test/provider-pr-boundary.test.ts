import { describe, expect, test } from 'bun:test';
import {
  buildProviderPrMutationArgs,
  buildProviderPrDiscoveryArgs,
  buildProviderPrViewArgs,
  parseProviderPrDiscovery,
  parseProviderPrCreateOutput,
  providerPrRepositorySelector,
  resolveProviderPrKind,
  validateProviderPrSnapshot,
} from '../lib/provider-pr-boundary';
import { canonicalProviderRemote } from '../lib/provider-access';

describe('provider PR closed boundary', () => {
  test('selects the public provider from the canonical remote and rejects a conflicting assertion', () => {
    const github = canonicalProviderRemote('git@github.com:Acme/widget.git');
    const gitlab = canonicalProviderRemote('https://gitlab.com/acme/widget.git');
    expect(resolveProviderPrKind(github)).toBe('github');
    expect(resolveProviderPrKind(gitlab)).toBe('gitlab');
    expect(() => resolveProviderPrKind(github, 'gitlab')).toThrow('provider_pr_provider_mismatch');
    expect(() => resolveProviderPrKind(gitlab, 'github')).toThrow('provider_pr_provider_mismatch');
  });

  test('requires an asserted provider only for an otherwise ambiguous enterprise host', () => {
    const enterprise = canonicalProviderRemote('ssh://git@git.internal.example/acme/widget.git');
    expect(() => resolveProviderPrKind(enterprise)).toThrow('provider_pr_provider_unknown');
    expect(resolveProviderPrKind(enterprise, 'github')).toBe('github');
    expect(resolveProviderPrKind(enterprise, 'gitlab')).toBe('gitlab');
  });

  test('uses provider-native exact repository selectors', () => {
    const github = canonicalProviderRemote('ssh://git@ghe.example/acme/widget.git');
    const gitlab = canonicalProviderRemote('ssh://git@gitlab.example/acme/widget.git');
    expect(providerPrRepositorySelector('github', github)).toBe('ghe.example/acme/widget');
    expect(providerPrRepositorySelector('gitlab', gitlab)).toBe('https://gitlab.example/acme/widget');
    expect(providerPrRepositorySelector('gitlab', canonicalProviderRemote('https://gitlab.com/acme/platform/widget.git'))).toBe('https://gitlab.com/acme/platform/widget');
  });

  test('builds provider-specific create and exact-number update commands', () => {
    expect(buildProviderPrMutationArgs({
      provider: 'github', action: 'create', repositorySelector: 'Acme/widget',
      base: 'main', head: 'feature/exact', title: 'feat: exact', bodyFile: '-',
    })).toEqual([
      'pr', 'create', '--repo', 'Acme/widget', '--base', 'main', '--head', 'feature/exact',
      '--title', 'feat: exact', '--body-file', '-',
    ]);
    expect(buildProviderPrMutationArgs({
      provider: 'gitlab', action: 'create', repositorySelector: 'https://gitlab.com/acme/widget',
      base: 'main', head: 'feature/exact', title: 'feat: exact', bodyFile: '-',
    })).toEqual([
      'mr', 'create', '--repo', 'https://gitlab.com/acme/widget', '--target-branch', 'main',
      '--source-branch', 'feature/exact', '--title', 'feat: exact',
      '--description-file', '-', '--yes',
    ]);
    expect(buildProviderPrMutationArgs({
      provider: 'github', action: 'update', repositorySelector: 'Acme/widget',
      pr: 41, title: 'feat: exact', bodyFile: '-',
    }).slice(0, 3)).toEqual(['pr', 'edit', '41']);
    expect(buildProviderPrMutationArgs({
      provider: 'gitlab', action: 'update', repositorySelector: 'https://gitlab.com/acme/widget',
      pr: 41, title: 'feat: exact', bodyFile: '-',
    }).slice(0, 3)).toEqual(['mr', 'update', '41']);
    expect(() => buildProviderPrMutationArgs({
      provider: 'github', action: 'update', repositorySelector: 'Acme/widget',
      title: 'feat: exact', bodyFile: '-',
    })).toThrow('provider_pr_number_invalid');
  });

  test('uses an exact numbered view after either provider mutation', () => {
    expect(buildProviderPrViewArgs('github', 'Acme/widget', 41)).toEqual([
      'pr', 'view', '41', '--repo', 'Acme/widget', '--json', 'number,url,state,title,headRefName,headRepository',
    ]);
    expect(buildProviderPrViewArgs('gitlab', 'https://gitlab.com/acme/widget', 41)).toEqual([
      'mr', 'view', '41', '--repo', 'https://gitlab.com/acme/widget', '-F', 'json',
    ]);
  });

  test('builds branch-bound discovery commands for the attested provider CLI', () => {
    expect(buildProviderPrDiscoveryArgs('github', 'Acme/widget', 'feature/exact')).toEqual([
      'pr', 'list', '--repo', 'Acme/widget', '--head', 'feature/exact', '--state', 'open', '--limit', '2',
      '--json', 'number,url,state,title,headRefName,headRepository',
    ]);
    expect(buildProviderPrDiscoveryArgs('gitlab', 'https://gitlab.com/acme/widget', 'feature/exact')).toEqual([
      'mr', 'list', '--repo', 'https://gitlab.com/acme/widget', '--source-branch', 'feature/exact',
      '--per-page', '2', '--output', 'json',
    ]);
  });

  test('discovers at most one same-repository open PR for the exact branch', () => {
    const github = canonicalProviderRemote('git@github.com:Acme/widget.git');
    const gitlab = canonicalProviderRemote('https://gitlab.com/acme/widget.git');
    expect(parseProviderPrDiscovery('github', github, { head: 'feature/exact' }, '[]')).toBeNull();
    expect(parseProviderPrDiscovery('github', github, { head: 'feature/exact' }, JSON.stringify([{
      number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'old title',
      headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' },
    }]))).toEqual({ number: 41, url: 'https://github.com/Acme/widget/pull/41', title: 'old title' });
    expect(parseProviderPrDiscovery('gitlab', gitlab, { head: 'feature/exact' }, JSON.stringify([{
      iid: 52, web_url: 'https://gitlab.com/acme/widget/-/merge_requests/52', state: 'opened', title: 'old title',
      source_branch: 'feature/exact', source_project_id: 91, target_project_id: 91,
    }]))).toEqual({ number: 52, url: 'https://gitlab.com/acme/widget/-/merge_requests/52', title: 'old title' });
    expect(() => parseProviderPrDiscovery('github', github, { head: 'feature/exact' }, JSON.stringify([
      { number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'one', headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' } },
      { number: 42, url: 'https://github.com/Acme/widget/pull/42', state: 'OPEN', title: 'two', headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' } },
    ]))).toThrow('provider_pr_discovery_ambiguous');
  });

  test('extracts only an exact repository URL from create output', () => {
    const github = canonicalProviderRemote('git@github.com:Acme/widget.git');
    const gitlab = canonicalProviderRemote('https://gitlab.com/acme/widget.git');
    expect(parseProviderPrCreateOutput('github', github, 'Created\nhttps://github.com/Acme/widget/pull/41\n')).toEqual({
      number: 41, url: 'https://github.com/Acme/widget/pull/41',
    });
    expect(parseProviderPrCreateOutput('gitlab', gitlab, 'https://gitlab.com/acme/widget/-/merge_requests/52\n')).toEqual({
      number: 52, url: 'https://gitlab.com/acme/widget/-/merge_requests/52',
    });
    expect(() => parseProviderPrCreateOutput('github', github, 'https://github.com/other/widget/pull/41')).toThrow('provider_pr_result_invalid');
    expect(() => parseProviderPrCreateOutput('gitlab', gitlab, 'https://gitlab.com/acme/widget/-/merge_requests/not-a-number')).toThrow('provider_pr_result_invalid');
  });

  test('validates exact open identity, title and URL from provider-specific snapshots', () => {
    const github = canonicalProviderRemote('git@github.com:Acme/widget.git');
    const gitlab = canonicalProviderRemote('https://gitlab.com/acme/widget.git');
    expect(validateProviderPrSnapshot('github', github, { pr: 41, title: 'feat: exact', head: 'feature/exact' }, JSON.stringify({
      number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'feat: exact',
      headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' },
    }))).toEqual({ number: 41, url: 'https://github.com/Acme/widget/pull/41' });
    expect(validateProviderPrSnapshot('gitlab', gitlab, { pr: 52, title: 'feat: exact', head: 'feature/exact' }, JSON.stringify({
      iid: 52, web_url: 'https://gitlab.com/acme/widget/-/merge_requests/52', state: 'opened', title: 'feat: exact',
      source_branch: 'feature/exact', source_project_id: 91, target_project_id: 91,
    }))).toEqual({ number: 52, url: 'https://gitlab.com/acme/widget/-/merge_requests/52' });
    expect(() => validateProviderPrSnapshot('github', github, { pr: 41, title: 'feat: exact', head: 'feature/exact' }, JSON.stringify({
      number: 42, url: 'https://github.com/Acme/widget/pull/42', state: 'OPEN', title: 'feat: exact',
      headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' },
    }))).toThrow('provider_pr_snapshot_invalid');
    expect(() => validateProviderPrSnapshot('gitlab', gitlab, { pr: 52, title: 'feat: exact', head: 'feature/exact' }, JSON.stringify({
      iid: 52, web_url: 'https://gitlab.com/acme/widget/-/merge_requests/52', state: 'merged', title: 'feat: exact',
      source_branch: 'feature/exact', source_project_id: 91, target_project_id: 91,
    }))).toThrow('provider_pr_snapshot_invalid');
  });

  test('pre-mutation validation binds the exact numbered PR to the local same-repository branch', () => {
    const github = canonicalProviderRemote('git@github.com:Acme/widget.git');
    const gitlab = canonicalProviderRemote('https://gitlab.com/acme/widget.git');
    expect(validateProviderPrSnapshot('github', github, { pr: 41, head: 'feature/exact' }, JSON.stringify({
      number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'old title',
      headRefName: 'feature/exact', headRepository: { nameWithOwner: 'Acme/widget' },
    }))).toEqual({ number: 41, url: 'https://github.com/Acme/widget/pull/41' });
    expect(() => validateProviderPrSnapshot('github', github, { pr: 41, head: 'feature/exact' }, JSON.stringify({
      number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'old title',
      headRefName: 'other-branch', headRepository: { nameWithOwner: 'Acme/widget' },
    }))).toThrow('provider_pr_snapshot_invalid');
    expect(() => validateProviderPrSnapshot('github', github, { pr: 41, head: 'feature/exact' }, JSON.stringify({
      number: 41, url: 'https://github.com/Acme/widget/pull/41', state: 'OPEN', title: 'old title',
      headRefName: 'feature/exact', headRepository: { nameWithOwner: 'fork/widget' },
    }))).toThrow('provider_pr_snapshot_invalid');
    expect(() => validateProviderPrSnapshot('gitlab', gitlab, { pr: 52, head: 'feature/exact' }, JSON.stringify({
      iid: 52, web_url: 'https://gitlab.com/acme/widget/-/merge_requests/52', state: 'opened', title: 'old title',
      source_branch: 'feature/exact', source_project_id: 92, target_project_id: 91,
    }))).toThrow('provider_pr_snapshot_invalid');
  });
});
