#!/usr/bin/env bash
# Migration: v1.61.0.1 — repair artifact privacy metadata skipped by v1.38.1.0
# when jq was unavailable, including the later eng-review test-plan pattern.
#
# Affected: existing artifact-sync installs whose .brain-privacy-map.json was
# present while a historical migration could not use jq. This script is listed
# in retry-until-done.txt: it writes its done marker only after every existing
# applicable file is correct, so a later setup can safely retry it.
#
# Privacy boundary: local state only. This never enables sync, reads artifact
# contents, contacts a remote, commits, or pushes.

set -u

if [ -z "${GSTACK_HOME:-}" ] && [ -z "${HOME:-}" ]; then
  echo "  [v1.61.0.1] WARN: HOME is unset; migration will retry when a state home is available." >&2
  exit 0
fi

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
ALLOWLIST="$GSTACK_HOME/.brain-allowlist"
PRIVACY="$GSTACK_HOME/.brain-privacy-map.json"
GITATTRS="$GSTACK_HOME/.gitattributes"
MIGRATION_DIR="$GSTACK_HOME/.migrations"
DONE="$MIGRATION_DIR/v1.61.0.1.done"

if ! mkdir -p "$MIGRATION_DIR" 2>/dev/null; then
  echo "  [v1.61.0.1] WARN: cannot create migration state; will retry on a later setup." >&2
  exit 0
fi
[ -f "$DONE" ] && exit 0

PATTERNS=(
  'projects/*/*-design-*.md'
  'projects/*/*-test-plan-*.md'
  'projects/*/*-eng-review-test-plan-*.md'
)

added_any=0
incomplete=0

repair_allowlist() {
  local pattern="$1"
  [ -f "$ALLOWLIST" ] || return 0
  if grep -Fqx -- "$pattern" "$ALLOWLIST" 2>/dev/null; then
    return 0
  fi
  if grep -q '^# ---- USER ADDITIONS BELOW' "$ALLOWLIST" 2>/dev/null; then
    if sed -i.bak "/^# ---- USER ADDITIONS BELOW/i\\
$pattern
" "$ALLOWLIST" 2>/dev/null; then
      rm -f "$ALLOWLIST.bak" 2>/dev/null || true
      added_any=1
    else
      rm -f "$ALLOWLIST.bak" 2>/dev/null || true
      echo "  [v1.61.0.1] WARN: allowlist repair deferred; will retry on a later setup." >&2
      incomplete=1
    fi
  elif printf '%s\n' "$pattern" >> "$ALLOWLIST" 2>/dev/null; then
    added_any=1
  else
    echo "  [v1.61.0.1] WARN: allowlist repair deferred; will retry on a later setup." >&2
    incomplete=1
  fi
}

repair_gitattributes() {
  local pattern="$1"
  local rule="$pattern merge=union"
  [ -f "$GITATTRS" ] || return 0
  if grep -Fqx -- "$rule" "$GITATTRS" 2>/dev/null; then
    return 0
  fi
  if printf '%s\n' "$rule" >> "$GITATTRS" 2>/dev/null; then
    added_any=1
  else
    echo "  [v1.61.0.1] WARN: gitattributes repair deferred; will retry on a later setup." >&2
    incomplete=1
  fi
}

for pattern in "${PATTERNS[@]}"; do
  repair_allowlist "$pattern"
  repair_gitattributes "$pattern"
done

if [ -f "$PRIVACY" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "  [v1.61.0.1] WARN: jq is required to verify local privacy metadata; install jq and run setup again." >&2
    incomplete=1
  elif ! jq -e 'type == "array"' "$PRIVACY" >/dev/null 2>&1; then
    echo "  [v1.61.0.1] WARN: privacy metadata is not a valid JSON array; leaving it unchanged for manual repair." >&2
    incomplete=1
  else
    for pattern in "${PATTERNS[@]}"; do
      # Presence, rather than a forced class rewrite, preserves an operator's
      # existing privacy classification for a matching custom pattern.
      if jq -e --arg p "$pattern" 'map(select(.pattern == $p)) | length > 0' "$PRIVACY" >/dev/null 2>&1; then
        continue
      fi
      tmp=$(mktemp "$PRIVACY.tmp.XXXXXX" 2>/dev/null || true)
      if [ -z "$tmp" ] || [ ! -f "$tmp" ]; then
        echo "  [v1.61.0.1] WARN: privacy metadata repair deferred; will retry on a later setup." >&2
        incomplete=1
        continue
      fi
      if ! jq --arg p "$pattern" '. += [{"pattern": $p, "class": "artifact"}]' "$PRIVACY" > "$tmp" 2>/dev/null; then
        rm -f "$tmp" 2>/dev/null || true
        echo "  [v1.61.0.1] WARN: privacy metadata transformation failed; will retry on a later setup." >&2
        incomplete=1
      elif ! jq -e 'type == "array"' "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp" 2>/dev/null || true
        echo "  [v1.61.0.1] WARN: privacy metadata output validation failed; will retry on a later setup." >&2
        incomplete=1
      elif ! mv "$tmp" "$PRIVACY" 2>/dev/null; then
        rm -f "$tmp" 2>/dev/null || true
        echo "  [v1.61.0.1] WARN: privacy metadata replacement failed; will retry on a later setup." >&2
        incomplete=1
      else
        added_any=1
      fi
    done
  fi
fi

if [ "$incomplete" = "0" ]; then
  touch "$DONE"
  if [ "$added_any" = "1" ]; then
    echo "  [v1.61.0.1] repaired local artifact metadata (idempotent)." >&2
  fi
else
  echo "  [v1.61.0.1] INFO: completion marker not written; the audited migration retry will continue after prerequisites are met." >&2
fi

exit 0
