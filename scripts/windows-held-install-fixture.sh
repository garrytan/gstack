#!/usr/bin/env bash
# Builds the held-install fixture for the held-install jobs in
# .github/workflows/windows-setup-e2e.yml: a bare origin whose main carries this
# checkout's tree on top of the v1.91.101.0 release tree, a fix-branch for the
# trial form, and $RUNNER_TEMP/held/lib.sh, which every held-install step sources.
# Run from the checkout root on the Windows runner (Git Bash).
set -euo pipefail
BASH_COMPAT=50
OLD_RELEASE=47d639abffa882b8cbb641d7d1dedf08ecada9ec # v1.91.101.0
T="$RUNNER_TEMP/held"
rm -rf "$T" && mkdir -p "$T"
git cat-file -e "$OLD_RELEASE^{commit}" 2>/dev/null || git fetch -q --no-tags --depth=1 origin "$OLD_RELEASE"
c() { git commit-tree "$@"; }
HELD=$(c -m "v1.91.101.0" "$OLD_RELEASE^{tree}")
MAIN=$(c -p "$HELD" -m "this PR's tree" 'HEAD^{tree}')
export GIT_INDEX_FILE="$T/fix.index"
git read-tree "$MAIN"
git update-index --add --cacheinfo "100644,$(printf 'trial\n' | git hash-object -w --stdin),e2e-trial-marker"
FIX=$(c -p "$MAIN" -m "a fix branch to try" "$(git write-tree)")
unset GIT_INDEX_FILE
test "$(git show "$HELD:VERSION")" = 1.91.101.0 || (echo "the held tree is not v1.91.101.0" && exit 1)
git ls-tree "$MAIN" connect-chrome | grep -q '^120000 ' || (echo "this PR's tree has no connect-chrome symlink to reproduce the hold" && exit 1)
git init -q --bare -b main "$T/origin.git"
git push -q "$T/origin.git" "$MAIN:refs/heads/main" "$FIX:refs/heads/fix-branch"
printf 'HELD=%s\nMAIN=%s\nFIX=%s\n' "$HELD" "$MAIN" "$FIX" > "$T/vars"
: > "$T/cases"
cat > "$T/lib.sh" <<'LIB'
T="$RUNNER_TEMP/held"
. "$T/vars"
INSTALL="$HOME/.claude/skills/gstack"
STATE="$HOME/.gstack"
LOG="$STATE/analytics/session-update.log"
PS="${GSTACK_E2E_POWERSHELL:-powershell.exe}"
w() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
die() { echo "FAIL: $*" >&2; [ ! -f "$LOG" ] || { echo "--- updater log" && cat "$LOG"; } >&2; exit 1; }
case_ok() { echo "$1" >> "$T/cases"; echo "CASE OK: $1"; }
# The command docs/troubleshooting.md publishes under <!-- form:NAME -->.
form() { awk -v m="<!-- form:$1 -->" '$0 == m { f = 1; next } f && /^```/ { if (o) exit; o = 1; next } f && o { print }' "$GITHUB_WORKSPACE/docs/troubleshooting.md"; }
# run_ps_form NAME [REPLACEMENT-FOR-.\setup.ps1] [BRANCH]: the form,
# verbatim, as a script under powershell.exe; prints its output.
run_ps_form() {
  f=$(form "$1")
  case "$f" in *'{ .\setup.ps1 }') ;; *) die "form $1 is missing or does not end in .\setup.ps1: $f" ;; esac
  [ -z "${2:-}" ] || f="${f%'.\setup.ps1 }'}$2 }"
  [ -z "${3:-}" ] || f=${f//'<branch>'/$3}
  printf '%s\r\nexit $LASTEXITCODE\r\n' "$f" > "$T/form.ps1"
  "$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(w "$T/form.ps1")" 2>&1
}
# run_updater PATTERN [SECONDS]: one session-start check with the
# throttle cleared, waiting for its background run to log PATTERN.
run_updater() {
  rm -f "$STATE/.last-session-update"
  n0=$( { cat "$LOG" 2>/dev/null || true; } | wc -l)
  ( cd "$T" && PATH="${GSTACK_E2E_UPDATER_PATH_PREFIX:+$GSTACK_E2E_UPDATER_PATH_PREFIX:}$PATH" bash "$INSTALL/bin/gstack-session-update" ) || die "the updater exited $?"
  i=0
  until tail -n +"$((n0 + 1))" "$LOG" 2>/dev/null | grep -E "$1" > "$T/updater-line"; do
    i=$((i + 1)); [ "$i" -le "${2:-180}" ] || die "no updater log line matching '$1' within ${2:-180}s"
    sleep 1
  done
  cat "$T/updater-line"
  i=0; while [ -d "$STATE/.setup-lock" ] && [ "$i" -lt 120 ]; do i=$((i + 1)); sleep 1; done
}
# install_state clean|dirty|unmerged: a prefix-mode v1.91.101.0
# install one release behind origin's main.
install_state() {
  rm -rf "$INSTALL" "$STATE"
  mkdir -p "$(dirname "$INSTALL")"
  git clone -q "$T/origin.git" "$INSTALL"
  git -C "$INSTALL" reset -q --hard "$HELD"
  GSTACK_SETUP_RUNNING=1 bash "$INSTALL/bin/gstack-config" set auto_upgrade true
  GSTACK_SETUP_RUNNING=1 bash "$INSTALL/bin/gstack-config" set skill_prefix true
  bash "$INSTALL/bin/gstack-patch-names" "$INSTALL" true >/dev/null
  ! git -C "$INSTALL" diff --quiet -- SKILL.md '*/SKILL.md' || die "prefix mode left no footprint"
  case "$1" in
    dirty)
      git -C "$INSTALL" diff -U0 "$HELD" "$MAIN" -- docs/troubleshooting.md > "$T/upstream.diff"
      L=$(sed -n 's/^-\([^-]\)/\1/p' "$T/upstream.diff" | sed -n 1p)
      [ -n "$L" ] || die "docs/troubleshooting.md has no upstream change to conflict with"
      L="$L" awk '!d && $0 == ENVIRON["L"] { print $0 " LOCAL-EDIT"; d = 1; next } { print }' "$INSTALL/docs/troubleshooting.md" > "$T/edited"
      cat "$T/edited" > "$INSTALL/docs/troubleshooting.md"
      grep -q 'LOCAL-EDIT' "$INSTALL/docs/troubleshooting.md" || die "the local edit did not apply"
      ;;
    unmerged)
      b=$(printf 'base\n' | git -C "$INSTALL" hash-object -w --stdin)
      o=$(printf 'ours LOCAL-EDIT\n' | git -C "$INSTALL" hash-object -w --stdin)
      t=$(printf 'theirs\n' | git -C "$INSTALL" hash-object -w --stdin)
      git -C "$INSTALL" update-index --force-remove README.md
      printf '100644 %s 1\tREADME.md\n100644 %s 2\tREADME.md\n100644 %s 3\tREADME.md\n' "$b" "$o" "$t" | git -C "$INSTALL" update-index --index-info
      printf '<<<<<<< ours\nours LOCAL-EDIT\n=======\ntheirs\n>>>>>>> theirs\n' > "$INSTALL/README.md"
      [ -n "$(git -C "$INSTALL" ls-files -u)" ] || die "the install has no unmerged files"
      ;;
  esac
}
# check_recovered STATE: at origin's main, nothing unmerged, and
# every local edit (only those) in one rescue ref.
check_recovered() {
  [ "$(git -C "$INSTALL" rev-parse HEAD)" = "$MAIN" ] || die "$1: the install is at $(git -C "$INSTALL" rev-parse HEAD), not $MAIN"
  [ -z "$(git -C "$INSTALL" ls-files -u)" ] || die "$1: unmerged files remain"
  [ -f "$INSTALL/bin/gstack-ff-update" ] || die "$1: bin/gstack-ff-update is missing"
  refs=$(git -C "$INSTALL" for-each-ref --format='%(refname)' refs/gstack/rescue)
  if [ "$1" = clean ]; then
    [ -z "$refs" ] || die "clean: a rescue ref was made: $refs"
    return 0
  fi
  [ "$(printf '%s\n' "$refs" | grep -c .)" = 1 ] || die "$1: expected one rescue ref, got: $refs"
  file=docs/troubleshooting.md; [ "$1" != unmerged ] || file=README.md
  git -C "$INSTALL" show "$refs:$file" > "$T/rescued"
  grep -q 'LOCAL-EDIT' "$T/rescued" || die "$1: the rescue ref lacks the local edit to $file"
  [ "$(git -C "$INSTALL" diff --name-only "$refs^" "$refs")" = "$file" ] || die "$1: the rescue ref holds more than the user's edit"
}
LIB
bash -n "$T/lib.sh"
