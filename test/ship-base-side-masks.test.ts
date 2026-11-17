/**
 * GST-2975: /ship finish stopped with "behavior, tests or build inputs changed since review" after a base merge whose only
 * effect on the branch's files was base-side: the shared-preamble hash id in regenerated skill files (#4383, 94 files), and
 * main's new entry spliced into an expected-value list the branch also appended to (ghome#16). Both now compare with the
 * base-side difference masked; the spliced list goes to the scoped reader, and a real change to the branch's own lines
 * still stops.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { comparePath } from '../lib/ship-patch';
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
  test('the id lines are masked: the paths route as base or context and finish never stops for a behavior change', () => {
    const { f, reviewed, reviewedBase, post } = preambleMerge();
    const sides = sidesOf(f, reviewed, reviewedBase);
    expect(comparePath(f.work, sides, SKILL)).toBe('same');
    expect(comparePath(f.work, sides, PREAMBLE)).toBe('context');
    const r = finish(f, reviewed, post, reviewedBase);
    expect(lineOf(r.stdout, 'ROUTE')).toMatch(/ behavior=0 .* base=1 context=1$/);
    expect(r.stdout).not.toContain('behavior, tests or build inputs changed since review');
    expect(r.stdout).toContain(`STOP: base context moved next to the reviewed hunks in ${PREAMBLE}`);
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
  test('the union is context: finish stops for the scoped reader, never for a behavior change', () => {
    const { f, reviewed, reviewedBase, post } = listMerge(methods([...BASE_METHODS, 'ghome.talk.target', 'ghome.brief']));
    expect(comparePath(f.work, sidesOf(f, reviewed, reviewedBase), LIST)).toBe('context');
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
