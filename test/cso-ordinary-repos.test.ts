// Regressions for /cso on ordinary user repositories: an untracked nested Git
// repository (#3255 bug 1), a patch history over the 1 MiB bound (#3255 bug 2),
// a Docker socket that realpath refuses to open (#3248), and symlinks whose
// target stays inside the repository.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IN_REPOSITORY_LINK, LINK_OUTSIDE_AUDIT_PATHS, LINK_TO_UNCAPTURED_PATH, NESTED_REPOSITORY, OUTSIDE_AUDIT_PATHS, capture, historyMarker } from '../lib/cso/snapshot';
import { newRun, readJson } from '../lib/cso/state';
import { MAX_OUTPUT } from '../lib/cso/contracts';
import { dockerEndpoint } from '../lib/cso/docker';
import { TRUSTED_DIRECTORIES } from '../lib/cso/process';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const MIB = 1024 * 1024;
const CREDENTIAL_CANARY = ['ghp_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
const OLD_CANARY = ['ghp_', 'zyxwvutsrqponmlkjihgfedcba0987654321'].join('');
const MARKER = '[gstack-cso history truncated:';
const roots: string[] = [];
const originalHome = process.env.GSTACK_HOME;
let state = '';
beforeAll(() => {
  state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cso-ordinary-state-')));
  process.env.GSTACK_HOME = state;
});
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = originalHome;
  fs.rmSync(state, { recursive: true, force: true });
});

function tmp(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cso-ordinary-')));
  roots.push(root);
  return root;
}
function git(repo: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env: { HOME: path.dirname(repo), PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  if (result.status) throw new Error(result.stderr);
  return result.stdout;
}
function init(repo: string): string {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'config', 'user.name', 'Fixture');
  return repo;
}
function commit(repo: string, files: Record<string, string>, subject: string): void {
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', subject);
}
function filler(tag: string, bytes: number): string {
  const lines: string[] = [];
  for (let i = 0, size = 0; size < bytes; i++) {
    const line = `export const ${tag}${i} = ${i};`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n') + '\n';
}
function nestedRepository(outer: string, name: string, files: Record<string, string>): string {
  const inner = init(path.join(outer, name));
  commit(inner, files, 'inner');
  return inner;
}
function cso(repo: string, args: string[]) {
  return spawnSync(launcher, args, { cwd: repo, encoding: 'utf8', env: { HOME: path.dirname(repo), GSTACK_HOME: state, PATH: '/usr/bin:/bin' }, timeout: 120_000, maxBuffer: 64 * MIB });
}
function runFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile()).map((item) => path.join(item.parentPath, item.name));
}

describe('CSO start on a repository with an untracked nested repository (#3255 bug 1)', () => {
  test('start succeeds, records the boundary as an explicit exclusion, and never reads the nested source', () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'README.md': 'outer\n' }, 'outer');
    nestedRepository(repo, 'inner', { 'secret.txt': `TOKEN=${CREDENTIAL_CANARY}\n` });
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = path.join(state, 'security', 'cso', run.repoId, run.runId),
      report = readJson(path.join(dir, 'report.json')),
      snapshot = report.coverage.find((item: any) => item.domain === 'snapshot-inputs');
    expect(snapshot.exclusions).toEqual([`inner: ${NESTED_REPOSITORY}`]);
    expect(snapshot.gaps).toEqual([]);
    for (const file of runFiles(dir)) expect(fs.readFileSync(file, 'utf8')).not.toContain(CREDENTIAL_CANARY);
    expect(fs.existsSync(path.join(dir, 'snapshot', 'inner'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'readable', 'inner'))).toBe(false);
  });

  test('negative control: an untracked symlink to a directory is still refused, not treated as a boundary', () => {
    const root = tmp(),
      repo = init(path.join(root, 'repo')),
      outside = path.join(root, 'outside');
    commit(repo, { 'README.md': 'outer\n' }, 'outer');
    nestedRepository(repo, 'inner', { 'f.txt': 'x\n' });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'host.txt'), 'host\n');
    fs.symlinkSync(outside, path.join(repo, 'escape'));
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.status).not.toBe(0);
    expect(JSON.parse(started.stderr).error).toMatchObject({ code: 'UNSAFE_PATH', message: expect.stringContaining('escape') });
  });

  test('negative control: a nested repository swapped for another directory during capture fails as a snapshot race', async () => {
    const root = tmp(),
      repo = init(path.join(root, 'repo')),
      target = path.join(repo, 'vendor', 'inner'),
      replacement = path.join(root, 'replacement');
    commit(repo, { 'README.md': 'outer\n' }, 'outer');
    fs.mkdirSync(path.join(repo, 'vendor'));
    nestedRepository(repo, 'vendor/inner', { 'f.txt': 'x\n' });
    nestedRepository(root, 'replacement', { 'f.txt': 'y\n' });
    const original = fs.lstatSync;
    let hits = 0;
    const counting = spyOn(fs, 'lstatSync').mockImplementation(((candidate: any, options?: any) => {
      if (path.resolve(String(candidate)) === target) hits++;
      return options === undefined ? original(candidate) : original(candidate, options);
    }) as typeof fs.lstatSync);
    try {
      await capture(repo, newRun(repo).dir, 'HEAD');
    } finally {
      counting.mockRestore();
    }
    const last = hits;
    expect(last).toBeGreaterThan(1);
    hits = 0;
    let swapped = false;
    const swapping = spyOn(fs, 'lstatSync').mockImplementation(((candidate: any, options?: any) => {
      if (path.resolve(String(candidate)) === target && ++hits === last) {
        fs.renameSync(target, `${target}.parked`);
        fs.renameSync(replacement, target);
        swapped = true;
      }
      return options === undefined ? original(candidate) : original(candidate, options);
    }) as typeof fs.lstatSync);
    try {
      await expect(capture(repo, newRun(repo).dir, 'HEAD')).rejects.toMatchObject({ code: 'SNAPSHOT_RACE', message: 'Source changed before snapshot persistence: vendor/inner' });
    } finally {
      swapping.mockRestore();
    }
    expect(swapped).toBe(true);
  });
});

describe('CSO start on a repository with in-repository symlinks', () => {
  test('start succeeds, records each contained link as an explicit exclusion, and still audits its target', () => {
    const repo = init(path.join(tmp(), 'repo'));
    fs.mkdirSync(path.join(repo, 'docs'));
    commit(repo, { 'README.md': 'readme\n', 'docs/guide.md': 'guide\n' }, 'base');
    fs.symlinkSync('README.md', path.join(repo, 'README'));
    fs.symlinkSync('docs', path.join(repo, 'handbook'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'links');
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = path.join(state, 'security', 'cso', run.repoId, run.runId),
      report = readJson(path.join(dir, 'report.json')),
      snapshot = report.coverage.find((item: any) => item.domain === 'snapshot-inputs');
    expect(snapshot.exclusions.sort()).toEqual([`README: ${IN_REPOSITORY_LINK}`, `handbook: ${IN_REPOSITORY_LINK}`]);
    expect(snapshot.gaps).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'snapshot')).sort()).toEqual(['README.md', 'docs']);
  });

  test('a link may point up out of its directory, and an unchanged link is not a changed path', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    fs.mkdirSync(path.join(repo, 'web'));
    commit(repo, { 'README.md': 'readme\n', 'web/app.ts': 'export {};\n' }, 'base');
    fs.symlinkSync('../README.md', path.join(repo, 'web', 'README.md'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'link');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    commit(repo, { 'web/app.ts': 'export const changed = 1;\n' }, 'change');
    const manifest = await capture(repo, newRun(repo).dir, base),
      link = manifest.entries.find((entry) => entry.path === 'web/README.md');
    expect(link).toMatchObject({ originalHash: 'not-read', transformation: IN_REPOSITORY_LINK });
    expect(link?.executionHash).toBeUndefined();
    expect(manifest.changedPaths).toEqual(['web/app.ts']);
  });

  test('negative controls: absolute, escaping, broken, cyclic and special-file links are still refused', async () => {
    const root = tmp(),
      repo = init(path.join(root, 'repo')),
      outside = path.join(root, 'outside.txt');
    commit(repo, { 'README.md': 'readme\n', '.gitignore': 'ignored-*\n' }, 'base');
    fs.writeFileSync(outside, 'host\n');
    // Ignored links are allowed on their own, so these prove the check follows
    // the whole chain rather than trusting the first hop.
    fs.symlinkSync(outside, path.join(repo, 'ignored-escape'));
    const links: Record<string, string> = {
      absolute: path.join(repo, 'README.md'),
      escape: '../outside.txt',
      broken: 'missing.txt',
      cycle: 'cycle',
      hop: 'ignored-escape',
    };
    if (process.platform !== 'win32') {
      expect(spawnSync('/usr/bin/mkfifo', [path.join(repo, 'ignored-fifo')], { timeout: 10_000 }).status).toBe(0);
      links.fifo = 'ignored-fifo';
    }
    for (const [name, target] of Object.entries(links)) {
      const link = path.join(repo, name);
      fs.symlinkSync(target, link);
      try {
        await expect(capture(repo, newRun(repo).dir)).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: `Symlink or special source file: ${name}` });
      } finally {
        fs.unlinkSync(link);
      }
    }
  });

  test('negative control: a link retargeted or deleted during capture fails as a snapshot race', async () => {
    const repo = init(path.join(tmp(), 'repo')),
      target = path.join(repo, 'README');
    commit(repo, { 'README.md': 'readme\n', 'OTHER.md': 'other\n' }, 'base');
    fs.symlinkSync('README.md', target);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'link');
    const original = fs.lstatSync;
    let hits = 0;
    const counting = spyOn(fs, 'lstatSync').mockImplementation(((candidate: any, options?: any) => {
      if (path.resolve(String(candidate)) === target) hits++;
      return options === undefined ? original(candidate) : original(candidate, options);
    }) as typeof fs.lstatSync);
    try {
      await capture(repo, newRun(repo).dir, 'HEAD');
    } finally {
      counting.mockRestore();
    }
    // The last two reads of the link are the final stability check's. Change
    // it just before them. A retargeted link is itself contained, so only the
    // recorded identity can catch it.
    const last = hits - 1;
    const changes: [() => void, string][] = [
      [() => fs.symlinkSync('OTHER.md', target), 'Source changed before snapshot persistence: README'],
      [() => {}, 'Source symlink changed during validation: README'],
    ];
    for (const [replace, message] of changes) {
      hits = 0;
      let swapped = false;
      const swapping = spyOn(fs, 'lstatSync').mockImplementation(((candidate: any, options?: any) => {
        if (path.resolve(String(candidate)) === target && ++hits === last) {
          fs.unlinkSync(target);
          replace();
          swapped = true;
        }
        return options === undefined ? original(candidate) : original(candidate, options);
      }) as typeof fs.lstatSync);
      try {
        await expect(capture(repo, newRun(repo).dir, 'HEAD')).rejects.toMatchObject({ code: 'SNAPSHOT_RACE', message });
      } finally {
        swapping.mockRestore();
        fs.rmSync(target, { force: true });
        fs.symlinkSync('README.md', target);
      }
      expect(swapped).toBe(true);
    }
  });

  test('a link whose target is ignored or Git metadata is a gap: nothing at the target is audited', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    fs.mkdirSync(path.join(repo, 'generated'));
    fs.writeFileSync(path.join(repo, 'generated', 'auth.js'), 'module.exports = {};\n');
    commit(repo, { '.gitignore': 'generated/\n', 'index.js': 'require("./auth");\n' }, 'base');
    fs.symlinkSync('generated/auth.js', path.join(repo, 'auth.js'));
    fs.symlinkSync('.git/config', path.join(repo, 'gitconfig'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'links');
    const manifest = await capture(repo, newRun(repo).dir);
    for (const link of ['auth.js', 'gitconfig'])
      expect(manifest.entries.find((entry) => entry.path === link)).toMatchObject({ originalHash: 'not-read', transformation: LINK_TO_UNCAPTURED_PATH });
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('generated/auth.js');
  });

  test('a retargeted link and a file replaced by a link with the same bytes are changed paths', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'README.md': 'readme\n', 'OTHER.md': 'other\n', alias: 'README.md' }, 'base');
    fs.symlinkSync('README.md', path.join(repo, 'LINK'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'link');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.unlinkSync(path.join(repo, 'LINK'));
    fs.symlinkSync('OTHER.md', path.join(repo, 'LINK'));
    fs.unlinkSync(path.join(repo, 'alias'));
    fs.symlinkSync('README.md', path.join(repo, 'alias'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'retarget');
    expect((await capture(repo, newRun(repo).dir, base)).changedPaths).toEqual(['LINK', 'alias']);
  });

  test('under --paths a link entry is refused, a link to an out-of-scope target is a gap, and an out-of-scope link is withheld', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.mkdirSync(path.join(repo, 'tools'));
    commit(repo, { 'src/app.ts': 'export {};\n', 'tools/run.sh': 'echo\n' }, 'base');
    fs.symlinkSync('tools', path.join(repo, 'bin'));
    fs.symlinkSync('../tools', path.join(repo, 'src', 'tools'));
    fs.symlinkSync('run.sh', path.join(repo, 'tools', 'alias'));
    await expect(capture(repo, newRun(repo).dir, undefined, undefined, {}, ['bin'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: '--paths entry is a symlink: bin; pass the path it points to, tools' });
    const manifest = await capture(repo, newRun(repo).dir, undefined, undefined, {}, ['src']);
    expect(manifest.entries.find((entry) => entry.path === 'src/tools')).toMatchObject({ originalHash: 'not-read', transformation: LINK_OUTSIDE_AUDIT_PATHS });
    expect(manifest.entries.find((entry) => entry.path === 'tools/alias')).toMatchObject({ originalHash: 'not-read', transformation: OUTSIDE_AUDIT_PATHS });
  });

  test('a --paths entry deleted from disk is recorded as a deletion, not refused', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    fs.mkdirSync(path.join(repo, 'src'));
    commit(repo, { 'src/old.ts': 'export {};\n', 'src/app.ts': 'export {};\n' }, 'base');
    fs.unlinkSync(path.join(repo, 'src', 'old.ts'));
    const manifest = await capture(repo, newRun(repo).dir, undefined, undefined, {}, ['src/old.ts']);
    expect(manifest.deletedPaths?.map((entry) => entry.path)).toEqual(['src/old.ts']);
  });

  test('a broken link in an unignored host dependency tree is excluded, not refused', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'index.ts': 'export {};\n' }, 'base');
    fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../missing/cli.js', path.join(repo, 'node_modules', '.bin', 'broken'));
    const manifest = await capture(repo, newRun(repo).dir);
    expect(manifest.entries.find((entry) => entry.path === 'node_modules/.bin/broken')).toMatchObject({ originalHash: 'not-read', transformation: expect.stringMatching(/^excluded: /) });
  });

  test('outside --paths an escaping link or a FIFO is withheld, not refused; inside it each is refused', async () => {
    const root = tmp(),
      repo = init(path.join(root, 'repo')),
      outside = path.join(root, 'outside.txt'),
      host = path.join(repo, 'tools', 'host'),
      pipe = path.join(repo, 'tools', 'pipe'),
      fifo = process.platform !== 'win32';
    fs.mkdirSync(path.join(repo, 'src'));
    fs.mkdirSync(path.join(repo, 'tools'));
    commit(repo, { 'src/app.ts': 'export {};\n', 'tools/run.sh': 'echo\n' }, 'base');
    fs.writeFileSync(outside, 'host\n');
    fs.symlinkSync(outside, host);
    if (fifo) expect(spawnSync('/usr/bin/mkfifo', [pipe], { timeout: 10_000 }).status).toBe(0);
    const manifest = await capture(repo, newRun(repo).dir, undefined, undefined, {}, ['src']);
    expect(manifest.entries.find((entry) => entry.path === 'tools/host')).toMatchObject({ originalHash: 'not-read', transformation: OUTSIDE_AUDIT_PATHS });
    expect(manifest.entries.find((entry) => entry.path === 'src/app.ts')?.executionHash).toBeDefined();
    const widened = () => capture(repo, newRun(repo).dir, undefined, undefined, {}, ['src', 'tools']);
    if (fifo) {
      fs.unlinkSync(host);
      await expect(widened()).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: 'Symlink or special source file: tools/pipe' });
      fs.unlinkSync(pipe);
      fs.symlinkSync(outside, host);
    }
    await expect(widened()).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: 'Symlink or special source file: tools/host' });
  });
});

describe('CSO history capture over the 1 MiB bound (#3255 bug 2)', () => {
  test('keeps the newest whole commits that fit, marks the truncation, and still redacts', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'old.ts': filler('old', 450 * 1024) + `// ${OLD_CANARY}\n` }, 'oldest');
    commit(repo, { 'mid.ts': filler('mid', 450 * 1024) }, 'middle');
    commit(repo, { 'new.ts': filler('new', 300 * 1024) + `// ${CREDENTIAL_CANARY}\n` }, 'newest');
    const run = newRun(repo);
    await capture(repo, run.dir);
    const status = readJson(path.join(run.dir, 'history-status.json')),
      history = fs.readFileSync(path.join(run.dir, 'history.txt'), 'utf8');
    expect(status).toMatchObject({ status: 'captured', commits: 2 });
    expect(status.truncated).toBe(`the newest 2 of 3 commits were retained with patches; 1 older commits were omitted to stay within the ${MAX_OUTPUT}-byte history limit`);
    expect(history.startsWith(historyMarker(status.truncated))).toBe(true);
    expect(Buffer.byteLength(history)).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(status.bytes).toBe(Buffer.byteLength(history));
    expect(history).toContain('Subject: newest');
    expect(history).toContain('Subject: middle');
    expect(history).not.toContain('Subject: oldest');
    expect(history).toContain('diff --git a/new.ts b/new.ts');
    expect(history).not.toContain(CREDENTIAL_CANARY);
    expect(history).not.toContain(OLD_CANARY);
  });

  test('falls back to commit metadata when the newest patch alone exceeds the bound, and still redacts', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'a.ts': 'export const a = 1;\n' }, 'first');
    commit(repo, { 'big.ts': filler('big', 1.2 * MIB) }, `rotate ${CREDENTIAL_CANARY}`);
    const run = newRun(repo);
    await capture(repo, run.dir);
    const status = readJson(path.join(run.dir, 'history-status.json')),
      history = fs.readFileSync(path.join(run.dir, 'history.txt'), 'utf8');
    expect(status).toMatchObject({ status: 'captured', commits: 'metadata for at most 100' });
    expect(status.truncated).toMatch(/^patches were withheld because/);
    expect(history.startsWith(historyMarker(status.truncated))).toBe(true);
    expect(history).toContain('Subject: first');
    expect(history).toContain('Subject: rotate');
    expect(history).not.toContain('diff --git');
    expect(history).not.toContain(CREDENTIAL_CANARY);
  });

  test('a history within the bound is retained whole with no marker', async () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'a.ts': 'export const a = 1;\n' }, 'first');
    commit(repo, { 'b.ts': `// ${CREDENTIAL_CANARY}\n` }, 'second');
    const run = newRun(repo);
    await capture(repo, run.dir);
    const status = readJson(path.join(run.dir, 'history-status.json')),
      history = fs.readFileSync(path.join(run.dir, 'history.txt'), 'utf8');
    expect(status).toEqual({ status: 'captured', range: status.range, commits: 'at most 100', bytes: Buffer.byteLength(history) });
    expect(history.startsWith('commit ')).toBe(true);
    expect(history).toContain('Subject: first');
    expect(history).not.toContain(MARKER);
    expect(history).not.toContain(CREDENTIAL_CANARY);
  });

  test('start reports the truncated history as partial coverage and history stays readable', () => {
    const repo = init(path.join(tmp(), 'repo'));
    commit(repo, { 'old.ts': filler('old', 700 * 1024) }, 'oldest');
    commit(repo, { 'new.ts': filler('new', 700 * 1024) }, 'newest');
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      report = readJson(path.join(state, 'security', 'cso', run.repoId, run.runId, 'report.json')),
      coverage = report.coverage.find((item: any) => item.domain === 'history-inputs');
    expect(coverage.status).toBe('partial');
    expect(coverage.gaps).toEqual([`History truncated: the newest 1 of 2 commits were retained with patches; 1 older commits were omitted to stay within the ${MAX_OUTPUT}-byte history limit`]);
    expect(coverage.evidence[0]).toStartWith('Captured 1 from ');
    const whole = cso(repo, ['history', run.runId]);
    expect(whole.status).toBe(0);
    expect(whole.stdout.startsWith(MARKER)).toBe(true);
    const scoped = cso(repo, ['history', run.runId, 'new.ts']);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout.startsWith('commit ')).toBe(true);
    expect(scoped.stdout).toContain('diff --git a/new.ts b/new.ts');
  });
});

const dockerInstalled = TRUSTED_DIRECTORIES.some((directory) => fs.existsSync(path.join(directory, 'docker')));
describe.skipIf(process.platform === 'win32' || !dockerInstalled)('CSO Docker endpoint admission when realpath refuses sockets (#3248)', () => {
  let root = '';
  let socketPath = '';
  let server: net.Server;
  const realpath = fs.realpathSync;
  const refusing = ((candidate: fs.PathLike, ...rest: any[]) => {
    let socket = false;
    try {
      socket = fs.statSync(candidate).isSocket();
    } catch {}
    if (socket) {
      const error = new Error('EOPNOTSUPP: operation not supported on socket') as NodeJS.ErrnoException;
      error.code = 'EOPNOTSUPP';
      throw error;
    }
    return realpath(candidate, ...rest);
  }) as typeof fs.realpathSync;
  beforeAll(async () => {
    root = realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'cso-endpoint-')));
    socketPath = path.join(root, 'docker.sock');
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    (fs.realpathSync as any).mockRestore?.();
  });
  const admit = (host: string) => dockerEndpoint(root, { HOME: root, DOCKER_HOST: host });

  test('admits a socket reached through a symlinked directory and a symlinked leaf, pinned to its identity', async () => {
    const linkedDirectory = path.join(root, 'run'),
      leaf = path.join(root, 'colima.sock');
    fs.symlinkSync(root, linkedDirectory);
    fs.symlinkSync('docker.sock', leaf);
    const stub = spyOn(fs, 'realpathSync').mockImplementation(refusing);
    const identity = fs.statSync(socketPath);
    for (const host of [`unix://${socketPath}`, `unix://${path.join(linkedDirectory, 'colima.sock')}`]) {
      const endpoint = await admit(host);
      expect(endpoint).toMatchObject({ socket: socketPath, uri: `unix://${socketPath}`, device: identity.dev, inode: identity.ino });
    }
    expect(stub.mock.calls.some(([candidate]) => String(candidate) === socketPath)).toBe(true);
  });

  test('negative controls: non-sockets, dangling or looping links, and non-local URIs are still refused', async () => {
    spyOn(fs, 'realpathSync').mockImplementation(refusing);
    const file = path.join(root, 'plain.sock'),
      dangling = path.join(root, 'dangling.sock'),
      loopA = path.join(root, 'loop-a.sock'),
      loopB = path.join(root, 'loop-b.sock');
    fs.writeFileSync(file, '');
    fs.symlinkSync(path.join(root, 'missing.sock'), dangling);
    fs.symlinkSync(loopB, loopA);
    fs.symlinkSync(loopA, loopB);
    await expect(admit(`unix://${file}`)).rejects.toMatchObject({ code: 'ISOLATION_FAILED', message: 'Docker endpoint is not a local Unix socket' });
    for (const candidate of [dangling, loopA])
      await expect(admit(`unix://${candidate}`)).rejects.toMatchObject({ code: 'ISOLATION_FAILED', message: 'Pinned local Docker socket is unavailable' });
    await expect(admit(`unix://${root}/../${path.basename(root)}/docker.sock`)).rejects.toMatchObject({ code: 'ISOLATION_FAILED' });
    await expect(admit('tcp://127.0.0.1:2375')).rejects.toMatchObject({ code: 'ISOLATION_FAILED' });
  });
});
