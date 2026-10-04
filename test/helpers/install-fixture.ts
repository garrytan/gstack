/**
 * Real-setup fixtures for the install tests: host conformance, the install
 * registry, the Claude overlay, Conductor hooks and Codex scope.
 *
 * A fixture is a throwaway gstack checkout (the working tree's tracked and
 * untracked-but-not-ignored files, so uncommitted changes are under test) plus
 * a clean HOME. Binaries are stubbed and `bun run build` is refused, so setup
 * runs its real registration path without compiling (GSTACK_SKIP_PLAYWRIGHT,
 * GSTACK_SETUP_SKIP_CSO_BUILD, GSTACK_SKIP_FONTS). Every write the test makes
 * goes through `put` or the `fixture*Sync` wrappers, which refuse paths
 * outside the fixture roots.
 *
 * The checkout is built once per test file into a read-only seed and cloned
 * per fixture (copy-on-write reflink/clonefile where the filesystem has one,
 * else a full copy). Clones are independent files, never hard links, because
 * tests and `put` write into the checkout in place.
 */
import { expect } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
if (listed.status !== 0) throw new Error(listed.stderr);
const SOURCE_FILES = listed.stdout.split('\0').filter(rel => rel && !/^(?:test|docs|browse\/test|\.github|node_modules)\//.test(rel) && existsSync(join(ROOT, rel)));
const STUB_BINARIES = ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf', 'browse/dist/.build-complete'];
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const POSIX = process.platform !== 'win32';

export interface Fixture { dir: string; home: string; commands: string; env: Record<string, string> }

/** Fixture roots; every helper write must land under one of them. */
export const owned: string[] = [];

/** `target` is `base` or below it, compared by the platform's own path rules (separators, Windows drive case). */
const within = (base: string, target: string) => {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Write inside the fixture only (never through a link out of it). */
export function put(file: string, content: string | Buffer, mode = 0o644) {
  const root = owned.find(r => file !== r && within(r, file));
  if (!root) throw new Error(`fixture write outside a fixture root: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  if (!within(realpathSync(root), realpathSync(dirname(file)))) throw new Error(`fixture write escapes its root: ${file}`);
  writeFileSync(file, content, { mode });
}

export function assertFixtureWrite(file: string) {
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
export function fixtureWriteFileSync(...args: Parameters<typeof writeFileSync>) {
  assertFixtureWrite(String(args[0]));
  return writeFileSync(...args);
}
export function fixtureCopyFileSync(...args: Parameters<typeof copyFileSync>) {
  assertFixtureWrite(String(args[1]));
  return copyFileSync(...args);
}
export function fixtureMkdirSync(...args: Parameters<typeof mkdirSync>) {
  assertFixtureWrite(String(args[0]));
  return mkdirSync(...args);
}
export function fixtureUtimesSync(...args: Parameters<typeof utimesSync>) {
  assertFixtureWrite(String(args[0]));
  return utimesSync(...args);
}

let seed: string | undefined;
let seedEntries: { rel: string; link?: string; mode: number }[] = [];
const STUB_MTIME = new Date('2040-01-01');
const SEED_PREFIX = 'gstack-install-seed-';

function removeSeed(root: string) {
  if (POSIX) spawnSync('chmod', ['-R', 'u+w', root], { timeout: 30_000 });
  rmSync(root, { recursive: true, force: true });
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * The prebuilt checkout every fixture clones: built on first use and read-only.
 * Callers register `afterAll(cleanupSeed)`; Bun's test runner fires no process
 * exit event, so a seed left by a killed run is swept when its pid is gone.
 */
export function seedSource(): string {
  if (seed) return seed;
  for (const name of readdirSync(tmpdir())) {
    const pid = new RegExp(`^${SEED_PREFIX}(\\d+)-`).exec(name)?.[1];
    if (pid && !alive(Number(pid))) removeSeed(join(tmpdir(), name));
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${SEED_PREFIX}${process.pid}-`)));
  const dir = join(root, 'gstack');
  const entries: typeof seedEntries = [];
  try {
    for (const rel of SOURCE_FILES) {
      const from = join(ROOT, rel);
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(from);
        if (!within(dir, resolve(dirname(to), link))) throw new Error(`source symlink leaves the checkout: ${rel} -> ${link}`);
        symlinkSync(link, to);
        entries.push({ rel, link, mode: 0o777 });
      } else {
        copyFileSync(from, to);
        entries.push({ rel, mode: stat.mode & 0o7777 });
      }
    }
    for (const rel of STUB_BINARIES) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      utimesSync(join(dir, rel), STUB_MTIME, STUB_MTIME);
      if (!SOURCE_FILES.includes(rel)) entries.push({ rel, mode: 0o755 });
    }
    if (POSIX) {
      const locked = spawnSync('chmod', ['-R', 'a-w', dir], { encoding: 'utf8', timeout: 30_000 });
      if (locked.status !== 0) throw new Error(`could not make the fixture seed read-only: ${locked.stderr}`);
    }
  } catch (err) {
    removeSeed(root);
    throw err;
  }
  seedEntries = entries;
  return seed = dir;
}

export function cleanupSeed() {
  if (!seed) return;
  removeSeed(dirname(seed));
  seed = undefined;
  seedEntries = [];
}

/** Clone the seed into `dest` (inside a fixture root) file by file: a reflink/clonefile where the filesystem supports one, else a full copy, with the checkout's own modes. */
function cloneSeed(dest: string) {
  if (!owned.some(r => within(r, dest))) throw new Error(`fixture clone outside a fixture root: ${dest}`);
  const from = seedSource();
  for (const { rel, link, mode } of seedEntries) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (link !== undefined) symlinkSync(link, to);
    else {
      copyFileSync(join(from, rel), to, constants.COPYFILE_FICLONE);
      chmodSync(to, mode);
    }
  }
  for (const rel of STUB_BINARIES) utimesSync(join(dest, rel), STUB_MTIME, STUB_MTIME);
}

export function makeFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-install-')));
  owned.push(dir);
  const home = join(dir, 'home');
  const commands = join(dir, 'commands');
  mkdirSync(home, { recursive: true });
  put(join(commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  'run build') echo 'Unexpected build in an install fixture' >&2; exit 90 ;;
  *) exec ${quote(process.execPath)} "$@" ;;
esac
`, 0o755);
  put(join(home, '.gstack/config.yaml'), 'telemetry: off\nartifacts_sync: off\n');
  const env: Record<string, string> = {
    PATH: `${commands}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
    TMPDIR: dir, TMP: dir, TEMP: dir, LANG: 'C.UTF-8',
    GSTACK_SKIP_PLAYWRIGHT: '1', GSTACK_SETUP_SKIP_CSO_BUILD: '1', GSTACK_SKIP_FONTS: '1',
    GSTACK_SKIP_COREUTILS: '1', GSTACK_SKIP_ASIDE: '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'gstack-install-fixture-bun-cache'),
  };
  return { dir, home, commands, env };
}

/** A gstack checkout at `dest` (inside the fixture) with stubbed binaries. */
export function makeSource(f: Fixture, dest: string, version?: string): string {
  cloneSeed(dest);
  if (version) setVersion(dest, version);
  return dest;
}

export function setVersion(source: string, version: string) {
  put(join(source, 'VERSION'), `${version}\n`);
}

export function runSetup(f: Fixture, setupPath: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [setupPath, ...args, '--no-plan-tune-hooks'], {
    cwd: opts.cwd ?? f.home, env: { ...f.env, ...opts.env }, encoding: 'utf8', timeout: 60_000, input: '',
  });
}

export function registryRows(f: Fixture, stateRoot = join(f.home, '.gstack')): string[][] {
  const file = join(stateRoot, 'installs.tsv');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
}

/**
 * Path → link target / sha256 / subtree, for "nothing changed" assertions.
 * `.capy` is skipped: Capy cloud machines wrap git with a shim that logs to
 * $HOME/.capy, which is the machine's write, not gstack's.
 */
export function tree(dir: string): unknown {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: readlinkSync(dir) };
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(dir).filter(name => name !== '.capy').sort().map(name => [name, tree(join(dir, name))]));
  return createHash('sha256').update(readFileSync(dir)).digest('hex');
}

export type CodexScopeFixture = ReturnType<typeof fixture>;

/**
 * Codex-scope layout: a checkout at `layout` ('machine' → ~/.claude/skills/gstack,
 * 'ordinary' → project-a/custom-checkout, else project-a/<layout>/skills/gstack)
 * beside a previous release's global Codex namespace in ~/.codex/skills.
 */
export function fixture(layout: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-codex-scope-'));
  owned.push(dir);
  const home = join(dir, 'home');
  const project = join(dir, 'project-a');
  const other = join(dir, 'project-b');
  const source = layout === 'machine' ? join(home, '.claude/skills/gstack')
    : layout === 'ordinary' ? join(project, 'custom-checkout') : join(project, layout, 'skills/gstack');
  const commands = join(dir, 'commands');
  for (const d of [home, other, commands, source]) fixtureMkdirSync(d, { recursive: true });
  cloneSeed(source);
  const write = (file: string, content: string) => {
    fixtureMkdirSync(dirname(file), { recursive: true });
    fixtureWriteFileSync(file, content, { mode: 0o755 });
  };
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

export function install(f: CodexScopeFixture, args = '--host codex') {
  const result = spawnSync('bash', [join(f.source, 'setup'), ...args.split(' '), '--no-plan-tune-hooks', '--no-timeline-stop-hook', '--no-team'], {
    cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

export function cleanupFixtures() {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
}
