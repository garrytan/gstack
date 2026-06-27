#!/usr/bin/env bash
# kernel/tests/test_locks.sh — exclusive resource lock contract test.
# Run before pushing ANY kernel change touching locks/eligibility/claim.
# Exercises: --locks create, eligibility withholding, claim refusal, lock release
# at done, and that lock-free tasks are unaffected. Uses a real bare remote so the
# full claim path (push + post-push pull + tie-break) runs.
set -e

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
KERNEL_SRC="$(cd "$(dirname "$0")/.." && pwd)/task"

cd "$WORK"
git init -q --bare remote.git
git clone -q remote.git a 2>/dev/null
cd a && git config user.email t@t && git config user.name t
mkdir -p kernel ledger && cp "$KERNEL_SRC" kernel/task && chmod +x kernel/task
git add -A && git commit -qm init && git push -q
T=./kernel/task

# Two schema tasks share the migrations lock; one lock-free task is the control.
$T create BE-1 --repo r --domain be --desc "add users table" --locks migrations >/dev/null
$T create BE-2 --repo r --domain be --desc "add orders table" --locks migrations >/dev/null
$T create BE-3 --repo r --domain be --desc "no schema change" >/dev/null

# 1. lock is recorded on create
$T show BE-1 | grep -q "^locks: migrations" || { echo "FAIL: --locks not persisted"; exit 1; }
$T show BE-3 | grep -q "^locks: -"          || { echo "FAIL: lock-free task should have locks: -"; exit 1; }

# 2. all three eligible before any lock is held
[ "$($T eligible --role feature --domain be --repo r)" = "$(printf 'BE-1\nBE-2\nBE-3')" ] \
  || { echo "FAIL: all three should be eligible initially"; exit 1; }

# 3. claiming BE-1 takes the lock; BE-2 withheld, BE-3 still eligible
$T claim BE-1 --agent agent-be --role feature >/dev/null
ELIG="$($T eligible --role feature --domain be --repo r)"
echo "$ELIG" | grep -q "^BE-2$" && { echo "FAIL: BE-2 should be withheld while lock held"; exit 1; }
echo "$ELIG" | grep -q "^BE-3$" || { echo "FAIL: lock-free BE-3 should stay eligible"; exit 1; }

# 4. direct claim of the contended task loses with exit 2
set +e
$T claim BE-2 --agent agent-be2 --role feature >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: contended claim should exit 2, got $RC"; exit 1; }

# 5. lock holds across the whole pipeline (testing/documenting), not just in_progress
$T complete BE-1 --agent agent-be --role feature >/dev/null          # -> testing
echo "$($T eligible --role feature --domain be --repo r)" | grep -q "^BE-2$" \
  && { echo "FAIL: BE-2 should stay withheld while holder is in testing"; exit 1; }

# 6. lock STILL held after the holder reaches `done` — it releases on MERGE, not done.
#    (A human merges the PR hours later; releasing at done reopens the collision window.)
$T claim BE-1 --agent agent-qa --role qa >/dev/null
$T complete BE-1 --agent agent-qa --role qa --verdict passed >/dev/null  # -> documenting
$T claim BE-1 --agent agent-doc --role doc >/dev/null
$T complete BE-1 --agent agent-doc --role doc >/dev/null                 # -> done
$T show BE-1 | grep -q "^lock_state: held" || { echo "FAIL: lock must stay held at done"; exit 1; }
echo "$($T eligible --role feature --domain be --repo r)" | grep -q "^BE-2$" \
  && { echo "FAIL: BE-2 must stay withheld until BE-1 merges (not at done)"; exit 1; }

# 7. lock-release (merge-reaper / human) frees it; BE-2 becomes eligible
$T lock-release BE-1 --agent reaper >/dev/null
$T show BE-1 | grep -q "^lock_state: freed" || { echo "FAIL: lock-release should set freed"; exit 1; }
echo "$($T eligible --role feature --domain be --repo r)" | grep -q "^BE-2$" \
  || { echo "FAIL: BE-2 should be eligible after BE-1 lock released"; exit 1; }
# lock-release is idempotent
$T lock-release BE-1 --agent reaper >/dev/null || { echo "FAIL: lock-release should be idempotent"; exit 1; }

# 8. a held task QA-bounces to `open` but STAYS held (its unmerged migration persists)
$T claim BE-2 --agent agent-be --role feature >/dev/null
$T complete BE-2 --agent agent-be --role feature >/dev/null             # -> testing
$T claim BE-2 --agent agent-qa --role qa >/dev/null
$T complete BE-2 --agent agent-qa --role qa --verdict failed >/dev/null # -> open (bounced)
$T show BE-2 | grep -q "^status: open"       || { echo "FAIL: QA-fail should reopen BE-2"; exit 1; }
$T show BE-2 | grep -q "^lock_state: held"   || { echo "FAIL: bounced task must stay held"; exit 1; }
# the SAME task is still re-eligible to itself (self excluded from contention)
$T eligible --role feature --domain be --repo r | grep -q "^BE-2$" \
  || { echo "FAIL: bounced holder should be re-eligible to fix"; exit 1; }

# 9. only ONE of two racing first-claims on the same lock survives (post-push tie-break)
$T create BE-4 --repo r --domain be --desc "more schema" --locks migrations >/dev/null
$T lock-release BE-2 --agent reaper >/dev/null                          # clear the field
cd "$WORK" && git clone -q remote.git c && cd c && git config user.email c@c && git config user.name c
cd "$WORK/a" && git pull -q --rebase
cd "$WORK/a" && $T claim BE-4 --agent agent-x --role feature >/dev/null  # holds migrations
cd "$WORK/c" && ./kernel/task >/dev/null 2>&1 || true
set +e
./kernel/task claim BE-4 --agent agent-y --role feature >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: racing claim on held lock should exit 2, got $RC"; exit 1; }

echo "kernel locks: ALL PASS"
