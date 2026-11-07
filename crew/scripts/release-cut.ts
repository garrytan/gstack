#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * release-cut: tag the newest green commit on main as v<VERSION>, publish a
 * GitHub Release whose notes are that span's CHANGELOG headlines, and
 * fast-forward refs/heads/stable to it (docs/releases.md). Run by
 * .github/workflows/weekly-release.yml ("Stable release") every day at 14:00
 * UTC with --daily (the daily check, crew/scripts/release-cadence.ts: an important
 * change after 24 h, a forced cut at 7 days, the regular cut on Monday and
 * Thursday) and by hand (--ref <sha on main> for a hotfix). Dry runs print the
 * plan and change nothing.
 *
 *   bun crew/scripts/release-cut.ts --repo owner/name [--ref <sha>] [--security <reason> | --regression <reason>] [--daily [--fragments-dir <dir>]] [--dry-run]
 *     [--summary <file>] [--required-check <name>] [--backstop-check <name>] [--notes-ref <ref>]
 *
 * The checkout needs origin's full history (fetch-depth 0). Green, for a
 * commit on main's first-parent history, means: its required check run
 * succeeded (--required-check, default free-tests: the status main requires),
 * it was gated (see below), every check run on it has completed and none
 * failed, and the trains notes ref (--notes-ref, default
 * refs/notes/gstack-trains) holds no active freeze. The newest such commit in
 * the window (7 days, 200 first-parent commits) is the candidate; a commit
 * with a check run still going is skipped, not waited for.
 *
 * Gated means one of three kinds of evidence. Either the backstop check run
 * (--backstop-check, default main-backstop) succeeded: evals-main-backstop.yml
 * publishes it, success only when a green train record covers the tree or the
 * backstop gated it green, neutral when main moved past the push before it was
 * gated. Or a train record in the notes ref (kind train, state green, merging
 * or merged) lists the commit's sha or its tree in merged[]: those entries are
 * the main commits `gstack-ship-queue verify --train` confirmed, so a neutral
 * or absent backstop run on such a commit is not held against it, and the
 * CANDIDATE line says "gated by train <nonce>". Or a GREEN release record
 * (kind release, crew/lib/release-gate.ts) names the commit: "gated by release gate
 * run <id>". A red backstop run stays red either way. A commit with none of
 * these is not green. A RED release record with no GREEN one on a later
 * commit that contains it holds every cut, like a freeze.
 *
 * stable moves only forward: a candidate behind the current stable is refused
 * (REFUSED non-fast-forward), as is a tag v<VERSION> that already names another
 * commit. A cut that stopped half-way (tag and stable pushed, release not
 * created) is finished by the next run; a completed cut reports NOTHING_NEW
 * and exits 0.
 *
 * The floor: stable moves at most once per FLOOR_HOURS (72). The last move is
 * the annotated v<VERSION> tag pointing at stable, or its GitHub Release's
 * publish time when that is later; a cut inside the floor is REFUSED_FLOOR
 * with NEXT_ALLOWED, and a stable without that tag is FLOOR_UNKNOWN. A
 * scheduled run (GITHUB_EVENT_NAME=schedule) gets SCHEDULED_GRACE_HOURS (3) of
 * slack for cron start jitter; nothing else does. Finishing a half-done cut is
 * not a new move. Two exceptions pass the floor, each with --ref and one per
 * cut: a security cut (--security <reason>, where the reason names a GHSA, CVE
 * or #<n> that verifySecurity ties to the commits being released) and a
 * regression cut (--regression <reason>, where the reason names a
 * regression-labelled #<n> a released commit references and the earlier stable
 * release v<X> it worked in; see verifyRegression). Only a security cut passes
 * FLOOR_UNKNOWN. The reason and its evidence go into the tag message and the
 * notes, and a retry recovers them from the tag.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLOOR_HOURS, IMPORTANT_FLOOR_HOURS, SCHEDULED_GRACE_HOURS, decideDaily, importantChanges, type DailyDecision } from './release-cadence';

export { FLOOR_HOURS, SCHEDULED_GRACE_HOURS };

export type Gh = (args: string[]) => { status: number | null; stdout: string; stderr: string };
export type Git = (args: string[]) => { ok: boolean; out: string };

export const REQUIRED_CHECK = 'free-tests';
export const BACKSTOP_CHECK = 'main-backstop';
export const NOTES_REF = 'refs/notes/gstack-trains';
const NOTES_LOCAL = 'refs/notes/gstack-trains-release';
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
export const WINDOW_DAYS = 7;
export const WINDOW_COMMITS = 200;
export const NOTES_CAP = 60_000;
const HOUR = 3_600_000;

export const runGh: Gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : r.stderr ?? '' };
};
export const gitIn = (cwd: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: (r.stdout ?? '').replace(/\n$/, '') } : { ok: false, out: (r.stderr || String(r.error ?? '')).trim() };
};

function parseJson<T>(r: { status: number | null; stdout: string }): T | null {
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

/** Four-part versions compare numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Green names what gated the commit: the backstop check's name, or `train <nonce>`. Pending means a check run on it is still going. */
export type Verdict = { green: true; via: string } | { green: false; why: string; pending: boolean };
interface CheckRun { name: string; status: string; conclusion: string | null }

/** Main commits a green, merging or merged train record lists in merged[], by sha and by tree, each naming the train; `release` maps a commit a green release gate passed to its run (crew/lib/release-gate.ts). */
export interface TrainEvidence { bySha: Map<string, string>; byTree: Map<string, string>; release?: Map<string, string> }
export interface GateOptions { requiredCheck?: string; backstopCheck?: string; evidence?: TrainEvidence; treeOf?: (sha: string) => string | null }

/** Why a commit is not releasable, or green and through which evidence. */
export function gateVerdict(gh: Gh, repo: string, sha: string, o: GateOptions = {}): Verdict {
  const required = o.requiredCheck ?? REQUIRED_CHECK;
  const backstop = o.backstopCheck ?? BACKSTOP_CHECK;
  const paged = parseJson<unknown>(gh(['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]));
  if (!paged) return { green: false, why: 'cannot read its check runs', pending: false };
  const pages = (Array.isArray(paged) ? paged : [paged]) as Array<{ check_runs?: CheckRun[] }>;
  const runs = pages.flatMap(p => p.check_runs ?? []);
  let via = backstop;
  for (const name of [required, backstop]) {
    const named = runs.filter(c => c.name === name);
    if (named.some(c => c.status !== 'completed')) return { green: false, why: `${name} is still running`, pending: true };
    if (named.some(c => c.conclusion === 'success')) continue;
    const train = name === backstop && name !== required && o.evidence ? o.evidence.bySha.get(sha) ?? o.evidence.byTree.get(o.treeOf?.(sha) ?? '') : undefined;
    if (train) { via = `train ${train}`; continue; }
    const gate = name === backstop && name !== required ? o.evidence?.release?.get(sha) : undefined;
    if (gate) { via = `release gate run ${gate}`; continue; }
    if (named.length === 0) return { green: false, why: `no ${name} check run`, pending: false };
    return { green: false, why: `${name} concluded ${named.map(c => c.conclusion).join(',')}`, pending: false };
  }
  const red = runs.filter(c => c.status === 'completed' && RED.has(c.conclusion ?? ''));
  if (red.length > 0) return { green: false, why: `red check runs: ${[...new Set(red.map(c => c.name))].join(', ')}`, pending: false };
  const running = runs.filter(c => c.status !== 'completed');
  if (running.length > 0) return { green: false, why: `check runs still going: ${[...new Set(running.map(c => c.name))].join(', ')}`, pending: true };
  return { green: true, via };
}

export interface TrainNotes { error: string | null; freeze: string | null; evidence: TrainEvidence }
interface NoteRecord {
  kind?: string; state?: string; nonce?: string; merged?: Array<{ sha?: string; tree?: string }>; cleared_at?: string | null; reason?: string; train?: string;
  sha?: string; verdict?: string; run?: { id?: number } | null; red_cases?: string[]; main?: { sha?: string } | null;
}

/**
 * One read of the trains notes ref (fetched from origin): the active freeze
 * record (kind freeze, cleared_at null) and the train evidence (lib/
 * ship-queue-train-record.ts TrainRecord: kind train, state green, merging or
 * merged, merged[].sha and .tree). A fetch failure other than a missing ref is
 * an error; a missing ref holds nothing. Release-gate records (kind release,
 * crew/lib/release-gate.ts) add evidence when GREEN, and a RED one with no GREEN
 * record on a later commit that contains it is the hold: it refuses the cut
 * like a freeze (a train freeze, when both exist, is the one named). A backstop
 * freeze clears for the cut once a GREEN release record sits on a commit that
 * contains its main: under release_gate the backstop stands down and never
 * clears it itself.
 */
export function readTrainNotes(git: Git, notesRef = NOTES_REF): TrainNotes {
  const notes: TrainNotes = { error: null, freeze: null, evidence: { bySha: new Map(), byTree: new Map() } };
  const f = git(['fetch', '--no-tags', '-q', 'origin', `+${notesRef}:${NOTES_LOCAL}`]);
  if (!f.ok) {
    if (!/couldn't find remote ref|no such ref/i.test(f.out)) notes.error = `cannot fetch ${notesRef}: ${f.out.slice(0, 160)}`;
    return notes;
  }
  const listed = git(['notes', `--ref=${NOTES_LOCAL}`, 'list']);
  if (!listed.ok || !listed.out.trim()) return notes;
  const gates: Array<{ sha: string; verdict: string; red: string[] }> = [];
  let backstopMain: string | null = null;
  notes.evidence.release = new Map();
  for (const line of listed.out.split('\n')) {
    const blob = line.split(' ')[0];
    if (!blob) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(git(['cat-file', 'blob', blob]).out); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const r = parsed as NoteRecord;
    if (r.kind === 'freeze' && !r.cleared_at) {
      notes.freeze = `queue frozen since train ${r.train ?? '?'}: ${r.reason ?? 'red backstop'}`;
      backstopMain = r.train === 'backstop' && typeof r.main?.sha === 'string' && /^[0-9a-f]{40}$/.test(r.main.sha) ? r.main.sha : null;
    }
    if (r.kind === 'release' && typeof r.sha === 'string' && /^[0-9a-f]{40}$/.test(r.sha)) {
      gates.push({ sha: r.sha, verdict: String(r.verdict), red: Array.isArray(r.red_cases) ? r.red_cases.filter(c => typeof c === 'string') : [] });
      if (r.verdict === 'GREEN') notes.evidence.release.set(r.sha, String(r.run?.id ?? '?'));
    }
    if (r.kind !== 'train' || typeof r.nonce !== 'string' || !r.nonce || !['green', 'merging', 'merged'].includes(r.state ?? '')) continue;
    for (const m of Array.isArray(r.merged) ? r.merged : []) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.sha === 'string' && m.sha) notes.evidence.bySha.set(m.sha, r.nonce);
      if (typeof m.tree === 'string' && m.tree) notes.evidence.byTree.set(m.tree, r.nonce);
    }
  }
  const main = backstopMain;
  if (main && gates.some(g => g.verdict === 'GREEN' && git(['merge-base', '--is-ancestor', main, g.sha]).ok)) notes.freeze = null;
  const held = gates.find(red => red.verdict === 'RED' && !gates.some(g => g.verdict === 'GREEN' && g.sha !== red.sha && git(['merge-base', '--is-ancestor', red.sha, g.sha]).ok));
  if (held && !notes.freeze) notes.freeze = `release gate red on ${held.sha.slice(0, 12)} (${held.red.join(', ') || 'red cases not recorded'}) and no gate on a later commit is green; land the revert or fix-forward, then run gstack-release-gate run --ignore-cadence`;
  return notes;
}

export interface ChangelogEntry { version: string; date: string; headline: string }

/** Every "## [X.Y.Z.W] - date" entry of a CHANGELOG with its first prose line, markdown stripped. */
export function changelogEntries(text: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^## \[(\d+(?:\.\d+)+)\](?: - (\S+))?/.exec(lines[i]!);
    if (!m) continue;
    let headline = '';
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith('## '); j++) {
      const l = lines[j]!.trim();
      if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('-') || l.startsWith('```')) continue;
      const bold = /^\*\*(.+?)\*\*/.exec(l);
      headline = (bold ? bold[1]! : l.replace(/\*\*/g, '')).replace(/\s+/g, ' ');
      break;
    }
    out.push({ version: m[1]!, date: m[2] ?? '', headline });
  }
  return out;
}

export interface NotesInput { repo: string; version: string; date: string; prevVersion: string | null; prevTag: string | null; entries: ChangelogEntry[]; hotfix: boolean; first?: boolean; exception?: Exception | null }

/** A verified floor exception (a security or a regression cut): the sanitized reason and what tied it to the released commits. */
export interface Exception { kind: 'security' | 'regression'; reason: string; evidence: string }

const KIND_LABEL = { security: 'Security', regression: 'Regression' } as const;

export function releaseKind(hotfix: boolean, exception: Exception | null | undefined): 'security' | 'regression' | 'hotfix' | 'regular' {
  return exception ? exception.kind : hotfix ? 'hotfix' : 'regular';
}

/** Release notes: one headline per version in (prev, version], capped at NOTES_CAP. */
export function releaseNotes(n: NotesInput): string {
  const span = n.entries.filter(e => compareVersions(e.version, n.version) <= 0 && (!n.prevVersion || compareVersions(e.version, n.prevVersion) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
  const plural = span.length === 1 ? '' : 's';
  const changelogUrl = 'https://github.com/' + n.repo + '/blob/v' + n.version + '/CHANGELOG.md';
  const compare = n.prevTag ? '[Compare](https://github.com/' + n.repo + '/compare/' + n.prevTag + '...v' + n.version + ') or read ' : 'Read ';
  const head = [
    '## gstack v' + n.version + ' (' + releaseKind(n.hotfix, n.exception) + ' release)',
    '',
    ...(n.exception ? ['**' + KIND_LABEL[n.exception.kind] + ' release:** `' + n.exception.reason + '` (verified: ' + n.exception.evidence + '). Every version since the previous release ships with it.', ''] : []),
    n.first || !n.prevVersion
      ? 'First tagged release: the ' + span.length + ' version' + plural + (n.prevVersion ? ' since v' + n.prevVersion + ' (the week before it)' : '') + ', one line each; the [full changelog](' + changelogUrl + ') has every earlier one.'
      : span.length + ' version' + plural + ' since v' + n.prevVersion + ', one line each. ' + compare + 'the [full changelog](' + changelogUrl + ').',
    '',
    'New installs and team-mode installs follow the stable branch, which now points here; gstack-config set update_channel main follows every merge instead ([docs/releases.md](https://github.com/' + n.repo + '/blob/v' + n.version + '/docs/releases.md)).',
    '',
  ].join('\n');
  const bullets = span.map(e => '- **' + e.version + '**' + (e.date ? ' (' + e.date + ')' : '') + ': ' + (e.headline || 'see CHANGELOG.md'));
  let body = head + bullets.join('\n') + '\n';
  if (body.length > NOTES_CAP) {
    const kept: string[] = [];
    let size = head.length;
    for (const b of bullets) { if (size + b.length + 1 > NOTES_CAP - 200) break; kept.push(b); size += b.length + 1; }
    body = head + kept.join('\n') + '\n- ...and ' + (bullets.length - kept.length) + ' more versions; see CHANGELOG.md\n';
  }
  return body;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * When stable last moved: the annotated v<VERSION> tag a cut made on it (VERSION
 * read at stable), or that tag's release publish time when later. Any other tag
 * on that commit is ignored, so a hand-made extra tag cannot date the move or
 * pin later runs to stable. published is false when the release does not exist
 * yet (a half-done cut, whose tag may predate the stable push); a release that
 * cannot be read leaves the move undated.
 */
export function stableMovedAt(git: Git, gh: Gh, repo: string, stable: string): { at: number; tag: string; published: boolean } | { at: null; why: string } {
  const version = git(['show', stable + ':VERSION']);
  const tag = 'v' + (version.ok ? version.out.trim() : '<VERSION>');
  const listed = version.ok ? git(['for-each-ref', '--points-at=' + stable, '--format=%(objecttype)%09%(creatordate:unix)', 'refs/tags/' + tag]) : null;
  const [type, created] = listed?.ok && listed.out ? listed.out.split('\t') : [];
  if (type !== 'tag') return { at: null, why: 'no annotated ' + tag + ' tag points at stable ' + stable.slice(0, 12) + ', so its last move cannot be dated' };
  const at = Number(created) * 1000;
  const view = gh(['release', 'view', tag, '--repo', repo, '--json', 'publishedAt']);
  if (view.status !== 0) {
    if (/not found|HTTP 404/i.test(view.stderr)) return { tag, at, published: false };
    return { at: null, why: 'cannot read the release for ' + tag + ' (' + (view.stderr.trim().slice(0, 120) || 'gh exit ' + view.status) + '), so its last move cannot be dated' };
  }
  const published = Date.parse(parseJson<{ publishedAt?: string }>(view)?.publishedAt ?? '');
  return { tag, at: Number.isFinite(published) ? Math.max(at, published) : at, published: true };
}

/** The floor verdict for moving stable from prevStable to sha. A refusal carries the message and the NEXT_ALLOWED text. */
export interface Floor { verdict: 'first' | 'finishing' | 'clear' | 'security' | 'regression' | 'refused' | 'unknown'; line: string; message?: string; next?: string }

/** A regression cut passes only a dated floor; an undatable or unpublished stable stays security-only. */
export function floorStatus(o: { git: Git; gh: Gh; repo: string; prevStable: string | null; sha: string; exception: Exception['kind'] | null; scheduled: boolean; now: number; floorHours?: number }): Floor {
  const floor = o.floorHours ?? FLOOR_HOURS;
  if (!o.prevStable) return { verdict: 'first', line: 'FLOOR: none (no stable yet; this cut creates it)' };
  if (o.prevStable === o.sha) return { verdict: 'finishing', line: 'FLOOR: not applied (finishing the cut that already moved stable)' };
  const moved = stableMovedAt(o.git, o.gh, o.repo, o.prevStable);
  if (moved.at === null) {
    if (o.exception === 'security') return { verdict: 'security', line: 'FLOOR: bypassed by the security exception (' + moved.why + ')' };
    return { verdict: 'unknown', line: 'FLOOR: unknown', message: moved.why + '; only a --security cut can move it until one does', next: 'none until an annotated v<VERSION> tag dates the release stable points at' };
  }
  if (!moved.published && o.exception !== 'security') {
    return { verdict: 'unknown', line: 'FLOOR: unknown', message: 'stable moved to ' + moved.tag + ' but its release is not published, so the tag cannot date the move; finish that cut first (a run without --ref finishes it)', next: 'once the release for ' + moved.tag + ' is published' };
  }
  // A tag dated in the future holds the floor from now, not from that date.
  moved.at = Math.min(moved.at, o.now);
  const need = floor - (o.scheduled ? SCHEDULED_GRACE_HOURS : 0);
  const since = 'stable moved to ' + moved.tag + ' at ' + iso(moved.at) + ', ' + ((o.now - moved.at) / HOUR).toFixed(1) + ' h ago';
  const next = iso(moved.at + floor * HOUR) + ' for a hand-run cut; ' + iso(moved.at + (floor - SCHEDULED_GRACE_HOURS) * HOUR) + ' for a scheduled run';
  if (o.exception) return { verdict: o.exception, line: 'FLOOR: bypassed by the ' + o.exception + ' exception (' + since + ')' };
  const kind = o.scheduled ? 'a scheduled run needs ' + need + ' h (' + floor + ' h less ' + SCHEDULED_GRACE_HOURS + ' h cron grace)' : 'a hand-run cut needs ' + need + ' h';
  if (o.now - moved.at >= need * HOUR) return { verdict: 'clear', line: 'FLOOR: clear (' + since + '; ' + kind + ')' };
  return { verdict: 'refused', line: 'FLOOR: refused', message: since + '; ' + kind + '; a security fix passes with --security "<GHSA-…|CVE-…|#n>: why" --ref <fix sha>, a regression fix with --regression "#n: worked in v<X>: why" --ref <fix sha>', next };
}

/** One line, no control characters or backticks, at most 300 characters: the reason is public in the notes and tag. */
export function sanitizeReason(reason: string): string {
  return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Ties a security reason to the commits in (from, to]. The reason must name a
 * GHSA, CVE or #<n>; it is verified when (a) a commit message in the span names
 * that GHSA/CVE, (b) issue or PR #<n> carries the security label and a commit
 * in the span references #<n>, or (c) the GitHub Advisory Database entry for
 * that GHSA/CVE lists a package whose line changes in the span's package.json
 * or bun.lock. What the fix fixes, and how bad it was, stays attested.
 */
export function verifySecurity(o: { reason: string; git: Git; gh: Gh; repo: string; from: string | null; to: string }): { ok: true; evidence: string } | { ok: false; why: string } {
  const advisories = [...new Set([...o.reason.matchAll(/\bGHSA(?:-[2-9cfghjmpqrvwx]{4}){3}\b/gi)].map(m => 'GHSA' + m[0].slice(4).toLowerCase())
    .concat([...o.reason.matchAll(/\bCVE-\d{4}-\d{4,}\b/gi)].map(m => m[0].toUpperCase())))];
  const issues = issueNumbers(o.reason);
  if (advisories.length === 0 && issues.length === 0) return { ok: false, why: 'the reason names no GHSA-…, CVE-… or #<n> to verify' };
  const commits = spanCommits(o.git, o.from, o.to);
  // Package names whose own entry changed: a package.json dependency line or a bun.lock package key, never a name listed inside another package's entry.
  const changed = new Set((o.from ? o.git(['diff', '--unified=0', o.from, o.to, '--', 'package.json', 'bun.lock']).out.split('\n') : [])
    .flatMap(l => { const m = /^[+-](?![+-])\s*"([^"]+)":\s*(?:"[^"]*"|\[\s*"([^"]+)@)/.exec(l); return m && (!m[2] || m[2] === m[1]) ? [m[1]!] : []; }));
  const why: string[] = [];
  for (const id of advisories) {
    const named = commits.find(c => c.body.toUpperCase().includes(id.toUpperCase()));
    if (named) return { ok: true, evidence: 'commit ' + named.sha + ' names ' + id };
    const read = parseJson<unknown>(o.gh(['api', id.startsWith('GHSA') ? 'advisories/' + id : 'advisories?cve_id=' + id]));
    const entries = (Array.isArray(read) ? read : read ? [read] : []) as Array<{ vulnerabilities?: Array<{ package?: { name?: string; ecosystem?: string } }> }>;
    const packages = [...new Set(entries.flatMap(e => e.vulnerabilities ?? []).filter(v => v.package?.ecosystem?.toLowerCase() === 'npm').map(v => v.package?.name).filter((n): n is string => Boolean(n)))];
    const bumped = packages.find(p => changed.has(p));
    if (bumped) return { ok: true, evidence: 'advisory ' + id + ' lists ' + bumped + ', which changes in package.json/bun.lock' };
    why.push(id + ': no commit names it' + (read ? ' and none of its ' + packages.length + ' npm advisory packages changes in package.json/bun.lock' : ' and the advisory database has no entry for it'));
  }
  const labelled = labelledReference(o.gh, o.repo, commits, issues, 'security');
  if (labelled.ok) return labelled;
  return { ok: false, why: 'nothing in ' + spanName(o.from, o.to) + ' ties the reason to the release: ' + [...why, ...labelled.why].join('; ') };
}

/**
 * Ties a regression reason to the commits in (from, to]. A regression is a fix
 * for behavior that worked in an earlier stable release. The reason names
 * exactly one release v<X> and at least one #<n>; it is verified when v<X> is
 * an annotated release tag strictly behind the current stable with a published
 * GitHub Release (so team installs ran it and have since moved past it; a tag a
 * half-done cut left behind does not count), and issue or PR #<n> carries the
 * regression label (a maintainer's declaration: labelling needs triage rights)
 * and a commit in the span references #<n>. That the behavior really worked in
 * v<X> stays attested, in public, by the label and the reason.
 */
export function verifyRegression(o: { reason: string; git: Git; gh: Gh; repo: string; from: string | null; to: string; stable: string | null }): { ok: true; evidence: string } | { ok: false; why: string } {
  const releases = [...new Set([...o.reason.matchAll(/(?<![\w.])v(\d+(?:\.\d+)+)(?!\w|\.\d)/g)].map(m => 'v' + m[1]!))];
  const issues = issueNumbers(o.reason);
  if (releases.length !== 1 || issues.length === 0) return { ok: false, why: 'the reason must name exactly one earlier stable release v<X> the behavior worked in and the regression-labelled #<n> it fixes (named ' + releases.length + ' release' + (releases.length === 1 ? '' : 's') + ' and ' + issues.length + ' #<n>)' };
  if (!o.stable) return { ok: false, why: 'there is no stable release yet, so nothing earlier can have worked' };
  const tag = releases[0]!;
  const type = o.git(['for-each-ref', '--format=%(objecttype)', 'refs/tags/' + tag]);
  const worked = o.git(['rev-parse', '--verify', '-q', 'refs/tags/' + tag + '^{commit}']);
  if (!type.ok || type.out !== 'tag' || !worked.ok) return { ok: false, why: tag + ' is not an annotated release tag here, so it cannot be the earlier stable release the behavior worked in' };
  if (worked.out === o.stable || !o.git(['merge-base', '--is-ancestor', worked.out, o.stable]).ok) return { ok: false, why: tag + ' is not an earlier stable release: it must sit strictly behind the current stable ' + o.stable.slice(0, 12) + ', since a fix for something the current stable still does right needs no exception' };
  const release = o.gh(['release', 'view', tag, '--repo', o.repo, '--json', 'isDraft']);
  const published = release.status === 0 ? parseJson<{ isDraft?: boolean }>(release) : null;
  if (!published || published.isDraft === true) return { ok: false, why: tag + ' has no published release, so team installs never ran it as stable' };
  const labelled = labelledReference(o.gh, o.repo, spanCommits(o.git, o.from, o.to), issues, 'regression');
  if (!labelled.ok) return { ok: false, why: 'nothing in ' + spanName(o.from, o.to) + ' ties the reason to the release: ' + labelled.why.join('; ') };
  return { ok: true, evidence: labelled.evidence + '; ' + tag + ' (' + worked.out.slice(0, 12) + ') is an earlier stable release' };
}

const issueNumbers = (reason: string) => [...new Set([...reason.matchAll(/(?<![\w&])#(\d+)\b/g)].map(m => m[1]!))];
const spanName = (from: string | null, to: string) => (from ? from.slice(0, 12) + '..' : 'up to ') + to.slice(0, 12);

function spanCommits(git: Git, from: string | null, to: string): Array<{ sha: string; body: string }> {
  const log = git(['log', '--format=%H%x1f%B%x1e', ...(from ? [from + '..' + to] : ['--max-count=' + WINDOW_COMMITS, to])]);
  return (log.ok ? log.out.split('\x1e') : []).map(c => c.trim().split('\x1f')).filter(c => c[0]).map(c => ({ sha: c[0]!.slice(0, 12), body: c[1] ?? '' }));
}

/** The first #<n> carrying the label that a span commit references; each miss says why. */
function labelledReference(gh: Gh, repo: string, commits: Array<{ sha: string; body: string }>, issues: string[], label: string): { ok: true; evidence: string } | { ok: false; why: string[] } {
  const why: string[] = [];
  for (const n of issues) {
    const ref = commits.find(c => new RegExp('(?<![\\w&])#' + n + '\\b').test(c.body));
    const issue = parseJson<{ labels?: Array<{ name?: string }> }>(gh(['api', 'repos/' + repo + '/issues/' + n]));
    const labelled = Boolean(issue?.labels?.some(l => l.name?.toLowerCase() === label));
    if (ref && labelled) return { ok: true, evidence: '#' + n + ' carries the ' + label + ' label and commit ' + ref.sha + ' references it' };
    why.push('#' + n + ': ' + [!issue ? 'cannot read it' : !labelled ? 'no ' + label + ' label' : '', !ref ? 'no commit in the span references it' : ''].filter(Boolean).join(', '));
  }
  return { ok: false, why };
}

/** The exception reason and evidence an earlier run wrote into this release's annotated tag, so a retry publishes the same notes. */
export function exceptionFromTag(git: Git, tag: string): Exception | null {
  const body = git(['for-each-ref', '--format=%(contents)', 'refs/tags/' + tag]);
  const reason = body.ok ? /^(Security|Regression): (.+)$/m.exec(body.out) : null;
  if (!reason) return null;
  return { kind: reason[1] === 'Security' ? 'security' : 'regression', reason: reason[2]!.trim(), evidence: /^Verified: (.+)$/m.exec(body.out)?.[1]!.trim() ?? 'recorded in tag ' + tag };
}

export interface Plan {
  sha: string; version: string; tag: string; date: string; hotfix: boolean; via: string;
  prevStable: string | null; prevVersion: string | null; prevTag: string | null;
  tagExists: 'no' | 'same' | 'other'; stableAt: boolean; notes: string; skipped: string[];
  exception: Exception | null; floor: Floor; ridingAlong: number;
}
export type RefusalCode = 'NOTHING_NEW' | 'NO_GREEN_COMMIT' | 'NO_RELEASE_PR' | 'REFUSED' | 'REFUSED_FLOOR' | 'FLOOR_UNKNOWN' | 'REFUSED_SECURITY' | 'REFUSED_REGRESSION';
/** `sha` names the candidate on NO_RELEASE_PR, which comes after the candidate was picked but before a plan exists. */
export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: RefusalCode; message: string; skipped?: string[]; next?: string; plan?: Plan; sha?: string };

export interface PlanOptions {
  repo: string; ref?: string; git: Git; gh: Gh; now?: () => number; windowDays?: number; windowCommits?: number;
  requiredCheck?: string; backstopCheck?: string; notesRef?: string;
  /** A scheduled run (GITHUB_EVENT_NAME=schedule): the floor allows SCHEDULED_GRACE_HOURS of cron jitter. */
  scheduled?: boolean;
  /** --security <reason>: bypass the floor for a verified security fix; needs ref. */
  security?: string;
  /** --regression <reason>: bypass a dated floor for a verified regression fix; needs ref. */
  regression?: string;
  /** The floor in hours (default FLOOR_HOURS); the daily check plans at IMPORTANT_FLOOR_HOURS and applies each trigger's own floor (crew/scripts/release-cadence.ts). */
  floorHours?: number;
}

const refusalFor = (kind: Exception['kind']): RefusalCode => (kind === 'security' ? 'REFUSED_SECURITY' : 'REFUSED_REGRESSION');

export function planRelease(o: PlanOptions): PlanResult {
  const { git, gh, repo } = o;
  const windowDays = o.windowDays ?? WINDOW_DAYS;
  const skipped: string[] = [];
  if (o.security !== undefined && o.regression !== undefined) return { ok: false, code: 'REFUSED_REGRESSION', message: '--security and --regression together: a cut carries one exception, so its notes make one claim' };
  const asked: Exception['kind'] | null = o.security !== undefined ? 'security' : o.regression !== undefined ? 'regression' : null;
  if (asked && !o.ref) return { ok: false, code: refusalFor(asked), message: '--' + asked + ' needs --ref <the fix commit>: a ' + asked + ' cut releases up to the fix, never whatever is newest' };
  const mainHead = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  if (!mainHead.ok) return { ok: false, code: 'REFUSED', message: 'origin/main is not fetched: ' + mainHead.out };
  const stable = git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/stable^{commit}']);
  const prevStable = stable.ok ? stable.out : null;
  const trains = readTrainNotes(git, o.notesRef);
  const frozen = trains.error ?? trains.freeze;
  if (frozen) return { ok: false, code: 'REFUSED', message: frozen };
  const gate: GateOptions = {
    requiredCheck: o.requiredCheck, backstopCheck: o.backstopCheck, evidence: trains.evidence,
    treeOf: (sha) => { const t = git(['rev-parse', sha + '^{tree}']); return t.ok ? t.out : null; },
  };

  let candidates: string[];
  if (o.ref) {
    const r = git(['rev-parse', '--verify', o.ref + '^{commit}']);
    if (!r.ok) return { ok: false, code: 'REFUSED', message: '--ref ' + o.ref + ' is not a commit here: ' + r.out };
    const fp = git(['rev-list', '--first-parent', 'refs/remotes/origin/main']);
    if (!fp.out.split('\n').includes(r.out)) return { ok: false, code: 'REFUSED', message: '--ref ' + r.out.slice(0, 12) + " is not on main's first-parent history; a release is always a merge commit of main" };
    candidates = [r.out];
  } else {
    const since = new Date((o.now?.() ?? Date.now()) - windowDays * 86_400_000).toISOString();
    const list = git(['rev-list', '--first-parent', '--max-count=' + (o.windowCommits ?? WINDOW_COMMITS), '--since=' + since, 'refs/remotes/origin/main']);
    candidates = list.ok && list.out ? list.out.split('\n') : [];
    if (candidates.length === 0) return { ok: false, code: 'NOTHING_NEW', message: 'no commit on origin/main in the last ' + windowDays + ' days' };
    // A cut that moved stable but never published its release is finished before stable moves again.
    const moved = prevStable ? stableMovedAt(git, gh, repo, prevStable) : null;
    if (prevStable && moved && moved.at !== null && !moved.published) candidates = [prevStable];
  }

  // stable itself stays a candidate so a cut that stopped half-way (tag and
  // stable pushed, release missing) is finished; nothing older is looked at.
  let sha: string | null = null;
  let via = '';
  for (const c of candidates) {
    const v = gateVerdict(gh, repo, c, gate);
    if (v.green) { sha = c; via = v.via; break; }
    skipped.push(c.slice(0, 12) + ': ' + v.why);
    if (prevStable && c === prevStable) { skipped.push(c.slice(0, 12) + ': already stable; nothing newer is green'); break; }
  }
  if (!sha) {
    if (o.ref) return { ok: false, code: 'REFUSED', message: '--ref ' + candidates[0]!.slice(0, 12) + ' is not green: ' + (skipped[0] ?? '').split(': ').slice(1).join(': '), skipped };
    return { ok: false, code: 'NO_GREEN_COMMIT', message: 'no green commit among ' + candidates.length + ' on origin/main; see the skipped list', skipped };
  }
  if (prevStable && sha !== prevStable && !git(['merge-base', '--is-ancestor', prevStable, sha]).ok) {
    return { ok: false, code: 'REFUSED', message: 'non-fast-forward: stable ' + prevStable.slice(0, 12) + ' is not an ancestor of ' + sha.slice(0, 12) + '; stable only moves forward along main' };
  }

  const version = git(['show', sha + ':VERSION']).out.trim();
  if (!/^\d+(\.\d+)+$/.test(version)) return { ok: false, code: 'REFUSED', message: 'VERSION at ' + sha.slice(0, 12) + " is not a version: '" + version + "'" };
  const tag = 'v' + version;
  const existing = git(['rev-parse', '--verify', '-q', 'refs/tags/' + tag + '^{commit}']);
  const tagExists: Plan['tagExists'] = !existing.ok ? 'no' : existing.out === sha ? 'same' : 'other';
  // The tag on an earlier commit of the same line means VERSION has not moved since that release: no
  // release PR landed (docs/ship-policy.md#release-stamp). Anywhere else, a version was stamped twice.
  if (tagExists === 'other' && git(['merge-base', '--is-ancestor', existing.out, sha]).ok) return { ok: false, code: 'NO_RELEASE_PR', sha, message: 'tag ' + tag + ' already names ' + existing.out.slice(0, 12) + ', an earlier commit, not ' + sha.slice(0, 12) + ': VERSION has not moved since that release, so no release PR landed; the Captain runs gstack-release-stamp open and lands it, then the cut runs' };
  if (tagExists === 'other') return { ok: false, code: 'REFUSED', message: 'tag ' + tag + ' already names ' + existing.out.slice(0, 12) + ', not ' + sha.slice(0, 12) + '; a version is stamped once per merge, so this needs a look' };
  if (prevStable === sha && tagExists === 'same' && gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName']).status === 0) {
    return { ok: false, code: 'NOTHING_NEW', message: 'origin/main ' + sha.slice(0, 12) + ' is already released as ' + tag + '; nothing newer is green' };
  }

  // The release this one follows: stable, or when stable already sits here
  // (a cut that stopped half-way), the newest release tag behind it.
  let before = prevStable;
  if (prevStable === sha) {
    const prior = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--first-parent', sha + '^']);
    const resolved = prior.ok && prior.out ? git(['rev-parse', '--verify', '-q', prior.out + '^{commit}']) : null;
    before = resolved?.ok ? resolved.out : null;
  }
  let prevVersion: string | null = null, prevTag: string | null = null;
  if (before) {
    const shown = git(['show', before + ':VERSION']);
    prevVersion = shown.ok ? shown.out.trim() || null : null;
    if (prevVersion && git(['rev-parse', '--verify', '-q', 'refs/tags/v' + prevVersion + '^{commit}']).ok) prevTag = 'v' + prevVersion;
  } else {
    const date = git(['show', '-s', '--format=%cI', sha]).out;
    const before = new Date(new Date(date).getTime() - windowDays * 86_400_000).toISOString();
    const older = git(['rev-list', '--first-parent', '-1', '--before=' + before, sha]);
    if (older.ok && older.out) prevVersion = git(['show', older.out + ':VERSION']).out.trim() || null;
  }
  // Finishing an exception cut keeps the reason and evidence its tag recorded; a
  // tag that recorded one but never moved stable needs that same kind verified again.
  const recorded = tagExists === 'same' ? exceptionFromTag(git, tag) : null;
  let exception: Exception | null = recorded && prevStable === sha ? recorded : null;
  if (recorded && !exception && asked !== recorded.kind) return { ok: false, code: refusalFor(recorded.kind), message: 'tag ' + tag + ' records a ' + recorded.kind + ' cut that has not moved stable; run it again with --' + recorded.kind + ' and --ref ' + sha.slice(0, 12) + ' so the reason is verified' };
  if (!exception && asked) {
    const reason = sanitizeReason((asked === 'security' ? o.security : o.regression)!);
    if (recorded && recorded.reason !== reason) return { ok: false, code: refusalFor(asked), message: 'tag ' + tag + ' records the ' + asked + ' reason "' + recorded.reason + '"; run it again with that same reason so the tag and the notes agree' };
    const verified = asked === 'security' ? verifySecurity({ reason, git, gh, repo, from: before, to: sha }) : verifyRegression({ reason, git, gh, repo, from: before, to: sha, stable: prevStable });
    if (!verified.ok) return { ok: false, code: refusalFor(asked), message: verified.why };
    exception = { kind: asked, reason, evidence: verified.evidence };
  }
  const changelog = git(['show', sha + ':CHANGELOG.md']);
  const date = git(['show', '-s', '--format=%cs', sha]).out;
  const notes = releaseNotes({ repo, version, date, prevVersion, prevTag, entries: changelog.ok ? changelogEntries(changelog.out) : [], hotfix: Boolean(o.ref), first: !before, exception });
  const floor = floorStatus({ git, gh, repo, prevStable, sha, exception: exception?.kind ?? null, scheduled: Boolean(o.scheduled), now: o.now?.() ?? Date.now(), floorHours: o.floorHours });
  const ridingAlong = Math.max(0, notes.split('\n').filter(l => l.startsWith('- **')).length - 1);
  const plan: Plan = { sha, version, tag, date, hotfix: Boolean(o.ref), via, prevStable, prevVersion, prevTag, tagExists, stableAt: prevStable === sha, notes, skipped, exception, floor, ridingAlong };
  if (floor.verdict === 'refused' || floor.verdict === 'unknown') return { ok: false, code: floor.verdict === 'refused' ? 'REFUSED_FLOOR' : 'FLOOR_UNKNOWN', message: floor.message!, next: floor.next, plan };
  return { ok: true, plan };
}

export interface CutResult { ok: boolean; lines: string[] }

/** Tag, push stable and create the release for a plan; each step is skipped when already done. */
export function cutRelease(p: Plan, o: { repo: string; git: Git; gh: Gh; notesDir?: string }): CutResult {
  const { git, gh } = o;
  const lines: string[] = [];
  const existing = git(['rev-parse', '--verify', '-q', 'refs/tags/' + p.tag + '^{commit}']);
  if (existing.ok && existing.out !== p.sha) return { ok: false, lines: ['TAG: ' + p.tag + ' already names ' + existing.out.slice(0, 12) + ', not ' + p.sha.slice(0, 12)] };
  if (!existing.ok) {
    const message = 'gstack ' + p.tag + ' (' + releaseKind(p.hotfix, p.exception) + ' release)' + (p.exception ? '\n\n' + KIND_LABEL[p.exception.kind] + ': ' + p.exception.reason + '\nVerified: ' + p.exception.evidence : '');
    const t = git(['tag', '-a', p.tag, p.sha, '-m', message]);
    if (!t.ok) return { ok: false, lines: [...lines, 'TAG: failed: ' + t.out] };
    const push = git(['push', 'origin', 'refs/tags/' + p.tag]);
    if (!push.ok) return { ok: false, lines: [...lines, 'TAG: push failed: ' + push.out] };
    lines.push('TAG: ' + p.tag + ' -> ' + p.sha.slice(0, 12) + ' pushed');
  } else {
    lines.push('TAG: ' + p.tag + ' already names ' + p.sha.slice(0, 12));
  }
  if (!p.stableAt) {
    if (p.prevStable && !git(['merge-base', '--is-ancestor', p.prevStable, p.sha]).ok) return { ok: false, lines: [...lines, 'STABLE: refused: ' + p.sha.slice(0, 12) + ' does not descend from stable ' + p.prevStable.slice(0, 12)] };
    // The lease pins origin's stable to the commit the floor and the ancestry check read; a move in between fails the push.
    const push = git(['push', '--force-with-lease=refs/heads/stable:' + (p.prevStable ?? ''), 'origin', p.sha + ':refs/heads/stable']);
    if (!push.ok) return { ok: false, lines: [...lines, 'STABLE: push failed (stable moved since this plan read it, or the push was rejected): ' + push.out] };
    lines.push('STABLE: ' + (p.prevStable ? p.prevStable.slice(0, 12) : 'none') + ' -> ' + p.sha.slice(0, 12));
  } else {
    lines.push('STABLE: already at ' + p.sha.slice(0, 12));
  }
  const view = gh(['release', 'view', p.tag, '--repo', o.repo, '--json', 'tagName']);
  if (view.status === 0) {
    lines.push('RELEASE: ' + p.tag + ' already published');
  } else {
    const dir = o.notesDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-release-'));
    const file = path.join(dir, p.tag + '.md');
    fs.writeFileSync(file, p.notes);
    const created = gh(['release', 'create', p.tag, '--repo', o.repo, '--verify-tag', '--title', 'gstack ' + p.tag, '--notes-file', file]);
    if (created.status !== 0) return { ok: false, lines: [...lines, 'RELEASE: create failed: ' + created.stderr.trim().slice(0, 300)] };
    lines.push(('RELEASE: ' + p.tag + ' published ' + created.stdout.trim()).trim());
  }
  return { ok: true, lines };
}

export function describePlan(p: Plan, dryRun: boolean): string[] {
  const lines = [
    'CANDIDATE: ' + p.sha + ' (' + p.date + ')' + (p.hotfix ? ' [hotfix: --ref]' : '') + ' gated by ' + p.via,
    'VERSION: ' + p.version + ' -> tag ' + p.tag + (p.tagExists === 'same' ? ' (exists at this commit)' : ''),
    'STABLE: ' + (p.stableAt ? 'already at ' + p.sha.slice(0, 12) + ' (finishing an earlier cut)' : (p.prevStable ? p.prevStable.slice(0, 12) + ' (v' + (p.prevVersion ?? '?') + ')' : 'none yet') + ' -> ' + p.sha.slice(0, 12)),
    'NOTES: ' + p.notes.split('\n').filter(l => l.startsWith('- ')).length + ' version lines, ' + p.notes.length + ' chars',
    p.floor.line,
  ];
  if (p.exception) lines.push(p.exception.kind.toUpperCase() + ': `' + p.exception.reason + '` (verified: ' + p.exception.evidence + ')', 'RIDING_ALONG: ' + p.ridingAlong + ' other version' + (p.ridingAlong === 1 ? '' : 's') + ' ship with the fix');
  for (const s of p.skipped) lines.push('SKIPPED: ' + s);
  if (dryRun) {
    lines.push('DRY_RUN: nothing pushed, nothing created. The cut would run:',
      '  git tag -a ' + p.tag + ' ' + p.sha + ' && git push origin refs/tags/' + p.tag,
      '  git push --force-with-lease=refs/heads/stable:' + (p.prevStable ?? '') + ' origin ' + p.sha + ':refs/heads/stable',
      '  gh release create ' + p.tag + ' --verify-tag --title "gstack ' + p.tag + '" --notes-file <notes>');
  }
  return lines;
}

/**
 * The daily check (--daily, crew/scripts/release-cadence.ts): plan at the 24-hour important floor, then let
 * decideDaily pick the trigger, if any; NO_RELEASE_PR becomes a blocked decision only when a trigger
 * is due. decision is null when the plan's refusal stands on its own (a freeze, nothing green,
 * FLOOR_UNKNOWN, a non-fast-forward, a version stamped on an unrelated commit); lines then say which
 * important changes are still waiting on the gate. A plan that cleared while the daily check itself
 * cannot date stable is held as FLOOR_UNKNOWN, so a null decision never reaches a cut.
 */
export function planDaily(o: PlanOptions & { fragmentsDir?: string }): { planned: PlanResult; decision: DailyDecision | null; lines: string[] } {
  const { git, gh, repo } = o;
  const planned = planRelease({ ...o, floorHours: IMPORTANT_FLOOR_HOURS });
  const stable = git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/stable^{commit}']);
  const prev = stable.ok ? stable.out : null;
  const main = git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}']);
  const noReleasePr = !planned.ok && planned.code === 'NO_RELEASE_PR';
  const sha = planned.ok ? planned.plan.sha
    : planned.code === 'REFUSED_FLOOR' ? planned.plan?.sha
    : noReleasePr ? planned.sha
    : planned.code === 'NOTHING_NEW' ? prev ?? undefined
    : undefined;
  const moved = prev ? stableMovedAt(git, gh, repo, prev) : null;
  if (!sha || !main.ok || (moved && moved.at === null)) {
    const waiting = main.ok ? importantChanges(git, prev, main.out, o.fragmentsDir) : [];
    const why = moved && moved.at === null ? moved.why : 'origin/main does not resolve';
    const held: PlanResult = planned.ok ? { ok: false, code: 'FLOOR_UNKNOWN', message: why + '; the daily check cannot pick a trigger, so nothing is cut', next: 'none until the next daily run can date stable', plan: planned.plan } : planned;
    return { planned: held, decision: null, lines: waiting.length ? ['IMPORTANT_UNGATED: ' + waiting.map(c => c.kind + ' in ' + (c.pr ? '#' + c.pr : c.commit.slice(0, 12))).join(', ') + ' is on main but no cut can run (below)'] : [] };
  }
  if (planned.ok && planned.plan.stableAt) return { planned, decision: { action: 'cut', trigger: null, lines: ['DAILY: cut (finishing the cut that already moved stable)'] }, lines: [] };
  const decision = decideDaily({
    now: o.now?.() ?? Date.now(), scheduled: Boolean(o.scheduled), candidate: sha, stableMovedAt: moved?.at ?? null, gatedChanges: sha !== prev, mainAhead: main.out !== prev,
    important: importantChanges(git, prev, sha, o.fragmentsDir), ungated: importantChanges(git, sha, main.out, o.fragmentsDir), releasePr: !noReleasePr,
  });
  return { planned, decision, lines: [] };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const repo = arg('--repo');
  const dryRun = process.argv.includes('--dry-run');
  const summary = arg('--summary');
  const security = arg('--security');
  const regression = arg('--regression');
  const empty = (flag: string, value: string | undefined) => process.argv.includes(flag) && (!value || value.startsWith('--'));
  if (!repo || empty('--security', security) || empty('--regression', regression)) {
    console.error('usage: release-cut.ts --repo owner/name [--ref <sha>] [--security <reason naming GHSA-…|CVE-…|#n> | --regression <reason naming #n and the v<X> it worked in>] [--daily [--fragments-dir <dir>]] [--dry-run] [--summary <file>] [--required-check <name>] [--backstop-check <name>] [--notes-ref <ref>]');
    process.exit(2);
  }
  const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  const daily = process.argv.includes('--daily');
  if (daily && (arg('--ref') || security !== undefined || regression !== undefined)) {
    console.error('release-cut.ts: --daily picks its own candidate and trigger; run --ref, --security or --regression without it');
    process.exit(2);
  }
  const git = gitIn(process.cwd());
  const emit = (lines: string[]) => {
    for (const l of lines) console.log(l);
    if (summary) fs.appendFileSync(summary, lines.map(l => '- ' + l).join('\n') + '\n');
  };
  const annotate = (level: 'notice' | 'warning' | 'error', code: string, text: string) => {
    if (process.env.GITHUB_ACTIONS === 'true') console.log('::' + level + ' title=release-cut ' + code + '::' + text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  };
  const options = { repo, ref: arg('--ref'), git, gh: runGh, requiredCheck: arg('--required-check'), backstopCheck: arg('--backstop-check'), notesRef: arg('--notes-ref'), scheduled, security, regression };
  let planned: PlanResult;
  if (daily) {
    const day = planDaily({ ...options, fragmentsDir: arg('--fragments-dir') });
    planned = day.planned;
    emit([...(day.decision?.lines ?? []), ...day.lines]);
    // A day with no trigger or a trigger still under its floor is the policy working: exit 0 with a
    // notice. A due cut that cannot run (NO_RELEASE_PR, STABLE_STALE) goes red so someone acts; a dry
    // run has answered and exits 0. Every refusal the decision did not absorb keeps its own exit.
    const d = day.decision;
    if (d && d.action !== 'cut') {
      const red = d.action === 'blocked';
      annotate(red ? (dryRun ? 'warning' : 'error') : 'notice', red ? d.lines[0]!.split(':')[0]! : 'daily', d.lines[0]!);
      process.exit(red && !dryRun ? 1 : 0);
    }
  } else {
    planned = planRelease(options);
  }
  if (!planned.ok) {
    emit([planned.code + ': ' + planned.message, ...(planned.next ? ['NEXT_ALLOWED: ' + planned.next] : []), ...(planned.skipped ?? []).map(s => 'SKIPPED: ' + s), ...(planned.plan ? describePlan(planned.plan, false) : [])]);
    // A dry run that finds nothing green or no release PR has done its job,
    // and so has a floor hold on a dry run or on the schedule: the policy
    // working, not a fault. Every other refusal goes red so someone looks.
    const hold = (planned.code === 'REFUSED_FLOOR' && (dryRun || scheduled)) || (planned.code === 'NO_RELEASE_PR' && dryRun);
    if (planned.code !== 'NOTHING_NEW' && planned.code !== 'NO_GREEN_COMMIT') annotate(hold ? (planned.code === 'NO_RELEASE_PR' ? 'warning' : 'notice') : 'error', planned.code, planned.code + ': ' + planned.message + (planned.next ? ' NEXT_ALLOWED: ' + planned.next : ''));
    process.exit(planned.code === 'NOTHING_NEW' || (dryRun && planned.code === 'NO_GREEN_COMMIT') || hold ? 0 : 1);
  }
  emit(describePlan(planned.plan, dryRun));
  if (summary) fs.appendFileSync(summary, '\n<details><summary>Release notes</summary>\n\n' + planned.plan.notes + '\n</details>\n');
  else console.log('--- notes ---\n' + planned.plan.notes);
  if (dryRun) process.exit(0);
  const cut = cutRelease(planned.plan, { repo, git, gh: runGh });
  emit(cut.lines);
  process.exit(cut.ok ? 0 : 1);
}
