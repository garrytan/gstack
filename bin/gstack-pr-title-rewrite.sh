#!/usr/bin/env bash
# Rewrite a PR/MR title to start with v<NEW_VERSION>.
#
# Usage:  bin/gstack-pr-title-rewrite.sh <NEW_VERSION> <CURRENT_TITLE>
# Output: corrected title on stdout.
#
# Rule: PR titles MUST start with v<NEW_VERSION>. Three cases:
#   1. Already starts with "v<NEW_VERSION>" -> no change.
#   2. Starts with a different "v<digits and dots>" prefix -> replace prefix.
#   3. No version prefix -> prepend "v<NEW_VERSION> ".
#
# Each version prefix may be followed by a space (then a description) OR sit at
# the end of the title as a bare version with no description (e.g. "v1.2.3", the
# format ship/CHANGELOG uses for version-only bumps). Both forms must be handled
# in cases 1 and 2, otherwise a bare version falls through to case 3 and gets a
# second prefix prepended, e.g. "v1.2.3" -> "v1.2.3.4 v1.2.3". The CI workflow
# .github/workflows/pr-title-sync.yml feeds real PR titles through this and then
# `gh pr edit`s the result, so the duplicated title would be written back.
#
# The version-prefix regex matches two or more dot-separated digit segments
# (covers v1.2, v1.2.3, v1.2.3.4) so the rule is portable across repos that
# use 3-part or 4-part versions, but does NOT strip plain words like
# "version 5".

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <NEW_VERSION> <CURRENT_TITLE>" >&2
  exit 2
fi

NEW_VERSION="$1"
TITLE="$2"

# Reject malformed NEW_VERSION early. Real values are dot-separated digits;
# anything with shell pattern metacharacters or whitespace is a caller bug.
if ! printf '%s' "$NEW_VERSION" | grep -qE '^[0-9]+(\.[0-9]+)*$'; then
  echo "error: NEW_VERSION must be dot-separated digits, got: $NEW_VERSION" >&2
  exit 2
fi

# Literal prefix match (case statement is glob-quoted by bash, but our
# regex-validated NEW_VERSION has no glob metacharacters so this is safe).
# Match both "v<NEW_VERSION> <description>" and a bare "v<NEW_VERSION>" title.
case "$TITLE" in
  "v$NEW_VERSION "*|"v$NEW_VERSION")
    printf '%s\n' "$TITLE"
    exit 0
    ;;
esac

# Strip an existing different version prefix whether it is followed by a space
# (then a description) or sits at the end of the title (bare version).
REST=$(printf '%s' "$TITLE" | sed -E 's/^v[0-9]+(\.[0-9]+)+( |$)//')
if [ -n "$REST" ]; then
  printf 'v%s %s\n' "$NEW_VERSION" "$REST"
else
  # Title was nothing but a (different) version prefix; emit the bare new one.
  printf 'v%s\n' "$NEW_VERSION"
fi
