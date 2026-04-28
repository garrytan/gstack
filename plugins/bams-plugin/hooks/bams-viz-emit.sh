#!/usr/bin/env bash
umask 077  # Ensure new files (logs, tmp) are created with 0600 permission
# bams-viz-emit.sh — Pipeline/step event emit helper
# Called from pipeline commands (feature, dev, hotfix, etc.)
#
# Usage:
#   bash bams-viz-emit.sh pipeline_start <slug> <type> [command] [arguments]
#   bash bams-viz-emit.sh pipeline_end   <slug> <status> [total] [completed] [failed] [skipped]
#   bash bams-viz-emit.sh step_start     <slug> <step_number> <step_name> <phase>
#   bash bams-viz-emit.sh step_end       <slug> <step_number> <status> [duration_ms]
#   bash bams-viz-emit.sh agent_start    <slug> <call_id> <agent_type> [model] [description] [prompt_summary]
#   bash bams-viz-emit.sh agent_end      <slug> <call_id> <agent_type> <status> [duration_ms] [result_summary]
#   bash bams-viz-emit.sh work_unit_start <slug> [name]
#   bash bams-viz-emit.sh work_unit_end   <slug> [status]
#   bash bams-viz-emit.sh error          <slug> <message> [step_number] [error_code]
set -uo pipefail

# Unicode/multibyte slug 안전 처리 (한글 slug 지원)
LANG="${LANG:-en_US.UTF-8}"
LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LANG LC_ALL

EVENT_TYPE="${1:-}"
SLUG="${2:-}"

if [ -z "$EVENT_TYPE" ] || [ -z "$SLUG" ]; then
  exit 0
fi

# Global bams root: all projects share ~/.bams/ for cross-project visibility
# Override: BAMS_ROOT env var (same name used in event-store.ts, app.ts, global-root.ts)
BAMS_ROOT="${BAMS_ROOT:-$HOME/.bams}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Active work units JSON array file (supports parallel work units)
# Format: [{"slug":"...","name":"...","startedAt":"..."},...]
ACTIVE_WU_FILE="/tmp/bams-active-workunits.json"

# wu_list_read: read the active work units JSON array; returns [] if absent or invalid
wu_list_read() {
  if [ -f "$ACTIVE_WU_FILE" ]; then
    jq -e '.' "$ACTIVE_WU_FILE" 2>/dev/null || echo "[]"
  else
    echo "[]"
  fi
}

# wu_list_write: atomically write the JSON array to the active work units file
wu_list_write() {
  local data="$1"
  printf '%s\n' "$data" > "${ACTIVE_WU_FILE}.tmp" && mv "${ACTIVE_WU_FILE}.tmp" "$ACTIVE_WU_FILE"
}

# wu_latest_slug: return the slug of the most recently started active work unit, or ""
wu_latest_slug() {
  local list
  list=$(wu_list_read)
  printf '%s' "$list" | jq -r 'if length > 0 then last.slug else "" end' 2>/dev/null || echo ""
}

# Migrate legacy single-file tracker to JSON array (one-time, backward-compat)
if [ -f /tmp/bams-active-workunit ] && [ ! -f "$ACTIVE_WU_FILE" ]; then
  _LEGACY_SLUG=$(cat /tmp/bams-active-workunit 2>/dev/null | tr -d '[:space:]')
  if [ -n "$_LEGACY_SLUG" ]; then
    wu_list_write "[{\"slug\":\"${_LEGACY_SLUG}\",\"name\":\"${_LEGACY_SLUG}\",\"startedAt\":\"${TS}\"}]"
  fi
  # Keep legacy file in place so other tools that haven't updated yet still work;
  # it will naturally become stale and can be removed once all callers migrate.
fi

# Department mapping from agent_type
dept_map() {
  case "$1" in
    product-strategy|business-analysis|ux-research|project-governance) echo "planning" ;;
    frontend-engineering) echo "engineering-frontend" ;;
    backend-engineering) echo "engineering-backend" ;;
    platform-devops|data-integration) echo "engineering-platform" ;;
    design-director|ui-designer|ux-designer|graphic-designer|motion-designer|design-system-agent) echo "design" ;;
    product-analytics|experimentation|performance-evaluation|business-kpi) echo "evaluation" ;;
    qa-strategy|automation-qa|defect-triage|release-quality-gate) echo "qa" ;;
    pipeline-orchestrator|cross-department-coordinator|executive-reporter|resource-optimizer|hr-agent) echo "management" ;;
    *) echo "general" ;;
  esac
}

# ── DB 이벤트 전송 ──
# 서버 미가동 시에도 || true로 emit.sh 실패 방지
BAMS_SERVER_URL="${BAMS_SERVER_URL:-http://localhost:3099}"

# Fallback JSONL 파일 경로 (한글 slug 포함 멀티바이트 안전 처리)
# printf %s를 사용해 echo -n 의 BSD/GNU 차이를 회피
_events_file() {
  local slug="$1"
  local dir="${BAMS_ROOT}/artifacts/pipeline"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s/%s-events.jsonl' "$dir" "$slug"
}

_post_event() {
  local payload="$1"
  # 1) 서버 POST 시도 (BAMS_SERVER_URL이 설정된 경우)
  local _server_ok=0
  if [ -n "${BAMS_SERVER_URL:-}" ]; then
    curl -s --max-time 2 -X POST "${BAMS_SERVER_URL}/api/events" \
      -H "Content-Type: application/json" \
      -d "$payload" > /dev/null 2>&1 && _server_ok=1 || true
  fi
  # 2) fallback file write — 서버 POST 실패하거나 BAMS_SERVER_URL 미설정 시
  if [ "$_server_ok" -eq 0 ]; then
    local _file
    _file="$(_events_file "$SLUG")"
    printf '%s\n' "$payload" >> "$_file" 2>/dev/null || true
  fi
}

case "$EVENT_TYPE" in
  pipeline_start)
    _PARENT="${6:-}"
    _WU_ARG="${7:-}"
    # Prefer explicitly passed WU slug ($7); fall back to most recently started active work unit
    if [ -n "$_WU_ARG" ]; then
      ACTIVE_WU="$_WU_ARG"
    else
      ACTIVE_WU=$(wu_latest_slug)
    fi
    _PS_EVT=$(jq -cn --arg slug "$SLUG" --arg ptype "${3:-unknown}" --arg cmd "${4:-}" --arg args "${5:-}" --arg parent "$_PARENT" --arg wu "$ACTIVE_WU" --arg ts "$TS" \
      '{type:"pipeline_start",pipeline_slug:$slug,pipeline_type:$ptype,command:$cmd,arguments:$args,ts:$ts}
       + (if $parent != "" then {parent_pipeline_slug:$parent} else {} end)
       + (if $wu != "" then {work_unit_slug:$wu} else {} end)')
    _post_event "$_PS_EVT"
    # Record pipeline link in work unit file
    if [ -n "$ACTIVE_WU" ]; then
      _WU_EVT=$(jq -cn --arg wu "$ACTIVE_WU" --arg slug "$SLUG" --arg ptype "${3:-unknown}" --arg ts "$TS" \
        '{type:"pipeline_linked",work_unit_slug:$wu,pipeline_slug:$slug,pipeline_type:$ptype,ts:$ts}')
      _post_event "$_WU_EVT"
    fi
    ;;
  pipeline_end)
    # Auto-calculate step counts from event file if not explicitly provided
    _P_STATUS="${3:-completed}"
    _P_TOTAL="${4:-0}"
    _P_COMPLETED="${5:-0}"
    _P_FAILED="${6:-0}"
    _P_SKIPPED="${7:-0}"
    _PE_EVT=$(jq -cn --arg slug "$SLUG" --arg status "$_P_STATUS" --argjson total "$_P_TOTAL" --argjson completed "$_P_COMPLETED" --argjson failed "$_P_FAILED" --argjson skipped "$_P_SKIPPED" --arg ts "$TS" \
      '{type:"pipeline_end",pipeline_slug:$slug,status:$status,total_steps:$total,completed_steps:$completed,failed_steps:$failed,skipped_steps:$skipped,ts:$ts}')
    _post_event "$_PE_EVT"
    ;;
  step_start)
    _SS_EVT=$(jq -cn --arg slug "$SLUG" --argjson num "${3:-0}" --arg name "${4:-}" --arg phase "${5:-}" --arg ts "$TS" \
      '{type:"step_start",pipeline_slug:$slug,step_number:$num,step_name:$name,phase:$phase,ts:$ts}')
    _post_event "$_SS_EVT"
    ;;
  step_end)
    _SE_EVT=$(jq -cn --arg slug "$SLUG" --argjson num "${3:-0}" --arg status "${4:-done}" --argjson dur "${5:-0}" --arg ts "$TS" \
      '{type:"step_end",pipeline_slug:$slug,step_number:$num,status:$status,duration_ms:$dur,ts:$ts}')
    _post_event "$_SE_EVT"
    ;;
  agent_start)
    CALL_ID="${3:-}"
    AGENT_TYPE="${4:-general-purpose}"
    DEPT=$(dept_map "$AGENT_TYPE")
    TRACE_ID="${SLUG}-$(date -u +%Y%m%dT%H%M%SZ)"
    STEP_NUM="null"
    EVENT=$(jq -cn \
      --arg type "agent_start" \
      --arg call_id "$CALL_ID" \
      --arg trace_id "$TRACE_ID" \
      --arg agent_type "$AGENT_TYPE" \
      --arg department "$DEPT" \
      --arg model "${5:-}" \
      --arg description "${6:-}" \
      --arg prompt_summary "$(printf '%s' "${7:-}" | cut -c1-300)" \
      --arg input "$(printf '%s' "${7:-}" | cut -c1-1000)" \
      --argjson step_number "$STEP_NUM" \
      --arg ts "$TS" \
      --arg pipeline_slug "$SLUG" \
      '{type:$type, call_id:$call_id, trace_id:$trace_id, agent_type:$agent_type, department:$department, model:$model, description:$description, prompt_summary:$prompt_summary, input:$input, ts:$ts}
       + (if $step_number != null then {step_number:$step_number} else {} end)
       + (if $pipeline_slug != "" then {pipeline_slug:$pipeline_slug} else {} end)')
    _post_event "$EVENT"
    ;;
  agent_end)
    CALL_ID="${3:-}"
    AGENT_TYPE="${4:-general-purpose}"
    A_STATUS="${5:-success}"
    IS_ERR="false"
    [ "$A_STATUS" = "error" ] && IS_ERR="true"
    EVENT=$(jq -cn \
      --arg type "agent_end" \
      --arg call_id "$CALL_ID" \
      --arg agent_type "$AGENT_TYPE" \
      --argjson is_error "$IS_ERR" \
      --arg status "$A_STATUS" \
      --argjson duration_ms "${6:-null}" \
      --arg result_summary "$(printf '%s' "${7:-}" | cut -c1-300)" \
      --arg output "$(printf '%s' "${7:-}" | cut -c1-1000)" \
      --argjson token_usage "null" \
      --arg ts "$TS" \
      --arg pipeline_slug "$SLUG" \
      '{type:$type, call_id:$call_id, agent_type:$agent_type, is_error:$is_error, status:$status, duration_ms:$duration_ms, result_summary:$result_summary, output:$output, token_usage:$token_usage, ts:$ts}
       + (if $pipeline_slug != "" then {pipeline_slug:$pipeline_slug} else {} end)')
    _post_event "$EVENT"
    ;;
  recover)
    # Scan DB for unmatched start events and emit interrupted end events.
    # Usage: bash bams-viz-emit.sh recover <slug>
    # NOTE: Recovery now queries DB via API. Emit interrupted events to DB only.
    RECOVER_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Emit a recover marker event to DB so the server can handle cleanup
    _R_RECOVER=$(jq -cn \
      --arg slug "$SLUG" \
      --arg ts "$RECOVER_TS" \
      '{type:"recover",pipeline_slug:$slug,ts:$ts}')
    _post_event "$_R_RECOVER"
    ;;
  work_unit_start)
    WU_NAME="${3:-$SLUG}"
    _WUS_EVT=$(jq -cn --arg slug "$SLUG" --arg name "$WU_NAME" --arg ts "$TS" \
      '{type:"work_unit_start",work_unit_slug:$slug,work_unit_name:$name,ts:$ts}')
    _post_event "$_WUS_EVT"
    # Append to active work units JSON array (parallel support)
    _CURRENT_LIST=$(wu_list_read)
    # Remove any existing entry with the same slug (idempotent re-start)
    _UPDATED=$(printf '%s' "$_CURRENT_LIST" | jq --arg s "$SLUG" '[.[] | select(.slug != $s)]')
    # Append new entry
    _UPDATED=$(printf '%s' "$_UPDATED" | jq --arg s "$SLUG" --arg n "$WU_NAME" --arg t "$TS" \
      '. + [{"slug":$s,"name":$n,"startedAt":$t}]')
    wu_list_write "$_UPDATED"
    # Also update legacy single-file tracker for backward compatibility
    echo "$SLUG" > /tmp/bams-active-workunit
    ;;
  work_unit_end)
    _WUE_EVT=$(jq -cn --arg slug "$SLUG" --arg status "${3:-completed}" --arg ts "$TS" \
      '{type:"work_unit_end",work_unit_slug:$slug,status:$status,ts:$ts}')
    _post_event "$_WUE_EVT"
    # Remove only this slug from the active work units JSON array
    _CURRENT_LIST=$(wu_list_read)
    _UPDATED=$(printf '%s' "$_CURRENT_LIST" | jq --arg s "$SLUG" '[.[] | select(.slug != $s)]')
    wu_list_write "$_UPDATED"
    # Update legacy single-file tracker: if the removed slug was the active one,
    # set it to the most recently started remaining work unit (or remove entirely)
    if [ -f /tmp/bams-active-workunit ]; then
      _LEGACY=$(cat /tmp/bams-active-workunit 2>/dev/null | tr -d '[:space:]')
      if [ "$_LEGACY" = "$SLUG" ]; then
        _NEXT=$(printf '%s' "$_UPDATED" | jq -r 'if length > 0 then last.slug else "" end' 2>/dev/null || echo "")
        if [ -n "$_NEXT" ]; then
          echo "$_NEXT" > /tmp/bams-active-workunit
        else
          rm -f /tmp/bams-active-workunit
        fi
      fi
    fi
    ;;
  error)
    _ERR_EVT=$(jq -cn --arg slug "$SLUG" --arg msg "${3:-}" --argjson num "${4:-0}" --arg code "${5:-unknown}" --arg ts "$TS" \
      '{type:"error",pipeline_slug:$slug,message:$msg,step_number:$num,error_code:$code,ts:$ts}')
    _post_event "$_ERR_EVT"
    ;;
esac

exit 0
