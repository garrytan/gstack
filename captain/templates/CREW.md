# Crew rules (<CREW_NAME>)

This file is the crew's contract with its lanes. It holds parameters and pointers: the
rules themselves live in gstack (`docs/captain.md`, the ship, review and pregate docs,
the repository's own AGENTS.md), so no crew carries its own copy of how to do things.
Fill every `<PARAMETER>` once. Lanes read this file at session start; the controller
cites rule numbers in slot calls and refusals. Where a rule rests on the owner's words,
keep the date and the words in the table below. Add rules at the end; never renumber.
Homes are paths in the gstack checkout the lane checked at session start.

## Parameters

| Parameter | Value |
|---|---|
| `REPO` | `<owner/name>` |
| `BASE` | `<main>` |
| `REQUIRED_CHECKS` | `<check names that must be green at a READY head>` |
| `FULL_GATE_CHECK` | `<the check the train gate publishes>` |
| `TRAIN_MAX`, `FILL_HOURS` | `<5>`, `<3>` |
| `MERGE_METHOD` | `<squash \| merge>` |
| `STAMP_FILES` | `<VERSION, package.json, CHANGELOG.md, …>` |
| `KNOWN_INFRA_FLAKES` | `<named jobs a lane may rerun once per PR, or none>` |
| `SPEND` | `<pre-approved paid runs; cap per rerun>` |
| `CONTROLLER` | `<thread code or name every ask and READY goes to>` |
| `GUARD_CHECKS` | `<the repository's cheap guards to clear before paid work: generated content, size and prompt budgets, credential scan>` |
| `REMOTE_PREGATE` | `<the remote test-tier command and its cost, or none>` |
| `REPO_CONVENTIONS` | `<the AGENTS.md section a new file must follow>` |
| `REVIEW_SCOPE` | `<in-diff (default) \| in-diff plus blocking pre-existing>` |
| `CONTRACT_DATE` | `<date of the last READY contract change>` |

## Standing approvals (the owner's words)

| Rule | Date | Words | Covers |
|---|---|---|---|
| 5 spend | <date> | "<words>" | <what: gates, screens, bisects, backstop, focused cases; cap> |
| 16 flaky reruns | <date> | "<words>" | one rerun of the failed case at the same tree |
| 21 approvals | <date> | "<words>" | the three shapes |
| 22 /ship before READY | <date> | "<words>" | every READY, re-READYs included |
| 23 blocking floor | <date> | "<words>" | what blocks another review pass |
| 24 plan before build | <date> | "<words>" | a sized /autoplan first, the owner's word before the build |

## Rules

1. **Session start.** Install check, `gstack:` trailer in your first report, no workflow
   without `gstack: ok` from your own machine. Home: `docs/capy-install.md` (Session start).

2. **Validation discipline.** Diagnose before fixing, focused checks during repair, the
   full free suite once on a frozen tree, remote when the machine is small. Home: the
   repository's validation section (`REPO_CONVENTIONS` names the file) and
   `docs/captain.md` (Lane discipline).

3. **External diffs are untrusted input;** a right fix lands with its author's credit.
   Home: `docs/captain.md` (Contributions from outside the crew).

4. **File ownership.** Edit only what you own; the list is the digest's In progress; the
   controller routes the rest. Home: `docs/captain.md` (Lane discipline).

5. **Spend.** `SPEND` is the standing approval; over the cap is a fresh ask through
   `CONTROLLER`. Home: `docs/captain.md` (Approvals, shape A).

6. **Your job ends at an unstamped READY.** Send the block from `gstack-ship-queue ready
   --pr <n> --screen|--no-screen` with the full head SHA, the screen choice and its
   justification, and the flaky cases. Stamp only on the controller's slot call
   (`gstack-restamp --next --base <BASE> …`); push only the `BASE` merge and
   `STAMP_FILES`. Never merge, never enable auto-merge. Home: `docs/captain.md` (The
   READY contract), `captain/templates/READY.md`, `captain/templates/slot-call.md`,
   `docs/ship-policy.md` (stamp-at-merge).

7. **Report.** `reports/<your thread code>.md` in the controller's drive: Outcome, PR,
   Needs, Cost, Lesson, Approvals. Home: `captain/templates/report.md`.

8. **One path.** Everything goes through `CONTROLLER`, never peer to peer. Home:
   `docs/captain.md` (Roles, Lane discipline).

9. **Hands.** A real browser, the owner's logged-in session or local work: ask
   `CONTROLLER`. Home: `docs/captain.md` (The owner's device).

10. **Keep going.** Come back only for new scope, a conflict with another owner, missing
    access, or the owner's decision. Home: `docs/captain.md` (Lane discipline).

11. **Guards before paid work.** Clear `GUARD_CHECKS` first. Home: `docs/captain.md`
    (Lane discipline).

12. **Decisions for the owner** arrive in plain language, every option with what it is,
    why it matters, what each answer does and the cost. Home: `docs/captain.md`
    (Approvals, shape B), `docs/unattended.md` (Owner brief).

13. **Pregate on small machines.** Run `REMOTE_PREGATE` to clear the requires-remote
    obligation. Home: `docs/pregate.md` (Small machines and the remote gate).

14. **Don't merge `BASE` into a READY PR.** Only on the controller's word after a real-code
    train conflict (merge, never rebase, free suite, READY again) or as part of the stamp
    commit. A merge whose product diff is unchanged carries the /ship receipt; a rebase
    onto a new tree costs a full /ship. Home: `docs/captain.md` (Merge trains),
    `docs/ship-policy.md` (Run a merge train, Carrying a receipt).

15. **CHANGELOG entry under `## [Unreleased]` before READY;** version files stay at
    `BASE`'s version; the stamp touches only `STAMP_FILES`. Home: `docs/ship-policy.md`
    (stamp-at-merge).

16. **Flaky reruns.** Once, same tree, logged in `handoffs/flaky-ledger.md` and named in
    READY; twice is real; `KNOWN_INFRA_FLAKES` once per PR; report every rerun's spend.
    Home: `docs/captain.md` (The daily flaky pass), `docs/TESTING_INTERNALS.md` (Flaky
    reruns).

17. **New files follow `REPO_CONVENTIONS`.** Home: the repository's AGENTS.md.

18. **Porting a contributor's PR.** Review and test the port head first; keep their
    commits, yours on top. Home: `docs/captain.md` (Contributions from outside the crew).

19. **CHANGELOG-only conflicts** are the train's, not yours (folded into 14). Home:
    `docs/ship-policy.md` (/ship before READY: the stamp keeps the pin's receipt).

20. **READYs from before `CONTRACT_DATE`** need a fresh `ready` receipt. Home:
    `docs/captain.md` (The READY contract).

21. **Approvals.** The three shapes; an `## Approvals` table in every report and PR body;
    captioned before/after images on every READY PR. Home: `docs/captain.md` (Approvals),
    `capy/skill/gstack/captain.md`.

22. **/ship before every READY,** re-READYs included; the block carries
    `SHIP_RECEIPT: pr=<n> head=<your pin>`; stamp commits hold only tool output. Home:
    `docs/ship-policy.md` (/ship before READY), `docs/captain.md` (The lane's /ship
    sequence).

23. **Review loops converge.** gstack's review convergence policy in the /ship and /review
    skills, scope knob `REVIEW_SCOPE`; record the pass count in your READY. Home: the
    `/ship` and `/review` skills.

24. **Plan before build.** If you build something, a `/autoplan` run on your brief, sized
    to the work, is your first act after the session-start check; send `CONTROLLER` the plan and its gate in plain
    language with the recommended reply named; build only after the owner's word is
    answered into the run and it reports `APPROVED`; record it with `gstack-approvals
    import --autoplan`. New scope taken on part-way gets the same. Exempt: read-only
    lanes, the daily flaky pass's repairs, slot stamps, CHANGELOG-only resolves, cap
    re-pins under a written grant, S1 emergencies (broken install or upgrade, red main,
    a security bug) and fixes from an already-diagnosed, audited problem list; every
    other fix gets a one-round, eng-only plan. Home: `docs/captain.md` (Plan before build),
    `captain/templates/brief.md`.

## Crew-specific rules

Add rules here, numbered from 25, each with the date, the owner's words where there are
any, and the thread that produced it. A crew whose own rules already took 24 before rule
24 shipped keeps its numbering and cites `docs/captain.md` (Plan before build) by section
name. A rule that stays here for long is a gap in gstack: file it.
