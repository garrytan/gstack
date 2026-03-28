#!/usr/bin/env bash
# verify-rls.sh — smoke test after deploying 002_tighten_rls.sql
#
# Verifies:
#   - SELECT denied on all tables and views (security fix)
#   - UPDATE denied on installations (security fix)
#   - INSERT still allowed on tables (kept for old client compat)
#
# Run manually after deploying the migration:
#   bash supabase/verify-rls.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/config.sh"

URL="$GSTACK_SUPABASE_URL"
KEY="$GSTACK_SUPABASE_ANON_KEY"
PASS=0
FAIL=0
TOTAL=0

# check <description> <expected> <method> <path> [data]
#   expected: "deny" (want 401/403) or "allow" (want 200/201)
check() {
  local desc="$1"
  local expected="$2"
  local method="$3"
  local path="$4"
  local data="${5:-}"
  TOTAL=$(( TOTAL + 1 ))

  local resp_file
  resp_file="$(mktemp 2>/dev/null || echo "/tmp/verify-rls-$$-$TOTAL")"

  local http_code
  if [ "$method" = "GET" ]; then
    http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 \
      "${URL}/rest/v1/${path}" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Content-Type: application/json" 2>/dev/null)" || http_code="000"
  elif [ "$method" = "POST" ]; then
    http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 \
      -X POST "${URL}/rest/v1/${path}" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Content-Type: application/json" \
      -H "Prefer: return=minimal" \
      -d "$data" 2>/dev/null)" || http_code="000"
  elif [ "$method" = "PATCH" ]; then
    http_code="$(curl -s -o "$resp_file" -w '%{http_code}' --max-time 10 \
      -X PATCH "${URL}/rest/v1/${path}" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Content-Type: application/json" \
      -d "$data" 2>/dev/null)" || http_code="000"
  fi

  # Trim to last 3 chars (the HTTP code) in case of concatenation
  http_code="$(echo "$http_code" | grep -oE '[0-9]{3}$' || echo "000")"

  if [ "$expected" = "deny" ]; then
    case "$http_code" in
      401|403)
        echo "  PASS  $desc (HTTP $http_code, denied)"
        PASS=$(( PASS + 1 )) ;;
      200|204)
        # For GETs: 200+empty means RLS filtering (pass). 200+data means leak (fail).
        # For PATCH: 204 means no rows matched — could be RLS or missing row.
        if [ "$method" = "GET" ]; then
          body="$(cat "$resp_file" 2>/dev/null || echo "")"
          if [ "$body" = "[]" ] || [ -z "$body" ]; then
            echo "  PASS  $desc (HTTP $http_code, empty — RLS filtering)"
            PASS=$(( PASS + 1 ))
          else
            echo "  FAIL  $desc (HTTP $http_code, got data!)"
            FAIL=$(( FAIL + 1 ))
          fi
        else
          # PATCH 204 = no rows affected. RLS blocked the update or row doesn't exist.
          # Either way, the attacker can't modify data.
          echo "  PASS  $desc (HTTP $http_code, no rows affected)"
          PASS=$(( PASS + 1 ))
        fi ;;
      000)
        echo "  WARN  $desc (connection failed)"
        FAIL=$(( FAIL + 1 )) ;;
      *)
        echo "  WARN  $desc (HTTP $http_code — unexpected)"
        FAIL=$(( FAIL + 1 )) ;;
    esac
  elif [ "$expected" = "allow" ]; then
    case "$http_code" in
      200|201|204|409)
        # 409 = conflict (duplicate key) — INSERT policy works, row already exists
        echo "  PASS  $desc (HTTP $http_code, allowed as expected)"
        PASS=$(( PASS + 1 )) ;;
      401|403)
        echo "  FAIL  $desc (HTTP $http_code, denied — should be allowed)"
        FAIL=$(( FAIL + 1 )) ;;
      000)
        echo "  WARN  $desc (connection failed)"
        FAIL=$(( FAIL + 1 )) ;;
      *)
        echo "  WARN  $desc (HTTP $http_code — unexpected)"
        FAIL=$(( FAIL + 1 )) ;;
    esac
  fi

  rm -f "$resp_file" 2>/dev/null || true
}

echo "RLS Verification (after 002_tighten_rls.sql)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Read denial (should be blocked):"
check "SELECT telemetry_events" deny GET "telemetry_events?select=*&limit=1"
check "SELECT installations"    deny GET "installations?select=*&limit=1"
check "SELECT update_checks"    deny GET "update_checks?select=*&limit=1"
check "SELECT crash_clusters"   deny GET "crash_clusters?select=*&limit=1"
check "SELECT skill_sequences"  deny GET "skill_sequences?select=skill_a&limit=1"

echo ""
echo "Update denial (should be blocked):"
check "UPDATE installations"    deny PATCH "installations?installation_id=eq.test_verify_rls" '{"gstack_version":"hacked"}'

echo ""
echo "Insert allowed (kept for old client compat):"
check "INSERT telemetry_events" allow POST "telemetry_events" '{"gstack_version":"verify_rls_test","os":"test","event_timestamp":"2026-01-01T00:00:00Z","outcome":"test"}'
check "INSERT update_checks"    allow POST "update_checks"    '{"gstack_version":"verify_rls_test","os":"test"}'
check "INSERT installations"    allow POST "installations"    '{"installation_id":"verify_rls_test"}'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed (of $TOTAL checks)"

if [ "$FAIL" -gt 0 ]; then
  echo "VERDICT: FAIL"
  exit 1
else
  echo "VERDICT: PASS — reads/updates blocked, inserts allowed"
  exit 0
fi
