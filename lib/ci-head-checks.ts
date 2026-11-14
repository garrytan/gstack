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

/**
 * Every check and commit-status context ciAtHead counts at `sha` in `repo`, or why they could not all be read (unknown is
 * never green). A check with an unknown conclusion keeps its spelling and one with none is `fail`, as ciAtHead counts them.
 */
export function headCheckRows(gh: GhRunner, repo: string, sha: string): { rows: HeadCheckRow[] } | { error: string } {
  const inRepo = (args: string[]) => {
    const r = gh(args.map(a => a.replace('repos/{owner}/{repo}/', `repos/${repo}/`)));
    return { ok: !r.error && r.status === 0, out: r.stdout, err: r.error ?? r.stderr };
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
