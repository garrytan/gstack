/**
 * gstack-ship-queue count (lib/ship-queue-count.ts, R119): the finished-PR count a Captain reads at every wake, from
 * one gh call. Fixtures stand in for that call's GraphQL page.
 */
import { describe, expect, test } from 'bun:test';
import { COUNT_QUERY, queueCount } from '../lib/ship-queue-count';
import type { QueueContext } from '../lib/ship-queue';

const NOW = new Date('2026-11-22T16:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
type Over = Partial<{ isDraft: boolean; mergeable: string; baseRefName: string; login: string | null; rollup: string | null; committed: string }>;
const pr = (number: number, hours: number, o: Over = {}) => ({
  number, title: `Change ${number}`, isDraft: o.isDraft ?? false, mergeable: o.mergeable ?? 'MERGEABLE', baseRefName: o.baseRefName ?? 'main',
  author: o.login === null ? null : { login: o.login ?? 'garrytan' },
  commits: { nodes: [{ commit: { committedDate: o.committed ?? hoursAgo(hours), statusCheckRollup: o.rollup === null ? null : { state: o.rollup ?? 'SUCCESS' } } }] },
});
function run(nodes: unknown[], o: { totalCount?: number; authors?: string[]; fail?: string } = {}) {
  const calls: string[][] = [];
  const ctx: QueueContext = {
    repoRoot: '/nonexistent', base: 'main',
    gh: args => { calls.push(args); return o.fail ? { ok: false, out: '', err: o.fail } : { ok: true, out: JSON.stringify({ data: { repository: { pullRequests: { totalCount: o.totalCount ?? nodes.length, nodes } } } }), err: '' }; },
  };
  return { out: queueCount(ctx, { now: NOW, authors: o.authors }), calls };
}

describe('gstack-ship-queue count', () => {
  test('makes exactly one gh call and counts only finished PRs: our authors, on the base, not draft, not conflicting, green at the head', () => {
    const { out, calls } = run([
      pr(1, 3),
      pr(2, 5, { login: 'capy-ai' }),
      pr(3, 1, { login: 'app/garrytan-agents' }),
      pr(4, 2, { login: 'capy-ai[bot]', mergeable: 'UNKNOWN' }),
      pr(10, 9, { isDraft: true }),
      pr(11, 9, { mergeable: 'CONFLICTING' }),
      pr(12, 9, { login: 'dependabot' }),
      pr(13, 9, { login: null }),
      pr(14, 9, { baseRefName: 'release' }),
      pr(15, 9, { rollup: 'PENDING' }),
      pr(16, 9, { rollup: 'FAILURE' }),
      pr(17, 9, { rollup: null }),
    ]);
    expect(calls).toEqual([['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${COUNT_QUERY}`]]);
    expect(out.ok).toBe(true);
    expect(out.lines).toEqual([
      'QUEUE_COUNT: finished=4 waited_24h=0 oldest=5h #2 open=12 base=main authors=garrytan,capy-ai,garrytan-agents',
      'FINISHED: #2 5h Change 2',
      'FINISHED: #1 3h Change 1',
      'FINISHED: #4 2h Change 4',
      'FINISHED: #3 1h Change 3',
    ]);
  });

  test('more than 6 finished PRs prints DRAIN; exactly 6, none a day old, does not', () => {
    const six = [1, 2, 3, 4, 5, 6].map(n => pr(n, n));
    expect(run(six).out.lines.some(l => l.startsWith('DRAIN:'))).toBe(false);
    const seven = run([...six, pr(7, 7)]).out.lines;
    expect(seven[0]).toBe('QUEUE_COUNT: finished=7 waited_24h=0 oldest=7h #7 open=7 base=main authors=garrytan,capy-ai,garrytan-agents');
    expect(seven.at(-1)).toBe('DRAIN: 7 finished PRs are waiting (more than 6); start a drain this turn: land them, bundle them, or send each idle owner its next step (docs/captain.md#drain-the-queue)');
  });

  test('one PR waiting 24 hours since its last commit prints DRAIN on its own; 23 hours does not', () => {
    expect(run([pr(1, 23.9)]).out.lines.some(l => l.startsWith('DRAIN:'))).toBe(false);
    const lines = run([pr(1, 2), pr(4670, 31)]).out.lines;
    expect(lines[0]).toBe('QUEUE_COUNT: finished=2 waited_24h=1 oldest=31h #4670 open=2 base=main authors=garrytan,capy-ai,garrytan-agents');
    expect(lines.at(-1)).toMatch(/^DRAIN: 1 has waited 24h or more \(oldest #4670, 31h\); start a drain this turn/);
  });

  test('both bounds name both reasons; past 10 finished the list folds; over 100 open PRs says the count is partial', () => {
    const many = Array.from({ length: 12 }, (_, i) => pr(i + 1, 30 + i));
    const lines = run(many, { totalCount: 140 }).out.lines;
    expect(lines[1]).toBe('QUEUE_COUNT_PARTIAL: counted the oldest 12 of 140 open PRs');
    expect(lines.filter(l => l.startsWith('FINISHED: #'))).toHaveLength(10);
    expect(lines).toContain('FINISHED: and 2 more');
    expect(lines.at(-1)).toMatch(/^DRAIN: 12 finished PRs are waiting \(more than 6\) and 12 have waited 24h or more \(oldest #12, 41h\); /);
  });

  test('--authors replaces the default list, and a failed gh call refuses with the fix instead of printing a zero count', () => {
    expect(run([pr(1, 2), pr(2, 2, { login: 'someone' })], { authors: ['someone'] }).out.lines[0]).toBe('QUEUE_COUNT: finished=1 waited_24h=0 oldest=2h #2 open=2 base=main authors=someone');
    const failed = run([], { fail: 'HTTP 401: Bad credentials' }).out;
    expect(failed.ok).toBe(false);
    expect(failed.lines).toEqual([]);
    expect(failed.failure).toMatchObject({ code: 'QUEUE_NOT_READY', message: 'gh could not list the open PRs: HTTP 401: Bad credentials' });
  });
});
