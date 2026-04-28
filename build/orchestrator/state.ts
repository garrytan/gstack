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
import { isGbrainAvailable, gbrainPut, gbrainGet } from './gbrain';
import { isPhaseComplete } from './parser';

export interface PersistOptions {
  /** Skip gbrain entirely. Useful for tests and the --no-gbrain CLI flag. */
  noGbrain?: boolean;
  /** Optional logger. Default: silent. Used to surface gbrain warnings. */
  log?: (msg: string) => void;
}

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
    // Status reflects what we observe on disk:
    // - all three checked (testSpec+impl+review) → committed (skip phase)
    // - impl checked only                         → gemini_done (resume at Codex review)
    // - review checked only (user manually)       → committed (trust them; legacy compat)
    // - neither / testSpec unchecked              → pending (run from scratch)
    status:
      isPhaseComplete(p)
        ? 'committed'
        : p.implementationDone && !p.reviewDone
        ? 'gemini_done'
        : !p.implementationDone && p.reviewDone
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
    currentPhaseIndex: Math.max(0, phaseStates.findIndex((s) => s.status !== 'committed')),
    phases: phaseStates,
    completed: phaseStates.every((s) => s.status === 'committed'),
  };
}

/**
 * Load state for a plan. Strategy:
 *   1. Try local JSON (fast, always-on, source of truth).
 *   2. If JSON missing AND gbrain available, try gbrain (resume on a
 *      fresh machine where the build was started elsewhere).
 *   3. Return null if neither has it.
 *
 * Throws on JSON parse error (corrupt local state is a hard stop —
 * user inspects or deletes to start fresh).
 */
export function loadState(slug: string, opts: PersistOptions = {}): BuildState | null {
  const p = statePath(slug);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    try {
      return JSON.parse(raw) as BuildState;
    } catch (err) {
      throw new Error(
        `state file at ${p} is corrupt (${(err as Error).message}). Inspect or delete to start fresh.`
      );
    }
  }

  if (opts.noGbrain) return null;
  if (!isGbrainAvailable()) return null;

  const fromBrain = gbrainGet(slug);
  if (!fromBrain) return null;
  try {
    const parsed = JSON.parse(fromBrain) as BuildState;
    // Mirror back to local JSON so subsequent reads are fast and the
    // local file is the canonical source.
    saveState(parsed, { noGbrain: true });
    opts.log?.(`resumed state from gbrain page "${slug}"`);
    return parsed;
  } catch {
    opts.log?.(`gbrain page "${slug}" exists but isn't valid state JSON; ignoring`);
    return null;
  }
}

/**
 * Persist state. JSON is always written (atomic temp+rename); gbrain
 * is best-effort (failures are logged, not thrown). lastUpdatedAt is
 * updated as a side effect.
 */
export function saveState(state: BuildState, opts: PersistOptions = {}): void {
  ensureStateDir();
  state.lastUpdatedAt = new Date().toISOString();
  const finalPath = statePath(state.slug);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  const serialized = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);

  // Best-effort gbrain mirror.
  if (opts.noGbrain) return;
  if (!isGbrainAvailable()) return;
  const ok = gbrainPut(state.slug, serialized);
  if (!ok) {
    opts.log?.(`warning: gbrain put for "${state.slug}" failed; local JSON is canonical`);
  }
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
