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

echo "kernel lifecycle: ALL PASS"
