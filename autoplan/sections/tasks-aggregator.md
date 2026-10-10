<!-- AUTO-GENERATED from tasks-aggregator.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Implementation Tasks aggregator

Before rendering the Final Approval Gate output block below, aggregate the
per-phase task lists each review skill wrote.

```bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
BRANCH=$(~/.claude/skills/gstack/bin/gstack-slug --get BRANCH 2>/dev/null)
SLUG=$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG 2>/dev/null)
TASKS_DIR="$GSTACK_STATE_ROOT/projects/${SLUG:-unknown}"
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
# Commit window: last 5 commits on this branch. Drops stale standalone reviews.
COMMITS_RECENT=$(git log --format=%H -n 5 2>/dev/null | tr '\n' '|' | sed 's/|$//')

AGGREGATED_TASKS=""
if command -v jq >/dev/null 2>&1; then
  # All 4 phases, scoped to this branch + commit window; latest run_id per
  # phase; exact dedupe by (component, sorted(files), title); P1 > P2 > P3, then phase order.
  ALL_JSONL=$(mktemp -t autoplan-tasks.XXXXXXXX)
  for phase in ceo-review design-review eng-review devex-review; do
    # find, not a glob: zsh nomatch errors when a phase wrote no JSONL. Sorted for stable order.
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      # .commit is bound BEFORE the pipe: a pipe rebinds jq's context, so a bare
      # .commit after it indexes the array, every line errors, and the aggregate is empty.
      jq -c --arg branch "$BRANCH" --arg commits "$COMMITS_RECENT" \
        '.commit as $c | select(.branch == $branch and ($commits | split("|") | index($c) != null))' \
        "$f" 2>/dev/null >> "$ALL_JSONL" || true
    done < <(find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl" 2>/dev/null | sort)
    # Latest run_id per phase
    if [ -s "$ALL_JSONL" ]; then
      jq -sc --arg phase "$phase" \
        '[.[] | select(.phase == $phase)] | (max_by(.run_id) // null) as $latest_run | if $latest_run then map(select(.run_id == $latest_run.run_id)) else [] end | .[]' \
        "$ALL_JSONL" > "$ALL_JSONL.phase" 2>/dev/null || true
      jq -c --arg phase "$phase" 'select(.phase != $phase)' "$ALL_JSONL" > "$ALL_JSONL.other" 2>/dev/null || true
      cat "$ALL_JSONL.other" "$ALL_JSONL.phase" > "$ALL_JSONL"
      rm -f "$ALL_JSONL.phase" "$ALL_JSONL.other"
    fi
  done

  # Exact-match dedupe; non-matches stay separate (the renderer marks possible duplicates).
  AGGREGATED_TASKS=$(jq -s \
    'group_by([.component, (.files | sort), .title])
     | map(
         # Highest priority per group; tie-break by phase order
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

In the Final Approval Gate output template below, render the aggregated markdown
in the `### Implementation Tasks (aggregated across phases)` section: substitute
`$AGGREGATED_TASKS` (the bash variable above) at runtime before printing the
message; it is not a gen-skill-docs placeholder.

If `$AGGREGATED_TASKS` is empty (no JSONL files found — none of the review
skills ran in this session), render:

`_No per-phase task lists found in $TASKS_DIR for branch $BRANCH. Each review
skill writes its own; if you ran one of them but no list appears here, check
that jq is installed and the tasks-<phase>-*.jsonl files exist._`

