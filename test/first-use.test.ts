/**
 * The first-use check (lib/first-use.ts, lib/first-use-message.ts, bin/gstack-first-use;
 * docs/first-use-check.md). Every owner, app, plan and build here is made up. Pins the
 * day-one table format both plan sources share (autoplan's ### Day one table and the
 * one-page day-one list), so a change to lib/autoplan-owner-text.ts fails here rather
 * than silently changing what the check freezes. Runs under a temporary HOME, drive and
 * record root, serves its links from a local server, and proves the real drive is untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY_ONE_COLUMNS, DAY_ONE_TITLES } from '../lib/autoplan-owner-text';
import { buildFingerprint, checkLinks, decide, freezeActions, modelFamily, ownerScore, predict, readManifest, recordResult, recordRoot, startRun, type Fetcher } from '../lib/first-use';
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
const T0 = new Date('2026-11-18T10:00:00Z');
const ACTIONS = [
  'adds her first three plants by photo', 'sees which plant needs water today', 'marks a plant as watered', 'gets a reminder at 8am', "opens a plant's care card",
];
let n = 0;
const fresh = (name: string) => { const d = path.join(TMP, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const shot = (dir: string, name = 'shot.png', body = 'png bytes') => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
const playWith = (port: number) => ({ ...PLAY, links: PLAY.links.map((l: { url: string }) => ({ ...l, url: l.url.replace('PORT', String(port)) })) });
const AS = { account: PLAY.account, device_class: 'ios' as const };
const okFetch: Fetcher = async url => ({ status: url.endsWith('/account') ? 401 : 200 });

/** A run on its own plan copy and record root, with every action passed, the links checked and a prediction. */
function passedRun(o: { plan?: string } = {}) {
  const root = fresh('root'), work = fresh('work');
  const planPath = path.join(work, 'plan.md');
  fs.writeFileSync(planPath, o.plan ?? AUTOPLAN);
  const r = startRun({ root, app: 'plantpal', planPath, build: BUILD, play: playWith(1), builder: 'anthropic/claude-opus-5-5', checker: 'openai/gpt-6.2-sol', now: T0 });
  if ('error' in r) throw new Error(r.error.detail);
  for (let a = 1; a <= 5; a++) {
    const rec = recordResult({ dir: r.dir, action: a, verdict: 'pass', evidence: shot(work, `a${a}.png`, `screen ${a}`), device: 'iPhone 17 Pro (cloud)', account: PLAY.account, by: 'openai/gpt-6.2-sol', now: T0 });
    if ('error' in rec) throw new Error(rec.error.detail);
  }
  const p = predict({ dir: r.dir, score: '6', why: 'the reminder works but adding plants is slow', by: 'openai/gpt-6.2-sol', now: T0 });
  if ('error' in p) throw new Error(p.error.detail);
  return { ...r, planPath, work, root };
}

describe('the day-one table format (pinned)', () => {
  test('the parser this check reads keeps its titles and columns', () => {
    expect(DAY_ONE_TITLES).toEqual(['Day one', 'Day-one page', 'Day one page']);
    expect([...DAY_ONE_COLUMNS]).toEqual(['action', 'frequency', 'source', 'feature', 'route', 'first build', 'check']);
  });

  test('an autoplan plan and a one-page day-one list freeze the same five actions', () => {
    const a = freezeActions(AUTOPLAN), b = freezeActions(ONE_PAGE);
    if ('error' in a || 'error' in b) throw new Error('fixture did not freeze');
    expect(a.actions.map(x => x.action)).toEqual(ACTIONS);
    expect(b.actions).toEqual(a.actions);
    expect(b.rows_sha256).toBe(a.rows_sha256);
    expect(a.actions[3]).toEqual({ n: 4, action: 'gets a reminder at 8am', frequency: 'daily', feature: 'Morning reminder', route: 'notification', first_build: 'build 1', check: 'a notification arrives at 8:00 on the device', source: 'calendar habit' });
  });

  test('a sixth row marked assumed is not frozen; an assumed row in the first five refuses', () => {
    expect('error' in freezeActions(AUTOPLAN)).toBe(false);
    const assumed = AUTOPLAN.replace('| gets a reminder at 8am | daily | calendar habit |', '| gets a reminder at 8am | daily | assumed |');
    const r = freezeActions(assumed);
    expect('error' in r && r.error).toEqual({ code: 'FIRST_USE_PLAN_UNREADY', detail: 'day-one row 4 is still marked assumed' });
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
    expect('error' in freezeActions(noCheck) && freezeActions(noCheck)).toMatchObject({ error: { detail: 'the table has no check column' } });
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
    const base = { root: fresh('root'), app: 'plantpal', planPath, build: BUILD, play: PLAY };
    expect(startRun({ ...base, builder: 'anthropic/claude-opus-5-5', checker: 'claude-fable-5-2' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY', detail: 'builder and checker are both anthropic' } });
    expect(startRun({ ...base, builder: 'anthropic/claude-opus-5-5', checker: 'mystery-model' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY' } });
  });

  test('a build needs a full commit and exactly one of TestFlight build or deploy version', () => {
    expect(buildFingerprint({ ...BUILD, commit: 'abc123' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(buildFingerprint({ ...BUILD, deploy: 'v1' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(buildFingerprint({ platform: 'web', commit: COMMIT })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    const a = buildFingerprint(BUILD), b = buildFingerprint({ ...BUILD, testflight: '18' });
    if ('error' in a || 'error' in b) throw new Error('valid builds refused');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the play spec carries the ten parts of every play ask', () => {
  test('the fixture is complete and the parts are in order', () => {
    expect('spec' in checkPlaySpec(PLAY)).toBe(true);
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
});

describe('the gate', () => {
  test('five passes, live links and a prediction clear the exact build, and the message carries every part', async () => {
    const r = passedRun();
    expect(decide(r.dir, BUILD, T0).reasons).toEqual(['link_unchecked: http://127.0.0.1:1/testflight (as a fresh Apple ID with notifications allowed on ios)', 'link_unchecked: http://127.0.0.1:1/account (as a fresh Apple ID with notifications allowed on ios)']);
    const links = await checkLinks(r.dir, AS, okFetch, () => T0);
    expect('receipts' in links && links.receipts.map(x => x.verdict)).toEqual(['live', 'live']);
    const d = decide(r.dir, BUILD, new Date(T0.getTime() + 5 * 60_000));
    expect(d).toMatchObject({ ok: true, reasons: [], passed: 5 });
    const msg = renderPlayMessage(d, new Date(T0.getTime() + 5 * 60_000));
    for (const [i, label] of ['Links', 'Device and setup', 'What it is', 'How to start', 'Controls', 'How long', 'What we want to learn', 'How to report back', 'Known quirks', 'Reply word'].entries()) {
      expect(msg).toContain(`${i + 1}. **${label}`);
    }
    expect(msg).toContain('checked live at 10:00 UTC, 5 min before this message');
    expect(msg).toContain('[TestFlight invite](http://127.0.0.1:1/testflight)');
    expect(msg).toContain('(asks you to sign in)');
    expect(msg).toContain('Try plantpal: c0ffee000000, TestFlight build 17');
    for (const a of ACTIONS) expect(msg).toContain(`- ${a}`);
    expect(msg).not.toContain('predict');
  });

  test('another build, a stale link, a changed day-one row and tampered evidence each refuse', async () => {
    const r = passedRun();
    await checkLinks(r.dir, AS, okFetch, () => T0);
    expect(decide(r.dir, { ...BUILD, testflight: '18' }, T0).reasons).toEqual(['build_mismatch: this run checked c0ffee000000, TestFlight build 17, not c0ffee000000, TestFlight build 18']);
    expect(decide(r.dir, BUILD, new Date(T0.getTime() + 16 * 60_000)).reasons).toEqual([
      'link_stale: http://127.0.0.1:1/testflight was checked at 2026-11-18T10:00:00.000Z, over 15 minutes ago',
      'link_stale: http://127.0.0.1:1/account was checked at 2026-11-18T10:00:00.000Z, over 15 minutes ago',
    ]);
    fs.writeFileSync(r.planPath, AUTOPLAN.replace('gets a reminder at 8am', 'gets a reminder at 9am'));
    expect(decide(r.dir, BUILD, T0).reasons).toEqual(['source_changed: the day-one rows changed since the check started; start a new run']);
    fs.writeFileSync(r.planPath, AUTOPLAN + '\nAn edit outside the table does not count.\n');
    expect(decide(r.dir, BUILD, T0).ok).toBe(true);
    const ev = fs.readdirSync(path.join(r.dir, 'evidence')).find(f => f.startsWith('2-'))!;
    fs.writeFileSync(path.join(r.dir, 'evidence', ev), 'edited');
    expect(decide(r.dir, BUILD, T0).reasons).toEqual(['action_2_evidence_stale']);
  });

  test('a failed action, a down link and a missing prediction refuse; the newest result for an action counts', async () => {
    const root = fresh('root'), work = fresh('work'), planPath = path.join(work, 'plan.md');
    fs.writeFileSync(planPath, ONE_PAGE);
    const r = startRun({ root, app: 'plantpal', planPath, build: BUILD, play: playWith(1), builder: 'anthropic/claude-opus-5-5', checker: 'gemini-4-carbon', now: T0 });
    if ('error' in r) throw new Error(r.error.detail);
    const rec = (a: number, verdict: string, at: Date, note?: string) => recordResult({ dir: r.dir, action: a, verdict, evidence: shot(work, `a${a}-${verdict}.mp4`, `${a}${verdict}`), device: 'iPhone 17 Pro (cloud)', account: PLAY.account, by: 'google/gemini-4-carbon', note, now: at });
    for (let a = 1; a <= 4; a++) rec(a, 'pass', T0);
    expect(rec(5, 'fail', T0)).toMatchObject({ error: { detail: 'a fail needs --note saying what happened' } });
    rec(5, 'fail', T0, 'the care card is blank');
    await checkLinks(r.dir, AS, async () => ({ status: 401 }), () => T0);
    expect(decide(r.dir, BUILD, T0).reasons).toEqual([
      'action_5_failed: the care card is blank', 'link_down: http://127.0.0.1:1/testflight (status 401)', 'no_predicted_score',
    ]);
    rec(5, 'pass', new Date(T0.getTime() + 60_000));
    await checkLinks(r.dir, AS, okFetch, () => new Date(T0.getTime() + 60_000));
    expect(predict({ dir: r.dir, score: '7', why: 'clean', by: 'gemini-4-carbon' })).toMatchObject({ prediction: { score: 7 } });
    expect(predict({ dir: r.dir, score: '8', why: 'again', by: 'gemini-4-carbon' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(decide(r.dir, BUILD, T0)).toMatchObject({ ok: true, passed: 5 });
  });

  test('link receipts and results bind the owner-equivalent account and device class', async () => {
    const r = passedRun();
    expect(await checkLinks(r.dir, { account: 'any session', device_class: 'ios' }, okFetch, () => T0)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(await checkLinks(r.dir, { account: PLAY.account, device_class: 'web' }, okFetch, () => T0)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(fs.existsSync(path.join(r.dir, 'links'))).toBe(false);
    const other = { schema_version: 1, kind: 'first-use-link', url: 'http://127.0.0.1:1/testflight', build_fingerprint: JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8')).build.fingerprint, audience: { account: 'a developer account', device_class: 'ios' }, checked_at: T0.toISOString(), status: 200, login_gated: false, verdict: 'live' };
    fs.mkdirSync(path.join(r.dir, 'links'));
    fs.writeFileSync(path.join(r.dir, 'links', 'other.json'), JSON.stringify(other));
    expect(decide(r.dir, BUILD, T0).reasons[0]).toBe('link_unchecked: http://127.0.0.1:1/testflight (as a fresh Apple ID with notifications allowed on ios)');
    expect(recordResult({ dir: r.dir, action: 1, verdict: 'pass', evidence: shot(r.work, 'dev.png'), device: 'd', account: 'a developer account', by: 'openai/gpt-6.2-sol' })).toMatchObject({ error: { detail: 'play on the owner-equivalent account and pass it exactly: --account "a fresh Apple ID with notifications allowed"' } });
  });

  test('the builder cannot record a result or a prediction, and evidence must be a screenshot or video', () => {
    const r = passedRun();
    expect(recordResult({ dir: r.dir, action: 1, verdict: 'pass', evidence: shot(r.work, 'self.png'), device: 'd', account: PLAY.account, by: 'anthropic/claude-opus-5-5' })).toMatchObject({ error: { code: 'FIRST_USE_SAME_FAMILY' } });
    expect(recordResult({ dir: r.dir, action: 1, verdict: 'pass', evidence: shot(r.work, 'notes.txt'), device: 'd', account: PLAY.account, by: 'openai/gpt-6.2-sol' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(recordResult({ dir: r.dir, action: 6, verdict: 'pass', evidence: shot(r.work, 'six.png'), device: 'd', account: PLAY.account, by: 'openai/gpt-6.2-sol' })).toMatchObject({ error: { detail: '--action must be 1 to 5' } });
    const link = path.join(r.work, 'link.png');
    fs.symlinkSync(shot(r.work, 'real.png'), link);
    expect(recordResult({ dir: r.dir, action: 1, verdict: 'pass', evidence: link, device: 'd', account: PLAY.account, by: 'openai/gpt-6.2-sol' })).toMatchObject({ error: { detail: 'the evidence must be a regular file, not a link or directory' } });
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
    const again = startRun({ root: r.root, app: 'plantpal', planPath: r.planPath, build: BUILD, play: PLAY, builder: 'anthropic/claude-opus-5-5', checker: 'openai/gpt-6.2-sol', now: T0 });
    expect(again).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
  });

  test('a record write that fails refuses with FIRST_USE_RECORD_INVALID instead of throwing', async () => {
    const r = passedRun();
    for (const d of ['results', 'links', 'owner']) {
      fs.rmSync(path.join(r.dir, d), { recursive: true, force: true });
      fs.writeFileSync(path.join(r.dir, d), 'not a directory');
    }
    expect(recordResult({ dir: r.dir, action: 1, verdict: 'pass', evidence: shot(r.work, 'again.png', 'again'), device: 'd', account: PLAY.account, by: 'openai/gpt-6.2-sol' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(await checkLinks(r.dir, AS, okFetch)).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
    expect(ownerScore({ dir: r.dir, score: '4', words: '4, fine', by: 'GStack Minder' })).toMatchObject({ error: { code: 'FIRST_USE_RECORD_INVALID' } });
  });

  test('the brief shell-quotes every value it puts into the record and predict lines', () => {
    const work = fresh('quote'), planPath = path.join(work, 'plan.md'), marker = path.join(work, 'ran');
    fs.writeFileSync(planPath, AUTOPLAN);
    const account = `Ada's "test" $HOME \`touch ${marker}\` $(touch ${marker}) account`;
    const r = startRun({ root: path.join(fresh('root'), 'it\'s "$x"'), app: 'plantpal', planPath, build: BUILD, play: { ...PLAY, account }, builder: 'anthropic/claude-opus-5-5', checker: 'openai/gpt-6.2-sol', now: T0 });
    if ('error' in r) throw new Error(r.error.detail);
    const lines = renderBrief(r.manifest, r.dir).split('\n').filter(l => l.startsWith('gstack-first-use '));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const argv = spawnSync('bash', ['-c', line.replace(/^gstack-first-use /, "printf '%s\\n' ")], { encoding: 'utf8', timeout: 10_000 }).stdout.split('\n');
      expect(argv[argv.indexOf('--run') + 1]).toBe(r.dir);
      expect(argv[argv.indexOf('--by') + 1]).toBe('openai/gpt-6.2-sol');
      if (line.includes(' record ')) expect(argv[argv.indexOf('--account') + 1]).toBe(account);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('the brief gives the checker only the play text and the frozen actions', () => {
    const r = passedRun();
    const read = readManifest(r.dir);
    if ('error' in read) throw new Error('no manifest');
    const brief = renderBrief(read.manifest, r.dir);
    expect(brief).toContain('You run on openai/gpt-6.2-sol; the team that built it runs on anthropic models');
    expect(brief).toContain('tools.capy.phone');
    expect(brief).toContain('TestFlight build 17');
    for (const a of ACTIONS) expect(brief).toContain(a);
    expect(brief).toContain(`gstack-first-use record --run '${r.dir}' --action N --verdict pass --evidence FILE --device 'DEVICE YOU USED' --account 'a fresh Apple ID with notifications allowed' --by 'openai/gpt-6.2-sol'`);
    expect(brief).not.toContain('Ada Example');
    expect(brief).not.toContain(r.planPath);
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
    const start = await cli('start', '--app', 'plantpal', '--plan', plan, '--play', play, ...build, '--builder', 'anthropic/claude-opus-5-5', '--checker', 'openai/gpt-6.2-sol');
    expect(start.code).toBe(0);
    const dir = /^FIRST_USE_RUN: (.+)$/m.exec(start.stdout)![1]!;
    expect(dir.startsWith(path.join(home, '.capy', 'drive', 'user-ada-example', 'first-use', 'plantpal') + path.sep)).toBe(true);
    expect(start.stdout).toContain('FIRST_USE_FROZEN: 5 actions');

    const early = await cli('message', '--run', dir, ...build);
    expect(early.code).toBe(3);
    expect(early.stdout).toBe('');
    expect(early.stderr).toContain('(FIRST_USE_REFUSED)');
    expect(early.stderr).toContain('action_1_not_played');

    const brief = await cli('brief', '--run', dir);
    expect(brief.stdout).toContain('# Cold first-use check: plantpal');
    expect(brief.stderr).toContain('DISPATCH: give this brief');

    for (let a = 1; a <= 5; a++) {
      const rec = await cli('record', '--run', dir, '--action', String(a), '--verdict', 'pass', '--evidence', shot(work, `a${a}.png`, `s${a}`), '--device', 'iPhone 17 Pro (cloud)', '--account', PLAY.account, '--by', 'openai/gpt-6.2-sol');
      expect(rec.code).toBe(0);
    }
    expect((await cli('predict', '--run', dir, '--score', '6', '--why', 'reminder works, adding is slow', '--by', 'openai/gpt-6.2-sol')).stdout).toContain('FIRST_USE_PREDICTED: 6');
    expect((await cli('links', '--run', dir)).code).toBe(1);
    const links = await cli('links', '--run', dir, '--account', PLAY.account, '--device-class', 'ios');
    expect(links.code).toBe(0);
    expect(links.stdout).toContain('LINK: live status=403 as=ios');

    const check = await cli('check', '--run', dir, ...build);
    expect(check.stdout).toMatch(/^FIRST_USE: pass app=plantpal build=c0ffee000000, TestFlight build 17 actions=5\/5 links=2\/2 checker=openai\/gpt-6.2-sol predicted=6$/m);
    const msg = await cli('message', '--run', dir, ...build);
    expect(msg.code).toBe(0);
    expect(msg.stdout).toContain('10. **Reply word:** played');
    expect((await cli('check', '--run', dir, '--platform', 'ios', '--commit', COMMIT, '--testflight', '18')).code).toBe(3);

    expect((await cli('score', '--run', dir, '--score', '4', '--words', '4, Talk is slow', '--by', 'Example Captain')).code).toBe(0);
    const show = await cli('show', '--run', dir, '--json');
    expect(JSON.parse(show.stdout)).toMatchObject({ passed: 5, predicted: 6, owner: { score: 4, words: '4, Talk is slow' }, gap: -2 });
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
