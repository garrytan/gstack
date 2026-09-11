import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchTrustedGithubClaimed } from '../lib/release-queue';

const roots: string[] = [];
afterAll(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

const base = 'a'.repeat(40);
const subject = 'b'.repeat(40);
const projection = { path: 'VERSION', format: 'plain_text', selector: 'whole_file' } as const;
const remote = { hostname: 'github.com', slug: 'owner/repo', selector: 'github.com/owner/repo', owner: 'owner', repository: 'repo' };

function observe(node: Record<string, unknown>, refs: unknown[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-queue-')); roots.push(root);
  const prPage = JSON.stringify({ data: { repository: {
    id: 'R_1', nameWithOwner: 'owner/repo', viewerPermission: 'READ',
    ref: { target: { oid: base } },
    pullRequests: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
  } } });
  const refPage = JSON.stringify({ data: { repository: {
    id: 'R_1', nameWithOwner: 'owner/repo', viewerPermission: 'READ',
    ref: { target: { oid: base } },
    refs: { nodes: refs, pageInfo: { hasNextPage: false, endCursor: null } },
  } } });
  const content = JSON.stringify({ encoding: 'base64', content: Buffer.from('1.0.1\n').toString('base64') });
  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh
case "$*" in
  *pullRequests*) printf '%s\\n' '${prPage}' ;;
  *refs\\(refPrefix*) printf '%s\\n' '${refPage}' ;;
  *) printf '%s\\n' '${content}' ;;
esac
`, { mode: 0o755 });
  return fetchTrustedGithubClaimed(gh, 'main', projection, base, subject, 'feature', remote);
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    baseRefName: 'main',
    headRefName: 'feature',
    headRefOid: subject,
    headRepository: { id: 'R_1', nameWithOwner: 'owner/repo' },
    url: 'https://github.com/owner/repo/pull/7',
    isDraft: false,
    ...overrides,
  };
}

describe('trusted release queue PR identity', () => {
  test('emits current PR identity only for the exact repository/base/ref/head tuple', () => {
    const result = observe(pr(), [{ name: 'feature', target: { oid: subject } }]);
    expect(result.possibleSelfClaim).toBe(true);
    expect(result.currentPrIdentity).toEqual({
      number: 7,
      base_oid: base,
      head_oid: subject,
      head_repository_node_id: 'R_1',
      head_ref: 'feature',
    });
    expect(result.claimed).toEqual([
      { pr: 0, branch: 'origin/feature', version: '1.0.1' },
      { pr: 7, branch: 'feature', version: '1.0.1', url: 'https://github.com/owner/repo/pull/7' },
    ]);
    expect(result.exactSelfClaim).toEqual({
      identity: result.currentPrIdentity,
      repository_node_id: 'R_1',
      version: '1.0.1',
      claimed: [],
      snapshot: JSON.stringify({ repositoryId: 'R_1', repository: 'owner/repo', base: 'main', targetSha: base, rows: [], refs: [] }),
    });
    expect(result.unresolvedSelfClaim).toBe(false);
  });

  test('does not mint an exclusion when the exact ref is missing or an overlapping alias remains', () => {
    const missing = observe(pr());
    expect(missing.currentPrIdentity).not.toBeNull();
    expect(missing.exactSelfClaim).toBeNull();
    expect(missing.unresolvedSelfClaim).toBe(true);

    const aliased = observe(pr(), [
      { name: 'feature', target: { oid: subject } },
      { name: 'feature-alias', target: { oid: subject } },
    ]);
    expect(aliased.exactSelfClaim).toBeNull();
    expect(aliased.unresolvedSelfClaim).toBe(true);
    expect(aliased.claimed.some(item => item.branch === 'origin/feature-alias')).toBe(true);
  });

  test.each([
    ['wrong head OID', pr({ headRefOid: 'c'.repeat(40) })],
    ['wrong head ref', pr({ headRefName: 'renamed' })],
    ['wrong base ref', pr({ baseRefName: 'release' })],
    ['fork repository', pr({ headRepository: { id: 'R_fork', nameWithOwner: 'fork/repo' } })],
  ])('keeps %s as a conservative possible-self blocker without minting identity', (_label, node) => {
    const result = observe(node);
    expect(result.possibleSelfClaim).toBe(true);
    expect(result.currentPrIdentity).toBeNull();
    if ((node as { baseRefName: string }).baseRefName === 'main') expect(result.claimed).toHaveLength(1);
  });
});
