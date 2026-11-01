#!/usr/bin/env bash
# Read one file at a commit in a CI checkout that may be a blobless clone
# (actions/checkout `filter: blob:none`), where git fetches an old file's
# contents on demand and that fetch can fail. lib/history-read.ts is the
# TypeScript twin.
#
# Usage: history-read.sh <ref> <path> [--absent <text>]
#
# A read that `git show` answers is the file. When it fails, existence comes
# from the ref's tree (`git ls-tree --full-tree`, local data only): a path the
# tree does not list is absent, so this prints <text> (default: nothing) and
# exits 0. A listed path is retried, 3 tries in all in a partial clone (only a
# fetch can recover) and none otherwise, waiting HISTORY_READ_BACKOFF_SECONDS
# (default 2) times the attempt between tries. Anything else (a ref that does
# not resolve, a fetch that keeps failing) exits 1 with HISTORY_READ_FAILED
# naming the ref, the path and the git version, and never reads as absent.
# docs/troubleshooting.md#history-read-failed
set -euo pipefail

if [ "$#" -ne 2 ] && { [ "$#" -ne 4 ] || [ "$3" != --absent ]; }; then
  echo "usage: history-read.sh <ref> <path> [--absent <text>]" >&2
  exit 2
fi
ref=$1 file=$2 absent=${4:-}
out=$(mktemp) err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT

fail() {
  echo "::error::cannot read ${file} at ${ref}. $1 ($(git --version)). Fix: see docs/troubleshooting.md#history-read-failed (HISTORY_READ_FAILED)" >&2
  exit 1
}

if git show "${ref}:${file}" >"$out" 2>"$err"; then cat "$out"; exit 0; fi
listed=$(git ls-tree --full-tree "$ref" -- "$file" 2>"$err") || fail "git ls-tree failed: $(head -n 1 "$err")"
if [ -z "$listed" ]; then
  printf '%s' "$absent"
  exit 0
fi

tries=1
if git config --get-regexp '^(remote\..+\.promisor|extensions\.partialclone)$' | grep -qvi ' false$'; then tries=3; fi
try=1
while [ "$try" -lt "$tries" ]; do
  sleep "$(( try * ${HISTORY_READ_BACKOFF_SECONDS:-2} ))"
  if git show "${ref}:${file}" >"$out" 2>"$err"; then cat "$out"; exit 0; fi
  try=$(( try + 1 ))
done
fail "git show failed ${tries} time(s): $(head -n 1 "$err")"
