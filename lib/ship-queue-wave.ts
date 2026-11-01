/**
 * Wave PRs for merge trains (docs/ship-policy.md#wave-prs; Garry's R46, GST-574):
 * when the queue is long, 3-6 PRs of one functional area travel as one wave PR
 * that takes one train slot, one /ship, one READY and one version.
 *
 *   wave plan     read-only (git merge-tree leaves only unreferenced objects): live READY PRs with green
 *                 CI, WAVE_ADVISED over the trigger, suggested area groups
 *   wave build    the integrator branch wave/<nonce>: main plus each constituent's pinned head merged
 *                 unchanged with the train's merge rules (a merge commit whose second parent is the
 *                 pin); a conflict stops in a worktree under the state root (--continue resumes);
 *                 --drop rebuilds without one constituent as a new wave (never a force-push)
 *   wave status   the wave's record, its branch chain and each constituent's GitHub head
 *   wave settle   after the wave PR merged: close each constituent whose head is still its pin with a
 *                 link to the wave and version; a moved constituent stays open with a comment
 *
 * The wave record (kind 'wave', lib/ship-queue-train-record.ts) is written locally and to
 * refs/notes/gstack-trains before the branch push, so ready and train build on any machine
 * check the same pins (checkWavePin). Constituent heads freeze once in: a moved head refuses
 * the wave (QUEUE_WAVE_MOVED) and fixes go on the wave branch as integrator commits.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, formatResult } from './headless-artifacts';
import { RESULT_CODES } from './result-codes';
import { versionAtRef } from './restamp';
import { globToRegExp, type ShipPolicy } from './ship-policy';
import { ciAtHead, type QueueContext } from './ship-queue';
import { git, sha256, type QueueFailure } from './ship-queue-gate';
import { fetchBase, mergeCommit, mergeStep, outFailed, outOk, outRefused, parsePins, trainEnv, type TrainEnv, type TrainOut } from './ship-queue-train';
import { prInfo, type PrInfo } from './ship-queue-train-github';
import { listWaves, loadWave, nowIso, persist, queueRoot, rebuildFromNotes, redactCause, wavePath, type ReadyReceipt, type WaveRecord } from './ship-queue-train-record';

export const WAVE_TRIGGER = 6;
export const WAVE_MIN = 3;
export const WAVE_MAX = 6;
const Q = 'gstack-ship-queue';
const LIVE = new Set(['conflict', 'built', 'pushed']);
const marker = (nonce: string, kind: string) => `<!-- gstack-wave:${nonce}:${kind} -->`;
const short = (sha: string) => sha.slice(0, 12);
const pinsOf = (w: WaveRecord) => w.constituents.map(c => `#${c.pr}@${short(c.head)}`).join(',');
const fail = (code: QueueFailure['code'], message: string): QueueFailure => ({ code, message });

/** Files that never decide an area or a conflict: version files, the CHANGELOG, fragments and release outputs. */
export function isReleasePath(file: string, policy: ShipPolicy): boolean {
  if (file === policy.changelog || file === 'VERSION' || file === 'package.json') return true;
  if (policy.changelog_fragments && file.startsWith(policy.changelog_fragments.dir + '/')) return true;
  return policy.release_outputs.some(glob => globToRegExp(glob).test(file));
}

/**
 * A file's functional area: the skill directory for files in a skill, the subdirectory for
 * lib/<dir>/…, the first word of the module name for lib, bin, test and scripts files
 * (lib/ship-queue-train.ts and test/ship-receipt.test.ts are both "ship"), docs for docs/**.
 */
export function areaKey(file: string, isSkillDir: (dir: string) => boolean): string {
  const parts = file.split('/');
  const top = parts[0]!;
  if (parts.length > 1 && isSkillDir(top)) return top;
  if (top === 'docs') return 'docs';
  if (['lib', 'bin', 'test', 'scripts'].includes(top) && parts.length > 1) {
    const inner = parts.slice(1).filter(p => p !== 'helpers' && p !== 'fixtures');
    if (inner.length > 1) return inner[0]!;
    const name = (inner[0] ?? top).replace(/^gstack-/, '').replace(/(\.test)?\.[a-z]+$/, '');
    return name.split(/[-_.]/)[0] || top;
  }
  return parts.length > 1 ? top : 'root';
}

/** renamed maps a path the PR renamed to its new path; files lists both. */
export interface PlanPr { pr: string; head: string; files: string[]; lines: number; renamed?: Record<string, string> }
export interface WaveGroup { area: string; prs: PlanPr[]; integrator: string }

/** The most common area across files, ties broken by name; 'misc' with no files. */
export function dominantArea(files: string[], areaOf: (f: string) => string): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(areaOf(f), (counts.get(areaOf(f)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'misc';
}

const largestFirst = (a: PlanPr, b: PlanPr) => b.lines - a.lines || Number(a.pr) - Number(b.pr);

/**
 * Hub files: prose (docs/**, Markdown, generated SKILL.md renders) and JSON ledgers and registries.
 * Most PRs append to them, so their conflicts are kept-both-sides edits that any train slot
 * resolves; linking PRs through them chained a 55-PR queue into one area (GST-770). They never
 * link PRs into a wave. Skill templates (.md.tmpl) are source and link on a real conflict.
 */
export const isHubFile = (file: string) => file.startsWith('docs/') || /\.(md|jsonl?)$/.test(file);

/**
 * Group PRs into waves: PRs whose changes to a common code file conflict always travel together
 * (one integrator resolves the conflict once); hub files never link. conflicts(a, b) names the
 * files a merge of the two heads cannot resolve, or null when unknown, which counts every shared
 * file as conflicting; a conflict at the path either PR renamed the shared file to counts as one
 * on that file. Each cluster takes its largest PR's area and is packed whole, first fit in PR
 * order, into the waves of its area of at most max; a cluster larger than max is oversize (never
 * split, so its conflicts still meet one integrator), and a wave below min rides solo. The
 * integrator is the PR with the most changed lines.
 */
export function groupWaves(prs: PlanPr[], areaOf: (f: string) => string, min = WAVE_MIN, max = WAVE_MAX, conflicts: (a: PlanPr, b: PlanPr) => string[] | null = () => null): { groups: WaveGroup[]; solo: string[]; oversize: Array<{ area: string; prs: PlanPr[] }> } {
  const sorted = [...prs].sort((a, b) => Number(a.pr) - Number(b.pr));
  const root = new Map(sorted.map(p => [p.pr, p.pr]));
  const find = (x: string): string => { const r = root.get(x)!; return r === x ? x : find(r); };
  const sharers = new Map<string, PlanPr[]>();
  for (const p of sorted) for (const f of p.files) if (!isHubFile(f)) sharers.set(f, [...(sharers.get(f) ?? []), p]);
  const clash = new Map<string, string[] | null>();
  for (const [f, list] of sharers) list.forEach((a, i) => list.slice(i + 1).forEach(b => {
    const key = `${a.pr} ${b.pr}`;
    if (!clash.has(key)) clash.set(key, conflicts(a, b));
    const hit = clash.get(key);
    const at = [f, a.renamed?.[f], b.renamed?.[f]];
    if ((!hit || at.some(p => p && hit.includes(p))) && find(a.pr) !== find(b.pr)) root.set(find(b.pr), find(a.pr));
  }));
  const clusters = new Map<string, PlanPr[]>();
  for (const p of sorted) clusters.set(find(p.pr), [...(clusters.get(find(p.pr)) ?? []), p]);
  const byArea = new Map<string, PlanPr[][]>();
  for (const c of clusters.values()) {
    const area = dominantArea([...c].sort(largestFirst)[0]!.files, areaOf);
    byArea.set(area, [...(byArea.get(area) ?? []), c]);
  }
  const groups: WaveGroup[] = [];
  const solo: string[] = [];
  const oversize: Array<{ area: string; prs: PlanPr[] }> = [];
  for (const [area, list] of [...byArea].sort((a, b) => a[0].localeCompare(b[0]))) {
    const waves: PlanPr[][] = [];
    for (const c of list) {
      if (c.length > max) { oversize.push({ area, prs: c }); continue; }
      const fit = waves.find(w => w.length + c.length <= max);
      if (fit) fit.push(...c); else waves.push([...c]);
    }
    for (const w of waves) {
      if (w.length >= min) groups.push({ area, prs: w, integrator: [...w].sort(largestFirst)[0]!.pr });
      else solo.push(...w.map(p => p.pr));
    }
  }
  return { groups, solo: solo.sort((a, b) => Number(a) - Number(b)), oversize };
}

export interface WaveChain { integrator: string[]; merges: string[]; stamps: string[] }

/**
 * Walk the wave branch's first parents from tip back to the recorded base. Every constituent
 * must appear, in order and exactly once, as the second parent of a two-parent commit; a
 * one-parent commit is an integrator commit; any other merge (an unknown head, main merged in
 * before the last constituent) is refused. With stampBase, merges of commits already on
 * stampBase (train land's stamps, or main merged in) may follow the last constituent.
 */
export function waveChain(repoRoot: string, w: WaveRecord, tip: string, stampBase: string | null = null): WaveChain | { error: string } {
  const r = git(repoRoot, ['rev-list', '--first-parent', '--parents', `${w.base.sha}..${tip}`]);
  if (!r.ok) return { error: `cannot walk ${short(tip)} back to the wave base ${short(w.base.sha)} (${r.err.slice(0, 120)})` };
  const rows = r.out.split('\n').filter(Boolean).map(l => l.split(' ')).reverse();
  if (!rows.length || rows[0]![1] !== w.base.sha) return { error: `the branch at ${short(tip)} does not start at the wave base ${short(w.base.sha)}` };
  const out: WaveChain = { integrator: [], merges: [], stamps: [] };
  let next = 0;
  for (const [commit, , second, ...more] of rows) {
    if (!second) { out.integrator.push(commit!); continue; }
    const want = w.constituents[next];
    if (!more.length && want && second === want.head) { out.merges.push(commit!); next++; continue; }
    if (!more.length && stampBase && next === w.constituents.length && git(repoRoot, ['merge-base', '--is-ancestor', second, stampBase]).ok) { out.stamps.push(commit!); continue; }
    const expected = want ? `#${want.pr}'s pin ${short(want.head)}` : 'a constituent';
    return { error: `${short(commit!)} merges ${short(second)}, which is not ${expected} (only constituent merges and integrator commits belong on a wave branch)` };
  }
  if (next < w.constituents.length) return { error: `#${w.constituents[next]!.pr}'s pin ${short(w.constituents[next]!.head)} is not merged on the branch at ${short(tip)}` };
  return out;
}

/** The conflict worktree is derived from the nonce, never read from a record another machine wrote. */
const worktreeOf = (w: WaveRecord) => path.join(queueRoot(), 'waves', `${w.nonce}-work`);
const waveByBranch = (env: TrainEnv, branch: string) => listWaves(env.repo.keys).find(w => w.branch === branch) ?? null;

function ensureCommit(env: TrainEnv, sha: string, pr: string): boolean {
  if (git(env.ctx.repoRoot, ['cat-file', '-e', `${sha}^{commit}`]).ok) return true;
  git(env.ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/pull/${pr}/head:refs/gstack/wave/pr-${pr}`]);
  return git(env.ctx.repoRoot, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/** One constituent's GitHub state against its pin: null when it is open, same-repo and unmoved. */
function constituentProblem(ctx: QueueContext, pr: string, pin: string): { failure: QueueFailure } | null {
  const info = prInfo(ctx, pr);
  if ('error' in info) return { failure: fail('QUEUE_PROOF_MISSING', info.error) };
  if (info.isCrossRepository) return { failure: fail('QUEUE_TRAIN_UNTRUSTED', `#${pr}'s head repository is not the base repository; fork work stays on the trusted-branch path`) };
  if (info.state !== 'OPEN') return { failure: fail('QUEUE_WAVE_MOVED', `#${pr} is ${info.state.toLowerCase()}; a wave carries open PRs only`) };
  if (info.baseRefName && info.baseRefName !== ctx.base) return { failure: fail('QUEUE_WAVE_MOVED', `#${pr} targets ${info.baseRefName}, not ${ctx.base}; a stacked PR would carry its parent's commits into the wave`) };
  if (info.headRefOid !== pin) return { failure: fail('QUEUE_WAVE_MOVED', `#${pr} moved: pinned ${short(pin)}, head is now ${short(info.headRefOid)}`) };
  return null;
}

/**
 * ready and train build: a PR whose head branch is wave/<nonce> must have a readable wave
 * record (refused QUEUE_WAVE_UNKNOWN otherwise, never skipped), a branch chain that merges every
 * pin unchanged, and constituents still open at their pins. Any other PR is null, unless a live
 * wave lists it as a constituent: then it is refused QUEUE_WAVE_DUPLICATE so it cannot land twice.
 */
export function checkWavePin(env: TrainEnv, pr: string, info: PrInfo): { wave: WaveRecord; lines: string[] } | { failure: QueueFailure } | null {
  if (!info.headRefName.startsWith('wave/')) {
    const holder = listWaves(env.repo.keys).find(x => LIVE.has(x.state) && x.constituents.some(c => c.pr === pr));
    return holder ? { failure: fail('QUEUE_WAVE_DUPLICATE', `#${pr} is a constituent of live wave ${holder.nonce}; it lands through the wave PR, not on its own`) } : null;
  }
  let w = waveByBranch(env, info.headRefName);
  if (!w) { rebuildFromNotes(env.ctx.repoRoot, env.remote); w = waveByBranch(env, info.headRefName); }
  if (!w) return { failure: fail('QUEUE_WAVE_UNKNOWN', `#${pr}'s branch ${info.headRefName} has no wave record in local state or refs/notes/gstack-trains`) };
  if (w.state === 'superseded') return { failure: fail('QUEUE_WAVE_MOVED', `wave ${w.nonce} was rebuilt as ${w.superseded_by}; READY the new wave PR`) };
  if (w.state === 'released') return { failure: fail('QUEUE_WAVE_MOVED', `wave ${w.nonce} was released; its PRs ride as single slots`) };
  if (!ensureCommit(env, info.headRefOid, pr)) return { failure: fail('QUEUE_PROOF_MISSING', `cannot fetch #${pr}'s head ${short(info.headRefOid)}`) };
  const chain = waveChain(env.ctx.repoRoot, w, info.headRefOid, `${env.remote}/${env.ctx.base}`);
  if ('error' in chain) return { failure: fail('QUEUE_WAVE_MOVED', `wave ${w.nonce}: ${chain.error}`) };
  for (const c of w.constituents) {
    const p = constituentProblem(env.ctx, c.pr, c.head);
    if (p) return { failure: { ...p.failure, message: `wave ${w.nonce}: ${p.failure.message}` } };
  }
  return { wave: w, lines: [
    `WAVE: ${w.nonce} area=${w.area} branch=${w.branch} constituents=${w.constituents.length} integrator_commits=${chain.integrator.length}`,
    `CONSTITUENTS: ${pinsOf(w)} (heads frozen; fixes go on the wave branch)`,
  ] };
}

function readyReceipts(env: TrainEnv): ReadyReceipt[] {
  const newest = new Map<string, ReadyReceipt>();
  for (const key of env.repo.keys) {
    const dir = path.join(queueRoot(), 'ready', key);
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as ReadyReceipt;
        if (r.kind !== 'ready') continue;
        const cur = newest.get(r.pr);
        if (!cur || r.ready_at > cur.ready_at) newest.set(r.pr, r);
      } catch {}
    }
  }
  return [...newest.values()];
}

function changed(env: TrainEnv, head: string): { files: string[]; lines: number; renamed: Record<string, string> } | null {
  const fork = git(env.ctx.repoRoot, ['merge-base', `${env.remote}/${env.ctx.base}`, head]);
  const stat = fork.ok ? git(env.ctx.repoRoot, ['diff', '--numstat', '--no-renames', fork.out, head]) : fork;
  const moves = fork.ok ? git(env.ctx.repoRoot, ['diff', '--name-status', '-z', '-M', '--diff-filter=R', fork.out, head]) : fork;
  if (!stat.ok || !moves.ok) return null;
  const renamed: Record<string, string> = {};
  const fields = moves.out.split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) if (!isReleasePath(fields[i + 1]!, env.policy.policy)) renamed[fields[i + 1]!] = fields[i + 2]!;
  let lines = 0;
  const files: string[] = [];
  for (const row of stat.out.split('\n').filter(Boolean)) {
    const [add, del, file] = row.split('\t');
    if (!file || isReleasePath(file, env.policy.policy)) continue;
    files.push(file);
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { files, lines, renamed };
}

const areaOf = (env: TrainEnv) => (f: string) => areaKey(f, dir => fs.existsSync(path.join(env.ctx.repoRoot, dir, 'SKILL.md.tmpl')));
const buildCmd = (area: string, pins: Array<{ pr: string; head: string }>) => `${Q} wave build --area ${area} --prs ${pins.map(p => `${p.pr}@${p.head}`).join(',')}`;

function setup(ctx: QueueContext): TrainEnv | TrainOut {
  const fetchErr = fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'POLICY_SOURCE_UNAVAILABLE', message: fetchErr }, [], 'none', 'none');
  rebuildFromNotes(ctx.repoRoot, env.remote);
  return env;
}

export function wavePlan(ctx: QueueContext, o: { trigger: number; min: number; max: number }): TrainOut {
  const env = setup(ctx);
  if ('exit' in env) return env;
  const inWave = new Map<string, string>();
  for (const w of listWaves(env.repo.keys)) if (LIVE.has(w.state)) for (const c of w.constituents) inWave.set(c.pr, w.nonce);
  const live: PlanPr[] = [];
  const lines: string[] = [];
  const unreadable: string[] = [];
  for (const r of readyReceipts(env).sort((a, b) => Number(a.pr) - Number(b.pr))) {
    if (inWave.has(r.pr)) { lines.push(`IN_WAVE: #${r.pr} (wave ${inWave.get(r.pr)})`); continue; }
    const info = prInfo(ctx, r.pr);
    if ('error' in info) { unreadable.push(`#${r.pr} (${info.error})`); continue; }
    if (info.state !== 'OPEN' || info.headRefOid !== r.head || info.isCrossRepository || info.headRefName.startsWith('wave/')) continue;
    const ci = ciAtHead(ctx, r.head);
    if (ci.line.startsWith('unknown')) { unreadable.push(`#${r.pr} (CI ${ci.line})`); continue; }
    if (!ci.green) { lines.push(`NOT_GREEN: #${r.pr} (${ci.line}; left out until CI is green at the READY head)`); continue; }
    if (!ensureCommit(env, r.head, r.pr)) { unreadable.push(`#${r.pr} (head ${short(r.head)} not fetchable)`); continue; }
    const onBase = mergeStep(env.ctx.repoRoot, `${env.remote}/${env.ctx.base}`, r.head, env.policy.policy);
    if ('conflicts' in onBase && onBase.conflicts.some(f => f.startsWith('('))) { unreadable.push(`#${r.pr} (merge onto ${env.ctx.base} unreadable: ${onBase.conflicts.join(', ')})`); continue; }
    if ('conflicts' in onBase) { lines.push(`NOT_MERGEABLE: #${r.pr} (conflicts with ${env.remote}/${env.ctx.base} at ${short(r.head)} in ${onBase.conflicts.join(', ')}; left out until the head merges cleanly onto ${env.ctx.base})`); continue; }
    const c = changed(env, r.head);
    if (!c) { unreadable.push(`#${r.pr} (diff unreadable)`); continue; }
    live.push({ pr: r.pr, head: r.head, ...c });
  }
  if (unreadable.length) return outFailed(fail('QUEUE_PROOF_MISSING', `cannot read ${unreadable.length} READY PR(s): ${unreadable.join('; ')}; a plan from a partial queue would mislead`), lines, `${Q} wave plan (after gh and git can read every PR)`, 'none');
  lines.push(`QUEUE: ${live.length} live READY PR(s) (open, head equal to its READY receipt, CI green there, merging cleanly onto ${env.ctx.base}); wave trigger ${o.trigger}`);
  if (live.length <= o.trigger) return outOk([...lines, `WAVE: not needed (${live.length} <= ${o.trigger}); build trains of single PRs`], `${Q} train build --prs <pins>`, 'none');
  const plan = groupWaves(live, areaOf(env), o.min, o.max, (a, b) => {
    const m = git(env.ctx.repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a.head, b.head]);
    return m.ok ? [] : m.status === 1 ? m.out.split('\n').slice(1).filter(Boolean) : null;
  });
  lines.push(`WAVE_ADVISED: ${live.length} READY PRs over the wave trigger ${o.trigger}; group by area into waves of ${o.min}-${o.max} (Garry R46)`);
  for (const g of plan.groups) {
    lines.push(`WAVE_GROUP: area=${g.area} prs=${g.prs.map(p => '#' + p.pr).join(',')} integrator=#${g.integrator} (most changed lines)`);
    lines.push(`  build: ${buildCmd(g.area, g.prs)}`);
  }
  for (const c of plan.oversize) lines.push(`WAVE_OVERSIZE: area=${c.area} prs=${c.prs.map(p => '#' + p.pr).join(',')} (${c.prs.length} PRs whose changes conflict, over the wave maximum ${o.max}; kept whole with no build command: land part of it as single slots, then run wave plan again)`);
  if (plan.solo.length) lines.push(`SOLO: ${plan.solo.map(p => '#' + p).join(',')} (no area group of ${o.min}+; they ride as single slots)`);
  const first = plan.groups[0];
  return outOk(lines, first ? `#${first.integrator}'s owner integrates: ${buildCmd(first.area, first.prs)}` : `${Q} train build --prs <pins>`, 'none');
}

export interface WaveBuildOptions { pins?: string; area?: string; wave?: string; cont?: boolean; drop?: string; release?: boolean; dryRun: boolean; min: number; max: number }

export function waveBuild(ctx: QueueContext, o: WaveBuildOptions): TrainOut {
  const env = setup(ctx);
  if ('exit' in env) return env;
  if (!o.wave) return newWave(env, o, null);
  const w = loadWave(o.wave);
  if (!w || !env.repo.keys.includes(w.repo_key)) return outRefused(fail('QUEUE_WAVE_UNKNOWN', `no wave record ${o.wave} in local state or refs/notes/gstack-trains`), [], `${Q} wave status`, 'none');
  if (o.release) return release(env, w, [], o.dryRun);
  if (o.drop) return dropFrom(env, w, o);
  if (o.cont) return continueWave(env, w, o.dryRun);
  if (w.state === 'conflict') return outRefused(fail('QUEUE_WAVE_CONFLICT', `wave ${w.nonce} is stopped at #${w.conflict!.pr}; resolve in ${w.conflict!.worktree}`), [], `${Q} wave build --wave ${w.nonce} --continue`, wavePath(w.nonce));
  if (w.state !== 'built') return outOk([`WAVE: ${w.nonce} is ${w.state}`], `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  return publish(env, w, [], o.dryRun);
}

function newWave(env: TrainEnv, o: WaveBuildOptions, supersedes: WaveRecord | null, given?: Array<{ pr: string; sha: string }>): TrainOut {
  const parsed = given ?? parsePins(o.pins);
  if (typeof parsed === 'string') return outRefused(fail('QUEUE_PROOF_MISSING', parsed), [], 'none', 'none');
  if (parsed.length < o.min || parsed.length > o.max) return outRefused(fail('QUEUE_WAVE_SIZE', `a wave carries ${o.min}-${o.max} PRs (got ${parsed.length})`), [], `${Q} wave plan`, 'none');
  const taken = new Map<string, string>();
  for (const w of listWaves(env.repo.keys)) if (LIVE.has(w.state) && w.nonce !== supersedes?.nonce) for (const c of w.constituents) taken.set(c.pr, w.nonce);
  const pins: Array<{ pr: string; head: string }> = [];
  for (const p of parsed) {
    if (taken.has(p.pr)) return outRefused(fail('QUEUE_WAVE_DUPLICATE', `#${p.pr} is already in wave ${taken.get(p.pr)}`), [], `${Q} wave status --wave ${taken.get(p.pr)}`, 'none');
    const info = prInfo(env.ctx, p.pr);
    if ('error' in info) return outRefused(fail('QUEUE_PROOF_MISSING', info.error), [], 'none', 'none');
    if (!info.headRefOid.startsWith(p.sha)) return outRefused(fail('QUEUE_WAVE_MOVED', `#${p.pr} moved: pinned ${p.sha.slice(0, 12)}, head is now ${short(info.headRefOid)}`), [], `${Q} wave build --prs <pins with #${p.pr}@${short(info.headRefOid)}>`, 'none');
    const problem = constituentProblem(env.ctx, p.pr, info.headRefOid);
    if (problem) return outRefused(problem.failure, [], 'none', 'none');
    if (info.headRefName.startsWith('wave/')) return outRefused(fail('QUEUE_WAVE_DUPLICATE', `#${p.pr} is itself a wave PR; waves do not nest`), [], 'none', 'none');
    if (!ensureCommit(env, info.headRefOid, p.pr)) return outRefused(fail('QUEUE_PROOF_MISSING', `cannot fetch #${p.pr}'s head`), [], 'none', 'none');
    pins.push({ pr: p.pr, head: info.headRefOid });
  }
  const baseSha = git(env.ctx.repoRoot, ['rev-parse', `${env.remote}/${env.ctx.base}`]).out;
  const files = pins.flatMap(p => changed(env, p.head)?.files ?? []);
  const area = (o.area ?? dominantArea(files, areaOf(env))).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'misc';
  const nonce = `${area}-${sha256(JSON.stringify({ baseSha, pins, salt: randomBytes(4).toString('hex') })).slice(0, 12)}`;
  const now = nowIso();
  const w: WaveRecord = {
    schema: 1, kind: 'wave', nonce, repo_key: env.repo.key, area, base: { ref: env.ctx.base, sha: baseSha }, branch: `wave/${nonce}`,
    constituents: pins.map(p => ({ pr: p.pr, head: p.head, merge_commit: null })), head: null, state: 'built', conflict: null,
    superseded_by: null, settled: [], effects: supersedes ? [{ at: now, what: `rebuilt from ${supersedes.nonce}` }] : [], created_at: now, updated_at: now,
  };
  const lines = [`WAVE: ${nonce} area=${area} base=${env.ctx.base}@${short(baseSha)} constituents=${pinsOf(w)}`];
  return chainFrom(env, w, 0, baseSha, lines, o.dryRun, supersedes);
}

function chainFrom(env: TrainEnv, w: WaveRecord, start: number, pred: string, lines: string[], dryRun: boolean, supersedes: WaveRecord | null): TrainOut {
  const repo = env.ctx.repoRoot;
  for (let i = start; i < w.constituents.length; i++) {
    const c = w.constituents[i]!;
    const m = mergeCommit(repo, pred, c.head, env.policy.policy, `wave ${w.nonce}: merge #${c.pr} (${short(c.head)})`);
    if ('commit' in m) { c.merge_commit = m.commit; pred = m.commit; lines.push(`MERGED: #${c.pr} at ${short(c.head)} -> ${short(m.commit)}`); continue; }
    const conflictLine = `QUEUE_WAVE_CONFLICT: #${c.pr} conflicts with the wave so far (${m.conflicts.join(', ')})`;
    if (dryRun) return outFailed(fail('QUEUE_WAVE_CONFLICT', `#${c.pr} conflicts with the wave so far`), [...lines, conflictLine, 'DRY-RUN: no record, no worktree, nothing pushed'], `build the wave without --dry-run to resolve it in a worktree, or leave #${c.pr} out`, 'none');
    const worktree = worktreeOf(w);
    fs.rmSync(worktree, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
    const add = git(repo, ['worktree', 'add', '-q', '--detach', worktree, pred]);
    if (!add.ok) return outFailed(fail('QUEUE_WAVE_CONFLICT', `#${c.pr} conflicts and the resolution worktree could not be created: ${add.err.slice(0, 160)}`), [...lines, conflictLine], 'none', 'none');
    git(worktree, ['merge', '--no-ff', '--no-commit', c.head]);
    w.state = 'conflict';
    w.conflict = { pr: c.pr, files: m.conflicts, worktree, pred };
    w.effects.push({ at: nowIso(), what: `stopped at #${c.pr}; worktree ${worktree}` });
    w.updated_at = nowIso();
    const p = persist(repo, [w], { remote: env.remote });
    if (supersedes) supersede(env, supersedes, w);
    return outFailed(fail('QUEUE_WAVE_CONFLICT', `#${c.pr} conflicts with the wave so far; nothing pushed`), [...lines, conflictLine,
      `WORKTREE: ${worktree} (merge of #${c.pr} onto ${short(pred)} in progress; record ${wavePath(w.nonce)}, ${p.detail})`],
      `resolve the conflicts in ${worktree}, git -C ${worktree} commit --no-edit, then ${Q} wave build --wave ${w.nonce} --continue`, wavePath(w.nonce));
  }
  w.head = pred;
  w.state = 'built';
  w.conflict = null;
  if (dryRun) return outOk([...lines, `WAVE_HEAD: ${short(pred)} (dry run in object storage)`, 'DRY-RUN: no record written, nothing pushed'], buildCmd(w.area, w.constituents), 'none');
  w.effects.push({ at: nowIso(), what: `built ${short(pred)}` });
  w.updated_at = nowIso();
  persist(repo, [w], { remote: env.remote });
  if (supersedes) supersede(env, supersedes, w);
  return publish(env, w, lines, false);
}

function supersede(env: TrainEnv, old: WaveRecord, w: WaveRecord): void {
  old.state = 'superseded';
  old.superseded_by = w.nonce;
  old.effects.push({ at: nowIso(), what: `superseded by ${w.nonce}` });
  old.updated_at = nowIso();
  persist(env.ctx.repoRoot, [old], { remote: env.remote });
}

function comments(ctx: QueueContext, pr: string): string[] | null {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'comments']);
  if (!r.ok) return null;
  try { return ((JSON.parse(r.out).comments ?? []) as Array<{ body?: string }>).map(c => c.body ?? ''); } catch { return null; }
}

/** Post a comment once: a body carrying the marker is never posted twice. */
function commentOnce(ctx: QueueContext, pr: string, mark: string, body: string): 'posted' | 'present' | 'failed' {
  const seen = comments(ctx, pr);
  if (seen === null) return 'failed';
  if (seen.some(b => b.includes(mark))) return 'present';
  return ctx.gh(['pr', 'comment', pr, '--body', `${body}\n\n${mark}`]).ok ? 'posted' : 'failed';
}

function publish(env: TrainEnv, w: WaveRecord, lines: string[], dryRun: boolean): TrainOut {
  const repo = env.ctx.repoRoot;
  const remote = git(repo, ['ls-remote', env.remote, `refs/heads/${w.branch}`]);
  if (!remote.ok) return outFailed(fail('QUEUE_PROOF_MISSING', `cannot read ${env.remote} refs/heads/${w.branch}: ${remote.err.slice(0, 120)}`), lines, `${Q} wave build --wave ${w.nonce}`, wavePath(w.nonce));
  const at = remote.out.split(/\s/)[0] || null;
  if (dryRun) return outOk([...lines, `DRY-RUN: would push ${short(w.head!)} to ${w.branch}`], `${Q} wave build --wave ${w.nonce}`, wavePath(w.nonce));
  if (at && at !== w.head) return outFailed(fail('QUEUE_WAVE_MOVED', `${w.branch} already exists at ${short(at)}, not the built head ${short(w.head!)}; nothing overwritten`), lines, `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  if (!at) {
    const p = git(repo, ['push', '-q', `--force-with-lease=refs/heads/${w.branch}:`, env.remote, `${w.head}:refs/heads/${w.branch}`]);
    if (!p.ok) return outFailed(fail('QUEUE_PROOF_MISSING', `git push ${w.branch} failed (${p.err.replace(/\s+/g, ' ').slice(0, 160)}); the record says built, nothing else changed`), lines, `${Q} wave build --wave ${w.nonce}`, wavePath(w.nonce));
  }
  w.state = 'pushed';
  w.effects.push({ at: nowIso(), what: `pushed ${w.branch} at ${short(w.head!)}` });
  w.updated_at = nowIso();
  const saved = persist(repo, [w], { remote: env.remote });
  const notices = w.constituents.map(c => `#${c.pr} ${commentOnce(env.ctx, c.pr, marker(w.nonce, 'frozen'), `Frozen in wave \`${w.nonce}\` (branch \`${w.branch}\`) at ${short(c.head)}. Push nothing here: a moved head drops this PR from the wave. Fixes go on the wave branch through its integrator.`)}`);
  const body = path.join(queueRoot(), 'waves', `${w.nonce}-pr-body.md`);
  fs.writeFileSync(body, [`## Wave ${w.nonce}`, '', `One slot and one version for ${w.constituents.length} PRs in area \`${w.area}\`, each merged unchanged with a merge commit:`, '',
    ...w.constituents.map(c => `- #${c.pr} at ${c.head}`), '', 'Each constituent is closed with a link to this PR after it lands (`gstack-ship-queue wave settle`).', ''].join('\n'));
  return outOk([...lines, `PUSHED: ${w.branch} at ${w.head} (${saved.detail})`, `FROZEN_NOTICE: ${notices.join(' ')}`, `PR_BODY: ${body}`],
    `open the wave PR (gh pr create --base ${env.ctx.base} --head ${w.branch} --title "wave(${w.area}): ${w.constituents.map(c => '#' + c.pr).join(' ')}" --body-file ${body}, or the host's PR tool), run /ship on it, then ${Q} ready --pr <wave pr> --screen|--no-screen`, wavePath(w.nonce));
}

function continueWave(env: TrainEnv, w: WaveRecord, dryRun: boolean): TrainOut {
  if (w.state !== 'conflict' || !w.conflict) return outRefused(fail('QUEUE_WAVE_CONFLICT', `wave ${w.nonce} is ${w.state}, not stopped at a conflict`), [], `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  const { pred, pr } = w.conflict;
  const worktree = worktreeOf(w);
  const idx = w.constituents.findIndex(c => c.pr === pr);
  const c = w.constituents[idx]!;
  const dirty = git(worktree, ['status', '--porcelain']);
  const parents = git(worktree, ['rev-list', '--parents', '-n', '1', 'HEAD']).out.split(' ');
  if (!dirty.ok || dirty.out.trim() || parents.length !== 3 || parents[1] !== pred || parents[2] !== c.head) {
    return outRefused(fail('QUEUE_WAVE_CONFLICT', `${worktree} must hold one committed merge of #${pr} (${short(c.head)}) onto ${short(pred)} with a clean tree`), [`WORKTREE: ${worktree}`],
      `resolve the conflicts in ${worktree}, git -C ${worktree} commit --no-edit, then ${Q} wave build --wave ${w.nonce} --continue`, wavePath(w.nonce));
  }
  const problem = w.constituents.map(x => constituentProblem(env.ctx, x.pr, x.head)).find(Boolean);
  if (problem) return outRefused(problem.failure, [], `${Q} wave build --wave ${w.nonce} --drop <pr>`, wavePath(w.nonce));
  c.merge_commit = parents[0]!;
  c.resolved = w.conflict.files;
  const lines = [`RESOLVED: #${pr} -> ${short(parents[0]!)} (integrator resolution of ${w.conflict.files.join(', ')})`];
  if (!dryRun) { git(env.ctx.repoRoot, ['worktree', 'remove', '--force', worktree]); w.conflict = null; }
  return chainFrom(env, w, idx + 1, parents[0]!, lines, dryRun, null);
}

function dropFrom(env: TrainEnv, w: WaveRecord, o: WaveBuildOptions): TrainOut {
  if (!LIVE.has(w.state)) return outRefused(fail('QUEUE_WAVE_MOVED', `wave ${w.nonce} is ${w.state}; only a live wave is rebuilt`), [], `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  const dropped = w.constituents.find(c => c.pr === o.drop);
  if (!dropped) return outRefused(fail('QUEUE_PROOF_MISSING', `#${o.drop} is not a constituent of wave ${w.nonce}`), [], `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  const open = openWavePr(env, w);
  if (open && !o.dryRun) return outRefused(open, [], `close the wave PR on ${w.branch} (a train may still land it), then rerun the drop`, wavePath(w.nonce));
  const rest = w.constituents.filter(c => c !== dropped);
  const missing = w.constituents.find(c => !ensureCommit(env, c.head, c.pr));
  if (missing) return outRefused(fail('QUEUE_PROOF_MISSING', `cannot fetch #${missing.pr}'s pin ${short(missing.head)} to check what the drop leaves behind`), [], 'none', wavePath(w.nonce));
  const carrier = rest.find(c => git(env.ctx.repoRoot, ['merge-base', '--is-ancestor', dropped.head, c.head]).ok);
  if (carrier) return outRefused(fail('QUEUE_WAVE_DEPENDENT', `#${carrier.pr}'s pin contains #${dropped.pr}'s pin, so dropping #${dropped.pr} would still land its code`), [], `drop #${carrier.pr} too, or keep #${dropped.pr}`, wavePath(w.nonce));
  if (rest.length < o.min) return release(env, w, [`DROP: #${dropped.pr} from ${w.nonce} leaves ${rest.length} PR(s), under the wave minimum ${o.min}`], o.dryRun);
  const out = newWave(env, { ...o, area: w.area }, w, rest.map(c => ({ pr: c.pr, sha: c.head })));
  out.lines.unshift(`DROP: #${dropped.pr} from ${w.nonce}; the rebuilt wave gets a new branch and PR (${w.branch}'s PR is already closed)`);
  return out;
}

/** A wave PR still open can still land through a train that admitted it, so drop and release wait for it to close. */
function openWavePr(env: TrainEnv, w: WaveRecord): QueueFailure | null {
  const list = env.ctx.gh(['pr', 'list', '--head', w.branch, '--state', 'open', '--json', 'number']);
  let prs: Array<{ number: number }> | null = null;
  try { prs = list.ok ? JSON.parse(list.out) : null; } catch {}
  if (!prs) return fail('QUEUE_PROOF_MISSING', `gh cannot list PRs for ${w.branch}`);
  return prs.length ? fail('QUEUE_WAVE_MOVED', `wave PR #${prs[0]!.number} on ${w.branch} is still open; a train that admitted it would still land it`) : null;
}

/** End a live wave without landing it (a drop under the minimum, or a wave PR closed unmerged): every constituent rides on its own again. */
function release(env: TrainEnv, w: WaveRecord, lines: string[], dryRun: boolean): TrainOut {
  if (!LIVE.has(w.state)) return outRefused(fail('QUEUE_WAVE_MOVED', `wave ${w.nonce} is ${w.state}; only a live wave is released`), lines, `${Q} wave status --wave ${w.nonce}`, wavePath(w.nonce));
  const open = openWavePr(env, w);
  if (open) return outRefused(open, lines, `close the wave PR on ${w.branch}, then rerun`, wavePath(w.nonce));
  const done = [...lines, `RELEASED: ${w.nonce}: ${w.constituents.map(c => '#' + c.pr).join(',')} ride as single slots; close the wave PR on ${w.branch}`];
  if (dryRun) return outOk([...done, 'DRY-RUN: no record written'], `${Q} wave build --wave ${w.nonce} --release`, wavePath(w.nonce));
  if (w.conflict) { git(env.ctx.repoRoot, ['worktree', 'remove', '--force', worktreeOf(w)]); w.conflict = null; }
  w.state = 'released';
  w.effects.push({ at: nowIso(), what: 'released' });
  w.updated_at = nowIso();
  const saved = persist(env.ctx.repoRoot, [w], { remote: env.remote });
  return outOk([...done, `RECORD: ${saved.detail}`], `each owner READYs its PR alone: ${Q} ready --pr <n> --screen|--no-screen`, wavePath(w.nonce));
}

export function waveStatus(ctx: QueueContext, o: { wave?: string }): TrainOut {
  const env = setup(ctx);
  if ('exit' in env) return env;
  if (!o.wave) {
    const all = listWaves(env.repo.keys);
    if (!all.length) return outOk(['WAVE: none recorded'], `${Q} wave plan`, 'none');
    return outOk(all.map(w => `WAVE: ${w.nonce} ${w.state} area=${w.area} ${pinsOf(w)} branch=${w.branch}${w.superseded_by ? ` superseded_by=${w.superseded_by}` : ''}`), `${Q} wave status --wave <nonce>`, 'none');
  }
  const w = loadWave(o.wave);
  if (!w || !env.repo.keys.includes(w.repo_key)) return outRefused(fail('QUEUE_WAVE_UNKNOWN', `no wave record ${o.wave}`), [], `${Q} wave status`, 'none');
  const lines = [`WAVE: ${w.nonce} ${w.state} area=${w.area} base=${short(w.base.sha)} branch=${w.branch} head=${w.head ? short(w.head) : 'none'}`];
  if (w.conflict) lines.push(`CONFLICT: #${w.conflict.pr} (${w.conflict.files.join(', ')}) in ${w.conflict.worktree}`);
  const tip = git(env.ctx.repoRoot, ['ls-remote', env.remote, `refs/heads/${w.branch}`]).out.split(/\s/)[0];
  if (tip && git(env.ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/heads/${w.branch}:refs/gstack/wave/${w.nonce}`]).ok) {
    const chain = waveChain(env.ctx.repoRoot, w, tip, `${env.remote}/${env.ctx.base}`);
    lines.push('error' in chain ? `CHAIN: invalid at ${short(tip)}: ${chain.error}` : `CHAIN: ok at ${short(tip)}: ${chain.merges.length} constituent merges, ${chain.integrator.length} integrator commit(s)`);
  }
  for (const c of w.constituents) {
    const p = constituentProblem(ctx, c.pr, c.head);
    lines.push(`CONSTITUENT: #${c.pr} pin=${short(c.head)} ${p ? `${p.failure.code}: ${p.failure.message}` : 'open at its pin'}`);
  }
  for (const s of w.settled) lines.push(`SETTLED: #${s.pr} ${s.outcome} at ${s.at}`);
  const next = w.state === 'conflict' ? `${Q} wave build --wave ${w.nonce} --continue` : w.state === 'built' ? `${Q} wave build --wave ${w.nonce}` : w.state === 'pushed' ? `after the wave PR merges: ${Q} wave settle --wave ${w.nonce}` : 'none';
  return outOk(lines, next, wavePath(w.nonce));
}

/**
 * After the wave PR merged: bind to the merged PR's own head (main's merge must carry its
 * tree), walk its chain, and settle each constituent once. A constituent still at its pin is
 * closed with the link, the version and any integrator commits touching its files; a moved one
 * stays open with a comment (its newer work did not land); a closed one is skipped.
 */
export function waveSettle(ctx: QueueContext, o: { wave: string; dryRun: boolean }): TrainOut {
  const env = setup(ctx);
  if ('exit' in env) return env;
  const w = loadWave(o.wave);
  if (!w || !env.repo.keys.includes(w.repo_key)) return outRefused(fail('QUEUE_WAVE_UNKNOWN', `no wave record ${o.wave}`), [], `${Q} wave status`, 'none');
  const list = ctx.gh(['pr', 'list', '--head', w.branch, '--state', 'all', '--json', 'number,state,headRefOid,mergeCommit,baseRefName']);
  let prs: Array<{ number: number; state: string; headRefOid: string; baseRefName?: string; mergeCommit?: { oid?: string } | null }> = [];
  try { prs = JSON.parse(list.out); } catch {}
  const merged = list.ok ? prs.find(p => p.state === 'MERGED' && p.mergeCommit?.oid && p.baseRefName === w.base.ref) : undefined;
  if (!merged) return outRefused(fail('QUEUE_WAVE_NOT_MERGED', list.ok ? `no merged PR has head branch ${w.branch}` : `gh cannot list PRs for ${w.branch}: ${(list.err ?? '').slice(0, 120)}`), [], `land the wave PR through its train, then ${Q} wave settle --wave ${w.nonce}`, wavePath(w.nonce));
  const mergeSha = merged.mergeCommit!.oid!;
  const repo = ctx.repoRoot;
  if (!ensureCommit(env, merged.headRefOid, String(merged.number)) || !git(repo, ['cat-file', '-e', `${mergeSha}^{commit}`]).ok) return outRefused(fail('QUEUE_PROOF_MISSING', `cannot fetch #${merged.number}'s head or merge commit`), [], 'none', wavePath(w.nonce));
  if (!git(repo, ['merge-base', '--is-ancestor', mergeSha, `${env.remote}/${w.base.ref}`]).ok) {
    return outRefused(fail('QUEUE_WAVE_NOT_MERGED', `#${merged.number}'s merge ${short(mergeSha)} is not on ${env.remote}/${w.base.ref}`), [], 'none', wavePath(w.nonce));
  }
  const mergedTree = git(repo, ['rev-parse', `${mergeSha}^{tree}`]).out;
  const onParent = git(repo, ['merge-tree', '--write-tree', `${mergeSha}^1`, merged.headRefOid]);
  if (mergedTree !== git(repo, ['rev-parse', `${merged.headRefOid}^{tree}`]).out && !(onParent.ok && onParent.out.split('\n')[0] === mergedTree)) {
    return outRefused(fail('QUEUE_WAVE_NOT_MERGED', `main's merge ${short(mergeSha)} is neither #${merged.number}'s head tree nor that head merged onto its parent; what landed is not the wave`), [], 'none', wavePath(w.nonce));
  }
  const chain = waveChain(repo, w, merged.headRefOid, mergeSha);
  if ('error' in chain) return outRefused(fail('QUEUE_WAVE_MOVED', `the merged head ${short(merged.headRefOid)}: ${chain.error}`), [], 'none', wavePath(w.nonce));
  const at = versionAtRef(repo, mergeSha);
  const version = 'version' in at ? `v${at.version}` : 'its version';
  const integratorFiles = new Map(chain.integrator.map(c => [c, git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', c]).out.split('\n').filter(Boolean)]));
  const lines = [`WAVE_MERGED: #${merged.number} as ${short(mergeSha)} (${version}); chain ok: ${chain.merges.length} constituent merges, ${chain.integrator.length} integrator commit(s)`];
  let incomplete = 0;
  for (const c of w.constituents) {
    const info = prInfo(ctx, c.pr);
    if ('error' in info) { incomplete++; lines.push(`SETTLED: #${c.pr} unreadable (${info.error}); rerun settle`); continue; }
    if (info.state !== 'OPEN') { lines.push(`SETTLED: #${c.pr} skipped (${info.state.toLowerCase()})`); continue; }
    const own = new Set(changed(env, c.head)?.files ?? []);
    const touched = [
      ...w.constituents.flatMap((x, i) => {
        const why = chain.merges[i] !== x.merge_commit ? 'not the recorded merge' : x.resolved ? `resolved by hand: ${x.resolved.join(', ')}` : null;
        return why && (x === c || x.resolved?.some(f => own.has(f))) ? [`${short(chain.merges[i]!)} (merge of #${x.pr}, ${why})`] : [];
      }),
      ...chain.integrator.filter(x => integratorFiles.get(x)!.some(f => own.has(f))).map(short),
    ];
    const moved = info.headRefOid !== c.head;
    const body = moved
      ? `Wave #${merged.number} landed this PR's pin ${short(c.head)} as ${version} (${short(mergeSha)}). The head moved to ${short(info.headRefOid)} after the wave froze, so that newer work did not land. Left open for its owner.`
      : `Landed in wave #${merged.number} as ${version} (${short(mergeSha)}), merged from this PR's pin ${short(c.head)}. Integrator changes touching this PR's files: ${touched.length ? touched.join(', ') : 'none'}.`;
    if (o.dryRun) { lines.push(`SETTLED: #${c.pr} would be ${moved ? 'commented, left open' : 'commented and closed'} (dry run)`); continue; }
    const posted = commentOnce(ctx, c.pr, marker(w.nonce, moved ? 'moved' : 'landed'), body);
    const still = moved || posted === 'failed' ? null : prInfo(ctx, c.pr);
    const stillAtPin = !!still && !('error' in still) && still.headRefOid === c.head;
    const closed = stillAtPin ? ctx.gh(['pr', 'close', c.pr]).ok : false;
    const outcome = posted === 'failed' || (!moved && !closed) ? 'incomplete' : moved ? 'moved-left-open' : 'landed-closed';
    if (outcome === 'incomplete') incomplete++;
    lines.push(`SETTLED: #${c.pr} ${outcome} (comment ${posted})`);
    w.settled = [...w.settled.filter(s => s.pr !== c.pr), { pr: c.pr, outcome, at: nowIso() }];
  }
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: nothing commented or closed'], `${Q} wave settle --wave ${w.nonce}`, wavePath(w.nonce));
  if (!incomplete) w.state = 'settled';
  w.updated_at = nowIso();
  persist(repo, [w], { remote: env.remote });
  if (incomplete) return outFailed(fail('QUEUE_PROOF_MISSING', `${incomplete} constituent(s) not settled; every other one is recorded`), lines, `${Q} wave settle --wave ${w.nonce}`, wavePath(w.nonce));
  return outOk(lines, 'none', wavePath(w.nonce));
}

export const WAVE_HELP = `gstack-ship-queue wave: wave PRs for merge trains (docs/ship-policy.md#wave-prs)

  wave plan [--trigger <n>] [--min <n>] [--max <n>]
                                           read-only: live READY PRs (NOT_GREEN and NOT_MERGEABLE heads left out); over the
                                           trigger (default ${WAVE_TRIGGER}) WAVE_ADVISED and WAVE_GROUP lines (area, PRs, integrator)
                                           with each group's build command; WAVE_OVERSIZE for linked PRs over --max (no command)
  wave build --prs <n>@<sha>,... [--area <name>] [--min <n>] [--max <n>] [--dry-run]
                                           the integrator branch wave/<nonce>: main plus each pin merged unchanged (train merge
                                           rules), the wave record in refs/notes/gstack-trains, the branch pushed, a frozen notice
                                           on each constituent; a conflict stops in a worktree under the state root
  wave build --wave <nonce> [--continue | --drop <pr> | --release] [--dry-run]
                                           resume (retry the push), continue after the integrator committed the resolution, or
                                           rebuild without one constituent as a new wave (new branch; never a force-push), or
                                           release the wave so its PRs ride alone (a drop under --min releases too)
  wave status [--wave <nonce>]             records, the branch chain, each constituent's GitHub head
  wave settle --wave <nonce> [--dry-run]   after the wave PR merged: close constituents still at their pins with the link and
                                           version; a moved constituent stays open with a comment; resumable
  A wave PR is READY'd and trained like any PR: ready --pr <wave pr> adds WAVE and CONSTITUENTS lines.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(message: string): number {
  process.stderr.write(`gstack-ship-queue: ${message}\n${WAVE_HELP}\n`);
  return EXIT.usage;
}

function print(cmd: string, out: TrainOut): number {
  for (const l of out.lines) process.stdout.write(l + '\n');
  if (out.failure) process.stderr.write(`gstack-ship-queue ${cmd}: ${out.failure.message}; fix: ${out.failure.fix ?? RESULT_CODES[out.failure.code].fix} (${out.failure.code})\n`);
  process.stdout.write(`NEXT: ${out.next}\n`);
  process.stdout.write(formatResult('ship-queue', out.status, out.run) + '\n');
  return out.exit;
}

export async function waveMain(ctx: QueueContext, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith('-')) { process.stdout.write(WAVE_HELP + '\n'); return sub === '--help' || sub === '-h' ? EXIT.ok : EXIT.usage; }
  const count = (name: string, fallback: number) => { const v = flag(rest, name); return v === undefined ? fallback : /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : NaN; };
  const min = count('--min', WAVE_MIN);
  const max = count('--max', WAVE_MAX);
  const trigger = count('--trigger', WAVE_TRIGGER);
  if ([min, max, trigger].some(Number.isNaN) || min > max) return usage('--min, --max and --trigger take positive whole numbers, with --min <= --max');
  const wave = flag(rest, '--wave');
  const dryRun = rest.includes('--dry-run');
  try {
    if (sub === 'plan') return print('wave plan', wavePlan(ctx, { trigger, min, max }));
    if (sub === 'status') return print('wave status', waveStatus(ctx, { wave }));
    if (sub === 'settle') return wave ? print('wave settle', waveSettle(ctx, { wave, dryRun })) : usage('wave settle needs --wave <nonce>');
    if (sub === 'build') {
      const drop = flag(rest, '--drop');
      const cont = rest.includes('--continue');
      const releaseIt = rest.includes('--release');
      if (!wave && !flag(rest, '--prs')) return usage('wave build needs --prs <n>@<sha>,... or --wave <nonce>');
      if (wave && flag(rest, '--prs')) return usage('pass --prs for a new wave or --wave <nonce> for an existing one, not both');
      if ((drop !== undefined || cont || releaseIt) && !wave) return usage('--continue, --drop and --release need --wave <nonce>');
      if ([drop !== undefined, cont, releaseIt].filter(Boolean).length > 1) return usage('pass one of --continue, --drop or --release');
      if (drop !== undefined && !/^\d+$/.test(drop)) return usage('--drop needs a PR number');
      return print('wave build', waveBuild(ctx, { pins: flag(rest, '--prs'), area: flag(rest, '--area'), wave, cont, drop, release: releaseIt, dryRun, min, max }));
    }
    return usage(`unknown wave subcommand ${sub}`);
  } catch (error) {
    process.stderr.write(`gstack-ship-queue wave ${sub}: unexpected failure: ${redactCause(error instanceof Error ? error.message : String(error))}\n`);
    process.stdout.write(`NEXT: ${Q} wave status${wave ? ` --wave ${wave}` : ''} (the record shows what was written before the failure)\n`);
    process.stdout.write(formatResult('ship-queue', 'interrupted', wave ? wavePath(wave) : 'none') + '\n');
    return EXIT.fail;
  }
}
