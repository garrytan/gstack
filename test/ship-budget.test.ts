/**
 * /ship token budget (GSTA-152 PR A, plan v3 items 1-2, 4, 9; build-spec r2
 * items 2-7): free, deterministic, with a fake Capy meter passed as --reading.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { admits, loadCalibration, METER_CONTRACTS, newEpoch, parseNext, parseTokens, segmentEstimate, stepProjection, tally, unitConstants, type Ledger } from '../lib/ship-budget';
import { BUDGET_BIN, budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const K = unitConstants(cal, 'capy-tokens');
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

function started(h: Harness, args: string[]) {
  const record = h.record();
  const r = h.sb(['start', '--record', record, ...args]);
  return { record, r, run: r.code === 0 || r.code === 3 ? h.field(r.out, 'BUDGET_RUN', 'id') : '', ledger: r.code === 0 || r.code === 3 ? h.field(r.out, 'BUDGET_RUN', 'ledger') : '' };
}

describe('parsing and the admission rule', () => {
  test('token counts, step ids and roles', () => {
    expect(parseTokens('25M', '--token-cap')).toBe(25_000_000);
    expect(parseTokens('400k', '--reading')).toBe(400_000);
    expect(parseTokens('1.5M', '--reserve')).toBe(1_500_000);
    expect(() => parseTokens('lots', '--token-cap')).toThrow(/not a token count/);
    expect(parseNext('dispatch:specialist,red-team')).toEqual({ kind: 'dispatch', roles: ['specialist', 'red-team'] });
    expect(() => parseNext('7.7')).toThrow(/valid: 0.9, 1, 2/);
    expect(() => parseNext('dispatch:security')).toThrow(/unknown roles \(security\)/);
  });

  test('exactly at the cap is admitted; one token over is not', () => {
    const t = { used: 10, reserved: 5, unknown: 1 };
    expect(admits(t, 4, 0, 20)).toBe(true);
    expect(admits(t, 5, 0, 20)).toBe(false);
    expect(admits(t, 1_000, 0, null)).toBe(true);
  });

  test('CLI boundary: a check exactly at the cap continues, one token over stops (exit 3)', () => {
    const h = fresh();
    for (const [extra, code, verdict] of [[0, 0, 'continue'], [1, 3, 'stop']] as const) {
      const cap = K.per_dispatch + K.stop_overhead - extra;
      const s = started(h, ['--token-cap', String(cap), '--reading', '3000000', '--reserve', '0']);
      expect(s.r.code).toBe(0);
      const c = h.sb(['check', '--run', s.run, '--step', '1', '--next', 'dispatch:specialist', '--reading', '3000000']);
      expect(c.code).toBe(code);
      expect(h.field(c.out, 'BUDGET', 'verdict')).toBe(verdict);
      expect(h.field(c.out, 'BUDGET', 'admission_cap')).toBe(String(cap));
    }
  });
});

describe('reservations', () => {
  test('a parallel batch is reserved as one sum; when it would overshoot only the prefix that fits is admitted', () => {
    const h = fresh();
    const cap = 2 * K.per_dispatch + K.stop_overhead + 1_000_000;
    const s = started(h, ['--token-cap', String(cap), '--reading', '0', '--reserve', '0']);
    const over = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist,red-team,fix-check', '--reading', '0']);
    expect(over.code).toBe(0);
    expect(over.out).toContain('ADMIT: 2 of 3 (remaining=fix-check)');
    expect(h.ledger(s.ledger).reservations.filter((r: any) => r.kind === 'dispatch').map((r: any) => [r.tokens, r.roles])).toEqual([[2 * K.per_dispatch, ['specialist', 'red-team']]]);
  });

  test('#31 replay: a 25M cap stops before the dispatch that would cross it', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '25M', '--reading', '0']);
    let reading = 0;
    let admitted = 0;
    let stop = '';
    for (let i = 0; i < 10; i++) {
      const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', String(reading)]);
      if (c.code === 3) { stop = c.out; break; }
      const id = h.field(c.out, 'RESERVATION', 'id');
      reading += 4_950_000;
      admitted++;
      expect(h.sb(['settle', '--run', s.run, '--reservation', id]).code).toBe(0);
    }
    expect(stop).toContain('STOP: reason=budget_exhausted');
    expect(reading).toBeLessThanOrEqual(25_000_000);
    expect(admitted).toBeLessThan(10);
    expect(stop).toMatch(/^RECOVER: \/ship --resume \S+ --token-cap \d+$/m);
    expect(stop.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=incomplete run=/);
  });

  test('actual spend above its reservation is counted from the meter, and the next admission sees it', () => {
    const h = fresh();
    const cap = 30_000_000;
    const s = started(h, ['--token-cap', String(cap), '--reading', '0', '--reserve', '0']);
    const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '0']);
    const id = h.field(c.out, 'RESERVATION', 'id');
    expect(Number(h.field(c.out, 'RESERVATION', 'tokens'))).toBe(K.per_dispatch);
    const spent = 2 * K.per_dispatch;
    h.sb(['settle', '--run', s.run, '--reservation', id, '--dispatched-at', '0', '--reading', String(spent)]);
    const next = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:red-team', '--reading', String(spent)]);
    expect(Number(h.field(next.out, 'BUDGET', 'used'))).toBe(spent);
    const projected = Number(h.field(next.out, 'BUDGET', 'projected'));
    // The factor (2 x headroom) is bounded by the clean per-reader mean it was learned from (GSTA-167).
    expect(projected).toBe(Math.min(Math.ceil((K.per_dispatch * 2 * cal.headroom) / cal.round_to) * cal.round_to, spent));
    expect(next.code).toBe(spent + projected + K.stop_overhead <= cap ? 0 : 3);
    const later = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:red-team', '--reading', String(cap - K.stop_overhead - K.per_dispatch + 1)]);
    expect(later.code).toBe(3);
  });

  test('without a cap: no marker, no reservation, no GSTACK_RESULT, and usage is still metered', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', 'none', '--reading', '1000']);
    expect(s.r.code).toBe(0);
    expect(s.r.out).not.toContain('RESERVATION');
    expect(s.r.out).not.toContain('GSTACK_RESULT');
    const c = h.sb(['check', '--run', s.run, '--step', '1', '--next', '2', '--reading', '5000']);
    expect(c.code).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'used')).toBe('4000');
    expect(h.field(c.out, 'BUDGET', 'admission_cap')).toBe('none');
    expect(c.out).not.toContain('GSTACK_RESULT');
    const projects = path.join(h.state, 'projects');
    const markers = fs.existsSync(projects) ? fs.readdirSync(projects).flatMap(d => fs.readdirSync(path.join(projects, d))).filter(f => f.endsWith('-ship-budget.json')) : [];
    expect(markers).toEqual([]);
  });
});

describe('meters and exit codes', () => {
  test('a cap with no readable meter refuses; --meter estimate prints meter=estimate', () => {
    const h = fresh();
    const r = h.sb(['start', '--record', h.record(), '--token-cap', '25M']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('(BUDGET_METER_UNAVAILABLE)');
    expect(r.err).toContain('--meter estimate (not passed)');
    const e = h.sb(['start', '--record', h.record(), '--token-cap', '25M', '--meter', 'estimate']);
    expect(e.code).toBe(0);
    expect(h.field(e.out, 'BUDGET', 'meter')).toBe('estimate');
    expect(h.field(e.out, 'BUDGET', 'unit')).toBe('estimate-tokens');
  });

  test('the Capy meter needs a reading under a cap; lower readings and readings to other meters are rejected', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '50M', '--reading', '1000']);
    const missing = h.sb(['check', '--run', s.run, '--step', '1', '--next', '2']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('(BUDGET_READING_MISSING)');
    const lower = h.sb(['check', '--run', s.run, '--step', '1', '--next', '2', '--reading', '999']);
    expect(lower.code).toBe(2);
    expect(lower.err).toContain('(BUDGET_READING_REJECTED)');
    const est = started(h, ['--token-cap', '50M', '--meter', 'estimate']);
    const wrong = h.sb(['check', '--run', est.run, '--step', '1', '--next', '2', '--reading', '5']);
    expect(wrong.err).toContain('(BUDGET_READING_REJECTED)');
  });

  test('a meter change opens a new epoch and keeps prior usage and reservations', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '60M', '--reading', '0']);
    const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '3000000']);
    expect(c.code).toBe(0);
    const r = h.sb(['resume', '--run', s.run, '--meter', 'estimate']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('EPOCH: 2 meter=estimate');
    expect(h.field(r.out, 'BUDGET', 'used')).toBe('3000000');
    expect(Number(h.field(r.out, 'BUDGET', 'reserved'))).toBeGreaterThanOrEqual(K.per_dispatch);
    expect(h.ledger(s.ledger).epochs[0].contract.unit).toBe('capy-tokens');
  });

  test('usage errors exit 2 on stderr with the value and the repair; unknown ids list the valid ones', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '50M', '--reading', '0']);
    const step = h.sb(['check', '--run', s.run, '--step', '7.7', '--next', '8', '--reading', '0']);
    expect(step.code).toBe(2);
    expect(step.out).toBe('');
    expect(step.err).toContain("--step '7.7' is not a ship step id; valid: 0.9, 1, 2, 3");
    const role = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:security', '--reading', '0']);
    expect(role.err).toContain('valid: specialist, red-team, adversarial-native, outside-voice, fix-check');
    expect(h.sb(['check', '--step', '1', '--next', '2']).err).toContain('never found by branch or directory');
    expect(h.sb(['frobnicate']).code).toBe(2);
    expect(h.sb(['start', '--record', h.record(), '--token-cap', 'lots']).err).toContain("--token-cap 'lots' is not a token count");
  });
});

describe('delegation', () => {
  test('start from a long-lived context (100k or more above the host floor) delegates the whole /ship', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '60M', '--reading', '9000000', '--prior-reading', '8740000']);
    expect(h.field(s.r.out, 'BUDGET', 'call')).toBe('260000');
    expect(h.field(s.r.out, 'BUDGET', 'above_floor')).toBe('110000');
    expect(h.field(s.r.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(s.r.out).toContain('--from 1 --to 22');
  });

  test('a segment boundary with an unknown per-call charge delegates; --delegate never stops instead', () => {
    const h = fresh();
    const a = started(h, ['--token-cap', '80M', '--reading', '0']);
    const d = h.sb(['check', '--run', a.run, '--step', '8', '--next', '9', '--reading', '100']);
    expect(d.code).toBe(0);
    expect(h.field(d.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(d.out).not.toContain('RESERVATION');
    const small = h.sb(['check', '--run', a.run, '--step', '8', '--next', '9', '--reading', '1100', '--prior-reading', '1000']);
    expect(h.field(small.out, 'BUDGET', 'verdict')).toBe('continue');
    const n = started(h, ['--token-cap', '80M', '--reading', '0', '--delegate', 'never']);
    const stop = h.sb(['check', '--run', n.run, '--step', '11.5', '--next', '12', '--reading', '100']);
    expect(stop.code).toBe(3);
    expect(stop.out).toContain('STOP: reason=context_threshold');
  });

  test('full chain: delegate, handoff, verify, child checks, 40-line return, idempotent reconcile, close', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '80M', '--reading', '1000000']);
    const d = h.sb(['check', '--run', s.run, '--step', '8', '--next', '9', '--reading', '1200000', '--prior-reading', '800000']);
    expect(h.field(d.out, 'BUDGET', 'verdict')).toBe('delegate');
    const ho = h.sb(['handoff', '--run', s.run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '1300000']);
    expect(ho.code).toBe(0);
    const brief = ho.out.match(/^HANDOFF: (\S+) sha256=([0-9a-f]{64}) sub_cap=(\d+)$/m)!;
    expect(brief).toBeTruthy();
    expect(Number(brief[3])).toBeLessThanOrEqual(segmentEstimate(cal, 'capy-tokens', '7', '11.5'));
    expect((fs.statSync(brief[1]!).mode & 0o777).toString(8)).toBe('600');
    const text = fs.readFileSync(brief[1]!, 'utf8');
    expect(text).toContain('1b4e28ba-2fa1-11d2-883f-0016d3cca427');
    expect(text).toContain('"do it" covers the CHANGELOG wording');
    expect(text).toContain('## Return contract');
    const v = h.sb(['verify-handoff', '--in', brief[1]!, '--reading', '1400000']);
    expect(v.code).toBe(0);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    expect(h.field(v.out, 'BUDGET', 'admission_cap')).toBe(brief[3]);
    expect(h.field(v.out, 'BUDGET', 'used')).toBe('0');
    const cc = h.sb(['check', '--run', child, '--step', '8', '--next', '9', '--reading', '5000000']);
    expect(cc.code).toBe(0);
    const past = h.sb(['check', '--run', child, '--step', '11', '--next', '12', '--reading', '6000000']);
    expect(past.code).toBe(0);
    expect(past.out).toMatch(/^CONTEXT_HIGH: .*Step 12 is past this child's Steps 9-11\.5/m);
    const ret = h.sb(['return', '--run', child, '--to', '11.5', '--changed', 'Reviews,Checks', '--reading', '9000000']);
    expect(ret.code).toBe(0);
    expect(ret.out.trim().split('\n').length).toBeLessThanOrEqual(40);
    expect(ret.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=complete run=/);
    const returnFile = ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!;
    const rec = h.sb(['reconcile', '--run', s.run, '--return', returnFile, '--reading', '9100000']);
    expect(rec.code).toBe(0);
    expect(rec.out).toContain('child=complete child_used=7600000');
    expect(h.field(rec.out, 'BUDGET', 'reserved')).toBe('0');
    const again = h.sb(['reconcile', '--run', s.run, '--return', returnFile, '--reading', '9200000']);
    expect(again.out).toContain('nothing charged twice');
    expect(h.field(again.out, 'BUDGET', 'reserved')).toBe('0');
    const close = h.sb(['close', '--run', s.run, '--reading', '9300000']);
    expect(close.code).toBe(0);
    expect(close.out).toContain('BUDGET_FINAL: used=8300000');
    expect(close.out).not.toContain('GSTACK_RESULT');
  });

  test('pins: HEAD moving refuses with HANDOFF_PIN_MOVED and a tampered brief refuses', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '80M', '--reading', '0']);
    const brief = () => h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '10']).out.match(/^HANDOFF: (\S+)/m)![1]!;
    const second = brief();
    fs.writeFileSync(path.join(h.repo, 'app.ts'), 'export const x = 3;\n');
    h.git('commit', '-qam', 'moved');
    const moved = h.sb(['verify-handoff', '--in', second, '--reading', '30']);
    expect(moved.code).toBe(3);
    expect(moved.out).toMatch(/head expected [0-9a-f]{40} actual [0-9a-f]{40}.*\(HANDOFF_PIN_MOVED\)/);
    expect(moved.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=refused run=/);
    const third = brief();
    fs.appendFileSync(third, '\nextra instruction\n');
    const tampered = h.sb(['verify-handoff', '--in', third, '--reading', '40']);
    expect(tampered.code).toBe(3);
    expect(tampered.out).toMatch(/brief sha256 expected [0-9a-f]{64} actual [0-9a-f]{64}.*\(HANDOFF_PIN_MOVED\)/);
  });

  test('main moving alone keeps the merge base, so the brief still verifies', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '80M', '--reading', '0']);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '10']);
    const file = ho.out.match(/^HANDOFF: (\S+)/m)![1]!;
    const feature = h.git('rev-parse', 'HEAD');
    h.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(h.repo, 'other.ts'), 'export {};\n');
    h.git('add', '-A');
    h.git('commit', '-qm', 'main moves');
    h.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    h.git('checkout', '-q', 'feature');
    expect(h.git('rev-parse', 'HEAD')).toBe(feature);
    expect(h.sb(['verify-handoff', '--in', file, '--reading', '20']).code).toBe(0);
  });

  test('a refused child and an interrupted child both stop the parent; their reservations settle once', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '80M', '--reading', '0']);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '10']);
    const file = ho.out.match(/^HANDOFF: (\S+)/m)![1]!;
    const returnFile = ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!;
    fs.writeFileSync(path.join(h.repo, 'app.ts'), 'export const x = 9;\n');
    expect(h.sb(['verify-handoff', '--in', file, '--reading', '20']).code).toBe(3);
    const refused = h.sb(['reconcile', '--run', s.run, '--return', returnFile, '--reading', '30']);
    expect(refused.code).toBe(3);
    expect(refused.out).toContain('child=refused');
    expect(refused.out).toContain('NEXT: the child returned refused; regenerate the handoff');
    const ho2 = h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '40']);
    const sha = ho2.out.match(/sha256=([0-9a-f]{64})/)![1]!;
    const interrupted = h.sb(['reconcile', '--run', s.run, '--handoff', sha, '--reading', '5000040']);
    expect(interrupted.code).toBe(3);
    expect(interrupted.out).toContain('child=interrupted child_used=5000000');
    expect(h.ledger(s.ledger).reservations.filter((r: any) => r.kind === 'child').map((r: any) => r.state)).toEqual(['settled', 'settled']);
    expect(Number(h.field(interrupted.out, 'BUDGET', 'reserved'))).toBe(stepProjection(cal, 'capy-tokens', '1'));
  });
});

describe('Claude Code child launch', () => {
  test('launch runs the child in the background with explicit permission flags and the return file named', async () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '80M', '--meter', 'estimate']);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main']);
    const file = ho.out.match(/^HANDOFF: (\S+)/m)![1]!;
    const argsFile = path.join(h.root, 'claude-args.txt');
    const fake = path.join(h.root, 'fake-claude');
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
    const r = h.sb(['launch', '--in', file], { GSTACK_CLAUDE_BIN: fake });
    expect(r.code).toBe(0);
    const session = h.field(r.out, 'CHILD', 'session');
    expect(h.field(r.out, 'CHILD', 'return')).toBe(ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!);
    for (let i = 0; i < 50 && !fs.existsSync(argsFile); i++) await Bun.sleep(100);
    const args = fs.readFileSync(argsFile, 'utf8').split('\n');
    expect(args.slice(0, 7)).toEqual(['-p', '--session-id', session, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Grep,Glob']);
    expect(args[7]).toContain(`verify-handoff --in ${file} --session ${session}`);
  });
});

describe('stop, resume and recovery', () => {
  test('stop prints a RECOVER line; executing it needs the owner\'s words and then the run continues', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '20M', '--reading', '0']);
    const stop = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9000000']);
    expect(stop.code).toBe(3);
    const recover = stop.out.match(/^RECOVER: \/ship --resume (\S+) --token-cap (\d+)$/m)!;
    expect(recover[1]).toBe(s.record);
    expect(h.sb(['check', '--run', s.run, '--step', '9', '--next', '10', '--reading', '9000000']).code).toBe(3);
    const noWords = h.sb(['resume', '--record', recover[1]!, '--token-cap', recover[2]!, '--reading', '9100000']);
    expect(noWords.code).toBe(2);
    expect(noWords.err).toContain('--approved-by');
    const ok = h.sb(['resume', '--record', recover[1]!, '--token-cap', recover[2]!, '--approved-by', 'Garry', '--words', 'raise it to finish', '--reading', '9100000']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('RESUMED: from=Step 9 (budget_exhausted)');
    const go = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9200000']);
    expect(go.code).toBe(0);
    expect(h.ledger(s.ledger).cap_raises[0]).toMatchObject({ from: 20_000_000, to: Number(recover[2]), by: 'Garry', words: 'raise it to finish' });
  });

  test('a machine change: the ledger and record come back from the checkpoint into an empty state root', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '60M', '--reading', '0']);
    const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '2000000']);
    expect(c.code).toBe(0);
    fs.rmSync(h.state, { recursive: true, force: true });
    fs.rmSync(path.dirname(s.record), { recursive: true, force: true });
    const r = h.sb(['resume', '--run', s.run, '--reading', '2500000']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`RESTORED: ledger=${s.ledger} record=${s.record}`);
    expect(h.field(r.out, 'BUDGET', 'used')).toBe('2500000');
    expect(Number(h.field(r.out, 'BUDGET', 'reserved'))).toBe(K.per_dispatch);
    expect(fs.readFileSync(s.record, 'utf8')).toContain('```gstack-budget');
  });

  test('a corrupt ledger refuses with path, schema and parse location; --rebuild-from-record charges open reservations as unknown', () => {
    const h = fresh();
    const s = started(h, ['--token-cap', '60M', '--reading', '0']);
    h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '1000000']);
    fs.writeFileSync(s.ledger, '{"kind": "gstack-ship-budget", oops');
    const bad = h.sb(['resume', '--record', s.record, '--reading', '1500000']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain(s.ledger);
    expect(bad.err).toMatch(/schema_version unknown, parse error: .*\(BUDGET_LEDGER_INVALID\)/);
    const rebuilt = h.sb(['resume', '--record', s.record, '--rebuild-from-record', '--reading', '1500000']);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.out).toContain('REBUILT:');
    expect(h.field(rebuilt.out, 'BUDGET', 'used')).toBe('1000000');
    expect(Number(h.field(rebuilt.out, 'BUDGET', 'unknown'))).toBeGreaterThanOrEqual(K.per_dispatch);
  });
});

describe('isolation', () => {
  test('two ledgers run concurrently, and contention on one ledger never over-admits', async () => {
    const h = fresh();
    const a = started(h, ['--token-cap', '60M', '--reading', '0', '--reserve', '0']);
    const b = started(h, ['--token-cap', '60M', '--reading', '0', '--reserve', '0']);
    expect(a.ledger).not.toBe(b.ledger);
    const cap = 2 * K.per_dispatch + K.stop_overhead + stepProjection(cal, 'capy-tokens', '1');
    const tight = started(h, ['--token-cap', String(cap), '--reading', '0', '--reserve', '0']);
    const spawn = (run: string) => Bun.spawn([BUDGET_BIN, 'check', '--run', run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '0'], { cwd: h.repo, env: h.env, stdout: 'pipe', stderr: 'pipe' });
    const procs = [...Array.from({ length: 6 }, () => spawn(tight.run)), spawn(a.run), spawn(b.run)];
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes.slice(0, 6).filter(c => c === 0)).toHaveLength(2);
    expect(codes.slice(6)).toEqual([0, 0]);
    for (const file of [a.ledger, b.ledger]) expect(h.ledger(file).reservations.filter((r: any) => r.kind === 'dispatch')).toHaveLength(1);
  });

  test('budget state lives outside the checkout: gstack-wtree and git status are unchanged across checks', () => {
    const h = fresh();
    const wtree = () => spawnSync('bash', [path.join(import.meta.dir, '..', 'bin', 'gstack-wtree')], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    const before = wtree();
    const s = started(h, ['--token-cap', '60M', '--reading', '0']);
    h.sb(['check', '--run', s.run, '--step', '1', '--next', '2', '--reading', '10']);
    h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '20']);
    expect(wtree()).toBe(before);
    expect(h.git('status', '--porcelain')).toBe('');
    expect(s.ledger.startsWith(path.join(h.state, 'ship-runs'))).toBe(true);
    expect((fs.statSync(s.ledger).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('meter epochs', () => {
  test('estimate spend survives a change of meter (estimate -> capy -> estimate)', () => {
    const l = { meter: { contract: METER_CONTRACTS.estimate, epoch: 0, baseline: 0, last: 0 }, epochs: [], carried_used: 0, estimate_used: 20_000_000, unknown: 0, reservations: [] } as unknown as Ledger;
    expect(tally(l).used).toBe(20_000_000);
    newEpoch(l, METER_CONTRACTS.capy, 100_000_000);
    expect(tally(l).used).toBe(20_000_000);
    l.meter.last = 103_000_000;
    newEpoch(l, METER_CONTRACTS.estimate, 0);
    expect(tally(l).used).toBe(23_000_000);
    l.estimate_used = 1_000_000;
    expect(tally(l).used).toBe(24_000_000);
  });
});
