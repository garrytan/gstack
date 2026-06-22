#!/usr/bin/env bash
# supervisor/console/qa-smoke.sh
# Boots the server on a random free port, hits all GET endpoints, and exits 0.
# T9 AC8: uses bun run server.ts; kills server with trap "kill $PID" EXIT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
TMP_DECISIONS=$(mktemp -d)

PID=""
trap 'kill "${PID}" 2>/dev/null || true; rm -rf "${TMP_DECISIONS}"' EXIT

PORT="${PORT}" SUPERVISOR_DECISIONS_DIR="${TMP_DECISIONS}" \
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

printf '\n=== smoke: %d passed, %d failed ===\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
