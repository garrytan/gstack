/**
 * Agent host selection for paid E2E cases (GSTA-49 TM2). EVALS_HOST picks the
 * agent every runSkillTest session runs on: `claude` (default) or `codex`
 * (codex exec, test/helpers/codex-host-runner.ts). E2E_HOSTS is the per-case
 * host metadata over every gate case (classification in the GSTA-49 TM2
 * scoping): `both` runs on either host with the shared adapter; every other
 * value is the reason the case is Claude-only. On the Codex host a Claude-only
 * case is SKIPPED with its reason, planned as excluded and deselected by the
 * report with zero credit, never counted as failed. A case without metadata
 * (every non-gate case) is Claude-only.
 */

export type EvalHost = 'claude' | 'codex';
export const EVAL_HOSTS: readonly EvalHost[] = ['claude', 'codex'];

export function resolveEvalHost(env: NodeJS.ProcessEnv = process.env): EvalHost {
  const raw = (env.EVALS_HOST ?? '').trim();
  if (!raw) return 'claude';
  if ((EVAL_HOSTS as readonly string[]).includes(raw)) return raw as EvalHost;
  throw new Error(`EVALS_HOST must be one of ${EVAL_HOSTS.join(', ')}; got "${raw}"`);
}

export const CLAUDE_ONLY_REASONS = {
  pty: 'drives the interactive Claude Code TUI (plan mode, native AskUserQuestion) through the PTY harness',
  sdk: 'uses the Claude Agent SDK (canUseTool answers and PreToolUse hooks)',
  subagents: 'asserts Claude Agent/Task subagent events',
  'skill-tool': 'depends on the Claude Skill tool load and registration',
  hermetic: 'a claude -p hermetic canary; the Codex host needs its own canary twin',
  'self-host': 'the Claude host calling /codex; on the Codex host /codex is the agent itself',
  rework: 'parses Claude stream-json tool events or prescribes native Claude tools; not ported to the Codex host',
  'host-neutral': 'runs no model session, so a second host adds nothing',
} as const;

export type ClaudeOnlyReason = keyof typeof CLAUDE_ONLY_REASONS;
export type HostSupport = 'both' | ClaudeOnlyReason;

/** Adapter-only cases: final output, files, git state, Bash commands, server logs or browseErrors. */
const ADAPTER_ONLY: readonly string[] = [
  'benchmark-workflow',
  'browse-basic',
  'browse-snapshot',
  'canary-workflow',
  'context-recovery-artifacts',
  'context-restore-loads-latest',
  'context-save-writes-file',
  'cso-diff-mode',
  'design-review-detector-shim',
  'design-review-detector-shim-dom',
  'design-review-plugin-handoff',
  'diagram-triplet',
  'document-release',
  'gstack-upgrade-happy-path',
  'land-and-deploy-first-run',
  'land-and-deploy-review-gate',
  'land-and-deploy-workflow',
  'learnings-show',
  'operational-learning',
  'plan-design-review-no-ui-scope',
  'plan-eng-coverage-audit',
  'plan-review-report',
  'plan-tune-inspect',
  'qa-bootstrap',
  'qa-quick',
  'retro-base-branch',
  'review-army-delivery-audit',
  'review-army-json-findings',
  'review-army-migration-safety',
  'review-army-quality-score',
  'review-base-branch',
  'review-coverage-audit',
  'review-enum-completeness',
  'review-sql-injection',
  'review-test-value',
  'safety-pair-agent-block',
  'safety-ship-stale-evidence',
  'setup-deploy-workflow',
  'ship-base-branch',
  'ship-coverage-audit',
  'ship-coverage-value',
  'ship-local-workflow',
  'ship-triage',
  'skillmd-no-local-binary',
  'skillmd-outside-git',
  'skillmd-setup-discovery',
  'test-audit-report-only',
  'tpa-absent-darwin',
  'tpa-absent-linux',
  'tpa-apple-ban',
  'tpa-broken',
  'tpa-present'
];

const CLAUDE_ONLY: Readonly<Record<ClaudeOnlyReason, readonly string[]>> = {
  pty: ['autoplan-guard-pty', 'office-hours-auto-mode', 'plan-ceo-finding-floor', 'plan-ceo-review-plan-mode',
    'plan-design-with-ui-scope', 'plan-devex-finding-floor', 'plan-devex-review-plan-mode', 'plan-mode-no-op'],
  sdk: ['auq-format-gate', 'investigate-owned-abort', 'investigate-owned-completion', 'investigate-owned-ending-error',
    'shared-libs-review-index-flags', 'shared-libs-review-lifecycle', 'shared-libs-review-path-eligibility',
    'shared-libs-review-prior-coverage', 'shared-libs-review-revalidation', 'ship-frozen-scope-convergence', 'ship-local-hook-preservation',
    'ship-managed-hook-refresh', 'ship-skipped-queued-finding', 'ship-unmanaged-hook-consent'],
  subagents: ['docsync-spawned', 'review-army-perf-n-plus-one'],
  'skill-tool': ['router-failure-contradicted-cause', 'router-failure-triage-resolves', 'router-failure-triage-unclear',
    'router-failure-verified-cause', 'skillify-approval-reject', 'skillify-happy-path', 'skillify-provenance-refusal'],
  hermetic: ['hermetic-canary', 'hermetic-sentinel'],
  'self-host': ['safety-codex-consult-embed'],
  rework: ['qa-functional-cli-fix', 'qa-functional-cli-report', 'qa-functional-webhook-fix', 'qa-functional-webhook-report',
    'qa-only-no-fix', 'review-dashboard-via', 'review-exploratory-small-cli', 'review-gate-integrity',
    'shared-libs-read-only', 'shared-libs-unsupported-git', 'ship-docsync-completion', 'ship-docsync-current',
    'ship-docsync-failure', 'ship-docsync-late-result', 'ship-docsync-launch-failure', 'ship-docsync-missing-asset',
    'ship-docsync-missing-marker', 'ship-docsync-recovery', 'ship-docsync-stale-after', 'ship-docsync-stale-before',
    'ship-docsync-store', 'ship-docsync-timeout-unsettled', 'ship-exploratory-late-input', 'ship-exploratory-plan-checks',
    'ship-exploratory-small-cli', 'ship-exploratory-unavailable'],
  'host-neutral': ['timeline-event-flow'],
};

export const E2E_HOSTS: Readonly<Record<string, HostSupport>> = Object.freeze(Object.fromEntries([
  ...ADAPTER_ONLY.map(id => [id, 'both'] as const),
  ...(Object.entries(CLAUDE_ONLY) as Array<[ClaudeOnlyReason, readonly string[]]>).flatMap(([reason, ids]) => ids.map(id => [id, reason] as const)),
]));

/** Why a case does not run on `host`, or null when it does. */
export function hostSkipReason(id: string, host: EvalHost, hosts: Readonly<Record<string, HostSupport>> = E2E_HOSTS): string | null {
  if (host === 'claude') return null;
  const support = hosts[id];
  if (support === 'both') return null;
  if (support === undefined) return `Claude-only on the ${host} host: no Codex host metadata (E2E_HOSTS covers the gate cases)`;
  return `Claude-only on the ${host} host: ${CLAUDE_ONLY_REASONS[support]}`;
}
