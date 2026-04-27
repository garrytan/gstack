/**
 * State persistence for gstack-build.
 *
 * Phase 2: JSON-only fallback path. Phase 6 wires gbrain as the primary
 * store with this JSON path as fallback when gbrain is unavailable or
 * write fails.
 *
 * Atomicity: writes go to a temp file in the same dir, then rename. Rename
 * is atomic on POSIX, so a crash between truncate and full write can never
 * leave the state file half-written.
 *
 * Slug derivation: state slug = `build-<plan-basename-without-ext>` for
 * the gbrain page. Local JSON file path: `~/.gstack/build-state/<slug>.json`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BuildState, Phase, PhaseState } from './types';

const STATE_DIR = path.join(os.homedir(), '.gstack', 'build-state');

export function deriveSlug(planFile: string): string {
  const base = path.basename(planFile);
  const noExt = base.replace(/\.md$/i, '');
  return `build-${noExt}`;
}

export function statePath(slug: string): string {
  return path.join(STATE_DIR, `${slug}.json`);
}

export function lockPath(slug: string): string {
  return path.join(STATE_DIR, `${slug}.lock`);
}

export function logDir(slug: string): string {
  return path.join(STATE_DIR, slug);
}

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function ensureLogDir(slug: string): void {
  fs.mkdirSync(logDir(slug), { recursive: true });
}

/**
 * Build an initial BuildState from parsed phases. Used when no prior
 * state file exists for this plan.
 */
export function freshState(args: {
  planFile: string;
  branch: string;
  phases: Phase[];
}): BuildState {
  const slug = deriveSlug(args.planFile);
  const planBasename = path.basename(args.planFile).replace(/\.md$/i, '');
  const now = new Date().toISOString();
  const phaseStates: PhaseState[] = args.phases.map((p) => ({
    index: p.index,
    number: p.number,
    name: p.name,
    // Status reflects what we observe on disk: if a phase is already
    // fully checked, it's `committed`; otherwise `pending`.
    status:
      p.implementationDone && p.reviewDone
        ? 'committed'
        : 'pending',
  }));
  return {
    planFile: args.planFile,
    planBasename,
    slug,
    branch: args.branch,
    startedAt: now,
    lastUpdatedAt: now,
    currentPhaseIndex: phaseStates.findIndex((s) => s.status !== 'committed'),
    phases: phaseStates,
    completed: phaseStates.every((s) => s.status === 'committed'),
  };
}

/**
 * Load state from local JSON. Returns null if no state file exists for
 * this plan. Throws on parse error (corrupt state is a hard stop).
 */
export function loadState(slug: string): BuildState | null {
  const p = statePath(slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw) as BuildState;
  } catch (err) {
    throw new Error(
      `state file at ${p} is corrupt (${(err as Error).message}). Inspect or delete to start fresh.`
    );
  }
}

/**
 * Persist state via temp-file-and-rename. Updates lastUpdatedAt as a
 * side effect.
 */
export function saveState(state: BuildState): void {
  ensureStateDir();
  state.lastUpdatedAt = new Date().toISOString();
  const finalPath = statePath(state.slug);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Acquire a lock for this slug. Returns true on success, false if another
 * instance already holds the lock. Caller must call releaseLock on graceful
 * exit AND in any signal handler.
 *
 * Uses O_EXCL flag so two simultaneous calls can't both succeed.
 */
export function acquireLock(slug: string): boolean {
  ensureStateDir();
  const p = lockPath(slug);
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

export function releaseLock(slug: string): void {
  const p = lockPath(slug);
  try {
    fs.unlinkSync(p);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Read the lock file's contents to surface a useful error when contention
 * blocks startup. Returns null if no lock file exists.
 */
export function readLockInfo(slug: string): string | null {
  const p = lockPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}
