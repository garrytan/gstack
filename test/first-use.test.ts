/**
 * The first-use check (lib/first-use.ts, lib/first-use-message.ts, bin/gstack-first-use;
 * docs/first-use-check.md). Every owner, app, plan and build here is made up. Pins the
 * day-one table format both plan sources share (autoplan's ### Day one table and the
 * one-page day-one list), and the owner's quoted words each frozen row must cite, so a
 * change to lib/autoplan-owner-text.ts fails here rather than silently changing what the
 * check freezes. Runs under a temporary HOME, drive and record root, serves its links from
 * a local server, and proves the real drive is untouched.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY_ONE_COLUMNS, DAY_ONE_TITLES } from '../lib/autoplan-owner-text';
import { buildFingerprint, checkLinks, decide, freezeActions, modelFamily, ownerScore, plainLine, predict, readManifest, recordResult, recordRoot, startRun, type Fetcher } from '../lib/first-use';
import { checkPlaySpec, PLAY_PARTS, renderBrief, renderPlayMessage } from '../lib/first-use-message';

const ROOT = path.resolve(import.meta.dir, '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'first-use');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'first-use-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const AUTOPLAN = fs.readFileSync(path.join(FIX, 'autoplan-plan.md'), 'utf8');
const ONE_PAGE = fs.readFileSync(path.join(FIX, 'one-page-plan.md'), 'utf8');
const PLAY = JSON.parse(fs.readFileSync(path.join(FIX, 'play.json'), 'utf8'));
const COMMIT = 'c0ffee'.padEnd(40, '0');
const BUILD = { platform: 'ios' as const, commit: COMMIT, testflight: '17' };
const PHONE_BUILD = '01KPHQ7Z3M8V2X5C9B4N6R1T0W';
const HOLDING = { build: 'TestFlight build 16', defects: 'the care card shows yesterday as the last watered date' };
const T0 = new Date('2026-11-18T10:00:00Z');
const ACTIONS = [
  'adds her first three plants by photo', 'sees which plant needs water today', 'marks a plant as watered', 'gets a reminder at 8am', "opens a plant's care card",
];
const STEPS = 7;
const CHECKER = 'openai/gpt-6.2-sol';
const TARGET = PLAY.target.name;
let n = 0;
const fresh = (name: string) => { const d = path.join(TMP, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const shot = (dir: string, name = 'shot.png', body = 'png bytes') => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
const playWith = (port: number, o: Record<string, unknown> = {}) => ({ ...PLAY, ...o, links: PLAY.links.map((l: { url: string }) => ({ ...l, url: l.url.replace('PORT', String(port)) })) });
const AS = { account: PLAY.account, device_class: 'ios' as const };
const okFetch: Fetcher = async url => ({ status: url.endsWith('/account') ? 401 : 200 });
const start = (o: { plan?: string; play?: unknown; root?: string; checker?: string } = {}) => {
  const root = o.root ?? fresh('root'), work = fresh('work');
  const planPath = path.join(work, 'plan.md');
  fs.writeFileSync(planPath, o.plan ?? AUTOPLAN);
  const r = startRun({ root, app: 'plantpal', planPath, build: BUILD, phoneBuild: PHONE_BUILD, play: o.play ?? playWith(1), holding: HOLDING, builder: 'anthropic/claude-opus-5-5', checker: o.checker ?? CHECKER, now: T0 });
  if ('error' in r) throw new Error(r.error.detail);
  return { ...r, planPath, work, root };
};
type Rec = { verdict?: string; line?: string; at?: Date; by?: string; account?: string; target?: string; evidence?: string; needsLookup?: string; notice?: string };
const rec = (r: { dir: string; work: string }, step: number, o: Rec = {}) => recordResult({ dir: r.dir, step, verdict: o.verdict ?? 'useful', line: o.line ?? `step ${step} does what she asked`,
  evidence: o.evidence ?? shot(r.work, `s${step}-${o.verdict ?? 'useful'}-${++n}.png`, `screen ${step}-${n}`), device: 'iPhone 17 Pro (cloud)', account: o.account ?? PLAY.account, target: o.target ?? TARGET,
  by: o.by ?? CHECKER, needsLookup: o.needsLookup, notice: o.notice, now: o.at ?? T0 });

/** A run on its own plan copy and record root, with every step useful and a prediction. */
function passedRun(o: { plan?: string } = {}) {
  const r = start(o);
  for (let s = 1; s <= STEPS; s++) { const x = rec(r, s); if ('error' in x) throw new Error(x.error.detail); }
  const p = predict({ dir: r.dir, score: '6', why: 'the reminder works but adding plants is slow', by: CHECKER, now: T0 });
  if ('error' in p) throw new Error(p.error.detail);
  return r;
}

describe('the day-one table and the owner quotes it cites (pinned)', () => {
  test('the parser this check reads keeps its titles and columns', () => {
    expect(DAY_ONE_TITLES).toEqual(['Day one', 'Day-one page', 'Day one page']);
    expect([...DAY_ONE_COLUMNS]).toEqual(['action', 'frequency', 'source', 'feature', 'route', 'first build', 'check']);
  });

  test('an autoplan plan and a one-page day-one list freeze the same five actions and quotes', () => {
    const a = freezeActions(AUTOPLAN), b = freezeActions(ONE_PAGE);
    if ('error' in a) throw new Error(a.error.detail);
    if ('error' in b) throw new Error(b.error.detail);
    expect(a.actions.map(x => x.action)).toEqual(ACTIONS);
    expect(b.actions).toEqual(a.actions);
    expect(b.quotes).toEqual(a.quotes);
    expect(b.rows_sha256).toBe(a.rows_sha256);
    expect(a.actions[3]).toEqual({ n: 4, action: 'gets a reminder at 8am', frequency: 'daily', feature: 'Morning reminder', route: 'notification', first_build: 'build 1', check: 'a notification arrives at 8:00 on the device', source: 'owner words 2', quote: 2 });
    expect(a.quotes[1]).toEqual({ n: 2, who: 'Ada Example, day 0', when: 'day 0', text: 'remind me every morning before work', line: 'does it' });
  });

  test('a sixth row marked assumed is not frozen; an assumed row in the first five refuses', () => {
    const assumed = AUTOPLAN.replace('| gets a reminder at 8am | daily | owner words 2 |', '| gets a reminder at 8am | daily | assumed |');
    expect(freezeActions(assumed)).toMatchObject({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'day-one row 4 is still marked assumed' } });
  });

  test('a row that cites no real quote refuses, so the five actions come from the owner\'s words', () => {
    const habit = AUTOPLAN.replace('| owner words 2 |', '| calendar habit |');
    expect(freezeActions(habit)).toMatchObject({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: expect.stringMatching(/^day-one row 4 cites none of the owner's quotes/) } });
    const ghost = AUTOPLAN.replace('| owner words 2 |', '| owner words 9 |');
    expect(freezeActions(ghost)).toMatchObject({ error: { detail: expect.stringMatching(/^day-one row 4 cites none/) } });
  });

  test('no Owner\'s words, a quote with no time or no line, or a bad line refuses', () => {
    const none = AUTOPLAN.replace(/### Owner's words[\s\S]*?### Day one/, '### Day one');
    expect(freezeActions(none)).toMatchObject({ error: { detail: expect.stringMatching(/^the plan has no ### Owner's words section/) } });
    const noLine = AUTOPLAN.replace('before work" → does it', 'before work"');
    expect(freezeActions(noLine)).toEqual({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'owner quote 2 needs a line (does it or choice)' } });
    const noTime = AUTOPLAN.replace('- Ada Example, day 0: "remind', '- Ada Example: "remind');
    expect(freezeActions(noTime)).toEqual({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'owner quote 2 needs when it was said' } });
    const bad = AUTOPLAN.replace('before work" → does it', 'before work" → maybe later');
    expect(freezeActions(bad)).toMatchObject({ error: { detail: expect.stringContaining('bullet 2 has a line that is not does it or choice') } });
  });

  test('editing or inserting a quote changes the frozen hash, even when the rows stay the same', () => {
    const a = freezeActions(AUTOPLAN), edited = freezeActions(AUTOPLAN.replace('before work', 'after breakfast'));
    const inserted = freezeActions(AUTOPLAN.replace('- Ada Example, day 0: "I keep', '- Ada Example, day 0: "I travel a lot" → does it\n- Ada Example, day 0: "I keep'));
    if ('error' in a || 'error' in edited) throw new Error('fixture did not freeze');
    expect(edited.rows_sha256).not.toBe(a.rows_sha256);
    expect('error' in inserted || inserted.rows_sha256 !== a.rows_sha256).toBe(true);
  });

  test('fewer than five rows, or an empty cell in the first five, refuses', () => {
    const four = ONE_PAGE.replace(/^\| opens a plant's care card .*\n/m, '');
    expect(freezeActions(four)).toEqual({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'the day-one table has 4 rows; the check needs 5' } });
    const blank = ONE_PAGE.replace('| Morning reminder | notification |', '| Morning reminder |  |');
    expect(freezeActions(blank)).toEqual({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'day-one row 4 has an empty cell; every column of the first 5 rows needs a value' } });
  });

  test('no table, a missing column or an empty table refuses', () => {
    expect(freezeActions('# A plan\n\nNo day one here.\n')).toEqual({ error: { code: 'FIRST_USE_PLAN_UNREADY', detail: 'the plan has no ### Day one table' } });
    const noCheck = ONE_PAGE.replace('| Check |', '| Notes |');
    expect(freezeActions(noCheck)).toMatchObject({ error: { detail: 'the table has no check column' } });
    const empty = '## Day one\n\n| action | frequency | source | feature | route | first build | check |\n|---|---|---|---|---|---|---|\n';
    expect(freezeActions(empty)).toMatchObject({ error: { code: 'FIRST_USE_PLAN_UNREADY' } });
  });
});

describe('model families and build fingerprints', () => {
  test('families come from the provider prefix, a family name or a known model word', () => {
    expect(modelFamily('openai/gpt-6.2-sol')).toBe('openai');
    expect(modelFamily('anthropic/claude-opus-5-5')).toBe('anthropic');
    expect(modelFamily('claude-fable-5-2')).toBe('anthropic');
    expect(modelFamily('gpt-6-astra')).toBe('openai');
    expect(modelFamily('google')).toBe('google');
    expect(modelFamily('gemini-4-carbon')).toBe('google');
    expect(modelFamily('mystery-model')).toBeUndefined();
    expect(modelFamily('openrouter/anthropic/claude-opus-5-5')).toBe('anthropic');
    expect(modelFamily('bedrock/anthropic.claude-sonnet-5-5')).toBe('anthropic');
    expect(modelFamily('zai/glm-5.3')).toBe('zai');
  });

  test('a same-family or unknown checker refuses at start', () => {
    const work = fresh('fam'), planPath = path.join(work, 'plan.md');
    fs.writeFileSync(planPath, AUTOPLAN);
    const base = { root: fresh('root'), app: 'plantpal', planPath, build: BUILD, phoneBuild: PHONE_BUILD, play: PLAY, holding: HOLDING };
    expect(startRun({ ...base, builder: 'anthropic/claude-opus-5-5', checker: 'claude-fable-5-2' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY', detail: 'builder and checker are both anthropic' } });
    expect(startRun({ ...base, builder: 'anthropic/claude-opus-5-5', checker: 'mystery-model' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY' } });
  });

  test('the build the owner holds now is named at start: a label and its known defects, or none', () => {
    const work = fresh('hold'), planPath = path.join(work, 'plan.md');
    fs.writeFileSync(planPath, AUTOPLAN);
    const base = { root: fresh('root'), app: 'plantpal', planPath, build: BUILD, phoneBuild: PHONE_BUILD, play: PLAY, builder: 'anthropic/claude-opus-5-5', checker: CHECKER };
    expect(startRun({ ...base, holding: { build: 'TestFlight build 16' } })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID', detail: expect.stringContaining('--holding-defects') } });
    expect('dir' in startRun({ ...base, holding: { build: 'none', defects: 'none' } })).toBe(true);
  });

  test('a build needs a full commit and exactly one of TestFlight build or deploy version; Mac and server builds count', () => {
    expect(buildFingerprint({ ...BUILD, commit: 'abc123' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(buildFingerprint({ ...BUILD, deploy: 'v1' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(buildFingerprint({ platform: 'web', commit: COMMIT })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(buildFingerprint({ platform: 'watch' as any, commit: COMMIT, deploy: 'v1' })).toMatchObject({ error: { detail: '--platform must be ios, android, web, macos, server' } });
    expect('fingerprint' in buildFingerprint({ platform: 'macos', commit: COMMIT, deploy: '0.3.1' })).toBe(true);
    expect('fingerprint' in buildFingerprint({ platform: 'server', commit: COMMIT, deploy: 'gateway 2026.11.23' })).toBe(true);
    const a = buildFingerprint(BUILD), b = buildFingerprint({ ...BUILD, testflight: '18' });
    if ('error' in a || 'error' in b) throw new Error('valid builds refused');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the play spec carries the ten parts, the target and the numbered try-it steps', () => {
  test('the fixture is complete and the parts are in order', () => {
    expect(checkPlaySpec(PLAY)).toMatchObject({ spec: { target: { kind: 'realistic-copy', name: TARGET }, steps: [{ writes: 'none' }, { writes: 'a Plantpal account' }] } });
    expect(PLAY_PARTS.map(p => p.part)).toEqual([
      'The links, each checked live minutes before sending', 'Device and setup', 'What it is, in a sentence', 'How to start', 'Controls',
      'How long to play', 'What we want to learn', 'How to report back', 'Known quirks', 'Reply word',
    ]);
  });

  test('missing parts are named', () => {
    const { controls: _c, quirks: _q, ...rest } = PLAY;
    const r = checkPlaySpec({ ...rest, links: [{ label: 'x', url: 'ftp://nope' }], minutes: 0 });
    expect(r).toEqual({ error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: 'missing or invalid: The links, each checked live minutes before sending (links); Controls (controls); How long to play (minutes); Known quirks (quirks)' } });
    expect(checkPlaySpec({ ...PLAY, reply_word: 'two words' })).toMatchObject({ error: { detail: 'missing or invalid: Reply word (reply_word)' } });
    expect(checkPlaySpec({ ...PLAY, steps: [{ text: 'Open it' }] })).toMatchObject({ error: { detail: 'missing or invalid: How to start (steps)' } });
    expect(checkPlaySpec({ ...PLAY, target: { name: 'a copy' } })).toMatchObject({ error: { detail: 'missing or invalid: Device and setup (target)' } });
  });

  test('a copy is the default target; a step that writes on the owner\'s real setup needs his approval named', () => {
    const { target: _t, ...noTarget } = PLAY;
    expect(checkPlaySpec({ ...noTarget, target: { name: 'a copy', data: 'sample rows' } })).toMatchObject({ spec: { target: { kind: 'realistic-copy' } } });
    const reads = Array.from({ length: 5 }, () => ({ writes: 'none' }));
    const real = { ...PLAY, target: { kind: 'real', name: "Ada's own phone" }, action_writes: reads };
    expect(checkPlaySpec(real)).toEqual({ error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: "step 2 writes on the owner's real setup with no approved_write naming his lettered approval; run it on a realistic copy, or get his approval for that write first" } });
    const approved = { ...real, steps: [PLAY.steps[0], { ...PLAY.steps[1], approved_write: 'Ada, 2026-11-18: "B1"' }] };
    expect(checkPlaySpec(approved)).toMatchObject({ spec: { target: { kind: 'real' }, steps: [{}, { approved_write: 'Ada, 2026-11-18: "B1"' }], action_writes: reads } });
  });

  test('on the owner\'s real setup each day-one action says what it writes, and a write needs his approval', () => {
    const steps = [PLAY.steps[0]];
    const real = { ...PLAY, steps, target: { kind: 'real', name: "Ada's own phone" } };
    expect(checkPlaySpec(real)).toMatchObject({ error: { detail: 'missing or invalid: Device and setup (action_writes)' } });
    expect(checkPlaySpec({ ...real, action_writes: [{ writes: 'none' }] })).toMatchObject({ error: { detail: 'missing or invalid: Device and setup (action_writes)' } });
    const acts = [{ writes: 'none' }, { writes: 'none' }, { writes: 'archives a plant' }, { writes: 'none' }, { writes: 'none' }];
    expect(checkPlaySpec({ ...real, action_writes: acts })).toEqual({ error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: "day-one action 3 writes on the owner's real setup with no approved_write naming his lettered approval; run it on a realistic copy, or get his approval for that write first" } });
    acts[2] = { writes: 'archives a plant', approved_write: 'Ada, 2026-11-18: "C1"' } as typeof acts[number];
    expect(checkPlaySpec({ ...real, action_writes: acts })).toMatchObject({ spec: { action_writes: [{}, {}, { approved_write: 'Ada, 2026-11-18: "C1"' }, {}, {}] } });
  });
});

describe('where records live', () => {
  test('override, then the one user drive on Capy, else the state root', () => {
    const home = fresh('home');
    expect(recordRoot({ GSTACK_FIRST_USE_DIR: path.join(home, 'x') })).toEqual({ root: path.join(home, 'x') });
    expect(recordRoot({ HOME: home, GSTACK_CAPY: '1' })).toMatchObject({ error: { code: 'FIRST_USE_NO_PRIVATE_DRIVE' } });
    fs.mkdirSync(path.join(home, '.capy', 'drive', 'user-ada-example'), { recursive: true });
    fs.mkdirSync(path.join(home, '.capy', 'drive', 'project-plantpal'), { recursive: true });
    expect(recordRoot({ HOME: home, GSTACK_CAPY: '1' })).toEqual({ root: path.join(home, '.capy', 'drive', 'user-ada-example', 'first-use') });
    fs.mkdirSync(path.join(home, '.capy', 'drive', 'user-bo-example'), { recursive: true });
    expect(recordRoot({ HOME: home, GSTACK_CAPY: '1' })).toMatchObject({ error: { code: 'FIRST_USE_NO_PRIVATE_DRIVE', detail: '2 user-level drive folders (user-ada-example, user-bo-example)' } });
    expect(recordRoot({ HOME: home, GSTACK_STATE_ROOT: path.join(home, 'state') })).toEqual({ root: path.join(home, 'state', 'first-use') });
  });

  test('several user drives are named in sorted order whatever order the filesystem lists them', () => {
    const home = fresh('home');
    for (const d of ['user-ada-example', 'user-bo-example']) fs.mkdirSync(path.join(home, '.capy', 'drive', d), { recursive: true });
    const readdir = fs.readdirSync;
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => (readdir(p, o as undefined) as string[]).slice().sort().reverse()) as typeof fs.readdirSync);
    try {
      expect(recordRoot({ HOME: home, GSTACK_CAPY: '1' })).toMatchObject({ error: { code: 'FIRST_USE_NO_PRIVATE_DRIVE', detail: '2 user-level drive folders (user-ada-example, user-bo-example)' } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the gate', () => {
  test('every step played, live links and a prediction clear the exact build; the message opens with her words and names the build she holds', async () => {
    const r = passedRun();
    expect(decide(r.dir, BUILD, T0).reasons).toEqual(['link_unchecked: http://127.0.0.1:1/testflight (as a fresh Apple ID with notifications allowed on ios)', 'link_unchecked: http://127.0.0.1:1/account (as a fresh Apple ID with notifications allowed on ios)']);
    const links = await checkLinks(r.dir, AS, okFetch, () => T0);
    expect('receipts' in links && links.receipts.map(x => x.verdict)).toEqual(['live', 'live']);
    const d = decide(r.dir, BUILD, new Date(T0.getTime() + 5 * 60_000));
    expect(d).toMatchObject({ ok: true, reasons: [], passed: STEPS });
    const msg = renderPlayMessage(d, new Date(T0.getTime() + 5 * 60_000));
    expect(msg.startsWith('**Try plantpal: c0ffee000000, TestFlight build 17**\n\n**What you asked for, and what this version does with it:**\n- Ada Example, day 0: “I keep forgetting which plant needs water” → does it\n')).toBe(true);
    for (const [i, label] of ['Links', 'Device and setup', 'What it is', 'How to start', 'Controls', 'How long', 'What we want to learn', 'How to report back', 'Known quirks', 'Reply word'].entries()) {
      expect(msg).toContain(`${i + 1}. **${label}`);
    }
    expect(msg).toContain('It runs on the Plantpal test account (a copy loaded with three sample plants with a watering history).');
    expect(msg).toContain('   1. Open the TestFlight invite and install Plantpal');
    expect(msg).toContain('   4. Try: sees which plant needs water today');
    expect(msg).toContain('checked live at 10:00 UTC, 5 min before this message');
    expect(msg).toContain('[TestFlight invite](http://127.0.0.1:1/testflight)');
    expect(msg).toContain('(asks you to sign in)');
    expect(msg).toContain("**What you'll notice:**\n- nothing beyond the known quirks above");
    expect(msg).toContain('**The build on your device now:** TestFlight build 16. Known defects in it: the care card shows yesterday as the last watered date.');
    expect(msg).toContain('- 7 (useful): step 7 does what she asked');
    expect(msg).not.toContain('predict');
    expect(msg.startsWith(d.manifest!.try_text)).toBe(true);
  });

  test('another build, a stale link, a changed day-one row or quote and tampered evidence each refuse', async () => {
    const r = passedRun();
    await checkLinks(r.dir, AS, okFetch, () => T0);
    expect(decide(r.dir, { ...BUILD, testflight: '18' }, T0).reasons).toEqual(['build_mismatch: this run checked c0ffee000000, TestFlight build 17, not c0ffee000000, TestFlight build 18']);
    expect(decide(r.dir, BUILD, new Date(T0.getTime() + 16 * 60_000)).reasons).toEqual([
      'link_stale: http://127.0.0.1:1/testflight was checked at 2026-11-18T10:00:00.000Z, over 15 minutes ago',
      'link_stale: http://127.0.0.1:1/account was checked at 2026-11-18T10:00:00.000Z, over 15 minutes ago',
    ]);
    const changed = "source_changed: the day-one rows or the owner's quotes changed since the check started; start a new run";
    fs.writeFileSync(r.planPath, AUTOPLAN.replace('gets a reminder at 8am', 'gets a reminder at 9am'));
    expect(decide(r.dir, BUILD, T0).reasons).toEqual([changed]);
    fs.writeFileSync(r.planPath, AUTOPLAN.replace('before work', 'after breakfast'));
    expect(decide(r.dir, BUILD, T0).reasons).toEqual([changed]);
    fs.writeFileSync(r.planPath, AUTOPLAN + '\nAn edit outside the table does not count.\n');
    expect(decide(r.dir, BUILD, T0).ok).toBe(true);
    const ev = fs.readdirSync(path.join(r.dir, 'evidence')).find(f => f.startsWith('2-'))!;
    fs.writeFileSync(path.join(r.dir, 'evidence', ev), 'edited');
    expect(decide(r.dir, BUILD, T0).reasons).toEqual(['step_2_evidence_stale']);
  });

  test('a stored result whose verdict is not useful or thin refuses, whatever it says (fail closed, as the merge base required pass)', async () => {
    for (const verdict of ['pass', 'great', undefined]) {
      const r = passedRun();
      await checkLinks(r.dir, AS, okFetch, () => T0);
      expect(decide(r.dir, BUILD, T0).ok).toBe(true);
      const file = path.join(r.dir, 'results', fs.readdirSync(path.join(r.dir, 'results')).find(f => JSON.parse(fs.readFileSync(path.join(r.dir, 'results', f), 'utf8')).step === 3)!);
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, JSON.stringify({ ...row, verdict }));
      expect(decide(r.dir, BUILD, T0).reasons).toEqual([`step_3_verdict_unknown: ${String(verdict)}`]);
    }
  });

  test('a try-it text edited after the check refuses', async () => {
    const r = passedRun();
    await checkLinks(r.dir, AS, okFetch, () => T0);
    const file = path.join(r.dir, 'manifest.json'), m = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...m, try_text: m.try_text + '\nOne more line.\n' }));
    expect(decide(r.dir, BUILD, T0).reasons.some(x => x.startsWith('try_text_changed'))).toBe(true);
  });

  test('broken, wrong, a lookup the owner would be asked for and a thin day-one action refuse; the newest result counts', async () => {
    const r = start({ checker: 'gemini-4-carbon' });
    const by = 'google/gemini-4-carbon';
    for (let s = 1; s <= STEPS; s++) rec(r, s, { by });
    rec(r, 2, { by, verdict: 'useful', line: 'asks for her iCloud address', needsLookup: 'her iCloud address, which the Mac already knows', at: new Date(T0.getTime() + 1000) });
    rec(r, 4, { by, verdict: 'thin', line: 'shows one plant, not which needs water', at: new Date(T0.getTime() + 1000) });
    rec(r, 5, { by, verdict: 'broken', line: 'the Watered button does nothing', at: new Date(T0.getTime() + 1000) });
    rec(r, 6, { by, verdict: 'wrong', line: 'the reminder arrives at 8pm', at: new Date(T0.getTime() + 1000) });
    await checkLinks(r.dir, AS, async () => ({ status: 401 }), () => T0);
    expect(decide(r.dir, BUILD, T0).reasons).toEqual([
      'step_2_needs_lookup: her iCloud address, which the Mac already knows (an agent looks it up or does it; the owner is never asked)',
      "step_4_thin: shows one plant, not which needs water (a day-one action comes from the owner's own words)",
      'step_5_broken: the Watered button does nothing', 'step_6_wrong: the reminder arrives at 8pm',
      'link_down: http://127.0.0.1:1/testflight (status 401)', 'no_predicted_score',
    ]);
    const later = new Date(T0.getTime() + 60_000);
    for (const s of [2, 4, 5, 6]) rec(r, s, { by, at: later });
    await checkLinks(r.dir, AS, okFetch, () => later);
    expect(predict({ dir: r.dir, score: '7', why: 'clean', by: 'gemini-4-carbon' })).toMatchObject({ prediction: { score: 7 } });
    expect(predict({ dir: r.dir, score: '8', why: 'again', by: 'gemini-4-carbon' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(decide(r.dir, BUILD, later)).toMatchObject({ ok: true, passed: STEPS });
  });

  test('a thin play step and a notice pass, and the message names both', async () => {
    const r = passedRun();
    const later = new Date(T0.getTime() + 1000);
    rec(r, 2, { verdict: 'thin', line: 'sign-in works but asks for a password twice', notice: 'iOS asks to allow notifications', at: later });
    await checkLinks(r.dir, AS, okFetch, () => later);
    const d = decide(r.dir, BUILD, later);
    expect(d).toMatchObject({ ok: true, passed: STEPS });
    const msg = renderPlayMessage(d, later);
    expect(msg).toContain("**What you'll notice:**\n- Step 2 is thin: sign-in works but asks for a password twice\n- At step 2 you'll see: iOS asks to allow notifications\n");
    expect(msg).toContain('- 2 (thin): sign-in works but asks for a password twice');
  });

  test('a first build says so; checker text is one plain line', () => {
    const r = start();
    const read = readManifest(r.dir);
    if ('error' in read) throw new Error(read.error.detail);
    const first = { ...read.manifest, holding: { build: 'none', defects: 'none' } };
    expect(renderPlayMessage({ ok: true, reasons: [], manifest: first, passed: 0, verdicts: [], links: [{ checked_at: T0.toISOString() } as any] }, T0)).toContain('**The build on your device now:** none yet: this is your first build of it.');
    expect(plainLine('see [the docs](https://evil.example) <b>now</b>\nplease')).toBe('see the docs now please');
    expect(plainLine('x'.repeat(500))).toHaveLength(240);
    expect(rec(r, 1, { line: '  \n ' })).toMatchObject({ error: { detail: '--line needs one line on what the owner would see at this step' } });
  });

  test('link receipts and results bind the owner-equivalent account, device class and target', async () => {
    const r = passedRun();
    expect(await checkLinks(r.dir, { account: 'any session', device_class: 'ios' }, okFetch, () => T0)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(await checkLinks(r.dir, { account: PLAY.account, device_class: 'web' }, okFetch, () => T0)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(fs.existsSync(path.join(r.dir, 'links'))).toBe(false);
    const other = { schema_version: 1, kind: 'first-use-link', url: 'http://127.0.0.1:1/testflight', build_fingerprint: JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8')).build.fingerprint, audience: { account: 'a developer account', device_class: 'ios' }, checked_at: T0.toISOString(), status: 200, login_gated: false, verdict: 'live' };
    fs.mkdirSync(path.join(r.dir, 'links'));
    fs.writeFileSync(path.join(r.dir, 'links', 'other.json'), JSON.stringify(other));
    expect(decide(r.dir, BUILD, T0).reasons[0]).toBe('link_unchecked: http://127.0.0.1:1/testflight (as a fresh Apple ID with notifications allowed on ios)');
    expect(rec(r, 1, { account: 'a developer account' })).toMatchObject({ error: { detail: 'play on the owner-equivalent account and pass it exactly: --account "a fresh Apple ID with notifications allowed"' } });
    expect(rec(r, 1, { target: 'a scratch config' })).toMatchObject({ error: { detail: 'play on the play spec\'s target and pass it exactly: --target "the Plantpal test account"' } });
  });

  test('the builder cannot record a result or a prediction, and evidence must be a screenshot, video or terminal capture', () => {
    const r = passedRun();
    expect(rec(r, 1, { by: 'anthropic/claude-opus-5-5' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY' } });
    expect(rec(r, 1, { evidence: shot(r.work, 'notes.pdf') })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(rec(r, 1, { evidence: shot(r.work, 'terminal.log', 'gateway: ok') })).toMatchObject({ result: { evidence: { kind: 'text' } } });
    expect(rec(r, 1, { verdict: 'pass' })).toMatchObject({ error: { detail: '--verdict must be useful, thin, wrong, broken' } });
    expect(rec(r, 8)).toMatchObject({ error: { detail: '--step must be 1 to 7' } });
    const link = path.join(r.work, 'link.png');
    fs.symlinkSync(shot(r.work, 'real.png'), link);
    expect(rec(r, 1, { evidence: link })).toMatchObject({ error: { detail: 'the evidence must be a regular file, not a link or directory' } });
  });

  test('a schema-1 run from before this change refuses with a clear line', () => {
    const r = passedRun();
    const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
    const old = fresh('old');
    fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ ...m, schema_version: 1 }));
    expect(readManifest(old)).toMatchObject({ error: { detail: `${old} is a schema-1 run from before the try-it steps and the owner's quotes were checked; start a new run` } });
  });

  test('the owner score and words sit beside the prediction; the manifest is written once', () => {
    const r = passedRun();
    expect(ownerScore({ dir: r.dir, score: '4', words: '', by: 'GStack Minder' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    ownerScore({ dir: r.dir, score: '4', words: '4, Talk is slow', by: 'GStack Minder', now: T0 });
    ownerScore({ dir: r.dir, score: '5', words: '5, better after the fix', by: 'GStack Minder', now: new Date(T0.getTime() + 60_000) });
    const d = decide(r.dir, BUILD, T0);
    expect(d.prediction?.score).toBe(6);
    expect(d.owner).toMatchObject({ score: 5, words: '5, better after the fix' });
    expect(fs.readdirSync(path.join(r.dir, 'owner'))).toHaveLength(2);
    const again = startRun({ root: r.root, app: 'plantpal', planPath: r.planPath, build: BUILD, phoneBuild: PHONE_BUILD, play: PLAY, holding: HOLDING, builder: 'anthropic/claude-opus-5-5', checker: CHECKER, now: T0 });
    expect(again).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
  });

  test('a record write that fails refuses with FIRST_USE_RECORD_INVALID instead of throwing', async () => {
    const r = passedRun();
    for (const d of ['results', 'links', 'owner']) {
      fs.rmSync(path.join(r.dir, d), { recursive: true, force: true });
      fs.writeFileSync(path.join(r.dir, d), 'not a directory');
    }
    expect(rec(r, 1)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(await checkLinks(r.dir, AS, okFetch)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(ownerScore({ dir: r.dir, score: '4', words: '4, fine', by: 'GStack Minder' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
  });

  test('the brief shell-quotes every value it puts into the record and predict lines', () => {
    const marker = path.join(fresh('quote'), 'ran');
    const account = `Ada's "test" $HOME \`touch ${marker}\` $(touch ${marker}) account`;
    const target = `it's $(touch ${marker}) copy`;
    const r = start({ root: path.join(fresh('root'), 'it\'s "$x"'), play: { ...PLAY, account, target: { ...PLAY.target, name: target } } });
    const lines = renderBrief(r.manifest, r.dir).split('\n').filter(l => l.startsWith('gstack-first-use '));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const argv = spawnSync('bash', ['-c', line.replace(/^gstack-first-use /, "printf '%s\\n' ")], { encoding: 'utf8', timeout: 10_000 }).stdout.split('\n');
      expect(argv[argv.indexOf('--run') + 1]).toBe(r.dir);
      expect(argv[argv.indexOf('--by') + 1]).toBe(CHECKER);
      if (line.includes(' record ')) { expect(argv[argv.indexOf('--account') + 1]).toBe(account); expect(argv[argv.indexOf('--target') + 1]).toBe(target); }
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('the brief gives the checker the exact try-it message, the target and its rules, and nothing about the build', () => {
    const r = passedRun();
    const read = readManifest(r.dir);
    if ('error' in read) throw new Error('no manifest');
    const brief = renderBrief(read.manifest, r.dir);
    expect(brief).toContain('You run on openai/gpt-6.2-sol; the team that built it runs on anthropic models');
    expect(brief).toContain('tools.capy.phone');
    expect(brief).toContain('TestFlight build 17');
    expect(brief).toContain(read.manifest.try_text.trimEnd());
    expect(brief).toContain('Never send anything as the owner');
    expect(brief).toContain('Run every step on the Plantpal test account (a copy loaded with three sample plants with a watering history)');
    expect(brief).toContain('2. Sign in with the account above. Writes: a Plantpal account');
    expect(brief).toContain("3. Day-one action, from the owner's words (quote 1): adds her first three plants by photo. It works when: three plants show on the home screen with names. Writes: unknown, so treat it as a write");
    expect(brief).toContain(`gstack-first-use record --run '${r.dir}' --step N --verdict useful --line 'WHAT THE OWNER SEES' --evidence FILE --device 'DEVICE YOU USED' --account 'a fresh Apple ID with notifications allowed' --target 'the Plantpal test account' --by 'openai/gpt-6.2-sol'`);
    expect(brief).not.toContain(r.planPath);
    expect(brief).not.toContain('TestFlight build 16');
  });

  test('a phone build installs the build-service build start names, and start refuses a phone build without one (GST-3646)', () => {
    const work = fresh('phone'), planPath = path.join(work, 'plan.md');
    fs.writeFileSync(planPath, AUTOPLAN);
    const base = { app: 'plantpal', planPath, play: playWith(1), holding: HOLDING, builder: 'anthropic/claude-opus-5-5', checker: CHECKER, now: T0 };
    for (const build of [BUILD, { platform: 'android' as const, commit: COMMIT, deploy: '1.0.3' }]) {
      expect(startRun({ ...base, root: fresh('root'), build })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID', detail: expect.stringContaining('--phone-build') } });
      expect(startRun({ ...base, root: fresh('root'), build, phoneBuild: '17' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID', detail: expect.stringContaining('--phone-build') } });
    }
    const r = startRun({ ...base, root: fresh('root'), build: BUILD, phoneBuild: PHONE_BUILD });
    if ('error' in r) throw new Error(r.error.detail);
    expect(r.manifest.phone_build).toBe(PHONE_BUILD);
    const brief = renderBrief(r.manifest, r.dir);
    expect(brief).toContain(`(action "install" with build_id "${PHONE_BUILD}"`);
    expect(brief).not.toContain('action "install"; TestFlight build');
    const old = { ...r.manifest } as Partial<typeof r.manifest>;
    delete old.phone_build;
    fs.writeFileSync(path.join(r.dir, 'manifest.json'), JSON.stringify(old));
    expect(readManifest(r.dir)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID', detail: expect.stringContaining('start a new run with --phone-build') } });
    const android = startRun({ ...base, root: fresh('root'), build: { platform: 'android', commit: COMMIT, deploy: '1.0.3' }, phoneBuild: PHONE_BUILD });
    if ('error' in android) throw new Error(android.error.detail);
    expect(renderBrief(android.manifest, android.dir)).toContain(`build_id "${PHONE_BUILD}", the mobile build service's build of commit ${COMMIT.slice(0, 12)}, which version 1.0.3 ships`);
    const web = startRun({ ...base, root: fresh('root'), build: { platform: 'web', commit: COMMIT, deploy: 'web-12' } });
    expect('error' in web ? web.error.detail : web.manifest.phone_build).toBeUndefined();
  });

  test('the brief drives a Mac through Aside and a server over its shell', () => {
    const work = fresh('mac'), planPath = path.join(work, 'plan.md');
    fs.writeFileSync(planPath, AUTOPLAN);
    const base = { root: fresh('root'), app: 'helper', planPath, holding: HOLDING, builder: 'anthropic/claude-opus-5-5', checker: CHECKER, now: T0 };
    const mac = startRun({ ...base, build: { platform: 'macos', commit: COMMIT, deploy: '0.3.1' }, play: { ...PLAY, target: { kind: 'real', name: "Ada's Mac" }, steps: [{ text: 'Run helper setup', writes: 'none' }], action_writes: Array.from({ length: 5 }, () => ({ writes: 'none' })) } });
    if (!('error' in mac)) expect(mac.manifest.steps.filter(s => s.kind === 'action').map(s => s.writes)).toEqual(['none', 'none', 'none', 'none', 'none']);
    if ('error' in mac) throw new Error(mac.error.detail);
    expect(renderBrief(mac.manifest, mac.dir)).toContain('through the Aside CLI, preferably over Tailscale');
    const srv = startRun({ ...base, root: fresh('root'), build: { platform: 'server', commit: COMMIT, deploy: 'gw-7' }, play: PLAY });
    if ('error' in srv) throw new Error(srv.error.detail);
    expect(renderBrief(srv.manifest, srv.dir)).toContain('over its shell or CLI');
  });
});

describe('gstack-first-use (CLI, temporary HOME and drive)', () => {
  const BIN = path.join(ROOT, 'bin', 'gstack-first-use');
  const realDrive = path.join(os.homedir(), '.capy', 'drive');
  const realRecords = () => { try { return fs.readdirSync(realDrive).filter(d => fs.existsSync(path.join(realDrive, d, 'first-use'))).map(d => `${d}:${fs.readdirSync(path.join(realDrive, d, 'first-use')).join(',')}`); } catch { return []; } };
  let server: ReturnType<typeof Bun.serve>;
  let home: string, env: Record<string, string>;
  const before = realRecords();
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new Response('ok', { status: new URL(req.url).pathname === '/account' ? 403 : 200 }) });
    home = fresh('home');
    fs.mkdirSync(path.join(home, '.capy', 'drive', 'user-ada-example'), { recursive: true });
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GSTACK_')).map(([k, v]) => [k, v ?? '']));
    Object.assign(env, { HOME: home, GSTACK_CAPY: '1', GSTACK_STATE_ROOT: path.join(home, 'state') });
  });
  afterAll(() => server?.stop(true));
  const cli = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };

  test('start, brief, record, predict, links, message, score and show in the owner\'s private drive', async () => {
    const work = fresh('cli');
    const plan = path.join(work, 'plan.md'), play = path.join(work, 'play.json');
    fs.writeFileSync(plan, AUTOPLAN);
    fs.writeFileSync(play, JSON.stringify(playWith(server.port!)));
    const build = ['--platform', 'ios', '--commit', COMMIT, '--testflight', '17'];
    const holding = ['--holding', 'TestFlight build 16', '--holding-defects', 'none'];
    expect((await cli('start', '--app', 'plantpal', '--plan', plan, '--play', play, ...build, '--builder', 'anthropic/claude-opus-5-5', '--checker', CHECKER)).stderr).toContain('--holding, --holding-defects');
    const begun = await cli('start', '--app', 'plantpal', '--plan', plan, '--play', play, ...build, '--phone-build', PHONE_BUILD, ...holding, '--builder', 'anthropic/claude-opus-5-5', '--checker', CHECKER);
    expect(begun.code).toBe(0);
    const dir = /^FIRST_USE_RUN: (.+)$/m.exec(begun.stdout)![1]!;
    expect(dir.startsWith(path.join(home, '.capy', 'drive', 'user-ada-example', 'first-use', 'plantpal') + path.sep)).toBe(true);
    expect(begun.stdout).toContain('FIRST_USE_FROZEN: 7 steps (5 day-one actions) quotes=2');
    expect(begun.stdout).toContain('  2. Sign in with the account above (writes: a Plantpal account)');

    const early = await cli('message', '--run', dir, ...build);
    expect(early.code).toBe(3);
    expect(early.stdout).toBe('');
    expect(early.stderr).toContain('(FIRST_USE_REFUSED)');
    expect(early.stderr).toContain('step_1_not_played');

    const brief = await cli('brief', '--run', dir);
    expect(brief.stdout).toContain('# Cold first-use check: plantpal');
    expect(brief.stderr).toContain('DISPATCH: give this brief');

    for (let s = 1; s <= STEPS; s++) {
      const one = await cli('record', '--run', dir, '--step', String(s), '--verdict', 'useful', '--line', 'works', '--evidence', shot(work, `s${s}.png`, `s${s}`), '--device', 'iPhone 17 Pro (cloud)', '--account', PLAY.account, '--target', TARGET, '--by', CHECKER);
      expect(one.code).toBe(0);
    }
    expect((await cli('predict', '--run', dir, '--score', '6', '--why', 'reminder works, adding is slow', '--by', CHECKER)).stdout).toContain('FIRST_USE_PREDICTED: 6');
    expect((await cli('links', '--run', dir)).code).toBe(1);
    const links = await cli('links', '--run', dir, '--account', PLAY.account, '--device-class', 'ios');
    expect(links.code).toBe(0);
    expect(links.stdout).toContain('LINK: live status=403 as=ios');

    const check = await cli('check', '--run', dir, ...build);
    expect(check.stdout).toMatch(/^FIRST_USE: pass app=plantpal build=c0ffee000000, TestFlight build 17 steps=7\/7 thin=0 notices=0 links=2\/2 checker=openai\/gpt-6.2-sol predicted=6$/m);
    const msg = await cli('message', '--run', dir, ...build);
    expect(msg.code).toBe(0);
    expect(msg.stdout).toContain('10. **Reply word:** played');
    expect(msg.stdout).toContain('**The build on your device now:** TestFlight build 16. Known defects in it: none.');
    expect((await cli('check', '--run', dir, '--platform', 'ios', '--commit', COMMIT, '--testflight', '18')).code).toBe(3);

    expect((await cli('score', '--run', dir, '--score', '4', '--words', '4, Talk is slow', '--by', 'Example Captain')).code).toBe(0);
    const show = await cli('show', '--run', dir, '--json');
    expect(JSON.parse(show.stdout)).toMatchObject({ passed: 7, steps: 7, predicted: 6, owner: { score: 4, words: '4, Talk is slow' }, gap: -2 });
    expect(realRecords()).toEqual(before);
  });

  test('a run outside the record root and a second user drive refuse', async () => {
    const outside = fresh('outside');
    const r = await cli('show', '--run', outside);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is outside the record root');
    fs.mkdirSync(path.join(home, '.capy', 'drive', 'user-bo-example'), { recursive: true });
    const two = await cli('root');
    expect(two.code).toBe(3);
    expect(two.stderr).toContain('(FIRST_USE_NO_PRIVATE_DRIVE)');
    fs.rmSync(path.join(home, '.capy', 'drive', 'user-bo-example'), { recursive: true });
  });
});
