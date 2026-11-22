/**
 * GST-3260 PR 1: the /ship run record replaces the bare run marker. A run is open until a gstack command ends it (finish,
 * stop, gstack-skill-end, or gstack-ship-run abandon), never because a lease line aged out or another run's touch pruned
 * it (probe 002). A stopped run records only the fix-check grant for its own stop; a bare marker reads as legacy and an
 * unreadable record fails closed, and both are ended with one recorded abandon. Also: a stop binds to the head its
 * stopping row read (#4591), and the round history counts a reused run id once per head (gstack-evals#406).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { placeRunEntry, prReviewHistory, runStub, stopFrom } from '../lib/pr-review-history';
import { receiptRuns } from '../lib/ship-receipt';
import { lineOf, PREFLIGHT, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(PREFLIGHT);
const CHECKOUT = { GSTACK_LEASE_DIR: '', GSTACK_APPROVALS_MIRROR: '0' };
const CAPTAIN = 'Captain GStack Minder (GSTA-36)';
const fixtures: ShipFx[] = [];
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const recordFile = (f: ShipFx) => path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
const record = (f: ShipFx) => { const t = fs.readFileSync(recordFile(f), 'utf8'); return t.trim().startsWith('{') ? JSON.parse(t) : { legacy: t.trim() }; };
/** Moves the record's clock back, as if the run started and last beat `minutes` ago. */
const age = (f: ShipFx, minutes: number) => {
  const t = fs.readFileSync(recordFile(f), 'utf8');
  if (!t.trim().startsWith('{')) return;
  const back = (iso: string) => new Date(Date.parse(iso) - minutes * 60_000).toISOString();
  const r = JSON.parse(t);
  fs.writeFileSync(recordFile(f), JSON.stringify({ ...r, started_at: back(r.started_at), beat_at: back(r.beat_at) }) + '\n');
};
const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, CHECKOUT);
const preflight = (f: ShipFx, id?: string) => f.run(PREFLIGHT, ['--base', 'main', ...(id ? ['--run', id] : [])], CHECKOUT);
const head = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const grant = (f: ShipFx, kind: 'extra-round' | 'fix-check', extra: string[] = [], at = head(f)) =>
  run(f, 'gstack-approvals', ['round-grant', '--pr', '7', '--head', at, '--kind', kind, ...(kind === 'fix-check' && !extra.includes('--stop-run') ? ['--stop-run', 'ro', '--findings', 'p1/outside-voice#1'] : []), ...extra, '--reason', 'fixable blocker', '--by', CAPTAIN]);
/** A review row that stopped on one open blocker, logged through gstack-review-log on the committed tree. */
const logStoppingReview = (f: ShipFx) => {
  const start = run(f, 'gstack-review-log', ['--start', 'review']);
  expect(start.status, start.stderr).toBe(0);
  const logged = run(f, 'gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', pass: 1, review_scope: 'frozen', completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [{ fingerprint: 'src/x.ts:1:outside-voice', severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: 'p1/outside-voice#1', raised_by: 'outside-voice' }] }), '--finish', start.stdout.trim()]);
  expect(logged.status, logged.stderr).toBe(0);
};

describe('a /ship run stays open until a gstack command ends it (GST-3260)', () => {
  // Value: protects=probe 002, a live run whose lease line another run's touch pruned after 120 minutes still blocks a full
  //   preflight; fails_when=preflight reads gstack-lease open and merges the base under a live run's readers; seam=the run record
  test('probe 002: a live run past 120 minutes, after another run\'s lease touch, still reads open', () => {
    const f = fx();
    expect(preflight(f, 'r1').status).toBe(0);
    const lease = path.join(f.work, '.git', 'gstack-leases', String(process.pid));
    fs.writeFileSync(lease, fs.readFileSync(lease, 'utf8').replace(/^(run r1 )(\d+)$/m, (_, p, t) => `${p}${Number(t) - 10800}`));
    const touch = f.run(path.join(BIN, 'gstack-lease'), ['touch', '--root', f.work, '--pid', String(process.pid), '--run', 'r2'], CHECKOUT);
    expect(touch.status, touch.stderr).toBe(0);
    expect(fs.readFileSync(lease, 'utf8')).not.toMatch(/^run r1 /m);
    age(f, 180);
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const again = preflight(f, 'r3');
    expect(again.status).toBe(3);
    expect(again.stdout).toContain('STOP: /ship run r1 is open on this checkout and past its preflight (');
    expect(again.stdout).toContain('state open, beat_age 180m');
    expect(again.stdout).not.toContain('MERGE:');
    expect(run(f, 'gstack-ship-run', ['status']).stdout).toMatch(/^RUN_STATE: run=r1 state=open beat_age=180m /m);
  });

  // Value: protects=a bare marker an older gstack left (a run that died) refuses grants with its state and the way out, and one
  //   recorded abandon ends it, with a mark in the PR body; fails_when=the refusal says nothing about how to end the run, or
  //   only rm clears it; seam=gstack-approvals round-grant, gstack-ship-run abandon, gstack-ship-receipt abandoned
  test('a stale bare marker reads legacy: grants refuse with the abandon command, and abandon ends it at any age', () => {
    const f = fx();
    fs.writeFileSync(recordFile(f), 'ship-stale-1\n');
    const refused = grant(f, 'extra-round');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('/ship run ship-stale-1 is open on this checkout (state legacy, beat_age unknown;');
    expect(refused.stderr).toContain('gstack-ship-run abandon --run ship-stale-1 --by <lane or Captain> --reason "<one line>"');
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, 'Fixes a thing.\n');
    const end = run(f, 'gstack-ship-run', ['abandon', '--run', 'ship-stale-1', '--by', CAPTAIN, '--reason', 'the run died before finish', '--body', body]);
    expect(end.status, end.stderr).toBe(0);
    expect(end.stdout).toContain('RUN_ABANDONED: run=ship-stale-1 from=legacy by=Captain GStack Minder (GSTA-36)');
    expect(record(f)).toMatchObject({ v: 1, run: 'ship-stale-1', state: 'abandoned', ended_by: CAPTAIN, reason: 'the run died before finish' });
    expect(receiptRuns(fs.readFileSync(body, 'utf8'))).toEqual([expect.objectContaining({ mark: 'abandoned', run: 'ship-stale-1', by: CAPTAIN, reason: 'the run died before finish' })]);
    expect(prReviewHistory(fs.readFileSync(body, 'utf8')).rounds).toBe(0);
    const ok = grant(f, 'extra-round');
    expect(ok.status, ok.stderr).toBe(0);
    const again = run(f, 'gstack-ship-run', ['abandon', '--run', 'ship-stale-1', '--by', CAPTAIN, '--reason', 'twice']);
    expect(again.status).toBe(3);
    expect(again.stderr).toContain('(SHIP_RUN_ABANDON_REFUSED;');
  });

  // Value: protects=decision C, a stopped run records the fix-check grant its stop's NEXT line names and nothing else; fails_when=
  //   the stopped run refuses its own grant (the bare marker reads open) or grants itself an extra round; seam=gstack-ship-receipt
  //   stop, gstack-approvals round-grant
  test('a stopped record allows its own stop\'s fix-check grant and refuses an extra round', () => {
    const f = fx({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    expect(preflight(f, 'ro').status).toBe(0);
    const s = head(f);
    logStoppingReview(f);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, 'Fixes a thing.\n');
    const stop = run(f, 'gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']);
    expect(stop.status, stop.stderr).toBe(0);
    expect(record(f)).toMatchObject({ run: 'ro', state: 'stopped', stop: { head: s, tree: f.git('rev-parse', 'HEAD^{tree}').stdout.trim() } });
    const extra = grant(f, 'extra-round');
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain('/ship run ro is open on this checkout (state stopped, beat_age 0m;');
    expect(extra.stderr).toContain(`a stopped run records only the fix-check grant for its own stop (--kind fix-check --stop-run ro --head ${s})`);
    expect(grant(f, 'fix-check', ['--stop-run', 'other', '--findings', 'p1/outside-voice#1']).status).toBe(2);
    expect(grant(f, 'fix-check', [], f.git('rev-parse', 'HEAD~1').stdout.trim()).status).toBe(2);
    const own = grant(f, 'fix-check');
    expect(own.status, own.stderr).toBe(0);
  });

  // Value: protects=the own-stop exemption buys one fix round per run: once the run claimed it, a later stop needs the lane's
  //   relayed grant; fails_when=a run loops stop, self-grant, claim past R51's cap; seam=gstack-approvals round-grant, run record claim
  test('a stopped run grants itself one fix round: after its claim, another stop needs a relayed grant', () => {
    const f = fx({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    expect(preflight(f, 'ro').status).toBe(0);
    const s = head(f);
    logStoppingReview(f);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, 'Fixes a thing.\n');
    expect(run(f, 'gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']).status).toBe(0);
    const g = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(grant(f, 'fix-check').stdout)?.[1];
    expect(g).toBeDefined();
    expect(run(f, 'gstack-ship-receipt', ['claim', '--body', body, '--run', 'ro', '--grant', g!]).status).toBe(0);
    fs.writeFileSync(recordFile(f), JSON.stringify({ ...record(f), state: 'stopped' }) + '\n');
    const again = grant(f, 'fix-check', [], s);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("this run already spent its own stop's fix-check grant (" + g + ')');
  });

  // Value: protects=a stopped record of another run is replaced by a new --run, while a preflight with no --run stops on it;
  //   fails_when=a bare preflight merges the base under the stopped run's stop head; seam=lib/ship-preflight.ts shipRunClear
  test('a stopped record of another run: a new --run replaces it, a preflight with no --run stops', () => {
    const f = fx();
    expect(preflight(f, 'ro').status).toBe(0);
    const s = head(f);
    fs.writeFileSync(recordFile(f), JSON.stringify({ ...record(f), state: 'stopped', stop: { head: s, tree: f.git('rev-parse', 'HEAD^{tree}').stdout.trim() } }) + '\n');
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const bare = preflight(f);
    expect(bare.status).toBe(3);
    expect(bare.stdout).toContain('STOP: /ship run ro is open on this checkout and past its preflight (');
    expect(bare.stdout).not.toContain('MERGE:');
    const next = preflight(f, 'r2');
    expect(next.status, next.stdout).toBe(0);
    expect(lineOf(next.stdout, 'MERGE')).toMatch(/^MERGE: merged origin\/main at /);
    expect(record(f)).toMatchObject({ run: 'r2', state: 'open' });
  });

  // Value: protects=stop and claim upgrade a bare marker that names their run, and claim writes the grant it spends into the record;
  //   fails_when=a legacy marker stays bare after stop, or the claim lives only in the PR body; seam=gstack-ship-receipt stop/claim
  test('stop and claim upgrade a legacy marker naming their run; claim records the grant and reopens the run', () => {
    const f = fx({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    const s = head(f);
    fs.writeFileSync(recordFile(f), 'ro\n');
    logStoppingReview(f);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, 'Fixes a thing.\n');
    expect(run(f, 'gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']).status).toBe(0);
    expect(record(f)).toMatchObject({ v: 1, run: 'ro', state: 'stopped', stop: { head: s } });
    const g = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(grant(f, 'fix-check').stdout)?.[1];
    expect(g).toBeDefined();
    const claim = run(f, 'gstack-ship-receipt', ['claim', '--body', body, '--run', 'ro', '--grant', g!]);
    expect(claim.status, claim.stderr).toBe(0);
    expect(record(f)).toMatchObject({ run: 'ro', state: 'open', stop: { head: s }, claim: { grant: g, stop_run: 'ro', stop_head: s, findings: ['p1/outside-voice#1'] } });
  });

  // Value: protects=an unreadable record fails closed (preflight and grants refuse) and one abandon naming its digest ends it;
  //   fails_when=a corrupt record reads as no run; seam=lib/ship-run-record.ts readRunRecord, gstack-ship-run
  test('an unreadable record stops preflight and grants; abandon --run unknown takes only its digest', () => {
    const f = fx();
    fs.writeFileSync(recordFile(f), '{"v":1,"run":\n');
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const pre = preflight(f, 'r2');
    expect(pre.status).toBe(3);
    expect(pre.stdout).toContain('STOP: /ship run unknown is open on this checkout and past its preflight (');
    expect(pre.stdout).toContain('state unreadable');
    expect(grant(f, 'extra-round').stderr).toContain('state unreadable');
    const status = run(f, 'gstack-ship-run', ['status']);
    expect(status.status).toBe(1);
    expect(status.stderr).toContain('(SHIP_RUN_RECORD_UNREADABLE;');
    const sha = /sha256=([0-9a-f]{64})/.exec(status.stdout)?.[1];
    expect(sha).toBeDefined();
    const end = (digest: string) => run(f, 'gstack-ship-run', ['abandon', '--run', 'unknown', '--sha256', digest, '--by', CAPTAIN, '--reason', 'corrupt record']);
    expect(end('0'.repeat(64)).status).toBe(3);
    expect(end(sha!).status).toBe(0);
    const next = preflight(f, 'r2');
    expect(next.status, next.stdout).toBe(0);
    expect(lineOf(next.stdout, 'MERGE')).toMatch(/^MERGE: merged origin\/main at /);
    expect(record(f)).toMatchObject({ run: 'r2', state: 'open' });
  });

  // Value: protects=abandon refuses a run that beat in the last 60 minutes and gstack's own names, and a review-log beat counts;
  //   fails_when=a working run can be abandoned by mistake; seam=gstack-ship-run abandon, gstack-review-log --start
  test('abandon refuses under 60 minutes and as gstack; a review start beats the run', () => {
    const f = fx();
    expect(preflight(f, 'r1').status).toBe(0);
    const end = (by = CAPTAIN) => run(f, 'gstack-ship-run', ['abandon', '--run', 'r1', '--by', by, '--reason', 'stopped answering']);
    const young = end();
    expect(young.status).toBe(3);
    expect(young.stderr).toContain('(SHIP_RUN_ABANDON_REFUSED;');
    expect(young.stderr).toMatch(/beat_age 0m; the earliest abandon is \d{4}-\d\d-\d\dT/);
    age(f, 61);
    expect(end('gstack').status).toBe(2);
    expect(run(f, 'gstack-ship-run', ['abandon', '--run', 'r9', '--by', CAPTAIN, '--reason', 'x']).status).toBe(3);
    const start = run(f, 'gstack-review-log', ['--start', 'review']);
    expect(start.status, start.stderr).toBe(0);
    expect(Date.now() - Date.parse(record(f).beat_at)).toBeLessThan(60_000);
    expect(end().status).toBe(3);
    age(f, 61);
    const ok = end();
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('RUN_ABANDON_PR: skipped (no open PR');
  });

  // Value: protects=amendment C, gstack-skill-end ends its session's run on any outcome so the next preflight replaces it, and
  //   never touches another run; fails_when=a crashed or aborted /ship leaves an open run; seam=bin/gstack-skill-end
  for (const outcome of ['error', 'abort']) {
    test(`gstack-skill-end --outcome ${outcome} finishes its own run only`, () => {
      const f = fx();
      const skillEnd = (id: string) => f.run(path.join(BIN, 'gstack-skill-end'), ['--skill', 'ship', '--outcome', outcome, '--session-id', id, '--tel-start', '0'], { GSTACK_LEASE_DIR: path.join(f.root, 'install-leases') });
      expect(preflight(f, 's1').status).toBe(0);
      expect(skillEnd('other-session').status).toBe(0);
      expect(record(f)).toMatchObject({ run: 's1', state: 'open' });
      expect(skillEnd('s1').status).toBe(0);
      expect(record(f)).toMatchObject({ run: 's1', state: 'finished', ended_by: 'skill-end' });
      f.advanceBase({ 'docs/new.md': '# new\n' });
      const reused = preflight(f, 's1');
      expect(reused.status).toBe(3);
      expect(reused.stdout).toContain('STOP: /ship run s1 already ended on this checkout (state finished, ended_by skill-end)');
      const next = preflight(f, 's2');
      expect(next.status, next.stdout).toBe(0);
      expect(record(f)).toMatchObject({ run: 's2', state: 'open' });
    });
  }

  // Value: protects=two preflights racing to open a run: the compare-and-swap under the gate lock lets exactly one write;
  //   fails_when=both record (the second overwrites the first); seam=lib/ship-run-record.ts changeRunRecord under withGateLock
  test('two racing preflights: exactly one opens the run', async () => {
    const f = fx();
    const lib = path.resolve(import.meta.dir, '..', 'lib', 'ship-run-record.ts');
    const open = (id: string) => new Promise<string>(resolve => {
      const child = spawn(process.execPath, ['--no-env-file', '--config=/dev/null', '-e', `const { changeRunRecord } = await import(${JSON.stringify(lib)}); process.stdout.write(JSON.stringify(changeRunRecord(process.cwd(), 'preflight', ${JSON.stringify(id)})));`], { cwd: f.work, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('close', () => resolve(out));
    });
    const results = (await Promise.all(Array.from({ length: 6 }, (_, i) => open(`race-${i}`)))).map(o => JSON.parse(o || '{"ok":false,"why":"no output"}'));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const winner = results.find(r => r.ok).record.run;
    expect(record(f)).toMatchObject({ run: winner, state: 'open' });
    for (const r of results.filter(x => !x.ok)) expect(r.why).toContain(`of run ${winner}`);
  });

  // Value: protects=rule --owner-ref stays allowed under open, stopped and legacy records while an unrelayed ruling refuses with
  //   the record's state; fails_when=a stopped record blocks the owner's relayed ruling; seam=gstack-approvals rule
  test('rule --owner-ref records under stopped, open and legacy records; without it the refusal names the state', () => {
    const f = fx();
    const s = head(f);
    const rule = (finding: string, extra: string[] = []) => run(f, 'gstack-approvals', ['rule', '--finding', finding, '--head', s, '--reason', 'ships as a note', '--words', 'B, note it', '--by', 'GBrain Minder (GBRA-108)', ...extra]);
    const now = new Date().toISOString();
    const states: Record<string, () => void> = {
      stopped: () => fs.writeFileSync(recordFile(f), JSON.stringify({ v: 1, run: 'ro', state: 'stopped', head: s, started_at: now, beat_at: now, stop: { head: s, tree: f.git('rev-parse', 'HEAD^{tree}').stdout.trim() } }) + '\n'),
      open: () => fs.writeFileSync(recordFile(f), JSON.stringify({ v: 1, run: 'ro', state: 'open', head: s, started_at: now, beat_at: now }) + '\n'),
      legacy: () => fs.writeFileSync(recordFile(f), 'ro\n'),
    };
    for (const [state, make] of Object.entries(states)) {
      make();
      const bare = rule(`src/${state}.ts:1:correctness`);
      expect([state, bare.status]).toEqual([state, 2]);
      expect(bare.stderr).toContain(`/ship run ro is open on this checkout (state ${state}, `);
      expect(bare.stderr).toContain('(APPROVAL_RULING_RUN_OPEN');
      const relayed = rule(`src/${state}.ts:1:correctness`, ['--owner-ref', 'GBRA-108:2026-11-21T12:00:00Z']);
      expect([state, relayed.status, relayed.stderr]).toEqual([state, 0, relayed.stderr]);
    }
    expect(run(f, 'gstack-approvals', ['lane-exception', '--head', s, '--files', 'test/a.test.ts', '--reason', 'x', '--words', 'w', '--by', 'Owner']).stderr).toContain('state legacy');
  });

  // Value: protects=preflight refuses a run id the PR body already shows receipted (gstack-evals#406 reused ship-406 across three
  //   runs); fails_when=history prints nothing for a reused id; seam=gstack-ship-receipt history --run
  test('history names a --run the PR body already receipted', () => {
    const f = fx();
    const body = path.join(f.root, 'body.md');
    const receipted = placeRunEntry('Fixes a thing.\n', { head: 'a'.repeat(40), run: 'ship-406', review_loop: { passes: 1, blocking_found: 0, deferred: 0 } });
    fs.writeFileSync(body, receipted);
    const used = run(f, 'gstack-ship-receipt', ['history', '--body', body, '--pr', '7', '--base', 'main', '--run', 'ship-406']);
    expect(used.stdout).toContain(`PR_REVIEW_RUN_USED: run=ship-406 receipted at ${'a'.repeat(12)}`);
    expect(run(f, 'gstack-ship-receipt', ['history', '--body', body, '--pr', '7', '--base', 'main', '--run', 'ship-407']).stdout).not.toContain('PR_REVIEW_RUN_USED');
  });
});

describe('finish removes only the run record the PR body names (amendment F)', () => {
  // Value: protects=finish never removes another run's record; fails_when=a stopped run's late finish deletes the next run's open
  //   record; seam=lib/ship-run-record.ts finishRun
  test('a record whose run the PR body does not name stays; a named one, or one with no PR, is removed', async () => {
    const { finishRun } = await import('../lib/ship-run-record');
    const f = fx();
    expect(preflight(f, 'run-b').status).toBe(0);
    expect(finishRun(f.work, ['run-a'])).toMatchObject({ removed: false });
    expect(record(f)).toMatchObject({ run: 'run-b', state: 'open' });
    expect(finishRun(f.work, ['run-a', 'run-b'])).toMatchObject({ removed: true });
    expect(fs.existsSync(recordFile(f))).toBe(false);
    expect(preflight(f, 'run-c').status).toBe(0);
    expect(finishRun(f.work, null)).toMatchObject({ removed: true });
    expect(fs.existsSync(recordFile(f))).toBe(false);
  });

  // Value: protects=two untested transitions: finish keeps an unreadable record, and abandon ends a stopped run past 60 minutes;
  //   fails_when=finish deletes a record it cannot read, or a stopped run can never be abandoned; seam=finishRun, gstack-ship-run abandon
  test('finish keeps an unreadable record; abandon ends a stopped run past 60 minutes', async () => {
    const { finishRun } = await import('../lib/ship-run-record');
    const f = fx();
    fs.writeFileSync(recordFile(f), '{"v":1,"run":\n');
    expect(finishRun(f.work, null)).toMatchObject({ removed: false, line: expect.stringContaining('RUN_RECORD: kept (') });
    expect(fs.readFileSync(recordFile(f), 'utf8')).toBe('{"v":1,"run":\n');
    fs.rmSync(recordFile(f));
    expect(preflight(f, 'ro').status).toBe(0);
    fs.writeFileSync(recordFile(f), JSON.stringify({ ...record(f), state: 'stopped' }) + '\n');
    age(f, 61);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, 'Fixes a thing.\n');
    const end = run(f, 'gstack-ship-run', ['abandon', '--run', 'ro', '--by', CAPTAIN, '--reason', 'stopped and never resumed', '--body', body]);
    expect(end.status, end.stderr).toBe(0);
    expect(record(f)).toMatchObject({ run: 'ro', state: 'abandoned', ended_by: CAPTAIN });
  });
});

describe('the stop binds to the head its stopping row read (#4591)', () => {
  const S = 'a'.repeat(40), E = 'e'.repeat(40), TS = 'b'.repeat(40), TE = 'f'.repeat(40);
  const trees: Record<string, string> = { [S]: TS, [E]: TE };
  const bound = (skill: string, commit: string, at: string, extra: Record<string, unknown> = {}) => ({ skill, via: 'ship', timestamp: at, completed: true, converged: false, commit_full: commit, tree: trees[commit], wtree: trees[commit], review_binding: { state: 'incomplete', start_wtree: trees[commit], end_wtree: trees[commit] }, ...extra });
  const from = (rows: Record<string, unknown>[]) => stopFrom(rows, '2026-11-21T00:00:00Z', { treeOf: c => trees[c], onHead: c => c === S || c === E });
  test('p1 -> fix-check -> Step 11 voices on a committed tree: the stop is the voices\' head, not the first pass\'s', () => {
    const p1 = bound('review', S, '2026-11-21T07:00:00Z', { review_binding: { state: 'changed', start_wtree: TS, end_wtree: TE } });
    const fixCheck = bound('review-fix-check', E, '2026-11-21T07:10:00Z');
    const voices = bound('adversarial-review', E, '2026-11-21T07:20:00Z');
    expect(from([p1, fixCheck, voices])).toEqual({ ok: true, head: E, tree: TE });
    expect(from([p1, fixCheck])).toEqual({ ok: true, head: E, tree: TE });
    expect(from([bound('review', S, '2026-11-21T07:00:00Z'), voices])).toEqual({ ok: true, head: E, tree: TE });
    expect(from([p1, { ...voices, wtree: TS }]).ok).toBe(false);
  });
});

describe('the round history counts a reused run id once per head (gstack-evals#406)', () => {
  test('three entries sharing one run id at three heads read rounds=3; the same run at one head counts once', () => {
    const loop = { passes: 1, blocking_found: 0, deferred: 0, rounds: 1 };
    const receipt = (h: string) => ({ head: h, run: 'ship-406', review_loop: loop });
    const body = [receipt('d'.repeat(40)), receipt('b'.repeat(40)), receipt('2'.repeat(40))].reduce((b, e) => placeRunEntry(b, e), 'Fixes a thing.\n');
    expect(prReviewHistory(body)).toMatchObject({ rounds: 3, runs: 3, heads: 3 });
    const sameHead = [runStub({ head: 'd'.repeat(40), run: 'ship-406', status: 'started', loop }), receipt('d'.repeat(40))].reduce((b, e) => placeRunEntry(b, e), 'Fixes a thing.\n');
    expect(prReviewHistory(sameHead)).toMatchObject({ rounds: 1, heads: 1 });
  });
});
