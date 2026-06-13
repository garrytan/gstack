#!/usr/bin/env bash
# kernel/tests/test_lifecycle.sh — the kernel's contract test.
# Run before pushing ANY kernel change. Exercises: create, dependency blocking,
# claim, unblock-on-complete, QA fail/reopen/failure_count, and the claim race.
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
$T create DEP-1  --repo r1 --domain be --desc "foundation" --lease-hours 8 >/dev/null
$T create CHILD-1 --repo r1 --domain be --desc "depends" --blocked-by DEP-1 >/dev/null
$T create OTHER-1 --repo r2 --domain fe --desc "frontend" >/dev/null

# 1. eligibility respects domain + dependency
[ "$($T eligible --role feature --domain be)" = "DEP-1" ] || { echo "FAIL: dependency blocking"; exit 1; }
[ "$($T eligible --role feature --domain fe)" = "OTHER-1" ] || { echo "FAIL: domain filter"; exit 1; }

# 2. claim, then nothing eligible for be
$T claim DEP-1 --agent a1 --role feature >/dev/null
$T eligible --role feature --domain be >/dev/null 2>&1 && { echo "FAIL: claimed task still eligible"; exit 1; }

# 3. complete unblocks the child
$T complete DEP-1 --agent a1 --role feature >/dev/null
[ "$($T eligible --role feature --domain be)" = "CHILD-1" ] || { echo "FAIL: unblock on complete"; exit 1; }

# 4. QA cycle: done task eligible, fail reopens with failure_count
[ "$($T eligible --role qa)" = "DEP-1" ] || { echo "FAIL: qa eligibility"; exit 1; }
$T claim DEP-1 --agent q1 --role qa >/dev/null
$T complete DEP-1 --agent q1 --role qa --verdict failed >/dev/null
$T show DEP-1 | grep -q "^status: open" || { echo "FAIL: qa fail should reopen"; exit 1; }
$T show DEP-1 | grep -q "^failure_count: 1" || { echo "FAIL: failure_count"; exit 1; }

# 5. claim race: second clone loses with exit 2
cd "$WORK" && git clone -q remote.git b && cd b && git config user.email b@b && git config user.name b
cd "$WORK/a" && $T claim CHILD-1 --agent a1 --role feature >/dev/null
cd "$WORK/b"
set +e
./kernel/task claim CHILD-1 --agent a2 --role feature >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: race should exit 2, got $RC"; exit 1; }

# 6. unblock: needs_human -> open with reason; rejects missing reason and wrong state
cd "$WORK/a"
$T create T-NH --repo r1 --domain be --desc "needs human test" >/dev/null
$T claim T-NH --agent a1 --role feature >/dev/null
$T fail T-NH --agent a1 --role feature --needs-human >/dev/null
$T show T-NH | grep -q "^status: needs_human" || { echo "FAIL: fail --needs-human should set needs_human"; exit 1; }
$T unblock T-NH --agent tshepo 2>/dev/null && { echo "FAIL: unblock without --reason should error"; exit 1; }
$T unblock T-NH --agent tshepo --reason "human decision recorded" >/dev/null
$T show T-NH | grep -q "^status: open" || { echo "FAIL: unblock should set open"; exit 1; }
$T show T-NH | grep -q "^failure_count: 1" || { echo "FAIL: unblock should preserve failure_count"; exit 1; }
$T unblock T-NH --agent tshepo --reason "again" 2>/dev/null && { echo "FAIL: unblock on non-needs_human should error"; exit 1; }

# 7. sync: frontmattered ready specs -> ledger, one commit; not-ready/error specs reported
cd "$WORK/a"
mkdir -p tasks
cat > tasks/SYNC-1.md <<'EOS'
---
repo: r1
domain: be
done_check: pytest tests/test_sync1.py
ready: true
---
# SYNC-1 -- synced via frontmatter
EOS
cat > tasks/SYNC-2.md <<'EOS'
---
repo: r1
domain: be
ready: false
---
# SYNC-2 -- not ready yet
EOS
OUT=$($T sync)
echo "$OUT" | grep -q "created: 1 (SYNC-1)" || { echo "FAIL: sync should create SYNC-1"; exit 1; }
echo "$OUT" | grep -q "not ready.*SYNC-2" || { echo "FAIL: sync should report SYNC-2 as not ready"; exit 1; }
[ -f ledger/SYNC-1.task ] || { echo "FAIL: SYNC-1 ledger file missing"; exit 1; }
[ -f ledger/SYNC-2.task ] && { echo "FAIL: SYNC-2 should NOT have a ledger entry"; exit 1; }
$T eligible --role feature --domain be | grep -q "SYNC-1" || { echo "FAIL: SYNC-1 should be eligible after sync"; exit 1; }
# idempotent: second sync creates nothing new
OUT2=$($T sync)
echo "$OUT2" | grep -q "created: 0" || { echo "FAIL: second sync should create 0"; exit 1; }

# 8. awaiting_info: agent-to-agent Q&A, no failure_count hit; resume reopens;
#    if the answering agent also can't help, escalate to needs_human (failure_count++)
cd "$WORK/a"
$T create BUG-AI --repo r1 --domain be --desc "needs clarification from another agent" >/dev/null
$T claim BUG-AI --agent agent-be --role feature >/dev/null
$T fail BUG-AI --agent agent-be --role feature --awaiting-info >/dev/null
$T show BUG-AI | grep -q "^status: awaiting_info" || { echo "FAIL: awaiting_info status"; exit 1; }
$T show BUG-AI | grep -q "^failure_count: 0" || { echo "FAIL: awaiting_info must not increment failure_count"; exit 1; }
$T eligible --role feature --domain be 2>/dev/null | grep -q "^BUG-AI$" && { echo "FAIL: awaiting_info should not be immediately eligible"; exit 1; }
# answering agent CAN help -> resume -> open, re-eligible
$T resume BUG-AI --agent agent-fe --role feature >/dev/null
$T show BUG-AI | grep -q "^status: open" || { echo "FAIL: resume should reopen"; exit 1; }
$T eligible --role feature --domain be | grep -q "BUG-AI" || { echo "FAIL: BUG-AI should be eligible after resume"; exit 1; }
# resume on a non-awaiting_info task errors
$T resume BUG-AI --agent agent-fe --role feature 2>/dev/null && { echo "FAIL: resume on open task should error"; exit 1; }
# second round: nobody can answer -> needs_human, failure_count++
$T claim BUG-AI --agent agent-be --role feature >/dev/null
$T fail BUG-AI --agent agent-be --role feature --awaiting-info >/dev/null
$T fail BUG-AI --agent agent-fe --role feature --needs-human >/dev/null
$T show BUG-AI | grep -q "^status: needs_human" || { echo "FAIL: both-stuck should escalate to needs_human"; exit 1; }
$T show BUG-AI | grep -q "^failure_count: 1" || { echo "FAIL: needs_human escalation should increment failure_count"; exit 1; }

echo "kernel lifecycle: ALL PASS"
