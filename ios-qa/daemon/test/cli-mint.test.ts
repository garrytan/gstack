// CLI tests for gstack-ios-qa-mint. Invokes the bash launcher end-to-end
// so we catch any breakage between bin/, the entry-point resolution, and
// the underlying allowlist primitives. Runs against a temp allowlist path
// so the user's real ~/.gstack/ios-qa-allowlist.json is untouched.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..', '..', '..');
const MINT_BIN = join(ROOT, 'bin', 'gstack-ios-qa-mint');
const DAEMON_BIN = join(ROOT, 'bin', 'gstack-ios-qa-daemon');

function runMint(args: string[]) {
  return spawnSync(MINT_BIN, args, { stdio: 'pipe', encoding: 'utf-8' });
}

describe('bin/gstack-ios-qa-mint launcher', () => {
  let tmpDir: string;
  let listPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ios-qa-cli-mint-'));
    listPath = join(tmpDir, 'allowlist.json');
  });

  test('--help prints usage without touching allowlist', () => {
    const r = runMint(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gstack-ios-qa-mint');
    expect(r.stdout).toContain('grant');
    expect(r.stdout).toContain('revoke');
    expect(r.stdout).toContain('list');
  });

  test('grant + list + revoke roundtrip', () => {
    const grant = runMint([
      'grant', '--remote', 'alice@example.com',
      '--capability', 'interact',
      '--allowlist-path', listPath,
    ]);
    expect(grant.status).toBe(0);
    expect(grant.stdout).toContain('granted alice@example.com');

    // File must exist and be mode 0600 (owner-only). Mint creates the
    // parent directory with 0700 + writes the file at 0600.
    expect(existsSync(listPath)).toBe(true);
    const mode = statSync(listPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const list = runMint(['list', '--allowlist-path', listPath]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('alice@example.com');
    expect(list.stdout).toContain('cap=interact');

    const revoke = runMint(['revoke', '--remote', 'alice@example.com', '--allowlist-path', listPath]);
    expect(revoke.status).toBe(0);

    const listAfter = runMint(['list', '--allowlist-path', listPath]);
    expect(listAfter.status).toBe(0);
    expect(listAfter.stdout).toContain('(empty allowlist)');
  });

  test('grant without --remote exits non-zero with clear error', () => {
    const r = runMint(['grant', '--capability', 'interact', '--allowlist-path', listPath]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--remote');
  });

  test('rejects unknown capability', () => {
    const r = runMint([
      'grant', '--remote', 'alice@example.com',
      '--capability', 'godmode',
      '--allowlist-path', listPath,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unknown capability');
  });

  test('grant with --ttl persists expires_at', () => {
    const r = runMint([
      'grant', '--remote', 'tag:ci',
      '--capability', 'mutate',
      '--ttl', '3600',
      '--note', 'nightly',
      '--allowlist-path', listPath,
    ]);
    expect(r.status).toBe(0);
    const raw = readFileSync(listPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.entries[0].identity).toBe('tag:ci');
    expect(parsed.entries[0].capabilities).toEqual(['mutate']);
    expect(parsed.entries[0].expires_at).toBeTruthy();
    expect(parsed.entries[0].note).toBe('nightly');
  });
});

describe('bin/gstack-ios-qa-daemon launcher', () => {
  test('launcher is executable', () => {
    expect(existsSync(DAEMON_BIN)).toBe(true);
    const mode = statSync(DAEMON_BIN).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  test('reports missing bun runtime cleanly', () => {
    // Simulate `bun` missing by giving PATH only /usr/bin + /bin (so bash
    // resolves but `command -v bun` does not). The launcher's preflight
    // check should fire BEFORE attempting to exec bun.
    const r = spawnSync(DAEMON_BIN, [], {
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('bun');
  });
});
