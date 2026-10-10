INPUT: ceo 2937ab4ea148f3a53969c36337bdca53476892d5f7e8d8b1556bfa8763df6845

Reviewed from the native prompt file (202 lines, 41937 bytes, read in full). Receipts below are from the live checkout at origin/main `91bbd9e` (v1.91.69.0), the plan's stated base.

## Step 0

Mode: SELECTIVE EXPANSION. Expand where the plan under-builds the contract a parent agent depends on (artifact schema, adoption measurement, a session kind that does not collide with the eval harness); hold or defer where it builds breadth no incident in the feedback paid for.

### Premise table

| # | Premise (from the plan) | Receipt | Verdict |
|---|---|---|---|
| 1 | Capy user-scope installer `--check` is a bare `test -x` chain that prints nothing on failure | `~/.capy/drive/user-garry-tan/skills/gstack/scripts/install.sh:7-16` (`test -x ... \|\| return 1` chain), `:32-35` (`--check` calls `check_install; exit 0` with no output on the failure path) | VALID |
| 2 | `bin/gstack-doctor` has one `check_*` row per component, fix lines, exits 1 on `fail` | `bin/gstack-doctor:8-12` (contract), `:441-456` (row calls and `[ "$N_FAIL" -eq 0 ]`) | VALID |
| 3 | Doctor has no `--check`, `--json`, `--require` or Node row | grep of `bin/gstack-doctor` for those tokens: only an unrelated `server-node.mjs` hit at `:296` | VALID |
| 4 | `gstack-session-kind` classifies `spawned \| headless \| interactive`; only `spawned` is honored as an explicit `GSTACK_SESSION_KIND` override | `bin/gstack-session-kind:33-36` (spawned override), `:47-50` (`GSTACK_HEADLESS` → headless), `:59-62` (`CI`/`GITHUB_ACTIONS` → headless) | VALID |
| 5 | `headless` means BLOCK on any question; only `spawned` auto-continues | `scripts/resolvers/preamble/generate-ask-user-format.ts:15` (spawned auto-chooses), `:28` (`headless` → `BLOCKED — AskUserQuestion unavailable`) | VALID |
| 6 | Upgrade/telemetry/lake/proactive prompts are suppressed for `spawned` only | `bin/gstack-skill-start:96` (`if [ "$_SESSION_KIND" != "spawned" ]` around update-check), `:394` (same guard around the emission block) | VALID |
| 7 | Snapshot `init` wraps a raw plan in `## Implementation plan` | `bin/gstack-autoplan-snapshot.ts:413-417` | VALID |
| 8 | Review-log `status`/`unresolved` are model-written; nothing derives them from findings | `bin/gstack-review-log:88-93` (passes the record straight to `bindReview`), `lib/review-evidence.ts:178-186` (binds commit/tree only) | VALID, with a nuance the plan omits: `reviewFreshness` already downgrades `status: clean` with `issues_found > 0` to `UNVERIFIED` at read time (`lib/review-evidence.ts:238-240`). The gap is write-time derivation, not detection. |
| 9 | `gstack-version-bump write` stamps VERSION/package.json/locks with one hard-coded post-write hook | `bin/gstack-version-bump:373-402` (`regenAgentsDigest`, opt-in via `--regen-digest`, hard-coded path) | VALID |
| 10 | `bin/gstack-next-version` already reads the live PR queue and sibling worktrees | `bin/gstack-next-version:78-106` (`claimed`, `siblings`, `active_siblings`, `pickNextSlot`) | VALID |
| 11 | `gstack-evidence` records tree fingerprints | `bin/gstack-evidence:10-13`, `:388-396` (`tree`, `dirty`, wtree TOCTOU guard) | VALID |
| 12 | `ship/sections/measure.md.tmpl:3-16` holds a never-loosen rerun discipline | `ship/sections/measure.md.tmpl:3-7` | VALID |
| 13 | `codex_reviews` defaults to `enabled` | `bin/gstack-config:251` | VALID |
| 14 | Paid evals (Step 6) run before Step 16's cheap generation checks | `ship/sections/tests.md.tmpl:54` (Step 6 evals), `ship/SKILL.md.tmpl:371-389` (Step 16 stage 1 runs declared generation/build commands) | VALID |
| 15 | `/investigate` has no flake, polluter, race or backlog content | grep of `investigate/SKILL.md.tmpl`: one table row `Race condition` at `:165`, no recipe; no flake/polluter/backlog hits | VALID (one-line mention of race, no recipe) |
| 16 | Preregistration/panels/budgets are gstack-internal | `scripts/ship-measure.ts:22-28` (admission budget), `scripts/judge-calibration.ts:42` (`split: 'dev' \| 'heldout'`), `test/helpers/periodic-exclude-data.ts:79-92` (`EVAL_POLICY`) | VALID |
| 17 | Doctor's codex fix line does not name the `OPENAI_API_KEY` login path | `bin/gstack-doctor:186` (`codex login, or export CODEX_API_KEY`), `TODOS.md:1639-1641` (CI-only use of `codex login --with-api-key`) | VALID |
| 18 | `./setup --status` always exits 0 | `setup:146` (`exit 0` unconditionally after status lines) | VALID |
| 19 | `--no-browser` is undocumented; only `GSTACK_SKIP_PLAYWRIGHT=1` exists | grep for `--no-browser` in `setup`: none; `setup:2071-2072` (`GSTACK_SKIP_PLAYWRIGHT`), `setup:1505-1512` (`GSTACK_SKIP_FONTS`) | VALID |
| 20 | `GSTACK_CODEX_MODEL` is honored by `select-model` | `bin/gstack-codex-probe:143-147`, `:456`, `:497` | VALID |
| 21 | No resolver reads `capabilities.questions` (basis for "no capy host") | only `scripts/host-config.ts:178` validates the value; no reader under `scripts/resolvers/` | VALID |
| 22 | Module-size ratchet is 800 lines / 150 per function; `gstack-next-version` 822, snapshot 865, `setup` 4662 must not grow | `test/module-size-ratchet.test.ts:2`; `wc -l`: 822 / 865 / 4662 | VALID |
| 23 | `nativeDispatchPrompt` already exists in `snapshot.json` | `bin/gstack-autoplan-snapshot.ts:661-669` | VALID |
| 24 | Running Bun 1.3.14 vs repo requirement 1.4.2 | `bun --version` → 1.3.14; `package.json:80-81` (`engines.bun: ">=1.4.2"`), `.github/workflows/arm-setup-smoke.yml:33` | VALID (note: `engines` is a range `>=`, not a pin) |
| 25 | "13 of 27 threads ran no gstack workflow beyond the installer" and the causal reading that tooling gaps (not low perceived value) explain it | No artifact in the repo or the prompt file; the plan offers no per-thread reason | UNVERIFIED (the load-bearing premise of the wave) |
| 26 | Effort: A 1.5 d, B 1.5 d, C 1 d, D 1.5 d CC+gstack | No basis given; PR B alone names 5 new binaries, 4 lib modules, 11 pre-gate checks each with a fixture | UNVERIFIED (see Section 3) |
| 27 | `bin/gstack-hermetic-run` can be "reused" by the `hermetic` check | no such file in `bin/`; `buildHermeticEnv()` exists at `test/helpers/hermetic-env.ts` | FALSE as worded (the bin is new; the helper is reusable) |

### What already exists (relevant to scope)

| Capability | Where | Plan's use |
|---|---|---|
| Readiness rows with fix lines and exit 1 on fail | `bin/gstack-doctor:441-456` | A1 adds a mode, not a tool. Correct. |
| Session kind classification and preamble branching | `bin/gstack-session-kind`, `generate-ask-user-format.ts:15-28` | A3 reuses; see Section 6 for the collision. |
| Raw plan wrapping | `bin/gstack-autoplan-snapshot.ts:413-417` | A4 documents it. Correct. |
| Native dispatch prompt in snapshot | `bin/gstack-autoplan-snapshot.ts:661` | A6 exposes it. Correct. |
| Queue-aware next version | `bin/gstack-next-version:78-106` | B2 `--next` wraps it. Correct. |
| Tree/wtree fingerprints | `bin/gstack-evidence:388-396`, `gstack-wtree` | B3 composes them. Correct. |
| Read-time inconsistency guard on review rows | `lib/review-evidence.ts:238-240` | A7 should cite it and add only the write-time derivation. |
| Opt-in code execution posture for repo-declared regen | `bin/gstack-version-bump:373-385` | B4/B8 should inherit it; they currently do not (Section 6). |
| Admission budget, calibration splits, EVAL_POLICY | `scripts/ship-measure.ts:22-28`, `scripts/judge-calibration.ts:42`, `periodic-exclude-data.ts:79-92` | D1 generalizes all three at once. |
| Hermetic env builder | `test/helpers/hermetic-env.ts` | B8 `hermetic` check; the bin wrapper is new. |

### Dream state

A parent agent on any machine runs one install line, greps one `gstack: ok` line, then runs `/autoplan` or `/ship` unattended and receives versioned, schema-checked JSONL it can act on without reading prose, while the owner receives a one-page numbered gate list. The plan's PR A reaches most of that for autoplan. PR B reaches it for ship if the receipt and restamp land together. PRs C and D are breadth that the dream state does not need in this wave.

### Alternatives considered against the plan

1. **Ship PR A alone as the wave, then B trimmed, then measure adoption before C/D.** Rejected by the plan implicitly (four stacked PRs, D1). This review recommends it (Section 1, 3).
2. **A fourth session kind (`unattended`) instead of redefining `headless`.** Not considered by the plan; required (Section 6).
3. **One artifact-schema module with a version field instead of six independently described files.** Not considered; required (Section 2).
4. **Chromium always lazy, dropping `--light` as a user-facing mode.** Not considered; optional simplification (Section 4).
5. **Premise table + three rows instead of 17 reality rows in plan reviews.** Not considered; recommended (Section 4).

## Sections 1-11

### 1. Is this the right problem? Could a reframing yield 10x?

**Finding 1.1 (High): the wave treats "13 of 27 threads ran nothing" as a supply failure and never measures whether PR A changes it.** Premise 25 is unverified; an equally plausible reading is that in a coordinator-driven serial queue, an agent with a working harness still prefers the repo's own tooling because the gstack workflows cost context and time they cannot see the return on. If that is the cause, PR A fixes the install lie and nobody runs autoplan anyway, and PRs B-D build on an unmeasured assumption. Fix: make adoption a release promise. A10 already writes `analytics/autoplan-timing.jsonl`; add a `session_kind` and `consumer` field there and to the ship receipt, and define P7: "of the next 10 Capy threads that install gstack, at least 6 run one headless workflow whose artifacts the parent consumed (grep/jq in the parent transcript)". Gate PR C and D on that number, not on the queue.

The thesis itself (machine-readable first) is right and is the 10x lever: a parent agent that can `jq` a decision list is the product. The reframing that follows is that the artifact contract is the product, and the tools are implementations of it. The plan has it backwards: 17 new binaries, zero schema.

### 2. Are the premises stated or assumed? Which could be wrong?

The repo-level premises are stated and almost all hold (table above; 23 VALID, 1 FALSE as worded, 3 UNVERIFIED). The ones that could be wrong and matter:

**Finding 2.1 (High): six output files, five JSONL shapes, no schema owner, no version field.** `tasks.jsonl` is said to reuse today's per-phase schema; `decisions.jsonl` and `findings.jsonl` list fields inline; the ship receipt is a fenced block; `pregate.json` and `timing.json` are described by example. In six months a parent agent written against PR A's `findings.jsonl` breaks when PR C adds `incident` and PR D adds `contributor`. Fix: one `lib/headless-artifacts.ts` that owns every schema with `schema_version`, exports the TypeScript types, and backs a `bin/gstack-artifact validate <file>` that `phase-close`, `gstack-ship-receipt` and `gstack-pregate` call before writing. Align `findings.jsonl` rows with the review-log row shape so A7's derivation is one function over one type.

**Finding 2.2 (Medium): A7's "becomes impossible" overstates.** `reviewFreshness` already returns UNVERIFIED for `clean` with open issues (`lib/review-evidence.ts:238-240`); the real gap is that the inconsistent row is still written and the log reader trusts the model's `unresolved` count. Fix: scope A7 to "bindReview rejects at write time when `--findings` is given; interactive rows without `--findings` are tagged `status_source: claimed`", and cite the existing read-time guard so a reviewer does not believe detection is new.

**Finding 2.3 (Medium): runtime-pin semantics are underdefined for the machine the promise is made on.** `engines.bun` is `>=1.4.2`, a range (package.json:80-81); the plan's message prints `pinned 1.4.2`. More important, the Capy cloud image ships Bun 1.3.14, so on the default image `--check` can never end `gstack: ok` unless the installer upgrades Bun, and A2 does not say it does. P1 ("on a healthy machine it ends with `gstack: ok`") is then unmeetable on the primary target. Fix: A2 runs `bun upgrade --version <pin>` (or `mise`) when the row fails and the pin is satisfiable, and A1 distinguishes `range` from `exact` pins in the message.

### 3. 6-month regret scenario

**Finding 3.1 (High): the effort table is not credible and the delivery shape depends on it.** PR B is five new binaries (`restamp`, `tree-receipt`, `regen`, `ship-receipt`, `pregate`), four lib modules, a queue-replay test with three PRs, a mirror repo and a CHANGELOG re-header, plus eleven pre-gate checks each with its own fixture, in 1.5 CC-days. PR D is a new skill with thirteen sections and three lib extractions in 1.5 days. If the real multiplier is 3-4x, PRs C and D sit behind A and B for weeks, the stacked base drifts, and the plan's own queue incident (restamp after reorder) hits this wave first, before B2 exists to fix it. Fix: re-estimate per binary with a fixture count; cut PR B to B1, B2 (`--version`, `--next` only; `--after` and `mirror` in a follow-up), B3, B5 and the four pre-gate checks whose incidents the plan actually names fixtures for (`regen`, `strays`, `literals`, `lanes`+pipefail). Ship `guards`, `patches`, `integrator`, `hermetic`, `links`, `lint`, `ratchets` as a second pre-gate PR after one repo has run the first four for a week.

**Finding 3.2 (Medium): the pre-gate becomes a second CI that drifts from the repo's real CI.** `lanes`, `guards`, `platform`, `integrator` re-derive what `.github/workflows/*.yml` already encode. Six months out, a repo changes its CI matrix and the pre-gate still reports `Tiers ran: unit serial` from a stale mapping. Fix: `lanes` and `platform` read the workflow files for the lane list (A1's `runtime pins` already parses them); the pre-gate never carries its own lane taxonomy.

**Finding 3.3 (Medium): seventeen reality rows make plan reviews longer at the moment context budget is the binding constraint.** The plan notes every template edit must clear `test/parity-suite.test.ts` and the budget ratchets but adds 17 conditional rows plus incident notes to four templates. The regret is a plan review that spends its budget on rows whose scope detector misfires (`Transaction semantics`, `Recall`, `Units` need a scope signal that does not exist today). Fix: ship the four rows that this review itself demonstrates value for and that need no scope detection (premise table with receipts, already-done git check, surface check, binding decisions); defer the other 13 to a follow-up gated on scope-detection evidence from `detectDxScope`.

### 4. Alternatives dismissed without sufficient analysis

**Finding 4.1 (Medium): D1 (four stacked PRs) is argued on reviewability, not on the queue cost the plan itself calls an incident.** Stacked PRs in a repo whose `/ship` cannot yet gate ahead (B2 `--after` is in PR B) means PR B restamps by hand after A merges, PR C after B, PR D after C: exactly the "manual stamp edits" P3 promises to eliminate. Fix: land A; land a minimal B (B1+B2 `--next`+B3+B5) next; dogfood on C and D so the queue tool is proven by the wave that ships it.

**Finding 4.2 (Low): `--light` as a user mode versus Chromium always lazy.** D9 picks flag plus lazy install. If `gstack-browser-ensure` exists, the flag is redundant: default installs skip Chromium and the first browser skill installs it. One less mode in the installer, one less `SKIP browser (light mode)` state, and A2 shrinks. Fix: make lazy the default; keep `--with-browser` for machines that want the 86 s up front.

**Finding 4.3 (Low): A9's free-text owner reply grammar (`all except 3=b 7=no`, `d10 yes`, `1a 2a`).** The plan correctly refuses to guess, but five accepted dialects is a parser that grows with every owner. Fix: one grammar (`<id><option>` tokens plus `all`), and the rendered gate list prints the exact reply shape it accepts; the quoted feedback replies become fixtures that must parse under that one grammar or be reported as unparsed.

**Finding 4.4 (Medium): D1 `/eval-plan` is a product, not a section.** Thirteen bullets, three lib extractions (`pricing`, `spend-ledger`, `measure-bar`), a QA soak section and sealed-path self-checks, for one known consumer (gbrain-evals). The alternative never weighed: ship the three steps that prevent spend incidents (preregistration checklist, `$0` stub dry run, priced pilot with the ledger) and leave instrument audit, sealed paths, memory preflight and soak to the repo that needs them until a second consumer appears.

### 5. Competitive risk

Harness vendors (Claude Code, Codex, Capy itself) are converging on native structured subagent protocols and plan modes. The durable advantage gstack can hold is the opinionated artifact contract and the incident-derived checks, not the plumbing. The risk is that a harness ships a native "decision list" format first and gstack's five ad-hoc JSONL shapes become a translation burden. Finding 2.1's single versioned schema module is the hedge: a stable contract a harness can adopt or map to. No further finding; nothing in the plan is uniquely exposed beyond that.

### 6. Risks the plan does not cover

**Finding 6.1 (Critical): redefining `headless` changes behavior for every existing `GSTACK_HEADLESS` and CI session.** Today `GSTACK_HEADLESS` (set by the eval/E2E harness, `bin/gstack-session-kind:47-50`) and `CI`/`GITHUB_ACTIONS` (`:59-62`) both classify as `headless`, and `headless` means BLOCK on any question (`generate-ask-user-format.ts:28`). A3 makes `headless` take the recommended option and continue. Every paid eval and E2E case that today proves a skill BLOCKS correctly at a question would instead auto-continue, which changes measured behavior under the same case names and silently rewrites what a PASS means. The plan's own validation discipline (AGENTS.md "never rejudge a failure to manufacture a pass") is violated by construction. Fix: add a fourth kind, `unattended`, honored only as an explicit `GSTACK_SESSION_KIND=unattended` override; leave `headless` semantics untouched; the autoplan headless section and `{{HOST_ADAPTATION}}` key on `unattended`. The Capy installer and skill set `unattended`. Rename P2's wording accordingly.

**Finding 6.2 (High): pin files that execute repo-declared commands drop the opt-in posture `gstack-version-bump` deliberately adopted.** `.gstack/generated.json` commands (B4), `.gstack/pregate.json` guard patterns and ratchet commands (B8), and `release_tool` (B1/B2) all run code from the target repo. `bin/gstack-version-bump:373-385` explains why the same class of action is behind `--regen-digest`: presence-sniffing in a hostile clone is arbitrary code execution. Fix: `gstack-regen`, `gstack-pregate` and `gstack-restamp` run declared commands only when invoked from `/ship` or with `--allow-repo-commands`; standalone invocations list the commands and exit 3 with `repo commands not executed (pass --allow-repo-commands)`.

**Finding 6.3 (Medium): B3's "same-modulo-stamps" verdict depends on `stamp_paths` listing everything `release_tool` touches.** A repo's restamp script that regenerates a lockfile or a docs index outside `stamp_paths` produces `TREE: changed gate=required`, and P3's "a tree that already passed never gets a second gate" fails for exactly the repos the policy was built for. Fix: the receipt classifies the diff against `stamp_paths` plus `.gstack/generated.json` paths, and reports the residual set by name.

**Finding 6.4 (Medium): B2 `--after <pr>` merges the predecessor's head into the branch.** Under `history: squash-ok` the PR then shows the predecessor's commits until it merges, and a later predecessor force-push leaves a merge commit the receipt's `PREDECESSOR MOVED` refusal cannot undo. Fix: gate-ahead builds the predecessor merge in a throwaway worktree (`gstack-wtree` already exists), gates there, records the predecessor head in `gate-ahead.json`, and never touches the PR branch's history.

**Finding 6.5 (Medium): D3 auto-detects contributor mode from "the maintainer set" that nothing defines.** Fix: read `CODEOWNERS` when present, else `gh api repos/:owner/:repo/collaborators` with push permission, else off; record the source in the finding.

**Finding 6.6 (Low): A2's thin wrapper "fetches the repo script"** before the repo exists on the machine. Fix: the wrapper clones (or reuses) the repo under the existing lock and then executes `bin/gstack-capy-install` from the clone; say so, because that is the only path that does not depend on a raw-content URL.

### 7. Scope: NOT in scope (confirmed and additions)

The plan's four exclusions hold and are correctly reasoned (capy host target verified against premise 21). This review adds: `--after`/`mirror` in B2, seven of eleven pre-gate checks, thirteen of seventeen reality rows, ten of thirteen `/eval-plan` bullets, and the free-text gate grammar dialects. See Required outputs.

### 8. Release promises vs. delivery

P1, P2 (with `unattended`), P3 (with 6.3/6.4), P4 (trimmed) are deliverable and testable as stated. P5 is deliverable at four rows. P6 is three products in one promise; split it into P6a (lane-check and evidence bundle, cheap and consumed by the coordinator today) and defer P6b (`/eval-plan`) and P6c (owner brief beyond the gate list, which A9 and D3's first paragraph already give). Nothing flagged beyond that.

### 9. Validation plan

Validation item 2 (headless autoplan end to end on this plan with an API-key Codex login) is the strongest proof in the document and should be the PR A merge gate. Item 3's queue replay is good but must include the squash-history case (6.4) and a `release_tool` that touches a non-stamp path (6.3). Item 1's incident fixtures need the incident-to-test map committed as a file (`test/fixtures/multi-agent-wave/INCIDENTS.md`) rather than a PR body, or it is lost on merge. Low; no further flag.

### 10. Gate decisions D1-D10 (auto-decided per instruction, recommended option taken unless amended)

D1 four stacked PRs: taken as recorded, amended by 3.1/4.1 (A, then minimal B, then C/D gated on adoption). D2 session kind not host: taken, amended by 6.1 (`unattended`, not `headless`). D3 installer in repo: taken. D4 `.gstack/*.json` pin files: taken, amended by 6.2 (opt-in execution). D5 pre-gate blocks by default: taken for the four shipped checks. D6 never approves: taken. D7 `/eval-plan`: taken as the name, scope amended by 4.4. D8 forced-CRITICAL list: taken. D9 lazy Chromium: taken, amended by 4.2 (lazy by default). D10 contributor mode on by default: taken, amended by 6.5 (defined maintainer source).

### 11. Trajectory and compounding

If PR A lands with a versioned artifact module and an adoption metric, every later tool has a contract to write to and a number to justify itself against. If it lands as specified, the wave compounds the wrong thing: more binaries over an unversioned contract, measured by nothing. That is the only strategic fork in the document.

## Required outputs

### NOT in scope (this wave)

- A `capy` host target (plan's exclusion, verified: `scripts/host-config.ts:178` is the only reader of `capabilities.questions`).
- Installing semgrep/gitleaks; native Windows `/cso`; closing issues from `investigate --backlog` (plan's exclusions, hold).
- B2 `--after <pr>` and `mirror` (deferred until B2 `--version`/`--next` has one week of use).
- Pre-gate checks `guards`, `patches`, `integrator`, `hermetic`, `links`, `lint`, `ratchets` (second pre-gate PR).
- Reality rows other than premise table, already-done, surface check, binding decisions.
- `/eval-plan` beyond preregistration checklist, `$0` stub dry run, priced pilot with ledger; QA soak section.
- Owner-reply dialects beyond one grammar.

### What already exists

See the Step 0 table. Net: every P0 item is a mode, a derivation or a composition over an existing tool, which is the right shape; the plan correctly avoids rebuilding doctor, next-version, evidence or the snapshot.

### Error & Rescue registry

| Error | Where | Rescue |
|---|---|---|
| `gstack: fail <components>` | A1 `--check` | Each FAIL row carries the exact command; installer reruns `--check` after fixing. |
| `FAIL runtime pins` on the default Capy image (Bun 1.3.14) | A1/A2 | Installer upgrades Bun when the pin is satisfiable (2.3); otherwise the row names the image. |
| `BLOCKED — AskUserQuestion unavailable` under `GSTACK_HEADLESS` | A3 as written | Preserved by introducing `unattended` (6.1); evals keep today's semantics. |
| `AUTOPLAN_RESULT: gate_pending` | A4 | Parent reads `decisions.jsonl`; never auto-approved (D6). |
| `review-log: status mismatch` exit 2 | A7 | Caller re-derives from `findings.jsonl`; interactive rows tagged `status_source: claimed`. |
| `artifact: schema_version N unsupported` | new `gstack-artifact validate` (2.1) | Parent upgrades gstack or pins the reader. |
| `repo commands not executed (pass --allow-repo-commands)` exit 3 | B4/B8/B2 standalone (6.2) | `/ship` passes the flag; operators opt in explicitly. |
| `TREE: changed gate=required (<paths>)` after a pure restamp | B3 | Receipt names residual paths; add them to `generated.json` or `stamp_paths` (6.3). |
| `PREDECESSOR MOVED <old> -> <new>` | B3 | Re-run gate-ahead in the throwaway worktree (6.4). |
| Spec loop at cap without 7+ | A8 | Headless default: one cheap pass over the listed issues; approval gate blocked by `spec not re-verified`. |
| Outside voice auth failure in unattended | A5 | `gstack-codex-login` from `OPENAI_API_KEY`; policy text names it. |

### Failure Modes registry

| Failure mode | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Eval semantics silently change under `headless` (6.1) | High if shipped as written | Critical: PASS redefined without a case change | Fourth kind `unattended`. |
| Artifact schema drift across PRs A-D (2.1) | High | High: parent agents break | One versioned schema module + validator. |
| Repo-declared command execution in untrusted clones (6.2) | Medium | High | Opt-in flag, exit 3 standalone. |
| PR A ships, adoption unchanged (1.1) | Unknown, unmeasured | High: wave built on a false premise | Adoption metric as P7; gate C/D on it. |
| Effort 3-4x the table (3.1) | High | Medium: C/D rot, manual restamps of the wave itself | Trim B; A then minimal B. |
| Pre-gate lane taxonomy drifts from CI (3.2) | Medium over 6 months | Medium | Derive lanes from workflow files. |
| Review context budget exceeded by 17 rows (3.3) | Medium | Medium: parity-suite red or review quality diluted | Four rows now. |
| `same-modulo-stamps` never true for repos with a regenerating release tool (6.3) | Medium | Medium: P3 unmet | Classify against generated registry too. |
| Bun pin unmeetable on default image (2.3) | Certain today | Medium: P1 unmet on primary target | Installer upgrades Bun. |

### Dream state delta

Dream: one install line, one grep, unattended autoplan/ship with versioned artifacts, owner sees a numbered gate list. Plan as written reaches: install line and grep (A1/A2), unattended autoplan (A3/A4, once 6.1 is fixed), owner gate list (A9/D3). Missing from the plan: the versioned contract (2.1) and the proof anyone drives it (1.1). Over-reaching relative to the dream: eleven pre-gate checks, seventeen rows, thirteen eval-plan bullets.

### Completion Summary

- Premises checked: 27; VALID 23, FALSE as worded 1 (#27), UNVERIFIED 3 (#25 adoption cause, #26 effort, and the range-vs-pin nuance in #24 counted under VALID).
- Findings: 1 Critical (6.1), 5 High (1.1, 2.1, 3.1, 6.2, and 3.1's shape consequence in 4.1 counted once), 9 Medium, 4 Low.
- Unverified claims remaining in the plan after this review: 2 (adoption cause, effort table).
- Gate decisions auto-decided: 10 of 10, 6 amended.

## Scores

| Dimension | Score | Note |
|---|---|---|
| Premises valid | 8 | Repo facts are right; the wave's causal premise is unmeasured. |
| Right problem | 8 | Machine-readable-first is the correct thesis; the contract should be the product. |
| Scope calibration | 4 | ~17 binaries, 1 skill, 4 schemas, 17 rows in 5.5 claimed days. |
| Alternatives explored | 6 | D1-D10 are real decisions; the trim-and-measure path and `unattended` were not weighed. |
| Risks covered | 5 | Headless/eval collision and repo-command execution are uncovered. |
| 6-month trajectory | 6 | Strong if the schema and metric land in A; weak if breadth lands first. |

## Tasks

```json
[
  {"id": "T1", "priority": "P1", "component": "session-kind", "title": "Add `unattended` session kind as an explicit override; leave `headless` semantics unchanged; key autoplan headless section and HOST_ADAPTATION on it", "files": ["bin/gstack-session-kind", "scripts/resolvers/preamble/generate-ask-user-format.ts", "bin/gstack-skill-start", "test/gstack-session-kind.test.ts", "test/gstack-skill-start.test.ts", "test/spawned-consent-rule.test.ts"], "effort_human": "3 days", "effort_cc": "3 hours", "source_finding": "6.1"},
  {"id": "T2", "priority": "P1", "component": "artifacts", "title": "One versioned schema module for tasks/decisions/findings/timing/pregate/ship-receipt with `gstack-artifact validate`", "files": ["lib/headless-artifacts.ts", "bin/gstack-artifact", "lib/autoplan-export.ts", "lib/review-evidence.ts", "test/headless-artifacts.test.ts"], "effort_human": "1 week", "effort_cc": "5 hours", "source_finding": "2.1"},
  {"id": "T3", "priority": "P1", "component": "measurement", "title": "Adoption metric P7: record session_kind and consumer in autoplan-timing.jsonl and the ship receipt; gate PRs C/D on it", "files": ["lib/autoplan-export.ts", "bin/gstack-ship-receipt", "docs/TESTING_INTERNALS.md"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "1.1"},
  {"id": "T4", "priority": "P1", "component": "pin-files", "title": "Repo-declared commands (generated.json, pregate.json, release_tool) run only under /ship or --allow-repo-commands; standalone exits 3", "files": ["lib/regen.ts", "lib/pregate/index.ts", "lib/restamp.ts", "bin/gstack-regen", "bin/gstack-pregate", "bin/gstack-restamp"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "6.2"},
  {"id": "T5", "priority": "P1", "component": "delivery-shape", "title": "Re-estimate per binary with fixture counts; cut PR B to B1, B2 (--version/--next), B3, B5 and pre-gate checks regen/strays/literals/lanes", "files": [".gstack/tmp/autoplan/*/ceo-implementation.md"], "effort_human": "1 day", "effort_cc": "1 hour", "source_finding": "3.1, 4.1"},
  {"id": "T6", "priority": "P2", "component": "installer", "title": "Installer upgrades Bun when the pin is satisfiable; runtime-pins row distinguishes range from exact pins", "files": ["bin/gstack-capy-install", "lib/runtime-pins.ts", "bin/gstack-doctor", "test/gstack-doctor.test.ts"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "2.3"},
  {"id": "T7", "priority": "P2", "component": "tree-receipt", "title": "Classify the receipt diff against stamp_paths plus generated.json paths; name residuals", "files": ["lib/tree-receipt.ts", "bin/gstack-tree-receipt", "test/gstack-restamp-queue.test.ts"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "6.3"},
  {"id": "T8", "priority": "P2", "component": "restamp", "title": "Gate-ahead in a throwaway worktree; never merge the predecessor into the PR branch; add squash-history replay case", "files": ["lib/restamp.ts", "test/gstack-restamp-queue.test.ts"], "effort_human": "3 days", "effort_cc": "3 hours", "source_finding": "6.4"},
  {"id": "T9", "priority": "P2", "component": "plan-reviews", "title": "Ship four reality rows (premise table, already-done, surface check, binding decisions); defer 13 behind scope-detection evidence", "files": ["scripts/resolvers/plan-reality.ts", "plan-eng-review/SKILL.md.tmpl", "plan-ceo-review/SKILL.md.tmpl", "autoplan/sections/*.tmpl", "test/parity-suite.test.ts"], "effort_human": "3 days", "effort_cc": "3 hours", "source_finding": "3.3"},
  {"id": "T10", "priority": "P2", "component": "review-log", "title": "Scope A7 to write-time derivation; tag rows without --findings as status_source: claimed; cite existing read-time guard", "files": ["lib/review-evidence.ts", "bin/gstack-review-log", "test/review-evidence.test.ts"], "effort_human": "1 day", "effort_cc": "1 hour", "source_finding": "2.2"},
  {"id": "T11", "priority": "P2", "component": "pregate", "title": "Derive lanes and platform tiers from .github/workflows/*.yml rather than a pre-gate-owned taxonomy", "files": ["lib/pregate/lanes.ts", "lib/runtime-pins.ts"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "3.2"},
  {"id": "T12", "priority": "P3", "component": "review", "title": "Define the maintainer set source for contributor mode (CODEOWNERS, then collaborators API, else off) and record it", "files": ["review/SKILL.md.tmpl", "bin/gstack-issue-guard"], "effort_human": "1 day", "effort_cc": "1 hour", "source_finding": "6.5"},
  {"id": "T13", "priority": "P3", "component": "installer", "title": "Make Chromium lazy by default via gstack-browser-ensure; replace --light with --with-browser", "files": ["bin/gstack-capy-install", "bin/gstack-browser-ensure", "scripts/resolvers/browse.ts", "setup"], "effort_human": "2 days", "effort_cc": "2 hours", "source_finding": "4.2"},
  {"id": "T14", "priority": "P3", "component": "gate-list", "title": "One reply grammar for the gate list; quoted owner replies become parse fixtures", "files": ["lib/gate-list.ts", "bin/gstack-gate", "test/gate-list.test.ts"], "effort_human": "1 day", "effort_cc": "1 hour", "source_finding": "4.3"},
  {"id": "T15", "priority": "P3", "component": "eval-plan", "title": "Cut /eval-plan to preregistration checklist, $0 stub dry run, priced pilot with ledger; defer the rest", "files": ["eval-plan/SKILL.md.tmpl", "lib/spend-ledger.ts", "lib/pricing.ts"], "effort_human": "1 day", "effort_cc": "1 hour", "source_finding": "4.4"}
]
```

Recommendation: Proceed with PR A amended (an `unattended` session kind instead of redefining `headless`, one versioned artifact-schema module, and an adoption metric as a release promise), then a trimmed PR B, and defer the bulk of C and D until adoption is measured, because the repo-level premises hold and the thesis is right, but as written the wave silently changes eval semantics for every `GSTACK_HEADLESS` session and builds seventeen binaries over an unversioned contract that nothing proves a parent agent will drive.
