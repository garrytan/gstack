#!/usr/bin/env bash
# Migration: v1.91.19.0 — severe fix wave (memory ingest, artifacts remote).
# Placeholder name: the release queue may rename this file at /ship.
#
# Each step is independent and guarded. Idempotent and non-fatal: every path
# exits 0, and no step calls gbrain or the network unless it has work to do.
set -u
_gstack_migration_dir="${BASH_SOURCE[0]//\\//}"; _gstack_migration_dir="${_gstack_migration_dir%/*}"
. "${_gstack_migration_dir}/../../bin/gstack-state-root.sh" 2>/dev/null || { echo "$0: cannot resolve the gstack state root: ${_gstack_migration_dir}/../../bin/gstack-state-root.sh is missing. fix: reinstall with ./setup or /gstack-upgrade (docs/state-root.md)" >&2; exit 1; }
gstack_state_root_select; GH="$_gstack_sr_root"

# Step 1 (A1, #2778): older versions could mark a transcript ingested that
# gbrain had skipped. Record that a reconcile pass is pending; the next memory
# ingest re-checks stamped pages in bounded batches and re-queues the missing
# ones. This only writes a flag under the ingest's state lock; it never calls
# gbrain.
if [ -f "$GH/.transcript-ingest-state.json" ]; then
  INGEST="${_gstack_migration_dir}/../../bin/gstack-memory-ingest.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$INGEST" ]; then
    if bun "$INGEST" --request-reconcile --quiet; then
      echo "memory ingest: reconcile pending; the next /sync-gbrain re-checks transcripts already marked ingested."
    else
      echo "memory ingest: could not record a pending reconcile now; run: gstack-memory-ingest --reconcile" >&2
    fi
  fi
fi

# Step 2 (A8, #1437): the v1.27.0.0 migration passed a bare repo name to
# `gh repo rename`, which always failed, then pointed the artifacts remote at
# gstack-artifacts-<user> anyway. When that repository does not exist but the
# old gstack-brain-<user> does, point the remote back at the old one. Only a
# remote that names a gstack-artifacts-* GitHub repo is checked.
REMOTE_TXT="${HOME:-}/.gstack-artifacts-remote.txt"
if [ -n "${HOME:-}" ] && [ -f "$REMOTE_TXT" ]; then
  URL=$(head -1 "$REMOTE_TXT" 2>/dev/null | tr -d '[:space:]')
  OWNER=$(printf '%s\n' "$URL" | sed -n 's#^.*github\.com[:/]\([^/]*\)/gstack-artifacts-[^/]*$#\1#p')
  NEW_NAME=$(printf '%s\n' "$URL" | sed -n 's#^.*/\(gstack-artifacts-[^/]*\)$#\1#p' | sed 's/\.git$//')
  if [ -n "$OWNER" ] && [ -n "$NEW_NAME" ]; then
    OLD_NAME="gstack-brain-${NEW_NAME#gstack-artifacts-}"
    if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
      echo "artifacts remote: could not confirm $OWNER/$NEW_NAME exists (gh is not installed or not signed in). If artifact pushes fail, run: gh repo rename $NEW_NAME --repo $OWNER/$OLD_NAME --yes"
    elif ! gh repo view "$OWNER/$NEW_NAME" >/dev/null 2>&1 && gh repo view "$OWNER/$OLD_NAME" >/dev/null 2>&1; then
      OLD_URL=$(printf '%s\n' "$URL" | sed "s#/${NEW_NAME}#/${OLD_NAME}#")
      echo "$OLD_URL" > "$REMOTE_TXT" && chmod 600 "$REMOTE_TXT"
      if [ "$(git -C "$GH" remote get-url origin 2>/dev/null)" = "$URL" ]; then
        git -C "$GH" remote set-url origin "$OLD_URL" 2>/dev/null || true
      fi
      echo "artifacts remote: restored $OLD_URL because $OWNER/$NEW_NAME does not exist and $OWNER/$OLD_NAME does (an earlier upgrade rewrote it before the rename ran). To finish the rename later: gh repo rename $NEW_NAME --repo $OWNER/$OLD_NAME --yes"
    fi
  fi
fi

exit 0
