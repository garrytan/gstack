/**
 * GST-537 PR 3, shadow mode through the driver (bin/gstack-autoplan,
 * lib/autoplan-shadow.ts): every gate writer records the shadow before it
 * prints GATE, the lock is not held during the call, a live lease makes a
 * second writer pay nothing and answer wait, a crashed call settles unknown
 * (never released) and answer records the revision retrospectively, the
 * checkpoint taken at the gate holds the record, owner provenance comes from
 * the owner's own words, and the reader exports answered revisions only.
 * Model calls go to test/fixtures/shadow-fake-model.ts: never a real network call.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { releaseUndispatched } from '../lib/autoplan-budget';
import { readState } from '../lib/autoplan-state';
import { readLedger } from '../lib/spend-ledger';
import { AUTOPLAN, ROOT, SMALL_PLAN, env as baseEnv, journal, readRun, review } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-shadow-drv-'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'shadow-fake-model.ts');
const servers: Array<{ kill: (sig?: number) => void }> = [];
afterAll(() => { for (const s of servers) s.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });
const rows = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const record = (out: string, rev = 1) => path.join(out, 'shadow', `ceo-only.r${rev}.jsonl`);
const events = (out: string) => journal(out).map(r => r.event);

interface Fake { env: Record<string, string>; requests: () => any[]; receipts: () => any[] }
async function fake(name: string, script: Array<Record<string, unknown>>, extra: Record<string, string> = {}): Promise<Fake> {
  const dir = path.join(TMP, `fake-${name}`);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  servers.push(Bun.spawn(['bun', FAKE, dir], { stdout: 'ignore', stderr: 'inherit' }));
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'port')); i++) await Bun.sleep(25);
  const port = fs.readFileSync(path.join(dir, 'port'), 'utf8');
  const env = baseEnv({ GSTACK_STATE_ROOT: path.join(dir, 'state'), GSTACK_CAPY: '', GSTACK_AUTOPLAN_SHADOW: '1', ANTHROPIC_API_KEY: 'sk-fake-anthropic', OPENAI_API_KEY: 'sk-fake-openai',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ...extra });
  return { env, requests: () => rows(path.join(dir, 'requests.jsonl')), receipts: () => rows(path.join(dir, 'state', 'security', 'egress.jsonl')) };
}
const ap = (args: string[], e: Record<string, string>) => spawnSync('bun', [AUTOPLAN, ...args], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 120_000 });
const apAsync = (args: string[], e: Record<string, string>) => Bun.spawn(['bun', AUTOPLAN, ...args], { cwd: ROOT, env: e, stdout: 'pipe', stderr: 'pipe' });
function ok(r: { status: number | null; stdout: string; stderr: string }, what: string) { if (r.status !== 0) throw new Error(`${what} failed (${r.status}): ${r.stderr}\n${r.stdout}`); return r; }

function start(name: string, e: Record<string, string>, extra: string[] = []) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), SMALL_PLAN);
  const out = path.join(dir, 'run');
  const first = ok(ap(['next', '--out', out, '--plan', path.join(dir, 'plan.md'), '--no-ui', ...extra], e), 'first next');
  return { out, first };
}
const attempt = (out: string, phase: string, voice: string) => readRun(out).phases[phase][voice];
const resultFile = (out: string, phase: string, voice: string) => attempt(out, phase, voice).attempts.at(-1).result;
/** next, both fixture reviews, the native submit; returns the outside submit's argv so a test can run it its own way. */
function toOutsideSubmit(out: string, phase: string, e: Record<string, string>): string[] {
  ok(ap(['next', '--out', out], e), `next ${phase}`);
  for (const voice of ['native', 'outside']) ok(review(path.join(out, `${phase}-${voice}-prompt.md`)), `review ${voice}`);
  ok(ap(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultFile(out, phase, 'native'), '--model', 'anthropic/claude-opus-4-7', '--attempt', attempt(out, phase, 'native').attempt, '--runner', 'host-subagent'], e), 'submit native');
  return ['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultFile(out, phase, 'outside'), '--model', 'openai/gpt-6-astra', '--attempt', attempt(out, phase, 'outside').attempt, '--runner', 'host-subagent'];
}
const phase = (out: string, name: string, e: Record<string, string>) => ok(ap(toOutsideSubmit(out, name, e), e), `submit outside ${name}`);
const lineIndex = (stdout: string, prefix: string) => stdout.split('\n').findIndex(l => l.startsWith(prefix));
const exported = (args: string[], e: Record<string, string>) => ap(['shadow', ...args, '--json'], e);

describe('submit records the shadow before GATE; the record stays private and checkpointed', async () => {
  const f = await fake('main', [{ mode: 'valid' }]);
  const ckpt = path.join(TMP, 'ckpt-main');
  const e = { ...f.env, GSTACK_AUTOPLAN_CHECKPOINT_DIR: ckpt };
  const { out, first } = start('main', e);
  phase(out, 'ceo', e);
  const gate = phase(out, 'eng', e);
  const shadowRows = rows(record(out));

  test('init prints SHADOW: on and stores the switch in run.json and the init row', () => {
    expect(first.stdout).toContain('SHADOW: on model=claude-opus-5-5 (GSTACK_AUTOPLAN_SHADOW=1)');
    expect(readRun(out).shadow).toEqual({ enabled: true, model: 'claude-opus-5-5', source: 'env' });
    expect(journal(out).find(r => r.event === 'init').shadow.enabled).toBe(true);
  });
  test('SHADOW: recorded prints before GATE, and GATE_SPEND shows the shadow spend', () => {
    expect(lineIndex(gate.stdout, 'SHADOW: recorded model=claude-opus-5-5 usd=0.0140')).toBeGreaterThan(-1);
    expect(lineIndex(gate.stdout, 'SHADOW: ')).toBeLessThan(lineIndex(gate.stdout, 'GATE: gate_rev=1'));
    expect(gate.stdout).toMatch(/GATE_SPEND: .* attempts=4 shadow=0\.0140/);
    const ev = events(out);
    expect(ev.indexOf('gate_written')).toBeLessThan(ev.indexOf('shadow_pending'));
    expect(ev.indexOf('shadow_pending')).toBeLessThan(ev.indexOf('shadow_dispatched'));
    expect(ev.indexOf('shadow_dispatched')).toBeLessThan(ev.indexOf('shadow_recorded'));
    expect(f.requests().length).toBe(1);
  });
  test('one row per item with the frozen item, the rule pick, eligibility, class and hashes', () => {
    expect(shadowRows.map(r => [r.item, r.item_class, r.ceo_eligible, r.rule_pick, r.status, r.retrospective])).toEqual([
      ['uc1', 'challenge2', true, 'a', 'recorded', false], ['uc2', 'challenge2', false, 'a', 'recorded', false], ['p1', 'p1', true, 'a', 'recorded', false]]);
    expect(shadowRows[0].decision).toBe(`${readRun(out).run}-uc1`);
    expect(shadowRows[0].item_frozen.options.map((o: { key: string }) => o.key)).toEqual(['a', 'b']);
    expect(typeof shadowRows[0].audit).toBe('boolean');
  });
  test('exactly one egress receipt per send, with the shadow sink and consent', () => {
    expect(f.receipts().map(r => [r.sink, r.consent])).toEqual([['autoplan-shadow', 'autoplan_shadow on']]);
  });
  test('the checkpoint taken at the gate holds the shadow record; a restore keeps it byte for byte', () => {
    const collection = path.join(ckpt, readRun(out).run);
    const current = JSON.parse(fs.readFileSync(path.join(collection, 'current.json'), 'utf8'));
    const gen = path.join(collection, 'generations', current.generation, 'run', 'shadow', 'ceo-only.r1.jsonl');
    expect(fs.readFileSync(gen).equals(fs.readFileSync(record(out)))).toBe(true);
    const restored = path.join(TMP, 'main-restored');
    ok(ap(['resume', '--out', restored, '--from', collection], e), 'resume --from');
    expect(fs.readFileSync(record(restored)).equals(fs.readFileSync(record(out)))).toBe(true);
    expect(f.requests().length).toBe(1);
  });
  test('the gate render, owner brief, decisions and public export carry no pick, reason or salt', () => {
    const salt = fs.readFileSync(path.join(out, 'shadow', 'salt'), 'utf8').trim();
    const render = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-gate'), 'render', path.join(out, 'gate.json'), '--all'], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 60_000 });
    const brief = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--out', out], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 60_000 });
    expect(render.status).toBe(0);
    for (const text of [render.stdout, brief.stdout, fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8'), fs.readFileSync(path.join(out, 'gate.json'), 'utf8')]) {
      expect(text).not.toContain('fake prediction');
      expect(text).not.toContain('confidence');
      expect(text).not.toContain(salt);
    }
    const pub = path.join(TMP, 'main-public');
    ok(ap(['export', '--out', out, '--public', pub], e), 'export --public');
    const all = fs.readdirSync(pub, { recursive: true }).map(String);
    expect(all.some(p => p.includes('shadow'))).toBe(false);
    for (const p of all) if (fs.statSync(path.join(pub, p)).isFile()) expect(fs.readFileSync(path.join(pub, p), 'utf8')).not.toContain(salt);
    expect(readRun(out).salt).toBeUndefined();
  });
  test('gstack-artifact validate checks the record against its journaled sha256', () => {
    const validate = () => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 60_000 });
    expect(validate().status).toBe(0);
    const good = fs.readFileSync(record(out), 'utf8');
    fs.writeFileSync(record(out), good.replace('"pick":"a"', '"pick":"b"'));
    const bad = validate();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('(ARTIFACT_STALE)');
    expect(bad.stderr).toContain('shadow/ceo-only.r1.jsonl');
    fs.writeFileSync(record(out), good);
  });
  test('printing the gate again pays nothing', () => {
    const again = ok(ap(['next', '--out', out], e), 'next again');
    expect(again.stdout).toContain('GATE: gate_rev=1');
    expect(again.stdout).not.toContain('SHADOW:');
    expect(f.requests().length).toBe(1);
  });
  test('the reader refuses an unanswered revision', () => {
    const r = exported(['--out', out], e);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(SHADOW_BEFORE_ANSWER)');
  });
  test('"Do it" relayed as tokens records owner_mode rec, owner_named false, the rec_hash and the agent role', () => {
    ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a uc2a p1a', '--by', 'agent:capy', '--owner-reply', 'Do it'], e), 'answer');
    const d = rows(path.join(out, 'decisions.jsonl'));
    const gateRec = shadowRows[0].rec_hash;
    expect(d.map(r => [r.label, r.owner_mode, r.owner_named, r.answered_role, r.rec_hash === gateRec, r.answered_by])).toEqual([
      ['UC1', 'rec', false, 'agent', true, 'agent:capy'], ['UC2', 'rec', false, 'agent', true, 'agent:capy'], ['P1', 'rec', false, 'agent', true, 'agent:capy']]);
  });
  test('the reader exports the answered revision with the owner provenance', () => {
    const r = exported(['--out', out], e);
    expect(r.status).toBe(0);
    const x = JSON.parse(r.stdout);
    expect(x.rows.map((row: any) => [row.item, row.status, row.shadow.pick, row.owner.chosen, row.owner.owner_mode, row.owner.rec_hash_at_answer === row.owner.rec_hash_at_record])).toEqual([
      ['uc1', 'recorded', 'a', 'a', 'rec', true], ['uc2', 'recorded', 'a', 'a', 'rec', true], ['p1', 'recorded', 'a', 'a', 'rec', true]]);
    expect(x.counts.status).toEqual({ recorded: 3 });
    expect(x.counts.ceo_eligible).toEqual({ true: 2, false: 1 });
  });
});

describe('a failed shadow never blocks: the gate prints and answers; owner words name items', async () => {
  const f = await fake('fail', [{ mode: 'http500' }]);
  const e = f.env;
  const { out } = start('fail', e);
  phase(out, 'ceo', e);
  const gate = phase(out, 'eng', e);
  test('a 500 journals shadow_failed http, prints SHADOW: failed http, and still prints the gate', () => {
    expect(gate.stdout).toContain('SHADOW: failed http');
    expect(gate.stdout).toContain('GATE: gate_rev=1');
    expect(journal(out).find(r => r.event === 'shadow_failed')).toMatchObject({ gate_rev: 1, code: 'http' });
    expect(fs.existsSync(record(out))).toBe(false);
  });
  test('owner words "uc1a" record tokens and owner_named true for uc1 only', () => {
    const r = ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a', '--by', 'agent:capy', '--owner-reply', 'uc1a'], e), 'answer uc1a');
    expect(r.stdout).toContain('GATE_PENDING:');
    const uc1 = rows(path.join(out, 'decisions.jsonl')).find(r => r.label === 'UC1');
    expect(uc1).toMatchObject({ owner_mode: 'tokens', owner_named: true, answered_role: 'agent' });
    expect(rows(path.join(out, 'decisions.jsonl')).find(r => r.label === 'UC2').owner_mode).toBeUndefined();
  });
  test('an interrogated plan approval is refused by the reader', () => {
    ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'p1c', '--by', 'human'], e), 'answer p1c');
    const r = exported(['--out', out], e);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('answered c (interrogate)');
  });
  test('an unparsed owner reply records owner_mode unparsed; the reader shows failed with its code', () => {
    ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc2a p1a', '--by', 'agent:capy', '--owner-reply', 'sounds good to me'], e), 'answer');
    const d = rows(path.join(out, 'decisions.jsonl'));
    expect(d.find(r => r.label === 'UC2')).toMatchObject({ owner_mode: 'unparsed', owner_named: false, owner_reply_parsed: false });
    const x = JSON.parse(exported(['--out', out], e).stdout);
    expect(x.rows.map((row: any) => [row.item, row.status, row.code])).toEqual([['uc1', 'failed', 'http'], ['uc2', 'failed', 'http'], ['p1', 'failed', 'http']]);
  });
});

describe('the lease: the lock is free during the call, a second writer pays nothing, answer waits', async () => {
  const f = await fake('lease', [{ mode: 'valid', delay_ms: 2500 }]);
  const e = f.env;
  const { out } = start('lease', e);
  phase(out, 'ceo', e);
  const writer = apAsync(toOutsideSubmit(out, 'eng', e), e);
  for (let i = 0; i < 400 && !fs.existsSync(path.join(out, 'shadow', 'r1.pending')); i++) await Bun.sleep(25);
  const lease = JSON.parse(fs.readFileSync(path.join(out, 'shadow', 'r1.pending'), 'utf8'));
  const second = ap(['next', '--out', out], e);
  const answer = apAsync(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a uc2a p1a', '--by', 'human'], e);
  const [writerCode, answerCode] = await Promise.all([writer.exited, answer.exited]);
  const writerOut = await new Response(writer.stdout).text();
  test('the lease names the writer, and the run lock is free while it calls', () => {
    expect(lease).toMatchObject({ gate_rev: 1, pid: writer.pid, host: os.hostname(), retrospective: false });
    expect(second.status).toBe(0);
  });
  test('a second writer during the call prints SHADOW: pending and pays nothing; two writers pay once', () => {
    expect(second.stdout).toContain('SHADOW: pending (gate_rev 1 is being recorded by pid');
    expect(f.requests().length).toBe(1);
    expect(writerCode).toBe(0);
    expect(writerOut).toContain('SHADOW: recorded');
  });
  test('answer waits for the record, then answers; the record is prospective', () => {
    expect(answerCode).toBe(0);
    const ev = events(out);
    expect(ev.indexOf('shadow_recorded')).toBeLessThan(ev.indexOf('answered'));
    expect(rows(record(out)).every(r => r.retrospective === false)).toBe(true);
    expect(readRun(out).status).toBe('complete');
  });
});

describe('a crash mid-call: the dispatched call settles unknown and answer records the gate retrospectively', async () => {
  const f = await fake('crash', [{ mode: 'valid', delay_ms: 30000 }, { mode: 'valid' }]);
  const e = f.env;
  const { out } = start('crash', e);
  phase(out, 'ceo', e);
  const writer = apAsync(toOutsideSubmit(out, 'eng', e), e);
  for (let i = 0; i < 400 && !(events(out).includes('shadow_dispatched') && f.requests().length > 0); i++) await Bun.sleep(25);
  writer.kill(9);
  await writer.exited;
  const ledgerBefore = readLedger(path.join(out, 'spend.json'));
  const released = releaseUndispatched(readState(out));
  const answer = ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a uc2a p1a', '--by', 'human'], e);
  const ledger = readLedger(path.join(out, 'spend.json'));
  test('a dispatched shadow call is never released as undispatched', () => {
    expect(ledgerBefore.reserved.map(r => [r.attempt, r.label])).toEqual([['shadow-r1-1', 'shadow']]);
    expect(released).toEqual([]);
  });
  test('answer settles the dead call unknown, records every row retrospective, then answers', () => {
    expect(answer.status).toBe(0);
    expect(answer.stdout).toMatch(/SHADOW: recorded model=claude-opus-5-5 usd=0\.0140 retrospective/);
    expect(ledger.settled.find(s => s.attempt === 'shadow-r1-1')).toMatchObject({ usd: 'unknown', label: 'shadow' });
    expect(ledger.released.some(r => r.attempt === 'shadow-r1-1')).toBe(false);
    expect(journal(out).find(r => r.event === 'shadow_expired').settled_unknown).toEqual(['shadow-r1-1']);
    expect(rows(record(out)).every(r => r.retrospective === true)).toBe(true);
    expect(f.requests().length).toBe(2);
  });
  test('the reader labels those rows retrospective', () => {
    const x = JSON.parse(exported(['--out', out], e).stdout);
    expect(x.counts.status).toEqual({ retrospective: 3 });
  });
});

describe('every gate writer records the shadow before it prints GATE', async () => {
  const f = await fake('writers', [{ mode: 'valid' }]);
  const off = baseEnv({ GSTACK_CAPY: '' });
  /** A gate written with shadow off, then switched on: the next command that prints it records the shadow first. */
  const unshadowed = (name: string) => {
    const { out } = start(name, off);
    phase(out, 'ceo', off); phase(out, 'eng', off);
    const run = readRun(out);
    run.shadow = { enabled: true, model: 'claude-opus-5-5', source: 'env' };
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    return out;
  };
  for (const verb of ['next', 'resume'] as const) test(`${verb}`, () => {
    const out = unshadowed(`writer-${verb}`);
    const r = ok(ap([verb, '--out', out], f.env), verb);
    expect(lineIndex(r.stdout, 'SHADOW: recorded')).toBeGreaterThan(-1);
    expect(lineIndex(r.stdout, 'SHADOW: recorded')).toBeLessThan(lineIndex(r.stdout, 'GATE: gate_rev=1'));
    expect(fs.existsSync(record(out))).toBe(true);
  });
  test('close --deferred (and a malformed item records malformed)', async () => {
    const g = await fake('close', [{ mode: 'bad_option' }, { mode: 'bad_option' }]);
    const { out } = start('writer-close', g.env);
    phase(out, 'ceo', g.env);
    ok(ap(['next', '--out', out], g.env), 'next eng');
    const r = ok(ap(['close', '--out', out, '--phase', 'eng', '--deferred', 'out of time', '--by', 'human'], g.env), 'close');
    expect(lineIndex(r.stdout, 'SHADOW: recorded')).toBeLessThan(lineIndex(r.stdout, 'GATE: gate_rev=1'));
    expect(rows(record(out)).map(x => [x.item, x.item_class, x.status])).toEqual([['uc1', 'challenge2', 'malformed'], ['d1', 'cap_deferred', 'recorded'], ['p1', 'p1', 'recorded']]);
    ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--by', 'human', '--rec-hash', rows(record(out))[0].rec_hash], g.env), 'answer');
    closeOut = out;
  });
  test('submit, revise, check and run share the same publish step (source ratchet; submit runs above)', () => {
    const bin = fs.readFileSync(AUTOPLAN, 'utf8');
    for (const verb of ['next', 'submit', 'revise', 'close', 'check']) expect(bin).toMatch(new RegExp(`if \\(cmd === '${verb}'\\) return await publish\\(out, json, mutating\\(`));
    expect(bin).toContain('return await publish(out, json, withRunLock(out, () => {\n        const r = resumeRun(out);');
    const gateLineCalls = bin.split('\n').filter(l => /gateLines\((state|at), out\)/.test(l) && !l.includes('function gateLines'));
    expect(gateLineCalls.length).toBe(2);
    expect(gateLineCalls.every(l => l.includes('line ? [line] : []'))).toBe(true);
    expect(bin).toContain("const step = withRunLock(out, () => { const r = doNext(out, rest); return r.gate ? claimed(out, r) : r; });");
  });
});
let closeOut = '';

describe('the record: once per revision, a reopen writes r2, temp files and symlinks', async () => {
  const f = await fake('reopen', [{ mode: 'valid' }]);
  const e = f.env;
  const { out } = start('reopen', e);
  phase(out, 'ceo', e); phase(out, 'eng', e);
  const r1 = fs.readFileSync(record(out));
  ok(ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a uc2a p1d', '--by', 'human'], e), 'answer p1d');
  const orphan = path.join(out, 'shadow', 'ceo-only.r2.jsonl.99999.dead.tmp');
  fs.writeFileSync(orphan, 'partial');
  phase(out, 'ceo', e);
  const gate2 = phase(out, 'eng', e);
  test('a reopen writes r2 and leaves r1 byte-identical; the orphan temp file is removed', () => {
    expect(gate2.stdout).toContain('GATE: gate_rev=2');
    expect(fs.readFileSync(record(out)).equals(r1)).toBe(true);
    expect(rows(record(out, 2)).map(r => r.decision)).toEqual(rows(record(out, 2)).map(r => `${readRun(out).run}-r2-${r.item}`));
    expect(fs.existsSync(orphan)).toBe(false);
    expect(f.requests().length).toBe(2);
  });
  test('re-recording keeps the audit marks: the same salt and decision ids mark the same rows', () => {
    const salt = fs.readFileSync(path.join(out, 'shadow', 'salt'), 'utf8').trim();
    for (const r of [...rows(record(out)), ...rows(record(out, 2))]) {
      const mark = BigInt('0x' + new Bun.CryptoHasher('sha256').update(salt + r.decision).digest('hex')) % 1000n < 100n;
      expect(r.audit).toBe(r.action === 'decide' && mark);
    }
  });
  test('a symlinked shadow folder is refused, nothing is written through it, and the gate still prints', async () => {
    const g = await fake('symlink', [{ mode: 'valid' }]);
    const { out: o2 } = start('symlink', g.env);
    const target = path.join(TMP, 'symlink-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(o2, 'shadow'));
    phase(o2, 'ceo', g.env);
    const r = phase(o2, 'eng', g.env);
    expect(r.stdout).toContain('SHADOW: failed unsafe_dir');
    expect(r.stdout).toContain('GATE: gate_rev=1');
    expect(fs.readdirSync(target)).toEqual([]);
    expect(g.requests().length).toBe(0);
  });
});

describe('the switch through the driver, and the spend cap', async () => {
  const f = await fake('switch', [{ mode: 'valid' }]);
  test('off by default: no SHADOW line, run.json says off, and no shadow folder at the gate', () => {
    const e = { ...f.env, GSTACK_AUTOPLAN_SHADOW: '' };
    const { out, first } = start('switch-default', e);
    expect(first.stdout).not.toContain('SHADOW:');
    expect(readRun(out).shadow).toEqual({ enabled: false, reason: 'off by default', source: 'default' });
    phase(out, 'ceo', e);
    expect(phase(out, 'eng', e).stdout).not.toContain('SHADOW:');
    expect(fs.existsSync(path.join(out, 'shadow'))).toBe(false);
  });
  test('the env var wins over config; --no-outside gives off with its reason; resume cannot flip it', () => {
    fs.writeFileSync(path.join(f.env.GSTACK_STATE_ROOT!, 'config.yaml'), 'autoplan_shadow: on\n');
    const { out: offRun } = start('switch-env', { ...f.env, GSTACK_AUTOPLAN_SHADOW: '0' });
    expect(readRun(offRun).shadow).toMatchObject({ enabled: false, source: 'env' });
    const { out: cfgRun, first } = start('switch-config', { ...f.env, GSTACK_AUTOPLAN_SHADOW: '' });
    expect(first.stdout).toContain('SHADOW: on model=claude-opus-5-5 (autoplan_shadow on)');
    ok(ap(['resume', '--out', cfgRun], { ...f.env, GSTACK_AUTOPLAN_SHADOW: '0' }), 'resume');
    expect(readRun(cfgRun).shadow).toMatchObject({ enabled: true, source: 'config' });
    fs.rmSync(path.join(f.env.GSTACK_STATE_ROOT!, 'config.yaml'));
    const { first: noOutside } = start('switch-no-outside', f.env, ['--no-outside']);
    expect(noOutside.stdout).toContain('SHADOW: off (--no-outside)');
  });
  test('a cap that cannot cover the call journals shadow_failed budget and the gate prints', () => {
    const { out } = start('switch-cap', f.env, ['--spend-cap', '0.05']);
    phase(out, 'ceo', f.env);
    const r = phase(out, 'eng', f.env);
    expect(r.stdout).toContain('SHADOW: failed budget');
    expect(r.stdout).toContain('GATE: gate_rev=1');
    expect(journal(out).find(x => x.event === 'shadow_failed').code).toBe('budget');
    expect(f.requests().length).toBe(0);
  });
});

describe('the reader over many runs', () => {
  test('missing, failed, malformed, retrospective and recorded rows; dedupe across a repeated entry; CEO_ONLY_NO_GATE', () => {
    const e = baseEnv({ GSTACK_CAPY: '' });
    const { out: missing } = start('reader-missing', e);
    phase(missing, 'ceo', e); phase(missing, 'eng', e);
    const run = readRun(missing);
    run.shadow = { enabled: true, model: 'claude-opus-5-5', source: 'env' };
    fs.writeFileSync(path.join(missing, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    ok(ap(['answer', '--out', missing, '--gate-rev', '1', '--reply', 'uc1a uc2a p1a', '--by', 'human'], e), 'answer missing');
    const { out: ceoOnly } = start('reader-ceo-only', e, ['--ceo-only']);
    const list = path.join(TMP, 'runs.txt');
    fs.writeFileSync(list, [missing, path.join(TMP, 'fail', 'run'), path.join(TMP, 'crash', 'run'), closeOut, path.join(TMP, 'main', 'run'), path.join(TMP, 'main', 'run'), ceoOnly].join('\n') + '\n');
    const r = exported(['--runs', list], e);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('(CEO_ONLY_NO_GATE)');
    const x = JSON.parse(r.stdout);
    expect(x.counts.status).toEqual({ missing: 3, failed: 3, retrospective: 3, malformed: 1, recorded: 5 });
    expect(x.rows.length).toBe(15);
    expect(x.counts.item_class.cap_deferred).toBe(1);
    const text = ap(['shadow', '--runs', list], e);
    expect(text.stdout).toContain('SHADOW_EXPORT: rows=15 refused=1');
  });
});
