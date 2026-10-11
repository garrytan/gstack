/**
 * bin/gstack-autoplan recovery (plan B2): a runner killed before result
 * persistence leaves a dispatch intent that `resume` reconciles as
 * EXECUTION_UNKNOWN (reservation kept, no automatic redispatch, a late submit
 * still binds); one killed after persistence is rebound from the journal with
 * no second charge; the next/submit loop binds each result exactly once and
 * refuses a wrong receipt, a missing findings fence, a same-family outside
 * model and a stale attempt; the whole wave plan runs through the loop with a
 * fixture reviewer and validates. Pins tokens, codes and exit codes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTOPLAN, ROOT, WAVE_PLAN, attemptsOf, autoplan, env, journal, readRun, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-recovery-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ARTIFACT = path.join(ROOT, 'bin', 'gstack-artifact');
const validate = (out: string) => spawnSync('bun', [ARTIFACT, 'validate', path.join(out, 'run.json'), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

describe('next/submit loop', () => {
  test('next prepares both voices with one attempt each and ends awaiting_result; a second next re-prints the open attempts without new ids', () => {
    const out = startSmallRun(path.join(TMP, 'loop'), ['--spend-cap', '2', '--estimate-usd', '0.5']);
    const run = readRun(out);
    expect(run.status).toBe('awaiting_result');
    expect(run.phase_order).toEqual(['ceo', 'eng']);
    expect(run.phases.design.skipped).toBeTruthy();
    expect(run.phases.dx.skipped).toBeTruthy();
    expect(run.phases.ceo.native.status).toBe('running');
    expect(fs.existsSync(path.join(out, 'ceo-native-prompt.md'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'ceo-outside-prompt.md'), 'utf8')).toContain('IMPORTANT: Do NOT read or execute any SKILL.md');
    const again = autoplan(['next', '--out', out]);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/ATTEMPT: \S+-a1 phase=ceo voice=native .*\(open\)/);
    expect(again.stdout).toMatch(/ATTEMPT: \S+-a2 phase=ceo voice=outside .*\(open\)/);
    expect(again.stdout).toContain('GSTACK_RESULT: skill=autoplan status=awaiting_result run=' + out);
    expect(readRun(out).attempt_counter).toBe(2);
    const spend = JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
    expect(spend.reserved.map((r: any) => r.estimate_usd)).toEqual([0.5, 0.5]);
  });

  test('submit refuses a wrong receipt, a missing fence, a same-family outside model, a stale attempt, and writes nothing on refusal', () => {
    const out = startSmallRun(path.join(TMP, 'refuse'));
    const ids = attemptsOf(out, 'ceo');
    const before = fs.readFileSync(path.join(out, 'run.json'), 'utf8');
    review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_BREAK: 'receipt' });
    let r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\(RESULT_RECEIPT_MISSING\)$/m);
    review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_BREAK: 'fence' });
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\(RESULT_FINDINGS_MISSING\)$/m);
    review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_BREAK: 'row' });
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\(RESULT_FINDINGS_MISSING\)$/m);
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', 'nope-a9']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/\(ATTEMPT_MISMATCH\)$/m);
    r = autoplan(['submit', '--out', out, '--phase', 'dx', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/\(PHASE_NOT_AWAITING\)$/m);
    expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before);
    expect(journal(out).filter(j => j.event === 'submitted')).toEqual([]);
    // a good native, then an outside model from the same family
    review(path.join(out, 'ceo-native-prompt.md'));
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^BOUND: \S+ phase=ceo voice=native model=claude-opus-4-7 findings=3/m);
    review(path.join(out, 'ceo-outside-prompt.md'));
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', path.join(out, 'ceo-outside.md'), '--model', 'claude-sonnet-5', '--attempt', ids.outside]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/both anthropic.*\(MODEL_FAMILY_CONFLICT\)$/m);
    // exactly once: the bound native attempt cannot be submitted again
    r = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/\(PHASE_NOT_AWAITING\)$/m);
  });

  test('a phase closes when both voices are bound: consensus from canonical ids, Eng prompt carries the prior consensus, the gate ends gate_pending and validates', () => {
    const out = startSmallRun(path.join(TMP, 'full'));
    const ceo = runPhase(out, 'ceo');
    expect(ceo.native.status, ceo.native.stderr).toBe(0);
    expect(ceo.outside.status, ceo.outside.stderr).toBe(0);
    expect(ceo.outside.stdout).toMatch(/^PHASE_CLOSED: ceo confirmed=2 disagree=0 new=1 native_only=1 coverage=both$/m);
    expect(ceo.outside.stdout).toContain('GSTACK_RESULT: skill=autoplan status=running run=');
    const consensus = JSON.parse(fs.readFileSync(path.join(out, 'ceo-consensus.json'), 'utf8'));
    const run = readRun(out).run;
    expect(consensus.rows.map((r: any) => [r.outside_id, r.native_id, r.disposition, r.basis])).toEqual([
      [`${run}-ceo-outside-1`, `${run}-ceo-native-1`, 'confirmed', 'file_line'],
      [`${run}-ceo-outside-2`, null, 'new', 'none'],
      [`${run}-ceo-outside-3`, `${run}-ceo-native-3`, 'confirmed', 'title'],
    ]);
    expect(consensus.native_only_ids).toEqual([`${run}-ceo-native-2`]);
    const eng = runPhase(out, 'eng');
    expect(fs.readFileSync(path.join(out, 'eng-native-prompt.md'), 'utf8')).toContain('PRIOR-PHASE CONSENSUS');
    expect(fs.readFileSync(path.join(out, 'eng-native-prompt.md'), 'utf8')).toContain('CEO DUAL VOICES — CONSENSUS TABLE');
    expect(eng.outside.stdout).toContain('GSTACK_RESULT: skill=autoplan status=gate_pending run=' + out);
    const v = validate(out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ valid: true, status: 'gate_pending' });
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
    expect(gate.items.map((i: any) => i.id)).toEqual(['uc1', 'uc2', 'p1']);
    const decisions = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(decisions.every((d: any) => d.status === 'pending' && d.gate_rev === 1)).toBe(true);
    const tasks = fs.readFileSync(path.join(out, 'tasks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(tasks.length).toBe(4);
    expect(tasks[0]).toMatchObject({ schema_version: 2, status: 'blocked_on_decision', blocked_by: [`${run}-p1`], findings: [`${run}-ceo-native-1`, `${run}-ceo-outside-1`] });
    expect(fs.readFileSync(path.join(out, 'review-record.md'), 'utf8')).toContain('GUARD_NOT_INSTALLED');
    expect(fs.readFileSync(path.join(out, 'plan.md'), 'utf8').startsWith('## URGENT, outside this plan')).toBe(true);
    // a missing prior consensus refuses the Eng dispatch
    const broken = startSmallRun(path.join(TMP, 'no-consensus'));
    runPhase(broken, 'ceo');
    fs.unlinkSync(path.join(broken, 'ceo-consensus.md'));
    const refused = autoplan(['next', '--out', broken]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/\(CONSENSUS_MISSING\)$/m);
    expect(fs.existsSync(path.join(broken, 'eng-native-prompt.md'))).toBe(false);
  });
});

describe('recovery', () => {
  test('killed after dispatch intent, before any result: resume marks EXECUTION_UNKNOWN, keeps the reservation, never redispatches on its own, and a late submit still binds', () => {
    const out = startSmallRun(path.join(TMP, 'kill-before'), ['--spend-cap', '5', '--estimate-usd', '1']);
    const ids = attemptsOf(out, 'ceo');
    // the dispatch intent is persisted; the runner "dies" here (no submit ever arrives)
    expect(journal(out).filter(j => j.event === 'dispatched').map(j => j.attempt)).toEqual([ids.native, ids.outside]);
    const resumed = autoplan(['resume', '--out', out]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain(`EXECUTION_UNKNOWN: ${ids.native}`);
    expect(resumed.stdout).toContain(`EXECUTION_UNKNOWN: ${ids.outside}`);
    const spend = JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
    expect(spend.reserved.map((r: any) => r.attempt)).toEqual([ids.native, ids.outside]);
    const next = autoplan(['next', '--out', out]);
    expect(next.status).toBe(3);
    expect(next.stderr).toMatch(/\(EXECUTION_UNKNOWN\)$/m);
    expect(readRun(out).attempt_counter).toBe(2);
    // the provider had finished after all: the late result binds under the same attempt id
    review(path.join(out, 'ceo-native-prompt.md'));
    const late = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(late.status, late.stderr).toBe(0);
    // the outside attempt is redispatched only when named explicitly; its charge stays as unknown, never zero
    const redo = autoplan(['next', '--out', out, '--redispatch', ids.outside, '--estimate-usd', '1']);
    expect(redo.status, redo.stderr).toBe(0);
    expect(redo.stdout).toMatch(/ATTEMPT: \S+-a3 phase=ceo voice=outside/);
    const after = JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
    expect(after.settled.find((s: any) => s.attempt === ids.outside)).toMatchObject({ usd: 'unknown', reserved_usd: 1 });
    expect(after.reserved.map((r: any) => r.attempt)).toEqual([`${readRun(out).run}-a3`]);
    expect(journal(out).filter(j => j.event === 'superseded').map(j => j.attempt)).toEqual([ids.outside]);
  });

  test('killed after the journal recorded the submit but before run.json: resume rebinds from the journal with no second charge', () => {
    const out = startSmallRun(path.join(TMP, 'kill-after'), ['--estimate-usd', '1']);
    const ids = attemptsOf(out, 'ceo');
    review(path.join(out, 'ceo-native-prompt.md'));
    const snapshotBefore = fs.readFileSync(path.join(out, 'run.json'), 'utf8');
    const ok = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]);
    expect(ok.status, ok.stderr).toBe(0);
    // simulate the crash: the journal and the ledger have the submit, run.json does not
    fs.writeFileSync(path.join(out, 'run.json'), snapshotBefore);
    expect(readRun(out).phases.ceo.native.status).toBe('running');
    const resumed = autoplan(['resume', '--out', out, '--json']);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ rebound: [ids.native], execution_unknown: [ids.outside] });
    const run = readRun(out);
    expect(run.phases.ceo.native).toMatchObject({ status: 'completed', model: 'claude-opus-4-7', attempt: ids.native, findings: 3 });
    expect(run.native_model).toBe('claude-opus-4-7');
    const spend = JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
    expect(spend.settled.filter((s: any) => s.attempt === ids.native)).toHaveLength(1);
    expect(spend.reserved.map((r: any) => r.attempt)).toEqual([ids.outside]);
  });

  test('a runner process killed mid-command leaves no lock behind that a later command cannot reclaim; a live owner is never stolen', () => {
    const out = startSmallRun(path.join(TMP, 'lock'));
    fs.writeFileSync(path.join(out, 'run.lock'), JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date().toISOString() }));
    const status = autoplan(['next', '--out', out]);
    expect(status.status, status.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, 'run.lock'))).toBe(false);
    fs.writeFileSync(path.join(out, 'run.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
    const locked = autoplan(['next', '--out', out]);
    expect(locked.status).toBe(3);
    expect(locked.stderr).toMatch(/\(RUN_LOCKED\)$/m);
    fs.unlinkSync(path.join(out, 'run.lock'));
  });

  test('the spend cap refuses a dispatch that would cross it, with nothing journaled', () => {
    const out = startSmallRun(path.join(TMP, 'cap'), ['--spend-cap', '1', '--estimate-usd', '0.4']);
    runPhase(out, 'ceo');
    const next = autoplan(['next', '--out', out, '--estimate-usd', '0.6']);
    expect(next.status).toBe(3);
    expect(next.stderr).toMatch(/\(SPEND_CAP_EXCEEDED\)$/m);
    expect(journal(out).filter(j => j.event === 'dispatched' && j.phase === 'eng')).toEqual([]);
    expect(readRun(out).attempt_counter).toBe(2);
  });
});

describe('the wave plan through the loop', () => {
  test('docs/designs/MULTI_AGENT_WAVE_2026_10_10.md runs ceo → dx → eng with the fixture reviewer and validates', () => {
    const dir = path.join(TMP, 'wave');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'run');
    const first = autoplan(['next', '--out', out, '--plan', WAVE_PLAN, '--no-ui', '--developer-tool', '--agent-primary']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^PHASE: ceo snapshot=[0-9a-f]{64} order=ceo,dx,eng$/m);
    for (const phase of ['ceo', 'dx', 'eng']) {
      const r = runPhase(out, phase);
      expect(r.native.status, r.native.stderr).toBe(0);
      expect(r.outside.status, r.outside.stderr).toBe(0);
    }
    const run = readRun(out);
    expect(run.status).toBe('gate_pending');
    const v = validate(out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    const warn = spawnSync('bun', [AUTOPLAN, 'export', '--out', out], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 60_000 });
    expect(warn.stderr).toContain('plan.md is');
    expect(fs.readFileSync(path.join(out, 'plan.md'), 'utf8')).toContain('## Implementation plan');
    const pending = spawnSync('jq', ['-c', 'select(.status=="pending") | .id', path.join(out, 'decisions.jsonl')], { encoding: 'utf8', timeout: 30_000 });
    if (pending.status === 0) expect(pending.stdout.trim().split('\n').length).toBe(run.counts.decisions_pending);
  }, 180_000);
});
