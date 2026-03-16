#!/usr/bin/env bash
# End-to-end delivery pipeline runner
# Orchestrates: branch validation -> PR creation -> CI polling -> quality gates -> merge
#
# Usage:
#   run.sh <branch> [--task-id ID] [--base BASE] [--no-merge]
#   run.sh resume <task-id>
#   run.sh status <task-id>
#
# Output protocol (stdout, pipe-delimited):
#   PIPELINE|<task-id>|PHASE|<state>|<message>
#   PIPELINE|<task-id>|GATE|<agent>|<result>
#   PIPELINE|<task-id>|RESULT|<final-state>|<message>

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source sibling pipeline scripts
# shellcheck source=./delivery-state.sh
source "$SCRIPT_DIR/delivery-state.sh"
# shellcheck source=./pr-manager.sh
source "$SCRIPT_DIR/pr-manager.sh"
# shellcheck source=./ci-monitor.sh
source "$SCRIPT_DIR/ci-monitor.sh"
# shellcheck source=./gate-runner.sh
source "$SCRIPT_DIR/gate-runner.sh"

# Load merge settings from gates.yaml
_load_merge_settings() {
    local gates_file="${GATES_CONFIG:-$HOME/.gstack/deliver/gates.yaml}"
    if [[ ! -f "$gates_file" ]]; then
        gates_file="$SCRIPT_DIR/../gates.yaml.example"
    fi

    MERGE_METHOD="squash"
    DELETE_BRANCH_ON_MERGE=true
    AUTO_MERGE=true

    if [[ -f "$gates_file" ]]; then
        local val
        val=$(grep 'merge_method:' "$gates_file" 2>/dev/null | awk '{print $2}')
        [[ -n "$val" ]] && MERGE_METHOD="$val"

        val=$(grep 'delete_branch_on_merge:' "$gates_file" 2>/dev/null | awk '{print $2}')
        [[ "$val" == "false" ]] && DELETE_BRANCH_ON_MERGE=false

        val=$(grep 'auto_merge:' "$gates_file" 2>/dev/null | awk '{print $2}')
        [[ "$val" == "false" ]] && AUTO_MERGE=false
    fi
    return 0
}

# Emit structured pipeline output
_emit() {
    local task_id="$1" type="$2" key="$3" value="$4"
    echo "PIPELINE|${task_id}|${type}|${key}|${value}"
}

# Validate that a branch is suitable for delivery
_validate_branch() {
    local branch="$1"

    # Reject main/master
    if [[ "$branch" == "main" || "$branch" == "master" ]]; then
        echo "Error: Cannot deliver main/master branch" >&2
        return 1
    fi

    # Check branch exists remotely
    if ! git ls-remote --heads origin "$branch" 2>/dev/null | grep -q "$branch"; then
        echo "Error: Branch '$branch' not found on remote" >&2
        return 1
    fi

    return 0
}

# Find existing open PR for a branch
_find_existing_pr() {
    local branch="$1"
    gh pr list --head "$branch" --state open --json number -q '.[0].number' 2>/dev/null
}

# Run the full pipeline for a branch
pipeline_run() {
    local branch="" task_id="" base="" no_merge=false

    # Parse args
    if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        branch="$1"; shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --task-id) task_id="$2"; shift 2 ;;
            --base) base="$2"; shift 2 ;;
            --no-merge) no_merge=true; shift ;;
            *) shift ;;
        esac
    done

    if [[ -z "$branch" ]]; then
        echo "Usage: pipeline_run <branch> [--task-id ID] [--base BASE] [--no-merge]" >&2
        return 1
    fi

    # Auto-detect base branch if not specified
    if [[ -z "$base" ]]; then
        base=$(gh repo view --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "main")
    fi

    # Default task ID from branch name
    task_id="${task_id:-$branch}"

    _load_merge_settings

    # Step 1: Validate branch
    _validate_branch "$branch" || return 1

    # Step 2: Initialize delivery tracking
    delivery_init "$task_id" "$branch" >/dev/null 2>&1 || true
    _emit "$task_id" "PHASE" "PR_CREATING" "Looking for PR..."

    # Step 3: Create or find PR
    delivery_transition "$task_id" "PR_CREATING" 2>/dev/null || true
    local pr_number
    pr_number=$(_find_existing_pr "$branch")

    if [[ -z "$pr_number" ]]; then
        _emit "$task_id" "PHASE" "PR_CREATING" "Creating PR for $branch..."
        pr_number=$(pr_create "$branch" --base "$base") || {
            _emit "$task_id" "RESULT" "BLOCKED" "Failed to create PR"
            delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
            return 1
        }
    fi

    delivery_set_pr "$task_id" "$pr_number" 2>/dev/null || true
    _emit "$task_id" "PHASE" "CI_RUNNING" "PR #${pr_number} — polling CI..."

    # Step 4: Poll CI
    delivery_transition "$task_id" "CI_RUNNING" 2>/dev/null || true
    local ci_result
    ci_result=$(ci_poll "$pr_number") || {
        local ci_exit=$?
        if [[ $ci_exit -eq 1 ]]; then
            _emit "$task_id" "RESULT" "BLOCKED" "PR #${pr_number} CI failed"
            delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
            return 1
        elif [[ $ci_exit -eq 2 ]]; then
            _emit "$task_id" "RESULT" "BLOCKED" "PR #${pr_number} CI timed out"
            delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
            return 1
        fi
    }

    if [[ "$ci_result" != "passed" ]]; then
        _emit "$task_id" "RESULT" "BLOCKED" "PR #${pr_number} CI status: ${ci_result}"
        delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
        return 1
    fi

    # Step 5: Run quality gates
    _emit "$task_id" "PHASE" "REVIEWING" "Running quality gates..."
    delivery_transition "$task_id" "REVIEWING" 2>/dev/null || true

    if run_gates "$pr_number" "$branch" 2>/dev/null; then
        _emit "$task_id" "GATE" "all" "passed"
        delivery_transition "$task_id" "APPROVED" 2>/dev/null || true
    else
        _emit "$task_id" "RESULT" "BLOCKED" "PR #${pr_number} blocked by quality gates"
        delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
        return 1
    fi

    # Step 6: Merge (unless --no-merge)
    if [[ "$no_merge" == true ]]; then
        _emit "$task_id" "RESULT" "APPROVED" "PR #${pr_number} approved (merge skipped)"
        return 0
    fi

    if [[ "$AUTO_MERGE" == false ]]; then
        _emit "$task_id" "RESULT" "APPROVED" "PR #${pr_number} approved (auto-merge disabled)"
        return 0
    fi

    _emit "$task_id" "PHASE" "MERGING" "Merging PR #${pr_number}..."
    delivery_transition "$task_id" "MERGING" 2>/dev/null || true

    local merge_args=("$pr_number" "--method" "$MERGE_METHOD")
    if [[ "$DELETE_BRANCH_ON_MERGE" == true ]]; then
        merge_args+=(--delete-branch)
    fi

    if pr_merge "${merge_args[@]}" 2>/dev/null; then
        delivery_transition "$task_id" "MERGED" 2>/dev/null || true
        _emit "$task_id" "RESULT" "MERGED" "PR #${pr_number} merged"
        return 0
    else
        _emit "$task_id" "RESULT" "BLOCKED" "PR #${pr_number} merge failed"
        delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
        return 1
    fi
}

# Resume a pipeline from its saved delivery state
pipeline_resume() {
    local task_id="$1"
    if [[ -z "$task_id" ]]; then
        echo "Usage: pipeline_resume <task-id>" >&2
        return 1
    fi

    local entry
    entry=$(delivery_get "$task_id" 2>/dev/null) || {
        echo "Error: No delivery found for task '$task_id'" >&2
        return 1
    }

    local branch state pr_number
    branch=$(echo "$entry" | jq -r '.branch')
    state=$(echo "$entry" | jq -r '.state')
    pr_number=$(echo "$entry" | jq -r '.prNumber // empty')

    _load_merge_settings

    case "$state" in
        WORKING|PR_CREATING)
            pipeline_run "$branch" --task-id "$task_id"
            ;;
        CI_RUNNING)
            if [[ -z "$pr_number" ]]; then
                echo "Error: No PR number recorded for $task_id" >&2
                return 1
            fi
            # Re-enter from CI polling
            _emit "$task_id" "PHASE" "CI_RUNNING" "Resuming CI poll for PR #${pr_number}..."
            local ci_result
            ci_result=$(ci_poll "$pr_number") || {
                delivery_transition "$task_id" "BLOCKED" 2>/dev/null || true
                return 1
            }
            if [[ "$ci_result" == "passed" ]]; then
                delivery_transition "$task_id" "REVIEWING" 2>/dev/null || true
                if run_gates "$pr_number" "$branch" 2>/dev/null; then
                    delivery_transition "$task_id" "APPROVED" 2>/dev/null || true
                    delivery_transition "$task_id" "MERGING" 2>/dev/null || true
                    pr_merge "$pr_number" --method "$MERGE_METHOD" --delete-branch 2>/dev/null && \
                        delivery_transition "$task_id" "MERGED" 2>/dev/null || true
                fi
            fi
            ;;
        REVIEWING)
            [[ -z "$pr_number" ]] && return 1
            if run_gates "$pr_number" "$branch" 2>/dev/null; then
                delivery_transition "$task_id" "APPROVED" 2>/dev/null || true
                delivery_transition "$task_id" "MERGING" 2>/dev/null || true
                pr_merge "$pr_number" --method "$MERGE_METHOD" --delete-branch 2>/dev/null && \
                    delivery_transition "$task_id" "MERGED" 2>/dev/null || true
            fi
            ;;
        BLOCKED)
            # Re-run from the beginning
            delivery_transition "$task_id" "CI_RUNNING" 2>/dev/null || \
                delivery_transition "$task_id" "WORKING" 2>/dev/null || true
            pipeline_run "$branch" --task-id "$task_id"
            ;;
        APPROVED|MERGING)
            [[ -z "$pr_number" ]] && return 1
            delivery_transition "$task_id" "MERGING" 2>/dev/null || true
            pr_merge "$pr_number" --method "$MERGE_METHOD" --delete-branch 2>/dev/null && \
                delivery_transition "$task_id" "MERGED" 2>/dev/null || true
            ;;
        MERGED)
            _emit "$task_id" "RESULT" "MERGED" "Already merged"
            return 0
            ;;
    esac
}

# Show pipeline status for a task
pipeline_status() {
    local task_id="$1"
    if [[ -z "$task_id" ]]; then
        echo "Usage: pipeline_status <task-id>" >&2
        return 1
    fi

    delivery_get "$task_id"
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        resume) shift; pipeline_resume "$@" ;;
        status) shift; pipeline_status "$@" ;;
        *)
            # Default: run pipeline with first arg as branch
            pipeline_run "$@"
            ;;
    esac
fi
