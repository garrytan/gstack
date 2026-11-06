import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDiff, classifyPath, dataCandidate, depthFor, gateScanNeeded, depthOfCommitInput, diffCommand, isGatePath, nextStep, planReview, reviewPlanLine, scanNumbers, DEPTH_RULES, ROLE_EFFORT, FULL_PASS_CAP, SCOPED_RANGE_LINES, type DepthError, type PlanInput } from '../lib/review-depth';
import { summarizeReviewLoop } from '../lib/review-scope';
import { sectionTexts } from '../lib/review-brief';
import { createHash } from 'node:crypto';

const ROOT = path.join(import.meta.dir, '..');
const none = scanNumbers({});
const base = (o: Partial<PlanInput>): PlanInput => ({ paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120, history: { fullPasses: 0, last: 'none' }, numbers: none, ...o });
const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}:${d.effort}`);
const batch = (p: ReturnType<typeof planReview>) => p.dispatches.find(d => d.role === 'specialist' && d.name === 'batched')?.checklists;

describe('classifyPath: agent-read markdown is code', () => {
  test.each([
    ['README.md', 'docs'], ['CHANGELOG.md', 'docs'], ['docs/howto-x.md', 'docs'], ['TODOS.md', 'docs'],
    ['ship/SKILL.md.tmpl', 'code'], ['review/SKILL.md', 'code'], ['ship/sections/review-army.md', 'code'], ['scripts/resolvers/review-army.ts', 'code'],
    ['docs/review-policy.md', 'code'], ['autoplan/DRIVER.md.tmpl', 'code'], ['captain/templates/brief.md', 'code'], ['AGENTS.md', 'code'], ['review/specialists/security.md', 'code'],
    ['test/review-depth.test.ts', 'tests'], ['src/a.test.ts', 'tests'], ['pkg/x_test.go', 'tests'], ['test/fixtures/a.json', 'tests'],
    ['lib/review-depth.ts', 'code'], ['package.json', 'code'],
  ])('%s -> %s', (p, c) => expect(classifyPath(p)).toBe(c as any));
});

describe('classifyDiff', () => {
  test('docs only stays docs', () => expect(classifyDiff({ paths: ['README.md', 'docs/a.md'], gateTagged: null }).class).toBe('docs'));
  test('a skill-template-only diff is code, not docs', () => expect(classifyDiff({ paths: ['ship/SKILL.md.tmpl'], gateTagged: 0 }).class).toBe('code'));
  test('mixed diff takes the most restrictive class', () => {
    expect(classifyDiff({ paths: ['README.md', 'test/a.test.ts'], gateTagged: 0 }).class).toBe('tests');
    expect(classifyDiff({ paths: ['README.md', 'lib/a.ts'], gateTagged: 0 }).class).toBe('code');
  });
  test('a scope error fails closed to code', () => expect(classifyDiff({ paths: ['README.md'], scope: { SCOPE_ERROR: 'unmatched' }, gateTagged: 0 }).class).toBe('code'));
  test('code with the gate scan unavailable fails closed to gate', () => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: null }).class).toBe('gate'));
  test.each([
    [{ scope: { SCOPE_AUTH: 'true' } }], [{ scope: { SCOPE_MIGRATIONS: 'true' } }], [{ gateTagged: 2 }],
    [{ paths: ['lib/a.ts', '.github/workflows/ci.yml'] }], [{ paths: ['lib/a.ts', 'lib/credentials.ts'] }], [{ deleted: ['lib/old.ts'] }],
  ])('gate signal %j raises code to gate', (o: any) => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: 0, ...o }).class).toBe('gate'));
  test('docs never become gate from code-only signals', () => expect(classifyDiff({ paths: ['README.md'], gateTagged: null, deleted: ['docs/old.md'] }).class).toBe('docs'));
});

describe('nextStep: the transition table', () => {
  test('pass 1 is full', () => expect(nextStep({ fullPasses: 0, last: 'none' }).step).toBe('full'));
  test('no edits is done', () => expect(nextStep({ fullPasses: 1, last: 'full' }).step).toBe('done'));
  test('a fixed blocker earns full pass 2', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBlocking: true }).step).toBe('full'));
  test('below-floor fixes earn one fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true }).step).toBe('fix-check'));
  test('a fix touching gate code earns a full pass instead of a fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, touchedGate: true }).step).toBe('full'));
  // R51: two rounds is the cap, a fix-check included. A blocker open or fixed in round 2 stops for the owner (a grant may add
  //   one scoped fix-check); below-floor fixes in round 2 finish with notes; a light pass whose fixes change no runtime lines is done.
  test('a blocker fixed in round 2 stops for the owner, never a third round', () => {
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true })).toMatchObject({ step: 'stop', reason: expect.stringContaining('scoped fix-check') });
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true, touchedGate: true }).step).toBe('stop');
  });
  test('below-floor fixes in round 2 finish with notes, a fix-check included', () => {
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBelow: true })).toMatchObject({ step: 'done', reason: expect.stringContaining('notes') });
    expect(nextStep({ fullPasses: 1, last: 'fix-check', fixedBelow: true })).toMatchObject({ step: 'done', reason: expect.stringContaining('notes') });
    expect(nextStep({ fullPasses: 1, last: 'fix-check', fixedBelow: true, fixedBlocking: true }).step).toBe('stop');
  });
  test('a light pass 1 whose below-floor fixes change no runtime lines is done; a runtime fix or a deeper diff keeps the fix-check', () => {
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, rangeRuntimeLines: 0 }, 'light').step).toBe('done');
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, rangeRuntimeLines: 3 }, 'light').step).toBe('fix-check');
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, rangeRuntimeLines: 0 }, 'full').step).toBe('fix-check');
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true }, 'light').step).toBe('fix-check');
  });
  test('a blocker open at the cap stops', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a blocker open with no fix stops', () => expect(nextStep({ fullPasses: 1, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a fix-check that finds a blocker stops, never a third full pass', () => {
    expect(nextStep({ fullPasses: 1, last: 'fix-check', blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 2, last: 'fix-check', fixedBlocking: true }).step).toBe('stop');
  });
  test('a clean fix-check is done', () => expect(nextStep({ fullPasses: 1, last: 'fix-check' }).step).toBe('done'));
});

// Value: protects=on gate class Step 11's adversarial, outside and targeted voices run before any owner exit the round cap reaches, and a recorded owner grant dispatches its one scoped fix-check after round 2, once; fails_when=a gate-class round-2 blocker fix stops before Step 11 (C6-36 after-opus: next=stop, no voice ran), or a recorded grant still stops (C6-36 after-opus-grant: the lane hand-dispatched the fix-check);
//   why_new=GST-967; seam=nextStep, planReview; no_claim=the voices' or the fix-check's verdicts
describe('GST-967: the round cap limits fix rounds, not the gate-class voices; a recorded grant runs its fix-check', () => {
  const capStop = { fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true } as const;
  test('a gate-class round-2 blocker fix runs Step 11\'s voices before the owner stop, then stops', () => {
    expect(nextStep({ ...capStop, gate: true })).toMatchObject({ step: 'voices', reason: expect.stringContaining("Step 11's voices") });
    for (const o of [{ blockingOpen: true }, { fixedBlocking: false, fixedBelow: true, touchedGate: true }, { fullPasses: 1, last: 'fix-check' as const }, { fullPasses: 1, blockingOpen: true }]) expect(nextStep({ ...capStop, gate: true, ...o }).step).toBe('voices');
    expect(nextStep({ ...capStop, gate: true, adversarialRan: true }).step).toBe('stop');
    expect(nextStep(capStop).step).toBe('stop');
  });
  test('C6-36 run 1 replanned: the plan lists Step 11\'s three voices, and once they ran the stop stands', () => {
    const h = { ...capStop, touchedGate: true };
    const p = planReview(base({ gateTagged: 1, targeted: { classes: ['gate'] }, history: h }));
    expect([p.class, p.next.step, roles(p)]).toEqual(['gate', 'voices', ['adversarial-native:adversarial:full', 'outside-voice:outside-voice:host', 'targeted:targeted:full']]);
    expect(planReview(base({ gateTagged: 1, adversarialRan: true, targeted: { classes: ['gate'] }, history: h })).next.step).toBe('stop');
  });
  test('a recorded grant dispatches one scoped fix-check after a round-2 full pass, after the gate-class voices, and never a second', () => {
    const g = { ...capStop, granted: 'a-feb4aba31633' };
    expect(nextStep(g)).toMatchObject({ step: 'fix-check', reason: expect.stringContaining('a-feb4aba31633') });
    expect(roles(planReview(base({ history: g })))).toEqual(['fix-check:fix-check:full']);
    expect(nextStep({ ...g, gate: true }).step).toBe('voices');
    expect(nextStep({ ...g, gate: true, adversarialRan: true }).step).toBe('fix-check');
    expect(nextStep({ ...g, fixedBlocking: false, fixedBelow: true, touchedGate: true }).step).toBe('fix-check');
    expect(nextStep({ fullPasses: 1, last: 'fix-check', fixedBlocking: true, granted: 'a-1' }).step).toBe('stop');
    expect(nextStep({ ...g, blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'fix-check', granted: 'a-1' }).step).toBe('done');
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'fix-check', fixedBlocking: true, granted: 'a-1' }).step).toBe('stop');
  });
  // Value: protects=a recorded grant gets its one fix-check when round 2 was itself a fix-check (GEVA-223), without restating
  //   history as a full pass; fails_when=the planner prints stop despite the grant, runs a second granted fix-check, or grants
  //   one with a blocker open; seam=nextStep; no_claim=the CLI's grant binding to the stop head
  test('a recorded grant after a round-2 fix-check runs its one fix-check, and never a second (GEVA-223)', () => {
    const h = { fullPasses: 1, last: 'fix-check', fixedBlocking: true, granted: 'a-a17f3fd0a47a', fixChecks: 1 } as const;
    expect(nextStep(h)).toMatchObject({ step: 'fix-check', reason: expect.stringContaining('a-a17f3fd0a47a') });
    expect(nextStep({ ...h, fixedBlocking: false, touchedGate: true }).step).toBe('fix-check');
    expect(nextStep({ ...h, gate: true }).step).toBe('voices');
    expect(nextStep({ ...h, gate: true, adversarialRan: true }).step).toBe('fix-check');
    for (const o of [{ fixChecks: 2 }, { fixChecks: undefined }, { blockingOpen: true }, { granted: undefined }, { fullPasses: FULL_PASS_CAP }]) expect([o, nextStep({ ...h, ...o }).step]).toEqual([o, 'stop']);
  });
  // Value: protects=after a fix-check, edits after the review bound (--post-review) with a new recorded grant plan one more fix-check,
  //   the next link of finish's chain, in either panel and after Step 11 on gate class; without a grant, with a blocker open, or
  //   outside --post-review it stays a stop; fails_when=the planner tells the lane to get a grant and then ignores it (GST-1676);
  //   seam=nextStep; no_claim=the CLI's binding of the grant to a stop head after the last fix-check's commit
  test('a new grant after a fix-check plans the next chained fix-check for edits after the review bound (GST-1676)', () => {
    const h = { fullPasses: FULL_PASS_CAP, last: 'fix-check', touchedGate: true, fixedBelow: false, granted: 'a-060fed2b73ee', fixChecks: 2, postReview: true } as const;
    expect(nextStep(h)).toMatchObject({ step: 'fix-check', reason: expect.stringContaining('a-060fed2b73ee') });
    expect(nextStep({ ...h, lean: true }).step).toBe('fix-check');
    expect(nextStep({ ...h, fullPasses: 1, fixChecks: 1 }).step).toBe('fix-check');
    expect(nextStep({ ...h, gate: true }).step).toBe('voices');
    expect(nextStep({ ...h, gate: true, adversarialRan: true }).step).toBe('fix-check');
    for (const o of [{ granted: undefined }, { blockingOpen: true }, { postReview: false }, { postReview: undefined }]) expect([o, nextStep({ ...h, ...o }).step]).toEqual([o, 'stop']);
    expect(nextStep({ ...h, last: 'full', fullPasses: 1, fixedBelow: true }).step).toBe('full');
  });
  // Value: protects=in the loop, a grant the CLI bound to the last fix-check's own stop head (`chained`) plans one more fix-check
  //   after any number of fix-checks (GEVA-363's third round), after Step 11 on gate class; without that binding a fix-check still
  //   never earns another; fails_when=the planner prints stop for a new grant (GST-1681) or plans one for an unbound grant;
  //   seam=nextStep; no_claim=the CLI's binding (test/review-plan-cli.test.ts)
  test('a new grant bound to the last fix-check\'s stop plans the next chained fix-check in the loop (GST-1681)', () => {
    const h = { fullPasses: 1, last: 'fix-check', fixedBlocking: true, granted: 'a-5214be46db1e', fixChecks: 2, chained: true } as const;
    expect(nextStep(h)).toMatchObject({ step: 'fix-check', reason: expect.stringContaining('a-5214be46db1e') });
    expect(nextStep({ ...h, lean: true }).step).toBe('fix-check');
    expect(nextStep({ ...h, fullPasses: FULL_PASS_CAP }).step).toBe('fix-check');
    expect(nextStep({ ...h, gate: true }).step).toBe('voices');
    expect(nextStep({ ...h, gate: true, adversarialRan: true }).step).toBe('fix-check');
    for (const o of [{ chained: false }, { chained: undefined }, { granted: undefined }, { blockingOpen: true }]) expect([o, nextStep({ ...h, ...o }).step]).toEqual([o, 'stop']);
    expect(nextStep({ ...h, fixedBlocking: false }).step).toBe('done');
  });
  test('docs/review-policy.md\'s transitions table and rule 3 say both', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'review-policy.md'), 'utf8');
    const table = doc.slice(doc.indexOf('<a id="transitions"></a>'), doc.indexOf('A **fix-check** is one reviewer'));
    expect(table).toContain("| a stop (any row above) on gate class before Step 11's voices ran | Step 11's voices (adversarial, outside, targeted), then ask again with `--adversarial-ran` |");
    expect(table).toContain('| a round-2 full pass that stops for a fixed blocking finding or a gate-class edit, with the owner\'s recorded grant (`--grant <approval id>`) | one scoped fix-check (round 3), after Step 11 on gate class |');
    const rule3 = doc.slice(doc.indexOf('3. **Two rounds is the cap**'), doc.indexOf('<a id="transitions"></a>')).replace(/\s+/g, ' ');
    expect(rule3).toContain("The cap limits fix rounds, not Step 11's voices");
    expect(rule3).toContain('`gstack-review-plan --grant <approval id> --range-base <round 2\'s PASS_HEAD>`');
  });
});

/**
 * GST-967's safety property, as a permanent invariant over the transitions table (Captain, 2026-11-02: the invariant is the
 * gate, a reader the second check). Every state: passes 0-3, each last step, every mix of the four fix flags, gate class or
 * not, Step 11 run or not, grant recorded or not.
 */
describe('GST-967 invariant: no gate-class owner exit before Step 11\'s voices; a recorded grant always gets its fix-check', () => {
  // Value: protects=a gate-class plan never stops (the exit where the owner may ship with open notes) before Step 11's adversarial, outside and targeted voices ran, voices is planned only then and dispatches all three, and a recorded grant always turns the stop after a round-2 full pass with a fixed finding into exactly one fix-check while changing nothing else, so it never repeats; fails_when=any state breaks one of those, so a later edit to nextStep cannot fail open;
  //   why_new=GST-967 (three earlier fixes failed open and a reviewer caught each after the fact); seam=nextStep, planReview; no_claim=the parent following NEXT
  test('every state of the table holds the property', () => {
    let states = 0, voices = 0, grants = 0;
    for (const fullPasses of [0, 1, 2, 3]) for (const last of ['none', 'full', 'fix-check'] as const) for (let bits = 0; bits < 16; bits++)
      for (const gate of [false, true]) for (const adversarialRan of [false, true]) {
        const h = { fullPasses, last, fixedBlocking: !!(bits & 1), fixedBelow: !!(bits & 2), blockingOpen: !!(bits & 4), touchedGate: !!(bits & 8), gate, adversarialRan };
        const plain = nextStep(h), granted = nextStep({ ...h, granted: 'a-1' });
        const ungatedStop = nextStep({ ...h, gate: false }).step === 'stop';
        states++;
        for (const n of [plain, granted]) {
          if (gate && !adversarialRan) expect(n.step).not.toBe('stop');
          if (n.step === 'voices') expect([gate, adversarialRan, ungatedStop]).toEqual([true, false, true]);
        }
        if (plain.step === 'voices') voices++;
        const owed = ungatedStop && !h.blockingOpen && last === 'full' && fullPasses === FULL_PASS_CAP && (!gate || adversarialRan);
        if (owed) grants++;
        expect([granted.step === 'fix-check' && plain.step !== 'fix-check', granted.step === plain.step]).toEqual([owed, !owed]);
        if (owed) expect(granted.reason).toContain('a-1');
      }
    expect(states).toBe(4 * 3 * 16 * 2 * 2);
    expect([voices > 0, grants > 0]).toEqual([true, true]);
    const gatePlan = (o: Partial<PlanInput>) => planReview(base({ gateTagged: 1, targeted: { classes: ['gate'] }, ...o }));
    for (const fullPasses of [1, 2]) for (const last of ['full', 'fix-check'] as const) for (let bits = 0; bits < 16; bits++) {
      const p = gatePlan({ history: { fullPasses, last, fixedBlocking: !!(bits & 1), fixedBelow: !!(bits & 2), blockingOpen: !!(bits & 4), touchedGate: !!(bits & 8), granted: bits & 1 ? 'a-1' : undefined } });
      expect(p.next.step).not.toBe('stop');
      if (p.next.step === 'voices') expect(p.dispatches.map(d => d.role)).toEqual(['adversarial-native', 'outside-voice', 'targeted']);
    }
  });
});

/**
 * The GST-967 dispatch-superset no-loss check (crew rule 2026-10-30; replay 'GST-967' in test/fixtures/review-pins/replays/GST-967.json).
 * On a 1,440-case grid (five diffs: light, standard, gate, docs, tests; passes 0-2; last none, full or fix-check; every mix of
 * the four fix flags; Step 11 run or not), main's planReview at 1022f4f (v1.92.81.0) hashes to MAIN_PLANS. The branch's plan,
 * with each voices step read back as main's stop (its reason is the parenthesised tail, no dispatch), hashes to the same value,
 * and every voices step is a gate-class stop before Step 11 that adds exactly Step 11's three voices. No grant is passed (main
 * takes none). The brief bodies lib/review-brief.ts cuts from the ship sections hash to MAIN_SECTIONS: main's bodies plus
 * GST-508's exclude-pathspec placeholders (replay 'GST-508+GST-464+GST-967': the merged bodies minus main's are the wave's minus fc292e22f).
 */
const MAIN_PLANS = '9d13d6bae86bfc9207ce7e0cec8da5b33db2518c1653e8e009160a98b0f04c89';
const MAIN_SECTIONS = 'cec8872ff5a4aacb610133294706e452952b172fbe9c4891039679e98d895f62';
describe('GST-967 dispatch-superset no-loss check', () => {
  // Value: protects=the no-loss rule for review-depth changes: GST-967 drops, renames and re-efforts no reviewer main dispatches on any grid case, and changes no brief body; fails_when=a non-stop plan changes, a voices step appears off gate class or after Step 11, it dispatches anything but the three voices, or a brief body moves;
  //   why_new=GST-967; seam=planReview, sectionTexts; no_claim=what the added voices find (they only add coverage)
  test('the grid matches main except gate-class stops before Step 11, which add only the three voices; brief bodies are main\'s', () => {
    const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const fixtures: Record<string, Partial<PlanInput>> = {
      light: { paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120 },
      standard: { paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120, floor: 'standard' },
      gate: { paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true' }, gateTagged: 1, diffLines: 120, targeted: { classes: ['gate'] } },
      docs: { paths: ['README.md'], scope: {}, gateTagged: null, diffLines: 30 },
      tests: { paths: ['test/a.test.ts'], scope: { SCOPE_TESTS: 'true' }, gateTagged: 0, diffLines: 40 },
    };
    const rows: unknown[] = [];
    let voices = 0;
    for (const [name, f] of Object.entries(fixtures)) for (const fullPasses of [0, 1, 2]) for (const last of ['none', 'full', 'fix-check'] as const) for (let bits = 0; bits < 16; bits++) for (const adversarialRan of [false, true]) {
      const history = { fullPasses, last, fixedBlocking: !!(bits & 1), fixedBelow: !!(bits & 2), blockingOpen: !!(bits & 4), touchedGate: !!(bits & 8) };
      const p = planReview({ ...f, numbers: none, history, adversarialRan } as PlanInput);
      let { step, reason } = p.next;
      let dispatches = p.dispatches;
      if (step === 'voices') {
        voices++;
        expect([p.class, adversarialRan, dispatches.map(d => `${d.role}:${d.effort}`)]).toEqual(['gate', false, ['adversarial-native:full', 'outside-voice:host', 'targeted:full']]);
        [step, reason, dispatches] = ['stop', reason.slice(reason.indexOf('--adversarial-ran (') + '--adversarial-ran ('.length, -1), []];
      }
      rows.push({ name, fullPasses, last, bits, adversarialRan, class: p.class, step, reason, dispatches, skipped: p.skipped });
    }
    expect([rows.length, voices, sha(rows)]).toEqual([1440, 71, MAIN_PLANS]);
    expect(sha(sectionTexts(ROOT))).toBe(MAIN_SECTIONS);
  });
});

describe('GST-972 follow-up: review-exclude and default-base are gate paths; harness pins are code', () => {
  // Value: protects=full review on edits to what reviewers never see (review-exclude) and to the diff base (default-base), and code-class review on harness pin edits; fails_when=either module plans light depth with no gate class, or a scripts/harness-pins file classifies as tests or as unconsumed data;
  //   why_new=GST-972 item 4 and the GST-1084 pin split (#3903) dropped both to light or test-only plans; seam=classifyPath, classifyDiff, planReview; no_claim=what the reviewers find
  test.each(['lib/review-exclude.ts', 'lib/default-base.ts'])('%s is a gate path: gate class, full depth', p => {
    expect(isGatePath(p)).toBe(true);
    const c = classifyDiff({ paths: [p], gateTagged: 0, perPath: [{ path: p, lines: 1, binary: false }] });
    expect([c.class, depthFor({ cls: c.class, runtimeLines: c.runtimeLines ?? 0, errors: c.errors, risk: c.risk })]).toEqual(['gate', 'full']);
  });
  test('a harness pin is code, never test or data; a review pin fixture stays tests', () => {
    expect(['scripts/harness-pins/test/helpers/e2e-gate.ts.json', 'scripts/harness-pins/scripts/lib/paid-plan.ts.json'].map(p => [classifyPath(p), dataCandidate(p)])).toEqual([['code', false], ['code', false]]);
    expect(classifyPath('test/fixtures/review-pins/files/lib/review-depth.ts.json')).toBe('tests');
  });
  test('a harness helper edit with its pin plans the code-class reviewers, even when no code names the pin', () => {
    const paths = ['test/helpers/e2e-gate.ts', 'scripts/harness-pins/test/helpers/e2e-gate.ts.json'];
    const p = planReview(base({ paths, scope: { SCOPE_TESTS: 'true' }, diffLines: 20, consumed: [] }));
    expect([p.class, roles(p)]).toEqual(['code', ['specialist:batched:full', 'adversarial-native:adversarial:full']]);
    expect(batch(p)).toEqual(expect.arrayContaining(['testing', 'security']));
  });
});

/**
 * The GST-972 follow-up no-loss check (crew rule 2026-10-30; replay 'GST-972' in test/fixtures/review-pins/replays/GST-972.json).
 * On the GST-967 history grid, each changed case runs on its real paths and on a stand-in (a path main and the branch both
 * classify the way main classified the real one). Main's planReview at 1ccab0d (v1.94.24.0) on the real paths hashes to
 * MAIN_972_PLANS, and so does the branch's on the stand-ins, so the stand-in plans are main's. On the real paths the branch only
 * raises class and depth and keeps every reader main dispatched, at the same effort or higher, with one exception: light's
 * batched reader, which carries the Red Team prompt at full effort, becomes full depth's batched reader at the specialist
 * effort, while the Red Team keeps full effort as its own dispatch.
 */
const MAIN_972_PLANS = '798e56faf8a44c182b77e1638b9a80c554a5d727bb56a84786b1c11507b31030';
describe('GST-972 follow-up no-loss check', () => {
  // Value: protects=the no-loss rule for review-depth changes: the GST-972 follow-up drops no reviewer main dispatched and lowers no class, depth or effort beyond the named Red Team split; fails_when=a stand-in stops matching main's plans, a reader disappears, a class or depth falls, or an effort falls anywhere else;
  //   why_new=GST-972 follow-up; seam=planReview; no_claim=what the added readers find (they only add coverage)
  test('the changed cases only raise class and depth and keep every reader main dispatched', () => {
    const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const cases: Record<string, [string[], string[], Record<string, string>]> = {
      'review-exclude': [['lib/review-exclude.ts'], ['lib/plain-module.ts'], { SCOPE_BACKEND: 'true' }],
      'default-base': [['lib/default-base.ts'], ['lib/plain-module.ts'], { SCOPE_BACKEND: 'true' }],
      'helper+pin': [['test/helpers/e2e-gate.ts', 'scripts/harness-pins/test/helpers/e2e-gate.ts.json'], ['test/helpers/e2e-gate.ts', 'test/helpers/e2e-gate.ts.json'], { SCOPE_TESTS: 'true' }],
      pin: [['scripts/harness-pins/scripts/lib/paid-plan.ts.json'], ['scripts/lib/paid-plan.ts.json'], {}],
    };
    const grid = (pick: 0 | 1) => {
      const rows: { name: string; fullPasses: number; last: string; bits: number; adversarialRan: boolean; class: string; depth: string; step: string; dispatches: { role: string; name: string; effort: string; checklists: string[] }[] }[] = [];
      for (const [name, c] of Object.entries(cases)) for (const fullPasses of [0, 1, 2]) for (const last of ['none', 'full', 'fix-check'] as const) for (let bits = 0; bits < 16; bits++) for (const adversarialRan of [false, true]) {
        const history = { fullPasses, last, fixedBlocking: !!(bits & 1), fixedBelow: !!(bits & 2), blockingOpen: !!(bits & 4), touchedGate: !!(bits & 8) };
        const p = planReview({ paths: c[pick], scope: c[2], gateTagged: 0, diffLines: 40, consumed: [], numbers: none, history, adversarialRan });
        rows.push({ name, fullPasses, last, bits, adversarialRan, class: p.class, depth: p.depth, step: p.next.step, dispatches: p.dispatches.map(d => ({ role: d.role, name: d.name, effort: d.effort, checklists: d.checklists ?? [] })) });
      }
      return rows;
    };
    const main = grid(1);
    expect(sha(main)).toBe(MAIN_972_PLANS);
    const rank: Record<string, number> = { docs: 0, tests: 1, code: 2, gate: 3, light: 0, standard: 1, full: 2, medium: 1, host: 2 };
    const readers = (r: (typeof main)[number]) => new Map(r.dispatches.flatMap(d => d.role === 'specialist' ? d.checklists.map(c => [c === 'red-team' ? 'red-team' : `checklist:${c}`, d.effort] as const) : [[d.role, d.effort] as const]));
    const moves: Record<string, number> = {};
    let split = 0;
    grid(0).forEach((b, i) => {
      const m = main[i]!;
      const move = `${m.name}: ${m.class}/${m.depth} -> ${b.class}/${b.depth}`;
      moves[move] = (moves[move] ?? 0) + 1;
      expect([rank[b.class]! >= rank[m.class]!, rank[b.depth]! >= rank[m.depth]!]).toEqual([true, true]);
      const mr = readers(m), br = readers(b);
      for (const [reader, effort] of mr) {
        expect([move, reader, br.has(reader)]).toEqual([move, reader, true]);
        if (rank[br.get(reader)!]! >= rank[effort]!) continue;
        expect([reader.startsWith('checklist:'), m.depth, effort, br.get(reader), mr.get('red-team'), br.get('red-team')]).toEqual([true, 'light', 'full', ROLE_EFFORT.specialist, 'full', 'full']);
        split++;
      }
    });
    expect([main.length, split, moves]).toEqual([1152, 168, {
      'review-exclude: code/light -> gate/full': 288, 'default-base: code/light -> gate/full': 288, 'helper+pin: tests/light -> code/light': 288, 'pin: docs/light -> code/light': 288,
    }]);
  });
});

describe('scanNumbers', () => {
  test('finds claims and fingerprints them', () => {
    const a = scanNumbers({ 'docs/bench.md': ['Median dropped 48% to 1.2s', 'no numbers here'] });
    expect(a).toMatchObject({ publishes: true, claims: 1 });
    expect(scanNumbers({ 'docs/bench.md': ['Median dropped 47% to 1.2s'] }).fingerprint).not.toBe(a.fingerprint);
  });
  test('versions, dates, issue and step numbers and plain prose are not claims', () => expect(scanNumbers({ 'CHANGELOG.md': ['## [1.91.283.0] - 2026-10-27', 'Fixes the ship loop (#3516), see Step 9.4 and rule 23.'] }).publishes).toBe(false));
  test.each([
    ['the smallest two-sided p with 16 clusters is 2 x 0.5^6 = 0.031'],
    ['the miss split is 10/52'], ['p falls to 3.05e-5'], ['median 1.4 passes per PR'], ['Hot-memory hits: 10 of 62'],
  ])('a bare numeric claim counts: %s', line => expect(scanNumbers({ 'docs/comparing-runs.md': [line] }).publishes).toBe(true));
});

describe('planReview', () => {
  test('docs class: core only, no outside voice', () => {
    const p = planReview(base({ paths: ['README.md'], scope: {}, gateTagged: null, diffLines: 300 }));
    expect(p.class).toBe('docs');
    expect(p.dispatches).toEqual([]);
  });
  test('docs class with numeric claims keeps the outside voice', () => {
    const p = planReview(base({ paths: ['docs/bench.md'], scope: {}, numbers: scanNumbers({ 'docs/bench.md': ['3x faster'] }) }));
    expect(roles(p)).toEqual(['outside-voice:outside-voice:host']);
  });
  test('tests class: runtime 0 is light, core only (Behavior changes: no Testing specialist)', () => {
    const p = planReview(base({ paths: ['test/a.test.ts'], scope: { SCOPE_TESTS: 'true' } }));
    expect(p.depth).toBe('light');
    expect(roles(p)).toEqual([]);
  });
  test('non-risky code pass 1 is light at any size (R51): one batched reader carrying the Red Team prompt and the native adversarial', () => {
    const p = planReview(base({ diffLines: 900 }));
    expect([p.depth, roles(p)]).toEqual(['light', ['specialist:batched:full', 'adversarial-native:adversarial:full']]);
  });
  test('code class pass 1 at standard: specialists at medium, the native adversarial at full, the outside voice at its own', () => {
    const p = planReview(base({ floor: 'standard' }));
    expect(roles(p)).toEqual(['specialist:batched:medium', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
    expect(batch(p)).toEqual(['testing', 'security']);
    expect(p.skipped).toContain('maintainability, performance, simplification (lean ensemble: read only when forced)');
  });
  test('gate class forces red team and ignores hit-rate gating', () => {
    const p = planReview(base({ gateTagged: 1, gated: ['security', 'state-machines'], scope: { SCOPE_BACKEND: 'true' } }));
    expect(roles(p)).toContain('red-team:red-team:full');
    expect(batch(p)).toEqual(['testing', 'security', 'state-machines']);
  });
  test('code class honours hit-rate gating and small-diff skip', () => {
    const sm = { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'true' };
    expect(batch(planReview(base({ scope: sm })))).toContain('state-machines');
    const gated = planReview(base({ scope: sm, gated: ['state-machines'] }));
    expect(batch(gated)).not.toContain('state-machines');
    expect(gated.skipped).toContain('state-machines (gated by hit rate)');
    expect(planReview(base({ diffLines: 20 })).dispatches.filter(d => d.role === 'specialist').map(d => d.name)).toEqual(['batched']);
  });
  test('pass 2 reruns the army on the range but not the adversarial or outside voice once Step 11 ran', () => {
    const p = planReview(base({ adversarialRan: true, history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(p.next.step).toBe('full');
    expect(roles(p).some(r => r.startsWith('outside-voice') || r.startsWith('adversarial'))).toBe(false);
  });
  test('a repeat that became code class keeps the adversarial pass Step 11 has not run yet', () => {
    const p = planReview(base({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(roles(p)).toContain('adversarial-native:adversarial:full');
    expect(planReview(base({ paths: ['docs/a.md'], history: { fullPasses: 1, last: 'full', fixedBlocking: true } })).dispatches.some(d => d.role === 'adversarial-native')).toBe(false);
  });
  test('a fix-check is one full-effort dispatch', () => {
    expect(roles(planReview(base({ history: { fullPasses: 1, last: 'full', fixedBelow: true } })))).toEqual(['fix-check:fix-check:full']);
  });
  test('changed numeric claims rerun only the outside voice', () => {
    const numbers = scanNumbers({ 'docs/bench.md': ['3x faster'] });
    const p = planReview(base({ numbers, reviewedNumbers: 'old', history: { fullPasses: 1, last: 'full', fixedBelow: true } }));
    expect(roles(p)).toEqual(['fix-check:fix-check:full', 'outside-voice:outside-voice (numbers changed):host']);
  });
  // Value: protects=GSTA-167 part 3 (specialists at medium, CREW 30c) without moving the GSTA-131 lesson (a light fix-check missed
  //   a fail-open a full one caught): Red Team, native adversarial and fix-check stay full; fails_when=any of those drops below
  //   full, a specialist leaves medium, or --no-tiers leaves a specialist off the host default; seam=planReview
  test('specialists run at medium; the Red Team, native adversarial and fix-check stay full; --no-tiers sends specialists to host', () => {
    for (const h of [{ fullPasses: 0, last: 'none' }, { fullPasses: 1, last: 'full', fixedBelow: true }, { fullPasses: 1, last: 'full', fixedBlocking: true }] as const) {
      const d = planReview(base({ gateTagged: 1, history: h })).dispatches;
      expect(d.filter(x => x.role === 'specialist').every(x => x.effort === 'medium')).toBe(true);
      expect(d.filter(x => ['red-team', 'adversarial-native', 'fix-check'].includes(x.role)).every(x => x.effort === 'full')).toBe(true);
      expect(d.filter(x => x.role === 'outside-voice').every(x => x.effort === 'host')).toBe(true);
    }
    const gate = planReview(base({ gateTagged: 1 })).dispatches;
    expect(gate.map(x => x.role)).toEqual(expect.arrayContaining(['specialist', 'red-team', 'adversarial-native']));
    const host = planReview(base({ gateTagged: 1, tiers: false })).dispatches;
    expect(host.filter(x => x.role === 'specialist').every(x => x.effort === 'host')).toBe(true);
    expect(host.filter(x => x.role === 'red-team' || x.role === 'adversarial-native').every(x => x.effort === 'full')).toBe(true);
  });
  test('done dispatches nothing', () => expect(planReview(base({ history: { fullPasses: 1, last: 'full' } })).dispatches).toEqual([]));
});

describe('GSTA-131 pass-1 review repairs', () => {
  test('rule docs agents follow are code, and markdown inside a skill directory is code when the root is known', () => {
    for (const p of ['docs/captain.md', 'docs/unattended.md', 'docs/pregate.md']) expect(classifyPath(p)).toBe('code');
    expect(classifyPath('autoplan/notes.md')).toBe('docs');
    expect(classifyPath('autoplan/notes.md', ROOT)).toBe('code');
    expect(classifyPath('docs/howto-x.md', ROOT)).toBe('docs');
  });
  test.each([
    [{ gateTagged: 3 }], [{ gateTagged: null }], [{ deleted: ['test/old.test.ts'] }],
  ])('a tests-only diff with gate signal %j is gate class', (o: any) => expect(classifyDiff({ paths: ['test/a.test.ts'], gateTagged: 0, ...o }).class).toBe('gate'));
  test('a version-only package.json stays docs; the same path with any other edit is code', () => {
    expect(classifyDiff({ paths: ['package.json', 'CHANGELOG.md'], stampOnly: ['package.json'], gateTagged: 0 }).class).toBe('docs');
    expect(classifyDiff({ paths: ['package.json', 'CHANGELOG.md'], gateTagged: 0 }).class).toBe('code');
  });
  test('an open blocker never routes to a fix-check, even when other fixes landed', () => {
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBlocking: true, blockingOpen: true }).step).toBe('stop');
  });
  test('code and test source publish no numbers; prose and data files do', () => {
    expect(scanNumbers({ 'test/a.test.ts': ['const n = 3;', 'for (let i = 0; i < 10; i++)', 'expect(x).toBe(0.5)'] }).publishes).toBe(false);
    expect(scanNumbers({ 'test/fixtures/bench.json': ['{ "ratio": 0.74 }'] }).publishes).toBe(true);
  });
  test('--all-specialists forces every specialist; a code diff past 200 lines or with a CRITICAL adds the Red Team', () => {
    const all = planReview(base({ floor: 'standard', force: 'all' }));
    expect(all.dispatches.filter(d => d.role === 'specialist').length).toBe(1);
    expect([...batch(all)!].sort()).toEqual(['api-contract', 'data-migration', 'design', 'maintainability', 'performance', 'security', 'simplification', 'state-machines', 'testing']);
    const has = (o: Partial<PlanInput>) => roles(planReview(base({ floor: 'standard', ...o }))).some(r => r.startsWith('red-team'));
    expect(has({ diffLines: 120 })).toBe(false);
    expect(has({ diffLines: 201 })).toBe(true);
    expect(has({ diffLines: 120, criticalFound: true })).toBe(true);
  });
});

describe('GSTA-131 coverage: Red Team and specialist arms', () => {
  const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}`);
  test('Red Team runs on code past 200 lines or after a CRITICAL, and on every gate diff', () => {
    expect(roles(planReview(base({ diffLines: 120, floor: 'standard' })))).not.toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 201, floor: 'standard' })))).toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 120, floor: 'standard', criticalFound: true })))).toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 20, gateTagged: 1 })))).toContain('red-team:red-team');
  });
  test('scope arms select their specialist, state machines default on when scope is unknown, and --force all reaches docs class', () => {
    const picked = (scope: Record<string, string>) => batch(planReview(base({ floor: 'standard', scope: { SCOPE_STATE_MACHINE: 'false', ...scope } })));
    expect(picked({ SCOPE_MIGRATIONS: 'true' })).toContain('data-migration');
    expect(picked({ SCOPE_API: 'true' })).toContain('api-contract');
    expect(picked({ SCOPE_FRONTEND: 'true' })).toEqual(['testing', 'security', 'design']);
    expect(batch(planReview(base({ scope: {} })))).toContain('state-machines');
    expect(batch(planReview(base({ scope: { SCOPE_STATE_MACHINE: 'false' } })))).not.toContain('state-machines');
    expect(batch(planReview(base({ floor: 'standard', force: ['maintainability'] })))).toEqual(['testing', 'security', 'maintainability']);
    expect(batch(planReview(base({ floor: 'standard', gated: ['design'], scope: { SCOPE_FRONTEND: 'true', SCOPE_STATE_MACHINE: 'false' } })))).toEqual(['testing', 'security']);
    const docsAll = planReview(base({ paths: ['docs/a.md'], force: 'all' }));
    expect(docsAll.class).toBe('docs');
    expect(docsAll.dispatches.filter(d => d.role === 'specialist').length).toBeGreaterThan(5);
    expect(roles(planReview(base({ paths: ['docs/a.md'], force: ['security'] })))).toEqual(['specialist:security']);
  });
});

const per = (o: Record<string, number>) => Object.entries(o).map(([p, lines]) => ({ path: p, lines, binary: false }));
const mixed = (o: Partial<PlanInput> = {}) => base({ paths: Object.keys(o.perPath ? Object.fromEntries(o.perPath.map(e => [e.path, 1])) : {}), ...o });
const err = (code: DepthError['code'], result?: DepthError['result']): DepthError => ({ code, detail: 'd', input: 'i', repair: 'r', ...(result ? { result } : {}) });

describe('review depth: the matrix', () => {
  test('runtime 0 (tests and docs only) is light: core only, nothing dispatched', () => {
    const p = planReview(mixed({ perPath: per({ 'test/a.test.ts': 300, 'docs/a.md': 40 }), diffLines: 340 }));
    expect([p.depth, p.runtimeLines, p.dispatches]).toEqual(['light', 0, []]);
  });
  test('runtime 1-50 is light plus one batched specialist: the fixed set, scope picks and the Red Team in one context', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 48, 'test/a.test.ts': 190, 'docs/a.md': 9 }), diffLines: 247 }));
    expect([p.depth, p.runtimeLines]).toEqual(['light', 48]);
    expect(p.dispatches).toEqual([
      { role: 'specialist', name: 'batched', effort: 'full', exclude: [':(exclude)docs/a.md'], checklists: ['testing', 'security', 'red-team'] },
      { role: 'adversarial-native', name: 'adversarial', effort: 'full', exclude: [], reason: 'backtest inconclusive (GSTA-147 D5)' },
    ]);
    expect(p.skipped.join('; ')).toContain('red-team (light depth');
    expect(planReview(mixed({ perPath: per({ 'src/app.ts': 48 }), adversarialRan: true, history: { fullPasses: 1, last: 'full', touchedGate: true, fixedBelow: true } })).dispatches.some(d => d.role === 'adversarial-native')).toBe(false);
  });
  test('runtime 51 non-risky code stays light (R51: size never raises the depth)', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 51, 'test/a.test.ts': 400, 'README.md': 3 }), diffLines: 454 }));
    expect([p.depth, p.runtimeLines, roles(p)]).toEqual(['light', 51, ['specialist:batched:full', 'adversarial-native:adversarial:full']]);
  });
  test('standard (floor or raise): thresholds read runtime lines, reviewers read their own hunks', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 51, 'test/a.test.ts': 400, 'README.md': 3 }), diffLines: 454, floor: 'standard' }));
    expect([p.depth, p.runtimeLines]).toEqual(['standard', 51]);
    expect(roles(p)).toEqual(['specialist:batched:medium', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
    expect(batch(p)).toEqual(['testing', 'security']);
    const ex = Object.fromEntries(p.dispatches.map(d => [d.name, d.exclude]));
    expect(ex.batched).toEqual([':(exclude)README.md']);
    expect([ex.adversarial, ex['outside-voice']]).toEqual([[], []]);
  });
  test.each([
    ['scope error', { scope: { SCOPE_ERROR: 'boom' } }, 'scope_error', []],
    ['gate scan unavailable', { gateTagged: null }, 'gate_scan_unavailable', []],
    ['base registry invalid', { registry: { sha: 'abc', outputs: [], error: err('registry_invalid', 'REGEN_REGISTRY_INVALID') } }, 'registry_invalid', ['REGEN_REGISTRY_INVALID']],
    ['base registry unavailable', { registry: { sha: null, outputs: [], error: err('registry_unavailable') } }, 'registry_unavailable', []],
    ['numstat failure', { errors: [err('numstat_failed')] }, 'numstat_failed', []],
    ['binary code path', { perPath: [...per({ 'src/app.ts': 5 }), { path: 'lib/x.wasm', lines: 0, binary: true }], paths: ['src/app.ts', 'lib/x.wasm'] }, 'binary_code_path', []],
  ] as const)('%s fails closed to full with its code', (_n, o, code, codes) => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 5 }), ...(o as Partial<PlanInput>) }));
    expect(p.depth).toBe('full');
    expect(p.errors.map(e => e.code)).toContain(code);
    expect(p.codes).toEqual([...codes]);
    expect(roles(p)).toContain('red-team:red-team:full');
  });
  test.each([
    ['a gate path', { paths: ['src/app.ts', '.github/workflows/ci.yml'] }],
    ['a gate tag', { gateTagged: 1 }],
    ['a deleted test', { deleted: ['test/old.test.ts'] }],
    ['an edit to the registry', { paths: ['.gstack/generated.json'] }],
    ['an edit to SMALL_DIFF_LINES', { paths: ['lib/review-depth.ts'] }],
    ['the collector', { paths: ['lib/review-collect.ts'] }],
    ['the plan CLI', { paths: ['bin/gstack-review-plan'] }],
    ['the queue', { paths: ['lib/ship-queue-train.ts'] }],
    ['the Step 9 template', { paths: ['ship/sections/review-army.md.tmpl'] }],
  ] as const)('%s is full', (_n, o) => {
    const paths = (o as any).paths ?? ['src/app.ts'];
    expect(planReview(mixed({ perPath: per(Object.fromEntries(paths.map((p: string) => [p, 2]))), ...(o as Partial<PlanInput>) })).depth).toBe('full');
  });
  test('a registered glob output is excluded from runtime; a .tmpl edit plus its generated SKILL.md counts the tmpl only', () => {
    const p = planReview(mixed({ perPath: per({ 'ship/SKILL.md.tmpl': 30, 'ship/SKILL.md': 200 }), registry: { sha: 'abc', outputs: ['*/SKILL.md'] } }));
    expect([p.depth, p.runtimeLines]).toEqual(['light', 30]);
    expect(p.dispatches[0]!.exclude).toEqual([':(exclude)ship/SKILL.md']);
  });
  test('a path no base-registry entry names stays runtime', () => {
    expect(planReview(mixed({ perPath: per({ 'src/gen.ts': 60 }), registry: { sha: 'abc', outputs: ['lib/dom.js'] } })).runtimeLines).toBe(60);
  });
  test('numbers in light dispatch the outside voice with an empty exclude', () => {
    const p = planReview(mixed({ perPath: per({ 'docs/bench.md': 4 }), numbers: scanNumbers({ 'docs/bench.md': ['3x faster'] }) }));
    expect(p.depth).toBe('light');
    expect(p.dispatches).toEqual([{ role: 'outside-voice', name: 'outside-voice', effort: 'host', exclude: [] }]);
  });
  test('a fixed blocker in light raises the next full step to the standard set, Red Team included', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 30 }), history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect([p.depth, p.stepDepth]).toEqual(['light', 'standard']);
    expect(roles(p)).toEqual(['specialist:batched:medium', 'red-team:red-team:full', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
  });
  test('--depth-floor raises and never lowers', () => {
    expect(depthFor({ cls: 'code', runtimeLines: 10, errors: [], floor: 'full' })).toBe('full');
    expect(depthFor({ cls: 'code', runtimeLines: 10, errors: [], floor: 'standard' })).toBe('standard');
    expect(depthFor({ cls: 'gate', runtimeLines: 10, errors: [], floor: 'standard' })).toBe('full');
    expect(depthFor({ cls: 'code', runtimeLines: 80, errors: [] })).toBe('light');
    expect(depthFor({ cls: 'code', runtimeLines: 3, errors: [], risk: ['data'] })).toBe('full');
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 10 }), floor: 'full' }));
    expect(p.depth).toBe('full');
    expect(p.depthReasons).toContain('floor:full');
  });
  test('depthOfCommitInput gives the same depth as the plan for the same input', () => {
    const i = { paths: ['src/app.ts', 'test/a.test.ts'], perPath: per({ 'src/app.ts': 51, 'test/a.test.ts': 9 }), gateTagged: 0 };
    expect(depthOfCommitInput(i)).toMatchObject({ depth: 'light', runtimeLines: 51, rules: DEPTH_RULES, errors: [], risk: [] });
    expect(depthOfCommitInput({ ...i, added: { 'src/app.ts': ['const spend_cap_usd = 5;'] } })).toMatchObject({ depth: 'full', risk: ['money'] });
    expect(depthOfCommitInput({ ...i, gateTagged: null }).depth).toBe('full');
  });
});

describe('review depth: diff commands and the rules hash', () => {
  test('DIFF_CMD shell-quotes each pathspec; a glob character makes the pathspec literal', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 10, "docs/my notes*.md": 3, "docs/it's.md": 1 }) }));
    const ex = p.dispatches[0]!.exclude;
    expect(ex).toEqual([':(exclude,literal)docs/my notes*.md', ":(exclude)docs/it's.md"]);
    expect(diffCommand(p.dispatches[0]!)).toBe("git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md' ':(exclude)docs/it'\\''s.md'");
    expect(diffCommand({ role: 'red-team', name: 'red-team', effort: 'full', exclude: [] })).toBe('git diff <diff-base>');
  });
  test('DEPTH_RULES hashes the deciding constants: a comment-only edit keeps it, a threshold edit changes it', () => {
    expect(DEPTH_RULES).toMatch(/^[0-9a-f]{16}$/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-rules-'));
    try {
      const src = fs.readFileSync(path.join(ROOT, 'lib/review-depth.ts'), 'utf8');
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      fs.symlinkSync(path.join(ROOT, 'lib/review-risk.ts'), path.join(dir, 'review-risk.ts'));
      const hashOf = (text: string) => {
        fs.writeFileSync(path.join(dir, 'review-depth.ts'), text);
        fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
        const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      expect(hashOf('// a comment-only edit\n' + src)).toBe(DEPTH_RULES);
      expect(hashOf(src.replace('SMALL_DIFF_LINES = 50', 'SMALL_DIFF_LINES = 60'))).not.toBe(DEPTH_RULES);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('D6: the scoped second pass after a blocking fix (GSTA-152 PR B)', () => {
  const r = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}`);
  const fixed = (rangeRuntimeLines: number | null | undefined, o: Partial<PlanInput['history']> = {}): PlanInput['history'] => ({ fullPasses: 1, last: 'full', fixedBlocking: true, rangeRuntimeLines, ...o });
  // gstack-evals#19: a standard diff, pass 1 fixed one CRITICAL from a QA probe, the fix range was 3 files +18/-6 of runtime.
  const n19 = (o: Partial<PlanInput> = {}) => mixed({ perPath: per({ 'src/a.ts': 300, 'src/b.ts': 100, 'src/c.ts': 60, 'test/a.test.ts': 80 }), diffLines: 540, scope: { SCOPE_BACKEND: 'true' }, history: fixed(24), adversarialRan: true, ...o });

  test('the #19 shape plans one fix-check, the Red Team and the native adversarial pass, not the specialist army', () => {
    const before = planReview(n19({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(before.next.step).toBe('full');
    expect(roles(before)).toEqual(['specialist:batched:medium', 'red-team:red-team:full']);
    const p = planReview(n19());
    expect(p.next.step).toBe('scoped');
    expect(p.next.reason).toContain('24 runtime lines');
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial']);
    expect(p.dispatches.every(d => d.effort === 'full' && d.exclude.length === 0)).toBe(true);
  });
  test('Step 11 voices that have not run yet stay listed, as on a full pass 2', () => {
    const p = planReview(n19({ adversarialRan: false }));
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial', 'outside-voice:outside-voice']);
    expect(p.skipped).toContain('specialists (scoped pass)');
    expect(planReview(n19()).skipped).toEqual(expect.arrayContaining(['specialists (scoped pass)', 'outside-voice (scoped pass)']));
    expect(planReview(n19({ force: ['security'] })).skipped).toContain('specialists (scoped pass; forced ones dispatched)');
  });
  test.each([
    ['full depth (a gate tag)', { gateTagged: 1 }],
    ['a fail-closed classification', { gateTagged: null }],
    ['--depth-floor full', { floor: 'full' as const }],
    ['a 151-line range', { history: fixed(151) }],
    ['a missing range', { history: fixed(undefined) }],
    ['an unread range', { history: fixed(null) }],
    ['a fix that touched a gate-class path', { history: fixed(10, { touchedGate: true }) }],
  ])('%s keeps the full pass 2', (_n, o) => {
    const p = planReview(n19(o as Partial<PlanInput>));
    expect(p.next.step).toBe('full');
    expect(p.dispatches.some(d => d.role === 'specialist')).toBe(true);
  });
  test('a force-included specialist and changed published numbers keep their reviewers', () => {
    expect(r(planReview(n19({ force: ['security'] })))).toEqual(['fix-check:fix-check', 'specialist:security', 'red-team:red-team', 'adversarial-native:adversarial']);
    const numbers = scanNumbers({ 'docs/bench.md': ['3x faster'] });
    expect(r(planReview(n19({ numbers, reviewedNumbers: 'old' })))).toContain('outside-voice:outside-voice (numbers changed)');
    expect(r(planReview(n19({ numbers, reviewedNumbers: numbers.fingerprint })))).not.toContain('outside-voice:outside-voice (numbers changed)');
  });
  test('150 is scoped, 151 is full, and a docs-only range is scoped without the native adversarial pass', () => {
    expect(SCOPED_RANGE_LINES).toBe(150);
    expect(planReview(n19({ history: fixed(150) })).next.step).toBe('scoped');
    expect(planReview(n19({ history: fixed(151) })).next.step).toBe('full');
    const docs = planReview(n19({ history: fixed(0) }));
    expect(docs.next.step).toBe('scoped');
    expect(r(docs)).toEqual(['fix-check:fix-check', 'red-team:red-team']);
  });
  test('a light diff with a fixed blocker gets the scoped set: the raise adds the Red Team, never the standard army', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 30 }), history: fixed(12), adversarialRan: true }));
    expect(p.next.step).toBe('scoped');
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial']);
  });
  test('the scoped pass counts toward the cap, and a blocker it leaves stops for the owner', () => {
    expect(nextStep(fixed(10, { fullPasses: FULL_PASS_CAP }), 'standard').step).toBe('stop');
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', blockingOpen: true, rangeRuntimeLines: 10 }, 'light').step).toBe('stop');
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 10, m)).toISOString();
    const rows = [
      { skill: 'review', via: 'ship', timestamp: at(1), pass: 1, dispatches: [{ role: 'specialist' }, { role: 'adversarial-native' }] },
      { skill: 'review', via: 'ship', timestamp: at(2), pass: 2, scope: 'scoped', dispatches: [{ role: 'fix-check' }, { role: 'red-team' }, { role: 'adversarial-native' }] },
    ];
    const s = summarizeReviewLoop(rows, at(0));
    expect(s.passes).toBe(2);
    expect(s.fix_checks).toBeUndefined();
    expect(s.dispatches).toEqual({ specialist: 1, 'adversarial-native': 2, 'fix-check': 1, 'red-team': 1 });
  });
  test('nextStep without a depth keeps the full pass (planReview is where depth is known)', () => {
    expect(nextStep(fixed(10)).step).toBe('full');
    expect(nextStep(fixed(10), 'full').step).toBe('full');
    expect(nextStep(fixed(10), 'standard').step).toBe('scoped');
  });
  test('REVIEW_PLAN prints the chosen step and its reason', () => {
    const line = reviewPlanLine(planReview(n19()), 2);
    expect(line).toMatch(/^REVIEW_PLAN: class=code pass=2 next=scoped dispatches=3 numbers=no fingerprint=none reason="[^"]*24 runtime lines[^"]*"$/);
    expect(reviewPlanLine(planReview(n19({ history: fixed(151) })), 2)).toContain('reason="a blocking finding was fixed');
  });
  test('DEPTH_RULES changes when the scoped-range constant does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-rules-scoped-'));
    try {
      const src = fs.readFileSync(path.join(ROOT, 'lib/review-depth.ts'), 'utf8');
      expect(src).toContain('SCOPED_RANGE_LINES = 150');
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      fs.symlinkSync(path.join(ROOT, 'lib/review-risk.ts'), path.join(dir, 'review-risk.ts'));
      fs.writeFileSync(path.join(dir, 'review-depth.ts'), src.replace('SCOPED_RANGE_LINES = 150', 'SCOPED_RANGE_LINES = 151'));
      fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
      const res = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).not.toBe(DEPTH_RULES);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('consumers name the scoped step: the Step 9 template and the transitions table', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md.tmpl'), 'utf8');
    expect(tmpl).toContain('--range-base $PASS_HEAD');
    expect(tmpl).toContain('`scoped` is 3 too.');
    expect(tmpl).toContain('"scope":"scoped"');
    expect(tmpl).toContain('raised_by');
    const policy = fs.readFileSync(path.join(ROOT, 'docs/review-policy.md'), 'utf8');
    expect(policy).toContain('| a full pass that fixed a blocking finding, below the cap, on a diff below full depth with a fix range of at most 150 runtime lines | scoped pass on the range |');
  });
});

describe('GSTA-167 part 4a: data files no code names are docs (classifyDiff only)', () => {
  const json = (n: number) => ({ path: 'wiki/post/data.json', lines: n, binary: false });
  // Value: protects=a data-only docs PR (gstack-evals #34: 6,687 lines of wiki JSON) plans light with no specialists; fails_when=an
  //   unconsumed JSON counts as runtime lines; seam=ClassInput.consumed from lib/review-collect.ts
  test('wiki JSON no code names is docs and a 6,687-line diff plans light; a numbers-bearing JSON keeps the outside voice', () => {
    const input = { paths: ['wiki/post/data.json'], perPath: [json(6687)], consumed: [] as string[], gateTagged: 0 };
    const c = classifyDiff(input);
    expect([c.class, c.runtimeLines]).toEqual(['docs', 0]);
    expect(c.reasons).toContain('docs: 1 data path(s) no code names');
    const plan = planReview(base({ ...input, scope: {}, diffLines: 6687, numbers: scanNumbers({ 'wiki/post/data.json': ['{"recall": "19/29"}'] }) }));
    expect([plan.depth, roles(plan)]).toEqual(['light', ['outside-voice:outside-voice:host']]);
    expect(planReview(base({ ...input, scope: {}, diffLines: 6687 })).dispatches).toEqual([]);
  });
  test('a consumed data file, an unscanned diff and an overflowing scan all keep the file code', () => {
    for (const consumed of [['wiki/post/data.json'], undefined, 'all' as const]) {
      const c = classifyDiff({ paths: ['wiki/post/data.json'], perPath: [json(80)], consumed, gateTagged: 0 });
      expect([c.class, c.runtimeLines]).toEqual(['code', 80]);
    }
  });
  test.each([
    'config/runtime.json', 'package.json', 'package-lock.json', 'tsconfig.build.json', 'app/.eslintrc.json', 'vite.config.json', 'public/manifest.json',
    '.gstack/ship-policy.json', '.gstack/generated.json', '.github/workflows/ci.yml', 'fly.toml', 'wrangler.toml', 'docker-compose.yml', 'k8s/deploy.yaml',
    'openapi.yaml', 'public/icon.svg', 'lib/gate-thresholds.json',
  ])('%s with no consumer stays code (config, agent prose, gate, YAML, TOML, SVG)', p => {
    expect(dataCandidate(p)).toBe(false);
    expect(classifyDiff({ paths: [p], perPath: [{ path: p, lines: 3, binary: false }], consumed: [], gateTagged: 0 }).class).not.toBe('docs');
  });
  test.each(['data/rows.csv', 'data/rows.tsv', 'logs/events.jsonl', 'assets/hero.png', 'assets/photo.JPEG', 'wiki/index.json'])('%s is a data candidate', p => expect(dataCandidate(p)).toBe(true));
  test('test fixtures stay tests and markdown stays docs: the rule never touches a non-code class', () => {
    expect(classifyDiff({ paths: ['test/fixtures/a.json'], consumed: [], gateTagged: 0 }).class).toBe('tests');
    expect(dataCandidate('test/fixtures/a.json')).toBe(false);
  });
  // Value: protects=F17, the behavior change is named: an image no code names is docs, not a binary_code_path error; one code names
  //   still fails closed; fails_when=either direction flips; seam=none
  test('a binary PNG no code names is docs with no error; one code names is still binary_code_path (full)', () => {
    const png = { path: 'assets/hero.png', lines: 0, binary: true };
    const free = classifyDiff({ paths: ['assets/hero.png', 'src/app.ts'], perPath: [png, { path: 'src/app.ts', lines: 4, binary: false }], consumed: [], gateTagged: 0 });
    expect([free.errors, free.runtimeLines]).toEqual([[], 4]);
    const named = classifyDiff({ paths: ['assets/hero.png'], perPath: [png], consumed: ['assets/hero.png'], gateTagged: 0 });
    expect(named.errors.map(e => e.code)).toEqual(['binary_code_path']);
  });
  // Value: protects=F1, the receipt's gate scan cannot be skipped through the data rule; fails_when=a data-only range reads as
  //   needing no scan, so tagged=0 is recorded unscanned; seam=lib/ship-receipt-depth.ts receiptDepthAtHead
  test('gateScanNeeded is path-only: a data-only range still needs the scan, a markdown-only range does not', () => {
    expect(gateScanNeeded(['wiki/post/data.json'])).toBe(true);
    expect(gateScanNeeded(['assets/hero.png', 'README.md'])).toBe(true);
    expect(gateScanNeeded(['README.md', 'docs/a.md'])).toBe(false);
    expect(classifyPath('wiki/post/data.json')).toBe('code');
  });
  test('a deleted data file stays guarded: a code diff that deletes one is gate class', () => {
    expect(classifyDiff({ paths: ['src/app.ts', 'wiki/old.json'], deleted: ['wiki/old.json'], consumed: [], gateTagged: 0 }).class).toBe('gate');
  });
});

describe('lean ensemble: one batched specialist at standard and full depth (GSTA-167 part 2)', () => {
  const fixture = (name: string): PlanInput => {
    const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-depth', `${name}.json`), 'utf8'));
    return { paths: x.paths, deleted: x.deleted, stampOnly: x.stamp_only ?? [], scope: x.scope, gateTagged: x.gate_tagged, diffLines: x.diff_lines, numbers: x.numbers, perPath: x.per_path, registry: x.registry_outputs ? { sha: null, outputs: x.registry_outputs } : undefined, history: { fullPasses: 0, last: 'none' } };
  };
  const specialists = (p: ReturnType<typeof planReview>) => p.dispatches.filter(d => d.role === 'specialist');
  // Value: protects=the lean ensemble's reader set (testing and security always, the four scoped checklists when scope asks,
  //   maintainability, performance and simplification only when forced) on captured diffs; fails_when=a plan dispatches more than
  //   one specialist reader at standard or full, drops testing or security, or the Red Team or voices change; seam=planReview
  test('the captured gate fixture plans one batched reader, the Red Team and both voices', () => {
    const p = planReview(fixture('code'));
    expect([p.class, p.depth]).toEqual(['gate', 'full']);
    expect(roles(p)).toEqual(['specialist:batched:medium', 'red-team:red-team:full', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
    expect(batch(p)).toEqual(['testing', 'security', 'state-machines']);
    expect(batch(planReview({ ...fixture('code'), scope: { ...fixture('code').scope, SCOPE_MIGRATIONS: 'true', SCOPE_API: 'true', SCOPE_FRONTEND: 'true', SCOPE_STATE_MACHINE: 'false' } }))).toEqual(['testing', 'security', 'data-migration', 'api-contract', 'design']);
  });
  test('the captured docs fixture dispatches no reader at standard and one batched reader when floored to full', () => {
    expect(specialists(planReview({ ...fixture('docs-only'), floor: 'standard' }))).toEqual([]);
    const full = planReview({ ...fixture('docs-only'), floor: 'full' });
    expect(specialists(full).map(d => [d.name, d.effort, d.checklists])).toEqual([['batched', 'medium', ['testing', 'security', 'state-machines']]]);
  });
  test('a standard code plan reads one batched reader on its own hunks, and a forced checklist joins it', () => {
    const p = planReview(base({ diffLines: 400, floor: 'standard', scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' } }));
    expect(specialists(p).map(d => [d.name, d.checklists])).toEqual([['batched', ['testing', 'security']]]);
    expect(roles(p)).toContain('red-team:red-team:full');
    expect(batch(planReview(base({ floor: 'standard', force: ['performance', 'simplification'] })))).toEqual(['testing', 'security', 'performance', 'simplification']);
    expect(specialists(planReview(base({ floor: 'standard', tiers: false })))[0]!.effort).toBe('host');
  });
});

