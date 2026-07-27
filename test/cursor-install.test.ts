/**
 * Tests for bin/gstack-cursor-install and bin/gstack-cloud-bootstrap.
 *
 * gstack-cursor-install installs gstack skills into .cursor/skills/ without
 * requiring bun — it uses sed-based path rewrites on source SKILL.md files.
 *
 * gstack-cloud-bootstrap wraps cursor-install with a git-clone step for use
 * on fresh Cloud Agent VMs.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const CURSOR_INSTALL = path.join(ROOT, 'bin', 'gstack-cursor-install');
const CLOUD_BOOTSTRAP = path.join(ROOT, 'bin', 'gstack-cloud-bootstrap');

// ── Helpers ────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cursor-test-'));
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): RunResult {
  try {
    const stdout = execSync(cmd, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      encoding: 'utf-8',
      timeout: opts.timeout ?? 15_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

// ── gstack-cursor-install ───────────────────────────────────────

describe('gstack-cursor-install', () => {
  let tmpDir: string;
  let cursorSkills: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    cursorSkills = path.join(tmpDir, '.cursor', 'skills');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Existence and executability ────────────────────────────

  test('script exists at bin/gstack-cursor-install', () => {
    expect(fs.existsSync(CURSOR_INSTALL)).toBe(true);
  });

  test('script is executable', () => {
    const stat = fs.statSync(CURSOR_INSTALL);
    // Owner execute bit
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  test('script does not depend on bun', () => {
    const content = fs.readFileSync(CURSOR_INSTALL, 'utf-8');
    expect(content).not.toContain('command -v bun');
    expect(content).not.toContain('bun run');
    expect(content).not.toContain('bun install');
  });

  // ── Install outcome ────────────────────────────────────────

  test('creates target .cursor/skills/ directory', () => {
    const result = run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(cursorSkills)).toBe(true);
  });

  test('creates gstack/ runtime root inside target', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(fs.existsSync(path.join(cursorSkills, 'gstack'))).toBe(true);
  });

  test('installs ETHOS.md in gstack/', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(fs.existsSync(path.join(cursorSkills, 'gstack', 'ETHOS.md'))).toBe(true);
  });

  test('installs gstack/SKILL.md root descriptor', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(fs.existsSync(path.join(cursorSkills, 'gstack', 'SKILL.md'))).toBe(true);
  });

  test('installs gstack/review/checklist.md', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(fs.existsSync(path.join(cursorSkills, 'gstack', 'review', 'checklist.md'))).toBe(true);
  });

  test('installs at least 10 skills with SKILL.md files', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const installed = fs.readdirSync(cursorSkills, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(cursorSkills, d.name, 'SKILL.md')));
    expect(installed.length).toBeGreaterThanOrEqual(10);
  });

  // ── Path rewrites ──────────────────────────────────────────

  test('root gstack/SKILL.md contains no ~/.claude/skills references', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const content = fs.readFileSync(path.join(cursorSkills, 'gstack', 'SKILL.md'), 'utf-8');
    expect(content).not.toContain('~/.claude/skills/gstack');
  });

  test('root gstack/SKILL.md contains .cursor/skills/gstack reference', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const content = fs.readFileSync(path.join(cursorSkills, 'gstack', 'SKILL.md'), 'utf-8');
    expect(content).toContain('.cursor/skills/gstack');
  });

  test('individual skill SKILL.md files contain no ~/.claude/skills references', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const skills = fs.readdirSync(cursorSkills, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const skill of skills) {
      const skillFile = path.join(cursorSkills, skill, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).not.toContain('~/.claude/skills/gstack');
    }
  });

  test('no skill SKILL.md contains ~/.codex/skills references', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const skills = fs.readdirSync(cursorSkills, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const skill of skills) {
      const skillFile = path.join(cursorSkills, skill, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).not.toContain('~/.codex/skills');
    }
  });

  // ── Idempotency ────────────────────────────────────────────

  test('running twice does not fail', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    const result = run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(result.exitCode).toBe(0);
  });

  test('running twice leaves ETHOS.md intact', () => {
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    run(`${CURSOR_INSTALL} ${cursorSkills}`);
    expect(fs.existsSync(path.join(cursorSkills, 'gstack', 'ETHOS.md'))).toBe(true);
  });

  // ── Quiet mode ─────────────────────────────────────────────

  test('GSTACK_CURSOR_QUIET=1 suppresses stdout', () => {
    const result = run(`${CURSOR_INSTALL} ${cursorSkills}`, {
      env: { GSTACK_CURSOR_QUIET: '1' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

// ── gstack-cloud-bootstrap ─────────────────────────────────────

describe('gstack-cloud-bootstrap', () => {
  test('script exists at bin/gstack-cloud-bootstrap', () => {
    expect(fs.existsSync(CLOUD_BOOTSTRAP)).toBe(true);
  });

  test('script is executable', () => {
    const stat = fs.statSync(CLOUD_BOOTSTRAP);
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  test('script does not depend on bun', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    expect(content).not.toContain('command -v bun');
    expect(content).not.toContain('bun run');
    expect(content).not.toContain('bun install');
  });

  test('script clones gstack via git', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    expect(content).toContain('git clone');
  });

  test('script delegates to gstack-cursor-install', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    expect(content).toContain('gstack-cursor-install');
  });

  test('script verifies skill count after install', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    // Should check that enough skills were installed
    expect(content).toContain('skill_count');
    expect(content).toContain('GSTACK_MIN_SKILLS');
  });

  test('script exits non-zero when fewer than min skills installed', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    // Verify the guard is present
    expect(content).toContain('exit 1');
    expect(content).toContain('skill_count');
  });

  test('script supports GSTACK_AUTOUPDATE env var', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    expect(content).toContain('GSTACK_AUTOUPDATE');
  });

  test('script supports GSTACK_CACHE_DIR env var', () => {
    const content = fs.readFileSync(CLOUD_BOOTSTRAP, 'utf-8');
    expect(content).toContain('GSTACK_CACHE_DIR');
  });

  test('bootstrap using local repo does not require network', () => {
    // Bootstrap with GSTACK_CACHE_DIR pointing at our local repo.
    // This verifies the full install path without a git clone.
    const tmpDir = mkTmpDir();
    try {
      const result = run(`${CLOUD_BOOTSTRAP}`, {
        cwd: tmpDir,
        env: {
          GSTACK_CACHE_DIR: ROOT,
          GSTACK_SKILLS_DIR: path.join(tmpDir, '.cursor', 'skills'),
        },
      });
      expect(result.exitCode).toBe(0);
      // Verify skills exist
      const skillsDir = path.join(tmpDir, '.cursor', 'skills');
      const skillCount = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
        .length;
      expect(skillCount).toBeGreaterThanOrEqual(10);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── setup --host cursor ────────────────────────────────────────

describe('setup --host cursor', () => {
  const SETUP_SCRIPT = path.join(ROOT, 'setup');

  test('setup script contains cursor in valid --host values', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content).toContain('cursor');
  });

  test('setup --host cursor exits 0 and installs skills', () => {
    const tmpDir = mkTmpDir();
    try {
      const result = run(`${SETUP_SCRIPT} --host cursor --quiet`, {
        cwd: tmpDir,
        env: { GSTACK_SKILLS_DIR: path.join(tmpDir, '.cursor', 'skills') },
      });
      expect(result.exitCode).toBe(0);
      const skillsDir = path.join(tmpDir, '.cursor', 'skills');
      expect(fs.existsSync(skillsDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
