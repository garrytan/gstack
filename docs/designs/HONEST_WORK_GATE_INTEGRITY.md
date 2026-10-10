# Design: Honest work and gate integrity across the base skills

Status: plan, autoplan complete (CEO → DX → Eng); awaiting approval
Created: 2026-10-09
Source: the `just-say-no-to-process-porn-and-ceremony` skill (SKILL.md, REWARD-HACKING-CATALOG.md, HONESTY-PROTOCOL.md, ENFORCEMENT.md, three worksheets), evaluated against gstack's preamble, `/review`, `/ship`, `/qa`, `/plan-ceo-review`, `/plan-eng-review`, `/spec`, `/retro`.

## Problem

The source skill names a family of agent pathologies with stable IDs: an agent
weakens the gate instead of the code (deletes or skips a test, regenerates a
golden, widens a timeout, adds `eslint-disable`, commits with `--no-verify`),
presents a mock or fixture as live proof, claims a command it never ran, closes
work by editing the spec, or builds ledgers and dashboards that nothing
consumes. Its evidence is real multi-agent sessions on a beads/NTM swarm; the
gstack-native incidents that match it are cited per workstream below.

gstack already enforces most of the honesty half: `/ship` Step 16's "no
completion claims without fresh verification evidence", the evidence ledger,
`/review`'s "Verification of claims", the Completion Status Protocol, the
Claimed Limitations directive, the plan-completion audit's `Linked to #N`
rule (RH-9), `measure.md`'s "never raise a budget, lower a threshold, add a
retry or skip a case to get a pass" (RH-15, SM-11), the testing specialist's
"never accept buggy-output goldens or discarded valid red tests" (RH-3) and
"Negative Assertions" category, and `/ship`'s "never rewrite history" (RH-17).
What gstack does **not** have:

1. **Gate-integrity review is scattered, unnamed, and absent from the core
   pass that small diffs get.** The clauses above live in a specialist that
   only runs on diffs over 50 lines, in `/ship`'s measure loop, and in
   `/qa`. Nothing in the core `/review` checklist, and nothing mechanical,
   lists the gate edits in a diff (deleted or skipped tests, `.only`, a
   timeout bumped from 5s to 60s, `@ts-ignore`, a regenerated snapshot,
   `[skip ci]`) so that a human dispositions each one. The checklist even
   suppresses "eval threshold changes" outright (`review/checklist.md`,
   Suppressions).
2. **No No-Claim line.** Plan test criteria name a positive assertion and a
   wrong result it rejects (CEO Section 6 step 1) but never state what a green
   result does *not* prove, the line that makes proof-class inflation a
   violation of the item's own text.
3. **Zero-run green is invisible.** The evidence ledger records exit codes. A
   suite that selected nothing and exited 0 is recorded as a pass.
   gstack-observed: AGENTS.md validation discipline, "Bun can silently ignore
   a nonexistent file selector and pass the remaining files"; `describe.skip`
   placeholders earning zero selected-case credit.
4. **Execution honesty is implied, not stated.** The preamble says a claimed
   *limitation* needs evidence; it does not say a claimed *execution* must
   have happened, that a mock never stands in for a required live check, that
   a checked null result is a successful result, that conclusion-changing
   failures are disclosed, or that stderr is never silenced in an evidence
   command. gstack-observed: CLAUDE.md "'Pre-existing' without receipts is a
   lazy claim".
5. **No value test for process artifacts in plans.** `/plan-ceo-review`
   challenges scope but has no question for "this plan adds a ledger / audit
   matrix / meta-report about the work: who uses it, what decision changes,
   why is this the smallest version, when does it retire?"
6. **Implementing children inherit narrow success criteria.** `/spec
   --execute` pipes the spec to `claude -p`; `/ship` Step 7 generates tests
   and Step 9.4 auto-fixes through children. The source's dispatch rules
   (never "make the tests pass"; a child's report is a claim; the parent
   re-checks what the child touched) are absent.

**The control is the human disposition, not the detector.** In a solo
session the agent that weakened the gate is the agent running `/ship` twenty
minutes later. A detector that reports to its own author is disclosure, not
control. Everything below is built so that each gate edit reaches a human,
by name, with its justification, in the PR body; the detector exists to make
that listing complete and cheap, and must never become a verdict.

## What is universal and what is not

**Adopt (universal to any agent writing code against tests), in durability
order:** the No-Claim line and planted negative in acceptance criteria;
dispatch rules for implementing children; disclosure of every gate edit at a
human ASK with its reason landing in the PR body; execution honesty, failure
disclosure, truthful null results and the stderr rule; zero-run green and
positive observables beyond exit code (PL-1, PL-2); the gate-integrity
pattern catalog (RH-1, 2, 3, 4, 5, 10, 12, 13, 14, 15, 16) as the engine
behind the listing; the value test for process artifacts; the auditor's
posture as a self-report at publication.

**Do not adopt (swarm- and tracker-specific):** the beads/`br` tracker
encoding, canary-the-enforcement (its universal lesson, "show the claimed
control fires", is kept as the detector's calibration run), the joint-freeze
protocol, SM-2/3/6 ready-pool mechanics, refusal-farming redirects, `cass`
session mining, NTM references, the three worksheets as standalone
artifacts, the AGENTS.md "durable law" offer (gstack's AGENTS.md is the
durable law), the USER/ENABLER/PROCESS commit classification (it needs a
project-specific definition of "user" an agent cannot infer from paths, and
gstack's own product would read as PROCESS).

**No new skill.** The agent most in need of an honesty audit is the least
likely to invoke one; `/review` and `/ship` are the only surfaces guaranteed
to see the diff, so prevention is folded into them. (A new skill would also
cost catalog bytes, but that is not the reason.) The retrospective "what did
we conceal or waste over the last week" job is real and distinct; it gets a
range mode on the detector (W1) and is otherwise a follow-on, not this PR.

## Workstreams

Each workstream names its consumer, the gate it strengthens, the
gstack-observed defect that justifies it (or "speculative: adopted on the
source's evidence"), and its retirement condition.

### W1. Gate-edit detector (`lib/gate-diff.ts`, `bin/gstack-gate-diff`)

Consumer: `/review` Step 3.5/4, `/ship` core checklist (new item 2.5), Steps
7, 9.4, 16 and 19 (PR body). Gate: pre-landing review and publication.
Observed defect: `review/checklist.md` suppression of threshold changes;
AGENTS.md "do not lower thresholds, increase model budgets, skip cases, or
rejudge a failure to manufacture a pass" (written after RH-15-class
incidents); the per-pattern rows are adopted on the source's evidence.
Retirement: when the host's review tooling lists gate edits natively, or
when calibration (below) shows findings are skipped more than they are read.

**Why a tool and not prose.** `gstack-diff-scope` already flags
`SCOPE_TESTS` and `SCOPE_CONFIG`; prose alone could say "read every hunk in
those files with the gate question". The model skips or rationalizes that
step under context pressure, and the PR body needs counts. The tool
produces the inventory and the tags; it never judges and never suppresses.

**Three levels, kept apart everywhere (tool output, review prose, PR body):**

| level | what | who sees it | human action |
|---|---|---|---|
| **listed** | every hunk in a test, CI, runner/lint-config, snapshot or golden path (the floor) | counted in `GATE_SUMMARY:`; full listing in `--out` file | none |
| **read** | listed hunks that carry a tag, or that remove lines (deletion-bearing), capped at 50 with the cap disclosed | the agent reads each with the gate question | none unless it becomes a finding |
| **finding** | a read hunk the agent judges a relaxation not justified by a measurement or decision visible in the diff | ASK (W2) | one decision per finding or coherent group |

Measured on gstack's own last 40–49 merged PRs (two reviewers, path-floor
proxy): median 23–45 listed hunks per PR, p75 over 100, max about 1,300;
deletion-bearing median 16. Mandatory disposition per listed hunk is
therefore unworkable; only findings reach a human. Added tests, renamed
tests, and snapshots updated alongside their source are inventory, never
findings.

**Floor: own matcher, not `gstack-diff-scope`'s.** diff-scope's test globs
are root-anchored and case-sensitive (`test/*`, `*_test.*`) so
`src/test/java/…`, `Tests/FooTests.swift` and `FooTest.kt` are never tests,
and its CONFIG class covers every `*.yml` and lockfile. W1 ships its own
matcher: any-depth, case-insensitive `**/test/**`, `**/tests/**`,
`**/spec/**`, `**/__tests__/**`, `*.test.*`, `*.spec.*`, `*_test.*`,
`*_spec.*`, `test_*.py`, `*Test.{java,kt,scala}`, `*Tests.swift`,
`*_test.go`, `*_test.exs`; a content backstop (a hunk in any file whose
removed lines match a test-declaration idiom is listed even when the path
did not match); an explicit CI/runner/lint-config list (`.github/workflows/`,
`.gitlab-ci.yml`, `Jenkinsfile`, `vitest.config*`, `jest.config*`,
`pytest.ini`, `setup.cfg`, `tox.ini`, `bunfig.toml`, `.eslintrc*`,
`eslint.config*`, `tsconfig*.json`, `.rubocop.yml`, `golangci*.yml`);
snapshot/golden paths (`__snapshots__/`, `*.snap`, `*.golden`,
`testdata/`). Candidate = committed diff + staged + unstaged + untracked
(the same union `/ship` uses), with rename detection (`-M`). A project adds
paths through a CLAUDE.md `## Gate Integrity` block (`Extra test paths:`,
`Snapshot paths:`), following the `## Test Coverage` precedent; the
effective classification is printed in the coverage line. No off switch in
v1 (see Review record).

**Tags: best-effort labels on top of the floor.**

| id | what it tags | signal |
|---|---|---|
| RH-1 | test removed or disabled | removed `test(`/`it(`/`def test_`/`func Test`/`@Test`; added `.skip`, `.only`, `xit`, `xdescribe`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip(`, `@Disabled`, `@Ignore`, `XCTSkip`, `@tag :skip` |
| RH-3 | snapshot changed without its owning test | `__snapshots__/<name>.snap` or `<name>.snap` whose conventional owner (`<name>` test file) has no hunk in the candidate. `*.golden`, `testdata/` and project `Snapshot paths:` are tagged `RH-3?` (owner unresolved: listed and read, never inferred). No general source-ownership inference in v1 |
| RH-4 | placeholder committed | added `todo!()`, `unimplemented!()`, `raise NotImplementedError`, `throw new Error("not implemented")`, `pass  # TODO` in non-test code |
| RH-12 | environment sniffing in product code | added `process.env.CI`, `NODE_ENV === 'test'`, `RAILS_ENV == 'test'`, `PYTEST_CURRENT_TEST`, `GITHUB_ACTIONS` outside test paths |
| RH-13 | suppression pragma added | added `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `#[allow(`, `// nolint`, `rubocop:disable`, `@SuppressWarnings` |
| RH-14 | gate bypass | commits in range with `[skip ci]`/`[ci skip]`; added `continue-on-error: true`, `allow_failure: true`, `--no-verify` in scripts or hooks (job-removal detection cut from v1: a removed workflow job is listed by the floor and read) |
| RH-15 | gate value relaxed | in test/CI/config files, a numeric literal changed on a removed/added line pair with the same key inside one hunk, where the key is a gate keyword and the direction relaxes it: timeout/retry/retries/tolerance/epsilon/delta/maxDiff/jitter **up**, or threshold/min_score/minimum/coverage/required **down** (direction-agnostic detection, direction shown); or an exact-count assertion relaxed to a bound (`toBe(3)` → `toBeGreaterThan(0)`). Unpaired values (new file, reordered multi-number lines) are tagged `RH-15?` and read; cross-hunk pairing is out of v1. The tool prints any citation it finds beside the hunk (commit text naming a `ship-measure` report, or a `gstack-shortcut(dec-*)` marker resolved through `gstack-decision-search`); it never suppresses on it, because `ship-measure` reports are gitignored and commit text is forgeable; the human decides |
| RH-16 | exception swallowed | added `catch {}`, `catch (e) {}`, `except: pass`, `rescue nil`, `_ = err` in non-test code (overlaps slop-scan's empty-catch rule; gate-diff lists it under the RH id, slop-scan keeps its fix) |

RH-2 (proof-class inflation) and RH-5 (tautological tests) are prose
checks in W2 and W5, not patterns. RH-17 (history rewriting) is not
detectable from a final diff and is covered by `/ship`'s existing "never
rewrite history"; the coverage line says so rather than pretending.

**CLI contract.** `gstack-gate-diff [base-ref] [--format table|jsonl]
[--commit <sha>] [--help]`. (`--out`, `--paths` and `--range` from the DX
draft are cut: the artifact path is tool-owned, a child's self-reported
path list is both a pathspec-injection surface and a self-report, and the
only history need is calibration, which `--commit <sha>` covers by scanning
one commit's first-parent delta without the working tree.) Positional
base defaults the way `gstack-diff-scope` does (`origin/HEAD` → `main` →
`master`); an already-qualified ref is used as given. stdout: one
`GATE_SUMMARY: listed=N read=N tagged={RH-1:2,RH-15:1} unmatched=N
coverage=<patterns> languages_unlisted=<…> candidate=<sha+wtree>` line, then
the read-level listing (bounded; the full listing goes to `--out`).
`--format jsonl` emits one object per listed hunk (`id`, `path`, `level`,
`tags`, `old`, `new`, `citation`); `id` is the tool-computed identity
(path pair + tag + normalised changed lines, with a structural suffix for
duplicates), never a caller-supplied hash. **Candidate model:** one
comparison, resolved merge-base SHA → the working tree as it stands,
including non-ignored untracked files as additions (`git diff -M
--no-color --no-ext-diff --no-textconv <merge-base>` plus untracked), with
the candidate fingerprint from `gstack-wtree` recorded so a concurrently
changing tree is detected, never the committed + `HEAD` + untracked
concatenation `gstack-diff-scope` uses for filenames. Binary, symlink,
submodule and undecodable paths are named unsupported coverage, not zero
hunks; CRLF is normalised for tag matching only.

**Admission.** A hunk is listed when its path matches the floor **or** any
content tag matches (so an `eslint-disable` or empty `catch` added in
product code is admitted through RH-13/RH-16); `package.json` scripts,
`pyproject.toml` and `setup.cfg` tool sections join the config list. The
read level is ordered tagged-first, then deletion-bearing, bounded by 50
hunks and 200 KB; `GATE_SUMMARY` reports `eligible`, `inspected`,
`unread`. When anything is unread the result is **partial**, rendered
`Gate edits: partial (K of M eligible read)`, reported as missing coverage
like UNAVAILABLE, and never as `none detected`.

**Exit contract.** 0 with or without hunks; 2 only when the base is
unresolvable (`GATE_ERROR=no_base ref=<ref>` with the concrete recovery:
`git fetch <remote> <branch>` from the detected remote, or "deepen the
shallow history") or the tool itself failed. Unmatched paths are reported
in `GATE_SUMMARY: unmatched=N` and listed, never an exit 2. The template
block that calls it branches on the exit explicitly, never
`2>/dev/null || true`:

```bash
if GATE_OUT=$(~/.claude/skills/gstack/bin/gstack-gate-diff <base> 2>&1); then
  printf '%s\n' "$GATE_OUT"
else
  GATE_EXIT=$?; printf '%s\n' "$GATE_OUT"
  case "$GATE_EXIT" in
    2) echo "Gate integrity: UNAVAILABLE — $(printf '%s\n' "$GATE_OUT" | grep -m1 '^GATE_ERROR=')" ;;
    *) echo "Gate integrity: UNAVAILABLE — helper exit $GATE_EXIT (stale install? run /gstack-upgrade)" ;;
  esac
fi
```

The block is one resolver constant (`GATE_SCAN_BLOCK`) rendered into
`/review` Step 3.5 and `/ship`'s core checklist so the two cannot drift; it
uses `ctx.paths.binDir` and the runtime-root prelude like every other
helper call (the `~/.claude/...` path above is the Claude-host rendering),
and `if assignment; then … else … fi` because a bare `VAR=$(cmd); RC=$?`
exits an errexit shell before the branch. The full listing is written by
the tool itself to
`$GSTACK_STATE_ROOT/projects/<slug>/gate-diff/<candidate-fingerprint>.jsonl`
(mode 0600, never synced, never inside the working tree: an untracked file
under the repo would flip `/review`'s `review_binding` to `changed` and make
`/ship` loop at Step 11.5), and prints that path in `GATE_SUMMARY:`.
UNAVAILABLE is reported as missing coverage in the final report and PR body
(the same way an `unverified` outside review is), does not flip `COMPLETED`,
and is never rendered as `none detected`.

**Calibration (free) before W2 ships.** A small unshipped script runs
`--commit <sha>` over gstack's last 50 first-parent merge commits and over
two external fixture diffs (a snapshot-heavy frontend repo, a Rails repo)
and publishes per PR: listed, eligible, tagged by id. I hand-read the
tagged hunks of 10 PRs and record for each whether a reviewer would want
to read it. Tags below 50% on that hand read are demoted to inventory
before merge. Agent-level signal ("findings the agent raised, kept,
restored, left open") is **not** simulated before ship: it is collected
after ship from the persisted records, which is the only honest source
for it; that is the retirement/promotion input for the tags.

Tests: fixtures under `test/fixtures/gate-diff/` as patch text plus a
builder that materialises each into a temporary git repo (no nested `.git`
in the tree), one planted case per tag, plus controls: a test file moved
(rename: listed, untagged), an added test (listed, untagged), a snapshot
updated with its owning test (listed, untagged), a test deleted alongside
its deleted source (listed **and tagged RH-1**: tags are factual; the
agent's judgment, not the tool, makes it a non-finding), a `spec/` skill
directory with no `*_spec.*`/`*.spec.*` inside (not a test path: the floor
treats `spec/` as tests only when such files exist there). Adversarial fixtures: a forged "measured"
comment (tagged RH-15 with the citation shown, never suppressed), a golden
regenerated beside an unrelated source edit (tagged RH-3), a Kotlin
`@Ignore` under `src/test/kotlin/` (listed and tagged by the own matcher),
a new untracked `vitest.config.ts` with a raised timeout (listed via the
untracked union). Pure-function core (`lib/gate-diff/{classify,tags,git,render}.ts`, each
under the 800/150 module-size ratchet) tested directly; the bin is a thin
CLI with `--help`, argument-error and errexit-block tests.

### W2. Gate Integrity in `/review`

Consumer: `/review` core pass (every diff size), `/ship` core checklist.
Gate: pre-landing review. Observed defect: the "eval threshold changes"
suppression hides RH-15 in the one skill that reads every diff. Retirement:
with W1.

- `review/checklist.md`: new Pass 1 CRITICAL category **Gate Integrity**,
  written in the three levels: read every *read*-level hunk W1 listed with
  one question, *does this relaxation silence the failure it was added for,
  or is it justified by a measurement or decision visible in this diff?*; a
  hunk that fails the question is a **finding**; inventory is never a
  finding. Confidence scores how sure the agent is that the hunk *is* a gate
  relaxation (identification), not whether it is justified, so a real gate
  edit cannot be buried in the low-confidence appendix. Gate findings are
  ASK, never AUTO-FIX. Coherent groups (one source change plus its N
  snapshots; one timeout constant raised in M tests) are one decision.
- **ASK options** (replacing bare Fix/Skip for this category): A) **Restore
  the gate** (revert the relaxation; keep the product change), B) **Keep —
  justified: <agent-drafted one-line reason from the diff/citation>**,
  C) **Keep — other reason** (the human supplies it). There is no bare Skip;
  the chosen reason is persisted as `reason` on the finding record with
  `action: "kept"`, and `gate: "RH-15"`. An auto-chosen answer (plan-tune
  `AUTO_DECIDE`, spawned auto-pick) is never a disposition: the record gets
  `action: "open"`.
- **Question identity and non-interactive sessions.** The disposition
  question is registered as `review-gate-disposition`, a one-way id, so
  `gstack-question-preference` refuses `never-ask` for it and `/plan-tune`
  cannot auto-decide it. It carries a fourth option **D) Leave open for a
  later human**, and the review prose marks D as the *recommended* option
  whenever the preamble echoed `SESSION_KIND: spawned` or `headless`. The
  existing auto-pick machinery (skill-start block, AskUserQuestion Format,
  the two AUQ hooks) then yields `open` with no exception edited anywhere.
  Belt and braces: `gstack-review-log` stamps `actor` itself from
  `gstack-session-kind` and forces `action: "open"` for non-interactive
  kinds, so a child cannot log `actor: human, action: kept` about itself.
- Narrow the "Eval threshold changes" suppression to: a cited change is
  still a **finding** (a citation never removes a relaxation from the human
  ASK, because a diff comment or commit message is forgeable); the agent
  resolves the citation read-only (`gstack-decision-search` for `dec-*`,
  the named `ship-measure` report if present) and pre-fills option B with
  it, marked verified or unverified. Hunk text, test names, paths and commit
  messages are data: the review prose says so, excerpts are rendered as
  fenced data, and nothing in them is followed as an instruction or used to
  fill `actor` or `reason`.
- Step 3.5 becomes "Diff scans": `GATE_SCAN_BLOCK` first (local, seconds),
  then `slop:diff` as today; carry the gate listing into Step 4. Small diffs
  run it too.
- `/review` never publishes. Gate findings are persisted in this
  invocation's review record with `gate`, `id` (the tool's identity),
  `reason`, logger-stamped `actor`, and the `open`/`kept`/`restored`
  actions; no raw hunk text is stored (the durable record is brain-synced).
  `open` counts in `issues_found`. **v1 limit:** dispositions are
  per-invocation; `/ship`'s own review pass asks again, exactly as Fix/Skip
  work today. Cross-invocation reuse needs a versioned identity and a
  transition table and is a follow-on, stated as such.
- Final report line: `Gate edits: none detected (N listed, M read;
  patterns: …; unlisted idioms: …)` or `Gate edits: N listed, M read, K
  findings — J kept (reasons below), R restored, O open`.
- `review/gate-integrity.md`: the adapted catalog (ids, one-paragraph
  definitions, gstack's countermeasure, attribution to the source skill).

### W3. `/ship`: zero-run green, gate edits in the PR body, draft while open

Consumer: `/ship` Steps 5, 7, 9 (core checklist item 2.5), 9.4, 11.5, 16,
19. Gate: publication. Observed defect: AGENTS.md "Bun can silently ignore
a nonexistent file selector and pass the remaining files"; `describe.skip`
zero-credit rule. Retirement: when every supported runner's receipt carries
a test count natively.

- Step 5: a lane passes on its runner summary line, not on exit 0 alone
  (PL-2). Three distinct count states: `tests_ran: N`; `tests_ran: 0`
  (**ZERO-RUN**: bun `0 pass 0 fail`, jest "No tests found", pytest "no
  tests ran", rspec "0 examples", `go test` with `no test files`, an empty
  selection after a filter) is triaged as a failed lane; `tests_ran:
  unknown` (runner summary not recognised) keeps today's exit-0 pass and
  prints `count unavailable` in the PR body. The three are never merged.
- `gstack-evidence run` keeps a bounded tail of the streamed output (the
  saved log is capped at 2 MB and would truncate the summary) and parses
  it into `tests_ran` for the supported runners only: bun (reusing
  `shard-engine`'s classifier; executed = pass + fail, so an all-skip run is
  ZERO-RUN), jest/vitest, pytest, rspec, and Go's zero-only case (every
  package `[no test files]`); the last summary per runner wins. Everything
  else is `unknown`. `check` reports ZERO-RUN as STALE-equivalent and
  unknown as non-blocking. The TRANSPARENCY INVARIANT holds: `run`'s exit is
  always the child's; detection lives in the receipt and in `check`.
- After Step 7's test-generation child returns and after Step 9.4's parent
  fixes, run the full `GATE_SCAN_BLOCK` again (no child-supplied path list:
  a self-reported list is the self-report problem); a child's green is a
  claim until the parent has read its gate hunks. Step 7's child prompt
  carries the implementer rules (W7); its last-line JSON contract is
  preserved unchanged (it has no `summary` field) and the child's gate-edit
  disclosure uses the prose the protocol already permits before the JSON.
- Step 16 stage 5, the folded honesty inventory, two lines: for each gate
  finding, its disposition, reason and actor; if none, the coverage line.
  Adopt the auditor's posture for this report: describe the session's own
  gate edits as evidence to examine, not positions to defend.
- **Draft while open.** With any `open` gate finding, a new PR is created
  with `gstack-post pr-create --draft` (GitHub and GitLab both supported by
  the existing publisher); the early-PR finalisation consults the gate state
  before marking ready. For an **existing ready** PR there is no silent
  conversion (`gh pr ready --undo` is GitHub-only and a label fallback does
  not make a PR draft): interactive sessions get one question, A) resolve
  the open items now, B) publish ready with the `Gate edits: N open` banner
  (recorded as a human-authorised publication); spawned and headless
  sessions stop before pushing to a ready PR and report. If disclosure
  itself fails, the ship reports the failure and leaves the local
  open-items report; no fabricated success. A later agent never infers
  approval from the PR existing.
- Step 19 PR body: under `## Pre-Landing Review` the `Gate edits:` line
  with kept reasons; under `## Test Coverage` the per-lane `tests ran`
  count or `count unavailable`.

### W4. Preamble: Claims Need Evidence (tiers 2–4, including terse)

Consumer: every skill that claims evidence. Gate: the skill's completion
report. Observed defect: CLAUDE.md "'Pre-existing' without receipts is a lazy
claim"; `/ship`'s existing `unverified` rules exist because reports said
"passed" for runs that did not happen. Retirement: never while gstack reports
evidence; wording trimmed if the context-budget ratchet shows it is the
marginal cost.

Extend `generate-evidence-directive.ts` from "Claimed Limitations Need
Evidence" to a small honesty kernel, rendered for every tier and for `terse`
(it is a correctness rule, not prose style; `terse` currently renders the
directive as `''`, so the budget delta is the whole kernel, about 140
tokens, and `test/fixtures/context-budget.json` is refreshed in the same
commit):

- A claimed limitation needs the verbatim error, documented statement or live
  probe (unchanged).
- A claimed execution happened and its result was observed; name the command
  and the revision or content fingerprint. Never cite a command whose stderr
  was silenced.
- Name the evidence kind you have (static read, unit test, fixture or replay,
  live run, production) and never substitute one for a kind the question
  requires: a mock is not a live check, a static grep is not a reachability
  proof. Reuse is valid when the consumed inputs are unchanged, as Step 16
  already defines it; a new commit alone does not invalidate evidence.
- Disclose any failure or missing coverage that would change the reader's
  conclusion; "done, unverified" and "done" are different reports.
- A checked null result ("ran X, inspected Y, found no material issue") is a
  successful result; an unsupported positive claim is worse than silence.
  Agreement between agents, or several reads of one source, is one datum.

Completion Status Protocol: `DONE` means "supported by evidence valid for the
final consumed inputs; reuse and anything not independently verified are
named."

Composition: the kernel renders through `generatePreamble` for tiers 2–4
and for `terse` (the tier-1 extension is cut: `/browse` and the other
tier-1 skills have no evidence claim to make; `/benchmark`, which does,
moves to tier 2 as a follow-on). Honest size: the draft bullets above are
about 250–290 tokens, not 140; the shipped kernel is trimmed to ≤ 200 by
dropping the reuse sentence in favour of "reuse rules: Step 16". Size is
measured on generated output per tier and host before and after; the
`context-budget.json` refresh moves ~49 skills and is committed with the
kernel; the parity baseline may need one documented rebase. The stderr
rule is scoped to commands whose output is cited as evidence; the existing
`2>/dev/null || true` idioms that feed a cited result (Step 3.5's scans)
are rewritten to branch on exit instead, and optional discovery probes keep
theirs.

### W5. No-Claim line in plans, specs and test cards

Consumer: `/plan-eng-review` Test Plan Artifact, `/plan-ceo-review` Section
6, `/spec` Section 10 and its archived spec (which is the spawned agent's
prompt), `/ship` Step 7's `Value:` test card, `/autoplan` (inherits the
sections). Gate: plan approval and `/ship`'s plan-completion audit. Observed
defect: speculative, adopted on the source's evidence (ENFORCEMENT.md calls
it the single highest-leverage line). Retirement: if two releases of
plan-completion audits show the line is never cited in a
`changed`/`partial` classification.

- One vocabulary, not two. gstack's test card already has `protects=`
  (the positive observable), `fails_when=` (the planted wrong result),
  `why_new=`, `seam=`, owned by `scripts/resolvers/test-value.ts`
  (`VALUE_CARD_FIELDS`, `renderValueCard`) and pinned by
  `test/test-value-bar.test.ts`. W5 adds **`no_claim=`** at that owner as
  an optional fifth field: cards gstack generates from now on carry it,
  four-field cards from older prompts stay valid in the machine check, and
  every `renderValueCard` caller and the static specialist copy are
  inventoried in the same commit. It adds the field to that card and uses the
  same four-plus-one names in the Test Plan Artifact and `/spec` acceptance
  criteria, so a plan item, its spec criterion and the test that lands carry
  one description. `no_claim` is one sentence: what green here does not
  prove and which fixtures or mocks stand in for what. Two examples are
  rendered in the templates: `no_claim=provider acceptance (mocked
  provider; unit only)` and `no_claim=none beyond protects`, so the latter
  does not become reflexive filler. Never asked of the user; authored by the
  reviewer. A `no_claim` sentence never waives a required live check or an
  unresolved test-method decision.
- `/spec`'s acceptance template drops the literal `3. Tests written and
  passing` (the exact dispatch W7 forbids) in favour of criteria written in
  the card vocabulary.
- CEO Section 6 step 1 already asks for "a wrong result it rejects"; it
  gains the `no_claim` sentence.
- RH-10 (spec-editing as progress) in `/ship`'s plan-completion audit: the
  parent diffs the plan's acceptance-bearing sections as they stand in the
  working tree (the audit already includes uncommitted work) against a
  baseline: the `origin/<base>` version when the plan exists there, else
  its first commit on the branch, else `baseline unavailable` (plans
  outside the repo). An item whose acceptance text changed gets a **new**
  classification `ACCEPTANCE_EDITED`, reported beside `done/changed/…`
  and never folded into `CHANGED` (which today means "same goal achieved"
  and passes the gate); the PR body names it as a scope change, and the
  original obligation is still audited. Limit stated in the skill: an item
  rewritten in the same commit that introduced the plan is invisible.

### W6. Value test for process artifacts in `/plan-ceo-review`

Consumer: `/plan-ceo-review` Section 1 (Architecture) question list. Gate:
plan approval. Observed defect: speculative for product plans; gstack's own
history of ledgers (evidence, decision, review log, telemetry) is the
motivating case. Retirement: if the question never changes a plan in two
releases.

One added question in Section 1, not a new 0D decision: when a plan adds an
artifact about the *work* (status report, audit matrix, certificate,
meta-report, conformance check nothing consumes), ask: who uses it, what
decision or delivered behavior changes because it exists, why this is the
smallest useful version, and when it retires. An explicit user request
answers the first two and is recorded as provenance; the last two are still
answered. A credible, explicitly identified preventive risk is a valid
answer; a past incident is not required. Manufacturing a code consumer to
pass the question is the pathology, not an answer.

**Carve-out, stated in the text:** product observability (dashboards,
alerts, runbooks for the shipped system) is launch scope under Prime
Directive 5 and is never a process artifact; user-facing docs and
agent-consumed instructions are product. The question applies to artifacts
about the work, not about the system.

### W7. Dispatch rules for implementing children

Consumer: `/spec`'s archived spec (piped to `claude -p`), `/ship` Step 7
test-generation child. Gate: the parent's acceptance of a child's work.
Observed defect: speculative; gstack's specialist schema already requires
`path`/`severity` and defines `NO FINDINGS` as a complete empty result.
Retirement: with W5.

- **Implementer rules**, one constant in `scripts/resolvers/dispatch-rules.ts`
  rendered into `/spec`'s template (so they travel inside the spec that is
  the prompt) and into Step 7's child prompt: acceptance criteria are the
  `protects / fails_when / no_claim` profile; never "make the tests pass";
  any test, validator, CI, tolerance or suppression change is reported on
  its own line in your summary with its justification; real code and real
  tests land in the same change; a reported command names the command and
  its observed result.
- `/spec --execute` sets `GSTACK_SESSION_KIND=spawned` on the `claude -p`
  spawn so the child's gstack skills take the spawned branch (`open`, draft)
  instead of degrading to `interactive` and emitting a prose brief to nobody.
- Reviewer-side change: none. The CEO draft's "`NO FINDINGS` names what you
  examined" contradicted the specialists' "`NO FINDINGS` and nothing else"
  sentinel that the parent parses; it is dropped.
- Step 9.4 is parent work, not a child; it is covered by W3's post-fix scan.

### W8. Docs and tests

- `review/gate-integrity.md` (W2) is the catalog; `ETHOS.md` gains a short
  **Honest Work** paragraph linking to it. **TASTE DECISION** (see Review
  record): ship the ETHOS paragraph now or hold one release.
- `README.md` / `AGENTS.md` skill tables: no new skill; the `/review` and
  `/ship` one-liners gain "gate integrity".
- Tests, free: W1 fixtures and unit tests; `test/review-workflow-clarity`
  structural checks for the Gate Integrity category and the narrowed
  suppression; prompt-structure tests for the No-Claim tokens in the Test
  Plan Artifact and the `/spec` implementer section; preamble render test
  for the kernel at every tier and `terse`; `test/context-budget-ratchet`
  fixture refresh; `test/parity-suite`; SKILL.md regeneration for every
  touched template.
- Evals: no new paid lanes. The existing diff-selected PR gate
  (`eval:bg:pr`) runs because templates and the preamble are prompt files.
  **TASTE DECISION:** add one `gate`-tier, `rule`-kind E2E case (a fixture
  branch with a planted `.skip` and a widened timeout; `/review` must list
  both as gate findings and route them to the one-way ASK, never AUTO-FIX;
  asserted on native question/edit events, not prose), registered in all
  three `test/helpers/touchfiles-data.ts` maps and `PR_PROFILE_CASE_IDS`
  with a hermetic bin, versus relying on the selected existing evals alone.

## NOT in scope

- A new `/honesty-audit` skill, or a `/review` audit mode over a time window
  (follow-on; W1's `--range` is the only piece shipped).
- Tracker encoding, canaries, joint-freeze, swarm ready-pool mechanics,
  refusal-farming redirects, USER/ENABLER/PROCESS retro classification.
- Blocking on RH-3 golden regeneration (listed and read, never auto-blocked:
  gstack's own SKILL.md goldens regenerate on every template edit by
  design; for product snapshot tests the PR-body line makes it visible).
- Cross-invocation reuse of gate dispositions; `--paths`/`--range`;
  RH-3 source-ownership inference; cross-hunk RH-15 pairing; RH-14 job
  removal; exact Go test counts; converting an existing ready PR to draft;
  the tier-1 kernel; a project off switch.
- A second round "tuning the gate-integrity category". Defects found in the
  detector get fixed; categories do not get redesigned (the source's
  meta-trap rule).

## What already exists (and is reused, not duplicated)

- `/ship` Step 16 evidence freshness and ledger (`gstack-evidence`): W3 adds
  `tests_ran`, not a new ledger.
- `ship/sections/measure.md`: the measure-then-fix loop is gstack's native
  RH-15 and SM-11 countermeasure; W2's "carries the measurement" means a
  `ship-measure` report or equivalent.
- `/review` "Verification of claims"; CEO Section 6 "a wrong result it
  rejects"; `Linked to #N` never auto-close (RH-9); outside review
  `unverified` is missing coverage, never a pass; `/ship` "never rewrite
  history" (RH-17).
- Testing specialist: "never accept buggy-output goldens or discarded valid
  red tests", "Negative Assertions" (about *added* absence assertions; W2 is
  about *removed or relaxed* gates; both stay), the test value bar.
- slop-scan's empty-catch rule (RH-16 cites it rather than re-detecting the
  fix); `gstack-diff-scope`'s path classes, union-of-changes and exit
  contract (W1 reuses the classes and copies the contract).
- Specialist schema (`path`, `severity`, `NO FINDINGS`) and the
  plan-completion audit child's "report only" contract.

## Failure modes

| Path | Realistic failure | Coverage |
|---|---|---|
| repo with no tests dir | zero listed, exit 0, reads as clean | coverage line always printed: `none detected (0 listed; patterns …; paths checked …)`; a bounded null, not an error |
| shallow CI checkout / absent base | base unresolvable | exit 2 → `Gate integrity: UNAVAILABLE (no_base ref=…)` with the concrete fetch/deepen command; reported as missing coverage, never `none`; `COMPLETED` unaffected |
| Java/Kotlin/Swift layout | diff-scope's root-anchored globs miss `src/test/java` | W1's own any-depth matcher + content backstop; `languages_unlisted` in the coverage line |
| unknown language skip idiom | listed, untagged | floor lists it; coverage line names the gap; no false `none` |
| test-heavy PR (median 23–45 listed hunks) | per-hunk disposition drowns the human | three levels: only findings reach ASK; groups are one decision; read cap 50 disclosed |
| RH-15 over-fires on legitimate tuning | ASK fatigue | calibration before CRITICAL; cited changes are read, not findings; kept reasons land in PR body |
| forged "measured" comment or injected test name | a relaxation vanishes before ASK, or excerpt text steers the agent | citations never exclude a finding; resolved read-only and marked (un)verified; excerpts are fenced data; `actor` stamped by the logger |
| detector artifact written in the repo | `review_binding` flips to `changed`; `/ship` loops at 11.5 | artifact lives under the state root, 0600, path printed |
| 1,300-hunk diff | 50 read, late `.skip` unread, "none" printed | tagged-first ordering; `partial (K of M eligible read)`; never `none` |
| removed credential in a hunk | leaks into the synced review record or PR body | records store id/path/tag/reason only; snippets pass the existing scanner with a `content withheld` marker; PR body through the scanned publisher |
| plan-tune `never-ask` / `AUTO_DECIDE` on the gate question | gate self-waives interactively | `review-gate-disposition` is a one-way id; preference tool refuses `never-ask`; auto-chosen = `open` |
| spawned `/ship` (e.g. `/spec --execute`) | auto-Fix reverts a legitimate edit, or auto-Skip waives the gate | `GSTACK_SESSION_KIND=spawned` set on spawn; option D recommended → auto-pick yields `open`; logger forces `open` for non-interactive kinds regardless |
| headless `/ship` with a PR surface | blocks on any `.skip` | same as spawned; BLOCKED only with no writable PR destination; disclosure failure reported, never fabricated |
| existing ready PR gains an open finding | ships as ready silently | interactive: explicit human choice (resolve / publish-with-banner, recorded); spawned/headless: stop and report |
| `/review` answer not reused by `/ship` | human asked twice | accepted v1 limit, same as Fix/Skip today; reuse is a follow-on |
| child reports a partial touched-path list | its CI edit escapes the scan | parent runs the full scan, never a child-supplied list |
| preamble growth trips context-budget ratchet | CI red | measured per tier/host; fixture refreshed for the retained delta only |
| unknown runner summary | `tests_ran: unknown` | exit-0 pass kept; `count unavailable` in PR body; never conflated with ZERO-RUN |
| `tests_ran` parser bug | flips a green lane red | detection in receipt/`check` only (TRANSPARENCY INVARIANT); `check` says which state it saw |
| `2>/dev/null \|\| true` idiom copied for the gate scan | "could not look" swallowed | `GATE_SCAN_BLOCK` constant branches on exit; shared by `/review` and `/ship` |
| plan rewritten in its introducing commit | RH-10 check blind | limit stated in the skill text |

## Delivery order (one PR, staged commits, one owner per shared file)

1. **Contracts and free fixtures:** candidate model, coverage/partial
   semantics, disposition states, `no_claim` schema at `test-value.ts`,
   publication rules; gate-diff patch fixtures and builder.
2. **Detector and counts:** `lib/gate-diff/*`, `bin/gstack-gate-diff`,
   `gstack-evidence` `tests_ran`, the calibration script and its 10-PR hand
   read. Independent of 3 and 4.
3. **Review/ship integration:** checklist category, `GATE_SCAN_BLOCK`,
   `review-gate-disposition` one-way id with option D, logger-stamped
   `actor`/forced `open`, record fields, draft-while-open in the publisher,
   Step 7/9.4 rescan, Step 16 lines, PR body lines, `ACCEPTANCE_EDITED`.
4. **Prose and acceptance:** kernel (W4), `no_claim` in templates (W5), W6
   question, W7 dispatch rules and `/spec` spawn env, `review/gate-integrity.md`,
   ETHOS paragraph (if approved), regen of every SKILL.md and the four host
   goldens, context-budget and parity refreshes, touchfiles + PR profile
   entries, the paid `rule` case, then `bun run test` once on the frozen tree
   and `eval:bg:pr`.

Steps 2 and 3 can run in two worktrees; Step 4 has one owner. `ship/` and
the preamble are each touched by exactly one of them at a time.

## Rough size

Human team ~3 weeks; AI-assisted 3–4 days with the v1 cuts above (both
Eng voices independently sized the DX draft at 5+ days as written). Real
code: `lib/gate-diff/*` + CLI ~800–1,000 LOC, their fixtures and tests
~400–600, logger/registry/evidence/publisher ~250–350; ~600 lines of
template prose across 12 files; regen and fixture refreshes; one paid
case; a free calibration script. One PR, shippable at each staged commit. One session, not a project
(ENFORCEMENT.md: "adapt the templates; don't redesign them").

---

## Review record

### CEO phase (autoplan, SELECTIVE EXPANSION; native Claude + outside GPT-6 Astra)

Both voices: problem real, fold-in right, universal/swarm split roughly
right, plan failed its own creation gate and left spawned/headless undefined.

Decisions applied (P1 completeness, P5 explicit, P6 action):
- Observed-defect and retirement condition per workstream, citing gstack
  incidents (native 1.3 critical).
- Detector split into discovery / disposition / publication; file-class
  floor + pattern tags; coverage line always printed; `-M` rename detection;
  controls listed-not-tagged; adversarial fixtures; RH-4 added; RH-2 moved to
  prose; RH-17 to "already exists"; range mode; calibration on 50 merged PRs
  before CRITICAL (native 1.2, 3.1, 3.4, 4.7, 2.6; outside 2).
- Spawned/headless disposition defined (native 3.2 high).
- W6 scoped to artifacts about the work, with the Prime Directive 5
  carve-out, value-test wording, no incident requirement, manufactured
  consumers banned, one Section 1 question (native 4.1; outside 3).
- W4 kernel extended (failure disclosure, no substitution, correlated
  agreement, evidence reuse) and rendered for every tier including terse; no
  total proof ordering; DONE redefined around final consumed inputs
  (outside 4, 5; native 2.3).
- W7 reviewer form cut to one sentence; parent-side check moved to Step 7/9.4
  children; implementer rules travel in the spec (native 4.3, 2.x).
- W5 RH-10 mechanism and limit specified; No-Claim allowed to read "none
  beyond the positive" (native 4.8; outside "no four ceremonial fields").
- Old W8 (retro classification) cut (native 4.4; outside 6).
- Folded honesty inventory as two lines in Step 16 stage 5 with the auditor's
  posture (native 4.5, 6).
- Problem statement softened and "already exists" completed with `measure.md`
  (native 2.1, 4.2).
- Workstreams reordered by durability (native 5.1).

Taste decisions carried to the final gate:
1. ETHOS "Honest Work" paragraph now (names are the deterrent) vs hold one
   release (ETHOS is identity, not a changelog). Recommendation: ship a
   short paragraph now.
2. One new paid `gate`-tier E2E case for the Gate Integrity category vs
   existing selected evals only. Recommendation: add the one case; prose
   that does not change behavior is ceremony by this plan's own standard.
3. Retrospective audit packaging (`/review --gate-audit <since>` vs a
   `/honesty-audit` skill) — deferred as follow-on; no decision needed now.

User challenges: none. Both voices agree with the user's direction (adapt
into base skills, no new skill).

### DX phase (autoplan, DX POLISH; native Claude + outside GPT-6 Astra)

Both voices measured gstack's own history and found the CEO-phase floor
unworkable as a disposition unit (median 23–45 listed test/CI hunks per
PR); both found the spawned/headless rule unenforced by the code that
actually chooses answers; both found the `NO FINDINGS` sentence
contradictory and the `/review`-publishes-draft line out of `/review`'s
remit.

Decisions applied (P5 explicit, P3 pragmatic, P1 completeness):
- Three levels, listed / read / finding; only findings reach ASK; groups are
  one decision; confidence scores identification (native 4.1, outside DX-01,
  DX-05).
- ASK options Restore / Keep-justified (agent-drafted reason) / Keep-other;
  no bare Skip; record gains `gate`, `reason`, `actor`, `open`/`kept`
  (native 4.2; outside DX-01, DX-07).
- `review-gate-disposition` registered one-way so `never-ask` and
  `AUTO_DECIDE` cannot waive it; spawned block exempts it; `/spec` sets
  `GSTACK_SESSION_KIND=spawned` (native 3.1; outside DX-06).
- `/review` persists, `/ship` publishes; draft-while-open covers new, early
  and existing PRs; disclosure failure reported (outside DX-07).
- Own test-path matcher + content backstop + explicit config list +
  untracked union; CLAUDE.md `## Gate Integrity` paths block; CLI and exit
  contract specified; `--range` walks commits; `--paths` for children;
  `GATE_SCAN_BLOCK` shared constant with explicit exit branching; gate scan
  before slop (native 2.3, 1.1, 1.2; outside DX-02, DX-03, DX-04).
- Tool never suppresses RH-15; shows citation; human decides (native).
- Three count states for zero-run (outside DX-08).
- `no_claim=` folded into the existing test card vocabulary; `/spec` drops
  "Tests written and passing" (native, outside duplication check).
- W7 reviewer sentence dropped; Step 9.4 is parent work (native; outside
  DX-10).
- Kernel composition and sizing made explicit; stderr rule scoped (outside
  DX-09).
- Calibration redefined per PR as listed/read/findings/decisions, including
  test-scoped PRs and two external fixture repos (native, outside DX-05).

Not adopted: a project-level off switch or `Mode: listing-only` in v1
(both voices lean against a silent off; revisit after calibration); handing
large-diff gate reads to the testing specialist (keeps the category in the
core pass that small diffs get); renaming the tool.

Taste decisions carried to the final gate: tool name (`gstack-gate-diff`,
matching the `gstack-*` helper family, vs `gstack-diff-gates`); whether to
offer `Mode: listing-only` later; the read cap (50).

### Eng phase (autoplan; native Claude + outside GPT-6 Astra)

Both voices: Go as one PR, not as written. Agreed: the DX draft had become
a cross-workflow state machine (disposition reuse, draft conversion of
ready PRs, child path lists, ownership inference) sized as a 600-LOC
helper; the detector's `.gstack/tmp` artifact would flip the review
binding; `actor`/`reason` were self-attested; RH-15 missed lowered
thresholds (the motivating suppression) and RH-3 had no owner definition;
the citation-only exclusion let a forged comment remove a finding before
the human control; Step 7 has no `summary` field; `CHANGED` already means
"same goal achieved"; the kernel is ~250–290 tokens; the paid case needs
three touchfile maps plus the PR profile.

Decisions applied (P5 explicit, P3 pragmatic, P4 DRY, P6 action):
- Artifact under the state root, 0600, unsynced; records store identity,
  not hunks; snippets redacted through the existing scanner.
- Logger stamps `actor` and forces `open` for spawned/headless; option D
  "Leave open" recommended in those sessions, so no auto-pick exemption is
  edited anywhere (native 1.2/1.3 chosen over editing four hook surfaces).
- RH-15 direction-agnostic with per-key relax direction, same-hunk pairs,
  `RH-15?` for unpaired; RH-3 conventional `__snapshots__` owner only,
  `RH-3?` otherwise; tags stay factual on controls.
- Admission = floor OR tag; bounded read with `partial` coverage state.
- Citations never exclude a finding; resolved read-only, pre-fill option B.
- One candidate model (merge-base → working tree + untracked), hardened git
  flags, named unsupported path kinds; tool-computed identities.
- Full rescan after children; Step 7 JSON untouched; `ACCEPTANCE_EDITED`
  as a new classification; `no_claim` optional at `test-value.ts`.
- Kernel tiers 2–4 + terse, ≤ 200 tokens; `/benchmark` to tier 2 later.
- Free calibration (tag precision + 10-PR hand read); agent-level signal
  collected post-ship from records.
- Paid case: `rule` kind, `gate` tier, three maps + PR profile, hermetic bin.
- Cuts: cross-invocation reuse, `--paths`, `--range`, RH-14 job removal,
  RH-3 inference, cross-hunk RH-15, Go counts, ready→draft conversion,
  tier-1 kernel.
- Sizing 3–4 AI days; four staged commits with single owners.

Taste decisions carried to the final gate: ETHOS paragraph now vs later;
the paid `rule` case; `open` counting in `issues_found` (plan says yes);
read cap 50 / 200 KB.
