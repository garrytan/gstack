INPUT: eng d7365d9256d2c956908fce530731115816ab6b477152e78602fc69d51fd14b17

Read receipt: `/workspace/gstack/.gstack/tmp/autoplan/autoplan-eng-JwMe0e/native-prompt.md`, 230 lines, 67384 bytes, SHA-256 `77ee24a4…3511f` (matches the dispatch); the six lines over 2000 chars (54, 58, 65, 74, 100, 102) were re-read in full via `sed`. Every file:line below was opened on `origin/main 91bbd9e` (v1.91.69.0) in `/workspace/gstack`.

Prior-phase decisions treated as binding: UC1 (tiered scope, P7 gate), B0 (one artifact contract + validator), B1 (`unattended` as a fourth kind), C1 (repo commands opt-in), C3/D11 (gate reuse on identity), B2 (one runner), A1 (one doctor table), A2 (Bun preflight), C2 (stamp-at-merge, restamp journal), hunk-level receipts, GSTACK_RESULT grammar, gate-list ids/pagination/gate_rev, two-stage pre-gate. Where the plan's own premise table is wrong I say so with the receipt; the plan's D1 "premise table" row would have caught two of these.

## Scope Challenge

**What already exists (verified).** `bin/gstack-doctor` is 456 lines of Bash 3.2 with one `check_*` per row, `--live`, exit 1 on `fail` / 2 on usage (bin/gstack-doctor:3-16, :35-40, :442-454). `bin/gstack-session-kind` classifies `spawned|headless|interactive` with the explicit override only honoring `spawned` (bin/gstack-session-kind:33-36); `bin/gstack-skill-start:93` whitelists exactly those three and coerces anything else to `interactive`. The preamble's AUQ rule branches on the same three (scripts/resolvers/preamble/generate-ask-user-format.ts:15-29). `lib/state-root.ts:22-29` owns the chain and `test/state-root-ratchet.test.ts` rejects hand-rolled chains and bare `~/.gstack` prose. `bindReview` is the single write choke point and `reviewFreshness` already downgrades `issues_found > 0` at read time (lib/review-evidence.ts:178-186, :238-240); the bash wrapper swallows binding errors as `invalid JSON` (bin/gstack-review-log:88-96). `gstack-version-bump write` has one opt-in post-write hook with the exact trust rationale C1 wants to generalize (bin/gstack-version-bump:373-402) and a half-write recovery path (:483-495). `gstack-evidence` records `tree`/`wtree` and compares changed paths against an allow-list by filename (bin/gstack-evidence:388-396, :498-512) and is machine-local by design (:27-30). `outsideVoiceFor` picks the provider from `ctx.host` at render time (scripts/resolvers/outside-voice.ts:8-12). The spec-review loop stops on PASS / repeats / third launch and "a missing score alone does not require another review" (scripts/resolvers/spec-review.ts:186-192). The autoplan publication hook renders only for `host === 'claude'` and denies when the file is absent (scripts/resolvers/composition.ts:11, :16-23); the shell backstop denies when the TS half fails (autoplan/bin/phase-publication-hook:4-9). `lib/gate-outcomes.ts:1-18` is the reason-code contract with a `docs/troubleshooting.md` anchor test (`test/troubleshooting-anchors.test.ts`). `setup` honors `GSTACK_SKIP_PLAYWRIGHT=1` (setup:2071-2072) and `GSTACK_SKIP_FONTS=1` (setup:1512), prints a checksum-verified Bun install recipe when Bun is missing (setup:296-305), and `--status` always exits 0 (setup:136-146). Section manifests exist for 21 skills and are documented as PASSIVE registries with no machine predicate (autoplan/sections/manifest.json:5). `investigate/` has no `sections/` dir (278-line monolith; parity ratio 0.787 of a 1.12 cap, so it has room).

**What the plan rebuilds vs. extends.** PR A extends doctor/setup (right call). PR B's B7/B8/B9/B12 extend existing choke points (right call). PR B's B2/B3 are new subsystems disguised as "thin": a prompt-assembling, dispatching, resumable state machine (B2) and a runtime outside-voice runner (B3) where today only render-time prose exists. PR C is almost entirely new code (restamp, receipt, regen, pregate, ship-policy, ship-receipt, evidence bundle): seven libs and six bins is a realistic count, and the queue-replay fixture alone is a multi-repo harness. PR D is template + resolver work with budget consequences (Section 4). PR E is tier-3 except E1 tier 1 and the E2 bundle, which C3 already pulls forward.

**Complexity check (my estimate, `[estimated]`, counting what the text implies rather than the table's "3/1/8").**

| PR | New bins | New libs | Template/resolver edits | Fixtures | Est. LOC | Fits one review sitting? |
|---|---|---|---|---|---|---|
| A | `gstack-capy-install`, `gstack-browser-ensure` (+ doctor `--check/--for/--require/--json/--project`) | `runtime-pins.ts`, component table (see F5 on language) | setup `--no-browser`, `--status` exit, browse preflight | ~10 (healthy, each missing, wrong host, no auth, range vs exact pin, Windows lane pin) | 900-1200 | yes |
| B | `gstack-artifact`, `gstack-autoplan`, `gstack-gate`, `gstack-codex-login`, (+ `gstack-outside-voice`, F2) | `headless-artifacts.ts`, `autoplan-export.ts`, `autoplan-run.ts`, `gate-list.ts`, `outside-voice-api.ts` | preamble (unattended), skill-start, session-kind, autoplan skeleton + `sections/unattended`, 4 checklists, spec-review, review-evidence, review-log, phase-close | ~20 | 3500-5000 | **no** — B2+B3 alone are a PR |
| C | `gstack-restamp`, `gstack-tree-receipt`, `gstack-regen`, `gstack-pregate`, `gstack-ship-receipt`, `gstack-hermetic-run` | `ship-policy.ts`, `restamp.ts`, `changelog-check.ts`, `tree-receipt.ts`, `regen.ts`, `pregate/*` (≥6 files), `md-links.ts`, evidence bundle | ship Steps 3/5/12/16/18, land-and-deploy, tests.md.tmpl | ~16 + a 3-PR multi-repo replay | 4000-6000 | **no** — pregate and restamp are separate review sittings |
| D | — | `plan-reality.ts` resolver | 6 template files | ~12 | 600-900 | yes, but every edit lands on a zero-headroom skill (Section 4) |
| E | `gstack-lane-check`, `gstack-banned-terms`, (`gstack-evidence verify`) | `lane-ownership.ts`, `spend-ledger.ts`, `pricing.ts`, eval-plan sections | new skill + qa/ship sections | ~10 | 1500-2500 | yes (tier 1 only) |

**PR count vs the repo's own constraints.** The repo has no hard PR-count rule, but it has three byte-level ratchets that bite per PR (parity, context-budget, skill-size) and a release process where every PR is a full gate. Five PRs is the right *shape*; two of them are the wrong *size*. Recommended split (keeps D1(a) in spirit, seven PRs, not ten): B → B-core (B0, B1, B7, B9, B12, B10) and B-runner (B2, B3, B4, B8, B11); C → C-stamp (C1, C2, C3, C5, C7) and C-pregate (C4, C8, C6). Each half is still shippable alone and the queue cost is two extra gates, which the pre-gate PR is designed to make cheaper. Record as decision E1 below.

## Section 1 Architecture

```
 parent agent (Capy thread / coordinator)
   | GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=<p> GSTACK_EPHEMERAL=1
   v
 bin/gstack-capy-install ──> ./setup --host claude|codex (--no-browser) ──> bin/gstack-doctor --check --for <skill>
   |                                                                          ^ table: doctor-components (F5: bash, not TS)
   |                                                                          ├─ lib/runtime-pins.ts  <── <project>/package.json, .tool-versions, .github/workflows/*.yml
   |                                                                          └─ bin/gstack-browser-ensure (lazy Chromium)
   v
 bin/gstack-autoplan {run|next|submit|status|answer|resume} ── lib/autoplan-run.ts (state machine; F1)
   |   reads: autoplan/sections/*.md (+ scope field, F9), snapshot.json (nativeDispatchPrompt), gate list
   |   writes: --out/<run>/{plan.md, review-record.md, tasks.jsonl, decisions.jsonl, findings.jsonl, timing.json, run.json}
   |           via lib/headless-artifacts.ts  <── bin/gstack-artifact {validate|schema|ack}
   |   outside voice: bin/gstack-outside-voice --runner codex-cli|api|host-subagent (F2) ── lib/outside-voice-api.ts
   |   review log:    bin/gstack-review-log --findings findings.jsonl ── lib/review-evidence.ts bindReview (B7)
   |   gate:          bin/gstack-gate {render|parse} ── lib/gate-list.ts (ids, gate_rev, pages)
   |   state root:    $GSTACK_STATE_ROOT/analytics/autoplan-timing.jsonl   (EPHEMERAL on Capy — F3)
   v
 /ship (Step 5)  bin/gstack-pregate ── lib/pregate/{index,regen,secrets,strays,literals,lanes,import-graph,...}.ts
   |                 pins: .gstack/pregate.json  .gstack/generated.json (read from origin/<base>, F12)
   |                 writes: pregate.json (schema via headless-artifacts)
 /ship (Step 12/16/18)
   bin/gstack-restamp --queue-mode stamp-at-merge --next|--version|--after <pr> ── lib/restamp.ts, lib/changelog-check.ts
   |     pins: .gstack/ship-policy.json (lib/ship-policy.ts)   journal: .gstack/tmp/restamp-journal.json   gate-ahead: .gstack/tmp/gate-ahead.json
   |     calls: bin/gstack-version-bump write, <release_tool> (opt-in), bin/gstack-regen --write, mirror
   bin/gstack-tree-receipt --from gate-ahead.json ── lib/tree-receipt.ts  <── bin/gstack-evidence bundle (portable), gstack-wtree
   |     verdict: TREE: same-modulo-stamps | changed (<paths>)   gate-reuse: eligible | not-eligible (<what>)
   bin/gstack-ship-receipt ── fenced ```gstack-ship-receipt``` (first PR-body section) ── /land-and-deploy read --json
```

**Module-size ratchet risks (corrected).** The plan's premise that `bin/gstack-next-version` (822), `bin/gstack-autoplan-snapshot.ts` (865) and `setup` (4662) are capped by `test/module-size-ratchet.test.ts` is false: the fixture caps 47 `newModules` and 4 `residualFiles`, none of which are those three (test/fixtures/module-size-ratchet.json; the residual list is `scripts/test-free-shards.ts`, `scripts/test-paid-shards.ts`, `browse/src/server.ts`, `test/helpers/claude-pty-runner.ts`). Keeping those bins thin is still good hygiene, but the real ratchet exposure is on files the plan edits and does not name: `scripts/resolvers/plan-gates.ts` (571/800, D2 adds the `Undeclared behavior changes` line), `scripts/resolvers/spec-review.ts` (288/800, B8), `autoplan/bin/phase-publication-hook.ts` (B1), `scripts/lib/measure-bar.ts` (E1), `scripts/resolvers/outside-voice-steps.ts` (B3). All five are in `newModules`, so the 150-line function cap applies to every function touched. New `lib/*` files are *not* ratcheted unless added to the fixture; the plan's "each under 150 lines" for `lib/pregate/*` is unenforced until it adds them.

**State-root compliance.** Every new path in the plan goes through `GSTACK_STATE_ROOT` or a parent-chosen `--out` dir, which is correct. Two traps: (1) templates and resolvers must use the `gstack-paths --get GSTACK_STATE_ROOT` form with the `:?` guard or `test/state-root-ratchet.test.ts` fails on the first fence (test/state-root-ratchet.test.ts:18-25); (2) `docs/unattended.md` must not write `~/.gstack` in prose (PROSE_ROOT regex, :20) — write `$GSTACK_STATE_ROOT`. The `--out` directory is outside the chain by design; `run.json` should record `state_root` and `state_root_durable` so the validator can say which artifact class landed where.

**Generated-template compliance.** All prose edits are `.tmpl` + `bun run gen:skill-docs --host all` (scripts/gen-skill-docs.ts:34, :116 supports `all`). The new `{{HOST_ADAPTATION:unattended}}` and `{{PLAN_REALITY_ROWS}}` and `{{COORDINATOR_CONTRACT}}` resolvers must be registered in `scripts/resolvers/index.ts:52` and will be rendered into every host, so each costs bytes on every skill that includes it (Section 4). B4's `scope` field on `sections/manifest.json` reverses the documented passive-registry design (autoplan/sections/manifest.json:5 "No machine predicate here — see docs/designs/v2_PLAN.md:663"); `test/qa-lazy-sections.test.ts:127` asserts passive resolution without inlining. The reversal is defensible for an unattended runner that assembles prompts itself, but the plan must update the note, the `$schema`, and that test rather than add a field nobody reads.

## Section 2 Edge cases and failure modes

Registry (critical gap = no test AND no handling AND silent, marked ★):

| # | Mode | Detection | Handling in plan | Test in plan | Gap |
|---|---|---|---|---|---|
| 1 | `--check` piped through `tail`, caller sees pipe status | trailer line + non-zero exit | A1 prints trailer on every path; SKILL.md says never pipe | doctor fixtures on trailer tokens | ok |
| 2 | Bun absent on the target machine, doctor table in TS | `bun` missing | **none** — A1 puts the table in `lib/doctor-components.ts`, doctor is Bash 3.2 and promises to report without Bun (bin/gstack-doctor:22) | none | ★ F5 |
| 3 | `bun upgrade --version <pin>` unsupported on Bun 1.3.14 | `bun upgrade --help` lists only `--canary` | A2 assumes the flag | none | ★ F11 |
| 4 | Project pin and gstack floor conflict | both constraints printed, installer stops | yes | partial (runtime mismatch fixture) | add conflict fixture |
| 5 | `unattended` set but older `gstack-skill-start` coerces to `interactive` (bin/gstack-skill-start:93) | nothing | not mentioned | not mentioned | ★ F7 |
| 6 | `GSTACK_SESSION_KIND=unattended` and `GSTACK_HEADLESS=1` both set (eval harness + parent) | override wins at step 0 | implied, not stated | negative control for HEADLESS only | state precedence; add both-set test |
| 7 | Capy host: hook file present, hooks never executed | nothing | B1 detects *file absence* only (composition.ts:21-23) | guard fixtures on absence | ★ F4 |
| 8 | Claude host: hook file absent (broken install) → B1 turns deny into allow | prints `guard: not installed` | weakens the guard where it ships | — | F4 |
| 9 | P7 counter written to ephemeral state root; telemetry `off` in unattended | — | A3 says learnings skipped; B0/B10 still write analytics | none | ★ F3 |
| 10 | Unattended runner needs a *native* reviewer the host must dispatch (this review) | run blocks or shells to Codex for both voices | B2 has no `submit`/`next` verb | acceptance says "produces the files" | ★ F1 |
| 11 | Outside runner `api` returns truncated/empty output; `host-subagent` result file missing | `OUTSIDE_STATUS` | B3 "never degraded" for *completed*; missing-file path unspecified | — | add refused + reason code |
| 12 | Same-family check when `--outside-model` is a Claude id and native is Claude | model-family table | stated as a rule | none | add fixture |
| 13 | `findings.jsonl` count matches, content omitted | hash binding in run.json | yes (B0) | omitted-finding fixture | ok |
| 14 | `answer` against stale `gate_rev` | refused with current rev | yes (B9) | parse fixtures | ok |
| 15 | `d10 yes` (id + bare yes) | ambiguous for multi-option | rejects bare yes/no; id+yes unspecified | fixture quoted | specify: `yes` after an id = recommended option; print the mapping |
| 16 | Interrupted run with half-written `decisions.jsonl` | validate fails | `resume` from first incomplete gate | interrupted fixture | ok; require atomic rename on every writer |
| 17 | B7 mismatch exit code | exit 2 vs 1 contradiction inside B7; usage today exits 1 (bin/gstack-review-log:81-84) | — | — | F8 |
| 18 | `origin/<base>` absent (shallow clone on gate VM) when reading policy | git fails | not stated | none | ★ F12 |
| 19 | `--after <pr>` throwaway worktree writes evidence under a synthetic branch key | `gstack-evidence check` on real branch finds nothing | not stated | queue replay doesn't cover | ★ F13 |
| 20 | Old VERSION string equals an unrelated dependency version in a lockfile or doc | permitted-transform regex rewrites it | hunk classification per path, patterns "exact" | — | add fixture (F14) |
| 21 | Two restamps race (two coordinators) on one branch | journal | journal is per-run | injected failures per stage | add lock on journal path |
| 22 | Predecessor head moves between gate and merge | `PREDECESSOR MOVED` refusal | yes (C3) | replay includes it | ok |
| 23 | Pre-gate `lanes` for a touched *bash* bin (no importer) | import graph finds nothing → PASS | not stated | — | ★ F15 |
| 24 | `gstack-hermetic-run` imports `test/helpers/hermetic-env.ts` from a shipped bin | product typecheck scope | not stated | — | F16 |
| 25 | `regen --check` scratch copy of a large repo with `node_modules` | time | "two-minute promise" measured | measured on gstack and gbrain | ok if scratch copy uses `git worktree`, not `cp -r` |
| 26 | `.gstack/ship-policy.json` `mirror` or `stamp_paths` escapes repo (`..`, symlink) | containment check | C1 says containment-checked | none named | add escape fixtures |
| 27 | Pre-gate downgraded check still fails hard on a first run in a drifted repo | `warn` map | yes (D5) | — | ok |
| 28 | 10x: 33-decision gate list, pagination ids | stable ids | yes | approve-all fixture | ok |
| 29 | 10x: `findings.jsonl` with 176 open across 4 voices, `validate` referential integrity | O(n) | yes | — | ok |
| 30 | Ratchet fixture refresh forgotten → CI red on parity/context budget on every PR B-E | ratchet tests | plan says "clear parity"; no per-PR receipt | — | F6 |

## Section 3 Test plan

```
 codepath                                   test file (free unless marked)                      fixture
 ─────────────────────────────────────────  ──────────────────────────────────────────────────  ─────────────────────────────
 A  doctor --check/--for/--require/--json   test/gstack-doctor.test.ts (extend)                 healthy; each missing; wrong host;
                                                                                               no auth; bun range vs exact; win lane pin
    lib/runtime-pins.ts                     test/runtime-pins.test.ts (new)                     package.json engines, .tool-versions, nvmrc,
                                                                                               workflows w/ per-lane pins
    gstack-capy-install                     test/gstack-capy-install.test.ts (new, PATH-stubbed) no-bun; old-bun; conflict; --with-browser; --revision mismatch
    gstack-browser-ensure                   test/gstack-browser-ensure.test.ts (new)             stub playwright dir; lazy marker
    setup --no-browser / --status exit 1    test/setup-status.test.ts (extend)                   broken section link registry
 B  session-kind unattended                 test/gstack-session-kind.test.ts (extend)            override; both-set; unknown value
    skill-start unattended                  test/gstack-skill-start.test.ts (extend)             no telemetry prompt; UPGRADE_AVAILABLE one-liner
    preamble AUQ rule                       test/spawned-consent-rule.test.ts (extend)           unattended never records consent
    headless-artifacts + gstack-artifact    test/headless-artifacts.test.ts (new)                valid; interrupted; missing reviewer; omitted finding;
                                                                                               count/hash mismatch; stale artifact; schema print
    autoplan-run state machine              test/gstack-autoplan-run.test.ts (new)               next→submit→close per phase; answer stale rev; resume
    autoplan export                         test/autoplan-snapshot.test.ts (extend)              plan.md >30KB warn; custom heading
    outside-voice runner                    test/gstack-outside-voice.test.ts (new)              codex-cli stub; api stub; host-subagent result; same-family refusal
    review-log --findings                   test/review-log.test.ts (extend)                     clean/176-open mismatch; resolved-all → clean
    gate-list                               test/gate-list.test.ts (new)                         `all`, `d3b uc1a`, `all except d9b`, `yes`, `d10 yes`, 33 items/pages
    spec-review cap                         test/spec-review*.test.ts (extend)                   cap → cheap pass vs unconfirmed decision
    URGENT block order                      test/autoplan-report-order.test.ts (new)             block precedes summary
    E2E unattended run (paid)               test/skill-e2e-autoplan-unattended.test.ts (new)     this plan; PR B merge gate (Validation 2)
 C  ship-policy init/validate/show          test/ship-policy.test.ts (new)                       containment escapes; head vs base
    restamp                                 test/gstack-restamp.test.ts (new)                    --version; --next; --after; idempotent; dry-run; journal injected failures
    queue replay                            test/gstack-restamp-queue.test.ts (new)              3 PRs, mirror, CHANGELOG, (was X), since:, reorder x2
    tree-receipt                            test/gstack-tree-receipt.test.ts (new)               same-modulo-stamps; changed; lockfile-only; predecessor moved; dep==old version
    regen                                   test/gstack-regen.test.ts (new)                      stale golden; --write; command not authorized (exit 3)
    pregate (per check)                     test/pregate-<check>.test.ts (new, one per lib file)  INCIDENTS.md map: stale goldens, scratch, heavy-only const, win-only change, dropped hunk, |tail
    ship-receipt                            test/gstack-ship-receipt.test.ts (new)               render; read --json; truncation keeps identifiers
    ship/sections/tests.md.tmpl pipefail     test/ship-tests-section.test.ts (structural)         fence contains pipefail + wait $pid
 D  plan-reality resolver                   test/plan-reality-rows.test.ts (structural)          every row id rendered where declared; unattended → incomplete
    plan-gates undeclared-changes           test/plan-gates*.test.ts (extend)                    fixture diff with omitted behavior
    investigate sections + manifest         test/investigate-lazy-sections.test.ts (new)         manifest passive + scope; CARVE_GUARDS entry
    eval cases (paid)                       eval:bg:pr on plan-eng-review/plan-ceo-review/review/investigate
 E  spend-ledger                            test/spend-ledger.test.ts (new)                      spent+reserved>=cap under lock; unknown charges
    lane-check                              test/gstack-lane-check.test.ts (new)                 two branches intersecting
    banned-terms                            test/gstack-banned-terms.test.ts (new)               allowed_paths
    eval-plan skill                         test/context-budget-ratchet (new ceiling), parity (new invariant), skill-size-budget
```

**Free vs paid.** Everything above is free except the unattended E2E (Validation 2), the `eval:bg:pr` prompt evals for changed templates (Validation 5), and B4's checklist quality (needs a judge). The plan correctly routes paid work after cheap checks; the `pregate` PR should be the one that proves it.

**Gaps.** (1) No test for the mixed-version case (new `gstack-session-kind` + old `gstack-skill-start`), which is exactly a fleet-upgrade state. (2) No test that `gstack-doctor --check` works with Bun absent (the P1 scenario). (3) No `--help` coverage test exists today (no `test/help-coverage*.test.ts`), so B0's "with a `--help` coverage test" is a new test, name it: `test/bin-help-exit-table.test.ts`, asserting every new bin prints the exit table and exits 0. (4) The `lanes` check needs a fixture where a touched bash bin maps to its spawning test via path literal (F15). (5) The queue replay has no concurrent-restamp case. (6) `gstack-artifact ack` idempotency and the P7 census have no test because the collection path is undefined (F3). (7) Windows: every new bin that is bash (`gstack-capy-install`, `gstack-codex-login`, doctor) must be excluded from or made safe for the curated Windows subset (`scripts/test-free-shards.ts --windows-only`); plan is silent. (8) New test files need durations entries or the shard packer uses a default; check `scripts/free-test-durations.json` handling in the first PR and document it in INCIDENTS.md.

## Section 4 Performance/size

**Context budget impact (measured now, `bun` over `test/helpers/parity-harness.ts` invariants against `test/fixtures/parity-baseline-v1.64.1.0.json`):**

| skill | union bytes | ratio | maxSizeRatio | headroom |
|---|---|---|---|---|
| ship | 288 804 | 1.539 | 1.539 | **~0 B** |
| review | 133 923 | 1.234 | 1.2345 | **~60 B** |
| autoplan | 115 143 | 1.129 | 1.1305 | **~150 B** |
| qa | 94 736 | 1.127 | 1.1272 | **~20 B** |
| plan-eng-review | 145 423 | 1.167 | 1.187 | ~2.5 KB |
| plan-ceo-review | 160 085 | 1.055 | 1.081 | ~4 KB |
| plan-devex-review | 129 397 | 1.033 | 1.08 | ~6 KB |
| investigate (monolith) | 47 702 | 0.787 | 1.12 | ~20 KB |
| cso | 33 508 | 0.374 | 1.08 | large |

Every template edit the plan makes to ship (C5, C6, C7, C8 Step 5, Step 16 stage 1, E2 handoff), review (D2, E3 contributor mode), autoplan (B1 guard line, B2 unattended section, B12, E3 brief, B4 checklist) and qa (E1 soak) will fail `test/parity-suite.test.ts` on the first byte and require a `CARVE_GUARDS` `maxSizeRatio` bump plus a `capture-context-budget` refresh in the same commit. The plan says "every template edit must clear parity" but budgets no bytes and names no receipt; that is a per-PR hidden cost of a few hours and, more importantly, a design pressure: prefer bins that *print* the text (`gstack-gate render`, `gstack-ship-receipt`, `gstack-pregate` table) over prose that *describes* it, and put new prose in lazy sections (they count in the union ratio but not in the eager context-budget ceiling). B4's four 200-line checklists are ~30-40 KB of new union bytes across the plan-review skills; plan-eng-review has 2.5 KB of headroom. B4 should be budgeted as "checklist replaces, never adds": the deep section shrinks by what the checklist takes, with the union byte delta recorded in the PR body. `eval-plan` is a new skill and `test/context-budget-ratchet.test.ts` fails when "a skill exists with no ceiling at all" — PR E must add the fixture entry.

**Parity-suite risk.** Low for mechanics (it ran green in 269 ms here), high for byte discipline per the table. Also `test/skill-size-budget.test.ts` is a shrink floor; B4 moving methodology out of eager text could trip it on plan-* skills if the skeleton shrinks past the floor — check `minBytes` before carving.

**Two-minute pre-gate plausibility.** Stage 1 (`regen --check`, `secrets`, `strays`, `literals`, `links`, `lint`, `patches`, `ratchets`) is plausible on gstack only if `regen --check` uses a `git worktree` scratch (not `cp -r` of a repo with `node_modules`) and `gen:skill-docs --host all` fits — today that generation plus the agents digest is tens of seconds; `ratchets` (`module-size`, `state-root`, `parity`, `context-budget`) is a few seconds each. `literals` is a grep over the test tree (fast). `lint` depends on semgrep being absent (prints `not installed`). So ~60-100 s on gstack, measured `[estimated]`; on gbrain unknown. Stage 2 (`lanes`, `guards`, `hermetic`) is unbounded by design (it runs tests) and the plan correctly keeps its own clock. Risk: `lanes` import-graph closure over `scripts/` and `test/` (~2000-line files) is a few seconds with a cached graph; without caching it reparses on every run — cache keyed by `HEAD^{tree}` under `.gstack/tmp`.

## Findings

**F1 — Critical. The unattended runner has no verb for the host-dispatched reviewer.** B2 defines `run|status|answer|resume` and claims `run` "owns the unattended loop", yet the native voice on a Capy machine is a subagent the *parent* dispatches from a prompt file (exactly how this review ran; `nativeDispatchPrompt` lives in `snapshot.json`, bin/gstack-autoplan-snapshot.ts). Either `run` blocks forever waiting for a result nobody can hand it, or it shells both voices to Codex and violates B3's same-family rule. Evidence: B3 names runners for the *outside* voice only; nothing names how the native voice is produced without Claude Code. Change: make `lib/autoplan-run.ts` an explicit state machine with `next` (prints the phase, the voice, the prompt path and the expected result path, then exits `gate_pending`-style with `GSTACK_RESULT: status=awaiting_result`) and `submit --phase <p> --voice native|outside --result <file> --model <id>` (validates, binds hash into `run.json`, runs B11 reconciliation and `phase-close`). `run` becomes `next` in a loop only when a runner can execute both voices locally (`api` for both with two families).

**F2 — High. B3 puts a runtime decision in a render-time resolver.** `outsideVoiceFor(ctx)` picks the provider from `ctx.host` when `gen:skill-docs` renders (scripts/resolvers/outside-voice.ts:8-12); the rendered prose shells out to `codex` directly (scripts/resolvers/outside-voice-steps.ts:177, :327). A `--runner codex-cli|api|host-subagent` flag chosen per run cannot live there without rendering all three branches into every host's SKILL.md (bytes the zero-headroom skills do not have). Change: new `bin/gstack-outside-voice run --runner <r> --prompt <file> --out <file> [--model <id>] [--result <file>]` over `lib/outside-voice-runner.ts`; the resolver names the bin and the runner table once; `outsideVoiceFailurePolicy()` keeps owning the failure prose and adds `codex-cli unavailable; using <runner>`.

**F3 — Critical. P7's adoption number has no durable collection path.** B0 `ack`, B2 and B10 append to `$GSTACK_STATE_ROOT/analytics/autoplan-timing.jsonl`; A3 declares the Capy state root ephemeral by default and B1 makes unanswered telemetry consent `off`. UC1(a) gates PRs D/E tier 3 on "six of ten threads … a parent consumed", which this design cannot count. Change: make the durable carriers the ones that already leave the machine — `run.json.consumed_by` in the parent-chosen `--out` dir and the `gstack-ship-receipt` block (`session_kind`, `artifacts_consumed: <n>/<m>`) in PR bodies — and add `gstack-ship-receipt census --repo <r> --since <tag>` that computes the P7 number from merged PR bodies via `gh`. Analytics on the state root stay as a bonus, labeled `durable=no`.

**F4 — High. B1's guard clause detects the wrong condition and loosens the right one.** The publication hook renders only for `host === 'claude'` (scripts/resolvers/composition.ts:11) and the file-absent branch denies (composition.ts:16-23). On Capy the file is *present* (installed from the repo) and hooks are never executed, so "hook file absent" never fires and nothing reports the guard as unenforced; on Claude Code, absence means a broken install, where turning deny into allow removes the only backstop (autoplan/bin/phase-publication-hook:4-9 exists precisely so a broken install cannot pass as absent). Change: keep deny-on-absent for the Claude render; emit `autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)` from `gstack-skill-start` when `SESSION_KIND=unattended` (and on every non-claude host render), and have B0's validator require that line in `review-record.md` for unattended runs. The owner's direction ("allow guarded tool calls when no guard is installed and say so") is satisfied because unattended hosts never ran the hook anyway.

**F5 — High. A1's component table in TypeScript breaks the doctor's "reports without Bun" contract.** `bin/gstack-doctor` is Bash 3.2 + POSIX "so it still reports when bun or python3 is missing" (bin/gstack-doctor:22), and P1's scenario is a machine with nothing installed, Bun possibly below floor or absent (A2 says the Capy image ships 1.3.14; `setup` exits at :296 without Bun). A `lib/doctor-components.ts` table is unreadable in that state. Change: the table is `bin/gstack-doctor-components.sh` (sourced, one row per component: id, label, probe fn, fix, needed_by); if `--json` or `--for` resolution wants TS, generate the bash table from `lib/doctor-components.ts` at build time with a freshness test, the way `agents-digest` is generated (bin/gstack-version-bump:373-385 describes that pattern). `--check` must be exercised in a fixture with `bun` removed from `PATH`.

**F6 — High. Byte budgets are unaccounted on four skills with zero headroom.** See Section 4 table: ship 1.539/1.539, review 1.234/1.2345, autoplan 1.129/1.1305, qa 1.127/1.1272 (`test/helpers/parity-harness.ts:247` default plus per-skill `CARVE_GUARDS`). Every PR B-E lands prose on at least one of them. Change: each PR's acceptance lists the union byte delta per skill and the `CARVE_GUARDS`/`capture-context-budget` refresh commit; B4 becomes "replace, never add"; any text a bin can print is printed by the bin.

**F7 — Medium. `unattended` must be whitelisted in `gstack-skill-start` or it silently becomes `interactive`.** bin/gstack-skill-start:93 `case "$_SESSION_KIND" in spawned|headless|interactive) ;; *) _SESSION_KIND="interactive"`. B1 names session-kind, the preamble and skill-start but not this line, and the failure is the inverse of the intent (prompts return). Change: add `unattended` to the case; add a test that an *unknown* kind prints `SESSION_KIND: interactive (unknown kind '<x>' from gstack-session-kind)` so a mixed-version fleet is loud; state that the step-0 override outranks `GSTACK_HEADLESS` and that the eval harness never sets it.

**F8 — Medium. B7's exit codes contradict themselves and the code.** The text says a status mismatch is "exit 2" and three sentences later "a rejected row exits 1 … usage stays 2"; today the wrapper's usage exits 1 (bin/gstack-review-log:81-84) and swallows binding errors into `invalid JSON` (:88-96). Change: adopt B0's table — usage 2, rejected row 1 with `review-log: status mismatch: claimed clean, findings.jsonl has 176 open (REVIEW_STATUS_MISMATCH)` on stderr — and fix the wrapper to pass stderr through (drop the `2>/dev/null` on :95).

**F9 — Medium. New reason codes do not fit `lib/gate-outcomes.ts`'s contract.** `GateOutcome.state` is `ran|not_run|unavailable` with snake_case keys and one anchor each, checked by `test/troubleshooting-anchors.test.ts` (lib/gate-outcomes.ts:1-18). `QUEUE_STALE`, `GATE_REUSE_NOT_ELIGIBLE`, `REPO_COMMANDS_NOT_AUTHORIZED` are not gate states, and `ARTIFACT_INVALID_*` is a wildcard that cannot have one anchor. Change: a sibling `lib/result-codes.ts` with the same `{anchor, summary, fix}` shape and an enumerated artifact-error list; extend the anchor test to both tables; keep snake_case or document the SCREAMING_CASE convention for CLI-visible codes.

**F10 — Medium. B4's `scope` field reverses a documented design without touching its guards.** autoplan/sections/manifest.json:5 says the manifest is PASSIVE with "No machine predicate here"; `test/qa-lazy-sections.test.ts:127` asserts passive resolution. Change: update the note and `$schema`, make `scope` optional with `always` default, and have the *runner* (F1) be the only consumer; interactive renders ignore it, as the plan says.

**F11 — Medium. A2 relies on `bun upgrade --version <pin>`, which Bun 1.3.14 does not offer.** `bun upgrade --help` on this machine lists only `--canary`. `setup:296-305` already prints the checksum-verified `BUN_VERSION=… bash install` recipe. Change: the installer runs that recipe (download, print sha256, install to `~/.bun`, re-exec), and A1's `gstack runtime` fix line quotes it.

**F12 — Medium. Reading policy from `origin/<base>` has no shallow-clone or offline path.** C1 reads pins from the committed base copy; gate VMs often have shallow or detached checkouts. Change: when `origin/<base>` is unresolvable, exit 3 with `policy source unavailable — fix: git fetch origin <base> --depth=1 (POLICY_SOURCE_UNAVAILABLE)`; never fall back to the working tree silently. Also say plainly in `docs/ship-policy.md` that the base read protects the command *string* only (`bun run release:restamp` executes the PR's script), as C1 already concedes.

**F13 — Medium. Gate-ahead worktree evidence is keyed by the wrong branch.** Review and evidence ledgers are keyed by slug and branch (bin/gstack-review-log:18-22, :99; `gstack-evidence` ledger path, bin/gstack-evidence:13). A throwaway merge worktree with a synthetic branch writes under that name, so the receipt's `gstack-evidence check` on the real branch finds nothing and grades MISSING. Change: `gate-ahead.json` records the evidence branch key and `gstack-tree-receipt --from` reads it; or export `GSTACK_REVIEW_BRANCH`/evidence branch to the real PR branch inside the worktree.

**F14 — Medium. Permitted version transforms need per-file-type rules and a negative fixture.** C3 classifies hunks; the risk is an old VERSION (or its npm form) coinciding with an unrelated dependency version in `package-lock.json`/`bun.lock` or a doc. Change: lockfile rules match only the root package's `version` keys (`syncNpmLockfiles` already knows where they are, bin/gstack-version-bump:486); `stamp_paths` rules match `(was X)`, `since: X`, `vX` only when `X` equals the old VERSION *and* the replacement equals the new one; fixture where a dependency pin equals the old version must classify as `changed`.

**F15 — Medium. `lanes` cannot map bash bins to their tests through an import graph.** `test/gstack-doctor.test.ts` spawns `bin/gstack-doctor`; no TS imports it. The precedent (`test/helpers/touchfile-closure.ts:1-6, :20`) already adds string-literal path matching. Change: `lib/pregate/import-graph.ts` unions static imports with repo-path literals and the `bin/<name>` → `test/<name>*.test.ts` naming convention, and reports "no lane found" as `FAIL lanes — <file> has no test lane` rather than passing.

**F16 — Low. `bin/gstack-hermetic-run` would import test code.** `buildHermeticEnv` lives in `test/helpers/hermetic-env.ts:112` (554 lines); a shipped bin importing it crosses the product/test typecheck boundary (`bun run typecheck` vs `typecheck:test`). Change: move the env builder to `lib/hermetic-env.ts`, re-export from the helper.

**F17 — Low. Validation 2 ties PR B's merge gate to Codex CLI.** "a Codex login from `OPENAI_API_KEY` only" contradicts B3's acceptance of a Claude subagent as a full outside voice. Change: the gate accepts either runner and records which ran.

**F18 — Low. Security surface of new pin files is named but not fixtured.** `mirror`, `stamp_paths`, `generated.json` commands, `pregate.json` guards patterns and `banned-terms.json` are all repo-controlled inputs; containment (no `..`, no symlink escape, globs confined to the repo), command execution only under `--allow-repo-commands`, and regex-size caps for `banned-terms`/`guards` patterns need named fixtures. `gstack-regen --check` is still code execution even in a scratch copy and must sit behind the same opt-in.

**F19 — Low. Windows subset.** New bash bins and tests must be classified for `scripts/test-free-shards.ts --windows-only`; the plan is silent, and the windows lane is exactly the "unrun platform lane" incident C8 targets.

## Required outputs

**NOT in scope (confirmed and extended).** The plan's "Not in this wave" list stands (no `capy` host, no semgrep/gitleaks install, no native Windows `/cso`, no issue closing, no stamping on main, no running platform lanes locally). Add: no telemetry transport for P7 (receipts carry it, F3); no change to `headless` BLOCK semantics or any eval case meaning; no Greptile-tier vocabulary (D8a); no automatic `CARVE_GUARDS` bumps (each is a human-visible commit).

**What already exists (receipts).** Doctor rows + exit codes (bin/gstack-doctor:3-16); session kinds and override (bin/gstack-session-kind:33-66); skill-start kind whitelist (bin/gstack-skill-start:93); AUQ branch rule (generate-ask-user-format.ts:15-29); state-root chain and ratchet (lib/state-root.ts:22-29, test/state-root-ratchet.test.ts); `bindReview`/`reviewFreshness` (lib/review-evidence.ts:178-243); review-log wrapper (bin/gstack-review-log:81-99); version-bump opt-in regen and half-write path (bin/gstack-version-bump:373-402, :483-495); evidence fingerprints and allow-list compare (bin/gstack-evidence:388-396, :498-512); render-time outside voice (outside-voice.ts:8-12, :217-230); spec-review stop rules (spec-review.ts:186-192); publication hook render + backstop (composition.ts:7-32, phase-publication-hook:1-15); gate-outcome contract (lib/gate-outcomes.ts:1-18); setup skip flags and status exit (setup:1512, :2071-2072, :136-146); Bun floor/tested (bin/gstack-bun-version.sh:16-17; package.json:80-81 `>=1.4.2`; windows-free-tests.yml:85-89); passive manifests (autoplan/sections/manifest.json:5); parity/context/skill-size ratchets (test/parity-suite.test.ts, test/context-budget-ratchet.test.ts, test/skill-size-budget.test.ts); module-size fixture (test/fixtures/module-size-ratchet.json: 47 + 4 entries, none of the three bins the plan names).

**Completion Summary.** The plan is well grounded (most receipts check out) and its decisions are right; it is under-specified where it matters most for P2 (how a native reviewer's output gets back into the run) and over-confident where the repo's ratchets are strictest (ship/review/autoplan/qa bytes). Two premises are wrong (module-size caps on the three bins; `bun upgrade --version`), one promise is unmeasurable as designed (P7), one safety change targets the wrong host (B1 guard), and one component sits in the wrong language for its own promise (doctor table). None of these change the decisions; they change PR B's shape and every PR's acceptance list. Unverified claims in the plan I could not check on this machine: the 86 s Chromium number, the 3.7 s Codex probe, gbrain's pre-gate timing, and the per-PR effort table (all `[estimated]`; the plan labels them so).

**Dependencies and parallelization.**
- A is independent and lands first (D1). F5 and F11 are inside A.
- B-core (B0, B1, B7, B9, B10, B12) depends only on A's `GSTACK_LAUNCH` line; B-runner (B2, B3, B4, B8, B11) depends on B-core's schemas and on F1/F2's bins. These two halves can be developed in parallel on fresh machines with B-runner stacked on B-core's branch.
- C-stamp (C1, C2, C3, C5, C7) depends on B0 (receipt schema) only; C-pregate (C4, C8, C6) depends on C1 (pin trust boundary) and B0 (`pregate.json`). C-stamp and B-runner are disjoint and can run in parallel; C-pregate stacks on C-stamp.
- D depends on B4 (`scope`) for tier 2 only; tier-1 rows can start after B-core. D's byte budget work (F6) is the long pole, not the code.
- E tier 1 (E1 ledger + pilot) depends on nothing in B-D except `lib/pricing.ts` extraction; E2 bundle moved into C3. E tier 3 waits for P7 via F3's census.
- Shared files with one owner each: `bin/gstack-skill-start` (B-core), `scripts/resolvers/outside-voice*.ts` (B-runner), `ship/SKILL.md.tmpl` and `ship/sections/*` (C-stamp then C-pregate, serialized), `test/fixtures/carve-guards`/`CARVE_GUARDS` (one commit per PR, the PR's author).

## Scores

- Architecture: 6/10 — right layering (lib behind bin, pins, one validator) but F1/F2/F5 put three components in the wrong place or language.
- Edge cases: 6/10 — queue and receipt edges are strong; session-kind, shallow-clone, worktree-key and bash-lane edges are missing.
- Test plan: 7/10 — incident fixtures and the queue replay are the right instruments; missing the no-Bun doctor case, mixed-version kinds, concurrent restamp, Windows classification, and any P7 test.
- Right-sized diff: 4/10 — A, D, E are sized; B and C are each two review sittings and the byte budget is unbudgeted.
- Reversibility: 8/10 — every new behavior is behind a new kind, a new pin file, or a new flag; `headless` and interactive paths are untouched; guard change (F4) is the one irreversible-feeling edit and it should not ship as written.
- Maintainability under ratchets: 5/10 — the plan names the ratchets but misidentifies which files they cap and does not budget the four zero-headroom skills.

## Tasks

```json
[
  {"id":"T1","priority":"P1","component":"autoplan-runner","title":"Add next/submit verbs to gstack-autoplan so a host-dispatched native reviewer can return results; run becomes a loop over next only when both voices are local","files":["bin/gstack-autoplan","lib/autoplan-run.ts","lib/headless-artifacts.ts","test/gstack-autoplan-run.test.ts"],"effort_human":"4d","effort_cc":"0.5d","source_finding":"F1"},
  {"id":"T2","priority":"P1","component":"outside-voice","title":"Create bin/gstack-outside-voice (codex-cli|api|host-subagent) and point the resolver prose at it instead of rendering runner branches","files":["bin/gstack-outside-voice","lib/outside-voice-runner.ts","lib/outside-voice-api.ts","scripts/resolvers/outside-voice.ts","scripts/resolvers/outside-voice-steps.ts","test/gstack-outside-voice.test.ts"],"effort_human":"3d","effort_cc":"0.5d","source_finding":"F2"},
  {"id":"T3","priority":"P1","component":"adoption","title":"Carry P7 in run.json.consumed_by and the ship receipt; add gstack-ship-receipt census over merged PR bodies; label state-root analytics durable=no","files":["lib/headless-artifacts.ts","bin/gstack-artifact","bin/gstack-ship-receipt","docs/unattended.md","test/gstack-ship-receipt.test.ts"],"effort_human":"2d","effort_cc":"0.25d","source_finding":"F3"},
  {"id":"T4","priority":"P1","component":"autoplan-guard","title":"Keep deny-on-absent in the Claude render; emit GUARD_NOT_INSTALLED from gstack-skill-start for unattended/non-hook hosts and require it in review-record.md","files":["scripts/resolvers/composition.ts","bin/gstack-skill-start","lib/headless-artifacts.ts","test/autoplan-publication-guard.test.ts","test/gstack-skill-start.test.ts"],"effort_human":"1d","effort_cc":"0.15d","source_finding":"F4"},
  {"id":"T5","priority":"P1","component":"doctor","title":"Component table as sourced bash (or build-time generated from TS with a freshness test); --check fixture with bun removed from PATH","files":["bin/gstack-doctor","bin/gstack-doctor-components.sh","lib/doctor-components.ts","test/gstack-doctor.test.ts"],"effort_human":"2d","effort_cc":"0.25d","source_finding":"F5"},
  {"id":"T6","priority":"P1","component":"budgets","title":"Per-PR union-byte delta and CARVE_GUARDS/capture-context-budget refresh in acceptance; B4 checklists replace rather than add; new eval-plan ceiling","files":["test/helpers/carve-guards.ts","test/fixtures/context-budget*.json","docs/designs/multi-agent-wave-2026-10-10/ACCEPTANCE.md"],"effort_human":"1d per PR","effort_cc":"0.1d per PR","source_finding":"F6"},
  {"id":"T7","priority":"P1","component":"session-kind","title":"Whitelist unattended in gstack-skill-start; loud fallback for unknown kinds; state override-vs-HEADLESS precedence and test both-set","files":["bin/gstack-skill-start","bin/gstack-session-kind","test/gstack-skill-start.test.ts","test/gstack-session-kind.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F7"},
  {"id":"T8","priority":"P2","component":"review-log","title":"Adopt exit table (usage 2, rejected 1 with REVIEW_STATUS_MISMATCH); pass bindReview stderr through the wrapper","files":["bin/gstack-review-log","lib/review-evidence.ts","test/review-log.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F8"},
  {"id":"T9","priority":"P2","component":"reason-codes","title":"lib/result-codes.ts with enumerated artifact/queue/policy codes and anchors; extend troubleshooting-anchors test","files":["lib/result-codes.ts","lib/gate-outcomes.ts","docs/troubleshooting.md","test/troubleshooting-anchors.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F9"},
  {"id":"T10","priority":"P2","component":"sections-manifest","title":"Optional scope field with updated passive-registry note and schema; runner is the only consumer; update qa-lazy-sections test","files":["autoplan/sections/manifest.json","plan-*-review/sections/manifest.json","scripts/resolvers/sections.ts","test/qa-lazy-sections.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F10"},
  {"id":"T11","priority":"P2","component":"installer","title":"Replace bun upgrade --version with setup's checksum-verified BUN_VERSION install recipe; doctor fix line quotes it","files":["bin/gstack-capy-install","bin/gstack-doctor","test/gstack-capy-install.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F11"},
  {"id":"T12","priority":"P2","component":"ship-policy","title":"POLICY_SOURCE_UNAVAILABLE (exit 3) when origin/<base> is unresolvable; never fall back to the working tree; document the command-string-only trust boundary","files":["lib/ship-policy.ts","docs/ship-policy.md","test/ship-policy.test.ts"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F12"},
  {"id":"T13","priority":"P2","component":"restamp","title":"Record the evidence branch key in gate-ahead.json and read it in the receipt; concurrent-restamp lock on the journal","files":["lib/restamp.ts","lib/tree-receipt.ts","test/gstack-restamp-queue.test.ts"],"effort_human":"1d","effort_cc":"0.15d","source_finding":"F13"},
  {"id":"T14","priority":"P2","component":"tree-receipt","title":"Per-file-type permitted transforms (root package version keys only in lockfiles) and a dep-equals-old-version negative fixture","files":["lib/tree-receipt.ts","test/gstack-tree-receipt.test.ts","test/fixtures/multi-agent-wave/p0-3-dep-equals-old-version/"],"effort_human":"1d","effort_cc":"0.15d","source_finding":"F14"},
  {"id":"T15","priority":"P2","component":"pregate","title":"Import graph unions repo-path literals and bin→test naming; 'no lane found' is FAIL; cache graph by HEAD tree","files":["lib/pregate/import-graph.ts","lib/pregate/lanes.ts","test/pregate-lanes.test.ts"],"effort_human":"1.5d","effort_cc":"0.2d","source_finding":"F15"},
  {"id":"T16","priority":"P3","component":"pregate","title":"Move buildHermeticEnv to lib/hermetic-env.ts and re-export from the test helper","files":["lib/hermetic-env.ts","test/helpers/hermetic-env.ts","bin/gstack-hermetic-run"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F16"},
  {"id":"T17","priority":"P3","component":"validation","title":"PR B merge gate accepts either outside runner and records it","files":["docs/designs/multi-agent-wave-2026-10-10/ACCEPTANCE.md"],"effort_human":"0.1d","effort_cc":"0.05d","source_finding":"F17"},
  {"id":"T18","priority":"P2","component":"pin-security","title":"Containment, opt-in and regex-size fixtures for ship-policy mirror/stamp_paths, generated.json, pregate.json guards, banned-terms.json","files":["lib/ship-policy.ts","lib/regen.ts","lib/pregate/index.ts","bin/gstack-banned-terms","test/ship-policy.test.ts","test/gstack-regen.test.ts"],"effort_human":"1d","effort_cc":"0.15d","source_finding":"F18"},
  {"id":"T19","priority":"P3","component":"windows-lane","title":"Classify every new bash bin and test for the curated Windows subset; add durations entries","files":["scripts/test-free-shards.ts","scripts/free-test-durations.json","scripts/free-test-durations-windows.json"],"effort_human":"0.5d","effort_cc":"0.1d","source_finding":"F19"},
  {"id":"T20","priority":"P1","component":"delivery","title":"Split B into B-core/B-runner and C into C-stamp/C-pregate (seven PRs, stacked); record as decision E1 with the two-gate cost","files":["docs/designs/multi-agent-wave-2026-10-10/ACCEPTANCE.md"],"effort_human":"0.2d","effort_cc":"0.05d","source_finding":"Scope Challenge"}
]
```

**Auto-decided (recommended options, recorded, no questions asked):** UC1(a), D1(a) amended by T20 (seven PRs: A, B-core, B-runner, C-stamp, C-pregate, D, E), D2(a), D3(a), D4(a) with F12's refusal, D5(a), D6(a), D7(a), D8(a), D9(a), D10(a), D11(a) with F14's per-file-type rules. New decision E1 (PR split) recommended (a) as above; (b) keep five PRs and accept two review sittings per PR.

Recommendation: revise-then-proceed because the decisions are sound and most receipts hold, but PR B cannot meet P2 without a submit/next verb and a runtime outside-voice bin (F1, F2), P7 is unmeasurable as designed (F3), the guard change targets the wrong host (F4), the doctor table is in a language the P1 scenario lacks (F5), and four skills have zero parity headroom for the prose every later PR adds (F6).
