/**
 * review-sweep — the per-stage sweep that enforces the fetch rule (GST-1322 PR B, docs/review-policy.md#what-readers-may-fetch).
 *
 * Capy exposes no reader's jam id, so a pass cannot read a reader's own tool calls. Instead the pass program takes an
 * inventory of git repositories and big files under fixed roots before a stage's readers start, and again after the last
 * of them is collected. A repository that is new and has a network remote, or a new file of BIG_BYTES or more, is a fetch
 * that stage made. Attribution is per stage: every reader of the stage is quarantined (its reply moved under
 * <out>/quarantine/, its findings taken out of merged.jsonl), verify refuses, and the stage reruns once, each slot as
 * `<reader>#2`. A second violation stops the pass. A sweep that hit its bounds is `partial`: a note, never a refusal.
 *
 * Nothing here deletes anything, and nothing prints a delete command: no transcript can attribute a path to a reader today,
 * so every found path is reported as KEEP for the lane to inspect and leave alone.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { networkTarget } from './review-fetch';
import { appendEvent, readLedger, readerKey } from './review-ledger';
import type { Manifest, PassReader, Stage } from './review-pass';

export const SWEEP_DEPTH = 6;
export const SWEEP_MAX_ENTRIES = 200_000;
export const SWEEP_BUDGET_MS = 20_000;
export const BIG_BYTES = 100 * 1024 * 1024;
const SKIP = new Set(['node_modules', '.git']);
const SCP = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)[\w./-]+$/;

export interface Inventory { at: number; roots: string[]; repos: Record<string, string[]>; big: Record<string, number>; partial?: string }
export interface Found { path: string; kind: 'repo' | 'download'; remote?: string; bytes: number | null }
export type SweepVerdict = 'clean' | 'violation' | 'partial';
export interface StageSweep {
  attempt: number;
  start?: { at: string; file: string; partial?: string };
  end?: { at: string; verdict: SweepVerdict; found: Found[]; partial?: string };
  /** Earlier attempts of this stage, newest last. */
  history?: Array<Omit<StageSweep, 'history'>>;
}

/** The workspace (the checkout's parent), home and the temp dir, or GSTACK_SWEEP_ROOTS (path-delimited; tests); drives are never walked. */
export const defaultRoots = (checkout: string) => process.env.GSTACK_SWEEP_ROOTS?.split(path.delimiter).filter(Boolean) ?? [path.dirname(checkout), os.homedir(), os.tmpdir()];
export const defaultSkip = () => [path.join(os.homedir(), '.capy', 'drive')];

/**
 * A remote URL with nothing that can carry a credential: userinfo removed and a query read as `?<redacted>`
 * (`https://user:PASSWORD@host/r.git#x` reads `https://host/r.git#x`). git's `[user@]host:path` form has no password and stays
 * as it is. Anything else, a value the URL parser rejects included, reads `<redacted>`: it is never recorded or printed raw.
 */
export function redactUrl(v: string): string {
  if (SCP.test(v)) return v;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return '<redacted>';
  try {
    const u = new URL(v);
    if (!u.username && !u.password && !u.search) return v;
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?<redacted>' : ''}${u.hash}`;
  } catch { return '<redacted>'; }
}

/**
 * Whether git would reach a remote over the network: any `scheme://` but `file:`, a `<transport>::` helper, or git's
 * `[user@]host:path` form (a colon with no slash before it; one letter before it is a Windows drive).
 */
export function networkRemote(v: string): boolean {
  if (/^file:/i.test(v)) return false;
  return networkTarget(v) !== null || /^[a-z][a-z0-9+.-]*:(?::|\/\/)/i.test(v) || /^(?:[^@/]+@)?(?:\[[^\]/]+\]|[^/:@[]{2,}):(?!\/\/)/.test(v);
}

/**
 * A repository's network remotes as git itself reads its config (quoted values, escapes and `#` included), classified on
 * the raw value and recorded only through redactUrl.
 */
function remotes(gitDir: string): string[] {
  const r = spawnSync('git', ['config', '--file', path.join(gitDir, 'config'), '--null', '--get-regexp', '\\.url$'], { encoding: 'utf8', timeout: 5_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\0').flatMap(e => { const i = e.indexOf('\n'); const v = e.slice(i + 1); return i >= 0 && networkRemote(v) ? [redactUrl(v)] : []; });
}

/** The git directory a directory holds: its `.git` (a directory, or a file naming one), or itself when it is a bare repository. */
function gitDirOf(dir: string, names: Set<string>): string | null {
  if (names.has('.git')) {
    const g = path.join(dir, '.git');
    try {
      if (fs.statSync(g).isDirectory()) return g;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      return m ? path.resolve(dir, m[1]!.trim()) : null;
    } catch { return null; }
  }
  return names.has('HEAD') && names.has('objects') && names.has('refs') ? dir : null;
}

/**
 * Git repositories (with their redacted network remotes) and files of BIG_BYTES or more under the roots, to SWEEP_DEPTH, without following
 * symlinks or entering node_modules, .git or a repository other than the checkout. Past SWEEP_MAX_ENTRIES entries or
 * SWEEP_BUDGET_MS the inventory stops and says so in `partial`.
 */
export function inventory(roots: readonly string[], checkout: string, skip: readonly string[] = defaultSkip(), now = Date.now()): Inventory {
  const inv: Inventory = { at: now, roots: roots.map(r => realOr(r)), repos: {}, big: {} };
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const home = realOr(checkout);
  const seen = new Set<string>();
  let entries = 0;
  const walk = (dir: string, depth: number) => {
    if (inv.partial || seen.has(dir) || skip.some(s => dir === s || dir.startsWith(s + path.sep))) return;
    seen.add(dir);
    let list: fs.Dirent[];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries += list.length;
    if (entries > SWEEP_MAX_ENTRIES) { inv.partial = `more than ${SWEEP_MAX_ENTRIES} entries`; return; }
    if (Date.now() > deadline) { inv.partial = `past ${SWEEP_BUDGET_MS / 1000}s`; return; }
    const gitDir = gitDirOf(dir, new Set(list.map(d => d.name)));
    if (gitDir) { inv.repos[dir] = remotes(gitDir); if (dir !== home) return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isFile()) { try { const s = fs.statSync(p); if (s.size >= BIG_BYTES) inv.big[p] = s.size; } catch { /* gone */ } continue; }
      if (d.isDirectory() && !SKIP.has(d.name) && depth < SWEEP_DEPTH) walk(p, depth + 1);
    }
  };
  for (const r of inv.roots) walk(r, 0);
  return inv;
}

function realOr(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function du(p: string): number | null {
  const r = spawnSync('du', ['-sk', p], { encoding: 'utf8', timeout: 10_000 });
  const kb = Number(/^(\d+)/.exec(r.stdout ?? '')?.[1]);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

/** What the stage fetched: repositories new since the start inventory with a network remote, and new big files outside them. */
export function sweepDiff(start: Inventory, end: Inventory): Found[] {
  const found: Found[] = [];
  for (const [p, urls] of Object.entries(end.repos)) {
    const remote = urls[0];
    if (p in start.repos || !remote) continue;
    found.push({ path: p, kind: 'repo', remote, bytes: du(p) });
  }
  for (const [p, bytes] of Object.entries(end.big)) {
    if (p in start.big || found.some(f => p.startsWith(f.path + path.sep))) continue;
    found.push({ path: p, kind: 'download', bytes });
  }
  return found;
}

/**
 * The end of a stage. With no start inventory, or one that stopped at its bounds, the sweep cannot tell a path the start
 * never reached from a new one, so what it finds is a `partial` note, never a violation.
 */
export function sweepResult(start: Inventory | null, end: Inventory | null): { found: Found[]; verdict: SweepVerdict; partial?: string } {
  const found = start && end ? sweepDiff(start, end) : [];
  const partial = !start ? 'no start inventory' : start.partial ?? end?.partial;
  const verdict = found.length && !start?.partial ? 'violation' : partial ? 'partial' : 'clean';
  return { found, verdict, ...(partial ? { partial } : {}) };
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const safe = (reader: string) => reader.replace(/[^a-zA-Z0-9._-]/g, '_');

/**
 * The lines a violation prints for each found path: what it is, then KEEP (never a delete command). A path or remote with a
 * control character prints JSON-quoted, so it can never start a line of its own.
 */
const control = (s: string) => /[\x00-\x1f\x7f]/.test(s);
const shownPath = (p: string) => (control(p) ? JSON.stringify(p) : q(p));

export function foundLines(stage: Stage, attempt: number, found: readonly Found[], readers: readonly string[]): string[] {
  return found.flatMap(f => {
    const unsafe = control(f.path) || control(f.remote ?? '');
    const shown = unsafe ? JSON.stringify(f.path) : q(f.path);
    return [
      `FETCH_VIOLATION: stage=${stage} attempt=${attempt} kind=${f.kind} path=${shown}${f.remote ? ` remote=${unsafe ? JSON.stringify(f.remote) : f.remote}` : ''} bytes=${f.bytes ?? 'unknown'} readers=${readers.join(',')} (attributed to the stage: Capy exposes no reader id; docs/troubleshooting.md#fetch-violation)`,
      `KEEP: ${shown} (no transcript attributes it to a reader: inspect it and leave it alone)`,
    ];
  });
}

/**
 * A stage's pending rerun: while a path an earlier attempt of the stage found still exists, a reader could read it and
 * sweep clean, so no stage's start dispatches a reader (and the violation stays unresolved). Nothing is moved or deleted.
 */
export function rerunBlocked(stage: Stage, s: StageSweep): string[] {
  const kept = (s.history ?? []).flatMap(h => (h.end?.found ?? []).map(f => ({ f, attempt: h.attempt }))).filter(({ f }) => fs.existsSync(f.path));
  return kept.map(({ f, attempt }) => `FETCH_RERUN_BLOCKED: stage=${stage} attempt=${s.attempt} path=${shownPath(f.path)} (attempt ${attempt} found it and it still exists, so no rerun reader starts beside it and verify refuses; stop and report the path to your Captain, and leave it alone; docs/troubleshooting.md#fetch-rerun-blocked)`);
}

/**
 * Quarantine every reader of the stage's current attempt: its reply moves to <out>/quarantine/ (0600), its findings leave
 * merged.jsonl, and the ledger records which ids left. On the first attempt each slot gets a planned `<reader>#2`.
 */
export function quarantineStage(m: Manifest, stage: Stage, attempt: number): { quarantined: PassReader[]; reruns: PassReader[]; lines: string[] } {
  const dir = path.join(m.out, 'quarantine');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const quarantined = m.readers.filter(r => r.stage === stage && !r.quarantined && (r.attempt ?? 1) === attempt);
  const reruns: PassReader[] = [];
  const lines: string[] = [];
  const events = readLedger(m.ledger);
  for (const r of quarantined) {
    const file = path.join(dir, `${safe(r.reader)}.txt`);
    if (r.output && fs.existsSync(r.output)) { fs.renameSync(r.output, file); fs.chmodSync(file, 0o600); }
    let ids: string[] = [];
    if (!r.prompt_file && r.role) {
      const key = readerKey(r.role, r.name);
      const mine = events.filter(e => e.reader === key && (e.event === 'output' || e.event === 'rendered'));
      ids = mine.slice(mine.findLastIndex(e => e.event === 'rendered') + 1).flatMap(e => (Array.isArray(e.ids) ? (e.ids as string[]) : []));
      const gone = new Set(ids);
      if (gone.size && fs.existsSync(m.merged)) {
        const kept = fs.readFileSync(m.merged, 'utf8').split('\n').filter(l => { if (!l.trim()) return false; try { return !gone.has((JSON.parse(l) as { id: string }).id); } catch { return true; } });
        fs.writeFileSync(m.merged, kept.map(l => l + '\n').join(''), { mode: 0o600 });
      }
      appendEvent(m.ledger, { event: 'quarantined', reader: key, pass: m.pass, stage, attempt, ids, file });
    }
    Object.assign(r, { quarantined: { file, at: new Date().toISOString() }, output: undefined });
    lines.push(`QUARANTINED: reader=${r.reader} file=${file} findings_removed=${ids.length}`);
    if (attempt > 1) continue;
    const { file: _f, sha256: _s, bytes: _b, chunks: _c, findings_sha256: _fs, tree: _t, path: _p, output: _o, error: _e, state_at: _a, quarantined: _q, fetch_audit: _fa, ...plan } = r;
    const next: PassReader = { ...plan, reader: `${r.reader}#2`, title: `${r.title}#2`, state: 'planned', attempt: 2 };
    r.superseded_by = next.reader;
    reruns.push(next);
  }
  m.readers.push(...reruns);
  return { quarantined, reruns, lines };
}
