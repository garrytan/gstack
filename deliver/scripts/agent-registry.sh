#!/usr/bin/env bash
# Agent registry for the delivery pipeline
# Loads agent definitions from .md files with YAML front matter.
#
# Agent .md format:
#   ---
#   name: agent-name
#   description: Short description
#   model: claude-sonnet-4-5-20250929
#   trigger: always | { files_match: [...] } | { min_lines_changed: N }
#   blocking: true | false
#   gate_output_pattern: "RESULT:.*(PASS|FAIL)"
#   ---
#   # Agent Title
#   Markdown body...
#   ## Review Mandate
#   Review-specific instructions...
#
# Usage:
#   agent-registry.sh list
#   agent-registry.sh metadata <name>
#   agent-registry.sh prompt <name>
#   agent-registry.sh review-mandate <name>

set -eo pipefail

# Agent directories to search (in priority order)
_agent_dirs() {
    local dirs=()

    # Allow override via env var (for testing)
    if [[ -n "${GSTACK_DELIVER_AGENTS_DIR:-}" ]]; then
        dirs+=("$GSTACK_DELIVER_AGENTS_DIR")
        printf '%s\n' "${dirs[@]}"
        return
    fi

    # User-configured agents (highest priority — user customizations)
    if [[ -d "$HOME/.gstack/deliver/agents" ]]; then
        dirs+=("$HOME/.gstack/deliver/agents")
    fi

    # Skill-bundled agents (fallback defaults)
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -d "$script_dir/../agents" ]]; then
        dirs+=("$script_dir/../agents")
    fi

    printf '%s\n' "${dirs[@]}"
}

# Find agent file by name
_find_agent() {
    local name="$1"
    local dir
    while IFS= read -r dir; do
        if [[ -f "$dir/${name}.md" ]]; then
            echo "$dir/${name}.md"
            return 0
        fi
    done < <(_agent_dirs)

    echo "Error: Agent '$name' not found" >&2
    return 1
}

# Extract YAML front matter from a .md file
# Returns the content between the first and second '---' lines
_extract_front_matter() {
    local file="$1"
    sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$file"
}

# Extract Markdown body (everything after the second '---')
_extract_body() {
    local file="$1"
    sed -n '/^---$/,/^---$/d; p' "$file" | sed '/./,$!d'
}

# Extract a specific section from Markdown body
_extract_section() {
    local file="$1" section="$2"
    local in_section=false

    while IFS= read -r line; do
        if [[ "$line" =~ ^##[[:space:]]+"$section" ]] || [[ "$line" == "## $section" ]]; then
            in_section=true
            continue
        fi
        if [[ "$in_section" == true ]]; then
            # Stop at next section heading
            if [[ "$line" =~ ^##[[:space:]] ]]; then
                break
            fi
            echo "$line"
        fi
    done < <(_extract_body "$file")
}

# List all agents with their metadata
agent_list() {
    local dir
    while IFS= read -r dir; do
        for file in "$dir"/*.md; do
            [[ -f "$file" ]] || continue
            local name
            name=$(basename "$file" .md)
            local desc
            desc=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description:[[:space:]]*/, ""); print}' "$file")
            printf "%-20s %s\n" "$name" "$desc"
        done
    done < <(_agent_dirs)
}

# Get agent metadata as key-value pairs
agent_get_metadata() {
    local name="$1"
    if [[ -z "$name" ]]; then
        echo "Usage: agent_get_metadata <name>" >&2
        return 1
    fi

    local file
    file=$(_find_agent "$name") || return 1
    _extract_front_matter "$file"
}

# Get agent's full Markdown prompt (body)
agent_get_prompt() {
    local name="$1"
    if [[ -z "$name" ]]; then
        echo "Usage: agent_get_prompt <name>" >&2
        return 1
    fi

    local file
    file=$(_find_agent "$name") || return 1
    _extract_body "$file"
}

# Get agent's review mandate section
agent_get_review_mandate() {
    local name="$1"
    if [[ -z "$name" ]]; then
        echo "Usage: agent_get_review_mandate <name>" >&2
        return 1
    fi

    local file
    file=$(_find_agent "$name") || return 1
    local mandate
    mandate=$(_extract_section "$file" "Review Mandate")

    if [[ -z "$mandate" ]]; then
        echo "Warning: No '## Review Mandate' section found in $name" >&2
        # Fall back to full prompt
        _extract_body "$file"
    else
        echo "$mandate"
    fi
}

# CLI dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        list)           shift; agent_list "$@" ;;
        metadata)       shift; agent_get_metadata "$@" ;;
        prompt)         shift; agent_get_prompt "$@" ;;
        review-mandate) shift; agent_get_review_mandate "$@" ;;
        *)
            echo "Usage: agent-registry.sh {list|metadata|prompt|review-mandate} [args...]" >&2
            exit 1
            ;;
    esac
fi
