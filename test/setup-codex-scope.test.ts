import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateAutoplanSnapshotTool } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { runBashScript } from './helpers/bash-script';

const ROOT = resolve(import.meta.dir, '..');
const files = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
if (files.status !== 0) throw new Error(files.stderr);
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;


function assertFixtureWrite(file: string) {
  const root = owned.find(dir => file === dir || file.startsWith(dir + '/'));
  if (!root) throw new Error(`Fixture write outside owned roots: ${file}`);
  let existing = file;
  while (!existsSync(existing)) {
    if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Unresolvable fixture link: ${existing}`);
    existing = dirname(existing);
  }
  const target = realpathSync(existing);
  const physicalRoot = realpathSync(root);
  if (target !== physicalRoot && !target.startsWith(physicalRoot + '/')) throw new Error(`Fixture write escapes physical root: ${file} -> ${target}`);
}
function fixtureWriteFileSync(...args: Parameters<typeof writeFileSync>) {
  assertFixtureWrite(String(args[0]));
  return writeFileSync(...args);
}
function fixtureCopyFileSync(...args: Parameters<typeof copyFileSync>) {
  assertFixtureWrite(String(args[1]));
  return copyFileSync(...args);
}
function fixtureMkdirSync(...args: Parameters<typeof mkdirSync>) {
  assertFixtureWrite(String(args[0]));
  return mkdirSync(...args);
}
function fixtureUtimesSync(...args: Parameters<typeof utimesSync>) {
  assertFixtureWrite(String(args[0]));
  return utimesSync(...args);
}

function tree(dir: string): unknown {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return { link: readlinkSync(dir) };
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(dir).sort().map(name => [name, tree(join(dir, name))]));
  return createHash('sha256').update(readFileSync(dir)).digest('hex');
}

function fixture(layout: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-codex-scope-'));
  owned.push(dir);
  const home = join(dir, 'home');
  const project = join(dir, 'project-a');
  const other = join(dir, 'project-b');
  const source = layout === 'machine' ? join(home, '.claude/skills/gstack')
    : layout === 'ordinary' ? join(project, 'custom-checkout') : join(project, layout, 'skills/gstack');
  const commands = join(dir, 'commands');
  for (const d of [home, other, commands, source]) fixtureMkdirSync(d, { recursive: true });
  for (const rel of [...files.stdout.split('\0').filter(Boolean), 'scripts/external-skill-names.ts', 'scripts/preflight-codex-overlap.ts']) {
    if (/^(?:test|docs|browse\/test|\.github)\//.test(rel)) continue;
    const dest = join(source, rel);
    fixtureMkdirSync(dirname(dest), { recursive: true });
    if (lstatSync(join(ROOT, rel)).isSymbolicLink()) {
      const target = readlinkSync(join(ROOT, rel));
      expect(resolve(dirname(dest), target).startsWith(source + '/')).toBe(true);
      symlinkSync(target, dest);
    } else fixtureCopyFileSync(join(ROOT, rel), dest);
  }
  const write = (file: string, content: string) => {
    fixtureMkdirSync(dirname(file), { recursive: true });
    fixtureWriteFileSync(file, content, { mode: 0o755 });
  };
  for (const rel of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf', 'browse/dist/.build-complete']) {
    const file = join(source, rel);
    write(file, '#!/bin/sh\nexit 0\n');
    fixtureUtimesSync(file, new Date('2040-01-01'), new Date('2040-01-01'));
  }
  write(join(commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  'build --help') echo 'Fixture Bun has no CSO compile flags'; exit 0 ;;
  'run build') echo 'Unexpected build in registration fixture' >&2; exit 90 ;;
  *) exec ${quote(process.execPath)} "$@" ;;
esac
`);
  const realRm = Bun.which('rm');
  if (!realRm) throw new Error('rm is required');
  write(join(commands, 'rm'), `#!/usr/bin/env bash
if [ "$#" -eq 2 ] && [ "$1" = -f ] && [ "$2" = /tmp/gstack-latest-version ]; then exit 0; fi
exec ${quote(realRm)} "$@"
`);
  for (const name of ['codex', 'claude']) write(join(commands, name), '#!/bin/sh\nexit 0\n');
  const global = join(home, '.codex/skills');
  const previous = join(dir, 'previous/gstack');
  write(join(previous, 'bin/gstack-autoplan-snapshot.ts'), readFileSync(join(ROOT, 'bin/gstack-autoplan-snapshot.ts'), 'utf8'));
  write(join(previous, 'lib/claude-bin.ts'), 'export {};\n');
  for (const name of ['gstack-review', 'gstack-claude', 'gstack-retired']) {
    write(join(previous, name, 'SKILL.md'), `---\nname: ${name}\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior global skill.\n`);
    fixtureMkdirSync(global, { recursive: true });
    if (name === 'gstack-claude') {
      write(join(global, name, 'SKILL.md'), readFileSync(join(previous, name, 'SKILL.md'), 'utf8'));
    } else symlinkSync(join(previous, name), join(global, name), 'dir');
  }
  fixtureMkdirSync(join(global, 'gstack'), { recursive: true });
  symlinkSync(join(previous, 'bin'), join(global, 'gstack/bin'), 'dir');
  symlinkSync(join(previous, 'lib'), join(global, 'gstack/lib'), 'dir');
  write(join(global, 'gstack/SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nGlobal router.\n');
  write(join(global, 'custom/SKILL.md'), 'User-owned skill.\n');
  const env = {
    PATH: `${commands}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GSTACK_HOME: join(home, '.gstack'), GSTACK_STATE_ROOT: join(home, '.gstack'),
    TMPDIR: dir, TMP: dir, TEMP: dir,
    GSTACK_SKIP_PLAYWRIGHT: '1', GSTACK_SKIP_FONTS: '1', GSTACK_SKIP_COREUTILS: '1', GSTACK_SKIP_ASIDE: '1', GSTACK_SKIP_GBRAIN_REGEN: '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'gstack-preflight-bun-cache'),
  };
  write(join(home, '.gstack/config.yaml'), 'telemetry: off\nartifacts_sync: off\n');
  return { dir, source, home, project, other, global, previous, env };
}

function install(f: ReturnType<typeof fixture>, args = '--host codex') {
  const result = spawnSync('bash', [join(f.source, 'setup'), ...args.split(' '), '--no-plan-tune-hooks', '--no-timeline-stop-hook', '--no-team'], {
    cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

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


describe.skipIf(process.platform === 'win32')('F13 independent review boundaries', () => {
  for (const target of ['legacy', 'replacement', 'legacy-skill', 'runtime', 'runtime-bin', 'runtime-lib']) {
    test(`Claude-only setup preserves cyclic foreign ownership link: ${target}`, () => {
      const f = fixture('ordinary');
      rmSync(join(f.global, 'gstack-retired'));
      for (const rel of ['bin', 'lib']) {
        const asset = join(f.global, 'gstack', rel);
        rmSync(asset);
        symlinkSync(join(f.source, rel), asset, 'dir');
      }
      const old = join(f.global, 'gstack-claude');
      rmSync(old, { recursive: true });
      const oldRender = join(f.source, '.agents/skills/gstack-claude');
      fixtureMkdirSync(oldRender, { recursive: true });
      fixtureWriteFileSync(join(oldRender, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior legacy render.\n');
      symlinkSync(oldRender, old, 'dir');
      const link = target === 'legacy' ? old
        : target === 'replacement' ? join(f.global, 'gstack-claude-code')
        : target === 'legacy-skill' ? join(old, 'SKILL.md')
        : target === 'runtime' ? join(f.global, 'gstack')
        : join(f.global, 'gstack', target === 'runtime-bin' ? 'bin' : 'lib');
      if (target === 'legacy-skill') {
        rmSync(old);
        fixtureMkdirSync(old);
      }
      if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true });
      symlinkSync(link, link);
      const before = tree(f.global);
      for (let run = 0; run < 2; run++) {
        install(f, '--host claude');
        expect(tree(f.global)).toEqual(before);
      }
    }, 90_000);
  }

  for (const alias of [false, true]) for (const windows of [false, true]) {
    test(`global generation namespace is refused before mutation: alias=${alias}, Windows=${windows}`, () => {
      const f = fixture('ordinary');
      const agents = join(f.source, '.agents');
      fixtureMkdirSync(agents, { recursive: true });
      const codexHome = alias ? join(f.home, 'generation-alias') : agents;
      if (alias) symlinkSync(agents, codexHome, 'dir');
      if (windows) {
        fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\n"\n', { mode: 0o755 });
        for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
          fixtureCopyFileSync(join(f.source, rel.replace('.exe', '')), join(f.source, rel));
          fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
        }
      }
      const before = tree(f.dir);
      for (let run = 0; run < 2; run++) {
        const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
          cwd: f.other, env: { ...f.env, CODEX_HOME: codexHome }, encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('host namespace');
        expect(tree(f.dir)).toEqual(before);
      }
    }, 90_000);
  }

  for (const leaf of ['SKILL.md', 'agents']) {
    test(`selected generated cyclic write remains fail-closed: ${leaf}`, () => {
      const f = fixture('ordinary');
      const generated = join(f.source, '.agents/skills/gstack-review');
      fixtureMkdirSync(generated, { recursive: true });
      const link = join(generated, leaf);
      symlinkSync(link, link);
      const before = tree(f.dir);
      for (let run = 0; run < 2; run++) {
        const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
          cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('ELOOP');
        expect(tree(f.dir)).toEqual(before);
      }
    }, 90_000);
  }

});
