import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureWriteFileSync, fixtureCopyFileSync, fixtureMkdirSync, fixtureUtimesSync, tree, fixture, install } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup Codex destination follows recognized source scope', () => {
  for (const global of [false, true]) for (const windows of [false, true]) test(`a real runtime containing the source is refused before writes, global=${global}, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const runtime = join(f.project, '.agents/skills/gstack');
    const nested = join(runtime, 'checkout');
    cpSync(f.source, nested, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fixtureWriteFileSync(join(nested, 'uncommitted-work'), 'Preserve the nested checkout.\n');
    rmSync(f.source, { recursive: true });
    symlinkSync(nested, f.source, 'dir');
    if (windows) fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
    const env = global ? { ...f.env, CODEX_HOME: join(f.project, '.agents') } : f.env;
    const before = tree(f.dir);
    for (const host of ['codex', 'auto']) for (let run = 0; run < 2; run++) {
      const args = [join(f.source, 'setup'), '--host', host, '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'];
      if (global) args.push('--global');
      const result = spawnSync('bash', args, { cwd: f.other, env, encoding: 'utf8', timeout: 60_000 });
      expect(tree(f.dir)).toEqual(before);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('runtime directory contains the source checkout');
      expect(result.stderr).toContain(runtime);
    }
  }, 90_000);

  test('a distinct sibling source checkout is refused before any mutation', () => {
    const f = fixture('.claude');
    const sibling = join(f.project, '.agents/skills/gstack');
    cpSync(f.source, sibling, { recursive: true, verbatimSymlinks: true });
    fixtureWriteFileSync(join(sibling, 'uncommitted-work'), 'Keep sibling checkout edits.\n');
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(tree(f.dir)).toEqual(before);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`existing source checkout at ${sibling}`);
  }, 90_000);

  test('a project destination aliased to global skills is refused before any mutation', () => {
    const f = fixture('.claude');
    fixtureMkdirSync(join(f.project, '.agents'));
    symlinkSync(f.global, join(f.project, '.agents/skills'), 'dir');
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(tree(f.dir)).toEqual(before);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('project-local Codex destination resolves outside the project');
  }, 90_000);

  for (const target of ['root', 'rendered', 'missing-tail', 'project-root']) for (const marker of ['current', '1.85.0.0']) test(`another payload cannot own the local namespace: ${target}, marker=${marker}`, () => {
    const f = fixture('.claude');
    const sibling = target === 'project-root' ? f.project : join(f.project, 'other-checkout');
    if (target === 'project-root') {
      for (const rel of ['setup', 'VERSION', 'bin/gstack-relink']) {
        fixtureMkdirSync(dirname(join(sibling, rel)), { recursive: true });
        fixtureCopyFileSync(join(f.source, rel), join(sibling, rel));
      }
    } else cpSync(f.source, sibling, { recursive: true, verbatimSymlinks: true });
    const rendered = join(sibling, '.agents/skills');
    const root = join(rendered, 'gstack');
    const review = join(rendered, 'gstack-review');
    for (const dir of [root, review]) {
      fixtureMkdirSync(dir, { recursive: true });
      fixtureWriteFileSync(join(dir, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nKeep the sibling workflow.\n');
    }
    symlinkSync(join(sibling, 'bin'), join(root, 'bin'), 'dir');
    for (const [name, source] of [['gstack', root], ['gstack-review', review]]) {
      rmSync(join(f.global, name!), { recursive: true });
      symlinkSync(source!, join(f.global, name!), 'dir');
    }
    if (target === 'missing-tail') {
      expect(existsSync(join(sibling, 'skills'))).toBe(false);
      symlinkSync(sibling, join(f.project, '.agents'), 'dir');
    } else if (target !== 'project-root') {
      fixtureMkdirSync(join(f.project, '.agents'));
      symlinkSync(target === 'root' ? sibling : rendered, join(f.project, '.agents/skills'), 'dir');
    }
    fixtureWriteFileSync(join(f.home, '.gstack/.last-setup-version'), marker === 'current' ? readFileSync(join(f.source, 'VERSION')) : marker);
    const before = tree(f.dir);
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
        cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('overlaps the source tree');
      expect(result.stderr).toContain(sibling);
      expect(tree(f.dir)).toEqual(before);
    }
  }, 90_000);

  for (const preexisting of [false, true]) test(`generated runtime leaf alias survives setup, preexisting=${preexisting}`, () => {
    const f = fixture('.claude');
    const renderedSkills = join(f.source, '.agents/skills');
    const renderedRoot = join(renderedSkills, 'gstack');
    const local = join(f.project, '.agents/skills');
    if (preexisting) {
      fixtureMkdirSync(renderedRoot, { recursive: true });
      fixtureWriteFileSync(join(renderedRoot, 'SKILL.md'), readFileSync(join(f.source, 'SKILL.md')));
    }
    fixtureMkdirSync(local, { recursive: true });
    symlinkSync(renderedRoot, join(local, 'gstack'), 'dir');
    const globalRoot = join(f.global, 'gstack/SKILL.md');
    rmSync(globalRoot);
    symlinkSync(join(renderedRoot, 'SKILL.md'), globalRoot);
    const before = tree(f.global);
    for (let run = 0; run < 2; run++) {
      install(f);
      expect(tree(f.global)).toEqual(before);
      expect(existsSync(join(renderedRoot, 'SKILL.md'))).toBe(true);
      expect(realpathSync(join(local, 'gstack/SKILL.md'))).toBe(join(renderedRoot, 'SKILL.md'));
      expect(readFileSync(globalRoot)).toEqual(readFileSync(join(renderedRoot, 'SKILL.md')));
      expect(realpathSync(join(local, 'gstack/bin'))).toBe(join(f.source, 'bin'));
    }
  }, 90_000);

  for (const target of ['source', 'rendered', 'missing-rendered']) for (const windows of [false, true]) test(`source-backed namespace is refused without mutation: ${target}, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const renderedSkills = join(f.source, '.agents/skills');
    const oldRender = join(renderedSkills, 'gstack-claude');
    if (target !== 'missing-rendered') {
      fixtureMkdirSync(oldRender, { recursive: true });
      fixtureWriteFileSync(join(oldRender, 'SKILL.md'), '---\nname: gstack-claude\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nExcluded global workflow.\n');
      rmSync(join(f.global, 'gstack-claude'), { recursive: true });
      symlinkSync(oldRender, join(f.global, 'gstack-claude'), 'dir');
    }
    fixtureMkdirSync(join(f.project, '.agents'));
    symlinkSync(target === 'source' ? f.source : renderedSkills, join(f.project, '.agents/skills'), 'dir');
    if (windows) fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(target === 'missing-rendered' ? 'unresolvable directory' : 'overlaps the source tree');
    expect(result.stderr).toContain('Use a separate project-local skills directory');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

  for (const level of ['agents', 'skills']) for (const preexisting of [false, true]) for (const windows of [false, true]) test(`outward generation namespace is refused before writes: ${level}, preexisting=${preexisting}, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const agents = join(f.project, '.agents');
    const local = join(agents, 'skills');
    fixtureMkdirSync(agents);
    if (preexisting || level === 'skills') fixtureMkdirSync(local);
    if (level === 'agents') symlinkSync(agents, join(f.source, '.agents'), 'dir');
    else {
      fixtureMkdirSync(join(f.source, '.agents'));
      symlinkSync(local, join(f.source, '.agents/skills'), 'dir');
    }
    if (preexisting) for (const name of ['gstack', 'gstack-review']) {
      fixtureMkdirSync(join(local, name));
      fixtureWriteFileSync(join(local, name, 'SKILL.md'), `Handwritten ${name} workflow.\n`);
      fixtureWriteFileSync(join(local, name, 'user-notes'), 'Preserve unrelated user notes.\n');
    }
    if (!preexisting && level === 'skills') rmSync(local, { recursive: true });
    if (windows) fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
    fixtureWriteFileSync(join(f.home, '.gstack/.last-setup-version'), '1.85.0.0');
    const before = tree(f.dir);
    for (const host of ['codex', 'claude', 'auto']) for (let run = 0; run < 2; run++) {
      const result = spawnSync('bash', [join(f.source, 'setup'), '--host', host, '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
        cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
      });
      expect(tree(f.dir)).toEqual(before);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('generation namespace');
      expect(result.stderr).toContain('Use a separate project-local skills directory');
    }
  }, 90_000);

  for (const target of ['dangling-agents', 'dangling-skills', 'cyclic-agents', 'cyclic-skills', 'file-agents', 'file-skills', 'source-root']) test(`unresolvable generation namespace is refused without mutation: ${target}`, () => {
    const f = fixture('.claude');
    const agents = join(f.source, '.agents');
    const component = target.endsWith('skills') || target === 'source-root' ? join(agents, 'skills') : agents;
    if (component !== agents) fixtureMkdirSync(agents);
    if (target.startsWith('file')) fixtureWriteFileSync(component, 'Preserve namespace file.\n');
    else symlinkSync(target === 'source-root' ? f.source : target.startsWith('cyclic') ? component : join(f.source, 'missing-generation'), component, 'dir');
    const before = tree(f.dir);
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team'], {
        cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
      });
      expect(tree(f.dir)).toEqual(before);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('generation namespace');
    }
  }, 90_000);

  for (const level of ['agents', 'skills']) for (const preexisting of [false, true]) for (const windows of [false, true]) test(`internal generation namespace alias remains supported: ${level}, preexisting=${preexisting}, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const internal = join(f.source, 'generated-codex');
    fixtureMkdirSync(internal);
    if (level === 'agents') symlinkSync(internal, join(f.source, '.agents'), 'dir');
    else {
      fixtureMkdirSync(join(f.source, '.agents'));
      symlinkSync(internal, join(f.source, '.agents/skills'), 'dir');
    }
    const generated = join(f.source, '.agents/skills');
    if (preexisting) {
      fixtureMkdirSync(join(generated, 'gstack-review'), { recursive: true });
      fixtureWriteFileSync(join(generated, 'gstack-review/SKILL.md'), 'Prior internal render.\n');
    }
    if (windows) {
      fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
        fixtureWriteFileSync(join(f.source, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
      }
    }
    fixtureWriteFileSync(join(f.source, 'uncommitted-work'), 'Preserve source edits.\n');
    const excluded = tree(f.global), sibling = tree(f.other);
    const sourceBefore = Object.fromEntries(['SKILL.md', 'bin', 'lib', 'uncommitted-work'].map(rel => [rel, tree(join(f.source, rel))]));
    for (let run = 0; run < 2; run++) {
      install(f);
      expect(tree(f.global)).toEqual(excluded);
      expect(tree(f.other)).toEqual(sibling);
      for (const [rel, before] of Object.entries(sourceBefore)) expect(tree(join(f.source, rel))).toEqual(before);
      expect(readFileSync(join(f.project, '.agents/skills/gstack-review/SKILL.md'))).toEqual(readFileSync(join(generated, 'gstack-review/SKILL.md')));
      expect(existsSync(join(f.source, 'bin/bin'))).toBe(false);
    }
  }, 90_000);

  for (const windows of [false, true]) test(`individual generated skill leaf alias remains supported, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const rendered = join(f.source, '.agents/skills/gstack-review');
    const local = join(f.project, '.agents/skills');
    fixtureMkdirSync(rendered, { recursive: true });
    fixtureMkdirSync(local, { recursive: true });
    fixtureWriteFileSync(join(rendered, 'user-notes'), 'Keep notes beside the source render.\n');
    symlinkSync(rendered, join(local, 'gstack-review'), 'dir');
    if (windows) {
      fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
        fixtureWriteFileSync(join(f.source, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
      }
    }
    const excluded = tree(f.global);
    for (let run = 0; run < 2; run++) {
      install(f);
      expect(tree(f.global)).toEqual(excluded);
      expect(readFileSync(join(rendered, 'user-notes'), 'utf8')).toBe('Keep notes beside the source render.\n');
      expect(readFileSync(join(local, 'gstack-review/SKILL.md'))).toEqual(readFileSync(join(rendered, 'SKILL.md')));
    }
  }, 90_000);

  for (const target of ['dangling-skills', 'dangling-agents', 'cyclic-skills', 'file-skills']) test(`unresolvable namespace is refused without mutation: ${target}`, () => {
    const f = fixture('.claude');
    const agents = join(f.project, '.agents');
    if (target === 'dangling-agents') symlinkSync(join(f.dir, 'missing-agents'), agents, 'dir');
    else {
      fixtureMkdirSync(agents);
      const local = join(agents, 'skills');
      if (target === 'file-skills') fixtureWriteFileSync(local, 'Preserve this file.\n');
      else symlinkSync(target === 'cyclic-skills' ? 'skills' : join(f.dir, 'missing-skills'), local, 'dir');
    }
    const before = tree(f.dir);
    const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
      cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('unresolvable directory');
    expect(result.stderr).toContain('Use a separate project-local skills directory');
    expect(tree(f.dir)).toEqual(before);
  }, 90_000);

});
