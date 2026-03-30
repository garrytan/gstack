import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let skillsDir: string;
let installDir: string;

function run(cmd: string, env: Record<string, string> = {}, expectFail = false): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, GSTACK_STATE_DIR: tmpDir, ...env },
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (expectFail) return (e.stderr || e.stdout || '').toString().trim();
    throw e;
  }
}

// Create a mock gstack install directory with skill subdirs
function setupMockInstall(skills: string[]): void {
  installDir = path.join(tmpDir, 'gstack-install');
  skillsDir = path.join(tmpDir, 'skills');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  // Copy the real gstack-config and gstack-relink to the mock install
  const mockBin = path.join(installDir, 'bin');
  fs.mkdirSync(mockBin, { recursive: true });
  fs.copyFileSync(path.join(BIN, 'gstack-config'), path.join(mockBin, 'gstack-config'));
  fs.chmodSync(path.join(mockBin, 'gstack-config'), 0o755);
  if (fs.existsSync(path.join(BIN, 'gstack-relink'))) {
    fs.copyFileSync(path.join(BIN, 'gstack-relink'), path.join(mockBin, 'gstack-relink'));
    fs.chmodSync(path.join(mockBin, 'gstack-relink'), 0o755);
  }

  // Create mock skill directories
  for (const skill of skills) {
    fs.mkdirSync(path.join(installDir, skill), { recursive: true });
    fs.writeFileSync(path.join(installDir, skill, 'SKILL.md'), `# ${skill}`);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-relink-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-relink (#578)', () => {
  // Test 11: prefixed symlinks when skill_prefix=true
  test('creates gstack-* symlinks when skill_prefix=true', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    // Set config to prefix mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`);
    // Run relink with env pointing to the mock install
    const output = run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Verify gstack-* symlinks exist
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-ship'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-review'))).toBe(true);
    expect(output).toContain('gstack-');
  });

  // Test 12: flat symlinks when skill_prefix=false
  test('creates flat symlinks when skill_prefix=false', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`);
    const output = run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'ship'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'review'))).toBe(true);
    expect(output).toContain('flat');
  });

  // Test 13: cleans stale symlinks from opposite mode
  test('cleans up stale symlinks from opposite mode', () => {
    setupMockInstall(['qa', 'ship']);
    // Create prefixed symlinks first
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`);
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(true);

    // Switch to flat mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`);
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });

    // Flat symlinks should exist, prefixed should be gone
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
  });

  // Test 14: error when install dir missing
  test('prints error when install dir missing', () => {
    const output = run(`${BIN}/gstack-relink`, {
      GSTACK_INSTALL_DIR: '/nonexistent/path/gstack',
      GSTACK_SKILLS_DIR: '/nonexistent/path/skills',
    }, true);
    expect(output).toContain('setup');
  });

  // Test: gstack-upgrade does NOT get double-prefixed
  test('does not double-prefix gstack-upgrade directory', () => {
    setupMockInstall(['qa', 'ship', 'gstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`);
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // gstack-upgrade should keep its name, NOT become gstack-gstack-upgrade
    expect(fs.existsSync(path.join(skillsDir, 'gstack-upgrade'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-gstack-upgrade'))).toBe(false);
    // Regular skills still get prefixed
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(true);
  });

  // Test 15: gstack-config set skill_prefix triggers relink
  test('gstack-config set skill_prefix triggers relink', () => {
    setupMockInstall(['qa', 'ship']);
    // Run gstack-config set which should auto-trigger relink
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // If relink was triggered, symlinks should exist
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-ship'))).toBe(true);
  });
});
