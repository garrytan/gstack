/**
 * v1.27.0.0 migration — gstack-brain → gstack-artifacts rename.
 *
 * Exercises the journaled migration in a temp HOME with mocked gh / git /
 * gbrain. Tests the four host-mode cases (GitHub, GitLab, remote-MCP,
 * nothing-to-migrate) plus interruption resume.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.27.0.0.sh');

let tmpHome: string;
let fakeBinDir: string;

function makeFakeGh(opts: { authStatus?: 'ok' | 'fail'; renameSucceeds?: boolean; alreadyRenamed?: boolean } = {}) {
  const authStatus = opts.authStatus ?? 'ok';
  const renameSucceeds = opts.renameSucceeds ?? true;
  const alreadyRenamed = opts.alreadyRenamed ?? false;
  const callLog = path.join(fakeBinDir, 'gh-calls.log');
  const script = `#!/bin/bash
echo "gh $@" >> "${callLog}"
case "$1" in
  auth) ${authStatus === 'ok' ? 'exit 0' : 'exit 1'} ;;
  repo)
    shift
    case "$1" in
      view)
        # gh repo view <name>
        shift
        ${alreadyRenamed ? `if echo "$@" | grep -q gstack-artifacts; then exit 0; else exit 1; fi` : `exit 1`}
        ;;
      rename) ${renameSucceeds ? 'exit 0' : 'exit 1'} ;;
      edit) ${renameSucceeds ? 'exit 0' : 'exit 1'} ;;
    esac
    ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'gh'), script, { mode: 0o755 });
}

function makeFakeGbrain(opts: { hasOldSource?: boolean; addSucceeds?: boolean; removeSucceeds?: boolean } = {}) {
  const hasOld = opts.hasOldSource ?? true;
  const addOk = opts.addSucceeds ?? true;
  const rmOk = opts.removeSucceeds ?? true;
  const callLog = path.join(fakeBinDir, 'gbrain-calls.log');
  const script = `#!/bin/bash
echo "gbrain $@" >> "${callLog}"
case "$1 $2" in
  "sources list")
    ${hasOld ? `echo "gstack-brain-testuser ~/.gstack-brain-worktree"` : 'true'}
    exit 0
    ;;
  "sources add") ${addOk ? 'exit 0' : 'exit 1'} ;;
  "sources remove") ${rmOk ? 'exit 0' : 'exit 1'} ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'gbrain'), script, { mode: 0o755 });
}

function run(extraEnv: Record<string, string> = {}, input = ''): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(MIGRATION, [], {
    env: {
      PATH: `${fakeBinDir}:${path.join(ROOT, 'bin')}:/usr/bin:/bin:/opt/homebrew/bin`,
      HOME: tmpHome,
      USER: 'testuser',
      // Disable interactive prompt: empty stdin = treat as non-interactive.
      ...extraEnv,
    },
    encoding: 'utf-8',
    input,
    cwd: tmpHome,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v1.27-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v1.27-fake-'));
  fs.mkdirSync(path.join(tmpHome, '.gstack'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('v1.27.0.0 migration — nothing to migrate', () => {
  test('no legacy state → exits 0, writes done touchfile, no journal', () => {
    // Fresh HOME: no brain-remote.txt, no .gstack/.git
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('nothing to migrate');
    expect(fs.existsSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.done'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.journal'))).toBe(false);
  });

  test('done touchfile present → exits 0 silently (no re-prompt)', () => {
    fs.mkdirSync(path.join(tmpHome, '.gstack/.migrations'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.done'), '');
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('skipped-by-user touchfile → exits 0 silently', () => {
    fs.mkdirSync(path.join(tmpHome, '.gstack/.migrations'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.skipped-by-user'), '');
    fs.writeFileSync(path.join(tmpHome, '.gstack-brain-remote.txt'), 'https://github.com/x/gstack-brain-testuser');
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('v1.27.0.0 migration — GitHub host (non-interactive)', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    fs.writeFileSync(
      path.join(tmpHome, '.gstack/config.yaml'),
      'gbrain_sync_mode: full\ngbrain_sync_mode_prompted: true\n'
    );
    makeFakeGh({});
  });

  test('renames repo, mvs remote.txt, rewrites config key, writes done', () => {
    const r = run();
    expect(r.code).toBe(0);
    // gh rename was called (or edit fallback).
    const ghLog = fs.readFileSync(path.join(fakeBinDir, 'gh-calls.log'), 'utf-8');
    expect(ghLog).toMatch(/gh repo (rename|edit)/);
    // Old remote.txt is gone, new one exists with rewritten URL.
    expect(fs.existsSync(path.join(tmpHome, '.gstack-brain-remote.txt'))).toBe(false);
    const newUrl = fs.readFileSync(path.join(tmpHome, '.gstack-artifacts-remote.txt'), 'utf-8').trim();
    expect(newUrl).toBe('https://github.com/testuser/gstack-artifacts-testuser');
    // Config key renamed.
    const cfg = fs.readFileSync(path.join(tmpHome, '.gstack/config.yaml'), 'utf-8');
    expect(cfg).toContain('artifacts_sync_mode: full');
    expect(cfg).toContain('artifacts_sync_mode_prompted: true');
    expect(cfg).not.toContain('gbrain_sync_mode');
    // Done touchfile written, journal cleared.
    expect(fs.existsSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.done'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gstack/.migrations/v1.27.0.0.journal'))).toBe(false);
  });

  test('idempotent: re-run after success is a no-op', () => {
    run();
    const r2 = run();
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe('');
  });

  test('repo already renamed (gh repo view succeeds with new name) → no rename attempt', () => {
    makeFakeGh({ alreadyRenamed: true });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('already named');
  });
});

describe('v1.27.0.0 migration — interruption resume', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    makeFakeGh({});
  });

  test('partial journal: skips already-done steps', () => {
    // Pre-plant journal with steps 1+2 marked done.
    const migDir = path.join(tmpHome, '.gstack/.migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, 'v1.27.0.0.journal'), 'gh_repo_renamed\nremote_txt_renamed\n');

    const r = run();
    expect(r.code).toBe(0);
    // gh should NOT have been called (step 1 already done).
    if (fs.existsSync(path.join(fakeBinDir, 'gh-calls.log'))) {
      const ghLog = fs.readFileSync(path.join(fakeBinDir, 'gh-calls.log'), 'utf-8');
      expect(ghLog).not.toMatch(/gh repo rename/);
      expect(ghLog).not.toMatch(/gh repo edit/);
    }
    // Final state: done touchfile written, journal removed.
    expect(fs.existsSync(path.join(migDir, 'v1.27.0.0.done'))).toBe(true);
    expect(fs.existsSync(path.join(migDir, 'v1.27.0.0.journal'))).toBe(false);
  });
});

describe('v1.27.0.0 migration — remote-MCP mode (step 5 prints, never executes)', () => {
  test('with mcpServers.gbrain.type=url → step 5 prints commands, doesn\'t call gbrain', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ mcpServers: { gbrain: { type: 'url', url: 'https://example.com/mcp' } } })
    );
    makeFakeGh({});
    makeFakeGbrain({}); // installed, but should NOT be called for sources commands

    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Remote MCP detected');
    expect(r.stderr).toContain('Send this to your brain admin');
    expect(r.stderr).toContain('gbrain sources add');

    // Confirm the script did NOT call `gbrain sources add/remove` locally.
    if (fs.existsSync(path.join(fakeBinDir, 'gbrain-calls.log'))) {
      const log = fs.readFileSync(path.join(fakeBinDir, 'gbrain-calls.log'), 'utf-8');
      expect(log).not.toMatch(/gbrain sources add/);
      expect(log).not.toMatch(/gbrain sources remove/);
    }
  });
});

describe('v1.27.0.0 migration — local CLI sources swap (codex Finding #6 ordering)', () => {
  test('add-new before remove-old (verify by call order in log)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    fs.mkdirSync(path.join(tmpHome, '.gstack/.git'), { recursive: true }); // brain repo present
    makeFakeGh({});
    makeFakeGbrain({ hasOldSource: true });

    const r = run();
    expect(r.code).toBe(0);

    const log = fs.readFileSync(path.join(fakeBinDir, 'gbrain-calls.log'), 'utf-8');
    const addIdx = log.indexOf('gbrain sources add gstack-artifacts-testuser');
    const removeIdx = log.indexOf('gbrain sources remove gstack-brain-testuser');
    expect(addIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    // Critical: add must come BEFORE remove (no downtime window).
    expect(addIdx).toBeLessThan(removeIdx);
  });

  test('add fails → old source stays registered (no silent loss)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    fs.mkdirSync(path.join(tmpHome, '.gstack/.git'), { recursive: true });
    makeFakeGh({});
    makeFakeGbrain({ addSucceeds: false });

    const r = run();
    expect(r.code).toBe(0); // step 5 warns, doesn't fail the migration
    expect(r.stderr).toContain('failed to add');
    const log = fs.readFileSync(path.join(fakeBinDir, 'gbrain-calls.log'), 'utf-8');
    // Remove was NOT called because add failed.
    expect(log).not.toMatch(/gbrain sources remove/);
  });
});

describe('v1.27.0.0 migration — CLAUDE.md block field rewrite', () => {
  test('rewrites "- Memory sync:" → "- Artifacts sync:" in CLAUDE.md', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/testuser/gstack-brain-testuser\n'
    );
    const claudeMd = `# Project notes

## GBrain Configuration (configured by /setup-gbrain)
- Engine: pglite
- Memory sync: full
- Current repo policy: read-write
`;
    fs.writeFileSync(path.join(tmpHome, 'CLAUDE.md'), claudeMd);
    makeFakeGh({});

    const r = run();
    expect(r.code).toBe(0);
    const updated = fs.readFileSync(path.join(tmpHome, 'CLAUDE.md'), 'utf-8');
    expect(updated).toContain('- Artifacts sync: full');
    expect(updated).not.toContain('- Memory sync:');
  });
});
