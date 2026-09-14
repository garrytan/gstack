#!/usr/bin/env bash
set -e

if git_head="$(git rev-parse HEAD 2>/dev/null)"; then
  :
else
  git_head=""
fi

for version_file in "$@"; do
  mkdir -p "$(dirname "$version_file")"
  printf '%s\n' "$git_head" > "$version_file"
done
