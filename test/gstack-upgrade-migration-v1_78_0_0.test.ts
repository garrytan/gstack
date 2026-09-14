/**
 * v1.78.0.0 migration — carry feature-discovery acknowledgement markers
 * (.feature-prompted-continuous-checkpoint, .feature-prompted-model-overlay)
 * from the gstack install dir to GSTACK_HOME (#2728 absorption).
 *
 * Exercises the script in hermetic mkdtemp roots via GSTACK_INSTALL_DIR /
 * GSTACK_HOME overrides. Covers: copy-when-absent, destination-wins,
 * clean no-op, and idempotent re-run.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.78.0.0.sh');

const MARKERS = [
  '.feature-prompted-continuous-checkpoint',
  '.feature-prompted-model-overlay',
] as const;

const tmpRoots: string[] = [];
let tmpHome: string;
let installDir: string;
let gstackHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v1.78-'));
  tmpRoots.push(tmpHome);
  installDir = path.join(tmpHome, 'install');
  gstackHome = path.join(tmpHome, '.gstack');
  fs.mkdirSync(installDir, { recursive: true });
  // gstackHome deliberately NOT pre-created: the script's own `mkdir -p` is
  // part of the contract (fresh installs have no ~/.gstack yet).
});

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function run(): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [MIGRATION], {
    env: {
      // The parent PATH, not a hardcoded POSIX one: on Windows, spawn
      // resolves `bash` against the CHILD env's PATH, and /usr/bin:/bin
      // contains no bash.exe there (the exact hazard documented on
      // codex-under-codex-detection's KNOWN_WINDOWS_INCOMPATIBLE entry).
      // Hermeticity comes from HOME/GSTACK_* below, not from PATH.
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmpHome,
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_HOME: gstackHome,
    },
    encoding: 'utf-8',
    cwd: tmpHome,
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('v1.78.0.0 migration — feature markers → GSTACK_HOME', () => {
  test('markers in INSTALL_DIR, absent in GSTACK_HOME → created in GSTACK_HOME, source untouched', () => {
    for (const m of MARKERS) fs.writeFileSync(path.join(installDir, m), 'source-content\n');

    const r = run();
    expect(r.code).toBe(0);
    for (const m of MARKERS) {
      expect(fs.existsSync(path.join(gstackHome, m))).toBe(true);
      expect(r.stdout).toContain(`migrated: ${m}`);
      // Copy, not move: the install-dir marker stays, content intact.
      expect(fs.readFileSync(path.join(installDir, m), 'utf-8')).toBe('source-content\n');
    }
  });

  test('marker already in GSTACK_HOME → NOT overwritten (destination wins); missing sibling still migrates', () => {
    fs.mkdirSync(gstackHome, { recursive: true });
    const [checkpoint, overlay] = MARKERS;
    fs.writeFileSync(path.join(installDir, checkpoint), 'install-side\n');
    fs.writeFileSync(path.join(gstackHome, checkpoint), 'dest-side\n');
    fs.writeFileSync(path.join(installDir, overlay), '');

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(gstackHome, checkpoint), 'utf-8')).toBe('dest-side\n');
    expect(r.stdout).not.toContain(`migrated: ${checkpoint}`);
    expect(fs.existsSync(path.join(gstackHome, overlay))).toBe(true);
    expect(r.stdout).toContain(`migrated: ${overlay}`);
  });

  test('no markers anywhere → clean no-op, exit 0, nothing created', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    for (const m of MARKERS) {
      expect(fs.existsSync(path.join(gstackHome, m))).toBe(false);
    }
  });

  test('idempotent: second run exits 0, migrates nothing new, end state unchanged', () => {
    for (const m of MARKERS) fs.writeFileSync(path.join(installDir, m), '');

    const r1 = run();
    expect(r1.code).toBe(0);
    const stateAfterFirst = MARKERS.map((m) => [
      fs.existsSync(path.join(gstackHome, m)),
      fs.readFileSync(path.join(gstackHome, m), 'utf-8'),
    ]);

    const r2 = run();
    expect(r2.code).toBe(0);
    expect(r2.stdout).toBe(''); // destinations exist now — no "migrated:" lines
    const stateAfterSecond = MARKERS.map((m) => [
      fs.existsSync(path.join(gstackHome, m)),
      fs.readFileSync(path.join(gstackHome, m), 'utf-8'),
    ]);
    expect(stateAfterSecond).toEqual(stateAfterFirst);
  });
});
