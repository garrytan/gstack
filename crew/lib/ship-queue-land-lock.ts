/**
 * The repository land lock (docs/ship-policy.md#land, #3599): one ref, refs/notes/gstack-land, whose commit
 * holds lock.json, shared by `gstack-ship-queue land` (owner `{ pr }`) and `train land` (owner
 * `{ train, slot, pr }`), so a standalone land and a train slot never both publish onto one main. Every write
 * is an exact lease on the sha read, so two writers racing one sha leave one winner. A push that reports failure is
 * checked against origin's ref (GitHub can apply a push and still answer HTTP 502, GST-1344), and a read whose fetch
 * fails takes origin's sha from ls-remote when this clone already holds that commit. A lock is resumed only by
 * the same owner kind, identity and journal; anything else is a takeover the caller allows (a drift repair, a
 * train's next slot, the admitted repair train) or a --break-lock under the staleness, mid-push, drift, freeze
 * and live-train rules.
 *
 * A direct land (`land --pin`) holds the lock only while its process runs, so its lock is process-scoped
 * (AcquireOptions.processScoped): every write records the process (boot id, pid namespace, pid, process group,
 * start time and a random mark) and an expiry, and the run keeps a mark file under the state root until it
 * releases. A later land judges such a lock before anything else: a process of the holder's group started at or
 * after the holder still running on this machine means it runs, and it is never taken over, --break-lock included;
 * a group with no such process, or a mark file this machine kept for a lock written before its last boot, means the
 * holder is gone, and an expired lock whose holder is not running is stale. A gone or stale lock is taken over
 * without --break-lock and the takeover is logged (LOCK_TAKEOVER, and took_over in the new lock). A mark file that
 * records a deliberate hold (land.merged_checks were running, or changed the checkout) keeps the lock refused on
 * this machine; the hold lives in this machine's state root, so another machine still takes it over once it
 * expires (its checkout was never touched). A mark proves a restart only for this machine and a different boot.
 * Anything else refuses
 * with the expiry and the fix. A takeover writes under the exact lease on the sha it judged, and a retry adopts only
 * a lock carrying this run's own mark, so a stalled takeover or a late release never replaces a newer owner's lock.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveStateRoot } from '../../lib/state-root';
import { git, type QueueFailure } from './ship-queue-gate';

export const LAND_LOCK_REF = 'refs/notes/gstack-land';
export const PUSH_STALE_MS = 10 * 60_000;
/** A direct land's bound: merged checks (about 15 minutes), land.merged_ci (CI_TIMEOUT_MS, 45) and the merge with its tree check, with room to spare. */
export const DIRECT_LOCK_TTL_MS = 90 * 60_000;
export type LandLockPhase = 'stamping' | 'pushing' | 'waiting' | 'merging' | 'drift' | 'between' | 'freeze';
/** The process holding a process-scoped lock; start is the kernel's start time in clock ticks since boot. */
export interface LockProcess { boot: string; pidns: string; pid: number; pgid: number; start: number; mark: string }
export interface LockTakeover { pr: string; holder: string; sha: string; why: string; at: string }
export interface LandLock { pr: string; holder: string; started_at: string; phase: LandLockPhase; journal: string; phase_at?: string; repair_pr?: string; drift_of?: string; train?: string; slot?: number; proc?: LockProcess; expires_at?: string; took_over?: LockTakeover }
export type LockOwner = { pr: string; train?: undefined; slot?: undefined } | { pr: string; train: string; slot: number };
export type LockRead = { state: 'absent'; sha: '' } | { state: 'released'; sha: string } | { state: 'held'; sha: string; lock: LandLock } | { state: 'unreadable'; sha: string; detail: string };
type Released = { released: true; by: string; at: string };

const isSha = (s: string | undefined) => /^[0-9a-f]{40,64}$/.test(s ?? '');
/** How a lock names its owner in every message: `#<pr>`, or `train <nonce> slot <i> (#<pr>)`. */
export const lockLabel = (lock: LandLock): string => (lock.train ? `train ${lock.train} slot ${lock.slot} (#${lock.pr})` : `#${lock.pr}`);
/** The same owner kind, identity and journal: a resume of this run's journal, never just the same PR. */
export const ownsLock = (lock: LandLock, owner: LockOwner, journal: string): boolean =>
  lock.pr === owner.pr && (lock.train ?? null) === (owner.train ?? null) && (lock.slot ?? null) === (owner.slot ?? null) && lock.journal === journal;

/** state, process group and start time (clock ticks since boot) from /proc/<pid>/stat; null off Linux or once the process is gone. */
function procStat(pid: number | 'self'): { state: string; ppid: number; pgrp: number; start: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: f[0]!, ppid: Number(f[1]), pgrp: Number(f[2]), start: Number(f[19]) };
  } catch { return null; }
}

/** This process as a lock records it, with a fresh mark; null where /proc cannot say (then only the expiry applies). */
export function thisProcess(): LockProcess | null {
  try {
    const self = procStat('self');
    if (!self || !Number.isInteger(self.pgrp) || !Number.isInteger(self.start)) return null;
    return { boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pidns: fs.readlinkSync('/proc/self/ns/pid'), pid: process.pid, pgid: self.pgrp, start: self.start, mark: crypto.randomUUID() };
  } catch { return null; }
}

/**
 * A live process of the holder's group that started at or after the holder (the holder, or a child it started,
 * even one orphaned when the holder died); 0 when there is none. Older members are the shell that ran the holder.
 * When this run shares the holder's group (a rerun in the same script), this run, its ancestors and its siblings
 * (a `| tee` beside it) are never counted, except the holder itself. A group reused after its last member exited reads as running: a refusal, never a theft.
 */
function groupRunning(p: LockProcess): number {
  let entries: string[];
  try { entries = fs.readdirSync('/proc'); } catch { return p.pid; }
  const mine = new Set<number>();
  for (let at = process.pid; at > 1 && !mine.has(at);) { mine.add(at); at = procStat(at)?.ppid ?? 0; }
  const self = procStat('self');
  const parent = self?.pgrp === p.pgid ? self.ppid : 0;
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const s = procStat(pid);
    if (!s || s.pgrp !== p.pgid || s.start < p.start || s.state === 'Z' || s.state === 'X') continue;
    const holder = pid === p.pid && s.start === p.start;
    if (!holder && parent && (mine.has(pid) || (parent > 1 && s.ppid === parent))) continue;
    return pid;
  }
  return 0;
}

/** This machine as a mark file records it, so a mark read through a shared state root never proves another machine's restart. */
function thisMachine(): string {
  let id = '';
  try { id = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* none */ }
  return `${os.hostname()}/${id}`;
}

export const lockMarkDir = (env: NodeJS.ProcessEnv = process.env) => path.join(resolveStateRoot(env), 'ship-queue', 'land-owners');
const markFile = (dir: string, mark: string) => path.join(dir, `${mark.replace(/[^A-Za-z0-9-]/g, '')}.json`);
function readMark(dir: string, mark: string): { hold?: string; machine?: string; boot?: string } | null {
  try { return JSON.parse(fs.readFileSync(markFile(dir, mark), 'utf8')); } catch { return null; }
}
function writeMark(dir: string, mark: string, value: object): boolean {
  const file = markFile(dir, mark);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value) + '\n');
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
    return true;
  } catch { return false; }
}
const dropMark = (dir: string, mark: string) => { try { fs.rmSync(markFile(dir, mark), { force: true }); } catch { /* already gone */ } };

/** Whether a lock is held only while its land runs: one a process-scoped run wrote, or a direct land's from before process records. */
export const processScopedLock = (lock: LandLock): boolean => !!(lock.expires_at || lock.proc) || (!lock.train && lock.journal?.startsWith('land-pin:'));
export const lockExpiry = (lock: LandLock): number => Date.parse(lock.expires_at ?? '') || Date.parse(lock.phase_at ?? lock.started_at) + DIRECT_LOCK_TTL_MS;

export type OwnerVerdict = { state: 'running'; pid: number; why: string } | { state: 'gone' | 'held' | 'unknown'; why: string };
/** What this machine can prove about a process-scoped lock's holder. */
export function judgeOwner(lock: LandLock, self: LockProcess | null, marks: string): OwnerVerdict {
  const p = lock.proc;
  const mark = p?.mark ? readMark(marks, p.mark) : null;
  const here = !!(p && self && p.boot === self.boot && p.pidns === self.pidns);
  const pid = here ? groupRunning(p!) : 0;
  if (pid) return { state: 'running', pid, why: `process ${pid} of its land (process group ${p!.pgid}) is still running on this machine` };
  if (mark?.hold && mark.machine === thisMachine()) return { state: 'held', why: `its land left it held on purpose: ${mark.hold}` };
  if (here) return { state: 'gone', why: `its land (process ${p!.pid}) and every process it started have exited` };
  if (p && self && mark && mark.machine === thisMachine() && mark.boot === p.boot && p.boot !== self.boot) return { state: 'gone', why: 'this machine wrote it before it last restarted, so its land is gone' };
  return { state: 'unknown', why: p ? 'its land ran on another machine, so this one cannot check whether it still runs' : 'it records no land process (an older gstack wrote it), so no machine can check it' };
}

/** The sha origin's lock ref holds: '' when origin has none, null when origin cannot be read. */
function originSha(root: string, remote: string): string | null {
  const listed = git(root, ['ls-remote', remote, LAND_LOCK_REF]);
  if (!listed.ok) return null;
  return listed.out.split('\n').map(l => l.split('\t')).find(([, ref]) => ref === LAND_LOCK_REF)?.[0] ?? '';
}

export function readLock(root: string, remote = 'origin'): LockRead {
  const fetched = git(root, ['fetch', '-q', remote, `+${LAND_LOCK_REF}:${LAND_LOCK_REF}`]);
  if (!fetched.ok) {
    const at = originSha(root, remote);
    if (at === '') git(root, ['update-ref', '-d', LAND_LOCK_REF]);
    else if (at && git(root, ['cat-file', '-e', `${at}^{commit}`]).ok) git(root, ['update-ref', LAND_LOCK_REF, at]);
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

/** Push the lock under the lease. On a failed push, `origin` is the sha origin's ref now holds ('' none, null unreadable); a push origin applied anyway is a success. */
export function writeLock(root: string, expected: string, value: LandLock | Released, remote = 'origin'): { ok: boolean; sha: string; origin?: string | null } {
  const blob = git(root, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(value, null, 2) + '\n').out;
  const tree = git(root, ['mktree'], undefined, `100644 blob ${blob}\tlock.json\n`).out;
  const message = 'released' in value ? `land lock released by ${value.by}` : `land lock ${value.train ? `train ${value.train} slot ${value.slot} ` : ''}#${value.pr} ${value.phase}${value.took_over ? ` (took over #${value.took_over.pr}: ${value.took_over.why})` : ''}`;
  const commit = git(root, ['commit-tree', tree, ...(expected ? ['-p', expected] : []), '-m', message]).out;
  if (![blob, tree, commit].every(isSha)) return { ok: false, sha: '', origin: expected };
  const push = git(root, ['push', '-q', `--force-with-lease=${LAND_LOCK_REF}:${expected}`, remote, `${commit}:${LAND_LOCK_REF}`]);
  const origin = push.ok ? commit : originSha(root, remote);
  if (origin !== commit) return { ok: false, sha: commit, origin };
  git(root, ['update-ref', LAND_LOCK_REF, commit]);
  return { ok: true, sha: commit };
}

export interface HeldLandLock {
  /** The lock as this run last wrote it. */
  readonly lock: LandLock;
  /** This owner's lock as it was before this run took it back (a resume), else null. */
  readonly resumed: LandLock | null;
  /** Move to a phase under the exact lease; a failure is another lander's lock (QUEUE_LAND_LOCKED) or a refused push (QUEUE_NOT_READY). */
  set(phase: LandLockPhase, extra?: Partial<LandLock>): QueueFailure | null;
  release(): boolean;
  /** Mark a process-scoped lock as held on purpose (no git call): if this process stops while a reason is set, later lands here refuse it with that reason; null clears it. False when the mark could not be written. */
  hold(reason: string | null): boolean;
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
  /** The lock lives only as long as this process (land --pin): each write records the process and expires ttlMs later. proc and marks are for tests. */
  processScoped?: { ttlMs: number; proc?: LockProcess | null; marks?: string };
  /** This run may replace a lock held on purpose by its own PR's earlier run (land --pin without --allow-repo-commands, the documented release). */
  releasesHold?: boolean;
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

/** The fix a refusal of a process-scoped lock names: the expiry and --break-lock, or how a deliberate hold is released. */
function scopedFix(lock: LandLock, state: OwnerVerdict['state'], expiry: number, now: number, tampered = false): string {
  if (state === 'held') return `make sure nothing that land started still runs and restore any path of the checkout's git directory it changed from a trusted copy, then release it: gstack-ship-queue land --pr ${lock.pr} --pin ${lock.journal.replace(/^land-pin:/, '')} (without --allow-repo-commands)${tampered ? '' : ', or pass --break-lock'}`;
  return `the lock expires at ${new Date(expiry).toISOString()} (in ${Math.max(1, Math.ceil((expiry - now) / 60_000))} min), and the first land after that takes it over; to take it sooner, make sure the land that holds it has stopped, then rerun with --break-lock`;
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
  const scoped = o.processScoped;
  const proc = scoped ? (scoped.proc === undefined ? thisProcess() : scoped.proc) : null;
  const marks = scoped?.marks ?? lockMarkDir();
  const previousMark = current?.proc?.mark;
  let tookOver: LockTakeover | undefined;
  if (read.state === 'unreadable') {
    if (!o.breakLock) return { failure: { code: 'QUEUE_LAND_LOCKED', message: `the land lock at ${read.sha.slice(0, 12)} cannot be read (${read.detail}); --break-lock replaces it` }, lines };
    lines.push(`LOCK: broke an unreadable lock at ${read.sha.slice(0, 12)} (${read.detail})`);
  } else if (current) {
    const verdict = processScopedLock(current) ? judgeOwner(current, proc ?? thisProcess(), marks) : null;
    if (verdict?.state === 'running') return { failure: { code: 'QUEUE_LAND_LOCKED', message: `${lockLabel(current)}'s land is still running: ${verdict.why}; a running land's lock is never taken over, --break-lock included`, fix: `wait for it to finish, then rerun land; if it is stuck, stop process ${verdict.pid} and rerun land, which then takes the lock over` }, lines };
    const expiry = verdict ? lockExpiry(current) : NaN;
    if (verdict?.state === 'held' && (own || current.pr === o.owner.pr) && !o.releasesHold && !o.breakLock) return { failure: { code: 'QUEUE_LAND_LOCKED', message: `#${current.pr}'s earlier land left the lock held on purpose: ${verdict.why.replace(/^its land left it held on purpose: /, '')}`, fix: scopedFix(current, 'held', expiry, o.now().getTime(), /changed this checkout/.test(verdict.why)) }, lines };
    const allowed = own ? null : o.takeover?.(current) ?? null;
    if (own) { /* this owner's own lock: resumed below */ } else if (allowed) lines.push(allowed);
    else if (verdict && !o.breakLock && (verdict.state === 'gone' || (verdict.state === 'unknown' && o.now().getTime() >= expiry))) {
      const why = verdict.state === 'gone' ? verdict.why : `it expired at ${new Date(expiry).toISOString()}, and ${verdict.why}`;
      tookOver = { pr: current.pr, holder: current.holder, sha: read.sha, why, at: o.now().toISOString() };
      lines.push(`LOCK_TAKEOVER: ${lockLabel(current)}'s land lock (holder ${current.holder}, phase ${current.phase}, since ${current.phase_at ?? current.started_at}): ${why}`);
    } else {
      const age = o.now().getTime() - Date.parse(current.phase_at ?? current.started_at);
      if (!o.breakLock) return { failure: { code: 'QUEUE_LAND_LOCKED', message: `${lockLabel(current)} holds the land lock (${current.holder}, phase ${current.phase}, since ${current.started_at})${verdict ? `; ${verdict.why}` : ''}`, ...(verdict ? { fix: scopedFix(current, verdict.state, expiry, o.now().getTime(), /changed this checkout/.test(verdict.why)) } : {}) }, lines };
      lines.push(`LOCK_HOLDER: ${lockLabel(current)} holder=${current.holder} phase=${current.phase} since=${current.started_at}`);
      const refusal = unbreakable(current, o, age);
      if (refusal) return { failure: refusal, lines };
      lines.push(`LOCK: broke ${lockLabel(current)}'s lock (${current.holder}, phase ${current.phase})`);
    }
  }
  const startedAt = own?.started_at ?? o.now().toISOString();
  const always = o.extra?.(own) ?? {};
  const write = (value: LandLock | Released) => {
    const w = writeLock(o.root, sha, value, remote);
    if (w.ok || w.origin === sha) return w;
    const seen = readLock(o.root, remote);
    if (seen.state !== 'held' || seen.sha === sha || !ownsLock(seen.lock, o.owner, o.journal) || seen.lock.holder !== o.holder || seen.lock.proc?.mark !== proc?.mark) return w;
    sha = seen.sha;
    return writeLock(o.root, sha, value, remote);
  };
  const set = (phase: LandLockPhase, extra: Partial<LandLock> = {}): QueueFailure | null => {
    const at = o.now();
    const next: LandLock = {
      pr: o.owner.pr, ...(o.owner.train ? { train: o.owner.train, slot: o.owner.slot } : {}), holder: o.holder, started_at: startedAt, phase, journal: o.journal, phase_at: at.toISOString(),
      ...(proc ? { proc } : {}), ...(scoped ? { expires_at: new Date(at.getTime() + scoped.ttlMs).toISOString() } : {}), ...always, ...extra,
    };
    const w = write(next);
    if (!w.ok) {
      if (w.origin === null) return { code: 'QUEUE_NOT_READY', message: `the land lock push to ${remote} failed and ${remote}'s lock could not be read, so this run cannot tell whether the push landed`, fix: 'rerun the same command once origin answers; it resumes this run\'s own lock' };
      return w.origin === sha
        ? { code: 'QUEUE_NOT_READY', message: `the land lock push to ${remote} failed and the lock there is unchanged; nothing was pushed` }
        : { code: 'QUEUE_LAND_LOCKED', message: 'the land lock moved under this run (another lander took it)' };
    }
    sha = w.sha; current = next;
    return null;
  };
  const markOf = (hold: string | null) => ({ pr: o.owner.pr, journal: o.journal, machine: thisMachine(), boot: proc!.boot, at: o.now().toISOString(), ...(hold ? { hold } : {}) });
  if (proc) writeMark(marks, proc.mark, markOf(null));
  const failed = set(o.phase(own), tookOver ? { took_over: tookOver } : {});
  if (failed) {
    if (proc) dropMark(marks, proc.mark);
    return { failure: failed, lines };
  }
  if (previousMark) dropMark(marks, previousMark);
  const held: HeldLandLock = {
    get lock() { return current!; },
    resumed: own,
    set,
    release: () => {
      const ok = write({ released: true, by: o.holder, at: o.now().toISOString() }).ok;
      if (ok && proc) dropMark(marks, proc.mark);
      return ok;
    },
    hold: reason => !proc || writeMark(marks, proc.mark, markOf(reason)),
  };
  return { held, lines };
}
