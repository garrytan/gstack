import type { ProviderRemote } from './provider-access';

export type ProviderPrKind = 'github' | 'gitlab';

export interface ProviderPrIdentity {
  number: number;
  url: string;
}

export interface DiscoveredProviderPr extends ProviderPrIdentity {
  title: string;
}

export function providerPrRepositorySelector(provider: ProviderPrKind, remote: ProviderRemote): string {
  return provider === 'github'
    ? remote.repositorySelector
    : `https://${remote.host}/${remote.owner}/${remote.repository}`;
}

function positivePr(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('provider_pr_number_invalid');
  return value as number;
}

export function resolveProviderPrKind(remote: ProviderRemote, asserted?: ProviderPrKind): ProviderPrKind {
  const known = remote.host === 'github.com'
    ? 'github'
    : remote.host === 'gitlab.com' || remote.host.includes('gitlab')
      ? 'gitlab'
      : null;
  if (known && asserted && asserted !== known) throw new Error('provider_pr_provider_mismatch');
  if (known) return known;
  if (!asserted || !['github', 'gitlab'].includes(asserted)) throw new Error('provider_pr_provider_unknown');
  return asserted;
}

export function buildProviderPrMutationArgs(input: {
  provider: ProviderPrKind;
  action: 'create' | 'update';
  repositorySelector: string;
  base?: string;
  head?: string;
  pr?: number;
  title: string;
  bodyFile: string;
}): string[] {
  if (input.action === 'update') {
    const pr = String(positivePr(input.pr));
    return input.provider === 'github'
      ? ['pr', 'edit', pr, '--repo', input.repositorySelector, '--title', input.title, '--body-file', input.bodyFile]
      : ['mr', 'update', pr, '--repo', input.repositorySelector, '--title', input.title, '--description-file', input.bodyFile];
  }
  if (!input.base || !input.head) throw new Error('provider_pr_branch_invalid');
  return input.provider === 'github'
    ? ['pr', 'create', '--repo', input.repositorySelector, '--base', input.base, '--head', input.head,
      '--title', input.title, '--body-file', input.bodyFile]
    : ['mr', 'create', '--repo', input.repositorySelector, '--target-branch', input.base,
      '--source-branch', input.head, '--title', input.title, '--description-file', input.bodyFile, '--yes'];
}

export function buildProviderPrViewArgs(provider: ProviderPrKind, repositorySelector: string, pr: number): string[] {
  const exactPr = String(positivePr(pr));
  return provider === 'github'
    ? ['pr', 'view', exactPr, '--repo', repositorySelector, '--json', 'number,url,state,title,headRefName,headRepository']
    : ['mr', 'view', exactPr, '--repo', repositorySelector, '-F', 'json'];
}

export function buildProviderPrDiscoveryArgs(
  provider: ProviderPrKind,
  repositorySelector: string,
  head: string,
): string[] {
  return provider === 'github'
    ? ['pr', 'list', '--repo', repositorySelector, '--head', head, '--state', 'open', '--limit', '2',
      '--json', 'number,url,state,title,headRefName,headRepository']
    : ['mr', 'list', '--repo', repositorySelector, '--source-branch', head,
      '--per-page', '2', '--output', 'json'];
}

function exactUrl(provider: ProviderPrKind, remote: ProviderRemote, pr: number, raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw new Error('provider_pr_result_invalid');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('provider_pr_result_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== remote.host
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('provider_pr_result_invalid');
  }
  const expectedPath = provider === 'github'
    ? `/${remote.owner}/${remote.repository}/pull/${pr}`
    : `/${remote.owner}/${remote.repository}/-/merge_requests/${pr}`;
  const observedPath = parsed.pathname.replace(/\/$/, '');
  const pathMatches = provider === 'github'
    ? observedPath.toLowerCase() === expectedPath.toLowerCase()
    : observedPath === expectedPath;
  if (!pathMatches) throw new Error('provider_pr_result_invalid');
  return `https://${remote.host}${expectedPath}`;
}

export function parseProviderPrCreateOutput(
  provider: ProviderPrKind,
  remote: ProviderRemote,
  raw: string,
): ProviderPrIdentity {
  const candidates = raw.match(/https:\/\/[^\s]+/g) ?? [];
  for (const candidate of candidates.reverse()) {
    const match = provider === 'github'
      ? candidate.match(/\/pull\/([1-9][0-9]*)(?:\/?$)/)
      : candidate.match(/\/-\/merge_requests\/([1-9][0-9]*)(?:\/?$)/);
    if (!match) continue;
    const number = positivePr(Number(match[1]));
    try { return { number, url: exactUrl(provider, remote, number, candidate) }; } catch { /* try the next URL */ }
  }
  throw new Error('provider_pr_result_invalid');
}

export function validateProviderPrSnapshot(
  provider: ProviderPrKind,
  remote: ProviderRemote,
  expected: { pr: number; head: string; title?: string },
  raw: string,
): ProviderPrIdentity {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('provider_pr_snapshot_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_pr_snapshot_invalid');
  const row = value as Record<string, unknown>;
  const number = provider === 'github' ? row.number : row.iid;
  const url = provider === 'github' ? row.url : row.web_url;
  const expectedState = provider === 'github' ? 'OPEN' : 'opened';
  try {
    if (positivePr(number) !== positivePr(expected.pr) || row.state !== expectedState
      || typeof row.title !== 'string' || !row.title
      || (expected.title !== undefined && row.title !== expected.title)) {
      throw new Error('provider_pr_snapshot_invalid');
    }
    if (provider === 'github') {
      const headRepository = row.headRepository as Record<string, unknown> | null | undefined;
      const expectedName = `${remote.owner}/${remote.repository}`;
      if (row.headRefName !== expected.head || !headRepository
        || typeof headRepository.nameWithOwner !== 'string'
        || headRepository.nameWithOwner.toLowerCase() !== expectedName.toLowerCase()) {
        throw new Error('provider_pr_snapshot_invalid');
      }
    } else if (row.source_branch !== expected.head
      || positivePr(row.source_project_id) !== positivePr(row.target_project_id)) {
      throw new Error('provider_pr_snapshot_invalid');
    }
    return { number: expected.pr, url: exactUrl(provider, remote, expected.pr, url) };
  } catch (error) {
    if (error instanceof Error && error.message === 'provider_pr_snapshot_invalid') throw error;
    throw new Error('provider_pr_snapshot_invalid');
  }
}

export function parseProviderPrDiscovery(
  provider: ProviderPrKind,
  remote: ProviderRemote,
  expected: { head: string },
  raw: string,
): DiscoveredProviderPr | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('provider_pr_discovery_invalid'); }
  if (!Array.isArray(value)) throw new Error('provider_pr_discovery_invalid');
  if (value.length === 0) return null;
  if (value.length !== 1) throw new Error('provider_pr_discovery_ambiguous');
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('provider_pr_discovery_invalid');
  const snapshot = row as Record<string, unknown>;
  const pr = provider === 'github' ? snapshot.number : snapshot.iid;
  if (!Number.isSafeInteger(pr) || (pr as number) <= 0) throw new Error('provider_pr_discovery_invalid');
  let identity: ProviderPrIdentity;
  try {
    identity = validateProviderPrSnapshot(provider, remote, { pr: pr as number, head: expected.head }, JSON.stringify(row));
  } catch {
    throw new Error('provider_pr_discovery_invalid');
  }
  if (typeof snapshot.title !== 'string' || !snapshot.title) throw new Error('provider_pr_discovery_invalid');
  return { ...identity, title: snapshot.title };
}
