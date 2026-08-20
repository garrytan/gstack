#!/usr/bin/env bun
/**
 * test-free-shards — enumerate, shard, curate, and run the free test suite.
 *
 * Four jobs:
 *   1. Enumeration. Walk `browse/test/`, `test/`, `make-pdf/test/` and return
 *      every `*.test.{ts,tsx,js,jsx,mjs,cjs}` that isn't a paid-eval test.
 *   2. Sharding. Stable-hash assign each test to one of N shards. Used by CI
 *      to parallelize the free suite when needed.
 *   3. Curation (Windows-safe filter). Scan each test's content for POSIX-only
 *      patterns (`/bin/bash`, `sh -c`, raw `/tmp/`, `chmod`, `xargs`). Files
 *      that match are excluded from the Windows-safe subset — they would fail
 *      on `windows-latest` no matter how the runner shards them.
 *   4. Execution. Spawn `bun test` children and refuse to trust their exit
 *      code alone: every byte of output is classified through
 *      scripts/test-strict-output.ts, so a child that exits 0 without bun's
 *      terminal summary (a mid-suite process.exit truncation), with `(fail)`
 *      result lines, or with fewer files run than planned is a FAILURE. An
 *      external wall-clock timeout SIGKILLs the child's process group and
 *      reports the shard as timed-out — distinct from failed.
 *
 * Execution strategy (decision ledger V3/D6 — evaluate the Bun built-in
 * first; probed 2026-08 on Bun 1.3.13):
 *   - Full-suite runs (`bun test` via package.json, `bun run test:free`) use
 *     N CONCURRENT SHARD PROCESSES, serial within each (the paid runner's
 *     model). A single `--parallel` invocation was probed and initially
 *     adopted, then abandoned: three distinct Bun 1.3.13 worker pathologies
 *     (segfault + crash-retry wedge, skipped-file hooks stalling a worker,
 *     spawn-heavy files hanging under load) each stalled the whole
 *     invocation, while process shards isolate any wedge to its own shard.
 *     Original --parallel probe results, kept for the record: it
 *     showed --parallel (a) prints the standard `Ran N tests across M files`
 *     terminal summary, (b) exits non-zero when any file fails, (c) runs each
 *     file in its own worker process (distinct pids, no shared globals), and
 *     (d) converts a mid-suite process.exit(0) — which silently truncates a
 *     serial run at exit 0 — into a per-file `(crashed: exited)` failure with
 *     a complete summary and exit 1. Strictly SAFER than the serial path and
 *     ~2x faster on a 6-file probe (0.22s -> 0.11s wall, 280% CPU); the win
 *     grows with suite size since the serial suite measured 454s.
 *   - CI-matrix runs (`--shards M --shard i`) keep the hash-partitioned
 *     one-child-per-shard path. Cross-runner partitioning must be
 *     deterministic and per-file stable, so bun's own `--shard=M/N`
 *     (round-robin over sorted paths — every assignment shifts when a file
 *     lands) is not used, and there are no static per-file weight lists.
 *     Shard indices are STABLE: assignFilesToShards never renumbers on
 *     occupancy, and an empty shard is a fast no-op success.
 *
 * Adapted from the McGluut/gstack fork's test-free-shards.ts (190 LOC). The
 * Windows-safe filter is upstream-original — codex flagged that sharding alone
 * doesn't fix POSIX-bound tests, so we curate the subset that actually runs
 * on the windows-latest CI job.
 *
 * Output contract (v1.66): the full child stream ALWAYS lands in a per-run
 * log file under os.tmpdir() (path printed once at start and again in the
 * epilogue). The console is quiet by default — only the runner's own
 * [test:free] lines, `(fail)` result lines, bun error/crash markers
 * (`error:`, `panic:`, `crashed`, `Unhandled error`), and the terminal
 * `Ran N tests across M files` summary reach it; `--verbose` restores full
 * forwarding. After every run a stable epilogue names the failing tests
 * (attributed to files via bun's `path/to/file.test.ts:` chunk headers),
 * crashed+retried workers, and — on a wall-timeout kill — the wedge-suspect
 * files. The strict classifier consumes the FULL stream regardless of what
 * the console shows.
 *
 * Exit codes: 0 pass, 1 fail, 124 wall-clock timeout.
 *
 * Usage:
 *   bun run scripts/test-free-shards.ts                            # full suite, N concurrent shard processes
 *   bun run scripts/test-free-shards.ts --list                     # show all
 *   bun run scripts/test-free-shards.ts --windows-only --list      # show curated
 *   bun run scripts/test-free-shards.ts --windows-only             # run curated
 *   bun run scripts/test-free-shards.ts --shards 4 --shard 1       # one shard (CI matrix)
 *   bun run scripts/test-free-shards.ts --wall-timeout 600         # override the kill deadline
 *   bun run scripts/test-free-shards.ts --verbose                  # forward the full child stream
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { isPaidTestFile } from '../test/helpers/paid-test-set';
import {
  BunTestOutputClassifier,
  exactTestFileSelectors,
  installChildSignalForwarding,
  isTerminationRequested,
  killProcessGroup,
  strictTestExitCode,
  stripAnsiLine,
} from './test-strict-output';

const ROOT = path.resolve(import.meta.dir, '..');
// design/test was silently absent from BOTH the package.json test script and
// this list — design tests (including a teardown bomb) never ran in any CI
// or local free run. Keep the two lists in sync. This list is the single
// source of truth for free-suite roots: package.json's `test` script routes
// through this runner rather than passing its own directory globs.
export const TEST_ROOTS = [
  'browse/test',
  'test',
  'make-pdf/test',
  'design/test',
  // v1.65 orphan wire-in (decision D3a): these ran under NO script or CI —
  // written coverage that caught nothing. All were green on arrival.
  'ios-qa/daemon/test',
  'ios-qa/scripts',
  'browser-skills',
] as const;
const TEST_FILE_REGEX = /\.test\.(?:[cm]?[jt]s|tsx|jsx)$/;

// POSIX-only patterns that indicate a test will fail on windows-latest no
// matter how the runner shards. Codex's v1.18.0.0 review flagged the first
// three as concrete examples in the existing free suite (test/ship-version-sync.test.ts:72,
// test/helpers/providers/claude.ts:22, package.json:12). We scan the test's
// own content here so the filter stays automatic as new tests land. The
// "Windows-incompatible APIs" patterns at the bottom were added after the
// first windows-free-tests CI run surfaced concrete failure modes.
const WINDOWS_FRAGILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Hardcoded POSIX shells / commands.
  { pattern: /['"`]\/bin\/(?:ba)?sh/, reason: 'hardcoded /bin/sh or /bin/bash' },
  { pattern: /spawnSync\(['"]sh['"],|spawn\(['"]sh['"],|exec\(['"]sh /, reason: 'spawn("sh", ...)' },
  { pattern: /['"]bash -c['"]|['"]sh -c['"]/, reason: 'bash -c / sh -c' },
  { pattern: /['"`]\/tmp\//, reason: 'raw /tmp/ path (use os.tmpdir())' },
  { pattern: /['"]chmod\b/, reason: 'chmod shell command' },
  { pattern: /['"]xargs\b/, reason: 'xargs pipeline' },
  { pattern: /\bwhich claude\b/, reason: 'which claude (use Bun.which)' },
  // Windows-incompatible APIs.
  { pattern: /\.mode\s*&\s*0o[0-7]+/, reason: 'POSIX file mode bitmask (mode & 0o600 etc — Windows fakes mode bits)' },
  { pattern: /\.endsWith\(['"]\//, reason: 'hardcoded forward-slash path assertion (Windows uses \\\\)' },
  { pattern: /['"]\.\/[a-zA-Z][^"']*['"]\)\s*\.\s*toBe\(true\)/, reason: 'forward-slash path comparison' },
  // Tests that spawn a bash shebang script in bin/ via spawnSync. Git Bash on
  // Windows can run `bash /path/to/script` but spawnSync(scriptPath, ...)
  // tries to execute the file directly via CreateProcess, which fails on the
  // shebang. The pattern matches `, 'bin'` as a path-join argument (closing
  // OR followed by another segment), which catches:
  //   - path.join(ROOT, 'bin', 'script-name')        — typical
  //   - join(import.meta.dir, '..', 'bin', 'name')   — destructured (diff-scope)
  //   - path.join(ROOT, 'bin')                       — bare BIN constant (brain-sync)
  { pattern: /,\s*['"]bin['"]\s*[,)]|['"]\.?\/?bin\/[a-z][\w-]+['"]/, reason: 'spawns bin/ shebang script (Windows CreateProcess does not parse shebangs)' },
  // Tests that launch a real Playwright browser. The windows-free-tests CI job
  // runs a curated subset that intentionally does NOT install Chromium —
  // browser bring-up on Windows is a separate concern (see PR #1238). Tests
  // matching `await foo.launch(` need Chromium and fail with "Executable
  // doesn't exist" on the runner.
  { pattern: /await\s+\w+\.launch\(/, reason: 'launches Playwright browser (Chromium not installed in windows-free CI)' },
  // Tests that spawn the browse server as a subprocess via `bun run server.ts`.
  // The Bun → server.ts → Playwright path is the same one that doesn't work
  // on Windows (PR #1238 windows-pty-bun-pty-fix). Tests typically set
  // BROWSE_HEADLESS_SKIP=1 to skip the browser launch but still need a working
  // server, which they don't get on Windows.
  { pattern: /BROWSE_HEADLESS_SKIP|spawn\(\[['"]bun['"],\s*['"]run['"]/, reason: 'spawns the browse server subprocess (Bun-driven path is Windows-broken)' },
];

// Explicit known-Windows-incompatible test files that don't fit a regex
// pattern. Listed here with the precise reason. Prefer adding a pattern above
// when possible; this list is for environment-/runtime-specific tests where
// the failure mode is structural rather than detectable via source-file scan.
export const KNOWN_WINDOWS_INCOMPATIBLE: Array<{ file: string; reason: string }> = [
  {
    file: 'test/host-config.test.ts',
    reason: 'asserts "claude" binary on PATH (only true when running inside Claude Code, not on bare CI runner)',
  },
  {
    file: 'browse/test/findport.test.ts',
    reason: 'asserts Bun.serve.stop() is fire-and-forget — Bun behavior differs on Windows for this polyfill',
  },
  // First full run of the expanded lane (v1.66, 13 → ~258 files) surfaced
  // seven POSIX-bound files the content patterns cannot see (their
  // POSIX-ness is what they TEST, or arrives via a variable). Receipts:
  // PR #2593 windows-free-tests run 31918591602.
  {
    file: 'test/codex-under-codex-detection.test.ts',
    reason: 'drives the rendered preflight bash under a hardcoded POSIX PATH (/usr/bin:/bin) — bash is unreachable through that PATH on Windows, so every case sees empty output (v1.67 windows lane run 95234224148)',
  },
  {
    file: 'test/regression-pr1169-build-app-sed.test.ts',
    reason: 'tests sed escape sequences in build-app.sh — sed/bash are the subject under test',
  },
  {
    file: 'test/setup-conductor-worktree.test.ts',
    reason: 'tests ln -snf symlink semantics in the setup script — POSIX ln is the subject under test',
  },
  {
    file: 'test/artifacts-init-migration.test.ts',
    reason: 'runs a bash migration script + jq against a scaffolded git state — POSIX toolchain paths break under cmd spawn',
  },
  {
    file: 'test/gstack-decision-semantic.test.ts',
    reason: 'installs a fake gbrain SHEBANG SHIM on PATH; Windows spawn cannot exec shebang scripts',
  },
  {
    file: 'test/question-log-hook.test.ts',
    reason: 'spawns the PostToolUse hook script (bash shebang) directly; Windows spawn cannot exec it',
  },
  {
    file: 'browse/test/browser-skills-e2e.test.ts',
    reason: 'asserts forward-slash tier paths (<repo>/browser-skills/) that resolve with backslashes on Windows',
  },
  {
    file: 'design/test/variants-retry-after.test.ts',
    reason: 'wall-clock retry-timing assertions — flaky on the slow windows-latest runner even with widened bounds',
  },
  // Round-2 census (PR #2593 run 31919227507) after the first seven:
  {
    file: 'test/skill-census.test.ts',
    reason: 'census walk throws at module load on Windows (skill-census.ts:63) — the skills-tree symlink layout needs Developer Mode that CI runners lack',
  },
  {
    file: 'browse/test/browser-manager-unit.test.ts',
    reason: 'wedges the shard to its wall deadline on windows-latest (in-flight at kill); needs a Windows repro to diagnose — macOS + Linux lanes cover the file',
  },
  // Round-3 census (PR #2593 run 31919871680): the round-2 wedge had been
  // TRUNCATING its shard, so these seven only surfaced once shard 2 completed.
  // All the same POSIX-environment classes: PID/cmdline identity probing,
  // bash scripts as the subject under test, env-scrubbed child spawns.
  {
    file: 'browse/test/server-embedder-terminal-port.test.ts',
    reason: 'identity-based terminal-agent kill probes PID/cmdline with POSIX semantics; teardown asserts fail on windows-latest',
  },
  {
    file: 'design/test/daemon-discovery.test.ts',
    reason: 'verifyIdentity matches a spawned daemon via /proc-style cmdline probing — POSIX identity semantics',
  },
  {
    file: 'test/context-save-hardening.test.ts',
    reason: 'bash context-save/migration scripts (HOME-unset semantics, random-suffix path) are the subject under test',
  },
  {
    file: 'test/eval-list-cli.test.ts',
    reason: 'spawns the eval:list CLI via bun with a constructed env — bun resolution fails under Windows spawn',
  },
  {
    file: 'test/memory-cache-injection.test.ts',
    reason: 'exercises hook/deny-enforcement shell scripts — POSIX toolchain is the subject under test',
  },
  {
    file: 'test/migrations-v1.65.0.0.test.ts',
    reason: 'bash migration script (bunx re-fetch, .done markers) is the subject under test',
  },
  {
    file: 'test/question-preference-hook.test.ts',
    reason: 'spawns the PreToolUse preference hook (shebang script) directly; Windows spawn cannot exec it',
  },
  // Round-4 census (PR #2593 run 31920052810): unhandled errors with no
  // (fail) lines — attributed statically (the lane had no log artifact yet).
  {
    file: 'browse/test/browser-skill-commands.test.ts',
    reason: 'spawnSkill spawns bun with a constructed env — bun resolution fails under Windows spawn (unhandled, no (fail) line)',
  },
  {
    file: 'browse/test/security-audit-r2.test.ts',
    reason: 'symlink-attack fixtures (evil-link) need Developer Mode CI runners lack; expect(toThrow) fires unhandled on Windows',
  },
];

// Force-include overrides: files a WINDOWS_FRAGILE_PATTERNS regex excludes for
// a reason that does not actually apply to them. Each entry documents WHY the
// pattern hit is a false positive — the point of these files is Windows
// coverage, so auto-excluding them defeats the regression tests they carry.
const KNOWN_WINDOWS_SAFE: Array<{ file: string; reason: string }> = [
  {
    file: 'test/setup-windows-rerun-refresh.test.ts',
    // Trips the "spawns bin/ shebang script" pattern via path.join(..., 'bin',
    // 'tool.sh') fixture paths, but every spawn goes through spawnSync('bash',
    // ['-c', ...]) — Git Bash executes it fine on windows-latest. This file IS
    // the #2444 Windows regression coverage (IS_WINDOWS=1 copy-refresh path);
    // excluding it here would keep the bug class unexercised on the one
    // platform it bites.
    reason: 'bin/ hits are fixture path segments; spawns bash explicitly — the IS_WINDOWS=1 refresh path must run on windows-latest',
  },
  {
    file: 'test/uninstall-windows-copies.test.ts',
    // Trips the "spawns bin/ shebang script" pattern via the
    // path.join(ROOT, 'bin', 'gstack-uninstall') constant, but the script is
    // always spawned through spawnSync('bash', [UNINSTALL, ...]). This file
    // carries the #2563 Windows real-dir-copy uninstall coverage — the bug
    // ONLY reproduces on the copy install shape windows-latest exercises.
    // The symlink-shape describe block self-skips on win32.
    reason: 'bin/ hit is a bash-spawned script path; #2563 real-dir uninstall coverage must run on windows-latest',
  },
  {
    file: 'browse/test/file-permissions.test.ts',
    // Trips the POSIX-mode-bitmask pattern, but every `mode & 0o777` assertion
    // is platform-guarded (win32 returns early / takes the icacls branch).
    // This file carries the win32-only icacls-by-SID regression tests, which
    // can ONLY execute on windows-latest — excluding it here means the
    // machine-account ACL lockout regression is never exercised on the one
    // platform it bricks.
    reason: 'mode-bitmask hits are POSIX-branch only; win32-only ACL regression tests must run on windows-latest',
  },
  {
    file: 'browse/test/terminal-agent-owner-watchdog.test.ts',
    // Trips the spawn(['bun','run',...]) pattern, whose reason is the
    // Playwright-bound browse server. This test spawns terminal-agent.ts,
    // which imports only fs/path/crypto + local helpers (no Playwright, no
    // PTY at module scope) and boots under Bun on Windows — the owner-PID
    // orphan leak it pins was reported on Windows (#2019).
    reason: 'spawns terminal-agent (no Playwright), not the browse server; owner-orphan leak is a Windows defect',
  },
];

export const DEFAULT_SHARD_COUNT = 20;
// Per-test timeout passed to `bun test --timeout`. 30s matches what
// package.json's `test` script used before it was repointed at this runner —
// the runner is now the single owner of that semantic.
export const FREE_TEST_TIMEOUT_MS = 30_000;
// External wall-clock deadline per spawned child (whole shard or the single
// full-suite --parallel invocation). A wedged child — a spinning main thread
// no in-process --timeout timer can interrupt — is SIGKILLed at the group
// level and reported 'timed-out', distinct from 'failed'.
// ~3.5x the observed full-suite wall (~100-160s). A wedged run should be
// killed-and-diagnosed (the epilogue prints the in-flight suspects) in
// minutes, not sat out — 15min of silence was pure diagnosis latency.
// Override per run with --wall-timeout <secs>.
export const DEFAULT_WALL_TIMEOUT_MS = 6 * 60_000;
/**
 * Full-suite shards scale their wall deadline with shard size:
 * max(DEFAULT_WALL_TIMEOUT_MS, files × PER_FILE_WALL_MS). The 6-min floor
 * keeps wedge diagnosis fast on a typical ~70-file local shard, while a
 * low-core machine (jobs=1 → the whole suite in one shard) or the Windows
 * lane (~130 files/shard) gets proportional headroom instead of a false
 * timed-out kill of a healthy run. Explicit --wall-timeout disables scaling.
 */
export const PER_FILE_WALL_MS = 5_000;
export function wallTimeoutForShard(fileCount: number, baseMs = DEFAULT_WALL_TIMEOUT_MS): number {
  return Math.max(baseMs, fileCount * PER_FILE_WALL_MS);
}
/**
 * Full-suite parallelism: leave RESERVED_CPUS cores for the parent runner +
 * OS, cap at MAX_FULL_SUITE_JOBS — beyond ~6 concurrent bun processes the
 * playwright-heavy shards contend on browser launches instead of finishing
 * sooner (measured on an M-series dev box).
 */
export const MAX_FULL_SUITE_JOBS = 6;
export const RESERVED_CPUS = 2;

/**
 * Files that crash or wedge Bun's --parallel WORKERS but run fine in a plain
 * serial process. Full-suite mode now uses shard PROCESSES (no workers), so
 * this list is inert placement-wise — retained as the paper trail of why the
 * one-invocation --parallel strategy was abandoned, and as the exclusion list
 * should anyone re-attempt it on a newer Bun.
 */
export const WORKER_HOSTILE: Record<string, string> = {
  'browse/test/security-live-playwright.test.ts':
    'Bun 1.3.13 segfaults running this file in a --parallel worker ("panic: '
    + 'Segmentation fault ... a bug in Bun"), and the crashed-worker retry then '
    + 'wedges the whole invocation past the wall clock. Passes serially.',
};

/**
 * TREE-SERIAL files: run in ONE serial shard AFTER the parallel shards.
 * Two kinds live here:
 *   - MUTATORS: tests that regenerate shared repo artifacts in place (skill
 *     SKILL.md files or the .agents/ host outputs). A shard reading those
 *     files concurrently sees a moving target — this family produced an
 *     exactly-doubled catalog estimate, golden-file drift, and a spec-sync
 *     mismatch before serialization.
 *   - RATCHET READERS: tests that MEASURE the shared tree (parity caps,
 *     size budgets). Measuring while any concurrent test regenerates is
 *     undefined behavior — two runs failed with byte-identical inflated
 *     skeletons while the tree was clean before and after, so rather than
 *     hunt every present and future mutator, the measurers get a quiet
 *     tree by construction.
 * Order within the serial shard is alphabetical (the file census is sorted
 * and the serial shard is a filter over it) — safety does NOT depend on
 * mutators-before-readers ordering; it rests on every mutator restoring
 * default state itself. (CI's --shards matrix is unaffected: each CI shard
 * has its own checkout.)
 * Keys are pinned against the live file census by test-free-shards.test.ts —
 * a renamed file fails the suite instead of silently dropping serialization.
 */
export const TREE_MUTATING: Record<string, string> = {
  'test/catalog-mode-full.test.ts': 'regenerates ALL SKILL.md in full-catalog mode, then restores',
  'test/spec-template-sync.test.ts': 'regenerates all SKILL.md in place to compare spec/SKILL.md',
  'test/gen-skill-docs-idempotency.test.ts': 'regenerates all SKILL.md twice to prove idempotency',
  'test/gen-skill-docs.test.ts': 'regenerates .agents/ (codex host) golden artifacts in place',
  'test/skill-validation.test.ts': 'regenerates .agents/ (codex host) artifacts in place (3 sites)',
  'test/gbrain-detection-override.test.ts':
    'regenerates SKILL.md in place with --respect-detection (gbrain variant), then git-restores — readers see inflated skeletons mid-window',
  'test/host-config.test.ts':
    'golden tests read .agents/.factory artifacts produced by gen-skill-docs.test.ts, and its beforeAll generates them when missing (#2532) — must not race the parallel readers or run before the mutators window',
  'test/catalog-trim.test.ts':
    'imports scripts/gen-skill-docs.ts, whose top-level body regenerates the full claude host at import time (71 files; idempotent on a fresh tree, but a stale tree gets rewritten mid-window) — same hazard class as #2532',
  // Ratchet readers (measure the tree; need it quiet):
  'test/parity-suite.test.ts': 'RATCHET READER — parity caps measure live SKILL.md/section bytes',
  'test/skill-size-budget.test.ts': 'RATCHET READER — per-skill and corpus size budgets measure the live tree',
  'test/carve-guard-completeness.test.ts': 'RATCHET READER — registry-vs-disk parity reads live sections/manifest.json files',
  'test/carve-section-ordering.test.ts': 'RATCHET READER — checkOrdering(ROOT) reads live skeletons and sections',
};

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isFreeTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!TEST_FILE_REGEX.test(normalized)) return false;
  return !isPaidTestFile(normalized);
}

/**
 * Returns the first POSIX-only pattern hit in the file, or null if Windows-safe.
 */
export function detectWindowsFragility(absolutePath: string): { reason: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }
  for (const { pattern, reason } of WINDOWS_FRAGILE_PATTERNS) {
    if (pattern.test(content)) return { reason };
  }
  return null;
}

function walkTestFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
      continue;
    }
    if (TEST_FILE_REGEX.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function collectFreeTestFiles(rootDir = ROOT): string[] {
  const discovered = new Set<string>();
  for (const testRoot of TEST_ROOTS) {
    const absoluteRoot = path.join(rootDir, testRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const fullPath of walkTestFiles(absoluteRoot)) {
      const relativePath = normalizeRelativePath(path.relative(rootDir, fullPath));
      if (isFreeTestFile(relativePath)) {
        discovered.add(relativePath);
      }
    }
  }
  return [...discovered].sort();
}

export interface CurationResult {
  safe: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function curateWindowsSafe(files: string[], rootDir = ROOT): CurationResult {
  const safe: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const knownBad = new Map(KNOWN_WINDOWS_INCOMPATIBLE.map((e) => [e.file, e.reason]));
  const knownSafe = new Set(KNOWN_WINDOWS_SAFE.map((e) => e.file));
  for (const relativePath of files) {
    const knownReason = knownBad.get(relativePath);
    if (knownReason) {
      excluded.push({ file: relativePath, reason: knownReason });
      continue;
    }
    if (knownSafe.has(relativePath)) {
      safe.push(relativePath);
      continue;
    }
    const absolute = path.join(rootDir, relativePath);
    const fragility = detectWindowsFragility(absolute);
    if (fragility) {
      excluded.push({ file: relativePath, reason: fragility.reason });
    } else {
      safe.push(relativePath);
    }
  }
  return { safe, excluded };
}

export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hash-partition files across EXACTLY shardCount shards. Empty shards are
 * preserved: a file's shard index is a pure function of its own path and the
 * shard count, never of which other files happen to exist. A CI matrix keys
 * runners off the index, so filtering empty shards (the old behavior) would
 * renumber every later shard whenever occupancy shifted — runner 3 silently
 * running shard 4's files. An empty shard is instead a fast no-op success at
 * run time.
 */
export function assignFilesToShards(files: string[], shardCount: number): string[][] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error(`Shard count must be a positive integer. Received: ${shardCount}`);
  }

  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  for (const file of files) {
    const shardIndex = stableHash(file) % shardCount;
    shards[shardIndex].push(file);
  }

  return shards.map(filesInShard => filesInShard.sort());
}

export interface BuildShardArgsOptions {
  /**
   * Pass bun's --parallel (worker-per-file, implies --isolate). No production
   * caller today — full-suite mode uses N shard PROCESSES after the worker
   * pathologies documented in main(); retained for a future re-attempt on a
   * newer Bun (see WORKER_HOSTILE).
   */
  parallel?: boolean;
  rootDir?: string;
}

export function buildShardArgs(files: string[], options: BuildShardArgsOptions = {}): string[] {
  // Exact absolute selectors: bun treats positional test paths as substring
  // filters, so a relative `test/x.test.ts` would ALSO select
  // `browse/test/x.test.ts` — shard bleed that double-runs files.
  const selectors = exactTestFileSelectors(files, options.rootDir ?? ROOT);
  const args = ['test', ...selectors, `--timeout=${FREE_TEST_TIMEOUT_MS}`];
  if (options.parallel) args.push('--parallel');
  else args.push('--max-concurrency=1');
  return args;
}

type CliOptions = {
  dryRun: boolean;
  listOnly: boolean;
  windowsOnly: boolean;
  verbose: boolean;
  shardCount: number;
  shardIndex: number | null;
  wallTimeoutMs: number;
  /** True when --wall-timeout was passed explicitly; full-suite mode only auto-scales the default. */
  wallTimeoutExplicit: boolean;
};

function parseCliOptions(argv: string[]): CliOptions {
  let dryRun = false;
  let listOnly = false;
  let windowsOnly = false;
  let verbose = false;
  let shardCount = DEFAULT_SHARD_COUNT;
  let shardIndex: number | null = null;
  let wallTimeoutMs = DEFAULT_WALL_TIMEOUT_MS;
  let wallTimeoutExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--list') { listOnly = true; continue; }
    if (arg === '--windows-only') { windowsOnly = true; continue; }
    if (arg === '--verbose') { verbose = true; continue; }
    if (arg === '--shards') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --shards');
      shardCount = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg === '--shard') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --shard');
      shardIndex = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg === '--wall-timeout') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--wall-timeout needs a positive integer (seconds)');
      wallTimeoutMs = value * 1000;
      wallTimeoutExplicit = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, listOnly, windowsOnly, verbose, shardCount, shardIndex, wallTimeoutMs, wallTimeoutExplicit };
}

function formatShardSummary(shards: string[][]): string[] {
  return shards.map((files, index) => {
    const preview = files.slice(0, 3).join(', ');
    const suffix = files.length > 3 ? ', ...' : '';
    return `Shard ${index + 1}/${shards.length}: ${files.length} files${preview ? ` -> ${preview}${suffix}` : ''}`;
  });
}

/**
 * True when a shard's output shows the run ended WITHOUT bun's final summary
 * ("Ran N tests across ..."). A process.exit() fired mid-suite skips the
 * summary AND hands back whatever code the caller passed — historically 0,
 * which made a truncated shard indistinguishable from a green one. Exit code
 * alone is therefore not evidence of completion; the summary line is.
 *
 * The runner itself now enforces this (and more) through
 * scripts/test-strict-output.ts inside runFreeShard; this predicate remains
 * the minimal documented primitive that test/exit-propagation.test.ts drives
 * with genuine truncated and genuine complete bun runs.
 */
export function shardRunLooksTruncated(status: number | null, output: string): boolean {
  if (status !== 0) return false; // already failing — not the silent case
  return !/Ran \d+ tests? across \d+ files?/.test(output);
}

// ---------------------------------------------------------------------------
// Output contract: console filtering + per-file failure attribution.
//
// Bun groups each file's output under a `path/to/file.test.ts:` header line
// (cwd-relative, sometimes ../-prefixed through a symlinked cwd). The
// reporter tracks the current header while consuming the stream, attributes
// `(fail)` lines and crash markers to files, and decides which lines reach
// the console in the default quiet mode. All matching happens on
// ANSI-stripped lines — colored `(fail)` lines defeated a prior grep.
// ---------------------------------------------------------------------------

const TEST_PATH_SOURCE = String.raw`\.test\.(?:[cm]?[jt]s|tsx|jsx)`;
/** A file chunk header: the path bun printed, terminated by a bare colon. */
const FILE_HEADER_RE = new RegExp(`^(\\S.*${TEST_PATH_SOURCE}):$`);
/** Same shape strict-output classifies as failed-test, with the name captured. */
const FAIL_RESULT_CAPTURE_RE = /^\(fail\) (.+) \[\d+(?:\.\d+)?(?:ns|us|µs|ms|s)\]$/;
/** bun --parallel retries a crashed worker once: `<icon> crashed running <path>, retrying`. */
const CRASH_RETRY_RE = new RegExp(`crashed running (\\S*${TEST_PATH_SOURCE}), retrying`);
/** The give-up marker after the retry also crashes: `✗ <path> (crashed: exited)`. */
const CRASH_FINAL_RE = new RegExp(`(\\S*${TEST_PATH_SOURCE}) \\(crashed: [^)]+\\)`);
const TERMINAL_SUMMARY_CAPTURE_RE = /^Ran (\d+) tests? across (\d+) files?\. \[/;
/** Substrings that must reach the console even in the default quiet mode. */
const CONSOLE_ALWAYS_MARKERS = ['error:', 'panic:', 'Unhandled error', 'crashed'] as const;

export type StreamOrigin = 'stdout' | 'stderr';

export interface FreeRunFailure {
  /** Planned relative path when attributable, else the raw header path, else null. */
  file: string | null;
  testName: string;
}

export interface FreeRunReport {
  testsRan: number | null;
  filesRan: number | null;
  sawTerminalSummary: boolean;
  /** Deduped `(fail)` lines in arrival order, attributed to the current file header. */
  failures: FreeRunFailure[];
  /** Files that crashed a worker (bun retries once; a second crash is final). Deduped. */
  crashedFiles: string[];
  /**
   * "# Unhandled error between tests" markers, attributed to the chunk they
   * appeared in. These fail the shard via the strict classifier but produce
   * NO (fail) lines — without surfacing them here, the epilogue reads
   * "FAIL — 0 failing test(s)" and the culprit is undiscoverable from CI
   * output (first Windows lane run: a module-load throw in skill-census).
   */
  unhandledErrors: Array<{ file: string | null }>;
  /**
   * Wedge-suspect heuristic for a wall-timeout kill: files whose header was
   * seen but whose chunk never ENDED (chunk end = the next file's header, or
   * a final crash marker) before the terminal summary — i.e. "started but
   * never produced a result chunk end". Result lines deliberately do NOT end
   * a chunk: a file that printed a fail and then wedged stays listed. Known
   * limits of the approximation:
   *   - Serial (--shard CI path): bun streams live but prints a file's header
   *     lazily, on its first output line — a wedged file that printed ANY
   *     line is listed; a fully silent wedge is not.
   *   - Parallel (full-suite path): bun buffers a file's whole chunk until it
   *     COMPLETES, so a wedged file usually never prints a header (see
   *     filesWithNoOutput), and the LAST flushed chunk before the kill has no
   *     closing header, so one completed noisy file can be over-listed.
   */
  inFlight: string[];
  /** Planned files never observed in the stream (silent passers + never-flushed wedges). */
  filesWithNoOutput: number;
}

interface FileProgress {
  headerSeen: boolean;
  /** The file's chunk ended: a later file's header arrived, or it crashed out. */
  ended: boolean;
}

/**
 * Incrementally consumes the child's stdout/stderr (chunk boundaries need not
 * align to lines), attributing results to files and forwarding only
 * always-visible lines to `forward` (omit `forward` for verbose/quiet modes —
 * attribution still runs so the epilogue works in every mode).
 */
export class FreeRunReporter {
  private readonly decoders: Record<StreamOrigin, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  private readonly pending: Record<StreamOrigin, string> = { stdout: '', stderr: '' };
  private readonly plannedSet: Set<string>;
  private readonly canonicalCache = new Map<string, string>();
  private readonly progress = new Map<string, FileProgress>();
  private readonly failureKeys = new Set<string>();
  private readonly failures: FreeRunFailure[] = [];
  private readonly crashed = new Set<string>();
  private currentFile: string | null = null;
  private inRecap = false;
  private readonly unhandled: Array<{ file: string | null }> = [];
  private testsRan: number | null = null;
  private filesRan: number | null = null;
  private sawSummary = false;

  constructor(
    private readonly plannedFiles: string[],
    private readonly forward?: (text: string, origin: StreamOrigin) => void,
  ) {
    this.plannedSet = new Set(plannedFiles.map(normalizeRelativePath));
  }

  write(chunk: Uint8Array | string, origin: StreamOrigin): void {
    this.pending[origin] += typeof chunk === 'string'
      ? chunk
      : this.decoders[origin].write(Buffer.from(chunk));
    let newline = this.pending[origin].indexOf('\n');
    while (newline !== -1) {
      this.handleLine(this.pending[origin].slice(0, newline), origin);
      this.pending[origin] = this.pending[origin].slice(newline + 1);
      newline = this.pending[origin].indexOf('\n');
    }
  }

  /** Flush partial trailing lines (a stream killed mid-line still classifies). */
  end(): void {
    for (const origin of ['stdout', 'stderr'] as const) {
      this.pending[origin] += this.decoders[origin].end();
      if (this.pending[origin].length > 0) this.handleLine(this.pending[origin], origin);
      this.pending[origin] = '';
    }
  }

  report(): FreeRunReport {
    const inFlight = this.sawSummary
      ? []
      : [...this.progress.entries()]
          .filter(([, p]) => p.headerSeen && !p.ended)
          .map(([file]) => file)
          .sort();
    return {
      testsRan: this.testsRan,
      filesRan: this.filesRan,
      sawTerminalSummary: this.sawSummary,
      failures: [...this.failures],
      crashedFiles: [...this.crashed].sort(),
      unhandledErrors: [...this.unhandled],
      inFlight,
      filesWithNoOutput: this.plannedFiles.filter((f) => !this.progress.has(normalizeRelativePath(f))).length,
    };
  }

  private handleLine(rawLine: string, origin: StreamOrigin): void {
    // GitHub Actions: bun wraps each file's section in ::group::<header>.
    // Without stripping, the real header fails FILE_HEADER_RE, failures get
    // attributed to the PREVIOUS file, and the terminal recap's re-printed
    // (fail) lines land under a second phantom file (observed on the first
    // Linux run: 5 real failures reported as 10 across 2 files).
    const line = stripAnsiLine(rawLine).replace(/^::group::/, '');
    let visible = false;

    // Bun's terminal recap ("N tests failed:") re-prints every (fail) line
    // WITHOUT re-printing file headers. Attributing those to the stale
    // currentFile invented a phantom failing file on the first Linux run
    // (5 real failures reported as 10 across 2 files, one innocent).
    if (/^\d+ tests? failed:$/.test(line)) {
      this.inRecap = true;
      if (this.currentFile) this.progressFor(this.currentFile).ended = true;
      this.currentFile = null;
    }

    if (line === '# Unhandled error between tests') {
      this.unhandled.push({ file: this.currentFile });
    }

    const header = FILE_HEADER_RE.exec(line);
    if (header) {
      const file = this.canonicalize(header[1]);
      // A new header ends the previous file's chunk — that file is no longer
      // a wedge suspect. (Bun 1.3.x prints NO (pass) lines, so chunk
      // delimiters, not result lines, are the completion signal.)
      if (this.currentFile && this.currentFile !== file) this.progressFor(this.currentFile).ended = true;
      this.currentFile = file;
      this.progressFor(file).headerSeen = true;
    } else {
      const fail = FAIL_RESULT_CAPTURE_RE.exec(line);
      const retry = fail ? null : CRASH_RETRY_RE.exec(line);
      const final = fail || retry ? null : CRASH_FINAL_RE.exec(line);
      if (fail) {
        visible = true;
        // In the recap, a (fail) line only records a failure the main run
        // somehow never attributed (belt and braces); known names dedupe.
        const recapDuplicate = this.inRecap
          && this.failures.some((f) => f.testName === fail[1]);
        const key = `${this.currentFile ?? ''}\u0000${fail[1]}`;
        if (!recapDuplicate && !this.failureKeys.has(key)) {
          this.failureKeys.add(key);
          this.failures.push({ file: this.currentFile, testName: fail[1] });
        }
      } else if (retry) {
        // The file will run again — a crash+retry does not end its chunk.
        visible = true;
        this.crashed.add(this.canonicalize(retry[1]));
      } else if (final) {
        visible = true;
        const file = this.canonicalize(final[1]);
        this.crashed.add(file);
        this.progressFor(file).ended = true;
      } else {
        const summary = TERMINAL_SUMMARY_CAPTURE_RE.exec(line);
        if (summary) {
          visible = true;
          this.sawSummary = true;
          this.testsRan = Number.parseInt(summary[1], 10);
          this.filesRan = Number.parseInt(summary[2], 10);
        }
      }
    }

    if (!visible) visible = CONSOLE_ALWAYS_MARKERS.some((marker) => line.includes(marker));
    if (visible && this.forward) this.forward(`${rawLine.replace(/\r$/, '')}\n`, origin);
  }

  private progressFor(file: string): FileProgress {
    let entry = this.progress.get(file);
    if (!entry) {
      entry = { headerSeen: false, ended: false };
      this.progress.set(file, entry);
    }
    return entry;
  }

  /**
   * Map a printed path back to its planned relative path. Bun prints paths
   * relative to the child's (real)cwd, so a symlinked cwd (macOS /tmp) yields
   * `../..`-prefixed forms — strip the prefix and suffix-match.
   */
  private canonicalize(printedPath: string): string {
    const cached = this.canonicalCache.get(printedPath);
    if (cached) return cached;
    const stripped = normalizeRelativePath(printedPath).replace(/^(?:\.{1,2}\/)+/, '');
    let resolved = stripped;
    if (!this.plannedSet.has(stripped)) {
      const match = this.plannedFiles.find(
        (planned) => stripped.endsWith(`/${planned}`) || planned.endsWith(`/${stripped}`),
      );
      if (match) resolved = match;
    }
    this.canonicalCache.set(printedPath, resolved);
    return resolved;
  }
}

/**
 * The stable post-run epilogue. Success is one line; failure names every
 * failing test (deduped, attributed) and crashed worker; a wall-timeout kill
 * additionally prints the wedge-suspect list (see FreeRunReport.inFlight for
 * the heuristic and its limits).
 */
export function buildRunEpilogue(
  status: FreeShardStatus,
  report: FreeRunReport,
  elapsedMs: number,
  logPath: string,
): string[] {
  const seconds = Math.round(elapsedMs / 1000);
  if (status === 'passed') {
    return [
      `[test:free] PASS — ${report.testsRan ?? '?'} tests, ${report.filesRan ?? '?'} files, ${seconds}s. Full log: ${logPath}`,
    ];
  }
  const failingFiles = new Set(report.failures.map((f) => f.file ?? '(unattributed)'));
  const lines = [
    `[test:free] FAIL — ${report.failures.length} failing test(s) in ${failingFiles.size} file(s), `
    + `${report.crashedFiles.length} crashed worker(s)${report.unhandledErrors.length > 0 ? `, ${report.unhandledErrors.length} unhandled error(s) between tests` : ''}. Full log: ${logPath}`,
  ];
  for (const failure of report.failures) {
    lines.push(`  ✗ ${failure.file ?? '(unattributed)'} — ${failure.testName}`);
  }
  for (const file of report.crashedFiles) {
    lines.push(`  ⚠ crashed+retried: ${file}`);
  }
  for (const u of report.unhandledErrors) {
    lines.push(`  ⚠ unhandled error between tests (around ${u.file ?? 'unknown file'})`);
  }
  if (status === 'timed-out') {
    if (report.inFlight.length > 0) {
      lines.push(`  ⏱ in flight at kill: ${report.inFlight.join(', ')}`);
    } else {
      lines.push(
        '  ⏱ in flight at kill: unknown — no open file chunk was observed '
        + '(bun --parallel buffers a file\'s output until it completes, so a silent wedge never prints); '
        + `${report.filesWithNoOutput} planned file(s) produced no output before the kill.`,
      );
    }
  }
  return lines;
}

export type FreeShardStatus = 'passed' | 'failed' | 'timed-out';

export interface FreeShardOutcome {
  shard: number;
  files: string[];
  status: FreeShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
}

export interface ShardCommand {
  command: string;
  args: string[];
}

export interface RunFreeShardOptions {
  /** External wall-clock deadline; on expiry the child's process GROUP is SIGKILLed. */
  wallTimeoutMs?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Pass bun's --parallel. No production caller today (see BuildShardArgsOptions.parallel). */
  parallel?: boolean;
  /** Override the spawned command. Tests inject fake pass/fail/slow commands. */
  commandFor?: (files: string[]) => ShardCommand;
  /** Suppress ALL child output from the console (tests). The classifier and the log file still see every byte. */
  quiet?: boolean;
  /** Forward the full child stream to the console (legacy firehose). Default: the quiet filtered console. */
  verbose?: boolean;
  /**
   * Console sink for child-stream output (tests inject to assert quiet vs
   * verbose behavior). Default: process.stdout / process.stderr by origin.
   * Runner-owned [test:free] lines go through `log`, not this sink.
   */
  consoleWrite?: (text: string) => void;
  /** Per-run full-stream log path (tests inject). Default: a timestamped file under os.tmpdir(). */
  logFilePath?: string;
  log?: (line: string) => void;
}

const EPILOGUE_WORD: Record<FreeShardStatus, string> = {
  passed: 'pass',
  failed: 'fail',
  'timed-out': 'timed-out',
};

/** One line per shard, printed after the run: `[test:free] shard i/N: M files, XXs, pass|fail|timed-out`. */
function shardEpilogue(outcome: FreeShardOutcome, totalShards: number): string {
  return `[test:free] shard ${outcome.shard}/${totalShards}: ${outcome.files.length} files, `
    + `${Math.round(outcome.elapsedMs / 1000)}s, ${EPILOGUE_WORD[outcome.status]}`;
}

/**
 * Run one shard (or the whole suite, in --parallel full-suite mode) in its own
 * bun process and classify the result strictly.
 *
 * Verdict integrity: the child's exit code is never trusted alone. Output is
 * fed through BunTestOutputClassifier, and strictTestExitCode requires bun's
 * terminal summary to report EXACTLY the planned file count — a shard that
 * exits 0 without the summary (mid-suite process.exit truncation), with
 * `(fail)` result lines, or having run fewer files than planned is a FAILURE.
 * This is enforced for injected fake commands too (unlike the paid runner),
 * so tests can pin the summary-missing => failure backstop; fake passing
 * commands must print a synthetic `Ran N tests across M files. [Xms]` line.
 *
 * Per-shard temp isolation: each spawned child gets its own throwaway TMPDIR
 * (TEMP/TMP on Windows) so shards can't trip over each other's temp files.
 * Deliberately NOT GSTACK_HOME: injecting one shared scratch home for a whole
 * invocation made 6,900 tests share a MUTABLE state dir — config tests wrote
 * keys into it and relink/update-check tests then read them (measured: 12
 * cross-contamination failures on the first full run). Tests that need
 * GSTACK_HOME isolation mkdtemp their own per test — the repo convention —
 * and the hermetic-env machinery covers E2E children.
 */
export async function runFreeShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunFreeShardOptions = {},
): Promise<FreeShardOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:free] shard ${shardNumber}/${totalShards}`;

  // Empty shard = fast no-op SUCCESS. Indices are stable for the CI matrix,
  // so an unoccupied index must not fail or shift work to a different runner.
  if (files.length === 0) {
    const outcome: FreeShardOutcome = {
      shard: shardNumber, files: [], status: 'passed', exitCode: 0, elapsedMs: 0, groupPid: null,
    };
    log(shardEpilogue(outcome, totalShards));
    return outcome;
  }

  const rootDir = options.rootDir ?? ROOT;
  const wallTimeoutMs = options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  log(`${label} (${files.length} files${options.parallel ? ', bun --parallel' : ''})`);

  // Full-stream capture: EVERY child byte lands here, whatever the console
  // shows. Printed once at start so a wedged or noisy run is inspectable
  // without a re-run.
  const logPath = options.logFilePath ?? nextDefaultLogPath();
  const logStream = fs.createWriteStream(logPath);
  let logWriteFailed = false;
  logStream.on('error', (err) => {
    if (logWriteFailed) return;
    logWriteFailed = true;
    console.error(`${label} could not write the full log at ${logPath}: ${err.message}`);
  });
  log(`[test:free] full log: ${logPath}`);

  const { command, args } = options.commandFor
    ? options.commandFor(files)
    : { command: process.execPath, args: buildShardArgs(files, { parallel: options.parallel, rootDir }) };

  const env = { ...(options.env ?? process.env) };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-free-shard-'));
  const childTmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(childTmp);
  env.TMPDIR = childTmp;
  env.TEMP = childTmp;
  env.TMP = childTmp;

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const groupPid = child.pid ?? null;
  // Group-kill on parent SIGINT/SIGTERM too, not just on timeout.
  const forwarding = installChildSignalForwarding({
    kill: (signal?: NodeJS.Signals | number) => {
      killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
      return true;
    },
  });

  const classifier = new BunTestOutputClassifier();

  // Console policy: quiet => nothing; verbose => the raw firehose; default =>
  // only always-visible lines (fail results, crash markers, error/panic
  // markers, the terminal summary), selected by the reporter. The reporter
  // consumes the stream in EVERY mode so the epilogue can attribute failures.
  const emitToConsole = (text: string, origin: StreamOrigin): void => {
    if (options.quiet) return;
    if (options.consoleWrite) {
      options.consoleWrite(text);
      return;
    }
    (origin === 'stdout' ? process.stdout : process.stderr).write(text);
  };
  const reporter = new FreeRunReporter(files, options.verbose ? undefined : emitToConsole);

  const consumeStream = (stream: NodeJS.ReadableStream, origin: StreamOrigin): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer | string) => {
        classifier.write(chunk, origin); // strict verdict ALWAYS sees the full stream
        if (!logWriteFailed) logStream.write(chunk);
        reporter.write(chunk, origin);
        if (options.verbose) emitToConsole(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), origin);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGKILL');
  }, wallTimeoutMs);

  let exitCode: number | null = null;
  try {
    const streams: Array<Promise<void>> = [];
    if (child.stdout) streams.push(consumeStream(child.stdout, 'stdout'));
    if (child.stderr) streams.push(consumeStream(child.stderr, 'stderr'));
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    await Promise.all(streams);
  } finally {
    clearTimeout(killTimer);
    forwarding.dispose();
    // Reap survivors of this shard even on the clean path.
    killProcessGroup(child, 'SIGKILL');
    reporter.end();
    await new Promise<void>((resolve) => logStream.end(() => resolve()));
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of a throwaway temp dir — a locked file on
      // Windows must not turn a real verdict into an exception.
    }
  }

  const summary = classifier.end();
  const status: FreeShardStatus = timedOut
    ? 'timed-out'
    : strictTestExitCode(exitCode ?? 1, summary, files.length) === 0 ? 'passed' : 'failed';

  if (status === 'timed-out') {
    console.error(
      `${label} exceeded the ${Math.round(wallTimeoutMs / 1000)}s wall-clock deadline — `
      + 'killed the process group. Reporting as TIMED-OUT (distinct from failed).',
    );
  } else if (status === 'failed' && (exitCode ?? 1) === 0) {
    const reason = summary.failedTests > 0 || summary.unhandledBetweenTests > 0
      ? `printed ${summary.failedTests} failing result(s) and ${summary.unhandledBetweenTests} unhandled error(s) between tests`
      : summary.terminalFileCounts.length === 0
        ? "never printed bun's terminal summary — the run was truncated (a process.exit fired mid-suite)"
        : `bun's summary reported ${summary.terminalFileCounts.join(', ')} file(s), expected ${files.length}`;
    console.error(`${label} exited 0 but ${reason}. Treating as FAILED.`);
  } else if (status === 'failed') {
    console.error(`${label} failed with exit code ${exitCode ?? 'signal'}`);
  }

  const outcome: FreeShardOutcome = {
    shard: shardNumber, files, status, exitCode, elapsedMs: Date.now() - startedAt, groupPid,
  };
  log(shardEpilogue(outcome, totalShards));
  for (const line of buildRunEpilogue(status, reporter.report(), outcome.elapsedMs, logPath)) log(line);
  return outcome;
}

let logPathSequence = 0;

/** Timestamped per-run log file under os.tmpdir(); pid+sequence defeat same-ms collisions. */
function nextDefaultLogPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logPathSequence += 1;
  return path.join(os.tmpdir(), `gstack-free-test-${stamp}-${process.pid}-${logPathSequence}.log`);
}

function exitCodeFor(status: FreeShardStatus): number {
  if (status === 'passed') return 0;
  return status === 'timed-out' ? 124 : 1;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const allFiles = collectFreeTestFiles();
  if (allFiles.length === 0) {
    throw new Error('No free test files were discovered.');
  }

  let files = allFiles;
  let curationReport: CurationResult | null = null;
  if (options.windowsOnly) {
    curationReport = curateWindowsSafe(allFiles);
    files = curationReport.safe;
    console.log(`[test:free] curated ${files.length} Windows-safe tests (${curationReport.excluded.length} excluded)`);
    if (options.listOnly && curationReport.excluded.length > 0) {
      console.log('\nExcluded (POSIX-fragile):');
      for (const { file, reason } of curationReport.excluded) {
        console.log(`  - ${file}  [${reason}]`);
      }
    }
  }

  if (options.listOnly) {
    console.log(`\nDiscovered ${files.length} test files.`);
    for (const file of files) console.log(`  ${file}`);
    return 0;
  }

  if (options.dryRun) {
    const shards = assignFilesToShards(files, options.shardCount);
    const occupied = shards.filter((s) => s.length > 0).length;
    console.log(
      `\nWould run ${files.length} files across ${shards.length} shards (${occupied} occupied). `
      + 'Without --shard, the full suite runs as N concurrent shard processes '
      + '(plus a serial tree-mutating shard) instead.',
    );
    for (const line of formatShardSummary(shards)) console.log(line);
    return 0;
  }

  if (options.shardIndex !== null) {
    // Bounds-check against the REQUESTED shard count, not post-assignment
    // occupancy — indices must be stable for a CI matrix, and an empty shard
    // is a valid fast no-op.
    if (!Number.isInteger(options.shardIndex) || options.shardIndex < 1 || options.shardIndex > options.shardCount) {
      throw new Error(`--shard must be between 1 and ${options.shardCount}. Received: ${options.shardIndex}`);
    }
    const shards = assignFilesToShards(files, options.shardCount);
    const outcome = await runFreeShard(shards[options.shardIndex - 1], options.shardIndex, options.shardCount, {
      wallTimeoutMs: options.wallTimeoutMs,
      verbose: options.verbose,
    });
    return exitCodeFor(outcome.status);
  }

  // Full-suite mode: N concurrent shard PROCESSES, serial within each — the
  // paid runner's proven model. One `bun test --parallel` invocation was
  // tried first (decision V3) and abandoned after three distinct
  // worker-runtime pathologies in a single day on Bun 1.3.13: a segfault
  // whose crashed-worker retry wedged the run (security-live-playwright), a
  // gated file's still-running file-level hooks stalling a worker
  // (compare-board), and spawn-heavy files hanging workers under load
  // (session-runner-timeout). Plain child processes have none of these:
  // proven spawn semantics, per-shard group-kill, per-shard logs, and a
  // wedge only ever costs its own shard. WORKER_HOSTILE files are moot in
  // process shards (no workers) and fold back into normal assignment.
  const jobs = Math.max(1, Math.min(MAX_FULL_SUITE_JOBS, os.cpus().length - RESERVED_CPUS));
  // Phase split: tree-mutating tests run AFTER the parallel shards, in one
  // serial shard, so no concurrent shard ever reads a half-regenerated tree.
  const mutators = files.filter((f) => f in TREE_MUTATING);
  const readers = files.filter((f) => !(f in TREE_MUTATING));
  const shards = assignFilesToShards(readers, jobs);
  const totalShards = jobs + (mutators.length > 0 ? 1 : 0);
  console.log(`[test:free] full suite: ${readers.length} files across ${jobs} shard processes`
    + (mutators.length > 0 ? `, then ${mutators.length} tree-mutating file(s) serially` : ''));
  const shardTimeout = (fileCount: number): number =>
    options.wallTimeoutExplicit ? options.wallTimeoutMs : wallTimeoutForShard(fileCount, options.wallTimeoutMs);
  const outcomes = await Promise.all(
    shards.map((shardFiles, index) => runFreeShard(shardFiles, index + 1, totalShards, {
      wallTimeoutMs: shardTimeout(shardFiles.length),
      verbose: options.verbose,
    })),
  );
  let worst = Math.max(...outcomes.map((o) => exitCodeFor(o.status)));
  // Cancellation stops the run: don't launch the serial tree-mutating shard
  // after a SIGINT/SIGTERM already killed the parallel phase.
  if (mutators.length > 0 && !isTerminationRequested()) {
    const mutatorOutcome = await runFreeShard(mutators, totalShards, totalShards, {
      wallTimeoutMs: shardTimeout(mutators.length),
      verbose: options.verbose,
    });
    worst = Math.max(worst, exitCodeFor(mutatorOutcome.status));
    if (mutatorOutcome.status !== 'passed') {
      // Mutator safety rests on each test restoring default state itself; a
      // SIGKILL at the wall deadline (or a mid-regeneration crash) defeats
      // that by construction. Say so, loudly, before someone commits
      // regenerated SKILL.md / .agents artifacts by accident.
      const dirty = spawnSyncGitStatusGenerated();
      if (dirty.length > 0) {
        console.error('[test:free] ⚠ tree-mutating shard did not finish cleanly — generated artifacts may be mid-regeneration:');
        for (const line of dirty.slice(0, 20)) console.error(`[test:free]   ${line}`);
        console.error('[test:free]   restore with: bun run gen:skill-docs (or git checkout -- <paths>)');
      }
    }
  }
  return worst;
}

/** Dirty generated artifacts (SKILL.md / host outputs) after a failed mutator shard. */
function spawnSyncGitStatusGenerated(): string[] {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\n').filter((line) =>
    /SKILL\.md$/.test(line) || line.includes('.agents/') || line.includes('.factory/'));
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[test:free] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
