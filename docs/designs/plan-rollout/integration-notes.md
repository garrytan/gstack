# Integration notes — changes needed to existing gstack skills

This document describes modifications to existing gstack skills to consume the
`decomposition.md` and `rollout.md` artifacts produced by `/plan-rollout`. Land
these as PR #4 in the contribution stack (after the two new skills and the
parser have merged).

## Design principle: zero regression

Every existing skill must behave **identically** when no `decomposition.md`
exists. Stack-mode behavior is gated on the artifact's presence. Users who
never run `/plan-rollout` see no change.

---

## `/ship` — stack mode (Expansion #5)

**Gate:** `[ -f "$_ARTIFACTS_DIR/decomposition.md" ]` after Step 1 (state discovery).

**New step: Step 11.5 — Stack-mode PR creation** (inserted before existing
Step 12 — VERSION bump).

```bash
if [ -f "$_ARTIFACTS_DIR/decomposition.md" ]; then
  # Parse decomposition, determine which PR unit this push represents.
  # Heuristic: git log of this branch since its parent stack-unit's merge base.
  _UNIT_ID=$(~/.claude/skills/gstack/lib/plan-rollout/infer-current-unit \
    --decomposition "$_ARTIFACTS_DIR/decomposition.md" \
    --branch "$_BRANCH" --diff-base "$(determine-parent-base)")

  # Enforce: if /spill-check would fail, halt with clear explanation.
  ~/.claude/skills/gstack/bin/spill-check-gate --unit "$_UNIT_ID" || exit 1

  # Generate the PR body from the decomposition entry for this unit:
  #   - Title (conventional-commits from decomposition)
  #   - Reading-order block
  #   - Reviewer time-budget estimate
  #   - Dependency note ("Depends on PR #N (merged/open)")
  #   - Next-in-stack note ("Followed by PR #M (title)")
  #   - Rollout strategy summary (links to rollout.md)
  _PR_BODY=$(~/.claude/skills/gstack/lib/plan-rollout/pr-body-for-unit \
    --decomposition "$_ARTIFACTS_DIR/decomposition.md" \
    --rollout "$_ARTIFACTS_DIR/rollout.md" \
    --unit "$_UNIT_ID")
fi
```

The existing `gh pr create` (Step 15-ish) uses `$_PR_BODY` when set, falling
through to the current default behavior when unset.

### Stacking mechanic

v1 does NOT implement native stacked-PR mechanics (rewriting base-branch fields
for each PR as the parent merges). Instead:

- First PR in the stack: base = `main` / default branch (standard)
- Subsequent PRs: base = the previous unit's branch, auto-filled
- User is responsible for using Graphite / git-spr / manual rebasing for the
  stack mechanics

This keeps `/ship` from becoming a stacking tool. The reviewer-ergonomics win
(reading order, time budget, dependency narration) is orthogonal to the
stack-rebase mechanics and more valuable.

v2 could add native stacking; scope for a future PR.

---

## `/review` — scope verification (Expansion #6)

**Gate:** same — `decomposition.md` exists.

**New step: before the existing review runs**, verify scope:

```bash
if [ -f "$_ARTIFACTS_DIR/decomposition.md" ]; then
  _UNIT_ID=$(~/.claude/skills/gstack/lib/plan-rollout/infer-current-unit ...)

  # Run spill classifier in gate mode (non-interactive).
  _SCOPE_REPORT=$(~/.claude/skills/gstack/lib/plan-rollout/spill-classifier \
    --decomposition "$_ARTIFACTS_DIR/decomposition.md" \
    --current-unit "$_UNIT_ID" \
    --files "$(git diff --name-only BASE HEAD)" \
    --format human)

  # If hard spills present, surface them as Section 0 of the review output.
  echo "## Scope Verification"
  echo "$_SCOPE_REPORT"
fi
```

Hard spills become P1 findings in the existing `/review` output. Soft spills
become informational notes. This closes the loop: `/spill-check` catches
spills during implementation; `/review` catches any that made it to PR.

---

## `/plan-ceo-review` and `/plan-eng-review` — Next Steps hooks (Expansion #7)

In the existing "Next Steps — Review Chaining" section, add a line:

```markdown
**Recommend /plan-rollout if the accepted plan represents more than one logical
unit of work.** Signs: plan touches >5 files, spans multiple SYSTEM.md
components, includes both migrations and feature code, or the CEO review
accepted scope expansions. /plan-rollout decomposes the plan into a reviewable
PR stack and produces the rollout artifact, saving you from either a
humongous single PR or improvised stacking.
```

Add `/plan-rollout` to the AskUserQuestion options in that section:

```
- A) Run /plan-eng-review next (required gate)
- B) Run /plan-rollout next (decompose into PR stack + rollout plan)
- C) Run /plan-design-review next (only if UI scope detected)
- D) Skip — I'll handle reviews manually
```

---

## `/land-and-deploy` — rollout-aware deployment (stretch)

Not in v1 scope, but the hook point is obvious: `/land-and-deploy` reads
`rollout.md` for the step sequence, executes each step with its verify block,
and uses the auto-generated rollback lines if a step fails. Defer to v2 to
keep the initial PR stack tractable.

---

## `/canary` — scope-aware regression watching (stretch)

Also v2. `/canary` could read the `verify:` metrics from `rollout.md` and
watch them specifically post-deploy, alerting on regression in the declared
scope while ignoring unrelated noise.

---

## Test plan (lives in `test/plan-rollout/`)

```
test/plan-rollout/
├── system-map-parser.test.ts         # YAML parsing, validation, component lookup
├── reconcile.test.ts                 # the 3 reconciliation categories on fixtures
├── scaffolder.test.ts                # draft generation from a test repo fixture
├── decomposition-roundtrip.test.ts   # write → read → write produces identical output
├── reviewer-time-estimator.test.ts   # formula produces expected ranges
└── spill-classifier.test.ts          # hard/soft classification + allowlist logic
```

Fixtures in `test/fixtures/plan-rollout/`:
- `system-map-minimal.yaml` — single component
- `system-map-three-layers.yaml` — auth + middleware + gateway example
- `system-map-invalid-*.yaml` — each validation error path
- `import-graph-sample.json` — synthetic edges for reconcile tests
- `decomposition-three-prs.md` — golden output

Test approach matches existing gstack skills (see `test/fixtures/golden/` in
the repo for the pattern).

---

## Rollout of the contribution itself

As described in CEO-PLAN.md, this lands as a 4-PR stack (the skill
decomposing its own contribution):

1. **PR #1 — Foundation.** `lib/plan-rollout/system-map-*.ts` + tests +
   `docs/SYSTEM-MD.md`. Standalone; no skills modified. ~15 min review.
2. **PR #2 — /plan-rollout skill.** `plan-rollout/SKILL.md` + remaining
   `lib/plan-rollout/*.ts` (decomposition writer, rollout writer, reviewer-time
   estimator, inverse-rollback generator). ~25 min review.
3. **PR #3 — /spill-check skill.** `spill-check/SKILL.md` + spill classifier.
   Independent of PR #2. ~15 min review.
4. **PR #4 — Integration.** Modify `ship/SKILL.md`, `review/SKILL.md`,
   `plan-ceo-review/SKILL.md`, `plan-eng-review/SKILL.md`. Hot-path risk;
   covered by golden-fixture tests. ~20 min review.

File the issue first:
https://github.com/garrytan/gstack/issues/new — link CEO-PLAN.md, propose the
stack, ask for directional buy-in before sinking implementation time.
