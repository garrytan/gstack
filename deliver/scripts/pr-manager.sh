#!/usr/bin/env bash
# PR lifecycle management for the delivery pipeline
# Wraps `gh` CLI for PR creation, status, merge, and label management.
#
# Usage:
#   pr-manager.sh create <branch> [--title <title>] [--body <body>] [--base <base>]
#   pr-manager.sh status <pr-number>
#   pr-manager.sh merge <pr-number> [--method squash|merge|rebase] [--delete-branch]
#   pr-manager.sh files <pr-number>
#   pr-manager.sh add-label <pr-number> <label>
#   pr-manager.sh remove-label <pr-number> <label>

set -eo pipefail

# Verify gh CLI is available
_require_gh() {
    if ! command -v gh &>/dev/null; then
        echo "Error: GitHub CLI (gh) is required but not installed." >&2
        echo "Install: https://cli.github.com/" >&2
        return 1
    fi
    if ! gh auth status &>/dev/null 2>&1; then
        echo "Error: Not authenticated with GitHub. Run 'gh auth login'." >&2
        return 1
    fi
}

# Auto-detect repo from current git context
_detect_repo() {
    gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null
}

# Create a PR for a branch
pr_create() {
    _require_gh

    # Auto-detect default branch (main or master)
    local default_base
    default_base=$(gh repo view --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "main")
    local branch="" title="" body="" base="$default_base"

    # First positional arg is branch
    if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        branch="$1"; shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --title) title="$2"; shift 2 ;;
            --body) body="$2"; shift 2 ;;
            --base) base="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$branch" ]]; then
        echo "Usage: pr_create <branch> [--title <title>] [--body <body>] [--base <base>]" >&2
        return 1
    fi

    # Default title from branch name
    if [[ -z "$title" ]]; then
        title="${branch//[-_]/ }"
    fi

    local args=(
        --head "$branch"
        --base "$base"
        --title "$title"
    )

    if [[ -n "$body" ]]; then
        args+=(--body "$body")
    fi

    local result
    result=$(gh pr create "${args[@]}" 2>&1)
    local exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        echo "Error creating PR: $result" >&2
        return 1
    fi

    # Extract PR number from URL
    local pr_number
    pr_number=$(echo "$result" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+' | tail -1)

    if [[ -n "$pr_number" ]]; then
        echo "$pr_number"
    else
        echo "$result"
    fi
}

# Get PR status as JSON
pr_status() {
    _require_gh

    local pr_number="$1"
    if [[ -z "$pr_number" ]]; then
        echo "Usage: pr_status <pr-number>" >&2
        return 1
    fi

    gh pr view "$pr_number" --json number,url,state,statusCheckRollup,labels,additions,deletions \
        | jq '{
            number: .number,
            url: .url,
            state: (.state | ascii_downcase),
            ciStatus: (
                if (.statusCheckRollup | length) == 0 then "unknown"
                elif (.statusCheckRollup | all(.conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED")) then "passed"
                elif (.statusCheckRollup | any(.conclusion == "FAILURE" or .conclusion == "ERROR")) then "failed"
                else "pending"
                end
            ),
            labels: [.labels[].name],
            additions: .additions,
            deletions: .deletions
        }'
}

# Merge a PR
pr_merge() {
    _require_gh

    local pr_number="" method="squash" delete_branch=false

    if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        pr_number="$1"; shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --method) method="$2"; shift 2 ;;
            --delete-branch) delete_branch=true; shift ;;
            *) shift ;;
        esac
    done

    if [[ -z "$pr_number" ]]; then
        echo "Usage: pr_merge <pr-number> [--method squash|merge|rebase] [--delete-branch]" >&2
        return 1
    fi

    local args=("$pr_number" "--$method")

    if [[ "$delete_branch" == true ]]; then
        args+=(--delete-branch)
    fi

    gh pr merge "${args[@]}"
}

# Update a PR's branch with the latest base branch changes
pr_update_branch() {
    _require_gh

    local pr_number="$1"
    if [[ -z "$pr_number" ]]; then
        echo "Usage: pr_update_branch <pr-number>" >&2
        return 1
    fi

    local head_sha
    head_sha=$(gh pr view "$pr_number" --json headRefOid -q '.headRefOid')

    local repo
    repo=$(_detect_repo)

    gh api "repos/${repo}/pulls/${pr_number}/update-branch" \
        -X PUT -f expected_head_sha="$head_sha" 2>&1
}

# List files changed in a PR
pr_files() {
    _require_gh

    local pr_number="$1"
    if [[ -z "$pr_number" ]]; then
        echo "Usage: pr_files <pr-number>" >&2
        return 1
    fi

    gh pr diff "$pr_number" --name-only
}

# Add a label to a PR
pr_add_label() {
    _require_gh

    local pr_number="$1" label="$2"
    if [[ -z "$pr_number" || -z "$label" ]]; then
        echo "Usage: pr_add_label <pr-number> <label>" >&2
        return 1
    fi

    gh pr edit "$pr_number" --add-label "$label"
}

# Remove a label from a PR
pr_remove_label() {
    _require_gh

    local pr_number="$1" label="$2"
    if [[ -z "$pr_number" || -z "$label" ]]; then
        echo "Usage: pr_remove_label <pr-number> <label>" >&2
        return 1
    fi

    gh pr edit "$pr_number" --remove-label "$label"
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        create)         shift; pr_create "$@" ;;
        status)         shift; pr_status "$@" ;;
        merge)          shift; pr_merge "$@" ;;
        update-branch)  shift; pr_update_branch "$@" ;;
        files)          shift; pr_files "$@" ;;
        add-label)      shift; pr_add_label "$@" ;;
        remove-label)   shift; pr_remove_label "$@" ;;
        *)
            echo "Usage: pr-manager.sh {create|status|merge|update-branch|files|add-label|remove-label} [args...]" >&2
            exit 1
            ;;
    esac
fi
