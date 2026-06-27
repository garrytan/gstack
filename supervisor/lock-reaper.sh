#!/usr/bin/env bash
# lock-reaper.sh — auto-release exclusive resource locks once their branch merges.
#
# An exclusive lock (e.g. `migrations`) is held from claim until the work actually
# lands on main. PRs are merged by a human who may not look for hours, so the kernel
# cannot release at `done` — it would reopen the collision window. This reaper closes
# the loop: every sync, for each `lock_state: held` task, it checks the WORK repo for
# the task's feature branch and releases the lock the moment that branch is an ancestor
# of origin/main (merged) or has been merged-and-deleted.
#
# Idempotent and safe to run from every agent: `kernel/task lock-release` no-ops on an
# already-freed lock, and the kernel push retries on contention.
#
# Usage: lock-reaper.sh <CONTROL_DIR> <WORK_DIR> [AGENT_NAME] [DEFAULT_BRANCH]
set -u

CONTROL_DIR="${1:?control dir required}"
WORK_DIR="${2:?work dir required}"
AGENT="${3:-reaper}"
BASE="${4:-main}"

# Nothing to do without a work clone (qa/doc agents) or a ledger.
[ -d "$WORK_DIR/.git" ] || exit 0
[ -d "$CONTROL_DIR/ledger" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0

# Refresh remote refs so merge/deletion is visible. (run-agent already fetched, but
# this keeps the reaper correct when called standalone.)
git -C "$WORK_DIR" fetch -q --prune origin 2>/dev/null || true

released=0
for f in "$CONTROL_DIR"/ledger/*.task; do
  [ -e "$f" ] || continue
  grep -q '^lock_state: held$' "$f" || continue
  tid=$(basename "$f" .task)

  # Find the task's feature branch on origin. Convention: feat/<task-id>-<slug>.
  # Trailing dash avoids T7 matching T70.
  branch=$(git -C "$WORK_DIR" for-each-ref --format='%(refname:short)' \
             "refs/remotes/origin/feat/${tid}-*" 2>/dev/null | head -n1)

  merged=""
  if [ -n "$branch" ]; then
    # Branch still on origin: merged iff its tip is an ancestor of origin/$BASE.
    if git -C "$WORK_DIR" merge-base --is-ancestor "$branch" "origin/$BASE" 2>/dev/null; then
      merged="ancestor of origin/$BASE"
    fi
  else
    # No matching origin branch. If the task finished the pipeline, the branch was
    # merged-and-deleted (squash/merge with delete-on-merge). Release. If the task is
    # NOT done, the branch may simply not be pushed yet — leave the lock held.
    if grep -q '^status: done$' "$f"; then
      merged="branch gone, task done (merged+deleted)"
    fi
  fi

  if [ -n "$merged" ]; then
    if (cd "$CONTROL_DIR" && ./kernel/task lock-release "$tid" --agent "${AGENT}-reaper" >/dev/null 2>&1); then
      echo "[lock-reaper] released lock on $tid ($merged)"
      released=$((released + 1))
    fi
  elif grep -q '^status: done$' "$f"; then
    # Pipeline finished, branch not yet on main → the ONLY thing holding every other
    # schema task is the human's pending merge. Surface it so it isn't a silent stall.
    res=$(sed -n 's/^locks: //p' "$f")
    echo "[lock-reaper] WARN: $tid is done but unmerged — '$res' lock blocks other schema tasks until you merge its PR (or: kernel/task lock-release $tid --abandon)"
  fi
done

[ "$released" -gt 0 ] && echo "[lock-reaper] released $released lock(s)"
exit 0
