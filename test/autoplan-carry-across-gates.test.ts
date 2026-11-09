/**
 * Carry across fix-only gates: an owner who answered gate_rev N with "do it" is not asked again when a later gate holds
 * only the fixes that answer asked for. Repro of run autoplan-v0-20261109012507: answer(rec) left accepted changes
 * pending; revise at the round cap wrote gate_rev 2 with unreviewed-delta items; its delta check found a High; the High
 * was fixed and a second revise wrote gate_rev 3, which refused to carry because gate_rev 2 was never answered, so the
 * owner said "do it" twice. A carry reuses the owner's last answered gate only across gates that were never relayed and
 * hold only delta or already-decided items, and only after a delta check against that answer passes. Simulated Capy host.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recHash } from '../lib/gate-list';
import { ROOT, SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

setDefaultTimeout(60_000);
const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const NONE = { native: [], outside: [] };
const AGREE = {
  native: [{ id: 'F1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
  outside: [{ id: 'O1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
};
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1');
const V3 = V2.replace('jitter 10%', 'jitter 10% (kept from the first draft)');
const gateOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const decisions = (out: string) => readJsonl(path.join(out, 'decisions.jsonl'));
const result = (file: string, sha: string, findings: unknown[]) => fs.writeFileSync(file, `INPUT: carry-check ${sha}\n\nReviewed the delta.\n\n` + '```gstack-findings\n' + findings.map(f => JSON.stringify(f)).join('\n') + '\n```\n');
const check = (out: string, findings: unknown[]) => {
  const c = readRunJson(out).carry.check;
  result(c.result, c.delta_sha256, findings);
  const res = r.ap(['check', '--out', out, '--attempt', c.attempt, '--result', c.result, '--model', 'openai/gpt-6.1-sol']);
  expect(res.status, res.stderr).toBe(0);
  return res;
};

/** answer(rec) "do it" at gate_rev 1, revise at the round cap (gate_rev 2, delta check dispatched), the check finds a High. */
function highAtGate2() {
  const dir = path.join(r.host.base, `across${++n}`);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--max-rounds', '1']).status).toBe(0);
  phaseVia(r, out, 'ceo', AGREE);
  expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
  const ans = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', 'Garry: do it']);
  expect(ans.status, ans.stderr).toBe(0);
  const v2 = path.join(dir, 'plan-v2.md');
  fs.writeFileSync(v2, V2);
  const rev = r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', 'uc1']);
  expect(rev.status, rev.stderr).toBe(0);
  expect(rev.stdout).toMatch(/^GATE: gate_rev=2 /m);
  expect(rev.stdout).toMatch(/^CARRY_CHECK: attempt=\S+-c2 /m);
  const bad = check(out, [{ id: 'F1', severity: 'High', title: 'The edit also drops the jitter' }]);
  expect(bad.stdout).toMatch(/^CARRY: no \(delta check found High: The edit also drops the jitter\)$/m);
  return { dir, out, v2 };
}

/** The fix for the High: a second revise at the cap, which writes gate_rev 3. */
function fixed(s: { dir: string; out: string }, text = V3) {
  const v3 = path.join(s.dir, 'plan-v3.md');
  fs.writeFileSync(v3, text);
  const rev = r.ap(['revise', '--out', s.out, '--plan', v3]);
  expect(rev.status, rev.stderr).toBe(0);
  expect(rev.stdout).toMatch(/^GATE: gate_rev=3 /m);
  return rev;
}

describe('carry across fix-only gates', () => {
  // Value: protects=the owner's one "do it" covers the fixes it asked for, through a capped gate whose delta check failed;
  // fails_when=carry insists on the gate right before it being answered; why_new=autoplan-carry.test.ts carries only from
  // gate_rev N to N+1; seam=none; no_claim=real reviewer dispatch (simulated Capy host)
  test('answer(rec), revise at the cap, a High, the fix, revise: gate_rev 3 carries the gate_rev 1 answer after its delta check', () => {
    const s = highAtGate2();
    const rev = fixed(s);
    expect(rev.stdout).not.toContain('CARRY: no (gate_rev 2 was not answered)');
    expect(rev.stdout).toMatch(/^CARRY_CHECK: attempt=\S+-c3 /m);
    const c = readRunJson(s.out).carry;
    expect(c).toMatchObject({ gate_rev: 3, from_gate_rev: 1, verdict: 'check_pending' });
    const prompt = fs.readFileSync(c.check.prompt, 'utf8');
    expect(prompt).toContain("reuses the owner's approval of gate_rev 1 for gate_rev 3");
    expect(prompt).toContain('gate_rev 2');
    expect(prompt).toContain('+ Add exponential backoff');
    const ok = check(s.out, []);
    expect(ok.stdout).toMatch(/^CARRIED: gate_rev=3 <- gate_rev=1 words="Garry: do it" .*across unrelayed gate_rev 2/m);
    expect(ok.stdout).toContain('status=complete');
    expect(decisions(s.out).find(d => d.gate_rev === 3 && d.label === 'P1')).toMatchObject({ carried_gate_rev: 1, owner_reply: 'Garry: do it' });
    expect(r.ap(['export', '--out', s.out]).status).toBe(0);
    expect(r.validate(s.out).status).toBe(0);
  });
  // Value: protects=the cross-gate carry never skips a gate that asked the owner something new; fails_when=sourceGate
  // skips an unanswered gate without reading its items; why_new=the repro gate holds only delta items; seam=none
  test('an intervening gate that asks a new user challenge refuses the carry', () => {
    const dir = path.join(r.host.base, `across${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--max-rounds', '2']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    phaseVia(r, out, 'eng', NONE);
    expect(r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', 'Garry: do it']).status).toBe(0);
    const v2 = path.join(dir, 'plan-v2.md');
    fs.writeFileSync(v2, V2);
    expect(r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', 'uc1']).stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
    const NEW = { native: [{ id: 'F2', severity: 'High', title: 'Drop the resume path', user_challenge: true, changes: 'scope', fix: 'remove the attempt count' }], outside: [{ id: 'O2', severity: 'High', title: 'Drop the resume path', user_challenge: true, changes: 'scope', fix: 'remove the attempt count' }] };
    phaseVia(r, out, 'ceo', NEW);
    expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^CARRY: no \(new item uc\d+: /m);
    expect(gateOf(out).gate_rev).toBe(2);
    const rev = fixed({ dir, out });
    expect(rev.stdout).toMatch(/^CARRY: no \(gate_rev 2 was not answered and asks uc\d+: .*Drop the resume path/m);
    expect(readRunJson(out).status).toBe('gate_pending');
  });

  // Value: protects=a gate the owner may have seen is never skipped; fails_when=renders are not journaled or not read;
  // why_new=nothing recorded a relay before; seam=none
  test('a gate that was relayed (rendered for the owner) refuses the carry', () => {
    const s = highAtGate2();
    const brief = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--captain', '--out', s.out, '--allow-incomplete'], { cwd: ROOT, env: r.env, encoding: 'utf8', timeout: 60_000 });
    expect(brief.status, brief.stderr).toBe(0);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter((j: any) => j.event === 'gate_relayed').map((j: any) => [j.gate_rev, j.via])).toEqual([[2, 'gstack-owner-brief render --captain']]);
    const rev = fixed(s);
    expect(rev.stdout).toMatch(/^CARRY: no \(gate_rev 2 was relayed to the owner and not answered\)$/m);
    expect(rev.stdout).not.toMatch(/^CARRY_CHECK:/m);
  });

  // Value: protects=a check dispatched across a gate whose items were never kept (written before this change) cannot
  // carry past a relay recorded meanwhile; fails_when=submit falls back to the answered gate without walking the skipped
  // one; why_new=the across-gates tests always keep the snapshot; seam=none
  test('a passing check across a gate whose items were not kept refuses instead of carrying', () => {
    const s = highAtGate2();
    expect(fixed(s).stdout).toMatch(/^CARRY_CHECK: attempt=\S+-c3 /m);
    fs.rmSync(path.join(s.out, 'gate-at-gate.r2.json'));
    fs.appendFileSync(path.join(s.out, 'attempts.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'gate_relayed', gate_rev: 2, via: 'test' }) + '\n');
    const ok = check(s.out, []);
    expect(ok.stdout).toMatch(/^CARRY: no \(gate_rev 2 was not answered and its items were not kept\)$/m);
    expect(ok.stdout).not.toMatch(/^CARRIED:/m);
    expect(readRunJson(s.out).status).toBe('gate_pending');
  });

  // Value: protects=gstack-gate render journals the relay in the live run and never writes a checkpoint generation's
  // hash-pinned copy; fails_when=the render path drops recordRelay or writes the copy; why_new=only owner-brief was tested
  test('gstack-gate render records the relay in the live run, never in a checkpoint copy', () => {
    const s = highAtGate2();
    const copy = path.join(s.dir, 'ckpt', 'generations', 'g1', 'run');
    fs.cpSync(s.out, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, '..', 'checkpoint.json'), '{}\n');
    const journalBefore = fs.readFileSync(path.join(copy, 'attempts.jsonl'), 'utf8');
    const render = (dir: string) => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-gate'), 'render', path.join(dir, 'gate.json'), '--all'], { cwd: ROOT, env: r.env, encoding: 'utf8', timeout: 60_000 });
    const fromCopy = render(copy);
    expect(fromCopy.status, fromCopy.stderr).toBe(0);
    expect(fs.readFileSync(path.join(copy, 'attempts.jsonl'), 'utf8')).toBe(journalBefore);
    const live = render(s.out);
    expect(live.status, live.stderr).toBe(0);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter((j: any) => j.event === 'gate_relayed').map((j: any) => [j.gate_rev, j.via])).toEqual([[2, 'gstack-gate render']]);
  });

  // Value: protects=Highs still block the cross-gate carry exactly as at one gate; fails_when=the skipped path carries
  // without binding a passing check; why_new=the repro binds a clean check; seam=none
  test('a High in the delta check across gates leaves gate_rev 3 for the owner', () => {
    const s = highAtGate2();
    fixed(s);
    const bad = check(s.out, [{ id: 'F1', severity: 'Critical', title: 'The fix deletes the resume path' }]);
    expect(bad.stdout).toMatch(/^CARRY: no \(delta check found Critical: The fix deletes the resume path\)$/m);
    expect(bad.stdout).not.toMatch(/^CARRIED:/m);
    expect(readRunJson(s.out).status).toBe('gate_pending');
    expect(decisions(s.out).some(d => d.gate_rev === 3 && d.carried_gate_from)).toBe(false);
  });

  // Value: protects=an agent cannot redraw delta checks on one owner answer until one passes (review_loop_grant
  // a-c7c65e1ca065); fails_when=sourceGate skips gates without counting their failed checks; why_new=the tests above
  // fail the check once; seam=none
  test('one failed delta check per owner answer: a second failure sends the next gate to the owner', () => {
    const s = highAtGate2();
    fixed(s);
    const second = check(s.out, [{ id: 'F2', severity: 'High', title: 'The fix still drops the jitter' }]);
    expect(second.stdout).toMatch(/^CARRY: no \(delta check found High: The fix still drops the jitter\)$/m);
    expect(second.stdout).toContain("and it cannot carry the owner's last answer (the delta check against gate_rev 1's answer already failed at gate_rev 2 and 3; one failed check per owner answer, so the owner answers this one), so the owner answers it");
    const v4 = path.join(s.dir, 'plan-v4.md');
    fs.writeFileSync(v4, V3.replace('jitter 10% (kept from the first draft)', 'jitter 10% (kept, and tested)'));
    const rev = r.ap(['revise', '--out', s.out, '--plan', v4]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^GATE: gate_rev=4 /m);
    expect(rev.stdout).toMatch(/^CARRY: no \(the delta check against gate_rev 1's answer already failed at gate_rev 2 and 3; one failed check per owner answer, so the owner answers this one\)$/m);
    expect(rev.stdout).not.toMatch(/^CARRY_CHECK:/m);
    expect(readRunJson(s.out).status).toBe('gate_pending');
  });

  // Value: protects=a fix that widens the plan's scope goes to the owner; fails_when=plan_revised's scope_widened is not
  // recorded or not read; why_new=the delta check is the only other guard and it is a model; seam=none
  test('a fix that puts new scope in the plan refuses the carry', () => {
    const s = highAtGate2();
    const v3 = path.join(s.dir, 'plan-v3.md');
    fs.writeFileSync(v3, V3.replace('Tests cover', 'Add a CLI command and an SDK so operators can replay a job. Tests cover'));
    const rev = r.ap(['revise', '--out', s.out, '--plan', v3]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: .* added=dx/m);
    const dx = phaseVia(r, s.out, 'dx', NONE).outside;
    expect(dx.stdout).toMatch(/^CARRY: no \(revise v2 put dx in scope, beyond the changes the owner accepted at gate_rev 1\)$/m);
    expect(readRunJson(s.out).status).toBe('gate_pending');
  });
});

describe('a revise at the round cap says it opens a new gate', () => {
  // Value: protects=a Captain learns before the revise that it opens a new gate and whether it can carry; fails_when=
  // NEW_GATE is missing from NEXT, the revise, or the failed check; why_new=none of them said it; seam=none
  test('NEXT after the answer, the top of the revise, and a failed delta check each name the new gate and its carry', () => {
    const dir = path.join(r.host.base, `across${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--max-rounds', '1']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    phaseVia(r, out, 'eng', NONE);
    const ans = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', 'Garry: do it']);
    expect(ans.stdout).toMatch(/^NEXT: edit the plan, then gstack-autoplan revise /m);
    const forecast = 'NEW_GATE: ceo,eng used their last round, so a plan edit reopens no reviewer: it goes to gate_rev 2 as an unreviewed delta, and it carries the owner\'s gate_rev 1 answer ("Garry: do it") only if one delta reviewer finds no High or Critical in the edits since then; otherwise the owner answers it';
    expect(ans.stdout.split('\n')).toContain(forecast);
    const v2 = path.join(dir, 'plan-v2.md');
    fs.writeFileSync(v2, V2);
    const rev = r.ap(['revise', '--out', out, '--plan', v2, '--incorporates', 'uc1']);
    expect(rev.stdout.split('\n')[0]).toBe(forecast);
    const bad = check(out, [{ id: 'F1', severity: 'High', title: 'The edit also drops the jitter' }]);
    expect(bad.stdout).toContain('NEXT: relay gate_rev 2 to the owner, or fix the finding and revise without relaying it: the phases are at their round cap, so the revise writes gate_rev 3, and it carries the owner\'s gate_rev 1 answer ("Garry: do it") only if');
  });

  test('when the answer cannot carry, NEXT says the owner answers the new gate', () => {
    const dir = path.join(r.host.base, `across${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui', '--max-rounds', '1', '--no-carry-forward']).status).toBe(0);
    phaseVia(r, out, 'ceo', AGREE);
    phaseVia(r, out, 'eng', NONE);
    const ans = r.ap(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', 'Garry: do it']);
    expect(ans.stdout).toMatch(/^NEW_GATE: ceo,eng used their last round, .* it cannot carry the owner's last answer \(carry-forward is off for this run \(--no-carry-forward\)\), so the owner answers it$/m);
  });
});
