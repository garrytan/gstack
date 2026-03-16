#!/usr/bin/env bash
# Quality gate orchestrator for the delivery pipeline
# Reads gates.yaml, determines which agents to invoke per PR, runs them, collects results.
#
# Usage:
#   gate-runner.sh run-all <pr-number> <branch>
#   gate-runner.sh run <agent-name> <pr-number> <branch>
#   gate-runner.sh status <pr-number>
#   gate-runner.sh needs <agent-name> <pr-number>

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load gates config
_gates_config() {
    local gates_file="${GATES_CONFIG:-$HOME/.gstack/deliver/gates.yaml}"
    if [[ ! -f "$gates_file" ]]; then
        gates_file="$SCRIPT_DIR/../gates.yaml.example"
    fi
    if [[ ! -f "$gates_file" ]]; then
        echo "Error: gates.yaml not found. Run /deliver once to initialize, or create ~/.gstack/deliver/gates.yaml" >&2
        return 1
    fi
    echo "$gates_file"
}

# Parse a YAML value from gates.yaml (simple key extraction)
_yaml_value() {
    local file="$1" key="$2"
    grep "^[[:space:]]*${key}:" "$file" 2>/dev/null | head -1 | sed "s/^[[:space:]]*${key}:[[:space:]]*//"
}

# Get gate config for a specific agent
_gate_config() {
    local agent_name="$1"
    local gates_file
    gates_file=$(_gates_config) || return 1

    # Extract the block for this gate
    local block
    # Use sed to extract the agent's config block, then remove last line (next section header)
    block=$(sed -n "/^  ${agent_name}:/,/^  [a-z]/p" "$gates_file" | sed '$d')

    if [[ -z "$block" ]]; then
        # Last entry: extract from agent to next top-level key (non-indented) or EOF
        block=$(sed -n "/^  ${agent_name}:/,/^[a-z]/p" "$gates_file" | sed '$d')
    fi

    if [[ -z "$block" ]]; then
        # Truly the last entry in file with nothing after it
        block=$(sed -n "/^  ${agent_name}:/,\$p" "$gates_file")
    fi

    if [[ -z "$block" ]]; then
        echo "Error: No gate config found for '$agent_name'" >&2
        return 1
    fi

    echo "$block"
}

# Check if a gate is enabled
_gate_enabled() {
    local agent_name="$1"
    local block
    block=$(_gate_config "$agent_name" 2>/dev/null) || return 1
    local enabled
    enabled=$(echo "$block" | grep 'enabled:' | awk '{print $2}')
    [[ "$enabled" == "true" ]]
}

# Check if a gate is blocking
_gate_blocking() {
    local agent_name="$1"
    local block
    block=$(_gate_config "$agent_name" 2>/dev/null) || return 1
    local blocking
    blocking=$(echo "$block" | grep 'blocking:' | awk '{print $2}')
    [[ "$blocking" == "true" ]]
}

# Get list of all gate names
_gate_names() {
    local gates_file
    gates_file=$(_gates_config) || return 1
    # Gate names are indented with 2 spaces under "gates:"
    sed -n '/^gates:/,/^[a-z]/p' "$gates_file" | grep '^  [a-z]' | sed 's/:[[:space:]]*$//' | sed 's/^  //'
}

# Check if a gate should run for this PR based on trigger conditions
needs_gate() {
    local agent_name="$1" pr_number="$2"

    if [[ -z "$agent_name" || -z "$pr_number" ]]; then
        echo "Usage: needs_gate <agent-name> <pr-number>" >&2
        return 1
    fi

    # Check if gate is enabled
    if ! _gate_enabled "$agent_name"; then
        return 1
    fi

    local block
    block=$(_gate_config "$agent_name") || return 1

    # Check trigger type
    if echo "$block" | grep -q 'trigger: always'; then
        return 0
    fi

    # File pattern trigger
    local files_match
    files_match=$(echo "$block" | sed -n '/files_match:/,/^[[:space:]]*[a-z]/p' | grep '^\s*-' | sed 's/^[[:space:]]*-[[:space:]]*//' | tr -d '"')

    if [[ -n "$files_match" ]]; then
        # Get changed files for this PR
        local changed_files
        changed_files=$(gh pr diff "$pr_number" --name-only 2>/dev/null) || return 1

        while IFS= read -r pattern; do
            [[ -z "$pattern" ]] && continue
            # Convert glob to grep regex (simple: ** -> .*, * -> [^/]*)
            local regex
            regex=$(echo "$pattern" | sed 's/\*\*/.*/g; s/\*/[^\/]*/g')
            if echo "$changed_files" | grep -qE "$regex"; then
                return 0
            fi
        done <<< "$files_match"
        return 1
    fi

    # Line count trigger
    local min_lines
    min_lines=$(echo "$block" | grep 'min_lines_changed:' | awk '{print $2}')

    if [[ -n "$min_lines" ]]; then
        local additions deletions total
        additions=$(gh pr view "$pr_number" --json additions -q '.additions' 2>/dev/null || echo 0)
        deletions=$(gh pr view "$pr_number" --json deletions -q '.deletions' 2>/dev/null || echo 0)
        total=$((additions + deletions))
        [[ $total -ge $min_lines ]]
        return $?
    fi

    # Default: run the gate
    return 0
}

# Run a single gate
run_gate() {
    local agent_name="$1" pr_number="$2" branch="$3"

    if [[ -z "$agent_name" || -z "$pr_number" || -z "$branch" ]]; then
        echo "Usage: run_gate <agent-name> <pr-number> <branch>" >&2
        return 1
    fi

    echo "Running gate: $agent_name for PR #$pr_number..." >&2

    # Get agent review mandate
    local mandate
    mandate=$("$SCRIPT_DIR/agent-registry.sh" review-mandate "$agent_name" 2>/dev/null)

    if [[ -z "$mandate" ]]; then
        echo "Warning: No review mandate found for '$agent_name', using full prompt" >&2
        mandate=$("$SCRIPT_DIR/agent-registry.sh" prompt "$agent_name" 2>/dev/null)
    fi

    # Get PR diff
    local diff
    diff=$(gh pr diff "$pr_number" 2>/dev/null)

    if [[ -z "$diff" ]]; then
        echo "Error: Could not get diff for PR #$pr_number" >&2
        return 1
    fi

    # Build the review prompt
    local prompt
    prompt="You are reviewing PR #${pr_number} on branch '${branch}'.

## Your Review Mandate

${mandate}

## PR Diff

\`\`\`diff
${diff}
\`\`\`

## Instructions

1. Review the diff against your mandate
2. Provide specific, actionable feedback
3. End your review with exactly one of:
   - RESULT: PASS — if the changes meet all criteria
   - RESULT: FAIL — if there are blocking issues
   - RESULT: CONDITIONAL PASS — if there are non-blocking suggestions"

    # Invoke Claude with the agent's review
    local result
    if command -v claude &>/dev/null; then
        result=$(echo "$prompt" | claude --print 2>/dev/null) || true
    else
        echo "Error: claude CLI not found. Cannot run quality gates." >&2
        return 1
    fi

    echo "$result"

    # Parse result
    if echo "$result" | grep -qE 'RESULT:[[:space:]]*PASS'; then
        return 0
    elif echo "$result" | grep -qE 'RESULT:[[:space:]]*CONDITIONAL PASS'; then
        return 0
    else
        return 1
    fi
}

# Run all applicable gates for a PR
run_gates() {
    local pr_number="$1" branch="$2"

    if [[ -z "$pr_number" || -z "$branch" ]]; then
        echo "Usage: run_gates <pr-number> <branch>" >&2
        return 1
    fi

    local gate_names all_passed=true blocking_failed=false
    gate_names=$(_gate_names) || return 1

    # Track results
    declare -A results

    echo "=== Quality Gates for PR #${pr_number} (branch: ${branch}) ===" >&2

    while IFS= read -r gate; do
        [[ -z "$gate" ]] && continue

        if ! needs_gate "$gate" "$pr_number" 2>/dev/null; then
            echo "  SKIP: $gate (trigger not met)" >&2
            results[$gate]="skipped"
            continue
        fi

        echo "  RUN:  $gate" >&2

        # Update delivery state if available
        if [[ -f "$SCRIPT_DIR/delivery-state.sh" ]]; then
            "$SCRIPT_DIR/delivery-state.sh" set-gate "$pr_number" "$gate" "pending" 2>/dev/null || true
        fi

        local gate_exit=0
        run_gate "$gate" "$pr_number" "$branch" >/dev/null 2>&1 || gate_exit=$?

        if [[ $gate_exit -eq 0 ]]; then
            results[$gate]="passed"
            echo "  PASS: $gate" >&2
            if [[ -f "$SCRIPT_DIR/delivery-state.sh" ]]; then
                "$SCRIPT_DIR/delivery-state.sh" set-gate "$pr_number" "$gate" "passed" 2>/dev/null || true
            fi
        else
            results[$gate]="failed"
            all_passed=false
            echo "  FAIL: $gate" >&2
            if [[ -f "$SCRIPT_DIR/delivery-state.sh" ]]; then
                "$SCRIPT_DIR/delivery-state.sh" set-gate "$pr_number" "$gate" "failed" 2>/dev/null || true
            fi

            if _gate_blocking "$gate" 2>/dev/null; then
                blocking_failed=true
                echo "  ^^^ BLOCKING gate failed" >&2
            fi
        fi
    done <<< "$gate_names"

    # Summary
    echo "" >&2
    echo "=== Gate Summary ===" >&2
    for gate in "${!results[@]}"; do
        printf "  %-20s %s\n" "$gate:" "${results[$gate]}" >&2
    done

    if [[ "$blocking_failed" == true ]]; then
        echo "RESULT: BLOCKED (blocking gate failed)" >&2
        return 1
    elif [[ "$all_passed" == true ]]; then
        echo "RESULT: PASSED" >&2
        return 0
    else
        echo "RESULT: PASSED (non-blocking failures)" >&2
        return 0
    fi
}

# Get aggregate gate status for a PR (from delivery state)
gate_status() {
    local pr_number="$1"
    if [[ -z "$pr_number" ]]; then
        echo "Usage: gate_status <pr-number>" >&2
        return 1
    fi

    if [[ -f "$SCRIPT_DIR/delivery-state.sh" ]]; then
        local entry
        entry=$("$SCRIPT_DIR/delivery-state.sh" get "$pr_number" 2>/dev/null) || true
        if [[ -n "$entry" ]]; then
            echo "$entry" | jq '.gates'
            return 0
        fi
    fi

    echo "No gate status found for PR #$pr_number" >&2
    return 1
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        run-all) shift; run_gates "$@" ;;
        run)     shift; run_gate "$@" ;;
        status)  shift; gate_status "$@" ;;
        needs)   shift; needs_gate "$@" ;;
        *)
            echo "Usage: gate-runner.sh {run-all|run|status|needs} [args...]" >&2
            exit 1
            ;;
    esac
fi
