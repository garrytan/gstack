/**
 * GST-537 PR 3, shadow mode for the CEO-only decider (lib/autoplan-shadow.ts):
 * the frozen decider prompt, the switch, the reply contract, the 10% audit
 * mark, the call (truncation, the OpenAI output bound, the 90 s deadline, the
 * shadow's own egress receipt), and the gate-cost exclusion of shadow spend.
 * Model calls go to test/fixtures/shadow-fake-model.ts through
 * ANTHROPIC_BASE_URL and OPENAI_BASE_URL: never a real network call.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SHADOW_PROMPT_SHA256, SHADOW_PROMPT_VERSION, auditMark, buildPage, claimShadow, parsePage, recordFile, runShadow, shadowPromptFile, shadowSwitch } from '../lib/autoplan-shadow';
import { callModel } from '../lib/outside-voice-api';
import { gateCost, renderGateCost } from '../lib/autoplan-gate-cost';
import { readState } from '../lib/autoplan-state';
import { reserve, settle, readLedger } from '../lib/spend-ledger';
import type { GateList } from '../lib/gate-list';
import { ROOT, readRun, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-shadow-'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'shadow-fake-model.ts');
const servers: Array<{ kill: () => void }> = [];
afterAll(() => { for (const s of servers) s.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });
const rows = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** A fake model server in its own process, answering step n of its script for the n-th request. */
async function fake(name: string, script: Array<Record<string, unknown>>) {
  const dir = path.join(TMP, `fake-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  const proc = Bun.spawn(['bun', FAKE, dir], { stdout: 'ignore', stderr: 'inherit' });
  servers.push(proc);
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'port')); i++) await Bun.sleep(25);
  const port = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const env = { GSTACK_STATE_ROOT: state, ANTHROPIC_API_KEY: 'sk-fake-anthropic', OPENAI_API_KEY: 'sk-fake-openai', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` };
  return { dir, env, requests: () => rows(path.join(dir, 'requests.jsonl')), receipts: () => rows(path.join(state, 'security', 'egress.jsonl')) };
}

// One run at its gate (uc1 from CEO, uc2 from Eng, p1), shadow off; each case copies it and turns shadow on in run.json.
const BASE = startSmallRun(path.join(TMP, 'base'));
runPhase(BASE, 'ceo');
runPhase(BASE, 'eng');
let copies = 0;
function gateRun(model = 'claude-opus-5-5'): string {
  const out = path.join(TMP, `run-${++copies}`);
  fs.cpSync(BASE, out, { recursive: true });
  const run = readRun(out);
  run.shadow = { enabled: true, model, source: 'env' };
  fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  return out;
}
const gateOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
const decider = () => fs.readFileSync(shadowPromptFile(), 'utf8');

describe('the decider prompt is frozen and predicts; it imports no mandate', () => {
  test('its sha256 is pinned beside its version, and every row stores it', () => {
    expect(SHADOW_PROMPT_VERSION).toBe(1);
    expect(crypto.createHash('sha256').update(fs.readFileSync(shadowPromptFile())).digest('hex')).toBe(SHADOW_PROMPT_SHA256);
  });
  test('no take-the-recommendation or keep-the-direction rule; the recommendation is a labeled input', () => {
    const text = decider();
    expect(text).not.toMatch(/\(recommended\)/i);
    expect(text).not.toMatch(/keep (the|your|its) (plan's )?direction/i);
    expect(text).not.toMatch(/sections\/ceo-only\.md/);
    expect(text).toContain("The reviewers' recommendation is one input among several");
    for (const slot of ['{{PLAN}}', '{{QUESTIONS}}', '{{IDS}}']) expect(text.split(slot).length).toBe(2);
    expect(text.trimEnd().endsWith('```')).toBe(true);
  });
  test('the CEO-only driver module does not name the CEO-only skill section', () => {
    expect(fs.readFileSync(path.join(ROOT, 'lib', 'autoplan-ceo-only.ts'), 'utf8')).not.toContain('sections/ceo-only.md');
  });
});

describe('the switch is off by default and fixed at init', () => {
  const state = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const keys = { GSTACK_STATE_ROOT: state, ANTHROPIC_API_KEY: 'sk-fake', OPENAI_API_KEY: '' };
  const on = { outsideEnabled: true, ceoOnly: false };
  test('off by default, with no line', () => {
    expect(shadowSwitch(on, keys)).toEqual({ shadow: { enabled: false, reason: 'off by default', source: 'default' } });
  });
  test('config on turns it on with the default model; the env var wins over config', () => {
    fs.writeFileSync(path.join(state, 'config.yaml'), 'autoplan_shadow: on\n');
    const r = shadowSwitch(on, keys);
    expect(r.shadow).toEqual({ enabled: true, model: 'claude-opus-5-5', source: 'config' });
    expect(r.line).toStartWith('SHADOW: on model=claude-opus-5-5');
    expect(shadowSwitch(on, { ...keys, GSTACK_AUTOPLAN_SHADOW: '0' }).shadow).toMatchObject({ enabled: false, source: 'env' });
    fs.rmSync(path.join(state, 'config.yaml'));
    expect(shadowSwitch(on, { ...keys, GSTACK_AUTOPLAN_SHADOW: '1' }).shadow).toMatchObject({ enabled: true, source: 'env' });
  });
  test('no key, --no-outside, a CEO-only run, an unpriced model or a bad value give off with the reason', () => {
    const env = { ...keys, GSTACK_AUTOPLAN_SHADOW: 'on' };
    expect(shadowSwitch(on, { ...env, ANTHROPIC_API_KEY: '' }).line).toBe('SHADOW: off (no API key for claude-opus-5-5 (ANTHROPIC_API_KEY))');
    expect(shadowSwitch({ ...on, outsideEnabled: false }, env).line).toBe('SHADOW: off (--no-outside)');
    expect(shadowSwitch({ ...on, ceoOnly: true }, env).line).toBe('SHADOW: off (a CEO-only run writes no gate)');
    fs.writeFileSync(path.join(state, 'config.yaml'), 'autoplan_shadow_model: claude-unpriced-9\n');
    expect(shadowSwitch(on, env).line).toBe('SHADOW: off (claude-unpriced-9 has no price in lib/pricing.ts, so --spend-cap cannot bound it)');
    fs.rmSync(path.join(state, 'config.yaml'));
    expect(shadowSwitch(on, { ...keys, GSTACK_AUTOPLAN_SHADOW: 'yes' }).line).toBe('SHADOW: off (GSTACK_AUTOPLAN_SHADOW=yes is not on or off)');
  });
  test('a run.json without the field reads off: nothing is claimed', () => {
    const out = path.join(TMP, 'no-field');
    fs.cpSync(BASE, out, { recursive: true });
    const run = readRun(out);
    expect(run.shadow).toEqual({ enabled: false, reason: 'off by default', source: 'default' });
    delete run.shadow;
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    expect(claimShadow(out)).toEqual({});
    expect(fs.existsSync(path.join(out, 'shadow'))).toBe(false);
  });
});

describe('the reply contract: exactly one valid object per requested id', () => {
  const out = gateRun();
  const page = buildPage(readState(out), gateOf(out), decider());
  const valid = page.items.map(i => ({ id: i.item.id, action: 'decide', pick: 'a', confidence: 0.6, cites: i.findings.slice(0, 1).map(f => f.id), reason: 'r' }));
  const reply = (objs: unknown[]) => '```json\n' + JSON.stringify(objs) + '\n```';
  test('the page carries each item as rendered, with its findings, and p1 lists every finding the others name', () => {
    expect(page.items.map(i => i.item.id)).toEqual(['uc1', 'uc2', 'p1']);
    expect(page.items[0]!.frozen).toMatchObject({ item_class: 'challenge2', kind: 'approval', recommended: 'a' });
    expect(page.items[0]!.findings.map(f => f.severity).every(Boolean)).toBe(true);
    expect(page.items[2]!.findings.map(f => f.id).sort()).toEqual([...page.items[0]!.findings, ...page.items[1]!.findings].map(f => f.id).sort());
    expect(page.prompt).toContain('"id": "uc1"');
    expect(page.prompt).not.toContain('{{');
  });
  test('a good reply is clean', () => {
    expect(parsePage(reply(valid), page.items).clean).toBe(true);
  });
  const cases: Array<[string, unknown[] | string, string]> = [
    ['missing', valid.slice(0, 2), 'missing'],
    ['duplicate', [...valid, valid[2]], 'duplicate'],
    ['unknown option', valid.map((v, i) => (i === 2 ? { ...v, pick: 'z' } : v)), 'pick "z" is not an option of p1'],
    ['foreign cite', valid.map((v, i) => (i === 2 ? { ...v, cites: ['nope'] } : v)), 'cites ["nope"] name a finding outside p1\'s origin'],
    ['confidence above 1', valid.map((v, i) => (i === 2 ? { ...v, confidence: 1.2 } : v)), 'confidence 1.2 is not a number from 0 to 1'],
    ['bad action', valid.map((v, i) => (i === 2 ? { ...v, action: 'approve' } : v)), 'action "approve" is not decide, send_back or hold'],
    ['long reason', valid.map((v, i) => (i === 2 ? { ...v, reason: 'x'.repeat(401) } : v)), 'reason is not a string of at most 400 characters'],
    ['no JSON', 'I would approve.', 'no JSON array in the reply'],
  ];
  for (const [name, objs, why] of cases) test(`${name} marks that item malformed`, () => {
    const p = parsePage(typeof objs === 'string' ? objs : reply(objs), page.items);
    expect(p.clean).toBe(false);
    expect(p.byId.get('p1')).toEqual({ ok: false, why });
  });
  test('a foreign id leaves the items valid but the page unclean, so it is asked again', () => {
    const p = parsePage(reply([...valid, { ...valid[0], id: 'zz9' }]), page.items);
    expect(p.foreign).toEqual(['zz9']);
    expect([...p.byId.values()].every(v => v.ok)).toBe(true);
    expect(p.clean).toBe(false);
  });
});

describe('the 10% audit mark', () => {
  test('on a fixed 2,000-row corpus the marked share is what the hash gives', () => {
    const marked = Array.from({ length: 2000 }, (_, i) => auditMark('fixed-salt-0001', `run-fixture-r${1 + (i % 3)}-d${i}`)).filter(Boolean).length;
    expect(marked).toBe(Array.from({ length: 2000 }, (_, i) => BigInt('0x' + crypto.createHash('sha256').update(`fixed-salt-0001run-fixture-r${1 + (i % 3)}-d${i}`).digest('hex')) % 1000n < 100n).filter(Boolean).length);
    expect(marked / 2000).toBeGreaterThanOrEqual(0.08);
    expect(marked / 2000).toBeLessThanOrEqual(0.12);
  });
});

describe('callModel: the shadow receipt, stop_reason and the OpenAI output bound (existing callers unchanged)', async () => {
  const f = await fake('transport', [{ mode: 'valid' }, { mode: 'truncated' }, { mode: 'valid' }, { mode: 'truncated' }]);
  test('a receipt override writes exactly one receipt with its sink and consent; the default stays the outside-voice receipt', async () => {
    const saved = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = f.env.GSTACK_STATE_ROOT;
    afterAll(() => { if (saved === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = saved; });
    await callModel({ model: 'claude-opus-5-5', prompt: 'p', timeoutMs: 5000, env: f.env, maxTokens: 10, receipt: { sink: 'autoplan-shadow', consent: 'autoplan_shadow on', payloadClass: 'plan-and-gate' } });
    expect(f.receipts().map(r => [r.sink, r.consent, r.payload_class ?? r.payloadClass])).toEqual([['autoplan-shadow', 'autoplan_shadow on', 'plan-and-gate']]);
    const cut = await callModel({ model: 'claude-opus-5-5', prompt: 'p', timeoutMs: 5000, env: f.env });
    expect(cut.stop_reason).toBe('max_tokens');
    expect(f.receipts().at(-1)!.sink).toBe('outside-voice-api');
    expect(f.receipts().length).toBe(2);
  });
  test('OpenAI gets max_completion_tokens only when the caller set an output limit, and its finish_reason comes back', async () => {
    const plain = await callModel({ model: 'gpt-6.1-sol', prompt: 'p', timeoutMs: 5000, env: f.env });
    const bounded = await callModel({ model: 'gpt-6.1-sol', prompt: 'p', timeoutMs: 5000, env: f.env, maxTokens: 4000 });
    const [a, b] = f.requests().slice(2).map(r => r.body);
    expect(Object.keys(a)).toEqual(['model', 'messages']);
    expect(b.max_completion_tokens).toBe(4000);
    expect(plain.stop_reason).toBe('stop');
    expect(bounded.stop_reason).toBe('length');
  });
});

describe('runShadow: retry, truncation, failures and the deadline', async () => {
  const ids = (out: string) => rows(recordFile(out, 1));
  const shadowed = async (name: string, script: Array<Record<string, unknown>>, model?: string, deadlineMs?: number) => {
    const f = await fake(name, script);
    const out = gateRun(model);
    const { claim } = claimShadow(out);
    expect(claim).toEqual({ gate_rev: 1, retrospective: false });
    const started = Date.now();
    const outcome = await runShadow(out, claim!, { env: { ...process.env, ...f.env }, deadlineMs });
    return { f, out, outcome, ms: Date.now() - started };
  };
  test('a good reply records every item, keeps the prompt and the raw reply, and settles one shadow-labeled call', async () => {
    const { f, out, outcome } = await shadowed('good', [{ mode: 'valid' }]);
    expect(outcome.status).toBe('recorded');
    expect(outcome.line).toMatch(/^SHADOW: recorded model=claude-opus-5-5 usd=0\.0140$/);
    expect(ids(out).map(r => [r.item, r.status, r.pick, r.rule_pick, r.prompt_sha256 === SHADOW_PROMPT_SHA256])).toEqual([['uc1', 'recorded', 'a', 'a', true], ['uc2', 'recorded', 'a', 'a', true], ['p1', 'recorded', 'a', 'a', true]]);
    expect(f.requests().map(r => r.body.max_tokens)).toEqual([4000]);
    expect(fs.existsSync(path.join(out, 'shadow', 'r1.prompt.md'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'shadow', 'shadow-r1-1.reply.txt'), 'utf8')).toContain('fake prediction');
    expect(readLedger(path.join(out, 'spend.json')).settled.filter(s => s.label === 'shadow').map(s => [s.attempt, s.usd])).toEqual([['shadow-r1-1', 0.014]]);
    expect(fs.existsSync(path.join(out, 'shadow', 'r1.pending'))).toBe(false);
  });
  test('a malformed page is asked once more; items valid in either reply record, the rest record malformed', async () => {
    const fixed = await shadowed('missing-then-valid', [{ mode: 'missing' }, { mode: 'valid' }]);
    expect(fixed.f.requests().length).toBe(2);
    expect(ids(fixed.out).every(r => r.status === 'recorded')).toBe(true);
    const still = await shadowed('bad-twice', [{ mode: 'bad_option' }, { mode: 'bad_option' }]);
    expect(still.f.requests().length).toBe(2);
    expect(ids(still.out).map(r => r.status)).toEqual(['malformed', 'recorded', 'recorded']);
    expect(ids(still.out)[0]).toMatchObject({ pick: null, audit: false, malformed: 'pick "z" is not an option of uc1' });
    expect(still.outcome.line).toContain('malformed=1/3');
  });
  test('a truncated reply raises max_tokens once to 8,000 (no page retry); truncated twice fails truncated', async () => {
    const raised = await shadowed('truncated-once', [{ mode: 'truncated' }, { mode: 'valid' }]);
    expect(raised.f.requests().map(r => r.body.max_tokens)).toEqual([4000, 8000]);
    expect(raised.outcome.status).toBe('recorded');
    const twice = await shadowed('truncated-twice', [{ mode: 'truncated' }]);
    expect(twice.f.requests().length).toBe(2);
    expect(twice.outcome.line).toBe('SHADOW: failed truncated');
    expect(fs.existsSync(recordFile(twice.out, 1))).toBe(false);
  });
  test('an OpenAI shadow model sends max_completion_tokens and treats finish_reason length as truncated', async () => {
    const r = await shadowed('openai', [{ mode: 'truncated' }, { mode: 'valid' }], 'gpt-6.1-sol');
    expect(r.f.requests().map(x => [x.path, x.body.max_completion_tokens])).toEqual([['/v1/chat/completions', 4000], ['/v1/chat/completions', 8000]]);
    expect(r.outcome.status).toBe('recorded');
  });
  test('a 500 fails http and settles the call at 0; the journal names the code', async () => {
    const r = await shadowed('http500', [{ mode: 'http500' }]);
    expect(r.outcome.line).toBe('SHADOW: failed http');
    expect(readLedger(path.join(r.out, 'spend.json')).settled.filter(s => s.label === 'shadow').map(s => s.usd)).toEqual([0]);
  });
  test('one deadline covers the call and its retry: a slow malformed reply leaves the retry no time', async () => {
    const r = await shadowed('deadline-retry', [{ mode: 'missing', delay_ms: 1200 }, { mode: 'valid', delay_ms: 1200 }], undefined, 1500);
    expect(r.ms).toBeLessThan(2400);
    expect(r.outcome.status).toBe('recorded');
    expect(ids(r.out).map(x => x.status)).toEqual(['recorded', 'recorded', 'malformed']);
    const slow = await shadowed('deadline-call', [{ mode: 'valid', delay_ms: 3000 }], undefined, 800);
    expect(slow.outcome.line).toBe('SHADOW: failed timeout');
    expect(slow.ms).toBeLessThan(2500);
    expect(readLedger(path.join(slow.out, 'spend.json')).settled.filter(s => s.label === 'shadow').map(s => s.usd)).toEqual(['unknown']);
  });
  test('a record already published makes a later claim a no-op: no second call is paid', async () => {
    const { f, out } = await shadowed('noop', [{ mode: 'valid' }]);
    const before = fs.readFileSync(recordFile(out, 1));
    expect(claimShadow(out)).toEqual({});
    expect(f.requests().length).toBe(1);
    expect(fs.readFileSync(recordFile(out, 1)).equals(before)).toBe(true);
  });
});

describe('gate cost: shadow spend counts against the cap and shows in GATE_SPEND, never in the per-voice price', () => {
  test('a $5 voice settle followed by a shadow settle keeps GATE_REC_COST at x 5.00', () => {
    const out = path.join(TMP, 'cost');
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'spend.json');
    reserve(file, 'r-a1', 5, { cap: 5.2, label: 'ceo/native' }); settle(file, 'r-a1', 'unknown');
    reserve(file, 'shadow-r1-1', 0.15, { label: 'shadow' }); settle(file, 'shadow-r1-1', 0.014);
    const list: GateList = { schema_version: 1, run: 'r', gate_rev: 1, items: [
      { id: 'd1', title: 't', kind: 'auto', recommended: 'b', phase: 'ceo', options: [{ key: 'a', text: 'keep', changes_plan: false }, { key: 'b', text: 'change', changes_plan: true }] },
      { id: 'p1', title: 'Plan approval', kind: 'approval', recommended: 'b', options: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }] }] };
    const c = gateCost(out, list, { phase_order: ['ceo', 'eng'], outside_enabled: true, spend_cap_usd: 5.2 });
    expect(c.per_voice_usd).toBe(5);
    expect(c.attempts).toBe(1);
    expect(c.shadow_usd).toBe(0.014);
    expect(c.summary.worst_case_usd).toBe(5.014);
    const [spend, rec] = renderGateCost(c);
    expect(spend).toContain('attempts=1 shadow=0.0140');
    expect(rec).toContain('× 5.00');
    expect(rec).toContain('(over the cap: raise it with gstack-autoplan budget before answering rec)');
  });
});
