/**
 * gstack-gbrain-repo-policy — per-remote trust-tier policy store.
 *
 * Covers the setup-gbrain D3/D2-eng decisions end-to-end:
 *   - D3 triad semantics (read-write / read-only / deny / unset)
 *   - Remote-URL normalization (ssh/https/shorthand all collapse to the same key)
 *   - D2-eng schema-version field (_schema_version: 2) written on new files
 *   - Legacy `allow` → `read-write` migration, one-shot, idempotent
 *   - Atomic writes (tmpfile + rename; no partial files visible)
 *   - Corrupt-file quarantine (file renamed to .corrupt-<ts>, fresh file created)
 *   - 0600 permissions on the policy file
 *
 * Each test uses a temp GSTACK_HOME so nothing leaks into the user's real ~/.gstack.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-gbrain-repo-policy');

let tmpHome: string;

function run(args: string[], opts: { env?: Record<string, string> } = {}) {
  const res = spawnSync(BIN, args, {
    env: { ...process.env, GSTACK_HOME: tmpHome, ...(opts.env || {}) },
    encoding: 'utf-8',
  });
  return {
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    status: res.status ?? -1,
  };
}

function policyFile(): string {
  return path.join(tmpHome, 'gbrain-repo-policy.json');
}

function readPolicy(): any {
  return JSON.parse(fs.readFileSync(policyFile(), 'utf-8'));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-policy-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('normalize', () => {
  test('strips https:// and .git', () => {
    const r = run(['normalize', 'https://github.com/foo/bar.git']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('github.com/foo/bar');
  });

  test('plain https without .git', () => {
    const r = run(['normalize', 'https://github.com/foo/bar']);
    expect(r.stdout).toBe('github.com/foo/bar');
  });

  test('ssh shorthand git@host:path collapses to the same key', () => {
    const r = run(['normalize', 'git@github.com:foo/bar.git']);
    expect(r.stdout).toBe('github.com/foo/bar');
  });

  test('ssh:// URL form collapses to the same key', () => {
    const r = run(['normalize', 'ssh://git@github.com/foo/bar.git']);
    expect(r.stdout).toBe('github.com/foo/bar');
  });

  test('uppercase hostname and path are lowercased', () => {
    const r = run(['normalize', 'HTTPS://GITHUB.COM/FOO/BAR']);
    expect(r.stdout).toBe('github.com/foo/bar');
  });

  test('gitlab subgroups preserved (ssh shorthand)', () => {
    const r = run(['normalize', 'git@gitlab.com:group/subgroup/project.git']);
    expect(r.stdout).toBe('gitlab.com/group/subgroup/project');
  });

  test('custom gitlab host with https', () => {
    const r = run(['normalize', 'https://gitlab.example.com/group/project']);
    expect(r.stdout).toBe('gitlab.example.com/group/project');
  });

  test('all variants collapse to a single key', () => {
    const forms = [
      'https://github.com/Foo/Bar.git',
      'https://github.com/foo/bar',
      'git@github.com:foo/bar.git',
      'ssh://git@github.com/foo/bar.git',
      'HTTPS://GITHUB.COM/FOO/BAR',
    ];
    const keys = forms.map((f) => run(['normalize', f]).stdout);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('github.com/foo/bar');
  });
});

describe('set + get', () => {
  test('set persists the tier and get returns it', () => {
    const s = run(['set', 'https://github.com/foo/bar.git', 'read-write']);
    expect(s.status).toBe(0);
    const g = run(['get', 'https://github.com/foo/bar']);
    expect(g.status).toBe(0);
    expect(g.stdout).toBe('read-write');
  });

  test('all three tier values accepted', () => {
    run(['set', 'https://github.com/a/a', 'read-write']);
    run(['set', 'https://github.com/b/b', 'read-only']);
    run(['set', 'https://github.com/c/c', 'deny']);
    expect(run(['get', 'https://github.com/a/a']).stdout).toBe('read-write');
    expect(run(['get', 'https://github.com/b/b']).stdout).toBe('read-only');
    expect(run(['get', 'https://github.com/c/c']).stdout).toBe('deny');
  });

  test('invalid tier rejected with non-zero exit', () => {
    const r = run(['set', 'https://github.com/foo/bar', 'allow']);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('invalid tier');
  });

  test('get for unset remote returns literal unset', () => {
    run(['set', 'https://github.com/foo/bar', 'read-write']);
    const r = run(['get', 'https://github.com/baz/qux']);
    expect(r.stdout).toBe('unset');
  });

  test('ssh-set then https-get returns the same tier', () => {
    run(['set', 'git@github.com:foo/bar.git', 'deny']);
    const r = run(['get', 'https://github.com/foo/bar']);
    expect(r.stdout).toBe('deny');
  });
});

describe('file format + schema version', () => {
  test('_schema_version: 2 added on fresh file creation', () => {
    run(['set', 'https://github.com/foo/bar', 'read-write']);
    expect(readPolicy()._schema_version).toBe(2);
  });

  test('policy file mode is 0600', () => {
    run(['set', 'https://github.com/foo/bar', 'read-write']);
    const mode = fs.statSync(policyFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('re-running set does not duplicate schema version or entries', () => {
    run(['set', 'https://github.com/foo/bar', 'read-write']);
    run(['set', 'https://github.com/foo/bar', 'deny']);
    const p = readPolicy();
    expect(p._schema_version).toBe(2);
    expect(p['github.com/foo/bar']).toBe('deny');
    // Only the schema version + the one entry
    expect(Object.keys(p).length).toBe(2);
  });
});

describe('legacy migration (D3 allow → read-write)', () => {
  test('legacy allow value is rewritten to read-write on first read', () => {
    fs.writeFileSync(
      policyFile(),
      JSON.stringify({ 'github.com/foo/bar': 'allow' }),
      { mode: 0o600 }
    );
    const r = run(['get', 'https://github.com/foo/bar']);
    expect(r.stdout).toBe('read-write');
    expect(r.stderr).toContain('Migrated 1 legacy allow entries');
    const p = readPolicy();
    expect(p['github.com/foo/bar']).toBe('read-write');
    expect(p._schema_version).toBe(2);
  });

  test('migration preserves deny entries unchanged', () => {
    fs.writeFileSync(
      policyFile(),
      JSON.stringify({ 'github.com/foo/bar': 'allow', 'github.com/baz/qux': 'deny' }),
      { mode: 0o600 }
    );
    run(['get', 'https://github.com/foo/bar']);
    const p = readPolicy();
    expect(p['github.com/foo/bar']).toBe('read-write');
    expect(p['github.com/baz/qux']).toBe('deny');
  });

  test('migration is idempotent — second run is a no-op', () => {
    fs.writeFileSync(
      policyFile(),
      JSON.stringify({ 'github.com/foo/bar': 'allow' }),
      { mode: 0o600 }
    );
    const first = run(['get', 'https://github.com/foo/bar']);
    expect(first.stderr).toContain('Migrated 1');
    const second = run(['get', 'https://github.com/foo/bar']);
    expect(second.stderr).not.toContain('Migrated');
    expect(second.stdout).toBe('read-write');
  });

  test('already-v2 file is not re-migrated', () => {
    fs.writeFileSync(
      policyFile(),
      JSON.stringify({ _schema_version: 2, 'github.com/foo/bar': 'read-write' }),
      { mode: 0o600 }
    );
    const r = run(['get', 'https://github.com/foo/bar']);
    expect(r.stderr).not.toContain('Migrated');
    expect(r.stdout).toBe('read-write');
  });
});

describe('corrupt-file handling', () => {
  test('unparseable JSON is quarantined and a fresh file is started', () => {
    fs.writeFileSync(policyFile(), 'not valid json{', { mode: 0o600 });
    const r = run(['get', 'https://github.com/foo/bar']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('unset');
    expect(r.stderr).toContain('corrupt policy file quarantined');
    // New file exists, is valid, and has schema version
    const p = readPolicy();
    expect(p._schema_version).toBe(2);
    // Quarantine file exists
    const quarantine = fs.readdirSync(tmpHome).find((f) =>
      f.startsWith('gbrain-repo-policy.json.corrupt-')
    );
    expect(quarantine).toBeDefined();
  });
});

describe('list', () => {
  test('list prints entries sorted, excludes _schema_version', () => {
    run(['set', 'https://github.com/zebra/zz', 'deny']);
    run(['set', 'https://github.com/apple/aa', 'read-write']);
    run(['set', 'https://github.com/middle/mm', 'read-only']);
    const r = run(['list']);
    const lines = r.stdout.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('github.com/apple/aa\tread-write');
    expect(lines[1]).toBe('github.com/middle/mm\tread-only');
    expect(lines[2]).toBe('github.com/zebra/zz\tdeny');
  });

  test('list on missing file returns empty, no file created', () => {
    const r = run(['list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(policyFile())).toBe(false);
  });
});

describe('get without arg (auto-detect from current dir)', () => {
  test('returns unset when not in a git repo', () => {
    const cwdTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    try {
      const res = spawnSync(BIN, ['get'], {
        env: { ...process.env, GSTACK_HOME: tmpHome },
        cwd: cwdTmp,
        encoding: 'utf-8',
      });
      expect((res.stdout || '').trim()).toBe('unset');
    } finally {
      fs.rmSync(cwdTmp, { recursive: true, force: true });
    }
  });
});
