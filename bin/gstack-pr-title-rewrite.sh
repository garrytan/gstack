#!/usr/bin/env bash
# Rewrite a PR/MR title to start with v<NEW_VERSION>.
#
# Usage:  bin/gstack-pr-title-rewrite.sh <NEW_VERSION> <CURRENT_TITLE>
# Output: corrected title on stdout.
#
# Rule: PR titles MUST start with v<NEW_VERSION>. Three cases:
#   1. Already starts with "v<NEW_VERSION> " -> no change.
#   2. Starts with a different "v<digits and dots> " prefix -> replace prefix.
#   3. No version prefix -> prepend "v<NEW_VERSION> ".
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
case "$TITLE" in
  "v$NEW_VERSION "*)
    printf '%s\n' "$TITLE"
    exit 0
    ;;
esac

REST=$(printf '%s' "$TITLE" | sed -E 's/^v[0-9]+(\.[0-9]+)+ //')
printf 'v%s %s\n' "$NEW_VERSION" "$REST"
