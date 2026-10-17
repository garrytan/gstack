# shellcheck shell=bash
# gstack-doctor-components.sh — GENERATED from lib/doctor-components.ts and
# lib/result-codes.ts by scripts/gen-doctor-components.ts (bun run gen:skill-docs). Do not edit; the
# freshness test is test/doctor-components.test.ts. Sourced by
# bin/gstack-doctor-check.sh; Bash 3.2 builtins only.

GSTACK_DOCTOR_COMPONENTS="claude codex patch codex-cli browse-bundle browser cso helpers runtime pins state-root privacy cores revision wrapper"
GSTACK_DOCTOR_CORE="runtime pins state-root privacy cores revision wrapper"
GSTACK_DOCTOR_HOSTS="claude codex"
GSTACK_DOCTOR_OPTIONAL="codex-cli cso"
GSTACK_DOCTOR_SKILLS="autoplan plan-ceo-review plan-eng-review plan-design-review plan-devex-review plan-tune office-hours spec review ship investigate codex cso browse qa qa-only design-review design-consultation design-html devex-review scrape skillify canary benchmark make-pdf diagram pair-agent open-gstack-browser setup-browser-cookies connect-chrome land-and-deploy benchmark-models careful claude-code context-restore context-save design-shotgun deslop-shared-libs document-generate document-release eval-plan freeze gstack-upgrade guard health ios-clean ios-design-review ios-fix ios-qa ios-sync landing-report learn retro setup-deploy setup-gbrain sync-gbrain test-audit unfreeze review-voice"
GSTACK_BROWSER_LAZY_REASON="lazy; gstack-browser-ensure installs on first use"
GSTACK_DOCTOR_HELPERS="gstack-pregate gstack-plan-reality gstack-artifact gstack-autoplan"

# gstack_doctor_component_title ID — the human title; returns 1 for an unknown id.
gstack_doctor_component_title() {
  case "$1" in
    claude) printf '%s' 'Claude skills' ;;
    codex) printf '%s' 'Codex skills' ;;
    patch) printf '%s' 'Astra behavioral patch in the Codex render' ;;
    codex-cli) printf '%s' 'Codex CLI (outside voice)' ;;
    browse-bundle) printf '%s' 'browse bundle' ;;
    browser) printf '%s' 'Chromium launch and render' ;;
    cso) printf '%s' 'CSO native helper' ;;
    helpers) printf '%s' 'read-only helpers (gstack-pregate sealed, gstack-plan-reality, gstack-artifact, gstack-autoplan reads)' ;;
    runtime) printf '%s' 'gstack runtime (Bun)' ;;
    pins) printf '%s' 'project pins' ;;
    state-root) printf '%s' 'state root' ;;
    privacy) printf '%s' 'privacy' ;;
    cores) printf '%s' 'cores' ;;
    revision) printf '%s' 'revision' ;;
    wrapper) printf '%s' 'Capy skill copy (bootstrapper revision)' ;;
    *) return 1 ;;
  esac
}

# gstack_doctor_component_kind ID — core | host | component | optional; returns 1 for an unknown id.
gstack_doctor_component_kind() {
  case "$1" in
    claude) printf '%s' 'host' ;;
    codex) printf '%s' 'host' ;;
    patch) printf '%s' 'component' ;;
    codex-cli) printf '%s' 'optional' ;;
    browse-bundle) printf '%s' 'component' ;;
    browser) printf '%s' 'component' ;;
    cso) printf '%s' 'optional' ;;
    helpers) printf '%s' 'component' ;;
    runtime) printf '%s' 'core' ;;
    pins) printf '%s' 'core' ;;
    state-root) printf '%s' 'core' ;;
    privacy) printf '%s' 'core' ;;
    cores) printf '%s' 'core' ;;
    revision) printf '%s' 'core' ;;
    wrapper) printf '%s' 'core' ;;
    *) return 1 ;;
  esac
}

# gstack_doctor_skill_requires SKILL — the non-core ids the skill needs; returns 1 for an unknown skill.
gstack_doctor_skill_requires() {
  case "$1" in
    autoplan|plan-ceo-review|plan-eng-review|plan-design-review|plan-devex-review|plan-tune|office-hours|spec|review|ship|investigate) printf '%s' 'claude codex patch' ;;
    codex) printf '%s' 'claude codex patch codex-cli' ;;
    cso) printf '%s' 'claude cso' ;;
    browse|qa|qa-only|design-review|design-consultation|design-html|devex-review|scrape|skillify|canary|benchmark|make-pdf|diagram|pair-agent|open-gstack-browser|setup-browser-cookies|connect-chrome|land-and-deploy) printf '%s' 'claude codex patch browse-bundle browser' ;;
    benchmark-models|careful|claude-code|context-restore|context-save|design-shotgun|deslop-shared-libs|document-generate|document-release|eval-plan|freeze|gstack-upgrade|guard|health|ios-clean|ios-design-review|ios-fix|ios-qa|ios-sync|landing-report|learn|retro|setup-deploy|setup-gbrain|sync-gbrain|test-audit|unfreeze) printf '%s' 'claude' ;;
    review-voice) printf '%s' 'helpers' ;;
    *) return 1 ;;
  esac
}

# gstack_doctor_skill_optional SKILL — ids that SKIP when absent; returns 1 for an unknown skill.
gstack_doctor_skill_optional() {
  case "$1" in
    autoplan|plan-ceo-review|plan-eng-review|plan-design-review|plan-devex-review|plan-tune|office-hours|spec|review|ship|investigate) printf '%s' 'codex-cli' ;;
    codex) printf '%s' '' ;;
    cso) printf '%s' '' ;;
    browse|qa|qa-only|design-review|design-consultation|design-html|devex-review|scrape|skillify|canary|benchmark|make-pdf|diagram|pair-agent|open-gstack-browser|setup-browser-cookies|connect-chrome|land-and-deploy) printf '%s' 'codex-cli' ;;
    benchmark-models|careful|claude-code|context-restore|context-save|design-shotgun|deslop-shared-libs|document-generate|document-release|eval-plan|freeze|gstack-upgrade|guard|health|ios-clean|ios-design-review|ios-fix|ios-qa|ios-sync|landing-report|learn|retro|setup-deploy|setup-gbrain|sync-gbrain|test-audit|unfreeze) printf '%s' '' ;;
    review-voice) printf '%s' '' ;;
    *) return 1 ;;
  esac
}

# gstack_doctor_skill_pins_advisory SKILL — true for a planning-only workflow (a repo test-pin mismatch SKIPs pins).
gstack_doctor_skill_pins_advisory() {
  case "$1" in
    autoplan|plan-ceo-review|plan-eng-review|plan-design-review|plan-devex-review|office-hours) return 0 ;;
    *) return 1 ;;
  esac
}

# gstack_doctor_install_profile NAME — true for an install profile (helper runtime: no ./setup, no host profiles, project pins not applied).
gstack_doctor_install_profile() {
  case "$1" in
    review-voice) return 0 ;;
    *) return 1 ;;
  esac
}

# gstack_capy_bootstrap_cmd ROOT [SKILL] — the install command for a machine without the Drive skill (capyBootstrapCommand).
gstack_capy_bootstrap_cmd() {
  printf 'test -f "%s/setup" || git clone --quiet --single-branch --depth 1 %s "%s" && GSTACK_CAPY_ROOT="%s" bash "%s/capy/skill/gstack/scripts/install.sh"' "$1" 'https://github.com/garrytan/gstack.git' "$1" "$1" "$1"
  [ -z "${2:-}" ] || printf ' --for %s' "$2"
}

# gstack_result_anchor CODE — the docs/troubleshooting.md anchor for a lib/result-codes.ts code; returns 1 for an unknown code.
gstack_result_anchor() {
  case "$1" in
    ARTIFACT_INVALID_JSON) printf '%s' 'artifact-invalid-json' ;;
    ARTIFACT_UNSUPPORTED_VERSION) printf '%s' 'artifact-unsupported-version' ;;
    ARTIFACT_SCHEMA) printf '%s' 'artifact-schema' ;;
    ARTIFACT_MISSING) printf '%s' 'artifact-missing' ;;
    ARTIFACT_STALE) printf '%s' 'artifact-stale' ;;
    ARTIFACT_PATH_ESCAPE) printf '%s' 'artifact-path-escape' ;;
    ARTIFACT_MALFORMED_JSONL) printf '%s' 'artifact-malformed-jsonl' ;;
    ARTIFACT_DUPLICATE_ID) printf '%s' 'artifact-duplicate-id' ;;
    ARTIFACT_UNBOUND_ID) printf '%s' 'artifact-unbound-id' ;;
    ARTIFACT_DANGLING_REF) printf '%s' 'artifact-dangling-ref' ;;
    ARTIFACT_DEPENDENCY_CYCLE) printf '%s' 'artifact-dependency-cycle' ;;
    ARTIFACT_COUNT_MISMATCH) printf '%s' 'artifact-count-mismatch' ;;
    ARTIFACT_RUN_INTERRUPTED) printf '%s' 'artifact-run-interrupted' ;;
    ARTIFACT_REVIEWER_MISSING) printf '%s' 'artifact-reviewer-missing' ;;
    ARTIFACT_GUARD_LINE_MISSING) printf '%s' 'artifact-guard-line-missing' ;;
    GUARD_NOT_INSTALLED) printf '%s' 'guard-not-installed' ;;
    REVIEW_STATUS_MISMATCH) printf '%s' 'review-status-mismatch' ;;
    GATE_REV_STALE) printf '%s' 'gate-rev-stale' ;;
    GATE_REPLY_UNPARSED) printf '%s' 'gate-reply-unparsed' ;;
    ANSWER_BY_REQUIRED) printf '%s' 'answer-by-required' ;;
    COMPONENT_MISSING) printf '%s' 'doctor-component-missing' ;;
    RUNTIME_BELOW_MINIMUM) printf '%s' 'doctor-runtime-below-minimum' ;;
    PROJECT_PIN_MISMATCH) printf '%s' 'doctor-project-pin-mismatch' ;;
    REVISION_UNMET) printf '%s' 'doctor-revision-unmet' ;;
    RUNTIME_PIN_CONFLICT) printf '%s' 'capy-install-runtime-conflict' ;;
    BROWSER_UNAVAILABLE) printf '%s' 'browser-ensure-failed' ;;
    INSTALL_PREFLIGHT_FAILED) printf '%s' 'capy-install-preflight-failed' ;;
    SETUP_PS1_EMPTY_ARGUMENT) printf '%s' 'setup-ps1-empty-argument' ;;
    POLICY_SOURCE_UNAVAILABLE) printf '%s' 'policy-source-unavailable' ;;
    POLICY_INVALID) printf '%s' 'policy-invalid' ;;
    POLICY_CONTAINMENT) printf '%s' 'policy-containment' ;;
    POLICY_EXISTS) printf '%s' 'policy-exists' ;;
    REPO_COMMANDS_NOT_ALLOWED) printf '%s' 'repo-commands-not-allowed' ;;
    QUEUE_STALE) printf '%s' 'queue-stale' ;;
    RESTAMP_VERSION_SOURCE) printf '%s' 'restamp-version-source' ;;
    RESTAMP_MERGE_CONFLICT) printf '%s' 'restamp-merge-conflict' ;;
    RESTAMP_RELEASE_TOOL_FAILED) printf '%s' 'restamp-release-tool-failed' ;;
    RESTAMP_OUTPUT_OUTSIDE_ALLOWED) printf '%s' 'restamp-output-outside-allowed' ;;
    RESTAMP_CONFLICT) printf '%s' 'restamp-conflict' ;;
    RESTAMP_PREDECESSOR_MOVED) printf '%s' 'restamp-predecessor-moved' ;;
    CHANGELOG_DUPLICATE_HEADING) printf '%s' 'changelog-duplicate-heading' ;;
    CHANGELOG_TOP_MISMATCH) printf '%s' 'changelog-top-mismatch' ;;
    CHANGELOG_SECTION_MISSING) printf '%s' 'changelog-section-missing' ;;
    GATE_REUSE_NOT_ELIGIBLE) printf '%s' 'gate-reuse-not-eligible' ;;
    EVIDENCE_IDENTITY_UNKNOWN) printf '%s' 'evidence-identity-unknown' ;;
    EVIDENCE_BUNDLE_INVALID) printf '%s' 'evidence-bundle-invalid' ;;
    PREREGISTRATION_NOT_ANCESTOR) printf '%s' 'preregistration-not-ancestor' ;;
    HISTORY_POLICY_VIOLATION) printf '%s' 'history-policy-violation' ;;
    RECEIPT_MISSING) printf '%s' 'receipt-missing' ;;
    RECEIPT_INVALID) printf '%s' 'receipt-invalid' ;;
    EXECUTION_UNKNOWN) printf '%s' 'execution-unknown' ;;
    RUN_LOCKED) printf '%s' 'run-locked' ;;
    RUN_NOT_INITIALIZED) printf '%s' 'run-not-initialized' ;;
    PHASE_NOT_AWAITING) printf '%s' 'phase-not-awaiting' ;;
    ATTEMPT_MISMATCH) printf '%s' 'attempt-mismatch' ;;
    RESULT_RECEIPT_MISSING) printf '%s' 'result-receipt-missing' ;;
    RESULT_FINDINGS_MISSING) printf '%s' 'result-findings-missing' ;;
    MODEL_FAMILY_CONFLICT) printf '%s' 'model-family-conflict' ;;
    SPEND_CAP_EXCEEDED) printf '%s' 'spend-cap-exceeded' ;;
    CONSENSUS_MISSING) printf '%s' 'consensus-missing' ;;
    OUTSIDE_RUNNER_UNAVAILABLE) printf '%s' 'outside-runner-unavailable' ;;
    REALITY_ROW_MISSING) printf '%s' 'reality-row-missing' ;;
    REALITY_RECEIPT_MISSING) printf '%s' 'reality-receipt-missing' ;;
    REGEN_REGISTRY_INVALID) printf '%s' 'regen-registry-invalid' ;;
    REGEN_CONTAINMENT) printf '%s' 'regen-containment' ;;
    REGEN_STALE) printf '%s' 'regen-stale' ;;
    REGEN_COMMAND_FAILED) printf '%s' 'regen-command-failed' ;;
    PREGATE_CONFIG_INVALID) printf '%s' 'pregate-config-invalid' ;;
    PREGATE_SECRETS) printf '%s' 'pregate-secrets' ;;
    PREGATE_STRAYS) printf '%s' 'pregate-strays' ;;
    PREGATE_LITERALS) printf '%s' 'pregate-literals' ;;
    PREGATE_NO_LANE) printf '%s' 'pregate-no-lane' ;;
    PREGATE_LANE_FAILED) printf '%s' 'pregate-lane-failed' ;;
    PREGATE_INCOMPLETE) printf '%s' 'pregate-incomplete' ;;
    PREGATE_STALLED) printf '%s' 'pregate-stalled' ;;
    PREGATE_RECEIPT_INVALID) printf '%s' 'pregate-receipt-invalid' ;;
    PREGATE_STALE) printf '%s' 'pregate-stale' ;;
    PREGATE_REMOTE_UNCLEARED) printf '%s' 'pregate-remote-uncleared' ;;
    ISSUE_UNREADABLE) printf '%s' 'issue-unreadable' ;;
    ISSUE_LOOKUP_FAILED) printf '%s' 'issue-lookup-failed' ;;
    ISSUE_LINKS_MISSING) printf '%s' 'issue-links-missing' ;;
    PREREG_INCOMPLETE) printf '%s' 'prereg-incomplete' ;;
    EVAL_PRICE_MISSING) printf '%s' 'eval-price-missing' ;;
    EVAL_DRY_RUN_FAILED) printf '%s' 'eval-dry-run-failed' ;;
    EVAL_ARMS_UNRESOLVED) printf '%s' 'eval-arms-unresolved' ;;
    EVAL_BUDGET_EXHAUSTED) printf '%s' 'eval-budget-exhausted' ;;
    LANE_CONFLICT) printf '%s' 'lane-conflict' ;;
    LANE_REF_UNAVAILABLE) printf '%s' 'lane-ref-unavailable' ;;
    EVIDENCE_UNVERIFIED) printf '%s' 'evidence-unverified' ;;
    BANNED_TERM_FOUND) printf '%s' 'banned-term-found' ;;
    BANNED_TERMS_INVALID) printf '%s' 'banned-terms-invalid' ;;
    CONTRIBUTOR_SOURCE_UNAVAILABLE) printf '%s' 'contributor-source-unavailable' ;;
    BRIEF_INPUT_MISSING) printf '%s' 'brief-input-missing' ;;
    DRAFT_DIRECTION_UNRESOLVED) printf '%s' 'draft-direction-unresolved' ;;
    PREGATE_GUARD_FAILED) printf '%s' 'pregate-guard-failed' ;;
    MIGRATION_COLLISION) printf '%s' 'migration-collision' ;;
    SEALED_OUTPUT_REFUSED) printf '%s' 'sealed-output-refused' ;;
    EVAL_GATE_UNPRICED) printf '%s' 'eval-gate-unpriced' ;;
    EVAL_GATE_OVER_CAP) printf '%s' 'eval-gate-over-cap' ;;
    EVAL_PLAN_STALE) printf '%s' 'eval-plan-stale' ;;
    PLAN_SECTIONS_INVALID) printf '%s' 'plan-sections-invalid' ;;
    PLAN_AMEND_PENDING) printf '%s' 'plan-amend-pending' ;;
    AMENDMENT_UNKNOWN) printf '%s' 'amendment-unknown' ;;
    AMENDMENT_NOT_SETTLEABLE) printf '%s' 'amendment-not-settleable' ;;
    GATE_REC_STALE) printf '%s' 'gate-rec-stale' ;;
    CHECKPOINT_INVALID) printf '%s' 'checkpoint-invalid' ;;
    CHECKPOINT_OVERLAP) printf '%s' 'checkpoint-overlap' ;;
    CHECKPOINT_TARGET_EXISTS) printf '%s' 'checkpoint-target-exists' ;;
    OWNER_REPLY_REQUIRED) printf '%s' 'owner-reply-required' ;;
    GATE_OWNER_REPLY_MISMATCH) printf '%s' 'gate-owner-reply-mismatch' ;;
    GSTACK_VERSION_CHANGED) printf '%s' 'gstack-version-changed' ;;
    ARTIFACT_GATE_UNSETTLED) printf '%s' 'artifact-gate-unsettled' ;;
    UPGRADE_REFUSED) printf '%s' 'upgrade-refused' ;;
    UPGRADE_BUSY) printf '%s' 'upgrade-busy' ;;
    UPGRADE_FETCH_FAILED) printf '%s' 'upgrade-fetch-failed' ;;
    REVISION_BELOW_MINIMUM) printf '%s' 'revision-below-minimum' ;;
    CAPY_WRAPPER_STALE) printf '%s' 'capy-wrapper-stale' ;;
    BUN_RESOLUTION_DRIFT) printf '%s' 'bun-resolution-drift' ;;
    BUN_INSTALL_VERSION_INVALID) printf '%s' 'bun-install-version-invalid' ;;
    INSTALL_UNVERIFIED) printf '%s' 'install-unverified' ;;
    BROWSE_TAB_UNRECOVERABLE) printf '%s' 'browse-tab-unrecoverable' ;;
    BUN_VERSION_UNREADABLE) printf '%s' 'bun-version-unreadable' ;;
    BASH_UNAVAILABLE) printf '%s' 'bash-unavailable' ;;
    IOS_LAUNCH_ENV_INVALID) printf '%s' 'ios-launch-env-invalid' ;;
    OUTSIDE_VOICE_UNAVAILABLE) printf '%s' 'outside-voice-unavailable' ;;
    ARTIFACT_MACHINE_PATH) printf '%s' 'artifact-machine-path' ;;
    ARTIFACT_PUBLIC_TARGET_EXISTS) printf '%s' 'artifact-public-target-exists' ;;
    PREREG_DIAGNOSTIC_UNTESTED) printf '%s' 'prereg-diagnostic-untested' ;;
    EVAL_MODELS_INVALID) printf '%s' 'eval-models-invalid' ;;
    EVAL_MODEL_DENIED) printf '%s' 'eval-model-denied' ;;
    EVAL_MODEL_OLD_GENERATION) printf '%s' 'eval-model-old-generation' ;;
    EVAL_MODEL_GENERATION_UNRESOLVED) printf '%s' 'eval-model-generation-unresolved' ;;
    DX_CAPTURE_USAGE) printf '%s' 'dx-capture-usage' ;;
    DX_CAPTURE_BAD_DEADLINE) printf '%s' 'dx-capture-bad-deadline' ;;
    DX_CAPTURE_BAD_MAX_BYTES) printf '%s' 'dx-capture-bad-max-bytes' ;;
    DX_CAPTURE_BAD_PASS_ENV) printf '%s' 'dx-capture-bad-pass-env' ;;
    DX_CAPTURE_BAD_CWD) printf '%s' 'dx-capture-bad-cwd' ;;
    DX_CAPTURE_APPROVAL_REQUIRED) printf '%s' 'dx-capture-approval-required' ;;
    DX_CAPTURE_CONFIG_REFUSED) printf '%s' 'dx-capture-config-refused' ;;
    DX_CAPTURE_NOT_FOUND) printf '%s' 'dx-capture-not-found' ;;
    DX_CAPTURE_TEMP_DIR) printf '%s' 'dx-capture-temp-dir' ;;
    DX_CAPTURE_CONTAINMENT_UNAVAILABLE) printf '%s' 'dx-capture-containment-unavailable' ;;
    DX_CAPTURE_SUPERVISOR_FAILED) printf '%s' 'dx-capture-supervisor-failed' ;;
    DX_CAPTURE_INTERRUPTED) printf '%s' 'dx-capture-interrupted' ;;
    DX_CAPTURE_REDACTION_FAILED) printf '%s' 'dx-capture-redaction-failed' ;;
    DX_CAPTURE_INTERNAL) printf '%s' 'dx-capture-internal' ;;
    POLICY_GSTACK_TOO_OLD) printf '%s' 'policy-gstack-too-old' ;;
    QUEUE_NOT_READY) printf '%s' 'queue-not-ready' ;;
    QUEUE_PROOF_MISSING) printf '%s' 'queue-proof-missing' ;;
    QUEUE_STAMP_NOT_STAMP_ONLY) printf '%s' 'queue-stamp-not-stamp-only' ;;
    QUEUE_VERIFY_MISMATCH) printf '%s' 'queue-verify-mismatch' ;;
    QUEUE_GATE_MISSING) printf '%s' 'queue-gate-missing' ;;
    GATE_AHEAD_ATTEMPT_INVALID) printf '%s' 'gate-ahead-attempt-invalid' ;;
    PREGATE_TIMING_ASSERTION) printf '%s' 'pregate-timing-assertion' ;;
    APPROVAL_CLASSES_INVALID) printf '%s' 'approval-classes-invalid' ;;
    APPROVAL_CLASS_FOUND) printf '%s' 'approval-class-found' ;;
    APPROVAL_CITATION_MISSING) printf '%s' 'approval-citation-missing' ;;
    APPROVAL_SOURCE_UNAVAILABLE) printf '%s' 'approval-source-unavailable' ;;
    STATE_MATRIX_INCOMPLETE) printf '%s' 'state-matrix-incomplete' ;;
    WTREE_UNAVAILABLE) printf '%s' 'wtree-unavailable' ;;
    REGEN_DEPS_MISSING) printf '%s' 'regen-deps-missing' ;;
    *) return 1 ;;
  esac
}
