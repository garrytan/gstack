/**
 * GST-1561 (founderstar#563): a receipt carry whose diff holds both a changed product path and a context path had no
 * bounded route. RECEIPT_CARRY_SCOPED_REVIEW opened only when no path changed, and J1's scoped re-check refused whenever
 * base context moved, so a base merge that bumped a constant the branch also replaces (SAVE_VERSION := 82 became 83 on
 * the base; the branch's own `:= 84` line is byte-identical) next to a moved base block forced a full /ship every time.
 * Here: a hunk whose only difference is a base-side removed line takes the scoped review with the context paths (finish
 * and carry), a changed path plus context paths take one composed re-check packet bound to range_base, past the size cap
 * it refuses as before, and a branch-side change to an added line still needs review.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { comparePath } from '../lib/ship-patch';
import { extractReceipt } from '../lib/ship-receipt';
import { RECHECK_RANGE_DIFF_CAP } from '../crew/lib/ship-recheck';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const RECEIPT = path.join(BIN, 'gstack-ship-receipt');
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const READER = 'anthropic/claude-opus-5-5';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const GAME = 'scripts/core/game.gd';
const VESTING = 'scripts/core/vesting.gd';
const SCORE = 'scripts/core/score.gd';
const game = (save: number) => ['extends Node', '', `const SAVE_VERSION := ${save}`, '', 'func _ready():', '\tload_save()', '', 'func load_save():', '\tpass', ''].join('\n') + '\n';
const vesting = (edit: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => edit[i + 1] ?? `var v${i + 1} := ${i + 1}`).join('\n') + '\n';
const BRANCH_VESTING = { 6: 'func was_vesting_clear(): return granted and not revoked' };
const BASE_VESTING = { 4: 'var v4 := 40 # moved by the base' };
const UNATTENDED = { GSTACK_SESSION_KIND: 'unattended' };

/** A branch reviewed at its first commit (receipt written by gstack-ship-receipt write, so it records review_depth). */
function reviewedBranch(base: Record<string, string>, feat: Record<string, string>) {
  const f = shipFixture(base, feat); ships.push(f);
  const from = f.git('rev-parse', 'HEAD').stdout.trim();
  const reviewedTree = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const w = f.run(RECEIPT, ['write', '--pr', '5', '--base', 'main', '--body', body], UNATTENDED);
  expect([w.status, w.stderr.slice(0, 400)]).toEqual([EXIT.ok, expect.any(String)]);
  expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.review_depth).toBeDefined();
  const carry = (extra: string[] = []) => f.run(RECEIPT, ['carry', '--body', body, '--base', 'main', ...extra], UNATTENDED);
  return { f, from, reviewedTree, reviewedBase, body, carry };
}

/** Merge origin/main; a conflict takes `resolved` and commits the merge. */
function mergeMain(f: ShipFx, resolved: Record<string, string>) {
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status !== 0) { f.write(resolved); f.commit('merge main'); }
}

/** founderstar#563: the base took SAVE_VERSION 83 under the branch's 84, and moved a block next to the branch's vesting hunk. */
function founderstar(resolvedSave = 84, baseBlock = 0) {
  const x = reviewedBranch({ [GAME]: game(82), [VESTING]: vesting(), [SCORE]: 'var score := 1\n' }, { [GAME]: game(84), [VESTING]: vesting(BRANCH_VESTING) });
  const moved = { 4: [BASE_VESTING[4], ...Array.from({ length: baseBlock }, (_, i) => `var base${i} := ${i}`)].join('\n') };
  x.f.advanceBase({ [GAME]: game(83), [VESTING]: vesting(moved) });
  mergeMain(x.f, { [GAME]: game(resolvedSave), [VESTING]: vesting({ ...moved, ...BRANCH_VESTING }) });
  const head = x.f.git('rev-parse', 'HEAD').stdout.trim();
  const sides = { reviewedBase: x.reviewedBase, reviewed: x.from, currentBase: x.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), current: head };
  return { ...x, head, sides };
}

const scopedPacket = (err: string) => /one fix-check reviewer reads (\S+), then rerun carry/.exec(err)?.[1];
const eligible = (err: string) => /^RECHECK: eligible range_diff_lines=(\d+) range_diff_sha256=([0-9a-f]{64}) packet=(\S+);/m.exec(err);
const recordAt = (f: ShipFx, name: string, v: object) => { const file = path.join(f.root, name); fs.writeFileSync(file, JSON.stringify(v)); return file; };

describe('a base-side removed line next to byte-identical added lines (GST-1561 ask 2)', () => {
  test('comparePath routes it with the context paths; a branch-side added-line change stays changed', () => {
    const same = founderstar();
    expect(comparePath(same.f.work, same.sides, GAME)).toBe('context');
    expect(comparePath(same.f.work, same.sides, VESTING)).toBe('context');
    const moved = founderstar(85);
    expect(comparePath(moved.f.work, moved.sides, GAME)).toBe('changed');
  });

  test('a branch that now also removes a line the base never touched stays changed', () => {
    const x = reviewedBranch({ [GAME]: game(82) }, { [GAME]: game(84) });
    x.f.advanceBase({ [GAME]: game(83) });
    mergeMain(x.f, { [GAME]: game(84).replace('\tload_save()\n', '') });
    const head = x.f.git('rev-parse', 'HEAD').stdout.trim();
    const sides = { reviewedBase: x.reviewedBase, reviewed: x.from, currentBase: x.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), current: head };
    expect(comparePath(x.f.work, sides, GAME)).toBe('changed');
  });

  for (const [where, inserted] of [['before', game(82).replace('const SAVE', 'const BASE_ADD := 1\nconst SAVE')], ['after', game(82).replace(':= 82\n', ':= 82\nconst BASE_ADD := 1\n')], ['beside its own edit of', game(83).replace(':= 83\n', ':= 83\nconst BASE_ADD := 1\n')]] as const) {
    test(`a merge that drops a line the base inserted ${where} the replaced line stays changed`, () => {
      const x = reviewedBranch({ [GAME]: game(82) }, { [GAME]: game(84) });
      x.f.advanceBase({ [GAME]: inserted });
      mergeMain(x.f, { [GAME]: game(84) });
      if (fs.readFileSync(path.join(x.f.work, GAME), 'utf8') !== game(84)) { x.f.write({ [GAME]: game(84) }); x.f.commit('drop the base line'); }
      const head = x.f.git('rev-parse', 'HEAD').stdout.trim();
      const sides = { reviewedBase: x.reviewedBase, reviewed: x.from, currentBase: x.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), current: head };
      expect(comparePath(x.f.work, sides, GAME)).toBe('changed');
    });
  }
});

describe('carry: the founderstar#563 shape takes one scoped reader, then binds', () => {
  test('one packet holds the constant hunk and the moved context block; a clean record carries', () => {
    const { f, head, carry, body } = founderstar();
    const ask = carry();
    expect([ask.status, ask.stdout.trim().split('\n')[0]], ask.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_SCOPED_REVIEW)']);
    const packet = scopedPacket(ask.stderr);
    expect(packet, ask.stderr).toBeDefined();
    const text = fs.readFileSync(packet!, 'utf8');
    for (const s of ['-const SAVE_VERSION := 82', '-const SAVE_VERSION := 83', '+const SAVE_VERSION := 84', 'was_vesting_clear', 'moved by the base']) expect(text).toContain(s);
    const partial = recordAt(f, 'partial.json', { head, paths: [VESTING], reviewer: READER, verdict: 'clean' });
    expect(carry(['--scoped-review', partial]).stderr).toContain(`the scoped review does not cover ${GAME}`);
    const ok = carry(['--scoped-review', recordAt(f, 'scoped.json', { head, paths: [GAME, VESTING], reviewer: READER, verdict: 'clean' })]);
    expect([ok.status, ok.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    const carried = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
    expect(carried.head).toBe(head);
    expect(carried.carry!.reason).toContain(`scoped review by ${READER}`);
    expect(carried.carry!.reason).toContain(GAME);
  });

  test('a branch-side change to the added line still forces review (never the scoped context route)', () => {
    const { carry } = founderstar(85);
    const r = carry();
    expect(r.status).toBe(EXIT.refused);
    expect(r.stdout).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(r.stderr).toContain(GAME);
    expect(r.stdout).not.toContain('RECEIPT_CARRY_SCOPED_REVIEW');
  });
});

describe('carry: a changed path plus context paths compose into one bounded re-check (GST-1561 ask 1)', () => {
  const composed = (baseBlock = 0) => {
    const x = founderstar(84, baseBlock);
    x.f.write({ [SCORE]: 'var score0 := 2\n' }); x.f.commit('fix: score');
    return { ...x, head: x.f.git('rev-parse', 'HEAD').stdout.trim() };
  };

  test('one packet holds the range-diff and the context hunks, bound to range_base; a clean record carries', () => {
    const { f, from, head, reviewedBase, carry, body } = composed();
    const ask = carry();
    expect([ask.status, ask.stdout.trim().split('\n')[0]], ask.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)']);
    const m = eligible(ask.stderr);
    expect(m, ask.stderr).not.toBeNull();
    const rangeBase = /"range_base":"([0-9a-f]{40,64})"/.exec(ask.stderr)?.[1];
    expect(rangeBase).toBe(reviewedBase);
    const text = fs.readFileSync(m![3]!, 'utf8');
    for (const s of ['var score0 := 2', 'was_vesting_clear', 'moved by the base', 'const SAVE_VERSION := 83', `range_base ${reviewedBase}`]) expect(text).toContain(s);
    const record = { from, head, range_base: rangeBase, range_diff_sha256: m![2], reader: READER, verdict: 'clean' };
    const noBase = carry(['--recheck', recordAt(f, 'nobase.json', { ...record, range_base: undefined })]);
    expect([noBase.status, noBase.stdout.includes('RECEIPT_CARRY_REFUSED'), noBase.stderr.includes('range_base')]).toEqual([EXIT.refused, true, true]);
    const ok = carry(['--recheck', recordAt(f, 'recheck.json', record)]);
    expect([ok.status, ok.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(ok.stdout).toContain(`scoped re-check by ${READER}`);
    const reason = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.carry!.reason;
    expect(reason).toContain(`scoped re-check by ${READER}`);
    expect(reason).toContain(VESTING);
    expect(reason).toContain(`range_base ${reviewedBase.slice(0, 12)}`);
  });

  test('past the size cap it refuses as before: RECEIPT_CARRY_PRODUCT_CHANGED, re-check not eligible', () => {
    const { carry } = composed(RECHECK_RANGE_DIFF_CAP);
    const r = carry();
    expect([r.status, r.stdout.trim().split('\n')[0]]).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)']);
    expect(r.stderr).toMatch(/RECHECK: not eligible \(the packet is \d+ lines, over the scoped re-check cap/);
    expect(eligible(r.stderr)).toBeNull();
  });

  test('changed-only keeps J1 as it is; context-only keeps the scoped review', () => {
    const changed = reviewedBranch({ [SCORE]: 'var score := 1\n' }, { [SCORE]: 'var score := 2\n' });
    changed.f.write({ [SCORE]: 'var score := 3\n' }); changed.f.commit('fix: score 3');
    const c = changed.carry();
    const m = eligible(c.stderr);
    expect(m, c.stderr).not.toBeNull();
    expect(c.stderr).not.toContain('"range_base"');
    expect(fs.readFileSync(m![3]!, 'utf8')).not.toContain('# Scoped review');

    const context = reviewedBranch({ [VESTING]: vesting() }, { [VESTING]: vesting(BRANCH_VESTING) });
    context.f.advanceBase({ [VESTING]: vesting(BASE_VESTING) });
    mergeMain(context.f, { [VESTING]: vesting({ ...BASE_VESTING, ...BRANCH_VESTING }) });
    const s = context.carry();
    expect([s.status, s.stdout.trim().split('\n')[0]]).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_SCOPED_REVIEW)']);
    expect(s.stderr).not.toContain('RECHECK:');
  });
});

describe('finish: the founderstar#563 shape takes the scoped reader too', () => {
  test('ROUTE sends nothing to behavior, and one clean scoped record lets finish go on', () => {
    const x = founderstar();
    const post = path.join(x.f.root, 'post.json');
    expect(x.f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    const finish = (extra: string[] = []) => x.f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', x.reviewedTree, '--docs-post', post, '--lane', LANE, '--reviewed-base', x.reviewedBase, ...extra]);
    const ask = finish();
    expect([ask.status, lineOf(ask.stdout, 'ROUTE')], ask.stdout).toEqual([3, expect.stringMatching(/ behavior=0 .* context=[12]$/)]);
    const packet = /reads (\S+\.md)[ ,]/.exec(ask.stdout)?.[1];
    expect(fs.readFileSync(packet!, 'utf8')).toContain('moved by the base');
    const tree = x.f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const ok = finish(['--context-reviewed', recordAt(x.f, 'ctx.json', { tree, paths: [GAME, VESTING], reviewer: READER, verdict: 'clean' })]);
    expect(lineOf(ok.stdout, 'SCOPED_REVIEW'), ok.stdout).toStartWith(`SCOPED_REVIEW: clean by ${READER} (`);
    expect(ok.stdout).not.toContain('STOP: behavior');
  });
});
