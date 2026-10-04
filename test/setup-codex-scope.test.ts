import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateAutoplanSnapshotTool } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { runBashScript } from './helpers/bash-script';
import { cleanupFixtures, cleanupSeed, ROOT, owned, fixtureWriteFileSync, fixtureCopyFileSync, fixtureMkdirSync, fixtureUtimesSync, tree, fixture, install } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

test.skipIf(process.platform === 'win32')('fixture writes reject physical escapes and allow aliased temporary roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-fixture-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'gstack-fixture-outside-'));
  owned.push(dir, outside);
  symlinkSync(outside, join(dir, 'escape'), 'dir');
  expect(() => fixtureWriteFileSync(join(dir, 'escape/proof'), 'blocked')).toThrow('escapes physical root');
  expect(existsSync(join(outside, 'proof'))).toBe(false);
  const actual = join(dir, 'actual');
  fixtureMkdirSync(actual);
  const alias = join(dir, 'alias');
  symlinkSync(actual, alias, 'dir');
  owned.unshift(alias);
  fixtureWriteFileSync(join(alias, 'proof'), 'safe');
  expect(readFileSync(join(actual, 'proof'), 'utf8')).toBe('safe');
});

describe.skipIf(process.platform === 'win32')('setup Codex destination follows recognized source scope', () => {
  for (const [layout, host] of [['.claude', 'codex'], ['.agents', 'codex'], ['.claude', 'auto']]) {
    test(`${layout}: ${host} preserves the global lane and unrelated project`, () => {
      const f = fixture(layout!);
      const before = tree(f.global), sourceBefore = tree(f.previous);
      install(f, `--host ${host}`);
      install(f, `--host ${host}`);
      expect(tree(f.global)).toEqual(before);
      expect(tree(f.previous)).toEqual(sourceBefore);
      const local = join(f.project, '.agents/skills');
      expect(realpathSync(join(local, 'gstack-review/SKILL.md'))).toBe(join(f.source, '.agents/skills/gstack-review/SKILL.md'));
      expect(realpathSync(join(local, 'gstack/bin'))).toBe(join(f.source, 'bin'));
      const ctx = { host: 'codex', paths: HOST_PATHS.codex, skillName: 'autoplan', tmplPath: '' } as TemplateContext;
      const command = generateAutoplanSnapshotTool(ctx).replace(/^```bash\n/, '').replace(/\n```$/, '');
      const resolved = runBashScript(command, { cwd: f.other, env: f.env, timeout: 10_000 });
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(resolved.stdout.trim()).toBe(join(f.previous, 'bin/gstack-autoplan-snapshot.ts'));
    }, 90_000);
  }

  test('canonical local gstack runtime remains in place across Windows-copy refresh', () => {
    const f = fixture('.agents');
    fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
    for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
      fixtureCopyFileSync(join(f.source, rel.replace('.exe', '')), join(f.source, rel));
      fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
    }
    fixtureWriteFileSync(join(f.source, 'uncommitted-proof'), 'Preserve canonical checkout.\n');
    const sourceBefore = Object.fromEntries(['setup', 'bin', 'lib', 'uncommitted-proof'].map(rel => [rel, tree(join(f.source, rel))]));
    for (let run = 0; run < 2; run++) {
      install(f);
      for (const [rel, before] of Object.entries(sourceBefore)) expect(tree(join(f.source, rel))).toEqual(before);
      expect(realpathSync(join(f.source, '.agents/skills/gstack/bin'))).toBe(join(f.source, '.agents/skills/gstack/bin'));
    }
  }, 90_000);

  for (const layout of ['machine', 'ordinary']) test(`${layout}: ordinary machine sources still register globally`, () => {
    const f = fixture(layout);
    install(f);
    expect(realpathSync(join(f.global, 'gstack/bin'))).toBe(join(f.source, 'bin'));
    expect(realpathSync(join(f.global, 'gstack-review/SKILL.md'))).toBe(join(f.source, '.agents/skills/gstack-review/SKILL.md'));
    expect(readFileSync(join(f.global, 'custom/SKILL.md'), 'utf8')).toBe('User-owned skill.\n');
  }, 90_000);

  for (const aliasedParent of [false, true]) for (const windows of [false, true]) test(`a direct global Codex checkout migrates and supports repeat setup, aliased parent=${aliasedParent}, Windows=${windows}`, () => {
    const f = fixture('ordinary');
    if (windows) {
      fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
        fixtureWriteFileSync(join(f.source, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
      }
    }
    const direct = join(f.global, 'gstack');
    rmSync(direct, { recursive: true });
    cpSync(f.source, direct, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fixtureWriteFileSync(join(direct, 'uncommitted-work'), 'Keep the real source checkout.\n');
    const codexHome = aliasedParent ? join(f.home, 'codex-parent-alias') : dirname(f.global);
    if (aliasedParent) symlinkSync(dirname(f.global), codexHome, 'dir');
    const env = { ...f.env, CODEX_HOME: codexHome };
    const sourceBefore = Object.fromEntries(['SKILL.md', 'bin', 'lib'].map(rel => [rel, tree(join(direct, rel))]));
    const migrated = join(f.home, '.gstack/repos/gstack');
    for (let run = 0; run < 2; run++) {
      install({ ...f, source: run === 0 ? join(codexHome, 'skills/gstack') : migrated, env });
      expect(readFileSync(join(migrated, 'setup'))).toEqual(readFileSync(join(ROOT, 'setup')));
      expect(readFileSync(join(migrated, 'uncommitted-work'), 'utf8')).toBe('Keep the real source checkout.\n');
      for (const [rel, before] of Object.entries(sourceBefore)) expect(tree(join(migrated, rel))).toEqual(before);
      expect(existsSync(join(migrated, 'bin/bin'))).toBe(false);
      if (windows) {
        expect(lstatSync(join(direct, 'bin')).isSymbolicLink()).toBe(false);
        expect(tree(join(direct, 'bin'))).toEqual(sourceBefore.bin);
        expect(readFileSync(join(f.global, 'gstack-review/SKILL.md'))).toEqual(readFileSync(join(migrated, '.agents/skills/gstack-review/SKILL.md')));
      } else {
        expect(realpathSync(join(direct, 'bin'))).toBe(join(migrated, 'bin'));
        expect(realpathSync(join(f.global, 'gstack-review/SKILL.md'))).toBe(join(migrated, '.agents/skills/gstack-review/SKILL.md'));
      }
      expect(readFileSync(join(f.global, 'custom/SKILL.md'), 'utf8')).toBe('User-owned skill.\n');
    }
  }, 90_000);

  test('global repository-link invocation converts to a minimal runtime without changing source or unrelated global entries', () => {
    const f = fixture('ordinary');
    install(f);
    install(f);
    const sourceBefore = tree(f.source), globalBefore = tree(f.global);
    const runtime = join(f.global, 'gstack');
    for (let run = 0; run < 2; run++) {
      expect(lstatSync(runtime).isSymbolicLink()).toBe(false);
      rmSync(runtime, { recursive: true });
      symlinkSync(f.source, runtime, 'dir');
      install({ ...f, source: runtime });
      expect(tree(f.source)).toEqual(sourceBefore);
      expect(tree(f.global)).toEqual(globalBefore);
      expect(lstatSync(runtime).isSymbolicLink()).toBe(false);
      expect(existsSync(join(runtime, 'setup'))).toBe(false);
      expect(existsSync(join(runtime, 'review/SKILL.md'))).toBe(false);
      expect(existsSync(join(runtime, '.agents/skills'))).toBe(false);
      expect(realpathSync(join(runtime, 'bin'))).toBe(join(f.source, 'bin'));
    }
    install(f);
    expect(tree(f.source)).toEqual(sourceBefore);
    expect(tree(f.global)).toEqual(globalBefore);
  }, 90_000);

  test('ordinary project ancestors with Git and application setup metadata remain supported', () => {
    const f = fixture('.claude');
    const init = spawnSync('git', ['init', '--quiet', f.project], { encoding: 'utf8', timeout: 10_000 });
    expect(init.status, init.stderr).toBe(0);
    fixtureWriteFileSync(join(f.project, 'setup'), 'Application setup.\n');
    fixtureWriteFileSync(join(f.project, 'VERSION'), 'Application version.\n');
    const before = tree(f.global), gitBefore = tree(join(f.project, '.git'));
    install(f);
    install(f);
    expect(tree(f.global)).toEqual(before);
    expect(tree(join(f.project, '.git'))).toEqual(gitBefore);
    expect(readFileSync(join(f.project, 'setup'), 'utf8')).toBe('Application setup.\n');
    expect(readFileSync(join(f.project, 'VERSION'), 'utf8')).toBe('Application version.\n');
  }, 90_000);

  test('explicit global override identifies its project source even in quiet mode', () => {
    const f = fixture('.claude');
    const result = install(f, '--host codex --global -q');
    expect(result.stderr).toContain(`Global Codex registration requested from project source: ${f.source}`);
    expect(realpathSync(join(f.global, 'gstack/bin'))).toBe(join(f.source, 'bin'));
  }, 90_000);

  test('Claude-only vendored setup cannot prune global Codex entries either', () => {
    const f = fixture('.claude');
    const before = tree(f.global);
    install(f, '--host claude');
    expect(tree(f.global)).toEqual(before);
  }, 90_000);

  test('vendored setup preserves a user-owned local runtime root', () => {
    const f = fixture('.claude');
    const runtime = join(f.project, '.agents/skills/gstack');
    fixtureMkdirSync(runtime, { recursive: true });
    fixtureWriteFileSync(join(runtime, 'SKILL.md'), 'User-owned local skill.\n');
    const before = tree(runtime);
    const result = install(f);
    expect(tree(runtime)).toEqual(before);
    expect(result.stderr).toContain(`left in place (existing dir not gstack-managed — no generated banner): ${runtime}`);
  }, 90_000);

  test('vendored setup cannot migrate a copied global Claude wrapper', () => {
    const f = fixture('.claude');
    for (const rel of ['bin', 'lib']) {
      const target = join(f.global, 'gstack', rel);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      rmSync(target);
      fixtureMkdirSync(target);
      fixtureWriteFileSync(join(target, 'prior'), 'Existing copied global runtime.\n');
    }
    const before = tree(f.global);
    install(f);
    expect(tree(f.global)).toEqual(before);
  }, 90_000);

  test('a recognized local symlink keeps its destination local and its source physical', () => {
    const f = fixture('ordinary');
    const source = f.source;
    const link = join(f.project, '.agents/skills/gstack');
    fixtureMkdirSync(dirname(link), { recursive: true });
    symlinkSync(source, link, 'dir');
    f.source = link;
    const before = tree(f.global);
    install(f);
    expect(tree(f.global)).toEqual(before);
    expect(realpathSync(join(f.project, '.agents/skills/gstack-review/SKILL.md'))).toBe(join(source, '.agents/skills/gstack-review/SKILL.md'));
    expect(realpathSync(join(link, 'bin'))).toBe(join(source, 'bin'));
  }, 90_000);

  test('a parent-directory alias cannot turn the running source into a disposable runtime', () => {
    const f = fixture('.claude');
    fixtureMkdirSync(join(f.project, '.agents'));
    symlinkSync(join(f.project, '.claude/skills'), join(f.project, '.agents/skills'), 'dir');
    expect(realpathSync(join(f.project, '.agents/skills/gstack'))).toBe(f.source);
    fixtureWriteFileSync(join(f.source, 'uncommitted-work'), 'Keep the running source.\n');
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(existsSync(join(f.source, 'uncommitted-work')), result.stdout + result.stderr).toBe(true);
    expect(readFileSync(join(f.source, 'uncommitted-work'), 'utf8')).toBe('Keep the running source.\n');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(realpathSync(join(f.project, '.agents/skills/gstack/bin'))).toBe(join(f.source, 'bin'));
  }, 90_000);

});
