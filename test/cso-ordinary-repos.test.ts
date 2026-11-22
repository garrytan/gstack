// Regressions for /cso on ordinary user repositories: an untracked nested Git
// repository (#3255 bug 1), a patch history over the 1 MiB bound (#3255 bug 2),
// a Docker socket that realpath refuses to open (#3248), and tracked symlinks,
// which are recorded by their target string and never followed (#4540).
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NESTED_REPOSITORY, OUTSIDE_AUDIT_PATHS, capture, historyMarker, symlinkTransformation } from '../lib/cso/snapshot';
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

  test.skipIf(process.platform === 'win32')('negative control: an untracked symlink to a directory is recorded as a link, never treated as a boundary or followed (#4540)', () => {
    const root = tmp(),
      repo = init(path.join(root, 'repo')),
      outside = path.join(root, 'outside');
    commit(repo, { 'README.md': 'outer\n' }, 'outer');
    nestedRepository(repo, 'inner', { 'f.txt': 'x\n' });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'host.txt'), `TOKEN=${CREDENTIAL_CANARY}\n`);
    fs.symlinkSync(outside, path.join(repo, 'escape'));
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = path.join(state, 'security', 'cso', run.repoId, run.runId),
      snapshot = readJson(path.join(dir, 'report.json')).coverage.find((item: any) => item.domain === 'snapshot-inputs');
    expect(snapshot.exclusions.sort()).toEqual([`escape: ${symlinkTransformation('escape', outside)}`, `inner: ${NESTED_REPOSITORY}`]);
    expect(snapshot.gaps).toEqual([]);
    for (const file of runFiles(dir)) expect(fs.readFileSync(file, 'utf8')).not.toContain(CREDENTIAL_CANARY);
    expect(fs.existsSync(path.join(dir, 'snapshot', 'escape'))).toBe(false);
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

describe.skipIf(process.platform === 'win32')('CSO on a repository that tracks symlinks (#4540)', () => {
  const OUTSIDE_CANARY = ['outside', 'payload', 'never', 'read'].join('-');
  const LINKS: Record<string, string> = {
    'CLAUDE.md': 'README.md',
    handbook: 'docs',
    'web/guide.md': '../docs/guide.md',
    'host-users': '/etc/passwd',
    'null-device': '/dev/null',
    escape: '../outside.txt',
    'docs/deep-escape': '../../outside.txt',
    'loop-a': 'loop-b',
    'loop-b': 'loop-a',
    dangling: 'missing.txt',
  };
  function linkedRepo(): { root: string; repo: string } {
    const root = tmp(),
      repo = init(path.join(root, 'repo'));
    fs.writeFileSync(path.join(root, 'outside.txt'), `${OUTSIDE_CANARY}\n`);
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.mkdirSync(path.join(repo, 'web'));
    commit(repo, { 'README.md': 'readme\n', 'docs/guide.md': 'guide\n', 'web/app.ts': 'export {};\n' }, 'base');
    for (const [name, target] of Object.entries(LINKS)) fs.symlinkSync(target, path.join(repo, name));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'links');
    return { root, repo };
  }

  test('start audits the repository and reports every tracked link by its target string', () => {
    const { repo } = linkedRepo();
    const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = path.join(state, 'security', 'cso', run.repoId, run.runId),
      report = readJson(path.join(dir, 'report.json')),
      snapshot = report.coverage.find((item: any) => item.domain === 'snapshot-inputs');
    expect(snapshot.exclusions.sort()).toEqual(
      Object.entries(LINKS)
        .map(([name, target]) => `${name}: ${symlinkTransformation(name, target)}`)
        .sort(),
    );
    expect(snapshot.gaps).toEqual([]);
    expect(symlinkTransformation('host-users', '/etc/passwd')).toContain('"/etc/passwd"');
    expect(symlinkTransformation('escape', '../outside.txt')).toContain('escapes the repository');
    expect(symlinkTransformation('handbook', 'docs')).toContain('"docs" inside the repository');
    const retained = runFiles(path.join(dir, 'snapshot')).map((file) => path.relative(path.join(dir, 'snapshot'), file)).sort();
    expect(retained).toEqual(['README.md', 'docs/guide.md', 'web/app.ts']);
    for (const file of runFiles(dir)) {
      const body = fs.readFileSync(file, 'utf8');
      expect(body).not.toContain(OUTSIDE_CANARY);
      expect(body).not.toContain('root:x:0:0');
    }
  });

  test('capture never opens, stats or resolves a link: only lstat and readlink touch it', async () => {
    const { repo } = linkedRepo(),
      linkPaths = Object.keys(LINKS).map((name) => path.join(repo, name)),
      touched: string[] = [],
      spies = (['statSync', 'realpathSync', 'openSync', 'readFileSync', 'opendirSync', 'existsSync', 'accessSync', 'readdirSync'] as const).map((name) => {
        const original = (fs as any)[name];
        return spyOn(fs, name as any).mockImplementation(((...args: any[]) => {
          if (typeof args[0] === 'string' || args[0] instanceof URL || Buffer.isBuffer(args[0])) touched.push(path.resolve(String(args[0])));
          return original(...args);
        }) as any);
      });
    let manifest: Awaited<ReturnType<typeof capture>>;
    try {
      manifest = await capture(repo, newRun(repo).dir);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(touched).toContain(path.join(repo, 'README.md'));
    expect(touched.filter((item) => linkPaths.some((link) => item === link || item.startsWith(`${link}${path.sep}`)))).toEqual([]);
    for (const [name, target] of Object.entries(LINKS)) {
      const entry = manifest.entries.find((item) => item.path === name);
      expect(entry).toMatchObject({
        originalHash: createHash('sha256').update(target).digest('hex'),
        bytes: Buffer.byteLength(target),
        transformation: symlinkTransformation(name, target),
      });
      expect(entry?.executionHash).toBeUndefined();
    }
  });

  test('a comparison base sees a retargeted link as changed and an unchanged link as unchanged', async () => {
    const { repo } = linkedRepo(),
      base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.unlinkSync(path.join(repo, 'handbook'));
    fs.symlinkSync('web', path.join(repo, 'handbook'));
    commit(repo, { 'web/app.ts': 'export const changed = 1;\n' }, 'change');
    const manifest = await capture(repo, newRun(repo).dir, base);
    expect(manifest.changedPaths).toEqual(['handbook', 'web/app.ts']);
  });

  test('negative controls: an untracked FIFO or socket is still refused', async () => {
    const { repo } = linkedRepo(),
      fifo = path.join(repo, 'request.pipe');
    expect(spawnSync('/usr/bin/mkfifo', [fifo], { timeout: 10_000 }).status).toBe(0);
    await expect(capture(repo, newRun(repo).dir)).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: 'Symlink or special source file: request.pipe' });
    fs.unlinkSync(fifo);
    const server = net.createServer(),
      socket = path.join(repo, 'web', 'app.sock');
    await new Promise<void>((done) => server.listen(socket, done));
    try {
      await expect(capture(repo, newRun(repo).dir)).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: 'Symlink or special source file: web/app.sock' });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test('--paths narrows the special-file walk: a FIFO outside the scope no longer blocks, one inside still does', async () => {
    const { repo } = linkedRepo();
    expect(spawnSync('/usr/bin/mkfifo', [path.join(repo, 'request.pipe')], { timeout: 10_000 }).status).toBe(0);
    const manifest = await capture(repo, newRun(repo).dir, undefined, undefined, {}, ['web']);
    expect(manifest.entries.find((item) => item.path === 'web/guide.md')?.transformation).toBe(symlinkTransformation('web/guide.md', '../docs/guide.md'));
    expect(manifest.entries.find((item) => item.path === 'host-users')?.transformation).toBe(OUTSIDE_AUDIT_PATHS);
    expect(spawnSync('/usr/bin/mkfifo', [path.join(repo, 'web', 'request.pipe')], { timeout: 10_000 }).status).toBe(0);
    await expect(capture(repo, newRun(repo).dir, undefined, undefined, {}, ['web'])).rejects.toMatchObject({ code: 'UNSAFE_PATH', message: 'Symlink or special source file: web/request.pipe' });
  });

  test('negative control: a link retargeted during capture fails as a snapshot race', async () => {
    const { repo } = linkedRepo(),
      link = path.join(repo, 'handbook'),
      original = fs.readlinkSync;
    let hits = 0;
    const counting = spyOn(fs, 'readlinkSync').mockImplementation(((candidate: any, options?: any) => {
      if (path.resolve(String(candidate)) === link) hits++;
      return original(candidate, options);
    }) as typeof fs.readlinkSync);
    try {
      await capture(repo, newRun(repo).dir);
    } finally {
      counting.mockRestore();
    }
    expect(hits).toBeGreaterThan(1);
    const last = hits;
    hits = 0;
    let swapped = false;
    const swapping = spyOn(fs, 'readlinkSync').mockImplementation(((candidate: any, options?: any) => {
      if (path.resolve(String(candidate)) === link && ++hits === last) {
        fs.unlinkSync(link);
        fs.symlinkSync('/etc', link);
        swapped = true;
      }
      return original(candidate, options);
    }) as typeof fs.readlinkSync);
    try {
      await expect(capture(repo, newRun(repo).dir)).rejects.toMatchObject({ code: 'SNAPSHOT_RACE', message: expect.stringContaining('handbook') });
    } finally {
      swapping.mockRestore();
    }
    expect(swapped).toBe(true);
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

test('a symlink transformation never carries an unredacted secret or raw control text from its target (#4540)', () => {
  const inside = symlinkTransformation('cfg/link', `keys/${CREDENTIAL_CANARY}`),
    crafted = symlinkTransformation('cfg/link', 'a\nexcluded: fake sentence');
  expect(inside).not.toContain(CREDENTIAL_CANARY);
  expect(inside).toContain('inside the repository');
  expect(crafted).not.toContain('\n');
  expect(crafted).toContain('"cfg/a\\nexcluded: fake sentence" inside the repository');
});

test.skipIf(process.platform === 'win32')('negative controls: nested and deeply nested links carrying password, api_key and token values never leak them into the report or manifest (#4540)', () => {
  const repo = init(path.join(tmp(), 'repo')),
    keys = [['pass', 'word'].join(''), ['api', 'key'].join('_'), ['to', 'ken'].join('')],
    values = keys.map((key) => `${key}=${['Xk9', 'qPz7Lm2Rt8Vw4Ny6', key.length].join('')}`),
    secrets = values.map((value) => value.split('=')[1]),
    links: [string, string][] = [];
  fs.mkdirSync(path.join(repo, 'cfg', 'a', 'b', 'c', 'd'), { recursive: true });
  commit(repo, { 'README.md': 'readme\n' }, 'base');
  for (const dir of ['cfg', 'cfg/a/b/c/d'])
    keys.forEach((key, index) => {
      links.push([`${dir}/${key}-link`, values[index]], [`${dir}/${key}-up`, `../${values[index]}`]);
    });
  for (const [name, target] of links) {
    fs.symlinkSync(target, path.join(repo, name));
    const text = symlinkTransformation(name, target);
    for (const secret of secrets) expect(text).not.toContain(secret);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'links');
  const started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
  expect(started.stderr).toBe('');
  expect(started.status).toBe(0);
  const run = JSON.parse(started.stdout),
    dir = path.join(state, 'security', 'cso', run.repoId, run.runId),
    snapshot = readJson(path.join(dir, 'report.json')).coverage.find((item: any) => item.domain === 'snapshot-inputs');
  expect(snapshot.exclusions).toHaveLength(links.length);
  for (const file of ['report.json', 'snapshot.json']) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const secret of secrets) expect(body).not.toContain(secret);
  }
});

test('fail closed: a link target that matches a secret pattern, whole or per segment, is withheld with its resolved path (#4540)', () => {
  const value = ['Xk9', 'qPz7Lm2Rt8Vw4Ny6'].join(''),
    halves = [['c3Hd6Ty8Qp2Z', 'x7Lm4Nb9'].join(''), ['Vw1Rk5Js0Gh3', 'Fd8Ks2Pq'].join('')],
    cases: [string, string, string[]][] = [
      ['cfg/db', ['postgres://alice:', value, '@localhost/db'].join(''), [value]],
      ['cfg/aws', [['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_'), '=', halves[0], '/', halves[1]].join(''), halves],
      ['cfg/a/b/up', ['../', ['pass', 'word'].join(''), '=', value].join(''), [value]],
    ];
  for (const [name, target, secrets] of cases) {
    const text = symlinkTransformation(name, target);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain('a target withheld because it matches a secret pattern');
    expect(text).not.toContain('resolves lexically');
  }
});
