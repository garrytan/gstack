#!/bin/sh
# gstack-review first step: find the base, the merge base and what changed.
# Usage: sh diff-base.sh [base]   (POSIX sh and git only)
set -u
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "NOT_A_GIT_REPO: $(pwd)"
  exit 0
fi
no_base() {
  echo "BASE: none ($1)"
  echo "== uncommitted changes"
  git status --short | head -n 40
  if git rev-parse --verify --quiet HEAD >/dev/null; then
    echo "== diff stat against HEAD"
    git diff --stat HEAD --
  fi
  echo "NEXT: pass the base branch (sh diff-base.sh <base>) or review the uncommitted changes with git diff HEAD"
  exit 0
}
base=${1:-}
if [ -z "$base" ]; then
  base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
fi
if [ -z "$base" ]; then
  for candidate in origin/main main origin/master master; do
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      base=$candidate
      break
    fi
  done
fi
[ -n "$base" ] || no_base "no origin/HEAD, main or master"
merge_base=$(git merge-base "$base" HEAD 2>/dev/null) || no_base "$base has no merge base with HEAD"
echo "BRANCH: $(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo detached)"
echo "BASE: $base"
echo "MERGE_BASE: $merge_base"
echo "== commits since base"
git log --oneline "$merge_base..HEAD" -- | head -n 30
echo "== diff stat (working tree against merge base)"
git diff --stat "$merge_base" --
untracked=$(git ls-files --others --exclude-standard)
echo "== untracked files"
printf '%s\n' "$untracked" | head -n 30
untracked_count=$(printf '%s\n' "$untracked" | grep -c . || true)
if [ "$untracked_count" -gt 30 ]; then
  echo "UNTRACKED_MORE: $((untracked_count - 30)) more untracked files; list them all with git ls-files --others --exclude-standard"
fi
if git diff --quiet "$merge_base" -- && [ -z "$untracked" ]; then
  echo "NOTHING_TO_REVIEW"
  exit 0
fi
echo "NEXT: git diff $merge_base"
