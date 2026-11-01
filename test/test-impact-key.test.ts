/**
 * GST-167 PR 2: lib/test-impact/key.ts keys a free test file at a git tree from its trace and the static graph, and
 * refuses a key whenever it cannot prove the inputs. Every case runs the real functions on a fixture repo
 * (test/helpers/pregate-fixture.ts); traces come from strace text through parseStrace, and one Linux case runs real strace.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { ALWAYS_RUN_PATH } from '../lib/pregate/lane-selection';
import { computeKeys, MAX_HOPS, type KeyResult } from '../lib/test-impact/key';
import { TRACE_VERSION, envDigests, parseStrace, readTrace, tracePath, type TraceRecord } from '../lib/test-impact/trace';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(ROOT, 'scripts', 'test-impact.ts');
const NOW = Date.parse('2026-11-01T12:00:00Z');
const RUNTIME = { platform: 'linux', arch: 'x64', bun: '1.4.4' };
const NODE_TEST = "const test = require('node:test');\n";
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function fixture(baseFiles: Record<string, string> = {}): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gstack-test-impact-', baseFiles });
  repos.push(repo);
  return repo;
}

/** Write `test`'s trace from strace lines that open `reads`, list `lists` and add `extra` raw calls, through parseStrace. */
function traceFrom(repo: FixtureRepo, test: string, opts: { reads?: string[]; lists?: Record<string, string[]>; extra?: string[]; tracedAt?: string; env?: Record<string, string | undefined> } = {}): string {
  const w = repo.work;
  const lines = [test, ...(opts.reads ?? [])].map(p => `100 openat(AT_FDCWD<${w}>, "${w}/${p}", O_RDONLY|O_CLOEXEC) = 3<${w}/${p}>`);
  for (const [dir, names] of Object.entries(opts.lists ?? {})) lines.push(`100 getdents64(4<${w}/${dir}>, [${['.', '..', ...names].map(n => `{d_ino=1, d_off=1, d_reclen=24, d_type=DT_REG, d_name="${n}"}`).join(', ')}], 32768) = 96`);
  lines.push(...(opts.extra ?? []));
  const dir = path.join(repo.root, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const set = parseStrace(lines.join('\n'), { repoRoot: w, home: repo.home, tmpDir: path.join(repo.root, 'run'), sharedTmp: [] });
  const record: TraceRecord = { version: TRACE_VERSION, test, tracedAt: opts.tracedAt ?? '2026-11-01T00:00:00Z', commit: null, exitCode: 0, runtime: RUNTIME, env: envDigests(opts.env ?? {}), ...set };
  fs.writeFileSync(tracePath(dir, test), JSON.stringify(record));
  return dir;
}

function keyAt(repo: FixtureRepo, tree: string, test: string, base: string | null = 'main', env: Record<string, string | undefined> = {}, now = NOW): KeyResult {
  return computeKeys({ repoRoot: repo.work, tree, base, tests: [test], traceDir: path.join(repo.root, 'traces'), now, runtime: RUNTIME, env }).results[0]!;
}

function cli(repo: FixtureRepo, args: string[]) {
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), CLI, ...args], { cwd: repo.work, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...repo.env } });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('test-impact key: what changes it', () => {
  test('a lib file the test reads by a computed path changes the key; an unrelated file does not; without the trace the graph alone misses it', () => {
    const t = 'test/data-read.test.js';
    const repo = fixture({ 'lib/data.txt': 'one\n', [t]: `${NODE_TEST}test('reads', () => require('fs').readFileSync(require('path').join(__dirname, '..', ['lib', 'data' + '.txt'].join('/'))));\n` });
    traceFrom(repo, t, { reads: ['lib/data.txt'] });
    const before = keyAt(repo, 'main', t);
    expect(before.eligible).toBe(true);
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'traced', path: 'lib/data.txt' }));
    commit(repo, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
    expect(keyAt(repo, 'HEAD', t).key).toBe(before.key);
    commit(repo, { 'lib/data.txt': 'two\n' });
    expect(keyAt(repo, 'HEAD', t).key).not.toBe(before.key);

    traceFrom(repo, t);
    expect(keyAt(repo, 'HEAD', t).key).toBe(keyAt(repo, 'main', t).key);
  });

  test('a tsconfig path alias change changes the key, and the alias target is in the graph closure', () => {
    const t = 'test/alias.test.ts';
    const tsconfig = (target: string) => JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': [target] } } });
    const repo = fixture({ 'tsconfig.json': tsconfig('lib/*'), [t]: "import { add } from '@lib/util';\nimport { test } from 'bun:test';\ntest('adds', () => add(1, 2));\n" });
    traceFrom(repo, t);
    const before = keyAt(repo, 'main', t);
    expect(before.eligible).toBe(true);
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'graph', path: 'lib/util.js' }));
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'global', path: 'tsconfig.json' }));
    commit(repo, { 'tsconfig.json': tsconfig('src/*') });
    expect(keyAt(repo, 'HEAD', t).key).not.toBe(before.key);
  });

  test('a file added under a directory the test listed changes the key', () => {
    const t = 'test/listing.test.js';
    const repo = fixture({ 'test/data/a.txt': 'a\n', 'test/data/b.txt': 'b\n', [t]: `${NODE_TEST}test('lists', () => require('fs').readdirSync(require('path').join(__dirname, 'da' + 'ta')));\n` });
    traceFrom(repo, t, { lists: { 'test/data': ['a.txt', 'b.txt'] } });
    const before = keyAt(repo, 'main', t);
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'listed', path: 'test/data' }));
    commit(repo, { 'docs/README.md': '# docs\n\nmore\n' });
    expect(keyAt(repo, 'HEAD', t).key).toBe(before.key);
    commit(repo, { 'test/data/c.txt': 'c\n' });
    expect(keyAt(repo, 'HEAD', t).key).not.toBe(before.key);
  });

  test('the bytes of an executable outside the repo that the test ran are in the key', () => {
    const repo = fixture();
    const tool = path.join(repo.root, 'tools', 'mytool');
    fs.mkdirSync(path.dirname(tool), { recursive: true });
    fs.writeFileSync(tool, 'v1');
    traceFrom(repo, 'test/util.test.js', { extra: [`100 execve("${tool}", ["mytool"], []) = 0`] });
    const before = keyAt(repo, 'main', 'test/util.test.js');
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'tool', path: tool }));
    fs.writeFileSync(tool, 'v2');
    const fresh = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `const k = await import(${JSON.stringify(path.join(ROOT, 'lib/test-impact/key.ts'))}); console.log(k.computeKeys({ repoRoot: ${JSON.stringify(repo.work)}, tree: 'main', base: 'main', tests: ['test/util.test.js'], traceDir: ${JSON.stringify(path.join(repo.root, 'traces'))}, now: ${NOW}, runtime: ${JSON.stringify(RUNTIME)}, env: {} }).results[0].key)`], { encoding: 'utf8', timeout: 60_000 });
    expect(fresh.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.stdout.trim()).not.toBe(before.key);
  });

  test('a spawned bin that sources a sibling script: the traced sibling is in the key', () => {
    const t = 'test/tool2.test.js';
    const repo = fixture({ 'bin/tool2': '#!/bin/bash\nsource "$(dirname "$0")/tool2-lib.sh"\ngreet\n', 'bin/tool2-lib.sh': 'greet() { echo hi; }\n', [t]: `${NODE_TEST}test('greets', () => require('child_process').spawnSync('bin/tool2', { timeout: 5000 }));\n` });
    const w = repo.work;
    traceFrom(repo, t, { extra: [`100 execve("${w}/bin/tool2", ["bin/tool2"], []) = 0`, '100 chdir("bin") = 0', `100 openat(AT_FDCWD<${w}/bin>, "./tool2-lib.sh", O_RDONLY) = 3<${w}/bin/tool2-lib.sh>`] });
    const before = keyAt(repo, 'main', t);
    expect(before.inputs).toContainEqual(expect.objectContaining({ kind: 'traced', path: 'bin/tool2-lib.sh' }));
    commit(repo, { 'bin/tool2-lib.sh': 'greet() { echo hello; }\n' });
    expect(keyAt(repo, 'HEAD', t).key).not.toBe(before.key);
  });
});

describe('test-impact key: ineligible', () => {
  const chain = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/c${i}.js`, i + 1 < n ? `module.exports = require('./c${i + 1}.js');\n` : 'module.exports = 1;\n']));

  test(`an import chain deeper than ${MAX_HOPS} hops is ineligible; exactly ${MAX_HOPS} is not`, () => {
    const repo = fixture({ ...chain(MAX_HOPS + 1), 'test/deep.test.js': `${NODE_TEST}require('../lib/c0.js');\ntest('deep', () => {});\n`, 'test/edge.test.js': `${NODE_TEST}require('../lib/c1.js');\ntest('edge', () => {});\n` });
    traceFrom(repo, 'test/deep.test.js');
    traceFrom(repo, 'test/edge.test.js');
    const deep = keyAt(repo, 'main', 'test/deep.test.js');
    expect(deep.eligible).toBe(false);
    expect(deep.key).toBeNull();
    expect(deep.reasons.join('\n')).toContain(`import graph deeper than ${MAX_HOPS} hops: test/deep.test.js → lib/c0.js → `);
    expect(deep.reasons.join('\n')).toContain(`lib/c${MAX_HOPS}.js`);
    const edge = keyAt(repo, 'main', 'test/edge.test.js');
    expect(edge.reasons).toEqual([]);
    expect(edge.inputs).toContainEqual(expect.objectContaining({ kind: 'graph', path: `lib/c${MAX_HOPS}.js` }));
  });

  test('a read of the real HOME (an env-dependent file) or a network connect is ineligible', () => {
    const repo = fixture();
    traceFrom(repo, 'test/util.test.js', { extra: [`100 openat(AT_FDCWD<${repo.work}>, "${repo.home}/.gitconfig", O_RDONLY) = 3<${repo.home}/.gitconfig>`] });
    traceFrom(repo, 'test/retry.test.js', { extra: ['100 connect(5<socket:[1]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("140.82.112.3")}, 16) = -1 EINPROGRESS (Operation now in progress)'] });
    traceFrom(repo, 'test/config-read.test.js', { reads: ['lib/config.json'] });
    expect(keyAt(repo, 'main', 'test/util.test.js').reasons).toEqual([`reads the real HOME (${repo.home}/.gitconfig)`]);
    expect(keyAt(repo, 'main', 'test/retry.test.js').reasons).toEqual(['network: connect 140.82.112.3:443']);
    expect(keyAt(repo, 'main', 'test/config-read.test.js').eligible).toBe(true);
  });

  test('a successful read of a path the tree does not track (a build output) is ineligible; a probe or a file the run created is not', () => {
    const repo = fixture();
    const w = repo.work;
    traceFrom(repo, 'test/util.test.js', { reads: ['dist/tool'] });
    traceFrom(repo, 'test/retry.test.js', { extra: [`100 access("${w}/dist/tool", F_OK) = -1 ENOENT (No such file or directory)`, `100 openat(AT_FDCWD<${w}>, "${w}/out.json", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3<${w}/out.json>`, `100 openat(AT_FDCWD<${w}>, "${w}/out.json", O_RDONLY) = 3<${w}/out.json>`] });
    expect(keyAt(repo, 'main', 'test/util.test.js').reasons).toEqual(['reads paths main does not track (dist/tool)']);
    expect(keyAt(repo, 'main', 'test/retry.test.js').reasons).toEqual([]);
  });

  test('no trace, a stale trace and a failed traced run are ineligible', () => {
    const repo = fixture();
    traceFrom(repo, 'test/retry.test.js', { tracedAt: '2026-10-20T00:00:00Z' });
    const dir = traceFrom(repo, 'test/config-read.test.js');
    const failed = { ...readTrace(dir, 'test/config-read.test.js')!, exitCode: 1 };
    fs.writeFileSync(tracePath(dir, 'test/config-read.test.js'), JSON.stringify(failed));
    expect(keyAt(repo, 'main', 'test/util.test.js').reasons).toEqual(['no trace']);
    expect(keyAt(repo, 'main', 'test/retry.test.js').reasons[0]).toStartWith('stale trace (traced 2026-10-20T00:00:00Z');
    expect(keyAt(repo, 'main', 'test/config-read.test.js').reasons).toEqual(['the traced run failed (exit 1)']);
  });

  test('a future-dated trace, or one made under other allowlisted env values or another runtime, is ineligible', () => {
    const repo = fixture();
    traceFrom(repo, 'test/util.test.js', { tracedAt: '2026-11-02T00:00:00Z' });
    traceFrom(repo, 'test/retry.test.js', { env: { NODE_ENV: 'development' } });
    expect(keyAt(repo, 'main', 'test/util.test.js').reasons[0]).toStartWith('stale trace (traced 2026-11-02T00:00:00Z');
    expect(keyAt(repo, 'main', 'test/util.test.js', 'main', {}, Date.parse('2026-11-02T00:01:00Z')).reasons).toEqual([]);
    expect(keyAt(repo, 'main', 'test/retry.test.js', 'main', { NODE_ENV: 'production' }).reasons).toEqual(['traced under other values of NODE_ENV']);
    expect(keyAt(repo, 'main', 'test/retry.test.js', 'main', { NODE_ENV: 'development' }).reasons).toEqual([]);
    const other = computeKeys({ repoRoot: repo.work, tree: 'main', base: 'main', tests: ['test/retry.test.js'], traceDir: path.join(repo.root, 'traces'), now: NOW, runtime: { ...RUNTIME, bun: '1.5.0' }, env: { NODE_ENV: 'development' } }).results[0]!;
    expect(other.reasons).toEqual(['traced on another runtime (bun 1.4.4 vs 1.5.0)']);
  });

  test('a tree that edits key code makes every test ineligible', () => {
    const repo = fixture({ 'lib/test-impact/key.ts': 'export const v = 1;\n' });
    traceFrom(repo, 'test/util.test.js');
    traceFrom(repo, 'test/retry.test.js');
    expect(keyAt(repo, 'main', 'test/util.test.js').eligible).toBe(true);
    commit(repo, { 'lib/test-impact/key.ts': 'export const v = 2;\n' });
    const report = computeKeys({ repoRoot: repo.work, tree: 'HEAD', base: 'main', tests: ['test/util.test.js', 'test/retry.test.js'], traceDir: path.join(repo.root, 'traces'), now: NOW, runtime: RUNTIME, env: {} });
    expect(report.keyCodeEdited).toEqual(['lib/test-impact/key.ts']);
    for (const r of report.results) expect(r.reasons).toEqual(['the tree edits key code (lib/test-impact/key.ts); every test runs']);
  });

  test('GST-233: a branch that deletes a glob from the always-run list still gets the base list', () => {
    const repo = fixture({ [ALWAYS_RUN_PATH]: JSON.stringify({ tests: ['test/util.test.js'] }) });
    traceFrom(repo, 'test/util.test.js');
    commit(repo, { [ALWAYS_RUN_PATH]: JSON.stringify({ tests: [] }) });
    expect(keyAt(repo, 'HEAD', 'test/util.test.js').reasons).toEqual([`always_run (${ALWAYS_RUN_PATH} at main)`]);
    expect(keyAt(repo, 'HEAD', 'test/util.test.js', null).eligible).toBe(true);
  });
});

describe('scripts/test-impact.ts', () => {
  test('key --base runs the base ref\'s key code, not this checkout\'s, and refuses when the base has none', () => {
    const repo = fixture();
    traceFrom(repo, 'test/util.test.js');
    const none = cli(repo, ['key', '--tree', 'HEAD', '--base', 'main', '--traces', path.join(repo.root, 'traces'), 'test/util.test.js']);
    expect(none.status).toBe(0);
    expect(none.out).toContain('INELIGIBLE test/util.test.js: main has no lib/test-impact/key.ts; nothing is reusable until the key code lands there');

    const stub = "export const runtimeManifest = () => ({});\nexport function computeKeys(o: { tree: string; base: string; tests: string[] }) {\n  return { tree: o.tree, base: o.base, keyCodeEdited: [], alwaysRunGlobs: { base: [], tree: [] }, results: o.tests.map(test => ({ test, eligible: false, reasons: ['stub key code from the base ref'], key: null, inputs: [], tracedAt: null })) };\n}\n";
    repo.git('checkout', '-q', 'main');
    commit(repo, { 'lib/test-impact/key.ts': stub }, 'base key code');
    repo.git('checkout', '-q', 'feature');
    const trusted = cli(repo, ['key', '--tree', 'HEAD', '--base', 'main', '--traces', path.join(repo.root, 'traces'), 'test/util.test.js']);
    expect(trusted.out).toContain('key code from main:lib/test-impact/key.ts');
    expect(trusted.out).toContain('INELIGIBLE test/util.test.js: stub key code from the base ref');

    traceFrom(repo, 'test/util.test.js', { env: { ...process.env, ...repo.env } });
    const local = cli(repo, ['explain', '--tree', 'HEAD', '--traces', path.join(repo.root, 'traces'), 'test/util.test.js']);
    expect(local.status).toBe(0);
    expect(local.out).toMatch(/KEY test\/util\.test\.js [0-9a-f]{12}/);
    expect(local.out).toContain('lib/util.js');
  });

  const hasStrace = process.platform === 'linux' && spawnSync('strace', ['-V'], { timeout: 10_000 }).status === 0;
  test.if(hasStrace)('trace (real strace): a spawned bin that sources a sibling records the sibling, and editing it changes the key', () => {
    const t = 'test/tool2.test.ts';
    const repo = fixture({
      'bin/tool2': '#!/bin/bash\ncd "$(dirname "$0")"\nsource ./tool2-lib.sh\ngreet\n',
      'bin/tool2-lib.sh': 'greet() { echo hi; }\n',
      [t]: "import { expect, test } from 'bun:test';\nimport { spawnSync } from 'node:child_process';\nimport * as path from 'node:path';\ntest('greets', () => expect(spawnSync(path.join(import.meta.dir, '..', 'bin', 'tool2'), { encoding: 'utf8', timeout: 10000 }).stdout.trim()).toBe('hi'));\n",
    });
    fs.chmodSync(path.join(repo.work, 'bin/tool2'), 0o755);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'exec bit');
    const traces = path.join(repo.root, 'traces');
    const r = cli(repo, ['trace', '--out', traces, t]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toContain(`traced ${t}: exit 0`);
    const rec = readTrace(traces, t)!;
    expect(rec.paths).toEqual(expect.arrayContaining([t, 'bin/tool2', 'bin/tool2-lib.sh']));
    expect(rec.ineligible).toEqual([]);
    const env = { ...process.env, ...repo.env };
    const runtime = { platform: process.platform, arch: process.arch, bun: Bun.version };
    const keyNow = (tree: string) => computeKeys({ repoRoot: repo.work, tree, base: 'main', tests: [t], traceDir: traces, runtime, env }).results[0]!;
    const before = keyNow('HEAD');
    expect(before.reasons).toEqual([]);
    commit(repo, { 'bin/tool2-lib.sh': 'greet() { echo hi; }\n# edited\n' });
    expect(keyNow('HEAD').key).not.toBe(before.key);
  });
});
