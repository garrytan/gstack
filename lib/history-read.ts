/**
 * Read one file at a commit when the checkout may be a blobless clone
 * (`filter: blob:none`), where git fetches an old file's contents on demand
 * and that fetch can fail. The TypeScript twin of
 * .github/scripts/history-read.sh: existence comes from the ref's tree
 * (`git ls-tree`, local data only); a listed path is read with `git show`,
 * tried 3 times in a partial clone (only a fetch can recover) and once
 * otherwise, waiting HISTORY_READ_BACKOFF_SECONDS (default 2) times the attempt
 * between tries; every other failure throws HISTORY_READ_FAILED instead of
 * reading as absent (docs/troubleshooting.md#history-read-failed).
 */
import { spawnSync } from 'node:child_process';

export const HISTORY_READ_TRIES = 3;

export class HistoryReadError extends Error {
  readonly code = 'HISTORY_READ_FAILED';
}

/** The file's text at `ref`, or null when the ref's tree does not list it. */
export function readHistoryFile(repoRoot: string, ref: string, file: string): string | null {
  const git = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const fail = (cause: string) => {
    const version = git(['--version']).stdout?.trim() || 'git version unknown';
    return new HistoryReadError(`cannot read ${file} at ${ref}. ${cause} (${version}). Fix: see docs/troubleshooting.md#history-read-failed (HISTORY_READ_FAILED)`);
  };
  const firstLine = (r: ReturnType<typeof git>) => (r.stderr ?? '').split('\n')[0] || r.error?.message || `exit ${r.status}`;
  const listed = git(['ls-tree', '--full-tree', ref, '--', file]);
  if (listed.status !== 0) throw fail(`git ls-tree failed: ${firstLine(listed)}`);
  if (!listed.stdout.trim()) return null;
  const promisors = (git(['config', '--get-regexp', '^(remote\\..+\\.promisor|extensions\\.partialclone)$']).stdout ?? '').split('\n');
  const tries = promisors.some(line => line && !/ false$/i.test(line)) ? HISTORY_READ_TRIES : 1;
  for (let attempt = 1; ; attempt++) {
    const shown = git(['show', `${ref}:${file}`]);
    if (shown.status === 0) return shown.stdout;
    if (attempt === tries) throw fail(`git show failed ${tries === 1 ? 'once (not a partial clone, so no retry)' : `${tries} times`}: ${firstLine(shown)}`);
    Bun.sleepSync(attempt * 1000 * Number(process.env.HISTORY_READ_BACKOFF_SECONDS ?? 2));
  }
}
