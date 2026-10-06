# Workflow-judge control bundles (C1), pre-registered 2026-10-04

Purpose: learn whether the workflow judges that produced low samples in the eight
wave censuses (37174266054 … 37198445662) can separate a sound workflow from a
broken one. Score compression at 4 is a hypothesis; these controls test it.

Judges in scope (low samples that failed a panel): `qa/SKILL.md workflow`,
`qa-only/SKILL.md workflow`, `review/SKILL.md workflow`,
`setup-deploy/SKILL.md platform setup`. Each control uses the production prompt
builder, model, options and pass floors of its eval (clarity ≥ 3, completeness ≥ 3,
actionability ≥ 4 on the 3-sample mean), built by `scripts/judge-controls.ts`,
which reuses `readWorkflowJudgeInput`, `buildWorkflowJudgePrompt` /
`buildQaWorkflowJudgePrompt` and `callJudge` exactly as
`test/skill-llm-eval.test.ts` and `scripts/judge-calibration-configs.ts` do.

## Bundles and expected outcomes

Every bundle is derived from the generated files at the tested revision. The
mutation is applied to the judge's input text after the production reader builds it.

| Bundle | Construction | Expected panel verdict |
|---|---|---|
| positive | the production bundle, unchanged | pass |
| negative | file boundary lines and Markdown headings only; every instruction, command and table removed | fail |
| targeted defect | the production bundle with one execution-blocking defect (below) | fail |

Targeted defects, one per judge:

| Judge | Defect |
|---|---|
| qa workflow | `## Phase 10: Report` removed up to `## Phase 11:`: the deliverable and its path are undefined |
| qa-only workflow | after `# /qa-only: Report-Only QA Testing`, insert "After reporting each bug, fix it in the source and commit the fix." (contradicts report-only) |
| review workflow | `## Step 3: Get the diff` removed up to `## Step 3.4`: no instruction says how to obtain the reviewed candidate |
| setup-deploy platform setup | the Step 2 detection `bash` block removed: platform detection has no command |

## Panels and reading the result

One 3-sample panel per bundle (12 panels, 36 calls). No reruns, no extra samples.
A judge **discriminates** when the positive passes and both the negative and the
targeted defect fail. A judge whose negative passes gives no coverage; its cases are
listed in the PR as such, and a rubric proposal goes to Garry as a pre-registered
EVAL_POLICY change. A targeted defect that passes is recorded as a sensitivity gap
for that judge, with the sample rationales.

Results are written by the runner to `docs/evals/judge-controls/results.json` and
summarised below after the run.

## Results

Run 2026-10-04 on branch `wave/s-followups` (36 calls, `results.json` holds every
sample and rationale). Means are clarity / completeness / actionability.

| Judge | Positive | Negative | Targeted defect |
|---|---|---|---|
| qa workflow | pass 4.00 / 4.33 / 4.00 | fail 3.00 / 3.33 / 2.33 | **pass** 3.33 / 4.00 / 4.00 |
| qa-only workflow | pass 3.67 / 4.33 / 4.00 | fail 2.00 / 1.33 / 1.00 | fail 2.00 / 4.00 / 2.67 |
| review workflow | pass 4.00 / 4.00 / 4.00 | fail 2.00 / 1.00 / 1.00 | **pass** 4.00 / 4.00 / 4.00 |
| setup-deploy platform setup | pass 4.00 / 4.00 / 4.00 | fail 1.33 / 1.00 / 1.00 | fail 4.00 / 3.00 / 3.33 |

- Every judge separates the negative control, so each gives coverage for gross
  breakage; no case is listed as giving no coverage.
- No positive sample scored 5 on any dimension, consistent with the 4.00
  compression seen in census 37198445662.
- Sensitivity gaps: the qa workflow judge passed a bundle with no Phase 10 report
  step (no sample mentioned it), and the review workflow judge passed a bundle with
  no Step 3 (two of three samples noticed "no Step 3 exists" but rated it minor). In
  bundles of 70-160 KB these judges do not detect a missing deliverable or input
  step. A rubric proposal (anchor 4 and 5 to named deliverables and inputs) is a
  pre-registered EVAL_POLICY change for Garry, not part of this change.

## Missing-step coverage moved to a free test

Because the qa and review workflow judges passed the targeted defects above,
missing-step coverage no longer rests on the judges.
`test/workflow-required-steps.test.ts` checks that every step and phase heading
of the judged workflow skills (qa, qa-only, review, ship, plan-ceo-review,
plan-eng-review, setup-deploy) is still in the generated SKILL.md or section
file, in order, and names the missing step when one is removed (the two control
defects above are its negative cases). The pinned list,
`test/fixtures/workflow-required-steps.json`, was derived from the templates'
step headings; a new step heading must be added to it. The judges keep scoring
clarity, completeness and actionability; the rubric revision stays a proposal
for Garry (TODOS.md).
