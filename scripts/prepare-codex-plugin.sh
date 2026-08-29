#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

GSTACK_SKIP_COREUTILS=1 CODEX_HOME="$tmp" ./setup --host codex -q
rm -rf plugins/gstack/skills
mkdir -p plugins/gstack
cp -RL "$tmp/skills/." plugins/gstack/skills

test -x plugins/gstack/skills/gstack/bin/gstack-skill-start
