# Review policy: how gstack's reviews converge

This is the canonical statement of what a gstack review may block on, how the
`/ship` review loop converges, and what the ship receipt records about it. The
skills (`/review`, `/ship`) and the tools (`gstack-review-scope`,
`gstack-ship-receipt`) implement it; a team's own rules should point here
instead of restating it. A one-line crew rule is enough:

> Review convergence: gstack review policy (docs/review-policy.md), scope knob default.

## The blocking floor

A finding is **blocking** when it is a CRITICAL defect: it would fail a test,
break production, or lose data or secrets. Everything else is below the floor:
an advisory, an informational item, a test finding (category `testing`: a gap,
a weak or flaky test), a wording or naming note, a style or simplification
suggestion. Below-floor findings are reported, never fixed after pass 1 of a
ship, and never earn another review pass.

Three words cover every finding, and the loop budgets by them: a **blocker** is
the intended case gone wrong (the floor above); a **should** is a real bug a
caller will hit inside the intended case (fixed when it is in the diff on pass
1, deferred when it is not); a **nit** is the rest (a named note). Two stop
rules follow: if a pass's fixes grew the diff past what the request needs, cut
that growth first; and the cap approves nothing, so a standing blocker is
reported, never waved through.

Before a merged finding counts, the parent applies lead judgment
(`review/sections/review-army.md`, `ship/sections/review-army.md`, stage 4 of
the merge): a reviewer whose whole return is nits found nothing; a defect names
the call site or input that reaches it, or it is a note; structure for a case
nothing takes is advisory; "I would have done it differently" is not a finding;
a finding that assumes a rule the repository documents otherwise is dropped with
the pointer. Independent agreement between reviewers is the strongest signal.

Every reviewer prompt gstack dispatches (the core checklist, each specialist,
the Red Team, the outside voice) carries this definition: CRITICAL means the
floor above; everything else is INFORMATIONAL. Data loss, a trust-boundary
bypass and uncapped spend stay forced CRITICAL (the sideways sweep rule); no
lane, specialist, dedup or saved decision downgrades them.

<a id="rulings-below-the-floor"></a>
### Rulings below the floor

The floor is a test, and these classes have been put to it, each more than
once, and failed it (#3485 from the /ship of #3484, #3504 from the /ship of
#3487). A finding in one of them is a **note** from the first pass on, named
by its ruling in the PR body's `## Review notes`; it never earns a fix round
or another review pass, and the lead judgment stage drops it from the defect
count with the pointer. The floor itself does not move, so a finding that also
loses data, crosses a trust boundary or spends without a cap stays CRITICAL
whatever class it resembles.

| Ruling | What it looks like | Why it is below the floor |
|---|---|---|
| **own-artifact hardening** | A check missing between two things the repository's own tooling writes: a screen verdict not compared with the receipt it belongs to; a receipt schema that does not declare a key the writer records; a policy loader that defaults when the base branch's own file is invalid; a size read that follows a symlink inside the repository. | The only writer is the repository's maintainers through its tools; no caller inside the intended case reaches the gap, and no test fails. A writer outside that trust boundary makes it a bypass, and CRITICAL. |
| **unwired or unread** | A helper with no caller, a field written and never read, a duplicated helper, a header comment naming a step that does not run it, a key-version constant that moved before any release carried the old value. | Nothing takes the path, so nothing breaks; it is dead code to delete or wire in its own change. |
| **bounded repeat work** | A re-dispatch on every call, a redundant screen after main moves, an orphaned scratch branch, a refusal that could come one step earlier in the sequence, a settle that could wait one more check. | The operation completes, nothing is lost, and the cost is one more bounded run; uncapped spend is the sideways sweep's CRITICAL, not this class. |
| **conservative refusal** | Stale state scoped wider than its cause: a RED verdict that keeps refusing a head after main moved, a pending result that keeps refusing after it settled. | A refusal costs a rerun and never passes something wrong; a wrong pass would be the floor. |
| **artifact presentation** | A string from an artifact printed verbatim into a parsed line (whitespace, control characters); a classifier that reads a non-zero exit code beside a non-RED verdict as RED. | Display and classification of the repository's own output; it forges no parsed field. |
| **test gap** | A state-matrix cell without a test, a coverage percentage, a weak or flaky test, a fixture that shares the coordinator's environment. | Category `testing`, below the floor by definition above; a gap is work for the test audit, not a defect in the diff. Precedence for state machines: the specialist still reports each untested cell CRITICAL so `gstack-state-matrix check` proves the matrix complete, and `gstack-state-matrix findings` maps it to INFORMATIONAL per matrix cell before the merge; a wrong row or collapsed kinds stays CRITICAL, and a cell with a second finding keeps both. |

A reviewer that wants a class promoted argues it against the floor with a
reaching input, in the finding, and the owner rules; the table records the
rulings, it does not close them.

## `NO FINDINGS` is a result

A reviewer that finds nothing answers `NO FINDINGS` and nothing else. That is a
completed, clean result, never a failed review and never a reason to invent an
item to show work. Missing or unusable reviewer output is the opposite:
incomplete coverage, which blocks until the reviewer is rerun.

## How `/ship` converges (`review_scope: frozen`, the default)

1. **Pass 1 reviews the whole diff** against the merge base. Every finding goes
   through `gstack-review-scope classify`, which stamps it with `locus` (`diff`:
   a hunk the PR changed, with three lines of context; `outside`: anything else),
   `kind`, `blocking` and `scope`. Findings in the diff are `fix`. A blocking
   finding in code the PR did not change is `defer`: `gstack-review-scope defer`
   files it as a GitHub issue (one per finding, reused across reruns through an
   `<!-- gstack-deferred-finding: <fingerprint> -->` marker; the issue text is
   scanned like the PR body before anything is posted, so a finding that quotes a
   secret is `unfiled (publication scan refused: …)`; `unfiled (<reason>)` when
   `gh` is unavailable or its search fails; every unfiled case still exits 0)
   and the PR body lists it under `## Deferred findings`. A finding's `cause`
   (the changed line behind a defect reported elsewhere, a deleted file included)
   places it in the diff.
   Below-floor findings outside the diff are `note`, listed under `## Review notes`.
2. **What comes next is the transition table below**, not "any fix earns
   another pass". A full pass after pass 1 reviews only the range since the
   previous pass: each pass saves its head, the next diffs `RANGE_BASE..HEAD`
   for every reviewer (the gate scan and QA probes keep the whole candidate) and
   classifies with `--range-base`. Only a blocking finding in that range or in
   the diff is `fix`; every below-floor finding is a `note`.
3. **Two full passes is the cap**, plus at most one fix-check; a scoped pass
   ([below](#scoped-pass)) is a full pass. A blocking
   finding still open after the last allowed step stops the run and names the
   finding (path, severity, problem) for the owner; a third full pass is the
   owner's call, never the loop's. The cap approves nothing.

<a id="transitions"></a>
### Transitions

`gstack-review-plan` (`lib/review-depth.ts` `nextStep`) owns this table, and
/ship asks it after every step:

| The step that just finished | Next |
|---|---|
| none | full pass 1 on the whole diff |
| a full pass with no edits | done |
| a full pass that fixed a blocking finding, below the cap, on a diff below full depth with a fix range of at most 150 runtime lines | scoped pass on the range |
| a full pass that fixed a blocking finding, below the cap (full depth, a larger range, or a range or depth it could not read) | full pass on the range |
| a full pass whose fix touched a gate-class path, below the cap | full pass on the range |
| a full pass that fixed only below-floor findings | one fix-check |
| a full pass at the cap that fixed a blocking finding | one fix-check |
| a full pass that leaves a blocking finding open (fixed or not) | stop: name it for the owner |
| a fix-check that found nothing blocking (below-floor fixes before it included) | done |
| a fix-check that found a blocking finding | stop: name it for the owner |

A **fix-check** is one reviewer reading the touched hunks, the fix list, the
test results and the callers of every changed symbol, at full effort. It is
logged as a `review-fix-check` row, so it never counts as a pass. No army, no
Red Team and no outside voice run on it.

<a id="scoped-pass"></a>
A **scoped pass** is pass 2 after a blocking fix when pass 1 and the diff both
ran below full depth (no gate class, no depth error, no `--depth-floor full`).
A full pass 1 always gets a full pass 2: `--pass1-depth` carries pass 1's
`REVIEW_DEPTH`, and an absent flag counts as full. The fix range
`RANGE_BASE..HEAD` must have at most `SCOPED_RANGE_LINES` (150) runtime lines, counted
as the depth counts them (`gstack-review-plan --range-base $PASS_HEAD` prints
`FIX_RANGE:`). It dispatches one fix-check on the range, the Red Team on the
range, the native adversarial pass when the range changes runtime lines, every
force-included specialist and the outside voice when published numbers changed.
Step 11's voices that have not run yet stay listed, as on a full pass 2. It
writes a full-pass `review` row with `"scope":"scoped"`, so it counts toward
the cap, and a blocker it leaves open stops for the owner as before. A fix that
touched a gate-class path (read from the range with its own scope and gate
scan), a larger range, an empty range, or a
range, classifier or depth it cannot read keeps the full pass 2. The 150-line figure is a starting value from
a 24-PR backtest (GSTA-152 D6), to revisit once classified findings carry
`raised_by`.

The same floor and the same `NO FINDINGS` rule apply to `/review` on its own;
its re-review loop keeps its three-cycle fix cap (`CYCLES`), and a pass that
applies no edits is its exit too.

<a id="review-depth"></a>
## Review depth by diff class

`gstack-review-plan --base <base>` classifies the diff, picks a **depth** and prints
the reviewers the next step dispatches: `REVIEW_CLASS:`, `REVIEW_DEPTH: <d>
runtime_lines=<n> rules=<hash> reasons=<…> codes=<…>`, `GATE_SCAN: tagged=<n>|unavailable
head=<sha>`, one `DEPTH_ERROR:` per input that failed closed, one `DISPATCH:` per reviewer
with its effort and a shell-quoted `DIFF_CMD:` (plus `DIFF_EXCLUDE: <name> none` when it
reads everything), one `SKIP:` per reviewer left out, and `--json` with the same fields.
A plan that fails closed to full exits 0; a diff git cannot list exits 1.

**Classes** are unchanged. A mixed diff takes its most restrictive class: **docs**
(markdown no agent or gate reads), **tests** (test files and fixtures), **code**
(everything else, including every `SKILL.md` and template, markdown in a skill
directory, `*/sections/**`, `scripts/resolvers/**`, rule docs, checklists and bins) and
**gate** (code plus auth or migration scope, a hunk the gate scan tags, a deleted code
or test path, CI workflows, credential, state-root and the paths below).

**Runtime lines** are the changed lines of code-class paths, minus outputs the base
commit's `.gstack/generated.json` registers. Docs, tests and release metadata are never
runtime; a `.tmpl` edit plus its regenerated `SKILL.md` counts the template once.

**Data files no code names are docs.** A changed or deleted JSON, JSONL, NDJSON, CSV,
TSV or raster image (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF) counts as docs when no
non-docs file names its basename at the head, at the merge base or, for live /ship, in
the working tree with untracked files; a data file named only by another data file
follows that file, four files deep. Precedence: agent prose (`.gstack/**`), a test or
fixture path, a gate path, a config file (`.github/**`, anything under a `config/`
directory, dotfiles, `*.config.*`, `package.json`, lockfiles, `tsconfig*.json`,
`manifest.json` and the other tool manifests `lib/review-depth.ts` lists) and a named
consumer each keep the path code, and YAML, TOML and SVG are always code. More than
2,000 data paths keep every one code; a `git grep` failure is `consumer_scan_failed`
and fails the depth closed. Only `classifyDiff` applies the rule (`lib/review-collect.ts`
finds the consumers, `gstack-ship-preflight`'s `RUNTIME_LINES` reads the same
function); every path-only caller (the receipt's gate-scan decision, the Step 16
post-review route, /autoplan's docs-only scope) keeps data files code. A numeric claim
in a data file still schedules the outside voice.

| Depth | When | Pass 1 dispatches |
|---|---|---|
| **light**, runtime 0 | docs and tests only, or only registered outputs | the core checklist only; the outside voice when the diff publishes numbers |
| **light**, runtime 1–50 | `SMALL_DIFF_LINES` or fewer runtime lines | core, one **batched** specialist (the batched checklists below plus the Red Team prompt in one context), the native adversarial pass (kept: backtest inconclusive, GSTA-147 D5) and the outside voice on numbers |
| **standard** | more than 50 runtime lines | one batched specialist at `medium` and the Red Team at 200 runtime lines (or on a CRITICAL); the batched reader leaves docs and registered outputs out of its diff; adversarial and outside voice read everything |
| **full** | gate class, or any classifier error | one batched specialist on the whole diff, the Red Team always, no hit-rate gating |

**Batched checklists (the lean ensemble, GSTA-167 part 2).** One specialist
subagent reads Testing and Security on every code or gate diff, plus
State-machines, Data-migration, API-contract and Design when scope asks (a
forced checklist always joins). Maintainability, Performance and Simplification
are read only when forced (`SKIP:` names them). The Red Team reads the batched
reader's merged findings. A free re-score of saved C and D findings lost 0 of
the 29 blockers (handoffs/GSTA-167/lean-ensemble-rescore.md); the live round 5
replay passed (L∘G1 found 24 of 29 blockers against the control's 21,
handoffs/GSTA-167/noloss5-results.md).

A fixed blocking finding, a CRITICAL or an open blocker raises a light diff to
standard for the next step (`step=standard`): its specialists read at least 50 lines
and the Red Team runs, so a raise never dispatches less than light did. When the
next step is a scoped pass, the raise applies to the scoped set only. A fix-check
is the same at every depth.

**Fail closed.** Each of these makes the depth full and is listed in `errors[]` with
the input it could not read, a sanitized cause and the repair: a `gstack-diff-scope`
error, a gate scan that is unavailable, a base registry that cannot be read or is
invalid (`REGEN_REGISTRY_INVALID` or `REGEN_CONTAINMENT` in `codes=`), a numstat git
could not produce, and a binary code-class path (it is never counted as 0 lines).

**The registry rule.** Only the base commit's registry counts (the merge base's
`origin/<base>` commit for live /ship and the current base ref's commit for the queue: `origin/<base>` in `ready`, `<remote>/<base>` in `train build`), and only
entries with a `command`, which pregate's regen check proves for that tree. An entry
added on the branch never excludes anything; `command: null` entries, vendored code
and lockfiles stay runtime. To adopt it, commit an entry like this on the base branch:

```json
{
  "$schema": "https://github.com/garrytan/gstack/docs/pregate.md#generated-v1",
  "entries": [
    { "id": "skill-docs", "command": "bun run gen:skill-docs --host all", "outputs": ["*/SKILL.md", "*/sections/*.md"], "inputs": ["*/SKILL.md.tmpl", "*/sections/*.tmpl"] }
  ]
}
```

**Gate paths for the machinery itself.** An edit to `lib/review-depth.ts`,
`lib/review-collect.ts`, `bin/gstack-review-plan`, `lib/review-scope.ts`,
`lib/review-targeted.ts`, `review/specialists/targeted.md`, `lib/ship-queue*.ts`, `lib/regen.ts`, `.gstack/generated.json`,
`ship/sections/review-army.md.tmpl`, `ship/sections/adversarial.md.tmpl` or
`scripts/resolvers/review-army.ts` is gate class: changing how much review runs gets
the most review. `rules=` (`DEPTH_RULES`) hashes the deciding constants and patterns,
not file bytes, so a comment edit keeps it.

**`--depth-floor standard|full`** (a /ship prompt flag, passed to every plan run)
raises the depth and never lowers it.

**Numbers keep the outside voice.** At light depth the outside voice runs only when
the diff publishes numeric claims: `gstack-review-plan` scans the added lines of
prose and data files for percentages, money, multipliers, durations, token or credit
counts and score, rate or speed claims (`NUMBERS: yes`). The claims' fingerprint
(`fingerprint=`) is passed back as `--reviewed-numbers`; when a later fix changes a
claim, only the outside voice reruns, on the numbers. It always reads the whole diff.

**The adversarial and outside voices run once per invocation** (Step 11, on the
final tree), as the last full-pass plan lists them; after they ran, decision 2
passes `--adversarial-ran` so a repeat lists them no more. Later full passes rerun the
specialists on the range only. Step 11.5 binds a planned skip through the Step 9
record's `CURRENT` freshness instead of a native record.

**Effort.** The core checklist, the Red Team, the native adversarial pass and
fix-checks run at `full` effort (the lane's reasoning); specialists run at
`medium` (GSTA-167 part 3: the no-loss controls ran them there), except light's
batched specialist, which carries the Red Team prompt and stays `full`. The
outside voice and the native adversarial pass carry the floor sentence and end
each finding with `Severity:` and `Blocks: yes|no`; a finding is CRITICAL when
its label rule says so (native FIXABLE, outside Critical or High) or it says
`Blocks: yes`, and `Blocks: no` never lowers one (`gstack-review-dispatch collect`). Work that cannot block (the Step 7 coverage audit, the Step 8
plan-completion audit, the Step 14.5 docs audit, decision-trail reviewers,
watchers) runs at `light`: the same model at a lower reasoning effort, never a
cheaper model family. The outside voice keeps its own provider and effort
(`codex_effort`). A host that cannot set a subagent's effort runs it at its
default. `gstack-config set review_effort_tiers off` (or `--no-tiers`) runs
the specialists, audits and watchers at the host default too
([model-policy.md](model-policy.md#reasoning-effort)).

### Behavior changes

- Pass 2 after a blocking fix on a diff below full depth, with a fix range of at
  most 150 runtime lines, is a [scoped pass](#scoped-pass): a fix-check and the Red
  Team on the range, plus the native adversarial pass (on the range once Step 11 has
  run, otherwise on the whole branch), instead of the specialist army.
- A tests-only diff (runtime 0) no longer dispatches the Testing specialist: the
  core checklist and the gate scan review it.
- Every depth dispatches one batched specialist instead of one reader per
  checklist; Maintainability, Performance and Simplification run only when forced.
- Light no longer runs a separate Red Team: the batched specialist carries its
  prompt. At runtime 0 light runs no adversarial pass either.
- Standard reads thresholds on runtime lines, not the whole diff, so a test-heavy
  diff with few runtime lines dispatches fewer specialists.
- A JSON, CSV, TSV or raster data file no code names is docs, not runtime (GSTA-167
  part 4a). A binary image no code names is no longer a `binary_code_path` error
  that forces full depth; one that code names still is.

## Targeted pass on money, gate, auth and secret code

Some code is costly to get wrong: code that spends money, code that decides
whether a check passes, code that decides who gets in, and code that handles
secrets. When a diff touches one of these, `gstack-review-plan` dispatches one
more reader, `targeted`, at every depth, light included. It reads the whole
diff, fixtures and tests included, with the blocks of
`review/specialists/targeted.md` for the classes that hit, and it runs in Step
11 beside the native adversarial pass and the outside voice (GST-257).

`lib/review-targeted.ts` decides the classes from added and deleted lines, so
removing a cap, a check or a redaction counts. Docs and tests paths never count,
and matching is token-bounded: `costume` never reads as cost.

| Class | Signal |
|---|---|
| money | a path segment naming cost, spend, budget, ledger, billing, price, fee or invoice; or a changed line with an identifier ending in `_usd` or `Usd`, any `spend_cap` spelling, or a call to a paid provider `lib/pricing.ts` prices |
| gate | a hunk the gate scan tagged: a relaxed threshold, a skipped test, a loosened check |
| auth | `SCOPE_AUTH` from `gstack-diff-scope`, on a code path with an auth, session, jwt, permission or role token in its name |
| secret | a secrets, credentials, keychain or token path, or a changed line that reads a key-named environment variable (`OPENAI_API_KEY`, `GH_TOKEN`) or a credential store |

An input the classifier cannot read (the diff, `gstack-diff-scope`, the gate
scan) fails closed to all four classes. `TARGETED_RULES` hashes the patterns.
The classifier and the brief are gate paths, so an edit that weakens them gets
full review.

The plan prints `TARGETED: classes=<money,gate,auth,secret|none> rules=<hash>
brief=<sha256 of the brief> targeted_patch_id=<id>` and, when a class hit,
`DISPATCH: targeted targeted effort=full`. The targeted reader always reads the whole diff: `render --role targeted`
refuses a `--diff-base` other than the merge base, so on pass 2 and later it
gets the merge base, not `RANGE_BASE`. After a fix, pass
`--targeted-ran <targeted_patch_id>` from the line the reader ran on: the same
committed patch skips the reader, and a changed one, uncommitted edits or
`none` dispatch it again. `targeted_patch_id` is the patch-id of the whole
committed diff, tests included, so a test-only fix that adds a gate hunk
dispatches it again; it is not the receipt's `product_patch_id`.

The brief states the blocking floor in one sentence, and its money block cites
the checklist's Forced-CRITICAL rule on uncapped spend, so a money finding can
block without new floor words. The reader is read-only, and `NO FINDINGS` is a
result. `gstack-review-dispatch render --role targeted --classes <classes>`
renders its brief; `verify --targeted-out <file>` writes the record that
`gstack-ship-receipt write --review-targeted @<file>` puts in the receipt.
`gstack-ship-queue ready` and `train build` print
`REVIEW_TARGETED: required=<classes|none> receipt=<classes|none|legacy>
verdict=ok|missing` and refuse nothing yet; enforcement comes in a later
release.

Over the last 100 non-release commits on main (8663c3d2..8be7f213), money hit
21, gate 18, auth 3 and secret 8. The gate class first used the gate paths,
which hit 43 of 100; those paths already get full depth, so the gate class was
narrowed to the gate scan's tagged hunks.

## What the receipt records

`gstack-review-scope summary --since <REVIEW_SINCE>` reads this invocation's
review-log rows and writes the counters `gstack-ship-receipt write --review-loop`
puts in the receipt:

| Field | Meaning |
|---|---|
| `review_loop.passes` | full review passes this ship ran (1 or 2; up to 3 under `review_scope: all`) |
| `review_loop.blocking_found` | distinct blocking findings across the passes |
| `review_loop.deferred` | blocking findings in unchanged code filed as issues (a Step 11 late defer, logged as a `review-late-defer` row so it never displaces the newest `review` pass, counts here and is not a pass) |
| `review_loop.noted` | below-floor findings listed in the PR body |
| `review_loop.fixed` | findings fixed in this PR |
| `review_loop.scope` | the `review_scope` the loop ran under |
| `review_loop.fix_checks` | fix-checks this ship ran (never passes) |
| `review_loop.dispatches` | reviewer dispatches by role: `specialist`, `red-team`, `adversarial-native`, `outside-voice`, `fix-check`, `targeted` |
| `review_loop.est_input_tokens` | prompt plus diff bytes the dispatches read, divided by 4: a relative estimate for comparing runs, not a bill |
| `review_targeted` | the [targeted pass](#targeted-pass-on-money-gate-auth-and-secret-code): the `classes` it covered, `rules`, `brief_sha`, the receipt's own `product_patch_id`, `status` (`done` only with its output collected and the committed diff it was rendered on still the one at verify, else `failed`; absent when write got no record, which the queue reports as `legacy`), `findings` and `raised_by`; a carry keeps it while the product patch is unchanged |

Each review row may carry `dispatches: [{role, effort, prompt_bytes,
diff_bytes, status}]`, and each finding `raised_by` (the reviewer that raised it,
stamped by `gstack-review-scope classify`; `unknown` when untagged, absent on older rows); `summary` adds them up (older rows fall back to the
specialist stats they record). The summary line appends `fix_checks=`,
`dispatches=` and `est_input_tokens=` only when they were recorded, so an old
loop prints the old line.

Beside the counters, `write` records `review_depth` (the depth, runtime lines,
rules hash, base and registry commits, and the gate scan bound to the head) and
the queue refuses a receipt below the depth its head needs
([ship-policy.md#ship-receipt](ship-policy.md#ship-receipt)). A stop the owner
accepted after a fix-check edit goes in `review_loop_exception`, never in prose
under `REVIEW_LOOP:`.

The receipt's summary line prints `passes=<n> blocking_found=<k> deferred=<m>`,
which is what a scorecard tracks (target: a median of 1 pass per PR). A
receipt carried across a base merge or a test-only fix
([ship-policy.md#receipt-carry](ship-policy.md#receipt-carry)) keeps these
counters, because the reviewed product diff is unchanged.

## The scope knob

`.gstack/ship-policy.json` `review_scope` ([ship-policy.md#review-scope](ship-policy.md#review-scope)):

| Value | Pass 1 | Blocking finding in unchanged code | Pass 2+ | Cap |
|---|---|---|---|---|
| `frozen` (default) | the diff | filed as an issue, listed as deferred | the range since the previous pass, blocking only | 2 full passes + 1 fix-check |
| `diff-plus-blocking` | the diff | fixed in this PR | the range since the previous pass, blocking only | 2 full passes + 1 fix-check |
| `all` | everything | fixed in this PR | the whole diff, every finding | 3 fix cycles |

`diff-plus-blocking` is the fallback for a repository where deferred issues pile
up; `all` is the loop as it ran before the key existed. A value other than
`frozen` needs `min_gstack_version` at or past the release that added the key
(`REVIEW_SCOPE_KEY_VERSION` in `lib/ship-policy.ts`) so an older gstack refuses
the file by name instead of ignoring the key.

## Reviewer fan-out

The review army launches every selected specialist in one message so they run
in parallel; a host that caps running subagents makes that impossible past the
cap. In `/ship` the knob is a prompt flag, `--review-fanout auto|serial|parallel`
(default `auto`), read where the force flags (`--all-specialists`) are (`/review`
on its own keeps the single parallel batch: its generated SKILL.md sits at its
size pin, and a refused launch there is a failed reader, never dropped coverage):

| Value | Batches |
|---|---|
| `auto` | when the host reports fewer free subagent slots than selected specialists, batches of the free-slot count (at least one), each launched in one message, the next only after every reader of the previous one finished or is confirmed stopped; a host that reports no slot count runs one parallel batch |
| `serial` | batches of one |
| `parallel` | one batch regardless of slots; a refused launch is a failed reader, never silently dropped coverage |

Capy caps a thread at 8 running subagents, and waiting or idle ones hold a
slot, so under `auto` a nine-specialist review on an otherwise idle Capy
thread runs as one batch of 8 and one of 1 (`Fan-out: 9 specialists in 2
batches of 8`). Batching changes the order, never the set: every selected
specialist runs before the merge stage, and the Red Team's activation reads
the merged result as before.

## Two checklist rules with ids

Two findings `review/checklist.md` names by rule id so a PR body, a review log
and a later reader agree on what was flagged:

- `prereg-with-results` (Pass 1, Gate Integrity, ASK): one diff adds or changes
  an eval's preregistration (bars, arms, decoys, stop rules, a plan file) and
  also adds that eval's results, scores or verdict. The bar could have been set
  after the outcome, so the pairing is the finding. The repair is a split: the
  preregistration lands first and the results PR cites its merged commit.
- `test-keyboard-count-loop` (Pass 2, informational): a browser-driver test
  reaches an element by a counted loop of key presses and asserts on whatever
  has focus, so the count encodes today's DOM order. Locate the target by role,
  label or test id; a counted loop stays only when the count is the behavior
  under test.

<a id="porting-a-contributors-work"></a>
## Porting a contributor's work

A ported branch keeps the contributor's commits as theirs and adds the
porter's fixes on top, each crediting the original authors.
`gstack-coauthor-trailers [<range> | --base <ref>] [--message <file>]
[--exclude <email>]...` lists every distinct author of the range's commits
(default `origin/<base>..HEAD`) other than the checkout's own committer
identity, in first-appearance order, as `Co-authored-by: Name <email>` lines;
`--message <file>` adds the ones the commit message file lacks to its trailer
block (`git interpret-trailers`, pinned placement, so an existing co-author
keeps attribution), matched by
email case-folded, so running it twice changes nothing. The `COAUTHORS: <n> in
<range>` line on stderr is the receipt; `--json` prints `{ range, authors,
trailers, appended }`.

## Verbatim dispatch

A driven `/ship` (ship/DRIVER.md) never lets the model write a reviewer's brief
or merge a reviewer's findings. The no-loss replays showed why: with briefs the
parent filled in by hand, only 37 of 112 dispatched prompts matched the rendered
ones, and the arm lost blockers. `bin/gstack-review-dispatch` closes both ends:

1. `render --role <role> [--name <n>] --out <dir>` cuts the brief out of
   `ship/sections/review-army.md` or `ship/sections/adversarial.md` (the fix-check
   from `scripts/resolvers/fix-check.ts`) and fills only declared slots: the
   literal diff base, the plan's `DIFF_CMD` excludes, stack, test framework,
   learnings, checklist paths, the Red Team's merged findings and specialist count,
   and the outside voice's branch diff. A section that lost an anchor or placeholder
   refuses (`BRIEF_RENDER_FAILED`) instead of rendering something else.
2. The dispatch program passes that file's content unchanged as the reader's
   prompt and runs `sent` on what it passed: a hash that differs from the rendered
   one is `BRIEF_MISMATCH`, and that reader's review does not count.
3. `collect` hashes each reader's raw output and appends its findings to
   `merged.jsonl` with the label as written (a JSON line's `severity`, or the most
   severe of a prose line's Critical, High, Medium, Low, P0-P3, FIXABLE or INVESTIGATE
   wherever they stand, headings and table rows included; a top-level list item under a
   label-only heading takes the stronger of the two). A `Severity:` or `Blocks:` line
   continues the finding above it until a list item, heading, bold paragraph opener or a
   second line for the same field starts another: `Severity` raises its label,
   `Blocks: yes` makes it CRITICAL and `Blocks: no` never lowers it; an inline
   `Blocks: yes` is CRITICAL too, and with no finding above it is one. The native
   adversarial voice's FIXABLE collects as CRITICAL (normalizer v2, GSTA-167). An unnumbered, unlabeled bullet with no file:line
   under a paragraph finding whose Severity or Blocks line has not come yet is that finding's detail, so the field line after it
   lands on the finding; a numbered item is its own finding.
   A phantom finding costs a fold; a lost one costs the gate.
   A reply with no finding counts as a review only with the clean marker its own brief asks for: `NO FINDINGS` alone on a
   line for the specialists, the batched specialist, the targeted reader, the Red Team and fix-check, the `Recommendation:`
   line for the outside voice, either for the native adversarial voice. Without one (a refusal, an empty reply, a reader
   that never saw the diff) collect records `review: false`, prints `COLLECT_NOT_REVIEWED` and exits 1.
4. Lead judgment writes `judged.jsonl`; `judge` refuses a set that drops a merged
   finding, lowers its severity, folds it into a less severe duplicate, or adds or
   promotes one without a reason (`JUDGMENT_REJECTED`). A merged file missing any id
   the ledger collected is a drop. Each addition and promotion is logged with its reason.
5. `verify --ledger <f>` replays all of it from the run's ledger: rendered against
   dispatched hashes per render (each render is one dispatch of its reader, so a
   two-pass ledger checks pass-1 sends against pass-1 briefs; a later render prints as
   `<reader>@2`), a collected output that is a review for every sent reader (`NOT_COLLECTED`
   otherwise, and the output row `NOT_REVIEWED`; the marker is checked again in the output file when it is unchanged, so an
   older ledger meets the same rule; a non-review the same dispatch later replaced with a review, by re-sending the brief, is `VOIDED`
   and counted in `voided=N`). The outside voice may fail without blocking: `collect --unavailable '<reason>'` records its failure text
   as missing coverage (`COLLECT_UNAVAILABLE`); an empty reason or an output that holds findings is refused (exit 2), so a partial
   answer is collected normally and loses nothing. Verify prints its brief and output `UNAVAILABLE` and `unavailable=N` on the
   verdict line, and its coverage is logged `unavailable` in the review-log row; any other reader is refused (exit 2), because its
   missing coverage leaves the review incomplete. A mismatched send re-sent
   byte-exact before anything was collected is void and counted (`voided=N` on the
   verdict line); one that produced an output stays `MISMATCH`. Then output hashes
   against the merged lines they produced, and the judgment rerun against the
   recorded judged set, covering every collected id. A ledger from a run that kept no
   prompts prints `VERIFY: no brief records` (exit 3), never clean.
6. `pass --base <b> --out <dir> --pass <id> -- <plan flags>` runs one pass from a
   staged manifest (`<dir>/pass-manifest.json`): audit readers marked first, then
   the specialists with QA and the other audits, then the Red Team, then Step 11's
   voices. Each reviewer keeps its plan entry and is rendered by the same code as
   `render`, once its inputs exist; the Red Team's findings file is the specialists'
   `merged.jsonl` lines byte for byte. A brief leaves the bin in indexed chunks of at
   most 65,536 characters (`chunk`), so no tool output line carries a whole brief and a
   host's line or output cap cannot cut one. Each reader's intent is recorded before its
   subagent is created and its path right after (`mark`), so a resumed pass finds a
   create whose result was lost by its title and never starts a reader twice; a
   missing or doubled title stops the pass. On Capy the pass runs as one call to the
   checked-in program `lib/capy-review-pass.js`, served by `program` and loaded
   unchanged by the gstack Capy skill.
7. Every brief, audit readers' included, ends with a workspace paragraph naming the
   checkout the bins run in (GST-482): a reader on a shared machine starts in the
   machine's working directory, so it is told to `cd` there on every command, to give
   every file tool an absolute path under it, and to start its reply with
   `REVIEWED_TREE: <HEAD^{tree}> <toplevel>` measured there. The paragraph follows the
   section's render, which stays byte for byte. `collect` and `mark --state collected`
   compare that line with the fingerprint recorded at render: a missing or foreign line is
   `COLLECT_WRONG_TREE`, a later commit in the same checkout `COLLECT_TREE_MOVED`; nothing
   is merged, the reader becomes `failed`, and `verify` reports `NOT_COLLECTED`. An
   outside voice's tree failure is recorded `unavailable` only when its reply holds no finding. The line catches a reader that
   worked elsewhere by accident; it is not proof of reading, since diff text can predict it.

## Where this is enforced

- `lib/review-brief.ts`, `lib/review-ledger.ts`, `lib/review-pass.ts`, `lib/capy-review-pass.js`, `bin/gstack-review-dispatch`: [verbatim dispatch](#verbatim-dispatch) (`test/review-dispatch.test.ts`, `test/review-pass.test.ts`).

- `scripts/resolvers/review-army.ts`: the floor and `NO FINDINGS` in every specialist and Red Team prompt (rendered into `review/sections/review-army.md` and `ship/sections/review-army.md`), and the lead judgment's "On record" line that turns a [ruled class](#rulings-below-the-floor) into a note; in `/ship` every specialist and Red Team prompt it renders carries its diff base as a literal sha the parent writes in (`DIFF_BASE=<diff-base>`: the merge base on pass 1, `RANGE_BASE` from pass 2 on) beside its plan's `DIFF_CMD` excludes, because a reviewer is its own process and never sees the parent's shell variables; the fan-out batches above.
- `ship/sections/review-army.md` Step 9: the plan's `REVIEW_DEPTH`, `GATE_SCAN` and `--depth-floor` on every run, the depth fields of the review-log row, passes, `RANGE_BASE`, classify, defer, render, the cap check before any edit, the Step 11 late-defer row, scratch files under `.gstack/tmp/`, the cap decisions; `ship/sections/adversarial.md` Step 11: the outside voice reads the same range and scopes queued fixes the same way.
- `lib/review-depth.ts`, `bin/gstack-review-plan`: the diff class, the depth (`depthFor`, `DEPTH_RULES`, `depthOfCommitInput`), each dispatch's `exclude` pathspecs and `DIFF_CMD`, the transition table, the numeric-claim scan and each role's effort tier (`test/review-depth.test.ts`, `test/review-plan-cli.test.ts`).
- `lib/review-collect.ts`: `collectCommit` (git objects only, from any checkout) and `collectLive` (the working tree), per-path lines and the base commit's registry (`test/review-collect.test.ts`).
- `lib/review-scope.ts`, `bin/gstack-review-scope`: `classify`, `defer`, `render`, `summary` (with `fix_checks`, `dispatches`, `est_input_tokens`); refusals are `REVIEW_SCOPE_INPUT` and `REVIEW_SCOPE_RANGE` ([troubleshooting.md](troubleshooting.md#review-scope-input)).
- `lib/ship-policy.ts`: the `review_scope` key and its `ship: review_scope …` consequence line.
- `review/checklist.md`: `prereg-with-results` under Gate Integrity and `test-keyboard-count-loop` under Pass 2; `bin/gstack-coauthor-trailers` for the contributor-credit trailers of a port.
- `lib/ship-receipt-prose.ts`, `gstack-ship-receipt read --check-prose`: the body's quoted counters against the receipt (`RECEIPT_PROSE_MISMATCH`, [ship-policy.md](ship-policy.md#ship-receipt)).
- `lib/ship-receipt.ts`, `lib/headless-artifacts.ts`: the `review_loop` receipt object, its schema and the summary line.
