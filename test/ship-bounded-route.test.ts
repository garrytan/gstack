/**
 * Bounded post-review edits (GST-1276, GST-1311): a required edit that lands after review binds (a docs-audit fix to
 * code-classed policy prose, an additive lane mapping in .gstack/pregate.json, a declared bookkeeping file, a value-only
 * test literal) takes one scoped reader at finish instead of another review round, and only when the diff proves its
 * kind. Everything else still stops for Steps 5–11.5, now with a ROUTE_BOUNDED_REFUSED line naming why.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isGatePath } from '../lib/review-depth';
import { BOOKKEEPING_KEY_VERSION } from '../lib/ship-policy';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); ships.push(f); return f; };
const wtree = (f: ShipFx) => f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
const mergeBase = (f: ShipFx) => f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
const snapshot = (f: ShipFx, docs = ['README.md'], out = path.join(f.root, 'post.json')) => {
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', ...docs.flatMap(d => ['--docs', d])]).status).toBe(0);
  return out;
};
const finish = (f: ShipFx, reviewed: string, post: string, extra: string[] = []) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, ...extra]);
const behaviorStop = (p: string) => `STOP: behavior, tests or build inputs changed since review (${p}): insert 5–11.5 → 12–14 → 16 before Step 17; plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner's grant of one scoped fix-check (stage 2.1)`;
const packetOf = (out: string) => /reads (\S+\.md)[ ,]/.exec(out)?.[1] ?? '';
const record = (f: ShipFx, paths: string[], packet: string | null, extra: Record<string, unknown> = {}) => {
  const file = path.join(f.root, 'bounded-reviewed.json');
  const sha = packet ? createHash('sha256').update(fs.readFileSync(packet)).digest('hex') : undefined;
  fs.writeFileSync(file, JSON.stringify({ tree: wtree(f), paths, reviewer: 'anthropic/claude-opus-5-5', verdict: 'clean', ...(sha ? { packet_sha256: sha } : {}), ...extra }));
  return file;
};
const POLICY = (n: number, edit: Record<number, string> = {}) => '# Review policy\n\n' + Array.from({ length: n }, (_, i) => edit[i + 1] ?? `- rule ${i + 1}: a reviewer reads the hunk.`).join('\n') + '\n';

describe('docs-audit edits to code-classed policy prose (GST-1276: #3970, #3985)', () => {
  // The audit's own edit: the reviewed tree held the old bytes, the post-audit snapshot holds the new bytes, and the
  // file still holds them. finish asks one scoped reader for those hunks, bound to the packet's hash.
  const audited = (rel = 'docs/review-policy.md', edit: Record<number, string> = { 3: '- rule 3: the binary exclusion is plain docs carry.' }) => {
    const f = fx({ [rel]: POLICY(12) });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    f.write({ [rel]: POLICY(12, edit) }); f.commit('docs: audit fixes stale policy text');
    const post = snapshot(f, ['docs', 'review', 'AGENTS.md', 'README.md'].filter(d => fs.existsSync(path.join(f.work, d))));
    return { f, reviewed, reviewedBase, post, rel };
  };

  test('an audit edit to docs/review-policy.md routes to one scoped reader, and a clean bound record lets finish go on', () => {
    const { f, reviewed, reviewedBase, post, rel } = audited();
    const ask = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(ask.stdout, 'ROUTE'), ask.stdout).toMatch(/ behavior=0 .* bounded=1$/);
    expect(lineOf(ask.stdout, 'STOP')).toContain(`bounded edits since review in ${rel} (audit prose)`);
    const packet = packetOf(ask.stdout);
    expect(fs.readFileSync(packet, 'utf8')).toContain('the binary exclusion is plain docs carry');
    expect(fs.readFileSync(packet, 'utf8')).toContain('## money');
    const unbound = finish(f, reviewed, post, ['--reviewed-base', reviewedBase, '--context-reviewed', record(f, [rel], null)]);
    expect([unbound.status, lineOf(unbound.stdout, 'STOP')]).toEqual([3, expect.stringContaining('packet_sha256')]);
    const ok = finish(f, reviewed, post, ['--reviewed-base', reviewedBase, '--context-reviewed', record(f, [rel], packet)]);
    expect(lineOf(ok.stdout, 'SCOPED_REVIEW'), ok.stdout).toBe(`SCOPED_REVIEW: clean by anthropic/claude-opus-5-5 (${rel})`);
    expect(lineOf(ok.stdout, 'DOCS')).toContain('fresh');
  });

  test('docs/pregate.md and AGENTS.md take the same route', () => {
    for (const rel of ['docs/pregate.md', 'AGENTS.md']) {
      const { f, reviewed, reviewedBase, post } = audited(rel);
      expect([rel, lineOf(finish(f, reviewed, post, ['--reviewed-base', reviewedBase]).stdout, 'ROUTE')]).toEqual([rel, expect.stringMatching(/ behavior=0 .* bounded=1$/)]);
    }
  });

  test('controls: no --reviewed-base, an edit after the post snapshot, over 20 lines or a gate-path brief still stop, with a reason', () => {
    const noSides = audited();
    const a = finish(noSides.f, noSides.reviewed, noSides.post);
    expect([a.status, lineOf(a.stdout, 'STOP')]).toEqual([3, behaviorStop(noSides.rel)]);
    expect(lineOf(a.stdout, 'ROUTE_BOUNDED_REFUSED')).toContain(`${noSides.rel} needs --reviewed-base`);

    const late = audited();
    late.f.write({ [late.rel]: POLICY(12, { 3: '- rule 3: the binary exclusion is plain docs carry.', 9: '- rule 9: never mind.' }) }); late.f.commit('docs: edit after the audit');
    const b = finish(late.f, late.reviewed, late.post, ['--reviewed-base', late.reviewedBase]);
    expect([b.status, lineOf(b.stdout, 'STOP')]).toEqual([3, behaviorStop(late.rel)]);
    expect(lineOf(b.stdout, 'ROUTE_BOUNDED_REFUSED')).toContain('is not the bytes the post-audit snapshot recorded');

    const big = audited('docs/review-policy.md', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, `- rule ${i + 1}: rewritten.`])));
    const c = finish(big.f, big.reviewed, big.post, ['--reviewed-base', big.reviewedBase]);
    expect([c.status, lineOf(c.stdout, 'ROUTE_BOUNDED_REFUSED')]).toEqual([3, expect.stringContaining('changed 22 lines since review (at most 20)')]);

    const gate = audited('review/specialists/targeted.md');
    const d = finish(gate.f, gate.reviewed, gate.post, ['--reviewed-base', gate.reviewedBase]);
    expect([d.status, lineOf(d.stdout, 'STOP')]).toEqual([3, behaviorStop('review/specialists/targeted.md')]);
  });
});

describe('an additive lane mapping in .gstack/pregate.json (GST-1276: gstack-evals#203)', () => {
  const pregate = (deps: Record<string, string[]>, extra: Record<string, unknown> = {}) => JSON.stringify({ dependencies: deps, ...extra }, null, 2) + '\n';
  const mapped = (after: Record<string, string[]>, [was, now]: Record<string, unknown>[] = [{}, {}]) => {
    const f = fx({ '.gstack/pregate.json': pregate({ 'src/a.ts': ['test/a.test.ts'] }, was) });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    const post = snapshot(f);
    f.write({ '.gstack/pregate.json': pregate(after, now) }); f.commit('pregate: map the lane');
    return finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
  };

  test('a mapping that only adds tests takes the scoped reader', () => {
    const r = mapped({ 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/b.test.ts'] });
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 .* bounded=1$/);
    expect(lineOf(r.stdout, 'STOP')).toContain('.gstack/pregate.json (lanes)');
  });

  test('a removed mapping or a new [] declaration loosens and stops', () => {
    for (const [name, after, why] of [['removed', {}, 'is removed'], ['empty', { 'src/a.ts': ['test/a.test.ts'], 'docs/**': [] }, 'declares no lane needed']] as const) {
      const r = mapped(after as Record<string, string[]>);
      expect([name, r.status, lineOf(r.stdout, 'STOP')]).toEqual([name, 3, behaviorStop('.gstack/pregate.json')]);
      expect([name, lineOf(r.stdout, 'ROUTE_BOUNDED_REFUSED')]).toEqual([name, expect.stringContaining(why)]);
    }
  });

  test('a lane added beside a cut CI-reuse job or a dropped sealed rule stops; unchanged keys still take the reader', () => {
    const profile = { workflow: 'free-tests.yml', events: ['pull_request'], jobs: ['free-plan', 'free-tests'], artifact: 'tested-tree' };
    const was = { run_profiles: { 'ci-reuse/free-tests': profile }, sealed: { paths: ['evals/sealed/**'] } };
    const lane = { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/b.test.ts'] };
    const cut = { ...was, run_profiles: { 'ci-reuse/free-tests': { ...profile, jobs: ['free-plan'] } } };
    for (const [name, now] of [['run_profiles', cut], ['sealed', { run_profiles: was.run_profiles }]] as const) {
      const r = mapped(lane, [was, now]);
      expect([name, r.status, lineOf(r.stdout, 'STOP')]).toEqual([name, 3, behaviorStop('.gstack/pregate.json')]);
      expect([name, lineOf(r.stdout, 'ROUTE_BOUNDED_REFUSED')]).toEqual([name, expect.stringContaining(`changes ${name}`)]);
    }
    expect(lineOf(mapped(lane, [was, was]).stdout, 'STOP')).toContain('.gstack/pregate.json (lanes)');
  });
});

describe('declared bookkeeping files (GST-1311: gbrain#8523, #8525)', () => {
  const policy = (globs: string[]) => JSON.stringify({ bookkeeping: globs, min_gstack_version: BOOKKEEPING_KEY_VERSION }) + '\n';
  const TSV = (rows: string[]) => 'function\tlines\n' + rows.join('\n') + '\n';

  test('a renamed baseline row and a file first added after review take the scoped reader; an undeclared file stops', () => {
    const f = fx({ '.gstack/ship-policy.json': policy(['scripts/*-baseline.tsv', 'scripts/serial-files.tsv']), 'scripts/function-size-baseline.tsv': TSV(['oldFn\t180', 'other\t160']) });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    const post = snapshot(f);
    f.write({ 'scripts/function-size-baseline.tsv': TSV(['newFn\t180', 'other\t160']), 'scripts/serial-files.tsv': TSV(['test/a.test.ts\t1']) }); f.commit('verify: baseline rows');
    const r = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 .* bounded=2$/);
    f.write({ 'scripts/other.tsv': TSV(['x\t1']) }); f.commit('an undeclared table');
    const s = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect([s.status, lineOf(s.stdout, 'STOP')]).toEqual([3, behaviorStop('scripts/other.tsv')]);
  });

  test('a declared .txt table takes the bounded route, not the docs recheck; a glob reaching .github/ is refused', () => {
    const f = fx({ '.gstack/ship-policy.json': policy(['scripts/*-baseline.txt', '**/*.tsv']), 'scripts/skill-size-baseline.txt': 'a 10\nb 20\n', '.github/owners.tsv': TSV(['a\t1']) });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    const post = snapshot(f);
    f.write({ 'scripts/skill-size-baseline.txt': 'a 12\nb 20\n' }); f.commit('verify: size baseline');
    const r = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 docs=0 .* bounded=1$/);
    f.write({ '.github/owners.tsv': TSV(['a\t2']) }); f.commit('a table under .github/');
    const s = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(s.stdout, 'ROUTE_BOUNDED_REFUSED'), s.stdout).toContain('.github/owners.tsv is a gate path or under .gstack/ or .github/');
    expect([s.status, lineOf(s.stdout, 'STOP')]).toEqual([3, behaviorStop('.github/owners.tsv')]);
  });

  test('a bookkeeping glob that names code is refused at load', () => {
    const f = fx({ '.gstack/ship-policy.json': policy(['scripts/*.ts']) });
    const v = f.run(path.join(BIN, 'gstack-ship-policy'), ['validate', '--json']);
    expect(v.stdout + v.stderr).toContain('must end in .tsv, .csv or .txt');
    expect(v.status).not.toBe(0);
  });
});

describe('a value-only test literal after review (GST-1276 instance 5: #3984)', () => {
  const spec = (key: string, body = "  expect(scan(KEY)).toBe(false);\n") => `import { expect, test } from 'bun:test';\nconst KEY = '${key}';\nconst scan = (s: string) => s.startsWith('sk-live-');\ntest('fake key', () => {\n${body}});\n`;
  test('a changed string literal routes as tests (scoped reader); a changed assertion still stops', () => {
    const f = fx({}, { 'src/b.ts': 'export const b = 2;\n', 'test/key.test.ts': spec('sk-test-abc') });
    const reviewed = wtree(f);
    const post = snapshot(f);
    f.write({ 'test/key.test.ts': spec('fixture-value') }); f.commit('test: a value the secrets scan does not flag');
    const r = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 docs=0 metadata=0 tests=1 /);
    f.write({ 'test/key.test.ts': spec('fixture-value', "  expect(scan(KEY)).toBe(true);\n") }); f.commit('test: flip the assertion');
    const s = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect([s.status, lineOf(s.stdout, 'STOP')]).toEqual([3, behaviorStop('test/key.test.ts')]);
  });

  test('an expected value inside a multi-line assertion, or code in an f-string, still stops', () => {
    const multi = (name: string, gap = '') => spec('fixture-value', `  expect({ name: KEY }).toEqual({\n${gap}    name: '${name}',\n  });\n`);
    const tmpl = (v: string) => spec('fixture-value', `  expect(gen()).toBe(\`\nconst a = 1;\nconst b = '${v}';\n\`);\n`);
    const py = (flag: string) => `import subprocess\nBIN = "bin/scan"\n\ndef test_scan():\n    cmd = f"{BIN} ${flag}"\n    assert subprocess.run(cmd, shell=True).returncode == 0\n`;
    const f = fx({}, { 'src/b.ts': 'export const b = 2;\n', 'test/key.test.ts': multi('alice'), 'test/test_scan.py': py('--strict') });
    const reviewed = wtree(f);
    const post = snapshot(f);
    f.write({ 'test/key.test.ts': multi('bob') }); f.commit('test: change an expected value');
    const r = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('test/key.test.ts')]);
    f.write({ 'test/key.test.ts': multi('alice'), 'test/test_scan.py': py('--lenient') }); f.commit('test: change code in an f-string');
    const s = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect([s.status, lineOf(s.stdout, 'STOP')]).toEqual([3, behaviorStop('test/test_scan.py')]);
    for (const [before, after] of [[multi('alice', '\n'), multi('bob', '\n')], [tmpl('old'), tmpl('new')]] as const) {
      f.write({ 'test/test_scan.py': py('--strict'), 'test/key.test.ts': before }); f.commit('test: reset');
      const at = wtree(f);
      f.write({ 'test/key.test.ts': after }); f.commit('test: change an expected value');
      const t = finish(f, at, snapshot(f), ['--reviewed-base', mergeBase(f)]);
      expect([t.status, lineOf(t.stdout, 'STOP')], after).toEqual([3, behaviorStop('test/key.test.ts')]);
    }
  });
});

describe('gstack-diff-scope and gate paths for .gstack/ (GST-1276: GEVA-2 ask c)', () => {
  test('a .gstack/-only diff is config, not unmatched; .gstack/always-run.json is a gate path', () => {
    const f = fx({ '.gstack/pregate.json': '{"dependencies":{}}\n' });
    f.write({ '.gstack/pregate.json': '{"dependencies":{"src/b.ts":["test/b.test.ts"]}}\n' }); f.commit('lanes');
    const out = spawnSync(path.join(BIN, 'gstack-diff-scope'), ['main'], { cwd: f.work, encoding: 'utf8', timeout: 30_000 });
    expect(out.stdout).toContain('SCOPE_CONFIG=true');
    expect(out.stdout).not.toContain('SCOPE_ERROR');
    expect(isGatePath('.gstack/always-run.json')).toBe(true);
  });
});
