/**
 * bin/gstack-autoplan under two writers (plan B2): concurrent submits of one
 * attempt bind it exactly once; concurrent `next` calls never mint duplicate
 * attempt ids; a writer that reads a stale revision cannot clobber a newer
 * run.json because every mutation runs under run.lock; and the B0 `ack` on a
 * finished run is exactly-once across concurrent consumers. Pins journal rows,
 * attempt counters and exit codes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTOPLAN, ROOT, attemptsOf, env, journal, readRun, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-concurrency-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function parallel(argvs: string[][]): Promise<Array<{ status: number; stdout: string; stderr: string }>> {
  const procs = argvs.map(a => Bun.spawn(['bun', AUTOPLAN, ...a], { cwd: ROOT, env: env(), stdout: 'pipe', stderr: 'pipe' }));
  const timers = procs.map(p => setTimeout(() => p.kill('SIGKILL'), 120_000));
  const out = await Promise.all(procs.map(async p => ({ status: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() })));
  timers.forEach(clearTimeout);
  return out;
}

describe('two writers', () => {
  test('six concurrent submits of the same attempt: exactly one binds, the rest are refused, one journal row, one settlement', async () => {
    const out = startSmallRun(path.join(TMP, 'submit'), ['--estimate-usd', '1']);
    const ids = attemptsOf(out, 'ceo');
    review(path.join(out, 'ceo-native-prompt.md'));
    const args = ['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native];
    const results = await parallel(Array.from({ length: 6 }, () => args));
    const ok = results.filter(r => r.status === 0);
    expect(ok).toHaveLength(1);
    for (const r of results.filter(r => r.status !== 0)) {
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/\((PHASE_NOT_AWAITING|RUN_LOCKED)\)$/m);
    }
    expect(journal(out).filter(j => j.event === 'submitted')).toHaveLength(1);
    const spend = JSON.parse(fs.readFileSync(path.join(out, 'spend.json'), 'utf8'));
    expect(spend.settled.filter((s: any) => s.attempt === ids.native)).toHaveLength(1);
    expect(readRun(out).phases.ceo.native.status).toBe('completed');
    expect(fs.existsSync(path.join(out, 'run.lock'))).toBe(false);
  });

  test('six concurrent next calls mint no duplicate attempt ids and leave one consistent manifest', async () => {
    const out = startSmallRun(path.join(TMP, 'next'));
    const results = await parallel(Array.from({ length: 6 }, () => ['next', '--out', out]));
    for (const r of results) expect([0, 3]).toContain(r.status);
    const run = readRun(out);
    expect(run.attempt_counter).toBe(2);
    const dispatched = journal(out).filter(j => j.event === 'dispatched').map(j => j.attempt);
    expect(new Set(dispatched).size).toBe(dispatched.length);
    expect(dispatched).toHaveLength(2);
    expect(run.phases.ceo.native.attempts).toHaveLength(1);
  });

  test('revision conflict: a writer holding a stale copy cannot clobber a newer manifest (every write is a locked read-modify-write)', async () => {
    const out = startSmallRun(path.join(TMP, 'revision'));
    const ids = attemptsOf(out, 'ceo');
    review(path.join(out, 'ceo-native-prompt.md'));
    review(path.join(out, 'ceo-outside-prompt.md'));
    const before = readRun(out).revision;
    const results = await parallel([
      ['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native],
      ['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', path.join(out, 'ceo-outside.md'), '--model', 'openai/gpt-6-astra', '--attempt', ids.outside],
      ['status', '--out', out],
    ]);
    const bound = results.slice(0, 2).filter(r => r.status === 0).length;
    const lockedOut = results.slice(0, 2).filter(r => r.status === 3 && /RUN_LOCKED/.test(r.stderr)).length;
    expect(bound + lockedOut).toBe(2);
    const run = readRun(out);
    expect(run.revision).toBe(before + bound);
    const completed = ['native', 'outside'].filter(v => run.phases.ceo[v].status === 'completed');
    expect(completed).toHaveLength(bound);
    if (bound === 2) expect(run.phases.ceo.closed_at).toBeTruthy();
    expect(journal(out).filter(j => j.event === 'submitted')).toHaveLength(bound);
  });

  test('exactly-once ack: concurrent consumers of a finished run record one consumed_by entry each, never two for one consumer', async () => {
    const out = startSmallRun(path.join(TMP, 'ack'));
    runPhase(out, 'ceo');
    const eng = runPhase(out, 'eng');
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const artifact = path.join(ROOT, 'bin', 'gstack-artifact');
    const procs = ['thread-A', 'thread-A', 'thread-B', 'thread-A'].map(c => Bun.spawn(['bun', artifact, 'ack', path.join(out, 'run.json'), '--consumer', c, '--json'], { cwd: ROOT, env: env(), stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(procs.map(async p => ({ status: await p.exited, stdout: await new Response(p.stdout).text() })));
    for (const r of results) expect(r.status).toBe(0);
    const consumers = readRun(out).consumed_by.map((c: any) => c.consumer).sort();
    expect(consumers).toEqual(['thread-A', 'thread-B']);
    const added = results.map(r => JSON.parse(r.stdout)).filter(r => r.added);
    expect(added.map(r => r.consumer).sort()).toEqual(['thread-A', 'thread-B']);
  });
});
