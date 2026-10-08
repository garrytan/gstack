import { readBoundedResponse, sha256, type Fetcher } from './model-policy-freshness-sources';
import { FRESHNESS_ISSUE_AUTHOR, type FreshnessGitHub, type TrackingIssue } from './model-policy-freshness-publication';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function issueFromJson(value: unknown): TrackingIssue {
  if (!object(value) || !Number.isSafeInteger(value.number) || Number(value.number) <= 0 || (value.body !== null && typeof value.body !== 'string') || !['open', 'closed'].includes(String(value.state)) || !object(value.user) || typeof value.user.login !== 'string') throw new Error('github-invalid-issue');
  return { number: Number(value.number), body: value.body === null ? '' : value.body as string, state: value.state as 'open' | 'closed', author: value.user.login };
}

export function freshnessGitHub(repository: string, token: string, fetcher: Fetcher = fetch): FreshnessGitHub {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error('github-publication-prerequisites-missing');
  const root = `https://api.github.com/repos/${repository}`;
  async function request(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
    if (signal.aborted) throw new Error('github-publication-aborted');
    const response = await fetcher(`${root}${path}`, {
      method, signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`github-http-${response.status}`); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedResponse(response))); }
    catch { throw new Error('github-invalid-or-oversized-response'); }
  }
  return {
    async defaultCatalog(signal) {
      const repo = await request('', signal);
      if (!object(repo) || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error('github-default-branch-unavailable');
      const file = await request(`/contents/lib/model-catalog.ts?ref=${encodeURIComponent(repo.default_branch)}`, signal);
      if (!object(file) || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.size !== 'number' || file.size <= 0 || file.size > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/=\n\r]+$/.test(file.content)) throw new Error('github-default-catalog-unavailable');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length !== file.size) throw new Error('github-default-catalog-size-mismatch');
      return { defaultBranch: repo.default_branch, sourceSha256: sha256(bytes) };
    },
    async listIssues(signal) {
      const issues: TrackingIssue[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await request(`/issues?state=all&creator=${encodeURIComponent(FRESHNESS_ISSUE_AUTHOR)}&per_page=100&page=${page}`, signal);
        if (!Array.isArray(result)) throw new Error('github-issue-list-unavailable');
        for (const value of result) {
          const issue = issueFromJson(value);
          if (issue.author !== FRESHNESS_ISSUE_AUTHOR) throw new Error('github-issue-owner-filter-mismatch');
          if (object(value) && !value.pull_request) issues.push(issue);
        }
        if (result.length < 100) return issues;
      }
      throw new Error('github-issue-pagination-limit');
    },
    async readIssue(number, signal) { return issueFromJson(await request(`/issues/${number}`, signal)); },
    async createIssue(body, signal) { return issueFromJson(await request('/issues', signal, 'POST', { title: 'Model-policy freshness: advisory maintenance', body })); },
    async updateIssue(number, update, signal) { await request(`/issues/${number}`, signal, 'PATCH', update); },
  };
}
