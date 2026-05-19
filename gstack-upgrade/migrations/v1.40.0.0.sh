#!/usr/bin/env bash
# Migration: v1.40.0.0 — add eng-review-test-plan project-root pattern to
# .brain-allowlist, .brain-privacy-map.json, and .gitattributes (#1452 follow-on).
#
# Why a second migration: v1.38.1.0 shipped two of three filenames for #1452
# (`*-design-*.md` and `*-test-plan-*.md`) but missed `/plan-eng-review`'s
# actual filename: `*-eng-review-test-plan-*.md`. The v1.38.1.0 migration has
# a done-marker, so a "fix v1.38.1.0 and re-run" approach silently no-ops on
# existing users. v1.40.0.0 needs its own migration to patch installs that
# already ran v1.38.1.0.
#
# Per-file independent — if one file is missing we still repair the others.
#
# Idempotent: each insertion is gated on `not already present` so re-running
# the migration is a no-op.

set -u

GSTACK_HOME="${HOME}/.gstack"
ALLOWLIST="${GSTACK_HOME}/.brain-allowlist"
PRIVACY="${GSTACK_HOME}/.brain-privacy-map.json"
GITATTRS="${GSTACK_HOME}/.gitattributes"

MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.40.0.0.done"

mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
if [ -f "${DONE}" ]; then
  exit 0
fi

NEW_PATTERNS=(
  'projects/*/*-eng-review-test-plan-*.md'
)

added_any=0
# Set to 1 if a required step had to be skipped (e.g. jq missing for the
# privacy-map patch). We do NOT write the done-marker in that case — so the
# next /gstack-upgrade run will retry against an environment with jq
# installed. See #1581: previously the done-marker was written
# unconditionally, which silently dropped the privacy-map repair on boxes
# without jq and federation sync kept missing eng-review test plans.
skipped_required=0

# ----- .brain-allowlist ---------------------------------------------------
if [ -f "${ALLOWLIST}" ]; then
  for PATTERN in "${NEW_PATTERNS[@]}"; do
    if ! grep -Fq -- "${PATTERN}" "${ALLOWLIST}" 2>/dev/null; then
      if grep -q '^# ---- USER ADDITIONS BELOW' "${ALLOWLIST}" 2>/dev/null; then
        sed -i.bak "/^# ---- USER ADDITIONS BELOW/i\\
${PATTERN}
" "${ALLOWLIST}" && rm -f "${ALLOWLIST}.bak"
        added_any=1
      else
        printf '%s\n' "${PATTERN}" >> "${ALLOWLIST}"
        added_any=1
      fi
    fi
  done
fi

# ----- .brain-privacy-map.json -------------------------------------------
if [ -f "${PRIVACY}" ]; then
  if command -v jq >/dev/null 2>&1; then
    for PATTERN in "${NEW_PATTERNS[@]}"; do
      if ! jq -e --arg p "${PATTERN}" 'map(select(.pattern == $p)) | length > 0' "${PRIVACY}" >/dev/null 2>&1; then
        if jq --arg p "${PATTERN}" '. += [{"pattern": $p, "class": "artifact"}]' "${PRIVACY}" > "${PRIVACY}.tmp" 2>/dev/null; then
          mv "${PRIVACY}.tmp" "${PRIVACY}"
          added_any=1
        else
          rm -f "${PRIVACY}.tmp"
          skipped_required=1
          echo "  [v1.40.0.0] WARN: jq failed to patch ${PRIVACY}; skipping pattern ${PATTERN}." >&2
        fi
      fi
    done
  else
    skipped_required=1
    echo "" >&2
    echo "  [v1.40.0.0] *** ACTION REQUIRED ***" >&2
    echo "  [v1.40.0.0] jq not found; cannot patch .brain-privacy-map.json." >&2
    echo "  [v1.40.0.0] Federation sync will keep dropping /plan-eng-review test plans" >&2
    echo "  [v1.40.0.0] until this runs. Install jq and re-run /gstack-upgrade:" >&2
    echo "  [v1.40.0.0]   - macOS:  brew install jq" >&2
    echo "  [v1.40.0.0]   - Debian/Ubuntu: sudo apt install jq" >&2
    echo "  [v1.40.0.0]   - Fedora: sudo dnf install jq" >&2
    echo "  [v1.40.0.0] (Migration done-marker NOT written — next /gstack-upgrade retries.)" >&2
    echo "" >&2
  fi
fi

# ----- .gitattributes -----------------------------------------------------
if [ -f "${GITATTRS}" ]; then
  for PATTERN in "${NEW_PATTERNS[@]}"; do
    RULE="${PATTERN} merge=union"
    if ! grep -Fq -- "${RULE}" "${GITATTRS}" 2>/dev/null; then
      printf '%s\n' "${RULE}" >> "${GITATTRS}"
      added_any=1
    fi
  done
fi

# Mark done only when nothing was skipped. A fresh-init user's
# bin/gstack-artifacts-init now writes the pattern directly, so re-runs
# should no-op and the marker gets written immediately. The touchfile keeps
# the migration runner from looping on healthy installs.
#
# When skipped_required=1 (e.g. jq missing) we deliberately leave the
# done-marker unwritten so the next /gstack-upgrade run retries the
# privacy-map patch. The other files were patched on this pass and their
# "already present" gates make re-running idempotent. See #1581.
if [ "${skipped_required}" = "0" ]; then
  touch "${DONE}"
fi

if [ "${added_any}" = "1" ]; then
  echo "  [v1.40.0.0] allowlist/privacy-map/gitattributes patched for /plan-eng-review test plans (idempotent)" >&2
fi

# NEVER `git commit + push` from this migration. The user controls when the
# patches ship into their federated artifacts repo.

exit 0
