/**
 * Resolvers for the Implementation Tasks emission (#1454).
 *
 *   {{TASKS_SECTION_EMIT:<phase>}}     — per-skill task emission + JSONL write
 *   {{TASKS_SECTION_AGGREGATE}}        — autoplan aggregation across all phases
 *
 * Schema for the JSONL artifact lives in scripts/task-emission-schema.ts.
 */

import type { TemplateContext, ResolverFn } from './types';

const VALID_PHASES = new Set(['ceo-review', 'design-review', 'eng-review', 'devex-review']);

export const generateTasksSectionEmit: ResolverFn = (_ctx: TemplateContext, args?: string[]) => {
  const phase = args?.[0];
  if (!phase || !VALID_PHASES.has(phase)) {
    throw new Error(`TASKS_SECTION_EMIT requires one of ${[...VALID_PHASES].join(', ')} — got ${phase}`);
  }

  return `## Implementation Tasks

Before closing this review, synthesize the findings above into a flat list of
build-actionable tasks. Each task derives from a specific finding — no padding.
Emit the markdown section AND write a JSONL artifact that \`/autoplan\` can
aggregate across phases.

### Markdown section (always emit)

\`\`\`markdown
## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — <component> — <imperative title>
  - Surfaced by: <section name> — <specific finding text or line reference>
  - Files: <paths to touch>
  - Verify: <test command or manual check>
- [ ] **T2 (P2, human: ~30min / CC: ~5min)** — ...
\`\`\`

Rules:
- P1 blocks ship; P2 should land same branch; P3 is a follow-up TODO.
- If a finding produced no actionable task, do not invent one.
- If a section had zero findings, emit \`_No new tasks from <section>._\`
- Effort uses the AI-compression table from CLAUDE.md.

### JSONL artifact (always write, even if zero tasks)

\`/autoplan\` reads this file to aggregate across phases. Build each line with
\`jq -nc\` so titles and source findings containing quotes, newlines, or
backslashes serialize cleanly — never use hand-rolled \`echo\` / \`printf\`.

\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
TASKS_DIR="\${HOME}/.gstack/projects/\${SLUG:-unknown}"
mkdir -p "$TASKS_DIR"
TASKS_FILE="$TASKS_DIR/tasks-${phase}-$(date +%Y%m%d-%H%M%S).jsonl"
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

# Repeat ONE jq invocation per task identified during this review.
# Substitute the placeholders inline with shell variables you set per task:
#   TASK_ID (T1, T2, ...), PRIORITY (P1/P2/P3), COMPONENT, TITLE,
#   SOURCE_FINDING, EFFORT_HUMAN, EFFORT_CC, FILES_JSON (a JSON array literal
#   like '["browse/src/sanitize.ts","browse/src/server.ts"]').
jq -nc \\
  --arg phase '${phase}' \\
  --arg run_id "$RUN_ID" \\
  --arg branch "$BRANCH" \\
  --arg commit "$COMMIT" \\
  --arg id "$TASK_ID" \\
  --arg priority "$PRIORITY" \\
  --arg component "$COMPONENT" \\
  --arg effort_human "$EFFORT_HUMAN" \\
  --arg effort_cc "$EFFORT_CC" \\
  --arg title "$TITLE" \\
  --arg source_finding "$SOURCE_FINDING" \\
  --argjson files "$FILES_JSON" \\
  '{phase:$phase, run_id:$run_id, branch:$branch, commit:$commit, id:$id, priority:$priority, component:$component, files:$files, effort_human:$effort_human, effort_cc:$effort_cc, title:$title, source_finding:$source_finding}' \\
  >> "$TASKS_FILE"
\`\`\`

If \`jq\` is not installed, fall back to skipping the JSONL write and warn
the user to install jq for autoplan aggregation. Never hand-roll JSONL.

If zero tasks were identified in this review, still touch the JSONL file
(\`: > "$TASKS_FILE"\`) so the aggregator sees that the phase produced output
this run (an empty file means "ran, no findings" — distinct from "didn't run").
`;
};

export const generateTasksSectionAggregate: ResolverFn = (_ctx: TemplateContext) => {
  return `## Implementation Tasks aggregator

Before rendering the Final Approval Gate output block below, aggregate the
per-phase task lists each review skill wrote.

\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
TASKS_DIR="\${HOME}/.gstack/projects/\${SLUG:-unknown}"
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
# Commit window: last 5 commits on this branch. Drops stale standalone reviews.
COMMITS_RECENT=$(git log --format=%H -n 5 2>/dev/null | tr '\\n' '|' | sed 's/|$//')

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
      jq -c --arg branch "$BRANCH" --arg commits "$COMMITS_RECENT" \\
        'select(.branch == $branch and ($commits | split("|") | index(.commit) != null))' \\
        "$f" 2>/dev/null >> "$ALL_JSONL" || true
    done < <(find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl" 2>/dev/null | sort)
    # Reduce to latest run_id per phase
    if [ -s "$ALL_JSONL" ]; then
      jq -sc --arg phase "$phase" \\
        '[.[] | select(.phase == $phase)] | (max_by(.run_id) // null) as $latest_run | if $latest_run then map(select(.run_id == $latest_run.run_id)) else [] end | .[]' \\
        "$ALL_JSONL" > "$ALL_JSONL.phase" 2>/dev/null || true
      # Replace with reduced version for this phase, accumulating others
      jq -c --arg phase "$phase" 'select(.phase != $phase)' "$ALL_JSONL" > "$ALL_JSONL.other" 2>/dev/null || true
      cat "$ALL_JSONL.other" "$ALL_JSONL.phase" > "$ALL_JSONL"
      rm -f "$ALL_JSONL.phase" "$ALL_JSONL.other"
    fi
  done

  # Exact-match dedup by (component, sorted(files), title). Non-matches kept
  # separately with a possible-duplicate marker injected by the renderer.
  AGGREGATED_TASKS=$(jq -s \\
    'group_by([.component, (.files | sort), .title])
     | map(
         # Take the highest-priority entry per group; tie-break by phase order
         sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99) | .[0]
       )
     | sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99)
     | if length == 0 then "_No actionable tasks emitted from any phase._" else
         map("- [ ] **\\(.id) (\\(.priority), human: \\(.effort_human) / CC: \\(.effort_cc)) — \\(.component)** — \\(.title)\\n  - Surfaced by: \\(.phase) — \\(.source_finding)\\n  - Files: \\(.files | join(", "))") | join("\\n")
       end' "$ALL_JSONL" 2>/dev/null | sed 's/^"//;s/"$//;s/\\\\n/\\n/g')
  rm -f "$ALL_JSONL"
else
  AGGREGATED_TASKS="_jq not installed — install jq to aggregate per-phase task lists. Skipping._"
fi
\`\`\`

Inside the Final Approval Gate output template below, render the aggregated
markdown in the \`### Implementation Tasks (aggregated across phases)\` section.
Substitute the contents of \`$AGGREGATED_TASKS\` (the bash variable set above)
before printing the message to the user. This is NOT a template placeholder
— the agent does the substitution at runtime, not gen-skill-docs at build time.

If \`$AGGREGATED_TASKS\` is empty (no JSONL files found — none of the review
skills ran in this session), render:

\`_No per-phase task lists found in $TASKS_DIR for branch $BRANCH. Each review
skill writes its own; if you ran one of them but no list appears here, check
that jq is installed and the tasks-<phase>-*.jsonl files exist._\`
`;
};
