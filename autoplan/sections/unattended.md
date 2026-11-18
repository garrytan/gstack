<!-- AUTO-GENERATED from unattended.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Unattended profile

`SESSION_KIND: unattended`: a parent drives the run through
`~/.claude/skills/gstack/bin/gstack-autoplan` (DRIVER.md;
docs/unattended.md) and reads artifacts, never prose. Phases close
themselves, Eng runs last, and the outside voice (none when lean) runs per DRIVER.md
(enabled `codex_reviews` is consent; foreground only).

**The gate, unattended.** Never approve it on your own judgment: with no owner reply, the run stops at `status=gate_pending`. Record an owner's reply relayed to you yourself, never handing them the command: `gstack-autoplan answer --out <dir> --gate-rev <n> --reply "<reply>" --by agent:<id> --owner-reply-file <file of their words>`.

`gstack-artifact validate <dir>/run.json` is the completion check. End with
`GSTACK_RESULT: skill=autoplan status=<status> run=<dir>`.
