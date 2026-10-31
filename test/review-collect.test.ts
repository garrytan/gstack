import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectCommit, collectLive, CONSUMER_SCAN_CAP, CONSUMER_SCAN_TIMEOUT_MS, consumerScanTimeoutMs, grepConsumers, loadRegistryAt, scanConsumers } from '../lib/review-collect';
import { depthOfCommitInput } from '../lib/review-depth';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const lines = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const REGISTRY = JSON.stringify({ entries: [{ id: 'docs', command: 'bun run gen', outputs: ['*/SKILL.md'] }, { id: 'manual', command: null, outputs: ['src/hand.ts'] }] });

function repo(baseFiles: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-collect-'));
  dirs.push(dir);
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const write = (files: Record<string, string | Buffer | null>) => { for (const [p, text] of Object.entries(files)) { const f = path.join(dir, p); if (text === null) { fs.rmSync(f); continue; } fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  write({ 'README.md': '# x\n', ...baseFiles }); git('add', '-A'); git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feat');
  const commit = (files: Record<string, string | Buffer | null>) => { write(files); git('add', '-A'); git('commit', '-qm', 'feat'); return git('rev-parse', 'HEAD'); };
  return { dir, git, write, commit, baseSha };
}

describe('collectCommit: git objects only', () => {
  // Value: protects=only a bare version bump in package.json is release metadata; fails_when=a version line that also
  // carries scripts counts as stamp-only (docs class, light); seam=none
  test('a package.json version line that also carries scripts is not stamp-only; a bare version bump is', () => {
    const r = repo({ 'package.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n' });
    const bare = r.commit({ 'package.json': '{\n  "name": "x",\n  "version": "1.0.1"\n}\n' });
    expect(collectCommit(r.dir, r.baseSha, bare).stampOnly).toEqual(['package.json']);
    const riding = r.commit({ 'package.json': '{\n  "name": "x",\n  "version": "1.0.2", "scripts": { "postinstall": "node x.js" }\n}\n' });
    expect(collectCommit(r.dir, r.baseSha, riding).stampOnly).toEqual([]);
  });
  test('a registered glob output is excluded, a command:null entry is not, and a .tmpl edit counts once', () => {
    const r = repo({ '.gstack/generated.json': REGISTRY, 'ship/SKILL.md.tmpl': 'a\n', 'ship/SKILL.md': 'a\n' });
    const head = r.commit({ 'ship/SKILL.md.tmpl': 'a\nb\nc\n', 'ship/SKILL.md': lines(120), 'src/hand.ts': lines(5) });
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.errors).toEqual([]);
    expect(c.registry).toEqual({ sha: r.baseSha, outputs: ['*/SKILL.md'] });
    const d = depthOfCommitInput({ ...c, gateTagged: 0 });
    expect([d.depth, d.runtimeLines]).toEqual(['light', 2 + 5]);
  });
  test('a head-only registry entry never excludes: the registry is the base commit\'s', () => {
    const r = repo({ 'src/keep.ts': lines(1) });
    const head = r.commit({ '.gstack/generated.json': JSON.stringify({ entries: [{ id: 'gen', command: 'gen', outputs: ['src/gen.ts'] }] }), 'src/gen.ts': lines(60) });
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.registry).toEqual({ sha: r.baseSha, outputs: [] });
    const d = depthOfCommitInput({ ...c, gateTagged: 0 });
    expect(d.runtimeLines).toBeGreaterThanOrEqual(60);
    expect(d.depth).toBe('full');
  });
  test('a rename into src/ counts the new path as runtime', () => {
    const r = repo({ 'notes/a.txt': lines(30) });
    fs.mkdirSync(path.join(r.dir, 'src'));
    r.git('mv', 'notes/a.txt', 'src/a.ts');
    r.git('commit', '-qm', 'mv');
    const c = collectCommit(r.dir, r.baseSha, r.git('rev-parse', 'HEAD'));
    expect(c.deleted).toEqual(['notes/a.txt']);
    expect(c.perPath.find(e => e.path === 'src/a.ts')).toEqual({ path: 'src/a.ts', lines: 30, binary: false });
    expect(depthOfCommitInput({ ...c, gateTagged: 0 })).toMatchObject({ depth: 'light', runtimeLines: 30 });
  });
  test('a binary code-class path is an error (full), never 0 lines; a deleted test is full', () => {
    const r = repo({ 'test/old.test.ts': 'x\n' });
    const head = r.commit({ 'lib/x.wasm': Buffer.from([0, 97, 115, 109, 0, 1, 2]) });
    const d = depthOfCommitInput({ ...collectCommit(r.dir, r.baseSha, head), gateTagged: 0 });
    expect(d.depth).toBe('full');
    expect(d.errors).toEqual([expect.objectContaining({ code: 'binary_code_path', input: 'lib/x.wasm' })]);
    const t = repo({ 'test/old.test.ts': 'x\n', 'test/keep.test.ts': 'x\n' });
    const del = t.commit({ 'test/old.test.ts': null });
    const deleted = depthOfCommitInput({ ...collectCommit(t.dir, t.baseSha, del), gateTagged: 0 });
    expect([deleted.depth, deleted.runtimeLines, deleted.errors]).toEqual(['full', 0, []]);
  });
  test('an invalid base registry is an error with its result code; an unresolvable sha is unavailable', () => {
    const r = repo({ '.gstack/generated.json': '{"entries": [{"id": "x"}]}' });
    const head = r.commit({ 'src/a.ts': lines(3) });
    const d = depthOfCommitInput({ ...collectCommit(r.dir, r.baseSha, head), gateTagged: 0 });
    expect(d.depth).toBe('full');
    expect(d.codes).toEqual(['REGEN_REGISTRY_INVALID']);
    expect(d.errors[0]).toMatchObject({ code: 'registry_invalid', result: 'REGEN_REGISTRY_INVALID' });
    expect(d.errors[0]!.repair).toContain('gstack-regen validate');
    expect(loadRegistryAt(r.dir, 'f'.repeat(40)).error?.code).toBe('registry_unavailable');
    const missing = collectCommit(r.dir, 'f'.repeat(40), head);
    expect(missing.errors.map(e => e.code)).toContain('numstat_failed');
    expect(depthOfCommitInput({ ...missing, gateTagged: 0 }).depth).toBe('full');
  });
  test('from a checkout at another HEAD with a dirty tree it equals the clean result at head', () => {
    const r = repo({ '.gstack/generated.json': REGISTRY, 'src/a.ts': lines(2), 'ship/SKILL.md': 'a\n', 'autoplan/SKILL.md.tmpl': 'x\n' });
    const head = r.commit({ 'src/a.ts': lines(40), 'ship/SKILL.md': lines(9), 'docs/b.md': '# b\n12% faster\n', 'autoplan/notes.md': 'n\n', 'package.json': '{"version":"1.0.1"}\n' });
    const clean = collectCommit(r.dir, r.baseSha, head);
    r.git('checkout', '-q', r.baseSha);
    r.write({ 'src/a.ts': lines(500, 'dirty'), 'src/untracked.ts': lines(80), 'autoplan/SKILL.md.tmpl': null });
    const dirty = collectCommit(r.dir, r.baseSha, head);
    expect(dirty).toEqual(clean);
    expect(depthOfCommitInput({ ...dirty, gateTagged: 0 })).toEqual(depthOfCommitInput({ ...clean, gateTagged: 0 }));
    expect(clean.root).toEqual(['autoplan', 'ship']);
    expect(clean.added['docs/b.md']).toEqual(['# b', '12% faster']);
  });
});

describe('collectLive: the working tree', () => {
  test('tracked uncommitted edits and untracked files count per path; scratch under .gstack/tmp/ does not', () => {
    const r = repo({ 'src/a.ts': lines(1) });
    r.commit({ 'docs/a.md': '# a\n' });
    r.write({ 'src/a.ts': lines(11), 'src/new.ts': lines(20), '.gstack/tmp/x.ts': lines(500) });
    const c = collectLive(r.dir, 'main');
    expect(c.errors).toEqual([]);
    expect(c.untracked).toEqual(['src/new.ts']);
    expect(c.perPath.find(e => e.path === 'src/new.ts')).toEqual({ path: 'src/new.ts', lines: 20, binary: false });
    expect(c.paths).toEqual(['docs/a.md', 'src/a.ts', 'src/new.ts']);
    expect(depthOfCommitInput({ ...c, gateTagged: 0 })).toMatchObject({ depth: 'light', runtimeLines: 20 + 10 });
  });
  test('no merge base is a collector error the CLI refuses on', () => {
    const r = repo({});
    expect(collectLive(r.dir, 'no-such-branch').errors.map(e => e.code)).toEqual(['numstat_failed']);
  });
});

describe('GSTA-167 part 4a: which data files code names (scanConsumers)', () => {
  const rows = Array.from({ length: 80 }, (_, i) => `{"i":${i}}`).join('\n') + '\n';
  // Value: protects=a data file a code file names keeps review, one nothing names drops to docs, and markdown mentions do not
  //   count; fails_when=the consumer search misses a literal reader or counts prose; seam=git grep at head and merge base
  test('a JSON code names stays code; one only markdown names is docs', () => {
    const r = repo({ 'src/load.ts': "export const rows = () => require('./data/rows.json');\n", 'docs/wiki.md': 'see wiki/post/data.json\n' });
    const head = r.commit({ 'data/rows.json': rows, 'wiki/post/data.json': rows });
    const c = collectCommit(r.dir, r.baseSha, head);
    expect([c.consumed, c.errors]).toEqual([['data/rows.json'], []]);
    expect(depthOfCommitInput({ ...c, gateTagged: 0 })).toMatchObject({ class: 'code', runtimeLines: 80 });
  });
  test('a consumer the change deletes still counts (merge base); a data file named only by another data file follows it', () => {
    const r = repo({ 'src/old.ts': "read('rules.json')\n", 'src/manifest.ts': "load('index.json')\n" });
    const head = r.commit({ 'src/old.ts': null, 'assets/rules.json': rows, 'assets/index.json': '["post.json"]\n', 'assets/post.json': rows, 'orphan/list.json': '["lone.json"]\n', 'orphan/lone.json': rows });
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.consumed).toEqual(['assets/index.json', 'assets/post.json', 'assets/rules.json']);
  });
  test('a deleted data file head code still names keeps the deletion guarded (gate class)', () => {
    const r = repo({ 'src/a.ts': "read('table.csv')\n", 'data/table.csv': 'a,b\n' });
    const head = r.commit({ 'data/table.csv': null, 'src/a.ts': "read('table.csv'); // moved\n" });
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.consumed).toEqual(['data/table.csv']);
    expect(depthOfCommitInput({ ...c, gateTagged: 0 }).class).toBe('gate');
  });
  // Value: protects=the live plan (gstack-review-plan) and the queue recompute (collectCommit) agree on a committed tree, and
  //   the live plan sees an untracked consumer; fails_when=a receipt and the queue disagree on depth; seam=collectLive vs collectCommit
  test('collectLive and collectCommit compute the same consumed set on a clean tree; live counts an untracked consumer', () => {
    const r = repo({ 'src/load.ts': "read('rows.json')\n" });
    const head = r.commit({ 'data/rows.json': rows, 'wiki/post/data.json': rows });
    expect(collectLive(r.dir, 'main').consumed).toEqual(collectCommit(r.dir, r.baseSha, head).consumed);
    r.write({ 'src/new.ts': "read('post/data.json')\n" });
    expect(collectLive(r.dir, 'main').consumed).toEqual(['data/rows.json', 'wiki/post/data.json']);
  });
  // Value: protects=the scan reads git grep the same way under any user grep config, and a failed grep keeps every data file
  //   code; fails_when=grep.lineNumber/grep.column shift the NUL fields so no consumer matches, or a grep failure drops data to
  //   docs silently; seam=git grep output and exit status
  test('grep.lineNumber, grep.column and color.grep in git config do not change which files count as consumers', () => {
    const r = repo({ 'src/load.ts': "export const rows = () => require('./data/rows.json');\n" });
    r.git('config', 'grep.lineNumber', 'true'); r.git('config', 'grep.column', 'true'); r.git('config', 'color.grep', 'always');
    const head = r.commit({ 'data/rows.json': rows, 'docs/notes.md': 'see rows.json and orphan.json\n', 'data/orphan.json': rows });
    expect([collectCommit(r.dir, r.baseSha, head).consumed, collectLive(r.dir, 'main').consumed]).toEqual([['data/rows.json'], ['data/rows.json']]);
  });
  test('a git grep failure keeps every data file code and records consumer_scan_failed', () => {
    const r = repo({ 'src/load.ts': "read('rows.json')\n" });
    const head = r.commit({ 'data/rows.json': rows });
    r.git('config', 'grep.lineNumber', 'not-a-bool');
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.consumed).toBe('all');
    expect(c.errors.map(e => e.code)).toEqual(['consumer_scan_failed']);
    expect(depthOfCommitInput({ ...c, gateTagged: 0 }).class).toBe('code');
  });
  test('past CONSUMER_SCAN_CAP data paths every one stays code', () => {
    const r = repo({});
    const head = r.commit(Object.fromEntries(Array.from({ length: CONSUMER_SCAN_CAP + 1 }, (_, i) => [`d/${i}.json`, '{}\n'])));
    const c = collectCommit(r.dir, r.baseSha, head);
    expect(c.consumed).toBe('all');
    expect(depthOfCommitInput({ ...c, gateTagged: 0 }).class).toBe('code');
  }, 60_000);
});

describe('GST-544: the consumer scan reads only files that can match, under one overall deadline', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `{"i":${i}}`).join('\n') + '\n';
  const blob = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' rows.json post.json\n')]);
  const mixed = () => {
    const r = repo({ 'src/old.ts': "read('rules.json')\n", 'src/manifest.ts': "load('index.json')\n", 'docs/wiki.md': 'see orphan.json and rows.json\n', 'bench/blob.bin': blob, 'bench/notes.ts': 'no data names here, only .json and .csv\n' });
    const head = r.commit({ 'src/old.ts': null, 'src/load.ts': "require('./data/rows.json'); require('my rows.json')\n", 'data/rows.json': rows, 'data/my rows.json': rows, 'assets/rules.json': rows, 'assets/index.json': '["post.json"]\n', 'assets/post.json': rows, 'wiki/orphan.json': rows, 'wiki/live.csv': 'a\n', 'bench/overlap.ts': "'xrows.jsonl' 'ab.csv' 'b.csv'\n" });
    r.write({ 'src/untracked.ts': "read('live.csv')\n" });
    return { ...r, head };
  };
  const patterns = ['rows.json', 'my rows.json', 'rules.json', 'index.json', 'post.json', 'orphan.json', 'live.csv', 'b.csv'];
  const wholeTree = (dir: string, at: string) => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', 'grep', '-I', '-F', '-o', '--null', '--no-line-number', '--no-column', '--no-color', ...patterns.flatMap(b => ['-e', b]), ...(at ? [at, '--'] : ['--untracked', '--'])], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect([0, 1]).toContain(r.status);
    return r.stdout.split('\n').filter(Boolean).sort();
  };
  // Value: protects=the narrowed scan prints exactly the lines one whole-tree git grep prints, at a commit, at the merge base
  //   and in the working tree with untracked files; fails_when=the extension pre-pass or the pathspecs drop a consumer;
  //   seam=git grep output, compared with the single grep the scan ran before GST-544
  test('grepConsumers prints the same lines as one whole-tree git grep at each rev and in the working tree', () => {
    const r = mixed();
    for (const at of [r.baseSha, r.head, '']) {
      const got = grepConsumers(r.dir, patterns, at, () => true, Date.now() + 10_000);
      expect(Array.isArray(got)).toBe(true);
      expect((got as string[]).filter(Boolean).sort()).toEqual(wholeTree(r.dir, at));
    }
    expect(wholeTree(r.dir, '').length).toBeGreaterThan(5);
  });
  test('the pathspec chunks give the same lines when every file is its own git grep call', () => {
    const r = mixed();
    const got = grepConsumers(r.dir, patterns, '', () => true, Date.now() + 10_000, 1);
    expect((got as string[]).filter(Boolean).sort()).toEqual(wholeTree(r.dir, ''));
    expect(new Set(wholeTree(r.dir, '').map(l => l.split('\0')[0])).size).toBeGreaterThan(3);
  });
  test('consumed sets on the mixed fixture: chains through a data manifest, a live untracked consumer, docs ignored', () => {
    const r = mixed();
    const commit = collectCommit(r.dir, r.baseSha, r.head);
    expect([commit.consumed, commit.errors]).toEqual([['assets/index.json', 'assets/post.json', 'assets/rules.json', 'data/my rows.json', 'data/rows.json'], []]);
    const live = collectLive(r.dir, 'main');
    expect([live.consumed, live.errors]).toEqual([['assets/index.json', 'assets/post.json', 'assets/rules.json', 'data/my rows.json', 'data/rows.json', 'wiki/live.csv'], []]);
  });
  // Value: protects=a scan that runs out of time keeps every data file code and says it timed out, with the deadline;
  //   fails_when=a slow grep drops data to docs or reads as a git error; seam=the spawnSync timeout
  test('a scan past its deadline fails closed with consumer_scan_failed naming the timeout and the deadline', () => {
    const r = mixed();
    const errors: Parameters<typeof scanConsumers>[5] = [];
    expect(scanConsumers(r.dir, ['data/rows.json', 'wiki/orphan.json'], [r.head], true, r.dir, errors, 1)).toBe('all');
    expect(errors).toEqual([expect.objectContaining({ code: 'consumer_scan_failed', detail: expect.stringMatching(/timed out.*0\.001 s deadline.*GSTACK_CONSUMER_SCAN_TIMEOUT_MS/) })]);
    const saved = process.env.GSTACK_CONSUMER_SCAN_TIMEOUT_MS;
    process.env.GSTACK_CONSUMER_SCAN_TIMEOUT_MS = '1';
    try {
      const c = collectCommit(r.dir, r.baseSha, r.head);
      expect(c.consumed).toBe('all');
      expect(c.errors.map(e => [e.code, /timed out/.test(e.detail)])).toEqual([['consumer_scan_failed', true]]);
    } finally {
      if (saved === undefined) delete process.env.GSTACK_CONSUMER_SCAN_TIMEOUT_MS; else process.env.GSTACK_CONSUMER_SCAN_TIMEOUT_MS = saved;
    }
    r.git('config', 'grep.lineNumber', 'not-a-bool');
    const failed: Parameters<typeof scanConsumers>[5] = [];
    expect(scanConsumers(r.dir, ['data/rows.json'], [r.head], false, r.dir, failed, CONSUMER_SCAN_TIMEOUT_MS)).toBe('all');
    expect(failed[0]!.detail).toMatch(new RegExp(`^git grep exited \\d+: .*\\(deadline ${CONSUMER_SCAN_TIMEOUT_MS / 1000} s\\)$`));
  });
  const withEnv = (name: string, value: string, fn: () => void) => {
    const saved = process.env[name];
    process.env[name] = value;
    try { fn(); } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
  };
  // Value: protects=an inherited GIT_LITERAL_PATHSPECS (git --literal-pathspecs exports it to children) cannot empty the narrowed
  //   search and drop data to docs; a fractional override cannot crash spawnSync; fails_when=the pathspecs use magic the variable
  //   turns off, or the timeout is not an integer; seam=the process environment
  test('an inherited GIT_LITERAL_PATHSPECS keeps the same lines; a fractional timeout is whole milliseconds; a spawn error is named', () => {
    const r = mixed();
    withEnv('GIT_LITERAL_PATHSPECS', '1', () => {
      for (const at of [r.head, '']) expect((grepConsumers(r.dir, patterns, at, () => true, Date.now() + 10_000) as string[]).filter(Boolean).sort()).toEqual(wholeTree(r.dir, at));
    });
    withEnv('GSTACK_CONSUMER_SCAN_TIMEOUT_MS', '1500.5', () => expect(consumerScanTimeoutMs()).toBe(1500));
    const errors: Parameters<typeof scanConsumers>[5] = [];
    withEnv('PATH', path.join(r.dir, 'no-bin'), () => expect(scanConsumers(r.dir, ['data/rows.json'], [r.head], false, r.dir, errors, 10_000)).toBe('all'));
    expect(errors[0]!.detail).toMatch(/^git grep exited null: .*ENOENT/);
  });
  // Value: protects=a consumer whose name is not valid UTF-8 still counts, and a file with a million references does not crash the
  //   planner; fails_when=the -l pass hands back a mangled name as a pathspec, or the matches are spread into one call;
  //   seam=git tree objects and git grep output size
  test('a consumer named with invalid UTF-8 bytes still counts; a million matches in one file are all returned', () => {
    const r = repo({ 'src/keep.ts': 'x\n' });
    const head = r.commit({ 'data/results.json': rows });
    const run = (args: string[], input?: Buffer) => { const x = spawnSync('git', args, { cwd: r.dir, input, timeout: 10_000 }); if (x.status !== 0) throw new Error(`git ${args.join(' ')}: ${x.stderr}`); return x.stdout as Buffer; };
    const sha = run(['hash-object', '-w', '--stdin'], Buffer.from("read('results.json')\n")).toString().trim();
    const entry = Buffer.concat([Buffer.from(`100644 blob ${sha}\tloader`), Buffer.from([0xff]), Buffer.from('.py\0')]);
    const tree = run(['mktree', '-z'], Buffer.concat([run(['ls-tree', '-z', head]), entry])).toString().trim();
    const named = run(['commit-tree', tree, '-p', head, '-m', 'consumer'], Buffer.alloc(0)).toString().trim();
    expect(collectCommit(r.dir, r.baseSha, named).consumed).toEqual(['data/results.json']);
    r.write({ 'src/many.ts': 'rows.json\n'.repeat(1_100_000) });
    const got = grepConsumers(r.dir, ['rows.json'], '', () => true, Date.now() + 30_000);
    expect(Array.isArray(got) && got.filter(Boolean).length).toBe(1_100_000);
  }, 30_000);
  // Value: protects=a slow scan ends in its own fail-closed consumer_scan_failed, not in the parent killing gstack-review-plan;
  //   fails_when=the scan deadline reaches the timeout the dispatch and preflight callers give the whole plan; seam=caller source
  test('the default scan deadline leaves a minute of the plan timeout its callers set', () => {
    const callers = ['bin/gstack-review-dispatch', 'lib/ship-preflight.ts'].map(f => fs.readFileSync(path.join(import.meta.dir, '..', f), 'utf8'));
    const limits = callers.flatMap(src => [...src.matchAll(/gstack-review-plan'[^\n]*?(?:timeout: |\], )(\d[\d_]+)/g)].map(m => Number(m[1]!.replace(/_/g, ''))));
    expect(limits.length).toBeGreaterThanOrEqual(2);
    expect(CONSUMER_SCAN_TIMEOUT_MS).toBeLessThanOrEqual(Math.min(...limits) - 60_000);
  });
});
