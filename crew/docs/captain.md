# Running a Captain crew on Capy with gstack

This page is for a team that wants one coordinating agent (a Capy Captain, or any
controller agent) to run many worker threads against one repository, with gstack as the
engineering harness. It covers the drive layout, the crew rules file, the READY contract,
merge trains, approvals, the digest and the daily flaky pass. The skill that teaches the
controller the same model at run time is [`/captain`](../../docs/skills.md#captain) (it also answers
to `/crew`); the lane-side rules for a thread working under a Captain are in
[`capy/skill/gstack/captain.md`](../../capy/skill/gstack/captain.md) and
[capy-install.md](../../docs/capy-install.md#working-under-a-captain). Every file named below has a
copy-paste template under [`captain/templates/`](../../captain/templates/). For the story of how
one owner's crews run this day to day, with measured numbers, read
[capy/README.md](../../capy/README.md). Every Capy session also reads
[`capy/skill/gstack/factory.md`](../../capy/skill/gstack/factory.md), a one-page summary of
these practices with pointers to the rules.

## The model in one paragraph

Lanes build on their own branches and machines. A lane's job ends at an **unstamped
READY**: a block printed by `gstack-ship-queue ready` plus the full head SHA, the screen
choice and the flaky cases. The controller validates the block, batches READY pins into a
**merge train**, reads one full gate on the train head, then merges slot by slot: it calls
the slot, the lane stamps the version on call, the controller verifies the tree, merges
with the expected head, verifies again. A red train is bisected on its red cases and
rebuilt at most once. Every decision the owner makes travels through the controller in a
fixed shape and is recorded in the owner's words. Flakes are logged in a ledger and fixed
by a daily pass; nothing is retried into green.

## Roles

- **The owner** decides what only the owner can decide: product and behaviour, spend over
  a cap, anything published outside the repository, thresholds and budgets, closing a
  contribution, anything destructive. Every answer is recorded in the owner's words.
- **The controller** (the Captain) runs the crew: starts lanes on disjoint files, keeps the
  rules file, the digest and the notes, validates READYs, builds and merges trains, calls
  slots, relays asks to the owner in the three shapes, runs the flaky pass, and decides
  everything that needs no access, credentials, spend over cap or a cited approval. It
  archives only its own crew threads, each when its plan for that thread says the work is
  done and never while it still owns open work ([No orphaned work](#no-orphaned-work)); it
  knows each thread's next step, so nobody else archives them. A thread outside
  every crew belongs to the owner and stays as it is: no Captain archives it, flags it or
  lists it for archiving unless the owner asks, even when the Captain's own automation
  created it.
- **A lane** (a crew thread) owns named files, builds on its own branch and machine,
  runs /ship, sends one READY block, stamps on call (merging the base into its pin only
  as part of that stamp commit, or when the controller names a real-code conflict),
  writes one report, and never merges a PR.
- **A merge lane** (optional) is one crew thread that watches PRs and CI for the controller.
  Every Captain wake that comes more than about five minutes after its last call rewrites the
  Captain's whole context cache at many times the warm price, so a Captain whose PRs bring
  many check, review and merge wakes hands that watching to a merge lane and stops
  subscribing to PRs itself. The merge lane holds the PR watches, lands verified READYs as the
  crew's rules allow, and reports to the Captain only a landing, a red check that needs a
  decision or a blocker. Each other lane still owns its own PR's CI and review up to READY,
  so CI pings wake the lane that can act on them, never the Captain.
- **The controller never commits to a lane's branch**, and a lane never pushes to another
  lane's. One committer per shared tree.

## Drive layout

The Captain's drive is mounted read-write on every crew thread, so it is the handoff
surface. Keep it small and predictable:

| Path | Who writes | What it holds |
|---|---|---|
| `AGENTS.md` | the controller | standing rules and the owner's decisions, each with date and words ([template](../../captain/templates/AGENTS.md)) |
| `CREW.md` | the controller | the lanes' contract ([template](../../captain/templates/CREW.md)) |
| `DIGEST.md` | the controller | Needs you / New / In progress, rewritten every turn ([template](../../captain/templates/DIGEST.md)) |
| `NOTES.md` | the controller | the append-only timestamped log the digest is derived from ([template](../../captain/templates/NOTES.md)) |
| `skills/<name>/SKILL.md` | the controller | crew procedures the lanes load (the runbooks) |
| `reports/<code>.md` | each lane, once | Outcome with its Unverified line, PR, Needs, Cost, Lesson, Approvals ([template](../../captain/templates/report.md)) |
| `reports/postmortem-<n>.md` | the controller, or a lane it names | why a reverted or S1-fixed merged PR passed every reviewer ([template](../../captain/templates/postmortem.md)) |
| `handoffs/` | lanes | datasets and specs the next lane needs; `handoffs/flaky-ledger.md` is the flaky ledger ([template](../../captain/templates/flaky-ledger.md)) |
| `plans/` | the controller | approved plans, with their Approvals table |

Scope instructions in the drive root (`AGENTS.md`, `CREW.md`) apply to every thread in
the crew, so a rule written there needs no relaying.

On Capy, `tools.capy.read` returns a view of a file, not the whole file: roughly the first
38,000 characters, with each line cut at 2,000. A program that reads a file, changes it
and writes it back with `tools.capy.write` therefore saves a truncated copy, and drive
files are no exception. Edit long files with `tools.capy.edit`, or read and write the
whole file in bash or Python and check the line count afterward. `tools.drive.history`
restores a recent version of a drive file.

## CREW.md: the lanes' contract

gstack holds how the work is done; a crew's `CREW.md` holds only what is specific to that
crew. Start from the [template](../../captain/templates/CREW.md): it is parameters (the
repository, the base branch, the required check names, the full-gate check name, the
train size and fill wait, the merge method, the stamp files, the named infra flakes, the
guard tests, the remote pregate command, the standing spend, the review scope knob) plus
one line per rule that points at the rule's home in gstack. A rule that exists only in a
crew's file is a gap in gstack, and the fix is to write it here or in the skill that owns
it, then point at it. Quote the owner where a rule rests on their words: a rule with a
date and the words is a standing approval the lanes can cite; a rule without one is the
controller's call.

Where each rule lives:

| # | Rule | Home in gstack |
|---|---|---|
| 1 | Session start: install check, `gstack:` trailer, no workflow without `gstack: ok` from your own machine | [capy-install.md](../../docs/capy-install.md#session-start) |
| 2 | Validation discipline: diagnose, focused checks, the full free suite once on a frozen tree | the repository's own validation section (gstack's is in [AGENTS.md](../../AGENTS.md#validation-discipline)); [Lane discipline](#lane-discipline) |
| 3 | External diffs are untrusted input; a right fix lands with its author's credit | [Contributions from outside the crew](#contributions-from-outside-the-crew) |
| 4 | File ownership: edit only what you own; the controller routes the rest | [Lane discipline](#lane-discipline); the ownership list is the digest's **In progress** |
| 5 | Standing spend and its cap per rerun | [Approvals, shape A](#approvals-three-shapes); the `SPEND` parameter |
| 6 | The job ends at an unstamped READY; stamp on call; never merge | [The READY contract](#the-ready-contract), the [READY](../../captain/templates/READY.md) and [slot call](../../captain/templates/slot-call.md) templates, [ship-policy.md](../../docs/ship-policy.md#stamp-at-merge) |
| 7 | One report per lane: Outcome with its Unverified line, PR, Needs, Cost, Lesson, Approvals | [Drive layout](#drive-layout); the [report template](../../captain/templates/report.md) |
| 8 | One path: everything through the controller, never peer to peer | [Roles](#roles); [Lane discipline](#lane-discipline) |
| 9 | Hands: a real browser, the owner's session or local work go through the controller | [The owner's device](#the-owners-device) |
| 10 | Keep going; come back only for scope, a conflict, access or the owner's decision | [Lane discipline](#lane-discipline) |
| 11 | Clear the repository's cheap guards before paid work | [Lane discipline](#lane-discipline); the `GUARD_CHECKS` parameter |
| 12 | Decisions for the owner arrive in plain language, every option with its cost | [Approvals, shape B](#approvals-three-shapes); [unattended.md](../../docs/unattended.md#owner-brief) |
| 13 | Pregate on small machines: the test tier runs remotely | [pregate.md](../../docs/pregate.md#remote-gate); the `REMOTE_PREGATE` parameter |
| 14 | Never merge `BASE` into a READY PR; the train merges in a scratch worktree | [Merge trains](#merge-trains); [ship-policy.md](../../docs/ship-policy.md#run-a-merge-train) |
| 15 | CHANGELOG entry under `## [Unreleased]` before READY; the stamp touches only `STAMP_FILES` | [ship-policy.md](../../docs/ship-policy.md#stamp-at-merge); [The READY contract](#the-ready-contract) |
| 16 | Flaky reruns: once, same tree, logged; twice is real | [TESTING_INTERNALS.md](../../docs/TESTING_INTERNALS.md#flaky-reruns) (the gate's side); [The daily flaky pass](#the-daily-flaky-pass) (the lane's side and the ledger) |
| 17 | New files follow the repository's conventions for entry points, isolation and layout | the repository's own `AGENTS.md` (the `REPO_CONVENTIONS` parameter names the section) |
| 18 | Outside PRs are bug reports: a verdict within 7 days; rewrite real bugs on main with credit, no contributor commit in the tree | [Contributions from outside the crew](#contributions-from-outside-the-crew) |
| 19 | CHANGELOG-only conflicts are the train's to resolve, not the lane's | folded into 14: [ship-policy.md](../../docs/ship-policy.md#ship-before-ready) ("the stamp keeps the pin's receipt") |
| 20 | A READY from before a contract change needs a fresh receipt | [The READY contract](#the-ready-contract) |
| 21 | Approvals, plan asks and merge asks in the three shapes | [Approvals](#approvals-three-shapes); [capy/skill/gstack/captain.md](../../capy/skill/gstack/captain.md) |
| 22 | /ship before every READY; the block carries `SHIP_RECEIPT`; stamp commits hold only tool output | [ship-policy.md](../../docs/ship-policy.md#ship-before-ready); [the lane's /ship sequence](#the-lanes-ship-sequence-before-ready) |
| 23 | Review loops converge: scope frozen after pass 1, later passes on the delta, a pass cap, a blocking floor | the `/ship` and `/review` skills' own convergence policy ([skills.md](../../docs/skills.md#ship)); a crew names it in one line and sets only the scope knob (`REVIEW_SCOPE`) |
| 24 | Plan before build: a sized `/autoplan` is a building lane's first act; the plan ask goes up, the build starts after the owner's word is in the run and it reports `APPROVED` | [Plan before build](#plan-before-build); the [brief template](../../captain/templates/brief.md) |

## Lane discipline

A lane follows the repository's own validation discipline (gstack's is the
[Validation discipline](../../AGENTS.md#validation-discipline) section of its AGENTS.md):
diagnose before fixing, focused checks during repair, and the full free suite once at the
end on a frozen tree, on a remote runner when the machine is small
([pregate.md](../../docs/pregate.md#remote-gate)). Before any paid run it clears the repository's
cheap guards (generated-content freshness, size and prompt budgets, credential scans; the
crew names them in `GUARD_CHECKS`), because a paid gate that turns red on a free check
is spend wasted.

A lane writes the public record in plain words: its branch name, PR title, commit subjects
and changelog fragment say what changed for someone using the project, with an issue code
only at the end (`capy/github-rate-limit-gst-1713`, "Stop gstack from hitting GitHub's rate
limit while it waits on PRs (GST-1713)"), and its PR body keeps codes, receipts and lane
state in the closing Agent notes section ([ship-policy.md](../../docs/ship-policy.md#plain-titles)).

A lane edits only the files it was given. The controller keeps the ownership list in the
digest's **In progress**; a lane that needs a file another live lane owns tells the
controller, who routes it, and never edits it itself. Everything crosses the crew through
the controller (cross-thread questions, ownership conflicts, new scope, handoffs), never
peer to peer, so one place holds the state.

A lane never stops to ask whether to continue. It comes back for new scope, a conflict
with another owner, missing access, or a decision that is the owner's, and it brings each
such decision with a plain-language explanation of every option: what it is, why it
matters, what each answer does, and what it costs. A gate code or a tool's result line
alone is not an ask.

## Lane context

Every step a lane takes re-reads its whole conversation. A step within about five minutes
of the previous one reads it from the prompt cache; after five idle minutes the cache is
gone and the next step costs about eight times as much. Fixed instruction text and idle
restarts, not checks, are now most of a lane's own spend, so a lane keeps its context
cheap:

- **Warm waits.** When a lane expects a wait under about 30 minutes (a CI run, a test
  tier, a background build), it checks in every 240 seconds: on Capy, `wait` on the
  operation with `duration_seconds: 240`, and on a timer wake that brings nothing new it
  re-issues the same wait silently, with no message. Once a warm wait has run about 30
  minutes, or past the end the lane expected, the lane stops re-issuing the timer and
  sleeps on the operation or pull request watch alone. `gstack-runaway scan` leaves these
  check-ins out of its empty-wake rate: a turn whose only call re-waits on the same
  operation, or a 240-second timer on it or on nothing, within 30 minutes of the first wait.
  A status read in between counts and does not restart the 30 minutes. A wait expected to run
  longer sleeps on its operations alone. For short lane waits this overrides "waits go on
  operations, never on polling wakes" ([unattended.md](../../docs/unattended.md#report-length)). The
  controller never warm-waits, and a lane still sleeps while /ship runs
  ([the lane's /ship sequence](#the-lanes-ship-sequence-before-ready)).
- **Batched reads.** Independent reads (files, greps, pull request and thread state) go in
  one parallel program, not one call each. Each call returns 4k characters or less; long
  output (logs, test output, diffs) goes to a file under `~/.capy/work`, and the lane reads
  the part it needs with `grep` or a paged read.
- **Start card.** Once the install check passes, a lane reads
  [lane-card.md](../../capy/skill/gstack/lane-card.md) instead of the rest of the gstack
  skill's SKILL.md. It still reads the SKILL.md sections on /ship before it ships.
- **Tail check.** When a lane's spend passes twice the crew's median lane spend per merged
  PR (about $50 at today's prices), it writes `handoffs/<code>/next.md` in the controller's
  drive (what is done, what is left and what finishing costs) and tells the controller in
  one line. The controller decides whether the lane continues, rotates to a fresh lane
  that starts from that file, or parks. This sits below the crew's hard spend stop (a
  per-PR figure in the controller's rules), where the lane stops and asks whether the PR
  is still worth it. Spend is the
  thread's credit meter, never a token count.
- **Keep the PR to the end.** A lane keeps its PR until it merges or closes and hands
  off only at that boundary, never mid-PR on a token count. When its own tokens pass 1
  billion (about $330), it checks in with the controller once, then carries on unless
  told otherwise. Standing threads that wake on every event (merge lanes, watchers, an
  automation's standing thread) still rotate at 500M own tokens or 3 days, and subagent
  limits stay as they are: look at any subagent past 100M, and never reuse one across PRs
  ([/runaway-stopper](../../runaway-stopper/SKILL.md)). Why: every handoff wakes the
  controller, whose tokens cost about 1.7 times a lane's, and handoffs are where orphaned
  PRs came from. One PR went through four threads in eight hours (about 103k credits) on
  per-thread token stops and was still a draft.

## New threads join the crew

A crew thread never creates a thread itself. It asks its Captain, and the Captain creates
the thread, which puts it in the crew from the start: the Captain briefs it, reads its
reports and archives it when its work is done. When a crew thread has already made a
thread, it reports the new thread's code to its Captain in that same turn, and the Captain
adds it to the crew (`crew.add` on Capy).

A thread in another project goes Captain to Captain, because `crew.add` refuses a thread
from another project and a Captain creates threads only in its own project. The crew
thread asks its Captain, who asks that project's Captain to create and own the thread, and
the results come back the same way. For the receiving Captain, that ask is work: it
creates the thread in its own crew, briefs it and returns the result. Only when the other
project has no Captain does the crew thread create the thread itself, and then it records
the new thread's code on the work's issue so the thread can still be found. A thread the
crew thread already created in another project goes the same way: it reports the code to
its Captain, who asks that project's Captain to adopt the thread, and the code goes on
the work's issue.

Why: a crew thread once created a thread in another project directly. That thread ran
outside every crew, so no Captain briefed it, tracked it or could archive it.

**Finish before starting.** The Captain starts no new fix thread in a repository while
more than 10 finished PRs (green, reviewed, waiting only to merge) sit in that
repository's queue. It merges or closes them first, closing only as landed, superseded or
dropped ([No orphaned work](#no-orphaned-work)). Severe hotfixes are exempt: security, data
loss, a red main or a broken install. Why: a finished PR that waits goes stale and
conflicting, and each new fix thread adds to a queue nobody is clearing.

## No orphaned work

A PR or issue whose owning thread is archived has nobody to wake. CI, reviews and merges
wake only the thread that opened the PR, and nothing wakes anyone when a note's "start the
successor when X happens" comes true. In November 2026 gbrain's queue reached 220 open PRs
partly this way: eight trains and a finished feature sat for 1 to 8 days with no owner,
went stale and conflicting, and started to look like junk.

- **Never archive a thread that holds an open PR (R91).** A thread stays, idle if need be,
  until every PR it opened or carries is merged or closed. Work that has to move gets its
  successor started first, and the successor subscribes to every open PR (the
  [/runaway-stopper successor brief](../../runaway-stopper/templates/successor-brief.md)
  does this for rotations), while the old thread stays: a successor never makes archiving a
  thread with an open PR OK. When no successor is needed yet, the Captain takes the work
  itself, on an issue assigned to a live thread with the trigger written in it.
- **Archive through the check.** Before archiving any crew thread, re-assign every open
  issue it holds to a live thread or close it, then archive with the one program below. It
  reads the thread and its open issues, runs `gstack-archive-check thread`, and archives
  only on exit 0 (`ARCHIVE_CHECK: clean`). The check re-reads every PR the thread holds
  from GitHub and refuses while any is open, or while an issue in a working state (anything
  open but Backlog or Needs you) is still on the thread. It fails closed: stale, truncated or
  unreadable reads, failed gh reads and a PR state other than `OPEN`, `CLOSED` or `MERGED`
  refuse too ([troubleshooting](../../docs/troubleshooting.md#archive-reads-stale)).
  Every run prints a handoff stub (each open PR's branch, head and CI at that head, and the
  open issues) to paste into a successor brief. When an issue list has more than one page,
  read every page into `issues`.

  ```js
  const code = "PROJ-123";
  const [thread, issues] = await Promise.all([
    tools.thread.get({ thread_id: code }),
    tools.issue.read({ assignee: code, status: "open" }),
  ]);
  const file = `.gstack/tmp/archive-check-${code}.json`;
  await tools.capy.write({ path: file, content: JSON.stringify({ read_at: new Date(await now()).toISOString(), thread, issues: issues.text }) });
  const check = await tools.capy.bash({ command: `. <GSTACK_LAUNCH_FILE> && gstack-archive-check thread --thread ${code} --reads ${file}`, description: "Checking the thread before archiving" });
  if (check.exit_code !== 0) return check.output;
  await tools.thread.archive({ threads: [code] });
  return check.output;
  ```
- **Triggers never live only in notes.** A "successor takes the slot when X" line goes on
  an issue owned by a live thread, never only in NOTES.md.
- **Sweep for orphans.** Every Captain wake that reads its crew, and the daily issue sweep
  below, list open PRs whose owning thread is archived, issues with no live owner and
  outside PRs with no verdict after 5 days, and re-own each one. Nothing is closed for
  being old.
- **Close only as landed, superseded or dropped.** A crew PR closes only as landed (link
  the merge commit), superseded (link the replacement) or dropped (quote the decision).
  Anything else is salvage: a live owner rebuilds it onto current main, in the area's next
  wave when the queue is long. Old and conflicting is how finished work looks when its
  owner went away, not a reason to close it. Age a PR by its `createdAt`: bots touch every
  PR, so "last updated" means nothing.

## Keep issues tidy

Issues show what the crew is really doing, so keep them true:

- Before archiving a thread, re-assign every open issue it holds to its successor or the
  Captain, and close only what is done; `gstack-archive-check thread` refuses the archive
  while an issue in a working state is still on the thread, and lists Backlog and Needs you
  issues as notes for you to re-assign ([No orphaned work](#no-orphaned-work)).
- On each wake, leave every issue you touched accurate: its status, assignee and links.
- An unassigned Todo that nobody will start goes to Backlog.
- Deferred findings from review or /ship never become issues: they stay on the PR's
  findings or its `## Deferred findings` section, and any still open close when the PR
  merges. Follow-up work someone will actually do gets one issue with a named owner.
- A daily sweep re-assigns any open issue outside Backlog whose assignee is archived to a
  live owner ([No orphaned work](#no-orphaned-work)), and closes, re-assigns or backlogs
  one that nobody has touched for 2 days whose assignee is idle with no open PR. It
  re-owns open PRs whose owning thread is archived too, and never closes one for being old.
- The sweep skips an issue assigned to a person (an ask waiting on the owner, say) and a
  Waiting issue that names what it waits on, by a blocked-by link or a dated comment, while that is still open.

The target: the Overview's In progress count is about the number of working threads plus
the PRs waiting to merge.

## Plan before build

A lane that builds something plans first. Its first act after the session-start install
check, before any product code, is a `/autoplan` run on its brief, sized to the work. The
full run's phases run in order, CEO, then design, then DX, then eng, with design and DX only when the
scope has them. A bug fix gets no plan review and a feature gets the lean run (both below). On Capy the
unattended loop is `autoplan/DRIVER.md` in the gstack checkout. New functionality a lane
takes on part-way, scope its brief did not name, gets its own plan and its own ask before
the lane builds it. In the rules file this is rule 24 of the
[template](../../captain/templates/CREW.md); a crew whose own rules already took 24 before
this rule shipped cites this section by name.

**What the lane sends.** The plan and its gate in plain language a person outside the
project can follow: what changes, why now, what the change does, what it costs, the lane's
pick, and the choices as lettered ask lines ([the ask format](#the-ask-format)). `gstack-owner-brief render --captain --out <run dir>`
prints that from the plan's `## ELI5`, `## Before → after`, `## Why it matters`,
`## What caused this work` and `## Big decisions` sections (also saved as `eli5` in
`gate.json`, so `gstack-gate render` opens with them), with the cost lines
(`GATE_SPEND:`, `GATE_REC_COST:`) and a last line for the controller; a plan missing a
section exits `CAPTAIN_BRIEF_INCOMPLETE`, so the lane adds the section and renders again
([capy/skill/gstack/captain.md](../../capy/skill/gstack/captain.md) § 3 lists them). The lane
sends it whole, as a needs-you report, and builds nothing yet.

**What the controller relays.** One ask to the owner in shape B below, its choices in
[the ask format](#the-ask-format): "do it" (every recommendation, plan changes included,
at full scope, follow-ons included) is the default, and a named option such as "A2" takes
that option instead. The plan as first written is never the default.

**The build gate.** The lane builds only after the owner's word has come back through the
controller and been answered into the run
(`gstack-autoplan answer --out <run dir> --gate-rev <n> --reply <tokens> --by agent:<thread> --owner-reply "<their words>"`),
every accepted plan change has been incorporated (`revise`), every reopened phase has
finished, and the run reports `APPROVED` (`status=complete` after `export`). An answered
gate that still prints `PLAN_AMEND_PENDING` or `REOPENED:` is not a completed plan, and an
imported approval row alone is not completion. A later gate revision that asks nothing new
is answered with the owner's recorded words and says `CARRIED:`; that is the owner's word,
not a new ask ([carry-forward](../../docs/unattended.md#carry-forward)).

**The record.** `gstack-approvals import --autoplan <run dir> --by "<owner>"` (with
`--stack <b1,b2,...>` for a stacked PR set) writes the approval row (date, the ask, the owner's exact words, the lane that answered as relayer,
what it covers; a gate answered with `--words-by agent:<id>` is listed under that agent as its own decision, not the owner's words); `gstack-approvals render` puts it in the report and the PR body. Before
training the PR the controller compares that row's words and `gate_rev` with the ask it
relayed and the reply it carried back; a row that does not match is not READY (shape A).
The brief's done line names the row. The READY block carries the resolved plan as its
`PLAN:` line, which the [READY template](../../captain/templates/READY.md) refuses when it is
missing, says `warn`, or names another plan than the brief's `Plan:` line.

**Exemptions.** Read-only lanes (triage, research, measurement, a review voice), the daily
flaky pass's repairs, slot stamps, CHANGELOG-only conflict resolves and a size or budget
cap re-pinned under the controller's written grant need no plan. Two kinds of fix are exempt
too: an S1 emergency (a broken install or upgrade, a red main, a security bug), and a fix
from a problem list that was already diagnosed and audited, where that list is the plan.
Any other bug fix is exempt too (R65; the brief's reason is `bug fix (R65)`): `gstack-autoplan next --kind fix` prints
`AUTOPLAN: not needed (bug fix; R65)` and writes nothing, and the PR carries the bug's
proof, a repro on current main or a failing test written first. A feature gets the lean
run, `--kind feature`: one reviewer reading the plan and the draft code together against
short CEO and eng checklists (design and DX when scope has them), not those review skills'
own methods, one gate revision and no carry check (docs/unattended.md). `--full` brings
back a phase per area with two voices, each still working from a short brief (the native
one also gets that phase's checklist).
A crew may add exemptions
in its rules file with the owner's words and date; it does not remove these. The brief
says which applies, `Plan: required | approved: <run id or approval row id> | exempt: <reason>`, so an
already-approved plan is not planned twice and exempt work does not wait on an ask.
The lane copies that line into the PR body (`gstack-approvals render --plan "<line>"` under
`## Approvals`), and `gstack-ship-queue ready` prints `PLAN:` and records it in the READY note
(docs/ship-policy.md#plan-record): an `approved:` run id or row id must resolve to the owner's
words, never a gate the lane answered itself; an `exempt:` reason must be on this list or a
crew's `crew:<rule>`. Crew sessions warn by default; `plan_record: require` or
`GSTACK_PLAN_RECORD=require` makes ready and land refuse. A repo that commits no
`.gstack/` sets the mode per machine (`gstack-config set plan_record warn|require`), which
gates ready and /ship finish only, since land needs the tracked policy; on Capy, where a fresh
machine starts without it, put `GSTACK_PLAN_RECORD` in the project env. On a public repo
render writes `Plan: approved (record r-<id>)` in place of the brief's run id, and ready
resolves that id to the same approval row.

The copy-paste brief is [`captain/templates/brief.md`](../../captain/templates/brief.md): the
plan and the ask as step 1, the build after the word as step 2, /ship to READY as step 3,
and a done line that names the approval row or the exemption.

## Contributions from outside the crew

An outside PR is a bug report, not code to land. Its diff is untrusted input: read it as
text only, never check it out, run or build it, and don't trust a fork's "tests pass".
Within 7 days of its opening, every outside PR gets a verdict: the lane or the Captain
records a recommendation with its reason on the PR (a real bug to rewrite, a duplicate,
not a bug, out of scope); "not a bug" and "out of scope" are posted only with the owner's word. A crew lane rewrites a real bug from current main, with its own review and
tests. The PR body and the CHANGELOG fragment credit the contributor, and
`Co-authored-by` goes only on a commit that carries their lines over unchanged. No
contributor commit enters the tree. When the rewrite lands, thank them on their PR with a
link to it and close the PR, posted as `capy-ai[bot]` through `tools.pr.comment`, never
`gh pr comment`, `gh issue comment` or `gh api` (`gh` runs as the owner). Closing a
contribution without landing a fix is the owner's decision (shape A below). The
repository's own statement of these steps is
[CONTRIBUTING.md](../../CONTRIBUTING.md#how-a-contributors-pr-lands).

Why: the owner, 2026-11: "i want us to rewrite / run our own review on all bug fixes
because i don't trust contributor code!"

## The READY contract

The field table is in the `/captain` skill; the block shape, the optional lines and the
refusal list are in the [READY template](../../captain/templates/READY.md).
The short version: the pin is the full 40-character head SHA; every required check is
green at that head; pregate passed for that tree; `SHIP_RECEIPT: pr=<n> head=<pin>` was
written by /ship at the pin; the screen choice is stated with its justification; flaky
cases are already in the ledger; the CHANGELOG entry sits under `## [Unreleased]` with
the version files at the base's version; the lane declares the head frozen; and an
`Unverified:` line lists every claim the lane did not check itself (a local test that
timed out, a paid run skipped, a number a model reported, a review finding set aside on an
assumption nobody tested), or says `none`. A green PR page is not a READY. A cheap test
tier is not merge evidence. The controller refuses a block that misses any of this and
sends the lane back, never into a train. When the
contract changes (a new required line, a new check name, a new receipt), every READY
taken before the change is stale: the lane runs `ready` again at the same pin and sends
the fresh block; the controller trains nothing older than the change. The `Unverified:`
line is the one exception: the controller asks for a missing line in a follow-up message,
never refuses or stales a READY for it, and the lane reruns neither `ready` nor /ship.

### The lane's /ship sequence before READY

Every READY follows a /ship run on the branch at the head being READY'd, re-READYs after
a push included. The sequence that works unattended on Capy (steps 3 to 8 run inside
/ship; steps 1, 2, 9 and 10 are the lane's):

1. Install for ship (`bash scripts/install.sh --for ship` from the project directory; a
   planning-only install does not admit /ship).
2. Push the final head first. Everything below binds to it; a later push makes the
   receipt, the pregate record and the review binding stale.
3. Launch with the printed `GSTACK_LAUNCH` assignments (unattended session kind, state
   root, Capy flag) and follow ship/SKILL.md with the Capy adaptations: take every
   recommended option, leave consents and gates pending, never push or merge from the run.
4. Pregate on the still tree: preflight, then the test tier on a remote runner when the
   machine is small; clear the macOS and Windows lanes with this head's own green CI run
   URLs. Never run a bare pregate afterwards (it resets the regen check).
5. Reviews: mint tokens, run both passes read-only, finish them so the review log binds
   to the current tree.
6. Docs audit: snapshot the documentation candidates read-only and record the vetted
   section.
7. Body and receipt: compose the PR body (What changed, Why, Blast radius, Approvals first on Capy),
   write the ship receipt into it, post body and title.
8. Terminal line: `gstack-ship-receipt result --pr <n>` prints
   `GSTACK_RESULT: skill=ship status=complete`. `SHIP_PAUSED: base-red …` with
   `status=incomplete` means Step 5 proved its failures are the base's own
   ([base_red](../../docs/ship-policy.md#base-red)): the lane is waiting, not failed. It
   registers `gstack-base-red wait --pause <file>` as a background operation,
   tells the controller which cases hold it, and on `BASE_GREEN` runs
   `/ship --resume <record>`; no READY goes out on the conditional receipt,
   except on a train with `gates` ([Merge trains for other repos](#merge-trains-for-other-repos)).
9. READY: `gstack-ship-queue ready --pr <n> --pregate <pregate.json> --screen|--no-screen`;
   send the printed block. The lane runs this on /ship's completion wake, below.
10. After the slot call, the stamp commit keeps the pin's receipt; re-READY with the same
    receipt, no second /ship.

When /ship runs in a subagent, the lane sleeps while it runs. After dispatching /ship, the
lane ends its turn and wakes only on /ship's completion: one wake to relay READY, because the
controller hears READY from the lane, never from its subagent. So the lane holds no pull request watch of its own
while /ship runs: /ship opens the pull request, and on a re-READY the lane cancels the watch
it already holds before it dispatches. Every READY duty has one owner, so `train build`
never refuses the pin with `QUEUE_NOT_READY` for a step nobody ran:

| READY duty | Owner |
|---|---|
| The ship receipt (`SHIP_RECEIPT:`) and the pregate record behind the `PREGATE:` line (steps 4, 7 and 8) | /ship |
| `gstack-ship-queue ready --pr <n> --pregate <pregate.json> --screen\|--no-screen` at the pin, with its notes pushed to origin `refs/notes/gstack-trains` (step 9; /ship runs on the lane's machine, or the lane copies its `pregate.json` over first) | the lane |
| The decision-trail audit and the READY's `Attention` section, when the crew keeps a trail ([unattended.md](../../docs/unattended.md#the-decision-trail)) | the lane |

On the completion wake the lane subscribes to the pull request's check and review notices,
reads its checks and comments once (a notice that landed while /ship ran went to /ship, or to nobody on a re-READY),
stops the /ship subagent, runs `ready`, audits its trail, writes `Attention` and sends the
READY. A completion that ends `SHIP_PAUSED: base-red` follows step 8 instead: the lane
registers the base-red wait, tells the controller, and sends no READY. From then on the lane handles the pull request's events as before: red checks, human
review, the slot stamp and re-READY of step 10, and any receipt carry. It does that work
itself or sends it to the subagent as an explicit instruction. The tradeoff: a red check
that lands while /ship runs waits for /ship to finish instead of being fixed in parallel.
In exchange, the lane stops re-reading its whole context on every notice during /ship. On
Capy the mechanics are in [the gstack skill](../../capy/skill/gstack/SKILL.md#plan-approve-ship).

When the base moves under a reviewed branch, merge it in; never rebase. A merge that
leaves the product diff unchanged carries the receipt with `gstack-ship-receipt carry`
(pregate at HEAD, no review rerun), and a merge whose resolution changed product code
needs a fresh /ship. A rebase carries only onto a tree the receipt already covers with
the same product diff; any other rebase is a full /ship
([ship-policy.md](../../docs/ship-policy.md#receipt-carry)). A controller never asks a lane to
rebase a reviewed branch.

## Direct land (`merge: direct`)

When the base policy sets `"merge": "direct"`, there are no trains, slot calls or stamp
commits. Each PR merges at its own green head, and versions are set at release
([ship-policy.md](../../docs/ship-policy.md#land-direct)):

1. Lane: /ship, then `gstack-ship-queue ready --pr <n> --no-screen` at the pinned head,
   then READY to the Captain with that pin. The PR carries a `changelog.d` fragment and
   leaves VERSION, the `package.json` version and CHANGELOG.md alone.
2. Captain: `gstack-ship-queue land --pr <n> --pin <sha>` (add `--allow-repo-commands` when
   the base policy lists `land.merged_checks`, so a stale base can run them). It merges with
   `--match-head-commit`, checks main's tree and writes a land note. In the same program,
   after `MERGED`, run `gstack-archive-check landed --pr <n>` from the repository root (it
   refuses with `ARCHIVE_POLICY_UNREADABLE` when `.gstack/plain-titles.json` is missing,
   invalid or empty, and closes nothing). For each
   `ISSUE_CLOSE: <code>` line, read the issue with `tools.issue.read`. Move it to Done with a
   comment naming the merge commit only when it links this PR, links no other open PR and has
   no open sub-issues; skip one already Done; otherwise leave it open with a comment saying
   why. Report the closed, skipped and failed codes. After a partial run, reconcile with
   `tools.issue.read` and rerun: codes already Done are skipped. The landed PR's thread
   stays unarchived until none of its PRs is open (R91); archive it then through
   [the check](#no-orphaned-work).
3. Release: before each regular stable cut (Monday and Thursday, 14:00 UTC), and in the same
   turn it lands a PR whose fragment carries `important:` (the READY says `rides the daily
   cut`; [releases.md](../../docs/releases.md#the-daily-check)), the Captain runs
   `gstack-release-stamp open`, waits for the release PR's checks, then lands it with
   `gstack-ship-queue land --pr <n> --pin <head>` (no /ship receipt or READY note needed for a
   `release/<version>` head). The cut then tags the new version
   ([ship-policy.md](../../docs/ship-policy.md#release-stamp)).

What to do with each refusal (nothing was merged unless the code says so):

| Code | Who acts | Action |
|---|---|---|
| `QUEUE_LAND_STAMPED` | lane | run the printed `git checkout $(git merge-base origin/main HEAD) -- …`, keep the fragment, commit, /ship and `ready` again |
| `QUEUE_LAND_PIN_MOVED` | lane | /ship and `ready` at the new head, new READY |
| `QUEUE_RECEIPT_MISSING` / `QUEUE_RECEIPT_STALE` | lane | /ship at the pin |
| `QUEUE_NOT_READY` | lane, or Captain | no READY note: `ready --pr <n> --no-screen` at the pin; `merge: train`: use the train; closed or retargeted PR: as named |
| `QUEUE_LAND_CHECKS` | Captain, then lane | pending: `gstack-pr-wait <n> --until green` and rerun; red: back to the lane (rule 16 rerun for a flaky case); missing: dispatch the workflow on the branch |
| `QUEUE_LAND_MERGED_CHECKS` | lane | a `land.merged_checks` command failed on the pin merged onto main: the lane merges main (rule 19), fixes it, /ship, `ready`, new READY |
| `QUEUE_LAND_NOT_CLEAN` | lane, or Captain | `CONFLICTING`, or the pin conflicts with main's tip on a stale base: the lane merges main (rule 19), /ship, `ready`; `UNKNOWN`: rerun in a minute |
| `QUEUE_TRAIN_FROZEN` / `QUEUE_LAND_LOCKED` | Captain | finish the repair or the holder first |
| `QUEUE_TRAIN_UNTRUSTED` | Captain | a fork head; rewrite on a crew branch |
| `QUEUE_LAND_UNVERIFIED` | Captain | merged, but main isn't the pin on its parent, or main moved after land's check and `land.merged_checks` failed or is absent on the landed tree: revert the stray change or fix forward, report it |
| `RELEASE_STAMP_INVALID` | Captain | the `release/<version>` head is more than its stamp: close it, `gstack-release-stamp open` again |
| `RELEASE_STAMP_EMPTY` | Captain | no fragment landed since the last release: nothing to release |

## Merge trains

gstack's queue tool drives trains when the repository's `.gstack/ship-policy.json` carries
a `train` block ([ship-policy.md](../../docs/ship-policy.md#run-a-merge-train)). The controller's
loop, per train:

1. `train build --prs <pins> --dry-run`, then without `--dry-run`: the record, the train
   branch, free tests, one full gate.
2. `train verdict`: GREEN (with `FLAKY N` when an in-run rerun turned a case green), RED
   (cases that failed twice), or INCOMPLETE (never green).
3. Per slot, in order: the [slot call](../../captain/templates/slot-call.md) to the lane; the
   lane stamps and pushes only the base merge and the stamp files; `verify --train`;
   `gh pr merge --match-head-commit`; `verify --train` again.
4. `train prune` when every slot has merged.

Under `changelog_fragments` ([ship-policy.md](../../docs/ship-policy.md#train-land)) lanes READY with a
fragment (`changelog.d/<slug>.md`) instead of an `[Unreleased]` section, there is no slot
call and no lane stamp, and step 3 is one command per slot: `train land --train <nonce> --pr
<n>` commits the stamped prefix S_i on [pin, main], pushes it, waits for checks, merges and
confirms main is S_i exactly. Outside a train, `gstack-ship-queue land --pr <n>` is the same
step for one PR ([ship-policy.md](../../docs/ship-policy.md#land)).

A red train: `train bisect` on the red cases over every prefix. An attributed PR leaves
the train and goes back to its lane; red on the base branch itself is fixed forward
through an urgent one-PR train (or `train build --repair` while the queue is frozen, which
refuses `--urgent`); all prefixes green earns exactly one unchanged rebuild;
anything else goes to a repair lane. An infra-only census earns one re-dispatch. A
backstop gate runs on every push to the base branch and freezes the queue when it finds
a tree no green train covered; one repair PR at its exact head clears the freeze. A
policy with a `release_gate` block swaps that per-push backstop for one full gate on main
every 8 hours, whose red verdict holds the stable release instead of freezing the queue
([ship-policy.md#release-gate](../../docs/ship-policy.md#release-gate)).

**Wave PRs when the queue is long.** Every slot pays its own
stamp, its own round of required checks and its own version, one after another. When more
than 6 PRs are READY, `gstack-ship-queue wave plan` prints `WAVE_ADVISED` and suggested
area groups of 3 to 6 (`train build` prints the same line when handed more than 6 pins). The
controller asks the owner of each group's largest PR to integrate: `wave build` makes the
wave branch with every constituent merged unchanged, the integrator runs /ship once and
READYs the wave PR, which then takes one slot and one version. Constituent heads are frozen
once in; fixes go through the integrator, and a constituent that must change is dropped
(`wave build --wave <nonce> --drop <pr>`) and goes back to its owner. After the wave lands,
`wave settle` closes each constituent with a link. While the queue stays long, start new
work as area waves. The full flow is in [ship-policy.md](../../docs/ship-policy.md#wave-prs).

**One open queue PR per lane.** A lane has at most one open PR in the queue at a time. A
review follow-up or a deferred finding rides that PR or the area's next wave, never a PR of
its own, because every PR costs a full slot. Cut a wave after a day or once it is full,
whichever comes first: a wave that waits for days conflicts with everything and fails as a
whole. Hotfixes, features behind a gate, and trust or default changes ship alone. The lane
rule holds under `merge: direct` too. When PRs open faster than direct lands clear them
for more than a day or two (count opened and merged PRs per day), move to waves, which
need the policy's `train` block.

**Slot 2 and later.** The base branch already carries the earlier slots' stamps, so a
stamp on the bare pin leaves the PR conflicting on the CHANGELOG. The lane merges the base
into its pin first (expect a CHANGELOG-only conflict; resolve it with `mergeChangelogs`
from `lib/changelog-check.ts`, the `bun -e` one-liner in
[ship-policy.md](../../docs/ship-policy.md#run-a-merge-train), never by hand, and grep for conflict
markers before stamping), then restamps (the restamp stages the stamp files it wrote,
so a plain `git commit` after a `--no-commit` merge keeps them), then commits only the
merge and the stamp files. In practice slot 1 needs the same merge whenever the base moved after the pin was
taken. A stamp commit with one extra byte freezes the queue for every
lane behind it.

The slot stamp is the base merge, `mergeChangelogs`, and the stamp files the slot call
names (`STAMP_FILES` in CREW.md; gstack's are `CHANGELOG.md`, `VERSION`, `package.json` and
`agents-digest/gstack-AGENTS.md`, plus the file carrying a `*_KEY_VERSION` the PR
introduced, which the restamp moves on the PR's own line, when the call names it), never a
fifth: a file the restamp lists that the call did not name is not a stamp, so the lane
leaves it out and says so in its READY. The restamp itself never
moves a line the base added since the pin's fork point, base merge committed or staged. A
pin stacked on a PR that squash-merged earlier conflicts beyond the CHANGELOG where the
parent's squash touched the pin's lines, so the lane takes its pin's bytes for those files
(`verify` checks the tree against T<i>, which already carries the parent), and
`mergeChangelogs` carries the pin's edits to the parent's now-released entry as Gate
integrity corrections in the pin's own entry. The post-merge `verify` judges the CHANGELOG
by the same rule the pre-merge one did, so an accepted head never freezes the queue after
its merge ([ship-policy.md](../../docs/ship-policy.md#run-a-merge-train)).

Options the controller writes into CREW.md rather than inheriting: squash versus merge
commits; lane stamps versus controller stamps; gate-ahead (slot i+1 gates on slot i's
head while i merges); the severe race (several severe lanes told at once that the next
urgent train is theirs, first complete READY takes it; never a race for a slot inside a
built train); whether a READY also carries a gate run id and tree hash.

### Merge trains for other repos

A repository without gstack's eval workflow declares `gates` in its train block
([ship-policy.md](../../docs/ship-policy.md#train-gates)): its own CI workflows, a test
command on a Ubicloud VM, or both. Every prefix is gated, so a red train names
its culprit with no bisect and no rebuild. To turn one on, run `train init` in
a checkout, commit the printed block (and the workflow snippet) on the base
branch through a PR, then run `train doctor` until it reports no findings.

The controller's loop shortens to `train build --prs <pins>`, then
`train watch --train <nonce> --land`, which waits for every prefix run, reads
the verdict and lands each landable slot in order. Lanes READY with
`ready --pr <n> --no-screen`; there is no screen and no slot call. A lane whose
/ship paused on a red base READYs with `--base-red --fixer <pr>`, its fixer with
`--fixes-base-red <cases>`, and the train seats the fixer at slot 1. The `update` commit `train land` pushes to a PR
branch (the gated tree on [pin, main]) is the one exception to CREW rule 14's "never merge
the base into a PR": it is tool-made, recorded before the push, and pushed under the pin's
lease, like a stamped train's stamp commit. A peer crew
adopting this starts from
[captain/templates/merge-train-peer.md](../../captain/templates/merge-train-peer.md).

## Approvals: three shapes

**A. The record.** Every lane keeps an `## Approvals` table in its report and PR body,
rendered by `gstack-approvals render`: date, what was asked, the owner's exact words, who
relayed them, what the answer covers, what is pending. Standing approvals are cited with
their rule; a fresh ask is always needed for a product or behaviour decision, spend over
a cap, anything published outside the repository, a threshold, budget, trial-count or
case-kind change, closing a contribution without landing it, and anything destructive.
Standing spend is the commonest standing approval: `SPEND` in CREW.md names what the
owner pre-approved (train gates, screens, bisects, the backstop, focused paid cases) with
the owner's date and words and the cap per rerun; anything over the cap is a fresh ask.

**B. The plan ask** ([template](../../captain/templates/plan-ask.md)): before → after, why it
matters, what caused this work, the big decisions, and what we need from you in the ask
format below, closed by "do it", which takes every recommendation at full scope.
`gstack-owner-brief render --captain --captain-name "<Captain name>"` prints it from an
autoplan run.

**C. The merge ask** ([template](../../captain/templates/merge-ask.md)): captioned
before/after images, why, blast radius, the Approvals table, and the evidence. /ship writes the PR
body in this shape on Capy; the controller's merge report shows the key image inline.

## The ask format

Every ask to the owner, from a plan gate to a merge question to the digest, is written so a
five-year-old could follow it: the Captain's name, then one lettered line per decision, with
letters unique across the list.

```text
<Captain name>
- A: <code> hit problem <p>, which happens when <h>. We could fix it in these ways: 1) <x>; 2) <y>; 3) <z>. Recommendation: <x> because <why>. A1 to take recommendation.
- B: …
```

The recommendation is always option 1. "do it" takes every recommendation in the last
list; a named option ("A2") takes that option instead. `<code>` is the issue, PR or thread
the decision is about. An ask that cannot be put this way is not ready to send.

**When the owner has to do something** (create a token, approve a deployment, accept an
invite, change a setting), the line carries the exact link to the page where it happens, a
full URL and never a menu path like "Settings → Tokens", then numbered steps in the
simplest words: what to click, what to type, what to name it, and the one word to reply
when it is done. A page inside the Capy app is the one exception, because it has no stable
link: name the exact path and field instead ("Settings → Integrations → Slack, the Channel
field").

```text
<Captain name>
- A: <code> needs you to <action>, because <why>. Open <exact URL>, then:
  1. Click <button>.
  2. Type <value> in <field> and name it <name>.
  3. Reply **done**.
```

## The digest

`DIGEST.md` is rewritten every controller turn: **Needs you** (decisions only the owner
can make, in [the ask format](#the-ask-format); empty is the goal), **New** (what landed or
changed, newest first), **In progress** (every lane, what it owns, its state, the age of
its last report). Ages turn stalls into the controller's next action. When the controller
archives a thread, it drops that thread from **In progress** in the same turn.

## The daily flaky pass

A scheduled automation starts one lane a day with the
[flaky-pass prompt](../../captain/templates/automation-flaky-pass.md). It reads the gate
runs' flake-records artifacts and the free suites' retried cases, writes one ledger line
per event, groups by case, and fixes the worst repeat first with a PR that shows the
failure red before green. It never reruns a gate and never touches a threshold, trial
count or case kind. Where a repository runs `gstack-flaky`, the lane also reads
`gstack-flaky quarantine report --ledger <downloaded ledgers>` and fixes expiring quarantine
entries before anything else ([flaky.md](../../docs/flaky.md#the-daily-flaky-pass)). On Capy, create it with the automation tool, scheduled in the owner's
timezone, running as a thread in the crew so its report lands in `reports/`.

The lane's side of the same rule: in CI the gate reruns a case that failed on its own
verdict once, in the same run ([TESTING_INTERNALS.md](../../docs/TESTING_INTERNALS.md#flaky-reruns));
a pass is green with `FLAKY N`, and a case that failed twice is a real red that nobody
reruns by hand. In a lane's own focused paid runs it reruns only the failed case, once, at
the same tree: a pass goes into the ledger (case, PR, head, both runs, a one-line symptom)
and is named in the READY; a second failure is real. A harness, infra or incomplete red is
never a flake. One named failure from `KNOWN_INFRA_FLAKES` may be rerun once per PR and
is stated in the READY. A red train is the controller's (bisect, rebuild once), and every
rerun reports its spend.

## The owner's device

Some actions exist only in the owner's logged-in browser or on the owner's machine:
approving a deployment review, switching the GitHub account a run used, a local-only
build. A lane that needs one asks the controller; the controller does it through the
owner's device (on Capy, a paired device and the owner's browser) and records what it
did. Before approving a deployment, check the run's pending deployments list; approve
only the run the lane named.

## The lessons loop

Every report ends with one Lesson. The controller reads lessons before chat, and each
one becomes a rule in CREW.md, a line in AGENTS.md, or a tool fix as one issue with an owner;
nothing stays a lesson for long. Rules carry the thread that produced them, so a new lane
can read the incident behind the rule.

A revert or an S1 fix of a merged crew PR gets a postmortem as well as a lesson. The
controller starts it when the fix's brief goes out, from the
[postmortem template](../../captain/templates/postmortem.md), saves it as
`reports/postmortem-<n>.md` and links it from the fixing PR. Its root cause section asks
why the lane and every reviewer believed the change was right, and it is answered from the
review outputs, receipts, decision trail and approvals, not the diff. Each rule change it
names ships as a gstack PR, because gstack holds the how; a rule kept only in a crew file
is a gap.

When the owner states a rule meant for every Captain, forward it in the same turn to the
thread that keeps the account's shared rules, so every crew gets it.

## Setting it up on Capy

1. Create the Captain and give it the drive layout above; paste the filled `CREW.md`
   and an empty `DIGEST.md`.
2. Add the `train` block to the repository's `.gstack/ship-policy.json` and name the
   same check names in `CREW.md`.
3. Install the gstack Capy skill in the owner's user scope so every thread runs the
   session-start check ([capy-install.md](../../docs/capy-install.md)).
4. Create the daily flaky-pass automation.
5. Start lanes with the [brief](../../captain/templates/brief.md): the files they own, the
   rules file, whether a plan is required, and the READY contract. Read their reports
   before their chat.
