import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv } from '../lib/private-validator-env';

const roots: string[] = [];
const git = (cwd: string, args: string[]) => { const r = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('private validator environment', () => {
  test('materializes only the exact committed subject without mutating source Git state', () => {
    const source = mkdtempSync(join(tmpdir(), 'validator-source-')); roots.push(source); git(source, ['init', '-b', 'main']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@example.com']); writeFileSync(join(source, 'a.txt'), 'committed\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'base']); const sha = git(source, ['rev-parse', 'HEAD']); writeFileSync(join(source, 'a.txt'), 'dirty\n');
    const before = { status: git(source, ['status', '--porcelain=v1', '--untracked-files=all']), refs: git(source, ['show-ref']) };
    const lease = materializePrivateValidatorEnv({ sourceRepository: source, subjectSha: sha });
    expect(readFileSync(join(lease.checkout_root, 'a.txt'), 'utf8')).toBe('committed\n');
    expect(git(lease.checkout_root, ['rev-parse', 'HEAD'])).toBe(sha); expect(git(lease.checkout_root, ['status', '--porcelain'])).toBe('');
    expect(lease.environment.HOME).toStartWith(lease.lease_root); expect(lease.environment.GIT_TERMINAL_PROMPT).toBe('0'); expect(lease.environment.PYTHONPATH).toBeUndefined(); expect(lease.environment.SSH_AUTH_SOCK).toBeUndefined();
    expect({ status: git(source, ['status', '--porcelain=v1', '--untracked-files=all']), refs: git(source, ['show-ref']) }).toEqual(before);
    const root = lease.lease_root; releasePrivateValidatorEnv(lease); expect(existsSync(root)).toBe(false);
  });
  test('rejects a non-commit subject before creating an executable checkout', () => {
    const source = mkdtempSync(join(tmpdir(), 'validator-source-')); roots.push(source); git(source, ['init', '-b', 'main']);
    expect(() => materializePrivateValidatorEnv({ sourceRepository: source, subjectSha: 'f'.repeat(40) })).toThrow('private_validator_subject_invalid');
  });
});
