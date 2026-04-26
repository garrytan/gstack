/**
 * gstack-gbrain-detect + gstack-gbrain-install — Slice 2 of /setup-gbrain.
 *
 * Detect: state-reporter JSON with presence, version, config, doctor health,
 * and gstack-brain-sync mode. Pure introspection, no side effects.
 *
 * Install: D5 detect-first (reuse pre-existing clones) + D19 PATH-shadow
 * validation. The install flow itself (git clone + bun install + bun link)
 * is not exercised in CI because it touches the user's real ~/.bun/bin and
 * network. Instead we use --validate-only to exercise the D19 check and
 * --dry-run to exercise the D5 detect-first path end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const DETECT = path.join(ROOT, 'bin', 'gstack-gbrain-detect');
const INSTALL = path.join(ROOT, 'bin', 'gstack-gbrain-install');

// Minimal PATH with POSIX tools + homebrew (for jq/git/curl) but no user-bin
// dirs — this keeps `gbrain` out of PATH deterministically across dev machines
// while still finding jq, git, curl, sed, cat, etc. Each test can prepend a
// fake-gbrain dir when it wants to simulate presence.
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

let tmpHome: string;
let tmpHomeReal: string;

type RunOpts = { env?: Record<string, string>; cwd?: string };
function run(bin: string, args: string[], opts: RunOpts = {}) {
  const env = {
    ...process.env,
    GSTACK_HOME: tmpHome,
    HOME: tmpHomeReal,
    ...(opts.env || {}),
  };
  const res = spawnSync(bin, args, {
    env,
    cwd: opts.cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    status: res.status ?? -1,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-detect-gstack-'));
  tmpHomeReal = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-detect-home-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpHomeReal, { recursive: true, force: true });
});

describe('gstack-gbrain-detect', () => {
  test('emits valid JSON even when nothing is configured', () => {
    // Override PATH to exclude any real gbrain so the test is deterministic.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'));
    try {
      const r = run(DETECT, [], { env: { PATH: `${emptyBin}:${SAFE_PATH}` } });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.gbrain_on_path).toBe(false);
      expect(j.gbrain_version).toBeNull();
      expect(j.gbrain_config_exists).toBe(false);
      expect(j.gbrain_engine).toBeNull();
      expect(j.gbrain_doctor_ok).toBe(false);
      expect(j.gstack_brain_sync_mode).toBe('off');
      expect(j.gstack_brain_git).toBe(false);
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('reports gstack_brain_git: true when GSTACK_HOME has a .git dir', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'));
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'));
    try {
      const r = run(DETECT, [], { env: { PATH: `${emptyBin}:${SAFE_PATH}` } });
      const j = JSON.parse(r.stdout);
      expect(j.gstack_brain_git).toBe(true);
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('reports gbrain_config + engine when ~/.gbrain/config.json exists', () => {
    // HOME is tmpHomeReal; detect reads $HOME/.gbrain/config.json.
    fs.mkdirSync(path.join(tmpHomeReal, '.gbrain'));
    fs.writeFileSync(
      path.join(tmpHomeReal, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: '/tmp/x.pglite' })
    );
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'));
    try {
      const r = run(DETECT, [], { env: { PATH: `${emptyBin}:${SAFE_PATH}` } });
      const j = JSON.parse(r.stdout);
      expect(j.gbrain_config_exists).toBe(true);
      expect(j.gbrain_engine).toBe('pglite');
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('malformed config returns null engine, does not crash', () => {
    fs.mkdirSync(path.join(tmpHomeReal, '.gbrain'));
    fs.writeFileSync(path.join(tmpHomeReal, '.gbrain', 'config.json'), 'not valid json{');
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'));
    try {
      const r = run(DETECT, [], { env: { PATH: `${emptyBin}:${SAFE_PATH}` } });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.gbrain_config_exists).toBe(true);
      expect(j.gbrain_engine).toBeNull();
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('detects a mocked gbrain binary on PATH and reports its version', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'));
    fs.writeFileSync(
      path.join(fakeBin, 'gbrain'),
      '#!/bin/bash\necho "0.18.2"\nexit 0\n',
      { mode: 0o755 }
    );
    try {
      const r = run(DETECT, [], { env: { PATH: `${fakeBin}:${SAFE_PATH}` } });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.gbrain_on_path).toBe(true);
      expect(j.gbrain_version).toBe('0.18.2');
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('gstack-gbrain-install D5 detect-first', () => {
  test('--dry-run reuses a pre-existing ~/git/gbrain-shaped clone', () => {
    // Stand up a fake ~/git/gbrain that looks valid (name + bin.gbrain).
    const fakeGit = path.join(tmpHomeReal, 'git', 'gbrain');
    fs.mkdirSync(fakeGit, { recursive: true });
    fs.writeFileSync(
      path.join(fakeGit, 'package.json'),
      JSON.stringify({
        name: 'gbrain',
        version: '0.18.2',
        bin: { gbrain: './src/cli.ts' },
      })
    );
    const r = run(INSTALL, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`detected existing gbrain clone at ${fakeGit}`);
    expect(r.stdout).toContain('would run bun install + bun link');
  });

  test('--dry-run falls through to fresh clone when no valid clone detected', () => {
    // No ~/git/gbrain, no ~/gbrain.
    const r = run(INSTALL, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY RUN: would clone');
    expect(r.stdout).toContain('https://github.com/garrytan/gbrain.git');
  });

  test('rejects a pre-existing path that lacks a valid gbrain package.json', () => {
    // Put garbage at ~/git/gbrain, but nothing at ~/gbrain.
    const badGit = path.join(tmpHomeReal, 'git', 'gbrain');
    fs.mkdirSync(badGit, { recursive: true });
    fs.writeFileSync(path.join(badGit, 'package.json'), JSON.stringify({ name: 'not-gbrain' }));
    const r = run(INSTALL, ['--dry-run']);
    expect(r.status).toBe(0);
    // Falls through to fresh clone
    expect(r.stdout).toContain('DRY RUN: would clone');
  });
});

describe('gstack-gbrain-install D19 PATH-shadow validation', () => {
  function seedInstallDir(version: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-install-'));
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ name: 'gbrain', version, bin: { gbrain: './src/cli.ts' } })
    );
    return d;
  }

  function seedFakeGbrainBinary(version: string): string {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'));
    fs.writeFileSync(
      path.join(binDir, 'gbrain'),
      `#!/bin/bash\necho "${version}"\nexit 0\n`,
      { mode: 0o755 }
    );
    return binDir;
  }

  test('passes when install-dir version matches `gbrain --version` on PATH', () => {
    const installDir = seedInstallDir('0.18.2');
    const fakeBin = seedFakeGbrainBinary('0.18.2');
    try {
      const r = run(INSTALL, ['--validate-only', '--install-dir', installDir], {
        env: { PATH: `${fakeBin}:${SAFE_PATH}` },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('installed gbrain 0.18.2');
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test('tolerates a leading "v" in `gbrain --version` output', () => {
    const installDir = seedInstallDir('0.18.2');
    const fakeBin = seedFakeGbrainBinary('v0.18.2');
    try {
      const r = run(INSTALL, ['--validate-only', '--install-dir', installDir], {
        env: { PATH: `${fakeBin}:${SAFE_PATH}` },
      });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test('fails hard with exit 3 and PATH-shadow message on version mismatch', () => {
    const installDir = seedInstallDir('0.18.2');
    const fakeBin = seedFakeGbrainBinary('0.18.1');
    try {
      const r = run(INSTALL, ['--validate-only', '--install-dir', installDir], {
        env: { PATH: `${fakeBin}:${SAFE_PATH}` },
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('PATH SHADOWING DETECTED');
      expect(r.stderr).toContain('0.18.2');
      expect(r.stderr).toContain('0.18.1');
      // Remediation menu present
      expect(r.stderr).toContain('rm the shadowing binary');
      expect(r.stderr).toContain('prepend ~/.bun/bin to PATH');
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test('fails hard when no gbrain on PATH after supposed install', () => {
    const installDir = seedInstallDir('0.18.2');
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'));
    try {
      const r = run(INSTALL, ['--validate-only', '--install-dir', installDir], {
        env: { PATH: `${emptyBin}:${SAFE_PATH}` },
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("'gbrain' is not on PATH");
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('fails hard when install-dir package.json lacks version', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-install-'));
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ name: 'gbrain', bin: { gbrain: './src/cli.ts' } })
    );
    try {
      const r = run(INSTALL, ['--validate-only', '--install-dir', d]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('cannot read version');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('gstack-gbrain-install argument handling', () => {
  test('--help prints usage without exiting non-zero', () => {
    const r = run(INSTALL, ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gstack-gbrain-install');
  });

  test('unknown flag exits 2 with an error message', () => {
    const r = run(INSTALL, ['--not-a-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag');
  });
});
