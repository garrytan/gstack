/**
 * lane-ownership — which planned files an in-flight lane already changes
 * (plan E2). A coordinator running several lanes gives every shared file one
 * owner; `bin/gstack-lane-check` takes the files one lane plans to touch plus
 * the in-flight branches and pull requests, diffs each against its merge base
 * with the base branch, and reports every intersection with the PR number,
 * the branch and the hunk count in that file. A branch that cannot be
 * resolved is reported (`LANE_REF_UNAVAILABLE`), never assumed clear. Planned
 * paths may be globs (`lib/**`); `*` and `**` are the only wildcards.
 */
import { spawnSync } from 'node:child_process';
import { globToRegExp } from './ship-policy';

export interface LaneRef { branch: string; pr: number | null; ref: string }
export interface LaneFile { path: string; hunks: number; added: number; deleted: number }
export interface LaneDiff { lane: LaneRef; head: string | null; base: string | null; files: LaneFile[]; error?: string }
export interface Intersection { planned: string; file: string; lane: LaneRef; hunks: number }
export interface LaneCheck {
  schema_version: 1; base: string; planned: string[]; lanes: LaneDiff[]; intersections: Intersection[];
  unresolved: LaneRef[]; verdict: 'clear' | 'conflicts' | 'unresolved';
}

function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, '') };
}

/** Resolve a PR number to its head branch through `gh`; null when gh cannot answer. */
export function prHeadBranch(cwd: string, pr: number): { branch: string } | { error: string } {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'headRefName,state'], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { error: (r.stderr ?? '').trim() || `gh pr view ${pr} failed` };
  try {
    const parsed = JSON.parse(r.stdout) as { headRefName?: string; state?: string };
    if (!parsed.headRefName) return { error: `PR #${pr} has no head branch` };
    return { branch: parsed.headRefName };
  } catch (e: any) { return { error: `PR #${pr}: ${e.message}` }; }
}

/** The branch's ref to diff: a fetched remote-tracking ref when present, else the local branch. */
export function resolveRef(cwd: string, branch: string, remote = 'origin'): string | null {
  for (const candidate of [branch.startsWith(`${remote}/`) ? branch : `${remote}/${branch}`, branch]) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).ok) return candidate;
  }
  return null;
}

/** Files a lane changes against its merge base with `base`, each with its hunk count. */
export function diffLane(cwd: string, lane: LaneRef, base: string): LaneDiff {
  const head = git(cwd, ['rev-parse', lane.ref]);
  if (!head.ok) return { lane, head: null, base: null, files: [], error: `${lane.ref} is not a commit` };
  const mb = git(cwd, ['merge-base', base, lane.ref]);
  if (!mb.ok) return { lane, head: head.out, base: null, files: [], error: `no merge base between ${base} and ${lane.ref}` };
  const numstat = git(cwd, ['diff', '--numstat', `${mb.out}..${lane.ref}`]);
  if (!numstat.ok) return { lane, head: head.out, base: mb.out, files: [], error: `git diff failed for ${lane.ref}` };
  const files: LaneFile[] = [];
  for (const line of numstat.out.split('\n').filter(Boolean)) {
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    const hunkDiff = git(cwd, ['diff', '-U0', `${mb.out}..${lane.ref}`, '--', file]);
    const hunks = hunkDiff.ok ? hunkDiff.out.split('\n').filter(l => l.startsWith('@@')).length : 0;
    files.push({ path: file, hunks: Math.max(hunks, 1), added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted) });
  }
  return { lane, head: head.out, base: mb.out, files };
}

export interface LaneCheckOptions { cwd: string; planned: string[]; branches?: string[]; prs?: number[]; base?: string; remote?: string; resolvePr?: (pr: number) => { branch: string } | { error: string } }

export function laneCheck(o: LaneCheckOptions): LaneCheck {
  const remote = o.remote ?? 'origin';
  const base = o.base ?? (resolveRef(o.cwd, 'HEAD', remote) && git(o.cwd, ['rev-parse', '--abbrev-ref', `${remote}/HEAD`]).ok
    ? git(o.cwd, ['rev-parse', '--abbrev-ref', `${remote}/HEAD`]).out : `${remote}/main`);
  const planned = [...new Set(o.planned.map(p => p.trim()).filter(Boolean))];
  const lanes: LaneDiff[] = [];
  const unresolved: LaneRef[] = [];
  const refs: LaneRef[] = (o.branches ?? []).map(b => ({ branch: b, pr: null, ref: b }));
  for (const pr of o.prs ?? []) {
    const r = (o.resolvePr ?? (n => prHeadBranch(o.cwd, n)))(pr);
    if ('error' in r) { const lane = { branch: `#${pr}`, pr, ref: `#${pr}` }; unresolved.push(lane); lanes.push({ lane, head: null, base: null, files: [], error: r.error }); continue; }
    const existing = refs.find(x => x.branch === r.branch);
    if (existing) existing.pr = pr; else refs.push({ branch: r.branch, pr, ref: r.branch });
  }
  for (const lane of refs) {
    const ref = resolveRef(o.cwd, lane.branch, remote);
    if (!ref) { unresolved.push(lane); lanes.push({ lane, head: null, base: null, files: [], error: `${lane.branch} is not fetched (git fetch ${remote} ${lane.branch})` }); continue; }
    const diff = diffLane(o.cwd, { ...lane, ref }, base);
    if (diff.error) unresolved.push(diff.lane);
    lanes.push(diff);
  }
  const matchers = planned.map(p => ({ planned: p, re: globToRegExp(p) }));
  const intersections: Intersection[] = [];
  for (const lane of lanes) for (const f of lane.files) for (const m of matchers) {
    if (m.re.test(f.path)) intersections.push({ planned: m.planned, file: f.path, lane: lane.lane, hunks: f.hunks });
  }
  const verdict = intersections.length ? 'conflicts' : unresolved.length ? 'unresolved' : 'clear';
  return { schema_version: 1, base, planned, lanes, intersections, unresolved, verdict };
}

export function renderLaneCheck(c: LaneCheck): string {
  const lines: string[] = [];
  for (const lane of c.lanes) {
    const id = lane.lane.pr !== null ? `PR #${lane.lane.pr} (${lane.lane.branch})` : lane.lane.branch;
    lines.push(lane.error ? `LANE: ${id} unresolved: ${lane.error}` : `LANE: ${id} head=${lane.head!.slice(0, 12)} files=${lane.files.length}`);
  }
  for (const x of c.intersections) {
    const id = x.lane.pr !== null ? `PR #${x.lane.pr} (${x.lane.branch})` : x.lane.branch;
    lines.push(`LANE_CONFLICT: ${x.file} planned=${x.planned} in-flight=${id} hunks=${x.hunks}`);
  }
  lines.push(`LANE_CHECK: ${c.verdict} planned=${c.planned.length} lanes=${c.lanes.length} intersections=${c.intersections.length} unresolved=${c.unresolved.length} base=${c.base}`);
  return lines.join('\n') + '\n';
}
