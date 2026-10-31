/**
 * restamp — the whole stamp in one step (plan C2), behind bin/gstack-restamp.
 *
 * Every stage runs in an isolated staging worktree seeded from the working
 * tree's content fingerprint (bin/gstack-wtree): the version writer
 * (bin/gstack-version-bump write, composed, never grown), the policy's
 * release_tool under its contract (enumerated allowed outputs, pre/post
 * images), the CHANGELOG re-heading (lib/changelog-check.ts), the exact
 * `(was X)` / `since: X` / `vX` rewrites inside `stamp_paths`. A policy
 * `restamp_command` (the repo's own restamp) runs first instead of the
 * version writer, on a clean checkout of HEAD (the caller's tree must be
 * clean), under the same output confinement. The branch is
 * written only after every stage validated, file by file against the
 * fingerprinted preimage, with every write journaled in
 * .gstack/tmp/restamp-journal.json so a failure after any stage rolls back
 * without touching unrelated edits. `--dry-run` prints the diff and writes
 * nothing. `--after <pr>` stamps a merge of the branch and its predecessor in
 * a throwaway worktree (gate-ahead) and records .gstack/tmp/gate-ahead.json.
 * Policy comes from origin/<base> (lib/ship-policy.ts); repo-declared
 * commands run only with allowRepoCommands (the /ship flag).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from './bun-isolation';
import { checkChangelog, mergeChangelogs, parseChangelog, reheadChangelog } from './changelog-check';
import { effectiveBump, foldIntoUnreleased, readFragments, type FragmentSet } from './changelog-fragments';
import { type ResultCodeName } from './result-codes';
import { runScriptSync, wtreeFingerprint } from './script-invocation';
import {
  SHIP_POLICY_PATH, VERSION_SLOT, assertInsideRoot, declaredCommands, isUnavailable, loadPolicyFromBase, loadPolicyFromHead, matchesAny,
  type LoadedPolicy, type QueueMode, type ShipPolicy,
} from './ship-policy';
import { bumpVersion, cmpVersion, extractVersion, fmtVersion, parseVersion, versionWidth, type Bump } from './version-source';

export const JOURNAL_REL = '.gstack/tmp/restamp-journal.json';
export const GATE_AHEAD_REL = '.gstack/tmp/gate-ahead.json';
const BIN_DIR = path.resolve(import.meta.dir, '..', 'bin');
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

export type StageName = 'restamp_command' | 'version' | 'release_tool' | 'changelog' | 'stamp_paths' | 'mirror' | 'apply';
export interface JournalWrite { path: string; pre_sha256: string | null; post_sha256: string | null; applied: boolean }
export interface StageRecord { name: StageName; status: 'pending' | 'done' | 'skipped' | 'failed'; detail?: string; writes?: JournalWrite[] }
export interface Journal {
  schema_version: 1; started_at: string; status: 'staging' | 'applying' | 'complete' | 'failed' | 'rolled_back';
  inputs: { old_version: string; new_version: string; base_ref: string; base_sha: string; policy: string; wtree: string; queue_mode: QueueMode; after?: GateAheadRecord | null };
  stages: StageRecord[];
}
export interface GateAheadRecord {
  schema_version: 1; pr: string | null; predecessor_pr: string; predecessor_head: string; branch_head: string; gated_head: string;
  gated_tree: string; version: string; worktree: string; evidence_branch_key: string; created_at: string;
}

export interface RestampOptions {
  repoRoot: string; base: string; version?: string; next?: boolean; bump?: Bump; queueMode?: QueueMode;
  after?: { pr: string; ref?: string }; pr?: string; expectBase?: string; expectOrder?: string[]; was?: string;
  policyFrom: 'base' | 'head'; allowRepoCommands: boolean; dryRun: boolean; now?: Date; env?: NodeJS.ProcessEnv;
  gh?: (args: string[]) => { ok: boolean; out: string }; failAfter?: string; gateWorktree?: string; baseRef?: string;
}
export interface RestampResult {
  status: 'stamped' | 'noop' | 'dry-run' | 'refused' | 'failed' | 'gate-ahead';
  code?: ResultCodeName; message?: string; fix?: string;
  oldVersion?: string; newVersion?: string; base?: { ref: string; sha: string }; policy?: string; queueMode?: QueueMode;
  claims?: string; stages: StageRecord[]; diff?: string; files?: string[]; journal?: string; gateAhead?: GateAheadRecord;
  mergeCondition?: string; commands?: Array<{ key: string; command: string; cwd: string }>; expected?: unknown; actual?: unknown; recompute?: string;
}

function sha256(buf: Buffer | string): string { return createHash('sha256').update(buf).digest('hex'); }
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}
class Refusal extends Error { constructor(public code: ResultCodeName, message: string, public extra: Partial<RestampResult> = {}) { super(message); } }

export function ensureTmpExcluded(repoRoot: string): void {
  const ex = git(repoRoot, ['rev-parse', '--git-path', 'info/exclude']);
  if (!ex.ok) return;
  const file = path.isAbsolute(ex.out) ? ex.out : path.join(repoRoot, ex.out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text.split('\n').includes('/.gstack/tmp/')) fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + '/.gstack/tmp/\n');
}

/** The configured version source at a committed revision: `.gstack/version-path` there, else VERSION. */
export function versionAtRef(repoRoot: string, ref: string): { rel: string; version: string } | { error: string } {
  const pin = git(repoRoot, ['show', `${ref}:.gstack/version-path`]);
  const rel = pin.ok && pin.out.split('\n')[0]?.trim() ? pin.out.split('\n')[0]!.trim() : 'VERSION';
  if (rel.includes('..') || path.isAbsolute(rel)) return { error: `.gstack/version-path at ${ref} escapes the repository (${rel})` };
  const show = git(repoRoot, ['show', `${ref}:${rel}`]);
  if (!show.ok) return { error: `${rel} does not exist at ${ref}` };
  const v = extractVersion(show.out + '\n', rel);
  if (!v || !parseVersion(v)) return { error: `${rel} at ${ref} holds no parsable version` };
  return { rel, version: v };
}

function bumped(version: string, level: Bump): string {
  const w = versionWidth(version);
  return fmtVersion(bumpVersion(parseVersion(version)!, level, w), w);
}

function loadPolicy(o: RestampOptions): { loaded: LoadedPolicy; label: string } {
  if (o.policyFrom === 'head') {
    if (!o.allowRepoCommands) throw new Refusal('REPO_COMMANDS_NOT_ALLOWED', '--policy-from head is the unreviewed bootstrap path and needs --allow-repo-commands; nothing written');
    const loaded = loadPolicyFromHead(o.repoRoot);
    return { loaded, label: 'head (unreviewed)' };
  }
  const loaded = loadPolicyFromBase(o.repoRoot, o.base);
  if (isUnavailable(loaded)) throw new Refusal('POLICY_SOURCE_UNAVAILABLE', `policy source unavailable (${loaded.detail}); nothing written`, { fix: `git fetch origin ${o.base} --depth=1` });
  return { loaded, label: loaded.present ? `base ${loaded.source.label}` : `none (defaults; ${loaded.source.label})` };
}

function queueOrderCheck(o: RestampOptions, baseSha: string): void {
  if (!o.expectOrder?.length) return;
  const gh = o.gh ?? ((args: string[]) => { const r = spawnSync('gh', args, { cwd: o.repoRoot, encoding: 'utf8', timeout: 60_000 }); return { ok: r.status === 0, out: r.stdout ?? '' }; });
  const mine = o.pr ?? o.after?.pr ?? null;
  const idx = mine ? o.expectOrder.indexOf(mine) : -1;
  const ahead = idx >= 0 ? o.expectOrder.slice(0, idx) : o.expectOrder;
  const behind = idx >= 0 ? o.expectOrder.slice(idx + 1) : [];
  const actual: Record<string, string> = {};
  for (const pr of [...ahead, ...behind]) {
    const r = gh(['pr', 'view', pr, '--json', 'state,mergeCommit,headRefOid']);
    let info: any = null;
    try { info = JSON.parse(r.out); } catch {}
    if (!r.ok || !info) { actual[pr] = 'unknown'; continue; }
    const merged = info.state === 'MERGED';
    const inBase = merged && info.mergeCommit?.oid ? git(o.repoRoot, ['merge-base', '--is-ancestor', info.mergeCommit.oid, baseSha]).ok : false;
    actual[pr] = merged ? (inBase ? 'merged' : 'merged-not-in-base') : String(info.state ?? 'unknown').toLowerCase();
  }
  const stale = [...ahead.filter(pr => actual[pr] !== 'merged'), ...behind.filter(pr => actual[pr]?.startsWith('merged'))];
  if (!stale.length) return;
  // The recompute command is the corrected order, never the stale list again: this PR first (a list that left it out read
  // every entry as a predecessor), PRs merged into the local base dropped, an unmerged predecessor kept ahead because it
  // still has to merge first. A predecessor GitHub calls merged that the local base does not carry stays ahead too: the
  // recompute pins --expect-base to that local base, and dropping the PR would let it allocate the version the
  // predecessor already took (pre-landing review, pass 1); the lane fetches the base and the entry reads merged.
  const corrected = correctedOrder(o.expectOrder, mine, actual);
  const waitingOn = ahead.filter(pr => actual[pr] !== 'merged' && actual[pr] !== 'merged-not-in-base');
  const unfetched = ahead.filter(pr => actual[pr] === 'merged-not-in-base');
  const why = mine && idx < 0 ? `; --pr ${mine} is not in --expect-order, so every listed PR read as a predecessor: list this PR first, then the remaining order`
    : [waitingOn.length ? `${waitingOn.map(pr => `#${pr}`).join(', ')} must merge before this PR stamps` : '',
      unfetched.length ? `${unfetched.map(pr => `#${pr}`).join(', ')} merged but the local ${o.base} does not carry the merge yet: git fetch origin ${o.base}, then rerun` : '']
      .filter(Boolean).map(s => `; ${s}`).join('');
  throw new Refusal('QUEUE_STALE', `queue order moved: ${stale.map(pr => `#${pr}=${actual[pr]}`).join(', ')}${why}`, {
    expected: { order: o.expectOrder, base: o.expectBase ?? null }, actual: { prs: actual, base: baseSha },
    recompute: `gstack-restamp --next --base ${o.base} --expect-base ${baseSha.slice(0, 12)}${mine ? ` --pr ${mine}` : ''} --expect-order ${corrected.join(',')}`,
    ...(unfetched.length ? { fix: `git fetch origin ${o.base}` } : {}),
  });
}

/**
 * The --expect-order to run next: this PR first when the list left it out, every PR merged into the local base dropped,
 * the rest (open PRs and merges the local base does not carry yet) in their order.
 */
export function correctedOrder(order: readonly string[], mine: string | null, actual: Record<string, string>): string[] {
  const rest = order.filter(pr => actual[pr] !== 'merged');
  return mine && !order.includes(mine) ? [mine, ...rest] : rest;
}

interface Plan {
  policy: ShipPolicy; policyLabel: string; queueMode: QueueMode; oldVersion: string; newVersion: string; versionRel: string;
  baseVersion: string; branchStamp: string | null; forkVersion: string; baseSha: string; baseRef: string; claims: string; level: Bump; predecessor?: { pr: string; head: string };
}

function planVersions(o: RestampOptions, loaded: LoadedPolicy, policyLabel: string): Plan {
  const baseRef = o.baseRef ?? `origin/${o.base}`;
  const baseSha = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!baseSha.ok) throw new Refusal('POLICY_SOURCE_UNAVAILABLE', `${baseRef} is not a resolvable commit; nothing written`, { fix: `git fetch origin ${o.base} --depth=1` });
  if (o.expectBase && !baseSha.out.startsWith(o.expectBase)) {
    throw new Refusal('QUEUE_STALE', `base moved: expected ${o.expectBase}, ${baseRef} is ${baseSha.out}`, {
      expected: { base: o.expectBase }, actual: { base: baseSha.out },
      recompute: `gstack-restamp --next --base ${o.base} --expect-base ${baseSha.out.slice(0, 12)}${o.pr ? ` --pr ${o.pr}` : ''}${o.expectOrder?.length ? ` --expect-order ${correctedOrder(o.expectOrder, o.pr ?? null, {}).join(',')}` : ''}`,
    });
  }
  queueOrderCheck(o, baseSha.out);
  const policy = loaded.policy;
  const queueMode = o.queueMode ?? policy.queue_mode;
  const level: Bump = o.bump ?? (policy.bump === 'patch' ? 'patch' : 'micro');
  const atBase = versionAtRef(o.repoRoot, baseSha.out);
  if ('error' in atBase) throw new Refusal('RESTAMP_VERSION_SOURCE', `${atBase.error}; nothing written`);
  const head = versionAtRef(o.repoRoot, 'HEAD');
  const working = fs.existsSync(path.join(o.repoRoot, atBase.rel)) ? extractVersion(fs.readFileSync(path.join(o.repoRoot, atBase.rel), 'utf8'), atBase.rel) : '';
  const oldVersion = working && parseVersion(working) ? working : 'error' in head ? atBase.version : head.version;
  let newVersion: string;
  let claims = 'n/a';
  let predecessor: Plan['predecessor'];
  if (o.after) {
    const ref = o.after.ref ?? `refs/pull/${o.after.pr}/head`;
    const predHead = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!predHead.ok) throw new Refusal('RESTAMP_PREDECESSOR_MOVED', `predecessor #${o.after.pr} head ${ref} is not resolvable; fetch it first; nothing written`);
    const predV = versionAtRef(o.repoRoot, predHead.out);
    if ('error' in predV) throw new Refusal('RESTAMP_VERSION_SOURCE', `${predV.error}; nothing written`);
    newVersion = bumped(predV.version, level);
    predecessor = { pr: o.after.pr, head: predHead.out };
    claims = 'ignored (gate-ahead relative to predecessor)';
  } else if (o.version) {
    if (!parseVersion(o.version)) throw new Refusal('RESTAMP_VERSION_SOURCE', `--version ${o.version} is not MAJOR.MINOR.PATCH[.MICRO]; nothing written`);
    newVersion = o.version;
  } else if (queueMode === 'stamp-at-merge') {
    newVersion = bumped(atBase.version, level);
    claims = 'ignored (stamp-at-merge)';
  } else {
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(BIN_DIR, 'gstack-next-version'), '--base', o.base, '--bump', level, '--current-version', atBase.version], { cwd: o.repoRoot, encoding: 'utf8', timeout: 120_000, env: o.env ?? process.env });
    let q: any = null;
    try { q = JSON.parse(r.stdout ?? ''); } catch {}
    const usable = r.status === 0 && q && typeof q.version === 'string' && parseVersion(q.version) && (q.offline === false || q.fallback === 'git');
    newVersion = usable ? q.version : bumped(atBase.version, level);
    const queue = JSON.stringify(q?.claimed ?? q?.queue ?? []);
    const unknown = (Array.isArray(q?.unknown_claims) ? q.unknown_claims : []).map((n: unknown) => `#${n}`).join(', ') || 'some open PRs';
    claims = !usable ? 'unverified (claim-at-open; gstack-next-version unusable, local arithmetic)'
      : q.complete === false ? `incomplete (claim-at-open; the VERSION claims of PR ${unknown} are unknown, so ${q.version} is provisional and may collide; rerun, then ask the coordinator before stamping; queue ${queue})`
      : `read (claim-at-open; queue ${queue})`;
  }
  // The branch's own tentative stamp: its VERSION when it moved past base; else nothing (mentions come from the lines it added).
  const branchStamp = oldVersion !== atBase.version ? oldVersion : null;
  return { policy, policyLabel, queueMode, oldVersion, newVersion, versionRel: atBase.rel, baseVersion: atBase.version, branchStamp, forkVersion: forkVersion(o.repoRoot, baseRef, atBase.version), baseSha: baseSha.out, baseRef, claims, level, predecessor };
}

/** The version writer's own files: the version source, the manifest (root or pinned) and the npm lockfiles beside it. */
export function versionFiles(root: string, versionRel: string): string[] {
  const pin = path.join(root, '.gstack', 'package-json-path');
  const pkgRel = fs.existsSync(pin) ? (fs.readFileSync(pin, 'utf8').split('\n')[0]?.trim() || 'package.json') : 'package.json';
  const dir = path.dirname(pkgRel) === '.' ? '' : path.dirname(pkgRel) + '/';
  return [versionRel, pkgRel, ...NPM_LOCKFILES.map(l => dir + l)];
}
/**
 * The manifest's path when the repo's convention is a four-part manifest: the policy lists it as a
 * stamp file and the base's copy holds a four-part version (gbrain). Read at the base, like the
 * policy, so a branch an older restamp cut to three parts heals. Otherwise null, and the writer
 * stores the npm-valid three-part form (decision 11; gstack's own manifest).
 */
function manifestKeepsFourParts(plan: Plan, root: string): string | null {
  const pkgRel = versionFiles(root, plan.versionRel)[1]!;
  if (pkgRel === plan.versionRel || !matchesAny([...plan.policy.stamp_paths, ...plan.policy.stamp_files], pkgRel)) return null;
  const atBase = git(root, ['show', `${plan.baseSha}:${pkgRel}`]);
  const version = atBase.ok ? extractVersion(atBase.out, pkgRel) : '';
  return version && versionWidth(version) === 4 ? pkgRel : null;
}
function allowedOutput(plan: Plan, root: string, rel: string): boolean {
  const p = plan.policy;
  if (versionFiles(root, plan.versionRel).includes(rel)) return true;
  if (p.changelog && rel === p.changelog) return true;
  return matchesAny(p.stamp_paths, rel) || matchesAny(p.stamp_files, rel) || matchesAny(p.release_outputs, rel);
}

interface Hunk { removed: string[]; added: string[]; at: number; addedAt: number[] }
export interface FileDiff { path: string; binary: boolean; hunks: Hunk[]; status: 'M' | 'A' | 'D' | 'R'; modeChanged?: boolean }

/**
 * Parse `git diff --unified=0` into per-file hunks of removed/added lines (shared with lib/tree-receipt.ts).
 * File headers come only before a file's first hunk: inside a hunk every `-`/`+` line is content, so a
 * body line that begins `--` or `++` (`---`/`+++` in the diff) is never dropped as a header.
 * `addedAt` holds each added line's 1-based position on the new side, counted through any context
 * line the hunk carries (`diff.interHunkContext` can join hunks under `--unified=0`).
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let cursor = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), binary: false, hunks: [], status: 'M' };
      files.push(cur);
      hunk = null;
    } else if (!cur) continue;
    else if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (!hunk && (line.startsWith('old mode ') || line.startsWith('new mode '))) cur.modeChanged = true;
    else if (line.startsWith('rename to ')) cur.status = 'R';
    else if (line.startsWith('Binary files')) cur.binary = true;
    else if (line.startsWith('@@')) { hunk = { removed: [], added: [], at: Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)?.[1] ?? 0), addedAt: [] }; cursor = hunk.at; cur.hunks.push(hunk); }
    else if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
    else if (hunk && line.startsWith('+')) { hunk.added.push(line.slice(1)); hunk.addedAt.push(cursor); cursor += 1; }
    else if (hunk && line.startsWith(' ')) cursor += 1;
  }
  return files;
}

/** The lines a branch itself added to one file: their text, and their 1-based positions in the working-tree file. */
export interface AddedLines { text: Set<string>; at: Set<number>; /** Lines the diff shows that `notOwn` names: the base's, left out. */ notOwn: number }

/**
 * The lines a branch itself added, per stamp file: `git diff --unified=0 <since> -- <files>` in `cwd`
 * against its working tree (or against `to` when given). Positions are the parser's per-line count
 * on the new side (context lines included, and `--inter-hunk-context=0` keeps a
 * `diff.interHunkContext` setting from joining hunks), so a base line whose text equals an added
 * line, or a CRLF checkout whose diff is LF-normalized, is told apart by position. A line in
 * `notOwn` for the file (the base's own additions since `since`) is never the branch's: when the
 * base is merged into the working tree uncommitted, HEAD still forks before that merge and the
 * diff from the fork carries every line the base added since, main's own release keys included
 * (train 24, 2026-10-27: `DOCS_CAPS_KEY_VERSION` from #3511 moved in both slots).
 */
export function branchAddedLines(cwd: string, since: string, files: string[], to?: string, notOwn?: Map<string, AddedLines>): Map<string, AddedLines> {
  const out = new Map<string, AddedLines>();
  if (files.length === 0) return out;
  const diff = git(cwd, ['diff', '--unified=0', '--inter-hunk-context=0', '--no-color', '--no-ext-diff', since, ...(to ? [to] : []), '--', ...files]);
  // A failed diff must not read as "the branch added nothing" (or "the base added nothing"), which would move the base's lines again.
  if (!diff.ok) throw new Refusal('POLICY_SOURCE_UNAVAILABLE', `cannot diff ${since.slice(0, 12)}..${to ? to.slice(0, 12) : 'the worktree'} for the stamp_paths stage (${(diff.err || diff.out).split('\n')[0]}); nothing written`);
  for (const f of parseUnifiedDiff(diff.out)) {
    const own = out.get(f.path) ?? { text: new Set<string>(), at: new Set<number>(), notOwn: 0 };
    const base = notOwn?.get(f.path)?.text;
    for (const h of f.hunks) h.added.forEach((a, i) => { if (base?.has(a)) { own.notOwn += 1; return; } own.text.add(a); own.at.add(h.addedAt[i]!); });
    out.set(f.path, own);
  }
  return out;
}

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION_RE = '(?<v>\\d+(?:\\.\\d+){1,3})(?![0-9.])';
/**
 * The built-in stamp forms as scanners, the version in the `v` group: `(was X)`, `since: X` and `vX`.
 * A quote may wrap X in the first two (`since: 'X'`, `(was "X")`); an opened quote must close right
 * after X, so `since: '1.2.3-beta'` and `since: '1.2.3"` are not the form.
 */
const BUILT_IN_MENTIONS: readonly RegExp[] = [
  new RegExp(`\\(was (['"]?)${VERSION_RE}(?=\\1\\))`, 'g'),
  new RegExp(`since:\\s*(['"]?)${VERSION_RE}(?=\\1)`, 'g'),
  new RegExp(`(?<![A-Za-z0-9.])v${VERSION_RE}`, 'g'),
];
/** A policy `stamp_patterns` template (one `{version}` slot) as a scanner, the version in the `v` group at a version boundary. */
function templateMention(template: string): RegExp {
  const [pre, post] = template.split(VERSION_SLOT) as [string, string];
  return new RegExp(`${escapeRegExp(pre)}(?<![0-9.])${VERSION_RE}${escapeRegExp(post)}`, 'g');
}

/**
 * The branch's tentative stamps: versions it mentions in a stamp form (the
 * built-in ones and the policy's `stamp_patterns` templates), on lines it
 * added itself, newer than the version at its fork point and not the
 * allocated one. A released version is never newer than the fork point of a
 * branch written against it, and the repo's own version width must match, so
 * a 3-digit dependency pin in a 4-digit repo is never a candidate.
 */
export function tentativeMentions(added: Map<string, Set<string>>, forkVersion: string, newVersion: string, templates: readonly string[] = []): string[] {
  const fork = parseVersion(forkVersion);
  if (!fork) return [];
  const width = versionWidth(forkVersion);
  const scanners = [...BUILT_IN_MENTIONS, ...templates.map(templateMention)];
  const found = new Set<string>();
  for (const lines of added.values()) {
    for (const text of lines) {
      for (const re of scanners) {
        for (const m of text.matchAll(re)) {
          const raw = m.groups!.v!;
          const v = parseVersion(raw);
          if (!v || versionWidth(raw) !== width || raw === newVersion || cmpVersion(v, fork) <= 0) continue;
          found.add(raw);
        }
      }
    }
  }
  return [...found];
}

/** The versions one line mentions in a stamp form (the built-in forms and the policy's `stamp_patterns` templates). */
export function stampMentions(text: string, templates: readonly string[] = []): Set<string> {
  const found = new Set<string>();
  for (const re of [...BUILT_IN_MENTIONS, ...templates.map(templateMention)]) for (const m of text.matchAll(re)) found.add(m.groups!.v!);
  return found;
}

/**
 * A removed/added line pair that a restamp alone explains: every version the
 * removed line mentions in a stamp form and the added line no longer does
 * moves to `newV`, and the rewritten line is the added line byte for byte.
 * The moved versions are the ones the stamp_paths stage moves, not only the
 * old version `oldV` (the gated head's): a tentative `*_KEY_VERSION = '<next
 * minor>'` never equals the base version at the slot and is a stamp all the
 * same (#3512). The stage's own bound applies: a tentative mention is newer
 * than the version the branch was written against, so a moved version older
 * than `oldV` (a released key moved by hand) is not a stamp, and neither is
 * one of another width (`tentativeMentions`: a 3-digit dependency pin in a
 * 4-digit repo is never a candidate, so moving it is a hand edit). A line that
 * moves nothing, or changes anything beyond those mentions, is not one either.
 */
export function stampOnlyLine(removed: string, added: string, oldV: string, newV: string, templates: readonly string[] = []): boolean {
  if (removed === added) return false;
  const floor = parseVersion(oldV);
  const width = versionWidth(oldV);
  const after = stampMentions(added, templates);
  const moved = [...stampMentions(removed, templates)].filter(v => v !== newV && !after.has(v));
  if (!moved.length || !floor) return false;
  if (moved.some(v => { const p = parseVersion(v); return !p || versionWidth(v) !== width || cmpVersion(p, floor) < 0; })) return false;
  let text = removed;
  for (const v of moved) text = rewriteStamps(text, v, newV, templates).text;
  return text === added;
}

/** The version at the branch's original fork point: the first parent of its oldest own commit (base when it has none). */
export function forkVersion(repoRoot: string, baseRef: string, fallback: string): string {
  const first = git(repoRoot, ['rev-list', '--reverse', '--first-parent', `${baseRef}..HEAD`]).out.split('\n')[0]?.trim();
  if (!first) return fallback;
  const v = versionAtRef(repoRoot, `${first}^`);
  return 'version' in v ? v.version : fallback;
}

/**
 * Exact `(was X)`, `since: X`, `vX` rewrites plus the policy's literal
 * `stamp_patterns` templates (one `{version}` slot, matched at a version
 * boundary); anything else in the file stays. A quote around X in the
 * `(was X)` and `since: X` forms (`since: 'X'`, `(was "X")`, the shape of a
 * quoted source row) is matched and kept as written when it closes right after
 * X (`since: '1.2.3-beta'` and `since: '1.2.3"` are not the form); `vX`
 * already accepts a quote before the `v`.
 */
export function rewriteStamps(text: string, oldVersion: string, newVersion: string, templates: readonly string[] = []): { text: string; count: number } {
  const v = escapeRegExp(oldVersion);
  const patterns: Array<[RegExp, (...m: string[]) => string]> = [
    [new RegExp(`\\(was (['"]?)${v}\\1\\)`, 'g'), (_, q) => `(was ${q}${newVersion}${q})`],
    [new RegExp(`(since:\\s*)(['"]?)${v}(?![0-9.])(?=\\2)`, 'g'), (_, pre, q) => `${pre}${q}${newVersion}`],
    [new RegExp(`(?<![A-Za-z0-9.])v${v}(?![0-9.])`, 'g'), () => `v${newVersion}`],
    ...templates.map(t => { const [pre, post] = t.split(VERSION_SLOT) as [string, string]; return [new RegExp(`${escapeRegExp(pre)}(?<![0-9.])${v}(?![0-9.])${escapeRegExp(post)}`, 'g'), () => `${pre}${newVersion}${post}`] as [RegExp, () => string]; }),
  ];
  let count = 0;
  let out = text;
  for (const [re, rep] of patterns) {
    count += (out.match(re) ?? []).length;
    out = out.replace(re, rep);
  }
  return { text: out, count };
}

/** Paths the stages changed: worktree vs the seeded index (never index vs HEAD, which is the user's own uncommitted work). */
function changedPaths(staging: string): string[] {
  const modified = git(staging, ['diff', '--name-only', '-z']).out.split('\0');
  const untracked = git(staging, ['ls-files', '--others', '--exclude-standard', '-z']).out.split('\0');
  return [...new Set([...modified, ...untracked])].filter(p => p && !p.startsWith('.restamp-pre/') && p !== 'node_modules');
}

/** A release tool needs the repo's installed dependencies; an ignored top-level node_modules is linked, never copied. */
function linkIgnoredDeps(repoRoot: string, staging: string): void {
  const nm = path.join(repoRoot, 'node_modules');
  if (!fs.existsSync(nm) || fs.existsSync(path.join(staging, 'node_modules'))) return;
  if (!git(repoRoot, ['check-ignore', '-q', 'node_modules']).ok) return;
  try { fs.symlinkSync(nm, path.join(staging, 'node_modules'), 'dir'); } catch {}
}

/**
 * The repo's own restamp (`restamp_command`), first in the staging worktree:
 * the target version as `$1` and in GSTACK_RESTAMP_VERSION. Whatever it
 * stages or commits there is folded back into worktree edits against the
 * seeded tree; its outputs are confined like release_tool's, and the
 * version file must hold the target version. Any failure writes nothing.
 */
function runRestampCommand(command: string, plan: Plan, staging: string, env: NodeJS.ProcessEnv, before: Set<string>, s: StageRecord): void {
  const seeded = git(staging, ['write-tree']).out;
  const r = spawnSync('sh', ['-c', `${command} "$1"`, 'sh', plan.newVersion], { cwd: staging, encoding: 'utf8', timeout: 600_000, env: { ...env, GSTACK_RESTAMP_VERSION: plan.newVersion, GSTACK_RESTAMP_BASE_SHA: plan.baseSha } });
  git(staging, ['read-tree', seeded]);
  if (r.status !== 0) { s.status = 'failed'; s.detail = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().slice(0, 300); throw new Refusal('RESTAMP_RELEASE_TOOL_FAILED', `restamp_command exited ${r.status}: ${s.detail}; nothing written to the branch`); }
  const outside = changedPaths(staging).filter(p => !before.has(p) && !allowedOutput(plan, staging, p));
  if (outside.length) { s.status = 'failed'; s.detail = outside.join(', '); throw new Refusal('RESTAMP_OUTPUT_OUTSIDE_ALLOWED', `restamp_command wrote outside the allowed set: ${outside.join(', ')}; nothing written to the branch`); }
  const file = path.join(staging, plan.versionRel);
  const got = fs.existsSync(file) ? extractVersion(fs.readFileSync(file, 'utf8'), plan.versionRel) : '';
  if (got !== plan.newVersion) { s.status = 'failed'; s.detail = `${plan.versionRel}=${got || '(missing)'}`; throw new Refusal('RESTAMP_VERSION_SOURCE', `restamp_command left ${plan.versionRel} at ${got || '(missing)'}, expected ${plan.newVersion}; nothing written`); }
  s.status = 'done'; s.detail = `${command} ${plan.newVersion}`;
}

function runStages(o: RestampOptions, plan: Plan, staging: string, since: string, stages: StageRecord[]): void {
  const stage = (name: StageName): StageRecord => { const s: StageRecord = { name, status: 'pending' }; stages.push(s); return s; };
  const injected = (name: string) => { if (o.failAfter === name) throw new Error(`injected failure after ${name}`); };
  const env = { ...(o.env ?? process.env), GSTACK_RESTAMP_STAGING: '1' };
  const before = new Set(changedPaths(staging));

  const command = plan.policy.restamp_command;
  if (command) runRestampCommand(command, plan, staging, env, before, stage('restamp_command'));
  const v = stage('version');
  if (command) { v.status = 'skipped'; v.detail = 'restamp_command owns the version'; }
  else {
    const full = manifestKeepsFourParts(plan, staging);
    const w = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(BIN_DIR, 'gstack-version-bump'), 'write', '--version', plan.newVersion, ...(full ? ['--manifest-form', 'full'] : [])], { cwd: staging, encoding: 'utf8', timeout: 120_000, env });
    if (w.status !== 0) { v.status = 'failed'; v.detail = (w.stderr ?? '').trim().slice(0, 300); throw new Refusal('RESTAMP_VERSION_SOURCE', `gstack-version-bump write failed: ${v.detail}; nothing written`); }
    v.status = 'done'; v.detail = `wrote ${plan.newVersion}` + (full ? ` (${full} keeps four parts: a policy stamp file the base holds in four)` : '');
  }
  injected('version');

  const rt = stage('release_tool');
  if (plan.policy.release_tool) {
    const r = spawnSync('sh', ['-c', plan.policy.release_tool], { cwd: staging, encoding: 'utf8', timeout: 600_000, env });
    if (r.status !== 0) { rt.status = 'failed'; rt.detail = (r.stderr ?? r.stdout ?? '').trim().slice(0, 300); throw new Refusal('RESTAMP_RELEASE_TOOL_FAILED', `release_tool exited ${r.status}: ${rt.detail}; nothing written to the branch`); }
    const outside = changedPaths(staging).filter(p => !before.has(p) && !allowedOutput(plan, staging, p));
    if (outside.length) { rt.status = 'failed'; rt.detail = outside.join(', '); throw new Refusal('RESTAMP_OUTPUT_OUTSIDE_ALLOWED', `release_tool wrote outside the allowed set: ${outside.join(', ')}; nothing written to the branch`); }
    rt.status = 'done'; rt.detail = plan.policy.release_tool;
  } else { rt.status = 'skipped'; rt.detail = 'no release_tool in policy'; }
  injected('release_tool');

  const cl = stage('changelog');
  const clRel = plan.policy.changelog;
  const clPath = clRel ? path.join(staging, clRel) : null;
  if (clPath && fs.existsSync(clPath)) {
    const date = (o.now ?? new Date()).toISOString().slice(0, 10);
    const from = o.was ?? plan.branchStamp;
    const dir = plan.policy.changelog_fragments?.dir;
    const frags = dir ? readFragments(staging, null, dir, plan.baseSha, clRel) : null;
    if (frags?.errors.length) { cl.status = 'failed'; cl.detail = `${frags.errors[0]!.path}: ${frags.errors[0]!.message}`; throw new Refusal('CHANGELOG_FRAGMENT_INVALID', `${cl.detail}; nothing written to the branch`); }
    for (const f of frags?.fragments ?? []) fs.rmSync(path.join(staging, f.path));
    const r = reheadChangelog(foldIntoUnreleased(fs.readFileSync(clPath, 'utf8'), frags?.fragments ?? []), { from, to: plan.newVersion, date, file: clRel! });
    if (r.error) { cl.status = 'failed'; cl.detail = r.error.message; throw new Refusal(r.error.code, `${clRel}: ${r.error.message}; nothing written to the branch`); }
    if (r.moved) fs.writeFileSync(clPath, r.text);
    // Inherited duplicates are allowed at the larger count of two base readings: the base tip and
    // `since`, the commit the branch's own lines are counted from (its fork point, or the predecessor's
    // head in a gate-ahead stamp), so neither a duplicate main collapsed after the fork nor one it
    // gained since refuses the PR. A reading the base cannot show (the PR adds the file) is named.
    const readings = [...new Set([plan.baseSha, since])].map(sha => ({ sha, cl: git(o.repoRoot, ['show', `${sha}:${clRel}`]) }));
    const readable = readings.filter(x => x.cl.ok);
    const unreadable = readings.filter(x => !x.cl.ok).map(x => `${x.sha.slice(0, 12)}:${clRel}`);
    const baseNote = unreadable.length === 0 ? '' : readable.length === 0
      ? `; base ${clRel} unreadable at ${unreadable.join(', ')}, so every duplicate heading counts`
      : `; base ${clRel} unreadable at ${unreadable.join(', ')}, inherited headings counted at ${readable.map(x => x.sha.slice(0, 12)).join(', ')} only`;
    const check = checkChangelog(fs.readFileSync(clPath, 'utf8'), plan.newVersion, clRel!, readable.map(x => x.cl.out + '\n'));
    if (check.length) { cl.status = 'failed'; cl.detail = check[0]!.message + baseNote; throw new Refusal(check[0]!.code, `${check[0]!.path}: ${check[0]!.message}${baseNote}; nothing written to the branch`); }
    cl.status = 'done'; cl.detail = (r.moved ? `${r.from} -> ${r.to}` : `already headed ${plan.newVersion}`) + (frags?.fragments.length ? `; folded ${frags.fragments.map(f => f.path).join(', ')}` : '') + baseNote;
  } else { cl.status = 'skipped'; cl.detail = clRel ? `${clRel} absent` : 'changelog: null'; }
  injected('changelog');

  rewriteStampPaths(o, plan, staging, since, stage('stamp_paths'));
  injected('stamp_paths');

  const mi = stage('mirror');
  mi.status = 'skipped'; mi.detail = plan.policy.mirror ? `tier 2: declared ${plan.policy.mirror}, not run` : 'no mirror in policy';
}

/**
 * The stamp_paths stage. An explicit old version (the branch's own stamp, or
 * `--was`) is rewritten on every line of every stamp file; a tentative one
 * (a mention newer than the fork version) only on lines the branch added.
 * With no explicit version the branch's VERSION equals the base's: either it
 * never stamped, or it stamped X and the base reached X on its own (a PR that
 * lost its slot and merged the base). Then a stamp-form mention of the base
 * version on a line the branch added is its own tentative stamp, stale now,
 * and moves; the same version on a line the base already carries is the
 * base's release and stays. The detail names both counts per file.
 */
function rewriteStampPaths(o: RestampOptions, plan: Plan, staging: string, since: string, sp: StageRecord): void {
  const stampGlobs = [...plan.policy.stamp_paths, ...plan.policy.stamp_files];
  const templates = plan.policy.stamp_patterns;
  if (stampGlobs.length === 0) { sp.status = 'skipped'; sp.detail = 'no stamp_paths in policy'; return; }
  const files = git(staging, ['ls-files', '-z']).out.split('\0').filter(f => f && matchesAny(stampGlobs, f));
  for (const rel of files) {
    const why = assertInsideRoot(staging, rel);
    if (why) throw new Refusal('POLICY_CONTAINMENT', `${why}; nothing written`);
  }
  const baseAdded = branchAddedLines(o.repoRoot, since, files, plan.baseSha);
  const added = branchAddedLines(staging, since, files, undefined, baseAdded);
  const explicit = new Set([...(o.was ? [o.was] : []), ...(plan.branchStamp ? [plan.branchStamp] : [])].filter(v => v !== plan.newVersion));
  const tentative = new Set(tentativeMentions(new Map([...added].map(([rel, own]) => [rel, own.text])), plan.forkVersion, plan.newVersion, templates).filter(v => !explicit.has(v)));
  const equalBase = !o.was && !plan.branchStamp && plan.baseVersion !== plan.newVersion ? plan.baseVersion : null;
  if (equalBase) tentative.add(equalBase);
  const moved = new Map<string, number>();
  const baseSide: string[] = [];
  let touched = 0;
  let total = 0;
  for (const rel of files) {
    const abs = path.join(staging, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const own = added.get(rel);
    if (explicit.size === 0 && !own) continue;
    let count = 0;
    let ownBase = 0;
    let keptBase = 0;
    const rewrite = (text: string, old: string): string => {
      const r = rewriteStamps(text, old, plan.newVersion, templates);
      count += r.count;
      if (r.count) moved.set(old, (moved.get(old) ?? 0) + r.count);
      return r.text;
    };
    const out = fs.readFileSync(abs, 'utf8').split('\n').map((line, i) => {
      const mine = own?.at.has(i + 1) ?? false;
      if (equalBase) {
        const n = rewriteStamps(line, equalBase, plan.newVersion, templates).count;
        if (mine) ownBase += n; else keptBase += n;
      }
      let text = line;
      for (const old of explicit) text = rewrite(text, old);
      if (mine) for (const old of tentative) text = rewrite(text, old);
      return text;
    }).join('\n');
    if (ownBase || keptBase) baseSide.push(`${rel}: ${ownBase} moved, ${keptBase} kept`);
    if (count) { fs.writeFileSync(abs, out); touched += 1; total += count; }
  }
  const olds = [...explicit, ...tentative].filter(v => moved.has(v));
  sp.status = olds.length ? 'done' : 'skipped';
  const equalNote = equalBase && baseSide.length
    ? `; VERSION equals base ${equalBase}, so ${equalBase} moved only on lines this branch added and stayed on the base's own lines (${baseSide.join('; ')})`
    : '';
  const searched = explicit.size ? `no mention of ${[...explicit].join(', ')} in the stamp files and ` : '';
  const baseOwn = [...added].filter(([, own]) => own.notOwn);
  const baseOwnNote = baseOwn.length ? `; ${baseOwn.reduce((n, [, own]) => n + own.notOwn, 0)} line(s) the base added since the fork point are the base's, not this branch's, and stay (${baseOwn.map(([rel, own]) => `${rel}: ${own.notOwn}`).join('; ')})` : '';
  sp.detail = (olds.length
    ? `${total} mention(s) in ${touched} file(s) (${olds.join(', ')} -> ${plan.newVersion})${equalNote}`
    : `${searched}no tentative mention newer than the fork version ${plan.forkVersion}${equalBase ? ` and none of base ${equalBase} on a line this branch added` : ''}${equalNote}`) + baseOwnNote;
}

function applyToBranch(o: RestampOptions, staging: string, wtree: string, files: string[], journal: Journal, journalPath: string): JournalWrite[] {
  const apply: StageRecord = { name: 'apply', status: 'pending', writes: [] };
  journal.stages.push(apply);
  journal.status = 'applying';
  const save = () => fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  const writes = apply.writes!;
  const rollback = (reason: string): never => {
    for (const w of [...writes].reverse()) {
      if (!w.applied) continue;
      const abs = path.join(o.repoRoot, w.path);
      const cur = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
      if (cur !== w.post_sha256) { journal.status = 'failed'; save(); throw new Refusal('RESTAMP_CONFLICT', `${reason}; rollback stopped: ${w.path} no longer holds the recorded postimage`); }
      if (w.pre_sha256 === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, fs.readFileSync(path.join(staging, '.restamp-pre', w.path)));
      w.applied = false;
    }
    journal.status = 'rolled_back'; apply.status = 'failed'; apply.detail = reason; save();
    throw new Refusal('RESTAMP_CONFLICT', `${reason}; rolled back ${writes.length} write(s)`);
  };
  fs.mkdirSync(path.join(staging, '.restamp-pre'), { recursive: true });
  for (const rel of files) {
    const why = assertInsideRoot(o.repoRoot, rel);
    if (why) throw new Refusal('POLICY_CONTAINMENT', `${why}; nothing written`);
  }
  let n = 0;
  for (const rel of files) {
    const real = path.join(o.repoRoot, rel);
    const stagingFile = path.join(staging, rel);
    const exists = fs.existsSync(real);
    const fingerprinted = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${wtree}:${rel}`]);
    if (exists) {
      const cur = git(o.repoRoot, ['hash-object', real]).out;
      if (fingerprinted.ok && cur !== fingerprinted.out) rollback(`${rel} changed in the working tree while the restamp staged`);
      fs.mkdirSync(path.dirname(path.join(staging, '.restamp-pre', rel)), { recursive: true });
      fs.copyFileSync(real, path.join(staging, '.restamp-pre', rel));
    } else if (fingerprinted.ok) rollback(`${rel} was removed from the working tree while the restamp staged`);
    const w: JournalWrite = { path: rel, pre_sha256: exists ? sha256(fs.readFileSync(real)) : null, post_sha256: null, applied: false };
    writes.push(w);
    save();
    if (fs.existsSync(stagingFile)) {
      const bytes = fs.readFileSync(stagingFile);
      fs.mkdirSync(path.dirname(real), { recursive: true });
      const tmp = `${real}.restamp.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, real);
      w.post_sha256 = sha256(bytes);
    } else { fs.rmSync(real, { force: true }); w.post_sha256 = null; }
    w.applied = true;
    n += 1;
    save();
    if (o.failAfter === `apply:${n}`) rollback(`injected failure after apply:${n}`);
  }
  apply.status = 'done'; apply.detail = `${writes.length} file(s)`;
  journal.status = 'complete';
  save();
  return writes;
}

/** The fragments this change adds (absent from origin/<base>), read from the working-tree fingerprint the staging worktree is seeded from. */
function fragmentsOf(o: RestampOptions, dir: string, changelog: string | null): FragmentSet {
  const fp = wtreeFingerprint({ cwd: o.repoRoot });
  if ('error' in fp) throw new Refusal('RESTAMP_CONFLICT', `cannot fingerprint the working tree (${fp.error}); nothing written`);
  const set = readFragments(o.repoRoot, fp.tree, dir, o.baseRef ?? `origin/${o.base}`, changelog);
  if (set.errors.length) throw new Refusal('CHANGELOG_FRAGMENT_INVALID', `${set.errors[0]!.path}: ${set.errors[0]!.message}; nothing written`);
  return set;
}

function removeWorktree(repoRoot: string, dir: string): void {
  git(repoRoot, ['worktree', 'remove', '--force', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  git(repoRoot, ['worktree', 'prune']);
}

export function restamp(o: RestampOptions): RestampResult {
  const stages: StageRecord[] = [];
  let staging: string | null = null;
  try {
    const { loaded, label } = loadPolicy(o);
    if (loaded.errors.length) throw new Refusal(loaded.errors[0]!.code, `${SHIP_POLICY_PATH} (${label}): ${loaded.errors[0]!.message} at ${loaded.errors[0]!.path}; nothing written`);
    if (loaded.policy.bump === 'never' && !o.bump && !o.version) throw new Refusal('RESTAMP_VERSION_SOURCE', `${SHIP_POLICY_PATH} (${label}): bump never names no level; a release stamp passes --bump <level> or --version <X>; nothing written`);
    const commands = declaredCommands(loaded.policy);
    if (commands.length && !o.allowRepoCommands) {
      throw new Refusal('REPO_COMMANDS_NOT_ALLOWED', `repo commands not executed (pass --allow-repo-commands): ${commands.map(c => `${c.key}: ${c.command}`).join('; ')}; nothing written`, { commands });
    }
    const fragDir = loaded.policy.changelog_fragments?.dir ?? null;
    const frags = fragDir ? fragmentsOf(o, fragDir, loaded.policy.changelog) : null;
    const plan = planVersions(frags && !o.bump ? { ...o, bump: effectiveBump(loaded.policy.bump === 'patch' ? 'patch' : 'micro', frags.fragments) } : o, loaded, label);
    const headSha = git(o.repoRoot, ['rev-parse', 'HEAD']).out;
    const common: Partial<RestampResult> = {
      oldVersion: plan.oldVersion, newVersion: plan.newVersion, base: { ref: plan.baseRef, sha: plan.baseSha }, policy: plan.policyLabel,
      queueMode: plan.queueMode, claims: plan.claims, mergeCondition: headSha, commands,
    };
    ensureTmpExcluded(o.repoRoot);
    const journalPath = path.join(o.repoRoot, JOURNAL_REL);
    if (!o.after && fs.existsSync(journalPath)) {
      try {
        const prior: Journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        // A retry after a partial apply sees the already-written VERSION as a branch stamp; the journal holds the
        // original provenance (the branch's own stamp, or the base version when the branch had none), so restore it.
        if (prior.inputs?.new_version === plan.newVersion && prior.status !== 'complete' && prior.inputs.old_version !== plan.newVersion) { plan.oldVersion = prior.inputs.old_version; plan.branchStamp = prior.inputs.old_version !== plan.baseVersion ? prior.inputs.old_version : null; }
      } catch {}
    }

    if (o.after) return gateAhead(o, plan, stages, common);
    if (plan.policy.restamp_command) {
      const dirty = git(o.repoRoot, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(Boolean).map(l => l.slice(3));
      if (dirty.length) throw new Refusal('RESTAMP_CONFLICT', `restamp_command needs a clean HEAD, index and worktree (it runs on a clean checkout of HEAD); commit or remove: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ' …' : ''}; nothing written`);
    }

    const fp = wtreeFingerprint({ cwd: o.repoRoot });
    if ('error' in fp) throw new Refusal('RESTAMP_CONFLICT', `cannot fingerprint the working tree (${fp.error}); nothing written`);
    const wtree = fp.tree;
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-restamp-staging-'));
    fs.rmSync(staging, { recursive: true, force: true });
    const add = git(o.repoRoot, ['worktree', 'add', '--detach', '-q', staging, 'HEAD']);
    if (!add.ok) throw new Refusal('RESTAMP_CONFLICT', `cannot create the staging worktree: ${add.err}; nothing written`);
    const seed = git(staging, ['read-tree', '--reset', '-u', wtree]);
    if (!seed.ok) throw new Refusal('RESTAMP_CONFLICT', `cannot seed the staging worktree: ${seed.err}; nothing written`);
    linkIgnoredDeps(o.repoRoot, staging);

    runStages(o, plan, staging, git(o.repoRoot, ['merge-base', plan.baseRef, 'HEAD']).out || plan.baseSha, stages);
    const files = changedPaths(staging).sort();
    git(staging, ['add', '-A']);
    const diff = git(staging, ['diff', '--cached', wtree]).out;
    if (files.length === 0) return { ...common, status: 'noop', stages, diff: '', files: [] };
    if (o.dryRun) return { ...common, status: 'dry-run', stages, diff, files };

    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const journal: Journal = {
      schema_version: 1, started_at: (o.now ?? new Date()).toISOString(), status: 'staging',
      inputs: { old_version: plan.branchStamp ?? plan.oldVersion, new_version: plan.newVersion, base_ref: plan.baseRef, base_sha: plan.baseSha, policy: plan.policyLabel, wtree, queue_mode: plan.queueMode },
      stages: stages.map(s => ({ ...s })),
    };
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
    applyToBranch(o, staging, wtree, files, journal, journalPath);
    return { ...common, status: 'stamped', stages: journal.stages, diff, files, journal: journalPath };
  } catch (e: any) {
    if (e instanceof Refusal) return { status: e.code === 'RESTAMP_CONFLICT' ? 'failed' : 'refused', code: e.code, message: e.message, stages, ...e.extra };
    return { status: 'failed', code: 'RESTAMP_CONFLICT', message: `${e?.message ?? e}; see ${JOURNAL_REL}`, stages };
  } finally {
    if (staging) removeWorktree(o.repoRoot, staging);
  }
}

/**
 * Gate-ahead: merge the branch and the predecessor's head in a throwaway
 * worktree, stamp N+1 relative to the predecessor there, commit, and record
 * the predecessor head and the evidence branch key. The branch is untouched.
 */
function gateAhead(o: RestampOptions, plan: Plan, stages: StageRecord[], common: Partial<RestampResult>): RestampResult {
  const pred = plan.predecessor!;
  const branchHead = git(o.repoRoot, ['rev-parse', 'HEAD']).out;
  const dir = o.gateWorktree ?? path.join(o.repoRoot, '.gstack', 'tmp', 'gate-ahead-worktree');
  if (fs.existsSync(dir)) removeWorktree(o.repoRoot, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = git(o.repoRoot, ['worktree', 'add', '--detach', '-q', dir, branchHead]);
  if (!add.ok) throw new Refusal('RESTAMP_CONFLICT', `cannot create the gate-ahead worktree: ${add.err}; nothing written`);
  const env = { ...(o.env ?? process.env), GIT_AUTHOR_NAME: 'gstack-restamp', GIT_AUTHOR_EMAIL: 'restamp@gstack.local', GIT_COMMITTER_NAME: 'gstack-restamp', GIT_COMMITTER_EMAIL: 'restamp@gstack.local' };
  const merge = git(dir, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-q', pred.head], env);
  if (!merge.ok) {
    const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    const stampFiles = versionFiles(dir, plan.versionRel);
    const resolvable = conflicts.length > 0 && conflicts.every(c => stampFiles.includes(c) || c === plan.policy.changelog);
    let unresolved: string[] = resolvable ? [] : conflicts;
    if (resolvable) {
      for (const c of conflicts) {
        if (c === plan.policy.changelog) {
          const stage = (n: number) => git(dir, ['show', `:${n}:${c}`]);
          const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
          const merged = ours.ok && theirs.ok ? mergeChangelogs(ours.out + '\n', theirs.out + '\n', base.ok ? base.out + '\n' : undefined) : null;
          if (merged === null) { unresolved = [c]; break; }
          fs.writeFileSync(path.join(dir, c), merged);
        } else git(dir, ['checkout', '--theirs', '--', c]);
      }
    }
    if (unresolved.length) {
      removeWorktree(o.repoRoot, dir);
      throw new Refusal('RESTAMP_MERGE_CONFLICT', `merge of HEAD and predecessor #${pred.pr} (${pred.head.slice(0, 12)}) conflicts in ${unresolved.join(', ') || 'unknown files'}; nothing written`);
    }
    git(dir, ['add', '--', ...conflicts]);
    const done = git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-edit'], env);
    if (!done.ok) { removeWorktree(o.repoRoot, dir); throw new Refusal('RESTAMP_MERGE_CONFLICT', `cannot complete the gate-ahead merge: ${done.err}; nothing written`); }
  }
  runStages(o, plan, dir, pred.head, stages);
  if (o.dryRun) { const diff = git(dir, ['diff']).out; removeWorktree(o.repoRoot, dir); return { ...common, status: 'dry-run', stages, diff, files: changedPaths(dir) }; }
  git(dir, ['add', '-A']);
  const commit = git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `restamp v${plan.newVersion} (gate-ahead after #${pred.pr})`], env);
  if (!commit.ok) { removeWorktree(o.repoRoot, dir); throw new Refusal('RESTAMP_CONFLICT', `cannot commit the gate-ahead stamp: ${commit.err}`); }
  const gatedHead = git(dir, ['rev-parse', 'HEAD']).out;
  const gatedTree = git(dir, ['rev-parse', 'HEAD^{tree}']).out;
  const slug = runScriptSync(path.join(BIN_DIR, 'gstack-slug'), [], { cwd: o.repoRoot, encoding: 'utf8', timeout: 30_000 });
  const branchKey = /^BRANCH=(.+)$/m.exec(slug.stdout ?? '')?.[1]?.trim() ?? git(o.repoRoot, ['branch', '--show-current']).out;
  const record: GateAheadRecord = {
    schema_version: 1, pr: o.pr ?? null, predecessor_pr: pred.pr, predecessor_head: pred.head, branch_head: branchHead, gated_head: gatedHead,
    gated_tree: gatedTree, version: plan.newVersion, worktree: dir, evidence_branch_key: branchKey, created_at: (o.now ?? new Date()).toISOString(),
  };
  const file = path.join(o.repoRoot, GATE_AHEAD_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return { ...common, status: 'gate-ahead', stages, gateAhead: record, files: [], diff: git(dir, ['show', '--stat', '--format=', 'HEAD']).out, journal: file };
}
