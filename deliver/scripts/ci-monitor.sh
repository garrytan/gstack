#!/usr/bin/env bash
# CI monitoring for the delivery pipeline
# Polls GitHub Actions CI status until completion or timeout.
#
# Usage:
#   ci-monitor.sh poll <pr-number> [--interval <sec>] [--timeout <sec>]
#   ci-monitor.sh status <pr-number>

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default settings (overridden by gates.yaml if available)
DEFAULT_POLL_INTERVAL=30
DEFAULT_TIMEOUT=1800  # 30 minutes

# Load settings from gates.yaml if available
_load_settings() {
    local gates_file="${GATES_CONFIG:-$HOME/.gstack/deliver/gates.yaml}"
    if [[ ! -f "$gates_file" ]]; then
        gates_file="$SCRIPT_DIR/../gates.yaml.example"
    fi

    if [[ -f "$gates_file" ]] && command -v grep &>/dev/null; then
        local interval timeout_min
        interval=$(grep 'ci_poll_interval_seconds:' "$gates_file" 2>/dev/null | awk '{print $2}')
        timeout_min=$(grep 'ci_timeout_minutes:' "$gates_file" 2>/dev/null | awk '{print $2}')

        if [[ -n "$interval" ]]; then
            DEFAULT_POLL_INTERVAL="$interval"
        fi
        if [[ -n "$timeout_min" ]]; then
            DEFAULT_TIMEOUT=$((timeout_min * 60))
        fi
    fi
}

# One-shot CI status check
ci_status() {
    local pr_number="$1"
    if [[ -z "$pr_number" ]]; then
        echo "Usage: ci_status <pr-number>" >&2
        return 1
    fi

    if ! command -v gh &>/dev/null; then
        echo "Error: GitHub CLI (gh) is required." >&2
        return 1
    fi

    local checks
    checks=$(gh pr view "$pr_number" --json statusCheckRollup -q '.statusCheckRollup' 2>/dev/null)

    if [[ -z "$checks" || "$checks" == "[]" || "$checks" == "null" ]]; then
        echo "unknown"
        return 0
    fi

    # Check for any failures
    if echo "$checks" | jq -e 'any(.[]; .conclusion == "FAILURE" or .conclusion == "ERROR")' &>/dev/null; then
        echo "failed"
        return 0
    fi

    # Check if all completed successfully
    if echo "$checks" | jq -e 'all(.[]; .conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED")' &>/dev/null; then
        echo "passed"
        return 0
    fi

    echo "pending"
}

# Poll until CI completes or times out
ci_poll() {
    local pr_number="" interval="" timeout=""

    if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        pr_number="$1"; shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --interval) interval="$2"; shift 2 ;;
            --timeout) timeout="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$pr_number" ]]; then
        echo "Usage: ci_poll <pr-number> [--interval <sec>] [--timeout <sec>]" >&2
        return 1
    fi

    _load_settings
    interval="${interval:-$DEFAULT_POLL_INTERVAL}"
    timeout="${timeout:-$DEFAULT_TIMEOUT}"

    local elapsed=0
    echo "Polling CI for PR #${pr_number} (interval: ${interval}s, timeout: ${timeout}s)..." >&2

    while [[ $elapsed -lt $timeout ]]; do
        local status
        status=$(ci_status "$pr_number")

        case "$status" in
            passed)
                echo "passed"
                return 0
                ;;
            failed)
                echo "failed"
                return 1
                ;;
            unknown|pending)
                echo "  [${elapsed}s] CI status: ${status}" >&2
                sleep "$interval"
                elapsed=$((elapsed + interval))
                ;;
        esac
    done

    echo "  CI timed out after ${timeout}s" >&2
    echo "timeout"
    return 2
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        status) shift; ci_status "$@" ;;
        poll)   shift; ci_poll "$@" ;;
        *)
            echo "Usage: ci-monitor.sh {status|poll} [args...]" >&2
            exit 1
            ;;
    esac
fi
