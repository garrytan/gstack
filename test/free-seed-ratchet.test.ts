/**
 * Free-suite growth ratchet (CEO-10) and the free lane's health signals.
 * The committed duration seed may not hold a file over 60 s unless the
 * shrink-only allowlist names it; an added allowlist entry needs a "todo"
 * (an annotated exception, printed below). The shrink check compares with the
 * merge-base copy: GSTACK_FREE_SEED_BASE (set by free-tests.yml's plan job,
 * which has full history) or `git merge-base HEAD origin/main` locally.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ciHealthSummary,
  overrunWarning,
  parseSeedAllowlist,
  readBaseSeedAllowlist,
  SEED_ALLOWLIST_FILE,
  SEED_DOCS_ANCHOR,
  SEED_REFRESH_COMMAND,
  seedRatchet,
  shardOverruns,
  unseededWarning,
  flakyPassTable,
} from '../scripts/lib/free-ci-health';
import { FREE_TEST_DURATIONS_FILE, type FreeCiPlan, type FreeCiResult, type FreeShardOutcome } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });

describe('seed ceiling and shrink-only allowlist', () => {
  const durations = { 'test/slow.test.ts': 70_000, 'test/fast.test.ts': 2_000, 'test/listed.test.ts': 90_000 };
  const listed = { file: 'test/listed.test.ts', reason: 'real setup per host' };

  test('a seeded file over 60 s that the allowlist lacks fails with the split fix', () => {
    const { violations } = seedRatchet({ durations, allowlist: [listed], baseAllowlist: [listed] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('test/slow.test.ts is seeded at 70s, over the 60s ceiling');
    expect(violations[0]).toContain(SEED_REFRESH_COMMAND);
    expect(violations[0]).toContain(SEED_DOCS_ANCHOR);
  });

  test('an entry no longer over the ceiling, or gone from the seed, must be deleted', () => {
    const { violations } = seedRatchet({
      durations: { 'test/listed.test.ts': 40_000 },
      allowlist: [listed, { file: 'test/deleted.test.ts', reason: 'gone' }],
      baseAllowlist: null,
    });
    expect(violations.map(line => line.split(',')[0])).toEqual([
      `${SEED_ALLOWLIST_FILE} lists test/listed.test.ts`,
      `${SEED_ALLOWLIST_FILE} lists test/deleted.test.ts`,
    ]);
    expect(violations[0]).toContain('Fix: delete its entry');
  });

  test('shrink-only: an entry the merge-base lacks fails unless it is an annotated exception', () => {
    const slow = { file: 'test/slow.test.ts', reason: 'one real browser per case' };
    const added = seedRatchet({ durations, allowlist: [listed, slow], baseAllowlist: [listed] });
    expect(added.violations).toHaveLength(1);
    expect(added.violations[0]).toContain('adds test/slow.test.ts, but the allowlist is shrink-only');
    expect(added.violations[0]).toContain('add a "todo"');

    const annotated = seedRatchet({ durations, allowlist: [listed, { ...slow, todo: 'TODOS.md: split by browser fixture' }], baseAllowlist: [listed] });
    expect(annotated.violations).toEqual([]);
    expect(annotated.exceptions).toEqual(['annotated exception: test/slow.test.ts (reason: one real browser per case; todo: TODOS.md: split by browser fixture)']);
  });

  test('a merge-base without the allowlist file counts as the first allowlist', () => {
    const slow = { file: 'test/slow.test.ts', reason: 'first entry' };
    expect(seedRatchet({ durations, allowlist: [listed, slow], baseAllowlist: null })).toEqual({ violations: [], exceptions: [] });
  });

  test('the allowlist parser rejects entries without a file or reason', () => {
    expect(() => parseSeedAllowlist('{"entries":[{"file":"test/a.test.ts"}]}')).toThrow('entries[0] needs a non-empty "file" and "reason"');
    expect(() => parseSeedAllowlist('{"entries":[{"file":"test/a.test.ts","reason":"r","todo":" "}]}')).toThrow('"todo" must be a non-empty string');
    expect(() => parseSeedAllowlist('[]')).toThrow('expected {"entries": [...]}');
  });

  test('the merge-base reader distinguishes a pre-allowlist base, an allowlist base and an unresolvable base', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-seed-ratchet-'));
    try {
      expect(git(repo, 'init', '-q').status).toBe(0);
      const commit = (message: string) => expect(git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message, '--allow-empty').status).toBe(0);
      commit('before');
      expect(readBaseSeedAllowlist(repo, 'HEAD')).toEqual({ status: 'ok', entries: null });
      fs.mkdirSync(path.join(repo, 'scripts'));
      fs.writeFileSync(path.join(repo, SEED_ALLOWLIST_FILE), JSON.stringify({ entries: [listed] }));
      expect(git(repo, 'add', '.').status).toBe(0);
      commit('allowlist');
      expect(readBaseSeedAllowlist(repo, 'HEAD')).toEqual({ status: 'ok', entries: [listed] });
      expect(readBaseSeedAllowlist(repo, 'no-such-ref')).toEqual({ status: 'unavailable', reason: 'cannot resolve merge-base no-such-ref' });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('the committed seed holds the ceiling and the allowlist only shrinks', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, FREE_TEST_DURATIONS_FILE), 'utf8')) as { durations: Record<string, number> };
    const allowlist = parseSeedAllowlist(fs.readFileSync(path.join(ROOT, SEED_ALLOWLIST_FILE), 'utf8'));
    const explicitBase = process.env.GSTACK_FREE_SEED_BASE;
    const base = explicitBase ?? git(ROOT, 'merge-base', 'HEAD', 'origin/main').stdout.trim();
    const read = base ? readBaseSeedAllowlist(ROOT, base) : { status: 'unavailable' as const, reason: 'no origin/main merge-base in this checkout' };
    if (read.status === 'unavailable' && explicitBase) throw new Error(`GSTACK_FREE_SEED_BASE is set but ${read.reason}`);
    if (read.status === 'unavailable') console.log(`[seed-ratchet] shrink-only check not run here (${read.reason}); free-tests.yml's plan job runs it with full history.`);
    const { violations, exceptions } = seedRatchet({
      durations: seed.durations,
      allowlist,
      baseAllowlist: read.status === 'ok' ? read.entries : allowlist,
    });
    for (const line of exceptions) console.log(`[seed-ratchet] ${line}`);
    if (violations.length) throw new Error(`Free seed ratchet:\n- ${violations.join('\n- ')}`);
  });
});

describe('free lane CI warnings', () => {
  test('unseeded files warn only past the limit of five, naming the refresh command and anchor', () => {
    expect(unseededWarning(['a', 'b', 'c', 'd', 'e'])).toBeNull();
    const warning = unseededWarning(['a', 'b', 'c', 'd', 'e', 'f'])!;
    expect(warning).toStartWith('WARNING: 6 free test files have no recorded duration (limit 5)');
    expect(warning).toContain(`Fix: run \`${SEED_REFRESH_COMMAND}\``);
    expect(warning).toContain(SEED_DOCS_ANCHOR);
  });

  test('a shard overrun needs 1.5x its prediction and at least 30 s of excess', () => {
    const overruns = shardOverruns([
      { shard: 1, predictedMs: 100_000, elapsedMs: 160_000 },
      { shard: 2, predictedMs: 100_000, elapsedMs: 149_000 },
      { shard: 3, predictedMs: 10_000, elapsedMs: 30_000 },
    ]);
    expect(overruns.map(overrun => overrun.shard)).toEqual([1]);
    expect(overrunWarning(overruns)).toContain('shard 1 took 160s vs 100s predicted');
    expect(overrunWarning(overruns)).toContain(SEED_REFRESH_COMMAND);
    expect(overrunWarning([])).toBeNull();
  });

  test('the --ci-verify summary lists flaky passes from recovered shards and shards that outran the seed', () => {
    const outcome = (shard: number, files: string[], failingFiles: string[], elapsedMs: number): FreeShardOutcome =>
      ({ shard, files, failingFiles, elapsedMs, status: failingFiles.length ? 'failed' : 'passed' }) as FreeShardOutcome;
    const plan = { version: 1, revision: 'r', id: 'p', shards: [
      { shard: 1, files: ['test/a.test.ts', 'test/b.test.ts'], predictedMs: 100_000 },
      { shard: 2, files: ['test/c.test.ts'], predictedMs: 100_000 },
    ] } satisfies FreeCiPlan;
    const results: FreeCiResult[] = [
      { planId: 'p', revision: 'r', outcome: outcome(2, ['test/c.test.ts'], [], 200_000), retry: null },
      { planId: 'p', revision: 'r', outcome: outcome(1, plan.shards[0].files, ['test/b.test.ts'], 90_000), retry: outcome(1, ['test/b.test.ts'], [], 5_000) },
    ];
    const [flaky, overrun] = ciHealthSummary(plan, results);
    expect(flaky).toBe(flakyPassTable([{ file: 'test/b.test.ts', shard: 1 }]));
    expect(flaky).toContain('| `test/b.test.ts` | 1 |');
    expect(overrun).toContain('shard 2 took 200s vs 100s predicted');
    expect(ciHealthSummary(plan, [results[0]].map(r => ({ ...r, outcome: { ...r.outcome, elapsedMs: 100_000 } })))).toEqual([]);
  });
});
