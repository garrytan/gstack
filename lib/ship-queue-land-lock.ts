/**
 * The repository land lock (docs/ship-policy.md#land, #3599): one ref, refs/notes/gstack-land, whose commit
 * holds lock.json, shared by `gstack-ship-queue land` (owner `{ pr }`) and `train land` (owner
 * `{ train, slot, pr }`), so a standalone land and a train slot never both publish onto one main. Every write
 * is an exact lease on the sha read, so two writers racing one sha leave one winner. A lock is resumed only by
 * the same owner kind, identity and journal; anything else is a takeover the caller allows (a drift repair, a
 * train's next slot, the admitted repair train) or a --break-lock under the staleness, mid-push, drift, freeze
 * and live-train rules.
 */
import { git, type QueueFailure } from './ship-queue-gate';

export const LAND_LOCK_REF = 'refs/notes/gstack-land';
export const PUSH_STALE_MS = 10 * 60_000;
export type LandLockPhase = 'stamping' | 'pushing' | 'waiting' | 'merging' | 'drift' | 'between' | 'freeze';
export interface LandLock { pr: string; holder: string; started_at: string; phase: LandLockPhase; journal: string; phase_at?: string; repair_pr?: string; drift_of?: string; train?: string; slot?: number }
export type LockOwner = { pr: string; train?: undefined; slot?: undefined } | { pr: string; train: string; slot: number };
export type LockRead = { state: 'absent'; sha: '' } | { state: 'released'; sha: string } | { state: 'held'; sha: string; lock: LandLock } | { state: 'unreadable'; sha: string; detail: string };
type Released = { released: true; by: string; at: string };

const isSha = (s: string | undefined) => /^[0-9a-f]{40,64}$/.test(s ?? '');
/** How a lock names its owner in every message: `#<pr>`, or `train <nonce> slot <i> (#<pr>)`. */
export const lockLabel = (lock: LandLock): string => (lock.train ? `train ${lock.train} slot ${lock.slot} (#${lock.pr})` : `#${lock.pr}`);
/** The same owner kind, identity and journal: a resume of this run's journal, never just the same PR. */
export const ownsLock = (lock: LandLock, owner: LockOwner, journal: string): boolean =>
  lock.pr === owner.pr && (lock.train ?? null) === (owner.train ?? null) && (lock.slot ?? null) === (owner.slot ?? null) && lock.journal === journal;

export function readLock(root: string, remote = 'origin'): LockRead {
  const fetched = git(root, ['fetch', '-q', remote, `+${LAND_LOCK_REF}:${LAND_LOCK_REF}`]);
  if (!fetched.ok) {
    const listed = git(root, ['ls-remote', remote, LAND_LOCK_REF]);
    if (listed.ok && !listed.out.trim()) git(root, ['update-ref', '-d', LAND_LOCK_REF]);
  }
  const sha = git(root, ['rev-parse', '--verify', '--quiet', LAND_LOCK_REF]).out;
  if (!sha) return { state: 'absent', sha: '' };
  const body = git(root, ['show', `${sha}:lock.json`]);
  if (!body.ok) return { state: 'unreadable', sha, detail: 'no lock.json' };
  let value: Partial<LandLock> & { released?: boolean };
  try { value = JSON.parse(body.out); } catch { return { state: 'unreadable', sha, detail: 'lock.json is not JSON' }; }
  if (value?.released === true) return { state: 'released', sha };
  if (!/^\d+$/.test(String(value?.pr)) || typeof value.phase !== 'string' || typeof value.holder !== 'string') return { state: 'unreadable', sha, detail: 'lock.json names no PR, holder and phase' };
  return { state: 'held', sha, lock: value as LandLock };
}

export function writeLock(root: string, expected: string, value: LandLock | Released, remote = 'origin'): { ok: boolean; sha: string } {
  const blob = git(root, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(value, null, 2) + '\n').out;
  const tree = git(root, ['mktree'], undefined, `100644 blob ${blob}\tlock.json\n`).out;
  const message = 'released' in value ? `land lock released by ${value.by}` : `land lock ${value.train ? `train ${value.train} slot ${value.slot} ` : ''}#${value.pr} ${value.phase}`;
  const commit = git(root, ['commit-tree', tree, ...(expected ? ['-p', expected] : []), '-m', message]).out;
  if (![blob, tree, commit].every(isSha)) return { ok: false, sha: '' };
  const push = git(root, ['push', '-q', `--force-with-lease=${LAND_LOCK_REF}:${expected}`, remote, `${commit}:${LAND_LOCK_REF}`]);
  if (push.ok) git(root, ['update-ref', LAND_LOCK_REF, commit]);
  return { ok: push.ok, sha: commit };
}

export interface HeldLandLock {
  /** The lock as this run last wrote it. */
  readonly lock: LandLock;
  /** This owner's lock as it was before this run took it back (a resume), else null. */
  readonly resumed: LandLock | null;
  /** Move to a phase under the exact lease; a failure is another lander's lock (QUEUE_LAND_LOCKED) or a refused push (QUEUE_NOT_READY). */
  set(phase: LandLockPhase, extra?: Partial<LandLock>): QueueFailure | null;
  release(): boolean;
}
export interface AcquireOptions {
  root: string; remote?: string; holder: string; owner: LockOwner; journal: string; now: () => Date;
  /** The first phase, given this owner's own lock when this run resumes it. */
  phase: (own: LandLock | null) => LandLockPhase;
  breakLock?: boolean; breakTrainLock?: boolean;
  /** A takeover the caller allows (a drift repair, a train's next slot, the admitted repair train): its LOCK: line, else null. */
  takeover?: (lock: LandLock) => string | null;
  /** Whether a train still lands (its record is not terminal); unknown counts as live. */
  liveTrain?: (nonce: string) => boolean;
  /** Fields every write of this run carries (land's drift_of), given this owner's own lock when resumed. */
  extra?: (own: LandLock | null) => Partial<LandLock>;
}

/** Why --break-lock may not break a foreign lock, or null when it may. */
function unbreakable(lock: LandLock, o: AcquireOptions, age: number): QueueFailure | null {
  const label = lockLabel(lock);
  if (lock.phase === 'drift' || lock.drift_of) return { code: 'QUEUE_LAND_DRIFT', message: `#${lock.drift_of ?? lock.pr} holds a drift lock; --break-lock never breaks it, only its repair PR's land takes it over`, fix: `gstack-ship-queue land --pr ${lock.drift_of ?? lock.pr} --repair` };
  if (lock.phase === 'freeze') return { code: 'QUEUE_TRAIN_FROZEN', message: `${label} holds the land lock for a frozen queue; --break-lock never breaks it, only the repair train the freeze admits takes it over` };
  if (lock.train && (o.liveTrain?.(lock.train) ?? true) && !o.breakTrainLock) return { code: 'QUEUE_LAND_LOCKED', message: `${label} is a live train run's lock (phase ${lock.phase}); --break-lock refused without --break-train-lock` };
  if ((lock.phase === 'pushing' || lock.phase === 'merging') && age < PUSH_STALE_MS) return { code: 'QUEUE_LAND_LOCKED', message: `${label}'s holder is mid-${lock.phase === 'pushing' ? 'push' : 'merge'} (${Math.round(age / 1000)} s ago); --break-lock refused` };
  if (lock.phase === 'between' && age < PUSH_STALE_MS) return { code: 'QUEUE_LAND_LOCKED', message: `${label} is between slots (${Math.round(age / 1000)} s ago); --break-lock refused until it is ${PUSH_STALE_MS / 60_000} minutes old` };
  return null;
}

/**
 * Take the land lock for `owner`: resume this owner's own lock, take over one the caller allows, or (with
 * --break-lock, which always names the holder) break a foreign one the rules permit; then write the first
 * phase under the exact lease on the sha read.
 */
export function acquireLandLock(o: AcquireOptions): { held: HeldLandLock; lines: string[] } | { failure: QueueFailure; lines: string[] } {
  const remote = o.remote ?? 'origin';
  const lines: string[] = [];
  const read = readLock(o.root, remote);
  let sha = read.sha;
  let current: LandLock | null = read.state === 'held' ? read.lock : null;
  const own = current && ownsLock(current, o.owner, o.journal) ? current : null;
  if (read.state === 'unreadable') {
    if (!o.breakLock) return { failure: { code: 'QUEUE_LAND_LOCKED', message: `the land lock at ${read.sha.slice(0, 12)} cannot be read (${read.detail}); --break-lock replaces it` }, lines };
    lines.push(`LOCK: broke an unreadable lock at ${read.sha.slice(0, 12)} (${read.detail})`);
  } else if (current && !own) {
    const allowed = o.takeover?.(current) ?? null;
    if (allowed) lines.push(allowed);
    else {
      const age = o.now().getTime() - Date.parse(current.phase_at ?? current.started_at);
      if (!o.breakLock) return { failure: { code: 'QUEUE_LAND_LOCKED', message: `${lockLabel(current)} holds the land lock (${current.holder}, phase ${current.phase}, since ${current.started_at})` }, lines };
      lines.push(`LOCK_HOLDER: ${lockLabel(current)} holder=${current.holder} phase=${current.phase} since=${current.started_at}`);
      const refusal = unbreakable(current, o, age);
      if (refusal) return { failure: refusal, lines };
      lines.push(`LOCK: broke ${lockLabel(current)}'s lock (${current.holder}, phase ${current.phase})`);
    }
  }
  const startedAt = own?.started_at ?? o.now().toISOString();
  const always = o.extra?.(own) ?? {};
  const set = (phase: LandLockPhase, extra: Partial<LandLock> = {}): QueueFailure | null => {
    const next: LandLock = { pr: o.owner.pr, ...(o.owner.train ? { train: o.owner.train, slot: o.owner.slot } : {}), holder: o.holder, started_at: startedAt, phase, journal: o.journal, phase_at: o.now().toISOString(), ...always, ...extra };
    const w = writeLock(o.root, sha, next, remote);
    if (!w.ok) {
      return readLock(o.root, remote).sha === sha
        ? { code: 'QUEUE_NOT_READY', message: `the land lock push to ${remote} failed and the lock there is unchanged; nothing was pushed` }
        : { code: 'QUEUE_LAND_LOCKED', message: 'the land lock moved under this run (another lander took it)' };
    }
    sha = w.sha; current = next;
    return null;
  };
  const failed = set(o.phase(own));
  if (failed) return { failure: failed, lines };
  const held: HeldLandLock = {
    get lock() { return current!; },
    resumed: own,
    set,
    release: () => writeLock(o.root, sha, { released: true, by: o.holder, at: o.now().toISOString() }, remote).ok,
  };
  return { held, lines };
}
