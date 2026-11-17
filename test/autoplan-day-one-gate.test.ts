/**
 * GST-2947 PR 1: the approval page keeps a reviewer's product challenge open.
 * A free, deterministic replay of a reviewed app plan's records, rebuilt as a
 * synthetic, public-safe fixture (titles and fields only: no owner replies, no
 * private content, no real quotes). Round 1's CEO reviewer challenged the build
 * order and the promise scope; round 2 never repeated those, and its one
 * challenge became "keep your direction" because the planning agent's own draft
 * counted as the owner's direction. Now only the plan's `### Owner's words`
 * count as direction: the three challenges come out as lettered proposals
 * recommending the change. Negative controls: (a) a challenge to a quoted owner
 * line keeps the keep-direction default; (b) a plan with no Owner's words
 * section keeps today's default and gets one confirm-direction item; (c) a
 * round-1 challenge the revision fixed (`resolves`) or the owner answered does
 * not resurface.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyGuidance, buildGate } from '../lib/autoplan-gate';
import { branchKey } from '../lib/approval-record';
import { slugCacheReadOrder } from '../lib/bin-context';
import { proposalCost, proposalItem, ownerContext, recordedOwnerWords } from '../lib/autoplan-gate-items';
import { confirmBlock, openEarlier, settledIds } from '../lib/autoplan-confirm';
import { buildTasks } from '../lib/autoplan-export';
import { exportPublic } from '../lib/autoplan-public';
import * as crypto from 'node:crypto';
import { cutDrops, parseCuts, parseDayOne, parseOwnerWords, ownerWordsLine } from '../lib/autoplan-owner-text';
import { ownerWords, redactOwnerWords } from '../lib/autoplan-owner-words';
import { consensusRecord, parseReviewResult, reconcile } from '../lib/autoplan-reconcile';
import { decisionSeverity } from '../lib/autoplan-revise';
import { writeDecisions, type RunState } from '../lib/autoplan-state';
import { renderCaptainBrief } from '../lib/captain-brief';
import { decisionRows, parseReply, renderGate, type GateList } from '../lib/gate-list';
import type { FindingRow } from '../lib/headless-artifacts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-day-one-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const RUN = 'replay-20261117';
const SHA = 'a'.repeat(64);

const DAY_ONE = `### Day one

| action | frequency | source | feature | route | first build | check |
|---|---|---|---|---|---|---|
| sees the day's meetings and who is coming | daily | calendar export | Today screen | root screen | build 1 | the owner's real calendar shows on the phone |
| reads the before-meeting card | several times a day | owner words 1 | Before card | Today screen, tap a meeting | build 1 | a card opens for the next meeting |
| reviews the promises made in a meeting | daily | assumed | Promise review | Today screen, Promises | build 2 | a promise from a test meeting appears |

### What it won't do yet

- No Today screen in the first build: notifications only
- No Android build
- No shared team calendars
`;
const planText = (o: { owner?: string | null; dayOne?: boolean } = {}) => [
  '# Meeting companion for the phone and watch (synthetic replay)', '',
  '## Implementation plan', '',
  ...(o.owner === null ? [] : ["### Owner's words", '', o.owner ?? '- The owner, day 0: "I want to remember what I promised people after every meeting"', '']),
  ...(o.dayOne === false ? [] : [DAY_ONE]),
  '### Units', '', 'U1 the live lane. U2 the transcript. U3 the before-meeting card. U4 the promise review screen.', '',
  '## Review record', ''].join('\n');

type Row = Partial<FindingRow> & { id: string; severity: FindingRow['severity']; title: string; user_challenge?: boolean; changes?: string; owner_quote?: number; resolves?: string };
const row = (phase: string, voice: 'native' | 'outside', r: Row): FindingRow => ({ schema_version: 1, run: RUN, phase, voice, disposition: 'open', ...r } as FindingRow);

/** Round 1 of the CEO phase: the build-order and promise-scope challenges that round 2 never repeated. */
const ROUND1 = {
  native: [
    row('ceo', 'native', { id: `${RUN}-ceo-native-1`, severity: 'Critical', title: 'Watch cue delivery depends on a reachability the OS grants only in the foreground' }),
    row('ceo', 'native', { id: `${RUN}-ceo-native-4`, severity: 'High', title: 'Build order puts the riskiest layer (the live lane) before the loop that pays off on day one (before-meeting card, promise review)', user_challenge: true, changes: 'ordering', resolution: 'build the before-meeting card and the promise review first; the live lane after' }),
    row('ceo', 'native', { id: `${RUN}-ceo-native-18`, severity: 'Medium', title: 'The promise ledger learns only from in-person meetings, though the meetings archive already holds the rest', user_challenge: true, changes: 'scope', resolution: 'read promises from the meetings archive too' }),
  ],
  outside: [row('ceo', 'outside', { id: `${RUN}-ceo-outside-1`, severity: 'High', title: 'The scratch-server checks cannot tell client, transport or server slowness apart' })],
};
/** Round 2: one new challenge (the replay's d1) and an ordinary High finding; nothing repeats round 1. */
const round2 = (o: { quote?: number; resolved?: boolean } = {}) => ({
  native: [
    row('ceo', 'native', { id: `${RUN}-ceo-r2-native-1`, severity: 'High', title: 'The two checks that can redirect the plan without any build run only after three units are built', user_challenge: true, changes: 'ordering', resolution: 'run both checks before any build unit', ...(o.quote ? { owner_quote: o.quote } : {}) }),
    row('ceo', 'native', { id: `${RUN}-ceo-r2-native-2`, severity: 'High', title: 'The relationship-judgment harness has no runtime home' }),
    ...(o.resolved ? [row('ceo', 'native', { id: `${RUN}-ceo-r2-native-3`, severity: 'Informational', title: 'Resolved: the build order now ships the day-one loop first', resolves: `${RUN}-ceo-native-4` })] : []),
  ],
  outside: [row('ceo', 'outside', { id: `${RUN}-ceo-r2-outside-1`, severity: 'Medium', title: 'The upstream-edit list omits the signing settings' })],
});

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
function makeRun(name: string, o: { plan: string; round2: ReturnType<typeof round2>; round1?: boolean; ui?: boolean; lean?: boolean; answered?: string[] }): RunState {
  const out = path.join(TMP, name);
  fs.mkdirSync(out, { recursive: true });
  const plan = path.join(out, 'plan-active.md');
  fs.writeFileSync(plan, o.plan);
  fs.writeFileSync(path.join(out, 'plan.md'), o.plan);
  const voice = (output: string) => ({ status: 'completed', output, model: 'fixture' });
  const write = (stem: string, rows: FindingRow[]) => fs.writeFileSync(path.join(out, `${stem}.findings.jsonl`), jsonl(rows));
  write('ceo-native.a3.bound.md', o.round2.native); write('ceo-outside.a4.bound.md', o.round2.outside);
  const history: Array<Record<string, unknown>> = [];
  if (o.round1 !== false) {
    write('ceo-native.a1.bound.md', ROUND1.native); write('ceo-outside.a2.bound.md', ROUND1.outside);
    history.push({ event: 'reopened', phase: 'ceo', previous: { snapshot: SHA, closed_at: '2026-11-09T01:00:00Z', native: voice('ceo-native.a1.bound.md'), outside: voice('ceo-outside.a2.bound.md') } });
  }
  const rec = reconcile(o.round2.native, o.round2.outside, []);
  fs.writeFileSync(path.join(out, 'ceo-consensus.json'), JSON.stringify(consensusRecord('ceo', { rows: o.round2.native, model: 'fixture' }, { rows: o.round2.outside, model: 'fixture' }, rec)));
  fs.writeFileSync(path.join(out, 'attempts.jsonl'), '');
  if (o.answered?.length) writeDecisions(out, o.answered.map((id, i) => ({ schema_version: 1, run: RUN, id: `${RUN}-g1-d${i + 1}`, gate_rev: 1, label: `D${i + 1}`, title: id, status: 'overridden', chosen: 'a', origin: `ceo|${id}|2026-11-09T01:00:00Z|${SHA}|0` } as any)));
  return { run: RUN, out, revision: 1, plan_source: path.join(out, 'plan.md'), active_plan: plan, restore: path.join(out, 'restore.md'), scope: { ui: o.ui !== false } as any, phase_order: ['ceo'],
    phases: { ceo: { snapshot: SHA, closed_at: '2026-11-10T01:00:00Z', native: voice('ceo-native.a3.bound.md') as any, outside: voice('ceo-outside.a4.bound.md') as any } },
    outside_enabled: true, attempt_counter: 4, spend_cap_usd: null, history, created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', ...(o.lean ? { lean: 'lean' as any } : {}) } as unknown as RunState;
}
const byClass = (list: GateList, cls: string) => list.items.filter(i => i.item_class === cls);
const lettered = (list: GateList) => list.items.filter(i => i.id !== 'p1').length;
const covering = (list: GateList, id: string) => list.items.find(i => i.title.includes(`[${id}`) || i.title.includes(` ${id}]`) || i.title.includes(`+ ${id}`));
const rec = (list: GateList) => Object.fromEntries(parseReply('rec', list).choices.map(c => [c.id, c.chosen]));

describe('replay: a reviewed app plan whose product challenges were hidden', () => {
  const state = makeRun('replay', { plan: planText(), round2: round2() });
  const list = buildGate(state, 1);

  test('round-1 build order (F4) and promise scope (F18) come back as lettered proposals recommending the change', () => {
    for (const id of [`${RUN}-ceo-native-4`, `${RUN}-ceo-native-18`]) {
      const item = covering(list, id)!;
      expect(item).toBeDefined();
      expect(item.item_class).toBe('proposal');
      expect(item.kind).toBe('approval');
      expect(item.recommended).toBe('a');
      expect(item.options.find(o => o.key === 'a')!.text).toStartWith('take the change: ');
      expect(item.why).toContain('raised in an earlier round and still open');
    }
  });

  test("round 2's one-voice challenge (d1) recommends the reviewer's change, not \"keep your direction\"", () => {
    const d1 = covering(list, `${RUN}-ceo-r2-native-1`)!;
    expect(d1.item_class).toBe('proposal');
    expect(rec(list)[d1.id]).toBe('a');
    expect(d1.options.find(o => o.key === d1.recommended)!.changes_plan).toBe(true);
    expect(list.items.some(i => i.options.some(o => o.text.startsWith('keep your direction')))).toBe(false);
    expect(list.items.find(i => i.id === 'p1')!.recommended).toBe('b');
  });

  test('day one: the assumed row is an owner question, the cut that drops the Today screen is lettered, the rest are one item', () => {
    expect(byClass(list, 'day_one').map(i => i.title)).toEqual(['Day one: the plan assumes you will do "reviews the promises made in a meeting" (daily); is that right?']);
    expect(byClass(list, 'cut').map(i => i.title)).toEqual(['Cut: No Today screen in the first build: notifications only']);
    expect(byClass(list, 'cuts').map(i => i.title)).toEqual(['2 other cuts: No Android build; No shared team calendars']);
    expect(list.owner_words).toMatchObject({ status: 'ok', quotes: [{ n: 1, verified: false }] });
  });

  test('lettered-item counts (recorded for the PR): 3 proposals, 3 day-one items, 1 High finding', () => {
    expect(byClass(list, 'proposal').length).toBe(3);
    expect(byClass(list, 'finding').length).toBe(1);
    expect(lettered(list)).toBe(7);
  });
});

describe('negative controls', () => {
  test('(a) a challenge to a quoted owner line keeps "keep your direction"', () => {
    const owner = '- The owner, day 0: "I want to remember what I promised people after every meeting"\n- The owner, day 0: "build the live lane first, it is the whole point"';
    const list = buildGate(makeRun('control-a', { plan: planText({ owner }), round2: round2({ quote: 2 }) }), 1);
    const d1 = covering(list, `${RUN}-ceo-r2-native-1`)!;
    expect(d1.item_class).toBe('challenge1');
    expect(d1.recommended).toBe('a');
    expect(d1.options[0]!.text).toBe('keep your direction');
    expect(byClass(list, 'confirm_direction')).toEqual([]);
    expect(byClass(list, 'proposal').length).toBe(2);
    expect(lettered(list)).toBe(7);
  });

  test("(b) no Owner's words section: today's keep-direction default stays, plus one confirm-direction item", () => {
    const list = buildGate(makeRun('control-b', { plan: planText({ owner: null }), round2: round2() }), 1);
    expect(byClass(list, 'proposal')).toEqual([]);
    const kept = byClass(list, 'challenge1');
    expect(kept.map(i => i.recommended)).toEqual(['a', 'a', 'a']);
    expect(kept.every(i => i.options[0]!.text === 'keep your direction')).toBe(true);
    const confirm = byClass(list, 'confirm_direction');
    expect(confirm.length).toBe(1);
    expect(confirm[0]!.title).toContain(kept.map(i => i.id).join(', '));
    expect(list.owner_words).toBeUndefined();
    expect(lettered(list)).toBe(8);
  });

  test('(c) a round-1 challenge the revision fixed (resolves) or the owner answered does not resurface', () => {
    const state = makeRun('control-c', { plan: planText(), round2: round2({ resolved: true }), answered: [`${RUN}-ceo-native-18`] });
    const list = buildGate(state, 2);
    expect(covering(list, `${RUN}-ceo-native-4`)).toBeUndefined();
    expect(covering(list, `${RUN}-ceo-native-18`)).toBeUndefined();
    expect(openEarlier(state, 'ceo', [...round2({ resolved: true }).native])).toEqual([]);
    expect(byClass(list, 'proposal').length).toBe(1);
    expect(lettered(list)).toBe(5);
  });

  test('a later round staying silent never closes a challenge, and a lean run carries nothing', () => {
    const state = makeRun('silent', { plan: planText(), round2: round2() });
    expect(openEarlier(state, 'ceo', round2().native).map(r => r.id)).toEqual([`${RUN}-ceo-native-4`, `${RUN}-ceo-native-18`]);
    expect(openEarlier({ ...state, lean: 'lean' as any }, 'ceo', round2().native)).toEqual([]);
  });

  test('the confirm round lists the open earlier challenges and asks for resolves', () => {
    const state = makeRun('confirm', { plan: planText(), round2: round2() });
    const block = confirmBlock(state, 'ceo', path.join(state.out, 'missing-snapshot.md'), 2)!.text;
    expect(block).toContain(`- ${RUN}-ceo-native-4: Build order puts the riskiest layer`);
    expect(block).toContain('"resolves":"<id>"');
  });
});

describe('owner_quote downgrade, the day-one page requirement and the cost line', () => {
  test('a challenge naming no real owner line is an ordinary proposal', () => {
    const list = buildGate(makeRun('bad-quote', { plan: planText(), round2: round2({ quote: 9 }), round1: false }), 1);
    expect(covering(list, `${RUN}-ceo-r2-native-1`)!.item_class).toBe('proposal');
  });

  test('a below-High challenge with no changes and no real owner line still reaches the gate as a proposal', () => {
    const native = [row('ceo', 'native', { id: `${RUN}-ceo-r2-native-9`, severity: 'Medium', title: 'Make the summary daily instead of weekly', user_challenge: true, owner_quote: 99 })];
    const list = buildGate(makeRun('challenge-no-changes', { plan: planText(), round2: { native, outside: [] }, round1: false }), 1);
    const item = covering(list, `${RUN}-ceo-r2-native-9`)!;
    expect(item.item_class).toBe('proposal');
    expect(item.changes).toBe('direction');
    expect(item.recommended).toBe('a');
  });

  test('an ordinary finding that only correlates with an earlier challenge does not close it', () => {
    const state = makeRun('correlated', { plan: planText(), round2: round2() });
    const naming = row('ceo', 'native', { id: `${RUN}-ceo-r2-native-8`, severity: 'Low', title: 'Build order wording', correlates: [`${RUN}-ceo-native-4`] } as Row);
    expect(openEarlier(state, 'ceo', [naming]).map(r => r.id)).toContain(`${RUN}-ceo-native-4`);
    const repeat = row('ceo', 'native', { id: `${RUN}-ceo-r2-native-7`, severity: 'High', title: 'Build order again', changes: 'ordering', correlates: [`${RUN}-ceo-native-4`] } as Row);
    expect(openEarlier(state, 'ceo', [repeat]).map(r => r.id)).not.toContain(`${RUN}-ceo-native-4`);
  });

  test('a paired ordering and scope proposal takes scope: its cost line reopens and applyGuidance does not settle it', () => {
    const state = makeRun('pair', { plan: planText(), round2: round2(), round1: false });
    const pair = [row('ceo', 'native', { id: 'n1', severity: 'Medium', title: 'Build the card first', changes: 'ordering' }), row('ceo', 'outside', { id: 'o1', severity: 'Medium', title: 'Build the card first', changes: 'scope' })] as any;
    const item = proposalItem(ownerContext(state, []), 'ceo', pair);
    expect(item.changes).toBe('scope');
    expect(item.cost).toBe('a reopens ceo and eng once the plan is revised');
    expect(applyGuidance({ changes: item.changes as any, item: 'uc1' })).toBe('edit the plan, then revise');
  });

  test('a High proposal answered b keeps its finding open as a blocking task; below High keeps the plain draft option', () => {
    const state = makeRun('high-b', { plan: planText(), round2: round2(), round1: false });
    const list = buildGate(state, 1);
    const high = covering(list, `${RUN}-ceo-r2-native-1`)!;
    expect(high.item_class).toBe('proposal');
    expect(high.recommended).toBe('a');
    expect(high.options.find(o => o.key === 'b')!.text).toBe("keep the plan's draft; carry it into the build as a blocking task (no plan change)");
    expect(high.origin).toEndWith('|finding');
    writeDecisions(state.out, [{ schema_version: 1, run: RUN, id: `${RUN}-g1-${high.id}`, gate_rev: 1, label: high.id.toUpperCase(), title: high.title, status: 'overridden', chosen: 'b', origin: high.origin } as any]);
    expect(settledIds(state).has(`${RUN}-ceo-r2-native-1`)).toBe(false);
    expect(buildTasks(state, round2().native).some(t => t.findings.includes(`${RUN}-ceo-r2-native-1`))).toBe(true);
    const medium = buildGate(makeRun('medium-b', { plan: planText(), round2: round2() }), 1);
    const scope = covering(medium, `${RUN}-ceo-native-18`)!;
    expect(scope.options.find(o => o.key === 'b')!.text).toBe("keep the plan's draft");
    expect(scope.origin).not.toEndWith('|finding');
  });

  test('a quote a revision removed stays redacted in the public export of an earlier reviewer result', () => {
    const quote = 'I want to remember what I promised people after every meeting';
    const state = makeRun('revised-quote', { plan: planText({ owner: null }), round2: round2(), round1: false });
    fs.writeFileSync(path.join(state.out, 'plan-source.md'), planText());
    fs.writeFileSync(path.join(state.out, 'ceo-native.a1.bound.md'), `The owner said "${quote}", so keep the promise review.\n`);
    const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(state.out, f))).digest('hex');
    const run = { ...state, artifacts: { 'ceo-native.a1.bound.md': { path: 'ceo-native.a1.bound.md', sha256: sha('ceo-native.a1.bound.md') } } } as RunState;
    fs.writeFileSync(path.join(state.out, 'run.json'), JSON.stringify(run, null, 2));
    const pub = path.join(TMP, 'revised-quote-public');
    exportPublic(run, pub);
    const text = fs.readFileSync(path.join(pub, 'ceo-native.a1.bound.md'), 'utf8');
    expect(text).not.toContain(quote);
    expect(text).toContain('[owner words redacted]');
  });

  test('a changed cut list or challenge list gets a new origin, so an earlier answer is asked again instead of carried', () => {
    const origin = (list: GateList, cls: string) => byClass(list, cls)[0]!.origin;
    const cuts = (extra: string) => planText().replace('- No shared team calendars\n', `- No shared team calendars\n${extra}`);
    const before = buildGate(makeRun('cuts-before', { plan: cuts(''), round2: round2(), round1: false }), 1);
    const after = buildGate(makeRun('cuts-after', { plan: cuts('- No web dashboard\n'), round2: round2(), round1: false }), 1);
    expect(origin(after, 'cuts')).not.toBe(origin(before, 'cuts'));
    const confirmOne = buildGate(makeRun('confirm-one', { plan: planText({ owner: null }), round2: round2(), round1: false }), 1);
    const confirmTwo = buildGate(makeRun('confirm-two', { plan: planText({ owner: null }), round2: round2() }), 1);
    expect(origin(confirmTwo, 'confirm_direction')).not.toBe(origin(confirmOne, 'confirm_direction'));
  });

  test('an app plan with no Day one table gets one item; a backend plan never does', () => {
    const app = buildGate(makeRun('no-day-one-app', { plan: planText({ dayOne: false }), round2: round2(), round1: false }), 1);
    expect(byClass(app, 'day_one').map(i => [i.title.slice(0, 32), i.recommended])).toEqual([['The plan has no day-one page: th', 'a']]);
    const backend = buildGate(makeRun('no-day-one-backend', { plan: planText({ dayOne: false }), round2: round2(), round1: false, ui: false }), 1);
    expect(byClass(backend, 'day_one')).toEqual([]);
  });

  test("the cost line states what revise does: full runs re-review scope (even below High), settle ordering, lean applies", () => {
    const state = makeRun('cost', { plan: planText(), round2: round2() });
    const list = buildGate(state, 1);
    writeDecisions(state.out, decisionRows(list));
    const scope = covering(list, `${RUN}-ceo-native-18`)!;
    expect(scope.cost).toBe('a reopens ceo and eng once the plan is revised');
    expect(decisionSeverity(state, decisionRows(list).find(r => r.label?.toLowerCase() === scope.id)!.id)).toBe('challenge');
    const order = covering(list, `${RUN}-ceo-r2-native-1`)!;
    expect(order.cost).toBe('a is settled with revise --settle: no plan edit, no re-review');
    expect(applyGuidance({ changes: order.changes, item: order.id })).toBe(`no plan edit needed: revise --settle ${order.id}`);
    const lean = ownerContext({ ...state, lean: 'lean' as any }, []);
    expect(proposalCost(lean, 'eng', 'scope')).toBe('a applies without re-review (lean run: one gate revision)');
  });
});

describe('two-voice challenges (known gaps after #4431)', () => {
  const pair = (o: { native: 'ordering' | 'scope'; outside: 'ordering' | 'scope'; fix?: [string, string] }) => ({
    native: [row('ceo', 'native', { id: `${RUN}-ceo-r2-native-1`, severity: 'High', title: 'Ship the before-meeting card before the live lane', user_challenge: true, changes: o.native, resolution: o.fix?.[0] ?? 'build the card first' })],
    outside: [row('ceo', 'outside', { id: `${RUN}-ceo-r2-outside-1`, severity: 'High', title: 'Ship the before-meeting card before the live lane', user_challenge: true, changes: o.outside, resolution: o.fix?.[1] ?? 'build the card first' })],
  }) as unknown as ReturnType<typeof round2>;

  test('an ordering plus scope pair is a scope change, so taking it is re-reviewed, never settled', () => {
    const list = buildGate(makeRun('pair-scope', { plan: planText({ owner: null }), round2: pair({ native: 'ordering', outside: 'scope' }), round1: false }), 1);
    const item = byClass(list, 'challenge2')[0]!;
    expect(item.changes).toBe('scope');
    expect(applyGuidance({ changes: item.changes, item: item.id })).toBe('edit the plan, then revise');
  });

  test("with no Owner's words section, a two-voice challenge that keeps the plan's direction asks the owner to confirm it", () => {
    const list = buildGate(makeRun('pair-keep', { plan: planText({ owner: null }), round2: pair({ native: 'scope', outside: 'scope', fix: ['build the card first', 'drop the live lane'] }), round1: false }), 1);
    const item = byClass(list, 'challenge2')[0]!;
    expect(item.recommended).toBe('a');
    const confirm = byClass(list, 'confirm_direction');
    expect(confirm.length).toBe(1);
    expect(confirm[0]!.title).toContain(item.id);
  });

  test('a two-voice challenge that recommends the change adds no confirm item', () => {
    const list = buildGate(makeRun('pair-change', { plan: planText({ owner: null }), round2: pair({ native: 'scope', outside: 'scope' }), round1: false }), 1);
    expect(byClass(list, 'challenge2')[0]!.recommended).toBe('b');
    expect(byClass(list, 'confirm_direction')).toEqual([]);
  });
});

describe('parsers, render and redaction', () => {
  test("Owner's words: ok, none and malformed, with the OWNER_WORDS line", () => {
    expect(parseOwnerWords(planText())).toEqual({ status: 'ok', quotes: [{ n: 1, who: 'The owner, day 0', text: 'I want to remember what I promised people after every meeting' }] });
    expect(ownerWordsLine(parseOwnerWords(planText({ owner: null })))).toStartWith('OWNER_WORDS: none');
    const bad = parseOwnerWords(planText({ owner: '- The owner said to ship it' }));
    expect(bad.status).toBe('malformed');
    expect(ownerWordsLine(bad)).toBe('OWNER_WORDS: malformed (bullet 1 quotes no words; fix: one bullet per quote: - <who>, <when>: "<their exact words>"); 0 quotes read');
    expect(ownerWordsLine(parseOwnerWords(planText()), 1)).toBe('OWNER_WORDS: 1 quote (1 unverified: not found in a recorded owner reply)');
  });

  test('Day one table and cuts', () => {
    const day = parseDayOne(planText());
    expect(day.status).toBe('ok');
    expect(day.rows.map(r => [r.feature, r.assumed])).toEqual([['Today screen', false], ['Before card', false], ['Promise review', true]]);
    expect(parseDayOne('### Day one\n\n| action | feature |\n|---|---|\n| a | b |\n')).toMatchObject({ status: 'malformed', reason: 'the table has no frequency, source, route, first build, check column' });
    expect(parseCuts(planText())).toEqual(['No Today screen in the first build: notifications only', 'No Android build', 'No shared team calendars']);
    expect(cutDrops('No Today screen in the first build', 'Today screen')).toBe(true);
    expect(cutDrops('No Android build', 'Today screen')).toBe(false);
  });

  test('reviewer rows carry owner_quote and resolves; bad values are dropped', () => {
    const fence = (row: object) => `INPUT: ceo ${SHA}\n\n\`\`\`gstack-findings\n${JSON.stringify(row)}\n\`\`\`\n`;
    const ok = parseReviewResult(fence({ severity: 'High', title: 't', user_challenge: true, owner_quote: 2, changes: 'ordering' }), { phase: 'ceo', sha256: SHA });
    expect(ok.findings[0]).toMatchObject({ owner_quote: 2, user_challenge: true, changes: 'ordering' });
    const resolved = parseReviewResult(fence({ severity: 'Informational', title: 'Resolved: t', resolves: ' x-1 ' }), { phase: 'ceo', sha256: SHA });
    expect(resolved.findings[0]!.resolves).toBe('x-1');
    const bad = parseReviewResult(fence({ severity: 'High', title: 't', owner_quote: 0, resolves: '' }), { phase: 'ceo', sha256: SHA });
    expect(bad.findings[0]!.owner_quote).toBeUndefined();
    expect(bad.findings[0]!.resolves).toBeUndefined();
  });

  test('the gate render and the captain brief open with what the owner can do on day one and the words they are protected by', () => {
    const state = makeRun('render', { plan: planText(), round2: round2() });
    const list = buildGate(state, 1);
    const rendered = renderGate(list, 1, 50);
    expect(rendered).toContain("OWNER_WORDS: 1 quote (1 unverified");
    expect(rendered).toContain('1. The owner, day 0: "I want to remember what I promised people after every meeting" (unverified');
    const brief = renderCaptainBrief({ gate: list, decisions: decisionRows(list), findings: [], run: { status: 'gate_pending', active_plan: state.active_plan } }, { outDir: state.out }).text;
    expect(brief.indexOf('### Day one')).toBeGreaterThan(0);
    expect(brief.indexOf('### Day one')).toBeLessThan(brief.indexOf("### What it won't do yet"));
    expect(brief.indexOf("### What it won't do yet")).toBeLessThan(brief.indexOf('### Before → after'));
    expect(brief).toContain('| reviews the promises made in a meeting (our guess: asked below) | daily |');
  });

  test('a quote found in an approvals record on disk is verified, and reading it writes nothing to the state root', () => {
    const state = makeRun('ledger', { plan: planText(), round2: round2(), round1: false });
    const repo = path.dirname(state.plan_source);
    expect(spawnSync('git', ['init', '-q', '-b', 'day-one-ledger', repo], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const home = path.join(TMP, 'ledger-home');
    const mirror = path.join(TMP, 'ledger-mirror', 'some-slug');
    fs.mkdirSync(mirror, { recursive: true });
    fs.writeFileSync(path.join(mirror, `${branchKey('day-one-ledger')}.jsonl`), JSON.stringify({ schema_version: 1, id: 'x', words: 'The owner said: I want to remember what I promised people after every meeting' }) + '\n');
    const env = { HOME: home, GSTACK_APPROVALS_DIR: path.dirname(mirror), GSTACK_PROJECT_SLUG: 'some-slug' };
    const words = recordedOwnerWords(state, env);
    expect(ownerContext(state, words).verified).toEqual(new Set([1]));
    expect(fs.existsSync(home)).toBe(false);
  });

  test("another repo's approvals record on a branch of the same name never verifies a quote", () => {
    const state = makeRun('ledger-other-repo', { plan: planText(), round2: round2(), round1: false });
    expect(spawnSync('git', ['init', '-q', '-b', 'main', path.dirname(state.plan_source)], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const root = path.join(TMP, 'ledger-other-mirror');
    fs.mkdirSync(path.join(root, 'other-repo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'other-repo', `${branchKey('main')}.jsonl`), JSON.stringify({ schema_version: 1, id: 'y', words: 'I want to remember what I promised people after every meeting' }) + '\n');
    const env = { HOME: path.join(TMP, 'ledger-other-home'), GSTACK_APPROVALS_DIR: root, GSTACK_PROJECT_SLUG: 'this-repo' };
    expect(ownerContext(state, recordedOwnerWords(state, env)).verified).toEqual(new Set());
    expect(ownerContext(state, recordedOwnerWords(state, { ...env, GSTACK_PROJECT_SLUG: 'other-repo' })).verified).toEqual(new Set([1]));
  });

  test('without GSTACK_PROJECT_SLUG the repository slug cache entry finds the record, even under a project marker', () => {
    const state = makeRun(path.join('ledger-marker', 'run'), { plan: planText(), round2: round2(), round1: false });
    const repo = path.dirname(state.plan_source);
    expect(spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const stateRoot = path.join(TMP, 'ledger-marker-state');
    const cache = slugCacheReadOrder(stateRoot, repo)[0];
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, 'v2:this-repo');
    const record = path.join(stateRoot, 'projects', 'this-repo', 'approvals', `${branchKey('main')}.jsonl`);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ schema_version: 1, id: 'z', words: 'I want to remember what I promised people after every meeting' }) + '\n');
    const env = { HOME: path.join(TMP, 'ledger-marker-home'), GSTACK_STATE_ROOT: stateRoot };
    expect(ownerContext(state, recordedOwnerWords(state, env)).verified).toEqual(new Set([1]));
    fs.writeFileSync(path.join(TMP, 'ledger-marker', '.gstack-project'), '');
    expect(ownerContext(state, recordedOwnerWords(state, env)).verified).toEqual(new Set([1]));
  });

  test('with no GSTACK_PROJECT_SLUG and no slug cache entry, no record verifies a quote', () => {
    const state = makeRun('ledger-no-slug', { plan: planText(), round2: round2(), round1: false });
    expect(spawnSync('git', ['init', '-q', '-b', 'main', path.dirname(state.plan_source)], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const stateRoot = path.join(TMP, 'ledger-no-slug-state');
    const record = path.join(stateRoot, 'projects', 'other-repo', 'approvals', `${branchKey('main')}.jsonl`);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ schema_version: 1, id: 'w', words: 'I want to remember what I promised people after every meeting' }) + '\n');
    const env = { HOME: path.join(TMP, 'ledger-no-slug-home'), GSTACK_STATE_ROOT: stateRoot };
    expect(ownerContext(state, recordedOwnerWords(state, env)).verified).toEqual(new Set());
    expect(ownerContext(state, recordedOwnerWords(state, { ...env, GSTACK_PROJECT_SLUG: 'other-repo' })).verified).toEqual(new Set([1]));
  });

  test('quoted owner words are redacted from public copies', () => {
    const state = makeRun('redact', { plan: planText(), round2: round2(), round1: false });
    const words = ownerWords(state);
    const out = redactOwnerWords('The plan says: I want to remember what I promised people after every meeting.', words);
    expect(out.redacted).toBe(1);
    expect(out.text).not.toContain('promised people');
  });
});
