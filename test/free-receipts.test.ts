/**
 * GST-167 PR 3: scripts/lib/free-receipts.ts writes main receipts from a clean first-attempt shard and reads them back
 * for a pull request's shadow report through lib/run-evidence.ts verifyRun. Every refusal has a fixture; RunDeps and
 * the key computation are fakes, so nothing here reaches GitHub or runs a test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiJob, ApiRun, RunDeps, RunProfile, TreeRecord } from '../lib/run-evidence';
import type { KeyReport } from '../lib/test-impact/key';
import { readReceipts, recordShardReceipts, runShadowSelect, shadowReport, verifyReceipts, type FreeReceipt, type ReceiptCheck } from '../scripts/lib/free-receipts';
import { parseCliOptions, type FreeShardOutcome } from '../scripts/test-free-shards';

const REPO = 'garrytan/gstack';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-11-02T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['push'], jobs: ['free-tests'], artifact: 'free-tests-tree', max_age_hours: 72 };
const A = 'test/a.test.ts';
const B = 'test/b.test.ts';
const C = 'test/c.test.ts';
const D = 'test/d.test.ts';
const KEYS: Record<string, string> = { [A]: '1'.repeat(64), [B]: '2'.repeat(64), [C]: '3'.repeat(64), [D]: '4'.repeat(64) };
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-free-receipts-')); dirs.push(d); return d; };

interface World { run: ApiRun; jobs: ApiJob[]; artifact: TreeRecord; trees: Record<string, string>; throwOn?: boolean }
function world(over: { run?: Partial<ApiRun>; artifact?: Partial<TreeRecord>; jobs?: ApiJob[]; throwOn?: boolean } = {}): World {
  const run: ApiRun = {
    id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', head_sha: HEAD,
    path: '.github/workflows/free-tests.yml', created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:20:00Z',
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...over.run,
  };
  return {
    run, jobs: over.jobs ?? [{ name: 'free-tests', conclusion: 'success', completed_at: run.updated_at }],
    artifact: { run_id: 100, run_attempt: run.run_attempt, event: run.event, sha: HEAD, tree: TREE, files: [A, B, C, D], ...over.artifact },
    trees: { [HEAD]: TREE }, throwOn: over.throwOn,
  };
}
function deps(w: World): RunDeps {
  return {
    run: id => { if (w.throwOn) throw new Error('HTTP 502'); if (id !== w.run.id) throw new Error('HTTP 404'); return w.run; },
    runsForHead: (_wf, sha) => [w.run].filter(r => r.head_sha === sha),
    jobs: () => w.jobs,
    artifact: () => w.artifact,
    commitTree: sha => w.trees[sha] ?? null,
  };
}
const receipt = (file: string, over: Partial<FreeReceipt> = {}): FreeReceipt =>
  ({ file, key: KEYS[file]!, run_id: 100, run_attempt: 1, head_sha: HEAD, tree: TREE, shard: 1, written_at: '2026-11-02T10:10:00Z', ...over });
const check = (w: World, over: Partial<ReceiptCheck> = {}): ReceiptCheck =>
  ({ repo: REPO, profileName: 'free-receipts', profile: PROFILE, now: NOW, deps: deps(w), onBase: () => true, ...over });
function reasons(receipts: FreeReceipt[], c: ReceiptCheck): string[] {
  const v = verifyReceipts(receipts, c);
  if ('unavailable' in v) return [`unavailable: ${v.unavailable}`];
  return v.verdicts.map(x => x.ok ? 'ok' : x.reason);
}
const keyReport = (results: Array<{ test: string; key?: string | null; reasons?: string[] }>): KeyReport => ({
  tree: 'HEAD', base: 'origin/main', keyCodeEdited: [], alwaysRunGlobs: { base: [], tree: [] },
  results: results.map(r => ({ test: r.test, eligible: !r.reasons?.length, reasons: r.reasons ?? [], key: r.reasons?.length ? null : (r.key ?? KEYS[r.test]!), inputs: [], tracedAt: null })),
});

describe('verifyReceipts: a main receipt stands only on its verified push run', () => {
  test('first-attempt receipts from a verified main push run are accepted', () => {
    expect(reasons([receipt(A), receipt(B)], check(world()))).toEqual(['ok', 'ok']);
  });

  test('a forged run: the API or git disagrees with the receipt on tree, sha or the files it ran', () => {
    expect(reasons([receipt(A, { tree: 'd'.repeat(40) })], check(world()))).toEqual(['forged_run']);
    expect(reasons([receipt(A, { head_sha: 'e'.repeat(40) })], check(world()))).toEqual(['forged_run']);
    expect(reasons([receipt(A)], check(world({ artifact: { files: [B, C] } })))).toEqual(['forged_run']);
    expect(reasons([receipt(A)], check(world({ artifact: { tree: 'f'.repeat(40) } })))).toEqual(['forged_run']);
  });

  test('a pull_request or any other non-push event is refused, even when the profile also accepts dispatches', () => {
    expect(reasons([receipt(A)], check(world({ run: { event: 'pull_request' } })))).toEqual(['not_push']);
    expect(reasons([receipt(A)], check(world({ run: { event: 'workflow_dispatch' } }), { profile: { ...PROFILE, events: ['push', 'workflow_dispatch'] } }))).toEqual(['not_push']);
  });

  test('a retried run or shard is refused: run_attempt above 1 on the receipt or the API', () => {
    expect(reasons([receipt(A, { run_attempt: 2 })], check(world({ run: { run_attempt: 2 } })))).toEqual(['retried']);
    expect(reasons([receipt(A)], check(world({ run: { run_attempt: 2 } })))).toEqual(['retried']);
  });

  test('a run or receipt older than the profile max age is stale', () => {
    const old = '2026-10-29T10:00:00Z';
    expect(reasons([receipt(A)], check(world({ run: { created_at: old, updated_at: old } })))).toEqual(['stale']);
    expect(reasons([receipt(A, { written_at: old })], check(world()))).toEqual(['stale']);
  });

  test('a run of another workflow is refused', () => {
    expect(reasons([receipt(A)], check(world({ run: { path: '.github/workflows/evals.yml' } })))).toEqual(['other_workflow']);
  });

  test('a run whose head is not on the base branch is refused', () => {
    expect(reasons([receipt(A)], check(world(), { onBase: () => false }))).toEqual(['off_base']);
  });

  test('an API failure makes every receipt unavailable, never accepted', () => {
    const v = verifyReceipts([receipt(A), receipt(B)], check(world({ throwOn: true })));
    expect('unavailable' in v && v.unavailable).toContain('HTTP 502');
  });
});

describe('readReceipts', () => {
  test('a missing directory, an empty one or a malformed file is unavailable', () => {
    expect(readReceipts(path.join(tmp(), 'absent'))).toEqual({ unavailable: expect.stringContaining('no receipts directory') });
    expect(readReceipts(tmp())).toEqual({ unavailable: expect.stringContaining('no receipt files') });
    const bad = tmp();
    fs.writeFileSync(path.join(bad, 'free-receipts-shard-1.json'), JSON.stringify({ version: 1, receipts: [{ file: A, key: 'short' }] }));
    expect(readReceipts(bad)).toEqual({ unavailable: expect.stringContaining('malformed') });
  });

  test('receipt files written by several shards read back together', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'free-receipts-2'));
    fs.writeFileSync(path.join(dir, 'free-receipts-shard-1.json'), JSON.stringify({ version: 1, receipts: [receipt(A)] }));
    fs.writeFileSync(path.join(dir, 'free-receipts-2', 'free-receipts-shard-2.json'), JSON.stringify({ version: 1, receipts: [receipt(B, { shard: 2 })] }));
    expect(readReceipts(dir)).toEqual({ receipts: [receipt(A), receipt(B, { shard: 2 })] });
  });
});

describe('recordShardReceipts: one record per passing file, first attempts only', () => {
  const ENV = { GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: HEAD };
  const passed = (over: Partial<FreeShardOutcome> = {}): FreeShardOutcome => ({
    shard: 1, files: [A, B, C], status: 'passed', exitCode: 0, elapsedMs: 10, groupPid: null, failingFiles: [], unattributedFailures: 0,
    summary: { testsRan: 9, filesRan: 3, sawTerminalSummary: true }, ...over,
  });
  async function record(outcome: FreeShardOutcome, retry: FreeShardOutcome | null = null, env: Record<string, string> = ENV) {
    const dir = tmp();
    let keyed = 0;
    const line = await recordShardReceipts({
      root: '/nowhere', dir, shard: 1, outcome, retry, revision: HEAD, env, now: NOW, treeOf: () => TREE,
      keysAt: async (tree, base, tests) => { keyed++; expect([tree, base]).toEqual([HEAD, HEAD]); return keyReport(tests.map(t => t === C ? { test: t, reasons: ['no trace'] } : { test: t })); },
    });
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const receipts = files.length ? (JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8')).receipts as FreeReceipt[]) : [];
    return { line, files, receipts, keyed };
  }

  test('a clean shard writes one record per keyed passing file with the run identity', async () => {
    const r = await record(passed());
    expect(r.files).toEqual(['free-receipts-shard-1.json']);
    expect(r.receipts).toEqual([A, B].map(file => ({ file, key: KEYS[file]!, run_id: 100, run_attempt: 1, head_sha: HEAD, tree: TREE, shard: 1, written_at: NOW.toISOString() })));
    expect(r.line).toContain('2 written');
  });

  test('a shard with a flaky retry, a crash or an unattributed failure writes nothing at all', async () => {
    const retry = passed({ shard: 2, files: [B] });
    for (const [outcome, again] of [
      [passed({ status: 'failed', exitCode: 1, failingFiles: [B] }), retry],
      [passed({ crashedFiles: [B] }), null],
      [passed({ status: 'failed', exitCode: 1, unattributedFailures: 1 }), null],
      [passed({ summary: { testsRan: 9, filesRan: 2, sawTerminalSummary: true } }), null],
    ] as Array<[FreeShardOutcome, FreeShardOutcome | null]>) {
      const r = await record(outcome, again);
      expect(r.files).toEqual([]);
      expect(r.keyed).toBe(0);
      expect(r.line).toContain('none written');
    }
  });

  test('a pull_request run, a re-run attempt or a checkout that is not the run commit writes nothing', async () => {
    for (const env of [{ ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, { ...ENV, GITHUB_RUN_ATTEMPT: '2' }, { ...ENV, GITHUB_SHA: 'c'.repeat(40) }, {}]) {
      const r = await record(passed(), null, env);
      expect(r.files).toEqual([]);
      expect(r.line).toContain('none written');
    }
  });
});

describe('shadowReport: one line per free file, nothing skipped', () => {
  const accepted = (receipts: FreeReceipt[]) => verifyReceipts(receipts, check(world()));

  test('covers every free file exactly once; only a verified receipt with an equal key would be reused', () => {
    const r = shadowReport({
      files: [A, B, C, D],
      receipts: accepted([receipt(A), receipt(B, { key: '9'.repeat(64) }), receipt(C)]),
      keys: keyReport([{ test: A }, { test: B }, { test: C, reasons: ['no trace'] }, { test: D }]),
      durations: { [A]: 3000, [B]: 1000, [C]: 1000, [D]: 5000 },
    });
    expect(r.lines).toEqual([
      `${A} would-reuse 100 key=${KEYS[A]!.slice(0, 12)}`,
      `${B} execute (key mismatch: receipt 999999999999, tree 222222222222)`,
      `${C} execute (ineligible: no trace)`,
      `${D} execute (no receipt)`,
    ]);
    expect(r.lines.map(l => l.split(' ')[0]).sort()).toEqual([A, B, C, D]);
    expect(r.summary).toContain('would reuse 1 of 4 free files (25.0%)');
    expect(r.summary).toContain('3.0 s of 10.0 s seed time (30.0%)');
  });

  test('a free file listed twice fails the exactly-once assertion', () => {
    expect(() => shadowReport({ files: [A, A, B], receipts: accepted([receipt(A)]), keys: keyReport([{ test: A }, { test: B }]), durations: {} })).toThrow(/exactly once/);
  });

  test('refused receipts name their reason; unavailable receipts make every line execute', () => {
    const refused = shadowReport({ files: [A], receipts: verifyReceipts([receipt(A)], check(world({ run: { event: 'pull_request' } }))), keys: keyReport([{ test: A }]), durations: {} });
    expect(refused.lines[0]).toStartWith(`${A} execute (not_push: `);
    const down = shadowReport({ files: [A, B], receipts: { unavailable: 'HTTP 502' }, keys: keyReport([{ test: A }, { test: B }]), durations: {} });
    expect(down.lines).toEqual([`${A} execute (receipts unavailable: HTTP 502)`, `${B} execute (receipts unavailable: HTTP 502)`]);
    expect(down.summary).toContain('would reuse 0 of 2');
  });

  test('runShadowSelect with no receipts directory reports every file as execute', async () => {
    const r = await runShadowSelect({ root: '/nowhere', files: [A, B], receiptsDir: path.join(tmp(), 'absent'), base: 'origin/main', durations: {}, now: NOW, keysAt: async (_t, _b, tests) => keyReport(tests.map(test => ({ test }))) });
    expect(r.lines).toHaveLength(2);
    expect(r.lines.every(l => l.includes('execute (receipts unavailable: no receipts directory'))).toBe(true);
  });
});

describe('CLI flags', () => {
  test('--receipts rides --ci-run or --shadow-select; --shadow-select needs --receipts and --base', () => {
    expect(parseCliOptions(['--ci-run', 'p.json', '--shard', '1', '--result', 'r.json', '--receipts', 'out']).receipts).toBe('out');
    const shadow = parseCliOptions(['--shadow-select', '--receipts', 'in', '--base', 'origin/main']);
    expect([shadow.shadowSelect, shadow.receipts, shadow.base]).toEqual([true, 'in', 'origin/main']);
    expect(() => parseCliOptions(['--receipts', 'out'])).toThrow();
    expect(() => parseCliOptions(['--shadow-select', '--receipts', 'in'])).toThrow();
    expect(() => parseCliOptions(['--shadow-select', '--base', 'origin/main'])).toThrow();
    expect(() => parseCliOptions(['--shadow-select', '--receipts', 'in', '--base', 'm', '--ci-run', 'p.json', '--shard', '1', '--result', 'r.json'])).toThrow();
    expect(() => parseCliOptions(['--windows-only', '--ci-run', 'p.json', '--shard', '1', '--result', 'r.json', '--receipts', 'out'])).toThrow();
  });
});
