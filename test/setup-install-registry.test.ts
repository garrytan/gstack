/**
 * Install ownership rules (docs/ADDING_A_HOST.md "Install ownership rules"),
 * exercised through the real ./setup, gstack-relink, gstack-config and
 * gstack-uninstall against throwaway checkouts and HOMEs.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, registryRows, ROOT, runSetup, setVersion, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });

describe.skipIf(process.platform === 'win32')('setup entry path', () => {
  test('an unknown option is rejected before anything is written, with the corrected command', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    const before = tree(f.dir);
    const r = runSetup(f, join(src, 'setup'), ['--hots', 'codex']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown option: --hots — nothing was installed or changed.');
    expect(r.stderr).toContain('Did you mean: ./setup --host codex');
    expect(tree(f.dir)).toEqual(before);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('install ownership rules', () => {
  test('--host codex leaves an existing Claude install untouched: hooks, render, links (#2347)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(runSetup(f, join(src, 'setup'), ['--host', 'claude']).status).toBe(0);
    // The user removed the Stop hook; a stale gbrain render exists for Claude.
    expect(bash(`"${src}/bin/gstack-settings-hook" remove-source --source gstack-timeline-stop`, f.env).status).toBe(0);
    put(join(f.home, '.gstack/render/claude/review/SKILL.md'), 'claude render\n');
    // The checkout itself lives in ~/.claude/skills/gstack and is shared by
    // both hosts (Codex gets its .agents render there); everything else under
    // ~/.claude belongs to the Claude install.
    const claudeInstall = () => {
      const t = tree(join(f.home, '.claude')) as { skills: Record<string, unknown> };
      delete t.skills.gstack;
      return t;
    };
    const claudeBefore = claudeInstall();
    const renderBefore = tree(join(f.home, '.gstack/render'));

    const r = runSetup(f, join(src, 'setup'), ['--host', 'codex']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(claudeInstall()).toEqual(claudeBefore);
    expect(tree(join(f.home, '.gstack/render'))).toEqual(renderBefore);
    expect(r.stderr).toContain("this checkout lives in Claude Code's skills directory");
    expect(registryRows(f).map(row => row[0]).sort()).toEqual(['claude', 'codex']);
  }, 60_000);

  test('a second checkout never silently replaces the global Claude install; --global does', () => {
    const f = makeFixture();
    const a = makeSource(f, join(f.home, 'src-a/gstack'), '1.91.10.0');
    const b = makeSource(f, join(f.home, 'src-b/gstack'), '1.91.14.0');
    expect(runSetup(f, join(a, 'setup'), []).status).toBe(0);
    const link = join(f.home, '.claude/skills/gstack');
    expect(realpathSync(link)).toBe(realpathSync(a));
    const before = tree(join(f.home, '.claude'));

    const refused = runSetup(f, join(b, 'setup'), []);
    expect(refused.status, refused.stderr).toBe(0);
    expect(refused.stderr).toContain(`Left alone: ${link}, the global Claude install, which links to another gstack checkout:`);
    expect(refused.stderr).toContain('Rule: setup never silently replaces a global install from a different checkout.');
    expect(refused.stderr).toContain('./setup --global');
    expect(refused.stdout).toMatch(/claude\s+full\s+global\s+skipped/);
    expect(tree(join(f.home, '.claude'))).toEqual(before);

    const replaced = runSetup(f, join(b, 'setup'), ['--global']);
    expect(replaced.status, replaced.stderr).toBe(0);
    expect(realpathSync(link)).toBe(realpathSync(b));
    expect(registryRows(f).filter(r => r[0] === 'claude').map(r => r[5])).toEqual([realpathSync(b)]);
  }, 60_000);

  test('installs at different old versions each report their own old -> new row', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'), '1.91.12.0');
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    const file = join(f.home, '.gstack/installs.tsv');
    put(file, readFileSync(file, 'utf8').replace(/^(claude\t(?:[^\t]*\t){5})1\.91\.12\.0/m, '$11.91.10.0'));
    setVersion(src, '1.91.14.0');
    const r = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/claude\s+full\s+global\s+updated\s+1\.91\.10\.0 -> 1\.91\.14\.0/);
    expect(r.stdout).toMatch(/codex\s+experimental\s+global\s+updated\s+1\.91\.12\.0 -> 1\.91\.14\.0/);
    expect((lstatSync(file).mode & 0o777).toString(8)).toBe('600');
  }, 90_000);

  test('an uninstalled host is dropped from the registry and an upgrade does not resurrect it', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, 'gstack'));
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    const un = spawnSync('bash', [join(src, 'bin/gstack-uninstall'), '--force', '--keep-state'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 30_000 });
    expect(un.status, un.stderr).toBe(0);
    expect(registryRows(f)).toEqual([]);
    const r = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(f.home, '.codex/skills')) ? readdirSync(join(f.home, '.codex/skills')).filter(n => n.startsWith('gstack')) : []).toEqual([]);
  }, 90_000);

  test('a failed migration is a failed row, keeps its marker, and is retried (non-default state root)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'), '1.91.14.0');
    const state = join(f.dir, 'state');
    const env = { GSTACK_HOME: state };
    put(join(state, '.last-setup-version'), '1.91.13.0\n');
    put(join(state, 'config.yaml'), 'telemetry: off\n');
    put(join(src, 'gstack-upgrade/migrations/v1.91.13.2.sh'), `#!/bin/sh\necho ok >> "${f.dir}/ran-13.2"\n`, 0o755);
    put(join(src, 'gstack-upgrade/migrations/v1.91.13.5.sh'), `#!/bin/sh\necho try >> "${f.dir}/ran-13.5"\nexit 3\n`, 0o755);

    const first = runSetup(f, join(src, 'setup'), ['--host', 'codex'], { env });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stderr).toContain('migration 1.91.13.5 failed');
    expect(first.stdout).toMatch(/state\s+unknown\s+global\s+failed\s+1\.91\.13\.2 -> 1\.91\.14\.0/);
    expect(readFileSync(join(state, '.last-setup-version'), 'utf8').trim()).toBe('1.91.13.2');
    expect(existsSync(join(f.home, '.gstack/.last-setup-version'))).toBe(false);
    expect(registryRows(f, state).map(r => r[0])).toEqual(['codex']);

    put(join(src, 'gstack-upgrade/migrations/v1.91.13.5.sh'), `#!/bin/sh\necho try >> "${f.dir}/ran-13.5"\n`, 0o755);
    const retry = runSetup(f, join(src, 'setup'), ['--host', 'codex'], { env });
    expect(retry.status).toBe(0);
    expect(readFileSync(join(f.dir, 'ran-13.2'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(f.dir, 'ran-13.5'), 'utf8')).toBe('try\ntry\n');
    expect(readFileSync(join(state, '.last-setup-version'), 'utf8').trim()).toBe('1.91.14.0');
  }, 90_000);

  test('relink from a vendored project copy touches only that copy, and its failures are reported', () => {
    const f = makeFixture();
    const global = makeSource(f, join(f.home, 'gstack'));
    expect(runSetup(f, join(global, 'setup'), ['--no-prefix']).status).toBe(0);
    const project = join(f.dir, 'proj');
    mkdirSync(join(project, '.git'), { recursive: true });
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'));
    expect(runSetup(f, join(vendored, 'setup'), ['--no-prefix'], { cwd: project }).status).toBe(0);
    const globalBefore = tree(join(f.home, '.claude'));

    put(join(f.home, '.gstack/config.yaml'), 'telemetry: off\nskill_prefix: true\n');
    const r = spawnSync('bash', [join(vendored, 'bin/gstack-relink')], { cwd: project, env: f.env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(project, '.claude/skills/gstack-review/SKILL.md'))).toBe(true);
    expect(tree(join(f.home, '.claude'))).toEqual(globalBefore);

    const loose = makeSource(f, join(f.dir, 'loose/gstack'));
    const set = spawnSync('bash', [join(loose, 'bin/gstack-config'), 'set', 'skill_prefix', 'false'], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 30_000 });
    expect(set.stderr).toContain('relinking the installed skills failed');
  }, 90_000);
});

describe.skipIf(process.platform === 'win32')('disabled_skills (#1206)', () => {
  test('set relinks Claude now, other hosts on refresh, keeps runtime files, and "" re-enables', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host, '--no-prefix']).status).toBe(0);
    const config = (...args: string[]) => spawnSync('bash', [join(src, 'bin/gstack-config'), 'set', 'disabled_skills', ...args], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 30_000 });

    const typo = config('make-pdff');
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain("Did you mean 'make-pdf'?");
    expect(config('gstack-upgrade').status).toBe(1);

    const set = config('make-pdf, gstack-pair-agent');
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('Disabled (gstack-config disabled_skills, not registered): make-pdf pair-agent');
    expect(set.stdout).toContain(`apply to codex (${join(f.home, '.codex/skills')}): cd ${realpathSync(src)} && ./setup --host codex`);
    expect(existsSync(join(f.home, '.claude/skills/make-pdf'))).toBe(false);
    expect(existsSync(join(f.home, '.claude/skills/pair-agent'))).toBe(false);
    expect(existsSync(join(f.home, '.claude/skills/review/SKILL.md'))).toBe(true);
    expect(existsSync(join(src, 'make-pdf/SKILL.md'))).toBe(true);

    const refresh = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(existsSync(join(f.home, '.codex/skills/gstack-make-pdf'))).toBe(false);
    expect(existsSync(join(f.home, '.codex/skills/gstack-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(f.home, '.claude/skills/make-pdf'))).toBe(false);
    expect(refresh.stdout).toContain('disabled skills (not registered on any host): make-pdf pair-agent');

    expect(config('').status).toBe(0);
    expect(existsSync(join(f.home, '.claude/skills/make-pdf/SKILL.md'))).toBe(true);
  }, 120_000);
});

describe('install registry helper', () => {
  const helper = join(ROOT, 'bin/gstack-install-registry.sh');

  test('parallel writers never lose a row; the file stays 0600', () => {
    const f = makeFixture();
    const state = join(f.dir, 'state');
    const script = `. "${helper}"; GSTACK_STATE_ROOT="${state}"
for i in $(seq 1 12); do gstack_install_registry_upsert host$i global - "/d/$i" "/r/$i" /src 1.0 - committed & done; wait
gstack_install_registry_rows | wc -l`;
    const r = bash(script);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('12');
    expect((lstatSync(join(state, 'installs.tsv')).mode & 0o777).toString(8)).toBe('600');
    expect(existsSync(join(state, 'installs.tsv.lock'))).toBe(false);
  }, 30_000);

  test('a path with a tab is refused instead of corrupting the table', () => {
    const f = makeFixture();
    const r = bash(`. "${helper}"; GSTACK_STATE_ROOT="${join(f.dir, 'state')}"; gstack_install_registry_upsert claude global - "/a\tb" /r /s 1 - committed`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('contains a tab or newline');
  });
});
