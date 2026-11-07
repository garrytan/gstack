/**
 * The plan-record check (lib/plan-record.ts, GST-1751): the PR body's Plan line, resolved against every branch's
 * approval rows, the exemptions docs/captain.md lists, the warn and require modes, and land's READY-note check.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRow, locate, type ApprovalRow } from '../lib/approval-record';
import { exemptReason, finishPlan, landPlan, parsePlanLine, planMode, planRecordId, publicPlanLine, readyPlan, resolvePlan } from '../lib/plan-record';
import { planBinding } from '../lib/ship-audit';
import { loadReady, persist, repoIdentity } from '../lib/ship-queue-train-record';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture(files: Record<string, Array<Partial<ApprovalRow> & { ask: string; source?: string; outcome?: string; at?: string }>> = {}) {
  const cwd = tmp('plan-repo-');
  spawnSync('git', ['init', '-q', '-b', 'capy/feature'], { cwd, timeout: 30_000 });
  const state = tmp('plan-state-');
  const env = { GSTACK_STATE_ROOT: state, GSTACK_CAPY: '', GSTACK_APPROVALS_DIR: '', GSTACK_PLAN_RECORD: '' } as NodeJS.ProcessEnv;
  const loc = locate({ cwd, env, branch: 'probe' });
  if ('code' in loc) throw new Error(loc.message);
  const dir = path.dirname(loc.file);
  if (Object.keys(files).length) fs.mkdirSync(dir, { recursive: true });
  const ids: Record<string, string> = {};
  for (const [file, rows] of Object.entries(files)) {
    const lines = rows.map(r => {
      const built = buildRow({ ask: r.ask, words: r.words ?? 'do it', by: r.by ?? 'Garry (via GStack Minder)', scope: r.scope ?? 'the reviewed plan', outcome: r.outcome, source: r.source, pending: r.pending, date: '2026-11-07' }, file, new Date(r.at ?? '2026-11-07T00:00:00Z'));
      if ('code' in built) throw new Error(built.message);
      const row = r.words_by ? { ...built, words_by: r.words_by } : built;
      ids[r.ask] = row.id;
      return JSON.stringify(row);
    });
    fs.writeFileSync(path.join(dir, `${file}.jsonl`), lines.join('\n') + '\n');
  }
  return { cwd, env, ids };
}

describe('parsePlanLine', () => {
  test('reads approved, exempt and required, tolerating spacing and bold, and ignores fenced text', () => {
    expect(parsePlanLine('x\nPlan: approved: ap-20261107055041\n')).toEqual({ kind: 'approved', line: 'Plan: approved: ap-20261107055041', token: 'ap-20261107055041' });
    expect(parsePlanLine('**Plan:** approved ~/.capy/work/run/ap')).toMatchObject({ kind: 'approved', token: '~/.capy/work/run/ap' });
    expect(parsePlanLine('Plan: exempt: bug fix (R65)')).toMatchObject({ kind: 'exempt', reason: 'bug fix (R65)' });
    expect(parsePlanLine('Plan: required')).toMatchObject({ kind: 'required' });
    expect(parsePlanLine('```\nPlan: exempt: flaky\n```\nno line here')).toBeNull();
    expect(parsePlanLine('| Plan: approved: x |')).toBeNull();
    expect(parsePlanLine('Plan: /home/u/plan.md\nPlan: approved: ap-1')).toMatchObject({ kind: 'approved', token: 'ap-1' });
  });

  test('exemptions are the docs/captain.md list or crew:<rule>, with a trailing parenthetical ignored', () => {
    expect(exemptReason('bug fix (R65)')).toBe('bug fix');
    expect(exemptReason('Flaky')).toBe('flaky');
    expect(exemptReason('crew: rule 31')).toBe('crew:rule 31');
    expect(exemptReason('light plan')).toBeNull();
    expect(exemptReason('feature')).toBeNull();
  });
});

describe('planMode', () => {
  test('base policy first, then the crew opt-in, then warn in a Capy session, else off', () => {
    expect(planMode('require', { GSTACK_CAPY: '1' }).mode).toBe('require');
    expect(planMode('off', { GSTACK_PLAN_RECORD: 'require' })).toEqual({ mode: 'require', source: 'GSTACK_PLAN_RECORD' });
    expect(planMode('off', { GSTACK_CAPY: '1' })).toEqual({ mode: 'warn', source: 'Capy crew default' });
    expect(planMode(undefined, {}).mode).toBe('off');
  });
});

describe('resolvePlan', () => {
  test('a run id resolves from another branch file, and the newest gate revision decides', () => {
    const f = fixture({
      main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }],
      'other-lane': [{ ask: 'Approve the plan B rev1', source: 'autoplan:ap-2@gate_rev=1' }, { ask: 'Approve the plan B rev2', source: 'autoplan:ap-2@gate_rev=2', outcome: 'pending' }],
    });
    const a = resolvePlan(parsePlanLine('Plan: approved: ap-1'), f);
    expect(a.ok && a.record).toMatchObject({ state: 'approved', ref: 'ap-1', row_id: f.ids['Approve the plan A'], resolver: 1 });
    const b = resolvePlan(parsePlanLine('Plan: approved: ap-2'), f);
    expect(!b.ok && b.failure.code).toBe('PLAN_NOT_APPROVED');
  });

  test("a gate answered in an agent's own words never counts, structured or legacy", () => {
    const f = fixture({ x: [
      { ask: 'own words', source: 'autoplan:ap-3@gate_rev=1', words_by: 'agent:GSTA-1' },
      { ask: 'legacy', source: 'autoplan:ap-4@gate_rev=1', by: "agent:jam_x, its own decision (not the owner's words)" },
    ] });
    for (const run of ['ap-3', 'ap-4']) {
      const r = resolvePlan(parsePlanLine(`Plan: approved: ${run}`), f);
      expect(!r.ok && r.failure.code).toBe('PLAN_NOT_APPROVED');
      expect(!r.ok && r.failure.message).toContain("agent's own words");
    }
  });

  test('a row id resolves an approved plan row, never a ruling or grant row', () => {
    const f = fixture({ y: [{ ask: 'R41 A1: cut a skill' }, { ask: 'review_loop_grant abc for #1', scope: 'one fix-check' }, { ask: 'Grant for #2', scope: 'one review_loop_exception at abc' }] });
    const ok = resolvePlan(parsePlanLine(`Plan: approved: ${f.ids['R41 A1: cut a skill']}`), f);
    expect(ok.ok).toBe(true);
    const grant = resolvePlan(parsePlanLine(`Plan: approved: ${f.ids['review_loop_grant abc for #1']}`), f);
    expect(!grant.ok && grant.failure.code).toBe('PLAN_UNRESOLVED');
    const exception = resolvePlan(parsePlanLine(`Plan: approved: ${f.ids['Grant for #2']}`), f);
    expect(!exception.ok && exception.failure.code).toBe('PLAN_UNRESOLVED');
    expect(resolvePlan(parsePlanLine('Plan: approved: a-000000000000'), f)).toMatchObject({ ok: false, failure: { code: 'PLAN_UNRESOLVED' } });
  });

  test('a run directory path resolves through its run.json', () => {
    const f = fixture({ z: [{ ask: 'Approve the plan C', source: 'autoplan:ap-5@gate_rev=1' }] });
    const run = tmp('plan-run-');
    fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ run: 'ap-5' }));
    const r = resolvePlan(parsePlanLine(`Plan: approved: ${run}`), f);
    expect(r.ok && r.record.ref).toBe('ap-5');
  });

  test('missing, required, unknown exemption, no store, and the changelog-only diff', () => {
    const f = fixture({ z: [{ ask: 'something' }] });
    expect(resolvePlan(null, f)).toMatchObject({ ok: false, failure: { code: 'PLAN_RECORD_MISSING' } });
    expect(resolvePlan(parsePlanLine('Plan: required'), f)).toMatchObject({ ok: false, failure: { code: 'PLAN_NOT_APPROVED' } });
    expect(resolvePlan(parsePlanLine('Plan: exempt: light plan'), f)).toMatchObject({ ok: false, failure: { code: 'PLAN_EXEMPT_UNKNOWN' } });
    expect(resolvePlan(parsePlanLine('Plan: exempt: bug fix (R65)'), f)).toMatchObject({ ok: true, record: { state: 'exempt', reason: 'bug fix' } });
    expect(resolvePlan(parsePlanLine('Plan: approved: ap-1'), fixture())).toMatchObject({ ok: false, failure: { code: 'PLAN_STORE_UNAVAILABLE' } });
    expect(resolvePlan(null, { ...f, changed: ['changelog.d/a.md', 'changelog.d/b.md'] })).toMatchObject({ ok: true, record: { reason: 'changelog-only' } });
    expect(resolvePlan(null, { ...f, changed: ['changelog.d/a.md', 'lib/x.ts'] })).toMatchObject({ ok: false, failure: { code: 'PLAN_RECORD_MISSING' } });
    expect(resolvePlan(parsePlanLine('Plan: exempt: changelog-only'), { ...f, changed: ['lib/x.ts'] })).toMatchObject({ ok: false, failure: { code: 'PLAN_EXEMPT_UNKNOWN' } });
  });
});

describe('ready and land', () => {
  test('ready warns in warn mode, refuses in require mode, and records a resolved line', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    const base = { cwd: f.cwd, changed: ['lib/x.ts'] };
    expect(readyPlan({ ...base, env: f.env, body: '', policyValue: 'off' })).toEqual({});
    expect(readyPlan({ ...base, env: f.env, body: 'Plan: approved: ap-1', policyValue: 'off' })).toMatchObject({ record: { ref: 'ap-1' } });
    expect(readyPlan({ ...base, env: f.env, body: 'Plan: approved: ap-1', policyValue: 'off' }).line).toBeUndefined();
    const warn = readyPlan({ ...base, env: { ...f.env, GSTACK_CAPY: '1' }, body: '', policyValue: 'off' });
    expect(warn.failure).toBeUndefined();
    expect(warn.line).toContain('PLAN: warn');
    expect(warn.line).toContain('PLAN_RECORD_MISSING');
    const refused = readyPlan({ ...base, env: f.env, body: '', policyValue: 'require' });
    expect(refused.failure?.code).toBe('PLAN_RECORD_MISSING');
    const ok = readyPlan({ ...base, env: f.env, body: 'Plan: approved: ap-1', policyValue: 'require' });
    expect(ok.record).toMatchObject({ line: 'Plan: approved: ap-1', state: 'approved', ref: 'ap-1' });
  });

  test('land needs the READY note to carry the PR body\'s current Plan line under require, and never reads the store', () => {
    const record = { line: 'Plan: exempt: bug fix (R65)', state: 'exempt' as const, reason: 'bug fix', resolver: 1 };
    expect(landPlan({ env: {}, policyValue: 'off', body: '' })).toEqual({});
    expect(landPlan({ env: {}, policyValue: 'require', body: '' }).failure?.code).toBe('QUEUE_PLAN_MISMATCH');
    expect(landPlan({ env: {}, policyValue: 'require', record, body: 'Plan: exempt: bug fix (R65)' })).toEqual({ line: 'PLAN: exempt bug fix (from the READY note)' });
    expect(landPlan({ env: {}, policyValue: 'require', record, body: 'Plan: exempt: flaky' }).failure?.code).toBe('QUEUE_PLAN_MISMATCH');
    const warn = landPlan({ env: { GSTACK_CAPY: '1' }, policyValue: 'off', body: '' });
    expect(warn.failure).toBeUndefined();
    expect(warn.line).toContain('PLAN: warn');
    const frag = { line: 'Plan: exempt: changelog-only', state: 'exempt' as const, reason: 'changelog-only', resolver: 1 };
    expect(landPlan({ env: {}, policyValue: 'require', record: frag, body: 'no line' }).failure).toBeUndefined();
  });
});

describe('gstack-approvals plan-check and render --plan', () => {
  test('plan-check prints PLAN: and exits 0, or names the refusal; render --plan prints the line ready reads', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    const run = (args: string[]) => {
      const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-approvals'), ...args], { cwd: f.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...f.env } });
      return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    };
    const ok = run(['plan-check', '--plan', 'approved: ap-1']);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('PLAN: approved ap-1');
    const bad = run(['plan-check', '--plan', 'Plan: exempt: light plan']);
    expect(bad.status).not.toBe(0);
    expect(bad.err).toContain('PLAN_EXEMPT_UNKNOWN');
    const body = run(['render', '--full', '--plan', 'Plan: approved: ap-1']).out;
    expect(parsePlanLine(body)).toMatchObject({ kind: 'approved', token: 'ap-1' });
    expect(body).toContain('Plan check: approved ap-1 row=');
    expect(body).not.toContain('Approve the plan A');
  });

  test('the Plan record line is never Step 8\'s plan-file binding, and render --plan refuses a line it cannot parse', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    const run = (args: string[]) => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-approvals'), ...args], { cwd: f.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...f.env } });
    const body = `${run(['render', '--plan', 'Plan: approved: ap-1']).stdout}\nPlan: docs/designs/X.md\n`;
    expect(planBinding(body)).toBe('docs/designs/X.md');
    const sed = fs.readFileSync(path.join(ROOT, 'ship', 'sections', 'plan-completion.md'), 'utf8').split('\n').find(l => l.startsWith('_BOUND=$(gh pr view'))!;
    const pipeline = sed.replace(/^_BOUND=\$\(gh pr view --json body -q \.body 2>\/dev\/null/, 'cat').replace(/\)$/, '');
    expect(spawnSync('bash', ['-c', pipeline], { input: body, encoding: 'utf8', timeout: 30_000 }).stdout.trim()).toBe('docs/designs/X.md');
    const typo = run(['render', '--plan', 'aproved: ap-1']);
    expect(typo.status).not.toBe(0);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('render --plan needs');
  });

  const bound = (body: string) => {
    const sed = fs.readFileSync(path.join(ROOT, 'ship', 'sections', 'plan-completion.md'), 'utf8').split('\n').find(l => l.startsWith('_BOUND=$(gh pr view'))!;
    const pipeline = sed.replace(/^_BOUND=\$\(gh pr view --json body -q \.body 2>\/dev\/null/, 'cat').replace(/\)$/, '');
    return { ts: planBinding(body), sh: spawnSync('bash', ['-c', pipeline], { input: body, encoding: 'utf8', timeout: 30_000 }).stdout.trim() };
  };

  test('a plan file named like a record kind is a binding, not a record line', () => {
    for (const file of ['approved-plan.md', 'required.md', 'docs/designs/exempt.md']) {
      expect(parsePlanLine(`Plan: ${file}`)).toBeNull();
      expect(bound(`Plan: approved: ap-1\nPlan: ${file}\n`)).toEqual({ ts: file, sh: file });
    }
  });

  test('a tab-separated binding resolves without the tab, and record kinds are skipped in any case', () => {
    expect(bound('Plan:\tdocs/designs/X.md\n')).toEqual({ ts: 'docs/designs/X.md', sh: 'docs/designs/X.md' });
    expect(bound('Plan:\tAPPROVED:\tap-1\nPlan: Required\nPlan:\n\tdocs/designs/Y.md\nPlan:\tdocs/designs/X.md\n')).toEqual({ ts: 'docs/designs/X.md', sh: 'docs/designs/X.md' });
  });
});

describe('/ship finish and the READY note', () => {
  test('finish --plan refuses before any stage under require, and a READY note round-trips the record land reads', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    expect(finishPlan(f.cwd, 'main', undefined, f.env)).toEqual({});
    expect(finishPlan(f.cwd, 'main', undefined, { ...f.env, GSTACK_PLAN_RECORD: 'require' }).failure?.code).toBe('PLAN_RECORD_MISSING');
    const ok = finishPlan(f.cwd, 'main', 'approved: ap-1', { ...f.env, GSTACK_PLAN_RECORD: 'require' });
    expect(ok.failure).toBeUndefined();
    expect(ok.line).toContain('PLAN: approved ap-1');
    const state = tmp('plan-notes-');
    const prev = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = state;
    try {
      const keys = repoIdentity(f.cwd);
      const record = readyPlan({ cwd: f.cwd, env: f.env, body: 'Plan: approved: ap-1', policyValue: 'require', changed: ['lib/x.ts'] }).record!;
      persist(f.cwd, [{ schema: 1, kind: 'ready', repo_key: keys.key, pr: '7', head: 'a'.repeat(40), base_sha: 'b'.repeat(40), ready_at: 'now', screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: 'now', plan: record }], { push: false });
      const note = loadReady(keys.keys, '7', 'a'.repeat(40));
      expect(note?.plan).toEqual(record);
      expect(landPlan({ env: {}, policyValue: 'require', record: note?.plan, body: 'Plan: approved: ap-1' }).failure).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prev;
    }
  });
});

describe('the gate state a Plan line stands for (review blockers, GST-1751)', () => {
  test('a row id from an older gate revision does not outlive a rejected newer revision', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan C rev1', source: 'autoplan:ap-3@gate_rev=1' }, { ask: 'Approve the plan C rev2', source: 'autoplan:ap-3@gate_rev=2', outcome: 'rejected', at: '2026-11-07T02:00:00Z' }] });
    const r = resolvePlan(parsePlanLine(`Plan: approved: ${f.ids['Approve the plan C rev1']}`), f);
    expect(!r.ok && r.failure.code).toBe('PLAN_NOT_APPROVED');
    expect(!r.ok && r.failure.message).toContain('rejected');
  });

  test('a run id needs the plan approval answered and no decision left unanswered, whichever answer event came last', () => {
    const half = fixture({ main: [{ ask: 'Approve the plan D', source: 'autoplan:ap-4@gate_rev=1', pending: '1 decision(s) unanswered: P2' }] });
    const h = resolvePlan(parsePlanLine('Plan: approved: ap-4'), half);
    expect(!h.ok && h.failure.code).toBe('PLAN_NOT_APPROVED');
    expect(!h.ok && h.failure.message).toContain('unanswered');
    const done = fixture({ main: [
      { ask: 'Approve the plan D', source: 'autoplan:ap-4@gate_rev=1', pending: '1 decision(s) unanswered: P2' },
      { ask: 'Approve the plan D (P2 only)', source: 'autoplan:ap-4@gate_rev=1', outcome: 'pending', pending: 'the plan approval itself', at: '2026-11-07T03:00:00Z' },
    ] });
    const d = resolvePlan(parsePlanLine('Plan: approved: ap-4'), done);
    expect(d.ok && d.record).toMatchObject({ state: 'approved', ref: 'ap-4', row_id: done.ids['Approve the plan D'] });
  });
});

describe('a broken approval store never throws, and changes nothing with the key off', () => {
  function broken() {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    const loc = locate({ cwd: f.cwd, env: f.env, branch: 'probe' });
    if ('code' in loc) throw new Error(loc.message);
    const dir = path.dirname(loc.file);
    fs.appendFileSync(path.join(dir, 'main.jsonl'), JSON.stringify({ schema_version: 1, id: 'a-000000000000', ask: 'no source' }) + '\n{torn\n');
    fs.mkdirSync(path.join(dir, 'unreadable.jsonl'));
    return f;
  }

  test('key off: ready and finish give the same output as with no line at all, and nothing throws', () => {
    const f = broken();
    const body = 'Plan: approved: ap-1';
    expect(readyPlan({ cwd: f.cwd, env: f.env, body: '', changed: ['lib/x.ts'] })).toEqual({});
    const off = readyPlan({ cwd: f.cwd, env: f.env, body, changed: ['lib/x.ts'] });
    expect(off.line).toBeUndefined();
    expect(off.failure).toBeUndefined();
    const fin = finishPlan(f.cwd, 'main', body, f.env);
    expect(fin.line).toBeUndefined();
    expect(fin.failure).toBeUndefined();
    expect(landPlan({ env: f.env, body, record: undefined })).toEqual({});
  });

  test('warn and require read past the broken rows and still resolve; an unreadable store is a refusal, never a throw', () => {
    const f = broken();
    const warn = readyPlan({ cwd: f.cwd, env: { ...f.env, GSTACK_CAPY: '1' }, body: 'Plan: approved: ap-1', changed: ['lib/x.ts'] });
    expect(warn.line).toContain('PLAN: approved ap-1');
    const gone = fixture();
    const req = readyPlan({ cwd: gone.cwd, env: { ...gone.env, GSTACK_PLAN_RECORD: 'require' }, body: 'Plan: approved: ap-1', changed: ['lib/x.ts'] });
    expect(req.failure?.code).toBe('PLAN_STORE_UNAVAILABLE');
  });
});

describe('public repos: the record-keyed Plan line and the machine-local key (GST-1774)', () => {
  const ghStub = (visibility: string) => {
    const bin = tmp('plan-gh-');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho ${visibility}\n`, { mode: 0o755 });
    return bin;
  };
  const approvals = (f: { cwd: string; env: NodeJS.ProcessEnv }, visibility: string) => (args: string[]) => {
    const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-approvals'), ...args], { cwd: f.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...f.env, PATH: `${ghStub(visibility)}:${process.env.PATH}` } });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const setLocal = (env: NodeJS.ProcessEnv, value: string) => fs.writeFileSync(path.join(env.GSTACK_STATE_ROOT!, 'config.yaml'), `plan_record: ${value}\n`);

  test('parsePlanLine reads the record form; planRecordId is stable and opaque', () => {
    expect(parsePlanLine('Plan: approved (record r-0123456789ab)')).toEqual({ kind: 'approved', line: 'Plan: approved (record r-0123456789ab)', token: 'r-0123456789ab' });
    expect(parsePlanLine('**Plan:** approved (record r-0123456789AB).')).toMatchObject({ token: 'r-0123456789ab' });
    expect(parsePlanLine('```\nPlan: approved (record r-0123456789ab)\n```')).toBeNull();
    expect(planRecordId('a-000000000000')).toMatch(/^r-[0-9a-f]{12}$/);
    expect(planRecordId('a-000000000000')).toBe(planRecordId('a-000000000000'));
    expect(planRecordId('a-000000000000')).not.toContain('000000000000');
  });

  test('planMode: a tracked warn or require wins, then the env opt-in, then the machine key, then the Capy default', () => {
    const state = tmp('plan-local-');
    const env = { GSTACK_STATE_ROOT: state } as NodeJS.ProcessEnv;
    expect(planMode('off', env)).toEqual({ mode: 'off', source: 'default' });
    setLocal(env, 'require');
    expect(planMode('warn', env)).toEqual({ mode: 'warn', source: 'base policy plan_record' });
    expect(planMode('off', env)).toEqual({ mode: 'require', source: `state-root config ${state}/config.yaml` });
    expect(planMode(undefined, { ...env, GSTACK_PLAN_RECORD: 'warn' }).source).toBe('GSTACK_PLAN_RECORD');
    setLocal(env, 'off');
    expect(planMode('off', { ...env, GSTACK_CAPY: '1' }).mode).toBe('off');
    setLocal(env, 'requre');
    const typo = planMode('off', { ...env, GSTACK_CAPY: '1' });
    expect(typo.mode).toBe('warn');
    expect(typo.source).toContain('plan_record "requre" ignored');
    expect(planMode(undefined, { HOME: '' }).mode).toBe('off');
  });

  test('a record id resolves to its row under the row-id rules, and never names the run, the row or the ask', () => {
    const f = fixture({ main: [
      { ask: 'Approve the plan A (autoplan run ap-1)', source: 'autoplan:ap-1@gate_rev=1' },
      { ask: 'review_loop_grant abc for #1', scope: 'one fix-check' },
      { ask: 'Approve the plan C rev1', source: 'autoplan:ap-3@gate_rev=1' },
      { ask: 'Approve the plan C rev2', source: 'autoplan:ap-3@gate_rev=2', outcome: 'rejected', at: '2026-11-07T02:00:00Z' },
    ] });
    const id = planRecordId(f.ids['Approve the plan A (autoplan run ap-1)']);
    const ok = resolvePlan(parsePlanLine(`Plan: approved (record ${id})`), f);
    expect(ok.ok && ok.record).toEqual({ line: `Plan: approved (record ${id})`, state: 'approved', ref: id, row_sha256: expect.any(String), resolver: 1 });
    expect(ok.ok && ok.summary).toBe(`approved ${id} (gate_rev 1, 2026-11-07)`);
    const grant = resolvePlan(parsePlanLine(`Plan: approved (record ${planRecordId(f.ids['review_loop_grant abc for #1'])})`), f);
    expect(!grant.ok && grant.failure.code).toBe('PLAN_UNRESOLVED');
    const stale = resolvePlan(parsePlanLine(`Plan: approved (record ${planRecordId(f.ids['Approve the plan C rev1'])})`), f);
    expect(!stale.ok && stale.failure.code).toBe('PLAN_NOT_APPROVED');
    expect(!stale.ok && stale.failure.message).not.toContain('ap-3');
    const unknown = resolvePlan(parsePlanLine('Plan: approved (record r-000000000000)'), f);
    expect(!unknown.ok && unknown.failure.code).toBe('PLAN_UNRESOLVED');
    const block = 'r-' + createHash('sha256').update(Object.values(f.ids).sort().join('\n')).digest('hex').slice(0, 12);
    const pasted = resolvePlan(parsePlanLine(`Plan: approved (record ${block})`), f);
    expect(!pasted.ok && pasted.failure.message).toContain("the Approvals block's id");
    expect(publicPlanLine(parsePlanLine('Plan: approved: ap-1')!, resolvePlan(parsePlanLine('Plan: approved: ap-1'), f))).toBe(`Plan: approved (record ${id})`);
  });

  test('render on a public repo prints the record form, re-renders it unchanged, and refuses a line that does not resolve', () => {
    const f = fixture({ 'capy-feature': [{ ask: 'Approve the plan A (autoplan run ap-1)', source: 'autoplan:ap-1@gate_rev=1' }] });
    const run = approvals(f, 'PUBLIC');
    const id = planRecordId(f.ids['Approve the plan A (autoplan run ap-1)']);
    const body = run(['render', '--plan', 'Plan: approved: ap-1']).out;
    expect(body).toContain(`Plan: approved (record ${id})\nPlan check: approved (record ${id})\n`);
    for (const secret of ['ap-1', f.ids['Approve the plan A (autoplan run ap-1)']!, 'Approve the plan A']) expect(body).not.toContain(secret);
    expect(parsePlanLine(body)).toMatchObject({ token: id });
    expect(run(['render', '--plan', `Plan: approved (record ${id})`]).out).toBe(body);
    const check = run(['plan-check', '--plan', `approved (record ${id})`]);
    expect(check.status).toBe(0);
    expect(check.out).toBe(`PLAN: approved ${id} (gate_rev 1, 2026-11-07)\n`);
    expect(run(['render', '--plan', 'Plan: exempt: bug fix (R65)']).out).toContain('Plan: exempt: bug fix (R65)\nPlan check: exempt bug fix\n');
    const missing = run(['render', '--plan', 'Plan: approved: ap-9']);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toBe('');
    expect(missing.err).toContain('PLAN_UNRESOLVED');
    expect(missing.err).toContain('fix:');
    expect(approvals(f, 'PRIVATE')(['render', '--plan', 'Plan: approved: ap-1']).out).toContain('Plan: approved: ap-1\nPlan check: approved ap-1 row=');
  });

  test('ready, finish and land carry a record-form line with no run id, row id or ask', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A (autoplan run ap-1)', source: 'autoplan:ap-1@gate_rev=1' }] });
    const rowId = f.ids['Approve the plan A (autoplan run ap-1)']!;
    const line = `Plan: approved (record ${planRecordId(rowId)})`;
    const ready = readyPlan({ cwd: f.cwd, env: f.env, body: line, policyValue: 'require', changed: ['lib/x.ts'] });
    const finish = finishPlan(f.cwd, 'main', line, { ...f.env, GSTACK_PLAN_RECORD: 'require' });
    for (const out of [ready.line!, finish.line!, JSON.stringify(ready.record)]) for (const secret of ['ap-1', rowId, 'Approve the plan']) expect(out).not.toContain(secret);
    expect(ready.record?.row_id).toBeUndefined();
    expect(landPlan({ env: {}, policyValue: 'require', record: ready.record, body: line })).toEqual({ line: `PLAN: approved ${planRecordId(rowId)} (from the READY note)` });
  });

  test('with no tracked policy the machine key drives ready and finish, and a deciding off still prints a line', () => {
    const f = fixture({ main: [{ ask: 'Approve the plan A', source: 'autoplan:ap-1@gate_rev=1' }] });
    setLocal(f.env, 'require');
    const ready = readyPlan({ cwd: f.cwd, env: f.env, body: '', changed: ['lib/x.ts'] });
    expect(ready.failure?.code).toBe('PLAN_RECORD_MISSING');
    expect(ready.line).toContain(`[mode require from state-root config ${f.env.GSTACK_STATE_ROOT}/config.yaml]`);
    expect(finishPlan(f.cwd, 'main', undefined, f.env).failure?.code).toBe('PLAN_RECORD_MISSING');
    setLocal(f.env, 'off');
    const off = readyPlan({ cwd: f.cwd, env: { ...f.env, GSTACK_CAPY: '1' }, body: '', changed: ['lib/x.ts'] });
    expect(off).toEqual({ line: `PLAN: off [mode off from state-root config ${f.env.GSTACK_STATE_ROOT}/config.yaml]` });
    expect(landPlan({ env: { ...f.env, GSTACK_CAPY: '1' }, policyValue: 'off', body: '' }).line).toContain('PLAN: off');
  });

  test('gstack-config takes off, warn or require for plan_record and rejects a typo', () => {
    const state = tmp('plan-config-');
    const config = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-config'), args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_HOME: '' } });
    expect(config('get', 'plan_record')).toMatchObject({ status: 0, stdout: '' });
    expect(config('set', 'plan_record', 'warn').status).toBe(0);
    const typo = config('set', 'plan_record', 'requre');
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('Existing value left unchanged');
    expect(config('get', 'plan_record').stdout.trim()).toBe('warn');
  });
});
