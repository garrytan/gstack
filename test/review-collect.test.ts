import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectCommit, collectLive, loadRegistryAt } from '../lib/review-collect';
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
