/**
 * Resolvers for the Implementation Tasks emission (#1454).
 *
 *   {{TASKS_SECTION_EMIT:<phase>}}     — per-skill task emission + JSONL write
 *   {{TASKS_SECTION_AGGREGATE}}        — autoplan aggregation across all phases
 *
 * JSONL artifact fields: phase, run_id, branch, commit, id, priority,
 * component, files, effort_human, effort_cc, title, source_finding
 * (consumed by /autoplan's aggregator).
 */

import type { TemplateContext, ResolverFn } from './types';

const VALID_PHASES = new Set(['ceo-review', 'design-review', 'eng-review', 'devex-review']);

export const generateTasksSectionEmit: ResolverFn = (_ctx: TemplateContext, args?: string[]) => {
  const phase = args?.[0];
  if (!phase || !VALID_PHASES.has(phase)) {
    throw new Error(`TASKS_SECTION_EMIT requires one of ${[...VALID_PHASES].join(', ')} — got ${phase}`);
  }
  const ceo = _ctx.skillName === 'plan-ceo-review';
  const conditionalWrites = ceo || _ctx.skillName === 'plan-eng-review';
  const storagePolicy = ceo ? 'Step 0 storage policy' : 'Review record and write policy';

  return `## Implementation Tasks

${ceo ? `Turn findings into tasks within the approved review depth. Implementation-ready
tasks describe the build. Strategy-only tasks name the next research, design or
verification action and its owner; they do not choose implementation contracts.
List known files only. For unknown files, write "to be determined" and use an
empty JSONL files array. Each task needs a concrete verification step.` : `Before closing this review, synthesize the findings above into a flat list of
build-actionable tasks. Each task derives from a specific finding — no padding.`}
${conditionalWrites ? `Always emit the markdown section. Write its JSONL artifact for \`/autoplan\` only when the ${storagePolicy} permits it; otherwise label the complete task output not persisted and do not claim an aggregation artifact exists.` : 'Emit the markdown section AND write a JSONL artifact that `/autoplan` can\naggregate across phases.'}

### Earlier lists on this branch

Before listing tasks, run \`~/.claude/skills/gstack/bin/gstack-tasks prior --phase ${phase}\` and reconcile what it prints, so a rerun never leaves two lists.

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
- Show human-team and CC+gstack effort estimates. Default task-type ratios (human ÷ CC time): scaffolding ~100x, tests ~50x, features ~30x, bug fix with regression ~20x, architecture ~5x, research ~3x. Adjust to the actual work and state the assumption.

### JSONL artifact (${conditionalWrites ? 'write when permitted, including zero tasks' : 'always write, even if zero tasks'})

\`/autoplan\` aggregates this list. With your file-write tool, write one JSON object per line to \`.gstack/tmp/tasks-${phase}-rows.jsonl\` at the repo root (no free text in a command; no rows, no file): a task is \`{"id":"T1","priority":"P1","component":"","title":"","source_finding":"","effort_human":"~2h","effort_cc":"~15min","files":[]}\`, plus \`"carried_from":"<run_id>/<id>"\` when carried; a closed earlier task is \`{"prior":"<run_id>/<id>","disposition":"done|dropped","reason":""}\`. Then write the list (empty means "ran, no findings", distinct from "didn't run"):

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-tasks add --phase ${phase}
\`\`\`
`;
};

export const generateTasksSectionAggregate: ResolverFn = (_ctx: TemplateContext) => {
  return `## Implementation Tasks aggregator

Before rendering the Final Approval Gate output block below, aggregate the
per-phase task lists each review skill wrote.

\`\`\`bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
BRANCH=$(~/.claude/skills/gstack/bin/gstack-slug --get BRANCH 2>/dev/null)
SLUG=$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG 2>/dev/null)
TASKS_DIR="$GSTACK_STATE_ROOT/projects/\${SLUG:-unknown}"
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
# Commit window: last 5 commits on this branch. Drops stale standalone reviews.
COMMITS_RECENT=$(git log --format=%H -n 5 2>/dev/null | tr '\\n' '|' | sed 's/|$//')

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
      jq -c --arg branch "$BRANCH" --arg commits "$COMMITS_RECENT" \\
        '.commit as $c | select(.branch == $branch and ($commits | split("|") | index($c) != null))' \\
        "$f" 2>/dev/null >> "$ALL_JSONL" || true
    done < <(find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl" 2>/dev/null | sort)
    # Latest run_id per phase
    if [ -s "$ALL_JSONL" ]; then
      jq -sc --arg phase "$phase" \\
        '[.[] | select(.phase == $phase)] | (max_by(.run_id) // null) as $latest_run | if $latest_run then map(select(.run_id == $latest_run.run_id)) else [] end | .[]' \\
        "$ALL_JSONL" > "$ALL_JSONL.phase" 2>/dev/null || true
      jq -c --arg phase "$phase" 'select(.phase != $phase)' "$ALL_JSONL" > "$ALL_JSONL.other" 2>/dev/null || true
      cat "$ALL_JSONL.other" "$ALL_JSONL.phase" > "$ALL_JSONL"
      rm -f "$ALL_JSONL.phase" "$ALL_JSONL.other"
    fi
  done

  # Exact-match dedupe; non-matches stay separate (the renderer marks possible duplicates).
  AGGREGATED_TASKS=$(jq -s \\
    'group_by([.component, (.files | sort), .title])
     | map(
         # Highest priority per group; tie-break by phase order
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

In the Final Approval Gate output template below, render the aggregated markdown
in the \`### Implementation Tasks (aggregated across phases)\` section: substitute
\`$AGGREGATED_TASKS\` (the bash variable above) at runtime before printing the
message; it is not a gen-skill-docs placeholder.

If \`$AGGREGATED_TASKS\` is empty (no JSONL files found — none of the review
skills ran in this session), render:

\`_No per-phase task lists found in $TASKS_DIR for branch $BRANCH. Each review
skill writes its own; if you ran one of them but no list appears here, check
that jq is installed and the tasks-<phase>-*.jsonl files exist._\`
`;
};
