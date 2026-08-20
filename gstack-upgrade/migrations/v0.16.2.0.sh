#!/usr/bin/env bash
# Migration: v0.16.2.0 — Merge per-project resource logs into builder profile
#
# What changed: resource dedup moved from per-project resources-shown.jsonl to
# the global builder-profile.jsonl (single source of truth for all closing state).
#
# What this does: finds all per-project resources-shown.jsonl files and merges
# their URLs into a stub builder-profile entry so existing users don't lose
# their dedup history. Idempotent — safe to run multiple times.
#
# Affected: users who ran /office-hours before this version
set -euo pipefail

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
PROFILE_FILE="$GSTACK_HOME/builder-profile.jsonl"

# Find all per-project resource logs
RESOURCE_FILES=$(find "$GSTACK_HOME/projects" -name "resources-shown.jsonl" 2>/dev/null || true)

if [ -z "$RESOURCE_FILES" ]; then
  # No per-project resource files exist — clean install, nothing to migrate
  exit 0
fi

echo "  [v0.16.2.0] Migrating per-project resource logs to builder profile..."

# Collect all unique URLs from all per-project files
ALL_URLS=$(echo "$RESOURCE_FILES" | while read -r f; do
  [ -f "$f" ] && cat "$f" 2>/dev/null || true
done | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"//' | sort -u)

if [ -z "$ALL_URLS" ]; then
  exit 0
fi

# Check if builder-profile already has resource data (idempotency)
if [ -f "$PROFILE_FILE" ] && grep -q "resources_shown" "$PROFILE_FILE" 2>/dev/null; then
  # Already has resource data, check if it includes the migrated URLs
  EXISTING_URLS=$(grep -o '"resources_shown":\[[^]]*\]' "$PROFILE_FILE" 2>/dev/null | grep -o 'https://[^"]*' | sort -u)
  NEW_URLS=$(comm -23 <(echo "$ALL_URLS") <(echo "$EXISTING_URLS") 2>/dev/null || echo "$ALL_URLS")
  if [ -z "$NEW_URLS" ]; then
    # All URLs already present — nothing to do
    exit 0
  fi
fi

# Build JSON array of URLs
URL_ARRAY=$(echo "$ALL_URLS" | awk 'BEGIN{printf "["} NR>1{printf ","} {printf "\"%s\"", $0} END{printf "]"}')

# Append a migration stub entry to the builder profile
mkdir -p "$GSTACK_HOME"
echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"mode\":\"migration\",\"project_slug\":\"_migrated\",\"signal_count\":0,\"signals\":[],\"design_doc\":\"\",\"assignment\":\"\",\"resources_shown\":$URL_ARRAY,\"topics\":[]}" >> "$PROFILE_FILE"

echo "  [v0.16.2.0] Migrated $(echo "$ALL_URLS" | wc -l | tr -d ' ') resource URLs to builder profile."
