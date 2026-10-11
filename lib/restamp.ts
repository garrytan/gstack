/**
 * restamp — the whole stamp in one step (plan C2), behind bin/gstack-restamp.
 *
 * Every stage runs in an isolated staging worktree seeded from the working
 * tree's content fingerprint (bin/gstack-wtree): the version writer
 * (bin/gstack-version-bump write, composed, never grown), the policy's
 * release_tool under its contract (enumerated allowed outputs, pre/post
 * images), the CHANGELOG re-heading (lib/changelog-check.ts), the exact
 * `(was X)` / `since: X` / `vX` rewrites inside `stamp_paths`. The branch is
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
import { checkChangelog, mergeChangelogs, parseChangelog, reheadChangelog } from './changelog-check';
import { type ResultCodeName } from './result-codes';
import {
  SHIP_POLICY_PATH, assertInsideRoot, declaredCommands, isUnavailable, loadPolicyFromBase, loadPolicyFromHead, matchesAny,
  type LoadedPolicy, type QueueMode, type ShipPolicy,
} from './ship-policy';
import { bumpVersion, cmpVersion, extractVersion, fmtVersion, parseVersion, versionWidth, type Bump } from './version-source';

export const JOURNAL_REL = '.gstack/tmp/restamp-journal.json';
export const GATE_AHEAD_REL = '.gstack/tmp/gate-ahead.json';
const BIN_DIR = path.resolve(import.meta.dir, '..', 'bin');
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

export type StageName = 'version' | 'release_tool' | 'changelog' | 'stamp_paths' | 'mirror' | 'apply';
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
  gh?: (args: string[]) => { ok: boolean; out: string }; failAfter?: string; gateWorktree?: string;
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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, env: env ?? process.env });
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
  if (stale.length) {
    throw new Refusal('QUEUE_STALE', `queue order moved: ${stale.map(pr => `#${pr}=${actual[pr]}`).join(', ')}`, {
      expected: { order: o.expectOrder, base: o.expectBase ?? null }, actual: { prs: actual, base: baseSha },
      recompute: `gstack-restamp --next --base ${o.base} --expect-base ${baseSha}${mine ? ` --pr ${mine}` : ''} --expect-order ${o.expectOrder.join(',')}`,
    });
  }
}

interface Plan {
  policy: ShipPolicy; policyLabel: string; queueMode: QueueMode; oldVersion: string; newVersion: string; versionRel: string;
  baseVersion: string; branchStamp: string | null; forkVersion: string; baseSha: string; baseRef: string; claims: string; level: Bump; predecessor?: { pr: string; head: string };
}

function planVersions(o: RestampOptions, loaded: LoadedPolicy, policyLabel: string): Plan {
  const baseRef = `origin/${o.base}`;
  const baseSha = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!baseSha.ok) throw new Refusal('POLICY_SOURCE_UNAVAILABLE', `${baseRef} is not a resolvable commit; nothing written`, { fix: `git fetch origin ${o.base} --depth=1` });
  if (o.expectBase && !baseSha.out.startsWith(o.expectBase)) {
    throw new Refusal('QUEUE_STALE', `base moved: expected ${o.expectBase}, ${baseRef} is ${baseSha.out}`, {
      expected: { base: o.expectBase }, actual: { base: baseSha.out },
      recompute: `gstack-restamp --next --base ${o.base} --expect-base ${baseSha.out.slice(0, 12)}${o.expectOrder?.length ? ` --expect-order ${o.expectOrder.join(',')}` : ''}`,
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
    const r = spawnSync('bun', [path.join(BIN_DIR, 'gstack-next-version'), '--base', o.base, '--bump', level, '--current-version', atBase.version], { cwd: o.repoRoot, encoding: 'utf8', timeout: 120_000, env: o.env ?? process.env });
    let q: any = null;
    try { q = JSON.parse(r.stdout ?? ''); } catch {}
    const usable = r.status === 0 && q && typeof q.version === 'string' && parseVersion(q.version) && (q.offline === false || q.fallback === 'git');
    newVersion = usable ? q.version : bumped(atBase.version, level);
    claims = usable ? `read (claim-at-open; queue ${JSON.stringify(q.claimed ?? q.queue ?? [])})` : 'unverified (claim-at-open; gstack-next-version unusable, local arithmetic)';
  }
  // The branch's own tentative stamp: its VERSION when it moved past base; else nothing (mentions come from the lines it added).
  const branchStamp = oldVersion !== atBase.version ? oldVersion : null;
  return { policy, policyLabel, queueMode, oldVersion, newVersion, versionRel: atBase.rel, baseVersion: atBase.version, branchStamp, forkVersion: forkVersion(o.repoRoot, baseRef, atBase.version), baseSha: baseSha.out, baseRef, claims, level, predecessor };
}

/** The version writer's own files: the version source, the manifest (root or pinned) and the npm lockfiles beside it. */
function versionFiles(root: string, versionRel: string): string[] {
  const pin = path.join(root, '.gstack', 'package-json-path');
  const pkgRel = fs.existsSync(pin) ? (fs.readFileSync(pin, 'utf8').split('\n')[0]?.trim() || 'package.json') : 'package.json';
  const dir = path.dirname(pkgRel) === '.' ? '' : path.dirname(pkgRel) + '/';
  return [versionRel, pkgRel, ...NPM_LOCKFILES.map(l => dir + l)];
}
function allowedOutput(plan: Plan, root: string, rel: string): boolean {
  const p = plan.policy;
  if (versionFiles(root, plan.versionRel).includes(rel)) return true;
  if (p.changelog && rel === p.changelog) return true;
  return matchesAny(p.stamp_paths, rel) || matchesAny(p.release_outputs, rel);
}

interface Hunk { removed: string[]; added: string[] }
export interface FileDiff { path: string; binary: boolean; hunks: Hunk[]; status: 'M' | 'A' | 'D' | 'R' }

/** Parse `git diff --unified=0` into per-file hunks of removed/added lines (shared with lib/tree-receipt.ts). */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), binary: false, hunks: [], status: 'M' };
      files.push(cur);
      hunk = null;
    } else if (!cur) continue;
    else if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename to ')) cur.status = 'R';
    else if (line.startsWith('Binary files')) cur.binary = true;
    else if (line.startsWith('@@')) { hunk = { removed: [], added: [] }; cur.hunks.push(hunk); }
    else if (hunk && line.startsWith('-') && !line.startsWith('---')) hunk.removed.push(line.slice(1));
    else if (hunk && line.startsWith('+') && !line.startsWith('+++')) hunk.added.push(line.slice(1));
  }
  return files;
}

/** The lines a branch itself added, per stamp file: `git diff --unified=0 <since> -- <files>` in `cwd` against its working tree. */
export function branchAddedLines(cwd: string, since: string, files: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (files.length === 0) return out;
  const diff = git(cwd, ['diff', '--unified=0', '--no-color', '--no-ext-diff', since, '--', ...files]);
  for (const f of parseUnifiedDiff(diff.out)) {
    const set = out.get(f.path) ?? new Set<string>();
    for (const h of f.hunks) for (const a of h.added) set.add(a);
    out.set(f.path, set);
  }
  return out;
}

/**
 * The branch's tentative stamps: versions it mentions in a stamp pattern, on
 * lines it added itself, newer than the version at its fork point and not
 * the allocated one. A released version is never newer than the fork point
 * of a branch written against it, and the repo's own version width must
 * match, so a 3-digit dependency pin in a 4-digit repo is never a candidate.
 */
export function tentativeMentions(added: Map<string, Set<string>>, forkVersion: string, newVersion: string): string[] {
  const fork = parseVersion(forkVersion);
  if (!fork) return [];
  const width = versionWidth(forkVersion);
  const found = new Set<string>();
  for (const lines of added.values()) {
    for (const text of lines) {
      for (const m of text.matchAll(/(?:\(was |since:\s*|(?<![A-Za-z0-9.])v)(\d+(?:\.\d+){1,3})(?![0-9.])/g)) {
        const raw = m[1]!;
        const v = parseVersion(raw);
        if (!v || versionWidth(raw) !== width || raw === newVersion || cmpVersion(v, fork) <= 0) continue;
        found.add(raw);
      }
    }
  }
  return [...found];
}

/** The version at the branch's original fork point: the first parent of its oldest own commit (base when it has none). */
export function forkVersion(repoRoot: string, baseRef: string, fallback: string): string {
  const first = git(repoRoot, ['rev-list', '--reverse', '--first-parent', `${baseRef}..HEAD`]).out.split('\n')[0]?.trim();
  if (!first) return fallback;
  const v = versionAtRef(repoRoot, `${first}^`);
  return 'version' in v ? v.version : fallback;
}

/** Exact `(was X)`, `since: X`, `vX` rewrites; anything else in the file stays. */
export function rewriteStamps(text: string, oldVersion: string, newVersion: string): { text: string; count: number } {
  const esc = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: Array<[RegExp, string]> = [
    [new RegExp(`\\(was ${esc}\\)`, 'g'), `(was ${newVersion})`],
    [new RegExp(`(since:\\s*)${esc}(?![0-9.])`, 'g'), `$1${newVersion}`],
    [new RegExp(`(?<![A-Za-z0-9.])v${esc}(?![0-9.])`, 'g'), `v${newVersion}`],
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

function runStages(o: RestampOptions, plan: Plan, staging: string, since: string, stages: StageRecord[]): void {
  const stage = (name: StageName): StageRecord => { const s: StageRecord = { name, status: 'pending' }; stages.push(s); return s; };
  const injected = (name: string) => { if (o.failAfter === name) throw new Error(`injected failure after ${name}`); };
  const env = { ...(o.env ?? process.env), GSTACK_RESTAMP_STAGING: '1' };
  const before = new Set(changedPaths(staging));

  const v = stage('version');
  const w = spawnSync('bun', [path.join(BIN_DIR, 'gstack-version-bump'), 'write', '--version', plan.newVersion], { cwd: staging, encoding: 'utf8', timeout: 120_000, env });
  if (w.status !== 0) { v.status = 'failed'; v.detail = (w.stderr ?? '').trim().slice(0, 300); throw new Refusal('RESTAMP_VERSION_SOURCE', `gstack-version-bump write failed: ${v.detail}; nothing written`); }
  v.status = 'done'; v.detail = `wrote ${plan.newVersion}`;
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
    const r = reheadChangelog(fs.readFileSync(clPath, 'utf8'), { from, to: plan.newVersion, date, file: clRel! });
    if (r.error) { cl.status = 'failed'; cl.detail = r.error.message; throw new Refusal(r.error.code, `${clRel}: ${r.error.message}; nothing written to the branch`); }
    if (r.moved) fs.writeFileSync(clPath, r.text);
    const check = checkChangelog(fs.readFileSync(clPath, 'utf8'), plan.newVersion, clRel!);
    if (check.length) { cl.status = 'failed'; cl.detail = check[0]!.message; throw new Refusal(check[0]!.code, `${check[0]!.path}: ${check[0]!.message}; nothing written to the branch`); }
    cl.status = 'done'; cl.detail = r.moved ? `${r.from} -> ${r.to}` : `already headed ${plan.newVersion}`;
  } else { cl.status = 'skipped'; cl.detail = clRel ? `${clRel} absent` : 'changelog: null'; }
  injected('changelog');

  const sp = stage('stamp_paths');
  if (plan.policy.stamp_paths.length === 0) { sp.status = 'skipped'; sp.detail = 'no stamp_paths in policy'; }
  else {
    const files = git(staging, ['ls-files', '-z']).out.split('\0').filter(f => f && matchesAny(plan.policy.stamp_paths, f));
    for (const rel of files) {
      const why = assertInsideRoot(staging, rel);
      if (why) throw new Refusal('POLICY_CONTAINMENT', `${why}; nothing written`);
    }
    const added = branchAddedLines(staging, since, files);
    const explicit = new Set([...(o.was ? [o.was] : []), ...(plan.branchStamp ? [plan.branchStamp] : [])].filter(v => v !== plan.newVersion));
    const tentative = new Set(tentativeMentions(added, plan.forkVersion, plan.newVersion).filter(v => !explicit.has(v)));
    let touched = 0;
    let total = 0;
    for (const rel of files) {
      const abs = path.join(staging, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const own = added.get(rel);
      if (explicit.size === 0 && !own) continue;
      let count = 0;
      const out = fs.readFileSync(abs, 'utf8').split('\n').map(line => {
        let text = line;
        for (const old of explicit) { const r = rewriteStamps(text, old, plan.newVersion); text = r.text; count += r.count; }
        if (own?.has(line)) for (const old of tentative) { const r = rewriteStamps(text, old, plan.newVersion); text = r.text; count += r.count; }
        return text;
      }).join('\n');
      if (count) { fs.writeFileSync(abs, out); touched += 1; total += count; }
    }
    const olds = [...explicit, ...tentative];
    sp.status = olds.length ? 'done' : 'skipped';
    sp.detail = olds.length ? `${total} mention(s) in ${touched} file(s) (${olds.join(', ')} -> ${plan.newVersion})` : `no tentative mention newer than the fork version ${plan.forkVersion}`;
  }
  injected('stamp_paths');

  const mi = stage('mirror');
  mi.status = 'skipped'; mi.detail = plan.policy.mirror ? `tier 2: declared ${plan.policy.mirror}, not run` : 'no mirror in policy';
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
    const commands = declaredCommands(loaded.policy);
    if (commands.length && !o.allowRepoCommands) {
      throw new Refusal('REPO_COMMANDS_NOT_ALLOWED', `repo commands not executed (pass --allow-repo-commands): ${commands.map(c => `${c.key}: ${c.command}`).join('; ')}; nothing written`, { commands });
    }
    const plan = planVersions(o, loaded, label);
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
        if (prior.inputs?.new_version === plan.newVersion && prior.status !== 'complete' && prior.inputs.old_version !== plan.newVersion) { plan.oldVersion = prior.inputs.old_version; plan.branchStamp = prior.inputs.old_version !== plan.baseVersion ? prior.inputs.old_version : plan.branchStamp; }
      } catch {}
    }

    if (o.after) return gateAhead(o, plan, stages, common);

    const wt = spawnSync(path.join(BIN_DIR, 'gstack-wtree'), [], { cwd: o.repoRoot, encoding: 'utf8', timeout: 60_000 });
    const wtree = (wt.stdout ?? '').trim();
    if (wt.status !== 0 || !/^[0-9a-f]{40,64}$/.test(wtree)) throw new Refusal('RESTAMP_CONFLICT', `cannot fingerprint the working tree (${(wt.stderr ?? '').trim()}); nothing written`);
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
          const merged = mergeChangelogs(git(dir, ['show', `:2:${c}`]).out + '\n', git(dir, ['show', `:3:${c}`]).out + '\n');
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
  const slug = spawnSync(path.join(BIN_DIR, 'gstack-slug'), [], { cwd: o.repoRoot, encoding: 'utf8', timeout: 30_000 });
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
