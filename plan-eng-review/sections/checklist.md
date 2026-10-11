<!-- AUTO-GENERATED from checklist.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Checklist (runner profile)

Eng phase steps and required outputs for `bin/gstack-autoplan` (unattended or
`light` runs); interactive runs read `sections/review-sections.md` in full.

### Steps
1. Scope Challenge (A assess, B selectors, C findings) with the decision
   procedure; every prior-phase consensus is in the prompt before review.
2. Sections 1–4 in order: architecture, code quality, test, performance
   (`perf` scope). Continue after the outside voice.
3. Final planning decisions, then the finish sequence below in order.

### Required outputs → producing section

| Output | Produced by | Scope |
|---|---|---|
| Review body | Output reference — review body | always |
| NOT in scope | "NOT in scope" section | always |
| What already exists | "What already exists" section | always |
| Diagrams | Diagrams | always |
| Failure modes | Failure modes | always |
| Worktree parallelization strategy | Worktree parallelization strategy | always |
| Test Plan | 3. Test review | always |
| Performance findings | 4. Performance review | perf |
| Unresolved decisions | Unresolved decisions | always |
| Completion summary | Completion summary | always |
| Review log row | Review Log | always |
| Next-skill handoff | Next Steps — Review Chaining | always |
| Learnings | Learning hooks | always |
