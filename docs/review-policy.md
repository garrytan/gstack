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
   records it for the PR and files no issue, and the PR body lists it under
   `## Deferred findings`. Deferred findings never become issues; work someone
   will actually do gets one issue with a named owner. A finding's `cause`
   (the changed line behind a defect reported elsewhere, a deleted file included)
   places it in the diff.
   Below-floor findings outside the diff are `note`, listed under `## Review notes`.
2. **What comes next is the transition table below**, not "any fix earns
   another pass". A full pass after pass 1 reviews only the range since the
   previous pass: each pass saves its head, the next diffs `RANGE_BASE..HEAD`
   for every reviewer (the gate scan and QA probes keep the whole candidate) and
   classifies with `--range-base`. Only a blocking finding in that range or in
   the diff is `fix`; every below-floor finding is a `note`.
3. **Two rounds is the cap** (R51): a full pass, a scoped pass
   ([below](#scoped-pass)) or a fix-check is a round. After round 2 the run
   finishes with its open notes listed in the PR body and receipt (an owner-ruled
   note is closed and listed: [ruled notes](ship-policy.md#ruled-notes)), or stops for
   the owner when a blocking finding is open, or was fixed in round 2 and is
   unverified, or a round-2 fix edited a gate-class path, naming it (path,
   severity, problem). The cap limits fix rounds, not Step 11's voices: on gate
   class a stop waits for Step 11's adversarial, outside and targeted voices
   (`NEXT: voices`), so gate code never reaches the owner's "ship with open
   notes" without them (GST-967). A third round is the owner's
   grant of one scoped fix-check (recorded in `review_loop_exception`), never the
   loop's: once `gstack-approvals add` records the grant (its ask or scope
   naming `review_loop_grant` and the stop head's sha),
   `gstack-review-plan --grant <approval id> --range-base <round 2's PASS_HEAD>`
   plans that fix-check in place of the stop after a round-2 full pass, or after
   a round-2 fix-check that was the run's only one (`--fix-checks 1`, GEVA-223),
   with a fixed blocking finding or a gate-class edit, and refuses any other row,
   including a grant for a stop head before `--range-base` (an earlier /ship).
   A fix-check never earns another, so the grant cannot repeat, and a stop after
   the granted fix-check still goes to the owner. The cap approves nothing.
   Edits that /ship Step 16 later finds after the review bound are a new stop: a
   new grant at a stop head after the last fix-check's commit, passed as
   `gstack-review-plan --post-review --last fix-check --range-base <that commit>
   --grant <id>`, plans one more fix-check, the next link of the
   [fix-check chain](ship-policy.md#fix-check-chain) (GST-1676). The last link's
   own grant is refused there, so each link still needs the owner's word. In the
   loop, a new grant naming the last fix-check's commit (`--range-base`) plans
   the next link the same way; a grant recorded before a later logged fix-check
   already bought a link and is refused (GST-1681). Edits after the last
   fix-check that are only release stamps under the base policy's stamp rule
   (line-exact: one other line in a stamp file makes the file an edit) and docs
   are no gate-class edit: the plan reads them with the receipt's classifier
   (`docsChangeSince`, the [targeted-only read](#targeted-only-read-after-the-loop)'s)
   and prints `NEXT: done`, or `NEXT: targeted` when a docs claim on a
   targeted-class diff needs the read, with no grant (GST-1702). An executable,
   symlink or gitlink file in that range, or a commit the gate scan tags there
   (a `[skip ci]` message), still stops.

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
| a full pass that fixed only below-floor findings | one fix-check (round 2) |
| a light pass 1 whose below-floor fixes change no runtime lines | done |
| round 2 (a full pass or a fix-check) that fixed a blocking finding or edited a gate-class path | stop: name it for the owner, who may grant one scoped fix-check |
| round 2 (a full pass or a fix-check) that fixed only below-floor findings | done: notes in the PR body |
| a full pass that leaves a blocking finding open (fixed or not) | stop: name it for the owner |
| a fix-check that found nothing blocking | done |
| a fix-check that found a blocking finding | stop: name it for the owner |
| a stop (any row above) on gate class before Step 11's voices ran | Step 11's voices (adversarial, outside, targeted), then ask again with `--adversarial-ran` |
| a round-2 full pass that stops for a fixed blocking finding or a gate-class edit, with the owner's recorded grant (`--grant <approval id>`) | one scoped fix-check (round 3), after Step 11 on gate class |
| a round-2 fix-check that stops the same way, with the owner's recorded grant and `--fix-checks 1` | one scoped fix-check (round 3), after Step 11 on gate class |
| `--post-review` after a fix-check whose later edits are only release stamps and docs (`docsChangeSince`) | done, or the one targeted reader when a docs claim on a targeted-class diff needs it |
| `--post-review` after a fix-check (edits after the review bound), with a new recorded grant at a stop head after the last fix-check's commit | one scoped fix-check, the next link of the fix-check chain, after Step 11 on gate class |
| a fix-check that stops in the loop, with a new recorded grant naming its own commit (`--range-base`, the stop it answers), after any number of fix-checks | one scoped fix-check, the next link of the fix-check chain, after Step 11 on gate class |

A **fix-check** is one reviewer reading the touched hunks, the fix list, the
test results and the callers of every changed symbol, at full effort. It is
logged as a `review-fix-check` row, so it never counts as a pass. No army, no
Red Team and no outside voice run on it.

`NEXT: voices` runs Step 11 as `done` does, from the last full pass's
manifest; /ship then asks the plan again with `--adversarial-ran` (a blocking
finding the voices queued counts as `--blocking-open`, never a new Step 9), and
the stop or the granted fix-check it names stands.

<a id="scoped-pass"></a>
A **scoped pass** is pass 2 after a blocking fix when pass 1 and the diff both
ran below full depth (no gate class, no depth error, no `--depth-floor full`).
A full pass 1 always gets a full pass 2: `--pass1-depth` carries pass 1's
`REVIEW_DEPTH`, and an absent flag counts as full. The fix range
`RANGE_BASE..HEAD` must have at most `SCOPED_RANGE_LINES` (150) runtime lines, counted
as the depth counts them (`gstack-review-plan --range-base $PASS_HEAD` prints
`FIX_RANGE:`). The range holds only the PR's own change since `RANGE_BASE`: when
a base merge lands inside it, what the base brought (a file only main changed,
or main's lines in a file both changed) is not counted, and neither is its gate
class (GST-2229, harness-evals #354). It dispatches one fix-check on the range, the Red Team on the
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

<a id="no-stop"></a>
### No-stop defaults (K1)

Five routine stops don't wait for a Captain. /ship and /autoplan record each one
as `{class, reason, evidence}` in the receipt's `no_stop` field and keep going.
`gstack-no-stop record` (`lib/no-stop.ts`) checks each case before it records it.
When a case doesn't qualify, it prints `NO_STOP: refused` and exits 3, and that
stop goes to the owner as before. Every other stop still stops.

| Class | Qualifies when | What happens next |
|---|---|---|
| `scoped-fix-check` | Round 2 stops for a fix whose range since round 2's `PASS_HEAD` is docs class only, or only raises timeout values. `--range-base` must be the commit the newest review-log pass row read. One per branch: the ledger keeps every record, so a later /ship on the branch stops for the owner. | It records the standing grant in the approval record (`by: gstack no-stop default (K1)`) and prints `GRANT:`. `gstack-review-plan --grant` plans the one scoped fix-check. A blocking finding there goes to the owner. |
| `test-timeout-fix` | Every changed line is in a test file and only raises a timeout value: the value of a timeout key (`timeout: 5_000`, `setDefaultTimeout(5_000)`, `--timeout=5000`) or bun's and jest's trailing per-test argument, only on the line that opens the test call itself (`test('…', () => {…}, 30_000);`, likewise `it(` and `describe(`). A multi-line test's closing `}, 30_000);` does not qualify and stops for the owner. A line with `expect`, `assert` or a comparison never qualifies. | The gate scan's relaxation finding takes the printed `GATE_DISPOSITION: kept` reason instead of `open`. |
| `pregate-flake-rerun` | One rerun of a failed pregate case at the same tree (CREW rule 16). One per branch. | Green counts as flaky. Red again is a real failure. |
| `stamp-only-carry` | A refused carry, where the receipt head merged into the base (base side on conflict) differs from HEAD only in a version stamp: `VERSION`, the `"version"` line of `package.json`, `CHANGELOG.md`, the agents digest or `changelog.d/` fragments. | Take the carry's `RECHECK:` route instead of running Steps 2–16 again. |
| `autoplan-regate` | An edit to the plan file made after the owner's answer, or after the revise that took their changes, while the reviewed plan itself is unchanged. The edit only adds lines, all inside the plan's `## ELI5` section (an added `## ELI5` heading opens one), and no added line holds a number or a word for spend, cost, budget, price, cap, credits, limit, max, arm, model, judge, verdict, threshold, bar, trial, sample, stop rule, paid or eval. A removed or reworded line, or a line added anywhere else, goes to the owner. The carry exports the reviewed plan, so the added explanation is never built. | `gstack-autoplan` carries the owner's words (`reason=no-stop autoplan-regate: …`) and writes `<run>/no-stop.json`. `gstack-no-stop import` adds it to the branch's ledger. |

The ledger is one JSON array per branch under the checkout's git directory
(`NO_STOP_FILE:`). /ship's receipt write passes it as `--no-stop @<file>`.

<a id="review-depth"></a>
## Review depth by diff class

`gstack-review-plan --base <base>` classifies the diff, picks a **depth** and prints
the reviewers the next step dispatches: `REVIEW_CLASS:`, `REVIEW_DEPTH: <d>
runtime_lines=<n> rules=<hash> reasons=<…> codes=<…>`, `GATE_SCAN: tagged=<n>|unavailable
head=<sha>`, `REVIEW_BASE: <ref> <sha12>` (the base the diff was taken against: a bare
`--base main` reads `origin/main` when it shares history with HEAD, and a local `main` that lags
it is named on stderr), one `DEPTH_ERROR:` per input that failed closed, one `DISPATCH:` per reviewer
with its effort and a shell-quoted `DIFF_CMD:` (plus `DIFF_EXCLUDE: <name> none` when it
reads everything), one `SKIP:` per reviewer left out, and `--json` with the same fields (the
base as `base`).
A plan that fails closed to full exits 0; a diff git cannot list exits 1.

### Who reads (R65, the base policy's `review` key)

The depth says how much review a diff needs; the base branch's `.gstack/ship-policy.json`
`review` key says who does it (`review.panel`, default `all`: today's panel on every class). `gstack-review-plan`
prints `REVIEW_MODE: <lean|panel|platform> panel=<p> reader_model=<m> platform=<on|off>`
and, under `review.platform on`, `PLATFORM_REVIEW: <id> reviewer=capy-ai[bot] head=<sha>`
or `PLATFORM_REVIEW: none (<reason>)`.

Under the opt-in `review.panel risk` (and `review.platform on` under any panel):

| Diff | Pass 1 | After fixes (never more than 2 rounds) |
|---|---|---|
| Risk class: gate class, an R51 class (money, auth, secret, security, data), `eval` (scorer, judge and grader paths) or `policy` (`review.risk_paths`) | The full-depth plan as printed: the batched specialist, Red Team, native adversarial, outside voice and the targeted reader | A fixed blocker re-runs the printed plan on the fixed head as round 2; below-floor fixes get one fix-check |
| Non-risk code | One native adversarial reader (`DISPATCH: adversarial-native single`) at the lane's reasoning, on `review.reader_model` (`lane` by default), carrying the code checklists and the Red Team checklist; it also carries the targeted brief when the diff has a targeted class | A fixed blocker or a gate-class edit gets one fix-check on the touched hunks; below-floor fixes ship as notes |
| Docs and tests | The core read; the outside voice only when the diff publishes numbers | One fix-check after a fixed blocker |
| Docs or tests with no numeric, results or prereg claims, under `review.platform on`, with capy-ai[bot]'s review on the PR at HEAD | No reader: `NEXT: platform` and a planned `SKIP:` for every reader, the core read included | none |

`review.panel all`, the default, keeps today's panel and loop on every class. `risk` is
opt-in because its one-reader shape has not passed its no-loss replay: build C's replay
scored it FIX-METHOD (its readers saw the diff without the repository). `review.panel off` gives
risk class one merged reader too (`DISPATCH: adversarial-native merged`: the native
adversarial brief, the gate-class checklists, the Red Team checklist and the targeted
brief, whose ledger record is the receipt's `review_targeted`). The risk classes come
from paths and changed lines, never from a recorded `review_depth` (FOUN-64). Two
content rules: data and config files (JSON, YAML, TOML, CSV and the like) and analysis
scripts under `docs/`, `results/`, `benchmarks/`, `analysis/` or `notebooks/` are
judged by their path, so a `lease_usd` value or an `os.path.join(sys.argv[1], …)` in a
stats script names no class (HARN-1, harness-evals#231), and binary data such as
`*.sqlite` is data wherever it sits, unless the file has the exec bit or starts with
`#!`: an executable stays code whatever its name or directory (`scripts/logs/prune`,
a runnable `*.out`); a docs line that can print a credential (an
`Authorization:` header, a bearer or key-shaped value, an environment key set to a value,
a get or show command for auth config such as `mcp get`) is security (gbrain#8417); code
that reserves, binds, leases or settles spend against a ledger, budget or cap (`bindCheck(ledger, …)`,
`reserveSpend`, `bindCap`) is money (GST-1129, gstack-evals#170). When the matchers miss a class the
lane knows the diff has, `gstack-review-plan --declare-risk <classes>` adds it: a declaration joins the
detected classes, only raises the depth, and prints `RISK_DECLARED: classes=<declared> detected=<found>`.
The outside voice reads its diff from a file the brief names with its sha256; past
2,000,000 bytes it reads a path-scoped slice whose brief lists the files left out.
`--fix-checks <n>` tells the loop how many fix-checks ran, so the owner's grant
adds one fix-check after the first and never a second, in the lean loop and after
a round-2 fix-check in the full loop (GEVA-223).

**Classes** are unchanged. A mixed diff takes its most restrictive class: **docs**
(markdown no agent or gate reads), **tests** (test files and fixtures), **code**
(everything else, including every `SKILL.md` and template, markdown in a skill
directory, `*/sections/**`, `scripts/resolvers/**`, rule docs, checklists, bins and the
harness pins under `scripts/harness-pins/`, whose paths repeat a `test/` segment) and
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
`manifest.json`, the other tool manifests `lib/review-depth.ts` lists, and the harness
pins under `scripts/harness-pins/`, which code reads by path and never names) and a named
consumer each keep the path code, and YAML and TOML are always code. An SVG counts
as data only when its whole text at the head is a drawing (GST-911): SVG drawing
elements and RDF metadata, CSS made of declarations only (no `@` rule and no
function but a same-file `url(#id)`, which closes `@import`, `image-set()`,
`image()`, `element()` and every other CSS load), no backslash escape, every
`href` a same-file `#` reference or an inline raster image, no event handler and no
entity declaration, and no DOCTYPE but a bare `<!DOCTYPE svg>` or W3C's own SVG DTD, read after character references are decoded. A `<style>` element's text is read as written. Any `&` in it keeps the SVG code, its comments are read as CSS, an opening tag it cannot read as quoted `name="value"` pairs keeps the SVG code, and only ASCII whitespace may come before the `>` of either tag, so no character-reference `</style>`, comment that only an HTML parser ends early, quoted `>` or Unicode space can hide CSS. A non-ASCII character in an element or attribute name, such as a `gé:` prefix, keeps the SVG code too (GST-940); anything else, a
script or `foreignObject` included, keeps it code. More than
2,000 data paths keep every one code; a `git grep` failure is `consumer_scan_failed`
and fails the depth closed. The scan first lists the files that contain a candidate's
extension and then searches only those, docs files left out, so a large data tree
costs one cheap pass. Each scan gets one 120-second deadline, set in milliseconds with
`GSTACK_CONSUMER_SCAN_TIMEOUT_MS`; a scan that runs past it, or whose matches pass
256 MB, is also `consumer_scan_failed`, and its detail says what stopped it and names
the deadline. One scan fits a minute inside the 180 seconds /ship gives
`gstack-review-plan`; a plan that also scans a fix range runs two scans, and if they
pass that limit the plan, run by itself or under `gstack-review-dispatch pass`, stops with
[`REVIEW_PLAN_STOPPED`](troubleshooting.md#review-plan-stopped) before any reader
runs (`GSTACK_REVIEW_PLAN_TIMEOUT_MS` sets the limit in milliseconds). Only `classifyDiff` applies the rule (`lib/review-collect.ts`
finds the consumers, `gstack-ship-preflight`'s `RUNTIME_LINES` reads the same
function); every path-only caller (the receipt's gate-scan decision, the Step 16
post-review route, /autoplan's docs-only scope) keeps data files code. A numeric claim
in a data file still schedules the outside voice.

| Depth | When | Pass 1 dispatches |
|---|---|---|
| **light**, runtime 0 | docs, tests, eval write-ups, or only registered outputs | one reader: the core checklist; the outside voice instead reads a diff that publishes numbers |
| **light**, runtime above 0 | code with no risk class, at any size (R51: size never raises the depth) | core, one **batched** specialist (the batched checklists below plus the Red Team prompt in one context), the native adversarial pass (kept: backtest inconclusive, GSTA-147 D5) and the outside voice on numbers |
| **standard** | `--depth-floor standard`, or a light diff raised by a fixed blocker or a CRITICAL | one batched specialist at `medium` and the Red Team at 200 runtime lines (or on a CRITICAL or a raise); the batched reader leaves docs and registered outputs out of its diff; adversarial and outside voice read everything |
| **full** | gate class, a [risk class](#risk-classes), or any classifier error | one batched specialist on the whole diff, the Red Team always, no hit-rate gating |

<a id="risk-classes"></a>
**Risk classes (R51).** `lib/review-risk.ts` reads a code diff's paths and its
added and deleted lines; any class makes the depth full (`risk:<class>` in
`reasons=`, `review_depth.risk` in the receipt). money, auth and secret are the
[targeted pass](#targeted-pass-on-money-gate-auth-and-secret-code)'s matchers.
**money** also reads metering and charge words in a path or on a line (meter,
metering, metered, charge, charged, billable, billed, credits) and three
pairs: usage beside a token or cost word, proxy beside billing, and a client
beside a cost or charge word, so a CLI's usage text and a plain proxy stay out
(GST-850, from gbrain-evals #289, whose metering proxy and billing clients read
`required=none`). **security** is a trust-boundary path (trust, redact, sanitize, neutralize,
consent, escape, and sealed custody or egress: seal, sealed, custody, egress) or line (a
redaction call, an import of a redaction or outside-voice module, a `SECRET` or `CREDENTIAL`
constant set to a regex, since that code decides what reaches an outside model, GST-1177; `shell: true`, `exec(` and `execSync(`, `eval`, `new Function(`,
raw HTML sinks, a shell run through argv, recursive deletes), any call to an
outbound HTTP client (`fetch`, `http(s).get` or `.request`, axios, got, undici,
`requests`, `httpx`, urllib, with no exemption for a literal URL), `new URL` from
input, redirect toggles, proxy settings and host allowlists, archive extraction
and path traversal (`tar.x`, adm-zip, yauzl, extract-zip, `extractall`, `tar -x`,
`unzip`, `path.join` or `resolve` on request or entry input, a `'..'` check added
or removed), and any changed line that names the `child_process` or
`node:child_process` module, in any import or require spelling. A changed SVG
line that can run code (a script or `foreignObject` element, an event handler, a
`javascript:` URL) is security too (GST-911). The GST-850
rules are coarse on purpose and parse no import clause or call arguments;
`test/review-risk-linear.test.ts` holds each of them under 100 ms on
200,000-character hostile lines, its anchor followed by a long run of the
characters it repeats included. `test/review-risk-redos.test.ts` (GST-898) holds every risk pattern, R51's `rm` and `rmSync` rules included, under 100 ms on 100,000-character hostile lines. An `rmSync(` or `rm(` call (`fs.rm`, `fs.promises.rm` or an imported `rm`) counts as security when `recursive: true` follows within 500 characters, whatever the arguments hold (a `path.join(...)` first argument or a `)` in a comment included) and also when a formatter split a new call across lines, which is read over the file's changed lines joined (GST-942; an edit to one line of an existing split call is read on its own); a call with more than 500 characters before the first `)` after it counts on its own. **data** is user data: a path naming pii, gdpr, ccpa, privacy,
personal, account, customer, cookie, persistence, storage or database, or a line
that drops a table or column, deletes rows or bulk-deletes records. Auth scope,
migrations and deleted code paths were already gate class. `RISK_RULES` hashes
the patterns and `DEPTH_RULES` includes it.

**UI text** stays code (light unless a risk class applies). A docs path for UI
copy and locale values was built as an allowlist in GST-850 and dropped for
review cost: its first review round found a new bypass class in each version,
the same pattern as three rounds of R51. Chart SVGs use the drawing allowlist
above, which reads the whole file rather than changed lines. When a diff
publishes numbers, the batched specialist's diff keeps the write-up's text files
instead of leaving docs out.

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
`lib/review-targeted.ts`, `lib/review-risk.ts`, `lib/review-exclude.ts` (which files reviewers never see),
`lib/default-base.ts` (the base every diff is cut from), `review/specialists/targeted.md`, `lib/ship-queue*.ts` and `crew/lib/ship-queue*.ts`, `lib/regen.ts`, `.gstack/generated.json`,
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
its label rule says so (native FIXABLE, except as the collect step below
relaxes it on a runtime-only code or docs plan; outside Critical or High) or it says
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
- R51: size never raises the depth; non-risky code is light at any size, and a risk
  class makes it full. Two rounds is the cap, a fix-check
  included: a blocker fixed in round 2 stops for the owner instead of earning a
  fix-check, and a light pass 1 whose below-floor fixes change no runtime lines is done.
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
| money | a path segment naming cost, spend, budget, ledger, billing, price, fee or invoice; or a changed line with an identifier ending in `_usd` or `Usd`, unless every such name on the line is a reported cost (made only of words like cost, total, per, trial, mean or sum) and the line has no cap, limit, budget, spend, price, fee, charge, refund, amount, reservation or estimate word (the full list is `MONEY_USD_WORDS` in `lib/review-risk.ts`), no `<` or `>` comparison and no number set on it: summing or printing `cost_usd` is not money (GST-962); any `spend_cap` spelling; or a call to a paid provider `lib/pricing.ts` prices. A data file no code reads (the same consumer scan the depth uses) under a `doc/`, `docs/`, `wiki/`, `results/` or `reports/` directory counts as money only for a `spend_cap` or paid-provider line, never for its name, a `_usd` or `Usd` identifier (reported cost or not) or a metering word (GST-961); every other class still reads it |
| gate | a hunk the gate scan tagged: a relaxed threshold, a skipped test, a loosened check |
| auth | `SCOPE_AUTH` from `gstack-diff-scope`, on a code path with an auth, session, jwt, permission or role token in its name; a data file named for sessions (`recovered-sessions.jsonl`) outside a config location does not set `SCOPE_AUTH`, and `SCOPE_AUTH` fails safe: any name token containing auth sets it (`auth.ts`, `/auth/`, `oauth`, `useAuth.ts`, `nextauthmiddleware.ts`) except the authorship words `author`, `authors`, `authored`, `authoring`, `authorship`, `authority`, `authorities`, `coauthor` and `coauthors` |
| secret | a secrets, credentials or keychain path, a dotenv file (`.env`, `.env.production`; not `.env.example`), an SSH private key (`id_rsa`) or a key-store extension (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`), by name alone; a token-named path by name too, except a style or engine file (`token.gd`, `tokens.css`, `.scss`, `.sass`, `.less`, `.styl`), which counts only when its changed lines hold a value the credential scanner reads as a secret or have no text to read, since design and lexer tokens share the name (GST-1350); or a changed line that reads a key-named environment variable (`OPENAI_API_KEY`, `GH_TOKEN`) or a credential store |

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
renders its brief; `verify --targeted-out .gstack/tmp/targeted.json` writes the record that
`gstack-ship-receipt write --review-targeted @.gstack/tmp/targeted.json` puts in the receipt
(Step 19, the handoff and the driver pass it when the file exists). The record is `done` when
the reader got its brief verbatim and its reply was collected on a committed diff, whatever
happened to HEAD after, and it names the commit it read (`head`). `write` binds it only while
that commit is an ancestor of HEAD, its product patch is the receipt's, and nothing changed
after it carries a targeted class, with the gate scan run over that change. What changed after the
read is the PR's own change, on `product_patch_id`'s basis: the paths whose part of the PR's diff
against its merge base differs between the read and HEAD, so files only a base merge brought in never
count, while a branch edit or a merge resolution that changes the PR's own hunks does (GST-1593). Any other product change
after the read refuses with `RECEIPT_INVALID`, and so does a test edit the gate scan tags (a
skipped case). A release stamp after the read always carries the record: a path whose change
is a stamp under the base policy's stamp rule (`stamp_files`, `stamp_paths`, `stamp_patterns`,
the version file, manifests, lockfiles and the CHANGELOG re-heading or fragment fold, the rule
the tree receipt uses) is left out of that change (GST-1689). A docs-only change after the read
(TODOS.md included) carries the record only
when it changes no binary file, adds no numeric claim, touches no results, prereg or eval path,
and names no money, security, secret or auth topic (GST-1195). Every verify
removes `--targeted-out` before it writes a record, so an earlier run's record never reaches
Step 19. `write` and `carry` (which rescans the gate at the new head) also
refuse a receipt whose head needs a class no `done` record covers (`RECEIPT_INVALID`,
`RECEIPT_CARRY_REFUSED`). The queue refuses the same receipts at `ready` (#3859).
`gstack-ship-queue ready`, `train build` and `land` print
`REVIEW_TARGETED: required=<classes|none> receipt=<classes|none|legacy>
verdict=ok|missing|failed` and refuse
[`QUEUE_RECEIPT_TARGETED_MISSING`](troubleshooting.md#queue-receipt-targeted-missing)
when a required class has no done pass covering it.

Over the last 100 non-release commits on main (8663c3d2..8be7f213), money hit
21, gate 18, auth 3 and secret 8. The gate class first used the gate paths,
which hit 43 of 100; those paths already get full depth, so the gate class was
narrowed to the gate scan's tagged hunks.

### Targeted-only read after the loop (GST-1598)

A docs claim added after the review loop finished, such as a changelog
fragment with dollar figures, used to have no way through. The targeted record
names the commit its reader read, and `write` carries it across a later docs
change only when that change is plain docs, so the receipt asked for the
targeted reader on HEAD. But the plan printed `done`, so nothing could
dispatch it (harness-evals #225). Now, when the loop is done, pass
`--range-base <the commit the reader read>` and `--targeted-ran <the
targeted_patch_id it read>`. If every path the PR's own change moved since
then, release stamps aside, is docs class and not binary, and the change is
not plain docs, the plan
prints `NEXT: targeted`, one `DISPATCH: targeted` for the head's classes and
`TARGETED_DELTA: range_base=<sha> paths=<paths> classes=<classes>`
(`targeted_delta` in `--json`). The patch-id check proves that range_base
is what the reader read. The branch patch is compared on each side's own
merge base, so a base merge alone adds no path. The plan classifies the
change with the same function `write` uses (`docsChangeSince` in
`lib/ship-receipt-depth.ts`), so a restamp plus a plain docs-audit edit is
`done` in the plan and carried by the receipt, and a docs claim beside a
restamp gets the one reader (GST-1689).

The reader reads the whole merge-base diff at HEAD, like every targeted
reader. It isn't scoped to the docs change, because `render` reads no other
base and a record that names HEAD is the one `write` binds. It is read-only
and applies no fix, so it isn't a review round under R51 and needs no grant.
A `--grant` is still checked against the approval record first, and a row
that isn't there refuses (exit 3). `gstack-review-dispatch pass` builds the
manifest: the one reader in the voices stage, with the `TARGETED_DELTA` line
among its plan lines. After `verify --targeted-out`, pass the new
`targeted_patch_id` and the plan is `done`.

Every other case stays `done` and prints `SKIP: targeted-only read
(<reason>)`. That covers a code or binary change with no `--grant` (the granted
case is below), which takes the review loop as before; plain docs and release stamps, which the record carries; a range_base the
`--targeted-ran` patch doesn't match; and uncommitted edits. `--force
targeted` refuses (exit 2) and names these flags, because the targeted reader
is no specialist (`lib/review-targeted-delta.ts`,
`test/review-plan-targeted-delta.test.ts`).

A fix round the owner granted past the cap has the same problem in code
(harness-evals #271, GST-1607). The granted round's fix moves the product
patch the targeted record names, so the receipt asks for a fresh read once
the loop is done. With that grant passed as `--grant` (checked as above:
an approved `review_loop_grant` row naming a stop head inside
range_base..HEAD), any change since the read except plain docs plans the
same `NEXT: targeted`, and the reason names the grant. A head with no
targeted class adds no reader, and the same change with no grant keeps
`done` (`test/review-plan-granted-targeted.test.ts`). The Capy pass program
runs a targeted manifest's voices stage, so this one reader runs there too.

<a id="review-exclude-paths"></a>
## What readers read under `review_exclude_paths`

A repository can list content folders its reviewers leave out, on its base
branch only ([ship-policy.md](ship-policy.md#review-exclude-paths)). Under it,
every reader (specialists, the Red Team, the native and outside voices, the
targeted reader) reads the same selection: its `DIFF_CMD:` with one
`:(top,exclude,glob)` item per applied pattern, the fixture command with the
same items, and the `DIFF_KEEP:` command for the kept files under those
patterns. A kept file whose only reason is a secret line reaches pass readers as
an excerpt of its matched lines in context instead ([secret-line
excerpts](ship-policy.md#secret-line-excerpts)). The outside voice's embedded diff is that selection. Each brief says
how many files and bytes were left out and that the reader must not report on
their absence. Excluded paths count as docs for the depth and never trigger the
numeric-claim scan or a targeted class; kept files keep their own class.

Independently of the key, no reader is handed more than 2,000,000 bytes of
diff: `gstack-review-dispatch` stops with `REVIEW_DIFF_TOO_LARGE` before it writes
anything, instead of a review of the part a reader happened to see.

## What readers may fetch

Every reader brief closes with the fetch rule, before the workspace paragraph:
review only this checkout and its local git history (the diff base is already
local), and never clone, fetch, pull or download another repository, dataset or
archive. The rule names each forbidden shape from one table in
`lib/review-fetch.ts`: `git clone`, `fetch`, `pull`, `ls-remote` or `submodule
update` against a network remote; `gh repo clone`, `gh api` tarball, zipball or
contents, `gh release download`; dataset or model downloads; `curl` or `wget` of
an archive or a raw repository file; package installs from a git URL. A clone of
a local path or a `file://` URL is fine, and so is reading a single
documentation page. No brief asks for a fetch today. A repository's
[`readers` key](ship-policy.md#readers) adds hosts, repositories and paths no
reader may reach at all, and a one-line note every brief carries.

`gstack-review-dispatch audit-fetch --events <jsonl>` scans one reader's tool
calls (inputs only, never results) against the same table and the pass's policy.
It splits each command into words and flags only a known download tool aimed at
a network target, so a reader that greps for `git clone` or reads the scanner's
source is not a hit, while `bash -c`, wrappers such as `timeout` and `command:`
strings inside a program are read through. A fetch of the checkout's own remote
by name is a note. The result is recorded on the reader in the pass manifest as
a note (`fetch_audit`, `enforced: false`): Capy gives a pass no way to read a
reader's own tool calls, so the scanner serves hosts that can hand it a
transcript.

The rule is enforced per stage. Before a stage's readers start, the pass program
runs `gstack-review-dispatch sweep --phase start`, an inventory of git
repositories and files of 100 MB or more under the workspace, home and the temp
dir (bounded at depth 6, 200,000 entries and 20 seconds; past a bound the sweep
is `partial`, a note). After the stage's last reader is collected,
`--phase end` diffs against it. A new repository with a network remote, or a
new big file, is a violation. Every reader of that stage is quarantined (reply
under `<out>/quarantine/`, findings out of `merged.jsonl`, never shown to the
Red Team or returned), `verify` refuses with `FETCH_VIOLATION`, and each slot
reruns once as `<reader>#2`, which is not a review round. The rerun starts only
once every path the first attempt found is gone: while one exists, a rerun reader
could open it and still sweep clean, so no reader of any stage, Step 11's voices included, starts and the pass stops
(`FETCH_RERUN_BLOCKED`). A fetch on the rerun stops the pass (`FETCH_RERUN_SPENT`), and resuming it starts no later stage. Nothing is deleted for you, and no delete
command is printed: each found path gets a `KEEP:` line to inspect and leave alone. A remote URL is read through git's own config parser and printed and recorded without its `user:token@` part or query; a value that does not parse as a URL reads `<redacted>`.
Attribution is per stage until the platform exposes reader ids: a violation
names the stage and its readers, never the one reader that fetched, and a clean
reader of that stage reruns with the rest. The sweep sees only repositories that
keep a network remote and files of 100 MB or more, outside `node_modules` and
outside other repositories. An extracted archive, a smaller raw download, a fetch
with no remote, a clone nested in another repository and a clone deleted before
the stage ends all go unseen until the platform exposes reader transcripts.
A test run's fixtures are not fetches, and each new one prints a
`FETCH_IGNORED:` line with its reason instead: a directory below a sweep root
that carries `.gstack-test-fixture` (test-setup.ts puts every test's temp
paths under one such root per process and removes it after the last file), and a
repository whose every network-looking remote resolves to a local path through
`url.<base>.insteadOf` (the ship fixtures' `https://github.com/fx/fx.git`). A
marker on a sweep root itself is not honored, insteadOf that sends a local path
to the network still counts, and a clone made inside a live fixture root goes
unseen, as does one whose reader writes the marker or an insteadOf line itself.
A `Bun.spawn` child given no `env` keeps the temp dir its test process started
with, so its fixtures land outside the marked root and still count.

What this protects: the readers' findings, the merged review and PR text never
carry a sealed file a reader fetched or opened. What it cannot protect: data that
is already public may be in a model's training set, and the rule does nothing
about that.

## What the receipt records

`gstack-review-scope summary --since <REVIEW_SINCE> --run <run dir>` reads this invocation's
review-log rows and the dispatch ledgers under the run directory (`--ledger <f>` names one;
`--no-ledger` when no reader ran through `gstack-review-dispatch`) and writes the counters `gstack-ship-receipt write --review-loop`
puts in the receipt:

| Field | Meaning |
|---|---|
| `review_loop.passes` | full review passes this ship ran (1 or 2; up to 3 under `review_scope: diff-plus-blocking` or `all`) |
| `review_loop.blocking_found` | every blocker found (GST-951): the rows' blocking findings (classified, or an unclassified CRITICAL), plus each ledger CRITICAL (as collected or judged) that no row finding from the same reviewer at the same path:line accounts for (each row finding pairs with one per ledger), so an adversarial, outside-voice or not-yet-classified blocker counts and one whose newest classification is below the floor does not. An unreadable ledger, merged file or judged set, or a judged set changed since `judge`, is `REVIEW_SCOPE_LEDGER`, never a count |
| `review_loop.unrecorded` | blockers found that no row gives a disposition (fixed, deferred, noted, skipped, a gate answer); absent when 0 |
| `review_loop.unbound` | what could not bind (GST-1168), each printed as `REVIEW_SCOPE_UNBOUND: <what>: <why>`: a row with no start token and no readable time, a `pN` ledger with no review row of pass N (a fix-check ledger in a `pN` directory is not a pass ledger, GST-1775), a row finding's `ledger_id` no ledger collected, a `Review-Finding` trailer naming nothing; absent when 0 |
| `review_loop.ledgers_read` | dispatch ledgers the count read; absent under `--no-ledger` |
| `REVIEW_SCOPE_VOIDED:` (stderr, not a receipt field) | an abandoned pass (GBEV-3): a `pN` ledger never judged that no row names, replaced by a later `pM` ledger (M > N) that was judged or is named. Its findings are left out of every count above instead of counting as unbound and unrecorded. A fix-check ledger and the last pass are never voided |

Findings bind by id first (GST-1168). A row finding that came from a dispatched reader carries `ledger_id` (`<pass dir>/<merged.jsonl id>`, such as `p2/adversarial-native#3`) and pairs with that ledger entry whatever its path:line says, so a native finding with no path:line, or a row logged after its fix moved the line, still pairs. Each fix commit names what it fixed in a `Review-Finding: <ledger_id or fingerprint> reader=<raised_by>` trailer, and a trailer counts the finding as fixed. A late defer re-logs its finding under the same id, so it counts once. Rows that record their head dedupe by kind, pass, head and finding ids, so a logger command run twice counts once. Rows and findings without an id keep the path:line pairing above. The native reader's own verdict line ("all FIXABLE, and none blocks", with no file:line, list mark, lead label or Severity/Blocks field) collects at FIXABLE, not CRITICAL; the findings it summarizes collect on their own lines.
| `review_loop.deferred` | blocking findings in unchanged code, kept on the PR under `## Deferred findings` (a Step 11 late defer, logged as a `review-late-defer` row so it never displaces the newest `review` pass, counts here and is not a pass) |
| `review_loop.noted` | below-floor findings listed in the PR body |
| `review_loop.fixed` | findings fixed in this PR |
| `review_loop.scope` | the `review_scope` the loop ran under |
| `review_loop.fix_checks` | fix-checks this ship ran (never passes): the larger of the `review-fix-check` rows and the ledgers holding a fix-check reader's review. When fix-checks ran without their rows, a blocker no row disposes counts as fixed once a later fix-check ledger followed it (decision 3.5 runs one only after the fixes) |
| `review_loop.rounds` | passes plus fix-checks (R51 caps it at 2; the queue's `REVIEW_DEPTH:` line prints it) |
| `review_loop.dispatches` | reviewer dispatches by role: `specialist`, `red-team`, `adversarial-native`, `outside-voice`, `fix-check`, `targeted` |
| `review_loop.est_input_tokens` | prompt plus diff bytes the dispatches read, divided by 4: a relative estimate for comparing runs, not a bill |
| `review_targeted` | the [targeted pass](#targeted-pass-on-money-gate-auth-and-secret-code): the `classes` it covered, `rules`, `brief_sha`, the receipt's own `product_patch_id`, `status` (`done` only with its brief sent verbatim and its output collected on a committed diff, else `failed`; `write` refuses a record when a change after its read commit carries a targeted class or the read commit is not an ancestor, or when its product patch differs and the change is more than release stamps and plain docs (no binary file and no numeric, results, prereg, eval, money, security, secret or auth claim; GST-1195, GST-1689), and refuses to write without a record when the head needs a class), `findings` and `raised_by`; a carry keeps it while the product patch is unchanged |

Each review row may carry `dispatches: [{role, effort, prompt_bytes,
diff_bytes, status}]`, and each finding `raised_by` (the reviewer that raised it,
stamped by `gstack-review-scope classify`; `unknown` when untagged, absent on older rows); `summary` adds them up (older rows fall back to the
specialist stats they record). The summary line appends `fix_checks=`,
`dispatches=` and `est_input_tokens=` only when they were recorded, so an old
loop prints the old line.

Beside the counters, `write` records `review_depth` (the depth, runtime lines,
rules hash, base and registry commits, the gate scan bound to the head, the risk classes and
`mode`: lean, panel or platform; with `--declare-risk`, `declared` and `detected` beside `risk`, so a
class the lane added shows apart from what the matchers found) and the queue refuses a receipt below the depth its head needs
([ship-policy.md#ship-receipt](ship-policy.md#ship-receipt)). After `NEXT: platform`,
`write --platform-review <id>` records `review_depth: platform` with `platform_review`
(capy-ai[bot]'s review id, reviewer and head); write and the queue accept it only under
`review.platform on`, on a docs or tests diff with no numeric, results or prereg claims,
with the review at that exact head, so a new head needs `/ship` again. A stop the owner
accepted after a fix-check edit, or after the second full pass with a finding
left open (`second_pass`), goes in `review_loop_exception`, never in prose
under `REVIEW_LOOP:`. Step 16 takes the same record:
`gstack-ship-release finish --review-loop-exception <json|@file>` routes the
paths the branch touched at `fix_check.head` (narrowed to the record's
`fix_check.files` when it lists them) and changed since as `accepted=` in
`ROUTE:`, prints them on a `REVIEW_LOOP_EXCEPTION:` line, and carries them
through the docs stage. A path outside that scope and a gate-edited test still
route as behavior, with `--reviewed-base` (as /ship passes it) so does a file
too large for the scoped review, and without the record nothing changes.

A completed fix-check is a review, not an owner acceptance (GST-1130). Finish
reads the newest `review-fix-check` row from `gstack-review-read`, chained back
through earlier rows whose commit is the next row's `range_base`
([chained fix-checks](ship-policy.md#fix-check-chain), GST-1627). When every link
is a completed clean read on committed content (freshness `CURRENT` against its own
tree; a fix-check that stopped on findings the owner has since ruled notes reads
clean, [ruled notes](ship-policy.md#ruled-notes)) whose commit is on the branch, the oldest link's `range_base` is a branch commit
holding the reviewed tree (or following its commit by docs and release metadata
only, [docs bridge](ship-policy.md#fix-check-docs-bridge)), and for each link an approved `review_loop_grant` in
`gstack-approvals` names a stop head inside its `range_base..commit`, each code or test path inside a link's `range_base..commit`
that is unchanged since, or whose change against the base is still the one the
fix-check read after a base merge also edited it (GST-1195), routes as
`fix_checked=` in `ROUTE:` and is listed on a
`FIX_CHECK: reviewed` line, a gate-edited test included. The line names the
grant whose stop head is newest in that range, the fix-check's own when several
grants fall inside it (GST-1610). Authored docs keep the
stage 2.2 recheck, and a path the branch edited after the fix-check still routes by the
rules above. Any other row prints
`FIX_CHECK: not counted (<reason>)` and changes nothing. `gstack-review-log`
refuses a `review-fix-check` row without boolean `completed` and `converged`,
before it consumes the start token, because without them the row reads
`UNVERIFIED` and finish cannot count it.

<a id="bounded-post-review-edits"></a>
### Bounded post-review edits (GST-1276, GST-1311)

Some edits are required after the review binds: the Step 14.5 docs audit
corrects stale policy text, pregate asks for a lane mapping, and a verify
step renames rows in a size baseline. Finish proves each one's kind from
the diff and sends it to one scoped reader instead of Steps 5–11.5. That
read is not a review round under R51 (Garry, 2026-11-04: "Do it."), so it
needs no grant. It is the same stage 2.1 reader that test code changed
after review already takes. A path is bounded when finish runs with
`--reviewed-base`, the path changed at most 20 lines since review, its
diff is readable text, the gate scan tags none of its hunks, and it is one
of these kinds:

- **audit prose**: `docs/*.md` or the root `AGENTS.md` or `CLAUDE.md`,
  never a gate path, whose bytes now are the ones the post-audit snapshot
  (`--docs-post`) recorded. An edit made after the snapshot isn't the
  audit's.
- **lanes**: `.gstack/pregate.json` changes that pregate's own
  `headPolicyDiff` reads as added tests only, over the reviewed copy. A
  removed mapping, a new `[]` declaration or any other key stops.
- **bookkeeping**: a path matching a `bookkeeping` glob in the base
  branch's ship policy ([ship-policy.md#bookkeeping](ship-policy.md#bookkeeping)),
  first touched after review or not, a `.txt` table included, never a gate
  path or a path under `.gstack/` or `.github/`.

`ROUTE:` prints `bounded=<n>`, and finish writes the packet with every
bounded hunk, a reading note per kind and the targeted brief for every
class. The reader's clean record must carry the packet's `packet_sha256`,
which the STOP line prints. A candidate that fails a proof stays behavior,
and finish prints `ROUTE_BOUNDED_REFUSED: <path> <reason> (fix: …)`
([troubleshooting](troubleshooting.md#route-bounded-refused)). A lane
change whose other top-level keys differ from the reviewed copy stops too. A
targeted record read before the edits does not carry to the new head:
receipt write still asks for the targeted reader on HEAD (a docs-only change
plans it on its own: [targeted-only read](#targeted-only-read-after-the-loop)). A test file whose only removed lines are swapped
one for one with lines that differ inside plain quoted strings, in
statements with no assertion or test call, takes the plain test route (the
scoped reader) instead of behavior. A changed expected value in the
assertion's own statement (a multi-line one too) or in a template literal,
code inside an interpolated or prefixed string, or a deleted assertion still
stops. A value in a case table that a later test reads takes the scoped
reader.

The receipt's summary line prints `passes=<n> blocking_found=<k> deferred=<m>`,
which is what a scorecard tracks (target: a median of 1 pass per PR). A
receipt carried across a base merge or a test-only fix
([ship-policy.md#receipt-carry](ship-policy.md#receipt-carry)) keeps these
counters, because the reviewed product diff is unchanged or its only
difference passed a scoped review.

## The scope knob

`.gstack/ship-policy.json` `review_scope` ([ship-policy.md#review-scope](ship-policy.md#review-scope)):

| Value | Pass 1 | Blocking finding in unchanged code | Pass 2+ | Cap |
|---|---|---|---|---|
| `frozen` (default) | the diff | listed as deferred in the PR body | the range since the previous pass, blocking only | 2 rounds (a fix-check is one) |
| `diff-plus-blocking` | the diff | fixed in this PR | the range since the previous pass, blocking only | 3 fix cycles (Step 9.4 runs the review plan's two-round cap only under `frozen`) |
| `all` | everything | fixed in this PR | the whole diff, every finding | 3 fix cycles |

`diff-plus-blocking` is the fallback for a repository where deferred findings pile
up; `all` is the loop as it ran before the key existed. A value other than
`frozen` needs `min_gstack_version` at or past the release that added the key
(`REVIEW_SCOPE_KEY_VERSION` in `lib/ship-policy-keys.ts`) so an older gstack refuses
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
## Crediting a contributor's lines

Outside PRs are rewritten from main rather than ported
([CONTRIBUTING.md](../CONTRIBUTING.md#how-a-contributors-pr-lands)). When a rewrite
carries a contributor's lines over unchanged, the commit that carries them credits them.
Pass the contributor's PR commits as the range, fetched as a ref and never checked out
(`git fetch origin +pull/<n>/head:refs/contrib/<n>`, then `origin/<base>..refs/contrib/<n>`;
the `+` lets a re-fetch follow a force-push): the default range holds only the rewrite's
own commits and finds no co-author. A fork's commits can name any author, so list the
range first and `--exclude <email>` every author whose lines the commit does not carry
before adding `--message`.
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
   literal diff base, the plan's `DIFF_CMD` excludes (with the base policy's
   selection added, [as the pass's readers get it](ship-policy.md#one-selection-every-reader)), stack, test framework,
   learnings, checklist paths, the Red Team's merged findings and specialist count,
   and the outside voice's branch diff. A section that lost an anchor or placeholder
   refuses (`BRIEF_RENDER_FAILED`) instead of rendering something else, and so does
   a slot the section leaves unfilled (every reader but fix-check and the outside voice).
   That check runs before the findings and learnings go in, and they reach the reader
   as written, so a finding that quotes `origin/<base>` neither fails the render nor
   gets filled (GST-797).
2. The dispatch program passes that file's content unchanged as the reader's
   prompt and runs `sent` on what it passed: a hash that differs from the rendered
   one is `BRIEF_MISMATCH`, and that reader's review does not count.
3. `collect` hashes each reader's raw output and appends its findings to
   `merged.jsonl` with the label as written (a JSON line's `severity`, or the most
   severe of a prose line's Critical, High, Medium, Low, P0-P3, FIXABLE or INVESTIGATE
   wherever they stand, headings and table rows included, except that a line with its own `Severity` field takes that
   field's label (any letter case; a field stating more than one label, "High/Critical", counts as none), so a severity word in the finding's text does not raise it, and a label leading the line stays its floor (GST-976); a top-level list item under a
   label-only heading takes the stronger of the two). A `Severity:` or `Blocks:` line
   continues the finding above it until a list item, heading, bold paragraph opener or a
   second line for the same field starts another: `Severity` sets its label (a label leading the finding stays its floor),
   `Blocks: yes` makes it CRITICAL and `Blocks: no` never lowers it; an inline
   `Blocks: yes` is CRITICAL too, and with no finding above it is one. The native
   adversarial voice's FIXABLE collects as CRITICAL (normalizer v2, GSTA-167), except that on every class a native
   finding that states `Blocks: no` and one `Severity` field collects at that field (GST-1031 ruling A); a native FIXABLE
   finding without `Blocks: no`, with no `Severity` field, or whose field names only FIXABLE or INVESTIGATE still collects
   as CRITICAL. On a code or docs plan with only `runtime=<n>` depth reasons (collect `--manifest` naming this ledger's
   pass; GST-987) FIXABLE also raises nothing through a label heading or a leading tag. A numbered finding heading (`**1. …**`,
   or a lead that names its number, `**Finding 1 (FIXABLE): …**`, GST-1657) keeps every unlabeled line under it (located or
   numbered bullets, a bold subheading, a located paragraph) until its `Severity` or `Blocks` line comes, so those fields
   never split off as a second record (GST-1031); the line right under the heading that carries those fields, no other
   label and no file:line joins it at the stronger label (not under a heading that names CRITICAL or P0 itself), the way an unlocated paragraph after a blank line already does. An unnumbered, unlabeled bullet with no file:line
   under a paragraph finding whose Severity or Blocks line has not come yet is that finding's detail, so the field line after it
   lands on the finding; a numbered item is its own finding. A native adversarial numbered list item (`1. **FIXABLE. …**`)
   with no fields of its own keeps, after an unlabeled nested list, its indented lines and the first paragraph after a blank
   line until its fields come, so that paragraph's `Severity` and `Blocks` bind to the item instead of forming a second record;
   an item naming CRITICAL or P0 is never lowered, and a list item, heading, lead label, file:line, bold paragraph opener,
   verdict line or any later paragraph starts the next finding (ALPH-93).
   A reader's own no-defect closing sentence is no finding at the label it denies (GST-435): a prose line with no
   list, heading, bold or lead label, no `Severity` or `Blocks` field, no FIXABLE or INVESTIGATE, no file:line or path
   and no exception clause, with no line above it in its paragraph that runs on (no closing period) or names an
   exception, and whose every labelled sentence is
   wholly a denial ("I found nothing CRITICAL.", "I found no defect that is CRITICAL.", "No P0/P1 issues.", "Neither
   finding is CRITICAL.", or with a rating verb: "None of these rises to CRITICAL.", "Nothing reaches the CRITICAL
   floor.", GST-1628), a count ("I found three INFORMATIONAL issues and nothing CRITICAL" collects at
   INFORMATIONAL) or "nothing blocks", with labels spelled as collect spells them. Such a line collects nothing when it
   is only those sentences; when it also holds an unlabelled sentence ("Here is what I checked:", or one that may
   describe a defect) it stays on record at INFORMATIONAL, never as a blocker. A quantifier that points at a finding
   elsewhere ("nothing else", "no other", "remaining", "new"), a named defect in the same sentence ("No auth check
   guards the admin route, so nothing CRITICAL") or any other labelled sentence on the line keeps the whole line at its
   label, and a reply whose only text is a no-defect sentence, with no clean marker, is still no review. Any other negated severity word
   still collects at its label, so a closing summary with a clause of its own ("I checked these against the post and
   found nothing CRITICAL") is a known phantom: it collects at that label. When it is a summary candidate (no lead label, no
   `Severity` or `Blocks` field, and no file:line or exception clause in any sentence naming a label: "so nothing is
   CRITICAL", "so nothing reaches CRITICAL", "the test covers the CRITICAL fix"), collect marks it `summary_candidate` and lead judgment may lower it
   with a reason, which judge records as `dismissed` (GST-1031). A native adversarial finding whose own text states
   `Blocks: no` and one `Severity` field may also be lowered with a reason to that Severity, never below it, and is
   recorded as `dismissed` too (GST-1406): collect keeps the FIXABLE raise when those fields follow prose, because it
   can't tell a finding's own fields from another subject's. Otherwise lead judgment can fold it only into a finding
   at least as severe, and it counts toward what blocks. GST-766 skipped negated labels and lost
   real blockers named in an exception clause ("No CRITICAL issues except the token leak in log.ts:3"); GSTA-167
   reverted that. A reply that says `NO FINDINGS` keeps only its structured findings (GST-2122). Those are JSON objects
   (malformed JSON included), lead labels, label headings, numbered finding headings, `Severity` fields, `Blocks: yes`,
   the native voice's FIXABLE or INVESTIGATE tag, and anything naming a file:line, which still collect at their label.
   Its other prose collects nothing. Outside such a reply prose collects as described above. A denial that a change
   introduced a severity ("No fix introduced a CRITICAL defect") is a no-defect clause too, and a line led by a bold,
   unlabelled lead ("**1. Coverage:** …", "- **Callers:** …") is read for those clauses after its lead. Each prose finding's line also
   records the Severity and Blocks its own text states as `stated`, beside the collected label and never in its place;
   a classified finding that carries `stated` shows it in its `## Deferred findings` line next to the label ("CRITICAL (the
   reviewer wrote Severity: Low, Blocks: no)"). /ship's Step 9.4 does not copy `stated` into its findings file yet: that
   instruction lives in a reviewer brief that changes only after a no-loss replay. A CRITICAL whose own text writes the
   field `Blocks: no` (colon required, and no `Blocks: yes`) is not counted as a blocker by the ledger count, nor by the
   review-log count or classify when the finding carries `stated` (GST-1031); lead judgment that raises such a line above
   its label counts it again.
   A phantom finding costs a fold; a lost one costs the gate.
   A reply with no finding counts as a review only with the clean marker its own brief asks for: `NO FINDINGS` alone on a
   line for the specialists, the batched specialist, the targeted reader, the Red Team and fix-check, the `Recommendation:`
   line for the outside voice, either for the native adversarial voice. Without one (a refusal, an empty reply, a reader
   that never saw the diff) collect records `review: false`, prints `COLLECT_NOT_REVIEWED` and exits 1.
4. Lead judgment writes `judged.jsonl`; `judge` refuses a set that drops a merged
   finding, lowers its severity, folds it into a less severe duplicate, or adds or
   promotes one without a reason (`JUDGMENT_REJECTED`). A merged file missing any id
   the ledger collected is a drop. Each addition and promotion is logged with its reason.
   When every reader came back clean, `merged.jsonl` is empty and there is nothing to
   judge: `judge` writes an empty `judged.jsonl` itself and prints
   `JUDGMENT: ok nothing to judge`. A merge that holds findings with no `judged.jsonl`
   is refused (exit 2), naming the finding count.
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
   against the merged lines they produced, and each merged line against the finding collect
   parses at that id's index from the unchanged output file, its reader, label and raw text byte for byte
   (`merged_line_differs` on the OUTPUT and JUDGE rows otherwise, GST-541), so an edited
   merged.jsonl cannot lower a finding or swap its text. A recorded output file that is missing
   (`output_file_missing`), a judgment run on a merged file collect did not write
   (`judge_merged_not_collected`) and merged rows collect never recorded
   (`merged_rows_not_collected`) are dirty too, and so is an output whose re-parsed findings
   outnumber or undercount the ids collect recorded (`merged_count_differs`). The one exception
   is a reply collect refused for its tree: verify re-checks the reply's `REVIEWED_TREE` line
   against the render's tree, and such an output stays `NOT_REVIEWED` until a re-sent brief is
   answered by a reply that passes the same check. Deleting a whole output event with its rows is
   not caught yet, because the ledger has no anchor for it. The judgment is then rerun against the
   recorded judged set, covering every collected id. A ledger from a run that kept no
   prompts prints `VERIFY: no brief records` (exit 3), never clean.
6. `pass --base <b> --out <dir> --pass <id> -- <plan flags>` runs one pass from a
   staged manifest (`<dir>/pass-manifest.json`). The pass id is letters, digits and
   dashes, read as lowercase (`P1` is `p1`); any other character is refused. Audit readers marked first, then
   the specialists with the other audit readers, then the Red Team, then Step 11's
   voices. A QA extra is refused before any reader is created: Step 9.2.1's probes
   are the parent's. `--diff-base` sets every reader's base, a scoped pass's Red
   Team included; the targeted reader keeps the merge base. Each reviewer keeps its plan entry and is rendered by the same code as
   `render`, once its inputs exist; the Red Team's findings file is the specialists'
   `merged.jsonl` lines byte for byte. A brief leaves the bin in indexed chunks of at
   most 65,536 characters (`chunk`), so no tool output line carries a whole brief and a
   host's line or output cap cannot cut one. Each reader's intent is recorded before its
   subagent is created and its path right after (`mark`), so a resumed pass finds a
   create whose result was lost by its title and never starts a reader twice; a
   missing or doubled title stops the pass. On Capy the pass runs as one call to the
   checked-in program `lib/capy-review-pass.js`, served by `program` and loaded
   unchanged by the gstack Capy skill. A full repeat pass takes `--diff-base` (RANGE_BASE; a scoped pass, none), a
   fix-check plan renders its reader from `--fix-list`, `--hunks`, `--tests` and `--callers`,
   `--audit-only` runs just the `--extras` readers (Step 14.5's docs audit), `--voices`
   keeps only the plan's voices for Step 11 on its own `--out` (it takes no `--extras`, and a
   reviewer pass refuses to resume that manifest, GST-1368), and the fork
   point is found against `origin/<base>` first, as preflight does.
7. Every brief, audit readers' included, opens with a fingerprint step and ends with a
   workspace paragraph naming the checkout the bins run in (GST-482): a reader on a shared
   machine starts in the machine's working directory, so it is told to `cd` there on every
   command, to give every file tool an absolute path under it, and to start its reply with
   the `REVIEWED_TREE: <HEAD^{tree}> <toplevel>` line the step's command outputs there. The
   step comes first because a reader following a findings-only format skipped the request
   when it only closed the brief (GST-897). The section's render sits between the two,
   byte for byte. `collect` and `mark --state collected`
   compare that line with the fingerprint recorded at render: a missing or foreign line is
   `COLLECT_WRONG_TREE`, a later commit in the same checkout `COLLECT_TREE_MOVED`; nothing
   is merged, the reader becomes `failed`, and `verify` reports `NOT_COLLECTED`. An
   outside voice's tree failure is recorded `unavailable` only when its reply holds no finding. The line catches a reader that
   worked elsewhere by accident; it is not proof of reading, since diff text can predict it. A `printed:` label
   before the line (plain, bold or inside its backticks) is still read, and its tree and toplevel are still compared
   exactly (GST-776). Capy cannot start a subagent in a chosen directory, so before a stage takes a start token or sends
   its first reader, the Capy pass program compares the checkout with the one shared readers start in (the thread's
   working directory) and stops when that is another checkout or cannot be read: run /ship in the thread's own checkout.
   A start directory outside any checkout, such as a multi-repo workspace root, holds no tree to review by mistake and
   dispatches. Step 11's voices take the `adversarial-review` start
   token by default, and a `logStart` list without it stops before anything runs. Decision 3.5's fix-check pass turns a
   `review` start into `review-fix-check`, so its row is never a pass (GST-1031).

## Where this is enforced

- `lib/review-brief.ts`, `lib/review-ledger.ts`, `lib/review-pass.ts`, `lib/capy-review-pass.js`, `bin/gstack-review-dispatch`: [verbatim dispatch](#verbatim-dispatch) (`test/review-dispatch.test.ts`, `test/review-pass.test.ts`).
- `lib/ship-parts.ts`, `bin/gstack-ship-parts`: the section text each /ship phase uses, returned once per run inside the phase program before it; `next --resend` sends an unreceived batch again (`test/ship-parts.test.ts`).

- `scripts/resolvers/review-army.ts`: the floor and `NO FINDINGS` in every specialist and Red Team prompt (rendered into `review/sections/review-army.md` and `ship/sections/review-army.md`), and the lead judgment's "On record" line that turns a [ruled class](#rulings-below-the-floor) into a note; in `/ship` every specialist and Red Team prompt it renders carries its diff base as a literal sha the parent writes in (`DIFF_BASE=<diff-base>`: the merge base on pass 1, `RANGE_BASE` from pass 2 on) beside its plan's `DIFF_CMD` excludes, because a reviewer is its own process and never sees the parent's shell variables; the fan-out batches above.
- `ship/sections/review-army.md` Step 9: the plan's `REVIEW_DEPTH`, `GATE_SCAN` and `--depth-floor` on every run, the depth fields of the review-log row, passes, `RANGE_BASE`, classify, defer, render, the cap check before any edit, the Step 11 late-defer row, scratch files under `.gstack/tmp/`, the cap decisions; `ship/sections/adversarial.md` Step 11: the outside voice reads the same range and scopes queued fixes the same way.
- `lib/review-exclude.ts`: the base policy's `review_exclude_paths` (matched set, kept reasons, the kept-file argument bound, the digest the receipt, carry and the queue compare) and the 2,000,000-byte reader ceiling (`test/review-exclude.test.ts`).
- `lib/review-targeted-delta.ts`: the [targeted-only read after the loop](#targeted-only-read-after-the-loop) (`test/review-plan-targeted-delta.test.ts`).
- `lib/review-depth.ts`, `bin/gstack-review-plan`: the diff class, the depth (`depthFor`, `DEPTH_RULES`, `depthOfCommitInput`), each dispatch's `exclude` pathspecs and `DIFF_CMD`, the transition table, the numeric-claim scan and each role's effort tier (`test/review-depth.test.ts`, `test/review-plan-cli.test.ts`).
- `lib/review-collect.ts`: `collectCommit` (git objects only, from any checkout) and `collectLive` (the working tree), per-path lines and the base commit's registry (`test/review-collect.test.ts`).
- `lib/review-scope.ts`, `bin/gstack-review-scope`: `classify`, `defer`, `render`, `summary` (with `fix_checks`, `dispatches`, `est_input_tokens`, `unrecorded`, `ledgers_read`); refusals are `REVIEW_SCOPE_INPUT`, `REVIEW_SCOPE_RANGE` and `REVIEW_SCOPE_LEDGER` ([troubleshooting.md](troubleshooting.md#review-scope-input)).
- `lib/ship-policy.ts`: the `review_scope` key and its `ship: review_scope …` consequence line.
- `review/checklist.md`: `prereg-with-results` under Gate Integrity and `test-keyboard-count-loop` under Pass 2; `crew/bin/gstack-coauthor-trailers` for the contributor-credit trailers of a rewrite.
- `lib/ship-receipt-prose.ts`, `gstack-ship-receipt read --check-prose`: the body's quoted counters against the receipt (`RECEIPT_PROSE_MISMATCH`, [ship-policy.md](ship-policy.md#ship-receipt)).
- `lib/ship-receipt.ts`, `lib/headless-artifacts.ts`: the `review_loop` receipt object, its schema and the summary line.
- `lib/no-stop.ts`, `bin/gstack-no-stop`, `lib/autoplan-carry.ts`: the [no-stop defaults](#no-stop), their ledger and the autoplan re-gate (`test/no-stop.test.ts`, `test/autoplan-carry.test.ts`).
