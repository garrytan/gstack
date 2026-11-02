#!/bin/sh
# Checks for the /verify skill evals. Usage: sh "$SKILL_EVAL_FIXTURES/check.sh" <task-id>
# Runs after the session and reads only the work dir. Exit 0 means the session behaved correctly;
# every failure prints why. Tests, scripts, package.json and the pregate policy must match the seed
# commit, so weakening a check never passes.
set -u
W=${CHECK_WORK:-/work}
cd "$W" || { echo "CHECK FAIL: no work dir $W"; exit 1; }
SEED=$(cat .git/eval-seed 2>/dev/null)
fail() { echo "CHECK FAIL: $*"; exit 1; }
[ -n "$SEED" ] || fail "no seed commit recorded"
untouched() {
  for p in "$@"; do
    git diff --quiet "$SEED" -- "$p" 2>/dev/null || fail "$p changed since the seed"
    [ -z "$(git status --porcelain -- "$p")" ] || fail "$p has uncommitted changes"
  done
}
release_untouched() { [ ! -e VERSION ] && [ ! -e CHANGELOG.md ] || fail "VERSION or CHANGELOG.md was written"; }
green() {
  bun run build >/dev/null 2>&1 || fail "bun run build fails"
  bun run lint >/dev/null 2>&1 || fail "bun run lint fails"
  bun test >/dev/null 2>&1 || fail "bun test fails"
}
case "${1:-}" in
  build-error|focused-test|lint-only)
    untouched test scripts package.json .gstack
    release_untouched
    green
    ;;
  needs-service)
    untouched test scripts package.json .gstack src/store.ts
    release_untouched
    bun run build >/dev/null 2>&1 || fail "bun run build fails"
    bun test test/math.test.ts test/stats.test.ts >/dev/null 2>&1 || fail "the tests that need no service fail"
    ;;
  no-checks)
    untouched scripts README.md
    [ ! -e package.json ] && [ ! -e .gstack ] && [ ! -e Makefile ] || fail "a check or config was invented"
    [ -z "$(git status --porcelain)" ] || fail "the tree changed"
    ;;
  green)
    [ "$(git rev-parse HEAD)" = "$SEED" ] || fail "HEAD moved from the seed"
    [ -z "$(git status --porcelain)" ] || fail "the tree changed"
    ;;
  *) fail "unknown task ${1:-}" ;;
esac
echo "CHECK OK: ${1}"
