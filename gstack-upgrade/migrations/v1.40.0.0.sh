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
#
# Done-marker discipline (#1581): the marker is only written when every
# required repair either succeeded or was provably unnecessary. Tracking
# happens via the `incomplete` flag; on any failure path (missing jq, broken
# JSON, append failure, mv failure) we set `incomplete=1` and skip the touch
# so the migration runner retries on the next /gstack-upgrade.

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
incomplete=0

# ----- .brain-allowlist ---------------------------------------------------
if [ -f "${ALLOWLIST}" ]; then
  for PATTERN in "${NEW_PATTERNS[@]}"; do
    if ! grep -Fq -- "${PATTERN}" "${ALLOWLIST}" 2>/dev/null; then
      if grep -q '^# ---- USER ADDITIONS BELOW' "${ALLOWLIST}" 2>/dev/null; then
        if sed -i.bak "/^# ---- USER ADDITIONS BELOW/i\\
${PATTERN}
" "${ALLOWLIST}" 2>/dev/null; then
          rm -f "${ALLOWLIST}.bak"
          added_any=1
        else
          echo "  [v1.40.0.0] WARN: failed to insert ${PATTERN} into ${ALLOWLIST}; will retry on next upgrade." >&2
          rm -f "${ALLOWLIST}.bak" 2>/dev/null || true
          incomplete=1
        fi
      else
        if printf '%s\n' "${PATTERN}" >> "${ALLOWLIST}" 2>/dev/null; then
          added_any=1
        else
          echo "  [v1.40.0.0] WARN: failed to append ${PATTERN} to ${ALLOWLIST}; will retry on next upgrade." >&2
          incomplete=1
        fi
      fi
    fi
  done
fi

# ----- .brain-privacy-map.json -------------------------------------------
if [ -f "${PRIVACY}" ]; then
  if command -v jq >/dev/null 2>&1; then
    # Validate JSON shape up front. We won't try to repair a corrupt file —
    # bail out and leave for manual fix.
    if ! jq -e . "${PRIVACY}" >/dev/null 2>&1; then
      echo "  [v1.40.0.0] WARN: ${PRIVACY} is not valid JSON; skipping privacy-map repair. Fix manually or run gstack-artifacts-init." >&2
      incomplete=1
    else
      for PATTERN in "${NEW_PATTERNS[@]}"; do
        if ! jq -e --arg p "${PATTERN}" 'map(select(.pattern == $p)) | length > 0' "${PRIVACY}" >/dev/null 2>&1; then
          tmp=$(mktemp "${PRIVACY}.tmp.XXXXXX" 2>/dev/null)
          if [ -z "${tmp}" ] || [ ! -f "${tmp}" ]; then
            echo "  [v1.40.0.0] WARN: failed to create tempfile for ${PRIVACY}; skipping pattern ${PATTERN}." >&2
            incomplete=1
            continue
          fi
          if jq --arg p "${PATTERN}" '. += [{"pattern": $p, "class": "artifact"}]' "${PRIVACY}" > "${tmp}" 2>/dev/null; then
            if mv "${tmp}" "${PRIVACY}" 2>/dev/null; then
              added_any=1
            else
              echo "  [v1.40.0.0] WARN: failed to rewrite ${PRIVACY}; skipping pattern ${PATTERN}." >&2
              rm -f "${tmp}"
              incomplete=1
            fi
          else
            echo "  [v1.40.0.0] WARN: jq mutation failed for ${PRIVACY}; skipping pattern ${PATTERN}." >&2
            rm -f "${tmp}"
            incomplete=1
          fi
        fi
      done
    fi
  else
    echo "  [v1.40.0.0] WARN: jq not found; skipping privacy-map repair. Install jq and re-run gstack-upgrade, or run gstack-artifacts-init manually." >&2
    incomplete=1
  fi
fi

# ----- .gitattributes -----------------------------------------------------
if [ -f "${GITATTRS}" ]; then
  for PATTERN in "${NEW_PATTERNS[@]}"; do
    RULE="${PATTERN} merge=union"
    if ! grep -Fq -- "${RULE}" "${GITATTRS}" 2>/dev/null; then
      if printf '%s\n' "${RULE}" >> "${GITATTRS}" 2>/dev/null; then
        added_any=1
      else
        echo "  [v1.40.0.0] WARN: failed to append rule to ${GITATTRS}; will retry on next upgrade." >&2
        incomplete=1
      fi
    fi
  done
fi

if [ "${incomplete}" = "0" ]; then
  # Mark done — every required repair either succeeded or was provably
  # unnecessary. A fresh-init user's bin/gstack-artifacts-init now writes the
  # pattern directly, so re-runs no-op. The touchfile keeps the migration
  # runner from looping.
  touch "${DONE}"
  if [ "${added_any}" = "1" ]; then
    echo "  [v1.40.0.0] allowlist/privacy-map/gitattributes patched for /plan-eng-review test plans (idempotent)" >&2
  fi
else
  echo "  [v1.40.0.0] INFO: marker not written; gstack-upgrade will retry once prerequisites are met." >&2
fi

# NEVER `git commit + push` from this migration. The user controls when the
# patches ship into their federated artifacts repo.

exit 0
