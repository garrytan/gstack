/**
 * Readiness-gated dispatch (R1, GSTA-48), driven from scripted gh responses
 * and a fake clock: no network, no sleeping.
 */
import { describe, expect, test } from 'bun:test';
import { freeTestsState, readinessDecision, screenTarget, waitForReadiness, type FreeTestsRun } from '../scripts/eval-readiness';
import type { GhRunner } from '../scripts/recover-receipts';

const HEAD = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const CREATED = Date.parse('2026-10-18T00:00:00Z');
const free = (id: number, status: string, conclusion: string | null, over: Partial<FreeTestsRun> = {}): FreeTestsRun =>
  ({ id, status, conclusion, head_sha: HEAD, event: 'pull_request', ...over });

/** A gh that answers the run, Free Tests and PR reads from a per-poll script, recording each call. */
function fakeGh(polls: Array<{ free: FreeTestsRun[]; prHead?: string } | 'error'>, createdAt: string | null = new Date(CREATED).toISOString()) {
  const calls: string[] = [];
  let poll = -1;
  const gh: GhRunner = (args) => {
    const target = args.find(a => a.startsWith('repos/')) ?? '';
    calls.push(target);
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    if (/\/actions\/runs\/\d+$/.test(target)) return createdAt ? ok({ created_at: createdAt }) : { status: 1, stdout: '', stderr: 'HTTP 502' };
    if (target.endsWith('/actions/workflows/free-tests.yml/runs')) {
      poll++;
      const step = polls[Math.min(poll, polls.length - 1)]!;
      return step === 'error' ? { status: 1, stdout: '', stderr: 'HTTP 502' } : ok({ workflow_runs: step.free });
    }
    if (/\/pulls\/\d+$/.test(target)) {
      const step = polls[Math.min(poll, polls.length - 1)]!;
      return ok({ head: { sha: step === 'error' ? HEAD : step.prHead ?? HEAD } });
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { gh, calls };
}

function clock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, at: () => t };
}

const base = { repo: 'garrytan/gstack', pr: 42, headSha: HEAD, runId: 900, quietMs: 10 * 60_000, deadlineMs: 80 * 60_000, pollMs: 60_000 };

describe('readiness decision', () => {
  test('the newest Free Tests run on this exact head decides; other heads and events are ignored', () => {
    expect(freeTestsState([], HEAD)).toEqual({ state: 'missing' });
    expect(freeTestsState([free(1, 'completed', 'success', { head_sha: NEWER })], HEAD)).toEqual({ state: 'missing' });
    expect(freeTestsState([free(1, 'completed', 'success', { event: 'push' })], HEAD)).toEqual({ state: 'missing' });
    expect(freeTestsState([free(4, 'completed', 'success', { event: 'workflow_dispatch' })], HEAD)).toEqual({ state: 'success', runId: 4 });
    expect(freeTestsState([free(4, 'completed', 'success'), free(5, 'completed', 'failure', { event: 'workflow_dispatch' })], HEAD))
      .toEqual({ state: 'failed', runId: 5, conclusion: 'failure' });
    expect(freeTestsState([free(1, 'completed', 'failure'), free(2, 'in_progress', null)], HEAD)).toEqual({ state: 'running', runId: 2 });
    expect(freeTestsState([free(2, 'completed', 'success'), free(1, 'completed', 'failure')], HEAD)).toEqual({ state: 'success', runId: 2 });
    expect(freeTestsState([free(3, 'completed', 'cancelled')], HEAD)).toEqual({ state: 'failed', runId: 3, conclusion: 'cancelled' });
  });

  test('ready needs both a green Free Tests on the head and an elapsed window; a moved head is superseded', () => {
    const green = { state: 'success', runId: 7 } as const;
    expect(readinessDecision({ headSha: HEAD, prHead: HEAD, free: green, quietLeftMs: 0 }).kind).toBe('ready');
    expect(readinessDecision({ headSha: HEAD, prHead: HEAD, free: green, quietLeftMs: 1 }).kind).toBe('wait');
    expect(readinessDecision({ headSha: HEAD, prHead: HEAD, free: { state: 'running', runId: 7 }, quietLeftMs: 0 }).kind).toBe('wait');
    expect(readinessDecision({ headSha: HEAD, prHead: HEAD, free: { state: 'missing' }, quietLeftMs: 0 }).kind).toBe('wait');
    expect(readinessDecision({ headSha: HEAD, prHead: NEWER, free: green, quietLeftMs: 0 })).toEqual({ kind: 'superseded', by: NEWER });
    const blocked = readinessDecision({ headSha: HEAD, prHead: HEAD, free: { state: 'failed', runId: 7, conclusion: 'failure' }, quietLeftMs: 0 });
    expect(blocked.kind).toBe('blocked');
    expect(blocked.kind === 'blocked' && blocked.reason).toContain('re-run Free Tests and then re-run this workflow');
  });
});

describe('waitForReadiness', () => {
  test('sleeps out the window with no API calls, then starts once Free Tests passes', () => {
    const { gh, calls } = fakeGh([{ free: [free(5, 'in_progress', null)] }, { free: [free(5, 'completed', 'success')] }]);
    const c = clock(CREATED + 5_000);
    const { decision, lines } = waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep });
    expect(decision.kind).toBe('ready');
    // One run read, then nothing until the window closed at created + 10 min.
    expect(calls[0]).toBe('repos/garrytan/gstack/actions/runs/900');
    expect(c.sleeps[0]).toBe(10 * 60_000 - 5_000);
    expect(calls.filter(call => call.endsWith('free-tests.yml/runs'))).toHaveLength(2);
    expect(c.at()).toBe(CREATED + 11 * 60_000);
    expect(lines.join('\n')).toContain('Free Tests run 5 passed');
  });

  test('a re-run keeps the original creation time, so an elapsed window is not waited again', () => {
    const { gh } = fakeGh([{ free: [free(5, 'completed', 'success')] }]);
    const c = clock(CREATED + 3 * 3600_000);
    expect(waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep }).decision.kind).toBe('ready');
    expect(c.sleeps).toEqual([]);
  });

  test('a quiet window of 0 (the evals-no-debounce label) still waits for Free Tests', () => {
    const { gh } = fakeGh([{ free: [] }, { free: [free(5, 'queued', null)] }, { free: [free(5, 'completed', 'success')] }]);
    const c = clock(CREATED);
    expect(waitForReadiness({ ...base, quietMs: 0, gh, now: c.now, sleep: c.sleep }).decision.kind).toBe('ready');
    expect(c.sleeps).toEqual([60_000, 60_000]);
  });

  test('Free Tests red on this head blocks the paid gate', () => {
    const { gh } = fakeGh([{ free: [free(5, 'completed', 'failure')] }]);
    const c = clock(CREATED);
    const { decision } = waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep });
    expect(decision.kind).toBe('blocked');
  });

  test('a dispatched-only Free Tests run on this head makes readiness ready', () => {
    const { gh } = fakeGh([{ free: [free(5, 'completed', 'success', { event: 'workflow_dispatch' })] }]);
    const c = clock(CREATED);
    expect(waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep }).decision.kind).toBe('ready');
  });

  test('a newer head is reported superseded instead of starting', () => {
    const { gh } = fakeGh([{ free: [free(5, 'completed', 'success')], prHead: NEWER }]);
    const c = clock(CREATED);
    const { decision, lines } = waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep });
    expect(decision).toEqual({ kind: 'superseded', by: NEWER });
    expect(lines.join('\n')).toContain('this run plans no slices');
  });

  test('a Free Tests run that never finishes, or a gh outage, fails at the deadline with the last reason', () => {
    for (const polls of [[{ free: [free(5, 'in_progress', null)] }], ['error' as const]]) {
      const { gh } = fakeGh(polls);
      const c = clock(CREATED);
      const { decision } = waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep });
      expect(decision.kind).toBe('blocked');
      expect(decision.kind === 'blocked' && decision.reason).toContain('not ready after 80 min');
      expect(c.at() - CREATED).toBeLessThanOrEqual(80 * 60_000);
    }
  });

  test('an unreadable run creation time measures the window from now', () => {
    const { gh } = fakeGh([{ free: [free(5, 'completed', 'success')] }], null);
    const c = clock(CREATED + 60_000);
    expect(waitForReadiness({ ...base, gh, now: c.now, sleep: c.sleep }).decision.kind).toBe('ready');
    expect(c.sleeps[0]).toBe(10 * 60_000);
  });
});

describe('dispatched screens (GSTA-49 T1b): the merge commit is checked against the PR before Free Tests is read on its head', () => {
  const MERGE = 'c'.repeat(40);
  const BASE = 'd'.repeat(40);
  const pull = (over: Record<string, unknown> = {}) => ({ state: 'open', head: { sha: HEAD, ref: 'feature', repo: { full_name: 'garrytan/gstack' } }, base: { repo: { full_name: 'garrytan/gstack' } }, ...over });
  const gh = (pr: unknown, parents: string[] | null): GhRunner => (args) => {
    const target = args.find(a => a.startsWith('repos/')) ?? '';
    if (target.endsWith('/pulls/42')) return pr ? { status: 0, stdout: JSON.stringify(pr), stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    if (target.endsWith(`/commits/${MERGE}`)) return parents ? { status: 0, stdout: JSON.stringify({ parents: parents.map(sha => ({ sha })) }), stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 422' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  test("an open same-repository PR's merge commit names its head (second parent) and tested base (first parent)", () => {
    expect(screenTarget(gh(pull(), [BASE, HEAD]), 'garrytan/gstack', 42, MERGE)).toEqual({ head: HEAD, base: BASE, branch: 'feature' });
  });

  test('a fork PR, a closed PR, a non-merge commit, a short SHA or an unreadable PR is refused', () => {
    const refused: Array<[GhRunner, string, string]> = [
      [gh(pull({ head: { sha: HEAD, ref: 'feature', repo: { full_name: 'fork/gstack' } } }), [BASE, HEAD]), MERGE, 'not a same-repository PR'],
      [gh(pull({ head: { sha: HEAD, ref: 'feature', repo: null } }), [BASE, HEAD]), MERGE, 'not a same-repository PR'],
      [gh(pull({ state: 'closed' }), [BASE, HEAD]), MERGE, 'is closed, not open'],
      [gh(pull(), [BASE]), MERGE, 'is not a two-parent merge commit'],
      [gh(pull(), null), MERGE, 'cannot read the merge commit'],
      [gh(null, [BASE, HEAD]), MERGE, 'cannot read PR #42'],
      [gh(pull(), [BASE, HEAD]), MERGE.slice(0, 12), 'is not a full commit SHA'],
    ];
    for (const [runner, merge, why] of refused) expect((screenTarget(runner, 'garrytan/gstack', 42, merge) as { error?: string }).error, why).toContain(why);
  });

  test('the screen then waits on Free Tests for the PR head with no quiet window, and a moved head is superseded', () => {
    const { gh: ready } = fakeGh([{ free: [free(5, 'completed', 'success')] }]);
    const c = clock(CREATED);
    expect(waitForReadiness({ ...base, quietMs: 0, gh: ready, now: c.now, sleep: c.sleep }).decision.kind).toBe('ready');
    expect(c.sleeps).toEqual([]);
    const { gh: moved } = fakeGh([{ free: [free(5, 'completed', 'success')], prHead: NEWER }]);
    expect(waitForReadiness({ ...base, quietMs: 0, gh: moved, now: c.now, sleep: c.sleep }).decision).toEqual({ kind: 'superseded', by: NEWER });
  });
});
