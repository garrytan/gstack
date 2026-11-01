import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureMkdirSync, makeFixture, makeSource, put, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const stubBun = (f: ReturnType<typeof makeFixture>) => put(join(f.commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  install|'install --production --frozen-lockfile') exit 0 ;;
  'build --help') echo 'Fixture Bun has no CSO compile flags'; exit 0 ;;
  'run build') echo 'Unexpected build in a dev-setup fixture' >&2; exit 90 ;;
  *) exec '${process.execPath}' "$@" ;;
esac
`, 0o755);

const freshClone = (rel = 'gstack') => {
  const f = makeFixture();
  stubBun(f);
  const source = makeSource(f, join(f.dir, rel));
  const init = spawnSync('git', ['init', '-q', source], { encoding: 'utf8', timeout: 30_000 });
  if (init.status !== 0) throw new Error(init.stderr);
  return { f, source };
};

describe.skipIf(process.platform === 'win32')('bin/dev-setup in a fresh gstack clone', () => {
  test('links gstack into its own .claude and .agents skills and exits 0', () => {
    const { f, source } = freshClone();
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('bash', [join(source, 'bin/dev-setup')], { cwd: source, env: f.env, encoding: 'utf8', timeout: 120_000, input: '' });
      expect(result.stderr).not.toContain('overlaps the source tree');
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readlinkSync(join(source, '.claude/skills/gstack'))).toBe(source);
      expect(readlinkSync(join(source, '.agents/skills/gstack'))).toBe(source);
    }
  }, 240_000);

  test('a user project whose .agents/skills resolves to the checkout\'s own .agents/skills is still refused', () => {
    const { f, source } = freshClone('project/vendor/gstack');
    const project = join(f.dir, 'project');
    fixtureMkdirSync(join(source, '.agents/skills'), { recursive: true });
    fixtureMkdirSync(join(project, '.claude/skills'), { recursive: true });
    fixtureMkdirSync(join(project, '.agents'));
    symlinkSync(source, join(project, '.claude/skills/gstack'), 'dir');
    symlinkSync(join(source, '.agents/skills'), join(project, '.agents/skills'), 'dir');
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(project, '.claude/skills/gstack/setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: project, env: f.env, encoding: 'utf8', timeout: 60_000, input: '',
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`overlaps the source tree at ${source}`);
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  test('the checkout itself is still refused when its .agents/skills aliases the source root', () => {
    const { f, source } = freshClone();
    fixtureMkdirSync(join(source, '.claude/skills'), { recursive: true });
    fixtureMkdirSync(join(source, '.agents'));
    symlinkSync(source, join(source, '.claude/skills/gstack'), 'dir');
    symlinkSync(source, join(source, '.agents/skills'), 'dir');
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(source, '.claude/skills/gstack/setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: source, env: f.env, encoding: 'utf8', timeout: 60_000, input: '',
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('overlaps the source tree');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);
});
