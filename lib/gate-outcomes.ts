/**
 * INV-1 gate outcome contract: every gate or outside review ends as
 * `ran` (with findings or a verdict), `not_run` (gstack chose not to run it) or
 * `unavailable` (it tried and could not). Each reason code maps to one state,
 * one stable anchor in docs/troubleshooting.md and one fix action; the
 * validator prints these lines and test/troubleshooting-anchors.test.ts checks
 * every anchor exists. Add a row here before printing a new reason anywhere.
 */
export type GateState = 'ran' | 'not_run' | 'unavailable';

export interface GateOutcome {
  state: GateState;
  /** Stable `<a id>` in docs/troubleshooting.md. */
  anchor: string;
  /** What happened, in plain words; `<detail>` adds the real value (exit code, stderr line). */
  summary: string;
  fix: string;
}

export const GATE_OUTCOMES = {
  sandbox_unavailable: {
    state: 'unavailable', anchor: 'codex-sandbox-unavailable',
    summary: "Codex's sandbox could not start here",
    fix: 'enable unprivileged user namespaces for this container, or set GSTACK_CODEX_NO_SANDBOX=1',
  },
  commands_failed: {
    state: 'unavailable', anchor: 'outside-review-commands-failed',
    summary: 'the reviewer could not run commands or read the diff',
    fix: 'read the reviewer stderr above, repair the environment it names, then re-run the review',
  },
  execution_failed: {
    state: 'unavailable', anchor: 'outside-review-execution-failed',
    summary: 'the reviewer process failed',
    fix: 'read the provider diagnosis above (auth, model, network), repair it, then re-run the review',
  },
  timeout: {
    state: 'unavailable', anchor: 'outside-review-timeout',
    summary: 'the reviewer hit its time limit and was stopped',
    fix: 're-run the review with a smaller scope, or check the provider status and network',
  },
  empty_response: {
    state: 'unavailable', anchor: 'outside-review-empty-response',
    summary: 'the reviewer returned no response',
    fix: 'read the reviewer stderr above, then re-run the review',
  },
  review_refused: {
    state: 'unavailable', anchor: 'outside-review-refused',
    summary: 'the reviewer declined to review',
    fix: 're-run the review; if it declines again, review the change natively',
  },
  missing_markers: {
    state: 'unavailable', anchor: 'outside-review-missing-markers',
    summary: 'the response lacks the markers this gate requires',
    fix: 're-run the review; a response without its required markers never counts as a pass',
  },
  untagged_review: {
    state: 'ran', anchor: 'outside-review-unverified',
    summary: 'the review completed without severity tags or an explicit no-findings line',
    fix: 'read the output above and decide; it is not a pass',
  },
  model_unusable: {
    state: 'unavailable', anchor: 'codex-model-unusable',
    summary: 'Codex could not use the selected model',
    fix: 'set GSTACK_CODEX_MODEL=<supported-model> or fix model (and base_url for a custom provider) in your Codex config.toml',
  },
  quota_exhausted: {
    state: 'unavailable', anchor: 'codex-quota-exhausted',
    summary: "Codex refused the call for this account's usage or rate limit",
    fix: "wait for the reset time in Codex's message above, or add credits or a higher plan for that account; the model choice is fine",
  },
  helper_unavailable: {
    state: 'unavailable', anchor: 'sourced-helper-location',
    summary: 'the gstack Codex helper could not be loaded into this shell',
    fix: 'run the skill from bash or zsh, or export GSTACK_ROOT=<install dir>; if the helper file is missing, re-run ./setup (https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#sourced-helper-location)',
  },
  probe_inconclusive: {
    state: 'ran', anchor: 'codex-mode-unverified',
    summary: 'the Codex model check timed out or hit a network error, so readiness is unverified',
    fix: 'nothing to do now; the review itself is still checked, and a failure there is reported',
  },
  auth_failed: {
    state: 'unavailable', anchor: 'codex-auth-failed',
    summary: 'no Codex credentials were found',
    fix: 'run codex login, or set the API key your Codex config.toml provider names in env_key',
  },
  disabled: {
    state: 'not_run', anchor: 'outside-review-disabled',
    summary: 'outside reviews are turned off (codex_reviews=disabled)',
    fix: 'gstack-config set codex_reviews enabled',
  },
  no_version_source: {
    state: 'not_run', anchor: 'ship-no-version-source',
    summary: 'no version source is configured, or release automation owns it',
    fix: 'create VERSION, or write the version file path (for example package.json) to .gstack/version-path',
  },
  version_source_broken: {
    state: 'unavailable', anchor: 'ship-version-source-broken',
    summary: 'the configured version file is missing, empty, unreadable or malformed',
    fix: 'fix that file, or correct --version-path / .gstack/version-path',
  },
  no_plan_bound: {
    state: 'not_run', anchor: 'plan-audit-not-run',
    summary: 'no plan is bound to this branch and no docs/designs/ file matches',
    fix: 'add "Plan: <path>" to the PR body, or run /autoplan',
  },
  bun_missing: {
    state: 'unavailable', anchor: 'learnings-bun-missing',
    summary: 'bun not found on PATH, so learnings (or the timeline) could not be read',
    fix: 'install Bun (https://bun.sh), then re-run ./setup',
  },
  learnings_unavailable: {
    state: 'unavailable', anchor: 'learnings-unavailable',
    summary: 'the learnings search failed, so prior learnings were not loaded',
    fix: 'read the reason in parentheses; install Bun if it is missing, then re-run ./setup',
  },
  tmpdir_unwritable: {
    state: 'unavailable', anchor: 'log-tmpdir-unwritable',
    summary: 'could not create a temp file in ${TMPDIR:-/tmp}, so the entry was not recorded',
    fix: 'point TMPDIR at a writable directory',
  },
  not_calibrated: {
    state: 'not_run', anchor: 'plan-tune-not-calibrated',
    summary: 'not calibrated: no recorded signals',
    fix: 'answer more registered questions; run gstack-developer-profile --derive to recount',
  },
  variant_save_failed: {
    state: 'unavailable', anchor: 'design-variant-save-failed',
    summary: 'the paid image was received but could not be saved to the output path (a recovery copy is in the temp dir)',
    fix: 'follow the printed fix (disk space, permissions or a new --output), then copy the recovery file from the printed path',
  },
  design_unavailable: {
    state: 'unavailable', anchor: 'design-not-available',
    summary: 'the design binary could not start (it exited, timed out, was killed at launch, or is not installed)',
    fix: 'cd <gstack checkout> && ./setup',
  },
  taste_profile_unavailable: {
    state: 'unavailable', anchor: 'design-taste-profile-unavailable',
    summary: 'the project slug could not be resolved, so your taste profile was not loaded',
    fix: 'run ./setup',
  },
  no_install_found: {
    state: 'unavailable', anchor: 'gstack-no-install-found',
    summary: 'no gstack install for this host was found from this shell',
    fix: './setup --host <host> from your gstack checkout; ./setup --status shows it',
  },
  db_unreachable: {
    state: 'unavailable', anchor: 'gbrain-db-unreachable',
    summary: 'the gbrain database host is unreachable; your gbrain config is unchanged',
    fix: 'check network or VPN, then re-run /sync-gbrain',
  },
  ingest_batch_refused: {
    state: 'unavailable', anchor: 'memory-ingest-unattributed-failures',
    summary: 'gbrain reported failures it did not attribute to a page, so nothing was marked saved',
    fix: 're-run /sync-gbrain; after three refusals gstack finds and sets aside the page that breaks the batch',
  },
  reconcile_not_run: {
    state: 'not_run', anchor: 'memory-reconcile-not-run',
    summary: 'the post-upgrade transcript check did not run (gbrain missing, or the brain is remote over HTTP)',
    fix: 'run /setup-gbrain, then gstack-memory-ingest --reconcile',
  },
  ingest_locked: {
    state: 'not_run', anchor: 'memory-ingest-locked',
    summary: 'another memory ingest is writing the state file',
    fix: 'wait for it to finish, then re-run /sync-gbrain',
  },
  ingest_state_unsaved: {
    state: 'unavailable', anchor: 'memory-ingest-state-unsaved',
    summary: 'the ingest state file could not be saved',
    fix: 'fix permissions or free disk space under your gstack state root, then re-run /sync-gbrain',
  },
  artifacts_not_indexed: {
    state: 'unavailable', anchor: 'gbrain-artifacts-not-indexed',
    summary: 'curated artifacts were pushed to git, but gbrain has 0 indexed pages for them',
    fix: 'gbrain sync --source <id>, then re-run /sync-gbrain',
  },
  dream_unscoped: {
    state: 'not_run', anchor: 'gbrain-dream-skipped',
    summary: 'the installed gbrain cannot run only the call-graph phase, and the full dream cycle takes about 35 minutes',
    fix: 'gstack-gbrain-install, then /sync-gbrain --dream',
  },
  cycle_freshness_unknown: {
    state: 'unavailable', anchor: 'gbrain-cycle-freshness-unknown',
    summary: 'the installed gbrain does not expose cycle_freshness, so call-graph status is unknown',
    fix: 'gstack-gbrain-install',
  },
  update_incomplete: {
    state: 'unavailable', anchor: 'auto-update-incomplete',
    summary: 'auto-update pulled gstack, but setup or migrations did not finish',
    fix: 'cd <gstack checkout> && ./setup',
  },
  cso_helper_unbuilt: {
    state: 'unavailable', anchor: 'cso-windows-msvc-compile',
    summary: 'MSVC is installed but the /cso native helper failed to compile',
    fix: 'fix the printed compiler error, then re-run ./setup',
  },
  chromium_path_failed: {
    state: 'unavailable', anchor: 'browse-chromium-path-failed',
    summary: 'the Chromium at GSTACK_CHROMIUM_PATH could not launch',
    fix: 'point GSTACK_CHROMIUM_PATH at a working Chromium, or unset GSTACK_CHROMIUM_PATH',
  },
} as const satisfies Record<string, GateOutcome>;

export type GateReason = keyof typeof GATE_OUTCOMES;

/** One user-facing line for an outcome that is not a clean `ran`. */
export function gateOutcomeLine(gate: string, reason: GateReason, detail?: string): string {
  const outcome: GateOutcome = GATE_OUTCOMES[reason];
  const what = detail ? `${outcome.summary} (${detail})` : outcome.summary;
  if (outcome.state === 'not_run') return `${gate}: not run (${what}). Fix: ${outcome.fix}.`;
  if (outcome.state === 'ran') return `${gate}: ran, verdict unverified (${what}). Fix: ${outcome.fix}.`;
  return `${gate} unavailable: ${what}. No review ran; this is missing coverage, not a pass. Fix: ${outcome.fix}.`;
}
