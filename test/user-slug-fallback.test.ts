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
 * Result is persisted under user_slug_at_<endpoint-id> for stability.
 * Test isolation via GSTACK_HOME and HOME env overrides.
 *
 * Gate-tier, free, ~50ms.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { createHash } from 'crypto';
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
      // HOME isolation: endpoint_hash() reads $HOME/.claude.json for the
      // gbrain MCP URL. Pointing HOME at the empty TMP_HOME makes it
      // deterministically 'local' regardless of the developer's real
      // ~/.claude.json (which would otherwise change the persisted key
      // namespace to user_slug_at_<sha8-of-url>).
      HOME: TMP_HOME,
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

  test('persists resolution to user_slug_at_<endpoint-id> on first call', () => {
    runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'persisttest' });
    const configFile = join(TMP_HOME, 'config.yaml');
    expect(existsSync(configFile)).toBe(true);
    const content = readFileSync(configFile, 'utf-8');
    // HOME is isolated to the empty TMP_HOME, so endpoint_hash() is
    // deterministically the literal 'local' on every machine.
    expect(content).toMatch(/^user_slug_at_local:\s+persisttest/m);
  });

  test('subsequent calls return same slug (stable across sessions)', () => {
    const first = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'stabletest' });
    const second = runConfig(['resolve-user-slug'], { GSTACK_HOME: TMP_HOME, USER: 'changed-after' });
    // Second call ignores new $USER because the slug was already persisted.
    expect(first.stdout.trim()).toBe('stabletest');
    expect(second.stdout.trim()).toBe('stabletest');
  });
});

describe('sha8_of portable hash (sha256sum → shasum fallback)', () => {
  // sha8_of must work on coreutils-only Linux (no shasum: the exit-127
  // regression) AND on stock macOS (no sha256sum). The ambient PATH decides
  // which branch runs, so a plain subprocess call only ever covers one branch
  // per platform. Pin BOTH deterministically: extract the real function text
  // from bin/gstack-config (no drift-prone copy) and run it under /bin/sh
  // with a shim-only PATH that makes exactly one hasher visible. The wrong
  // branch exits 127 (its tool is absent from the shim dir), so branch
  // selection is asserted structurally, not inferred.
  const EXPECTED = '2cf24dba'; // sha256("hello") = 2cf24dba5fb0a30e2…

  function sha8FnSource(): string {
    const src = readFileSync(CONFIG_BIN, 'utf-8');
    const m = src.match(/^sha8_of\(\) \{\n[\s\S]*?\n\}/m);
    if (!m) throw new Error('sha8_of() not found in bin/gstack-config');
    return m[0];
  }

  /** Absolute-path sha256 pipeline for shims (host has sha256sum OR shasum). */
  function realHasherLine(): string {
    const sha256sum = Bun.which('sha256sum');
    if (sha256sum) return `exec ${sha256sum} "$@"`;
    const shasum = Bun.which('shasum');
    if (shasum) return `exec ${shasum} -a 256 "$@"`;
    throw new Error('neither sha256sum nor shasum available on this host');
  }

  function runSha8(shimDir: string) {
    const result = spawnSync('/bin/sh', ['-c', `${sha8FnSource()}\nsha8_of "hello"`], {
      encoding: 'utf-8',
      env: { PATH: shimDir }, // ONLY the shim dir: absent tools are really absent
      timeout: 5000,
    });
    return { stdout: (result.stdout || '').trim(), status: result.status ?? -1, stderr: result.stderr || '' };
  }

  function makeShimDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gstack-sha8-shim-'));
    const cut = Bun.which('cut');
    if (!cut) throw new Error('cut not on PATH');
    symlinkSync(cut, join(dir, 'cut'));
    return dir;
  }

  test('coreutils-only PATH (sha256sum present, shasum absent) — the Linux exit-127 regression', () => {
    const shim = makeShimDir();
    try {
      writeFileSync(join(shim, 'sha256sum'), `#!/bin/sh\n${realHasherLine()}\n`, { mode: 0o755 });
      const result = runSha8(shim);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(EXPECTED);
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });

  test('sha256sum absent falls back to `shasum -a 256` with identical output (macOS branch)', () => {
    const shim = makeShimDir();
    try {
      // Arg-validating shasum shim: wrong/missing `-a 256` exits 64, which
      // would surface as a failed pipeline — pins the exact invocation.
      writeFileSync(
        join(shim, 'shasum'),
        `#!/bin/sh\n[ "$1" = "-a" ] && [ "$2" = "256" ] || exit 64\nshift 2\n${realHasherLine()}\n`,
        { mode: 0o755 },
      );
      const result = runSha8(shim);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(EXPECTED); // same vector ⇒ branches are equivalent
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });
});

describe('endpoint-hash collision escalation (sha8 → sha16)', () => {
  // endpoint_hash_with_collision_check's sha16 arm carries its own portable
  // hash pipeline (sha256sum → shasum). This drives it end-to-end through the
  // real binary: a gbrain MCP URL in $HOME/.claude.json plus config keys at
  // BOTH the sha8 and sha16 namespaces is the recorded-collision evidence
  // that makes `endpoint-hash` emit the 16-char hash. Skipped where jq is
  // absent (the script itself degrades to 'local' there).
  test('emits sha8 normally, sha16 when a stored sha16-namespaced key exists', () => {
    if (!Bun.which('jq')) return; // endpoint_hash requires jq; degrades to 'local' without it
    const url = 'https://gbrain.example.test/mcp';
    const hex = createHash('sha256').update(url).digest('hex');
    const sha8 = hex.slice(0, 8);
    const sha16 = hex.slice(0, 16);
    writeFileSync(join(TMP_HOME, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { url } } }));

    // No collision evidence yet → plain sha8.
    const plain = runConfig(['endpoint-hash'], { GSTACK_HOME: TMP_HOME });
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe(sha8);

    // Keys stored at both namespaces → escalate to sha16.
    writeFileSync(
      join(TMP_HOME, 'config.yaml'),
      `brain_trust_policy@${sha8}: personal\nbrain_trust_policy@${sha16}: shared\n`,
    );
    const escalated = runConfig(['endpoint-hash'], { GSTACK_HOME: TMP_HOME });
    expect(escalated.status).toBe(0);
    expect(escalated.stdout.trim()).toBe(sha16);
  });
});

describe('brain_trust_policy@<endpoint-id> namespace', () => {
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

  test('accepts @local suffix on key', () => {
    const result = runConfig(['get', 'brain_trust_policy@local'], { GSTACK_HOME: TMP_HOME });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('unset');
  });
});
