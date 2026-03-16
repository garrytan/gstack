#!/usr/bin/env bash
# Delivery state machine for the pipeline
# Tracks each PR/task through: WORKING -> PR_CREATING -> CI_RUNNING -> REVIEWING -> APPROVED -> MERGING -> MERGED | BLOCKED
#
# Usage:
#   delivery-state.sh init <task-id> <branch>
#   delivery-state.sh transition <task-id> <new-state>
#   delivery-state.sh get <task-id>
#   delivery-state.sh list [--state <state>]
#   delivery-state.sh cleanup <task-id>

set -eo pipefail

STATE_DIR="${GSTACK_DELIVER_STATE_DIR:-$HOME/.gstack/deliver/state}"
STATE_FILE="$STATE_DIR/deliveries.json"

# Ensure state file exists
_init_state_file() {
    if [[ ! -d "$STATE_DIR" ]]; then
        mkdir -p "$STATE_DIR"
    fi
    if [[ ! -f "$STATE_FILE" ]]; then
        echo '{"deliveries":{}}' > "$STATE_FILE"
    fi
}

# Validate state name
_valid_state() {
    local state="$1"
    case "$state" in
        WORKING|PR_CREATING|CI_RUNNING|REVIEWING|APPROVED|MERGING|MERGED|BLOCKED) return 0 ;;
        *) return 1 ;;
    esac
}

# Validate state transition
_valid_transition() {
    local from="$1" to="$2"
    case "${from}->${to}" in
        "WORKING->PR_CREATING") return 0 ;;
        "PR_CREATING->CI_RUNNING") return 0 ;;
        "CI_RUNNING->REVIEWING") return 0 ;;
        "CI_RUNNING->BLOCKED") return 0 ;;
        "REVIEWING->APPROVED") return 0 ;;
        "REVIEWING->BLOCKED") return 0 ;;
        "APPROVED->MERGING") return 0 ;;
        "MERGING->MERGED") return 0 ;;
        "BLOCKED->WORKING") return 0 ;;
        "BLOCKED->CI_RUNNING") return 0 ;;
        "BLOCKED->REVIEWING") return 0 ;;
        *) return 1 ;;
    esac
}

# Initialize a new delivery entry
delivery_init() {
    local task_id="$1" branch="$2"
    if [[ -z "$task_id" || -z "$branch" ]]; then
        echo "Usage: delivery_init <task-id> <branch>" >&2
        return 1
    fi

    _init_state_file

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local entry
    entry=$(jq -n \
        --arg tid "$task_id" \
        --arg br "$branch" \
        --arg now "$now" \
        '{
            taskId: $tid,
            branch: $br,
            prNumber: null,
            state: "WORKING",
            gates: {},
            createdAt: $now,
            updatedAt: $now
        }')

    jq --arg tid "$task_id" --argjson entry "$entry" \
        '.deliveries[$tid] = $entry' "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"

    echo "$entry"
}

# Transition a delivery to a new state
delivery_transition() {
    local task_id="$1" new_state="$2"
    if [[ -z "$task_id" || -z "$new_state" ]]; then
        echo "Usage: delivery_transition <task-id> <new-state>" >&2
        return 1
    fi

    _init_state_file

    if ! _valid_state "$new_state"; then
        echo "Error: Invalid state '$new_state'" >&2
        return 1
    fi

    local current_state
    current_state=$(jq -r --arg tid "$task_id" '.deliveries[$tid].state // empty' "$STATE_FILE")
    if [[ -z "$current_state" ]]; then
        echo "Error: No delivery found for task '$task_id'" >&2
        return 1
    fi

    if ! _valid_transition "$current_state" "$new_state"; then
        echo "Error: Invalid transition ${current_state} -> ${new_state}" >&2
        return 1
    fi

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    jq --arg tid "$task_id" --arg state "$new_state" --arg now "$now" \
        '.deliveries[$tid].state = $state | .deliveries[$tid].updatedAt = $now' \
        "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"

    echo "Transitioned $task_id: $current_state -> $new_state"
}

# Get a delivery entry as JSON
delivery_get() {
    local task_id="$1"
    if [[ -z "$task_id" ]]; then
        echo "Usage: delivery_get <task-id>" >&2
        return 1
    fi

    _init_state_file

    local entry
    entry=$(jq --arg tid "$task_id" '.deliveries[$tid] // empty' "$STATE_FILE")
    if [[ -z "$entry" || "$entry" == "null" ]]; then
        echo "Error: No delivery found for task '$task_id'" >&2
        return 1
    fi

    echo "$entry"
}

# List deliveries, optionally filtered by state
delivery_list() {
    _init_state_file

    local filter_state=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --state) filter_state="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -n "$filter_state" ]]; then
        jq --arg state "$filter_state" \
            '[.deliveries | to_entries[] | select(.value.state == $state) | .value]' \
            "$STATE_FILE"
    else
        jq '[.deliveries | to_entries[] | .value]' "$STATE_FILE"
    fi
}

# Remove a completed delivery
delivery_cleanup() {
    local task_id="$1"
    if [[ -z "$task_id" ]]; then
        echo "Usage: delivery_cleanup <task-id>" >&2
        return 1
    fi

    _init_state_file

    jq --arg tid "$task_id" 'del(.deliveries[$tid])' \
        "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"

    echo "Cleaned up delivery: $task_id"
}

# Set PR number on a delivery
delivery_set_pr() {
    local task_id="$1" pr_number="$2"
    if [[ -z "$task_id" || -z "$pr_number" ]]; then
        echo "Usage: delivery_set_pr <task-id> <pr-number>" >&2
        return 1
    fi

    _init_state_file

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    jq --arg tid "$task_id" --argjson pr "$pr_number" --arg now "$now" \
        '.deliveries[$tid].prNumber = $pr | .deliveries[$tid].updatedAt = $now' \
        "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

# Set gate result for a delivery
delivery_set_gate() {
    local task_id="$1" gate_name="$2" result="$3"
    if [[ -z "$task_id" || -z "$gate_name" || -z "$result" ]]; then
        echo "Usage: delivery_set_gate <task-id> <gate-name> <pending|passed|failed>" >&2
        return 1
    fi

    _init_state_file

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    jq --arg tid "$task_id" --arg gate "$gate_name" --arg res "$result" --arg now "$now" \
        '.deliveries[$tid].gates[$gate] = $res | .deliveries[$tid].updatedAt = $now' \
        "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        init)       shift; delivery_init "$@" ;;
        transition) shift; delivery_transition "$@" ;;
        get)        shift; delivery_get "$@" ;;
        list)       shift; delivery_list "$@" ;;
        cleanup)    shift; delivery_cleanup "$@" ;;
        set-pr)     shift; delivery_set_pr "$@" ;;
        set-gate)   shift; delivery_set_gate "$@" ;;
        *)
            echo "Usage: delivery-state.sh {init|transition|get|list|cleanup|set-pr|set-gate} [args...]" >&2
            exit 1
            ;;
    esac
fi
