import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type ProviderAccess = typeof import('../lib/provider-access');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fakeGh(root: string, response: unknown): string {
  const executable = path.join(root, `gh-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(response)}'\n`, { mode: 0o700 });
  return executable;
}

describe('provider merge verification', () => {
  test('binds the returned merge commit to the frozen base and validated head tree', async () => {
    const provider = await import('../lib/provider-access') as ProviderAccess & {
      verifyProviderMergeCommit?: (...args: any[]) => Promise<unknown>;
    };
    expect(provider.verifyProviderMergeCommit).toBeFunction();
    if (!provider.verifyProviderMergeCommit) return;

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-merge-verify-')); roots.push(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n');
    git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'base');
    const baseOid = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'value.txt'), 'head\n');
    git(repo, 'commit', '-qam', 'head');
    const headOid = git(repo, 'rev-parse', 'HEAD');
    const headTree = git(repo, 'rev-parse', `${headOid}^{tree}`);
    const mergeSha = '3'.repeat(40);
    const validGh = fakeGh(repo, { sha: mergeSha, tree: { sha: headTree }, parents: [{ sha: baseOid }] });

    await expect(provider.verifyProviderMergeCommit(repo, {
      gitPath: '/usr/bin/git', ghPath: validGh, host: 'github.com', repositorySelector: 'owner/repo',
      expectedBaseOid: baseOid, expectedHeadOid: headOid, mergeSha,
    })).resolves.toEqual({ mergeSha, mergeTree: headTree, mergeParents: [baseOid], mergeTreeMatches: true });

    const racedGh = fakeGh(repo, { sha: mergeSha, tree: { sha: headTree }, parents: [{ sha: '4'.repeat(40) }] });
    await expect(provider.verifyProviderMergeCommit(repo, {
      gitPath: '/usr/bin/git', ghPath: racedGh, host: 'github.com', repositorySelector: 'owner/repo',
      expectedBaseOid: baseOid, expectedHeadOid: headOid, mergeSha,
    })).rejects.toThrow('base_race_detected');
  });
});
