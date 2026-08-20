#!/usr/bin/env bash
# Migration: v1.38.1.0 — add root-level design + test-plan patterns to
# .brain-allowlist, .brain-privacy-map.json, and .gitattributes (#1452).
#
# Why a migration: gstack-artifacts-init regenerates these files but also
# does `git commit + push` on ~/.gstack/, which would clobber user state on
# upgrade. Instead, we do targeted per-file in-place repairs.
#
# Per-file independent — if one file is missing we still repair the others.
#
# Idempotent: each insertion is gated on `not already present` so re-running
# the migration is a no-op.

# No `set -e` — we intentionally tolerate per-file failures so other repairs
# still run. `set -u` is fine.
set -u

GSTACK_HOME="${HOME}/.gstack"
ALLOWLIST="${GSTACK_HOME}/.brain-allowlist"
PRIVACY="${GSTACK_HOME}/.brain-privacy-map.json"
GITATTRS="${GSTACK_HOME}/.gitattributes"

MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.38.1.0.done"

mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
if [ -f "${DONE}" ]; then
  exit 0
fi

NEW_PATTERNS=(
  'projects/*/*-design-*.md'
  'projects/*/*-test-plan-*.md'
)

added_any=0

# ----- .brain-allowlist ---------------------------------------------------
if [ -f "${ALLOWLIST}" ]; then
  for PATTERN in "${NEW_PATTERNS[@]}"; do
    if ! grep -Fq -- "${PATTERN}" "${ALLOWLIST}" 2>/dev/null; then
      # Insert before USER ADDITIONS marker. BSD sed (-i.bak) compat for macOS;
      # the backup file is removed afterward.
      if grep -q '^# ---- USER ADDITIONS BELOW' "${ALLOWLIST}" 2>/dev/null; then
        sed -i.bak "/^# ---- USER ADDITIONS BELOW/i\\
${PATTERN}
" "${ALLOWLIST}" && rm -f "${ALLOWLIST}.bak"
        added_any=1
      else
        # Marker missing — append at end of file as a fallback. User may have
        # custom-edited the file; better to add than skip silently.
        printf '%s\n' "${PATTERN}" >> "${ALLOWLIST}"
        added_any=1
      fi
    fi
  done
fi

# ----- .brain-privacy-map.json -------------------------------------------
# Uses jq to preserve JSON validity. Skips with a warning if jq is missing.
if [ -f "${PRIVACY}" ]; then
  if command -v jq >/dev/null 2>&1; then
    for PATTERN in "${NEW_PATTERNS[@]}"; do
      if ! jq -e --arg p "${PATTERN}" 'map(select(.pattern == $p)) | length > 0' "${PRIVACY}" >/dev/null 2>&1; then
        if jq --arg p "${PATTERN}" '. += [{"pattern": $p, "class": "artifact"}]' "${PRIVACY}" > "${PRIVACY}.tmp" 2>/dev/null; then
          mv "${PRIVACY}.tmp" "${PRIVACY}"
          added_any=1
        else
          rm -f "${PRIVACY}.tmp"
          echo "  [v1.38.1.0] WARN: jq failed to patch ${PRIVACY}; skipping pattern ${PATTERN}." >&2
        fi
      fi
    done
  else
    echo "  [v1.38.1.0] WARN: jq not found; skipping privacy-map repair. Install jq and re-run gstack-upgrade, or run gstack-artifacts-init manually." >&2
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

# Mark done. Even if no patches were applied (already-current install), we
# write the touchfile so the migration runs once.
touch "${DONE}"

if [ "${added_any}" = "1" ]; then
  echo "  [v1.38.1.0] allowlist/privacy-map/gitattributes patched for root-level design + test-plan artifacts (idempotent)" >&2
fi

# NEVER `git commit + push` from this migration. The user controls when the
# patches ship into their federated artifacts repo (next gstack-brain-sync
# --once or a manual commit).

exit 0
