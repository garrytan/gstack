#!/usr/bin/env bash
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

EVENT_TYPE="${1:-}"
SLUG="${2:-}"

if [ -z "$EVENT_TYPE" ] || [ -z "$SLUG" ]; then
  exit 0
fi

# Global bams root: all projects share ~/.bams/ for cross-project visibility
# Override: BAMS_ROOT env var (same name used in event-store.ts, app.ts, global-root.ts)
BAMS_ROOT="${BAMS_ROOT:-$HOME/.bams}"
mkdir -p "$BAMS_ROOT" 2>/dev/null || true
EVENTS_FILE="${BAMS_ROOT}/artifacts/pipeline/${SLUG}-events.jsonl"
AGENTS_DIR="${BAMS_ROOT}/artifacts/agents"
mkdir -p "$(dirname "$EVENTS_FILE")" 2>/dev/null || true
mkdir -p "$AGENTS_DIR" 2>/dev/null || true
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TODAY=$(date -u +%Y-%m-%d)
AGENTS_FILE="$AGENTS_DIR/${TODAY}.jsonl"

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
    frontend-engineering|backend-engineering|platform-devops|data-integration) echo "engineering" ;;
    design-director|ui-designer|ux-designer|graphic-designer|motion-designer|design-system-agent) echo "design" ;;
    product-analytics|experimentation|performance-evaluation|business-kpi) echo "evaluation" ;;
    qa-strategy|automation-qa|defect-triage|release-quality-gate) echo "qa" ;;
    pipeline-orchestrator|cross-department-coordinator|executive-reporter|resource-optimizer|hr-agent) echo "management" ;;
    *) echo "general" ;;
  esac
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
    jq -cn --arg slug "$SLUG" --arg ptype "${3:-unknown}" --arg cmd "${4:-}" --arg args "${5:-}" --arg parent "$_PARENT" --arg wu "$ACTIVE_WU" --arg ts "$TS" \
      '{type:"pipeline_start",pipeline_slug:$slug,pipeline_type:$ptype,command:$cmd,arguments:$args,ts:$ts}
       + (if $parent != "" then {parent_pipeline_slug:$parent} else {} end)
       + (if $wu != "" then {work_unit_slug:$wu} else {} end)' >> "$EVENTS_FILE"
    # Record pipeline link in work unit file
    if [ -n "$ACTIVE_WU" ]; then
      WU_FILE="${BAMS_ROOT}/artifacts/pipeline/${ACTIVE_WU}-workunit.jsonl"
      jq -cn --arg wu "$ACTIVE_WU" --arg slug "$SLUG" --arg ptype "${3:-unknown}" --arg ts "$TS" \
        '{type:"pipeline_linked",work_unit_slug:$wu,pipeline_slug:$slug,pipeline_type:$ptype,ts:$ts}' >> "$WU_FILE"
    fi
    ;;
  pipeline_end)
    # Auto-calculate step counts from event file if not explicitly provided
    _P_STATUS="${3:-completed}"
    _P_TOTAL="${4:-0}"
    _P_COMPLETED="${5:-0}"
    _P_FAILED="${6:-0}"
    _P_SKIPPED="${7:-0}"
    if [ "$_P_TOTAL" = "0" ] && [ -f "$EVENTS_FILE" ]; then
      # Count unique step_end events by status
      _P_TOTAL=$(grep -c '"step_start"' "$EVENTS_FILE" 2>/dev/null || echo 0)
      _P_COMPLETED=$(grep '"step_end"' "$EVENTS_FILE" 2>/dev/null | grep -c '"status":"done"' 2>/dev/null | tr -d '\n' | head -1 || echo 0)
      _P_FAILED=$(grep '"step_end"' "$EVENTS_FILE" 2>/dev/null | grep -c '"status":"fail"' 2>/dev/null | tr -d '\n' | head -1 || echo 0)
      _P_SKIPPED=$(grep '"step_end"' "$EVENTS_FILE" 2>/dev/null | grep -c '"status":"skipped"' 2>/dev/null | tr -d '\n' | head -1 || echo 0)
      # Ensure values are pure integers (strip any trailing newlines or extra output)
      _P_TOTAL=$(printf '%s' "$_P_TOTAL" | tr -d '\n ' | grep -E '^[0-9]+$' || echo 0)
      _P_COMPLETED=$(printf '%s' "$_P_COMPLETED" | tr -d '\n ' | grep -E '^[0-9]+$' || echo 0)
      _P_FAILED=$(printf '%s' "$_P_FAILED" | tr -d '\n ' | grep -E '^[0-9]+$' || echo 0)
      _P_SKIPPED=$(printf '%s' "$_P_SKIPPED" | tr -d '\n ' | grep -E '^[0-9]+$' || echo 0)
    fi
    jq -cn --arg slug "$SLUG" --arg status "$_P_STATUS" --argjson total "$_P_TOTAL" --argjson completed "$_P_COMPLETED" --argjson failed "$_P_FAILED" --argjson skipped "$_P_SKIPPED" --arg ts "$TS" \
      '{type:"pipeline_end",pipeline_slug:$slug,status:$status,total_steps:$total,completed_steps:$completed,failed_steps:$failed,skipped_steps:$skipped,ts:$ts}' >> "$EVENTS_FILE"
    ;;
  step_start)
    jq -cn --arg slug "$SLUG" --argjson num "${3:-0}" --arg name "${4:-}" --arg phase "${5:-}" --arg ts "$TS" \
      '{type:"step_start",pipeline_slug:$slug,step_number:$num,step_name:$name,phase:$phase,ts:$ts}' >> "$EVENTS_FILE"
    ;;
  step_end)
    jq -cn --arg slug "$SLUG" --argjson num "${3:-0}" --arg status "${4:-done}" --argjson dur "${5:-0}" --arg ts "$TS" \
      '{type:"step_end",pipeline_slug:$slug,step_number:$num,status:$status,duration_ms:$dur,ts:$ts}' >> "$EVENTS_FILE"
    ;;
  agent_start)
    CALL_ID="${3:-}"
    AGENT_TYPE="${4:-general-purpose}"
    DEPT=$(dept_map "$AGENT_TYPE")
    TRACE_ID="${SLUG}-$(date -u +%Y%m%dT%H%M%SZ)"
    # Get current step_number from pipeline events
    STEP_NUM="null"
    if [ -f "$EVENTS_FILE" ]; then
      STEP_NUM=$(grep '"step_start"' "$EVENTS_FILE" 2>/dev/null | tail -1 | jq -r '.step_number // empty' 2>/dev/null || echo "null")
      [ -z "$STEP_NUM" ] && STEP_NUM="null"
    fi
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
    printf '%s\n' "$EVENT" >> "$EVENTS_FILE"
    printf '%s\n' "$EVENT" >> "$AGENTS_FILE" 2>/dev/null || true
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
    printf '%s\n' "$EVENT" >> "$EVENTS_FILE"
    printf '%s\n' "$EVENT" >> "$AGENTS_FILE" 2>/dev/null || true
    # 토큰 사용량이 전달된 경우 Control Plane에 기록 (B4: CostDB 연동)
    # 8번째 인자($8): token_usage JSON {"input_tokens":N,"output_tokens":N,"model":"..."} 또는 "null"
    TOKEN_USAGE="${8:-null}"
    if [ -n "$TOKEN_USAGE" ] && [ "$TOKEN_USAGE" != "null" ]; then
      _IN_TOK=$(echo "$TOKEN_USAGE" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
      _OUT_TOK=$(echo "$TOKEN_USAGE" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
      _MODEL=$(echo "$TOKEN_USAGE" | jq -r '.model // empty' 2>/dev/null || echo "")
      [ -z "$_MODEL" ] && _MODEL="$AGENT_TYPE"
      curl -s --max-time 1 -X POST http://localhost:3099/api/costs \
        -H "Content-Type: application/json" \
        -d "$(jq -cn \
          --arg slug "$SLUG" \
          --arg agent "$AGENT_TYPE" \
          --arg model "$_MODEL" \
          --argjson input "$_IN_TOK" \
          --argjson output "$_OUT_TOK" \
          '{pipeline_slug:$slug,agent_slug:$agent,model:$model,input_tokens:$input,output_tokens:$output,billed_cents:0}')" \
        > /dev/null 2>&1 || true
    fi
    ;;
  recover)
    # Scan event file for unmatched start events and emit interrupted end events.
    # Usage: bash bams-viz-emit.sh recover <slug>
    if [ ! -f "$EVENTS_FILE" ]; then
      exit 0
    fi
    RECOVER_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # 1. Find agent_start entries without matching agent_end
    while IFS= read -r _line; do
      _CALL_ID=$(printf '%s' "$_line" | jq -r '.call_id // empty' 2>/dev/null)
      _AGENT_TYPE=$(printf '%s' "$_line" | jq -r '.agent_type // empty' 2>/dev/null)
      [ -z "$_CALL_ID" ] && continue
      if ! grep -q '"agent_end"' "$EVENTS_FILE" 2>/dev/null ||          ! grep '"agent_end"' "$EVENTS_FILE" 2>/dev/null | grep -q ""call_id":"$_CALL_ID""; then
        jq -cn           --arg call_id "$_CALL_ID"           --arg agent_type "$_AGENT_TYPE"           --arg slug "$SLUG"           --arg ts "$RECOVER_TS"           '{type:"agent_end",call_id:$call_id,agent_type:$agent_type,status:"interrupted",is_error:true,duration_ms:null,result_summary:"session interrupted — recovered",output:"",token_usage:null,ts:$ts,pipeline_slug:$slug}' >> "$EVENTS_FILE"
      fi
    done < <(grep '"agent_start"' "$EVENTS_FILE" 2>/dev/null || true)
    # 2. Find step_start entries without matching step_end
    while IFS= read -r _line; do
      _STEP_NUM=$(printf '%s' "$_line" | jq -r '.step_number // empty' 2>/dev/null)
      [ -z "$_STEP_NUM" ] && continue
      if ! grep -q '"step_end"' "$EVENTS_FILE" 2>/dev/null ||          ! grep '"step_end"' "$EVENTS_FILE" 2>/dev/null | grep -q ""step_number":$_STEP_NUM"; then
        jq -cn           --argjson num "$_STEP_NUM"           --arg slug "$SLUG"           --arg ts "$RECOVER_TS"           '{type:"step_end",pipeline_slug:$slug,step_number:$num,status:"interrupted",duration_ms:0,ts:$ts}' >> "$EVENTS_FILE"
      fi
    done < <(grep '"step_start"' "$EVENTS_FILE" 2>/dev/null || true)
    # 3. If pipeline_start exists without pipeline_end, emit pipeline_end(interrupted)
    if grep -q '"pipeline_start"' "$EVENTS_FILE" 2>/dev/null &&        ! grep -q '"pipeline_end"' "$EVENTS_FILE" 2>/dev/null; then
      jq -cn         --arg slug "$SLUG"         --arg ts "$RECOVER_TS"         '{type:"pipeline_end",pipeline_slug:$slug,status:"interrupted",total_steps:0,completed_steps:0,failed_steps:0,skipped_steps:0,ts:$ts}' >> "$EVENTS_FILE"
    fi
    ;;
  work_unit_start)
    WU_FILE="${BAMS_ROOT}/artifacts/pipeline/${SLUG}-workunit.jsonl"
    WU_NAME="${3:-$SLUG}"
    jq -cn --arg slug "$SLUG" --arg name "$WU_NAME" --arg ts "$TS" \
      '{type:"work_unit_start",work_unit_slug:$slug,work_unit_name:$name,ts:$ts}' >> "$WU_FILE"
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
    WU_FILE="${BAMS_ROOT}/artifacts/pipeline/${SLUG}-workunit.jsonl"
    jq -cn --arg slug "$SLUG" --arg status "${3:-completed}" --arg ts "$TS" \
      '{type:"work_unit_end",work_unit_slug:$slug,status:$status,ts:$ts}' >> "$WU_FILE"
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
    jq -cn --arg slug "$SLUG" --arg msg "${3:-}" --argjson num "${4:-0}" --arg code "${5:-unknown}" --arg ts "$TS" \
      '{type:"error",pipeline_slug:$slug,message:$msg,step_number:$num,error_code:$code,ts:$ts}' >> "$EVENTS_FILE"
    ;;
esac

exit 0
