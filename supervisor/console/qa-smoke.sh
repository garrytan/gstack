#!/usr/bin/env bash
# supervisor/console/qa-smoke.sh
# Boots the server on a random free port, hits all GET endpoints, and exits 0.
# T9 AC8: uses bun run server.ts; kills server with trap "kill $PID" EXIT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
TMP_DECISIONS=$(mktemp -d)

# T16 AC6/AC7: minimal CONTROL_DIR so validAgents is populated for log + fleet tests.
TMP_CONTROL=$(mktemp -d)
printf 'smoke-test-agent FEATURE_ROLE.md\n' > "${TMP_CONTROL}/fleet.conf"
mkdir -p "${TMP_CONTROL}/ledger"

# T16 AC7: mock PID file with a non-existent PID for fleet/stop test.
PIDS_DIR="${SCRIPT_DIR}/../pids"
mkdir -p "${PIDS_DIR}"
printf '99999\n' > "${PIDS_DIR}/smoke-test-agent.pid"

PID=""
trap 'kill "${PID}" 2>/dev/null || true; rm -rf "${TMP_DECISIONS}" "${TMP_CONTROL}"; rm -f "${PIDS_DIR}/smoke-test-agent.pid"' EXIT

PORT="${PORT}" SUPERVISOR_DECISIONS_DIR="${TMP_DECISIONS}" CONTROL_DIR="${TMP_CONTROL}" \
  bun run "${SCRIPT_DIR}/server.ts" > /dev/null 2>&1 &
PID=$!

# Wait up to 5 s for the server to accept connections.
for i in $(seq 1 25); do
  curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 && break
  sleep 0.2
done

pass=0; fail=0

check() {
  local desc="$1" url="$2" want="${3:-200}" timeout="${4:-5}"
  local got
  got=$(curl -s --max-time "${timeout}" -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null) || true
  if [ "${got}" = "${want}" ]; then
    printf '  ok    %s\n' "${desc}"; pass=$((pass + 1))
  else
    printf '  FAIL  %s (want %s, got %s)\n' "${desc}" "${want}" "${got}" >&2; fail=$((fail + 1))
  fi
}

# T16 AC6: assert HTTP 200 + application/json content-type.
# Uses -D - to dump response headers inline with a GET (HEAD is not handled by endpoints).
check_json() {
  local desc="$1" url="$2"
  local headers status ct_line
  headers=$(curl -s --max-time 5 -D - -o /dev/null "${url}" 2>/dev/null) || headers=""
  status=$(printf '%s' "${headers}" | head -1 | grep -oE '[0-9]{3}' | head -1) || status="000"
  ct_line=$(printf '%s' "${headers}" | grep -i '^content-type:' | tr -d '\r') || ct_line=""
  if [ "${status}" = "200" ] && printf '%s' "${ct_line}" | grep -qi 'application/json'; then
    printf '  ok    %s\n' "${desc}"; pass=$((pass + 1))
  else
    printf '  FAIL  %s (want 200+json, got status=%s ct=%s)\n' "${desc}" "${status}" "${ct_line}" >&2; fail=$((fail + 1))
  fi
}

B="http://127.0.0.1:${PORT}"
check "GET /health"           "${B}/health"
check "GET / (index.html)"    "${B}/"
check "GET /styles.css"       "${B}/styles.css"
check "GET /api/fleet"        "${B}/api/fleet"
check "GET /api/attention"    "${B}/api/attention"
check "GET /api/queue"        "${B}/api/queue"
check "GET /api/events (SSE)" "${B}/api/events" "200" 1

# T13 AC1: pipeline endpoint returns 200 JSON with tasks array (AC4 data prerequisite)
check "GET /api/pipeline"     "${B}/api/pipeline"

# T13 AC7: invalid taskId always returns 400 regardless of CONTROL_DIR
check "GET /api/spec/invalid-id → 400" "${B}/api/spec/invalid-id" "400"

# T13 AC4/AC5: index.html contains pipeline-groups container element
INDEX_BODY=$(curl -sf --max-time 5 "${B}/" 2>/dev/null) || INDEX_BODY=""
if printf '%s' "${INDEX_BODY}" | grep -q 'pipeline-groups'; then
  printf '  ok    index.html contains pipeline-groups element\n'; pass=$((pass + 1))
else
  printf '  FAIL  index.html missing pipeline-groups element\n' >&2; fail=$((fail + 1))
fi

# T13 AC4/AC5: GET /api/pipeline returns JSON with tasks key
PIPELINE_BODY=$(curl -sf --max-time 5 "${B}/api/pipeline" 2>/dev/null) || PIPELINE_BODY=""
if printf '%s' "${PIPELINE_BODY}" | grep -q '"tasks"'; then
  printf '  ok    pipeline JSON contains tasks key\n'; pass=$((pass + 1))
else
  printf '  FAIL  pipeline JSON missing tasks key\n' >&2; fail=$((fail + 1))
fi

# T15 AC1: GET /api/stuck returns 200 with stuck key
check "GET /api/stuck" "${B}/api/stuck"
STUCK_BODY=$(curl -sf --max-time 5 "${B}/api/stuck" 2>/dev/null) || STUCK_BODY=""
if printf '%s' "${STUCK_BODY}" | grep -q '"stuck"'; then
  printf '  ok    stuck JSON contains stuck key\n'; pass=$((pass + 1))
else
  printf '  FAIL  stuck JSON missing stuck key\n' >&2; fail=$((fail + 1))
fi

# T15 AC1/AC2: index.html contains stuck-cards container element
if printf '%s' "${INDEX_BODY}" | grep -q 'stuck-cards'; then
  printf '  ok    index.html contains stuck-cards element\n'; pass=$((pass + 1))
else
  printf '  FAIL  index.html missing stuck-cards element\n' >&2; fail=$((fail + 1))
fi

# T15 AC2: stuck-alert-slot element appears before section-attention element in HTML
STUCK_LINE=$(printf '%s' "${INDEX_BODY}" | grep -n 'id="stuck-alert-slot"' | head -1 | cut -d: -f1)
ATTN_LINE=$(printf '%s' "${INDEX_BODY}" | grep -n 'id="section-attention"' | head -1 | cut -d: -f1)
if [ -n "${STUCK_LINE}" ] && [ -n "${ATTN_LINE}" ] && [ "${STUCK_LINE}" -lt "${ATTN_LINE}" ]; then
  printf '  ok    stuck-alert-slot appears before section-attention in DOM\n'; pass=$((pass + 1))
else
  printf '  FAIL  stuck-alert-slot not before section-attention in DOM\n' >&2; fail=$((fail + 1))
fi

# T16 AC6: pipeline, stuck, log endpoints return 200 + application/json content-type.
check_json "GET /api/pipeline JSON content-type"          "${B}/api/pipeline"
check_json "GET /api/stuck JSON content-type"             "${B}/api/stuck"
check_json "GET /api/log/smoke-test-agent JSON"           "${B}/api/log/smoke-test-agent"

# T16 AC7: fleet/stop with mock stale PID returns 200 { ok: true }.
STOP_RESP=$(curl -s --max-time 5 -X POST "${B}/api/fleet/stop?agent=smoke-test-agent" 2>/dev/null) || STOP_RESP=""
if printf '%s' "${STOP_RESP}" | grep -q '"ok":true'; then
  printf '  ok    POST /api/fleet/stop mock stale PID → ok:true\n'; pass=$((pass + 1))
else
  printf '  FAIL  POST /api/fleet/stop mock stale PID → %s\n' "${STOP_RESP}" >&2; fail=$((fail + 1))
fi

printf '\n=== smoke: %d passed, %d failed ===\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
