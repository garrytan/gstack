/**
 * Diff-based test selection for E2E and LLM-judge evals — the LOGIC half.
 *
 * Each test declares which source files it depends on ("touchfiles") in
 * ./touchfiles-data.ts (literals only — see the note there). The test runner
 * computes changed files as the union of committed diff, staged + unstaged
 * diff, and untracked files — uncommitted work selects tests too — and only
 * runs tests whose dependencies were modified. Override with EVALS_ALL=1 to
 * run everything.
 *
 * When touchfiles-data.ts itself changed, selection uses MAP-DIFF instead of
 * a global run-all: the old version of the data file is loaded from git and
 * evaluated in a bun child process (the literal-only tripwire in
 * test/touchfiles-facade.test.ts bounds what executing it can do), the four
 * maps are diffed per key, and only tests whose entry was added, whose
 * dep-list changed, or whose tier flipped are selected. Any failure on that
 * path fails CLOSED: run all tests, with the cause in the reason string.
 *
 * Everything here is synchronous by design: e2e-helpers.ts and the *-e2e
 * test files compute selection at module load, so the old-file evaluation
 * happens in a spawnSync'd bun child rather than a dynamic import.
 *
 * Import sites should keep using the ./touchfiles facade, which re-exports
 * both this module and the data module.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from './touchfiles-data';

/** Repo-relative path of the pure-data file (the map-diff subject). */
export const TOUCHFILES_DATA_PATH = 'test/helpers/touchfiles-data.ts';

// --- Glob matching ---

/**
 * Match a file path against a glob pattern.
 * Supports:
 *   ** — match any number of path segments
 *   *  — match within a single segment (no /)
 */
export function matchGlob(file: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(file);
}

// --- Base branch detection ---

/**
 * Detect the base branch by trying refs in order.
 * Returns the first valid ref, or null if none found.
 */
export function detectBaseBranch(cwd: string): string | null {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd, stdio: 'pipe', timeout: 3000,
    });
    if (result.status === 0) return ref;
  }
  return null;
}

/**
 * Run a git command and return stdout. FAIL-CLOSED: any failure (spawn
 * error, non-zero exit) throws — a broken git environment must abort the
 * suite loudly instead of silently degrading into a full (paid) run.
 */
function runGitOrThrow(args: string[], cwd: string, spawnImpl: typeof spawnSync): string {
  const result = spawnImpl('git', args, {
    cwd, stdio: 'pipe', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || result.error?.message || 'unknown error';
    throw new Error(
      `getChangedFiles: \`git ${args.join(' ')}\` failed in ${cwd} `
      + `(exit ${result.status ?? 'spawn-error'}): ${stderr}\n`
      + 'Diff-based test selection cannot proceed. Fix the git environment, '
      + 'or set EVALS_ALL=1 to deliberately run the full suite.',
    );
  }
  return result.stdout.toString();
}

/**
 * Get the list of files changed relative to the base branch, INCLUDING
 * uncommitted work. Union of three sources, deduped:
 *   1. committed:  `git diff --name-only <base>...HEAD`
 *   2. staged + unstaged: `git diff --name-only HEAD`
 *   3. untracked:  `git status --porcelain --untracked-files=all` ('?? ' lines)
 *
 * Without 2 and 3, an agent that edits files and runs evals BEFORE
 * committing gets an empty diff → run-all → the full paid suite every time.
 *
 * An empty UNION still means "no changes" and callers keep their intentional
 * run-all semantics for it (main-branch / periodic full runs depend on that).
 *
 * Git failures THROW (see runGitOrThrow) instead of returning [] — the old
 * behavior made a broken git environment indistinguishable from a clean tree.
 *
 * `spawnImpl` is injectable for tests.
 */
export function getChangedFiles(
  baseBranch: string,
  cwd: string,
  spawnImpl: typeof spawnSync = spawnSync,
): string[] {
  // core.quotePath=false: without it git C-escapes non-ASCII bytes
  // ("docs/r\303\251sum\303\251.md"), the escaped string matches no glob,
  // and the dependent test is silently DESELECTED — under-selection, the
  // exact direction selection must fail away from.
  const noQuote = ['-c', 'core.quotePath=false'];
  const committed = runGitOrThrow([...noQuote, 'diff', '--name-only', `${baseBranch}...HEAD`], cwd, spawnImpl)
    .trim().split('\n').filter(Boolean);
  const uncommitted = runGitOrThrow([...noQuote, 'diff', '--name-only', 'HEAD'], cwd, spawnImpl)
    .trim().split('\n').filter(Boolean);
  const untracked = runGitOrThrow([...noQuote, 'status', '--porcelain', '--untracked-files=all'], cwd, spawnImpl)
    .split('\n')
    .filter(line => line.startsWith('?? '))
    .map(line => {
      let p = line.slice(3);
      // residual quoting (embedded quote/newline) — strip the wrapper
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p;
    });
  return [...new Set([...committed, ...uncommitted, ...untracked])];
}

// --- Touchfile map diffing ---

/** The four exports of touchfiles-data.ts, as plain data. */
export interface TouchfileMaps {
  E2E_TOUCHFILES: Record<string, string[]>;
  E2E_TIERS: Record<string, string>;
  LLM_JUDGE_TOUCHFILES: Record<string, string[]>;
  GLOBAL_TOUCHFILES: string[];
}

export type MapDiffCause =
  | 'missing-base-ref'
  | 'git-show-failed'
  | 'import-failed'
  | 'shape-mismatch';

export type MapDiffOutcome =
  | {
      ok: true;
      /** Tests whose entry was added, dep-list changed, or tier flipped. */
      changedTests: string[];
      /** Keys present in the old maps but gone from every new map (reported, not selected). */
      removedTests: string[];
      /** True when the GLOBAL_TOUCHFILES set itself changed — not attributable to any test. */
      globalTouchfilesChanged: boolean;
    }
  | { ok: false; cause: MapDiffCause };

/** Current maps as a TouchfileMaps value (the "new" side of the diff). */
const CURRENT_MAPS: TouchfileMaps = {
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isRecordOfStringArrays(v: unknown): v is Record<string, string[]> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every(isStringArray);
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every(x => typeof x === 'string');
}

function isTouchfileMaps(v: unknown): v is TouchfileMaps {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isRecordOfStringArrays(o.E2E_TOUCHFILES)
    && isRecordOfStrings(o.E2E_TIERS)
    && isRecordOfStringArrays(o.LLM_JUDGE_TOUCHFILES)
    && isStringArray(o.GLOBAL_TOUCHFILES);
}

/**
 * Pure map-diff core (injectable for tests — no git, no filesystem).
 *
 * A key counts as CHANGED when it was added to any per-key map, its dep-list
 * array differs, or its tier value flipped. A key counts as REMOVED only when
 * it is gone from every new per-key map; a key dropped from one map but still
 * present in another (e.g. tier entry deleted, touchfile entry kept) counts
 * as changed — conservative, because the test still exists with a different
 * configuration. GLOBAL_TOUCHFILES is compared as a set; a change there is
 * not attributable to any test and is flagged for the caller to treat as
 * "run all".
 */
export function diffTouchfileMapsCore(
  oldMaps: TouchfileMaps,
  newMaps: TouchfileMaps,
): { changedTests: string[]; removedTests: string[]; globalTouchfilesChanged: boolean } {
  const perKeyMapNames = ['E2E_TOUCHFILES', 'E2E_TIERS', 'LLM_JUDGE_TOUCHFILES'] as const;
  const changed = new Set<string>();
  const rawRemoved = new Set<string>();

  for (const mapName of perKeyMapNames) {
    const oldMap: Record<string, unknown> = oldMaps[mapName] ?? {};
    const newMap: Record<string, unknown> = newMaps[mapName] ?? {};
    for (const key of Object.keys(newMap)) {
      if (!(key in oldMap)) {
        changed.add(key); // added
      } else if (JSON.stringify(oldMap[key]) !== JSON.stringify(newMap[key])) {
        changed.add(key); // dep-list edited or tier flipped
      }
    }
    for (const key of Object.keys(oldMap)) {
      if (!(key in newMap)) rawRemoved.add(key);
    }
  }

  const removed = new Set<string>();
  for (const key of rawRemoved) {
    const stillExists = perKeyMapNames.some(m => key in (newMaps[m] ?? {}));
    if (stillExists) changed.add(key);
    else removed.add(key);
  }

  const sortedSet = (arr: string[]) => JSON.stringify([...arr].sort());
  const globalTouchfilesChanged =
    sortedSet(oldMaps.GLOBAL_TOUCHFILES ?? []) !== sortedSet(newMaps.GLOBAL_TOUCHFILES ?? []);

  return {
    changedTests: [...changed].sort(),
    removedTests: [...removed].sort(),
    globalTouchfilesChanged,
  };
}

/**
 * Load the OLD touchfiles-data.ts from git and diff it against the current
 * maps. Synchronous: the old file is written to a temp dir and evaluated in
 * a spawnSync'd bun child that prints the four maps as JSON (module-scope
 * callers like e2e-helpers.ts cannot await).
 *
 * FAIL-CLOSED: every failure returns `{ ok: false, cause }` and the caller
 * must treat that as "data change is global — run all tests".
 *
 * `newMaps` is injectable so integration tests can diff a temp repo's old
 * version against a fixture instead of this repo's live maps.
 */
export function diffTouchfileMaps(
  baseRef: string,
  cwd: string,
  newMaps: TouchfileMaps = CURRENT_MAPS,
): MapDiffOutcome {
  try {
    const verify = spawnSync('git', ['rev-parse', '--verify', baseRef], {
      cwd, stdio: 'pipe', timeout: 3000,
    });
    if (verify.status !== 0) return { ok: false, cause: 'missing-base-ref' };

    const show = spawnSync('git', ['show', `${baseRef}:${TOUCHFILES_DATA_PATH}`], {
      cwd, stdio: 'pipe', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    });
    if (show.status !== 0) return { ok: false, cause: 'git-show-failed' };
    const oldSource = show.stdout.toString();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'touchfiles-map-diff-'));
    try {
      const dataPath = path.join(tempDir, 'touchfiles-data.ts');
      fs.writeFileSync(dataPath, oldSource);
      const loaderPath = path.join(tempDir, 'load-maps.ts');
      fs.writeFileSync(loaderPath, [
        `const m = await import(${JSON.stringify(dataPath)});`,
        'console.log(JSON.stringify({',
        '  E2E_TOUCHFILES: m.E2E_TOUCHFILES,',
        '  E2E_TIERS: m.E2E_TIERS,',
        '  LLM_JUDGE_TOUCHFILES: m.LLM_JUDGE_TOUCHFILES,',
        '  GLOBAL_TOUCHFILES: m.GLOBAL_TOUCHFILES,',
        '}));',
        '',
      ].join('\n'));

      // process.execPath is the bun binary when running under bun.
      const run = spawnSync(process.execPath, ['run', loaderPath], {
        stdio: 'pipe', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      if (run.status !== 0) return { ok: false, cause: 'import-failed' };

      let oldMaps: unknown;
      try {
        oldMaps = JSON.parse(run.stdout.toString());
      } catch {
        return { ok: false, cause: 'import-failed' };
      }
      if (!isTouchfileMaps(oldMaps)) return { ok: false, cause: 'shape-mismatch' };

      return { ok: true, ...diffTouchfileMapsCore(oldMaps, newMaps) };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Unexpected failure anywhere in the pipeline (temp dir, git, child
    // process) — same fail-closed contract as an evaluation failure.
    return { ok: false, cause: 'import-failed' };
  }
}

// --- Test selection ---

/**
 * Select tests to run based on changed files.
 *
 * Algorithm:
 * 1. If any changed file (other than touchfiles-data.ts) matches a global
 *    touchfile → run ALL tests
 * 2. If touchfiles-data.ts changed → map-diff it against the base ref and
 *    select only the tests whose map entries changed (fail-closed: any
 *    map-diff failure runs ALL tests, with the cause in the reason string)
 * 3. For each test, check if any other changed file matches its patterns
 * 4. Return selected + skipped lists with reason (union of 2 and 3)
 *
 * `opts.baseRef` / `opts.cwd` scope the map-diff; they default to
 * EVALS_BASE || detectBaseBranch || 'main' and the repo root — the same
 * resolution the module-scope callers (e2e-helpers.ts et al.) use to compute
 * `changedFiles`, so the two sides of the diff stay consistent.
 * `opts.mapDiff` injects a precomputed outcome (for tests).
 */
export function selectTests(
  changedFiles: string[],
  touchfiles: Record<string, string[]>,
  globalTouchfiles: string[] = GLOBAL_TOUCHFILES,
  opts: { baseRef?: string; cwd?: string; mapDiff?: MapDiffOutcome } = {},
): { selected: string[]; skipped: string[]; reason: string; removedTests?: string[] } {
  const allTestNames = Object.keys(touchfiles);
  const dataChanged = changedFiles.includes(TOUCHFILES_DATA_PATH);

  // Global touchfile hit → run all. touchfiles-data.ts is excluded here —
  // its changes route through map-diff below instead of a global run-all.
  for (const file of changedFiles) {
    if (file === TOUCHFILES_DATA_PATH) continue;
    if (globalTouchfiles.some(g => matchGlob(file, g))) {
      return { selected: allTestNames, skipped: [], reason: `global: ${file}` };
    }
  }

  // Map-diff path for data-file changes
  let mapDiffSelected: Set<string> | null = null;
  let removedTests: string[] | undefined;
  if (dataChanged) {
    const cwd = opts.cwd ?? path.resolve(import.meta.dir, '..', '..');
    const baseRef = opts.baseRef
      || process.env.EVALS_BASE
      || detectBaseBranch(cwd)
      || 'main';
    const outcome = opts.mapDiff ?? diffTouchfileMaps(baseRef, cwd);
    if (!outcome.ok) {
      return {
        selected: allTestNames,
        skipped: [],
        reason: `global — touchfiles-data changed (${outcome.cause})`,
      };
    }
    if (outcome.globalTouchfilesChanged) {
      return {
        selected: allTestNames,
        skipped: [],
        reason: 'global — touchfiles-data changed (GLOBAL_TOUCHFILES edited)',
      };
    }
    // Scope to this map's keys (E2E and LLM-judge selections run separately).
    mapDiffSelected = new Set(outcome.changedTests.filter(t => t in touchfiles));
    removedTests = outcome.removedTests;
  }

  // Per-test matching for the remaining changed files
  const otherFiles = changedFiles.filter(f => f !== TOUCHFILES_DATA_PATH);
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const [testName, patterns] of Object.entries(touchfiles)) {
    const hit = otherFiles.some(f => patterns.some(p => matchGlob(f, p)))
      || (mapDiffSelected !== null && mapDiffSelected.has(testName));
    (hit ? selected : skipped).push(testName);
  }

  if (dataChanged) {
    return { selected, skipped, reason: 'map-diff', removedTests };
  }
  return { selected, skipped, reason: 'diff' };
}
