#!/usr/bin/env bash
# Smoke test for _parse_session_limit_reset_epoch in run-agent.sh.
# Verifies the parser recognizes the four shapes Claude emits and ignores
# unrelated text.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_AGENT="$SCRIPT_DIR/../run-agent.sh"

if [ ! -f "$RUN_AGENT" ]; then
  echo "FAIL: cannot find run-agent.sh at $RUN_AGENT"
  exit 1
fi

# Pull the function definition out of run-agent.sh so we can source it without
# executing the rest of the script. The function is delimited by its name on a
# line and the matching closing brace at column 0.
TMP_FN=$(mktemp -t hibernate-parser-fn.XXXXXX.sh)
trap 'rm -f "$TMP_FN"' EXIT

awk '
  /^_parse_session_limit_reset_epoch\(\) \{$/ { capture=1 }
  capture { print }
  capture && /^\}$/ { exit }
' "$RUN_AGENT" > "$TMP_FN"

if [ ! -s "$TMP_FN" ]; then
  echo "FAIL: could not extract _parse_session_limit_reset_epoch from $RUN_AGENT"
  exit 1
fi

# shellcheck disable=SC1090
source "$TMP_FN"
export HIBERNATE_TZ_FALLBACK="${HIBERNATE_TZ_FALLBACK:-Africa/Johannesburg}"

NOW=$(date +%s)
PASS=0
FAIL=0

# Assert helper. Args: label, input_text, predicate (one of: nonempty, empty, zero,
# future_within_seconds:N, past).
assert_parse() {
  local label="$1"
  local input="$2"
  local pred="$3"
  local out
  out=$(printf '%s' "$input" | _parse_session_limit_reset_epoch || true)

  case "$pred" in
    empty)
      if [ -z "$out" ]; then
        PASS=$((PASS+1)); echo "  pass: $label"
      else
        FAIL=$((FAIL+1)); echo "  FAIL: $label -> expected empty, got '$out'"
      fi
      ;;
    zero)
      if [ "$out" = "0" ]; then
        PASS=$((PASS+1)); echo "  pass: $label"
      else
        FAIL=$((FAIL+1)); echo "  FAIL: $label -> expected 0, got '$out'"
      fi
      ;;
    nonempty)
      if [ -n "$out" ]; then
        PASS=$((PASS+1)); echo "  pass: $label ($out)"
      else
        FAIL=$((FAIL+1)); echo "  FAIL: $label -> expected nonempty, got ''"
      fi
      ;;
    future_within_seconds:*)
      local cap="${pred#future_within_seconds:}"
      if [ -n "$out" ] && [ "$out" != "0" ] && [ "$out" -gt "$NOW" ] && \
         [ "$((out - NOW))" -le "$cap" ]; then
        PASS=$((PASS+1)); echo "  pass: $label (in $((out - NOW))s)"
      else
        FAIL=$((FAIL+1))
        echo "  FAIL: $label -> expected future within ${cap}s, got '$out' (now=$NOW)"
      fi
      ;;
    *)
      FAIL=$((FAIL+1)); echo "  FAIL: $label -> unknown predicate $pred"
      ;;
  esac
}

echo "Parser smoke test (now=$NOW, tz_fallback=$HIBERNATE_TZ_FALLBACK)"

# Negative: no session-limit phrase -> must print nothing
assert_parse "empty input" "" "empty"
assert_parse "unrelated error" "Error: ENOENT no such file" "empty"
assert_parse "rate limit (not session)" "rate limit exceeded, retry later" "empty"

# Positive: relative "resets in 3h27m" -> ~(3h27m) ahead, allow up to 4h
assert_parse "relative 3h27m" \
  "You have hit your session limit · resets in 3h27m" \
  "future_within_seconds:14700"

# Positive: relative "resets in 45m" -> within an hour
assert_parse "relative 45m only" \
  "usage limit reached. Resets in 45m" \
  "future_within_seconds:3700"

# Positive: ISO 8601 in the FUTURE — synthesize +2h
FUTURE_ISO=$(python3 -c "
from datetime import datetime, timezone, timedelta
print((datetime.now(timezone.utc) + timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")
assert_parse "ISO 8601 future" \
  "session limit reached. Resets at $FUTURE_ISO" \
  "future_within_seconds:8000"

# Positive: clock time with TZ — always lands on the next occurrence of that
# clock time, so it must be in the future and within 24h+1m of now.
assert_parse "clock 12am Africa/Johannesburg" \
  "You've hit your session limit · resets 12am (Africa/Johannesburg)" \
  "future_within_seconds:86460"

assert_parse "clock 9pm UTC" \
  "session limit · resets 9pm (UTC)" \
  "future_within_seconds:86460"

# Positive: phrase recognised but reset time unparseable -> 0
assert_parse "phrase only, no time" \
  "You have hit your session limit. Please come back later." \
  "zero"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
