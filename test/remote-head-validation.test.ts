import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withRemoteHead } from '../lib/remote-head-validation';

const roots: string[] = []; const git = (cwd: string, args: string[]) => { const r = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('exact remote head validation', () => {
  test('binds callback to exact head/base and cleans its private checkout', () => {
    const source = mkdtempSync(join(tmpdir(), 'remote-subject-')); roots.push(source); git(source, ['init', '-b', 'main']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@example.com']); writeFileSync(join(source, 'a.txt'), 'base\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'base']); const base = git(source, ['rev-parse', 'HEAD']); git(source, ['switch', '-c', 'feature']); writeFileSync(join(source, 'a.txt'), 'head\n'); git(source, ['commit', '-am', 'head']); const head = git(source, ['rev-parse', 'HEAD']);
    let leaseRoot = '';
    const result = withRemoteHead({ sourceRepository: source, repoId: 'fixture', prNumber: 4, baseRef: 'main', baseSha: base, headSha: head }, (subject) => { leaseRoot = subject.lease_root; expect(subject.remote_pr_head_sha).toBe(head); expect(subject.base_sha).toBe(base); expect(git(subject.checkout_root, ['rev-parse', 'HEAD'])).toBe(head); return 'ok'; });
    expect(result).toBe('ok'); expect(() => git(leaseRoot, ['status'])).toThrow();
  });
  test('rejects non-ancestral or mismatched assertions without invoking callback', () => {
    const source = mkdtempSync(join(tmpdir(), 'remote-subject-')); roots.push(source); git(source, ['init', '-b', 'main']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@example.com']); writeFileSync(join(source, 'a'), 'x'); git(source, ['add', '.']); git(source, ['commit', '-m', 'one']); const head = git(source, ['rev-parse', 'HEAD']); let called = 0;
    expect(() => withRemoteHead({ sourceRepository: source, repoId: 'fixture', prNumber: 1, baseRef: 'main', baseSha: 'f'.repeat(40), headSha: head }, () => { called++; })).toThrow('remote_head_base_invalid'); expect(called).toBe(0);
  });
});
