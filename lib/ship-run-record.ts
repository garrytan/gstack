/**
 * ship-run-record — the /ship run record (GST-3260, docs/ship-policy.md#what-ends-a-run). One JSON file in the checkout's git dir
 * (git rev-parse --git-path gstack-ship-run, one per worktree) replaces the bare run marker. Preflight opens it, every /ship command
 * that names its run beats it, gstack-ship-receipt stop marks it stopped and claim records the grant it spends, finish removes it,
 * gstack-skill-end marks it finished, and gstack-ship-run abandon ends a run that stopped working. Liveness never rests on a timer:
 * a run stays open until one of those commands ends it. A bare-text marker from an older gstack reads as `legacy` and a file that is
 * neither as `unreadable`; every guard treats both as open (fails closed). Each change runs under the gate lock as a compare-and-swap on
 * run and state (RUN_TRANSITIONS). The record guards against mistakes; it is not proof of who the owner is.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecordError } from './approval-record';
import { spawnSync } from './spawn-sync';

export type RunState = 'open' | 'stopped' | 'finished' | 'abandoned';
export interface RunRecord {
  v: 1; run: string; state: RunState; pr?: number; head: string; started_at: string; beat_at: string;
  stop?: { head: string; tree: string };
  claim?: { grant: string; stop_run?: string; stop_head: string; findings: string[]; pr?: number };
  ended_by?: string; reason?: string;
  /** The harness process preflight ran under (GST-3546): once it is provably gone, abandon takes the run at any age and it stops holding gstack upgrades. */
  owner?: RunOwner;
}
export type RunRead =
  | { kind: 'none'; file: string }
  | { kind: 'record'; file: string; record: RunRecord }
  | { kind: 'legacy'; file: string; run: string }
  | { kind: 'unreadable'; file: string; why: string; sha256?: string };
export type RunCommand = 'preflight' | 'beat' | 'stop' | 'claim' | 'skill-end' | 'finish' | 'abandon';
type From = RunState | 'none' | 'legacy' | 'unreadable';

export const RUN_ID = /^[A-Za-z0-9][\w.:-]{0,127}$/;
/** A run that beat this recently is working: abandon refuses it, unless its owner process is provably gone. */
export const ABANDON_AFTER_MS = 60 * 60_000;

/**
 * The harness a /ship run belongs to: the first ancestor that is not a shell or one of gstack's own bun wrappers (bin/gstack-harness-pid.sh walks shells the same way), with
 * this machine, its boot and the process's start time. shared marks a harness every session on the machine runs under
 * (capy-server, GSTACK_SHARED_HARNESSES), whose liveness says nothing about one run.
 */
export interface RunOwner { machine: string; boot: string; pid: number; start: number; comm: string; shared?: true }
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox', 'bun', 'timeout', 'env', 'flock', 'xargs']);
const SHARED_HARNESSES = new Set(['capy-server']);
function procOf(pid: number): { ppid: number; start: number; comm: string } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(f[1]), start: Number(f[19]), comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')).replace(/^-/, '') };
  } catch { return null; }
}
const readTrim = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const thisMachine = () => `${os.hostname()}/${readTrim('/etc/machine-id')}`;

/** This process's run owner, or null where /proc cannot say (off Linux): then only the run record's state and age apply. */
export function thisRunOwner(from = process.ppid): RunOwner | null {
  let pid = from;
  for (let hops = 0; hops < 8; hops++) {
    const p = procOf(pid);
    if (!p) return null;
    if (WRAPPERS.has(p.comm) && p.ppid <= 1) return null;
    if (!WRAPPERS.has(p.comm)) {
      const boot = readTrim('/proc/sys/kernel/random/boot_id');
      return boot ? { machine: thisMachine(), boot, pid, start: p.start, comm: p.comm, ...(SHARED_HARNESSES.has(p.comm) ? { shared: true as const } : {}) } : null;
    }
    pid = p.ppid;
  }
  return null;
}

/**
 * Whether a run's owner is provably gone: on this machine, it ran before the last boot, or its pid now names no process or one
 * that started at another time. A shared harness, another machine, a missing or malformed owner proves nothing.
 */
export function ownerGone(o: unknown): boolean {
  const w = o as RunOwner | undefined;
  if (!w || typeof w !== 'object' || w.shared || !Number.isInteger(w.pid) || w.pid <= 1 || !Number.isFinite(w.start) || typeof w.boot !== 'string' || w.machine !== thisMachine()) return false;
  if (w.boot !== readTrim('/proc/sys/kernel/random/boot_id')) return true;
  const p = procOf(w.pid);
  return !p || p.start !== w.start;
}
const STATES: readonly RunState[] = ['open', 'stopped', 'finished', 'abandoned'];
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The state each command may change and the state it leaves (`kept`: the state stays, a legacy marker becomes open). Every command but
 * preflight and abandon changes only its own run's record (a legacy marker whose text is the run counts, and is upgraded); preflight
 * replaces another run's record only once that run stopped or ended, never one naming its own id (a run id is one /ship run).
 */
export const RUN_TRANSITIONS: Readonly<Record<RunCommand, { from: readonly From[]; to: RunState | 'kept' | 'removed' }>> = {
  preflight: { from: ['none', 'stopped', 'finished', 'abandoned'], to: 'open' },
  beat: { from: ['open', 'stopped', 'legacy'], to: 'kept' },
  stop: { from: ['open', 'stopped', 'legacy'], to: 'stopped' },
  claim: { from: ['open', 'stopped', 'legacy'], to: 'open' },
  'skill-end': { from: ['open', 'stopped', 'legacy'], to: 'finished' },
  finish: { from: ['open', 'stopped', 'legacy'], to: 'removed' },
  abandon: { from: ['open', 'stopped', 'legacy', 'unreadable'], to: 'abandoned' },
};

const gitOut = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
};

/** The record's path in this checkout's git dir, or '' outside a checkout. */
export function runRecordPath(cwd: string): string {
  const p = gitOut(cwd, ['rev-parse', '--git-path', 'gstack-ship-run']);
  return p ? path.resolve(cwd, p) : '';
}

function invalid(o: any): string | null {
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return 'not a v1 run record';
  if (typeof o.run !== 'string' || !RUN_ID.test(o.run)) return 'its run is not a run id';
  if (!STATES.includes(o.state)) return `its state ${String(o.state)} is not open, stopped, finished or abandoned`;
  if (!SHA.test(String(o.head)) || !Number.isFinite(Date.parse(o.started_at)) || !Number.isFinite(Date.parse(o.beat_at))) return 'head, started_at or beat_at is missing or malformed';
  if (o.pr !== undefined && !(Number.isInteger(o.pr) && o.pr > 0)) return 'pr is not a PR number';
  if (o.stop !== undefined && !(SHA.test(String(o.stop?.head)) && SHA.test(String(o.stop?.tree)))) return 'stop is not {head, tree}';
  if (o.claim !== undefined && !(typeof o.claim?.grant === 'string' && SHA.test(String(o.claim.stop_head)) && Array.isArray(o.claim.findings))) return 'claim is not {grant, stop_head, findings}';
  return null;
}

export function readRunRecord(cwd: string, file = runRecordPath(cwd)): RunRead {
  if (!file) return { kind: 'none', file };
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch (e: any) { return e?.code === 'ENOENT' ? { kind: 'none', file } : { kind: 'unreadable', file, why: `cannot read it (${e?.code ?? e?.message})` }; }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8').trim();
  if (!text.startsWith('{')) return RUN_ID.test(text) ? { kind: 'legacy', file, run: text } : { kind: 'unreadable', file, why: 'neither a run record nor a run id', sha256 };
  let o: unknown;
  try { o = JSON.parse(text); } catch { return { kind: 'unreadable', file, why: 'not valid JSON', sha256 }; }
  const why = invalid(o);
  return why ? { kind: 'unreadable', file, why, sha256 } : { kind: 'record', file, record: o as RunRecord };
}

/** The run a record names: its own, a legacy marker's text, or none for an unreadable file. */
export const recordRun = (read: RunRead) => read.kind === 'record' ? read.record.run : read.kind === 'legacy' ? read.run : undefined;

export interface OpenRun { run: string; state: RunState | 'legacy' | 'unreadable'; stop?: RunRecord['stop']; claim?: RunRecord['claim']; detail: string; line: string }
/**
 * The run every guard must respect: an open, stopped, legacy or unreadable record; none once it finished or was abandoned. `detail` is what
 * each refusal prints: the state, beat_age, the earliest time abandon takes it and the exact command.
 */
export function openRun(read: RunRead, now = Date.now()): OpenRun | undefined {
  if (read.kind === 'none' || (read.kind === 'record' && (read.record.state === 'finished' || read.record.state === 'abandoned'))) return undefined;
  const run = recordRun(read) ?? 'unknown';
  const state = read.kind === 'record' ? read.record.state : read.kind;
  const beat = read.kind === 'record' ? Date.parse(read.record.beat_at) : NaN;
  const age = Number.isFinite(beat) ? `${Math.max(0, Math.floor((now - beat) / 60_000))}m` : 'unknown';
  const from = new Date(Number.isFinite(beat) ? Math.max(now, beat + ABANDON_AFTER_MS) : now).toISOString();
  const command = read.kind === 'unreadable'
    ? `gstack-ship-run abandon --run unknown --sha256 ${read.sha256 ?? '<its digest: the file is unreadable, so fix its permissions first>'} --by <lane or Captain> --reason "<one line>"`
    : `gstack-ship-run abandon --run ${run} --by <lane or Captain> --reason "<one line>"`;
  const detail = `state ${state}, beat_age ${age}; ${read.kind === 'unreadable' ? `${read.file} ${read.why}; ` : ''}once it has stopped working, end it from ${from} with ${command}`;
  return { run, state, ...(read.kind === 'record' && read.record.stop ? { stop: read.record.stop } : {}), ...(read.kind === 'record' && read.record.claim ? { claim: read.record.claim } : {}), detail, line: `/ship run ${run} is open on this checkout (${detail})` };
}

/** Run `fn` holding the repository's gate-disposition lock (a directory in the git common dir; one older than a minute is stale). */
export function withGateLock<T>(cwd: string, fn: () => T, waitMs = 15_000): T | RecordError {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (common.status !== 0 || !common.stdout.trim()) return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `no git common dir at ${cwd}, so the gate-disposition lock cannot be taken` };
  const lock = path.join(path.resolve(cwd, common.stdout.trim()), 'gstack-gate-disposition.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e: any) {
      if (e.code !== 'EEXIST') return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${lock}: ${e.code ?? e.message}` };
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > until) return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${lock} is held; another gate disposition or /ship preflight is writing (rerun in a moment)` };
      Bun.sleepSync(100);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export type RunChange = { ok: true; record: RunRecord | null; from: From } | { ok: false; why: string };

/**
 * Apply one command to this checkout's record under the gate lock: re-read it, check RUN_TRANSITIONS and whose run it is, run the
 * caller's own `check` on what it read, then write a temp file and rename it over the record (finish removes it). A beat touches only
 * beat_at. Nothing is written when any check fails.
 */
export function changeRunRecord(cwd: string, cmd: RunCommand, run: string, patch: Partial<RunRecord> = {}, o: { waitMs?: number; check?: (read: RunRead) => string | null } = {}): RunChange {
  const held = withGateLock(cwd, (): RunChange => { try {
    const read = readRunRecord(cwd);
    if (!read.file) return { ok: false, why: 'not inside a git checkout' };
    const from: From = read.kind === 'record' ? read.record.state : read.kind;
    const owner = recordRun(read);
    if (!RUN_TRANSITIONS[cmd].from.includes(from)) return { ok: false, why: from === 'none' ? `${cmd} needs a run record, and this checkout has none` : `${cmd} cannot change the ${from} record${owner ? ` of run ${owner}` : ''}` };
    if (cmd === 'preflight' && owner === run) return { ok: false, why: `the record already names run ${run} (${from}): a run id is one /ship run` };
    if (cmd !== 'preflight' && cmd !== 'abandon' && owner !== run) return { ok: false, why: `the record is run ${owner ?? 'unknown'}'s, not ${run}'s` };
    const refused = o.check?.(read);
    if (refused) return { ok: false, why: refused };
    if (RUN_TRANSITIONS[cmd].to === 'removed') { fs.rmSync(read.file, { force: true }); return { ok: true, record: null, from }; }
    const now = new Date().toISOString();
    const prior = read.kind === 'record' && cmd !== 'preflight' ? read.record : undefined;
    const to = RUN_TRANSITIONS[cmd].to;
    const head = prior?.head ?? gitOut(cwd, ['rev-parse', 'HEAD']).toLowerCase();
    if (!SHA.test(head)) return { ok: false, why: 'HEAD does not resolve to a commit' };
    const record: RunRecord = cmd === 'beat' && prior ? { ...prior, beat_at: now }
      : { ...prior, v: 1, run: owner && cmd !== 'preflight' ? owner : run, head, started_at: prior?.started_at ?? now, ...patch, state: to === 'kept' ? prior?.state ?? 'open' : to as RunState, beat_at: now };
    const tmp = `${read.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n');
    fs.renameSync(tmp, read.file);
    return { ok: true, record, from };
  } catch (e) { return { ok: false, why: (e as Error).message.split('\n')[0]! }; } }, o.waitMs);
  return 'code' in held ? { ok: false, why: held.message } : held;
}

/**
 * gstack-review-log --start/--finish beat the run that owns this checkout's open or stopped record. The token cap's budget marker
 * names a budget run id (lib/ship-budget.ts), never the /ship run id, so it cannot pick the run. A beat never fails the review log.
 */
export function beatFromReview(cwd: string): void {
  try {
    const read = readRunRecord(cwd);
    if (read.kind !== 'record' || !openRun(read)) return;
    changeRunRecord(cwd, 'beat', read.record.run, {}, { waitMs: 2_000 });
  } catch { /* a beat is advisory */ }
}

/**
 * Finish's end of the run (amendment F): remove the record only when the PR body names its run (a stub, stop, grant or receipt entry),
 * or when there is no PR body to read (`named` null), so a late finish never removes another run's record. An unreadable record stays.
 */
export function finishRun(cwd: string, named: readonly string[] | null): { removed: boolean; line?: string } {
  const read = readRunRecord(cwd);
  const owner = recordRun(read);
  if (read.kind === 'unreadable') return { removed: false, line: `RUN_RECORD: kept (${read.file} ${read.why}; gstack-ship-run status prints the abandon command)` };
  if (!owner || (read.kind === 'record' && !openRun(read))) return { removed: false };
  if (named && !named.includes(owner)) return { removed: false, line: `RUN_RECORD: kept (the PR body names no entry of run ${owner}, so this finish is not its run's; gstack-ship-run status)` };
  const done = changeRunRecord(cwd, 'finish', owner);
  return done.ok ? { removed: true } : { removed: false, line: `RUN_RECORD: kept (${done.why})` };
}

/**
 * gstack-ship-run abandon's checks on what it read: never as gstack, the run named exactly (an unreadable record as `unknown` with its
 * digest), and never a record whose beat_at is under ABANDON_AFTER_MS old while its owner may still run. A legacy marker or an unreadable
 * record has no beat, and a record whose owner process is provably gone (ownerGone) is no longer working, so either goes at any age.
 */
export function abandonRefusal(read: RunRead, run: string, sha256: string | undefined, now = Date.now()): string | null {
  if (read.kind === 'unreadable') return run !== 'unknown' ? `the record is unreadable (${read.why}): pass --run unknown --sha256 <its digest from gstack-ship-run status>`
    : !read.sha256 || sha256 !== read.sha256 ? `--sha256 does not match the unreadable record's digest ${read.sha256 ?? '(unreadable bytes)'}: it changed since you read it, or the digest is wrong` : null;
  if (recordRun(read) !== run) return `the record names run ${recordRun(read) ?? 'none'}, not ${run}`;
  if (read.kind !== 'record' || ownerGone(read.record.owner)) return null;
  const beat = Date.parse(read.record.beat_at);
  return now - beat < ABANDON_AFTER_MS ? `run ${run} beat ${Math.floor((now - beat) / 60_000)}m ago (state ${read.record.state}, beat_age ${Math.floor((now - beat) / 60_000)}m; the earliest abandon is ${new Date(beat + ABANDON_AFTER_MS).toISOString()}): a run that beat in the last 60 minutes is still working` : null;
}
