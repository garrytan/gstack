#!/usr/bin/env bash
# Migration: v1.60.2.0 — normalize AskUserQuestion hooks after Claude stripped
# `_gstack_source` from some settings entries. Re-registering through the
# schema-aware helper adopts exact-command matches and collapses duplicates.

set -u

GSTACK_HOME="${HOME}/.gstack"
MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.60.2.0.done"
mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
[ -f "${DONE}" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SETTINGS_HOOK="${SCRIPT_DIR}/bin/gstack-settings-hook"
CONFIG_BIN="${SCRIPT_DIR}/bin/gstack-config"
PREF_HOOK="${SCRIPT_DIR}/hosts/claude/hooks/question-preference-hook"
LOG_HOOK="${SCRIPT_DIR}/hosts/claude/hooks/question-log-hook"
FALLBACK_HOOK="${SCRIPT_DIR}/hosts/claude/hooks/auq-error-fallback-hook"
MATCHER='(AskUserQuestion|mcp__.*__AskUserQuestion)'

_PT=$("${CONFIG_BIN}" get plan_tune_hooks 2>/dev/null || echo "")
_PT=$(printf '%s' "${_PT}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
case "${_PT}" in
  n|no|false|skip|off|0)
    echo "  [v1.60.2.0] plan_tune_hooks opted out; AskUserQuestion hooks unchanged." >&2
    touch "${DONE}"
    exit 0
    ;;
esac

# Existing Conductor installs need the popup routing hooks even when their saved
# config is still the default `prompt`. Outside Conductor, only an explicit opt-in
# authorizes settings changes during upgrade.
case "${_PT}" in
  y|yes|true|install|on|1) _SHOULD_NORMALIZE=1 ;;
  *)
    if [ -n "${CONDUCTOR_WORKSPACE_PATH:-}" ] || [ -n "${CONDUCTOR_PORT:-}" ]; then
      _SHOULD_NORMALIZE=1
    else
      _SHOULD_NORMALIZE=0
    fi
    ;;
esac

if [ "${_SHOULD_NORMALIZE}" -ne 1 ]; then
  touch "${DONE}"
  exit 0
fi

for executable in "${SETTINGS_HOOK}" "${PREF_HOOK}" "${LOG_HOOK}" "${FALLBACK_HOOK}"; do
  if [ ! -x "${executable}" ]; then
    echo "  [v1.60.2.0] WARN: missing executable ${executable}; migration will retry later." >&2
    exit 0
  fi
done

_OK=1
"${SETTINGS_HOOK}" add-event \
  --event PreToolUse \
  --matcher "${MATCHER}" \
  --command "${PREF_HOOK}" \
  --source plan-tune-cathedral \
  --timeout 5 >/dev/null || _OK=0
"${SETTINGS_HOOK}" add-event \
  --event PostToolUse \
  --matcher "${MATCHER}" \
  --command "${LOG_HOOK}" \
  --source plan-tune-cathedral \
  --timeout 5 >/dev/null || _OK=0
"${SETTINGS_HOOK}" add-event \
  --event PostToolUse \
  --matcher "${MATCHER}" \
  --command "${FALLBACK_HOOK}" \
  --source auq-error-fallback \
  --timeout 5 >/dev/null || _OK=0

if [ "${_OK}" -eq 1 ]; then
  touch "${DONE}"
  echo "  [v1.60.2.0] AskUserQuestion hooks normalized for clickable host popups." >&2
else
  echo "  [v1.60.2.0] WARN: hook normalization was incomplete; migration will retry later." >&2
fi

exit 0
