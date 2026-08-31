/**
 * The eval CLI family — scripts/eval-select.ts, eval-list.ts, eval-compare.ts,
 * eval-summary.ts — the primary interface to eval results.
 *
 * Isolation mechanisms (each verified against the source, not assumed):
 *
 *   - eval-list / eval-compare / eval-summary resolve their eval dir via
 *     getProjectEvalDir() (test/helpers/eval-store.ts), which probes the
 *     CWD-RELATIVE `.claude/skills/gstack/bin/gstack-slug` first, then
 *     `~/.claude/...` (~ = $HOME of the child). They do NOT honor
 *     GSTACK_EVAL_DIR (only EvalCollector does). So the real isolation
 *     mechanism is: cwd = a temp HOME containing a fake gstack-slug that
 *     prints `SLUG=<fixture>`, routing every read to
 *     $HOME/.gstack/projects/<fixture>/evals — fully hermetic, and it
 *     exercises the primary (project-scoped) dir resolution path.
 *     (test/eval-list-cli.test.ts already covers the legacy-fallback dir +
 *     --limit validation; this file deliberately does not duplicate that.)
 *
 *   - eval-select has NO isolation mechanism for its git diff: ROOT is
 *     hardcoded to the repo containing the script (import.meta.dir/..), so
 *     the CLI is smoke-tested against this repo with `--base HEAD` using
 *     shape invariants that hold for any working-tree state, and the
 *     "global touchfile ⇒ run everything" behavior is tested through the
 *     pure, importable selectTests() the CLI is a thin wrapper over.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBin } from './helpers/run-bin';
import { selectTests, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = (name: string) => path.join(ROOT, 'scripts', name);
const SLUG = 'eval-cli-fixture';

let tmpHome: string;
let evalDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eval-family-'));
  // Fake gstack-slug at the cwd-relative probe path so getProjectEvalDir()
  // deterministically resolves the project-scoped dir under the temp HOME.
  const slugBin = path.join(tmpHome, '.claude', 'skills', 'gstack', 'bin');
  fs.mkdirSync(slugBin, { recursive: true });
  fs.writeFileSync(path.join(slugBin, 'gstack-slug'), `#!/usr/bin/env bash\necho "SLUG=${SLUG}"\n`, { mode: 0o755 });
  evalDir = path.join(tmpHome, '.gstack', 'projects', SLUG, 'evals');
  fs.mkdirSync(evalDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runEvalCli(script: string, ...args: string[]) {
  return runBin('bun', [SCRIPT(script), ...args], {
    cwd: tmpHome,
    home: tmpHome,
    gstackHome: path.join(tmpHome, '.gstack'),
  });
}

interface FixtureTest {
  name: string;
  passed: boolean;
  cost?: number;
  turns?: number;
  duration?: number;
}

/** Write a run file in the collector's shapes: finalized `{version}-{branch}-{tier}-{ts}.json` or `_partial-e2e.json`. */
function writeRun(dir: string, opts: {
  version?: string;
  branch?: string;
  tier?: 'e2e' | 'llm-judge';
  timestamp: string;
  tests: FixtureTest[];
  partial?: boolean;
}): string {
  const version = opts.version ?? '1.0.0';
  const branch = opts.branch ?? 'featx';
  const tier = opts.tier ?? 'e2e';
  const tests = opts.tests.map(t => ({
    name: t.name,
    suite: 'fixture',
    tier,
    passed: t.passed,
    duration_ms: t.duration ?? 1000,
    cost_usd: t.cost ?? 0.5,
    turns_used: t.turns ?? 5,
  }));
  const body = {
    schema_version: 1,
    version,
    branch,
    git_sha: 'abc1234',
    timestamp: opts.timestamp,
    hostname: 'fixture-host',
    tier,
    total_tests: tests.length,
    passed: tests.filter(t => t.passed).length,
    failed: tests.filter(t => !t.passed).length,
    total_cost_usd: tests.reduce((s, t) => s + t.cost_usd, 0),
    total_duration_ms: tests.reduce((s, t) => s + t.duration_ms, 0),
    tests,
    ...(opts.partial ? { _partial: true } : {}),
  };
  const dateStr = opts.timestamp.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const filename = opts.partial ? '_partial-e2e.json' : `${version}-${branch}-${tier}-${dateStr}.json`;
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(body, null, 2) + '\n');
  return filepath;
}

// ── eval-select ──────────────────────────────────────────────────────────────

describe('eval:select CLI (scripts/eval-select.ts)', () => {
  test('--json parses and its selection partitions the full touchfile maps', () => {
    // --base HEAD makes the committed diff empty; uncommitted/untracked files
    // in the working tree may still appear, so assert shape invariants that
    // hold for ANY tree state rather than pinning specific selections.
    const result = runBin('bun', [SCRIPT('eval-select.ts'), '--json', '--base', 'HEAD'], { cwd: ROOT });
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.base).toBe('HEAD');

    if (parsed.changed_files === 0) {
      // Pristine tree: the no-diff shape reports run-all for both tiers.
      expect(parsed.e2e).toBe('all');
      expect(parsed.llm_judge).toBe('all');
      expect(parsed.reason).toContain('all tests');
    } else {
      expect(Array.isArray(parsed.changed_files)).toBe(true);
      expect(parsed.changed_files.length).toBeGreaterThan(0);
      for (const [selection, map] of [
        [parsed.e2e, E2E_TOUCHFILES],
        [parsed.llm_judge, LLM_JUDGE_TOUCHFILES],
      ] as const) {
        const total = Object.keys(map).length;
        expect(Array.isArray(selection.selected)).toBe(true);
        expect(Array.isArray(selection.skipped)).toBe(true);
        // selected + skipped always partition the map: disjoint, complete.
        expect(selection.selected.length + selection.skipped.length).toBe(total);
        const overlap = selection.selected.filter((name: string) => selection.skipped.includes(name));
        expect(overlap).toEqual([]);
        expect(typeof selection.reason).toBe('string');
        expect(selection.count).toBe(`${selection.selected.length}/${total}`);
      }
      expect(Array.isArray(parsed.e2e.removed_tests)).toBe(true);
    }
  });

  test('human-readable mode prints the base and per-tier headers', () => {
    const result = runBin('bun', [SCRIPT('eval-select.ts'), '--base', 'HEAD'], { cwd: ROOT });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Base: HEAD');
    // Either the no-diff line or the two selection headers.
    const hasNoDiff = result.stdout.includes('No changed files detected');
    if (!hasNoDiff) {
      expect(result.stdout).toContain('E2E: selected');
      expect(result.stdout).toContain('LLM-judge: selected');
    }
  });

  test('a global-touchfile diff selects ALL tests with a global reason (pure selectTests)', () => {
    // eval-select is a thin wrapper over selectTests(); the CLI cannot be
    // pointed at a fixture repo (ROOT is hardcoded), so the run-all-on-global
    // behavior is pinned through the same imported function it calls.
    expect(GLOBAL_TOUCHFILES).toContain('test/helpers/eval-store.ts');
    const selection = selectTests(['test/helpers/eval-store.ts'], E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    expect(selection.reason).toBe('global: test/helpers/eval-store.ts');
    expect(selection.selected.sort()).toEqual(Object.keys(E2E_TOUCHFILES).sort());
    expect(selection.skipped).toEqual([]);
  });

  test('a per-test touchfile diff selects only the dependent test', () => {
    const touchfiles = {
      'test-a': ['src/feature-a.ts', 'src/shared/**'],
      'test-b': ['src/feature-b.ts'],
    };
    const globals = ['helpers/global-runner.ts'];

    const hitA = selectTests(['src/feature-a.ts'], touchfiles, globals);
    expect(hitA.selected).toEqual(['test-a']);
    expect(hitA.skipped).toEqual(['test-b']);
    expect(hitA.reason).toBe('diff');

    const hitGlob = selectTests(['src/shared/deep/util.ts'], touchfiles, globals);
    expect(hitGlob.selected).toEqual(['test-a']);

    const miss = selectTests(['docs/README.md'], touchfiles, globals);
    expect(miss.selected).toEqual([]);
    expect(miss.skipped.sort()).toEqual(['test-a', 'test-b']);
  });
});

// ── eval-list ────────────────────────────────────────────────────────────────

describe('eval:list CLI (scripts/eval-list.ts)', () => {
  test('empty eval dir prints the getting-started hint and exits 0', () => {
    const result = runEvalCli('eval-list.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No eval runs yet');
  });

  test('lists finalized runs from the flat dir AND one level of shards/<slug>/', () => {
    writeRun(evalDir, { branch: 'flat-branch', timestamp: '2026-01-01T01:00:00Z', tests: [{ name: 't1', passed: true, cost: 1.5, turns: 7 }] });
    writeRun(path.join(evalDir, 'shards', 'shard-a'), { branch: 'shard-branch', timestamp: '2026-01-02T01:00:00Z', tests: [{ name: 't2', passed: true, cost: 0.5, turns: 3 }] });

    const result = runEvalCli('eval-list.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Eval History (2 total runs)');
    expect(result.stdout).toContain('flat-branch');
    expect(result.stdout).toContain('shard-branch');
    // Sorted by timestamp descending: the shard run (newer) is listed first.
    expect(result.stdout.indexOf('shard-branch')).toBeLessThan(result.stdout.indexOf('flat-branch'));
    // Reads route to the project-scoped dir resolved via the fake gstack-slug.
    expect(result.stdout).toContain(path.join('projects', SLUG, 'evals'));
  });

  test('--branch and --tier filter the listing', () => {
    writeRun(evalDir, { branch: 'keep-me', tier: 'e2e', timestamp: '2026-01-01T01:00:00Z', tests: [{ name: 't1', passed: true }] });
    writeRun(evalDir, { branch: 'drop-me', tier: 'llm-judge', timestamp: '2026-01-02T01:00:00Z', tests: [{ name: 't2', passed: true }] });

    const byBranch = runEvalCli('eval-list.ts', '--branch', 'keep-me');
    expect(byBranch.status).toBe(0);
    expect(byBranch.stdout).toContain('Eval History (1 total runs)');
    expect(byBranch.stdout).toContain('keep-me');
    expect(byBranch.stdout).not.toContain('drop-me');

    const byTier = runEvalCli('eval-list.ts', '--tier', 'llm-judge');
    expect(byTier.status).toBe(0);
    expect(byTier.stdout).toContain('drop-me');
    expect(byTier.stdout).not.toContain('keep-me');
  });

  test('DOCUMENTS CURRENT BEHAVIOR: in-progress _partial accumulators appear in the listing', () => {
    // eval-list.ts applies NO isPartialEval filter (unlike eval-compare and
    // every baseline lookup in eval-store.ts), so the in-progress accumulator
    // is listed as if it were a run. If eval-list ever grows a partial filter,
    // update this test to assert exclusion — that would be an improvement,
    // not a regression.
    writeRun(evalDir, { branch: 'finalized-run', timestamp: '2026-01-01T01:00:00Z', tests: [{ name: 't1', passed: true }] });
    writeRun(evalDir, { branch: 'partial-sentinel', timestamp: '2026-01-03T01:00:00Z', tests: [{ name: 't1', passed: false }], partial: true });

    const result = runEvalCli('eval-list.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('finalized-run');
    expect(result.stdout).toContain('Eval History (2 total runs)');
    expect(result.stdout).toContain('partial-sentinel');
  });
});

// ── eval-compare ─────────────────────────────────────────────────────────────

describe('eval:compare CLI (scripts/eval-compare.ts)', () => {
  test('empty eval dir prints the getting-started hint and exits 0', () => {
    const result = runEvalCli('eval-compare.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No eval runs yet');
  });

  test('a single run is not enough to compare (exit 0 with guidance)', () => {
    writeRun(evalDir, { timestamp: '2026-01-01T01:00:00Z', tests: [{ name: 't1', passed: true }] });
    const result = runEvalCli('eval-compare.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Need at least 2 eval runs');
  });

  test('no args: compares the two most recent FINALIZED runs and reports deltas; the fresher partial is never a side', () => {
    writeRun(evalDir, {
      timestamp: '2026-01-01T01:00:00Z',
      tests: [
        { name: 't-stable', passed: true, cost: 1.0, turns: 5 },
        { name: 't-flaky', passed: false, cost: 1.0, turns: 5 },
        { name: 't-regressed', passed: true, cost: 1.0, turns: 5 },
      ],
    });
    writeRun(evalDir, {
      timestamp: '2026-01-02T01:00:00Z',
      tests: [
        { name: 't-stable', passed: true, cost: 1.0, turns: 5 },
        { name: 't-flaky', passed: true, cost: 1.0, turns: 5 },
        { name: 't-regressed', passed: false, cost: 1.0, turns: 5 },
      ],
    });
    // Freshest timestamp of all — if partials leaked into selection, this
    // would be picked as the "after" run (or the baseline) and its sentinel
    // branch would show up in the header line.
    writeRun(evalDir, {
      branch: 'partial-sentinel',
      timestamp: '2026-01-03T01:00:00Z',
      tests: [{ name: 't-stable', passed: false }],
      partial: true,
    });

    const result = runEvalCli('eval-compare.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('partial-sentinel');
    expect(result.stdout).toContain('1 improved');
    expect(result.stdout).toContain('1 regressed');
    expect(result.stdout).toContain('1 unchanged');
    expect(result.stdout).toContain('REGRESSION: "t-regressed" was passing, now fails.');
    expect(result.stdout).toContain('Fixed: "t-flaky" now passes.');
  });

  test('two explicit filenames resolve relative to the eval dir and compare in the given order', () => {
    const before = writeRun(evalDir, {
      timestamp: '2026-01-01T01:00:00Z',
      tests: [{ name: 't-x', passed: true, cost: 1.0 }],
    });
    const after = writeRun(evalDir, {
      timestamp: '2026-01-02T01:00:00Z',
      tests: [{ name: 't-x', passed: false, cost: 3.0 }],
    });

    const result = runEvalCli('eval-compare.ts', path.basename(before), path.basename(after));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 regressed');
    expect(result.stdout).toContain('REGRESSION: "t-x" was passing, now fails.');
    // Cost delta: 1.00 → 3.00 = +$2.00
    expect(result.stdout).toContain('+$2.00');
  });

  test('a missing explicit file fails with exit 1 and names the resolved path', () => {
    writeRun(evalDir, { timestamp: '2026-01-01T01:00:00Z', tests: [{ name: 't1', passed: true }] });
    writeRun(evalDir, { timestamp: '2026-01-02T01:00:00Z', tests: [{ name: 't1', passed: true }] });
    const result = runEvalCli('eval-compare.ts', 'does-not-exist.json', 'also-missing.json');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('File not found:');
    expect(result.stderr).toContain('does-not-exist.json');
  });
});

// ── eval-summary ─────────────────────────────────────────────────────────────

describe('eval:summary CLI (scripts/eval-summary.ts)', () => {
  test('empty eval dir prints the getting-started hint and exits 0', () => {
    const result = runEvalCli('eval-summary.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No eval runs yet');
  });

  test('aggregates run counts, spend, and flaky tests across tiers', () => {
    writeRun(evalDir, {
      tier: 'e2e',
      branch: 'branch-one',
      timestamp: '2026-01-01T01:00:00Z',
      tests: [
        { name: 't-flaky', passed: true, cost: 0.5, turns: 4, duration: 10_000 },
        { name: 't-solid', passed: true, cost: 0.5, turns: 6, duration: 20_000 },
      ],
    });
    writeRun(evalDir, {
      tier: 'e2e',
      branch: 'branch-one',
      timestamp: '2026-01-02T01:00:00Z',
      tests: [
        { name: 't-flaky', passed: false, cost: 1.0, turns: 8, duration: 30_000 },
        { name: 't-solid', passed: true, cost: 1.0, turns: 6, duration: 20_000 },
      ],
    });
    writeRun(evalDir, {
      tier: 'llm-judge',
      branch: 'branch-two',
      timestamp: '2026-01-03T01:00:00Z',
      tests: [{ name: 'judge-1', passed: true, cost: 0.5 }],
    });

    const result = runEvalCli('eval-summary.ts');
    expect(result.status).toBe(0);
    // 3 runs total: 2 e2e + 1 llm-judge.
    expect(result.stdout).toContain('3 (2 e2e, 1 llm-judge)');
    // Total spend: (0.5+0.5) + (1.0+1.0) + 0.5 = 3.50
    expect(result.stdout).toContain('$3.50');
    // t-flaky passed once and failed once → flagged flaky, keyed by tier.
    expect(result.stdout).toContain('Flaky tests (1):');
    expect(result.stdout).toContain('e2e:t-flaky');
    expect(result.stdout).not.toContain('e2e:t-solid');
    // Date range spans first → last timestamp.
    expect(result.stdout).toContain('2026-01-01 01:00');
    expect(result.stdout).toContain('2026-01-03 01:00');
    expect(result.stdout).toContain(path.join('projects', SLUG, 'evals'));
  });
});
