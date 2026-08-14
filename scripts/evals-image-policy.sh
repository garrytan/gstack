#!/usr/bin/env bash
set -eu

EVENT_NAME=${1:-}
HEAD_REPOSITORY=${2:-}
BASE_REPOSITORY=${3:-}
ACTOR=${4:-}

# GitHub downgrades pull_request tokens from forks and Dependabot to read-only
# and withholds Actions secrets. Those contexts may validate the Dockerfile,
# but they must not publish images or start secret-backed eval/report jobs.
if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  echo true
elif [ "$EVENT_NAME" = "pull_request" ] && [ -n "$ACTOR" ] \
  && [ "$HEAD_REPOSITORY" = "$BASE_REPOSITORY" ] && [ "$ACTOR" != "dependabot[bot]" ]; then
  echo true
else
  echo false
fi
