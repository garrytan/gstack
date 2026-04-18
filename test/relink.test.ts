import { describe, test as _bunTest, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Every test in this file shells out to gstack-config + gstack-relink (bash scripts
// invoking subprocess work). Under parallel bun test load, subprocess spawn contends
// with other suites and each test can drift ~200ms past the 5s default. Bump to 15s.
// Object.assign preserves test.only / test.skip / test.each / test.todo sub-APIs.
const test = Object.assign(
  ((name: any, fn: any, timeout?: number) =>
    _bunTest(name, fn, timeout ?? 15_000)) as typeof _bunTest,
  _bunTest,
);

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
  if (fs.existsSync(path.join(BIN, 'gstack-patch-names'))) {
    fs.copyFileSync(path.join(BIN, 'gstack-patch-names'), path.join(mockBin, 'gstack-patch-names'));
    fs.chmodSync(path.join(mockBin, 'gstack-patch-names'), 0o755);
  }

  // Create mock skill directories with proper frontmatter
  for (const skill of skills) {
    fs.mkdirSync(path.join(installDir, skill), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: test\n---\n# ${skill}`
    );
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
    // Set config to prefix mode (pass install/skills env so auto-relink uses mock install)
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
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
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    const output = run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'ship'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'review'))).toBe(true);
    expect(output).toContain('flat');
  });

  // REGRESSION: unprefixed skills must be real directories, not symlinks (#761)
  // Claude Code auto-prefixes skills nested under a parent dir symlink.
  // e.g., `qa -> gstack/qa` gets discovered as "gstack-qa", not "qa".
  // The fix: create real directories with SKILL.md symlinks inside.
  test('unprefixed skills are real directories with SKILL.md symlinks, not dir symlinks', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    for (const skill of ['qa', 'ship', 'review', 'plan-ceo-review']) {
      const skillPath = path.join(skillsDir, skill);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      // Must be a real directory, NOT a symlink
      expect(fs.lstatSync(skillPath).isDirectory()).toBe(true);
      expect(fs.lstatSync(skillPath).isSymbolicLink()).toBe(false);
      // Must contain a SKILL.md that IS a symlink
      expect(fs.existsSync(skillMdPath)).toBe(true);
      expect(fs.lstatSync(skillMdPath).isSymbolicLink()).toBe(true);
      // The SKILL.md symlink must point to the source skill's SKILL.md
      const target = fs.readlinkSync(skillMdPath);
      expect(target).toContain(skill);
      expect(target).toEndWith('/SKILL.md');
    }
  });

  // Same invariant for prefixed mode
  test('prefixed skills are real directories with SKILL.md symlinks, not dir symlinks', () => {
    setupMockInstall(['qa', 'ship']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    for (const skill of ['gstack-qa', 'gstack-ship']) {
      const skillPath = path.join(skillsDir, skill);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      expect(fs.lstatSync(skillPath).isDirectory()).toBe(true);
      expect(fs.lstatSync(skillPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(skillMdPath).isSymbolicLink()).toBe(true);
    }
  });

  // Upgrade: old directory symlinks get replaced with real directories
  test('upgrades old directory symlinks to real directories', () => {
    setupMockInstall(['qa', 'ship']);
    // Simulate old behavior: create directory symlinks (the old pattern)
    fs.symlinkSync(path.join(installDir, 'qa'), path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(installDir, 'ship'), path.join(skillsDir, 'ship'));
    // Verify they start as symlinks
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isSymbolicLink()).toBe(true);

    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });

    // After relink: must be real directories, not symlinks
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
  });

  // FIRST INSTALL: --no-prefix must create ONLY flat names, zero gstack-* pollution
  test('first install --no-prefix: only flat names exist, zero gstack-* entries', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review', 'gstack-upgrade']);
    // Simulate first install: no saved config, pass --no-prefix equivalent
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Enumerate everything in skills dir
    const entries = fs.readdirSync(skillsDir);
    // Expected: qa, ship, review, plan-ceo-review, gstack-upgrade (its real name)
    expect(entries.sort()).toEqual(['gstack-upgrade', 'plan-ceo-review', 'qa', 'review', 'ship']);
    // No gstack-qa, gstack-ship, gstack-review, gstack-plan-ceo-review
    const leaked = entries.filter(e => e.startsWith('gstack-') && e !== 'gstack-upgrade');
    expect(leaked).toEqual([]);
  });

  // FIRST INSTALL: --prefix must create ONLY gstack-* names, zero flat-name pollution
  test('first install --prefix: only gstack-* entries exist, zero flat names', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review', 'gstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    const entries = fs.readdirSync(skillsDir);
    // Expected: gstack-qa, gstack-ship, gstack-review, gstack-plan-ceo-review, gstack-upgrade
    expect(entries.sort()).toEqual([
      'gstack-plan-ceo-review', 'gstack-qa', 'gstack-review', 'gstack-ship', 'gstack-upgrade',
    ]);
    // No unprefixed qa, ship, review, plan-ceo-review
    const leaked = entries.filter(e => !e.startsWith('gstack-'));
    expect(leaked).toEqual([]);
  });

  // FIRST INSTALL: non-TTY (no saved config, piped stdin) defaults to flat names
  test('non-TTY first install defaults to flat names via relink', () => {
    setupMockInstall(['qa', 'ship']);
    // Don't set any config — simulate fresh install
    // gstack-relink reads config; on fresh install config returns empty → defaults to false
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    const entries = fs.readdirSync(skillsDir);
    // Should be flat names (relink defaults to false when config returns empty)
    expect(entries.sort()).toEqual(['qa', 'ship']);
  });

  // SWITCH: prefix → no-prefix must clean up ALL gstack-* entries
  test('switching prefix to no-prefix removes all gstack-* entries completely', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review', 'gstack-upgrade']);
    // Start in prefix mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    let entries = fs.readdirSync(skillsDir);
    expect(entries.filter(e => !e.startsWith('gstack-'))).toEqual([]);

    // Switch to no-prefix
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    entries = fs.readdirSync(skillsDir);
    // Only flat names + gstack-upgrade (its real name)
    expect(entries.sort()).toEqual(['gstack-upgrade', 'plan-ceo-review', 'qa', 'review', 'ship']);
    const leaked = entries.filter(e => e.startsWith('gstack-') && e !== 'gstack-upgrade');
    expect(leaked).toEqual([]);
  });

  // SWITCH: no-prefix → prefix must clean up ALL flat entries
  test('switching no-prefix to prefix removes all flat entries completely', () => {
    setupMockInstall(['qa', 'ship', 'review', 'gstack-upgrade']);
    // Start in no-prefix mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    let entries = fs.readdirSync(skillsDir);
    expect(entries.filter(e => e.startsWith('gstack-') && e !== 'gstack-upgrade')).toEqual([]);

    // Switch to prefix
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    entries = fs.readdirSync(skillsDir);
    // Only gstack-* names
    expect(entries.sort()).toEqual([
      'gstack-qa', 'gstack-review', 'gstack-ship', 'gstack-upgrade',
    ]);
    const leaked = entries.filter(e => !e.startsWith('gstack-'));
    expect(leaked).toEqual([]);
  });

  // Test 13: cleans stale symlinks from opposite mode
  test('cleans up stale symlinks from opposite mode', () => {
    setupMockInstall(['qa', 'ship']);
    // Create prefixed symlinks first
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(true);

    // Switch to flat mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
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
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
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

describe('upgrade migrations', () => {
  const MIGRATIONS_DIR = path.join(ROOT, 'gstack-upgrade', 'migrations');

  test('migrations directory exists', () => {
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  test('all migration scripts are executable and parse without syntax errors', () => {
    const scripts = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sh'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const fullPath = path.join(MIGRATIONS_DIR, script);
      // Must be executable
      const stat = fs.statSync(fullPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
      // Must parse without syntax errors (bash -n is a syntax check, doesn't execute)
      const result = execSync(`bash -n "${fullPath}" 2>&1`, { encoding: 'utf-8', timeout: 5000 });
      // bash -n outputs nothing on success
    }
  });

  test('migration filenames follow v{VERSION}.sh pattern', () => {
    const scripts = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sh'));
    for (const script of scripts) {
      expect(script).toMatch(/^v\d+\.\d+\.\d+\.\d+\.sh$/);
    }
  });

  test('v0.15.2.0 migration runs gstack-relink', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, 'v0.15.2.0.sh'), 'utf-8');
    expect(content).toContain('gstack-relink');
  });

  test('v0.15.2.0 migration fixes stale directory symlinks', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    // Simulate old state: directory symlinks (pre-v0.15.2.0 pattern)
    fs.symlinkSync(path.join(installDir, 'qa'), path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(installDir, 'ship'), path.join(skillsDir, 'ship'));
    fs.symlinkSync(path.join(installDir, 'review'), path.join(skillsDir, 'review'));
    // Set no-prefix mode (suppress auto-relink so symlinks stay intact for the test)
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_SETUP_RUNNING: '1',
    });
    // Verify old state: symlinks
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isSymbolicLink()).toBe(true);

    // Run the migration (it calls gstack-relink internally)
    run(`bash ${path.join(MIGRATIONS_DIR, 'v0.15.2.0.sh')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });

    // After migration: real directories with SKILL.md symlinks
    for (const skill of ['qa', 'ship', 'review']) {
      const skillPath = path.join(skillsDir, skill);
      expect(fs.lstatSync(skillPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(skillPath).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(skillPath, 'SKILL.md')).isSymbolicLink()).toBe(true);
    }
  });
});

describe('gstack-patch-names (#620/#578)', () => {
  // Helper to read name: from SKILL.md frontmatter
  function readSkillName(skillDir: string): string | null {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const match = content.match(/^name:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  test('prefix=true patches name: field in SKILL.md', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Verify name: field is patched with gstack- prefix
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('gstack-qa');
    expect(readSkillName(path.join(installDir, 'ship'))).toBe('gstack-ship');
    expect(readSkillName(path.join(installDir, 'review'))).toBe('gstack-review');
  });

  test('prefix=false restores name: field in SKILL.md', () => {
    setupMockInstall(['qa', 'ship']);
    // First, prefix them
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('gstack-qa');
    // Now switch to flat mode
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Verify name: field is restored to unprefixed
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('qa');
    expect(readSkillName(path.join(installDir, 'ship'))).toBe('ship');
  });

  test('gstack-upgrade name: not double-prefixed', () => {
    setupMockInstall(['qa', 'gstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // gstack-upgrade should keep its name, NOT become gstack-gstack-upgrade
    expect(readSkillName(path.join(installDir, 'gstack-upgrade'))).toBe('gstack-upgrade');
    // Regular skill should be prefixed
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('gstack-qa');
  });

  test('SKILL.md without frontmatter is a no-op', () => {
    setupMockInstall(['qa']);
    // Overwrite qa SKILL.md with no frontmatter
    fs.writeFileSync(path.join(installDir, 'qa', 'SKILL.md'), '# qa\nSome content.');
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Should not crash
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    // Content should be unchanged (no name: to patch)
    const content = fs.readFileSync(path.join(installDir, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# qa\nSome content.');
  });
});
