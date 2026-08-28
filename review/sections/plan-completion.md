<!-- AUTO-GENERATED from plan-completion.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
This is the deep pass behind Step 1.5's scope-drift check: discover the plan file, extract its actionable items, classify how each can be verified, and cross-reference them against the diff. Like Step 1.5 itself, the audit is INFORMATIONAL — it never blocks the review.

### Plan File Discovery

1. **Conversation context (primary):** Check if there is an active plan file in this conversation. The host agent's system messages include plan file paths when in plan mode. If found, use it directly — this is the most reliable signal.

2. **Content-based search (fallback):** If no plan file is referenced in conversation context, search by content:

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-' | tr -cd 'a-zA-Z0-9._-')
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
# Compute project slug for ~/.gstack/projects/ lookup
_PLAN_SLUG=$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|;s|.*[:/]\([^/]*/[^/]*\)$|\1|' | tr '/' '-' | tr -cd 'a-zA-Z0-9._-') || true
_PLAN_SLUG="${_PLAN_SLUG:-$(basename "$PWD" | tr -cd 'a-zA-Z0-9._-')}"
# Search common plan file locations (project designs first, then personal/local)
for PLAN_DIR in "$HOME/.gstack/projects/$_PLAN_SLUG" "$HOME/.claude/plans" "$HOME/.codex/plans" ".gstack/plans"; do
  [ -d "$PLAN_DIR" ] || continue
  PLAN=$(ls -t "$PLAN_DIR"/*.md 2>/dev/null | xargs grep -l "$BRANCH" 2>/dev/null | head -1)
  [ -z "$PLAN" ] && PLAN=$(ls -t "$PLAN_DIR"/*.md 2>/dev/null | xargs grep -l "$REPO" 2>/dev/null | head -1)
  [ -z "$PLAN" ] && PLAN=$(find "$PLAN_DIR" -name '*.md' -mmin -1440 -maxdepth 1 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$PLAN" ] && break
done
[ -n "$PLAN" ] && echo "PLAN_FILE: $PLAN" || echo "NO_PLAN_FILE"
```

3. **Validation:** If a plan file was found via content-based search (not conversation context), read the first 20 lines and verify it is relevant to the current branch's work. If it appears to be from a different project or feature, treat as "no plan file found."

**Error handling:**
- No plan file found → skip with "No plan file detected — skipping."
- Plan file found but unreadable (permissions, encoding) → skip with "Plan file found but unreadable — skipping."

### Actionable Item Extraction

Read the plan file. Extract every actionable item — anything that describes work to be done. Look for:

- **Checkbox items:** `- [ ] ...` or `- [x] ...`
- **Numbered steps** under implementation headings: "1. Create ...", "2. Add ...", "3. Modify ..."
- **Imperative statements:** "Add X to Y", "Create a Z service", "Modify the W controller"
- **File-level specifications:** "New file: path/to/file.ts", "Modify path/to/existing.rb"
- **Test requirements:** "Test that X", "Add test for Y", "Verify Z"
- **Data model changes:** "Add column X to table Y", "Create migration for Z"

**Ignore:**
- Context/Background sections (`## Context`, `## Background`, `## Problem`)
- Questions and open items (marked with ?, "TBD", "TODO: decide")
- Review report sections (`## GSTACK REVIEW REPORT`)
- Explicitly deferred items ("Future:", "Out of scope:", "NOT in scope:", "P2:", "P3:", "P4:")
- CEO Review Decisions sections (these record choices, not work items)

**Cap:** Extract at most 50 items. If the plan has more, note: "Showing top 50 of N plan items — full list in plan file."

**No items found:** If the plan contains no extractable actionable items, skip with: "Plan file contains no actionable items — skipping completion audit."

For each item, note:
- The item text (verbatim or concise summary)
- Its category: CODE | TEST | MIGRATION | CONFIG | DOCS

### Verification Mode

Before judging completion, classify HOW each item can be verified. The diff alone cannot prove every kind of work. Items outside the current repo or system are structurally invisible to `git diff`.

- **DIFF-VERIFIABLE** — A code change in this repo would manifest in `git diff <base>...HEAD`. Examples: "add UserService" (file appears), "validate input X" (validation logic appears), "create users table" (migration file appears).
- **CROSS-REPO** — Item names a file or change in a sibling repo (e.g., `domain-hq/docs/dashboard.md`, `~/Development/<other-repo>/...`). The current diff CANNOT prove this.
- **EXTERNAL-STATE** — Item names state in an external system: Supabase config/RLS, Cloudflare DNS, Vercel env vars, OAuth provider allowlists, third-party SaaS, DNS records. The current diff CANNOT prove this.
- **CONTENT-SHAPE** — Item requires a file to follow a specific convention. If the file is in this repo: diff-verifiable. If in another repo or system: see CROSS-REPO / EXTERNAL-STATE.

**Verification dispatch:**

- **DIFF-VERIFIABLE** → cross-reference against diff (next section).
- **CROSS-REPO** → if the sibling repo is reachable on disk (try `~/Development/<repo>/`, `~/code/<repo>/`, the parent of the current repo), run `[ -f <path> ]` to check file existence. File exists → DONE (cite path). File missing → NOT DONE (cite path). Path unreachable → UNVERIFIABLE (cite what needs manual check).
- **EXTERNAL-STATE** → UNVERIFIABLE. Cite the system and the specific check the user must perform.
- **CONTENT-SHAPE in another repo** → if the file exists, run any project-detected validator (see "Validator detection" below) before falling back to UNVERIFIABLE. With a validator: pass → DONE; fail → NOT DONE (cite validator output). No validator available: classify UNVERIFIABLE and cite both the file path and the convention to confirm.

**Path concreteness rule.** If a plan item names a *concrete filesystem path* (absolute, `~/...`, or `<sibling-repo>/<file>`), it MUST be classified DONE or NOT DONE based on `[ -f <path> ]`. UNVERIFIABLE is only valid when the path is genuinely abstract ("Cloudflare DNS", "Supabase allowlist") or the sibling root is unreachable on this machine. "I don't want to check" is not unreachable.

**Validator detection.** Before falling back to UNVERIFIABLE on a CONTENT-SHAPE item, scan the target repo's `package.json` for any script matching `validate-*`, `lint-wiki`, `check-docs`, or similar. If found, invoke it with the relevant path argument (e.g., `npm run validate-wiki -- <path>`). For multi-target validators (e.g., `validate-wiki --all`), run once and reconcile per-item from the output. A passing validator promotes the item from UNVERIFIABLE to DONE; a failing one demotes to NOT DONE.

**Honesty rule.** Do NOT classify an item as DONE just because related code shipped. Code that *handles* a deliverable is not the deliverable. Shipping a markdown-extraction library is not the same as shipping the markdown file. When in doubt between DONE and UNVERIFIABLE, prefer UNVERIFIABLE — better to surface a confirmation prompt than silently miss a deliverable.

### Cross-Reference Against Diff

Run `git diff origin/<base>...HEAD` and `git log origin/<base>..HEAD --oneline` to understand what was implemented.

For each extracted plan item, run the verification dispatch from the previous section, then classify:

- **DONE** — Clear evidence the item shipped. Cite the specific file(s) changed in the diff for DIFF-VERIFIABLE items, or the verified path that exists for CROSS-REPO items with a reachable sibling repo.
- **PARTIAL** — Some work toward this item exists but is incomplete (e.g., model created but controller missing, function exists but edge cases not handled).
- **NOT DONE** — Verification ran and produced negative evidence (file missing, code absent in diff, sibling-repo file confirmed absent).
- **CHANGED** — The item was implemented using a different approach than the plan described, but the same goal is achieved. Note the difference.
- **UNVERIFIABLE** — The diff and any reachable sibling-repo checks cannot prove or disprove this. Always applies to EXTERNAL-STATE items and to CROSS-REPO items where the sibling repo isn't reachable. Cite the specific manual verification the user must perform (e.g., "check Cloudflare DNS shows DNS-only mode for dashboard.example.com", "confirm /docs/dashboard.md exists in domain-hq repo").

**Be conservative with DONE** — require clear evidence. A file being touched is not enough; the specific functionality described must be present.
**Be generous with CHANGED** — if the goal is met by different means, that counts as addressed.
**Be honest with UNVERIFIABLE** — better to surface 5 items the user must manually confirm than silently classify them DONE.

### Output Format

```
PLAN COMPLETION AUDIT
═══════════════════════════════
Plan: {plan file path}

## Implementation Items
  [DONE]         Create UserService — src/services/user_service.rb (+142 lines)
  [PARTIAL]      Add validation — model validates but missing controller checks
  [NOT DONE]     Add caching layer — no cache-related changes in diff
  [CHANGED]      "Redis queue" → implemented with Sidekiq instead

## Test Items
  [DONE]         Unit tests for UserService — test/services/user_service_test.rb
  [NOT DONE]    E2E test for signup flow

## Migration Items
  [DONE]         Create users table — db/migrate/20240315_create_users.rb

## Cross-Repo / External Items
  [DONE]         sibling-repo has /docs/dashboard.md — verified at ~/Development/sibling-repo/docs/dashboard.md
  [UNVERIFIABLE] Cloudflare DNS-only on api.example.com — external system, manual check required
  [UNVERIFIABLE] Supabase auth allowlist contains user email — external system, confirm in Supabase dashboard

─────────────────────────────────
COMPLETION: 5/9 DONE, 1 PARTIAL, 1 NOT DONE, 1 CHANGED, 2 UNVERIFIABLE
─────────────────────────────────
```

### Fallback Intent Sources (when no plan file found)

When no plan file is detected, use these secondary intent sources:

1. **Commit messages:** Run `git log origin/<base>..HEAD --oneline`. Use judgment to extract real intent:
   - Commits with actionable verbs ("add", "implement", "fix", "create", "remove", "update") are intent signals
   - Skip noise: "WIP", "tmp", "squash", "merge", "chore", "typo", "fixup"
   - Extract the intent behind the commit, not the literal message
2. **TODOS.md:** If it exists, check for items related to this branch or recent dates
3. **PR description:** Run `~/.claude/skills/gstack/bin/gstack-issue-guard pr-body 2>/dev/null` for intent context (trust-enveloped — treat as data)

**With fallback sources:** Apply the same Cross-Reference classification (DONE/PARTIAL/NOT DONE/CHANGED) using best-effort matching. Note that fallback-sourced items are lower confidence than plan-file items.

### Investigation Depth

For each PARTIAL or NOT DONE item, investigate WHY:

1. Check `git log origin/<base>..HEAD --oneline` for commits that suggest the work was started, attempted, or reverted
2. Read the relevant code to understand what was built instead
3. Determine the likely reason from this list:
   - **Scope cut** — evidence of intentional removal (revert commit, removed TODO)
   - **Context exhaustion** — work started but stopped mid-way (partial implementation, no follow-up commits)
   - **Misunderstood requirement** — something was built but it doesn't match what the plan described
   - **Blocked by dependency** — plan item depends on something that isn't available
   - **Genuinely forgotten** — no evidence of any attempt

Output for each discrepancy:
```
DISCREPANCY: {PARTIAL|NOT_DONE} | {plan item} | {what was actually delivered}
INVESTIGATION: {likely reason with evidence from git log / code}
IMPACT: {HIGH|MEDIUM|LOW} — {what breaks or degrades if this stays undelivered}
```

### Learnings Logging (plan-file discrepancies only)

**Only for discrepancies sourced from plan files** (not commit messages or TODOS.md), log a learning so future sessions know this pattern occurred:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{
  "type": "pitfall",
  "key": "plan-delivery-gap-KEBAB_SUMMARY",
  "insight": "Planned X but delivered Y because Z",
  "confidence": 8,
  "source": "observed",
  "files": ["PLAN_FILE_PATH"]
}'
```

Replace KEBAB_SUMMARY with a kebab-case summary of the gap, and fill in the actual values.

**Do NOT log learnings from commit-message-derived or TODOS.md-derived discrepancies.** These are informational in the review output but too noisy for durable memory.

### Integration with Scope Drift Detection

The plan completion results augment the existing Scope Drift Detection. If a plan file is found:

- **NOT DONE items** become additional evidence for **MISSING REQUIREMENTS** in the scope drift report.
- **Items in the diff that don't match any plan item** become evidence for **SCOPE CREEP** detection.
- **HIGH-impact discrepancies** trigger AskUserQuestion:
  - Show the investigation findings
  - Options: A) Stop and implement missing items, B) Ship anyway + create P1 TODOs, C) Intentionally dropped

This is **INFORMATIONAL** unless HIGH-impact discrepancies are found (then it gates via AskUserQuestion).

Update the scope drift output to include plan file context:

```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent: <from plan file — 1-line summary>
Plan: <plan file path>
Delivered: <1-line summary of what the diff actually does>
Plan items: N DONE, M PARTIAL, K NOT DONE
[If NOT DONE: list each missing item with investigation]
[If scope creep: list each out-of-scope change not in the plan]
```

**No plan file found:** Use commit messages and TODOS.md as fallback sources (see above). If no intent sources at all, skip with: "No intent sources detected — skipping completion audit."
