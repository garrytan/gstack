/**
 * Free-lane health signals that keep the duration seed honest: the
 * unseeded-file warning (--ci-plan), the shard overrun warning (--ci-verify
 * job summary), and the
 * seed growth ratchet (60 s ceiling with a shrink-only allowlist).
 * Every message names the problem, the offending entry, the fix command and
 * the docs anchor.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { FreeCiPlan, FreeCiResult } from '../test-free-shards';
import type { CurationResult } from './windows-curation';

export const UNSEEDED_WARN_LIMIT = 5;
export const SHARD_OVERRUN_FACTOR = 1.5;
/** Overruns smaller than this are runner noise (startup, cache restore), not a stale seed. */
export const SHARD_OVERRUN_FLOOR_MS = 30_000;
export const SEED_CEILING_MS = 60_000;
export const SEED_ALLOWLIST_FILE = 'scripts/free-test-seed-allowlist.json';
export const SEED_REFRESH_COMMAND = 'bun run test:ubicloud --record-durations';
export const SEED_DOCS_ANCHOR = 'docs/TESTING_INTERNALS.md#free-suite-duration-seed';

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

export function unseededWarning(unseeded: string[]): string | null {
  if (unseeded.length <= UNSEEDED_WARN_LIMIT) return null;
  const shown = unseeded.slice(0, 10).join(', ') + (unseeded.length > 10 ? `, +${unseeded.length - 10} more` : '');
  return `WARNING: ${unseeded.length} free test files have no recorded duration (limit ${UNSEEDED_WARN_LIMIT}); `
    + `they are packed at the 99th-percentile estimate, so shard balance degrades until the seed is refreshed: ${shown}. `
    + `Fix: run \`${SEED_REFRESH_COMMAND}\` and commit scripts/free-test-durations.json. See ${SEED_DOCS_ANCHOR}.`;
}

export interface ShardTiming { shard: number; predictedMs: number; elapsedMs: number }

export function shardOverruns(timings: ShardTiming[]): ShardTiming[] {
  return timings.filter(({ predictedMs, elapsedMs }) =>
    elapsedMs > predictedMs * SHARD_OVERRUN_FACTOR && elapsedMs - predictedMs >= SHARD_OVERRUN_FLOOR_MS);
}

export function overrunWarning(overruns: ShardTiming[]): string | null {
  if (overruns.length === 0) return null;
  const listed = overruns.map(({ shard, predictedMs, elapsedMs }) =>
    `shard ${shard} took ${seconds(elapsedMs)} vs ${seconds(predictedMs)} predicted`).join('; ');
  return `WARNING: ${overruns.length} shard(s) exceeded ${SHARD_OVERRUN_FACTOR}x their predicted duration (${listed}). `
    + `A file in them is slower than its seed entry or unseeded. Fix: run \`${SEED_REFRESH_COMMAND}\` `
    + `and commit scripts/free-test-durations.json; split any file over ${seconds(SEED_CEILING_MS)}. See ${SEED_DOCS_ANCHOR}.`;
}

/** Job-summary signal derived from the strict results: shards that outran their seed. */
export function ciHealthSummary(plan: FreeCiPlan, results: FreeCiResult[]): string[] {
  const ordered = [...results].sort((a, b) => a.outcome.shard - b.outcome.shard);
  const overruns = shardOverruns(ordered.flatMap(({ outcome }) => {
    const predictedMs = plan.shards[outcome.shard - 1]?.predictedMs;
    return predictedMs === undefined ? [] : [{ shard: outcome.shard, predictedMs, elapsedMs: outcome.elapsedMs }];
  }));
  const warning = overrunWarning(overruns);
  return warning ? [warning] : [];
}

/** Printed by every Windows run and its job summary so silent shrinkage of the curated set is visible. */
export function windowsCurationLine({ safe, excluded }: CurationResult): string {
  const byReason = new Map<string, number>();
  for (const { reason } of excluded) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  const top = [...byReason].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4)
    .map(([reason, count]) => `${count} ${reason}`).join('; ');
  return `curated ${safe.length} Windows-safe tests (${excluded.length} excluded${top ? `: ${top}` : ''})`;
}

/** Append markdown to the GitHub job summary when running in Actions; no-op locally. */
export function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
}

// ─── Seed growth ratchet ────────────────────────────────────────────────────

export interface SeedAllowlistEntry {
  file: string;
  reason: string;
  /** Required on an entry the merge-base allowlist lacks: the annotated exception names its follow-up. */
  todo?: string;
}

export function parseSeedAllowlist(raw: string, source = SEED_ALLOWLIST_FILE): SeedAllowlistEntry[] {
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error(`${source}: expected {"entries": [...]}`);
  return parsed.entries.map((entry, index) => {
    const { file, reason, todo } = (entry ?? {}) as Record<string, unknown>;
    if (typeof file !== 'string' || !file || typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`${source}: entries[${index}] needs a non-empty "file" and "reason"`);
    }
    if (todo !== undefined && (typeof todo !== 'string' || !todo.trim())) {
      throw new Error(`${source}: entries[${index}] "todo" must be a non-empty string when present`);
    }
    return todo === undefined ? { file, reason } : { file, reason, todo };
  });
}

export interface SeedRatchetInput {
  durations: Record<string, number>;
  allowlist: SeedAllowlistEntry[];
  /** The merge-base allowlist; null when the merge-base has no allowlist file (the first allowlist). */
  baseAllowlist: SeedAllowlistEntry[] | null;
}

export interface SeedRatchetResult {
  violations: string[];
  /** Annotated exceptions added on this branch; printed so reviewers see them. */
  exceptions: string[];
}

export function seedRatchet({ durations, allowlist, baseAllowlist }: SeedRatchetInput): SeedRatchetResult {
  const violations: string[] = [];
  const exceptions: string[] = [];
  const allowed = new Map(allowlist.map(entry => [entry.file, entry]));
  const fix = `See ${SEED_DOCS_ANCHOR}.`;

  for (const [file, ms] of Object.entries(durations).sort(([a], [b]) => a.localeCompare(b))) {
    if (ms > SEED_CEILING_MS && !allowed.has(file)) {
      violations.push(`${file} is seeded at ${seconds(ms)}, over the ${seconds(SEED_CEILING_MS)} ceiling. `
        + `Fix: split it (by describe block or fixture) so the packer can balance it, then rerun \`${SEED_REFRESH_COMMAND}\`. ${fix}`);
    }
  }
  for (const entry of allowlist) {
    const ms = durations[entry.file];
    if (ms === undefined || ms <= SEED_CEILING_MS) {
      violations.push(`${SEED_ALLOWLIST_FILE} lists ${entry.file}, which is ${ms === undefined ? 'not in the seed' : `seeded at ${seconds(ms)}`}. `
        + `Fix: delete its entry; the allowlist holds only files still over ${seconds(SEED_CEILING_MS)}. ${fix}`);
    }
  }
  if (baseAllowlist === null) return { violations, exceptions };
  const baseFiles = new Set(baseAllowlist.map(entry => entry.file));
  for (const entry of allowlist) {
    if (baseFiles.has(entry.file)) continue;
    if (entry.todo) {
      exceptions.push(`annotated exception: ${entry.file} (reason: ${entry.reason}; todo: ${entry.todo})`);
    } else {
      violations.push(`${SEED_ALLOWLIST_FILE} adds ${entry.file}, but the allowlist is shrink-only. `
        + `Fix: split the file under ${seconds(SEED_CEILING_MS)}, or add a "todo" naming the follow-up that splits it (an annotated exception). ${fix}`);
    }
  }
  return { violations, exceptions };
}

export type BaseAllowlistRead =
  | { status: 'ok'; entries: SeedAllowlistEntry[] | null }
  | { status: 'unavailable'; reason: string };

/**
 * The merge-base copy of the allowlist (`git show <base>:<file>`). A base that
 * predates the allowlist file yields null (the first allowlist); a base git
 * cannot resolve (shallow checkout, missing ref) is unavailable, never "empty".
 */
export function readBaseSeedAllowlist(root: string, baseRef: string): BaseAllowlistRead {
  const commit = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (commit.status !== 0) return { status: 'unavailable', reason: `cannot resolve merge-base ${baseRef}` };
  const sha = commit.stdout.trim();
  const listed = spawnSync('git', ['ls-tree', '--name-only', sha, '--', SEED_ALLOWLIST_FILE], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (listed.status !== 0) return { status: 'unavailable', reason: `cannot list ${SEED_ALLOWLIST_FILE} at ${sha}` };
  if (!listed.stdout.trim()) return { status: 'ok', entries: null };
  const shown = spawnSync('git', ['show', `${sha}:${SEED_ALLOWLIST_FILE}`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (shown.status !== 0) return { status: 'unavailable', reason: `cannot read ${SEED_ALLOWLIST_FILE} at ${sha}` };
  return { status: 'ok', entries: parseSeedAllowlist(shown.stdout, `${sha}:${SEED_ALLOWLIST_FILE}`) };
}
