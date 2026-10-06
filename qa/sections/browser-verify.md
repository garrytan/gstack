<!-- AUTO-GENERATED from browser-verify.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Browser repair verification

Use this section only for a browser defect. Re-run the original interaction and an
adjacent happy path. The Phase 5 evidence is the before (`issue-NNN-result.jpg` for an
interactive defect, the annotated `issue-NNN.png` for a static one); capture the after now.

Use the Phase 3 read/flow script in qa-patterns with `flow = true` for interaction bugs;
set its actions and waits to the original reproduction. For static defects use `flow = false`.
Keep the error hook, snapshot, console output and `GSTACK_STEP_OK` check. Run each flow
in one script from the affected URL; tabs do not survive the script.

Use fresh screenshot names, with `issue-NNN-after.jpg` for the result (add a suffix if it exists).
Copy them from the printed `ASIDE_DIR` to `$REPORT_DIR/screenshots/`, then Read the copied screenshot.
Compare the snapshot tree, `DIFF` and `CONSOLE_ERRORS=` with the before evidence.

On fallback, apply browser-setup's `$B` mapping to the same checks.
Functional repairs never load this section.
