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
      // A sibling test file in the same shard PROCESS can leave GSTACK_HOME
      // set on process.env; relink/config children must resolve state ONLY
      // via the dirs this test passes (observed: 'fresh install' test saw a
      // neighbor's skill_prefix and produced prefixed names).
      env: (() => {
        const child: Record<string, string | undefined> = { ...process.env, GSTACK_STATE_DIR: tmpDir, ...env };
        if (!('GSTACK_HOME' in env)) delete child.GSTACK_HOME;
        return child;
      })(),
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

  test('creates a thin root alias wrapper for the /gstack slash command', () => {
    setupMockInstall(['qa']);
    fs.writeFileSync(
      path.join(installDir, 'SKILL.md'),
      '---\nname: gstack\ndescription: root\n---\n# gstack',
    );

    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });

    const aliasDir = path.join(skillsDir, '_gstack-command');
    const aliasSkill = path.join(aliasDir, 'SKILL.md');
    expect(fs.lstatSync(aliasDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(aliasDir).isSymbolicLink()).toBe(false);
    // #2511: the alias is a rewritten COPY, never a symlink. A symlinked
    // alias re-serves the canonical `name: gstack`; Claude Code refuses
    // duplicate skill names and drops the entire personal-skills set.
    expect(fs.lstatSync(aliasSkill).isSymbolicLink()).toBe(false);
    const aliasContent = fs.readFileSync(aliasSkill, 'utf-8');
    expect(aliasContent).toContain('name: _gstack-command');
    expect(aliasContent).not.toContain('name: gstack\n');
    // The rewrite happened on the COPY: the canonical source keeps its name.
    expect(fs.readFileSync(path.join(installDir, 'SKILL.md'), 'utf-8')).toContain('name: gstack');

    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(aliasSkill)).toBe(true);
  });

  // #2201: connect-chrome ships as a dir SYMLINK to open-gstack-browser. The
  // discovery loop used to link it under its own basename while its SKILL.md
  // carried `name: open-gstack-browser` — a duplicate name that silently
  // shadows the real skill (readdir-order roulette). Symlinked source dirs
  // must be skipped; setup owns the rewritten-copy alias.
  test('symlinked skill dirs are skipped, so no duplicate frontmatter names (#2201)', () => {
    setupMockInstall(['open-gstack-browser', 'qa']);
    fs.symlinkSync(
      path.join(installDir, 'open-gstack-browser'),
      path.join(installDir, 'connect-chrome'),
    );
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
    });

    expect(fs.existsSync(path.join(skillsDir, 'open-gstack-browser'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'connect-chrome'))).toBe(false);

    // No two installed SKILL.md files may share a frontmatter name.
    const names: string[] = [];
    for (const entry of fs.readdirSync(skillsDir)) {
      const skillMd = path.join(skillsDir, entry, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const m = fs.readFileSync(skillMd, 'utf-8').match(/^name:\s*(\S+)/m);
      if (m) names.push(m[1]);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  // #2569: rendered :user variants live in ${GSTACK_HOME}/render/claude.
  // relink must serve the render when present — otherwise any config change
  // silently flips every skill back to the canonical (blockless) source.
  test('prefers a rendered SKILL.md from GSTACK_HOME/render/claude (#2569)', () => {
    setupMockInstall(['qa', 'ship']);
    const renderDir = path.join(tmpDir, 'render', 'claude', 'qa');
    fs.mkdirSync(renderDir, { recursive: true });
    fs.writeFileSync(
      path.join(renderDir, 'SKILL.md'),
      '---\nname: qa\ndescription: test\n---\nrendered brain-aware qa',
    );

    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: tmpDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: tmpDir,
    });

    const qaLink = path.join(skillsDir, 'qa', 'SKILL.md');
    expect(fs.readlinkSync(qaLink)).toBe(path.join(renderDir, 'SKILL.md'));
    expect(fs.readFileSync(qaLink, 'utf-8')).toContain('rendered brain-aware qa');
    // ship has no render — canonical source link.
    expect(fs.readlinkSync(path.join(skillsDir, 'ship', 'SKILL.md'))).toBe(
      path.join(installDir, 'ship', 'SKILL.md'),
    );
  });

  // #2738: with skill_prefix=true AND an active gbrain render, the symlink
  // target is the RENDER copy — so the render's `name:` must get the gstack-
  // prefix too, or the served frontmatter stays unprefixed and skill_prefix
  // silently no-ops for every brain-aware skill.
  test('skill_prefix=true patches the rendered SKILL.md name too (#2738)', () => {
    setupMockInstall(['qa']);
    const renderDir = path.join(tmpDir, 'render', 'claude', 'qa');
    fs.mkdirSync(renderDir, { recursive: true });
    fs.writeFileSync(
      path.join(renderDir, 'SKILL.md'),
      '---\nname: qa\ndescription: test\n---\nrendered brain-aware qa',
    );

    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix true`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: tmpDir,
    });
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: tmpDir,
    });

    const served = path.join(skillsDir, 'gstack-qa', 'SKILL.md');
    expect(fs.readlinkSync(served)).toBe(path.join(renderDir, 'SKILL.md'));
    // The SERVED file (the render) carries the prefixed name.
    expect(fs.readFileSync(served, 'utf-8')).toContain('name: gstack-qa');
    // Idempotent: a second relink must not double-prefix.
    run(`${path.join(installDir, 'bin', 'gstack-relink')}`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: tmpDir,
    });
    expect(fs.readFileSync(served, 'utf-8')).toContain('name: gstack-qa');
    expect(fs.readFileSync(served, 'utf-8')).not.toContain('gstack-gstack-');
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

// ============================================================
// Ownership gate (#2119): relink runs on every ./setup and must never delete
// or link over a skill it does not own. Ownership = symlink into INSTALL_DIR
// or RENDER_DIR, a real dir whose SKILL.md is such a symlink, or the
// .gstack-owned marker setup writes for Windows copy installs.
// ============================================================
describe('gstack-relink ownership gate (#2119)', () => {
  const FOREIGN = '---\nname: qa\ndescription: my own qa skill\n---\n# not gstack';

  function relink(env: Record<string, string> = {}): string {
    return run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, {
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
      ...env,
    });
  }
  function setPrefix(v: 'true' | 'false') {
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix ${v}`, {
      GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir, GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
    });
  }

  test('flat mode: a foreign real dir with a real SKILL.md is never linked over (Linux ln -snf would replace the file)', () => {
    setupMockInstall(['qa', 'ship']);
    // The foreign skill exists before gstack ever runs (gstack-config `set`
    // auto-relinks, so fixtures go in first).
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.writeFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), FOREIGN);
    setPrefix('false');
    const out = relink();
    const md = path.join(skillsDir, 'qa', 'SKILL.md');
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(md, 'utf-8')).toBe(FOREIGN);
    expect(out).toContain('skipped');
    expect(out).toContain('Skipped 1 foreign entry');
    // The other skill still links normally.
    expect(fs.lstatSync(path.join(skillsDir, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(true);
  });

  test('prefix flip: a foreign flat entry sharing a skill name survives the cleanup pass', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.writeFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), FOREIGN);
    setPrefix('true');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(true);
    expect(out).toContain('skipped');
  });

  test('a foreign directory symlink sharing a skill name is left in place', () => {
    setupMockInstall(['qa']);
    const elsewhere = path.join(tmpDir, 'elsewhere', 'qa');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), FOREIGN);
    fs.symlinkSync(elsewhere, path.join(skillsDir, 'qa'));
    setPrefix('false');
    const out = relink();
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(skillsDir, 'qa'))).toBe(elsewhere);
    expect(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
    expect(out).toContain('skipped');
  });

  test('an entry whose SKILL.md links into RENDER_DIR is ours and is cleaned on a mode flip', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    const renderDir = path.join(tmpDir, 'render', 'claude');
    fs.mkdirSync(path.join(renderDir, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(renderDir, 'qa', 'SKILL.md'), '---\nname: gstack-qa\ndescription: rendered\n---\n');
    // Stale prefixed entry from a prior prefix-mode run, pointing at the render.
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync(path.join(renderDir, 'qa', 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    const out = relink({ GSTACK_USER_RENDER_DIR: renderDir });
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(renderDir, 'qa', 'SKILL.md'));
    expect(out).not.toContain('skipped');
  });

  test('a real-file copy carrying the .gstack-owned marker (Windows install shape) is ours', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n');
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', '.gstack-owned'), '');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('a legacy RELATIVE symlink into the install (gstack/qa/SKILL.md) is ours and is cleaned', () => {
    setupMockInstall(['qa']);
    // Older setups wrote relative links; the skills dir sits beside the install
    // dir named `gstack`, so `gstack/qa/SKILL.md` resolves into INSTALL_DIR.
    const installAlias = path.join(skillsDir, 'gstack');
    fs.symlinkSync(installDir, installAlias);
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync('../gstack/qa/SKILL.md', path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('an entry linked against the REAL path of a symlinked install dir is ours', () => {
    setupMockInstall(['qa']);
    const realInstall = fs.realpathSync(installDir);
    const linkInstall = path.join(tmpDir, 'install-link');
    fs.symlinkSync(realInstall, linkInstall);
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync(path.join(realInstall, 'qa', 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    // relink detects the install through the symlinked spelling.
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix false`, {
      GSTACK_INSTALL_DIR: linkInstall, GSTACK_SKILLS_DIR: skillsDir,
    });
    const out = run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, {
      GSTACK_INSTALL_DIR: linkInstall, GSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('a real-file copy WITHOUT the marker is foreign and survives', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), FOREIGN);
    const out = relink();
    expect(fs.readFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
    expect(out).toContain('skipped');
  });

  // Before the gate, a stray regular FILE named like a skill made `mkdir -p`
  // fail under set -e and relink died mid-loop (exit 1, later skills never
  // linked). A non-dir, non-symlink entry is simply foreign now.
  test('a stray regular file with a skill name is foreign: relink completes, file untouched, other skills link', () => {
    setupMockInstall(['qa', 'ship']);
    fs.writeFileSync(path.join(skillsDir, 'qa'), 'stray notes\n');
    setPrefix('false');
    const out = relink();
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(skillsDir, 'qa'), 'utf-8')).toBe('stray notes\n');
    expect(fs.lstatSync(path.join(skillsDir, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(out).toContain('Relinked 1 skills as flat names');
    expect(out).toContain('Skipped 1 foreign entry');
  });

  test('a real dir whose SKILL.md symlink points OUTSIDE install/render is foreign in both the link pass and the flip cleanup', () => {
    setupMockInstall(['qa']);
    const elsewhere = path.join(tmpDir, 'elsewhere', 'qa');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), FOREIGN);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(elsewhere, 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    // Link pass (flat mode): the destination is not ours → never re-pointed.
    setPrefix('false');
    let out = relink();
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(elsewhere, 'SKILL.md'));
    expect(out).toContain('skipped');
    // Cleanup pass (prefix flip): the stale flat name is not ours → kept.
    setPrefix('true');
    out = relink();
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(elsewhere, 'SKILL.md'));
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(true);
    expect(out).toContain('skipped');
  });

  test('a sibling directory that merely shares the install dir as a prefix (…/gstack-install-fork) is not ours', () => {
    setupMockInstall(['qa']);
    const fork = installDir + '-fork';
    fs.mkdirSync(path.join(fork, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(fork, 'qa', 'SKILL.md'), FOREIGN);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(fork, 'qa', 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(fork, 'qa', 'SKILL.md'));
    expect(fs.readFileSync(path.join(fork, 'qa', 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
    expect(out).toContain('skipped');
  });

  test('several foreign entries: pluralized summary lists every name and the relinked count excludes them', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    for (const name of ['qa', 'ship']) {
      fs.mkdirSync(path.join(skillsDir, name));
      fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), FOREIGN);
    }
    setPrefix('false');
    const out = relink();
    expect(out).toContain('Relinked 1 skills as flat names');
    expect(out).toContain('Skipped 2 foreign entries');
    // Bare names, same wording as setup's own line, so setup can dedupe when it forwards relink's output.
    expect(out).toContain('skipped qa: existing entry is not gstack-managed');
    expect(out).toContain('skipped ship: existing entry is not gstack-managed');
    expect(out).toContain('left untouched): qa ship');
    expect(out).not.toContain('foreign entry ');
    expect(fs.lstatSync(path.join(skillsDir, 'review', 'SKILL.md')).isSymbolicLink()).toBe(true);
  });

  test('an opposite-mode WHOLE-DIR symlink into the install (oldest install shape) is ours and is removed on a flip', () => {
    setupMockInstall(['qa']);
    fs.symlinkSync(path.join(installDir, 'qa'), path.join(skillsDir, 'gstack-qa'));
    setPrefix('false');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(fs.lstatSync(path.join(skillsDir, 'gstack-qa'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(path.join(skillsDir, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(out).not.toContain('skipped');
  });
});

describe('gstack-relink ownership gate parity with setup (#2119 review fixes)', () => {
  const FOREIGN = '---\nname: qa\ndescription: my own qa skill\n---\n# not gstack';
  function relink(env: Record<string, string> = {}): string {
    return run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, {
      GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir, GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
      ...env,
    });
  }
  function setPrefix(v: 'true' | 'false') {
    run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix ${v}`, {
      GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir, GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
    });
  }

  test('a pre-marker legacy COPY carrying the generated header is ours (same rule as setup) and is cleaned on a flip', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# qa\n');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('a ONE-line AUTO-GENERATED substring is not provenance (another generator could emit it): entry survives', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n<!-- AUTO-GENERATED from my-tool -->\n# theirs\n');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(true);
    expect(out).toContain('skipped');
  });

  test('an absolute link that walks through a gstack segment with `..` is canonicalized first, not fast-pathed as ours', () => {
    setupMockInstall(['qa']);
    const decoy = path.join(tmpDir, 'x', 'gstack');
    const foreign = path.join(tmpDir, 'x', 'foreign');
    fs.mkdirSync(decoy, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), FOREIGN);
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync(path.join(decoy, '..', 'foreign', 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(true);
    expect(out).toContain('skipped');
  });

  test('a byte-identical copy of our source SKILL.md is ours even without marker or header', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.copyFileSync(path.join(installDir, 'qa', 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('an entry linked into a SIBLING gstack checkout (path segment `gstack`) is ours, like setup and uninstall treat it', () => {
    setupMockInstall(['qa']);
    setPrefix('false');
    const sibling = path.join(tmpDir, 'worktrees', 'gstack', 'qa');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'SKILL.md'), '---\nname: qa\n---\n');
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync(path.join(sibling, 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(out).not.toContain('skipped');
  });

  test('a fork under a `gstack-fork` directory is NOT ours (segment must be exactly gstack)', () => {
    setupMockInstall(['qa']);
    const fork = path.join(tmpDir, 'tools', 'gstack-fork', 'qa');
    fs.mkdirSync(fork, { recursive: true });
    fs.writeFileSync(path.join(fork, 'SKILL.md'), FOREIGN);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(fork, 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(fork, 'SKILL.md'));
    expect(out).toContain('skipped');
  });

  test('a DANGLING link from a moved checkout is healed, not reported foreign', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(tmpDir, 'old-checkout', 'gstack', 'qa', 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(out).not.toContain('skipped');
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(installDir, 'qa', 'SKILL.md'));
  });
});

describe('gstack-relink root alias (_gstack-command) ownership gate', () => {
  const ROOT_SKILL = '---\nname: gstack\ndescription: root\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# gstack root\n';
  function relink(): string {
    return run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, {
      GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir, GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
    });
  }

  test('a user-owned _gstack-command skill is reported and left byte-identical', () => {
    setupMockInstall(['qa']);
    fs.writeFileSync(path.join(installDir, 'SKILL.md'), ROOT_SKILL);
    const mine = '---\nname: _gstack-command\ndescription: my own command runner\n---\n# mine\n';
    fs.mkdirSync(path.join(skillsDir, '_gstack-command'));
    fs.writeFileSync(path.join(skillsDir, '_gstack-command', 'SKILL.md'), mine);
    const out = relink();
    expect(fs.readFileSync(path.join(skillsDir, '_gstack-command', 'SKILL.md'), 'utf-8')).toBe(mine);
    expect(fs.existsSync(path.join(skillsDir, '_gstack-command', '.gstack-owned'))).toBe(false);
    expect(out).toContain('skipped');
    expect(out).toContain('_gstack-command');
  });

  test('our own rewritten alias copy is refreshed and stamped with the ownership marker', () => {
    setupMockInstall(['qa']);
    fs.writeFileSync(path.join(installDir, 'SKILL.md'), ROOT_SKILL);
    const first = relink();
    expect(first).not.toContain('skipped');
    const alias = path.join(skillsDir, '_gstack-command');
    expect(fs.readFileSync(path.join(alias, 'SKILL.md'), 'utf-8')).toContain('name: _gstack-command');
    expect(fs.existsSync(path.join(alias, '.gstack-owned'))).toBe(true);
    // Stale copy (older render) with the marker: refreshed, not reported.
    fs.writeFileSync(path.join(alias, 'SKILL.md'), '---\nname: _gstack-command\n---\n# stale\n');
    const second = relink();
    expect(second).not.toContain('skipped');
    expect(fs.readFileSync(path.join(alias, 'SKILL.md'), 'utf-8')).toContain('# gstack root');
  });
});

describe('gstack-relink weak proof is file-scoped; differing files are moved aside (#2119 review)', () => {
  const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->';
  const env = () => ({
    GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir, GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
    GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
  });
  const relink = () => run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, env());
  const setPrefix = (v: 'true' | 'false') => run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix ${v}`, env());
  const backups = () => {
    const root = path.join(tmpDir, 'home', 'backups', 'skills');
    if (!fs.existsSync(root)) return [] as string[];
    return fs.readdirSync(root).flatMap((ts) => fs.readdirSync(path.join(root, ts)).map((n) => path.join(root, ts, n, 'SKILL.md')));
  };

  test('flip cleanup on a banner-only copy removes SKILL.md and keeps the user\'s other files and the directory', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa', 'my-templates'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), `---\nname: gstack-qa\n---\n${BANNER}\n# started from gstack\n`);
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'my-templates', 'checklist.md'), '- mine\n');
    setPrefix('false');
    const out = relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'gstack-qa', 'my-templates', 'checklist.md'), 'utf-8')).toBe('- mine\n');
    expect(out).not.toContain('skipped');
  });

  test('a marker-proven directory (we created it) is still removed whole on a flip', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), '# stale copy\n');
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'sections', 'a.md'), 'a\n');
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', '.gstack-owned'), installDir + '\n');
    setPrefix('false');
    relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
  });

  test('linking over a CUSTOMIZED banner copy moves it to the backup root first; the link then lands', () => {
    setupMockInstall(['qa']);
    const custom = `---\nname: qa\n---\n${BANNER}\n# my qa, started from gstack\n`;
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.writeFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), custom);
    setPrefix('false');
    const out = relink();
    expect(fs.lstatSync(path.join(skillsDir, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
    const saved = backups();
    expect(saved.length).toBe(1);
    expect(fs.readFileSync(saved[0], 'utf-8')).toBe(custom);
    expect(out).not.toContain('skipped');
  });

  test('linking over a byte-identical copy makes no backup', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.copyFileSync(path.join(installDir, 'qa', 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    setPrefix('false');
    relink();
    expect(fs.lstatSync(path.join(skillsDir, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(backups()).toEqual([]);
  });
});

describe('gstack-relink: checkout naming, legacy linked dirs, markers (#2119 review)', () => {
  const env = () => ({
    GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir,
    GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'),
  });
  const relink = () => run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, env());
  const setPrefix = (v: 'true' | 'false') => run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix ${v}`, env());

  test('an entry linked into a checkout whose path has no `gstack` segment (git worktree add ../gs-feature) is ours when that tree carries setup + VERSION + bin/', () => {
    setupMockInstall(['qa']);
    const other = path.join(tmpDir, 'gs-feature');
    fs.mkdirSync(path.join(other, 'qa'), { recursive: true });
    fs.mkdirSync(path.join(other, 'bin'));
    fs.writeFileSync(path.join(other, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(other, 'setup'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(other, 'bin', 'gstack-relink'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(other, 'qa', 'SKILL.md'), '---\nname: qa\n---\n');
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(other, 'qa', 'SKILL.md'), path.join(skillsDir, 'qa', 'SKILL.md'));
    setPrefix('false');
    const out = relink();
    expect(out).not.toContain('skipped');
    expect(fs.readlinkSync(path.join(skillsDir, 'qa', 'SKILL.md'))).toBe(path.join(installDir, 'qa', 'SKILL.md'));
    // ...but a hand-written skill repo with VERSION + setup + bin/ (no gstack-relink) is not a gstack tree.
    const plain = path.join(tmpDir, 'plain-tools');
    fs.mkdirSync(path.join(plain, 'ship'), { recursive: true });
    fs.mkdirSync(path.join(plain, 'bin'));
    fs.writeFileSync(path.join(plain, 'VERSION'), '0.1\n');
    fs.writeFileSync(path.join(plain, 'setup'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(plain, 'ship', 'SKILL.md'), '---\nname: ship\n---\n');
    fs.mkdirSync(path.join(installDir, 'ship'));
    fs.writeFileSync(path.join(installDir, 'ship', 'SKILL.md'), '---\nname: ship\n---\n');
    fs.mkdirSync(path.join(skillsDir, 'ship'));
    fs.symlinkSync(path.join(plain, 'ship', 'SKILL.md'), path.join(skillsDir, 'ship', 'SKILL.md'));
    const out2 = relink();
    expect(out2).toContain('skipped ship');
  });

  test('a directory relink creates gets the marker on Linux; a pre-existing unclaimed directory does not', () => {
    setupMockInstall(['qa', 'ship']);
    fs.mkdirSync(path.join(skillsDir, 'ship'));
    fs.writeFileSync(path.join(skillsDir, 'ship', 'notes.md'), 'mine\n');
    setPrefix('false');
    relink();
    expect(fs.existsSync(path.join(skillsDir, 'qa', '.gstack-owned'))).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'ship', '.gstack-owned'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'ship', 'notes.md'), 'utf-8')).toBe('mine\n');
  });

  test('flip on a legacy linked dir (no marker): all-links dir is removed whole; a dir with a user file keeps the file and drops our links', () => {
    setupMockInstall(['qa', 'ship']);
    fs.mkdirSync(path.join(installDir, 'qa', 'sections'));
    for (const name of ['gstack-qa', 'gstack-ship']) {
      fs.mkdirSync(path.join(skillsDir, name));
      fs.symlinkSync(path.join(installDir, 'qa', 'SKILL.md'), path.join(skillsDir, name, 'SKILL.md'));
      fs.symlinkSync(path.join(installDir, 'qa', 'sections'), path.join(skillsDir, name, 'sections'));
    }
    fs.writeFileSync(path.join(skillsDir, 'gstack-ship', 'my-notes.md'), 'keep\n');
    // gstack-config `set` auto-relinks, so the flip cleanup runs there; capture both outputs.
    const out = setPrefix('false') + relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-ship', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-ship', 'sections'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'gstack-ship', 'my-notes.md'), 'utf-8')).toBe('keep\n');
    expect(out).toContain('cleaned gstack-ship/SKILL.md');
    expect(out).not.toContain('skipped');
  });
});

describe('gstack-relink cycle-3 hardening: foreign dir links, failed backups, flip backups, mixed dirs (#2119 review)', () => {
  const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->';
  const env = (extra: Record<string, string> = {}) => ({
    GSTACK_INSTALL_DIR: installDir, GSTACK_SKILLS_DIR: skillsDir,
    GSTACK_HOME: path.join(tmpDir, 'home'), GSTACK_USER_RENDER_DIR: path.join(tmpDir, 'no-render'), ...extra,
  });
  const relink = (extra: Record<string, string> = {}) => run(`${path.join(installDir, 'bin', 'gstack-relink')} 2>&1`, env(extra));
  const setPrefix = (v: 'true' | 'false') => run(`${path.join(installDir, 'bin', 'gstack-config')} set skill_prefix ${v}`, env());
  const backups = (home = path.join(tmpDir, 'home')) => {
    const root = path.join(home, 'backups', 'skills');
    if (!fs.existsSync(root)) return [] as string[];
    return fs.readdirSync(root).flatMap((ts) => fs.readdirSync(path.join(root, ts)).map((n) => path.join(root, ts, n, 'SKILL.md')));
  };

  test('a foreign DIRECTORY symlink whose target has no SKILL.md is foreign, not unclaimed', () => {
    setupMockInstall(['qa']);
    const userdir = path.join(tmpDir, 'userdir');
    fs.mkdirSync(userdir);
    fs.writeFileSync(path.join(userdir, 'notes.md'), 'mine\n');
    fs.symlinkSync(userdir, path.join(skillsDir, 'qa'));
    setPrefix('false');
    const out = relink();
    expect(out).toContain('skipped qa');
    expect(fs.readlinkSync(path.join(skillsDir, 'qa'))).toBe(userdir);
    expect(fs.existsSync(path.join(userdir, 'SKILL.md'))).toBe(false);
  });

  test('flip cleanup moves a CUSTOMIZED banner copy to the backup root instead of deleting it', () => {
    setupMockInstall(['qa']);
    const custom = `---\nname: gstack-qa\n---\n${BANNER}\n# customized\n`;
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.writeFileSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'), custom);
    setPrefix('false');
    relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa'))).toBe(false);
    const saved = backups();
    expect(saved.length).toBe(1);
    expect(fs.readFileSync(saved[0], 'utf-8')).toBe(custom);
  });

  test('when the backup root cannot be created, the customized file stays and the entry is reported', () => {
    setupMockInstall(['qa']);
    const custom = `---\nname: qa\n---\n${BANNER}\n# customized\n`;
    fs.mkdirSync(path.join(skillsDir, 'qa'));
    fs.writeFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), custom);
    fs.mkdirSync(path.join(tmpDir, 'home'));
    fs.writeFileSync(path.join(tmpDir, 'home', 'backups'), 'not a dir');
    setPrefix('false');
    const out = relink();
    expect(out).toContain('could not back up');
    expect(fs.lstatSync(path.join(skillsDir, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'qa', 'SKILL.md'), 'utf-8')).toBe(custom);
  });

  test('a legacy linked dir holding the user\'s OWN symlink is mixed: our links go, theirs stays', () => {
    setupMockInstall(['qa']);
    fs.mkdirSync(path.join(installDir, 'qa', 'sections'));
    fs.mkdirSync(path.join(skillsDir, 'gstack-qa'));
    fs.symlinkSync(path.join(installDir, 'qa', 'SKILL.md'), path.join(skillsDir, 'gstack-qa', 'SKILL.md'));
    fs.symlinkSync(path.join(installDir, 'qa', 'sections'), path.join(skillsDir, 'gstack-qa', 'sections'));
    fs.writeFileSync(path.join(tmpDir, 'my-notes.md'), 'mine\n');
    fs.symlinkSync(path.join(tmpDir, 'my-notes.md'), path.join(skillsDir, 'gstack-qa', 'notes.md'));
    setPrefix('false');
    relink();
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'gstack-qa', 'sections'))).toBe(false);
    expect(fs.readlinkSync(path.join(skillsDir, 'gstack-qa', 'notes.md'))).toBe(path.join(tmpDir, 'my-notes.md'));
  });

  test('the root alias marker is written only for a directory relink creates', () => {
    setupMockInstall(['qa']);
    fs.writeFileSync(path.join(installDir, 'SKILL.md'), `---\nname: gstack\n---\n${BANNER}\n# root\n`);
    fs.mkdirSync(path.join(skillsDir, '_gstack-command'));
    fs.writeFileSync(path.join(skillsDir, '_gstack-command', 'notes.md'), 'mine\n');
    setPrefix('false');
    relink();
    expect(fs.readFileSync(path.join(skillsDir, '_gstack-command', 'SKILL.md'), 'utf-8')).toContain('name: _gstack-command');
    expect(fs.existsSync(path.join(skillsDir, '_gstack-command', '.gstack-owned'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, '_gstack-command', 'notes.md'), 'utf-8')).toBe('mine\n');
  });
});
