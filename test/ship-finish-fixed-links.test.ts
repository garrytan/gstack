/**
 * GST-1973 (GBRA-386, gbrain #8881): a granted fix-check that finds a blocker is logged converged:false
 * (ship/sections/review-army.md), so its row never reads CURRENT. finish's chain walk refused every chain with such a
 * link, and a later clean link that read the fix could not count: only a fresh /ship review recovered the receipt,
 * past R51's two-round cap. An earlier link with findings now hands its paths on: the chain still has to be contiguous
 * and granted link by link, its newest link must be a clean bound read, and only clean links count paths. A blocking
 * finding on an earlier link closes only when a later clean link's range touched its path.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as path from 'node:path';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const TEST_V2 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); }, 1_000);\n";
const CLEAN = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };
/** The shape of GBRA-386's 990e7b6e row: a granted fix-check that found one CRITICAL and two filed notes, logged converged:false. */
const found = (p = 'src/x.ts', o: Record<string, unknown> = {}) => ({
  completed: true, converged: false, status: 'issues_found', issues_found: 3, critical: 1, informational: 2,
  findings: [
    { fingerprint: `${p}:93:red-team`, severity: 'CRITICAL', action: 'deferred', locus: 'fix-range', kind: 'defect', blocking: true, raised_by: 'red-team' },
    { fingerprint: 'src/x.ts:121:testing', severity: 'INFORMATIONAL', action: 'noted', locus: 'fix-range', kind: 'test-gap', blocking: false, raised_by: 'testing', issue: 8897 },
    { fingerprint: 'src/x.ts:121:red-team', severity: 'INFORMATIONAL', action: 'noted', locus: 'fix-range', kind: 'defect', blocking: false, raised_by: 'red-team', issue: 8897 },
  ],
  ...o,
});
const NONCONVERGED = 'missing start capture or incomplete/nonconverged pass';
const STOP = 'STOP: behavior, tests or build inputs changed since review (';

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const at = (c: string) => c.slice(0, 12);
const stopLine = (out: string) => (l => l.slice(0, l.indexOf(')') + 1))(out.split('\n').find(l => l.startsWith(STOP)) ?? '');
const notCountedAt = (c: string) => new RegExp(`^FIX_CHECK: not counted \\(.*; fix-check at ${at(c)}, link 1 of 2\\)$`);

/** The reviewed tree is the feature head; src/y.ts is a second code path for the finding-path cases. */
function reviewedShape() {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n', 'src/y.ts': 'export const y = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
  ships.push(f);
  return { f, t: headOf(f), reviewed: f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim(), reviewedBase: f.git('merge-base', 'origin/main', 'HEAD').stdout.trim() };
}
const edit = (f: ShipFx, files: Record<string, string>, msg: string) => { f.write(files); f.commit(msg); return headOf(f); };
/** One granted fix-check at HEAD reading range_base..HEAD; the owner's grant names the commit it reads (GST-1676). */
function link(f: ShipFx, from: string, row: Record<string, unknown>, o: { grant?: boolean } = {}) {
  const commit = headOf(f);
  let grant = '';
  if (o.grant !== false) {
    const g = run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: one scoped fix-check (review_loop_grant ${at(commit)})`, '--words', 'one scoped fix-check', '--by', 'gstack minder (GSTA-36)', '--scope', 'this /ship invocation', '--json']);
    expect(g.status, g.stderr).toBe(0);
    grant = JSON.parse(g.stdout).added[0] as string;
  }
  const start = run(f, 'gstack-review-log', ['--start', 'review-fix-check']);
  expect(start.status, start.stderr).toBe(0);
  const logged = run(f, 'gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: '2026-11-09T00:00:00Z', via: 'ship', review_scope: 'frozen', range_base: from, ...row }), '--finish', start.stdout.trim()]);
  expect(logged.status, logged.stderr).toBe(0);
  return { commit, grant };
}
function finish(f: ShipFx, reviewed: string, reviewedBase: string, extra: string[] = []) {
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  return f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--reviewed-base', reviewedBase, '--lane', LANE, ...extra]);
}

describe('finish counts a fix-check chain whose earlier links found issues a later clean link read (GST-1973)', () => {
  // Value: protects=the GBRA-386 shape counts: T..A and A..B each found a CRITICAL (logged converged:false), B..C read the fixes
  //   clean, and every path C's range touched counts; fails_when=finish refuses link 2 as nonconverged (FIX_CHECK: not counted ...
  //   link 2 of 3) and src/x.ts routes as behavior, so only a fresh review recovers the receipt; seam=finish's chain walk
  test('T to A (findings) to B (findings) to C (clean) counts at C', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    const a = link(f, t, found());
    edit(f, { 'src/x.ts': 'export const x = 4;\n' }, 'fix fix-check 1 findings');
    const b = link(f, a.commit, found());
    edit(f, { 'src/x.ts': 'export const x = 5;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 2 CRITICAL');
    const c = link(f, b.commit, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check chain of 3 from ${at(t)}: at ${at(a.commit)} grant ${a.grant} (found issues); at ${at(b.commit)} grant ${b.grant} (found issues); at ${at(c.commit)} grant ${c.grant})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
  });

  // Value: protects=one fix round after a fix-check that found a blocker counts: T..A found a CRITICAL, A..C read the fix clean;
  //   fails_when=finish refuses link 1 as nonconverged; seam=finish's chain walk
  test('T to A (findings) to C (clean) counts at C', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    const a = link(f, t, found());
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 1 CRITICAL');
    const c = link(f, a.commit, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check chain of 2 from ${at(t)}: at ${at(a.commit)} grant ${a.grant} (found issues); at ${at(c.commit)} grant ${c.grant})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
  });
});

describe('finish still refuses fix-check chains that do not read the fixes (GST-1973)', () => {
  // Value: protects=contiguity: a commit after the link with findings that no fix-check read breaks the chain; fails_when=a clean
  //   link counts from any branch commit once an earlier link found issues; seam=finish's chain walk
  test('a gap between the link with findings and the clean link refuses', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    link(f, t, found());
    const gap = edit(f, { 'src/x.ts': 'export const x = 4;\n' }, 'an unread edit');
    edit(f, { 'test/x.test.ts': TEST_V2 }, 'the clean link fix');
    link(f, gap, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: not counted (range_base ${at(gap)} does not hold the reviewed tree)`);
    expect([r.status, stopLine(r.stdout)], r.stdout).toEqual([3, `${STOP}src/x.ts,test/x.test.ts)`]);
  });

  // Value: protects=a clean link joins only at the previous link's end: a range_base inside the earlier link's range is no link's
  //   end commit; fails_when=finish accepts any range_base the earlier link's range holds; seam=finish's chain walk
  test('a clean link whose range starts inside the earlier link\'s range, not at its end, refuses', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    const mid = edit(f, { 'src/y.ts': 'export const y = 2;\n' }, 'first half of the fix');
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'second half of the fix');
    link(f, t, found());
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix the CRITICAL');
    link(f, mid, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: not counted (range_base ${at(mid)} does not hold the reviewed tree)`);
    expect([r.status, stopLine(r.stdout)], r.stdout).toEqual([3, `${STOP}src/x.ts,src/y.ts,test/x.test.ts)`]);
  });

  // Value: protects=the newest link must be at the current tree for what it read: an edit after the clean link routes as
  //   behavior; fails_when=a counted chain covers edits made after its last link; seam=finish's per-path read test
  test('a clean last link that is not at the current tree leaves the later edit as behavior', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    const a = link(f, t, found());
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 1 CRITICAL');
    link(f, a.commit, CLEAN);
    edit(f, { 'src/x.ts': 'export const x = 9;\n' }, 'an edit after the last fix-check');
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).not.toMatch(/reviewed [^ ]*src\/x\.ts/);
    expect([r.status, stopLine(r.stdout)], r.stdout).toEqual([3, expect.stringMatching(/^STOP: behavior, tests or build inputs changed since review \([^)]*src\/x\.ts/)]);
  });

  // Value: protects=the newest link must itself be a clean, converged read: a chain ending in a link with findings never counts,
  //   alone or after a clean link; fails_when=finish accepts a link with findings anywhere in the chain; seam=finish's chain walk
  test('a non-converged last link refuses, alone or after a clean link', () => {
    const one = reviewedShape();
    edit(one.f, { 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }, 'fix the round-2 blocker');
    link(one.f, one.t, found());
    const r1 = finish(one.f, one.reviewed, one.reviewedBase);
    expect([r1.status, lineOf(r1.stdout, 'FIX_CHECK')], r1.stdout).toEqual([3, `FIX_CHECK: not counted (${NONCONVERGED})`]);

    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    const a = link(f, t, CLEAN);
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'a second fix');
    const c = link(f, a.commit, found());
    const r = finish(f, reviewed, reviewedBase);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, `FIX_CHECK: not counted (${NONCONVERGED}; fix-check at ${at(c.commit)}, link 2 of 2)`]);
    expect(stopLine(r.stdout)).toBe(`${STOP}src/x.ts,test/x.test.ts)`);
  });

  // Value: protects=a blocking finding closes only when a later clean link read its path: an earlier clean link's read of
  //   src/y.ts does not survive a later link that found a CRITICAL there, when no clean link after it touched src/y.ts;
  //   fails_when=the chain counts src/y.ts from the first link's read; seam=finish's per-path read test
  test('a clean link that did not read the path an earlier finding named leaves that path as behavior', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/y.ts': 'export const y = 2;\n' }, 'fix the round-2 blocker in y');
    const a = link(f, t, CLEAN);
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'a fix in x');
    const b = link(f, a.commit, found('src/y.ts'));
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'a second fix in x');
    link(f, b.commit, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toMatch(/^FIX_CHECK: not counted \(a finding on src\/y\.ts that no later clean fix-check's range touched; fix-check at [0-9a-f]{12}, link 2 of 3\)$/);
    expect([r.status, stopLine(r.stdout)], r.stdout).toEqual([3, expect.stringMatching(/^STOP: behavior, tests or build inputs changed since review \([^)]*src\/y\.ts/)]);
  });

  // Value: protects=a finding path written ./src/y.ts names the same file as git's src/y.ts, so it still masks the earlier read;
  //   fails_when=finish compares the reviewer's raw path to git's root-relative paths and counts src/y.ts; seam=flagged()'s paths
  test('a finding path written with a leading ./ still names the file a later clean link must read', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/y.ts': 'export const y = 2;\n' }, 'fix the round-2 blocker in y');
    const a = link(f, t, CLEAN);
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'a fix in x');
    const b = link(f, a.commit, found('./src/y.ts'));
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'a second fix in x');
    link(f, b.commit, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toMatch(/^FIX_CHECK: not counted \(a finding on src\/y\.ts that no later clean fix-check's range touched; fix-check at [0-9a-f]{12}, link 2 of 3\)$/);
    expect([r.status, stopLine(r.stdout)], r.stdout).toEqual([3, expect.stringMatching(/^STOP: behavior, tests or build inputs changed since review \([^)]*src\/y\.ts/)]);
  });

  // Value: protects=an earlier link's finding counts as handled only when a later clean link's range touched its file: a CRITICAL
  //   on a file the branch never changed, a doubled ./ spelling and a directory all refuse the chain; fails_when=a finding on a path
  //   no routing candidate holds drops out and the chain counts; seam=finish's chain walk (cross-family trail read, GSTA-425)
  test('a finding no later clean link read refuses the chain, even on a file the branch never changed', () => {
    for (const p of ['src/y.ts', '././src/x.ts', 'src']) {
      const { f, t, reviewed, reviewedBase } = reviewedShape();
      edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
      const a = link(f, t, found(p));
      edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 1 findings');
      link(f, a.commit, CLEAN);
      const r = finish(f, reviewed, reviewedBase);
      expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, expect.stringMatching(notCountedAt(a.commit))]);
    }
  });

  // Value: protects=every link needs its own approved review_loop_grant, the link that found issues included; fails_when=a link
  //   with findings rides on the clean link's grant; seam=finish's per-link grant assignment
  test('a link with findings and no grant of its own refuses the chain', () => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    const a = link(f, t, found(), { grant: false });
    edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 1 CRITICAL');
    link(f, a.commit, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, expect.stringMatching(notCountedAt(a.commit))]);
    expect(stopLine(r.stdout)).toBe(`${STOP}src/x.ts,test/x.test.ts)`);
  });

  // Value: protects=an earlier link hands its paths on only when its row says what it found: an unfinished read, a blocking
  //   finding with no path, and claimed counts the findings list does not hold all refuse; fails_when=finish trusts a link whose
  //   findings it cannot place; seam=finish's chain walk
  test('an earlier link that did not finish its read, or whose findings cannot be placed, refuses', () => {
    const rows = [
      found('src/x.ts', { completed: false, status: 'unavailable' }),
      found('src/x.ts', { findings: [{ fingerprint: 'p2/adversarial-native#1', severity: 'CRITICAL', action: 'deferred', blocking: true, raised_by: 'adversarial-native' }], issues_found: 1, informational: 0 }),
      found('src/x.ts', { issues_found: 5 }),
      found('src/x.ts', { critical: 2 }),
      found('src/gone.ts'),
    ];
    for (const row of rows) {
      const { f, t, reviewed, reviewedBase } = reviewedShape();
      edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
      const a = link(f, t, row);
      edit(f, { 'src/x.ts': 'export const x = 4;\n', 'test/x.test.ts': TEST_V2 }, 'fix fix-check 1 CRITICAL');
      link(f, a.commit, CLEAN);
      const r = finish(f, reviewed, reviewedBase);
      expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, expect.stringMatching(notCountedAt(a.commit))]);
    }
  });
});

describe('finish counts a fix-check whose range starts after docs-only commits (GST-2294)', () => {
  const README = { 'README.md': '# Fx\n\nHow to run the canary.\n' };
  const notHeld = (c: string) => `FIX_CHECK: not counted (range_base ${at(c)} does not hold the reviewed tree)`;

  // Value: protects=harness-evals#361's shape counts: the reviewed commit, then the Step 14.5 docs commit, then the granted
  //   fix-check whose range starts at that docs commit; fails_when=finish refuses the range_base because its tree is not the
  //   reviewed tree and no earlier fix-check ends at it, so src/x.ts routes as behavior; seam=finish's chain walk
  test.each([
    ['one docs commit', [README]],
    ['a docs commit and a changelog stamp', [README, { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- pending\n- canary docs\n' }]],
  ])('a range_base after %s counts', (_name, commits) => {
    const { f, t, reviewed, reviewedBase } = reviewedShape();
    const between = (commits as Record<string, string>[]).map((files, k) => edit(f, files, `docs commit ${k + 1}`));
    const from = between[between.length - 1]!;
    edit(f, { 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }, 'fix the round-2 blocker');
    const c = link(f, from, CLEAN);
    const r = finish(f, reviewed, reviewedBase, ['--docs-rechecked']);
    expect(lineOf(r.stdout, 'FIX_CHECK_DOCS_BRIDGE'), r.stdout).toBe(`FIX_CHECK_DOCS_BRIDGE: range_base ${at(from)} follows the reviewed commit ${at(t)} by docs or release metadata only (${between.map(at).join(',')})`);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${at(c.commit)}, range from ${at(from)}, grant ${c.grant})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
  });

  // Value: protects=only docs and release metadata bridge the gap: a code or test commit, alone or after a docs commit, between
  //   the reviewed commit and range_base is a read no fix-check made; fails_when=finish accepts any range_base that descends from
  //   the reviewed commit; seam=finish's chain walk
  test.each([
    ['a code commit', [{ 'src/y.ts': 'export const y = 2;\n' }]],
    ['a test commit', [{ 'test/x.test.ts': TEST_V2 }]],
    ['a docs commit, then a code commit', [README, { 'src/y.ts': 'export const y = 2;\n' }]],
  ])('a range_base after %s still refuses', (_name, commits) => {
    const { f, reviewed, reviewedBase } = reviewedShape();
    const between = (commits as Record<string, string>[]).map((files, k) => edit(f, files, `unread commit ${k + 1}`));
    const from = between[between.length - 1]!;
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    link(f, from, CLEAN);
    const r = finish(f, reviewed, reviewedBase, ['--docs-rechecked']);
    expect(lineOf(r.stdout, 'FIX_CHECK_DOCS_BRIDGE'), r.stdout).toBe('');
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, notHeld(from)]);
  });

  // Value: protects=the bridge runs only forward from the reviewed commit: a docs-only commit before it (so the reviewed commit
  //   descends from range_base, as when --reviewed-tree names the fix-check's own tree) is no bridge; fails_when=finish accepts a
  //   docs-only diff between range_base and the reviewed commit in either direction; seam=finish's chain walk
  test('a docs commit before the reviewed commit refuses: range_base is not a descendant of it', () => {
    const { f } = reviewedShape();
    const before = edit(f, README, 'docs before review');
    edit(f, { 'src/y.ts': 'export const y = 2;\n' }, 'more reviewed code');
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    link(f, before, CLEAN);
    const r = finish(f, reviewed, reviewedBase, ['--docs-rechecked']);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, notHeld(before)]);
  });

  // Value: protects=a base merge between the reviewed commit and range_base is no bridge, even when the base change is docs;
  //   fails_when=finish reads a merge commit's first-parent diff as the branch's own docs edit; seam=finish's chain walk
  test('a merge commit between the reviewed commit and range_base refuses', () => {
    const { f, reviewed, reviewedBase } = reviewedShape();
    f.advanceBase({ 'docs/base.md': '# Base docs\n' });
    expect(f.git('fetch', '-q', 'origin').status).toBe(0);
    expect(f.git('merge', '-q', '--no-edit', 'origin/main').status).toBe(0);
    const merge = headOf(f);
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    link(f, merge, CLEAN);
    const r = finish(f, reviewed, reviewedBase, ['--docs-rechecked']);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(notHeld(merge));
    expect(r.status, r.stdout).toBe(3);
  });

  // Value: protects=a range_base on another branch still refuses, docs-only or not; fails_when=the bridge looks up the reviewed
  //   commit from a range_base HEAD does not contain; seam=finish's chain walk
  test('a docs-only range_base on another branch refuses', () => {
    const { f, reviewed, reviewedBase } = reviewedShape();
    expect(f.git('checkout', '-qb', 'side').status).toBe(0);
    const side = edit(f, README, 'docs on a side branch');
    expect(f.git('checkout', '-q', 'feat').status).toBe(0);
    edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix the round-2 blocker');
    link(f, side, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, 'FIX_CHECK: not counted (the row names no range_base commit on this branch)']);
  });

  // Value: protects=a range_base whose tree is the reviewed tree counts with no bridge line (an empty commit after review);
  //   fails_when=the bridge replaces the equal-tree check; seam=finish's chain walk
  test('a range_base whose tree equals the reviewed tree counts', () => {
    const { f, reviewed, reviewedBase } = reviewedShape();
    expect(f.git('commit', '-q', '--allow-empty', '-m', 'an empty commit after review').status).toBe(0);
    const same = headOf(f);
    edit(f, { 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }, 'fix the round-2 blocker');
    const c = link(f, same, CLEAN);
    const r = finish(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK_DOCS_BRIDGE'), r.stdout).toBe('');
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${at(c.commit)}, range from ${at(same)}, grant ${c.grant})`);
    expect(r.status, r.stdout).toBe(0);
  });
});

describe('the docs bridge uses the router\'s own metadata rule on a landed stack parent (GST-2294 audit)', () => {
  const POLICY_SRC = ['export const allow = false;', ...Array.from({ length: 28 }, (_, k) => `export const l${k} = ${k};`), 'export const label = "old";', ''].join('\n');
  /** A child branch reviewed after its stack parent P, with src/policy.ts optionally declared under key; P then lands on main and main merges into the child. */
  function stackShape(key: string | null, after: (f: ShipFx) => void) {
    const f = shipFixture({ ...(key ? { '.gstack/ship-policy.json': JSON.stringify({ min_gstack_version: '1.99.0.0', [key]: ['src/policy.ts'] }) } : {}), 'src/policy.ts': POLICY_SRC, 'src/x.ts': 'export const x = 1;\n' }, { 'src/parent.ts': 'export const parent = 1;\n' });
    ships.push(f);
    const parent = headOf(f);
    edit(f, { 'src/x.ts': 'export const x = 2;\n' }, 'child');
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const from = edit(f, { 'src/policy.ts': POLICY_SRC.replace('allow = false', 'allow = true') }, 'unreviewed logic change');
    after(f);
    link(f, from, CLEAN);
    f.advanceBase({ 'src/parent.ts': 'export const parent = 1;\n' });
    expect(f.git('fetch', '-q', 'origin').status).toBe(0);
    expect(f.git('merge', '-q', '--no-edit', 'origin/main').status).toBe(0);
    return { r: finish(f, reviewed, parent, ['--docs-rechecked']), from };
  }
  const notHeld = (c: string) => `FIX_CHECK: not counted (range_base ${at(c)} does not hold the reviewed tree)`;

  // Value: protects=a declared stamp or release-output path the router classes as behavior on a landed stack parent never bridges
  //   the gap, whether the fix-check rewrites that file or only appends to it; fails_when=the bridge reads the broad release list and
  //   credits src/policy.ts as fix_checked (finish exits 0, fix_checked=2); seam=finish's chain walk and route's metadata rule
  test.each([
    ['stamp_paths', 'a rewrite'], ['release_outputs', 'a rewrite'], ['stamp_paths', 'an append'], ['release_outputs', 'an append'],
  ])('%s: a logic change in the gap, then %s in the fix-check range, refuses', (key, kind) => {
    const { r, from } = stackShape(key, f => edit(f, {
      'src/policy.ts': kind === 'a rewrite' ? POLICY_SRC.replace('allow = false', 'allow = true').replace('"old"', '"new"') : `${POLICY_SRC.replace('allow = false', 'allow = true')}export const tail = 1;\n`,
      'src/x.ts': 'export const x = 3;\n',
    }, 'fix-check reads this range'));
    expect(lineOf(r.stdout, 'FIX_CHECK_DOCS_BRIDGE'), r.stdout).toBe('');
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, notHeld(from)]);
  });

  // Value: protects=the two controls of the append repro: with no append the fix-check never touched src/policy.ts, and with no
  //   declaration the path was never metadata; both refuse; fails_when=either control counts; seam=finish's route
  test('controls: no append stops on src/policy.ts, and no declaration refuses the bridge', () => {
    const noAppend = stackShape('stamp_paths', f => edit(f, { 'src/x.ts': 'export const x = 3;\n' }, 'fix-check reads this range'));
    expect([noAppend.r.status, noAppend.r.stdout.includes('src/policy.ts')], noAppend.r.stdout).toEqual([3, true]);
    const undeclared = stackShape(null, f => edit(f, { 'src/policy.ts': `${POLICY_SRC.replace('allow = false', 'allow = true')}export const tail = 1;\n`, 'src/x.ts': 'export const x = 3;\n' }, 'fix-check reads this range'));
    expect([undeclared.r.status, lineOf(undeclared.r.stdout, 'FIX_CHECK')], undeclared.r.stdout).toEqual([3, notHeld(undeclared.from)]);
  });
});

describe('the docs bridge line prints only when the fix-check counts (GST-2294 audit)', () => {
  // Value: protects=FIX_CHECK_DOCS_BRIDGE never sits beside a refused chain; fails_when=the line prints before the grant check
  //   refuses; seam=finish's FIX_CHECK output
  test('an ungranted fix-check after a docs commit prints no bridge line', () => {
    const { f, reviewed, reviewedBase } = reviewedShape();
    const d = edit(f, { 'README.md': '# Fx\n\nHow to run the canary.\n' }, 'docs commit');
    edit(f, { 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }, 'fix the round-2 blocker');
    link(f, d, CLEAN, { grant: false });
    const r = finish(f, reviewed, reviewedBase, ['--docs-rechecked']);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK_DOCS_BRIDGE'), lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, '', 'FIX_CHECK: not counted (no approved review_loop_grant names a stop head inside its range_base..commit)']);
  });
});
