#!/usr/bin/env bash
# Migration: v1.0.0.0 — V1 writing style prompt
#
# What changed: tier-≥2 skills default to ELI10 writing style (jargon glossed on
# first use, outcome-framed questions, short sentences). Power users who prefer
# the older V0 prose can set `gstack-config set explain_level terse`.
#
# What this does: writes a "pending prompt" flag file. On the first tier-≥2 skill
# invocation after upgrade, the preamble reads the flag and asks the user once
# whether to keep the new default or opt into terse mode. Flag file is deleted
# after the user answers. Idempotent — safe to run multiple times.
#
# Affected: every user on v0.19.x and below who upgrades to v1.x
set -euo pipefail

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
PROMPTED_FLAG="$GSTACK_HOME/.writing-style-prompted"
PENDING_FLAG="$GSTACK_HOME/.writing-style-prompt-pending"

mkdir -p "$GSTACK_HOME"

# If the user has already answered the prompt at any point, skip.
if [ -f "$PROMPTED_FLAG" ]; then
  exit 0
fi

# If the user has already explicitly set explain_level (either way), count that
# as an answer — they've made their choice, don't ask again.
EXPLAIN_LEVEL_SET="$("${HOME}/.claude/skills/gstack/bin/gstack-config" get explain_level 2>/dev/null || true)"
if [ -n "$EXPLAIN_LEVEL_SET" ]; then
  touch "$PROMPTED_FLAG"
  exit 0
fi

# Write the pending flag — preamble will see it on the first tier-≥2 skill invocation.
touch "$PENDING_FLAG"

echo "  [v1.0.0.0] V1 writing style: you'll see a one-time prompt on your next skill run asking if you want the new default (glossed jargon, outcome framing) or the older terse prose."
