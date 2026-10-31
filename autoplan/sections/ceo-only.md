<!-- AUTO-GENERATED from ceo-only.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## CEO-only run (`--ceo-only`)

This section governs the whole run and wins over the skeleton. The run reviews
the plan; it never approves it.

**Zero questions.** Never call AskUserQuestion (native or `mcp__*`) or
ExitPlanMode, never ask the user in prose, never wait for a reply, whatever
`SESSION_KIND` says. A preamble instruction block that would ask takes its
non-consenting default (off, not now, skip). Each decision takes its
`(recommended)` option, else the 6 principles; consent, destructive or
irreversible options take the conservative choice. Log each as a Decision Audit
Trail row.

**Scope.** Run Phases 0, 0.5 and 1 only; send "Phases 2, 2.5, 3 and 4 skipped
(CEO-only run)" and record it in ACTIVE_PLAN. With `--no-outside`, skip every
outside dispatch: `outside_status: disabled (--no-outside)`.

**Mode.** Instead of SELECTIVE EXPANSION, use plan-ceo-review 0E step 2's rule
(an explicit mode in the request wins), skip step 3, run
`~/.claude/skills/gstack/bin/gstack-ceo-mode-handoff "<mode>" --ceo-only --decisions "<rows or none>"`
and send its line verbatim.

**Never applied:** a user challenge (keep the direction; list it below).
**Skipped and logged `skipped (ceo-only)`:** office-hours and BENEFITS_FROM
offers, 0E's question, plan archive cleanup, Next Steps chaining and CEO plan
promotion; the row satisfies its checklist entry.

**State.** Write only in `$_AP`, ACTIVE_PLAN and `GSTACK_STATE_ROOT`
(the override; docs/state-root.md).

**Finish.** After Phase 1 closes, write `$_AP/ceo-review.md`: `# CEO-only
review: <plan title>`; a line with the mode, outside-voice status and "Not
approved"; then `## User challenges (direction kept)` (plan says, proposal,
why, cost if wrong), `## Scope added`, `## Conservative choices`,
`## Findings` (severity, section, fix, disposition) and `## Decision Audit
Trail` (copied), each "None." when empty. Send the CEO Completion Summary and
both paths, skip Completion's logs, approval and `/ship`, and end with:

`GSTACK_RESULT: skill=autoplan status=reviewed run=<absolute $_AP>`
