/**
 * ship-queue-land — the per-PR merge step (docs/ship-policy.md#land), behind
 * `gstack-ship-queue land --pr <n>`. The PR carries an unversioned change (a
 * changelog fragment, or a legacy `[Unreleased]` section) at a pin /ship
 * reviewed; land takes the repository land lock, merges the pin with the base
 * branch (resolving release-version fields only), stamps the merged tree with
 * gstack-restamp, makes one commit whose parents are [pin, base] and whose tree
 * is the stamped tree, pushes it to the PR branch under an exact lease, waits
 * for the PR's checks there, merges with --match-head-commit, and confirms the
 * base branch's tree is the stamped tree. Every step is journaled under
 * .gstack/tmp/ship-queue/land/<pr>.json, so a rerun resumes.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeChangelogs, parseChangelog } from './changelog-check';
import { fragmentSlug, readFragments } from './changelog-fragments';
import { restamp, versionAtRef } from './restamp';
import { matchesAny, type ShipPolicy } from './ship-policy';
import { ciAtHead, loadBasePolicy, type QueueContext, type StepOutput } from './ship-queue';
import { QUEUE_DIR_REL, git, writeJsonAtomic, type QueueFailure } from './ship-queue-gate';
import { bindShippedReceipt } from './ship-receipt-depth';
import { loadReady, rebuildFromNotes, repoIdentity } from './ship-queue-train-record';

export const LAND_LOCK_REF = 'refs/notes/gstack-land';
export const MAX_RESTAMPS = 2;
const PUSH_STALE_MS = 10 * 60_000;
const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const isSha = (s: string | undefined) => /^[0-9a-f]{40,64}$/.test(s ?? '');
/** The first path segment of `rel` inside `wt` that is a symlink, or null: land writes only inside the checkout. */
function linkedSegment(wt: string, rel: string): string | null {
  const segs = rel.split('/');
  const at = segs.findIndex((_, i) => { try { return fs.lstatSync(path.join(wt, ...segs.slice(0, i + 1))).isSymbolicLink(); } catch { return false; } });
  return at < 0 ? null : segs.slice(0, at + 1).join('/');
}

/** A release file the merge step writes that is a symlink, or sits under one, in the checkout `wt`; null when none. */
export function linkedReleaseFile(wt: string, policy: ShipPolicy, versionRel: string): string | null {
  const exact = [versionRel, ...MANIFESTS, ...(policy.changelog ? [policy.changelog] : [])];
  return git(wt, ['ls-files', '-s', '-z']).out.split('\0').filter(rec => rec.startsWith('120000 ')).map(rec => rec.slice(rec.indexOf('\t') + 1))
    .find(rel => exact.includes(rel) || matchesAny([...policy.release_outputs, ...policy.stamp_paths], rel)) ?? exact.map(rel => linkedSegment(wt, rel)).find(Boolean) ?? null;
}

export interface LandJournal {
  schema_version: 1; pr: string; branch: string;
  reviewed_pin: string; last_pushed_head: string | null; stamp_commit: string | null; stamp_tree: string | null;
  base_sha: string | null; version: string | null; date: string | null; restamps: number;
  drift_main?: string; repair_pr?: string;
  phase: 'locked' | 'stamped' | 'pushed' | 'merged' | 'landed' | 'drift';
}
export interface LandLock { pr: string; holder: string; started_at: string; phase: 'stamping' | 'pushing' | 'waiting' | 'merging' | 'drift'; journal: string; phase_at?: string; repair_pr?: string; drift_of?: string }
export interface LandOptions { pr: string; repair?: boolean; dryRun?: boolean; noWait?: boolean; breakLock?: boolean; allowRepoCommands?: boolean; waitTimeoutMin?: number; now?: () => Date; holder?: string }

const fail = (lines: string[], failure: QueueFailure, run: string): StepOutput => ({ ok: false, lines, failure, run });
export const landJournalRel = (pr: string) => `${QUEUE_DIR_REL}/land/${pr}.json`;

function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } }

/** The remote land lock: a ref whose commit holds lock.json, or a released marker. Updated only by exact lease. */
function readLock(root: string): { sha: string; lock: LandLock | null } {
  git(root, ['fetch', '-q', 'origin', `+${LAND_LOCK_REF}:${LAND_LOCK_REF}`]);
  const sha = git(root, ['rev-parse', '--verify', '--quiet', LAND_LOCK_REF]).out;
  if (!sha) return { sha: '', lock: null };
  const body = git(root, ['show', `${sha}:lock.json`]);
  let lock: LandLock | { released: true } | null = null;
  try { lock = body.ok ? JSON.parse(body.out) : null; } catch { lock = null; }
  return { sha, lock: lock && 'pr' in lock && /^\d+$/.test(String(lock.pr)) ? lock : null };
}

function writeLock(root: string, expected: string, value: LandLock | { released: true; by: string; at: string }): { ok: boolean; sha: string } {
  const blob = git(root, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(value, null, 2) + '\n').out;
  const tree = git(root, ['mktree'], undefined, `100644 blob ${blob}\tlock.json\n`).out;
  const commit = git(root, ['commit-tree', tree, ...(expected ? ['-p', expected] : []), '-m', 'released' in value ? `land lock released by ${value.by}` : `land lock #${value.pr} ${value.phase}`]).out;
  if (![blob, tree, commit].every(isSha)) return { ok: false, sha: '' };
  const push = git(root, ['push', '-q', `--force-with-lease=${LAND_LOCK_REF}:${expected}`, 'origin', `${commit}:${LAND_LOCK_REF}`]);
  if (push.ok) git(root, ['update-ref', LAND_LOCK_REF, commit]);
  return { ok: push.ok, sha: commit };
}

/**
 * Release-version conflicts only: the version file and release outputs take the base's side, the
 * CHANGELOG merges by section (mergeChangelogs), and a manifest or npm lockfile is re-merged with
 * every side's release version set to the base's, so a clean dependency or script edit survives and
 * a real dependency conflict still conflicts. Returns the files it could not resolve.
 */
export function resolveReleaseConflicts(wt: string, conflicts: string[], policy: ShipPolicy, versionRel: string): string[] {
  const left: string[] = [];
  const stage = (n: number, rel: string) => git(wt, ['show', `:${n}:${rel}`]);
  for (const rel of conflicts) {
    const base = path.basename(rel);
    if (linkedSegment(wt, rel)) { left.push(rel); continue; }
    if (policy.changelog && rel === policy.changelog) {
      const merged = mergeChangelogs(stage(2, rel).out + '\n', stage(3, rel).out + '\n');
      if (merged === null) { left.push(rel); continue; }
      fs.writeFileSync(path.join(wt, rel), merged);
    } else if (!MANIFESTS.includes(base) && (rel === versionRel || matchesAny(policy.release_outputs, rel))) {
      if (!git(wt, ['checkout', '--theirs', '--', rel]).ok) { left.push(rel); continue; }
    } else if (MANIFESTS.includes(base)) {
      const sides = [1, 2, 3].map(n => stage(n, rel));
      const merged = sides.every(s => s.ok) ? mergeManifest(sides[0]!.out, sides[1]!.out, sides[2]!.out) : null;
      if (merged === null) { left.push(rel); continue; }
      fs.writeFileSync(path.join(wt, rel), merged);
    } else { left.push(rel); continue; }
    git(wt, ['add', '--', rel]);
  }
  return left;
}

/** Three-way merge of a JSON manifest with every side's release version set to theirs'; null when anything else conflicts. */
export function mergeManifest(base: string, ours: string, theirs: string): string | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-merge-'));
  try {
    const want = JSON.parse(theirs);
    const pin = (text: string) => {
      const o = JSON.parse(text);
      if ('version' in o) o.version = want.version;
      if (o.packages?.[''] && want.packages?.['']) o.packages[''].version = want.packages[''].version;
      const indent = /^\{\n( +|\t)/.exec(text)?.[1] ?? 2;
      return JSON.stringify(o, null, indent) + '\n';
    };
    const [b, o, t] = [base, ours, theirs].map((text, i) => { const f = path.join(tmp, String(i)); fs.writeFileSync(f, pin(text)); return f; });
    const m = spawnSync('git', ['merge-file', '-p', o!, b!, t!], { encoding: 'utf8', timeout: 30_000 });
    return m.status === 0 ? m.stdout : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A legacy per-PR stamp (a claim-at-open repo): the pin moved VERSION past its merge base and headed its
 * own entry with that version. Before the merge, put the pin's release fields back to the merge base's
 * values and re-head that entry `[Unreleased]`, committed in the scratch worktree, so the base merge
 * meets an unstamped change and the restamp allocates the version. Returns a note, or null.
 */
function unstampLegacy(wt: string, policy: ShipPolicy, versionRel: string, mergeBase: string): string | QueueFailure | null {
  const mb = versionAtRef(wt, mergeBase);
  const own = versionAtRef(wt, 'HEAD');
  if (!('version' in mb) || !('version' in own) || mb.version === own.version) return null;
  const link = [versionRel, ...MANIFESTS, ...(policy.changelog ? [policy.changelog] : [])].map(rel => linkedSegment(wt, rel)).find(Boolean);
  if (link) return { code: 'QUEUE_LAND_CONFLICT', message: `${link} is a symlink at the pin; land rewrites release fields only inside the repository` };
  const touched = MANIFESTS.includes(path.basename(versionRel)) ? [] : [versionRel];
  if (touched.length) fs.writeFileSync(path.join(wt, versionRel), git(wt, ['show', `${mergeBase}:${versionRel}`]).out + '\n');
  for (const rel of MANIFESTS) {
    const before = git(wt, ['show', `${mergeBase}:${rel}`]);
    if (!before.ok || !fs.existsSync(path.join(wt, rel))) continue;
    const text = fs.readFileSync(path.join(wt, rel), 'utf8');
    const b = JSON.parse(before.out); const cur = JSON.parse(text);
    if ('version' in cur) cur.version = b.version;
    if (cur.packages?.[''] && b.packages?.['']) cur.packages[''].version = b.packages[''].version;
    fs.writeFileSync(path.join(wt, rel), JSON.stringify(cur, null, /^\{\n( +|\t)/.exec(text)?.[1] ?? 2) + '\n');
    touched.push(rel);
  }
  const cl = policy.changelog;
  if (cl && fs.existsSync(path.join(wt, cl))) {
    const text = fs.readFileSync(path.join(wt, cl), 'utf8');
    const baseKeys = new Set(parseChangelog(git(wt, ['show', `${mergeBase}:${cl}`]).out).sections.map(s => s.version));
    const parsed = parseChangelog(text);
    const mine = parsed.sections.find(s => s.version === own.version && !baseKeys.has(s.version));
    if (mine && !parsed.sections.some(s => s.unreleased)) {
      const lines = text.split('\n'); lines[mine.start] = '## [Unreleased]';
      fs.writeFileSync(path.join(wt, cl), lines.join('\n'));
      touched.push(cl);
    }
  }
  git(wt, ['add', '--', ...touched]);
  git(wt, ['commit', '-q', '--no-verify', '-m', `land: put the legacy stamp ${own.version} back to ${mb.version} before the base merge`]);
  return `legacy: the pin stamped ${own.version} itself; its release fields go back to ${mb.version} and its entry is re-headed [Unreleased] before the merge`;
}

/**
 * Merge the pin with origin/<base> in a scratch worktree, resolve release conflicts, give a PR with
 * no entry a title-derived fragment, and stamp with gstack-restamp. Returns the stamped tree.
 */
function buildStamp(ctx: QueueContext, policy: ShipPolicy, o: { pin: string; baseSha: string; pr: string; title: string; allowRepoCommands: boolean; now: Date }): { tree: string; version: string; lines: string[] } | QueueFailure {
  const root = ctx.repoRoot;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-'));
  fs.rmSync(wt, { recursive: true, force: true });
  if (!git(root, ['worktree', 'add', '--detach', '-q', wt, o.pin]).ok) return { code: 'QUEUE_LAND_CONFLICT', message: `cannot create a worktree at the pin ${o.pin.slice(0, 12)}` };
  try {
    const lines: string[] = [];
    const at = versionAtRef(root, o.baseSha);
    const versionRel = 'rel' in at ? at.rel : 'VERSION';
    const legacy = unstampLegacy(wt, policy, versionRel, git(root, ['merge-base', o.pin, o.baseSha]).out);
    if (legacy && typeof legacy !== 'string') return legacy;
    if (legacy) lines.push(legacy);
    const merge = git(wt, ['merge', '--no-ff', '--no-commit', '-q', o.baseSha]);
    if (!merge.ok) {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
      if (!conflicts.length) return { code: 'QUEUE_LAND_CONFLICT', message: `git merge failed: ${merge.err.split('\n')[0]}` };
      const left = resolveReleaseConflicts(wt, conflicts, policy, versionRel);
      if (left.length) return { code: 'QUEUE_LAND_CONFLICT', message: `#${o.pr} conflicts with origin/${ctx.base} in ${left.join(', ')}` };
      lines.push(`resolved: ${conflicts.join(', ')} (release fields only)`);
    }
    const dir = policy.changelog_fragments?.dir;
    if (dir && policy.changelog) {
      const own = readFragments(wt, null, dir, o.baseSha, policy.changelog);
      const cl = fs.existsSync(path.join(wt, policy.changelog)) ? fs.readFileSync(path.join(wt, policy.changelog), 'utf8') : '';
      if (!own.errors.length && !own.fragments.length && !parseChangelog(cl).sections.some(s => s.unreleased)) {
        const rel = `${dir.replace(/\/+$/, '')}/land-${fragmentSlug(o.pr)}.md`;
        const link = linkedSegment(wt, rel);
        if (link) return { code: 'CHANGELOG_FRAGMENT_INVALID', message: `${link} is a symlink at the pin; land writes a fragment only inside the repository` };
        fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
        fs.writeFileSync(path.join(wt, rel), `- ${o.title.replace(/\s+/g, ' ').trim()} (#${o.pr})\n`);
        git(wt, ['add', '--', rel]);
        lines.push(`entry: none in the PR, so land wrote ${rel} from the title`);
      }
    }
    if (!git(wt, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `land #${o.pr}: merge origin/${ctx.base}`]).ok) return { code: 'QUEUE_LAND_CONFLICT', message: 'cannot commit the merge in the scratch worktree' };
    const linked = linkedReleaseFile(wt, policy, versionRel);
    if (linked) return { code: 'QUEUE_LAND_CONFLICT', message: `${linked} is a symlink in the merged tree; the merge step writes release files only inside the repository` };
    const r = restamp({ repoRoot: wt, base: ctx.base, next: true, policyFrom: 'base', allowRepoCommands: o.allowRepoCommands, dryRun: false, now: o.now, env: process.env });
    if (r.status !== 'stamped' && r.status !== 'noop') return { code: r.code ?? 'QUEUE_LAND_CONFLICT', message: `restamp ${r.status}: ${r.message ?? ''}`, fix: r.fix };
    lines.push(...r.stages.filter(s => s.status !== 'pending').map(s => `stage ${s.name}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`));
    git(wt, ['add', '-A']);
    const tree = git(wt, ['write-tree']).out;
    if (!isSha(tree)) return { code: 'QUEUE_LAND_CONFLICT', message: 'cannot write the stamped tree in the scratch worktree' };
    return { tree, version: r.newVersion!, lines };
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

interface PrInfo { state: string; baseRefName?: string; headRefName: string; headRefOid: string; isCrossRepository: boolean; body: string; title: string }
function prInfo(ctx: QueueContext, pr: string): PrInfo | QueueFailure {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'state,baseRefName,headRefName,headRefOid,isCrossRepository,body,title']);
  try { return JSON.parse(r.out) as PrInfo; } catch { return { code: 'QUEUE_NOT_READY', message: `gh pr view ${pr} failed: ${(r.err ?? r.out).trim().slice(0, 160)}` }; }
}

/** Poll the stamp commit's checks (the same read as the pin's) until they are green, one is red, or the time runs out. */
export function waitChecks(ctx: QueueContext, sha: string, minutes: number): void {
  const deadline = Date.now() + minutes * 60_000;
  for (let ci = ciAtHead(ctx, sha); !ci.green && !ci.line.startsWith('red') && Date.now() < deadline; ci = ciAtHead(ctx, sha)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
}

/** A head that is land's own stamp commit ([pin, base], `(land)` subject for this PR): its pin, when the local journal is gone. */
function stampPin(root: string, branch: string, head: string, pr: string): string | null {
  git(root, ['fetch', '-q', 'origin', `refs/heads/${branch}`]);
  const [parents = '', subject = ''] = git(root, ['log', '-1', '--format=%P%n%s', head]).out.split('\n');
  const p = parents.split(' ').filter(Boolean);
  return p.length === 2 && subject.endsWith(` into #${pr} (land)`) ? p[0]! : null;
}

/** `land --census`: what land would do with each open PR before a repository turns fragments on. Reads only. */
export function census(ctx: QueueContext): StepOutput {
  const root = ctx.repoRoot;
  const loaded = loadBasePolicy(ctx);
  if ('message' in loaded) return fail([], loaded, 'none');
  const policy = loaded.policy;
  git(root, ['fetch', '-q', 'origin', ctx.base]);
  const baseSha = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
  const list = ctx.gh(['pr', 'list', '--state', 'open', '--base', ctx.base, '--limit', '200', '--json', 'number,headRefOid,isCrossRepository']);
  let prs: Array<{ number: number; headRefOid: string; isCrossRepository: boolean }> = [];
  try { prs = JSON.parse(list.out); } catch { return fail([], { code: 'QUEUE_NOT_READY', message: 'gh pr list failed' }, 'none'); }
  const at = versionAtRef(root, baseSha);
  const versionRel = 'rel' in at ? at.rel : 'VERSION';
  const lines = [`CENSUS: ${prs.length} open PR(s) against origin/${ctx.base}@${baseSha.slice(0, 12)} (fragments: ${policy.changelog_fragments ? policy.changelog_fragments.dir : 'off'})`];
  const heads = prs.filter(p => !p.isCrossRepository).map(p => `refs/pull/${p.number}/head`);
  if (heads.length && !git(root, ['fetch', '-q', 'origin', ...heads]).ok) for (const h of heads) git(root, ['fetch', '-q', 'origin', h]);
  for (const p of prs.sort((a, b) => a.number - b.number)) {
    if (p.isCrossRepository) { lines.push(`#${p.number} fork: refused (QUEUE_TRAIN_UNTRUSTED)`); continue; }
    const head = p.headRefOid;
    const mt = git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, head]);
    const conflicts = mt.ok ? [] : mt.out.split('\n').slice(1).filter(Boolean);
    const product = conflicts.filter(c => c !== policy.changelog && c !== versionRel && !matchesAny(policy.release_outputs, c) && !['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(path.basename(c)));
    const frags = policy.changelog_fragments ? readFragments(root, head, policy.changelog_fragments.dir, baseSha, policy.changelog) : { fragments: [], errors: [] };
    const cl = policy.changelog ? git(root, ['show', `${head}:${policy.changelog}`]).out : '';
    const legacy = parseChangelog(cl).sections.some(s => s.unreleased);
    const hv = versionAtRef(root, head);
    const bumped = 'version' in hv && 'version' in at && hv.version !== at.version;
    const entry = frags.errors.length ? `invalid fragment ${frags.errors[0]!.path}` : frags.fragments.length ? `fold ${frags.fragments.map(f => path.basename(f.path)).join(', ')}` : legacy ? 're-head legacy [Unreleased]' : 'no entry (land writes one from the title)';
    lines.push(`#${p.number} ${head.slice(0, 12)}: ${product.length ? `refuse (product conflict: ${product.join(', ')})` : entry}${bumped ? `; rewrite its tentative ${'version' in hv ? hv.version : ''} through restamp` : ''}${conflicts.length && !product.length ? `; resolve ${conflicts.join(', ')} (release fields only)` : ''}`);
  }
  return { ok: true, run: 'none', lines };
}

/**
 * `land --repair --pr <n>` after QUEUE_LAND_DRIFT: a merge outside land slipped in beside #n, so what it
 * brought has no release of its own. Open a PR from the base whose only change is a fragment for it: each
 * fragment the outside merge left unfolded on the base moves to repair-<n>-<name>.md (so it counts as new),
 * or, with none, one entry naming the outside commits. That PR goes through /ship and land like any other;
 * its land takes over #n's drift lock and releases it.
 */
function repair(ctx: QueueContext, policy: ShipPolicy, j: LandJournal | null, file: string, run: string): StepOutput {
  const root = ctx.repoRoot;
  if (!j || j.phase !== 'drift' || !j.drift_main || !j.base_sha) return fail([], { code: 'QUEUE_NOT_READY', message: `#${j?.pr ?? '?'} has no drift record; --repair runs only after QUEUE_LAND_DRIFT` }, run);
  const lines = [`REPAIR: #${j.pr} landed on ${j.drift_main.slice(0, 12)} beside a merge outside land`];
  if (j.repair_pr) return { ok: true, run, lines: [...lines, `REPAIR_PR: #${j.repair_pr} (already open)`, `NEXT: run /ship on #${j.repair_pr}, then gstack-ship-queue land --pr ${j.repair_pr}`] };
  const dir = policy.changelog_fragments?.dir?.replace(/\/+$/, '');
  if (!dir) return fail(lines, { code: 'QUEUE_NOT_READY', message: 'changelog_fragments is off: write the [Unreleased] entry for the outside merge by hand and land it' }, run);
  git(root, ['fetch', '-q', 'origin', ctx.base]);
  const main = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
  const outside = git(root, ['log', '--first-parent', '--format=%h %s', `${j.base_sha}..${j.drift_main}^1`]).out.split('\n').filter(Boolean);
  const stray = readFragments(root, main, dir, null);
  const branch = `gstack-land-repair/${j.pr}`;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-repair-'));
  fs.rmSync(wt, { recursive: true, force: true });
  if (!git(root, ['worktree', 'add', '--detach', '-q', wt, main]).ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot create a worktree at ${main.slice(0, 12)}` }, run);
  try {
    for (const f of stray.fragments) {
      fs.renameSync(path.join(wt, f.path), path.join(wt, dir, `repair-${j.pr}-${path.basename(f.path)}`));
      lines.push(`moved: ${f.path} (left unfolded by the outside merge)`);
    }
    if (!stray.fragments.length) {
      fs.mkdirSync(path.join(wt, dir), { recursive: true });
      fs.writeFileSync(path.join(wt, dir, `repair-${j.pr}.md`), `- Changes merged outside land beside #${j.pr}: ${outside.map(c => c.slice(c.indexOf(' ') + 1)).join('; ') || 'unknown'}\n`);
      lines.push(`entry: ${dir}/repair-${j.pr}.md names ${outside.length} outside commit(s)`);
    }
    git(wt, ['add', '-A', '--', dir]);
    if (!git(wt, ['commit', '-q', '--no-verify', '-m', `land: release entry for the merge outside land beside #${j.pr}`]).ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: 'cannot commit the repair' }, run);
    const head = git(wt, ['rev-parse', 'HEAD']).out;
    const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${head}:refs/heads/${branch}`]);
    let pushed = head;
    if (!push.ok) {
      git(root, ['fetch', '-q', 'origin', `refs/heads/${branch}`]);
      const remote = git(root, ['log', '-1', '--format=%H%n%s', 'FETCH_HEAD']).out.split('\n');
      if (!isSha(remote[0]) || remote[1] !== `land: release entry for the merge outside land beside #${j.pr}`) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `cannot push ${branch}, and origin holds no repair commit there: ${push.err.split('\n')[0]}` }, run);
      pushed = remote[0]!;
      lines.push(`branch: ${branch} already on origin at ${pushed.slice(0, 12)} (an earlier --repair pushed it); opening or finding its PR`);
    }
    const pr = ctx.gh(['pr', 'create', '--base', ctx.base, '--head', branch, '--title', `Release entry for the merge outside land beside #${j.pr}`, '--body', `QUEUE_LAND_DRIFT repair (docs/troubleshooting.md#queue-land-drift). Outside commits: ${outside.join(', ') || 'unknown'}.`]);
    const n = /\/pull\/(\d+)/.exec(`${pr.out}\n${pr.err ?? ''}`)?.[1];
    if (!n) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr create failed: ${(pr.err ?? pr.out).trim().slice(0, 160)}` }, run);
    j.repair_pr = n; writeJsonAtomic(file, j);
    const held = readLock(root);
    if (held.lock?.pr === j.pr && held.lock.phase === 'drift') writeLock(root, held.sha, { ...held.lock, repair_pr: n });
    return { ok: true, run, lines: [...lines, `REPAIR_PR: #${n} ${branch} ${pushed}`, `NEXT: run /ship on #${n}, then gstack-ship-queue land --pr ${n} (it takes over #${j.pr}'s drift lock and releases it)`] };
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

/** `gstack-ship-queue land --pr <n>`: one resumable pass of the merge step. */
export function land(ctx: QueueContext, o: LandOptions): StepOutput {
  const root = ctx.repoRoot;
  const run = landJournalRel(o.pr);
  const file = path.join(root, run);
  const now = o.now ?? (() => new Date());
  const holder = o.holder ?? `${os.hostname()}:${process.pid}`;
  const loaded = loadBasePolicy(ctx);
  if ('message' in loaded) return fail([], loaded, run);
  const policy = loaded.policy;
  if (o.repair) return repair(ctx, policy, readJson<LandJournal>(file), file, run);
  const info = prInfo(ctx, o.pr);
  if ('code' in info) return fail([], info, run);
  if (info.isCrossRepository) return fail([], { code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; land stamps and pushes only crew branches` }, run);
  let j = readJson<LandJournal>(file);
  const mergedResume = info.state === 'MERGED' && !!j && ['pushed', 'merged', 'landed'].includes(j.phase) && j.stamp_commit === info.headRefOid;
  if (info.state !== 'OPEN' && !mergedResume) return fail([], { code: 'QUEUE_NOT_READY', message: `#${o.pr} is ${info.state}` }, run);
  if (info.baseRefName && info.baseRefName !== ctx.base) return fail([], { code: 'QUEUE_NOT_READY', message: `#${o.pr} targets ${info.baseRefName}, not ${ctx.base}; land merges only PRs on the base it stamps (retarget it, or land its parent first)` }, run);
  if (j && !mergedResume && (j.phase === 'landed' || ![j.reviewed_pin, j.last_pushed_head, j.stamp_commit].includes(info.headRefOid))) j = null;
  if (j && mergedResume) j.phase = 'merged';
  const recovered = j ? null : stampPin(root, info.headRefName, info.headRefOid, o.pr);
  const pin = j?.reviewed_pin ?? recovered ?? info.headRefOid;
  const lines = [`LAND: #${o.pr} branch=${info.headRefName} pin=${pin}${j ? ` (resuming at ${j.phase})` : recovered ? ` (the head ${info.headRefOid.slice(0, 12)} is land's stamp commit; restamping from its pin)` : ''}`];
  git(root, ['fetch', '-q', 'origin', ctx.base]);
  const receipt = bindShippedReceipt(root, `origin/${ctx.base}`, info.body ?? '', o.pr, [pin]);
  lines.push(receipt.line, ...(receipt.depthLine ? [receipt.depthLine] : []));
  if (!receipt.ok) return fail(lines, { code: receipt.code, message: receipt.message, fix: 'run /ship at the pinned head first' }, run);
  if (!policy.changelog_fragments) return fail(lines, { code: 'QUEUE_NOT_READY', message: 'the base policy has changelog_fragments off; land merges only under the key, where ready records the READY receipt it checks' }, run);
  const keys = repoIdentity(root).keys;
  if (!loadReady(keys, o.pr, pin)) rebuildFromNotes(root, ctx.remote ?? 'origin');
  if (!loadReady(keys, o.pr, pin)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `no READY receipt for #${o.pr} at the pin ${pin.slice(0, 12)}; ready checks the pregate and full_e2e evidence land merges on`, fix: `run gstack-ship-queue ready --pr ${o.pr}` }, run);
  if (!j) {
    const ci = ciAtHead(ctx, pin);
    lines.push(`CI: ${ci.line}`);
    if (!ci.green) return fail(lines, { code: 'QUEUE_NOT_READY', message: `required checks are not green at the pin ${pin.slice(0, 12)}` }, run);
  }
  if (o.dryRun) {
    git(root, ['fetch', '-q', 'origin', ctx.base]);
    const s = buildStamp(ctx, policy, { pin, baseSha: git(root, ['rev-parse', `origin/${ctx.base}`]).out, pr: o.pr, title: info.title, allowRepoCommands: !!o.allowRepoCommands, now: now() });
    if ('code' in s) return fail(lines, s, run);
    return { ok: true, run, lines: [...lines, ...s.lines, `STAMP_VERSION: ${s.version}`, `STAMP_TREE: ${s.tree}`, 'DRY-RUN: nothing locked, pushed or merged'] };
  }

  let { sha: lockSha, lock } = readLock(root);
  const drifted = lock && lock.pr !== o.pr && lock.phase === 'drift' ? lock.pr : null;
  const repairOf = drifted ? readJson<LandJournal>(path.join(root, landJournalRel(drifted))) : null;
  const driftOf = drifted && (lock!.repair_pr === o.pr || repairOf?.repair_pr === o.pr) ? drifted : lock?.pr === o.pr ? lock.drift_of : undefined;
  if (drifted && driftOf) lines.push(`LOCK: taking over #${drifted}'s drift lock for its repair`);
  else if (lock && lock.pr !== o.pr) {
    const age = now().getTime() - Date.parse(lock.phase_at ?? lock.started_at);
    if (!o.breakLock) return fail(lines, { code: 'QUEUE_LAND_LOCKED', message: `#${lock.pr} holds the land lock (${lock.holder}, phase ${lock.phase}, since ${lock.started_at})` }, run);
    if (lock.phase === 'drift' || lock.drift_of) return fail(lines, { code: 'QUEUE_LAND_DRIFT', message: `#${lock.drift_of ?? lock.pr} holds a drift lock; --break-lock never breaks it, only its repair PR's land takes it over`, fix: `gstack-ship-queue land --pr ${lock.drift_of ?? lock.pr} --repair` }, run);
    if ((lock.phase === 'pushing' || lock.phase === 'merging') && age < PUSH_STALE_MS) return fail(lines, { code: 'QUEUE_LAND_LOCKED', message: `#${lock.pr}'s holder is mid-${lock.phase === 'pushing' ? 'push' : 'merge'} (${Math.round(age / 1000)} s ago); --break-lock refused` }, run);
    lines.push(`LOCK: broke #${lock.pr}'s lock (${lock.holder}, phase ${lock.phase})`);
  }
  const setLock = (phase: LandLock['phase']): QueueFailure | null => {
    const next: LandLock = { pr: o.pr, holder, started_at: lock?.pr === o.pr ? lock.started_at : now().toISOString(), phase, journal: run, phase_at: now().toISOString(), ...(driftOf ? { drift_of: driftOf } : {}) };
    const w = writeLock(root, lockSha, next);
    if (!w.ok) return { code: 'QUEUE_LAND_LOCKED', message: 'the land lock moved under this run (another lander took it)' };
    lockSha = w.sha; lock = next;
    return null;
  };
  const save = () => writeJsonAtomic(file, j);
  const failed = setLock(j?.phase === 'pushed' ? 'waiting' : j?.phase === 'merged' ? 'merging' : 'stamping');
  if (failed) return fail(lines, failed, run);
  if (!j) { j = { schema_version: 1, pr: o.pr, branch: info.headRefName, reviewed_pin: pin, last_pushed_head: recovered ? info.headRefOid : null, stamp_commit: null, stamp_tree: null, base_sha: null, version: null, date: null, restamps: 0, phase: 'locked' }; save(); }

  for (;;) {
    git(root, ['fetch', '-q', 'origin', ctx.base]);
    const baseNow = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
    if (j.phase === 'pushed' && j.base_sha !== baseNow) {
      if (j.restamps >= MAX_RESTAMPS) {
        j.restamps = 0; save();
        if (!driftOf) writeLock(root, lockSha, { released: true, by: holder, at: now().toISOString() });
        return fail(lines, { code: 'QUEUE_LAND_BASE_BUSY', message: `origin/${ctx.base} moved during CI ${MAX_RESTAMPS + 1} times; the lock is released and a later run restamps from the pin` }, run);
      }
      lines.push(`BASE_MOVED: ${j.base_sha?.slice(0, 12)} -> ${baseNow.slice(0, 12)}; restamping`);
      j.restamps += 1; j.phase = 'locked'; save();
    }
    if (j.phase === 'locked') {
      const s = buildStamp(ctx, policy, { pin, baseSha: baseNow, pr: o.pr, title: info.title, allowRepoCommands: !!o.allowRepoCommands, now: j.date ? new Date(`${j.date}T12:00:00Z`) : now() });
      if ('code' in s) {
        if (driftOf) setLock('stamping');
        else writeLock(root, lockSha, { released: true, by: holder, at: now().toISOString() });
        return fail([...lines], s, run);
      }
      lines.push(...s.lines);
      const commit = git(root, ['commit-tree', s.tree, '-p', pin, '-p', baseNow, '-m', `v${s.version} stamp: merge ${ctx.base} ${baseNow.slice(0, 12)} into #${o.pr} (land)`]).out;
      if (!isSha(commit)) return fail(lines, { code: 'QUEUE_LAND_CONFLICT', message: 'cannot create the stamp commit; nothing pushed' }, run);
      Object.assign(j, { stamp_commit: commit, stamp_tree: s.tree, base_sha: baseNow, version: s.version, date: j.date ?? now().toISOString().slice(0, 10), phase: 'stamped' });
      save();
      lines.push(`STAMP_VERSION: ${s.version}`, `STAMP_COMMIT: ${commit} tree=${s.tree}`);
    }
    if (j.phase === 'stamped') {
      const lease = j.last_pushed_head ?? pin;
      const f = setLock('pushing');
      if (f) return fail(lines, f, run);
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${j.branch}:${lease}`, 'origin', `${j.stamp_commit}:refs/heads/${j.branch}`]);
      if (!push.ok) {
        const remote = git(root, ['ls-remote', 'origin', `refs/heads/${j.branch}`]).out.split('\t')[0];
        if (remote !== j.stamp_commit) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `#${o.pr}'s branch is at ${remote?.slice(0, 12) || 'unknown'}, not ${lease.slice(0, 12)}: someone else pushed; land never overwrites it` }, run);
      }
      j.last_pushed_head = j.stamp_commit; j.phase = 'pushed'; save();
      const fw = setLock('waiting');
      if (fw) return fail(lines, fw, run);
      lines.push(`PUSHED: ${j.stamp_commit} to ${j.branch} (lease ${lease.slice(0, 12)})`);
      if (o.noWait) return { ok: true, run, lines: [...lines, `NEXT: gstack-pr-wait ${o.pr} --until green && gstack-ship-queue land --pr ${o.pr}`] };
      waitChecks(ctx, j.stamp_commit!, o.waitTimeoutMin ?? 60);
      continue;
    }
    if (j.phase === 'pushed') {
      const head = git(root, ['ls-remote', 'origin', `refs/heads/${j.branch}`]).out.split('\t')[0] ?? '';
      if (head !== j.stamp_commit) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `#${o.pr}'s head is ${head.slice(0, 12) || 'unknown'}, not the stamp commit ${j.stamp_commit?.slice(0, 12)}` }, run);
      const ci = ciAtHead(ctx, j.stamp_commit!);
      lines.push(`CI: ${ci.line}`);
      if (!ci.green) return { ok: !ci.line.startsWith('red'), run, lines: [...lines, `NEXT: gstack-pr-wait ${o.pr} --until green && gstack-ship-queue land --pr ${o.pr}`], failure: ci.line.startsWith('red') ? { code: 'QUEUE_NOT_READY', message: `a check failed on the stamp commit ${j.stamp_commit!.slice(0, 12)}` } : undefined };
      const fm = setLock('merging');
      if (fm) return fail(lines, fm, run);
      const m = ctx.gh(['pr', 'merge', o.pr, policy.history === 'merge-only' ? '--merge' : '--squash', '--match-head-commit', j.stamp_commit!]);
      if (!m.ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200)}` }, run);
      j.phase = 'merged'; save();
    }
    if (j.phase === 'merged') {
      git(root, ['fetch', '-q', 'origin', ctx.base]);
      const tip = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
      const main = git(root, ['rev-list', '--first-parent', '--reverse', `${j.base_sha}..${tip}`]).out.split('\n')[0] || tip;
      const tree = git(root, ['rev-parse', `${main}^{tree}`]).out;
      const parent = git(root, ['rev-parse', `${main}^1`]).out;
      if (tree !== j.stamp_tree || parent !== j.base_sha) {
        j.phase = 'drift'; j.drift_main = tip; save(); setLock('drift');
        return fail([...lines, `MAIN: ${tip} first=${main} tree=${tree} parent=${parent}`], { code: 'QUEUE_LAND_DRIFT', message: `origin/${ctx.base} ${main.slice(0, 12)} is not the stamped tree on ${j.base_sha?.slice(0, 12)} (a merge outside land slipped in)`, fix: `gstack-ship-queue land --pr ${o.pr} --repair opens the PR that gives the outside merge its own release; /ship and land it, which releases the lock` }, run);
      }
      j.phase = 'landed'; save();
      const driftJournal = driftOf ? readJson<LandJournal>(path.join(root, landJournalRel(driftOf))) : null;
      if (driftOf && driftJournal) writeJsonAtomic(path.join(root, landJournalRel(driftOf)), { ...driftJournal, phase: 'landed' });
      const rel = writeLock(root, lockSha, { released: true, by: holder, at: now().toISOString() });
      return { ok: true, run, lines: [...lines, `MERGED: #${o.pr} as ${main} (${j.version})`, `LANDED: origin/${ctx.base} tree ${tree} equals the stamped tree`, `LOCK: ${rel.ok ? 'released' : 'release push failed (the next land takes it over)'}`] };
    }
    if (j.phase === 'drift') return fail(lines, { code: 'QUEUE_LAND_DRIFT', message: 'a previous land of this PR found drift', fix: `gstack-ship-queue land --pr ${o.pr} --repair` }, run);
  }
}
