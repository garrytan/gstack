/**
 * /ship re-review false triggers (GST-407, GST-384, GST-391): a base merge, an adjacent base edit,
 * a test-only fix and an audit-requested docs fix after review must not force another full
 * review loop, and a real product change must. Finish (Step 16's route and docs freshness) and
 * the receipt carry are exercised as the bins the driver runs; lib/ship-patch.ts is the seam both share.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, placeReceiptFirst } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); while (repos.length) cleanup(repos.pop()!); });
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); ships.push(f); return f; };
const wtree = (f: ShipFx) => f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
const mergeBase = (f: ShipFx) => f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
const snapshot = (f: ShipFx, docs = ['README.md']) => {
  const out = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', ...docs.flatMap(d => ['--docs', d])]).status).toBe(0);
  return out;
};
/** Fetch origin/main and merge it; a conflict takes `resolved` (path -> text) and commits. */
const mergeMain = (f: ShipFx, resolved: Record<string, string> = {}) => {
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status !== 0) { f.write(resolved); f.commit('merge main'); }
};
const finish = (f: ShipFx, reviewed: string, post: string, extra: string[] = []) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, ...extra]);
const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `export const l${i + 1} = ${i + 1};`).join('\n') + '\n';
const FLAVOR = (headline: string, pat: string) => `{\n  "intro": {\n    "title": "Intro",\n    "headline": "${headline}",\n    "pat": "${pat}",\n    "tone": "warm"\n  }\n}\n`;

describe('finish route after a base merge (GST-407 #1, GBRA-108 #7739)', () => {
  // Value: protects=a base merge after review that leaves the branch's own patch unchanged routes as base, not behavior,
  //   including a base edit to .gstack/pregate.json (GEVA-2, gstack-evals#87),
  //   and the docs audit stays fresh when only the base moved an audited doc; fails_when=finish compares the reviewed tree
  //   with the current tree directly and stops for 5–11.5 (behavior=N) or stales the audit on README.md the base edited;
  //   seam=lib/ship-patch.ts; no_claim=the pregate's verdict on the fixture's base-changed config
  test('base-only paths route as base and the run continues', () => {
    const f = fx({ 'src/x.ts': 'export const x = 1;\n' });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    const post = snapshot(f);
    f.advanceBase({ 'src/x.ts': 'export const x = 2;\n', 'src/y.ts': 'export const y = 1;\n', 'lib/z.ts': 'export const z = 1;\n', 'README.md': '# Fx, moved by main\n', '.gstack/pregate.json': '{"stages":[]}\n' });
    mergeMain(f);
    const r = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 docs=0 metadata=0 tests=0 base=5 context=0$/);
    expect(lineOf(r.stdout, 'DOCS')).toContain('fresh');
    expect(lineOf(r.stdout, 'EVIDENCE')).toMatch(/^EVIDENCE: FRESH label=tests /);
  });

  // Value: protects=negative control: a product edit after review, a conflict resolution that changes the branch's own
  //   lines, the same lines moved to another place, and the branch's own .gstack/pregate.json edit still force the full loop; fails_when=any routes as base or context;
  //   seam=lib/ship-patch.ts; no_claim=none
  test('a real product change, a changed resolution and a moved hunk still stop for 5–11.5', () => {
    const product = fx({ 'src/x.ts': 'export const x = 1;\n' });
    const reviewed = wtree(product);
    const reviewedBase = mergeBase(product);
    const post = snapshot(product);
    product.advanceBase({ 'src/x.ts': 'export const x = 2;\n' });
    mergeMain(product);
    product.write({ 'src/b.ts': 'export const b = 3;\n' }); product.commit('late product fix');
    const r = finish(product, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=1 .* base=1 /);
    expect([r.status, r.stdout.includes('STOP: behavior, tests or build inputs changed since review (src/b.ts)')]).toEqual([3, true]);

    const spliced = fx({ 'src/m.ts': lines(9) }, { 'src/m.ts': lines(9, { 5: 'export const l5 = 50;' }) });
    const reviewed2 = wtree(spliced);
    const base2 = mergeBase(spliced);
    const post2 = snapshot(spliced);
    spliced.advanceBase({ 'src/m.ts': lines(9, { 5: 'export const l5 = 5000;' }) });
    mergeMain(spliced, { 'src/m.ts': lines(9, { 5: 'export const l5 = 51;' }) });
    const s = finish(spliced, reviewed2, post2, ['--reviewed-base', base2]);
    expect([s.status, s.stdout.includes('STOP: behavior, tests or build inputs changed since review (src/m.ts)')]).toEqual([3, true]);

    const guarded = (at: number) => lines(30).split('\n').flatMap((l, i) => (i === at ? [l, 'authorize();'] : [l])).join('\n');
    for (const baseMoves of [false, true]) {
      const moved = fx({ 'src/m.ts': lines(30) }, { 'src/m.ts': guarded(4) });
      const reviewed3 = wtree(moved);
      const base3 = mergeBase(moved);
      const post3 = snapshot(moved);
      moved.advanceBase(baseMoves ? { 'src/m.ts': lines(30, { 28: 'export const l28 = 280;' }) } : { 'src/other.ts': 'export const o = 1;\n' });
      mergeMain(moved);
      const merged = moved.git('show', 'HEAD:src/m.ts').stdout.split('\n');
      merged.splice(merged.indexOf('authorize();'), 1);
      merged.splice(merged.indexOf('export const l20 = 20;') + 1, 0, 'authorize();');
      moved.write({ 'src/m.ts': merged.join('\n') }); moved.commit('move the guard');
      const m = finish(moved, reviewed3, post3, ['--reviewed-base', base3]);
      expect([baseMoves, m.status, m.stdout.includes('STOP: behavior, tests or build inputs changed since review (src/m.ts)')]).toEqual([baseMoves, 3, true]);
    }

    const gate = fx();
    const reviewed5 = wtree(gate);
    const base5 = mergeBase(gate);
    const post5 = snapshot(gate);
    gate.advanceBase({ 'src/x.ts': 'export const x = 2;\n' });
    mergeMain(gate);
    gate.write({ '.gstack/pregate.json': '{"stages":[]}\n' }); gate.commit('relax the pregate');
    const g = finish(gate, reviewed5, post5, ['--reviewed-base', base5]);
    expect([g.status, g.stdout.includes('STOP: behavior, tests or build inputs changed since review (.gstack/pregate.json)')]).toEqual([3, true]);

    for (const name of ['src/café.ts', 'src/[id].ts']) {
      const odd = fx({ [name]: 'export const v = 1;\n' }, { [name]: 'export const v = 2;\n' });
      const reviewed4 = wtree(odd);
      const base4 = mergeBase(odd);
      const post4 = snapshot(odd);
      odd.write({ [name]: 'export const v = 3;\n' }); odd.commit('late edit');
      const o = finish(odd, reviewed4, post4, ['--reviewed-base', base4]);
      expect([name, o.status, lineOf(o.stdout, 'ROUTE').includes(' behavior=1 ')]).toEqual([name, 3, true]);
    }
  });

  // Value: protects=--reviewed-base must be a commit on the base's history; without it the route keeps the path-only
  //   comparison and says base=unknown; fails_when=a bogus or foreign base silently widens what routes as base;
  //   seam=git merge-base --is-ancestor; no_claim=none
  test('an unknown reviewed base stops; no reviewed base keeps the path-only route', () => {
    const f = fx();
    const reviewed = wtree(f);
    const post = snapshot(f);
    const bogus = finish(f, reviewed, post, ['--reviewed-base', 'f'.repeat(40)]);
    expect([bogus.status, bogus.stdout.includes('STOP: --reviewed-base')]).toEqual([3, true]);
    const feature = finish(f, reviewed, post, ['--reviewed-base', f.git('rev-parse', 'HEAD').stdout.trim()]);
    expect([feature.status, feature.stdout.includes('is not on origin/main')]).toEqual([3, true]);
    const plain = finish(f, reviewed, post);
    expect(lineOf(plain.stdout, 'ROUTE')).toMatch(/ base=unknown context=0$/);
  });
});

describe('adjacent base edits (GST-384, #3631, founderstar#441)', () => {
  // Value: protects=a base edit next to the branch's unchanged hunk asks for a scoped review of only those hunks (finish
  //   context=N, carry RECEIPT_CARRY_SCOPED_REVIEW), and a clean scoped review lets it through; fails_when=it forces the
  //   full loop (RECEIPT_CARRY_PRODUCT_CHANGED, behavior=1) or passes silently with no review; seam=lib/ship-patch.ts;
  //   no_claim=the scoped reviewer's judgment
  test('finish stops for a scoped review of the spliced JSON entry, then continues with a clean record', () => {
    const f = fx({ 'data/flavor.json': FLAVOR('old', 'old') }, { 'data/flavor.json': FLAVOR('Bright and new', 'old') });
    const reviewed = wtree(f);
    const reviewedBase = mergeBase(f);
    const post = snapshot(f);
    f.advanceBase({ 'data/flavor.json': FLAVOR('old', 'pat-pat') });
    mergeMain(f, { 'data/flavor.json': FLAVOR('Bright and new', 'pat-pat') });
    const r = finish(f, reviewed, post, ['--reviewed-base', reviewedBase]);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 .* context=1$/);
    expect(r.status).toBe(3);
    const packet = /STOP: base context moved next to the reviewed hunks in data\/flavor\.json: .* reads (\S+),/.exec(r.stdout)?.[1];
    expect(packet).toBeDefined();
    const text = fs.readFileSync(packet!, 'utf8');
    expect(text).toContain('"pat": "pat-pat"');
    expect(text).toContain('"headline": "Bright and new"');
    const record = path.join(f.root, 'scoped.json');
    fs.writeFileSync(record, JSON.stringify({ tree: wtree(f), paths: ['data/flavor.json'], reviewer: 'anthropic/claude-opus-5-5', verdict: 'blocking' }));
    expect(finish(f, reviewed, post, ['--reviewed-base', reviewedBase, '--context-reviewed', record]).stdout).toContain('STOP: --context-reviewed: the scoped review is "blocking"');
    fs.writeFileSync(record, JSON.stringify({ tree: wtree(f), paths: ['data/flavor.json'], reviewer: 'anthropic/claude-opus-5-5', verdict: 'clean' }));
    const ok = finish(f, reviewed, post, ['--reviewed-base', reviewedBase, '--context-reviewed', record]);
    expect([ok.status, ok.stdout.includes('NEXT: Step 16 stage 5')]).toEqual([0, true]);
  });

  // Value: protects=same as above, for the receipt carry; and the same added line moved to another function is
  //   RECEIPT_CARRY_PRODUCT_CHANGED; fails_when=carry refuses the adjacent edit outright, carries it silently, or carries
  //   a moved hunk; seam=lib/ship-patch.ts; no_claim=gh pr edit (--body stands in)
  test('carry asks for a scoped review of an adjacent base edit, carries with a clean one, and refuses a moved hunk', () => {
    const repo = makeFixtureRepo({ prefix: 'ship-rereview-' }); repos.push(repo);
    const src = (edit: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => edit[i + 1] ?? `exports.v${i + 1} = ${i + 1};`).join('\n') + '\n';
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'lib/rows.js', src()); repo.git('add', '-A'); repo.git('commit', '-qm', 'rows'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature'); repo.git('merge', '-q', '--no-edit', 'main');
    write(repo.work, 'lib/rows.js', src({ 6: 'exports.v6 = 600;' })); repo.git('commit', '-qam', 'feat: v6');
    const reviewed = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 9, head: reviewed, base: 'main', queue_mode: 'stamp-at-merge' } as any));
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'lib/rows.js', src({ 5: 'exports.v5 = "five";' })); repo.git('commit', '-qam', 'main: v5'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    spawnMerge(repo, { 'lib/rows.js': src({ 5: 'exports.v5 = "five";', 6: 'exports.v6 = 600;' }) });
    const head = repo.git('rev-parse', 'HEAD');
    const carry = (extra: string[] = []) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', ...extra]);
    const ask = carry();
    expect(ask.status).toBe(EXIT.refused);
    expect(ask.out.trim()).toBe('CARRY: refused (RECEIPT_CARRY_SCOPED_REVIEW)\nGSTACK_RESULT: skill=ship status=refused run=-');
    expect(ask.err).toContain('lib/rows.js');
    const record = path.join(repo.root, 'scoped.json');
    fs.writeFileSync(record, JSON.stringify({ head, paths: ['lib/rows.js'], reviewer: 'anthropic/claude-opus-5-5', verdict: 'clean' }));
    const ok = carry(['--scoped-review', record]);
    expect(ok.status).toBe(EXIT.ok);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.carry!.reason).toBe('base merge + base context moved (scoped review by anthropic/claude-opus-5-5: lib/rows.js)');
    const guard = (text: string, after: string) => text.replace('authorize();\n', '').replace(after + '\n', after + '\nauthorize();\n');
    const rows = () => fs.readFileSync(path.join(repo.work, 'lib/rows.js'), 'utf8');
    write(repo.work, 'lib/rows.js', guard(rows(), 'exports.v2 = 2;')); repo.git('commit', '-qam', 'feat: guard v2');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 9, head: repo.git('rev-parse', 'HEAD'), base: 'main', queue_mode: 'stamp-at-merge' } as any));
    write(repo.work, 'lib/rows.js', guard(rows(), 'exports.v4 = 4;')); repo.git('commit', '-qam', 'feat: move the guard');
    const moved = carry();
    expect(moved.status).toBe(EXIT.refused);
    expect(moved.out).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(moved.err).toContain('lib/rows.js');
  });
});

function spawnMerge(repo: FixtureRepo, resolved: Record<string, string>): void {
  try { repo.git('merge', '-q', '--no-edit', 'origin/main'); return; } catch { /* conflict: resolve below */ }
  for (const [rel, text] of Object.entries(resolved)) write(repo.work, rel, text);
  repo.git('add', '-A'); repo.git('commit', '-qm', 'merge main');
}

describe('test-only and audit-requested edits after the docs audit (GST-391, gbrain #8084 #8087)', () => {
  // Value: protects=a test-only fix after review reruns the lanes instead of the loop and never stales the docs audit, while
  //   a gate edit in a test (a skip) still forces the loop; fails_when=finish stops on behavior=1 or DOCS: stale for a test
  //   file, or lets a skipped test through; seam=lib/gate-diff scanCandidate; no_claim=CI
  test('a test-only fix routes as tests and keeps the audit fresh; a skipped test stops', () => {
    const spec = (name: string, call = 'test') => `import { expect, test } from 'bun:test';\n${call}('${name}', () => expect(2).toBe(2));\n`;
    const f = fx({}, { 'src/b.ts': 'export const b = 2;\n', 'test/b.test.ts': spec('b') });
    const reviewed = wtree(f);
    const post = snapshot(f);
    f.write({ 'test/b.test.ts': spec('b is two') }); f.commit('test: rename');
    const r = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 docs=0 metadata=0 tests=1 /);
    expect(lineOf(r.stdout, 'DOCS')).toContain('fresh');
    expect(r.status).toBe(0);
    f.write({ 'test/b.test.ts': spec('b is two', 'test.skip') }); f.commit('test: skip');
    const skip = finish(f, reviewed, post, ['--reviewed-base', mergeBase(f)]);
    expect([skip.status, skip.stdout.includes('STOP: behavior, tests or build inputs changed since review (test/b.test.ts)')]).toEqual([3, true]);
  });

  // Value: protects=the one docs fix the audit's result asked for (exact path in blockers or decisions, at most 5 lines, clean
  //   at the post snapshot) carries; a bigger edit, a path the audit only reviewed, or no result file stays stale;
  //   fails_when=the audit stales on its own requested fix, or any named doc is waved through; seam=gstack-docs-candidate
  //   records; no_claim=the audit child
  test('--docs-requested carries only the requested small fix', () => {
    const index = Array.from({ length: 30 }, (_, i) => `- entry ${i}`).join('\n') + '\n';
    const f = fx({ 'docs/KEY_FILES.md': index, 'docs/guide.md': '# guide\n' });
    const reviewed = wtree(f);
    const post = snapshot(f, ['docs']);
    const result = path.join(f.root, 'a1-result.json');
    fs.writeFileSync(result, JSON.stringify({ schema_version: 1, audit_id: 'a1', status: 'current', files_updated: [], files_reviewed: ['docs/guide.md', 'docs/KEY_FILES.md'], blockers: [], decisions: ['docs/KEY_FILES.md is missing the src/b.ts entry; the author should add it'], documentation_section: 'x' }));
    f.write({ 'docs/KEY_FILES.md': index + '- src/b.ts: the b constant\n' }); f.commit('docs: index link');
    const base = ['--reviewed-base', mergeBase(f), '--docs-rechecked'];
    const stale = finish(f, reviewed, post, base);
    expect(lineOf(stale.stdout, 'DOCS')).toBe('DOCS: stale (docs/KEY_FILES.md)');
    const ok = finish(f, reviewed, post, [...base, '--docs-requested', 'docs/KEY_FILES.md', '--docs-result', result]);
    expect(lineOf(ok.stdout, 'DOCS')).toContain('fresh');
    expect(lineOf(ok.stdout, 'DOCS')).toContain('requested=1');
    expect(ok.status).toBe(0);
    f.write({ 'docs/guide.md': '# guide, rewritten\n' }); f.commit('docs: guide');
    const reviewedOnly = finish(f, reviewed, post, [...base, '--docs-requested', 'docs/guide.md', '--docs-result', result]);
    expect(reviewedOnly.stdout).toContain('STOP: --docs-requested docs/guide.md');
    f.write({ 'docs/guide.md': '# guide\n', 'docs/KEY_FILES.md': index.replace(/entry/g, 'item') + '- src/b.ts\n' }); f.commit('docs: big');
    const big = finish(f, reviewed, post, [...base, '--docs-requested', 'docs/KEY_FILES.md', '--docs-result', result]);
    expect(big.stdout).toContain('STOP: --docs-requested docs/KEY_FILES.md');
  });

  // Value: protects=an audit launch the child's install check refused is not counted, once per invocation; a crashed child,
  //   a completed audit and output that only quotes a refusal are counted, and a second refusal stops; fails_when=the refusal
  //   burns the only retry (gbrain #8084) or refusals relaunch forever; seam=none; no_claim=the parent's launch
  test('gstack-docs-candidate attempt counts only audits that could run', () => {
    const f = fx();
    const out = (name: string, text: string) => { const p = path.join(f.root, name); fs.writeFileSync(p, text); return p; };
    const state = path.join(f.root, 'attempts.json');
    const attempt = (file: string) => f.run(path.join(BIN, 'gstack-docs-candidate'), ['attempt', file, '--state', state]);
    const refused = out('refused.txt', 'gstack: ok 1.91.354.0 for=review-voice\nINSTALL: fail verdict for=review-voice does not admit document-release; fix: bash install.sh --for document-release\nGSTACK_RESULT: skill=document-release status=refused run=-\n');
    expect(attempt(out('crash.txt', 'Error: child crashed\n')).stdout.trim()).toBe('ATTEMPT: counted');
    expect(attempt(out('quoted.txt', 'I saw "GSTACK_RESULT: skill=document-release status=refused run=-" earlier\n{"schema_version":1,"audit_id":"a1","status":"current"}\n')).stdout.trim()).toBe('ATTEMPT: counted');
    const first = attempt(refused);
    expect([first.status, first.stdout.trim()]).toEqual([0, 'ATTEMPT: not-counted (install refused: INSTALL: fail verdict for=review-voice does not admit document-release; fix: bash install.sh --for document-release)']);
    const second = attempt(refused);
    expect(second.status).toBe(3);
    expect(second.stdout).toContain('ATTEMPT: counted (a second install refusal in this invocation)');
    expect(second.stdout).toContain('STOP: run the install fix');
  });
});
