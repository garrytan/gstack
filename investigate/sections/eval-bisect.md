<!-- AUTO-GENERATED from eval-bisect.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Eval bisect recipe

A judged or scored metric regressed between two revisions. Bisect inputs, not
commits, and spend the paid judge last.

1. **Distinct revisions only.** `git log --oneline <good>..<bad> -- <prompt and
   resolver paths>`; collapse commits that leave the expanded prompt bytes
   identical (build the prompt with the actual builder at each revision and
   compare hashes; a template edit that renders the same bytes is not a
   candidate).
2. **A cached cheap scorer first.** Score every distinct revision with the
   deterministic or cheap check (the structural judge, a token count, the
   quality judge at its lowest tier) and cache results per
   `(revision, case)` under `.gstack/tmp/eval-bisect/`. Bisect on the cheap
   score; spend the paid judge only on the two revisions where the cheap scorer
   disagrees with the reported regression.
3. **Detached runs.** Launch paid cases through the documented detached runner
   (`bun run eval:bg:pr`), poll the log for `### gstack-detach EXIT=<code> ###`,
   and keep the eval lock. Never retry a paid case; a failed launch is a launch
   failure in the report, not a second sample.
4. **Report.** The first bad revision with its prompt diff, the cheap and paid
   scores per revision (cached hits marked), the pre-registered panel size and
   every trial, and the cases that were not run.
