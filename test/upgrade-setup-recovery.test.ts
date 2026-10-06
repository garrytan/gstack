import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const template = readFileSync(join(import.meta.dir, '../gstack-upgrade/SKILL.md.tmpl'), 'utf8');
const blockAfter = (marker: string) => {
  const section = template.slice(template.indexOf(marker));
  return section.match(/```bash\n([\s\S]*?)\n```/)![1].replaceAll('{{SETUP_COMMAND}}', './setup');
};

describe.skipIf(process.platform === 'win32')('upgrade setup recovery (real shell)', () => {
  for (const mode of ['vendored', 'local'] as const) {
    for (const setupExit of [0, 1]) {
      test(`${mode}: setup exit ${setupExit} ${setupExit ? 'restores old install' : 'removes backup only after success'}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'upgrade-recovery-'));
        const target = join(root, 'target');
        const source = join(root, 'source');
        const bin = join(root, 'bin');
        try {
          for (const dir of [target, source, bin, join(target, 'bin'), join(source, 'bin')]) mkdirSync(dir);
          writeFileSync(join(target, 'VERSION'), 'old');
          writeFileSync(join(source, 'VERSION'), 'new');
          // C9: fences only touch a directory that looks like a gstack install.
          for (const dir of [target, source]) writeFileSync(join(dir, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
          writeFileSync(join(target, 'setup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          writeFileSync(join(source, 'setup'), '#!/bin/sh\nexit "$SETUP_EXIT"\n', { mode: 0o755 });
          writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor last; do :; done\ncp -R "$UPGRADE_FIXTURE" "$last"\n', { mode: 0o755 });
          const script = blockAfter(mode === 'vendored'
            ? '**For vendored installs**'
            : '**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is NOT `true`:**');
          const result = spawnSync('bash', ['-c', script], {
            cwd: root, encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: mode === 'vendored' ? target : source,
              LOCAL_GSTACK: target, UPGRADE_FIXTURE: source, SETUP_EXIT: String(setupExit) },
          });
          expect(result.status, result.stderr).toBe(setupExit);
          expect(readFileSync(join(target, 'VERSION'), 'utf8')).toBe(setupExit ? 'old' : 'new');
          expect(existsSync(`${target}.bak`)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('git setup failure is not routed into the divergence reset fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'upgrade-git-setup-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1 $2" = "rev-parse --show-toplevel" ]; then pwd -P; elif [ "$1" = rev-parse ]; then echo old-commit; fi\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'setup'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      // C9: the git fence verifies it is inside gstack's own checkout first.
      writeFileSync(join(root, 'VERSION'), '1.0.0.0\n');
      writeFileSync(join(root, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', blockAfter('**For git installs**')], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: root },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SETUP_FAILED');
      expect(result.stdout).not.toContain('FF_REFUSED');
      expect(result.stdout).not.toContain('FF_OK');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// /gstack-upgrade checks the incoming release's Bun floor before pulling, with
// the auto-updater's helper: below it the checkout and installs stay untouched.
describe.skipIf(process.platform === 'win32')('upgrade Bun floor (real git)', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).stdout.trim();

  function fixture(floor: string, bunVersion: string) {
    const root = mkdtempSync(join(tmpdir(), 'upgrade-bun-floor-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const install = join(root, 'install');
    const stub = join(root, 'stub');
    for (const dir of [join(seed, 'bin'), stub]) mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    const helper = readFileSync(join(import.meta.dir, '../bin/gstack-bun-version.sh'), 'utf8');
    writeFileSync(join(seed, 'bin', 'gstack-bun-version.sh'), helper);
    writeFileSync(join(seed, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(seed, 'VERSION'), '1.0.0\n');
    writeFileSync(join(seed, 'setup'), '#!/bin/sh\necho ran >> "$SETUP_LOG"\n', { mode: 0o755 });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    spawnSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
    writeFileSync(join(seed, 'bin', 'gstack-bun-version.sh'),
      helper.replace(/^GSTACK_BUN_FLOOR="[^"]*"/m, `GSTACK_BUN_FLOOR="${floor}"`));
    writeFileSync(join(seed, 'VERSION'), '1.1.0\n');
    git(seed, 'commit', '-aqm', 'release 1.1.0');
    git(seed, 'push', '-q', 'origin', 'main');
    writeFileSync(join(stub, 'bun'), `#!/bin/sh\necho ${bunVersion}\n`, { mode: 0o755 });
    const before = git(install, 'rev-parse', 'HEAD');
    const result = spawnSync('bash', ['-c', blockAfter('**For git installs**')], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, INSTALL_DIR: install, SETUP_LOG: join(root, 'setup.log') },
    });
    return { root, install, stub, before, result, after: git(install, 'rev-parse', 'HEAD'),
      setupRan: existsSync(join(root, 'setup.log')), version: readFileSync(join(install, 'VERSION'), 'utf8') };
  }

  test('below the incoming floor: stops before the pull with the held reason', () => {
    const fx = fixture('9.0.0', '1.4.0');
    try {
      expect(fx.result.status).toBe(1);
      expect(fx.result.stderr).toContain(
        `BUN_TOO_OLD: bun-too-old: found Bun 1.4.0 at ${join(fx.stub, 'bun')}; gstack 1.1.0 needs 9.0.0 or newer; nothing was changed`);
      expect(fx.result.stdout).not.toContain('FF_OK');
      expect(fx.after).toBe(fx.before);
      expect(fx.version).toBe('1.0.0\n');
      expect(fx.setupRan).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('at or above the incoming floor: the fast-forward and setup run', () => {
    const fx = fixture('1.3.3', '1.4.0');
    try {
      expect(fx.result.status, fx.result.stderr).toBe(0);
      expect(fx.result.stdout).toContain('FF_OK');
      expect(fx.after).not.toBe(fx.before);
      expect(fx.version).toBe('1.1.0\n');
      expect(fx.setupRan).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
