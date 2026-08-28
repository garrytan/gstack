<!-- AUTO-GENERATED from tasks-aggregator.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Implementation Tasks aggregator

Before rendering the Final Approval Gate output block below, aggregate the
per-phase task lists each review skill wrote.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
TASKS_DIR="${HOME}/.gstack/projects/${SLUG:-unknown}"
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
# Commit window: last 5 commits on this branch. Drops stale standalone reviews.
COMMITS_RECENT=$(git log --format=%H -n 5 2>/dev/null | tr '\n' '|' | sed 's/|$//')

AGGREGATED_TASKS=""
if command -v jq >/dev/null 2>&1; then
  # Collect entries from all 4 phases, scoped to current branch + commit window.
  # For each phase, keep only the latest run_id. Within the surviving set,
  # dedupe by (component, sorted(files), title) — exact match only.
  # Sort by priority (P1 > P2 > P3) then by phase order.
  ALL_JSONL=$(mktemp -t autoplan-tasks.XXXXXXXX)
  for phase in ceo-review design-review eng-review devex-review; do
    # Use find instead of glob expansion — zsh nomatch errors otherwise when
    # a phase produced no JSONL files. Sorting by name keeps the order stable.
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      # Filter to current branch + recent commits, then keep records for the
      # latest run_id only. (Single phase may have multiple files if the user
      # re-ran the review; aggregator takes the newest.)
      # .commit must be bound BEFORE piping to the split commit array: a
      # pipe rebinds jq's context, so a bare .commit after it indexes the
      # ARRAY with a string, every line errors into 2>/dev/null, and the
      # aggregate is empty forever — the #2018 zero-tasks bug.
      jq -c --arg branch "$BRANCH" --arg commits "$COMMITS_RECENT" \
        '.commit as $c | select(.branch == $branch and ($commits | split("|") | index($c) != null))' \
        "$f" 2>/dev/null >> "$ALL_JSONL" || true
    done < <(find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl" 2>/dev/null | sort)
    # Reduce to latest run_id per phase
    if [ -s "$ALL_JSONL" ]; then
      jq -sc --arg phase "$phase" \
        '[.[] | select(.phase == $phase)] | (max_by(.run_id) // null) as $latest_run | if $latest_run then map(select(.run_id == $latest_run.run_id)) else [] end | .[]' \
        "$ALL_JSONL" > "$ALL_JSONL.phase" 2>/dev/null || true
      # Replace with reduced version for this phase, accumulating others
      jq -c --arg phase "$phase" 'select(.phase != $phase)' "$ALL_JSONL" > "$ALL_JSONL.other" 2>/dev/null || true
      cat "$ALL_JSONL.other" "$ALL_JSONL.phase" > "$ALL_JSONL"
      rm -f "$ALL_JSONL.phase" "$ALL_JSONL.other"
    fi
  done

  # Exact-match dedup by (component, sorted(files), title). Non-matches kept
  # separately with a possible-duplicate marker injected by the renderer.
  AGGREGATED_TASKS=$(jq -s \
    'group_by([.component, (.files | sort), .title])
     | map(
         # Take the highest-priority entry per group; tie-break by phase order
         sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99) | .[0]
       )
     | sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99)
     | if length == 0 then "_No actionable tasks emitted from any phase._" else
         map("- [ ] **\(.id) (\(.priority), human: \(.effort_human) / CC: \(.effort_cc)) — \(.component)** — \(.title)\n  - Surfaced by: \(.phase) — \(.source_finding)\n  - Files: \(.files | join(", "))") | join("\n")
       end' "$ALL_JSONL" 2>/dev/null | sed 's/^"//;s/"$//;s/\\n/\n/g')
  rm -f "$ALL_JSONL"
else
  AGGREGATED_TASKS="_jq not installed — install jq to aggregate per-phase task lists. Skipping._"
fi
```

Inside the Final Approval Gate output template below, render the aggregated
markdown in the `### Implementation Tasks (aggregated across phases)` section.
Substitute the contents of `$AGGREGATED_TASKS` (the bash variable set above)
before printing the message to the user. This is NOT a template placeholder
— the agent does the substitution at runtime, not gen-skill-docs at build time.

If `$AGGREGATED_TASKS` is empty (no JSONL files found — none of the review
skills ran in this session), render:

`_No per-phase task lists found in $TASKS_DIR for branch $BRANCH. Each review
skill writes its own; if you ran one of them but no list appears here, check
that jq is installed and the tasks-<phase>-*.jsonl files exist._`

