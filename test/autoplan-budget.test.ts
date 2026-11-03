/**
 * Field list 2, W5: the autoplan run budget on the simulated Capy host. An
 * unattended run under --spend-cap (or on Capy) reserves the default per-voice
 * estimate so the cap binds, `--estimate-usd` persists for later phases, and a refused dispatch stops the run `incomplete` with a structured
 * stop object that export, validate and resume understand; `budget` journals
 * the owner's raise. `close --deferred` keeps a dispatched voice's
 * reservation, routes an open Critical to the gate and carries open findings
 * into tasks.jsonl; the round cap defers a rerun phase and turns a later
 * revise into an owner gate item; confirm rounds carry the plan delta and
 * revision-qualified, settled finding ids. Every spawn has a timeout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HOST_ESTIMATE_USD } from '../lib/autoplan-budget';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 60 s, dead-letter after 8 attempts');
const NONE = { native: [], outside: [] };
function start(args: string[] = []): { out: string; dir: string; plan: string } {
  const dir = path.join(r.host.base, `budget${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui', ...args]);
  if (first.status !== 0) throw new Error(`first next failed: ${first.stderr}\n${first.stdout}`);
  return { out, dir, plan };
}
const spend = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
const unknownUsd = (out: string) => spend(out).settled.filter((s: any) => s.usd === 'unknown').reduce((t: number, s: any) => t + s.reserved_usd, 0);
const answer = (out: string, rev: number, reply: string) => r.ap(['answer', '--by', 'human', '--out', out, '--gate-rev', String(rev), '--reply', reply]);
const gate = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const v2File = (dir: string, text = V2) => { const f = path.join(dir, `plan-v2-${++n}.md`); fs.writeFileSync(f, text); return f; };

describe('spend: the default host estimate binds and budget_exhausted is a resumable incomplete stop', () => {
  test('Capy unattended reserves the default per voice; the cap stops the run incomplete; budget raise then resume continues', () => {
    const dir = path.join(r.host.base, 'spend');
    const plan = writePlan(dir);
    const out = path.join(dir, 'run');
    const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui', '--spend-cap', '12']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^ESTIMATE: 5\.00 per voice reserved for each host-subagent attempt/m);
    expect(first.stdout).toMatch(/^ROUNDS: ceo=1\/2 eng=1\/2 max_rounds=2 host_spend=unknown$/m);
    expect(spend(out).reserved.map((x: any) => x.estimate_usd)).toEqual([5, 5]);
    expect(readRunJson(out).max_rounds).toBe(2);
    phaseVia(r, out, 'ceo', NONE);
    expect(unknownUsd(out)).toBe(10);
    const stopped = r.ap(['next', '--out', out]);
    expect(stopped.status).toBe(3);
    expect(stopped.stderr).toMatch(/\(SPEND_CAP_EXCEEDED\)$/m);
    expect(stopped.stdout).toMatch(/^STOP: reason=budget_exhausted phase=eng cap=12\.00 spent=0\.00 reserved=0\.00 unknown=2\(10\.00\) next_estimate=10\.00 rounds=ceo:1\/2,eng:1\/2$/m);
    expect(stopped.stdout).toContain(`RECOVER: gstack-autoplan close --out ${out} --phase eng --deferred`);
    expect(stopped.stdout).toContain(`RECOVER: gstack-autoplan budget --out ${out} --spend-cap <usd>`);
    expect(stopped.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=incomplete run=${out}`);
    const run = readRunJson(out);
    expect(run.status).toBe('incomplete');
    expect(run.stop).toMatchObject({ reason: 'budget_exhausted', cap_usd: 12, rounds: { ceo: 1, eng: 1 }, spent: 0, reserved: 0, unknown: 10 });
    expect(readJsonl(path.join(out, 'attempts.jsonl')).filter(e => e.event === 'dispatched' && e.phase === 'eng')).toEqual([]);
    expect(r.ap(['export', '--out', out]).status).toBe(0);
    const v = r.validate(out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    expect(v.stdout).toContain('status=incomplete');
    const early = r.ap(['resume', '--out', out]);
    expect(early.stdout).toMatch(/^STOPPED: budget_exhausted at /m);
    expect(readRunJson(out).status).toBe('incomplete');
    const noBy = r.ap(['budget', '--out', out, '--spend-cap', '40']);
    expect(noBy.status).toBe(3);
    expect(noBy.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)$/m);
    const raise = r.ap(['budget', '--out', out, '--spend-cap', '40', '--by', 'human']);
    expect(raise.status, raise.stderr).toBe(0);
    expect(raise.stdout).toMatch(/^BUDGET: spend_cap=12->40 by=human$/m);
    expect(raise.stdout).toContain(`NEXT: gstack-autoplan resume --out ${out}`);
    expect(spend(out).cap_usd).toBe(40);
    const resumed = r.ap(['resume', '--out', out]);
    expect(resumed.stdout).toMatch(/^STOP_LIFTED: budget raised after budget_exhausted$/m);
    expect(readRunJson(out).stops).toHaveLength(1);
    const eng = phaseVia(r, out, 'eng', NONE);
    expect(eng.outside.stdout).toContain('status=gate_pending');
    expect(fs.readFileSync(path.join(out, 'review-record.md'), 'utf8')).toMatch(/Stopped budget_exhausted at .* \(lifted\)/);
  });
});

describe('close --deferred', () => {
  test('a dispatched voice keeps its reservation, an open Critical becomes an owner item, open findings become tasks', () => {
    const s = start(['--spend-cap', '100']);
    r.review(path.join(s.out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ severity: 'Critical', title: 'Retries can double-charge', fix: 'idempotency key' }, { severity: 'Medium', title: 'Jitter source unstated' }]) });
    const run0 = readRunJson(s.out);
    const bound = r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--result', run0.phases.ceo.native.attempts[0].result, '--model', 'anthropic/claude-opus-5-5', '--attempt', run0.phases.ceo.native.attempt]);
    expect(bound.status, bound.stderr).toBe(0);
    const outsideAttempt = run0.phases.ceo.outside.attempt;
    const before = unknownUsd(s.out) + spend(s.out).reserved.reduce((t: number, x: any) => t + x.estimate_usd, 0);
    const noBy = r.ap(['close', '--out', s.out, '--phase', 'ceo', '--deferred', 'owner stop']);
    expect(noBy.status).toBe(3);
    expect(noBy.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)$/m);
    const close = r.ap(['close', '--out', s.out, '--phase', 'ceo', '--deferred', 'owner stop', '--by', 'human']);
    expect(close.status, close.stderr).toBe(0);
    expect(close.stdout).toMatch(/^PHASE_DEFERRED: ceo round=1\/2 by=human open=2 \(Critical=1 Medium=1\) blockers=\S+-ceo-native-1 reason="owner stop"$/m);
    expect(close.stdout).toContain('GSTACK_RESULT: skill=autoplan status=running');
    const run = readRunJson(s.out);
    expect(run.phases.ceo.outside.status).toBe('skipped');
    expect(run.phases.ceo.outside.attempts[0].state).toBe('deferred');
    const settled = spend(s.out).settled.find((x: any) => x.attempt === outsideAttempt);
    expect(settled).toMatchObject({ usd: 'unknown', reserved_usd: DEFAULT_HOST_ESTIMATE_USD });
    expect(spend(s.out).released).toEqual([]);
    const after = unknownUsd(s.out) + spend(s.out).reserved.reduce((t: number, x: any) => t + x.estimate_usd, 0);
    expect(after).toBe(before);
    expect(r.ap(['resume', '--out', s.out]).status).toBe(0);
    expect(unknownUsd(s.out)).toBe(after);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).some(e => e.event === 'attempt_deferred' && e.attempt === outsideAttempt)).toBe(true);
    const again = r.ap(['close', '--out', s.out, '--phase', 'ceo', '--deferred', 'twice', '--by', 'human']);
    expect(again.status).toBe(3);
    expect(again.stderr).toMatch(/\(PHASE_NOT_AWAITING\)$/m);
    expect(phaseVia(r, s.out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
    const items = gate(s.out).items;
    const blocker = items.find((i: any) => i.cap?.kind === 'blocker');
    expect(blocker).toMatchObject({ kind: 'approval', recommended: 'b', phase: 'ceo' });
    expect(blocker.title).toContain('Retries can double-charge');
    expect(items.find((i: any) => i.cap?.kind === 'deferred')).toMatchObject({ kind: 'auto', recommended: 'a' });
    const tasks = readJsonl(path.join(s.out, 'tasks.jsonl'));
    expect(tasks.filter((t: any) => t.title.startsWith('deferred from ceo:')).map((t: any) => t.priority).sort()).toEqual(['Critical', 'Medium']);
    expect(readJsonl(path.join(s.out, 'findings.jsonl')).filter((f: any) => f.phase === 'ceo').every((f: any) => f.disposition === 'deferred')).toBe(true);
    const v = r.validate(s.out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    const reply = answer(s.out, 1, 'rec');
    expect(reply.status, reply.stderr).toBe(0);
    expect(reply.stdout).toMatch(/^ROUND_GRANTED: ceo cap=3 \(uc\d+b by human\)$/m);
    expect(reply.stdout).toMatch(/^REOPENED: ceo,eng/m);
    expect(reply.stdout).toMatch(/^ROUND_GRANTED: eng cap=3 \(reruns after ceo; uc\d+b by human\)$/m);
    expect(readRunJson(s.out).round_grants).toEqual({ ceo: 1, eng: 1 });
  });
});

describe('the round cap', () => {
  test('a revise after a capped phase reopens nothing and asks the owner about the unreviewed delta', () => {
    const s = start(['--max-rounds', '1']);
    phaseVia(r, s.out, 'ceo', NONE);
    expect(phaseVia(r, s.out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
    const rev = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=none capped=ceo,eng$/m);
    expect(rev.stdout).toMatch(/^CAPPED: ceo used round 1 of 1: not reopened; the gate asks the owner about the unreviewed delta \(\+1 -1 lines\)$/m);
    expect(rev.stdout).toMatch(/^GATE: gate_rev=2 /m);
    const run = readRunJson(s.out);
    expect(run.status).toBe('gate_pending');
    expect(run.capped_deltas.map((d: any) => [d.phase, d.status])).toEqual([['ceo', 'pending'], ['eng', 'pending']]);
    const deltas = gate(s.out).items.filter((i: any) => i.cap?.kind === 'delta');
    expect(deltas.map((i: any) => i.title.replace(/\(.*/, '').trim())).toEqual(['plan changed after ceo cap: unreviewed delta', 'plan changed after eng cap: unreviewed delta']);
    expect(deltas.every((i: any) => i.kind === 'approval')).toBe(true);
    const partial = answer(s.out, 2, 'p1a');
    expect(partial.stdout).toMatch(/^GATE_PENDING: /m);
    const done = answer(s.out, 2, 'rec');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(/^APPROVED: gate_rev=2/m);
    expect(readRunJson(s.out).capped_deltas.map((d: any) => d.status)).toEqual(['accepted', 'accepted']);
    expect(r.validate(s.out).status).toBe(0);
  });

  test('a rerun past the cap closes the phase deferred, carrying the last round\'s findings, and export and validate pass', () => {
    const s = start(['--max-rounds', '1']);
    phaseVia(r, s.out, 'ceo', { native: [{ severity: 'High', title: 'Backoff cap is unbounded under clock skew' }], outside: [] });
    phaseVia(r, s.out, 'eng', NONE);
    const rerun = answer(s.out, 1, 'p1d');
    expect(rerun.stdout).toMatch(/^REOPENED: ceo,eng/m);
    const next = r.ap(['next', '--out', s.out]);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^PHASE_DEFERRED: ceo round=2\/1 by=runner open=1 \(High=1\) blockers=none reason="round cap: round 2 would pass max 1"$/m);
    expect(next.stdout).toMatch(/^PHASE_DEFERRED: eng round=2\/1 by=runner open=0 /m);
    expect(next.stdout).toContain('status=gate_pending');
    const findings = readJsonl(path.join(s.out, 'findings.jsonl'));
    expect(findings.map((f: any) => [f.title, f.disposition])).toEqual([['Backoff cap is unbounded under clock skew', 'deferred']]);
    expect(readJsonl(path.join(s.out, 'tasks.jsonl')).map((t: any) => t.status)).toEqual(['pending']);
    expect(r.ap(['export', '--out', s.out]).status).toBe(0);
    const v = r.validate(s.out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    expect(r.ap(['resume', '--out', s.out]).stdout).toContain('status=gate_pending');
  });
});

describe('deferred close keeps earlier open findings; a reopened phase reruns Eng', () => {
  test('a deferred confirm round with a new finding still carries the earlier undecided Critical to the gate and tasks', () => {
    const s = start();
    phaseVia(r, s.out, 'ceo', { native: [{ severity: 'Critical', title: 'Retries can double-charge', fix: 'Add a durable idempotency key' }], outside: [] });
    phaseVia(r, s.out, 'eng', NONE);
    expect(answer(s.out, readRunJson(s.out).gate_rev, 'p1d').status).toBe(0);
    expect(r.ap(['next', '--out', s.out]).status).toBe(0);
    const rr = readRunJson(s.out);
    const review = r.review(path.join(s.out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ severity: 'Medium', title: 'Jitter source is unspecified' }]) });
    expect(review.status, review.stderr).toBe(0);
    const sub = r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--result', rr.phases.ceo.native.attempts.at(-1).result, '--model', 'anthropic/claude-opus-5-5', '--attempt', rr.phases.ceo.native.attempt]);
    expect(sub.status, sub.stderr).toBe(0);
    const closed = r.ap(['close', '--out', s.out, '--phase', 'ceo', '--deferred', 'owner pauses remaining reviews', '--by', 'human']);
    expect(closed.status, closed.stderr).toBe(0);
    expect(closed.stdout).toMatch(/^PHASE_DEFERRED: ceo round=2\/\S+ by=human open=2 \(Critical=1 Medium=1\) blockers=\S+-ceo-native-1 /m);
    phaseVia(r, s.out, 'eng', NONE);
    expect(gate(s.out).items.filter((i: any) => i.cap?.kind === 'blocker').map((i: any) => i.title)).toEqual([expect.stringContaining('Retries can double-charge')]);
    expect(readJsonl(path.join(s.out, 'tasks.jsonl')).map((t: any) => t.priority).sort()).toEqual(['Critical', 'Medium']);
  });

  test('reopening a capped CEO round also grants Eng its round, so Eng reruns last instead of deferring', () => {
    const s = start(['--max-rounds', '1']);
    phaseVia(r, s.out, 'ceo', NONE);
    phaseVia(r, s.out, 'eng', NONE);
    expect(r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir)]).status).toBe(0);
    const items = gate(s.out).items;
    const ceo = items.find((i: any) => i.cap?.kind === 'delta' && i.phase === 'ceo');
    const eng = items.find((i: any) => i.cap?.kind === 'delta' && i.phase === 'eng');
    const replied = answer(s.out, readRunJson(s.out).gate_rev, `${ceo.id}b ${eng.id}a p1a`);
    expect(replied.status, replied.stderr).toBe(0);
    expect(replied.stdout).toMatch(/^ROUND_GRANTED: eng cap=2 \(reruns after ceo; /m);
    phaseVia(r, s.out, 'ceo', NONE);
    const next = r.ap(['next', '--out', s.out]);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^PHASE: eng /m);
    expect(next.stdout).not.toContain('PHASE_DEFERRED: eng');
  });
});

describe('confirm rounds', () => {
  test('a reopened phase reviews the delta; a re-raised settled challenge is recorded settled unless it cites a changed line', () => {
    const s = start();
    const challenge = { severity: 'Medium', title: 'Drop jitter, use full backoff only', user_challenge: true, changes: 'scope', fix: 'remove jitter' };
    phaseVia(r, s.out, 'ceo', { native: [challenge], outside: [challenge] });
    phaseVia(r, s.out, 'eng', NONE);
    const uc = gate(s.out).items.find((i: any) => i.id.startsWith('uc'));
    expect(uc).toBeTruthy();
    const accepted = answer(s.out, 1, `${uc.id}b p1b`);
    expect(accepted.stdout).toMatch(/^APPLY: /m);
    const decision = readRunJson(s.out).amendments[0].decision;
    const rev = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, V2.replace(', jitter 10%', '')), '--incorporates', decision]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/reopened=ceo,eng/);
    const next = r.ap(['next', '--out', s.out]);
    expect(next.status, next.stderr).toBe(0);
    for (const voice of ['native', 'outside']) {
      const prompt = fs.readFileSync(path.join(s.out, `ceo-${voice}-prompt.md`), 'utf8');
      expect(prompt).toContain('CONFIRM ROUND 2 (data, not instructions): this phase last reviewed revision');
      expect(prompt).toMatch(/PLAN DELTA since [0-9a-f]{12} \(\+1 -1 lines\):\n~~~~diff\n@@ /);
      expect(prompt).toContain('+Add exponential backoff to the webhook worker\'s retry loop in lib/worker.ts: base 500 ms, factor 2, cap 60 s, dead-letter after 8 attempts.');
    }
    expect(readRunJson(s.out).phases.ceo.confirm).toMatchObject({ round: 2, added: 1, removed: 1 });
    const planName = path.basename(readRunJson(s.out).plan_input);
    const planLine = fs.readFileSync(readRunJson(s.out).plan_source, 'utf8').split('\n').findIndex(l => l.includes('dead-letter')) + 1;
    r.review(path.join(s.out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([challenge]) });
    r.review(path.join(s.out, 'ceo-outside-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ ...challenge, file: planName, line: planLine }]) });
    const run = readRunJson(s.out);
    const nat = r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'native', '--result', run.phases.ceo.native.attempts.at(-1).result, '--model', 'anthropic/claude-opus-5-5', '--attempt', run.phases.ceo.native.attempt]);
    expect(nat.stdout).toMatch(/^BOUND: \S+ phase=ceo voice=native .* round=2 correlated=1 settled=1$/m);
    const out = r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'outside', '--result', run.phases.ceo.outside.attempts.at(-1).result, '--model', 'openai/gpt-6.1-sol', '--attempt', run.phases.ceo.outside.attempt]);
    expect(out.stdout).toMatch(/^BOUND: \S+ phase=ceo voice=outside .* round=2 correlated=1 settled=0$/m);
    const bound = readRunJson(s.out).phases.ceo;
    const rows = [...readJsonl(path.join(s.out, `${bound.native.output}.findings.jsonl`)), ...readJsonl(path.join(s.out, `${bound.outside.output}.findings.jsonl`))];
    expect(rows.map((x: any) => x.id)).toEqual([expect.stringMatching(/-ceo-r2-native-1$/), expect.stringMatching(/-ceo-r2-outside-1$/)]);
    expect(rows[0].correlates).toEqual([expect.stringMatching(/-ceo-native-1$/), expect.stringMatching(/-ceo-outside-1$/)]);
    expect(rows[0].settled_by).toBeTruthy();
    expect(rows[1].settled_by).toBeUndefined();
  });
});

describe('the cap binds on every unattended host (GBRA-223 claim 4)', () => {
  const OFF_CAPY = { GSTACK_CAPY: '' };
  test('a capped unattended run off Capy reserves the default per voice, so the cap stops it; with no cap it reserves nothing', () => {
    const dir = path.join(r.host.base, 'offcapy');
    const out = path.join(dir, 'run');
    const first = r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--spend-cap', '12'], OFF_CAPY);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^ESTIMATE: 5\.00 per voice reserved for each host-subagent attempt/m);
    expect(spend(out).reserved.map((x: any) => x.estimate_usd)).toEqual([DEFAULT_HOST_ESTIMATE_USD, DEFAULT_HOST_ESTIMATE_USD]);
    phaseVia(r, out, 'ceo', NONE);
    const stopped = r.ap(['next', '--out', out], OFF_CAPY);
    expect(stopped.status).toBe(3);
    expect(stopped.stderr).toMatch(/\(SPEND_CAP_EXCEEDED\)$/m);
    const freeDir = path.join(r.host.base, 'offcapy-nocap');
    const free = path.join(freeDir, 'run');
    const uncapped = r.ap(['next', '--out', free, '--plan', writePlan(freeDir), '--no-ui'], OFF_CAPY);
    expect(uncapped.status, uncapped.stderr).toBe(0);
    expect(uncapped.stdout).not.toMatch(/^ESTIMATE:/m);
    expect(spend(free).reserved.map((x: any) => x.estimate_usd)).toEqual([0, 0]);
  });

  test('--estimate-usd persists: later phases reserve it without the flag', () => {
    const s = start(['--spend-cap', '40', '--estimate-usd', '3']);
    expect(spend(s.out).reserved.map((x: any) => x.estimate_usd)).toEqual([3, 3]);
    expect(readRunJson(s.out).estimate_usd).toBe(3);
    phaseVia(r, s.out, 'ceo', NONE);
    expect(spend(s.out).settled.map((x: any) => x.reserved_usd)).toEqual([3, 3]);
    const eng = r.ap(['next', '--out', s.out]);
    expect(eng.status, eng.stderr).toBe(0);
    expect(eng.stdout).toMatch(/^PHASE: eng /m);
    expect(spend(s.out).reserved.map((x: any) => x.estimate_usd)).toEqual([3, 3]);
  });
});
