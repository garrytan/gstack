/**
 * ci-head-checks: the merge queue's read of CI at one commit (ciAtHead in lib/ship-queue.ts, GST-2167) as `gh pr checks`
 * bucket rows, for the other readers that decide a commit is green: gstack-pr-wait, gstack-ci-gate and the release cut
 * (crew/scripts/release-cut.ts) (GST-2252).
 *
 * GitHub's rollup (`gh pr checks`) and its default check-runs list hold only each check suite's latest attempt, so a rerun
 * attempt that created no jobs hides the failed run before it, and a workflow run that failed before creating a job is
 * never a check run at all: gstack-evals#303 read green with its `checks` job red. ciAtHead counts both. Each caller adds
 * these rows to the ones it already reads and keeps the worst bucket per name, so no check that gated before stops gating.
 */
import type { GhRunner } from './ci-gate';
import { ciAtHead } from './ship-queue';

export interface HeadCheckRow { name: string; bucket: string }

const CONCLUSION_BUCKET: Record<string, string> = {
  success: 'pass', failure: 'fail', timed_out: 'fail', action_required: 'fail', startup_failure: 'fail',
  cancelled: 'cancel', skipped: 'skipping', neutral: 'skipping',
};

/** Check runs (by id) and workflow runs (by id) a caller sets aside, such as the release cut's own jobs (GST-2463). */
export interface AsideRuns { checkRunIds: ReadonlySet<number>; workflowRunIds: ReadonlySet<number> }

const PAGE = 100;

/**
 * Every check and commit-status context ciAtHead counts at `sha` in `repo`, or why they could not all be read (unknown is
 * never green). A check with an unknown conclusion keeps its spelling and one with none is `fail`, as ciAtHead counts them.
 * `aside` removes those check runs and workflow runs from every list before ciAtHead reads it: each list is read whole and
 * served again without them, so ciAtHead's total_count check still holds, and a list that cannot be read whole is unknown.
 */
export function headCheckRows(gh: GhRunner, repo: string, sha: string, aside?: AsideRuns): { rows: HeadCheckRow[] } | { error: string } {
  const run = (args: string[]) => gh(args.map(a => a.replace('repos/{owner}/{repo}/', `repos/${repo}/`)));
  const lists = new Map<string, Array<Record<string, unknown>> | null>();
  const readWhole = (prefix: string, key: string, drop: ReadonlySet<number>) => {
    const items: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 10; page++) {
      const r = run(['api', `${prefix}per_page=${PAGE}&page=${page}`]);
      let body: Record<string, unknown> | null = null;
      try { body = !r.error && r.status === 0 ? JSON.parse(r.stdout) : null; } catch {}
      const list = body?.[key];
      if (!Array.isArray(list) || typeof body?.total_count !== 'number') return null;
      items.push(...list);
      if (items.length >= body.total_count || list.length < PAGE) return items.length === body.total_count ? items.filter(i => !drop.has(Number(i.id))) : null;
    }
    return null;
  };
  const inRepo = (args: string[]) => {
    const m = aside && args[0] === 'api' ? /^(.*(?:\/check-runs|\/actions\/runs)\?(?:.*&)?)per_page=\d+&page=(\d+)$/.exec(args[1] ?? '') : null;
    if (!aside || !m) {
      const r = run(args);
      return { ok: !r.error && r.status === 0, out: r.stdout, err: r.error ?? r.stderr };
    }
    const key = m[1]!.includes('/check-runs') ? 'check_runs' : 'workflow_runs';
    if (!lists.has(m[1]!)) lists.set(m[1]!, readWhole(m[1]!, key, key === 'check_runs' ? aside.checkRunIds : aside.workflowRunIds));
    const all = lists.get(m[1]!);
    if (!all) return { ok: false, out: '', err: `${key} unreadable while setting runs aside` };
    const page = Number(m[2]);
    return { ok: true, out: JSON.stringify({ total_count: all.length, [key]: all.slice((page - 1) * PAGE, page * PAGE) }), err: '' };
  };
  const ci = ciAtHead({ repoRoot: process.cwd(), base: '', gh: inRepo }, sha);
  if (ci.line.startsWith('unknown')) return { error: ci.line.replace(/^unknown at (\S+)/, 'CI at $1 is unknown') };
  return {
    rows: [
      ...ci.checks.map(c => ({ name: c.name, bucket: c.status !== 'completed' ? 'pending' : CONCLUSION_BUCKET[c.conclusion ?? ''] ?? (c.conclusion || 'fail') })),
      ...ci.contexts.map(s => ({ name: s.name, bucket: s.state === 'success' ? 'pass' : s.state === 'pending' ? 'pending' : 'fail' })),
    ],
  };
}
