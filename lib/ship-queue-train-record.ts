/**
 * Merge-train records (docs/ship-policy.md#run-a-merge-train): versioned
 * `train.json`, one attempt record per dispatch, the bisect ledger, READY
 * receipts and the queue freeze, under `$GSTACK_STATE_ROOT/ship-queue/`
 * (lib/state-root.ts resolves the root). Every record is mirrored to origin
 * as a git note under `refs/notes/gstack-trains`, each on a blob named for
 * the record, so a lost machine rebuilds its state with `train status`. A
 * record is written locally before its note, and the note before any remote
 * effect that depends on it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactFindingSpans } from './redact-engine';
import { git, sha256, writeJsonAtomic } from './ship-queue-gate';
import { resolveStateRoot } from './state-root';

export const TRAIN_SCHEMA = 1;
export const NOTES_REF = 'refs/notes/gstack-trains';
const NOTES_REMOTE_REF = 'refs/notes/gstack-trains-origin';

export type TrainState =
  | 'built' | 'pushed' | 'free-pending' | 'free-red' | 'free-green' | 'dispatch-unknown' | 'dispatch-absent' | 'gate-pending'
  | 'green' | 'red' | 'incomplete' | 'attributed' | 'red-on-main' | 'unattributed' | 'merging' | 'merged' | 'superseded' | 'stale';
/** States after which a train never dispatches again; prune deletes their branches (`stale`: every PR merged or closed outside the train, `train prune --stale`). */
export const TERMINAL_STATES: readonly TrainState[] = ['free-red', 'attributed', 'red-on-main', 'merged', 'superseded', 'stale'];

/** What the screen run itself said (lib/ship-queue-screen.ts), recorded when it was read; absent while the run is pending or unread. */
export interface ScreenVerdictRecord { outcome: 'GREEN' | 'RED' | 'NOT_RUN' | 'INCOMPLETE'; run: number; red: string[]; flaky: string[]; detail: string; read_at: string }
export interface ScreenChoice {
  choice: 'screen' | 'no-screen'; policy: 'narrow' | 'broad' | null; nonce: string | null; run: number | null; merge_sha: string | null;
  /** The scratch branch `ready --screen` pushed when GitHub's merge ref lagged the head (docs/ship-policy.md#run-a-merge-train). */
  branch?: string;
  verdict?: ScreenVerdictRecord;
}
export interface TrainSlot { pr: string; head: string; ready_at: string; screen: ScreenChoice }
export interface TrainPrefix { index: number; commit: string; tree: string; pr: string | null }
/** A stamped prefix S_i (changelog_fragments trains, lib/ship-queue-train-stamp.ts): what slot i publishes, exactly. */
export interface StampedPrefix { index: number; commit: string; tree: string; pr: string; version: string; date: string }
export interface FreeRun { run: number | null; url: string | null; head_sha: string | null; conclusion: string | null; verdict: 'green' | 'red' | 'missing' | 'stale' | 'cancelled' | 'pending' }
export interface TrainRecord {
  schema: 1; kind: 'train'; nonce: string; key: string; repo_key: string; repo: string; base: { ref: string; sha: string }; policy: string;
  slots: TrainSlot[]; held: string[]; prefixes: TrainPrefix[]; head: string; tree: string; branch: string;
  urgent: boolean; repair: boolean; explicit_order?: boolean; state: TrainState; free: FreeRun | null; attempts: string[];
  merged: Array<{ pr: string; sha: string; tree: string; at: string }>; superseded_by: string | null;
  /** S_1..S_k when the base policy declares changelog_fragments; head and tree are then S_k's. Absent on plain trains. */
  stamped?: StampedPrefix[];
  effects: Array<{ at: string; what: string }>; error: string | null; created_at: string; updated_at: string;
}
export type AttemptPurpose = 'gate' | 'rebuild' | 'infra-redispatch' | 'bisect';
export type GateOutcome = 'PENDING' | 'GREEN' | 'RED' | 'INCOMPLETE';
export interface CasePanel {
  case: string; kind: string; status: string; red_class: string | null; cost_usd: number | null;
  /** Rule 16: a PASS that failed once and passed on its one rerun, with where each ran. */
  flaky?: { first: string; rerun: string };
}
export interface AttemptRecord {
  schema: 1; kind: 'train-attempt'; train: string; id: string; purpose: AttemptPurpose; nonce: string; workflow: string; ref: string;
  inputs: Record<string, string>; state: 'dispatching' | 'unknown' | 'absent' | 'dispatched' | 'completed'; run: { id: number; url: string } | null;
  outcome: GateOutcome | null; detail: string | null; red_cases: string[]; panels: CasePanel[]; infra_eligible: boolean;
  cost_usd: number | null; prefixes: number[]; created_at: string; updated_at: string;
}
export type PrefixResult = 'red' | 'green';
export interface BisectRecord {
  schema: 1; kind: 'train-bisect'; train: string; cases: string[]; spend_cap: number; spent_usd: number;
  prefixes: Array<{ index: number; sha: string; results: Record<string, PrefixResult>; attempts: string[] }>;
  outcome: null | { kind: 'attributed' | 'red-on-main' | 'unattributed'; all_green: boolean; prs: string[]; patterns: Record<string, string>; at: string };
  updated_at: string;
}
export interface FreezeRecord {
  schema: 1; kind: 'freeze'; repo_key: string; train: string; merged: string[]; unmerged: Array<{ pr: string; head: string }>;
  /** Slots GitHub could not answer for beside a merged one: neither merged nor unmerged (#3519); absent on records written before the field. */
  unreadable?: Array<{ pr: string; head: string }>;
  main: { sha: string; tree: string }; reason: string; backstop: { nonce: string; run: number | null; state: string } | null;
  repair: { pr: string; head: string; train: string | null } | null; created_at: string; cleared_at: string | null; cleared_by: string | null; updated_at: string;
}
export interface ReadyReceipt {
  schema: 1; kind: 'ready'; repo_key: string; pr: string; head: string; base_sha: string; ready_at: string; screen: ScreenChoice; updated_at: string;
}
export type AnyRecord = TrainRecord | AttemptRecord | BisectRecord | FreezeRecord | ReadyReceipt;

/** Clock seam for fill-time and record tests (`GSTACK_SHIP_QUEUE_NOW`, ISO-8601). */
export function nowIso(): string {
  const fixed = process.env.GSTACK_SHIP_QUEUE_NOW;
  return fixed && !Number.isNaN(Date.parse(fixed)) ? new Date(fixed).toISOString() : new Date().toISOString();
}

/** An unexpected failure's cause, with secrets withheld, for the record and the error line. */
export function redactCause(message: string): string {
  const text = message.replace(/\s+/g, ' ').slice(0, 400);
  return redactFindingSpans(text) ?? '(cause withheld: it could not be redacted safely)';
}

export function queueRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'ship-queue');
}
export const trainDir = (nonce: string) => path.join(queueRoot(), 'trains', nonce);
export const trainFile = (nonce: string) => path.join(trainDir(nonce), 'train.json');
const attemptPath = (nonce: string, id: string) => path.join(trainDir(nonce), 'attempts', `${id}.json`);
const bisectPath = (nonce: string) => path.join(trainDir(nonce), 'bisect.json');
const freezePath = (repoKey: string) => path.join(queueRoot(), 'freeze', `${repoKey}.json`);
export const readyPath = (repoKey: string, pr: string, head: string) => path.join(queueRoot(), 'ready', repoKey, `${pr}-${head}.json`);

/** Hosts that serve GitHub repositories at /<owner>/<repo> (git.capy.ai is Capy's GitHub proxy, set through url.insteadOf). */
const GITHUB_HOSTS = ['github.com', 'www.github.com', 'ssh.github.com', 'git.capy.ai'];

/** Before 1.91.187.0 the key hashed origin's URL with only .git, git@github.com: and trailing slashes normalized. */
const legacyNorm = (url: string) => url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/\/+$/, '');

/** A remote URL as https://github.com/<owner>/<repo> when it names a GitHub repository in any form (scp, ssh, http(s), credentials, proxy host); otherwise the legacy form. */
export function normalizeRemoteUrl(url: string): string {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
  if (m && GITHUB_HOSTS.includes(m[1]!.toLowerCase())) return `https://github.com/${m[2]!.toLowerCase()}/${m[3]!.toLowerCase()}`;
  return legacyNorm(url.trim().replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1'));
}

/**
 * The repository's identity, keyed so records of different repositories
 * never mix: a hash of origin's URL normalized to owner/repo, so lanes whose
 * origin names the same GitHub repository in another form share one key.
 * `keys` adds the keys earlier versions wrote for this URL and for the
 * repository's common URL forms; readers accept all of them, writers use `key`.
 */
export function repoIdentity(repoRoot: string): { key: string; url: string; keys: string[] } {
  const raw = git(repoRoot, ['config', '--get', 'remote.origin.url']).out.trim() || repoRoot;
  const url = normalizeRemoteUrl(raw);
  const key = sha256(url).slice(0, 16);
  const gh = /^https:\/\/github\.com\/(.+)$/.exec(url)?.[1];
  const forms = gh ? GITHUB_HOSTS.flatMap(h => ['https', 'http', 'ssh://git@'].map(s => `${s.includes('://') ? s : `${s}://`}${h}/${gh}`)) : [];
  const keys = [...new Set([key, ...[raw, ...forms].map(u => sha256(legacyNorm(u)).slice(0, 16))])];
  return { key, url, keys };
}

function readJson<T>(file: string, kind: string): T | null {
  try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r?.schema === TRAIN_SCHEMA && r.kind === kind ? r as T : null; } catch { return null; }
}

export const loadTrain = (nonce: string) => (/^[A-Za-z0-9._-]{1,128}$/.test(nonce) ? readJson<TrainRecord>(trainFile(nonce), 'train') : null);
export const loadAttempt = (nonce: string, id: string) => (/^[A-Za-z0-9._-]{1,64}$/.test(id) ? readJson<AttemptRecord>(attemptPath(nonce, id), 'train-attempt') : null);
export const loadBisect = (nonce: string) => readJson<BisectRecord>(bisectPath(nonce), 'train-bisect');
/** A reader's repo keys: the current key first, then the legacy keys (repoIdentity().keys). */
type RepoKeys = string | readonly string[];
const keyList = (k: RepoKeys): readonly string[] => (typeof k === 'string' ? [k] : k);
const firstOf = <T>(k: RepoKeys, read: (key: string) => T | null): T | null => { for (const key of keyList(k)) { const r = read(key); if (r) return r; } return null; };

export const loadFreeze = (repoKeys: RepoKeys) => firstOf(repoKeys, key => readJson<FreezeRecord>(freezePath(key), 'freeze'));
export const loadReady = (repoKeys: RepoKeys, pr: string, head: string) => firstOf(repoKeys, key => readJson<ReadyReceipt>(readyPath(key, pr, head), 'ready'));
export const activeFreeze = (repoKeys: RepoKeys): FreezeRecord | null => firstOf(repoKeys, key => { const f = readJson<FreezeRecord>(freezePath(key), 'freeze'); return f && !f.cleared_at ? f : null; });

export function attemptsOf(train: TrainRecord): AttemptRecord[] {
  return train.attempts.map(id => loadAttempt(train.nonce, id)).filter((a): a is AttemptRecord => !!a);
}

/** Every train of this repository, newest first. */
export function listTrains(repoKeys: RepoKeys): TrainRecord[] {
  const dir = path.join(queueRoot(), 'trains');
  if (!fs.existsSync(dir)) return [];
  const keys = keyList(repoKeys);
  return fs.readdirSync(dir).map(n => loadTrain(n)).filter((t): t is TrainRecord => !!t && keys.includes(t.repo_key))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.nonce.localeCompare(a.nonce));
}

export function recordPath(r: AnyRecord): string {
  if (r.kind === 'train') return trainFile(r.nonce);
  if (r.kind === 'train-attempt') return attemptPath(r.train, r.id);
  if (r.kind === 'train-bisect') return bisectPath(r.train);
  if (r.kind === 'freeze') return freezePath(r.repo_key);
  return readyPath(r.repo_key, r.pr, r.head);
}

export function noteName(r: AnyRecord): string {
  if (r.kind === 'train') return `gstack-trains:train:${r.nonce}`;
  if (r.kind === 'train-attempt') return `gstack-trains:attempt:${r.train}:${r.id}`;
  if (r.kind === 'train-bisect') return `gstack-trains:bisect:${r.train}`;
  if (r.kind === 'freeze') return `gstack-trains:freeze:${r.repo_key}`;
  return `gstack-trains:ready:${r.repo_key}:${r.pr}:${r.head}`;
}

const NOTES_IDENTITY = { GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue', GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local' };
const notesEnv = () => ({ ...process.env, ...NOTES_IDENTITY });

/** Fetch origin's notes and fold them into the local notes ref (the local side wins a same-record conflict). */
export function fetchNotes(repoRoot: string, remote = 'origin'): { ok: boolean; detail: string } {
  const f = git(repoRoot, ['fetch', '--no-tags', '-q', remote, `+${NOTES_REF}:${NOTES_REMOTE_REF}`]);
  if (!f.ok) {
    const absent = /couldn't find remote ref|no such ref/i.test(f.err);
    return { ok: absent, detail: absent ? `${remote} has no ${NOTES_REF} yet` : `git fetch ${NOTES_REF} failed: ${f.err.slice(0, 160)}` };
  }
  const local = git(repoRoot, ['rev-parse', '--verify', '--quiet', NOTES_REF]).out;
  const fetched = git(repoRoot, ['rev-parse', '--verify', '--quiet', NOTES_REMOTE_REF]).out;
  if (!local) { git(repoRoot, ['update-ref', NOTES_REF, fetched]); return { ok: true, detail: 'notes fetched' }; }
  if (local === fetched || git(repoRoot, ['merge-base', '--is-ancestor', fetched, local]).ok) return { ok: true, detail: 'notes current' };
  const m = git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'merge', '-q', '-s', 'ours', NOTES_REMOTE_REF], notesEnv());
  return m.ok ? { ok: true, detail: 'notes merged' } : { ok: false, detail: `git notes merge failed: ${m.err.slice(0, 160)}` };
}

function addNote(repoRoot: string, r: AnyRecord): boolean {
  const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], undefined, noteName(r));
  if (!blob.ok) return false;
  return git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', '-', blob.out], notesEnv(), JSON.stringify(r)).ok;
}

/**
 * Write records locally, then as notes, then push the notes ref (fetch,
 * merge and retry on a race). A failed push leaves the local records and
 * notes for the next write to carry, and says so.
 */
export function persist(repoRoot: string, records: AnyRecord[], opts: { push?: boolean; remote?: string } = {}): { pushed: boolean; detail: string } {
  for (const r of records) writeJsonAtomic(recordPath(r), r);
  if (!records.every(r => addNote(repoRoot, r))) return { pushed: false, detail: 'could not write the notes locally' };
  if (opts.push === false) return { pushed: false, detail: 'notes written locally (not pushed)' };
  const remote = opts.remote ?? 'origin';
  let last = '';
  for (let i = 0; i < 3; i++) {
    const p = git(repoRoot, ['push', '-q', remote, `${NOTES_REF}:${NOTES_REF}`]);
    if (p.ok) return { pushed: true, detail: `notes pushed to ${remote} ${NOTES_REF}` };
    last = p.err.slice(0, 160);
    const f = fetchNotes(repoRoot, remote);
    if (!f.ok) return { pushed: false, detail: f.detail };
  }
  return { pushed: false, detail: `git push ${NOTES_REF} failed: ${last}` };
}

function newerOrMissing(r: AnyRecord): boolean {
  try {
    const cur = JSON.parse(fs.readFileSync(recordPath(r), 'utf8'));
    return !(typeof cur.updated_at === 'string' && cur.updated_at >= r.updated_at);
  } catch { return true; }
}

function parseNote(text: string): AnyRecord | null {
  try {
    const r = JSON.parse(text);
    const ids = /^[A-Za-z0-9._-]{1,128}$/;
    if (r?.schema !== TRAIN_SCHEMA || typeof r.updated_at !== 'string') return null;
    if (r.kind === 'train' && ids.test(r.nonce)) return r;
    if ((r.kind === 'train-attempt' && ids.test(r.train) && ids.test(r.id)) || (r.kind === 'train-bisect' && ids.test(r.train))) return r;
    if (r.kind === 'freeze' && ids.test(r.repo_key)) return r;
    if (r.kind === 'ready' && ids.test(r.repo_key) && /^\d+$/.test(r.pr) && /^[0-9a-f]{40,64}$/.test(r.head)) return r;
  } catch {}
  return null;
}

/**
 * Remove records from the notes ref (`train forget`): each named note is
 * removed locally, then the ref is pushed under an exact lease on the remote
 * tip this call fetched, so a concurrent writer's push is never overwritten
 * (a rejected lease returns `pushed: false` and nothing is deleted locally).
 * Names are note names (noteName); a name with no note is reported missing.
 */
export function forgetNotes(repoRoot: string, names: string[], remote = 'origin'): { removed: string[]; missing: string[]; failed: string[]; pushed: boolean; lease: string | null; detail: string } {
  const f = fetchNotes(repoRoot, remote);
  if (!f.ok) return { removed: [], missing: [], failed: [], pushed: false, lease: null, detail: f.detail };
  const lease = git(repoRoot, ['rev-parse', '--verify', '--quiet', NOTES_REMOTE_REF]).out || null;
  const before = git(repoRoot, ['rev-parse', '--verify', '--quiet', NOTES_REF]).out || null;
  const listed = git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'list']).out.split('\n').map(l => l.split(' ')[1]).filter(Boolean);
  const removed: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  const restore = () => { if (before) git(repoRoot, ['update-ref', NOTES_REF, before]); };
  for (const name of names) {
    const blob = git(repoRoot, ['hash-object', '--stdin'], undefined, name).out;
    if (!listed.includes(blob)) { missing.push(name); continue; }
    if (git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'remove', blob], notesEnv()).ok) removed.push(name); else failed.push(name);
  }
  if (failed.length) { restore(); return { removed: [], missing, failed, pushed: false, lease, detail: `git notes remove failed for ${failed.join(', ')}; the local notes ref was restored` }; }
  if (!removed.length) return { removed, missing, failed, pushed: false, lease, detail: 'no note to remove' };
  const p = git(repoRoot, ['push', '-q', lease ? `--force-with-lease=${NOTES_REF}:${lease}` : `--force-with-lease=${NOTES_REF}`, remote, `${NOTES_REF}:${NOTES_REF}`]);
  if (!p.ok) restore();
  return { removed, missing, failed, pushed: p.ok, lease, detail: p.ok ? `notes pushed to ${remote} ${NOTES_REF} (lease ${lease?.slice(0, 12) ?? 'new ref'})` : `git push ${NOTES_REF} rejected: ${p.err.replace(/\s+/g, ' ').trim().slice(0, 160)}; the local notes ref was restored` };
}

/** Rebuild local records from the notes ref: a note whose record is missing locally, or newer than the local copy, is written. */
export function rebuildFromNotes(repoRoot: string, remote = 'origin'): { restored: number; read: number; detail: string } {
  const f = fetchNotes(repoRoot, remote);
  const list = git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'list']);
  if (!list.ok || !list.out.trim()) return { restored: 0, read: 0, detail: f.detail };
  const records = list.out.split('\n').map(l => l.split(' ')[0]!).filter(Boolean)
    .map(blob => parseNote(git(repoRoot, ['cat-file', 'blob', blob]).out)).filter((r): r is AnyRecord => !!r);
  const fresh = records.filter(newerOrMissing);
  for (const r of fresh) writeJsonAtomic(recordPath(r), r);
  return { restored: fresh.length, read: records.length, detail: f.detail };
}
