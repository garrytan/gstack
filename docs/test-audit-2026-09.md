# Test audit 2026-09: evidence

Evidence for the test-reduction branch (plan approved through /autoplan: "A, approve as-is"; UC1 resolved as
delete). Base: 65bfb0c (v1.91.6.0). Wherever the plan asks for a PR-body table or verify item, it resolves here.

## Commits

| Commit | Workstream |
|---|---|
| G | Test-infrastructure dead code |
| F | Product tests that fake the product → real-boundary tests |
| A | Tests of dead eval code (reachability-driven) |
| B-cleanup | Paid lane cleanup (B1–B4, B6, B7) |
| C | Retire the never-green finding-count cluster, trim its helpers |
| D | Fold per-incident series into detector owners |
| H | Startup readiness marker for the plan-count history PTY |
| E | Derived touchfile closure invariant (behavior change) |
| B5 | Tier-lane skip and census judges (behavior change) |
| B8 | Default capture model for eleven paid evals (behavior change) |
| Guard | Ratchet, shared resolver, CONTRIBUTING, TODOS, portfolio, this doc |
| Release | Durations refresh, CHANGELOG, VERSION, docs sweep |

## C0 triage (recorded before commit G)

Recorded 2026-09-29 before commit G. Sources: weekly Periodic Evals runs
34812905093 (09-14, sha per run), 35567915613 (09-21, a6b3a575), 36385945043 (09-28, 65bfb0c-era).
Preflight: `gh` authenticated (git.capy.ai proxy, account garrytan); `gh run download` 401s but the
REST `actions/artifacts/<id>/zip` route works; all three runs' artifacts are retained (not expired).
Per-file evidence: 09-28 = uploaded per-shard PTY artifacts (observation.json + terminal logs);
09-14/09-21 = per-shard failure tail in the eval-slices job log (bun output + observation dump +
last-3KB terminal evidence). Local copies: audit workspace: c0/.

Classes: product = the skill did not ask per finding; harness = PTY/classifier/timeout/launch;
budget = live model still progressing when the deadline hit. Agreement rule applied: harness and
budget are both non-product classes; a file is deleted when every artifact is harness or budget
(no artifact shows product), kept+excluded otherwise.

| File | 09-14 | 09-21 | 09-28 | Class | Action |
|---|---|---|---|---|---|
| skill-e2e-autoplan-chain | harness: session exited in 13 s, no phase marker (launch) | harness: observer saw only the phase-3 marker after context compaction; transcript references CEO, Design and DX methodology files and "Phase 3 complete" | budget: timed out after ordered phase-1, 2, 2.5 hits (2 attempts, 160 min) | harness/budget | delete |
| skill-e2e-plan-ceo-finding-count | harness: 5-finding case exited in 11 s; paired case timeout | harness: model asked 8 finding decisions (SQL lookup, Email errors, Orders load, Tests, Sequencing, TODO…), classifier labelled all preReview → `no_review_questions` | harness: classifier threw "Unsupported current CEO decision; cannot exclude it from the 4–7 count" (paired case reached plan_ready, review=2) | harness | delete |
| skill-e2e-plan-eng-finding-count | harness: per-finding question D3 rendered; fingerprints are spinner garbage, step0=4 review=0 | harness: retired legacy oracle "mandatory legacy regression coverage absent" with reviewCount=9, then shard wall timeout | harness: model asked D1–D8/D9 per-finding decisions, all labelled preReview → deadline with review=0 | harness | delete |
| skill-e2e-plan-design-finding-count | harness: exited in 1.7 s | harness: BAND FAIL above ceiling (review=8 > 7 for 5 findings; asked per finding plus extras) | budget: timeout at review=4 and review=5, still asking | harness/budget | delete |
| skill-e2e-plan-devex-finding-count | harness: exited in 2.1 s | harness: seed classifier missed `missing-quickstart` although reviewCount=9 and outcome=plan_ready; retry hit shard wall timeout | pass (plan_ready, review=6) | harness | delete |

No artifact shows a product failure, so C3's issue is not opened; C0-kept TODO entry not needed.

## Security mapping (F)

| design/test/serve.test.ts mirror 'path traversal protection' (5) | design/test/serve.test.ts real serve() reload confinement | removing startsWith(allowedDir) guard in design/src/serve.ts → test 1 fails | 
| browse/test/terminal-agent-internal-handler.test.ts 1–3 (internalHandler/route source greps; auth gate for grant+revoke) | browse/test/terminal-agent-integration.test.ts "/internal/grant and /internal/revoke bearer auth" (no/wrong/valid × grant/revoke + state effect) | revoke route rewritten without internalHandler (no bearer check) → "revoke: no token…" and "unauthenticated revoke…" fail |
| server-security-surface "/health carries no security field and server.ts does not import getStatus" (#2557) | extension-token "GET /health is liveness-only" (real /health body, default + headed/pinned-origin) | injecting `security: 'protected'` into the /health body → 2 fail |
| server-security-surface "security.ts no longer exports the unfed status surface" | same /health body check: the only consumer of getStatus was /health.security; an unused export has no user-visible effect | (covered by the row above) |
| server-security-surface "the sidepanel shield markup is gone" | same /health body check: the shield's only data source was /health.security, now asserted absent | (covered by the row above) |
| server-security-surface:60-66 "server.ts still consumes the sidecar on the inject-scan path" (ENG-OV9) | pty-inject-scan "/pty-inject-scan — L4 sidecar verdict drives the response" (real buildFetchHandler, sidecar client mocked in a child bun test) | replacing `if (sidecarAvail.available && verdict !== 'BLOCK')` with `if (false)` in server.ts → fails |
| server-security-surface:68-76 "security.ts keeps the pure combiner + canary exports" | browse/test/security.test.ts imports and exercises THRESHOLDS, combineVerdict, generateCanary, injectCanary, checkCanaryInStructure, extractDomain | un-exporting injectCanary → SyntaxError "Export named 'injectCanary' not found", security.test.ts fails |
| server-security-surface "/health stays liveness-only: no token in any mode" | extension-token "GET /health never carries a token (IRON RULE)" (3, existing) + liveness-only test | injecting `token: authToken` → 5 fail |
| server-auth "/health never serves a token — no headed-mode or chrome-extension carve-out" | extension-token IRON RULE tests (headed, pinned Origin, both) | injecting `token: authToken` → 5 fail |
| server-auth "/health does not expose currentUrl or currentMessage"; security-audit-r2 "/health endpoint security" (2) | extension-token "GET /health is liveness-only" | injecting `currentUrl: 'x'` → 2 fail |
| sidebar-tabs "/health no longer surfaces agentStatus or messageQueue length" | extension-token "GET /health is liveness-only" (also asserts terminalPort survives) | injecting `agentStatus: 'idle'` → 2 fail |
| security-audit-r2 "Task 1: validateOutputPath uses realpathSync" source greps (4) + behavioral (5) | browse/test/path-validation.test.ts "validateOutputPath — symlink resolution" + "validateOutputPath" allow/deny cases (now importing path-security directly) | replacing both realpathSync resolutions in validateOutputPath with the unresolved path → symlink cases fail |
| security-audit-r2 "results.push is present in the loop block"; "viewport case uses rawW/rawH" (identifier greps, not security contracts) | kept siblings: "validateOutputPath appears before page.screenshot() in the loop", "viewport case clamps width and height" | n/a — identifier names only |
| test/skill-e2e-brain-privacy-gate.test.ts (paid, never green): privacy question fires once before any artifacts egress | test/gstack-skill-start.test.ts 'artifacts-sync consent is asked before any artifacts egress, and only in interactive sessions' | dropping the sync-mode gate on the daily pull → fails (pull stamp written with consent pending); dropping the interactive-only condition → fails (spawned session gets the gate) |

## Mixed-file and consolidation inventory

### F (product tests that fake the product)
| File | Block | Decision |
|---|---|---|
| design/test/serve.test.ts | whole file (16 tests against an inline mirror server) | delete; replaced in place by 2 tests driving the real serve() on an ephemeral port |
| test/gbrain-init-rollback.test.ts | 3 tests running a drifted local bash copy | delete; rollback contract moved to test/gbrain-init-voyage-code-3.test.ts executing the template-extracted blocks |
| test/gbrain-init-voyage-code-3.test.ts | local-copy voyage cases (4) | move: now execute each template init block (3 sites) |
| test/gbrain-init-voyage-code-3.test.ts | "demonstrates the #1798 collision" | delete (tests zsh itself) |
| test/gbrain-init-voyage-code-3.test.ts | template-grep count tests (3) | keep (merged into one "template alignment" test) |
| browse/test/browser-manager-unit.test.ts | "signature accepts an optional exitCode argument", "server.ts callback forwards exitCode…" | delete (tautologies); real owner: server-factory "buildFetchHandler chains cfgBrowserManager.onDisconnect" |
| browse/test/memory-command.test.ts | "12. text mode renders modificationHistory with evicted-count when > 0" | delete (compares two local literals); gap: evicted-count suffix untested at owner |
| test/ios-qa-swiftui-tap-regression.test.ts (+2 fixtures, 98 KB) | whole file | delete |
| test/memory-ingest-no-put_page.test.ts | whole file | delete; gstack-memory-ingest.test.ts fake gbrain exits 99 on put/put_page |
| browse/test/terminal-agent-internal-handler.test.ts | tests 1–3 | delete; replaced by terminal-agent-integration "/internal/grant and /internal/revoke bearer auth" (3×2 + state effect) |
| browse/test/terminal-agent-detach-reattach.test.ts | tests 1, 4, 5, 6 | delete (dup of terminal-agent-ring-buffer-runtime) |
| browse/test/terminal-agent-detach-reattach.test.ts | tests 2, 3, 7–10 | keep |
| browse/test/server-security-surface.test.ts | all 6 | delete; see security mapping |
| browse/test/server-auth.test.ts | "/health never serves a token — no headed-mode or chrome-extension carve-out", "/health does not expose currentUrl or currentMessage" | move → extension-token "GET /health is liveness-only" + IRON RULE |
| browse/test/security-audit-r2.test.ts | "/health endpoint security" (2) | move → extension-token "GET /health is liveness-only" |
| browse/test/security-audit-r2.test.ts | Task 1 block (4 source + 5 behavioral), "results.push is present…", "viewport case uses rawW/rawH…", AGENT_SRC | delete; path-validation owns validateOutputPath |
| browse/test/security-audit-r2.test.ts | escapeRegExp behavioral test | keep, imports path-security directly (meta-commands re-export deleted) |
| browse/test/security-audit-r2.test.ts | state-load, inbox, responsive, CSS validator ordering greps | keep (only guard) |
| browse/test/sidebar-tabs.test.ts | "/health no longer surfaces agentStatus or messageQueue length" | move → extension-token liveness-only (also asserts terminalPort) |
| browse/test/sidebar-tabs.test.ts | "browse/src/sidebar-agent.ts is gone", "sidebar-agent test files are gone" | delete |
| browse/test/sidebar-ux.test.ts | "stop button style exists", "stop button uses error color", "experimental-banner no longer uses amber…", "tool description uses system font not mono" | delete + dead CSS (.stop-btn, .experimental-banner, .agent-tool, .agent-reasoning; 67 lines) |
| browse/test/sidebar-ux.test.ts | "switchTab has bringToFront option" (dup of :50), "shutdown kills the terminal-agent via identity-based kill" (dup of terminal-agent-pid-identity), "quick actions toolbar has cookies button" (dup of sidebar-tabs quick-actions) | delete |
| test/skill-validation.test.ts | "Generated SKILL.md freshness" (3) | delete (C14); gen-skill-docs placeholder regex widened to \w+ |
| test/gen-skill-docs.test.ts | "generated header is present in SKILL.md", "…in browse/SKILL.md" | delete (C14); "every skill has a generated SKILL.md with auto-generated header" covers both |
| test/post-rename-doc-regen.test.ts | "top-level SKILL.md exists and is regenerated" | delete (C15) |
| test/static-no-legacy-writes.test.ts | "office-hours/SKILL.md uses --log-session, not raw echo append" | delete (C15); .tmpl sibling + freshness |
| make-pdf/test/coverage-gaps.test.ts | all 19 cases | move → diagram-prepass.test.ts (18) and render.test.ts (screenCss) |

### A (dead eval code)
Reachability tool: audit tool reach.ts (ts-morph; roots = every non-helper file importing
test/helpers + bin/gstack-model-benchmark + the outside-voice shim; edges = identifier → top-level helper
declaration; BFS to a fixed point; --prune removes unreached declarations and unused imports, rerun until 0).
Baseline at 65bfb0c: 12 dead declarations = the 10 A4 names + `execGit` (auq-sdk-capture) + `invokeAndObserve`
(claude-pty-runner). After A's test deletions: 33 dead (eng-seeded-coverage oracle closure 2,626 lines,
autoplan-artifact-permission approvers 474, matchesAutoplanDigestRows 86, the 12 above); pass 2 → 0.

| File | Block | Decision |
|---|---|---|
| 25 A1 pure files + eng-native-seed-contract.test.ts | all | delete (all 61 native-seed-contract tests call evaluateEngSeedCoverage; its 3 blocks with live pty-runner asserts replay the plan-eng-finding-count callback; hasNativePlanTerminal / isQuestionlessNativePlanExit / classifyPlanCountFrame keep owners plan-count-pending-exit, plan-count-empty-review, plan-count-completion) |
| eng-count-ad-v2 | "first attempt … D9 handoff", "prior successful plan Write…", "closed handoff…", "new task references…", "conditional closure…" | delete (isEngCompletionHandoff) |
| eng-count-ad-v2 | "new first-finding and handoff paths…" | keep first-finding half (engFirstReviewAUQ); handoff half deleted |
| eng-count-ad-v2 | census() | keep, dead handoff predicate argument removed (retry census unchanged: administrative 0) |
| eng-count-ad-v2 | 6 live + touchfile test | keep (touchfile test loses the eng-completion-handoff path line) |
| eng-resolution-block-position | tests 1–3 | delete (handoff / seed oracle) |
| eng-resolution-block-position | "saved native Header and Options…" (createEngBatchingIssueCounter) | keep |
| eng-seeded-completion-ai | "complete native navigation preserves conflicting current states…" | delete (handoff) |
| eng-task-pause-navigation-f359 | all check()/handoff tests | delete |
| eng-task-pause-navigation-f359 | "handoff alone never supplies a native terminal…" | keep (hasNativePlanTerminal); admin set now the completed call's signature |
| eng-next-handoff-ah | 18 handoff tests + parser-ACK replay | delete |
| eng-next-handoff-ah | "exact final exit/report replay…", "actual pending ExitPlanMode…" | keep (hasNativePlanTerminal, isCurrentPlanApprovalScreen) |
| eng-published-navigation | ~150 handoff checks | delete |
| eng-published-navigation | retry, real-completed, D19, investigation, cf74 terminal replays | keep (hasNativePlanTerminal); dead handoff/phase asserts inside removed |
| eng-seeded-coverage.test | 23 oracle blocks + 6 describes built on evaluateEngSeedCoverage/isEngSeedDecisionAUQ | delete |
| eng-seeded-coverage.test | "Eng semantic native evidence boundary", touchfile test, "batching caller counts…" | keep |
| autoplan-edit-digests-al / clipped-suffix-aq / pending-artifact | approver cases (8/8/8) | delete |
| same three | recorder/launcher cases | keep |
| 11 A2 replay files | all | delete |
| autoplan-permission-viewport | 27 tests (autoplan-phase-order + pty-current-screen) | delete; captured settings-overwrite card assertion moved to claude-pty-runner.unit "isPermissionDialogVisible" |
| autoplan-phase-observation | 44 tests (all via phase-order helpers) | delete |
| eng-finding-fixture.test | seeder + legacy-auth fixture tests (5) | delete |
| eng-finding-fixture.test | 2 prompt-builder pins of the paid eng-finding-count file | keep until C (plan said "four prompt-builder tests"; only 2 are) |
| ceo-paired-payment-fixture, design-ui-scope, plan-skill-completion, pty-current-screen, required-reads, transcript-section-logger tests | all | delete |
| plan-count-fixture | 3 design-ui-captured cases + captured-question fake plumbing | delete |
| autoplan-phase-handoff | readPlanSkillCompletion assertion in "captured parent text…" | delete line; test kept |
| plan-seed-submission | PtyCurrentScreen decoder | swap to production createPtyScreen (58/58 pass) |
| touchfiles.test | plan-skill-completion path in "native completion changes select the Design UI gate" | removed from the each-list |

### B-cleanup (B1–B4, B6, B7)
| File | Block | Decision |
|---|---|---|
| skill-llm-eval-spec, skill-e2e-spec-execute, gemini-e2e (+ gemini-session-runner + test), skill-e2e-ship-idempotency, 2 overlay opus-4-7 *-sonnet wrappers (+ fixture entries), skill-e2e-conductor-prose, codex-e2e-plan-format, skill-e2e-brain-privacy-gate | all | delete (B1/B7) |
| conductor-prose-observation-ao.test.ts + fixture | all (evaluates the deleted paid caller's source) | delete with its paid file |
| plan-tune-cathedral-fixture.test.ts | all (evaluates the cathedral file's source under injected fakes) | delete — the cathedral scenarios now run directly in the free suite (B3) |
| skill-llm-eval.test.ts | "regression vs baseline" | delete (B2) |
| skill-llm-eval.test.ts | "command reference table", "snapshot flags reference", "browse/SKILL.md reference" | collapse → one union judge "browse/SKILL.md reference" (B2) |
| skill-llm-eval.test.ts | "baseline score pinning" | fold into the union judge (pins eval-baselines.json browse_skill) |
| skill-e2e-opus-47.test.ts | 3 negative routing controls | move → skill-routing-e2e "journey-negatives" (same ≤1-of-3 bound); positives already in skill-routing-e2e |
| skill-e2e-ios.test.ts | "ios-qa E2E (with device)" HAS_DEVICE stub | delete (B3) |
| gstack-skill-start.test.ts | new "artifacts-sync consent is asked before any artifacts egress…" | add (B7: existing pins did not assert ordering) |
| paid census literals (paid-retry-supervision, paid-overlay-scheduling, overlay-lifecycle, overlay-measurement, paid-shards, touchfiles, periodic-fixture-selection, codex-eval-selection, paid-pr-profile) | counts / key lists | updated for the removed files and keys (no assertion removed except ones naming deleted keys) |

### C (retire finding-count cluster, C2 helper trim)

Rule: a free test block is deleted when every assertion subject is outside the post-C live closure (the pruned helpers, or a
deleted paid file loaded through a registration adapter); a block that only uses dead code as an *input builder* for a live
subject is kept and the builder is replaced or restored (rows below). LIVE blocks are kept. Touchfile self-assertions lose
only the removed keys (E deletes them).

| File | Block | Decision |
|---|---|---|
| test/skill-e2e-autoplan-chain.test.ts | whole file | delete (C1; C0 class harness/budget, see triage) |
| test/skill-e2e-plan-ceo-finding-count.test.ts | whole file | delete (C1; C0 class harness/budget, see triage) |
| test/skill-e2e-plan-design-finding-count.test.ts | whole file | delete (C1; C0 class harness/budget, see triage) |
| test/skill-e2e-plan-devex-finding-count.test.ts | whole file | delete (C1; C0 class harness/budget, see triage) |
| test/skill-e2e-plan-eng-finding-count.test.ts | whole file | delete (C1; C0 class harness/budget, see triage) |
| 84 free test files (list in commit) | whole file | delete: every block exercised only pruned helpers or deleted paid files |
| test/autoplan-eval-budget.test.ts | whole file (AUTOPLAN_CHAIN_BUDGET, dedicated slice) | delete; timer-safe/explicit-override checks moved → eng-finding-retry-budget 'ordinary tiers and registered allocations remain unchanged' |
| test/plan-review-native-default.test.ts | 3 tests (omitted multiSelect default) | move → plan-review-decisions 'an omitted native multiSelect receives the false default only in evaluator input' (removal-checked) |
| test/autoplan-chain-fixture.test.ts | 'native sequencing config reaches the real CLI reader…' | move → plan-count-fixture.test.ts; other 3 tests delete (chain source pins) |
| test/eng-finding-fixture.test.ts, test/design-finding-fixture.test.ts | whole file | delete (read/import the deleted paid files) |
| test/ceo-current-decision-record.test.ts (PROD-TOUCH) | all 28 | delete: reads plan-ceo-review template only as input to the retired ceo-payment-findings counter |
| test/devex-finding-fixture.test.ts | DX registration (8) + materialized devex-existing-sdk checks (5) | delete (fixture consumed only by the deleted DX count eval); keep 'every host exposes the DX per-call rule…' |
| test/ceo-finding-fixture.test.ts | 'native count registration: %s' (11) | delete (imports the deleted paid file); fixture tests keep |
| test/eng-semantic-terminal.test.ts | evaluateEngTerminalReview/buildEngSeedDecisionInput blocks (6), registration loops (7) | delete; 'real native Exit…' and 'a late substantive answer…' keep with a direct id callback in place of the dead assessor |
| test/eng-seeded-coverage.test.ts | 'Eng semantic native evidence boundary' describe, 2 mixed, touchfile test | delete (buildEngSeedDecisionInput dead; validator owned by plan-review-decisions) |
| test/plan-count-fixture.test.ts (PROD-TOUCH) | real PTY children worker | keep; dead design/devex predicates replaced by inline caller policies; dead-classifier assertion removed |
| test/plan-count-native-input.test.ts | design outside-voices cases | keep; pickDesignCountOutsideVoices replaced by inline caller policy; autoplan routing test delete |
| test/plan-pending-question-pty.test.ts | hook PTY test | keep; autoplanSetupDecision navigation replaced by the fixed native key sequence |
| test/helpers/claude-pty-runner.unit.test.ts | findModeOption (7), design/devex Step0 + first-review (14) | delete; 2 prompt-parser tests keep with the dead boundary assertion trimmed |
| test/autoplan-method-read-audit.test.ts, autoplan-phase-handoff, autoplan-publication-guard, plan-count-session-cwd, autoplan-preconfigured-onboarding-ar (PROD-TOUCH) | all but chain caller pins | keep; helpers autoplan-method-read-audit.ts / autoplan-preconfigured-fixture.ts restored (they adapt the production phase-publication hook / skill-start) |
| test/autoplan-artifact-recorder, autoplan-edit-digests-al, eng-test-plan-edit-approval | recorder tests | keep; readPendingAutoplanArtifact restored (recorder is imported by claude-pty-runner) |
| test/carve-guards (helper) | autoplan externalTest | behavioral 'none' (chain was its only section-read proof; TODOS entry) |
| 20 replay files (ceo-completion-handoff-m/-o, ceo-handoff-y, ceo-count-ad-v2, design-count-native-8525, …) | MIXED/DEAD blocks | delete; LIVE blocks keep (hasNativePlanTerminal admin exclusion owned by eng-published-navigation / eng-next-handoff-ah) |

Helpers deleted (11): autoplan-setup-question, ceo-approach-pick, ceo-completion-handoff, ceo-payment-findings,
design-artifact-question, design-count-fixture, design-count-outside, design-count-review, devex-count-fixture,
devex-seed-coverage, eng-count-question-policy. claude-pty-runner and eng-seeded-coverage trimmed to the paid-root closure.
135 fixtures orphaned by these deletions removed (orphans.py diff against fe011e0), plus test/fixtures/devex-existing-sdk/.
Known selection effect (not a regression by the plan's definition, E derives the closure): lib/autoplan-phase-publication.ts,
bin/gstack-decision-log, lib/gstack-decision.ts and the recorder/dx-navigation helper imports of claude-pty-runner selected
only the retired evals and now select none until E.
Out of C2 scope, left as is: ceo-finding-fixture seedCeoPaymentProject/pickSuppliedCeoPlanStart and test/fixtures/ceo-existing-payment
(no surviving paid consumer; not in the C2 helper list).

### D (consolidate per-incident series)
Mechanism: each incident file is folded verbatim into its detector's owner test as one `describe('<incident>')`
block (audit tool merge-into.ts); imports are hoisted and per-incident bindings restored as local consts, so every
case runs the identical code against the identical fixture. Dropped only: tests asserting the incident file's own
touchfile registration (E-type; the path no longer exists). Accounting per family = owner+incidents before vs
owner after, pass count must equal before − dropped with 0 failures (audit tool family.sh). Touchfile lists that named an
incident now name the owner (audit tool tfreplace.py). Rows are not rewritten into value tables: a verbatim fold cannot
drop an incident-specific control (lane-3 C7 risk note).

| Detector | Owner | Incident files folded (full paths) | Tests before → after (self-registration dropped) |
|---|---|---|---|
| hasStaleFillRaceFinding | test/ceo-section-loading-fixture.test.ts | test/sdk-columnar-af, sdk-compact-sequence-aj, sdk-order-b-ag, sdk-ordered-schedule-ar, sdk-ordering-ae, sdk-original-order-ai, sdk-reported-coordination-ar, sdk-schedule-continuation-ah, sdk-stale-table-ad-v3 (.test.ts) | 376 → 368 (8) |
| generateModelOverlay / resolveModel | test/model-overlays.test.ts (new) | test/model-overlay-fable-5, -gpt-5.6-sol, -gpt-6-astra, -opus-4-7, -opus-4-8, -sonnet-5 | 37 → 37 (0); every overlay phrase kept |
| coverageAuditVerdict / coverageAuditReadEvidence | test/coverage-audit-evidence.test.ts | test/coverage-audit-af, coverage-audit-aw, coverage-audit-shell-legend-at, coverage-checkbox-tail-av, coverage-diagram-legend-as, coverage-shell-display-aq (exercises coverageAuditReadEvidence) | 149 → 145 (4) |
| autoplan phase completion | test/autoplan-phase-observer.test.ts | test/autoplan-phase-dash-ao, autoplan-with-result-au (autoplan-final-gate-ao deleted in C) | 82 → 80 (2) |
| findNativeAutoDecision | test/native-auto-decide.test.ts | test/auto-decide-current-declaration, -explanatory-mode, -recommendation-scope, -saved-ai, -structured, -target-identity, auto-decision-state (auto-decide-fixture kept: real seeding) | 859 → 858 (1) |
| claudeOutsideExecutions | test/outside-voice-evidence.test.ts | test/outside-background-ai, outside-voice-async | 49 → 49 (0) |
| engStep0Boundary/engSetupAUQ/engFirstReviewAUQ | test/eng-first-review.test.ts (new) | test/eng-annotated-cache-au, eng-architecture-cache-av, eng-binding-retry-z, eng-binding-z, eng-cache-brief-am, eng-cache-owner-an, eng-cache-writes-as, eng-count-ad-v2, eng-declarative-as, eng-declared-retry-at, eng-first-category-af, eng-first-review-t, eng-injected-export-aq, eng-library-hooks-aq, eng-scope-y | 256 → 247 (9) |
| hasNativePlanTerminal (completion/handoff) | test/plan-count-completion.test.ts | test/ceo-completion-handoff-m, ceo-completion-handoff-o, ceo-handoff-y, dx-manual-handoff-ao, plan-count-dx-handoff-o, eng-next-handoff-ah, eng-task-pause-navigation-f359, design-count-native-8525 | 129 → 129 (0) |
| createPlanCountPermissionGuard | test/plan-count-file-permission.test.ts | test/batching-permission-at, design-crop-gutter-ap, plan-count-crop-ak, plan-count-permission-ac, plan-count-quoted-frame-ak | 125 → 121 (4) |
| ceo-mode-option | test/ceo-mode-option.test.ts | test/ceo-hold-commitment-ar, ceo-hold-posture-ag, ceo-mode-colon-at, ceo-mode-full-ad, ceo-mode-posture-ad, ceo-prerequisite-ad-v2 | 463 → 457 (6) |
| plan-scope-selection | test/plan-scope-selection.test.ts | test/design-scope-announcement-ao, design-scope-declaration-ak, design-scope-entry-aq, design-scope-selection-aj, eng-option-b-scope-al, plan-scope-recovery-av | 90 → 84 (6) |
| planCountPrerequisitePick | test/plan-count-prerequisite.test.ts (renamed from -n) | test/plan-count-navigation-r, plan-count-prerequisite-n | 38 → 37 (1) |

Native-completion negative table: after C it survives in 3 files (14 per-incident copies in eng-first-review,
2 in plan-count-completion, 1 in dx-selected-navigation-ap), each applied to a different captured call and a
different engFirstReviewAUQ branch. Collapsing them to one table is only sound after engFirstReviewAUQ checks
native completion once at entry (each branch gates it separately today, claude-pty-runner.ts engFirstReviewAUQ);
that is a harness behavior change on a paid verdict, so it is deferred (kept-vs-plan) rather than done here.

### E (derived touchfile closure)

Selection regression definition (used by the E proof and the drop rule): a sample edit's `--tier gate --profile pr --list`
output after the change is missing a paid case that the before-run selected through any path other than a free `*.test.ts`
touchfile entry. Proof computed with computePaidCaseSelection (the function `--list` calls) at 689ef30 vs the E tree:

| Sample edit | Profile | e2e before → after | judges before → after | lost | gained |
|---|---|---|---|---|---|
| plan-eng-review/SKILL.md.tmpl | pr | 2 → 2 | 1 → 1 | none | none |
| plan-eng-review/SKILL.md.tmpl | full | 28 → 28 | 1 → 1 | none | none |
| test/helpers/claude-pty-runner.ts | pr | 0 → 1 | 0 → 0 | none | auq-format-gate |
| test/helpers/claude-pty-runner.ts | full | 15 → 20 | 0 → 0 | none | auq-format-gate, carve-section-loading, office-hours-section-loading, plan-ceo-section-loading, ship-section-loading |
| test/helpers/plan-count-fixture.ts | pr | 0 → 1 | 0 → 0 | none | auq-format-gate |
| test/helpers/plan-count-fixture.ts | full | 10 → 20 | 0 → 0 | none | auq-format-gate, carve-section-loading, office-hours-auto-mode, office-hours-section-loading, plan-ceo-section-loading, plan-design-review-plan-mode, plan-devex-review-plan-mode, plan-eng-review-plan-mode, plan-mode-no-op, ship-section-loading |
| bin/gstack-config | pr | 3 → 3 | 0 → 0 | none | none |
| bin/gstack-config | full | 9 → 9 | 0 → 0 | none | none |
| test/fixtures/plans/autoplan-dashboard.md | pr | 86 → 86 | 23 → 23 | none | none |
| test/fixtures/plans/autoplan-dashboard.md | full | 0 → 0 | 0 → 0 | none | none |

Rewrite: 950 free `*.test.ts` entries removed from E2E/LLM-judge lists; 653 closure paths added (53 distinct helpers/fixtures
across 123 keys), all real static imports or literal fixture paths of the key's paid file. Closure traversal stops at
GLOBAL_TOUCHFILES modules (an edit there already selects everything) and ignores the selection modules themselves
(touchfiles-data/touchfiles/test-selection, map-diffed). Keyless paid files (asserted): codex-e2e-recommendation-substance
(census-only, PERIODIC_CI_EXCLUDE), skill-e2e-auq-consistency and skill-e2e-auq-verbose-vs-carved-ab (periodic tier gate only).
Deleted: test/periodic-fixture-selection.test.ts (hand-copied inventory), test/fake-impeccable-touchfiles.test.ts,
45 per-file selection examples (self-registration / literal selectTests of test/ paths) in 41 files; two emptied files
(autoplan-clipped-suffix-aq, codex-eval-selection) and their orphan fixture. Trimmed to non-test paths: 8 tests
(CSO each, mode-question capture, live runtime each, mode input each, autoplan-review-discovery, autoplan-snapshot,
review-entry-and-design-clarity-au, shared-libs-fixture generation, devex calibration, cookie judge helper exactness).
Kept selection-semantics tests (ES-1): matchGlob suite, global touchfile, skill-specific, resolver→consumer equivalence,
testing resolver, learnings rendering, browse/aside, gen-skill-docs scoped, unrelated/empty/union, LLM judge, SKILL root,
completeness, tiers, dependency-path existence, reverse invariant; eval-cli-family, skill-fixture global, workflow-boundaries F9.
Removal check: replacing test/fixtures/fake-impeccable.ts in one key makes the invariant print the paid file, the path, the
import/literal chain, the key, the verify command and CONTRIBUTING.md#paid-test-touchfiles plus the lower-bound note.

## Behavior-changing commits: kept or dropped

| Commit | Measurement | Decision |
|---|---|---|
| E | Selection proof above: no lost case for the four sample edits under either profile; growth only from real static dependencies | kept |
| B5 | Gate lane 52 → 42 files, weekly gate census 52 → 41 (judges skipped), periodic 77 → 69; PR-profile selection for the sample edits byte-identical before and after | kept |
| B8 | Paid run: gate 16/16 pass; periodic 28 pass, 6 fail (all in four files). Fallback taken: those four files keep claude-opus-4-7; seven files re-pinned. Estimated B8 delta after the fallback: +$0.69/week (opus −$1.43, sonnet +$2.12), below zero once C and B5 savings are counted | kept (seven files) |

### B8 pre-spend estimate (recorded 2026-09-29, before any B8 paid run)

Source: latest weekly periodic artifacts (runs 36385945043 = 09-28, 35567915613 = 09-21), per-shard eval JSON cost_usd.
Price ratio from test/helpers/pricing.ts: claude-fable-5-1 (default capture, lib/eval-model.ts) $10/$50 per MTok in/out;
claude-opus-4-7 $15/$75 (ratio 0.667 on both); claude-sonnet-4-6 $3/$15 (ratio 3.33 on both).

| Files | Old pin | Weekly $ (09-28) | Est. weekly $ on default | Delta |
|---|---|---:|---:|---:|
| plan, design, plan-prosons, plan-format, qa-bugs, retro, office-hours-phase4 | opus-4-7 | 15.78 | 10.52 | −5.26 |
| office-hours, office-hours-brain-writeback | sonnet-4-6 | 0.91 | 3.03 | +2.12 |
| auq-matrix, workflow | opus-4-7 | no result in the retained artifacts | — | ≤ 0 (ratio 0.667) |
| **B8 total** | | 16.69 | 13.55 | **−3.14** |

Assumes the same token volume per case (a verbosity change moves this; the ratio applies to input and output alike).
Wall clock: unchanged shard walls (budgets do not depend on model). Drop threshold, fixed now: B8 is dropped from this PR
if its estimated net weekly dollars after C and B5 savings are above zero. Estimated net: −3.14 (B8) − C savings
(five retired evals) − B5 savings (18 hollow shards, 23 census judges) < 0 → B8 proceeds to its one paid run.
Fallback check: `git log -S claude-sonnet-4-6` on skill-e2e-office-hours and -brain-writeback shows only 636175d / #2264
(infra hardening), no cost rationale → both re-pinned.

## Paid validation and fallbacks

- B2 union judge "browse/SKILL.md reference": PASS (clarity 4, completeness 4, actionability 4), $0.02. Fallback not
  taken; the three original browse judges are deleted.
- B6 folded journey negatives in `skill-routing-e2e`: 3/3 unrouted, $0.36. Fallback not taken; `skill-e2e-opus-47` deleted.
- B8 re-pin run (commit B8 tree, `EVALS_ALL=1`, `EVALS_TIER=gate` then `periodic`, 11 files, detached, about $32 logged
  capture cost): gate 16 pass / 0 fail; periodic 28 pass / 6 fail / 33 skip. Failures, all passing in the 09-14, 09-21
  and 09-28 weekly runs on the old pins, so attributed to the default model:
  `plan-design-review-plan-mode` (timeout at 300 s, no turns recorded), `office-hours-phase4-fork` (no two-alternative
  fork), `plan-review-prosons-neutral-neg` (output file not written), `plan-ceo-review-selective` and `plan-eng-review`
  (600 s timeouts), `plan-ceo-review-expansion-energy` (surface-framing score 3 < 4). Fallback taken: skill-e2e-design,
  -office-hours-phase4, -plan-prosons and -plan keep claude-opus-4-7 (TODOS entry); the other seven files stay re-pinned.
- PR-profile list on the final diff (`--tier gate --profile pr --list`, no EVALS_ALL): unknown dependencies (deleted
  helpers, fixtures and workflow edits) restore every gate case: 86 of 192 tests, 38 of 42 shards. Recorded as data.
- Gate census pre-spend estimate (recorded before running): 41 planned files (judges skipped). The 21 files with
  per-file cost in the retained weekly artifacts total about $22; the other 20 have no retained cost, so about $40–45
  in all at the same average. Wall clock with 8 local workers: about 1–2 hours. The census is the one full paid run
  this PR spends on; the B8 run above already covered the re-pinned files.
- Full gate census: results in the final report and PR body.

## Before metrics (65bfb0c)

- `bun run test:ubicloud --record-durations` (standard-16, 2026-09-29 04:34Z): EXIT 0, 1065 files one-per-shard,
  wall 142 s; recorded serial sum 1,888.2 s (committed durations file at 65bfb0c: see release commit diff).
  Raw copy: audit workspace: metrics/before-durations.json; log audit workspace: ubi-before.log
- File/LOC counts: audit workspace: metrics/before-counts.txt
- Paid --list: before-gate-list.txt (gate 58/119 files, 216 tests selected), before-periodic-list.txt (periodic 100/119)
tracked test files: 1187
under test/: 982
test/ LOC (ts): 274208
test/helpers LOC: 51390
test/fixtures bytes: 16289330	total
all test-file LOC: 279898
- free tests: 27,331 passed, 0 failed (1065 shards)

## After metrics (release commit, same counting script as before)

| Measure | Before (65bfb0c) | After |
|---|---:|---:|
| Tracked `*.test.ts` files | 1,184 | 957 |
| `test/*.test.ts` files | 979 | 755 |
| `test/` TypeScript lines | 274,208 | 227,713 |
| `test/helpers` lines | 51,390 | 39,427 |
| `test/fixtures` bytes | 16,289,330 | 9,695,914 |
| All `*.test.ts` lines | 279,640 | 244,504 |
| Free suite (Ubicloud standard-16, `--record-durations`) | 1,065 files, 27,331 passing, 142 s wall, 1,888.2 s serial | 857 files, 20,302 passing, 136 s wall, 1,737.7 s serial |
| Paid files / gate lane / periodic lane | 119 / 58 / 100 | 100 / 42 / 69 |
| Weekly gate census planned files | 58 | 41 |
| 09-21 weekly periodic shard-minutes on files this branch removes | 235 of 462 | 0 |

`git diff --numstat 65bfb0c..release`: production, CI and scripts 21 files (+90/−215); docs 6 (+574/−78 before the
release docs sweep); tests 383 (+9,375/−44,379); test helpers 47 (+786/−12,749); fixtures 199 (−43,667).

## Kept vs plan

- Kept `AUTOPLAN_PREFLIGHT_BUDGET_BYTES` (G): `skill-preflight-budget.test.ts` enforces it on real generated output.
- Deleted `plan-tune-cathedral-fixture.test.ts` beyond the plan (B3): it only replayed the renamed file's fixture.
- `eng-finding-fixture.test.ts`: the plan named four prompt-builder tests; only two existed, and C deleted them with
  the paid file they read.
- C0 agreement rule: harness and budget were treated as one non-product group; every artifact of the five files was
  harness or budget, none product.
- C kept seven of the eight production-touching files; `ceo-current-decision-record` went because its template read
  only fed the retired counter. Three helpers were restored for kept tests (`autoplan-method-read-audit.ts`,
  `autoplan-preconfigured-fixture.ts`, `readPendingAutoplanArtifact`).
- `CARVE_GUARDS.autoplan` became `behavioral: 'none'` (the retired chain was its only section-read proof).
- D folds incident files verbatim into owner `describe` blocks rather than rewriting them into value tables, so no
  incident control can be dropped; the native-completion negative table is deferred (TODOS) because collapsing it
  changes `engFirstReviewAUQ` gating on a paid verdict.
- E stops the closure walk at global touchfile modules and excludes the selection modules; helpers imported by a
  paid file now select every case that file registers (for example the cookie judge helpers select all judges).
- H edited only `plan-count-history`: `eng-semantic-terminal`'s sleeping cases and `design-artifact-question` went in C.
- B5 has no CLI file selector to bypass the skip; running a file directly with `bun test` bypasses it.
- Fixes to earlier commits: the B commit's census, judge-count, touchfile-count and selection literals were stale
  (nine free failures found by a full local run) and were fixed inside that commit before C.

## Retained false positives (lane reports §4)

### Lane 1

- `skill-e2e-hermetic-canary.test.ts` — paid test of test infrastructure, but it is the only falsifiable proof the
  child env/auth/config is hermetic ($0.02, 5–8s, gate + PR profile). Keep.
- `paid-*.test.ts` (8 files, 1,948 LOC, ~3.5s free) — they test `scripts/test-paid-shards.ts` (1,866 LOC) and
  `test-pr-profile.ts`, the real paid runner. Legit tooling tests. Minor smell only: `paid-free-boundary.test.ts`
  pins a sha256 of `test/helpers/test-selection.ts` and has incident-named tests (`as at 06ed920`, `PR 2956`).
- `llm-judge-abort.test.ts`, `llm-judge-frontier.test.ts` (287 LOC, 74ms) — unit tests of the shared judge client
  every judge uses. Keep.
- `llm-judge-recommendation.test.ts` — fixture-based negative coverage for `judgeRecommendation` (~$0.04). Keep.
- `make-pdf/test/e2e/*` — run in the Linux free suite and again in `make-pdf-gate.yml` on macOS: different
  platform, so not a duplicate. `ci-prereqs.test.ts` is the anti-silent-skip tripwire. Keep.
- Carve / overlay per-case wrappers — see C4. Keep.
- `overlay-harness-claude-dedicated-tools-vs-bash-sonnet` — applies `claude.md` to Sonnet 4.6, a pairing production
  does render. Keep (unlike D5).
- `skill-e2e-office-hours` posture judges, `skill-e2e-benchmark-providers` ($0.001) — quality benchmarks that
  CLAUDE.md explicitly classifies periodic. Keep.
- `codex-e2e-sol-scope.test.ts` — never runs in CI, but it pins the current `gpt-5.6-sol` overlay behavior;
  move to manual lane (C2), do not delete.
### Lane 2

- `autoplan-overwrite-progress-ax` (70 LOC): tests `autoplanPermissionProgressKey`, used live at `skill-e2e-autoplan-chain.test.ts:205`. KEEP (could merge into a recorder/progress test).
- `autoplan-artifact-recorder.test.ts` (7.5 s): owner of the live hook approval. KEEP; it's the proof that makes candidate 1 safe.
- `auq-format-always-loaded`: greps generated SKILL.md for the AskUserQuestion format and per-skill cadence rules. This is a prompt-byte contract (retention bar). KEEP.
- `auq-error-fallback-hook`, `autoplan-publication-guard/-hook/-generation`, `autoplan-snapshot/-init/-obligations/-methodology-names/-phase-order`,
  `outside-voice-provenance`, `outside-voice-invocation/-preflight/-routing`: exercise production hooks, bins, and resolvers. KEEP.
- `autoplan-review-discovery` (14 s): real copy/symlink install layouts per host plus `bin/gstack-autoplan-snapshot`. KEEP. Most of the
  cost is one `gen-skill-docs --host all` into tmp, a candidate for sharing generated output across tests (perf, not deletion).
- `auq-parallel` (17.4 s): tests the paid AUQ harness's concurrency, deadline, and cleanup through a mocked SDK. It's test-of-harness, but it
  guards paid-run cost and timeout behavior. KEEP; maybe reduce scenarios.
- `carve-guard-completeness`, `carve-section-ordering`, `carve-guards-negative`: generated-output structure guards for carved skills,
  plus a negative control proving the guard fires. KEEP. `carve-section-sharding` and `autoplan-eval-budget` test paid-runner
  scheduling; they could MOVE next to the `test-paid-shards` tests but are fine as is.
- `outside-voice-fixture`, `carve-plan-fixture`, `autoplan-chain-fixture`: tests of fixture builders used by paid evals. They're cheap and guard
  paid-run validity. KEEP (low priority).
- Not audited in depth: `autoplan-amend-input`, `autoplan-method-read-audit`, `autoplan-phase-handoff`, `autoplan-dual-voice-*`,
  `autoplan-owned-state`, `autoplan-preconfigured-onboarding-ar`, `autoplan-pending-question`, `auq-native-capture`,
  `batching-permission-at` (its helper `plan-count-file-permission.ts` is live in the runner; its siblings `plan-count-crop-ak`,
  `plan-count-permission-ac`, and `design-crop-gutter-ap` are outside this lane).
### Lane 3

- `plan-count-transcript.test.ts` (252 LOC): looks like harness, but `helpers/plan-count-transcript.ts` is a
  re-export of `lib/claude-public-transcript.ts`, which production uses (`lib/autoplan-phase-publication.ts`,
  `autoplan/bin/phase-publication-hook.ts`). Keep; consider renaming to the lib owner.
  Same for `plan-count-session-cwd` and `plan-count-cross-cwd-ancestry` (import the lib directly).
- `design-checklist-sync.test.ts`: generated-file drift contract (`review/design-checklist.md` from
  `lib/design-catalog.ts`), named in CLAUDE.md. Keep.
- `design-catalog`, `design-md`, `design-detect-contract`, `design-flag-utils`, `review-log`,
  `review-start-evidence` (13.3 s, `lib/review-evidence`), `office-hours-review`, `plan-tune`,
  `ship-version-sync`, `ship-template-redaction`, `ship-test-detection-markers`, `spec-quality-gate-secret-sink`:
  test production modules/bins. Keep.
- `ship-review-loop.test.ts` test 1 (no `**STOP** … run /ship again` across rendered hosts) is a real #2391
  regression guard; tests 2–3 are exact-sentence pins ("stay in this invocation and loop") and could be
  loosened, but prose here is the skill's instruction, so not a deletion candidate.
- `ship-apple-gate.test.ts`: ordering assertion (Apple adapter before branch gate) is behavior in prose. Keep.
- `spec-template-invariants`, `ship-workflow-clarity`, `ship-plan-completion-invariants`, `eng-scope-entry-ap`,
  `review-entry-and-design-clarity-au`, `design-scope-entry-aq`, `plan-scope-recovery-av`,
  `ceo-mode-preference-al` (~400 `toContain`/`toMatch` on skill prose): mixed ordering checks (keep) and
  exact-sentence pins (fragile). Needs a per-assertion pass; not a deletion batch.
- `plan-skill-questions.test.ts` (2,439 LOC, 22.6 s, 430 tests): `helpers/plan-skill-questions.ts` is used by
  9 helpers and 2 fixture modules on the paid path; large but live. Candidate for C7-style consolidation later.
- `claude-pty-runner.ts` exports: only 4 top-level declarations (111 LOC) unreachable from paid/helper code
  (`isTrustDialogVisible`, `findModeOption`, `PLAN_SKILL_COUNT_FINALIZE_MS`, `isUnknownSlashCommandVisible`);
  small, not pursued.
### Lane 4

- **`test/setup-codex-scope*.test.ts` (5 files, 160 s, the biggest time sink in the lane):**
  they spawn the real `setup` twice per case and assert no mutation of global or foreign
  skills. These are data-loss safety contracts, and each case covers a distinct layout, alias,
  or ownership shape. One exception: the first test in `setup-codex-scope.test.ts`, "fixture
  writes reject physical escapes…", tests the fixture guard, which is test infra. AGENTS.md
  mandates that guard, so it goes to lane 5 rather than being deleted.
- **`test/cso-cli*.test.ts` (73 s) and `cso-scanner-cli`:** each test is a distinct CLI
  contract (recheck resolution, launcher trust, redaction, deadlines). They're slow because
  they go through the compiled launcher, which is the real boundary.
- **`gstack-memory-ingest.test.ts` (75 s):** behavioral CLI tests with a fake gbrain. Only the
  "probes the gbrain executable directly…" source grep is weak; it's a minor candidate.
- **browse/test cookie-* cluster (14 files, ~65 s):** behavioral security tests (decryption,
  origin policy, Keychain denial, isolated Chromium auth). There's no duplication beyond the
  different layers they cover.
- **browse xvfb (43 s), handoff (55 s), commands (36 s):** real behavior. The `expect(true)
  .toBe(false)` calls in commands.test.ts sit inside try/catch "should not reach" blocks whose
  catch asserts the error message, so they aren't tautologies.
- **`design/test/feedback-roundtrip.test.ts`:** its server is also a mirror, but the thing
  under test is the generated board JS in a real browser. The daemon file owns the server
  contract. Suggestion: point the browser at the real daemon to remove the mirror.
- **`setup-gbrain-path4-structure.test.ts`:** a grep of template prose, but the prose (token
  never in argv or CLAUDE.md, STOP gates) is the prompt contract itself.
- **`terminal-agent-pid-identity` test 1 (repo-wide no `pkill -f terminal-agent`):** the
  cheapest independent guard for a cross-session kill bug.
- **security-audit-r2 ordering greps (state load, inbox, responsive, CSS validator):** the only
  guard today. Convert them, don't delete them.
- **sidebar-ux "welcome page has left-aligned text":** it encodes a stated user design
  preference, and it's cheap.
### Lane 5

- **Meta-tests guarding real CI contracts (KEEP):**
  - `ci-image-tag-binding` (three-way hashFiles drift causes silent rebuilds)
  - `ci-image-cli-pin` (unpinned CLI broke the PTY harness 3×)
  - `workflow-concurrency` (the generic loop)
  - `free-tests-workflow-wiring` (secretless, no `pull_request_target`, least privilege)
  - `evals-workflow-wiring`, `ci-eval-cache`, `e2e-tier-alignment` (inert-demotion class)
  - `paid-orphan-tripwire`, `eval-budgets-policy`, `eval-detach-timeout-floor`, `periodic-exclude-policy`, `gate-secret-scan`
  - `strict-output*`, `test-free-shards*`, `paid-shards`/`paid-retry-supervision`/`paid-run-manifest`/`paid-selection-propagation`/`paid-overlay-scheduling`/`ci-paid-coordination` (they test the code that decides CI verdicts)
  - `touchfiles-map-diff` (real fail-closed selection logic)
  - `hermetic-wiring` (source grep that is brittle by design, retention bar)
  - `spawnsync-timeout-tripwire` and `parity-suite` (named by AGENTS.md)
  - `llm-judge-frontier` (judge parsing decides eval verdicts)
  - `secret-sink-harness.test` (negative controls run real setup-gbrain bins)
  - `paid-free-boundary`
- **Weak literal pins worth trimming later (not candidates):** `free-tests-workflow-wiring` `max-parallel: 20` + the exact matrix string. `workflow-concurrency` hard-pins `actionlint.yml`/`skill-docs.yml`. `test-free-shards-sandbox-knobs` "Linux caps at 16". `parity-baseline-integrity` pins CHANGELOG headline numbers, a docs-consistency check rather than behavior.
- **Paid-callback replays (26 files, for example `review-n-plus-one-contract`):** tests of tests, but AGENTS.md step 4 explicitly requires them, and they catch broken pass predicates that would otherwise waste paid runs.
- **`test/helpers/claude-pty-runner.unit.test.ts` (3,694 LOC, 223 tests, 0.1 s):** a large self-test of the 5,885-LOC PTY harness. The classifiers it covers (`classifyVisible`, `parseNumberedOptions`, `Step0BoundaryPredicate`…) are live in paid runs, so keep it. The per-capture blocks (`captured F`, `captured G`) belong to the per-incident consolidation lane.
- **Zero-importer helpers** `auq-parallel-worker`, `setup-gbrain-fixture-command`, `emulate-bun-windows-eexist` are loaded by path (preload / generated import). `benchmark-judge` has a production caller (dynamic import in `bin/gstack-model-benchmark`).
- **`browse/src` `__reset*`/`reset*ForTests` exports (12):** standard singleton-reset seams, keep.

## Corrections (2026-10 audit)

Facts above that no longer hold, checked against main at v1.91.19.0:

- `codex-e2e-recommendation-substance` is not census-only: it is no longer in
  `PERIODIC_CI_EXCLUDE` and runs in every periodic census.
- The after-metrics are superseded. Five days after release the free suite had
  regrown by 132 test files and about 53% of serial time; the
  [2026-10 audit](test-audit-2026-10.md) carries current numbers.
- The duration seed again lacked 19 files, including the 115-second
  `claude-overlay-setup.test.ts`, which the planner packed as a short file.
- `browse/test/compare-board.test.ts` stayed quarantined through this audit; its
  16 tests now pass headless and run in the free suite again.
- `ci-image-tag-binding` now pins `evals.yml`, `evals-periodic.yml` and
  `evals-marathon.yml`; `ci-image.yml` is deleted because those workflows push
  the same content-hash tag.
- The weak literal pins listed under Lane 5 are still present.
