#!/usr/bin/env bun
/**
 * test-free-shards — enumerate, shard, and curate the free test suite.
 *
 * Three jobs:
 *   1. Enumeration. Walk `browse/test/`, `test/`, `make-pdf/test/` and return
 *      every `*.test.{ts,tsx,js,jsx,mjs,cjs}` that isn't a paid-eval test.
 *   2. Sharding. Stable-hash assign each test to one of N shards. Used by CI
 *      to parallelize the free suite when needed.
 *   3. Curation (Windows-safe filter). Scan each test's content for POSIX-only
 *      patterns (`/bin/bash`, `sh -c`, raw `/tmp/`, `chmod`, `xargs`). Files
 *      that match are excluded from the Windows-safe subset — they would fail
 *      on `windows-latest` no matter how the runner shards them.
 *
 * Adapted from the McGluut/gstack fork's test-free-shards.ts (190 LOC). The
 * Windows-safe filter is upstream-original — codex flagged that sharding alone
 * doesn't fix POSIX-bound tests, so we curate the subset that actually runs
 * on the windows-latest CI job.
 *
 * Usage:
 *   bun run scripts/test-free-shards.ts --list                    # show all
 *   bun run scripts/test-free-shards.ts --windows-only --list     # show curated
 *   bun run scripts/test-free-shards.ts --windows-only            # run curated
 *   bun run scripts/test-free-shards.ts --shards 4 --shard 1      # one shard
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const TEST_ROOTS = ['browse/test', 'test', 'make-pdf/test'] as const;
const TEST_FILE_REGEX = /\.test\.(?:[cm]?[jt]s|tsx|jsx)$/;

// Tests that require API spend, external services, or e2e harnesses.
// These are filtered out before any sharding or curation.
const PAID_EVAL_TESTS = [
  /^browse\/test\/security-review-fullstack\.test\.ts$/,
  /^test\/skill-e2e-.*\.test\.ts$/,
  /^test\/skill-llm-eval\.test\.ts$/,
  /^test\/skill-routing-e2e\.test\.ts$/,
  /^test\/codex-e2e\.test\.ts$/,
  /^test\/gemini-e2e\.test\.ts$/,
] as const;

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
  // Tests that read browse/src/sidebar-agent.ts — deleted in v1.14.0.0
  // sidebar refactor (replaced by sidepanel-terminal.js). 10 security tests
  // still reference it and fail on import. They've been broken on every
  // platform since v1.14, but Bun on macOS/Linux reports the failure as a
  // module-load error (exit 0) while Bun on Windows treats it as a hard
  // fail (exit 1). Tracked as a follow-up: update or delete these tests.
  { pattern: /sidebar-agent\.ts/, reason: 'reads deleted browse/src/sidebar-agent.ts (pre-existing breakage from v1.14.0.0 sidebar refactor)' },
];

// Explicit known-Windows-incompatible test files that don't fit a regex
// pattern. Listed here with the precise reason. Prefer adding a pattern above
// when possible; this list is for environment-/runtime-specific tests where
// the failure mode is structural rather than detectable via source-file scan.
const KNOWN_WINDOWS_INCOMPATIBLE: Array<{ file: string; reason: string }> = [
  {
    file: 'test/host-config.test.ts',
    reason: 'asserts "claude" binary on PATH (only true when running inside Claude Code, not on bare CI runner)',
  },
  {
    file: 'browse/test/findport.test.ts',
    reason: 'asserts Bun.serve.stop() is fire-and-forget — Bun behavior differs on Windows for this polyfill',
  },
];

export const DEFAULT_SHARD_COUNT = 20;
export const FREE_TEST_TIMEOUT_MS = 10_000;

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isFreeTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!TEST_FILE_REGEX.test(normalized)) return false;
  return !PAID_EVAL_TESTS.some(pattern => pattern.test(normalized));
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
  for (const relativePath of files) {
    const knownReason = knownBad.get(relativePath);
    if (knownReason) {
      excluded.push({ file: relativePath, reason: knownReason });
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

export function assignFilesToShards(files: string[], shardCount: number): string[][] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error(`Shard count must be a positive integer. Received: ${shardCount}`);
  }

  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  for (const file of files) {
    const shardIndex = stableHash(file) % shardCount;
    shards[shardIndex].push(file);
  }

  return shards
    .map(filesInShard => filesInShard.sort())
    .filter(filesInShard => filesInShard.length > 0);
}

export function buildShardArgs(files: string[]): string[] {
  return ['test', ...files, '--max-concurrency=1', `--timeout=${FREE_TEST_TIMEOUT_MS}`];
}

type CliOptions = {
  dryRun: boolean;
  listOnly: boolean;
  windowsOnly: boolean;
  shardCount: number;
  shardIndex: number | null;
};

function parseCliOptions(argv: string[]): CliOptions {
  let dryRun = false;
  let listOnly = false;
  let windowsOnly = false;
  let shardCount = DEFAULT_SHARD_COUNT;
  let shardIndex: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--list') { listOnly = true; continue; }
    if (arg === '--windows-only') { windowsOnly = true; continue; }
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, listOnly, windowsOnly, shardCount, shardIndex };
}

function formatShardSummary(shards: string[][]): string[] {
  return shards.map((files, index) => {
    const preview = files.slice(0, 3).join(', ');
    const suffix = files.length > 3 ? ', ...' : '';
    return `Shard ${index + 1}/${shards.length}: ${files.length} files${preview ? ` -> ${preview}${suffix}` : ''}`;
  });
}

function runShard(files: string[], shardNumber: number, totalShards: number): number {
  const header = `[test:free] shard ${shardNumber}/${totalShards} (${files.length} files)`;
  console.log(header);
  const result = spawnSync(process.execPath, buildShardArgs(files), {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`${header} failed with exit code ${result.status ?? 1}`);
  }
  return result.status ?? 1;
}

function main(): number {
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

  const shards = assignFilesToShards(files, options.shardCount);
  if (options.dryRun) {
    console.log(`\nWould run ${files.length} files across ${shards.length} shards.`);
    for (const line of formatShardSummary(shards)) console.log(line);
    return 0;
  }

  if (options.shardIndex !== null) {
    if (!Number.isInteger(options.shardIndex) || options.shardIndex < 1 || options.shardIndex > shards.length) {
      throw new Error(`--shard must be between 1 and ${shards.length}. Received: ${options.shardIndex}`);
    }
    return runShard(shards[options.shardIndex - 1], options.shardIndex, shards.length);
  }

  for (let index = 0; index < shards.length; index += 1) {
    const exitCode = runShard(shards[index], index + 1, shards.length);
    if (exitCode !== 0) return exitCode;
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
