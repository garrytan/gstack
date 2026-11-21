/**
 * #3084 (data loss): with the gstack checkout at ~/.cursor/skills/gstack and
 * ~/.claude/skills/gstack a symlink to it, `./setup --host cursor` swapped the
 * Cursor runtime root in over the checkout and deleted it, and `--status` had
 * suggested exactly that command. Setup now refuses to replace or remove a
 * runtime root that is, or contains, the running checkout (before any write,
 * and again in _activate_runtime_root, which covers all six host arms), and
 * `--status` suggests moving the checkout instead. Positive controls: the
 * canonical Claude install, a repeat ./setup, and the Codex direct-install
 * migration still succeed.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureMkdirSync, makeFixture, makeSource, registryRows, runSetup, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const ANCHOR = 'docs/troubleshooting.md#setup-runtime-root-contains-checkout';

describe.skipIf(process.platform === 'win32')('setup never replaces a runtime root that holds the running checkout (#3084)', () => {
  function cursorLayout() {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.cursor/skills/gstack'));
    const claudeLink = join(f.home, '.claude/skills/gstack');
    fixtureMkdirSync(join(f.home, '.claude/skills'), { recursive: true });
    symlinkSync(src, claudeLink, 'dir');
    return { f, src: realpathSync(src), claudeLink };
  }

  test('the issue layout: --status suggests the move, and ./setup --host cursor is refused with the checkout byte-identical', () => {
    const { f, src, claudeLink } = cursorLayout();
    const move = `rm ${claudeLink} && mv ${src} ${claudeLink} && cd ${claudeLink} && ./setup --host claude && ./setup --host cursor`;

    const status = runSetup(f, join(src, 'setup'), ['--status']);
    expect(status.stdout).toContain(move);
    expect(status.stdout).toContain(ANCHOR);
    expect(status.stdout).not.toContain(`register it: cd ${src} && ./setup --host cursor`);

    const before = tree(src);
    const r = runSetup(f, join(src, 'setup'), ['--host', 'cursor']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`gstack setup: refusing to replace ${src} for cursor: this runtime directory contains the source checkout setup runs from`);
    expect(r.stderr).toContain('Nothing was changed.');
    expect(r.stderr).toContain(`    ${move}`);
    expect(r.stderr).toContain(`https://github.com/garrytan/gstack/blob/main/${ANCHOR}`);
    expect(r.stderr).not.toContain('previous install was left in place');
    expect(tree(src)).toEqual(before);
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(registryRows(f).filter(row => row[0] === 'cursor')).toEqual([]);
  }, 90_000);

  test('a checkout nested inside a host runtime root is refused for every arm that writes a root', () => {
    for (const [host, root] of [['kiro', '.kiro/skills/gstack'], ['factory', '.factory/skills/gstack'], ['opencode', '.config/opencode/skills/gstack'],
      ['copilot', '.copilot/skills/gstack'], ['agy', '.gemini/antigravity-cli/skills/gstack']] as const) {
      const f = makeFixture();
      const src = makeSource(f, join(f.home, root, 'checkout'));
      const before = tree(join(f.home, root));
      const r = runSetup(f, join(src, 'setup'), ['--host', host]);
      expect(r.status, `${host}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr).toContain(`refusing to replace ${realpathSync(join(f.home, root))} for ${host}`);
      expect(r.stderr).toContain(`mv ${realpathSync(src)} ~/gstack && cd ~/gstack && ./setup --host ${host}`);
      expect(tree(join(f.home, root))).toEqual(before);
    }
  }, 240_000);

  test('the guard sits in _activate_runtime_root, which every host arm that swaps a root calls', () => {
    const setup = readFileSync(join(import.meta.dir, '..', 'setup'), 'utf8');
    const fn = setup.slice(setup.indexOf('_activate_runtime_root() {'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/_runtime_root_refused "\$\{_SETUP_ARM%%\t\*\}" "\$root" && return 1/);
    const arms = [...setup.matchAll(/_activate_runtime_root create_(\w+)_runtime_root/g)].map(m => m[1]);
    expect([...new Set(arms)].sort()).toEqual(['agy', 'codex', 'copilot', 'cursor', 'factory', 'opencode']);
  });

  test('control: the canonical ~/.claude/skills/gstack install and a repeat ./setup succeed', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    for (let run = 0; run < 2; run++) {
      const r = runSetup(f, join(src, 'setup'), ['--host', 'claude', '--no-team']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).not.toContain('refusing to replace');
    }
    expect(existsSync(join(src, 'setup'))).toBe(true);
    expect(registryRows(f).some(row => row[0] === 'claude')).toBe(true);
  }, 120_000);

  // @szsunyuan (#3128): only the link goes, so a symlinked root is replaced.
  test('control: a runtime root that is a symlink to the checkout is replaced, and the checkout survives', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    fixtureMkdirSync(join(f.home, '.cursor/skills'), { recursive: true });
    symlinkSync(src, join(f.home, '.cursor/skills/gstack'), 'dir');
    const r = runSetup(f, join(src, 'setup'), ['--host', 'cursor']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('refusing to replace');
    expect(lstatSync(join(f.home, '.cursor/skills/gstack')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(f.home, '.cursor/skills/gstack/SKILL.md'))).toBe(true);
    for (const file of ['setup', 'VERSION', 'bin/gstack-hook-check']) expect(existsSync(join(src, file))).toBe(true);
  }, 120_000);

  test('a Kiro checkout at ~/.kiro/skills/gstack is refused, not linked into itself', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.kiro/skills/gstack'));
    const before = tree(src);
    const r = runSetup(f, join(src, 'setup'), ['--host', 'kiro']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`refusing to replace ${realpathSync(src)} for kiro`);
    expect(tree(src)).toEqual(before);
  }, 120_000);

  test('control: a Cursor install from a checkout elsewhere replaces its runtime root, twice', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    for (let run = 0; run < 2; run++) {
      const r = runSetup(f, join(src, 'setup'), ['--host', 'cursor']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).not.toContain('refusing to replace');
    }
    expect(existsSync(join(f.home, '.cursor/skills/gstack/SKILL.md'))).toBe(true);
    expect(existsSync(join(src, 'setup'))).toBe(true);
  }, 120_000);

  test('control: the Codex direct-install migration still moves ~/.codex/skills/gstack to ~/.gstack/repos/gstack', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.codex/skills/gstack'));
    const r = runSetup(f, join(src, 'setup'), ['--host', 'codex']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain('Migrating direct Codex install');
    expect(r.stderr).not.toContain('refusing to replace');
    expect(existsSync(join(f.home, '.gstack/repos/gstack/setup'))).toBe(true);
    expect(existsSync(join(f.home, '.codex/skills/gstack/SKILL.md'))).toBe(true);
  }, 120_000);

  test('the failure summary says "previous install was left in place" only after verifying it', () => {
    const setup = readFileSync(join(import.meta.dir, '..', 'setup'), 'utf8');
    const helpers = setup.slice(setup.indexOf('_SETUP_ROWS=""'), setup.indexOf('# Aside (aside.com'));
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'setup-summary-')));
    try {
      mkdirSync(join(base, 'src'));
      writeFileSync(join(base, 'src', 'setup'), '');
      mkdirSync(join(base, 'skills', 'gstack'), { recursive: true });
      const summary = (src: string, root: string, refused = '') => spawnSync('bash', ['-c', [
        'QUIET=0 SETUP_VERSION=1.0 _DISABLED_SKILLS=""',
        'gstack_install_registry_render() { cat; }',
        helpers,
        `SOURCE_GSTACK_DIR='${src}'`,
        `_setup_arm_begin cursor global '${join(base, 'skills')}'`,
        `_SETUP_ARM_ROOT='${root}' _SETUP_REFUSED='${refused}'`,
        '_setup_exit_summary 1',
      ].join('\n')], { encoding: 'utf8', timeout: 10_000 }).stderr;
      expect(summary(join(base, 'src'), join(base, 'skills', 'gstack'))).toContain('its previous install was left in place. Retry: cd ');
      const gone = summary(join(base, 'gone'), join(base, 'skills', 'gstack'));
      expect(gone).not.toContain('left in place');
      expect(gone).toContain('its install could not be verified');
      expect(gone).toContain('git clone --depth 1 https://github.com/garrytan/gstack.git ~/gstack && cd ~/gstack && ./setup --host cursor');
      expect(summary(join(base, 'src'), join(base, 'skills', 'missing-root'))).toContain('could not be verified');
      expect(summary(join(base, 'src'), join(base, 'skills', 'gstack'), 'refused: moved')).toContain('refused: moved');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
