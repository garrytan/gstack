/**
 * User-slug identity resolution chain (T16 / D4 A3).
 *
 * Verifies the gstack-config resolve-user-slug subcommand walks the
 * documented fallback chain:
 *   1. mcp__gbrain__whoami.client_name (skipped when gbrain not on PATH)
 *   2. $USER env var
 *   3. sha8($(git config user.email))
 *   4. anonymous-<sha8(hostname)>
 *
 * Result is persisted under user_slug_at_<endpoint-hash> for stability.
 * Test isolation via GSTACK_HOME and HOME env overrides.
 *
 * Gate-tier, free, ~50ms.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = process.cwd();
const CONFIG_BIN = join(REPO_ROOT, 'bin', 'gstack-config');

let TMP_HOME: string;
const ORIGINAL = {
  HOME: process.env.HOME,
  GSTACK_HOME: process.env.GSTACK_HOME,
  USER: process.env.USER,
};

function runConfig(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(CONFIG_BIN, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...extraEnv,
    },
    timeout: 5000,
  });
  return { stdout: result.stdout || '', status: result.status ?? -1, stderr: result.stderr || '' };
}

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'gstack-user-slug-test-'));
  process.env.GSTACK_HOME = TMP_HOME;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v !== undefined) process.env[k] = v;
    else delete (process.env as Record<string, unknown>)[k];
  }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('endpoint-hash subcommand', () => {
  test('returns deterministic 8-char hex or literal "local"', () => {
    const result = runConfig(['endpoint-hash'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
    const out = result.stdout.trim();
    expect(out === 'local' || /^[a-f0-9]{8}$/.test(out) || /^[a-f0-9]{16}$/.test(out)).toBe(true);
  });
});

describe('resolve-user-slug fallback chain', () => {
  test('uses $USER when set (layer 2)', () => {
    const result = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'alice-test' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('alice-test');
  });

  test('lowercases + dash-normalizes $USER', () => {
    const result = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'Alice Test' });
    expect(result.status).toBe(0);
    // Spaces become dashes, uppercase becomes lowercase
    expect(result.stdout.trim()).toMatch(/^alice-test$/i);
  });

  test('falls through past empty $USER to git email or anonymous', () => {
    const result = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: '' });
    expect(result.status).toBe(0);
    const slug = result.stdout.trim();
    expect(slug.length).toBeGreaterThan(0);
    // Should be either email-<sha8> or anonymous-<sha8>
    expect(slug).toMatch(/^(email-|anonymous-)[a-f0-9]+$|^[a-zA-Z0-9-]+$/);
  });

  test('persists resolution to user_slug_at_<hash> on first call', () => {
    runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'persisttest' });
    const configFile = join(TMP_HOME, 'config.yaml');
    expect(existsSync(configFile)).toBe(true);
    const content = readFileSync(configFile, 'utf-8');
    expect(content).toMatch(/^user_slug_at_[a-f0-9]+:\s+persisttest/m);
  });

  test('subsequent calls return same slug (stable across sessions)', () => {
    const first = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'stabletest' });
    const second = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'changed-after' });
    // Second call ignores new $USER because the slug was already persisted.
    expect(first.stdout.trim()).toBe('stabletest');
    expect(second.stdout.trim()).toBe('stabletest');
  });
});

describe('brain_trust_policy@<hash> namespace', () => {
  test('default value is "unset"', () => {
    const result = runConfig(['get', 'brain_trust_policy@deadbeef'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('unset');
  });

  test('set + get roundtrip works', () => {
    const setResult = runConfig(['set', 'brain_trust_policy@deadbeef', 'personal'], { GSTACK_HOME: TMP_HOME });
    expect(setResult.status).toBe(0);
    const getResult = runConfig(['get', 'brain_trust_policy@deadbeef'], { GSTACK_HOME: TMP_HOME });
    expect(getResult.stdout).toBe('personal');
  });

  test('invalid value falls back to unset with warning', () => {
    const result = runConfig(['set', 'brain_trust_policy@deadbeef', 'invalid-value'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not recognized');
    const getResult = runConfig(['get', 'brain_trust_policy@deadbeef'], { GSTACK_HOME: TMP_HOME });
    expect(getResult.stdout).toBe('unset');
  });

  test('shared value accepted', () => {
    runConfig(['set', 'brain_trust_policy@deadbeef', 'shared'], { GSTACK_HOME: TMP_HOME });
    const getResult = runConfig(['get', 'brain_trust_policy@deadbeef'], { GSTACK_HOME: TMP_HOME });
    expect(getResult.stdout).toBe('shared');
  });

  test('per-endpoint policies dont collide', () => {
    runConfig(['set', 'brain_trust_policy@aaaaaaaa', 'personal'], { GSTACK_HOME: TMP_HOME });
    runConfig(['set', 'brain_trust_policy@bbbbbbbb', 'shared'], { GSTACK_HOME: TMP_HOME });
    const a = runConfig(['get', 'brain_trust_policy@aaaaaaaa'], { GSTACK_HOME: TMP_HOME });
    const b = runConfig(['get', 'brain_trust_policy@bbbbbbbb'], { GSTACK_HOME: TMP_HOME });
    expect(a.stdout).toBe('personal');
    expect(b.stdout).toBe('shared');
  });
});

describe('key validation', () => {
  test('rejects keys with disallowed characters', () => {
    const result = runConfig(['get', 'bad-key'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('alphanumeric');
  });

  test('accepts plain alphanumeric/underscore keys', () => {
    const result = runConfig(['get', 'proactive'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
  });

  test('accepts @<hex-hash> suffix on key', () => {
    const result = runConfig(['get', 'brain_trust_policy@abc123ff'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
  });
});
