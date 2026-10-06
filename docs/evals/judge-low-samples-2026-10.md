# Workflow-judge low samples, October 2026 (C2)

Source: the `skill-llm-eval` shards of the eight wave censuses (37174266054 …
37198445662), 24 judges each. A panel mean below 4 on a dimension means at least one
of its three samples scored below 4. Workflow judges gate on actionability ≥ 4
(clarity and completeness ≥ 3), so a single actionability 3 fails the panel.

## Panels with a low dimension (count of 8 censuses)

| Judge | Low dimension(s) | Censuses | Panel failed |
|---|---|---|---|
| setup block | completeness, actionability | 8/8 | never |
| qa health rubric | completeness | 8/8 | never |
| qa anti-refusal | `would_browse` reported as 1 (boolean field, not a low score) | 8/8 | never |
| qa workflow | clarity, actionability | 8/8 | 37186854666 |
| benchmark perf collection | completeness | 8/8 | never |
| plan-eng-review sections | clarity | 6/8 | never |
| canary monitoring loop | completeness | 6/8 | never |
| sync-gbrain read-only readiness | completeness | 6/8 | never |
| plan-ceo-review modes | clarity | 5/8 | never |
| qa-only workflow | clarity, actionability | 5/8 | 37198445662 |
| design-review fix loop | completeness | 4/8 | never |
| review workflow | clarity, actionability | 4/8 | 37193478719 |
| ship workflow | clarity | 3/8 | never |
| setup-deploy platform setup | actionability, completeness | 2/8 | 37176837432 |
| plan-design-review passes | completeness | 1/8 | never |

## Failing panels: each low rationale and its disposition

| Panel | Rationale (abridged) | Disposition |
|---|---|---|
| setup-deploy, 37176837432 | `[ -f vercel.json ] \|\| [ -d .vercel ] && echo` precedence bug; default branch never resolved; Fly deploy trigger undefined | Fixed on main before this wave (braced detection, `gh repo view --json defaultBranchRef`); the precedence claim was also wrong for that form |
| qa workflow, 37186854666 | undefined `{user}` in the outcome filename | **Fixed (C2):** `/qa` names the sources of `{user}`, `{branch}`, `{datetime}` |
| qa workflow, 37186854666 | `PROBE_DIR` "chosen above" only implied; EARLIER_UTC format unspecified; `/devex-review` path never given | Requested from the resolver owner (`scripts/resolvers/qa.ts`) |
| qa workflow, 37186854666 | prose density, two "Phases 1-6" numbering schemes | Density only; recorded |
| review workflow, 37193478719 | `unverified` Codex mode had competing run/skip rules | Fixed on main before this wave (`ready` and `unverified` run them) |
| review workflow, 37193478719 | "Post-expiry smoke rechecks are not-run" vs rerunning affected probes after fixes | Requested from the resolver owner (`scripts/resolvers/qa.ts`) |
| review workflow, 37193478719 | GATE: MISSING COVERAGE says "preserve the existing user decision flow", which is undefined | Requested from the resolver owner (`scripts/resolvers/outside-voice-steps.ts`) |
| review workflow, 37193478719 | plan-completion HIGH-impact gate has no spawned/non-interactive default | Requested from the resolver owner (plan-completion resolver) |
| qa-only workflow, 37198445662 | report templates ask for "Duration / durationMs totals" while `reporting.md` defines Probe budget and Guarded command time | **Fixed (C2):** both QA report templates name the defined fields |
| qa-only workflow, 37198445662 and the C2 panel | Browser Quick allots 30 s (`SECONDS=30`) for homepage plus five pages with a checkpoint Write per probe | Requested from the resolver owner (`scripts/resolvers/qa.ts:76`); recurs in two of the last three qa-only panels |
| qa-only workflow, 37198445662 | exploratory §2 "write the report, not a checkpoint" vs annotations/materialize first; "JSON keeps full values" names no JSON | Requested from the resolver owners (`qa.ts`, `test-value.ts`) |

Judges whose low samples never failed a panel carry density or out-of-bundle
complaints (for example completeness 3 on the qa health rubric, which is judged
without the workflow it serves). They are recorded, not chased.

## Panels after the C2 fixes (2026-10-04, one 3-sample panel per changed judge)

| Judge | Mean (clarity / completeness / actionability) | Verdict |
|---|---|---|
| qa workflow | 3.67 / 4.67 / 4.00 | pass |
| qa health rubric | 4.00 / 3.00 / 4.00 | pass |
| qa anti-refusal | would_browse true, confidence 5 | pass |
| qa-only workflow | 3.67 / 4.33 / 3.67 | **fail**: one sample cites the 30 s Browser Quick budget (resolver request above) |
| review workflow | 4.00 / 4.00 / 4.00 | pass |
| ship workflow | 4.00 / 4.00 / 4.00 | pass |
| plan-ceo-review modes | 3.67 / 4.67 / 4.00 | pass |
| cross-skill greptile consistency | 4 | pass |
| voice directive tone | all ≥ 4.33 | pass |

The timing-field and `{user}` rationales no longer appear in these panels. After the
ship and review wording was tightened to fit their parity size caps, the judges those
files select ran once more on the final wording: review workflow 4.00 / 4.00 / 4.00,
ship workflow 4.00 / 4.00 / 4.00, cross-skill consistency 4, voice directive tone ≥ 4.00
(all pass).
