/**
 * transcript-consent — the one reader of transcript consent. Reads
 * `transcript_ingest_mode` and `transcript_repos` together from every root in
 * mergedStateRoots() and returns one policy that gstack-memory-ingest,
 * gstack-gbrain-sync and gstack-brain-sync (through this file's CLI) share.
 *
 * Value grammar: `<base>[@<YYYY-MM-DDTHH:MM:SSZ>][+repos]`, base recent | all |
 * off | new. `@<time>` is required for `new` and invalid otherwise; `off+repos`
 * is invalid. Readers parse case-insensitively. `+repos` marks a value whose
 * scope lives in `transcript_repos`, so a gstack that predates the allowlist
 * reads it as unrecognized and ingests nothing.
 *
 * Across roots: a non-consenting value in any root wins (off, legacy,
 * unrecognized). The resolved root must hold the consent itself. Time
 * constraints stack (a 90-day window from any `recent`, the latest `new@`
 * cutoff), and the repo set is the intersection of every root's allowlist.
 *
 * CLI (bin/gstack-brain-sync):
 *   --check              exit 0 iff transcript pages may sync at all
 *   --describe           print the effective consent in words
 *   --purge              remove unpublished staged pages outside a scoped consent
 *   --guard-unpublished  drop excluded pages from unpublished sync commits;
 *                        exit 3 when the push must not happen
 * Docs: setup-gbrain/memory.md#transcripts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';
import { createHash } from 'node:crypto';
import { canonicalizeRemote } from './gstack-memory-helpers';
import { mergedStateRoots, readKeyFromRoot, resolveStateRoot } from './state-root';

export const MODE_KEY = 'transcript_ingest_mode';
export const REPOS_KEY = 'transcript_repos';
const BRAIN_SYNC_AUTHOR = 'gstack-brain-sync';
const MODE_RE = /^(recent|all|off|new)(?:@(\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}z))?(\+repos)?$/i;
const ROLLING_DAYS = 90;

export type TranscriptBase = 'recent' | 'all' | 'off' | 'new';

export interface TranscriptModeValue {
  base: TranscriptBase;
  /** ISO-8601 UTC cutoff (`new` only). */
  cutoff: string | null;
  /** The value carries the `+repos` allowlist marker. */
  repos: boolean;
}

/** True when `s` is exactly `YYYY-MM-DDTHH:MM:SSZ` and names a real instant. */
export function isUtcSecond(s: string): boolean {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace('.000Z', 'Z') === s;
}

/** Parse one stored value (case-insensitive). null = not valid grammar. */
export function parseTranscriptMode(raw: string): TranscriptModeValue | null {
  const m = MODE_RE.exec(raw.trim());
  if (!m) return null;
  const base = m[1].toLowerCase() as TranscriptBase;
  const cutoff = m[2] ? m[2].toUpperCase() : null;
  if ((base === 'new') !== (cutoff !== null)) return null;
  if (cutoff !== null && !isUtcSecond(cutoff)) return null;
  if (base === 'off' && m[3]) return null;
  return { base, cutoff, repos: m[3] !== undefined };
}

export type TranscriptConsentReason =
  | 'recent'
  | 'all'
  | 'new'
  | 'off'
  | 'not-set'
  | 'legacy'
  | 'unrecognized'
  | 'repos-unreadable';

export interface TranscriptConsent {
  /** Every root consents; transcripts may be walked without an override. */
  affirmative: boolean;
  /** recent = rolling 90 days (mtime, as before), new = cutoff only, all = no time limit. */
  window: 'recent' | 'all' | 'new' | null;
  reason: TranscriptConsentReason;
  /** The resolved root's stored value (null when absent). */
  value: string | null;
  /** Latest `new@` cutoff across roots. Applies even under an explicit override. */
  cutoff?: string;
  /** Canonical remotes allowed across roots ([] = none). Applies even under an override. */
  repos?: string[];
}

export interface TranscriptPolicy extends TranscriptConsent {
  /** Roots whose config.yaml sets either key. */
  roots: string[];
}

export type TranscriptExclusion = 'pre-cutoff' | 'missing-start' | 'not-allowlisted';

export function parseRepoList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const remote = canonicalizeRemote(part);
    if (remote && !out.includes(remote)) out.push(remote);
  }
  return out;
}

/** Read the effective transcript consent across `roots` (resolved root first). */
export function readTranscriptConsent(roots: string[] = mergedStateRoots()): TranscriptPolicy {
  const resolvedValue = roots.length > 0 ? readKeyFromRoot(roots[0], MODE_KEY) : null;
  let reason: TranscriptConsentReason | null = resolvedValue === null ? 'not-set' : null;
  let rolling = false;
  let cutoff: string | undefined;
  let repos: string[] | undefined;
  const contributing: string[] = [];
  for (const root of roots) {
    const raw = readKeyFromRoot(root, MODE_KEY);
    const list = readKeyFromRoot(root, REPOS_KEY);
    if (raw === null && list === null) continue;
    contributing.push(root);
    let marker = false;
    if (raw !== null) {
      const v = raw.trim().toLowerCase();
      const parsed = parseTranscriptMode(v);
      let rootReason: TranscriptConsentReason | null = null;
      if (!parsed) rootReason = /^[a-e]$/.test(v) || v === 'incremental' ? 'legacy' : 'unrecognized';
      else if (parsed.base === 'off') rootReason = 'off';
      else {
        marker = parsed.repos;
        if (parsed.base === 'recent') rolling = true;
        if (parsed.cutoff && (!cutoff || parsed.cutoff > cutoff)) cutoff = parsed.cutoff;
      }
      reason ??= rootReason;
    }
    const entries = list === null ? [] : parseRepoList(list);
    if (entries.length > 0) repos = repos ? repos.filter((r) => entries.includes(r)) : entries;
    else if (marker) {
      repos = [];
      reason ??= 'repos-unreadable';
    }
  }
  const affirmative = reason === null;
  const window = !affirmative ? null : rolling ? 'recent' : cutoff ? 'new' : 'all';
  const policy: TranscriptPolicy = {
    affirmative,
    window,
    reason: reason ?? (window as TranscriptConsentReason),
    value: resolvedValue,
    roots: contributing,
  };
  if (cutoff !== undefined) policy.cutoff = cutoff;
  if (repos !== undefined) policy.repos = repos;
  return policy;
}

/** A cutoff or an allowlist narrows consent to some sessions. */
export function isScoped(c: TranscriptConsent): boolean {
  return c.cutoff !== undefined || c.repos !== undefined;
}

/** Transcript pages may sync at all: consent, and a repo set that is not empty. */
export function allowsTranscripts(c: TranscriptConsent): boolean {
  return c.affirmative && !(c.repos !== undefined && c.repos.length === 0);
}

/** Short stable id of the allowlist, recorded with a memory stage so a scope change restages. */
export function reposHash(repos: string[]): string {
  return createHash('sha256').update([...repos].sort().join('\n')).digest('hex').slice(0, 12);
}

/** The `new@` cutoff check on a session's first record timestamp (never mtime). */
export function cutoffExclusion(c: TranscriptConsent, startedAt: string | null | undefined): 'pre-cutoff' | 'missing-start' | null {
  if (c.cutoff === undefined) return null;
  const ms = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(ms)) return 'missing-start';
  return ms < Date.parse(c.cutoff) ? 'pre-cutoff' : null;
}

/** The allowlist check on a session's canonical git remote. */
export function repoExclusion(c: TranscriptConsent, remote: string | null | undefined): 'not-allowlisted' | null {
  if (c.repos === undefined) return null;
  const canonical = canonicalizeRemote(remote ?? '');
  return canonical && c.repos.includes(canonical) ? null : 'not-allowlisted';
}

/** Why one session is outside the scope, or null when it is inside. Consent itself is checked by callers. */
export function sessionExclusion(
  c: TranscriptConsent,
  session: { startedAt?: string | null; remote?: string | null },
): TranscriptExclusion | null {
  return cutoffExclusion(c, session.startedAt) ?? repoExclusion(c, session.remote);
}

function formatCutoff(cutoff: string): string {
  return `${cutoff.slice(0, 10)} ${cutoff.slice(11, 19)} UTC`;
}

/** The effective consent in words: window or cutoff, up to 3 repos, contributing roots. */
export function describeTranscriptPolicy(p: TranscriptPolicy): string {
  let time: string;
  if (p.window === 'recent') time = `sessions from the last ${ROLLING_DAYS} days${p.cutoff ? ` that started after ${formatCutoff(p.cutoff)}` : ''}`;
  else if (p.cutoff) time = `sessions that started after ${formatCutoff(p.cutoff)}`;
  else time = 'all history';
  let scope: string;
  if (p.repos === undefined) scope = 'every repo your repo policy allows';
  else if (p.repos.length === 0) scope = 'no repo (the repo allowlists share no repo, or one is unreadable)';
  else {
    const shown = p.repos.slice(0, 3).join(', ');
    scope = `${p.repos.length === 1 ? 'repo' : 'repos'} ${shown}${p.repos.length > 3 ? ` +${p.repos.length - 3} more` : ''}`;
  }
  const roots = p.roots.length > 0 ? `; config: ${p.roots.join(', ')}` : '';
  if (!p.affirmative) return `not consented (${p.reason}); scope if overridden: ${time}; ${scope}${roots}`;
  return `${time}; ${scope}${roots}`;
}

// ── Staged pages ────────────────────────────────────────────────────────────

/** Frontmatter fields of a staged page (flat `key: value` lines). */
export function pageFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---\n')) return out;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return out;
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Why a staged page under transcripts/ must not sync, or null. Pages typed as
 * another memory type (artifacts staged in a remote-http run dir) are never
 * excluded here. Without consent every transcript page is excluded.
 */
export function pageExclusion(c: TranscriptConsent, text: string): TranscriptExclusion | 'not-consented' | null {
  const fm = pageFrontmatter(text);
  if (fm.type && fm.type !== 'transcript') return null;
  if (!c.affirmative) return 'not-consented';
  return sessionExclusion(c, { startedAt: fm.session_started_at || fm.start_time, remote: fm.git_remote });
}

function git(home: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', home, ...args], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '' };
}

/** origin/<branch> for the checked-out branch, or null (no repo, detached, never pushed). */
function upstreamRef(home: string): string | null {
  if (!fs.existsSync(path.join(home, '.git'))) return null;
  const branch = git(home, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  if (!branch || branch === 'HEAD') return null;
  const ref = `origin/${branch}`;
  return git(home, ['rev-parse', '--verify', '--quiet', ref]).ok ? ref : null;
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Drop ingest fingerprints so a later widening re-stages these sources. */
function clearFingerprints(home: string, sourcePaths: string[]): void {
  if (sourcePaths.length === 0) return;
  const statePath = path.join(home, '.transcript-ingest-state.json');
  let state: { sessions?: Record<string, unknown> };
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return;
  }
  if (!state.sessions) return;
  let changed = false;
  for (const p of sourcePaths) {
    if (p in state.sessions) {
      delete state.sessions[p];
      changed = true;
    }
  }
  if (!changed) return;
  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

/**
 * Remove staged transcript pages that are not yet published and fall outside
 * a scoped consent (cutoff or allowlist). Without consent pages are kept, as
 * before: they wait in the queue until the user consents. Published pages are
 * left alone; removing them from the brain is a separate operation.
 */
export function purgeStagedTranscripts(home: string, c: TranscriptConsent): number {
  if (!c.affirmative || !isScoped(c)) return 0;
  const dir = path.join(home, 'transcripts');
  if (!fs.existsSync(dir)) return 0;
  const ref = upstreamRef(home);
  const published = new Set(
    ref ? git(home, ['ls-tree', '-r', '--name-only', ref, '--', 'transcripts']).out.split('\n').filter(Boolean) : [],
  );
  const sources: string[] = [];
  let removed = 0;
  for (const file of walkMarkdown(dir)) {
    const rel = path.relative(home, file).split(path.sep).join('/');
    if (published.has(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (pageExclusion(c, text) === null) continue;
    fs.rmSync(file, { force: true });
    removed++;
    const source = pageFrontmatter(text).source_path;
    if (source) sources.push(source);
  }
  clearFingerprints(home, sources);
  return removed;
}

/** Queue a path again (same record shape as bin/gstack-brain-enqueue). */
function enqueue(home: string, rel: string, seq: number): void {
  const spool = path.join(home, '.brain-queue.d');
  fs.mkdirSync(spool, { recursive: true });
  const tmp = path.join(spool, `.tmp-${process.pid}-g${seq}`);
  fs.writeFileSync(tmp, JSON.stringify({ file: rel, ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }) + '\n');
  fs.renameSync(tmp, path.join(spool, `${Math.floor(Date.now() / 1000)}-${process.pid}-g${seq}.json`));
}

export interface GuardResult {
  status: 'clean' | 'rewritten' | 'blocked';
  removed: string[];
  message?: string;
}

/**
 * Before a push: scan the unpublished range for transcript pages outside the
 * current consent. When some exist and every unpublished commit is
 * gstack-brain-sync's own, soft-reset to the upstream, unstage the excluded
 * pages and recommit, so nothing excluded is ever pushed. Otherwise block.
 * Under a scoped consent the excluded pages are also purged from disk (with
 * their fingerprints). Pages removed while consent is absent stay on disk and
 * are queued again, so they wait for consent like never-committed pages.
 */
export function guardUnpublished(home: string, c: TranscriptConsent): GuardResult {
  if (!fs.existsSync(path.join(home, '.git'))) return { status: 'clean', removed: [] };
  const ref = upstreamRef(home);
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const touched = [...new Set(git(home, ['log', '--format=', '--name-only', range, '--', 'transcripts']).out.split('\n').filter(Boolean))];
  if (touched.length === 0) return { status: 'clean', removed: [] };
  purgeStagedTranscripts(home, c);
  const inHead = new Set(git(home, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'transcripts']).out.split('\n').filter(Boolean));
  const excluded: string[] = [];
  for (const rel of touched) {
    let text: string | null = null;
    if (inHead.has(rel)) text = git(home, ['show', `HEAD:${rel}`]).out;
    else {
      const sha = git(home, ['log', '-n1', '--format=%H', '--diff-filter=AM', range, '--', rel]).out.trim();
      if (sha) text = git(home, ['show', `${sha}:${rel}`]).out;
    }
    if (text !== null && pageExclusion(c, text) !== null) excluded.push(rel);
  }
  if (excluded.length === 0) return { status: 'clean', removed: [] };
  const authors = new Set(git(home, ['log', '--no-merges', '--format=%an', range]).out.split('\n').filter(Boolean));
  if (!ref) return { status: 'blocked', removed: [], message: `push blocked: ${excluded.length} transcript page(s) outside your transcript consent are in unpushed commits and there is no upstream branch to rewrite against` };
  if ([...authors].some((a) => a !== BRAIN_SYNC_AUTHOR)) {
    return { status: 'blocked', removed: [], message: `push blocked: ${excluded.length} transcript page(s) outside your transcript consent are in unpushed commits that include your own commits; remove them (git rm --cached) and amend, then sync again` };
  }
  if (!git(home, ['diff', '--cached', '--quiet']).ok) {
    return { status: 'blocked', removed: [], message: 'push blocked: excluded transcript pages are in unpushed commits and the index has other staged changes' };
  }
  if (!git(home, ['reset', '-q', '--soft', ref]).ok) return { status: 'blocked', removed: [], message: 'push blocked: could not rewrite unpushed sync commits' };
  const headExcluded = excluded.filter((rel) => inHead.has(rel));
  const published = new Set(git(home, ['ls-tree', '-r', '--name-only', ref, '--', ...headExcluded]).out.split('\n').filter(Boolean));
  const restore = headExcluded.filter((rel) => published.has(rel));
  const drop = headExcluded.filter((rel) => !published.has(rel));
  if (restore.length > 0) git(home, ['reset', '-q', ref, '--', ...restore]);
  if (drop.length > 0) git(home, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...drop]);
  if (!git(home, ['diff', '--cached', '--quiet']).ok) {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const commit = spawnSync('git', ['-C', home, '-c', 'user.email=gstack@localhost', '-c', `user.name=${BRAIN_SYNC_AUTHOR}`, 'commit', '-q', '-m', `sync: rewritten without ${excluded.length} excluded transcript page(s) | ${ts}`], { encoding: 'utf-8', timeout: 30_000 });
    if (commit.status !== 0) return { status: 'blocked', removed: [], message: 'push blocked: could not recommit unpushed sync changes' };
  }
  if (!c.affirmative) {
    let seq = 0;
    for (const rel of drop) if (fs.existsSync(path.join(home, rel))) enqueue(home, rel, ++seq);
  }
  return { status: 'rewritten', removed: excluded };
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const home = resolveStateRoot();
  const policy = readTranscriptConsent();
  if (cmd === '--check') process.exit(allowsTranscripts(policy) ? 0 : 1);
  if (cmd === '--describe') {
    console.log(describeTranscriptPolicy(policy));
    process.exit(0);
  }
  if (cmd === '--purge') {
    const n = purgeStagedTranscripts(home, policy);
    if (n > 0) console.error(`BRAIN_SYNC: removed ${n} staged transcript pages outside the new scope`);
    process.exit(0);
  }
  if (cmd === '--guard-unpublished') {
    const r = guardUnpublished(home, policy);
    if (r.status === 'rewritten') console.error(`BRAIN_SYNC: removed ${r.removed.length} excluded transcript pages from unpublished sync commits`);
    if (r.status === 'blocked') {
      console.error(`BRAIN_SYNC: ${r.message}`);
      process.exit(3);
    }
    process.exit(0);
  }
  console.error('Usage: bun run lib/transcript-consent.ts --check | --describe | --purge | --guard-unpublished');
  process.exit(2);
}
