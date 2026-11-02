/**
 * Free-suite home-write tripwire (#2895).
 *
 * Snapshots path + mtime + size of the gstack install and config surfaces under
 * the real home before and after each free shard, and names the shard's files
 * when one of those entries changed. It watches only these surfaces; it is not
 * a universal write-containment check. Live agent-session logs that a
 * concurrently running host keeps writing are excluded, as is the one lane log
 * `gstack-evidence run` tees this run's own output into (its exact path, from
 * GSTACK_EVIDENCE_LOG). Directory mtimes are ignored, so only file, link and
 * directory-set changes count.
 *
 * A shard that runs alone owns its window, so its guard names its files.
 * Concurrent shards share one HOME and cannot tell whose write a change was, so
 * the runner guards that phase once and names no file; `--attribute-home`
 * then runs every file alone in a private HOME, where any write is that file's.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { forEachFileAlone } from './shard-engine';

export const FREE_HOME_SURFACES = ['.gstack', '.claude', '.codex', '.agents', '.config/gstack'] as const;

export const FREE_HOME_VOLATILE = [
  '.claude/projects', '.claude/todos', '.claude/shell-snapshots', '.claude/statsig', '.claude/ide',
  '.claude/session-env', '.claude/file-history', '.claude/debug', '.claude/telemetry', '.claude/history.jsonl',
  '.claude/.credentials.json', '.codex/sessions', '.codex/archived_sessions', '.codex/log', '.codex/history.jsonl',
  '.codex/auth.json',
] as const;

const MAX_DEPTH = 4;
const MAX_REPORTED = 10;

export type FreeHomeSnapshot = Map<string, string>;

export function freeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function snapshotFreeHome(home: string): FreeHomeSnapshot {
  const entries: FreeHomeSnapshot = new Map();
  const volatile = new Set<string>(FREE_HOME_VOLATILE.map(entry => path.normalize(entry)));
  const visit = (relative: string, depth: number) => {
    if (volatile.has(relative)) return;
    const absolute = path.join(home, relative);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      entries.set(relative, `link:${fs.readlinkSync(absolute)}:${stat.mtimeNs}`);
      return;
    }
    if (!stat.isDirectory()) {
      entries.set(relative, `file:${stat.size}:${stat.mtimeNs}`);
      return;
    }
    entries.set(relative, 'dir');
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = fs.readdirSync(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (['EACCES', 'EPERM'].includes(code)) entries.set(relative, 'dir:unreadable');
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code)) return;
      throw error;
    }
    for (const name of names.sort()) visit(path.join(relative, name), depth + 1);
  };
  for (const surface of FREE_HOME_SURFACES) visit(path.normalize(surface), 0);
  return entries;
}

export function diffFreeHome(before: FreeHomeSnapshot, after: FreeHomeSnapshot): string[] {
  const changed = new Set<string>();
  for (const [entry, value] of before) if (after.get(entry) !== value) changed.add(entry);
  for (const entry of after.keys()) if (!before.has(entry)) changed.add(entry);
  return [...changed].sort();
}

/** Who owns the snapshotted window: one shard, a concurrent phase, or one file in a private HOME. */
export type FreeHomeScope = { kind: 'shard' } | { kind: 'concurrent'; shards: number } | { kind: 'private' };

export function formatFreeHomeChange(changed: string[], files: string[], scope: FreeHomeScope = { kind: 'shard' }): string {
  const shown = changed.slice(0, MAX_REPORTED).map(entry => `~/${entry.split(path.sep).join('/')}`);
  const more = changed.length > MAX_REPORTED ? ` (+${changed.length - MAX_REPORTED} more)` : '';
  const watched = `(watches ${FREE_HOME_SURFACES.map(s => `~/${s}`).join(', ')} only): ${shown.join(', ')}${more}.`;
  const fix = 'Give the writer a private HOME/GSTACK_HOME.';
  if (scope.kind === 'concurrent') {
    return `real home changed while ${scope.shards} shards ran concurrently ${watched} They share one HOME, so no shard or file `
      + `is named. Find the writer with \`bun run scripts/test-free-shards.ts --attribute-home\` (each file alone in a private HOME). ${fix}`;
  }
  if (scope.kind === 'private') return `${files.join(', ')} wrote its private HOME ${watched} With the real HOME it writes there. ${fix}`;
  return `real home changed while this shard ran ${watched} ${fix} Shard files: ${files.join(', ')}`;
}

export interface FreeHomeGuard { verify(): string | null }
/** How runFreeShard guards one shard; it may redirect `env` before the child starts. */
export type FreeHomeGuardFactory = (files: string[], env: NodeJS.ProcessEnv, stateDir: string) => FreeHomeGuard;

/** Take the baseline now; verify() returns null or the failure to report. */
export function guardFreeHome(files: string[], env: NodeJS.ProcessEnv = process.env, scope: FreeHomeScope = { kind: 'shard' }): FreeHomeGuard {
  const home = freeHomeDir(env);
  const ownLog = env.GSTACK_EVIDENCE_LOG && path.isAbsolute(env.GSTACK_EVIDENCE_LOG) ? path.relative(home, env.GSTACK_EVIDENCE_LOG) : null;
  const unreadable = (error: unknown) => `real home surfaces could not be snapshotted (${(error as NodeJS.ErrnoException).code ?? 'error'}); shard files: ${files.join(', ')}`;
  let before: FreeHomeSnapshot | undefined;
  let baselineError: string | undefined;
  try { before = snapshotFreeHome(home); } catch (error) { baselineError = unreadable(error); }
  return {
    verify() {
      if (!before) return baselineError!;
      try {
        const changed = diffFreeHome(before, snapshotFreeHome(home)).filter(entry => entry !== ownLog);
        return changed.length ? formatFreeHomeChange(changed, files, scope) : null;
      } catch (error) { return unreadable(error); }
    },
  };
}

/** For a shard inside a concurrently guarded phase: the phase guard reports, this one never does. */
export const sharedFreeHome = (): FreeHomeGuard => ({ verify: () => null });

/**
 * Redirect one shard's HOME to `<stateDir>/home` and guard that instead. The
 * browser cache and git identity still come from the real home, so tests run
 * as they would there; only home writes are diverted.
 */
export function privateFreeHome(files: string[], env: NodeJS.ProcessEnv, stateDir: string): FreeHomeGuard {
  const real = freeHomeDir(env);
  const home = path.join(stateDir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(real, process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
  if (!env.GIT_CONFIG_GLOBAL && fs.existsSync(path.join(real, '.gitconfig'))) env.GIT_CONFIG_GLOBAL = path.join(real, '.gitconfig');
  env.HOME = home;
  if (env.USERPROFILE !== undefined) env.USERPROFILE = home;
  return guardFreeHome(files, env, { kind: 'private' });
}

/**
 * `--attribute-home`: run each reader file alone with a private HOME, `jobs`
 * at a time, then each exclusive host-state file alone, and name every file
 * that wrote a watched surface. Exit 1 when any did.
 */
export async function attributeFreeHomeWriters(
  readers: string[], exclusive: string[], jobs: number,
  runAlone: (file: string, index: number, homeGuard: FreeHomeGuardFactory) => Promise<unknown>,
): Promise<number> {
  const writers: string[] = [];
  console.log(`[test:free] attributing home writes: ${readers.length + exclusive.length} files, each alone in a private HOME, ${jobs} at a time`);
  await forEachFileAlone(readers, exclusive, jobs, async (file, index) => {
    let change = null as string | null;
    await runAlone(file, index, (files, env, stateDir) => {
      const guard = privateFreeHome(files, env, stateDir);
      return { verify: () => (change = guard.verify()) };
    });
    if (change) writers.push(change);
  });
  for (const writer of writers.sort()) console.error(`[test:free] ✗ ${writer}`);
  console.log(`[test:free] ${writers.length ? `${writers.length} file(s) wrote home surfaces` : 'no file wrote a watched home surface'}`);
  return writers.length ? 1 : 0;
}
