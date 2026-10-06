# E2E detector inventory: phrase checks and structured sources

This inventory lists every pass/fail decision in the gate and periodic E2E cases (`E2E_TIERS` in test/helpers/touchfiles-data.ts, plus the three standalone periodic AUQ files) that rests only on phrases or regexes in model free text, at HEAD `cbcccf9`. It has 153 phrase-check rows: 13 are already structured-first (a), 38 are convert candidates (b), 79 need a phrase witness because the contract is user-visible (c), and 23 have no structured source (d); 13 more rows are LLM judges. Shared detectors (S1-S10, F1-F3, A1) are counted once, even though up to nine cases use each. Of the five B1 cases, only auto-decide-preserved has a structured record that can decide its outcome; the other four already read their records first or test text the user sees, so B1 replay corpora protect their phrase checks.

Dispositions:

- **(a) already structured-first.** The check reads a structured record first and falls back to phrases only when the record is absent.
- **(b) convert candidate.** A structured record of the same fact exists in this run, and the contract is not user-visible text.
- **(c) phrase witness required.** The contract is what the user sees (a question shown, a report or message rendered). A record may locate the text but cannot replace it. Numeric format regexes on a shown question, such as `Completeness: N/10`, are (c).
- **(d) no structured source.** An internal fact that nothing in the run records.
- **judge.** An LLM judge. It is listed but is not a phrase check.

"Journal" means the hermetic Claude session JSONL that test/helpers/plan-count-transcript.ts reads. "Surface" means `fullSurface`/`fullOutputSurface`, which includes Skill-injected SKILL.md bodies.

## Shared detectors

| ID | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| S1 | test/helpers/pty/screen.ts:399 via test/helpers/pty/classify.ts:490 | screen `❯ 1.` option list → `asked` | AskUserQuestion tool_use in the journal locates it | yes (a question shown) | (c) |
| S2 | test/helpers/pty/classify.ts:45 via :505 | lettered/numbered prose options, `Recommendation:`, `(recommended)` → `asked` | none when AUQ is disallowed | yes | (c) |
| S3 | test/helpers/pty/screen.ts:186 via test/helpers/pty/classify.ts:467 | "ready to execute" / exit-plan panel → `plan_ready` | ExitPlanMode tool_use in the journal | no | (b) |
| S4 | test/helpers/pty/classify.ts:425 | screen `⏺ Write(path)` outside sanctioned dirs → `silent_write`; plan write before first AUQ → `wrote_findings_before_asking` | Write/Edit tool_use (file_path, order) in the journal | no | (b) |
| S5 | test/helpers/pty/screen.ts:205 via test/helpers/pty/classify.ts:460 | `(auto-decided from plan-tune preference)` → `auto_decided`; runs before the structured path at test/helpers/pty/runners/observation.ts:389 | `gstack-ceo-mode-handoff --auto` (plan-ceo-review/SKILL.md.tmpl:410), question-log `auto_decided:true` (:416; scripts/resolvers/question-tuning.ts:38), read by test/helpers/native-auto-decide.ts:412 | yes (the chat must begin with the handoff line, plan-ceo-review/SKILL.md.tmpl:410); the record can locate it, the transcript line stays the witness | (b) |
| S6 | test/helpers/pty/runners/observation.ts:410-416 | Haiku `waiting` verdict → `asked` | — | — | judge |
| S7 | test/helpers/pty/plan-native.ts:36 via :605 | plan file `^## GSTACK REVIEW REPORT$` with no later `## ` heading | none (rendered plan file) | yes | (c) |
| S8 | test/helpers/plan-mode-evidence.ts:72 → test/helpers/pty/screen.ts:279 | plan file has `## Decisions` on `plan_ready` → fail | none | yes | (c) |
| S9 | test/helpers/pty/classify.ts:148 | squished screen "what should I (design-)review" + "current branch diff" | AUQ tool_use locates it when native AUQ is allowed | yes | (c) |
| S10 | test/helpers/pty/classify.ts:166, test/helpers/plan-scope-selection.ts:54-110, test/helpers/pty/runners/observation.ts:483 | scope-gate auto-select announcement, first-line target wording, seed token on screen | none (no scope-selection record; the seed token is in the pasted seed) | no | (d) |
| F1 | test/helpers/pty/runners/floor.ts:474 → test/helpers/plan-floor-review.ts:217 | staged question judged a `finding` (only pass) | — | — | judge |
| F2 | test/helpers/pty/runners/floor.ts:451 | prose candidate only if viewport and last assistant message both show prose options; native call read first | native AUQ call (structured first) | yes | (a) |
| F3 | test/helpers/pty/runners/floor.ts:497 | screen Write render / plan-ready text → fail | Write/ExitPlanMode tool_use in run.transcript | no | (b) |
| A1 | test/helpers/auq-sdk-capture.ts:30-43 `scoreAuqFormat` | question has ELI10:, Recommendation:, Pros / cons, ✅, ❌, Net:, (recommended) | AUQ tool input (its prose is the contract) | yes | (c) |

Cases that use S1-S8: plan-ceo-review-plan-mode, plan-devex-review-plan-mode, plan-mode-no-op, office-hours-auto-mode (gate); auto-decide-preserved, plan-eng-review-plan-mode, plan-design-review-plan-mode-smoke (periodic). S9-S10: plan-mode-no-op, plan-eng-review-plan-mode, plan-design-review-plan-mode-smoke. F1-F3: plan-ceo-finding-floor, plan-devex-finding-floor (gate); plan-design-finding-floor, plan-eng-finding-floor (periodic). A1: auq-format-gate (gate); the three standalone AUQ files (periodic).

## Gate tier

### test/skill-e2e-plan-mode-no-op.test.ts, test/skill-e2e-plan-ceo-plan-mode.test.ts, test/skill-e2e-plan-devex-plan-mode.test.ts, test/skill-e2e-office-hours-auto-mode.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| plan-mode-no-op | test/skill-e2e-plan-mode-no-op.test.ts:114, :175 | screen lacks the plan-mode reminder sentence | none | yes (leaked text) | (c) |
| plan-mode-no-op | test/skill-e2e-plan-mode-no-op.test.ts:186 | screen contains seed token `ZephyrLedgerWidget` | none; the token is in the pasted seed | no | (d) |
| office-hours-auto-mode | test/skill-e2e-office-hours-auto-mode.test.ts:41 | S5 `auto_decided` fails the case | question-log row | no | (b) |

The plan-ceo-review-plan-mode (:89, :108), plan-devex-review-plan-mode (:181-222) and office-hours-auto-mode (:54) verdicts are otherwise S1-S8.

### test/skill-e2e-plan-devex-finding-floor.test.ts, test/skill-e2e-plan-design-with-ui.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| plan-devex-finding-floor | test/helpers/plan-floor-review.ts:278-280 `pickPlanFloorProductType` | product-type brief `^Is this…?$` and one exact "Project/branch/task" context; no match leaves the menu unanswered (stall) | AUQ header `Product type` + option labels (already parsed :268-281) | no (selector) | (b) |
| plan-design-with-ui-scope | test/skill-e2e-plan-design-with-ui.test.ts:34-36 | design-focus question prose "I've rated this plan N/10…" or "all 7 … focus … design?" | AUQ header/options of the answered native call | no (boundary id) | (b) |
| plan-design-with-ui-scope | test/skill-e2e-plan-design-with-ui.test.ts:44-57 | review-finding identity from option labels or UI vocabulary | option labels (structured), no design-finding record | no | (b) |
| plan-design-with-ui-scope | test/helpers/plan-review-board-feedback.ts:111-120, :127-138 | outside-voices question lead regex; one `/boards/` URL in prose; mismatch throws | header `Voices` + exact option labels (compared :115-116) | no (actor) | (b) |
| plan-design-with-ui-scope | test/skill-e2e-plan-design-with-ui.test.ts:80-81 | screen prompt `/boards/` without a native call throws | native-call absence decides | no | (a) |
| plan-design-with-ui-scope | test/helpers/pty/classify.ts:555 `COMPLETION_SUMMARY_RE` via test/helpers/pty/runners/counting.ts:554 | screen report/summary/`VERDICT:` text ends collection before the ceiling | review-log row / ExitPlanMode tool_use | no | (b) |

### test/skill-e2e-ask-user-question-format-compliance.test.ts, test/skill-e2e-plan-tune.test.ts, test/skill-e2e-plan.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| auq-format-gate | test/skill-e2e-ask-user-question-format-compliance.test.ts:58 | question ~ `options differ in kind` | AUQ tool input | yes | (c) |
| auq-format-gate | test/skill-e2e-ask-user-question-format-compliance.test.ts:61, :68 | recommendation substance ≥ 4 | — | — | judge |
| plan-tune-inspect | test/skill-e2e-plan-tune.test.ts:167-169, :185 | output names ≥2 of 3 seeded question IDs or aliases | question-log is seeded fixture input | yes (inspection report) | (c) |
| plan-review-report | test/skill-e2e-plan.test.ts:463-491 | plan.md `## GSTACK REVIEW REPORT`, CEO/Eng/Design rows, ends with `NO UNRESOLVED DECISIONS` or a bullet | rows come from the seeded review log; the table is rendered | yes | (c) |

### test/skill-e2e-design.test.ts (gate cases)

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| plan-design-review-no-ui-scope | test/skill-e2e-design.test.ts:561-565, :572 | output contains no ui/no frontend/no design/not applicable/backend | none (early exit writes no record) | no | (d) |
| design-review-plugin-handoff | test/skill-e2e-design.test.ts:1012, :1020-1023 | detector-output.md has `IMPECCABLE_READY`, FINDING-001, rule ids, `deferred`, per-handoff `/impeccable x` | probe/scan tool output (checked :994, :1010-1011) | yes (report) | (c) |
| design-review-detector-shim | test/skill-e2e-design.test.ts:1158 | tool outputs or report include `IMPECCABLE_READY` | probe tool output read first | yes | (a) |
| design-review-detector-shim | test/skill-e2e-design.test.ts:1159-1161 | report contains FINDING-001, [ai-color-palette], [low-contrast] | calls.jsonl receipts + engine log (:1132-1154) | yes | (c) |
| design-review-detector-shim-dom | test/skill-e2e-design.test.ts:1254-1255 | report contains [ai-color-palette], "static scan of the rendered DOM" | DOM dump + Bash trace (:1247-1252) | yes | (c) |

### test/skill-e2e-coverage-audit.test.ts, test/skill-e2e-workflow.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| review-coverage-audit, plan-eng-coverage-audit | test/helpers/coverage-audit-evidence.ts:546-547 | last JSON `{"tested","untested"}` line first; ASCII-diagram grammar fallback (:459-510) | prompt-requested JSON summary | no | (a) |
| ship-coverage-audit | test/helpers/coverage-audit.ts:34-38 | diagram has gap/no test, tested/✓/★, coverage, both function names | none (the diagram is the requested output) | yes | (c) |
| document-release | test/skill-e2e-workflow.test.ts:101-102, :109 | CHANGELOG keeps old entries; current entry and README mention "feature c" | none (docs are the product) | yes | (c) |

### test/skill-e2e-shared-libs.test.ts, test/skill-e2e-shared-libs-paths.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| shared-libs-read-only | test/skill-e2e-shared-libs.test.ts:113-120 | report ~ uncommitted/overlay/raw, tip and branch SHAs, retry-worker/route, no blob link for branch-only file | none (read-only by contract) | yes | (c) |
| shared-libs-unsupported-git | test/skill-e2e-shared-libs.test.ts:136, :144 | report ~ unavailable/unsupported/limited; not "no commits/PRs found" | none | yes | (c) |
| shared-libs-review-path-eligibility | test/skill-e2e-shared-libs-paths.test.ts:133-134 | `trace + output` ~ submodule/160000, check-ignore/ignored (output alone satisfies) | Bash command trace (first operand) | no | (b) |

### test/skill-e2e-ship-docsync.test.ts, test/skill-e2e-docsync-spawned.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| ship-docsync-store | test/skill-e2e-ship-docsync.test.ts:74, :78 | ship report ~ `Documentation…blocked`; not `Documentation: current` | no receipt, no publish call (:75-77) | yes (report status) | (c) |
| ship-docsync-completion, ship-docsync-current | test/skill-e2e-ship-docsync.test.ts:81, :97 | parsed docs contract, then report contains `contract.documentation_section` | docs dispatch JSON (ship/sections/documentation.md.tmpl:52-56) | yes | (a) |
| ship-docsync-late-result, -missing-marker, -missing-asset, -launch-failure, -timeout-unsettled, -failure | test/helpers/docsync-fault-eval.ts:28, :30 | non-success report ~ `Documentation…blocked`, no `Documentation: current` outside inline code | actor event log decides dispatch count and publication first (:22-27) | yes | (c) |
| ship-docsync-recovery, -stale-before, -stale-after | test/helpers/docsync-fault-eval.ts:31 | report contains the accepted audit id | actor state `acceptedId` | yes | (a) |
| docsync-spawned | test/skill-e2e-docsync-spawned.test.ts:60 | `contract.blockers` ~ security/sensitive | parsed docs contract | no | (a) |

### test/helpers/ship-hook-actor.ts (ship-hook-consent, ship-hook-refresh files)

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| ship-managed-hook-refresh | test/helpers/ship-hook-actor.ts:122 | final ~ refresh/updat/install/current | installer receipt (checked :113-121) | yes (outcome told to user) | (c) |
| ship-unmanaged-hook-consent | test/helpers/ship-hook-actor.ts:129 | final ~ declin/unchanged/not install/preserv/leave | declined interaction record (:127) | yes | (c) |
| ship-local-hook-preservation | test/helpers/ship-hook-actor.ts:133 | final ~ /manual/ | none | yes | (c) |

### test/skill-e2e-review.test.ts, test/skill-e2e-review-attribution.test.ts, test/skill-e2e-review-army.test.ts (gate cases)

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| review-sql-injection | test/skill-e2e-review.test.ts:87-95 | review-output.md includes sql/injection/sanitiz/parameteriz/… | none: the fixture copies only the checklist, so no review-log row (review/SKILL.md.tmpl:402) | partly | (d) |
| review-enum-completeness | test/skill-e2e-review.test.ts:173-177 | review mentions "returned" and enum/status/critical | none (focused checklist run) | partly | (d) |
| ship-base-branch | test/skill-e2e-review-attribution.test.ts:144 | ship-preflight.md ~ /main\|base/ | git commands in the Bash trace (review-base-branch uses this, :87) | no | (b) |
| review-dashboard-via | test/skill-e2e-review-attribution.test.ts:273, :275 | output + dashboard ~ autoplan, clear | review log is seeded input; dashboard is rendered | yes | (c) |
| review-army-migration-safety | test/skill-e2e-review-army.test.ts:136-142 | output includes drop/data loss/reversib/migration/column | none (single-shot) | partly | (d) |
| review-army-perf-n-plus-one | test/skill-e2e-review-army.test.ts:272-280 | output includes n+1/eager/includes/preload/query/loop | specialist JSON findings in Agent results (review/sections/review-army.md); not verified per finding | no | (b) |
| review-army-delivery-audit | test/skill-e2e-review-army.test.ts:395-404 | output includes not done/missing and email/notification | none verified | partly | (d) |
| review-army-quality-score | test/skill-e2e-review-army.test.ts:494-496 | `SPECIALIST REVIEW: 1 findings (1 critical, 0 informational)`, `PR Quality Score: 8/10`, `[ADVISORY]` | merged-review.json (checked :485-493) | yes (rendered format) | (c) |

### test/skill-e2e-bws.test.ts, test/skill-e2e-session-intelligence.test.ts, test/skill-e2e-learnings.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| skillmd-no-local-binary | test/skill-e2e-bws.test.ts:156 | result.output ~ READY/NEEDS_SETUP | setup-block Bash tool_result prints `READY: $B`/`NEEDS_SETUP` (browse/SKILL.md:214) | no | (b) |
| skillmd-outside-git | test/skill-e2e-bws.test.ts:194 | same | same | no | (b) |
| context-recovery-artifacts | test/skill-e2e-session-intelligence.test.ts:181-183, :195 | output contains any of recent artifacts/ceo-plans/last_session/ship/timeline/completed (near-vacuous) | bin/gstack-context-recovery:31, :37 prints the record, but the fixture does not copy it (:46-48) | no | (d) (b once the bin is copied) |
| context-save-writes-file | test/skill-e2e-session-intelligence.test.ts:257, :266 | checkpoint includes `---` and `status:` | the file's YAML frontmatter (parseable) | no | (b) |
| context-restore-loads-latest | test/skill-e2e-session-intelligence.test.ts:379-393, :401-402 | `RESTORED: <newer>` or newer-body phrase; Read of the newer file as fallback | Read tool_use | partly | (c) |
| learnings-show | test/skill-e2e-learnings.test.ts:117-119, :131 | output mentions ≥2 of n-plus-one, stale/cache, rubocop | `gstack-learnings-search` Bash result (fixture copies it, test/skill-e2e-learnings.test.ts:43) | yes (/learn shows them) | (c) |

### test/skill-e2e-qa-functional*.test.ts, test/skill-e2e-skillify.test.ts, test/skill-e2e-deploy.test.ts, test/skill-e2e-cso.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| qa-functional-cli-report, -webhook-report, -cli-fix, -webhook-fix | test/helpers/qa-checkpoint-evidence.ts:207-209 | report.md links each `exploration-NNN.json` checkpoint | checkpoint files + gstack-qa-evidence receipts; the link is rendered | yes | (c) |
| same 4 | test/helpers/qa-functional-evidence.ts:179-180 | private sentinel absent from output, report and evidence | n/a (leak canary) | yes | (c) |
| skillify-happy-path | test/skill-e2e-skillify.test.ts:379 → test/helpers/skill-body-narration.ts:7 | committed SKILL.md has no `I `/`I'll`/`Let me` narration | none (generated skill text is the artifact) | yes | (c) |
| skillify-provenance-refusal | test/skill-e2e-skillify.test.ts:429, :467 | surface ~ unknown skill/not registered (load tripwire) | Skill tool_use + its error tool_result | no | (b) |
| skillify-provenance-refusal | test/skill-e2e-skillify.test.ts:444, :468 | assistant ~ "no recent scrape result" / "run /scrape first" | none | yes (refusal, skillify/SKILL.md.tmpl:67) | (c) |
| land-and-deploy-workflow | test/skill-e2e-deploy.test.ts:81 | deploy reports + CLAUDE.md ~ /fly/ | Bash result `PLATFORM:fly` (land-and-deploy/sections/first-run-validation.md:35); not verified this flow runs it | no | (b) |
| land-and-deploy-workflow | test/skill-e2e-deploy.test.ts:82 | artifacts contain `test-app` | none | no | (d) |
| land-and-deploy-first-run | test/skill-e2e-deploy.test.ts:150-151 | report contains fly or first-run-app | Bash result `PLATFORM:fly` (this case runs Step 1.5) | no | (b) |
| land-and-deploy-review-gate | test/skill-e2e-deploy.test.ts:221-222 | readiness report ~ review and not run/no reviews/missing | none (gstack-review-read not installed) | yes | (c) |
| setup-deploy-workflow | test/skill-e2e-deploy.test.ts:408-410 | CLAUDE.md contains fly, my-cool-app, Deploy Configuration | the `## Deploy Configuration` key/value block (setup-deploy/SKILL.md.tmpl:183-190) | no (machine-read) | (b) |
| cso-diff-mode | test/skill-e2e-cso.test.ts:181 | webhook.js finding prose ~ signature/authenticat/forg | report.json has no class/CWE field (lib/cso/contracts.ts:65-80) | no | (d) |
| cso-diff-mode (and the periodic CSO cases) | test/skill-e2e-cso.test.ts:61, :86, :133-134 | CANARY token absent from output, transcript and reports | n/a (leak canary) | yes | (c) |

### test/skill-e2e-third-party-actions.test.ts

The consent question is plain text by design (Read and Bash only). The probe's Bash result (`READY:`/`NEEDS_ASIDE: <os>`/`ASIDE_NOT_RUNNING`, ship/SKILL.md:395-409) records detection, not what was offered.

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| tpa-present | test/skill-e2e-third-party-actions.test.ts:197-203 | Aside, `A)`, defer, dashboard host; no download pitch (regex :41) | probe `READY:` | yes | (c) |
| tpa-absent-linux | test/skill-e2e-third-party-actions.test.ts:218-226; test/helpers/third-party-actions.ts:6, :23 | no pitch, no Aside-drive option, manual + headed-drive options | probe `NEEDS_ASIDE: Linux` | yes | (c) |
| tpa-broken | test/skill-e2e-third-party-actions.test.ts:244, :249-252 | no drive option; "open the Aside app" or a lettered question | probe `ASIDE_NOT_RUNNING` | yes | (c) |
| tpa-absent-darwin | test/skill-e2e-third-party-actions.test.ts:272-274 | pitch sentence, `macOS 15`, no drive options | probe `NEEDS_ASIDE: Darwin` | yes | (c) |
| tpa-apple-ban | test/skill-e2e-third-party-actions.test.ts:307-311 | no drive option for account.apple.com; app-specific password guidance | none | yes | (c) |

### test/helpers/workflow-boundaries-fixture.ts (investigate-owned files), test/skill-e2e-safety-pair-agent.test.ts, test/skill-e2e-safety-ship-evidence.test.ts

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| investigate-owned-completion, -abort, -ending-error | test/helpers/workflow-boundaries-fixture.ts:156-160 | scripted actor: option label ~ abort/stop/cancel or continue/proceed, else unsupported | AUQ input (labels are prose) | yes | (c) |
| investigate-owned-abort | test/helpers/workflow-boundaries-fixture.ts:194 | final ~ abort/stop/cancel | receipts (:186-193) | yes | (c) |
| investigate-owned-ending-error | test/helpers/workflow-boundaries-fixture.ts:209 | final ~ error/unavailable/cannot/unable | receipt `VERIFY_STATUS:69` (:208) | yes | (c) |
| safety-pair-agent-block | test/skill-e2e-safety-pair-agent.test.ts:86, :91 | final contains the instruction block byte-for-byte | block is in the fake tool result; relaying it is the contract | yes | (c) |
| safety-ship-stale-evidence | test/skill-e2e-safety-ship-evidence.test.ts:133 `callJudge` | — | — | — | judge |

Gate cases with no phrase-only checks: the shared-libs review-lifecycle, revalidation, index-flags and prior-coverage cases (review-log rows and traces); ship-skipped-queued-finding; the five qa-callers cases; ship-section-loading; ship-triage (test/helpers/ship-triage-labels.ts:12 parses JSON first, so (a)); ship-coverage-value, review-test-value, test-audit-report-only (JSON records; regexes only select items, so (a)); review-army-json-findings; ship-local-workflow; gstack-upgrade-happy-path; qa-quick; qa-only-no-fix; qa-bootstrap; browse-basic; browse-snapshot; skillmd-setup-discovery; operational-learning; skillify-approval-reject; canary-workflow; benchmark-workflow; retro-base-branch; timeline-event-flow; hermetic-canary; hermetic-sentinel; diagram-triplet; safety-codex-consult-embed.

## Periodic tier

### B1 cases

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| auto-decide-preserved | test/skill-e2e-auto-decide-preserved.test.ts:173 (S5) | screen auto-decided annotation passes | handoff `--auto` + question-log, read only when the screen is unclassified | yes (handoff line) | (b) |
| auto-decide-preserved | test/skill-e2e-auto-decide-preserved.test.ts:159 (S1/S2) | a shown option list fails | prose question only (AUQ disallowed) | yes | (c) |
| plan-ceo-section-loading | test/helpers/ceo-stale-fill-decision.ts:54 ‖ test/helpers/ceo-section-loading-fixture.ts:688 (called test/skill-e2e-plan-ceo-review-section-loading.test.ts:118) | approved ledger row + `currentDecision` naming fill/write/race; else structured-then-prose finding | decision ledger and `currentDecision` blocks in PLAN.md | no | (a) |
| plan-ceo-section-loading | test/helpers/auq-sdk-capture.ts:399-420 (called :101) | `COMPLETION SUMMARY` with Section 1-11 outcome rows | none per section | yes | (c) |
| plan-ceo-section-loading | test/skill-e2e-plan-ceo-review-section-loading.test.ts:74, :110-111 | `## GSTACK REVIEW REPORT`, review table header, `\| CEO Review \|` row | rendered dashboard | yes | (c) |
| plan-ceo-section-loading | test/helpers/auq-sdk-capture.ts:213 (called :113) | report row `Outside Review` status starts `disabled` | none in this native-only run | yes | (c) |
| shared-libs-plan-callers | test/helpers/shared-libs-plan-actor.ts:28-112 (phrase refusals :63, :67, :72, :75, :85, :109) | scripted actor parses question prose: reuse verbs, `lib/retry-after.ts`, contract wording, 9 scope-expansion regexes; a match fails the case | AUQ input; option text is the only carrier of what is offered | yes (question content) | (c) |
| shared-libs-plan-callers | test/skill-e2e-shared-libs-periodic.test.ts:198 | — | — | — | judge |
| plan-design-review-plan-mode | test/skill-e2e-design.test.ts:489, :497, :508 | output ~ `\d+/10` | review-log `initial_score`/`overall_score` (plan-design-review/sections/review-sections.md.tmpl:229); not verified in fixture | yes | (c) |
| plan-design-review-plan-mode | test/skill-e2e-design.test.ts:496-497, :508 | output or rated plan growth has information architecture/interaction state/ai slop/hierarchy | none (review-log has scores and counts only) | no | (d) |
| plan-design-review-plan-mode | test/skill-e2e-design.test.ts:499-504, :511 | plan.md contains empty/loading/error/state/responsive/accessibility | none | no | (d) |
| ship-docsync-late-result | gate tier; listed in the ship-docsync table | — | — | — | see gate |

### Plan reviews: test/skill-e2e-plan-ceo-mode-routing.test.ts, test/skill-e2e-plan-eng-*.test.ts, test/skill-e2e-plan-design-*.test.ts, carve-section-loading

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| plan-ceo-mode-routing | test/helpers/ceo-mode-option.ts:661-670 (called test/skill-e2e-plan-ceo-mode-routing.test.ts:248) | posture regex on the handoff tool-result line first, then post-answer prose | `gstack-ceo-mode-handoff` tool result (plan-ceo-review/SKILL.md.tmpl:410) | no | (a) |
| plan-ceo-mode-routing | test/skill-e2e-plan-ceo-mode-routing.test.ts:257 | HOLD posture review | — | — | judge |
| plan-ceo-mode-routing | test/helpers/pty/classify.ts:341 `MODE_RE` | option label starts with a mode name → mode question found | native AUQ options | yes | (c) |
| plan-design-finding-floor | test/helpers/pty/boundaries.ts:653-658 `pickDesignFocusAll` | Step-0D title, "Project/branch/task" and ELI10 rating prose; no match stalls | AUQ header + option labels (parsed :659-661) | no (selector) | (b) |
| plan-eng-multi-finding-batching | test/helpers/pty/boundaries.ts:62-116, :587-600, :626-640 | setup vs review question decided by prose ("This plan introduces N new classes", "Issue", scope-reduction) | decision ledger R records (plan-eng-review/sections/review-sections.md.tmpl:213-235); qid branches inert under `QUESTION_TUNING=false` | no | (b) |
| plan-eng-multi-finding-batching | test/helpers/eng-seeded-coverage.ts:33-104 | distinct-issue identity per answered AUQ ("Issue N:", D/R-ID, ELI10 gates) | ledger R records, used only as fallback behind the prose gates | no | (b) |
| plan-eng-multi-finding-batching | test/helpers/pty/classify.ts:555 via counting.ts:554 | screen completion text ends counting | review-log row / ExitPlanMode tool_use | no | (b) |
| plan-eng-review-artifact | test/skill-e2e-plan-eng-artifact.test.ts:78 | test-plan artifact ~ dashboard/fetchStats/`/api/stats` | artifact schema has no field naming the change (scripts/resolvers/testing.ts:501-528) | no | (d) |
| carve-section-loading [plan-eng-review] | test/helpers/carve-section-case.ts:120 → test/helpers/auq-sdk-capture.ts:381 | report or output ~ report/review/summary/design doc/handoff | review-log row in the capture state root, deleted before the verdict (auq-sdk-capture.ts:368-370) | no | (b) |
| carve-section-loading [12 other skills] | same | same loose regex | none (Bash not allowed, auq-sdk-capture.ts:358-359) | no | (d) |

The plan-eng-review-plan-mode and plan-design-review-plan-mode-smoke verdicts are S1-S10. plan-eng-finding-floor and plan-design-finding-floor verdicts are F1-F3.

### Question format: test/skill-e2e-plan-format.test.ts, test/skill-e2e-plan-prosons.test.ts, standalone AUQ files

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| plan-ceo-review-format-mode, plan-eng-review-format-kind | test/skill-e2e-plan-format.test.ts:174-175, :377-378 | no `Completeness: N/10`; kind note present | captured question | yes | (c) |
| plan-ceo-review-format-approach, plan-eng-review-format-coverage | test/skill-e2e-plan-format.test.ts:241, :310 | `Completeness: N/10` present | captured question | yes | (c) |
| all four format cases | test/skill-e2e-plan-format.test.ts:177, :243, :312, :380 | recommendation quality | — | — | judge |
| plan-review-prosons-format | test/skill-e2e-plan-prosons.test.ts:184-196 | `D\d+ —`, ELI10:, Stakes…:, Recommendation:, Pros / cons:, ^Net:, ✅≥4, ❌≥2, (recommended) | captured question | yes | (c) |
| plan-review-prosons-hardstop-neg | test/skill-e2e-plan-prosons.test.ts:246-249 | no hard-stop escape line; ✅/❌ counts | captured question | yes | (c) |
| plan-review-prosons-neutral-neg | test/skill-e2e-plan-prosons.test.ts:299-303 | no `taste call`; (recommended); `Recommendation:.*because` | captured question | yes | (c) |
| plan-ceo-review-prosons-cadence | test/skill-e2e-plan-prosons.test.ts:353-358 | Pros / cons header; hard-stop escape or pros+cons | captured question | yes | (c) |
| test/skill-e2e-auq-matrix.test.ts | test/helpers/auq-sdk-capture.ts:54-59 (called :166) | `Recommendation:` line; exactly one `(recommended)` label | AUQ options (the suffix the AUTO_DECIDE hook parses) | yes | (c) |
| test/skill-e2e-auq-consistency.test.ts | test/skill-e2e-auq-consistency.test.ts:65, :87 | each A1 element present in every run | AUQ text | yes | (c) |
| test/skill-e2e-auq-verbose-vs-carved-ab.test.ts | test/skill-e2e-auq-verbose-vs-carved-ab.test.ts:43, :108 | carved format count ≥ verbose | AUQ text | yes | (c) |
| AUQ matrix, consistency, A/B | auq-matrix :148; consistency :69, :95-96; A/B :48, :109 | substance panels and tolerances | — | — | judge |
| plan-ceo-review-expansion-energy | test/skill-e2e-plan.test.ts:271-275 | posture | — | — | judge |

### Shared-libs, review army, codex review, design

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| shared-libs-opportunity-judgment | test/skill-e2e-shared-libs-periodic.test.ts:121-122 | report contains tip SHA and `lib/retry-after.ts` | none | yes | (c) |
| shared-libs-opportunity-judgment | test/skill-e2e-shared-libs-periodic.test.ts:123 | `JSON.stringify(transcript)` ~ inventory.py/search.py/negative inventory (includes assistant prose) | Read/Bash tool-call inputs | no | (b) |
| shared-libs-opportunity-judgment, shared-libs-pr-coverage | test/skill-e2e-shared-libs-periodic.test.ts:88, :125, :158 | — | — | — | judge |
| shared-libs-codex-read-only | test/codex-e2e-shared-libs.test.ts:123-129 | Codex report contains SHA, overlay wording, file names, savings, tests | none | yes | (c) |
| review-army-red-team | test/skill-e2e-review-army.test.ts:651 | output ~ red team/adversarial | Agent/Task dispatch description (perf case reads it, :256-258) | no | (b) |
| review-army-consensus | test/skill-e2e-review-army.test.ts:737-741 | output includes sql/injection/interpolat | specialist JSON findings in Agent results; not verified | no | (b) |
| review-army-simplification | test/skill-e2e-review-army.test.ts:806-815 | output includes native/stdlib/speculative/…; not "lean already. ship." | none | partly | (d) |
| review-army-simplification-precision | test/skill-e2e-review-army.test.ts:868-872 | no delete/shrink JSON finding on the self-check; `NO FINDINGS` sentinel | specialist JSON lines / sentinel | no | (a) |
| review-design-lite | test/skill-e2e-review.test.ts:285-306 | ≥4 of 7 keyword groups | none | partly | (d) |
| codex-review | test/skill-e2e-workflow.test.ts:478, :481 | executed verdict from Codex command output | lib/outside-review-result.ts | no | (a) |
| codex-review | test/skill-e2e-workflow.test.ts:482 | codex-output.md ~ `GATE: PASS\|FAIL (N critical\|UNVERIFIED`, not fail-closed | same verdict | yes (gate line) | (c) |
| design-consultation-core | test/skill-e2e-design.test.ts:160-161, :186, :190 | DESIGN.md has one synonym per 7 section sets; CLAUDE.md mentions design.md | none for content | yes | (c) |
| design-consultation-research | test/skill-e2e-design.test.ts:253, :263 | "Search unavailable" only when no WebSearch/aside call | WebSearch / aside tool calls read first (:243-245) | yes | (a) |
| design-consultation-existing | test/skill-e2e-design.test.ts:314-315, :334-335 | DESIGN.md includes color and spacing | format marker only | yes | (c) |
| design-review-fix | test/skill-e2e-design.test.ts:714, :742 | design-audit.md ~ 47/48px, line-height, radius, padding, spacing, heading | none | yes | (c) |
| design-html-slop-gate | test/skill-e2e-design.test.ts:1318-1319 | gate-output.md has ai-color-palette and accepted | scan call count only | yes | (c) |
| design-consultation-core, plan-decision-classification, plan-devex-peer-comparison-classification, diagram-authoring-quality | design :168; classification :150-153, :40-43; diagram :159-183 | — | — | — | judge |

### Context, scrape, CSO, health, Aside

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| context-save-then-restore-roundtrip | test/skill-e2e-context-skills.test.ts:221, :231 | surface has the magic title (vacuous: it is in the Skill input) | restore Read/Bash tool_result of the saved file | no | (b) |
| context-restore-fragment-match | test/skill-e2e-context-skills.test.ts:266-267, :277-278 | surface has the PAYMENTS marker, lacks ALPHA/OMEGA | Read/Bash tool_result content | no | (b) |
| context-restore-provenance-order | test/skill-e2e-context-skills.test.ts:321-327, :344 | "Next steps" before "Verify first" with tokens placed | none | yes (context-restore/SKILL.md.tmpl:217-221) | (c) |
| context-restore-provenance-order | test/skill-e2e-context-skills.test.ts:328, :335, :338, :345 | `FIRST_ACTION: verify PROV_ASSUMED_7Q` | none (AUQ disallowed) | no | (d) |
| context-restore-empty-state | test/skill-e2e-context-skills.test.ts:374, :385 | surface ~ no saved context/NO_CHECKPOINTS (vacuous: in the injected body) | Bash result `NO_CHECKPOINTS` (context-restore/SKILL.md.tmpl:84, :95) | partly | (b) |
| context-restore-list-delegates | test/skill-e2e-context-skills.test.ts:413, :423 | surface ~ `context-save list` (vacuous) | none | yes | (c) |
| context-restore-legacy-compat | test/skill-e2e-context-skills.test.ts:465-470, :480 | surface has marker/title/filename/branch or pre-rename | Read of the legacy file | no | (b) |
| context-save-list-current-branch | test/skill-e2e-context-skills.test.ts:517, :536 | surface ~ timestamp/main-work | Bash listing result | partly | (b) |
| context-save-list-current-branch | test/skill-e2e-context-skills.test.ts:525-526, :537-538 | final lacks other-branch entries | none (model-rendered list) | yes | (c) |
| context-save-list-all-branches | test/skill-e2e-context-skills.test.ts:572-576, :586 | surface has all 3 timestamps | Bash listing result | partly | (b) |
| scrape-prototype-path | test/skill-e2e-skillify.test.ts:283, :290-294, :304-305 | surface ~ /skillify/ and `"items": [` (both vacuous: in scrape/SKILL.md.tmpl:32, :173) | none | yes | (c) |
| cso-full-audit | test/skill-e2e-cso.test.ts:139-140 | server.js finding prose ~ tenant/owner/authoriz | no class field in report.json | no | (d) |
| cso-infra-scope | test/skill-e2e-cso.test.ts:227-229 | finding prose ~ comment body, run/shell, GITHUB_TOKEN | same | no | (d) |
| health-reporting | test/helpers/health-eval-fixture.ts:132-156 | rendered dashboard: composite 5.6, partial coverage, 0/10 typecheck, "60 errors", unavailable categories, no trend verdict, N/A composite | health-history.jsonl rows (already checked :158-176) | yes | (c) |
| aside-browse-basic, aside-qa-quick, aside-scrape-json | test/skill-e2e-aside.test.ts:179, :219, :234-239 | title in final message; `health score` in report; final JSON contains page1 | none verified | yes | (c) |
| aside-canary-quick | test/skill-e2e-aside.test.ts:256 | canary report ~ CANARY REPORT/Status: | `{date}-canary.json` (canary/SKILL.md.tmpl:221); not verified | no | (b) |
| qa-b6-static, qa-b7-spa, qa-b8-checkout | test/skill-e2e-qa-bugs.test.ts:158, :177-179 | — | — | — | judge |

### Office hours, gbrain, codex, outside voice, safety, benchmarks

| Case | Check (file:line) | Matches | Structured source | User-visible | Disposition |
|---|---|---|---|---|---|
| office-hours-phase4-fork | test/skill-e2e-office-hours-phase4.test.ts:190-191 | written question has `because` and ≥2 option lines | none (AUQ suppressed by the prompt, :128) | yes | (c) |
| office-hours-phase4-fork | test/skill-e2e-office-hours-phase4.test.ts:193 | approach/architecture vocabulary or Server/Client/Hybrid options | none; a native capture would make it structural | no | (d) |
| office-hours-phase4-fork | test/helpers/llm-judge.ts:496-516 (via test/helpers/e2e-helpers.ts:320-322) | deterministic `Recommendation:` + `because` part of judgeRecommendation | none | yes | (c) |
| office-hours-design-draft | test/helpers/office-hours-completion.ts:107-115 | design doc has substantive Problem/Approach/Success/"What I noticed" and Assignment sections | none | yes | (c) |
| setup-gbrain-bad-token | test/skill-e2e-setup-gbrain-bad-token.test.ts:60-61 | `JSON.stringify(result)` ~ error_class AUTH/rotate token (satisfied by the helper's own stdout) | verify JSON `error_class` (bin/gstack-gbrain-mcp-verify:64), already checked :65-67 | partly | (b) |
| setup-gbrain-remote | test/skill-e2e-setup-gbrain-remote.test.ts:326-328 | serialized transcript must not contain `"error_class": NETWORK/AUTH/MALFORMED` | verify JSON in the Bash result | no | (b) |
| setup-gbrain-remote | test/skill-e2e-setup-gbrain-remote.test.ts:352 | CLAUDE.md ~ `Mode: remote-http` | the persisted config block | yes | (c) |
| setup-gbrain-path4-local-pglite | test/skill-e2e-setup-gbrain-path4-local-pglite.test.ts:72-73; test/helpers/setup-gbrain-fixture.ts:122-169 | question ~ code search/pglite/symbol; scripted actor classifies option labels and throws on unknown sets | AUQ labels only, no option ids | yes | (c) |
| sync-gbrain-read-ready, sync-gbrain-read-unknown | test/helpers/sync-gbrain-readiness-verdict.ts:4-25 | Capability row OK/WARN, YELLOW verdict, no unnegated ready claim | bin/gstack-gbrain-read-capability.ts:87 status JSON (status only; row and verdict are rendered) | yes | (c) |
| codex-discover-skill | test/helpers/codex-eval.ts:43 | output ~ review/gstack/skill | none | partly | (d) |
| codex-review-findings | test/helpers/codex-eval.ts:66-67; lib/outside-review-result.ts:88 | output ~ finding/issue/…/no issues; refusal phrases → unavailable | executed commands read first; no review-log step in the fixture | partly | (d) |
| outside-voice-codex-to-claude-code, outside-voice-claude-code-to-codex | test/helpers/outside-voice-evidence.ts:214-216 | outside stdout ~ invoice and authorization defect; no refusal | dispatch and receipts are structural; the review-log row holds status only | no | (d) |
| outside-plan-disabled-no-fallback | test/helpers/disabled-plan-review-fixture.ts:322-325 | JSON `outside_review_this_run: disabled` first, then prose | review-log `outside_status:"disabled"` (scripts/resolvers/outside-voice-steps.ts:331) | yes | (a) |
| outside-plan-disabled-no-fallback | test/helpers/disabled-plan-review-fixture.ts:326-328 | no unattributed "both reviewers agree" claim | none | yes | (c) |
| safety-design-risk-stop | test/skill-e2e-safety-design-risk.test.ts:165 | final names each unfixed FINDING-00N | git log decides which remain; the listing has no record | yes | (c) |
| benchmark-providers-live | test/skill-e2e-benchmark-providers.test.ts:116, :136, :168 | provider output contains "ok" | none | yes | (c) |
| office-hours-forcing-energy, office-hours-builder-wildness, office-hours-phase4-fork, safety-design-risk-stop, llm-judge-recommendation, arm-benchmark-* | office-hours :102-107, :183-188; e2e-helpers.ts:323-326; design-risk :166-174; llm-judge-recommendation :42-163; arm-benchmark :121 (non-gating) | — | — | — | judge |

Periodic cases with no phrase-only checks: plan-ceo-review, plan-ceo-review-selective, plan-eng-review (exit reason and optional file length only); autoplan-dual-voice and autoplan-journal-drift (transcript evidence); the eleven journey-* routing cases (Skill tool input); context-save-routing; scrape-match-path; qa-fix-loop; retro; office-hours-brain-writeback; gbrain-roundtrip-local; safety-codex-boundary; safety-ios-demo; codex-sol-scope-termination; ios-qa-device; design-consultation-preview; the five overlay-harness cases (JSON parse plus deep-equal).

## Convert candidates

These are ordered by red history across the 8 wave censuses (periodic censuses 37174266054 through 37198445662), then by tier and how many cases one change covers.

1. **S5 screen-first auto-decision** (test/helpers/pty/classify.ts:460). auto-decide-preserved went red in 3 of 8 censuses, all `outcome=timeout`. Its replay corpus (test/fixtures/detector-corpora/auto-decide-preserved/) shows two were product failures (the model never sent the handoff line) and one an order false red that is already fixed, so no red came from the screen phrase itself. Letting the bound question-log record hand the decision to the native transcript check also covers office-hours-auto-mode and the plan-mode smokes, but two of the five recent passing captures cannot prove that path from their archived polls (the poll predates the handoff message), so the conversion needs a paid diagnostic run before it lands.
2. **shared-libs-opportunity-judgment transcript regex** (test/skill-e2e-shared-libs-periodic.test.ts:123). The case went red in 2 of 8, but both reds were judge failures, so this conversion removes a fragile check rather than a past red.
3. **S3/S4/F3 PTY terminals** (test/helpers/pty/classify.ts:425, :467; test/helpers/pty/runners/floor.ts:497). 0 reds. Derive `plan_ready` and `silent_write` from ExitPlanMode and Write tool_use in the journal the runner already reads. One change covers 4 gate and 5 periodic cases.
4. **Setup selectors that stall on wording** (test/helpers/plan-floor-review.ts:278-280, test/helpers/pty/boundaries.ts:653-658, test/helpers/plan-review-board-feedback.ts:111-120, test/skill-e2e-plan-design-with-ui.test.ts:34-57). 0 census reds, but PR-lane reds for plan-design-with-ui-scope (runs 37166586458, 37172907071). Identify the question by AUQ header and option labels.
5. **Gate READY probe** in skillmd-no-local-binary and skillmd-outside-git (test/skill-e2e-bws.test.ts:156, :194). Read the setup-block Bash result instead of the final message.
6. **Gate artifact and trace swaps**: context-save-writes-file (parse frontmatter), ship-base-branch (git trace), land-and-deploy-workflow and -first-run (`PLATFORM:` result), setup-deploy-workflow (config block), skillify-provenance-refusal load tripwire (Skill tool_result), shared-libs-review-path-eligibility (drop the `output` operand). Separately, context-recovery-artifacts needs `bin/gstack-context-recovery` copied into its fixture before it can convert.
7. **plan-eng-multi-finding-batching** (test/helpers/pty/boundaries.ts:62-116, test/helpers/eng-seeded-coverage.ts:33-104, test/helpers/pty/classify.ts:555). Count decision-ledger R records bound to answered AUQ ids instead of question prose.
8. **Periodic surface narrowing**: the context-skills roundtrip, fragment, empty-state, legacy and list cases; carve-section-loading [plan-eng-review]; review-army red-team and consensus; setup-gbrain-bad-token and -remote; aside-canary-quick. Several of these phrase checks are vacuous today, because the surface includes the injected SKILL.md body, so narrowing them to tool results will surface new reds rather than remove old ones.

Red cases that are not convert candidates: shared-libs-plan-callers (3 reds, actor phrase refusal on "hardening", (c)); plan-ceo-section-loading (2 reds, report checks (c) and a ledger check already (a)); plan-review-prosons-neutral-neg (2, question format (c)); plan-ceo-review-format-mode and -format-approach, tpa-absent-darwin, and auq-matrix (1 each, (c)); plan-design-review-plan-mode (1, (d)); scrape-prototype-path (1, vacuous (c); the failing assertion is unknown); plan-ceo-mode-routing (1, already (a)); plan-eng-review-artifact (timeout), shared-libs-read-only (filesystem snapshot), shared-libs-review-revalidation (process abort) and the overlay sonnet case (measurement validity) did not fail on a phrase check. The four `SKILL.md workflow`/`platform setup` reds are skill-llm-eval judges outside `E2E_TIERS`.

## Not audited

- Census commits `a8ace39` through `fd6854b` are not in this checkout, so the wave-reds line numbers could not be mapped to assertions; reds are attributed from the trial error text.
- The skill-llm-eval.test.ts judge cases are outside `E2E_TIERS` and are not covered.
- codex-ci-access.test.ts, codex-hardening.test.ts, codex-under-codex-detection.test.ts, e2e-shard-reuse.test.ts and skill-routing-e2e.test.ts name the umbrella keys but are free tests or route to the files audited above.
- plan-eng-review-artifact-full is `marathon` and out of scope.
- The aside-* cases need a live Aside on macOS and never run in CI.
- "Not verified" in the structured-source column means the template writes the record, but the audit did not confirm that the fixture installs the helper.
