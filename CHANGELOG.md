# Changelog

## [Unreleased]

**gstack can remember which model you want your agents on, and every Capy session now reads a one-page summary of how crews work.** Set `agent_model` once (`opus`, another family, or an exact `provider/model`) and `gstack-models resolve --role agent` returns it whenever an agent picks a model for a lane, subagent or reviewer. Unset, every agent keeps its own model, and gstack takes no position for or against any model. A cross-family outside voice and a model under test in an eval ignore the preference on purpose. On Capy the preference lives in `preferences.yaml` beside the gstack skill in your Drive, so it survives fresh machines without being copied anywhere.

### Added
- **`gstack-models resolve --role agent [--request <model>]`**: the agent role. A one-job request wins and is never saved, then `agent_model` in this machine's config.yaml, then the preferences file, then `host`. Output names the winner, both stored values and the exemptions; `list` gains an agent block and `list --json` a top-level `agent` key, with `selections` unchanged.
- **`agent_model`** in `gstack-config`, checked with the same grammar as the resolver: `host`, a family (`opus`, `fable`, `sonnet`, `haiku`, `astra`, `sol`, `luna`, `terra`) or `<provider>/<model>`. A bad value stops only the agent role, naming the file and the fix; plan-review, implementation and eval-arms keep resolving.
- **`capy/skill/gstack/factory.md`**: thirteen practices the Captain crews converged on, each pointing at the rule it summarizes, at most 3,300 bytes. SKILL.md's session start tells every session to read it once.

### Changed
- The Capy session start (`bin/gstack-capy-session`, which updates with the checkout) points `GSTACK_PREFERENCES_FILE` at `preferences.yaml` next to the Drive skill's SKILL.md, and the installer writes it into the launch file. `--check` never writes the skill folder, and the frozen Drive bootstrapper is unchanged.
- SKILL.md allows exactly one write in the skill folder: `preferences.yaml`, when the owner asks an agent to remember a preference.
- `docs/model-policy.md` gains "Your model preference". `docs/captain.md` links factory.md and says to forward an owner's rule for every Captain, in the same turn, to the thread that keeps the account's shared rules.

## [1.91.327.0] - 2026-10-30

**A new page shows how gstack and Capy run as a software factory, with measured numbers.** `capy/README.md` explains how Capy Captains, their crews and gstack's skills fit together, from the plan-first approval loop and `/ship` before READY to merge trains, fix waves, the daily flaky pass and peer Captains. It compares the 14 days after 2026-10-15 with the 14 days before: 197 PRs merged to gstack's main against 65, and 194 versions shipped against 62. It also says what those numbers leave out. The median PR shrank from 1,292 changed lines to 422, and the median time from opening a PR to merging it grew from 1.1 hours to 5.6, because trains batch merges. A footnote gives the windows and the method behind every figure, and the page ends with tips and how Garry uses the setup day to day.

### Docs
- **`capy/README.md`**: the new page (how the pieces fit, the measured before/after, why we think it works, tips, and how Garry uses it).
- The documentation table in `README.md` and the introduction of `docs/captain.md` link to it.

## [1.91.326.0] - 2026-10-30

**/ship reviewers now read one packet file each, and the parent reads a findings record of at most 60 lines instead of every reviewer's transcript.** On this PR's own /ship, pass 2's eight reviewers cost 8.6M tokens on the root counter, against 52.6M for pass 1's eleven (pass 2 read the fix range, pass 1 the whole diff, so the two are not directly comparable).

### Added
- **`gstack-review-packet build`** writes one packet per `DISPATCH:` line of the review plan: the role's instructions and findings contract, its checklists, that reviewer's diff, a plan excerpt, a read budget and the output path. Steps 7 and 8 audits, the specialists, the Red Team, the fix-check and Step 11's adversarial pass and outside voice all dispatch this way. A packet over 200 KB is split by path; no hunk is cut and no path is dropped. Audits are never split.
- Each `PACKET:` line names its `budget_role` and `read=` line ranges of at most 30,000 bytes, and build prints `BUDGET_NEXT: dispatch:<roles>` for `gstack-ship-budget check --next`. A reviewer reads its packet with parallel range reads and finishes in about three calls.
- **`gstack-review-packet collect`** parses, validates and dedupes every reviewer's output, prints one line per reviewer plus each CRITICAL, and writes `merged.jsonl` and `informational.md` for the PR body. Missing or unusable output exits 3 with `REVIEW_COVERAGE_INCOMPLETE`.

### Changed
- Every reviewer prompt lives in `lib/review-prompts.ts`; the resolvers import it, so a packet and the generated SKILL.md prose cannot drift. /review's generated output is unchanged.
- Large `.json`, `.jsonl`, `.ndjson`, `.csv` and `.tsv` changes (over 400 changed lines, not package or config manifests) reach reviewers as a summary built from the diff alone. The testing reviewer and the coverage audit still read data under `test/` or `fixtures/` in full.
- The Capy dispatch paragraph in `capy/skill/gstack/SKILL.md` builds packets, starts reviewers on the shared machine, polls with `transcript: "none"` and returns only collect's output.

### Fixed
- `--base origin/main` no longer becomes `origin/origin/main` in audit prompts.
- A partial build keeps other reviewers' results only at the same head, diff base and diff content; a Red Team build against a changed tree refuses with `STALE_MANIFEST`.
- Collect counts a state-machines matrix record only from the state-machines reviewer, and a CRITICAL line that fails to parse or validate makes its reviewer invalid instead of disappearing.

### Tests
- `test/review-packet.test.ts`: 41 tests covering packet contents, sharding, audits, budget roles, read ranges, data summaries (including a symlinked CSV that must not leak its target), stale manifests and collect's validation. Each fix in this entry has a test that failed before it.

## [1.91.325.0] - 2026-10-30

**A capped /ship on Capy no longer delegates or stops just because the host's own prompt is big, and a delegated child hands off instead of stopping.** A fresh Capy call costs 150-230k before any /ship work, so the 100k start and 150k segment thresholds fired on every capped Capy start and stopped two gstack-evals #36 children at their first boundary. The thresholds now measure context above a calibrated per-host call floor.

### Fixed
- **Thresholds sit above the host call floor.** `lib/ship-budget-calibration.json` gives each meter a `call_floor` (Capy 150k, Claude Code 40k, estimate 0); `start --call-floor <n>` overrides it and children inherit it. `BUDGET:` and `STOP:` lines print `call_floor=` and `above_floor=`.
- **A child never stops on the context rule.** After a completed step it hands its remaining steps to a grandchild through the same handoff, verify, return and reconcile commands (chain depth 3 at most). Before its first completed step, at the maximum depth, or past its segment it continues with one `CONTEXT_HIGH:` line. The admission cap still stops it.
- **A delegated child cannot return complete with work left over.** `return` reports `status=incomplete` with `UNRECONCILED:` or `DROPPED:` lines while one of its own grandchildren is unreconciled or a batch remainder was never re-checked.

### Changed
- **Parallel reviewer batches near the cap admit the largest prefix that fits** (`ADMIT: k of n (remaining=<roles>)`) instead of refusing the whole batch; each reader is priced at the larger of its projection and the run's measured mean for that role. `close` flags remaining roles nobody re-checked (`DROPPED:`, `status=incomplete` until the owner accepts).

### Tests
- `test/ship-budget-chain.test.ts` replays #36 (a child at its first boundary continues) and covers the Capy floor, grandchild handoff at depth 2, the depth-3 cap, charging a chained return once on all three meters, and the incomplete return. `test/ship-budget-batch.test.ts` replays #35's 7-reader batch near the cap.

## [1.91.324.0] - 2026-10-29

**A /ship token cap now projects each step and reviewer from what the run has actually spent, so real caps stop refusing work that costs a fraction of the old guess.** On GSTA-152 a 29.28M cap refused its third reviewer because every dispatch was projected at 7.43M while real ones cost 0.23 to 1.02M; on GSTA-2 an 8M cap stopped before Step 6 after Steps 1 to 5 cost about 0.27M each, because every step was projected at 2.25M.

### Fixed
- **`gstack-ship-budget check`** projects steps and dispatches with the run's own factor once it has measured one: the largest actual/prior ratio of its last three measurements, times 1.5. Before the first measurement the calibrated prior applies, as before. The default tail reserve scales with the step factor; the stop overhead and an explicit `--reserve` do not.
- **Reviewers admitted one at a time no longer stay reserved.** `check --returned <id>` settles the reviewers that came back, `gstack-review-log --finish` settles every dispatch reservation of its step, and a check that moves to the next step settles the dispatches of the step before. `settle` takes `--reading`.
- Charges the meter cannot see (`settle --unknown`, a Claude-metered outside voice) are booked at their reservation and never measured, so they cannot shrink the dispatch factor.
- `gstack-ship-budget handoff` holds back the same calibrated reserve as `check`, so a `verdict=delegate` is always one the handoff admits.

### Changed
- The `BUDGET:` line adds `calibration=step:<f|prior>,dispatch:<f|prior>`. Each measured reservation prints `DRIFT: … projected=<n> actual=<n> ratio=<r>`, and `close` prints `BUDGET_DRIFT:` totals. docs/ship-budget.md has a Calibration section.

### Tests
- `test/ship-budget-projection.test.ts` replays GSTA-2 (an 8M cap now reaches Step 6.5 and still stops with room to stop) and GSTA-152 PR B (the 29.28M refusal is admitted and the run stops before the cap), and covers the settle points, unseen charges and the delegate/handoff boundary. The first 8 tests failed at ad8e12d; the 3 review-fix tests failed at f30c33f.

## [1.91.323.0] - 2026-10-29

### Tests
- `test/review-depth.test.ts`: the #19 shape plans fix-check, Red Team and native adversarial; full depth, a fail-closed classification, `--depth-floor full`, a 151-line, missing or unread range and a gate-touching fix keep the full pass; a forced specialist and changed numbers keep their reviewers; 150, 151 and a docs-only range; the scoped pass counts toward the cap and a blocker it leaves stops; `DEPTH_RULES` moves with the constant.
- `test/review-plan-cli.test.ts`: `--range-base` plans `NEXT: scoped`; a 151-line range, no range, an unknown base and uncommitted fixes plan full.
- `test/review-scope.test.ts`: `raised_by` from the explicit field, the specialist tag or `unknown`.
- `test/ship-receipt-depth.test.ts`: the queue binds a receipt whose pass 2 was scoped.

### Gate integrity
- Addition to the 1.91.316.0 entry below: **Pass 2 after a blocking fix now reviews the fix in proportion to its size.** When pass 1 fixed a blocking finding on a diff below full depth and the fix range has at most 150 runtime lines, /ship runs a scoped pass: one fix-check, the Red Team and the native adversarial pass on the range, instead of the specialist army. On gstack-evals#19 a 3-file fix range (+18/-6) was planned for nine reviewers. Full depth, `--depth-floor full`, a fix that touched a gate path, a larger range, or a range it cannot read keeps the full pass 2. The two-pass cap and the stop for the owner are unchanged.
- Addition to the 1.91.316.0 entry below: **`gstack-review-plan --range-base <sha>`** (`lib/review-depth.ts`): counts the committed fix range `<sha>..HEAD` the way the depth counts runtime lines, prints `FIX_RANGE: runtime_lines=<n>|unread (<why>) base=<sha>` (`fix_range` in `--json`), and `NEXT: scoped` when the scoped pass applies. `nextStep` takes the depth and `History.rangeRuntimeLines`; `SCOPED_RANGE_LINES` (150) joins `DEPTH_RULES`, so `rules=` changes. `REVIEW_PLAN:` ends with the step's `reason="…"`. Uncommitted or untracked edits, a range base that is not an ancestor of HEAD, an empty range, and a range the classifier cannot count all plan the full pass. A full pass 1 always gets a full pass 2: `--pass1-depth` carries pass 1's `REVIEW_DEPTH` (absent counts as full), so a fix that reverts a gate, auth, migration or gate-tagged edit cannot lower pass 2. The fix range is classified with its own `gstack-diff-scope` and `gstack-gate-diff` input, and a gate-class range plans the full pass and sets `fix_range.touched_gate`.
- Addition to the 1.91.316.0 entry below: **Scoped dispatches**: the fix-check, every force-included specialist, the Red Team, the native adversarial pass when the range changes runtime lines, and the outside voice when published numbers changed. Step 11's voices that have not run yet stay listed. A light diff's raise to standard applies to the scoped set only.
- Addition to the 1.91.316.0 entry below: **Step 9** (`ship/sections/review-army.md`): the repeat decision passes `--range-base $PASS_HEAD` and maps `NEXT: scoped` to decision 3; a scoped pass logs a full-pass `review` row with `"scope":"scoped"`, so it counts toward the cap and its roles land in `review_loop.dispatches` with no receipt schema change.
- Addition to the 1.91.316.0 entry below: **`raised_by` on classified findings** (`gstack-review-scope classify`, `lib/review-scope.ts`): the reviewer that raised each finding (`core`, `qa`, a specialist, `red-team`, `adversarial-native`, `outside-voice`, `fix-check`), from the finding's `raised_by` or `specialist` tag, else `unknown`. Step 9 copies it into the review-log row. Older rows without it still summarize.
- Addition to the 1.91.316.0 entry below: **Docs**: docs/review-policy.md (rule 3, the transitions table, a scoped-pass section and Behavior changes) and docs/ship-policy.md rule 3.

## [1.91.322.0] - 2026-10-29

**A PR screen no longer runs the whole paid gate just because a changed file sits on every case's import path.** Editing a file like `lib/restamp.ts` reached all 113 gate cases through the derived-reference closure, so 19 of the 41 full screens between Oct 20 and 29 ran the full $33 gate for that reason alone. A narrow screen (`gstack-ship-queue ready --screen`, and `bun run eval:bg:pr`) now leaves such a file's cases to the train gate's full census, which runs every case before anything merges. Replayed on those 41 screens with today's maps, this saves about $457 a week, and the screens that caught real PR-caused reds (#3434, #3453) still run the full gate.

### Changed
- **Narrow screens** (`scripts/test-pr-profile.ts`, `scripts/lib/paid-select.ts`): a changed file whose derived references reach every gate case and that nothing narrower selects is a hub file. On a narrow screen it selects no case or judge; the paid plan's reason and the coverage summary name it and say the train gate runs those cases. Full-gate files, shared runtime and build inputs, paid-runner inputs, files the derivation cannot place and files deleted by the PR select exactly what they did before. `ready --screen --broad`, `pull_request` runs (the merge gate when the base has no `train` block), the train gate, `eval:bg:gate`, periodic and release runs are unchanged.
- **The READY screen preview** (`lib/ship-queue-train-ready.ts`) and the per-push screening summary now show the narrow screen's selection.
- **`test/size-ledger/**`** is a touchfile of the 20 cases that read `test/helpers/size-ledger.ts` (all periodic or marathon), so a size-ledger baseline change no longer restores the full gate. `careful/bin/mask-commit-message.awk`, loaded only by the free-tested `check-careful.sh` hook, is free-only.

### Tests
- `test/pr-dependencies.test.ts`: a hub-only diff selects nothing on a narrow screen and every gate case on a broad one or with no policy set; a hub beside a shared runtime input, an unknown file or a full-gate file still runs the full gate; a hub beside a direct edit keeps that edit's cases; a deleted file is never a hub; the PR workflow plans narrow only for dispatches; size-ledger baselines select no gate case.

## [1.91.321.0] - 2026-10-29

**Free Tests passes again on Ubicloud runner image 20261026.1.0.** Every Linux job that landed on that image failed the cookie-import Playwright pipe smoke, in-shard and again on the serial retry, and a rerun passed only when it happened to land on the older 20261021.1.0 image. Both images keep `kernel.apparmor_restrict_unprivileged_userns=1`, but 20261026 loads three AppArmor profiles instead of 123, so nothing grants the bundled Chromium a user namespace and its sandbox aborts with `credentials.cc:131 ... Permission denied`. The two Linux jobs that launch Chromium now grant user namespaces to that one binary, the way Ubuntu's own `chrome` profile does.

### Fixed
- **`.github/workflows/free-tests.yml`**: `free-suite` and `quick-bun-default` gain a step after the SUID sandbox helper step. It resolves Playwright's Chromium, refuses any path outside `~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`, and loads an AppArmor profile that grants `userns` to that path alone. The kernel restriction stays on for every other binary. The SUID helper step is unchanged, and no step passes `--no-sandbox` or runs `sysctl`. Diagnostic dispatch 40921806393 ran 17 jobs: all 9 on 20261026 failed the smoke without the profile and passed with it, and all 8 on 20261021 passed throughout.

### Tests
- `test/chromium-sandbox-ci.test.ts`: four cases, two per job, run the real step with stubbed `bun` and `sudo`. They check that the step sits after the helper and before the suite, the exact profile bytes and the `apparmor_parser -r` call, that no protection-lowering flag appears, and that an unexpected Chromium path is refused before any privileged call. They fail against main's workflow.

## [1.91.320.0] - 2026-10-29

**A branch that adds its own pregate lane now learns why it still fails, and `gstack-post pr-body` no longer keeps a stale copy of a section.** Pregate reads its policy from the base branch so a branch cannot loosen its own gate. A branch that had already declared a lane in its own `.gstack/pregate.json` was still told to declare it, and went round in a circle. Separately, a PR body that held `## What changed` twice (an old description pasted under the /ship body) kept the old copy every time /ship reposted.

### Fixed
- **`PREGATE_NO_LANE`**: when the branch edits `.gstack/pregate.json` and the policy comes from the base copy or the user-owned file, the fix line names that policy, says a lane the branch adds counts only once it is on the base, and offers both routes: land the policy change in its own PR first, or rerun with `--policy-from head --allow-repo-commands`, which records the run as unreviewed. Pregate still never reads the branch's policy on its own. (#3574)
- **`gstack-post pr-body`**: when the PR's current body holds a title from the file more than once, it posts nothing, exits 64 and says to rerun with `--replace` and the whole body. /ship's PR-body step stops on that refusal and reports the duplicated titles instead of reposting with `--replace` itself, since a person chooses which copy stays. (#3575)

### Docs
- `docs/troubleshooting.md#pregate-no-lane-own-policy` explains the own-policy case and its two routes; `docs/pregate.md`'s trust boundary links it. The `gstack-post-pr-body-merge` entry covers the duplicate-title refusal.

### Tests
- `test/pregate-selection.test.ts`: the own-policy fix line under the base policy; a head-policy run and a branch that deletes `pregate.json` get the plain fix.
- `test/pregate-user-policy.test.ts`: the own-policy line names the user file as the policy source.
- `test/gstack-post.test.ts`: a doubled title refuses and posts nothing, `--replace` posts the file, and a body with two receipt blocks refuses too.

### Gate integrity
- `test/gstack-post.test.ts`: the duplicate-titles assertion that expected the first copy replaced and the second kept now expects the refusal, plus a case where duplicates the file does not touch are still kept.

## [1.91.319.0] - 2026-10-29

**`gstack-pregate sealed` no longer prints a line that reads like a push confirmation.** On gstack-evals#29 the lane read `pushed aeb2413` in the `SEALED:` line as the push landing, while the remote stayed at 9036ab1 (#3565). `sealed` never pushes: it checks the commits a push would publish. `pushed <sha>` was its label for the commit whose `sealed` policy it read beside the base branch's.

### Fixed
- **`lib/sealed-guard.ts`**: that label now reads `commit <sha12>` (`policy=origin/main + commit aeb2413f0ca1`), in the `SEALED:` line, in the managed pre-push hook's messages and in the unreadable-policy error.
- **`gstack-pregate --help`** and **docs/pregate.md#sealed** say the command never pushes and that `git ls-remote <remote> <ref>` confirms a push.

### Tests
- `test/sealed-guard.test.ts`: `gstack-pregate sealed` names the checked commit, prints no `pushed`, and leaves the remote's refs exactly as they were. It failed before the fix on `policy=origin/main + pushed <sha>`.

## [1.91.318.0] - 2026-10-29

**/office-hours now has eval tasks for the shared skill eval, and /write-skill's diet locks its tasks before a paid run.** gstack-evals' Lane A will re-check the office-hours diet from #3525. To do that it needs office-hours' tasks in gstack's contract format, a sidecar for what Lane A adds, and a diet step that commits the lock a paid run requires. #3525 never committed the task set GSTA-134 ran, so these tasks rebuild it from the pilot's written summary.

### Added
- **`test/fixtures/skill-evals/office-hours/`**: 11 tasks on a CSV-merge idea, with a `seed.sh` that makes the git repo and the `.gstack-home` state root. Nine follow the pilot's set, which covered the mode question, the first startup question, pushback on vague evidence, builder mode, the premise challenge, the second-opinion offer, alternatives, the UI visual step and the backend skip. Two are new safety tasks. One allows no code during a session (the hard gate), and the other allows no design doc before the user picks an approach (the Phase 4 stop). `no-code-mvp` failed in every arm of the pilot and is left out.
- **`tasks.ext.json`** beside it, in Lane A's sidecar format: every task is interactive, with a persona and scripted replies, a judge rubric per behavior task, and a violating `mutant` per safety task. Reply category names are provisional until gstack-evals publishes its list.

### Changed
- **/write-skill diet step 6** starts with `gstack-evals skill-eval --lock` and a commit of `tasks.lock.json`. Without that commit the shared eval refuses a paid run (LOCK_MISSING).
- **`docs/designs/SKILL_EVAL_CONTRACT.md`** adds notes for implementers. The harness should set both `GSTACK_STATE_ROOT` and `GSTACK_HOME` to `<work dir>/.gstack-home`. A verdict may carry an optional `resumable` field. The notes also cover the lock, the sidecar, and an open question about what `must` patterns grade when a host answers an interactive task's questions.

### Tests
- `test/skill-eval-tasks.test.ts` checks office-hours' `tasks.json` against the contract. It also checks that each `tasks.ext.json` entry names a task in `tasks.json` and uses only known keys. No existing test, threshold or allowlist changed.

## [1.91.317.0] - 2026-10-29

**Registered gstack skills now say when to use them where the harness model reads them, and OpenClaw lists the task skills directly.** HARN-5's paid cells showed OpenClaw and Hermes listing gstack's skills while the model rarely opened them. Router lines kept only each skill's first sentence and dropped its "Use when asked to ..." trigger, and Hermes's skills index shows only the first 57 characters of a description, which for gstack was capability prose. This release changes only what gstack writes into its own skills folders. Use rates are not claimed yet: HARN-5's fixed panel measures them next.

### Changed
- **Router lines lead with the trigger** (`gstack-harness`, every router-mode target: OpenClaw, dots, `generic` and `--print`). Each line opens with the skill's own trigger sentence, or, when the description has none, `Use for:` and the skill's `triggers:` list, within 160 characters. The router's description now leads with task verbs (review, debug, QA test, plan, ship) in its first 200 characters, within the 300-character budget. The wording rule lives in `lib/skill-triggers.ts`.
- **Hermes descriptions open with a trigger list of at most 57 characters** (`frontmatter.descriptionLead` in `hosts/hermes.ts`), for example `Use for: review this pr, code review, check my diff.`, followed by the description without its own trigger sentence, which the lead repeats, so no Hermes render grows. Claude Code and every other host render their descriptions as before.
- **OpenClaw registers in `hybrid` mode by default**: `gstack-review`, `gstack-investigate`, `gstack-qa`, `gstack-ship` and `gstack-plan-eng-review` are top-level skills and the `gstack` router carries the rest. Dumped through OpenClaw 2026.10.6's own `buildSkillSnapshot`/`prepareSkillsForPrompt` with its 19 eligible bundled skills, hybrid's skills section is 10,290 characters in full format (budget 18,000). `--skills all` falls to compact format at 17,971 characters, and `--skills router` is 6,701. `--skills router` and `--skills all` remain, and a mode switch now removes the empty folders the previous mode left behind.
- **`--context <file>` is opt-in for OpenClaw and Hermes too**: the block is written only into the file named, after a `gstack-harness: context block: <file> (<profile|project> scope)` line. Setup, upgrades and refresh never add one and do not re-add a block you deleted. A second `--context` file keeps the first, because the ledger keys blocks by file. The block text follows the mode (with `--skills all` it names no router path). Uninstall now restores each file byte for byte (the blank separator line, a missing final newline and a file gstack created are undone).
- `HARNESS_MODE_UNSUPPORTED`'s fix text and docs/hosts.md describe Hermes's listing, not its loader, and docs/hosts.md states registered, listed and used as separate facts.

### Fixed
- Re-registering an OpenClaw, Hermes or dots registration without `--context` (what setup and `gstack-harness auto` do) no longer cuts a block the user opted into.

### Added
- `HARNESS_CONTEXT_REFUSED`: `--context` refuses `SOUL.md` (in any letter case), and for Hermes a new rules file that would outrank rules Hermes loads now: a file of an earlier group (`.hermes.md`/`HERMES.md` before `AGENTS.md` before `CLAUDE.md`), an earlier name in the same folder (`.hermes.md` before `HERMES.md`, `AGENTS.override.md` before `AGENTS.md`), or a `.hermes.md`/`HERMES.md` below one in a parent folder, which Hermes takes as the nearest.

### Gate integrity
- `test/harness-register.test.ts`: three expectations change with the byte-for-byte restore and blocks keyed by file. The generic cut now expects the original bytes, without the extra newline. The second `--context` case now expects both blocks kept and both restored where it used to expect the first block cut. The OpenClaw router case passes `mode: 'router'` because the default is now hybrid. New cases cover router lines, Hermes leads (at most 57 characters), hybrid with mode switches through refresh and uninstall, context opt-in, refusal and scope, the CLI scope line, and Hermes's threat scanner on every block variant. The scanner case runs when `GSTACK_HERMES_SRC` names a Hermes checkout and is skipped otherwise. More new cases cover the same-folder and nearest-parent refusals, pre-blockpad ledgers, refresh keeping a block the user edited, `--json --context` output, and the Hermes check outside a git repository; new `test/skill-triggers.test.ts` covers the wording rule's fallbacks and cuts.
- `test/fixtures/skill-md-size-allowlist.json`: the Hermes pins for `gstack-autoplan` (108,982 to 108,891) and `gstack-plan-eng-review` (128,708 to 128,655) go down to the new render sizes, as the size guard directs.
- New `test/session-kind-marker.test.ts`: a marker-only environment (`GSTACK_SESSION_KIND=spawned`, no `GSTACK_CAPY`) gets the same soft admission from `bin/gstack-install-verdict.sh` and `lib/install-verdict.ts`. A ratchet fails when a file in `bin/`, `lib/`, `hosts/` or `scripts/` reads or sets `GSTACK_SESSION_KIND` outside its 13-file inventory; a planted-reader control and a comments-only control check it.

## [1.91.316.0] - 2026-10-29

**/ship takes a token cap and stops cleanly at it, and long runs hand their heavy segments to fresh-context children.** On gstack-evals#31 a /ship spent 54M tokens against a 25M cap because the cap was only a number in a brief; #26, whose agent read the counter after every step, stopped at 39.40M of 40M. `/ship --token-cap 25M` (or `GSTACK_SHIP_TOKEN_CAP`) now admits each step and dispatch batch only when it fits, and a run started from a long-lived context, or one whose per-call charge passes 150k at Step 7 or Step 12, runs that segment in a fresh child.

### Added
- **`gstack-ship-budget`** (`lib/ship-budget.ts`, `lib/ship-budget-cli.ts`, `lib/ship-handoff.ts`): an admission cap on a per-run token ledger under `<state root>/ship-runs/<run>/` (its own schema; only `withFileLock` is shared with `lib/spend-ledger.ts`). `start`, `check` (the `BUDGET:` line, `verdict=continue|delegate|stop`, a `RESERVATION:` id per admitted step or batch), `settle`/`release`, `handoff`/`launch`/`verify-handoff`/`return`/`reconcile`, `resume` (cap raises need `--approved-by` and the owner's words; `--rebuild-from-record`; restore from a private Drive checkpoint) and `close`. Exit 0 continue/delegate, 3 stop, 2 usage. Each meter is a versioned contract, and there are three: the Capy root counter (`--reading`), Claude Code journal usage (`lib/claude-usage.ts`, bound by `--session` or an echoed nonce) and `--meter estimate`.
- **`gstack-review-log --start ... --reservation <id>`**: under a cap, a dispatch without an unspent, one-shot reservation refuses before launch (`BUDGET_CHECK_SKIPPED`), and `--finish` settles it. Without a cap nothing changes.
- **/ship**: the skeleton's Budget paragraph (`--token-cap`, `--resume <record>`, `--continue <handoff>`) and a new `budget-handoff` section with the meter recipes, reservations, stop and resume, and the delegate flow per host.
- **Result codes** `BUDGET_CAP_REACHED`, `BUDGET_READING_MISSING`, `BUDGET_READING_REJECTED`, `BUDGET_METER_UNAVAILABLE`, `BUDGET_LEDGER_INVALID`, `BUDGET_CHECK_SKIPPED`, `HANDOFF_PIN_MOVED` with docs/troubleshooting.md anchors; `lib/ship-budget-calibration.json` seeded from #19, #26 and #31.
- **Docs**: docs/ship-budget.md (linked from docs/unattended.md), and a paragraph each in the Capy skill's SKILL.md and captain.md.

### Tests
- `test/ship-budget.test.ts`: the cap boundary, batch overshoot, the #31 replay, spend above a reservation, the no-cap path, meters and epochs, exit codes, start and segment delegation, the full handoff chain with an idempotent reconcile, moved pins and a tampered brief, refused and interrupted children, stop and RECOVER, checkpoint restore into an empty state root, ledger rebuild, concurrent ledgers, and an unchanged `gstack-wtree`.
- `test/ship-budget-review-log.test.ts`, `test/claude-usage.test.ts`, `test/ship-budget-calibration.test.ts` (leave-one-out), `test/ship-budget-section.test.ts`.

## [1.91.315.0] - 2026-10-29

### Changed
- **Stacked PRs** (Fixes #3570): after a stack parent lands and the child is retargeted to the base with the base merged in, `carry --base <base>` compares HEAD's product diff against the base with the range the receipt reviewed against the parent branch. That is the recorded `product_patch_id`, or the range against `origin/<parent>` for an older receipt. HEAD's side is its whole product diff against the base, so a parent's `package.json` change that never reached the base refuses too. Equal carries with the reason `stack parent <branch> landed` and rebinds the receipt's `base` to the base; anything else refuses. Until now every stacked child paid a full /ship once its parent merged (gstack-evals#19).

### Tests
- `test/ship-receipt-carry-squash.test.ts`: a child carries after its parent squash-merges and main is merged in, names main as its base, and carries again across a later main merge. A test-only child carries. A child edited after the merge, a parent that never landed, a parent `package.json` change that never reached main, and a merge that keeps the child's tree over the landed parent refuse. An older receipt falls back to `origin/<parent>` and refuses once that branch is deleted.

## [1.91.314.0] - 2026-10-29

**A later autoplan gate that asks nothing new is now answered with the owner's earlier words instead of another round trip.** Captains were carrying approvals across gate revisions by hand (GSTA-140 reused a rev-1 "Do it" on rev 2; ALPH-50 lost about 27 minutes to one), and a replay over 23 recorded runs found 14 later gates, 8 of them holding only post-cap delta items.

### Added
- **Carry-forward** (`lib/autoplan-carry.ts`): when gate_rev N+1 asks nothing new and gate_rev N was fully answered by the owner with `rec` or "do it", gstack answers N+1 with those recorded words and prints `CARRIED: gate_rev=<n> <- gate_rev=<m> …`; anything else prints `CARRY: no (<why>)` and goes to the owner. `--no-carry-forward` on the first `next` turns it off.
- **"do it" covers new low-risk items.** When the owner's own words were "do it", a new item that changes no scope, cost, direction or plan text takes its recommendation, is marked `carried_under: do it`, and is listed in the approval record and the Captain brief as not shown to the owner. A Captain's "do it" never counts.
- **Delta check.** A "plan changed after cap" item gets one reviewer from another model family on the delta first (`CARRY_CHECK:`, `gstack-autoplan check`), within a per-gate spend cap (`--carry-check-cap`, default $5). High or above, no reviewer, an owner answer, or a plan edit after dispatch leaves the gate for the owner and releases the reservation. The verdict is recorded on `gate.json`, the decision rows and `decisions.tsv`.
- **`eli5` in gate.json**: the plan's `## ELI5` and the four approvals-shape sections; `gstack-gate render` opens page 1 with them, and the Captain brief requires `## ELI5` (older runs render as before).
- **`gstack-approvals import --autoplan <dir> --stack b1,b2`** writes the same rows to every branch of a stack, or to none when one branch is unknown.
- **`REVIEW_ESTIMATE:`** on the first `next`: phases, voices, rounds, attempts and the reservation total.

### Changed
- `lib/decision-trail.ts` holds the trail append rules shared by `gstack-decision-trail` and the carry.

## [1.91.313.0] - 2026-10-29

**The PII scanner stops flagging two kinds of ordinary text: a bare power-of-two or hash constant in code, and a package@version-style filename.** Eval artifacts and PR bodies that print a PRNG range or name a versioned results file no longer raise a MEDIUM phone or email finding, and real phone numbers and addresses next to them still report.

### Fixed
- **`lib/redact-patterns.ts`**: `pii.phone.e164` skips a bare number that is exactly a power of two from 2^30 through 2^49, one less than one, or one of eleven well-known 32-bit hash and PRNG constants. The same digits written with a `+`, spaces, dashes, dots or parentheses still report (#3577).
- **`lib/redact-patterns.ts`**: `pii.email` skips a filename whose part after the `@` is a version or tag followed by file extensions no top-level domain uses, or a dotted version followed by an extension that doubles as one. A file named after a real address, an address at a numeric domain such as 163.com, and an address under a top-level domain that doubles as an extension (`.sh`, `.md`) still report (#3576).

### Tests
- `test/redact-constant-and-at-filename.test.ts`: pins both exemptions in both directions, including files named after a real address.

## [1.91.312.0] - 2026-10-29

**An install check run from inside /ship no longer upgrades gstack under it.** /ship's docs step runs `scripts/install.sh --for document-release`. That run fast-forwarded the checkout from 1.91.298 to 1.91.299 in the middle of a lane's /ship, so the receipt writer's rules changed partway through the run (#3571).

### Fixed
- **`bin/gstack-capy-session`**: in install mode, a live workflow lease under 120 minutes old held by the caller's own process chain now skips the self-upgrade: `SELF_UPGRADE: skipped (a gstack run in this session holds a workflow lease on this installation: pid <p> (<age>m <command>), so the upgrade waits until the lease is 120 minutes old; …(UPGRADE_BUSY))`. The install still certifies the installed revision and the trailer stays ok with `behind=`. `bin/gstack-upgrade` deliberately ignores the caller's own lease, and an install started from inside the run passed that check. Each `gstack-skill-start` renews the lease. The age bound matters on Capy, where the leased pid is the machine's long-lived `capy-server`, so a lease is never released by its process exiting. An older lease, or none, upgrades as before, and `GSTACK_UPGRADE_FORCE=1` or a hand-run `bin/gstack-upgrade` still moves the checkout.

### Tests
- `test/capy-skill-wrapper.test.ts`: an install run under a shell that holds a fresh lease leaves HEAD where it was and stays ok. Once that lease is 121 minutes old, with its holder still alive, the same install upgrades. Before this change the first run printed `SELF_UPGRADE: done 1.0.1 -> 1.0.2`.

## [1.91.311.0] - 2026-10-29

**A sealed policy can now refuse `sealed/<set>/tasks.json` while allowing the `MANIFEST.json` beside it, and can catch `HELDOUT/` with a `heldout` glob.** The sealed guard only had deny globs and one-commit waivers, so the gstack-evals layout, which keeps a public manifest of hashes and counts next to its sealed tasks, needed a fresh `.gstack/sealed-allow.tsv` line for every manifest commit (gstack-evals wiki/board/2026-10-28-gsta-9-sealed-manifest-glob-gap.md). Their first draft also wrote `sealed/**`, which never matched their nested `tasks/<id>/sealed/` directories, and garrytan/gstack-evals#3 (dc54796) hand-listed `Sealed/`, `HELDOUT/` and other case variants.

### Added