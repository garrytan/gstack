import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupFixtures, cleanupSeed, owned, fixtureWriteFileSync, fixtureCopyFileSync, fixtureMkdirSync, fixtureUtimesSync, tree, fixture, install } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup Codex destination follows recognized source scope', () => {
  for (const localLegacy of [false, true]) for (const marker of ['current', '1.85.0.0']) test(`excluded global legacy render survives local migration=${localLegacy}, marker=${marker} and generation`, () => {
    const f = fixture('.claude');
    const oldRender = join(f.source, '.agents/skills/gstack-claude');
    fixtureMkdirSync(oldRender, { recursive: true });
    const oldBytes = '---\nname: gstack-claude\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nExisting legacy global workflow.\n';
    fixtureWriteFileSync(join(oldRender, 'SKILL.md'), oldBytes);
    rmSync(join(f.global, 'gstack-claude'), { recursive: true });
    symlinkSync(oldRender, join(f.global, 'gstack-claude'), 'dir');
    for (const rel of ['bin', 'lib']) {
      const target = join(f.global, 'gstack', rel);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      rmSync(target);
      fixtureMkdirSync(target);
      fixtureWriteFileSync(join(target, 'prior'), 'Existing copied global runtime.\n');
    }
    const local = join(f.project, '.agents/skills');
    if (localLegacy) {
      fixtureMkdirSync(local, { recursive: true });
      symlinkSync(oldRender, join(local, 'gstack-claude'), 'dir');
    }
    fixtureWriteFileSync(join(f.home, '.gstack/.last-setup-version'), marker === 'current' ? readFileSync(join(f.source, 'VERSION')) : marker);
    const before = tree(f.global);
    install(f);
    expect(tree(f.global)).toEqual(before);
    expect(readFileSync(join(f.global, 'gstack-claude/SKILL.md'), 'utf8')).toBe(oldBytes);
    expect(realpathSync(join(local, 'gstack-claude-code/SKILL.md'))).toBe(join(f.source, '.agents/skills/gstack-claude-code/SKILL.md'));
    expect(lstatSync(join(local, 'gstack-claude'), { throwIfNoEntry: false })).toBeUndefined();
  }, 90_000);

  for (const nested of [false, true]) for (const global of [false, true]) for (const windows of [false, true]) {
    test(`named ${nested ? 'ancestor' : 'source'} overlap: logical local=${!global}, Windows=${windows}`, () => {
      const f = fixture('.claude');
      const physical = join(f.project, '.agents/skills/gstack-review', ...(nested ? ['checkout'] : []));
      fixtureMkdirSync(physical, { recursive: true });
      cpSync(f.source, physical, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      rmSync(f.source, { recursive: true });
      symlinkSync(physical, f.source, 'dir');
      if (nested) fixtureWriteFileSync(join(dirname(physical), 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior render.\n');
      fixtureWriteFileSync(join(physical, 'uncommitted-proof'), 'Do not erase this checkout.\n');
      if (windows) {
        fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
        for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
          fixtureCopyFileSync(join(physical, rel.replace('.exe', '')), join(physical, rel));
          fixtureUtimesSync(join(physical, rel), new Date('2040-01-01'), new Date('2040-01-01'));
        }
      }
      const env = global ? { ...f.env, CODEX_HOME: join(f.project, '.agents') } : f.env;
      const before = tree(f.dir);
      const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', ...(global ? ['--global'] : []), '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
        cwd: f.other, env, encoding: 'utf8', timeout: 60_000,
      });
      if (windows) {
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('Codex skill copy replacement overlaps source');
        expect(tree(f.dir)).toEqual(before);
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(join(physical, 'uncommitted-proof'), 'utf8')).toBe('Do not erase this checkout.\n');
      }
    }, 90_000);
  }

  for (const target of ['source', 'project', 'root-sidecar']) for (const host of target === 'root-sidecar' ? ['codex'] : ['codex', 'claude']) test(`generated namespace alias to ${target} refuses before writes, host=${host}`, () => {
    const f = fixture('ordinary');
    const render = join(f.source, '.agents/skills');
    fixtureMkdirSync(render, { recursive: true });
    const alias = join(render, target === 'root-sidecar' ? 'gstack' : 'gstack-review');
    const destination = target === 'project' ? join(f.project, 'ordinary-review') : f.source;
    if (target === 'project') {
      fixtureMkdirSync(destination);
      fixtureWriteFileSync(join(destination, 'SKILL.md'), 'Project-owned content.\n');
    }
    symlinkSync(destination, alias, 'dir');
    if (target === 'root-sidecar') fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', host, '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(target === 'root-sidecar' ? 'Codex sidecar' : 'Codex generated skill write');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  for (const target of ['absolute-generation-alias', 'occupied-relocation']) for (const windows of [false, true]) {
    test(`direct global checkout preflights ${target} before moving, Windows=${windows}`, () => {
      const f = fixture('ordinary');
      const direct = join(f.global, 'gstack');
      rmSync(direct, { recursive: true });
      cpSync(f.source, direct, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      fixtureWriteFileSync(join(direct, 'uncommitted-proof'), 'Keep source checkout.\n');
      if (target === 'absolute-generation-alias') {
        const generated = join(direct, 'generated-codex');
        fixtureMkdirSync(generated);
        symlinkSync(generated, join(direct, '.agents'), 'dir');
      } else {
        fixtureMkdirSync(join(f.home, '.gstack/repos'), { recursive: true });
        symlinkSync(direct, join(f.home, '.gstack/repos/gstack'), 'dir');
      }
      if (windows) fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      const before = tree(f.dir);
      const result = spawnSync('bash', [join(direct, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
        cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(target === 'absolute-generation-alias' ? 'post-relocation generation namespace' : 'checkout relocation');
      expect(tree(f.dir)).toEqual(before);
    }, 90_000);
  }

  test('Claude-only setup cannot prune a bannered stale skill inside its source checkout', () => {
    const f = fixture('ordinary');
    const skill = join(f.source, 'skills/gstack-obsolete/SKILL.md');
    fixtureMkdirSync(dirname(skill), { recursive: true });
    fixtureWriteFileSync(skill, '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPreserve source content.\n');
    const env = { ...f.env, CODEX_HOME: f.source };
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'claude', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Codex stale host cleanup');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  test('a dangling owned legacy Codex link reaches the rename migration', () => {
    const f = fixture('ordinary');
    const old = join(f.global, 'gstack-claude');
    rmSync(old, { recursive: true });
    symlinkSync(join(f.source, '.agents/skills/gstack-claude'), old, 'dir');
    for (const rel of ['bin', 'lib']) {
      const target = join(f.global, 'gstack', rel);
      rmSync(target);
      symlinkSync(join(f.source, rel), target, 'dir');
    }
    install(f);
    expect(lstatSync(old, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(f.global, 'gstack-claude-code/SKILL.md'), 'utf8')).toContain('name: claude-code');
    expect(readFileSync(join(f.global, 'custom/SKILL.md'), 'utf8')).toBe('User-owned skill.\n');
  }, 90_000);

  for (const explicit of [false, true]) for (const windows of [false, true]) {
    test(`global handwritten runtime is refused before writes, explicit=${explicit}, Windows=${windows}`, () => {
      const f = fixture(explicit ? '.claude' : 'ordinary');
      const runtime = join(f.global, 'gstack');
      rmSync(runtime, { recursive: true });
      fixtureMkdirSync(runtime);
      fixtureWriteFileSync(join(runtime, 'SKILL.md'), 'A handwritten root skill.\n');
      fixtureWriteFileSync(join(runtime, 'user-notes'), 'Keep these notes.\n');
      if (windows) fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      const before = tree(f.dir);
      const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', ...(explicit ? ['--global'] : []), '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
        cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`global Codex runtime ${runtime} is a real user-owned skill`);
      expect(result.stderr).toContain('choose another CODEX_HOME');
      expect(tree(f.dir)).toEqual(before);
    }, 90_000);
  }

  for (const prior of ['managed', 'partial']) test(`global ${prior} runtime remains refreshable`, () => {
    const f = fixture('ordinary');
    const runtime = join(f.global, 'gstack');
    rmSync(runtime, { recursive: true });
    fixtureMkdirSync(runtime);
    if (prior === 'managed') fixtureWriteFileSync(join(runtime, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior runtime.\n');
    fixtureWriteFileSync(join(runtime, 'prior-asset'), 'A previous runtime asset.\n');
    install(f);
    install(f);
    expect(existsSync(join(runtime, 'prior-asset'))).toBe(false);
    expect(readFileSync(join(runtime, 'SKILL.md'), 'utf8')).toContain('<!-- AUTO-GENERATED from');
    expect(realpathSync(join(runtime, 'bin'))).toBe(join(f.source, 'bin'));
  }, 90_000);

  test('Claude-only setup leaves a global handwritten runtime untouched', () => {
    const f = fixture('ordinary');
    const runtime = join(f.global, 'gstack');
    rmSync(runtime, { recursive: true });
    fixtureMkdirSync(runtime);
    fixtureWriteFileSync(join(runtime, 'SKILL.md'), 'A handwritten root skill.\n');
    fixtureWriteFileSync(join(runtime, 'user-notes'), 'Keep these notes.\n');
    const before = tree(runtime);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'claude', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(tree(runtime)).toEqual(before);
  }, 90_000);

  test('Unix rename does not overwrite a source checkout registered as another skill', () => {
    const f = fixture('ordinary');
    const source = join(f.global, 'gstack-review');
    rmSync(source);
    cpSync(f.source, source, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fixtureWriteFileSync(join(source, 'uncommitted-proof'), 'Keep this source.\n');
    for (const rel of ['bin', 'lib']) {
      const asset = join(f.global, 'gstack', rel);
      rmSync(asset);
      fixtureMkdirSync(asset);
    }
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Codex rename workflow write');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  for (const alias of ['SKILL leaf', 'metadata parent']) test(`direct relocation refuses a generated absolute ${alias} before moving source`, () => {
    const f = fixture('ordinary');
    const direct = join(f.global, 'gstack');
    rmSync(direct, { recursive: true });
    cpSync(f.source, direct, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fixtureWriteFileSync(join(direct, 'uncommitted-proof'), 'Keep this source.\n');
    const generated = join(direct, '.agents/skills/gstack-review');
    fixtureMkdirSync(generated, { recursive: true });
    if (alias === 'SKILL leaf') {
      fixtureWriteFileSync(join(generated, 'saved.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\nPrior render.\n');
      symlinkSync(join(generated, 'saved.md'), join(generated, 'SKILL.md'));
    } else {
      const prior = join(direct, '.agents/skills/gstack-office-hours/agents');
      fixtureMkdirSync(prior, { recursive: true });
      symlinkSync(prior, join(generated, 'agents'), 'dir');
    }
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(direct, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('post-relocation generated alias');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  test('managed rename detaches a metadata parent link without touching its source', () => {
    const f = fixture('ordinary');
    const installed = join(f.global, 'gstack-review');
    rmSync(installed);
    fixtureMkdirSync(installed);
    fixtureWriteFileSync(join(installed, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior installed review.\n');
    const sourceAgents = join(f.source, '.agents/skills/gstack-review/agents');
    fixtureMkdirSync(sourceAgents, { recursive: true });
    fixtureWriteFileSync(join(dirname(sourceAgents), 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior canonical review.\n');
    fixtureWriteFileSync(join(sourceAgents, 'user-notes'), 'Preserve source metadata.\n');
    symlinkSync(sourceAgents, join(installed, 'agents'), 'dir');
    for (const rel of ['bin', 'lib']) {
      const asset = join(f.global, 'gstack', rel);
      rmSync(asset);
      symlinkSync(join(f.source, rel), asset, 'dir');
    }
    const result = install(f);
    expect(result.stderr).toContain('migrated 1 installed skill');
    expect(lstatSync(join(installed, 'agents')).isDirectory()).toBe(true);
    expect(readFileSync(join(sourceAgents, 'user-notes'), 'utf8')).toBe('Preserve source metadata.\n');
    expect(existsSync(join(installed, 'agents/openai.yaml'))).toBe(true);
  }, 90_000);
});
