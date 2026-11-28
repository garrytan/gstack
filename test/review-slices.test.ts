/**
 * Over-ceiling reader diffs reviewed in slices (GST-4019, docs/review-policy.md#review-ceiling): planSlices' packing, the pass
 * manifest's R#i/k readers and their briefs, the coverage verify recomputes, and the refusals that stay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_DIFF_MAX_BYTES, type DiffUnit } from '../lib/review-exclude';
import { SLICE_CAP, planSlices } from '../lib/review-slices';
import type { Manifest } from '../lib/review-pass';
import { quarantinedIds, readLedger } from '../lib/review-ledger';
import { quarantineStage } from '../lib/review-sweep';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';
import { bin, host, repo as harnessRepo, runPass } from './helpers/review-pass-harness';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const POSIX = process.platform !== 'win32';
const MB = 1_000_000;

describe('planSlices', () => {
  const u = (p: string | string[], bytes: number): DiffUnit => ({ paths: Array.isArray(p) ? p : [p], bytes });
  const covered = (plan: ReturnType<typeof planSlices>) => (plan.ok ? plan.slices.flatMap(s => s.paths).sort() : []);

  test('a 5 MB diff across 3 folders plans one slice per folder, every file in exactly one slice', () => {
    const units = ['alpha', 'beta', 'gamma'].flatMap(d => Array.from({ length: 10 }, (_, k) => u(`${d}/m${k}.ts`, 170_000)));
    const plan = planSlices(units);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.slices.length).toBeLessThanOrEqual(SLICE_CAP);
    expect(plan.slices.map(s => [...new Set(s.paths.map(p => p.split('/')[0]))])).toEqual([['alpha'], ['beta'], ['gamma']]);
    expect(covered(plan)).toEqual(units.flatMap(x => x.paths).sort());
    for (const s of plan.slices) expect(s.bytes).toBeLessThanOrEqual(REVIEW_DIFF_MAX_BYTES);
  });

  test('a folder over the ceiling splits by its subfolders first, then its files in path order', () => {
    const units = [...['a', 'b', 'c'].flatMap(s => Array.from({ length: 4 }, (_, k) => u(`big/${s}/f${k}.json`, 400_000))), u('big/z.md', 300_000), u('lib/x.ts', 100_000)];
    const plan = planSlices(units);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.slices.map(s => s.paths)).toEqual([
      [...[0, 1, 2, 3].map(k => `big/a/f${k}.json`)],
      [...[0, 1, 2, 3].map(k => `big/b/f${k}.json`)],
      [...[0, 1, 2, 3].map(k => `big/c/f${k}.json`), 'big/z.md', 'lib/x.ts'],
    ]);
    expect(planSlices([...units].reverse())).toEqual(plan);
  });

  test('both sides of a rename, and a file beside the folder that replaces it, always share a slice', () => {
    const plan = planSlices([u(['old/x.ts', 'new/x.ts'], 1_500_000), u('new/y.ts', 900_000), u('old/z.ts', 900_000), u('p', 1_000_000), u('p/q.ts', 900_000)]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const home = (p: string) => plan.slices.findIndex(s => s.paths.includes(p));
    expect(home('old/x.ts')).toBe(home('new/x.ts'));
    expect(home('p')).toBe(home('p/q.ts'));
  });

  test('one file over the ceiling refuses and names the file; a diff needing 9 slices refuses with its count', () => {
    expect(planSlices([u('src/a.ts', 10), u('big/huge.ts', 2_100_000)])).toEqual({ ok: false, reason: 'file', file: 'big/huge.ts', bytes: 2_100_000 });
    expect(planSlices(Array.from({ length: 9 }, (_, k) => u(`d${k}/f.json`, 1_100_000)))).toEqual({ ok: false, reason: 'cap', needed: 9, cap: SLICE_CAP });
    expect(planSlices(Array.from({ length: 8 }, (_, k) => u(`d${k}/f.json`, 1_100_000))).ok).toBe(true);
  });
});

/** A source file of about `kb` kilobytes (one ~75-byte line each). */
const src = (tag: string, kb: number) => Array.from({ length: Math.ceil(kb * 1000 / 76) }, (_, i) => `export const v_${i} = ${i}; // ${tag.replace(/[^a-z0-9]/gi, '_').slice(0, 20).padEnd(20, '_')} ${'x'.repeat(30)}`).join('\n') + '\n';
function fixture(files: Record<string, string | null>, baseFiles: Record<string, string> = {}): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gstack-slices-', baseFiles });
  repos.push(repo);
  commit(repo, files);
  return repo;
}
const runPassBin = (repo: FixtureRepo, extra: string[] = []) => {
  const out = path.join(repo.root, 'pass');
  const r = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1', ...extra]);
  const file = path.join(out, 'pass-manifest.json');
  return { r, out, file, m: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest : null };
};
const mergeBase = (repo: FixtureRepo) => repo.git('merge-base', 'origin/main', 'HEAD');
/** What every git diff command in a brief shows, as NUL-separated --name-only paths run in the fixture. */
function briefNames(repo: FixtureRepo, brief: string, mb: string): string[][] {
  return [...brief.matchAll(/`((?:DIFF_BASE=[0-9a-f]+ && )?git diff [^`]*)`/g)].map(m => {
    const cmd = m[1]!.replace(/^DIFF_BASE=[0-9a-f]+ && /, '').replace(/^git diff( --stat| --name-status)?/, 'git diff --name-only -z --no-renames');
    const r = spawnSync('bash', ['-c', cmd], { cwd: repo.work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...repo.env, DIFF_BASE: mb } });
    expect({ cmd, status: r.status, err: r.stderr }).toMatchObject({ status: 0 });
    return r.stdout.split('\0').filter(Boolean);
  });
}
const fullNames = (repo: FixtureRepo, mb: string) => repo.git('-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', mb).split('\0').filter(Boolean).sort();
/** Send each rendered reader its brief verbatim and collect a clean reply, then judge the empty merge. */
function collectAll(repo: FixtureRepo, m: Manifest, skip: string[] = []) {
  const tree = `REVIEWED_TREE: ${repo.git('rev-parse', 'HEAD^{tree}')} ${fs.realpathSync(repo.work)}`;
  for (const r of m.readers.filter(x => x.state === 'rendered' && !skip.includes(x.reader))) {
    const role = ['--role', r.role!, ...(r.name ? ['--name', r.name] : []), ...(r.slice ? ['--slice', `${r.slice.index}/${r.slice.total}`] : [])];
    expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', m.ledger, ...role, '--sent', r.file!]).status).toBe(0);
    const reply = path.join(m.out, `${r.reader.replace(/[^a-z0-9]/gi, '_')}.reply.txt`);
    fs.writeFileSync(reply, `${tree}\nREVIEW_VERDICT: blocking=0\nNO FINDINGS\n`);
    const c = runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', m.ledger, ...role, '--output', reply, '--merged', m.merged]);
    expect({ status: c.status, out: c.out }).toMatchObject({ status: 0 });
  }
  expect(runBin(repo, 'gstack-review-dispatch', ['judge', '--ledger', m.ledger, '--merged', m.merged, '--judged', path.join(m.out, 'judged.jsonl')]).status).toBe(0);
}
const verifyOut = (repo: FixtureRepo, m: Manifest) => runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', m.ledger]);
/** Rewrite one reader's render events in the ledger, or with no edit drop every event of that reader. */
function editRenders(m: Manifest, reader: string, edit: ((e: Record<string, any>) => Record<string, any>) | null) {
  const lines = fs.readFileSync(m.ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const kept = lines.flatMap(e => (e.reader !== reader ? [e] : !edit ? [] : e.event === 'rendered' ? [edit(e)] : [e]));
  fs.writeFileSync(m.ledger, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('a reader over the ceiling is reviewed in slices', () => {
  const three = () => fixture(Object.fromEntries(['alpha', 'beta', 'gamma'].flatMap(d => Array.from({ length: 6 }, (_, k) => [`${d}/m${k}.ts`, src(`${d}${k}`, 290)]))));

  // Value: protects=a 5 MB kept diff is reviewed in full by slice readers that share no file; fails_when=a slice command shows
  //   another slice's file, a file is in no slice, or verify does not replay coverage; why_new=GST-4019 (harness-evals#619 at
  //   2.27 MB after exclusions stopped at REVIEW_DIFF_TOO_LARGE); seam=gstack-review-dispatch pass, the rendered briefs run by git, verify
  test.skipIf(!POSIX)('a 5 MB diff across 3 folders: every brief command reads only its slice, and verify replays full coverage', () => {
    const repo = three();
    const { r, m } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    const sliced = m!.readers.filter(x => x.slice);
    expect(sliced.map(x => x.reader)).toEqual(['specialist-batched#1/3', 'specialist-batched#2/3', 'specialist-batched#3/3', 'adversarial-native#1/3', 'adversarial-native#2/3', 'adversarial-native#3/3']);
    const mb = mergeBase(repo);
    const all = fullNames(repo, mb);
    expect(all.length).toBe(18);
    const seen = new Map<string, string>();
    for (const x of sliced.filter(y => y.state === 'rendered')) {
      const brief = fs.readFileSync(x.file!, 'utf8');
      expect(brief).toContain(`This review is slice ${x.slice!.index} of 3.`);
      const names = briefNames(repo, brief, mb);
      expect(names.length).toBeGreaterThan(0);
      for (const n of new Set(names.flat())) { expect(seen.get(n)).toBeUndefined(); seen.set(n, x.reader); }
      expect(x.slice!.bytes).toBeLessThanOrEqual(REVIEW_DIFF_MAX_BYTES);
    }
    expect([...seen.keys()].sort()).toEqual(all);
    collectAll(repo, m!);
    const v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched MATCH slices=3 files=18 kept=[0-9a-f]{12}$/m);
    expect(v.out).toContain('VERIFY: clean briefs=3 outputs=3');
  }, 300_000);

  // Value: protects=verify refuses a slice set that is incomplete or no longer partitions the reader's files; fails_when=a missing,
  //   uncollected, overlapping or dropping slice set verifies clean; why_new=GST-4019 zero-drop check; seam=verify on the ledger
  //   and git at the reviewed tree; no_claim=what a reader did with its brief
  test.skipIf(!POSIX)('verify refuses a missing slice, an uncollected slice, an overlap and a dropped file', () => {
    const repo = three();
    const { m } = runPassBin(repo);
    const ledger = fs.readFileSync(m!.ledger, 'utf8');
    collectAll(repo, m!, ['specialist-batched#2/3']);
    let v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched NOT_COLLECTED slices=3 open=specialist-batched#2\/3$/m);
    expect(v.out).toContain('VERIFY: dirty');
    const reset = () => { fs.writeFileSync(m!.ledger, ledger); fs.rmSync(m!.merged, { force: true }); fs.rmSync(path.join(m!.out, 'judged.jsonl'), { force: true }); };
    reset();
    collectAll(repo, m!);
    expect(verifyOut(repo, m!).out).toContain('VERIFY: clean');
    const done = fs.readFileSync(m!.ledger, 'utf8');
    editRenders(m!, 'specialist-batched#2/3', null);
    v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched MISSING slices=3 missing=2\/3$/m);
    expect(v.out).toContain('VERIFY: dirty');
    fs.writeFileSync(m!.ledger, done);
    const alpha = m!.readers.find(x => x.reader === 'specialist-batched#1/3')!.slice!.exclude.slice(3);
    editRenders(m!, 'specialist-batched#2/3', e => ({ ...e, slice: { ...e.slice, exclude: `${e.slice.exclude} ${alpha}` } }));
    v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched CHANGED slices=3 .*overlaps=1 /m);
    expect(v.out).toContain('VERIFY: dirty');
    fs.writeFileSync(m!.ledger, done);
    editRenders(m!, 'specialist-batched#3/3', e => ({ ...e, slice: { ...e.slice, exclude: "-- ':(top,literal)gamma/m0.ts'" } }));
    v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched CHANGED slices=3 .*dropped=5 paths=/m);
    expect(v.out).toContain('VERIFY: dirty');
  }, 300_000);

  // Value: protects=the one diff slicing cannot help still refuses and names the file; fails_when=a 2.1 MB single file is cut,
  //   dropped or sliced; why_new=GST-4019; seam=gstack-review-dispatch pass
  test.skipIf(!POSIX)('a single 2.1 MB file still refuses with REVIEW_DIFF_TOO_LARGE naming the file', () => {
    const repo = fixture({ 'lib/run.ts': src('run', 5), 'big/huge.ts': src('huge', 2_100) });
    const { r, m } = runPassBin(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(m).toBeNull();
    expect(r.err).toContain('slices=refused(file="big/huge.ts":');
    expect(r.err).toContain('"big/huge.ts" alone is ');
    expect(r.err).toEndWith('nothing was written (REVIEW_DIFF_TOO_LARGE)\n');
  }, 300_000);

  // Value: protects=a diff past the slice cap refuses honestly with the count it needed; fails_when=it is sliced into more than
  //   8 readers or some slices are dropped; why_new=GST-4019; seam=gstack-review-dispatch pass
  test.skipIf(!POSIX)('a diff needing 9 slices still refuses, naming the slices it needs and the cap', () => {
    const repo = fixture(Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`d${k}/f.ts`, src(`d${k}`, 1_100)])));
    const { r, m } = runPassBin(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(m).toBeNull();
    expect(r.err).toContain('slices=refused(needs=9 cap=8)');
    expect(r.err).toContain('the diff needs 9 slices of at most 2000000 bytes and a reader is split into at most 8');
  }, 300_000);

  // Value: protects=a large pure-deletion PR plans, renders and verifies like any other; fails_when=deleted files are left out
  //   of every slice or a slice command shows nothing for them; why_new=gstack #4837 and #4833 (92 deleted files); seam=pass and verify
  test.skipIf(!POSIX)('92 deleted files (the #4837 and #4833 shape) plan, render and verify cleanly', () => {
    const gone = Object.fromEntries(Array.from({ length: 92 }, (_, k) => [`${['bin', 'lib', 'test', 'docs'][k % 4]}/old${k}.ts`, src(`old${k}`, 30)]));
    const repo = fixture(Object.fromEntries(Object.keys(gone).map(f => [f, null])), gone);
    const { r, m } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    const mb = mergeBase(repo);
    expect(fullNames(repo, mb)).toEqual(Object.keys(gone).sort());
    const sliced = m!.readers.filter(x => x.slice && x.state === 'rendered');
    expect(sliced.length).toBeGreaterThan(1);
    const read = sliced.flatMap(x => [...new Set(briefNames(repo, fs.readFileSync(x.file!, 'utf8'), mb).flat())]);
    expect(read.sort()).toEqual(Object.keys(gone).sort());
    collectAll(repo, m!);
    const v = verifyOut(repo, m!);
    expect(v.out).toMatch(/^SLICE specialist-batched MATCH slices=\d files=92 /m);
    expect(v.out).toContain('VERIFY: clean');
  }, 300_000);

  // Value: protects=paths holding glob, quote, space, tab, backslash and non-ASCII characters land in exactly one slice and
  //   each slice's commands show them byte for byte; fails_when=a bracket path is read as a glob, a quoted diff header is
  //   parsed with its quotes, or a path is dropped; why_new=GST-4019 (#4847's bracket-glob finding); seam=pass, git and verify
  test.skipIf(!POSIX)('bracket and special-character paths match identically in every slice', () => {
    const odd = ['odd/[abc]/x*?.ts', "odd/a b/it's \"q\".ts", 'odd/\u00fc/\u00f1.ts', 'odd/tab\there.ts', 'odd/back\\slash.ts', 'odd/[abc].ts', 'odd/a/plain.ts'];
    const repo = fixture(Object.fromEntries(odd.map((f, k) => [f, src(`odd${k}`, 700)])));
    const { r, m } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    const mb = mergeBase(repo);
    expect(fullNames(repo, mb)).toEqual([...odd].sort());
    const sliced = m!.readers.filter(x => x.slice && x.state === 'rendered');
    expect(sliced.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const x of sliced) seen.push(...new Set(briefNames(repo, fs.readFileSync(x.file!, 'utf8'), mb).flat()));
    expect(seen.sort()).toEqual([...odd].sort());
    collectAll(repo, m!);
    expect(verifyOut(repo, m!).out).toContain('VERIFY: clean');
  }, 300_000);

  // Value: protects=under review_exclude_paths each slice reads its part of the kept selection, kept files through its own keep
  //   command, and no excluded file; fails_when=a slice command shows an excluded file, a kept file under the pattern is in no
  //   slice, or the keep command repeats another slice's file; why_new=GST-4019 (harness-evals#619 is over the ceiling after
  //   exclusions); seam=pass on a real repository with a base policy, the briefs run by git, verify
  test.skipIf(!POSIX)('under review_exclude_paths the slices partition the kept selection, kept files included', () => {
    const keep = Array.from({ length: 3 }, (_, k) => `results/b/keep${k}.json`);
    const files: Record<string, string> = {
      'src1/reader.ts': `export const files = ${JSON.stringify(keep)};\n`,
      ...Object.fromEntries(keep.map((f, k) => [f, JSON.stringify({ rows: src(`keep${k}`, 200).split('\n') }) + '\n'])),
      ...Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`results/a/x${k}.json`, JSON.stringify({ rows: src(`x${k}`, 500).split('\n') }) + '\n'])),
      ...Object.fromEntries(['src1', 'src2'].flatMap(d => Array.from({ length: 4 }, (_, k) => [`${d}/m${k}.ts`, src(`${d}${k}`, 280)]))),
    };
    const repo = fixture(files, { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: ['results/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' });
    const { r, m } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    const mb = mergeBase(repo);
    const selection = Object.keys(files).filter(f => !f.startsWith('results/a/')).sort();
    const sliced = m!.readers.filter(x => x.slice && x.state === 'rendered');
    expect(sliced.length).toBeGreaterThan(1);
    const seen = new Map<string, string>();
    for (const x of sliced) for (const n of new Set(briefNames(repo, fs.readFileSync(x.file!, 'utf8'), mb).flat())) { expect(seen.get(n)).toBeUndefined(); seen.set(n, x.reader); }
    expect([...seen.keys()].sort()).toEqual(selection);
    expect(sliced.some(x => x.keep?.length)).toBe(true);
    collectAll(repo, m!);
    const v = verifyOut(repo, m!);
    expect(v.out).toMatch(new RegExp(`^SLICE specialist-batched MATCH slices=\\d files=${selection.length} `, 'm'));
    expect(v.out).toContain('VERIFY: clean');
  }, 300_000);

  // Value: protects=a PR at or under the ceiling gets exactly today's readers and briefs; fails_when=a normal pass gains a slice
  //   reader, a slice field or slice wording; why_new=GST-4019 (zero change under the ceiling); seam=gstack-review-dispatch pass and verify
  test.skipIf(!POSIX)('a diff under the ceiling stays unsliced', () => {
    const repo = fixture({ 'alpha/a.ts': src('a', 300), 'beta/b.ts': src('b', 300) });
    const { r, m } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    expect(m!.readers.some(x => x.slice || x.reader.includes('#'))).toBe(false);
    for (const x of m!.readers.filter(y => y.file)) expect(fs.readFileSync(x.file!, 'utf8')).not.toContain('This review is slice');
    expect(fs.readFileSync(m!.ledger, 'utf8')).not.toContain('"slice"');
    collectAll(repo, m!);
    const v = verifyOut(repo, m!);
    expect(v.out).not.toContain('SLICE ');
    expect(v.out).toContain('VERIFY: clean');
  }, 300_000);
});

describe('a sliced reader is still one reviewer (R51)', () => {
  // Value: protects=slicing never multiplies review-log rows, start tokens or rounds; fails_when=Step 11 takes one
  //   adversarial-review start per native slice, or a slice's reply is collected under the wrong reader; why_new=GST-4019;
  //   seam=lib/capy-review-pass.js on a fake host with real bins, then verify
  test.skipIf(!POSIX)('Step 11 takes one start per voice however many slices its native reader has, and the pass verifies clean', async () => {
    const { dir, env } = harnessRepo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 }); if (r.status !== 0) throw new Error(r.stderr); };
    for (const d of ['alpha', 'beta', 'gamma']) for (let k = 0; k < 6; k++) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, `m${k}.ts`), src(`${d}${k}`, 290)); }
    sh('git add -A && git commit -qm big');
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env);
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.2-sol' } };
    const base = { base: 'main', out, pass: 'x9p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, { ...base, logStart: ['review'] })).toContain('NEXT: judge (Phase 4)');
    const voices = await runPass(h, { ...base, stage: 'voices', models });
    expect(voices).toContain('NEXT: judge the voices');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    const native = m.readers.filter(r => r.role === 'adversarial-native');
    expect(native.map(r => r.reader)).toEqual(['adversarial-native#1/3', 'adversarial-native#2/3', 'adversarial-native#3/3']);
    expect(m.readers.filter(r => r.role === 'outside-voice').map(r => r.reader)).toEqual(['outside-voice']);
    expect(Object.keys(m.log_starts ?? {}).sort()).toEqual(['pass:review', 'voices:adversarial-review', 'voices:adversarial-review#2']);
    expect(m.readers.every(r => r.state === 'collected')).toBe(true);
    fs.writeFileSync(path.join(out, 'judged.jsonl'), '');
    expect(bin(dir, env, ['judge', '--ledger', m.ledger, '--merged', m.merged, '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.stdout).toMatch(/^SLICE adversarial-native MATCH slices=3 /m);
    expect(v.stdout).toContain('VERIFY: clean');
  }, 300_000);
});

describe.skipIf(!POSIX)('slice guards', () => {
  const three = () => fixture(Object.fromEntries(['alpha', 'beta', 'gamma'].flatMap(d => Array.from({ length: 6 }, (_, k) => [`${d}/m${k}.ts`, src(`${d}${k}`, 290)]))));

  // Value: protects=stage never renders slice briefs from a plan whose files moved; fails_when=a file added after pass reaches
  //   no slice brief and the stage renders anyway; why_new=GST-4019 review (slicesMoved had no test); seam=pass, then stage
  test.skipIf(!POSIX)('stage refuses slice readers whose files changed after pass planned them', () => {
    const repo = three();
    const { m, file } = runPassBin(repo);
    expect(m!.readers.filter(x => x.role === 'adversarial-native' && x.state === 'planned').length).toBe(3);
    commit(repo, { 'alpha/new.ts': src('new', 10) });
    const s = runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']);
    expect(s.status).not.toBe(EXIT.ok);
    expect(s.err).toContain('planned its slices');
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    expect(after.readers.filter(x => x.role === 'adversarial-native' && x.state === 'rendered')).toEqual([]);
  }, 300_000);

  // Value: protects=the targeted-reader record a receipt reads is done only when every slice was collected and its slice set is
  //   clean, and counts every slice's findings; fails_when=a sliced targeted reader records done with a slice uncollected, with
  //   a dirty SLICE row (GSTA-876 follow-up on #4853), or findings miss a slice;
  //   why_new=GST-4019 review (targetedRecord's sliced path had no test); seam=pass, stage voices, collect, verify --targeted-out
  test.skipIf(!POSIX)('a sliced targeted reader records done only when every slice is collected, with findings summed', () => {
    const repo = fixture(Object.fromEntries(['billing', 'beta', 'gamma'].flatMap(d => Array.from({ length: 6 }, (_, k) => [`${d}/m${k}.ts`, `export const charge_limit_usd = ${k};\n` + src(`${d}${k}`, 290)]))));
    const { m, file } = runPassBin(repo);
    expect(runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']).status).toBe(EXIT.ok);
    const staged = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    const targeted = staged.readers.filter(x => x.role === 'targeted');
    expect(targeted.length).toBeGreaterThan(1);
    expect(targeted.every(x => x.slice && x.state === 'rendered')).toBe(true);
    const last = targeted.at(-1)!.reader;
    const tree = `REVIEWED_TREE: ${repo.git('rev-parse', 'HEAD^{tree}')} ${fs.realpathSync(repo.work)}`;
    const finding = JSON.stringify({ severity: 'INFORMATIONAL', confidence: 6, path: 'billing/m0.ts', line: 1, category: 'money', summary: 'a note' });
    const send = (x: (typeof targeted)[number], reply: string) => {
      const role = ['--role', x.role!, ...(x.name ? ['--name', x.name] : []), '--slice', `${x.slice!.index}/${x.slice!.total}`];
      expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', staged.ledger, ...role, '--sent', x.file!]).status).toBe(0);
      const f = path.join(staged.out, `${x.reader.replace(/[^a-z0-9]/gi, '_')}.reply.txt`);
      fs.writeFileSync(f, `${tree}\nREVIEW_VERDICT: blocking=0\n${reply}\n`);
      expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', staged.ledger, ...role, '--output', f, '--merged', staged.merged]).status).toBe(0);
    };
    for (const x of targeted.slice(1, -1)) send(x, 'NO FINDINGS');
    send(targeted[0]!, finding);
    const record = () => runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', staged.ledger]).out.match(/^TARGETED_RECORD: .*$/m)?.[0];
    expect(record()).toContain('status=failed');
    send(targeted.find(x => x.reader === last)!, finding);
    expect(record()).toMatch(/status=done findings=2 /);
    const events = fs.readFileSync(staged.ledger, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, any>);
    const tampered = events.filter(e => e.event === 'rendered' && e.reader === last).at(-1)!;
    tampered.slice.files_sha256 = '0'.repeat(64);
    fs.writeFileSync(staged.ledger, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const dirty = runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', staged.ledger]).out;
    expect(dirty).toMatch(/^SLICE targeted CHANGED /m);
    expect(dirty.match(/^TARGETED_RECORD: .*$/m)?.[0]).toMatch(/status=failed findings=2 /);
  }, 300_000);

  // Value: protects=a malformed --slice is a usage error before any ledger write; fails_when=3/2, 1/9, 0/1 or x is accepted;
  //   why_new=GST-4019 review (the --slice usage path had no test); seam=gstack-review-dispatch collect and sent
  test.each(['3/2', '1/9', '0/1', 'x'])('--slice %s is a usage error for collect and sent', s => {
    const repo = fixture({ 'a.ts': 'export const a = 1;\n' });
    const ledger = path.join(repo.root, 'ledger.jsonl');
    for (const cmd of [['collect', '--output', ledger, '--merged', ledger], ['sent', '--sent', ledger]]) {
      const r = runBin(repo, 'gstack-review-dispatch', [cmd[0]!, '--ledger', ledger, '--role', 'specialist', '--name', 'testing', '--slice', s, ...cmd.slice(1)]);
      expect(r.status).toBe(EXIT.usage);
      expect(r.err).toContain('--slice takes');
    }
    expect(fs.existsSync(ledger)).toBe(false);
  });
});


describe.skipIf(!POSIX)('slice readers in the fetch quarantine and the native test summary', () => {
  const reply = (repo: FixtureRepo, m: Manifest, x: Manifest['readers'][number], body: string) => {
    const role = ['--role', x.role!, ...(x.name ? ['--name', x.name] : []), '--slice', `${x.slice!.index}/${x.slice!.total}`];
    expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', m.ledger, ...role, '--sent', x.file!]).status).toBe(0);
    const f = path.join(m.out, `${x.reader.replace(/[^a-z0-9]/gi, '_')}.reply.txt`);
    fs.writeFileSync(f, `REVIEWED_TREE: ${repo.git('rev-parse', 'HEAD^{tree}')} ${fs.realpathSync(repo.work)}\nREVIEW_VERDICT: blocking=0\n${body}\n`);
    expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', m.ledger, ...role, '--output', f, '--merged', m.merged]).status).toBe(0);
  };

  // Value: protects=a slice reader that broke the fetch rule has its findings removed and its quarantine recorded under its
  //   own key; fails_when=quarantineStage looks a slice reader up without its slice and removes nothing; why_new=GST-4019
  //   final review (lib/review-sweep.ts:259); seam=pass, sent and collect, then quarantineStage and the ledger
  test('a quarantined slice reader loses its findings and its quarantine names the slice', () => {
    const repo = fixture(Object.fromEntries(['alpha', 'beta', 'gamma'].flatMap(d => Array.from({ length: 6 }, (_, k) => [`${d}/m${k}.ts`, src(`${d}${k}`, 290)]))));
    const { m } = runPassBin(repo);
    const first = m!.readers.find(x => x.reader === 'specialist-batched#1/3')!;
    reply(repo, m!, first, JSON.stringify({ severity: 'INFORMATIONAL', confidence: 6, path: 'alpha/m0.ts', line: 1, category: 'testing', summary: 'a note' }));
    const ids = () => fs.readFileSync(m!.merged, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string; reader: string });
    const mine = ids().filter(f => f.reader === first.reader).map(f => f.id);
    expect(mine.length).toBe(1);
    const { lines } = quarantineStage(m!, 'specialists', 1);
    expect(lines.find(l => l.startsWith(`QUARANTINED: reader=${first.reader} `))).toContain('findings_removed=1');
    expect(ids().map(f => f.id)).not.toContain(mine[0]);
    const events = readLedger(m!.ledger);
    expect([...quarantinedIds(events)]).toContain(mine[0]);
    expect(events.filter(e => e.event === 'quarantined').map(e => e.reader)).toContain(first.reader);
  }, 300_000);

  // Value: protects=a native slice's fixture summary command lists only that slice's test, fixture and spec files, and never
  //   a file the base policy excludes; fails_when=the summary command reads the whole slice or an excluded output;
  //   why_new=GST-4019 final review (lib/review-brief.ts:158); seam=pass and stage voices, the native briefs run by git
  test('a native slice summarizes only its own test and fixture files and no excluded output', () => {
    const files: Record<string, string> = {
      ...Object.fromEntries(['alpha', 'beta', 'gamma'].flatMap(d => Array.from({ length: 6 }, (_, k) => [`${d}/m${k}.ts`, src(`${d}${k}`, 290)]))),
      'alpha/m0.test.ts': src('t0', 2), 'beta/fixtures/f.json': src('f', 2), 'gamma/x.spec.ts': src('s', 2), 'testkit/big.ts': src('kit', 1_200),
      'results/a/test-out.json': src('out', 2),
    };
    const repo = fixture(files, { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: ['results/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' });
    const { r, file } = runPassBin(repo);
    expect({ status: r.status, err: r.err }).toEqual({ status: EXIT.ok, err: '' });
    expect(runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']).status).toBe(EXIT.ok);
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    const mb = mergeBase(repo);
    const native = m.readers.filter(x => x.role === 'adversarial-native' && x.slice && x.state === 'rendered');
    expect(native.length).toBeGreaterThan(1);
    const summarized: string[] = [];
    for (const x of native) {
      const brief = fs.readFileSync(x.file!, 'utf8');
      const stat = [...brief.matchAll(/`(git diff --stat [^`]*)`/g)].map(c => c[1]!);
      expect(stat.length).toBe(1);
      const own = new Set(briefNames(repo, brief.replace(/`git diff --stat [^`]*`/, ''), mb).flat());
      const names = briefNames(repo, `\`${stat[0]}\``, mb).flat();
      for (const n of names) { expect(own.has(n)).toBe(true); expect(n).toMatch(/test|fixture|\.spec\./); expect(n.startsWith('results/')).toBe(false); }
      summarized.push(...names);
    }
    expect(summarized.sort()).toEqual(['alpha/m0.test.ts', 'beta/fixtures/f.json', 'gamma/x.spec.ts', 'testkit/big.ts']);
  }, 300_000);
});
