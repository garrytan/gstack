/**
 * GitHub's REST answers about CI at one commit, for unit fakes of the readers that share ciAtHead (lib/ci-head-checks.ts,
 * GST-2252), with the check runs and workflow runs #4235 (GST-2167) recorded from gstack-evals#303 in
 * test/gstack-ship-queue.test.ts. A check run marked earlier_attempt belongs to a superseded workflow-run attempt: like
 * GitHub's default filter=latest and ghQueueShim (test/helpers/ship-queue-fixture.ts), it is listed only when the call asks
 * for filter=all.
 */
export interface CiAtCommit { check_runs: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>>; workflow_runs?: Array<Record<string, unknown>> }

const app = { id: 15368 };
const wf = (id: number, name: string, workflow_id: number, suite: number, conclusion: string, created_at: string) => ({ id, name, workflow_id, check_suite_id: suite, status: 'completed', conclusion, created_at });
const checks = { id: 129322614246, name: 'checks', status: 'completed', conclusion: 'failure', completed_at: '2026-11-09T17:49:57Z', app, check_suite: { id: 115553115622 } };
const sealed = { id: 129322588977, name: 'sealed', status: 'completed', conclusion: 'success', completed_at: '2026-11-09T17:22:47Z', app, check_suite: { id: 115553095053 } };

/**
 * gstack-evals#303: `checks` failed in its first attempt and the rerun attempt created no jobs, so GitHub's default list shows
 * only the passing `sealed`; a second sealed run failed without creating a job. ciAtHead reads it red (passed=1 failed=2).
 */
export const PR303: CiAtCommit = {
  check_runs: [{ ...checks, earlier_attempt: true }, sealed],
  workflow_runs: [
    wf(42671854799, 'sealed', 2, 115574560782, 'failure', '2026-11-09T18:11:40Z'),
    wf(42663983836, 'ci', 1, 115553115622, 'failure', '2026-11-09T17:22:30Z'),
    wf(42663976278, 'sealed', 2, 115553095053, 'success', '2026-11-09T17:22:28Z'),
  ],
};

/** The negative control from the same test: the failed `checks` attempt was rerun and passed, so the head is green. */
export const PR303_RERUN_PASSED: CiAtCommit = {
  check_runs: [{ ...checks, earlier_attempt: true }, { ...checks, id: 129330000000, conclusion: 'success', completed_at: '2026-11-09T18:20:00Z' }, sealed],
  workflow_runs: [wf(42663983836, 'ci', 1, 115553115622, 'success', '2026-11-09T17:22:30Z'), wf(42663976278, 'sealed', 2, 115553095053, 'success', '2026-11-09T17:22:28Z')],
};

/**
 * Bash `case "$*"` arms for a gh shim that answers every read of CI at a commit with `checkRuns` (all in their latest attempt):
 * gateVerdict's `--paginate --slurp` check-runs pages and ciAtHead's single pages, with no statuses and no workflow runs.
 */
export function ciShimCases(checkRuns: unknown[]): string {
  return [
    `  *--slurp*check-runs*) echo '${JSON.stringify([{ check_runs: checkRuns }])}' ;;`,
    `  *check-runs*) echo '${JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns })}' ;;`,
    `  */status\\?*) echo '{"total_count":0,"statuses":[]}' ;;`,
    `  *actions/runs*) echo '{"total_count":0,"workflow_runs":[]}' ;;`,
  ].join('\n') + '\n';
}

/**
 * gh's reply to one REST read of CI at a commit, or null when `args` is not one: `commits/<sha>/check-runs`, `commits/<sha>/status`
 * or `actions/runs?head_sha=<sha>`, as one page (`page=N`), `--paginate --jq '.<key>[]'` lines or `--paginate --slurp` pages.
 */
export function ciRest(args: string[], data: CiAtCommit): { status: number; stdout: string; stderr: string } | null {
  if (args[0] !== 'api') return null;
  const path = args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--jq') ?? '';
  const m = /commits\/[0-9a-f]+\/(check-runs|status)\b|actions\/runs\?head_sha=/.exec(path);
  if (!m) return null;
  const key = m[1] === 'check-runs' ? 'check_runs' : m[1] === 'status' ? 'statuses' : 'workflow_runs';
  const list = key === 'check_runs' ? data.check_runs.filter(r => /[?&]filter=all(&|$)/.test(path) || !r.earlier_attempt) : data[key] ?? [];
  const out = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  if (args.includes('--jq')) return out(list.map(item => JSON.stringify(item)).join('\n'));
  if (args.includes('--slurp')) return out(JSON.stringify([{ total_count: list.length, [key]: list }]));
  const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
  return out(JSON.stringify({ total_count: list.length, [key]: page === 1 ? list : [] }));
}
