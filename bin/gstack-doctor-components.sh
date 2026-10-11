# shellcheck shell=bash
# gstack-doctor-components.sh — GENERATED from lib/doctor-components.ts and
# lib/result-codes.ts by scripts/gen-doctor-components.ts (bun run gen:skill-docs). Do not edit; the
# freshness test is test/doctor-components.test.ts. Sourced by
# bin/gstack-doctor-check.sh; Bash 3.2 builtins only.

GSTACK_DOCTOR_COMPONENTS="claude codex patch codex-cli browse-bundle browser cso runtime pins state-root privacy cores revision"
GSTACK_DOCTOR_CORE="runtime pins state-root privacy cores revision"
GSTACK_DOCTOR_HOSTS="claude codex"
GSTACK_DOCTOR_OPTIONAL="codex-cli cso"
GSTACK_DOCTOR_SKILLS="autoplan plan-ceo-review plan-eng-review plan-design-review plan-devex-review plan-tune office-hours spec review ship investigate codex cso browse qa qa-only design-review design-consultation design-html devex-review scrape skillify canary benchmark make-pdf diagram pair-agent open-gstack-browser setup-browser-cookies connect-chrome land-and-deploy benchmark-models careful claude-code context-restore context-save design-shotgun deslop-shared-libs document-generate document-release freeze gstack-upgrade guard health ios-clean ios-design-review ios-fix ios-qa ios-sync landing-report learn retro setup-deploy setup-gbrain sync-gbrain test-audit unfreeze"
GSTACK_BROWSER_LAZY_REASON="lazy; gstack-browser-ensure installs on first use"

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
    runtime) printf '%s' 'gstack runtime (Bun)' ;;
    pins) printf '%s' 'project pins' ;;
    state-root) printf '%s' 'state root' ;;
    privacy) printf '%s' 'privacy' ;;
    cores) printf '%s' 'cores' ;;
    revision) printf '%s' 'revision' ;;
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
    runtime) printf '%s' 'core' ;;
    pins) printf '%s' 'core' ;;
    state-root) printf '%s' 'core' ;;
    privacy) printf '%s' 'core' ;;
    cores) printf '%s' 'core' ;;
    revision) printf '%s' 'core' ;;
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
    benchmark-models|careful|claude-code|context-restore|context-save|design-shotgun|deslop-shared-libs|document-generate|document-release|freeze|gstack-upgrade|guard|health|ios-clean|ios-design-review|ios-fix|ios-qa|ios-sync|landing-report|learn|retro|setup-deploy|setup-gbrain|sync-gbrain|test-audit|unfreeze) printf '%s' 'claude' ;;
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
    benchmark-models|careful|claude-code|context-restore|context-save|design-shotgun|deslop-shared-libs|document-generate|document-release|freeze|gstack-upgrade|guard|health|ios-clean|ios-design-review|ios-fix|ios-qa|ios-sync|landing-report|learn|retro|setup-deploy|setup-gbrain|sync-gbrain|test-audit|unfreeze) printf '%s' '' ;;
    *) return 1 ;;
  esac
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
    COMPONENT_MISSING) printf '%s' 'doctor-component-missing' ;;
    RUNTIME_BELOW_MINIMUM) printf '%s' 'doctor-runtime-below-minimum' ;;
    PROJECT_PIN_MISMATCH) printf '%s' 'doctor-project-pin-mismatch' ;;
    REVISION_UNMET) printf '%s' 'doctor-revision-unmet' ;;
    RUNTIME_PIN_CONFLICT) printf '%s' 'capy-install-runtime-conflict' ;;
    BROWSER_UNAVAILABLE) printf '%s' 'browser-ensure-failed' ;;
    INSTALL_PREFLIGHT_FAILED) printf '%s' 'capy-install-preflight-failed' ;;
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
    *) return 1 ;;
  esac
}
