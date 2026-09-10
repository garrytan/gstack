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
          for (const dir of [target, source, bin]) mkdirSync(dir);
          writeFileSync(join(target, 'VERSION'), 'old');
          writeFileSync(join(source, 'VERSION'), 'new');
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
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo old-commit; fi\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'setup'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
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
