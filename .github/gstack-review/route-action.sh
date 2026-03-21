#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Step 4 — Action Routing
#
# Reads the structured review JSON from Step 3 and takes action:
#   - Approve / Request Changes / Comment
#   - Label the PR
#   - Optionally merge (for auto-mergeable low-risk PRs)
#   - Post inline comments for findings
# ---------------------------------------------------------------------------

REVIEW_JSON="${1:?Usage: route-action.sh <review.json> <triage.json>}"
TRIAGE_JSON="${2:?Usage: route-action.sh <review.json> <triage.json>}"

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER not set}"
AUTO_MERGE_ENABLED="${AUTO_MERGE_ENABLED:-false}"

# Parse review result
verdict=$(jq -r '.verdict' "$REVIEW_JSON")
confidence=$(jq -r '.confidence' "$REVIEW_JSON")
overall_score=$(jq -r '.overall_score' "$REVIEW_JSON")
summary=$(jq -r '.summary' "$REVIEW_JSON")
critical_count=$(jq '[.findings[] | select(.severity == "critical")] | length' "$REVIEW_JSON")
major_count=$(jq '[.findings[] | select(.severity == "major")] | length' "$REVIEW_JSON")
minor_count=$(jq '[.findings[] | select(.severity == "minor")] | length' "$REVIEW_JSON")
nit_count=$(jq '[.findings[] | select(.severity == "nit")] | length' "$REVIEW_JSON")
has_security_critical=$(jq '[.findings[] | select(.severity == "critical" and .category == "security")] | length' "$REVIEW_JSON")

# Parse triage
pr_type=$(jq -r '.pr_type' "$TRIAGE_JSON")
auto_mergeable=$(jq -r '.auto_mergeable' "$TRIAGE_JSON")
risk_level=$(jq -r '.risk_level' "$TRIAGE_JSON")
review_depth=$(jq -r '.suggested_review_depth' "$TRIAGE_JSON")

# Score table for the comment
design_score=$(jq -r '.scores.design' "$REVIEW_JSON")
security_score=$(jq -r '.scores.security' "$REVIEW_JSON")
performance_score=$(jq -r '.scores.performance' "$REVIEW_JSON")
test_score=$(jq -r '.scores.test_coverage' "$REVIEW_JSON")
completeness_score=$(jq -r '.scores.completeness' "$REVIEW_JSON")
review_model=$(jq -r '.review_metadata.model_used' "$REVIEW_JSON")
triage_source=$(jq -r '.review_metadata.triage_source // "unknown"' "$REVIEW_JSON")

# ---------------------------------------------------------------------------
# Build the review comment body
# ---------------------------------------------------------------------------
build_comment() {
    cat <<EOF
## 🤖 gstack AI Review

| Dimension | Score |
|-----------|-------|
| Design | ${design_score}/10 |
| Security | ${security_score}/10 |
| Performance | ${performance_score}/10 |
| Test Coverage | ${test_score}/10 |
| Completeness | ${completeness_score}/10 |
| **Overall** | **${overall_score}/10** |

**Verdict:** \`${verdict}\` (confidence: ${confidence})
**PR Type:** ${pr_type} | **Risk:** ${risk_level} | **Review Depth:** ${review_depth}

### Summary
${summary}

### Findings
- 🔴 Critical: ${critical_count}
- 🟠 Major: ${major_count}
- 🟡 Minor: ${minor_count}
- 🔵 Nit: ${nit_count}

$(if [ "$critical_count" -gt 0 ] || [ "$major_count" -gt 0 ]; then
    echo "### Critical & Major Issues"
    jq -r '.findings[] | select(.severity == "critical" or .severity == "major") | "- **[\(.severity | ascii_upcase)] \(.title)** (\(.file):\(.line))\n  \(.description)\n"' "$REVIEW_JSON"
fi)

<details>
<summary>Review metadata</summary>

- Model: ${review_model}
- Triage: ${triage_source}
- Prompt version: $(jq -r '.review_metadata.prompt_version' "$REVIEW_JSON")

</details>

---
*Automated review by [gstack-pr-pipeline](https://github.com/garrytan/gstack) • Scores are AI-generated and should be verified by a human reviewer*
EOF
}

# ---------------------------------------------------------------------------
# Post inline review comments for findings
# ---------------------------------------------------------------------------
post_inline_comments() {
    local event="COMMENT"
    local comments_json="[]"

    # Build review comments array for findings that have file and line
    comments_json=$(jq -c '[
        .findings[]
        | select(.file != "" and .line > 0)
        | {
            path: .file,
            line: .line,
            body: ("**[\(.severity | ascii_upcase)]** \(.title)\n\n\(.description)" + 
                   (if .suggested_fix then "\n\n💡 **Suggested fix:**\n```\n\(.suggested_fix)\n```" else "" end))
          }
    ]' "$REVIEW_JSON")

    local num_comments
    num_comments=$(echo "$comments_json" | jq 'length')

    if [ "$num_comments" -eq 0 ]; then
        echo "::notice::No inline comments to post"
        return
    fi

    echo "::notice::Posting ${num_comments} inline review comments"

    # Determine review event type based on verdict
    case "$verdict" in
        approve)          event="APPROVE" ;;
        request_changes)  event="REQUEST_CHANGES" ;;
        *)                event="COMMENT" ;;
    esac

    # Post as a pull request review with inline comments
    local review_body
    review_body=$(build_comment)

    local payload
    payload=$(jq -n \
        --arg body "$review_body" \
        --arg event "$event" \
        --argjson comments "$comments_json" \
        --arg commit "$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid -q '.headRefOid')" \
        '{
            body: $body,
            event: $event,
            commit_id: $commit,
            comments: $comments
        }')

    gh api \
        --method POST \
        "/repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
        --input - <<< "$payload"
}

# ---------------------------------------------------------------------------
# Label management
# ---------------------------------------------------------------------------
add_label() {
    local label="$1"
    gh pr edit "$PR_NUMBER" --repo "$REPO" --add-label "$label" 2>/dev/null || \
        echo "::warning::Could not add label '${label}' — it may not exist. Create it in repo settings."
}

remove_label() {
    local label="$1"
    gh pr edit "$PR_NUMBER" --repo "$REPO" --remove-label "$label" 2>/dev/null || true
}

ensure_labels_exist() {
    local labels=("ai-approved" "ai-review-passed" "needs-work" "needs-human-review" "security-review-needed" "auto-merge-candidate")
    for label in "${labels[@]}"; do
        gh label create "$label" --repo "$REPO" --force --description "Auto-managed by gstack-pr-pipeline" 2>/dev/null || true
    done
}

# ---------------------------------------------------------------------------
# Decision logic
# ---------------------------------------------------------------------------
echo "::group::Review Decision"
echo "Verdict: ${verdict}"
echo "Confidence: ${confidence}"
echo "Overall Score: ${overall_score}"
echo "Critical: ${critical_count}, Major: ${major_count}"
echo "PR Type: ${pr_type}, Risk: ${risk_level}"
echo "Auto-mergeable (triage): ${auto_mergeable}"
echo "Auto-merge enabled (repo): ${AUTO_MERGE_ENABLED}"
echo "::endgroup::"

# Ensure labels exist
ensure_labels_exist

# Clean up any stale labels from previous runs
remove_label "ai-approved"
remove_label "ai-review-passed"
remove_label "needs-work"
remove_label "needs-human-review"
remove_label "security-review-needed"
remove_label "auto-merge-candidate"

# --- Route 1: Security escalation (always, regardless of verdict) ---
if [ "$has_security_critical" -gt 0 ]; then
    echo "::warning::Critical security finding detected — escalating"
    add_label "security-review-needed"
    # Don't auto-merge, even if everything else looks fine
    auto_mergeable="false"
fi

# --- Route 2: Low confidence — escalate to human ---
confidence_threshold=$(echo "$confidence" | awk '{print ($1 < 0.7) ? "low" : "ok"}')
if [ "$confidence_threshold" = "low" ]; then
    echo "::notice::Low confidence (${confidence}) — posting comment only, requesting human review"
    post_inline_comments
    add_label "needs-human-review"
    echo "action=comment_only" >> "$GITHUB_OUTPUT"
    exit 0
fi

# --- Route 3: Approve + auto-merge (highest confidence, lowest risk) ---
if [ "$verdict" = "approve" ] && \
   [ "$critical_count" -eq 0 ] && \
   [ "$major_count" -eq 0 ] && \
   [ "$auto_mergeable" = "true" ] && \
   [ "$(echo "$overall_score >= 9" | bc -l)" -eq 1 ]; then
    echo "::notice::Auto-merge eligible: score ${overall_score}, no critical/major findings, triage approved"
    post_inline_comments
    add_label "ai-approved"

    # Only actually merge if the repo-level toggle is enabled
    if [ "$AUTO_MERGE_ENABLED" = "true" ]; then
        add_label "auto-merge-candidate"
        # Enable auto-merge (squash) — GitHub will merge once all other checks pass
        gh pr merge "$PR_NUMBER" --repo "$REPO" --squash --auto 2>/dev/null && \
            echo "::notice::Auto-merge enabled for PR #${PR_NUMBER}" || \
            echo "::warning::Could not enable auto-merge — check branch protection settings"
        echo "action=auto_merge" >> "$GITHUB_OUTPUT"
    else
        echo "::notice::Auto-merge is disabled (AUTO_MERGE_ENABLED=$AUTO_MERGE_ENABLED). PR approved but merge is manual."
        add_label "ai-review-passed"
        echo "action=approve" >> "$GITHUB_OUTPUT"
    fi
    exit 0
fi

# --- Route 4: Approve (good score, no blockers, but not auto-merge eligible) ---
if [ "$verdict" = "approve" ] && \
   [ "$critical_count" -eq 0 ] && \
   [ "$(echo "$overall_score >= 7" | bc -l)" -eq 1 ]; then
    echo "::notice::Approved: score ${overall_score}, no critical findings"
    post_inline_comments
    add_label "ai-review-passed"
    echo "action=approve" >> "$GITHUB_OUTPUT"
    exit 0
fi

# --- Route 5: Comment only (moderate issues, non-blocking) ---
if [ "$verdict" = "comment_only" ] || \
   ([ "$critical_count" -eq 0 ] && [ "$major_count" -le 2 ]); then
    echo "::notice::Comment-only review: flagging ${major_count} major, ${minor_count} minor findings"
    post_inline_comments
    add_label "needs-human-review"
    echo "action=comment_only" >> "$GITHUB_OUTPUT"
    exit 0
fi

# --- Route 6: Request changes (default for anything with critical/major findings) ---
echo "::notice::Requesting changes: ${critical_count} critical, ${major_count} major findings"
post_inline_comments
add_label "needs-work"
echo "action=request_changes" >> "$GITHUB_OUTPUT"