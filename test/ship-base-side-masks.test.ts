/**
 * GST-2975: /ship finish stopped with "behavior, tests or build inputs changed since review" after a base merge whose only
 * effect on the branch's files was base-side: the shared-preamble hash id in regenerated skill files (#4383, 94 files), and
 * main's new entry spliced into an expected-value list the branch also appended to (ghome#16). Both now compare with the
 * base-side difference masked; the spliced list goes to the scoped reader, moved base context next to unchanged own lines
 * counts as reviewed (GST-3562 G), and a real change to the branch's own lines still stops.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { baseHolds, comparePath } from '../lib/ship-patch';
import { extractReceipt, placeReceipt } from '../lib/ship-receipt';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); ships.push(f); return f; };
const wtree = (f: ShipFx) => f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
const mergeBase = (f: ShipFx) => f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
const snapshot = (f: ShipFx) => {
  const out = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  return out;
};
const mergeMain = (f: ShipFx, resolved: Record<string, string>) => {
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status !== 0) { f.write(resolved); f.commit('merge main'); }
};
const finish = (f: ShipFx, reviewed: string, post: string, reviewedBase: string) =>
  f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, '--reviewed-base', reviewedBase]);
const sidesOf = (f: ShipFx, reviewed: string, reviewedBase: string) =>
  ({ reviewedBase, reviewed, currentBase: mergeBase(f), current: f.git('rev-parse', 'HEAD').stdout.trim() });

/** A generated skill file as gen-skill-docs writes it: the shared-preamble id twice, then rules the branch edits. */
const SKILL = 'ship/SKILL.md';
const PREAMBLE = 'ship/sections/preamble.md';
const skill = (id: string, rules: string[], tail = 'Run the review.') =>
  ['---', 'name: ship', '---', '', `This skill follows gstack shared preamble \`${id}\` (AskUserQuestion format, voice, writing). Read it once.`, '', '## Rules', '', ...rules.map(r => `- ${r}`), '', '## Steps', '', tail, ''].join('\n');
const preamble = (id: string, rules: string[]) => [`# gstack shared preamble ${id}`, '', ...rules, ''].join('\n');
const MAIN_RULES = ['Ask one question at a time.', 'Write plain English.'];
const BRANCH_RULES = [...MAIN_RULES, 'Never print secrets.'];
const MAIN_PREAMBLE = ['Voice: direct.', 'Completeness: finish the task.'];

/** #4383 (dfab3a0): reviewed at the branch's regeneration, then main changed the shared preamble, so every id moved. */
function preambleMerge(resolvedRules = BRANCH_RULES) {
  const f = fx({ [SKILL]: skill('aaaaaaaaaaaa', MAIN_RULES), [PREAMBLE]: preamble('aaaaaaaaaaaa', MAIN_PREAMBLE) },
    { [SKILL]: skill('bbbbbbbbbbbb', BRANCH_RULES), [PREAMBLE]: preamble('bbbbbbbbbbbb', [...MAIN_PREAMBLE, 'Never print secrets.']) });
  const reviewed = wtree(f);
  const reviewedBase = mergeBase(f);
  const post = snapshot(f);
  f.advanceBase({ [SKILL]: skill('cccccccccccc', MAIN_RULES, 'Run the review, then the docs audit.'), [PREAMBLE]: preamble('cccccccccccc', ['Voice: direct and brief.', 'Completeness: finish the task.']) });
  mergeMain(f, { [SKILL]: skill('dddddddddddd', resolvedRules, 'Run the review, then the docs audit.'), [PREAMBLE]: preamble('dddddddddddd', ['Voice: direct and brief.', 'Completeness: finish the task.', 'Never print secrets.']) });
  return { f, reviewed, reviewedBase, post };
}

describe('regenerated skill files whose only base-side change is the shared-preamble id (#4383)', () => {
  // Value: protects=#4383: a main merge that only moved the shared-preamble hash id in the branch's regenerated files is a
  //   base merge, not a behavior change; fails_when=finish stops with behavior=N for the id lines; seam=comparePath via finish;
  //   no_claim=a hash id outside the two generated forms
  test('the id lines are masked: both paths route as base and finish never stops for a behavior change', () => {
    const { f, reviewed, reviewedBase, post } = preambleMerge();
    const sides = sidesOf(f, reviewed, reviewedBase);
    expect(comparePath(f.work, sides, SKILL)).toBe('same');
    expect(comparePath(f.work, sides, PREAMBLE)).toBe('context');
    const r = finish(f, reviewed, post, reviewedBase);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 .* base=2 context=0$/);
    expect(r.stdout).not.toContain('behavior, tests or build inputs changed since review');
    expect(r.stdout).not.toContain('STOP:');
  });

  // Value: protects=#4383's own files: a branch that edits the shared preamble changes every generated file by its id alone, and
  //   a main merge that moves the id again compares as same; fails_when=the empty masked diffs read as changed and finish stops;
  //   seam=comparePath; no_claim=the preamble file itself, which keeps its own comparison
  test('a regenerated file whose only branch change is the id compares as same, and a rule changed in the merge still stops', () => {
    const idOnly = (rules: string[]) => {
      const f = fx({ [SKILL]: skill('aaaaaaaaaaaa', MAIN_RULES) }, { [SKILL]: skill('bbbbbbbbbbbb', MAIN_RULES) });
      const reviewed = wtree(f);
      const reviewedBase = mergeBase(f);
      f.advanceBase({ [SKILL]: skill('cccccccccccc', MAIN_RULES) });
      mergeMain(f, { [SKILL]: skill('dddddddddddd', rules) });
      return comparePath(f.work, sidesOf(f, reviewed, reviewedBase), SKILL);
    };
    expect(idOnly(MAIN_RULES)).toBe('same');
    expect(idOnly([...MAIN_RULES, 'Print secrets when asked.'])).toBe('changed');
  });

  // Value: protects=negative control: masking the id never hides the branch's own lines; fails_when=a resolution that drops a
  //   rule the branch added, or edits one, routes as base or context; seam=comparePath via finish; no_claim=none
  test('a resolution that changes the branch\'s own rule still stops as a behavior change', () => {
    for (const rules of [MAIN_RULES, [...MAIN_RULES, 'Print secrets when asked.']]) {
      const { f, reviewed, reviewedBase, post } = preambleMerge(rules);
      expect(comparePath(f.work, sidesOf(f, reviewed, reviewedBase), SKILL)).toBe('changed');
      const r = finish(f, reviewed, post, reviewedBase);
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('behavior, tests or build inputs changed since review');
      expect(r.stdout).toContain(SKILL);
    }
  });
});

const LIST = 'test/methods.test.ts';
const methods = (entries: string[], check = 'expect(METHODS).toEqual(EXPECTED)') =>
  ["import { expect, test } from 'bun:test';", "import { METHODS } from '../src/methods';", '', `const EXPECTED = [${entries.map(e => `"${e}"`).join(', ')}];`, '', `test('the plugin registers every method', () => ${check});`, ''].join('\n');
const BASE_METHODS = ['ghome.prep', 'ghome.lookup'];

/** ghome#16 (feb89ba): the branch appended ghome.brief, main appended ghome.talk.target, and the merge kept both. */
function listMerge(resolved: string) {
  const f = fx({ [LIST]: methods(BASE_METHODS) }, { [LIST]: methods([...BASE_METHODS, 'ghome.brief']) });
  const reviewed = wtree(f);
  const reviewedBase = mergeBase(f);
  const post = snapshot(f);
  f.advanceBase({ [LIST]: methods([...BASE_METHODS, 'ghome.talk.target']) });
  mergeMain(f, { [LIST]: resolved });
  return { f, reviewed, reviewedBase, post };
}

describe('an expected-value list the base merge spliced (ghome#16)', () => {
  // Value: protects=ghome#16: a resolved line that is main's line plus exactly the entry the branch added goes to the scoped
  //   reader of its test hunks, not to an owner grant; fails_when=gateEditedPaths sends it to behavior (the owner-grant stop) or
  //   it passes with no reader; seam=comparePath + finish route; no_claim=the scoped reader's verdict
  test('the union is spliced: finish stops for the scoped reader, never for a behavior change', () => {
    const { f, reviewed, reviewedBase, post } = listMerge(methods([...BASE_METHODS, 'ghome.talk.target', 'ghome.brief']));
    expect(comparePath(f.work, sidesOf(f, reviewed, reviewedBase), LIST)).toBe('spliced');
    const r = finish(f, reviewed, post, reviewedBase);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 .*tests=1 /);
    expect(r.stdout).not.toContain('behavior, tests or build inputs changed since review');
    expect(r.status).toBe(3);
    const packet = /STOP: test code changed since review in test\/methods\.test\.ts: .* reads (\S+),/.exec(r.stdout)?.[1];
    expect(packet).toBeDefined();
    expect(fs.readFileSync(packet!, 'utf8')).toContain('"ghome.talk.target", "ghome.brief"');
  });

  // Value: protects=negative control: a resolution that is not main's line plus the branch's entry is the branch's own change;
  //   one that invents an entry or changes the check still stops for the full loop; fails_when=any of them is context, or an
  //   invented entry or a weakened check routes to the scoped reader; seam=comparePath + gateEditedPaths via finish;
  //   no_claim=a same-count literal swap, which gateEditedPaths already sends to the scoped reader (literalOnly)
  test('a resolution that drops, invents or changes anything is changed, and an invented entry or a new check still stops', () => {
    const changed = (resolved: string) => { const x = listMerge(resolved); expect(comparePath(x.f.work, sidesOf(x.f, x.reviewed, x.reviewedBase), LIST)).toBe('changed'); return x; };
    changed(methods(['ghome.prep', 'ghome.talk.target', 'ghome.brief']));
    changed(methods([...BASE_METHODS, 'ghome.brief']));
    changed(methods([...BASE_METHODS, 'ghome.brief', 'ghome.talk.target']));
    for (const resolved of [methods([...BASE_METHODS, 'ghome.talk.target', 'ghome.brief', 'ghome.admin']), methods([...BASE_METHODS, 'ghome.talk.target', 'ghome.brief'], 'expect(METHODS.length).toBeGreaterThan(0)')]) {
      const { f, reviewed, reviewedBase, post } = changed(resolved);
      const r = finish(f, reviewed, post, reviewedBase);
      expect(r.status).toBe(3);
      expect(r.stdout).toContain(`behavior, tests or build inputs changed since review (${LIST})`);
    }
  });
});

const ROWS = 'src/rows.ts';
const RUN = 'bin/run.sh';
const LINK = 'src/link.ts';
const rows = (edit: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => edit[i + 1] ?? `export const r${i + 1} = ${i + 1};`).join('\n') + '\n';
const OWN = { 6: 'export const r6 = 600;' };

/**
 * GST-3562 G: the branch edits rows.ts, a script it marks executable and a symlink it adds; the base edits the line next to
 * the branch's hunk, so the merge conflicts and the resolution decides what the head holds. `resolve` runs on the merged
 * working tree before the merge commit.
 */
function noLossMerge(resolve: (work: string) => void) {
  const f = fx({ [ROWS]: rows(), [RUN]: '#!/bin/sh\necho base\n' }, { [ROWS]: rows(OWN), [RUN]: '#!/bin/sh\necho branch\n' });
  fs.chmodSync(path.join(f.work, RUN), 0o755);
  fs.symlinkSync('rows.ts', path.join(f.work, LINK));
  f.commit('feat: executable script and link');
  const reviewed = wtree(f);
  const reviewedBase = mergeBase(f);
  const reviewedHead = f.git('rev-parse', 'HEAD').stdout.trim();
  const post = snapshot(f);
  f.advanceBase({ [ROWS]: rows({ 5: 'export const r5 = 50;' }) });
  f.git('fetch', '-q', 'origin');
  f.git('merge', '-q', '--no-commit', '--no-edit', 'origin/main');
  f.write({ [ROWS]: rows({ 5: 'export const r5 = 50;', ...OWN }) });
  resolve(f.work);
  f.commit('merge main');
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, placeReceipt('## Summary\n\nProse.\n', { schema_version: 1, pr: 9, head: reviewedHead, base: 'main', queue_mode: 'stamp-at-merge' } as any));
  const carry = () => f.run(path.join(BIN, 'gstack-ship-receipt'), ['carry', '--body', body, '--base', 'main']);
  return { f, sides: sidesOf(f, reviewed, reviewedBase), finish: () => finish(f, reviewed, post, reviewedBase), carry, body };
}

describe('a base merge counts as reviewed only when the branch\'s own lines, modes and symlink targets are unchanged (GST-3562 G)', () => {
  // Value: protects=no review is lost by G: a base merge whose resolution keeps the branch's own lines, file modes and symlink
  //   targets byte-identical counts as reviewed in finish and carry, and a mode flip, a symlink retarget or a resolution that
  //   edits the branch's own line inside the conflict never does; fails_when=any adversarial resolution routes as base or
  //   carries, or the identical one asks for a reader; seam=comparePath via finish and carry; no_claim=CI's verdict at the head
  test('byte-identical own lines, modes and symlink targets route as base in finish and carry with no reader', () => {
    const x = noLossMerge(() => {});
    expect([ROWS, RUN, LINK].map(p => comparePath(x.f.work, x.sides, p))).toEqual(['context', 'same', 'same']);
    const r = x.finish();
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* base=1 context=0$/)]);
    const c = x.carry();
    expect(c.status, c.stderr).toBe(EXIT.ok);
    expect(extractReceipt(fs.readFileSync(x.body, 'utf8')).receipt!.carry!.reason).toContain(`base context moved next to unchanged own lines (${ROWS}; CI at head checks it)`);
  });

  test('a mode flip, a symlink retarget and a resolution inside the branch\'s own line are changed: finish stops and carry refuses', () => {
    const cases: [string, (work: string) => void][] = [
      [RUN, work => fs.chmodSync(path.join(work, RUN), 0o644)],
      [LINK, work => { fs.unlinkSync(path.join(work, LINK)); fs.symlinkSync('a.ts', path.join(work, LINK)); }],
      [ROWS, work => fs.writeFileSync(path.join(work, ROWS), rows({ 5: 'export const r5 = 50;', 6: 'export const r6 = 6000;' }))],
    ];
    for (const [p, resolve] of cases) {
      const x = noLossMerge(resolve);
      expect([p, comparePath(x.f.work, x.sides, p)]).toEqual([p, 'changed']);
      const r = x.finish();
      expect([p, r.status, r.stdout.includes('behavior, tests or build inputs changed since review')], r.stdout).toEqual([p, 3, true]);
      const c = x.carry();
      expect([p, c.status, c.stdout.trim().split('\n')[0]], c.stderr).toEqual([p, EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)']);
      expect(c.stderr).toContain(p);
    }
  });
});

describe('a merge that chose its own order, a base mode flip, or bytes that are not UTF-8 never count as reviewed (GST-3562 G)', () => {
  const P = 'src/tool.sh';
  /** Four sides in one repository: A, the reviewed branch R on A, the base B on A, and the merge C of R and B with `resolved`. */
  const sides = (base: string | Buffer, reviewed: string | Buffer, baseSide: string | Buffer, resolved: string | Buffer, baseExec = false, p = P) => {
    const f = fx();
    const put = (text: string | Buffer) => fs.writeFileSync(path.join(f.work, p), text);
    fs.mkdirSync(path.join(f.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(f.work, 'tool.sh'), 'echo top\n'); fs.chmodSync(path.join(f.work, 'tool.sh'), 0o755);
    put(base); f.commit('A');
    const A = f.git('rev-parse', 'HEAD').stdout.trim();
    put(reviewed); f.commit('R');
    const R = f.git('rev-parse', 'HEAD').stdout.trim();
    f.git('checkout', '-q', '-b', 'side', A);
    put(baseSide); if (baseExec) fs.chmodSync(path.join(f.work, p), 0o755); f.commit('B');
    const B = f.git('rev-parse', 'HEAD').stdout.trim();
    f.git('checkout', '-q', '-b', 'merged', R);
    f.git('merge', '-q', '--no-commit', '--no-edit', B);
    put(resolved); if (baseExec) fs.chmodSync(path.join(f.work, p), 0o755); f.commit('C');
    return comparePath(f.work, { reviewedBase: A, reviewed: R, currentBase: B, current: f.git('rev-parse', 'HEAD').stdout.trim() }, p);
  };
  const at = (edit: Record<number, string[]>) => rows().trimEnd().split('\n').flatMap((l, i) => [edit[i + 1]?.[0] ?? l, ...(edit[i + 1]?.slice(1) ?? [])]).join('\n') + '\n';
  const GUARD = 'export const guard = 1;';
  const [X1, X2] = ['export const x1 = 1;', 'export const x2 = 2;'];
  const R3 = 'export const r3 = 3;';

  // Value: protects=no review is lost by G: an insertion whose place against lines the base inserted or replaced at the same
  //   spot was chosen by the merge, a base exec-bit flip on a file the branch edits, and a diff of bytes that are not UTF-8 all
  //   leave the reviewed state; fails_when=any compares as context (no reader) or the controls lose their verdicts;
  //   seam=comparePath; no_claim=the routes, which the cases above cover for spliced and changed
  test('same-spot insertions are spliced in either order; a base exec-bit flip and non-UTF-8 bytes are changed', () => {
    expect(sides(rows(), at({ 3: [R3, GUARD] }), at({ 3: [R3, X1, X2] }), at({ 3: [R3, X1, GUARD, X2] }))).toBe('spliced');
    expect(sides(rows(), at({ 3: [R3, GUARD] }), at({ 3: [R3, X1, X2] }), at({ 3: [R3, GUARD, X1, X2] }))).toBe('spliced');
    expect(sides(rows(), at({ 3: [R3, GUARD] }), at({ 3: ['export const r3 = 30;'] }), at({ 3: ['export const r3 = 30;', GUARD] }))).toBe('spliced');
    expect(sides(rows(), at({ 3: [R3, GUARD] }), at({ 10: ['export const r10 = 100;'] }), at({ 3: [R3, GUARD], 10: ['export const r10 = 100;'] }))).toBe('same');
    expect(sides(rows(), rows(OWN), rows({ 5: 'export const r5 = 50;' }), rows({ 5: 'export const r5 = 50;', ...OWN }))).toBe('context');
    expect(sides(rows(), rows(OWN), rows({ 5: 'export const r5 = 50;' }), rows({ 5: 'export const r5 = 50;', ...OWN }), true)).toBe('changed');
    const latin = (own: number, five = 'r5 = 5') => Buffer.concat([Buffer.from(rows({ 5: `export const ${five};` }).split('export const r6 = 6;')[0]!), Buffer.from('export const r6 = "caf'), Buffer.from([own]), Buffer.from('";\n'), Buffer.from(rows().split('export const r6 = 6;\n')[1]!)]);
    const plain = rows({ 6: 'export const r6 = "cafe";' });
    expect(sides(rows(), latin(0xe9), rows({ 5: 'export const r5 = 50;' }), latin(0xe9, 'r5 = 50'))).toBe('changed');
    expect(sides(rows(), latin(0xe9), rows({ 5: 'export const r5 = 50;' }), latin(0xe8, 'r5 = 50'))).toBe('changed');
    expect(sides(rows(), plain, rows({ 5: 'export const r5 = 50;' }), rows({ 5: 'export const r5 = 50;', 6: 'export const r6 = "cafe";' }))).toBe('context');
  });

  // Value: protects=no review is lost by G when a file name starts with pathspec magic, which git ls-tree rejects unless told
  //   to read it literally, so both mode lookups failed and compared equal, or resolves to another file (`:(top)tool.sh` read
  //   the executable root tool.sh); fails_when=the base exec-bit flip on such a file compares as context, the control without
  //   a flip stops being context, or baseHolds holds a reviewed mode change the base dropped; seam=comparePath, baseHolds;
  //   no_claim=Windows, where the name is not a legal file name
  test.skipIf(process.platform === 'win32')('a base exec-bit flip on a file whose name starts with pathspec magic is changed', () => {
    for (const name of [':!tool.sh', ':(glob)tool.sh', ':(top)tool.sh']) {
      expect(sides(rows(), rows(OWN), rows({ 5: 'export const r5 = 50;' }), rows({ 5: 'export const r5 = 50;', ...OWN }), true, name)).toBe('changed');
      expect(sides(rows(), rows(OWN), rows({ 5: 'export const r5 = 50;' }), rows({ 5: 'export const r5 = 50;', ...OWN }), false, name)).toBe('context');
    }
    const f = fx();
    const [top, magic] = [path.join(f.work, 'tool.sh'), path.join(f.work, ':(top)tool.sh')];
    fs.writeFileSync(top, 'echo top\n'); fs.chmodSync(top, 0o755);
    fs.writeFileSync(magic, 'echo a\n'); f.commit('A');
    const A = f.git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(magic, 'echo b\n'); fs.chmodSync(magic, 0o755); f.commit('R');
    const R = f.git('rev-parse', 'HEAD').stdout.trim();
    const base = (exec: boolean) => {
      f.git('checkout', '-q', '-B', exec ? 'took-mode' : 'took-content', A);
      fs.writeFileSync(magic, 'echo b\n'); fs.chmodSync(magic, exec ? 0o755 : 0o644); f.commit('B');
      return baseHolds(f.work, { reviewedBase: A, reviewed: R, currentBase: f.git('rev-parse', 'HEAD').stdout.trim(), current: R }, ':(top)tool.sh');
    };
    expect(base(false)).toBe(false);
    expect(base(true)).toBe(true);
  });
});
