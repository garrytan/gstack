#!/usr/bin/env bash
# Migration: v1.58.0.0 — register the PreToolUse AskUserQuestion hook for
# existing Conductor installs.
#
# Why a migration: v1.58 makes the PreToolUse question-preference-hook also
# deny the flaky Conductor AskUserQuestion and redirect to a prose decision
# brief. But setup's hook-install block skips silently in non-interactive
# (conductor/CI) setups, and existing users who previously declined plan-tune
# hooks would never pick up the new Conductor backstop. This re-registers the
# hook for Conductor users so layer 3 actually deploys.
#
# Affected: users who run gstack inside Conductor and don't already have the
# PreToolUse hook installed.
#
# Scope guard: only acts inside a Conductor session (CONDUCTOR_* present) and
# never overrides an explicit `plan_tune_hooks` opt-out.
#
# Idempotent: gstack-settings-hook dedupes by (event, matcher, source), and a
# .done touchfile gates re-runs.

set -u

GSTACK_HOME="${HOME}/.gstack"
MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.58.0.0.done"
mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
[ -f "${DONE}" ] && exit 0

# Only relevant inside Conductor — the prose-default behavior is Conductor-scoped.
if [ -z "${CONDUCTOR_WORKSPACE_PATH:-}" ] && [ -z "${CONDUCTOR_PORT:-}" ]; then
  touch "${DONE}"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SETTINGS_HOOK="${SCRIPT_DIR}/bin/gstack-settings-hook"
PREF_HOOK="${SCRIPT_DIR}/hosts/claude/hooks/question-preference-hook"
CONFIG_BIN="${SCRIPT_DIR}/bin/gstack-config"

# Respect an explicit opt-out — don't force a hook on a user who said no.
_PT=$("${CONFIG_BIN}" get plan_tune_hooks 2>/dev/null || echo "")
_PT=$(printf '%s' "${_PT}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
case "${_PT}" in
  n|no|false|skip|off|0)
    echo "  [v1.58.0.0] plan_tune_hooks opted out — leaving Conductor on guidance-only prose." >&2
    touch "${DONE}"
    exit 0
    ;;
esac

if [ -x "${SETTINGS_HOOK}" ] && [ -x "${PREF_HOOK}" ]; then
  "${SETTINGS_HOOK}" add-event \
    --event PreToolUse \
    --matcher '(AskUserQuestion|mcp__.*__AskUserQuestion)' \
    --command "${PREF_HOOK}" \
    --source plan-tune-cathedral \
    --timeout 5 2>/dev/null \
    && echo "  [v1.58.0.0] Conductor AskUserQuestion prose hook registered (PreToolUse)." >&2 \
    || echo "  [v1.58.0.0] WARN: could not register the PreToolUse hook; run ./setup --plan-tune-hooks." >&2
fi

touch "${DONE}"
exit 0
