#!/usr/bin/env bash
# verify-rls.sh — smoke test the telemetry project's access rules after
# applying migrations 005-008.
#
# Verifies, for the public key (anon) and for a signed-in user
# (a JWT whose role is `authenticated`):
#   - every table, view and the pulse function is unreadable
#   - no table accepts an INSERT or UPDATE (008 closed the legacy inserts;
#     every write now goes through the telemetry-ingest edge function)
#
# A check passes only on a permission denial (Postgres error 42501) in the
# response body. A missing table or function fails, except community_benchmarks,
# which may be absent (ABSENT). An invalid JWT, a constraint error or any other
# response fails, so a wrong key or an unapplied migration cannot pass.
#
# Writes nothing: insert probes send an empty row, so a table that wrongly
# accepts the insert still rejects the row on its NOT NULL columns, and the
# check reports that as a failure.
#
# The signed-in checks need a user JWT. Set GSTACK_VERIFY_AUTH_JWT to one, or
# SUPABASE_JWT_SECRET (Dashboard > Settings > JWT, legacy secret) to mint a
# five-minute token for a random user id. Neither is ever printed. Without
# either, the signed-in checks are skipped and the verdict is INCOMPLETE.
#
#   bash supabase/verify-rls.sh
set -uo pipefail
BASH_COMPAT=50

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/config.sh"

URL="$GSTACK_SUPABASE_URL"
KEY="$GSTACK_SUPABASE_ANON_KEY"
PASS=0
FAIL=0
TOTAL=0
SKIPPED=0

# check <role-label> <bearer> <description> <method> <path> [data]
# Every check expects a permission denial, and decides from the response body:
#   - PASS only when the body carries Postgres error 42501 (permission denied).
#   - PGRST205 or PGRST202 (table or function not found) is ABSENT, which
#     counts as a pass for community_benchmarks only. For any other object it
#     is a FAIL: the migration that creates it is not applied.
#   - Anything else is a FAIL: data, an empty read, an update that matched no
#     row, an invalid JWT (401 PGRST301), a write stopped only by a constraint
#     (400 or 409), or a failed connection.
check() {
  local label="$1" bearer="$2" desc="$3" method="$4" path="$5" data="${6:-}"
  TOTAL=$(( TOTAL + 1 ))

  local resp_file
  resp_file="$(mktemp "${TMPDIR:-/tmp}/verify-rls-XXXXXX")" || {
    echo "verify-rls: mktemp failed, aborting" >&2
    return 1
  }
  local hdr_file
  hdr_file="$(mktemp "${TMPDIR:-/tmp}/verify-rls-hdr-XXXXXX")" || {
    rm -f "$resp_file"; echo "verify-rls: mktemp failed, aborting" >&2
    return 1
  }
  chmod 600 "$hdr_file" 2>/dev/null || true
  printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\n' "$KEY" "$bearer" > "$hdr_file"

  local http_code
  case "$method" in
    GET)   http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 -H @"$hdr_file" \
             "${URL}/rest/v1/${path}" 2>/dev/null)" || http_code="000" ;;
    POST)  http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 -H @"$hdr_file" \
             -H "Prefer: return=minimal" -X POST "${URL}/rest/v1/${path}" -d "$data" 2>/dev/null)" || http_code="000" ;;
    PATCH) http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 -H @"$hdr_file" \
             -X PATCH "${URL}/rest/v1/${path}" -d "$data" 2>/dev/null)" || http_code="000" ;;
  esac
  rm -f "$hdr_file" 2>/dev/null || true
  http_code="$(echo "$http_code" | grep -oE '[0-9]{3}$' || echo "000")"

  local body object
  body="$(cat "$resp_file" 2>/dev/null || echo "")"
  rm -f "$resp_file" 2>/dev/null || true
  object="${path%%\?*}"
  object="${object#rpc/}"

  if [ "$http_code" = "000" ]; then
    echo "  FAIL  [$label] $desc (connection failed)"
    FAIL=$(( FAIL + 1 ))
  elif [[ "$body" == *'"42501"'* ]]; then
    echo "  PASS  [$label] $desc (HTTP $http_code, permission denied)"
    PASS=$(( PASS + 1 ))
  elif [[ "$body" == *PGRST205* || "$body" == *PGRST202* ]]; then
    if [ "$object" = "community_benchmarks" ]; then
      echo "  ABSENT [$label] $desc (HTTP $http_code, not present)"
      PASS=$(( PASS + 1 ))
    else
      echo "  FAIL  [$label] $desc (HTTP $http_code: $object not found; is its migration applied?)"
      FAIL=$(( FAIL + 1 ))
    fi
  elif [[ "$body" == *PGRST301* ]]; then
    echo "  FAIL  [$label] $desc (HTTP $http_code: JWT rejected, so nothing was checked)"
    FAIL=$(( FAIL + 1 ))
  elif [ "$http_code" = "200" ] || [ "$http_code" = "204" ] || [ "$http_code" = "201" ]; then
    if [ "$method" = "GET" ] && { [ "$body" = "[]" ] || [ -z "$body" ]; }; then
      echo "  FAIL  [$label] $desc (HTTP $http_code: readable, empty only because of row filtering)"
    elif [ "$method" = "PATCH" ]; then
      echo "  FAIL  [$label] $desc (HTTP $http_code: update permitted, no row matched)"
    else
      echo "  FAIL  [$label] $desc (HTTP $http_code: got data!)"
    fi
    FAIL=$(( FAIL + 1 ))
  elif [ "$http_code" = "400" ] || [ "$http_code" = "409" ]; then
    echo "  FAIL  [$label] $desc (HTTP $http_code: write permitted, stopped only by a constraint)"
    FAIL=$(( FAIL + 1 ))
  else
    echo "  FAIL  [$label] $desc (HTTP $http_code, not a permission denial)"
    FAIL=$(( FAIL + 1 ))
  fi
}

check_all() {
  local label="$1" bearer="$2"
  echo "Reads ($label):"
  for rel in telemetry_events installations update_checks community_pulse_cache community_benchmarks \
             crash_clusters telemetry_live_events; do
    check "$label" "$bearer" "SELECT $rel" GET "${rel}?select=*&limit=1"
  done
  check "$label" "$bearer" "SELECT skill_sequences" GET "skill_sequences?select=skill_a&limit=1"
  check "$label" "$bearer" "CALL community_pulse_summary" POST "rpc/community_pulse_summary" '{}'
  echo ""
  echo "Writes ($label):"
  for rel in telemetry_events installations update_checks; do
    check "$label" "$bearer" "INSERT $rel" POST "$rel" '{}'
  done
  check "$label" "$bearer" "UPDATE installations" PATCH "installations?installation_id=eq.verify_rls_none" '{"gstack_version":"x"}'
  echo ""
}

mint_jwt() {
  [ -n "${SUPABASE_JWT_SECRET:-}" ] || return 1
  command -v python3 >/dev/null 2>&1 || { echo "verify-rls: python3 is needed to mint a JWT" >&2; return 1; }
  python3 - <<'PY'
import base64, hashlib, hmac, json, os, time, uuid
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b64(json.dumps({"role": "authenticated", "aud": "authenticated", "sub": str(uuid.uuid4()),
                       "iat": now, "exp": now + 300}).encode())
sig = hmac.new(os.environ["SUPABASE_JWT_SECRET"].encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
print(f"{head}.{body}.{b64(sig)}")
PY
}

echo "Access verification (migrations 005-008)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
check_all "anon" "$KEY"

USER_JWT="${GSTACK_VERIFY_AUTH_JWT:-}"
[ -n "$USER_JWT" ] || USER_JWT="$(mint_jwt 2>/dev/null || true)"
if [ -n "$USER_JWT" ]; then
  check_all "signed-in" "$USER_JWT"
else
  echo "SKIP  signed-in checks: set GSTACK_VERIFY_AUTH_JWT or SUPABASE_JWT_SECRET to run them"
  SKIPPED=1
  echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed (of $TOTAL checks)"

if [ "$FAIL" -gt 0 ]; then
  echo "VERDICT: FAIL"
  exit 1
elif [ "$SKIPPED" -gt 0 ]; then
  echo "VERDICT: INCOMPLETE — public-key checks passed; signed-in checks not run"
  exit 2
else
  echo "VERDICT: PASS — the public key and signed-in users can read and write nothing"
  exit 0
fi
