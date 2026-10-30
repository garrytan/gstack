# Working under a Captain: approvals, plan asks and merge asks

This file belongs to gstack's Capy skill (the folder the owner copies into their Drive). It describes how a
Capy thread running gstack asks for decisions, records answers and asks for a merge. The rules apply whether
the thread reports to a Captain (a crew thread) or straight to a person. `gstack-skill-start` prints the
short form as the `capy-asks` block whenever `GSTACK_CAPY=1` (the Capy launch line sets it).
`GSTACK_CAPY_ASKS=0` drops that block for one session. This is the lane's side. The controller's side (the
READY contract, merge trains, the digest, the daily flaky pass, and the templates for the crew rules file
and the Captain's drive) is the `/captain` skill and `docs/captain.md` in the gstack checkout.

## 1. How approvals work, per thread

- **One path.** A crew thread asks its Captain: a needs-you report through Capy's agent channel, never a
  question to the person. The Captain relays it in plain language and sends back the person's exact words.
  A thread with no Captain asks the person directly with a Capy question. Either way, never use a bare
  question, gate codes or slot numbers.
- **Scope.** An answer covers the thread and scope it was asked for. It is not a blanket approval for
  later work.
- **Standing approvals** are the ones the Captain lists in its own rules, for example "merge when green,
  through a merge train", "paid eval gates are pre-approved" or "a single-case flaky rerun". Cite the rule
  (with its date and words) instead of asking again. gstack ships no standing approvals of its own.
- **Always a fresh ask:**
  - a product or behaviour decision;
  - spend over a stated cap;
  - anything published outside the repository (advisories, releases, posts);
  - a change to a threshold, budget, trial count or test kind;
  - closing someone's contribution without landing it;
  - anything destructive or irreversible.
- **Observable questions are not the person's to answer.** A question a command, a render or a measurement
  can settle locally, read-only and for free ("is the new path faster", "does the test endpoint take this
  payload", "does the test still fail") is settled by the thread: it runs the thing and reports the result.
  A call that changes state, reaches a live system or spends money is still an ask. Only a product or preference call
  goes up, with the observation already made. A Captain that receives an observable question sends it
  back with the check that answers it instead of relaying it.
- **What a gstack workflow does in Capy.** Launched with `GSTACK_SESSION_KIND=unattended`, a workflow takes
  each recommended option, writes everything else as a pending gate item, and stops. Your job is to carry
  those pending items to the Captain or person in the shape below, then feed the answer back.

## 2. The approval record

Every answer gets a row: the date, what was asked, the person's exact words, who said them (and who relayed
them), what the answer covers, what is still pending, and the outcome (approved, rejected, pending, or a
cited standing approval).

```bash
gstack-approvals add --ask "Spend up to \$40 on a paid eval rerun for the ship cases" \
  --words "yes go" --by "Garry (via GStack Minder)" --scope "one rerun of the 6 ship cases, cap \$40"
gstack-approvals add --outcome standing --ask "Merge #3330 when green" \
  --words "yes merge when green" --by "Garry, 2026-10-16 (Captain rule)" --scope "every crew PR, through a train"
gstack-approvals import --autoplan <run dir> --by Garry   # after gstack-autoplan answer; idempotent
gstack-approvals import --autoplan <run dir> --by Garry --stack b1,b2   # a stacked PR set: every branch, or none
gstack-approvals render                                    # the ## Approvals section
```

- **Where it lives.** `<state root>/projects/<slug>/approvals/<branch key>.jsonl`, one file per branch,
  because one thread ships one branch. On Capy the state root is thrown away with the machine, so every write
  is also mirrored to `GSTACK_APPROVALS_DIR`, else to the `approvals/` directory in the mounted Captain
  drive (`<captain drive>/approvals/<slug>/`, readable by the whole crew), else to the private project-user
  Drive folder. `gstack-approvals path` prints the chosen mirror and `READ_ALSO:` roots, which reads still
  merge. `GSTACK_APPROVALS_MIRROR=0` turns the mirror off, and `gstack-approvals sync` restores the local copy.
- **The durable copies** are the `## Approvals` sections in the thread's report and in the PR body. Paste
  `render` output into them; never type rows by hand.
- **Secret-free.** Every field passes gstack's secret scanner before it is written. A hit refuses the row
  (`APPROVAL_RECORD_SECRET`, which names the field and rule, never the text). Write `[redacted]` in place of
  the secret, or ask the person to restate.
- **Display only.** The rendered table escapes mentions, links, images, HTML and anything shaped like an
  `Approved by … via …` citation. gstack's enforced approval classes still need their own citation line
  (docs/ship-policy.md#approval-classes).
- An empty table means "No approvals recorded". On a fresh Capy machine with no record and no mirror it says
  "Record unavailable" instead (`APPROVAL_RECORD_UNAVAILABLE`), because a lost record is not an empty one.

## 3. Plan approvals: the shape

Under a Captain, a thread that builds something plans before any product code. A `/autoplan` run on its
brief, sized to the work, is its first act, the gate goes up in the shape below, and the build starts only
when the answer is in the run and it reports `APPROVED`. The short form every Capy thread follows, with the
exempt work (read-only threads, flaky-pass repairs, slot stamps, CHANGELOG resolves, cap re-pins under a
grant), is the "Plan, approve, ship" section of SKILL.md in this folder; the rule in full is `docs/captain.md`,
Plan before build.

Every plan or gate you bring for approval has these parts, in this order, written so someone outside the
project can follow it:

1. **Before → after.** What the user or maintainer sees today and after, with concrete examples: a command
   and its output, a screen, a cost or time number.
2. **Why it matters.** Who is hurt today and how much, with numbers where possible.
3. **What caused this work.** The trigger: an issue or PR link, a failed run, a user report, or the
   person's request, quoted.
4. **Big decisions.** For each: the options considered, the pick and why, and what would flip it.
5. **What we need from you.** One decision, the options and their costs, the pick, and the one-word reply.
   The recommended reply is the default (`rec` for an autoplan gate). Never offer "the plan as first
   written" as the default.
6. **"do it".** Every ask ends with a "do it" reply: take every recommendation at full scope, the follow-ons
   the plan names (docs, trains, cleanups) included, and carry them through to done with no further ask.
   Say in one line what it covers. For an autoplan gate, "do it" answers as `rec`; record the words.

For an autoplan run, open the plan with `## ELI5` (5-10 plain sentences), then write parts 1 to 4 as
`## Before → after`, `## Why it matters`, `## What caused this work` and `## Big decisions` sections. Then, at the gate:

```bash
gstack-owner-brief render --captain --out <run dir>
```

It prints a header line ("Decision needed … Reply **rec** …"), the `### ELI5` summary (on a run whose gate
carries `eli5`), the four plan sections (each capped, with a pointer to the plan for the rest), and "What we need from you", which lists every choice `rec` takes, in
words, and closes with the "do it" reply, then a `### Cost` section (spent so far, worst case, and the estimate for
the phases `rec` can reopen). The last line, "For the relaying agent", carries the run, `gate_rev`, `rec_hash` and the exact
`gstack-autoplan answer` command. Relay everything above that line. When the reply comes back:

```bash
gstack-autoplan answer --out <run dir> --gate-rev <n> --reply rec --rec-hash <h> \
  --by agent:<your thread> --owner-reply "<their exact words>"
gstack-approvals import --autoplan <run dir> --by <name>
```

A later gate that asks nothing new is answered for you with the words you recorded (`CARRIED:`, then `APPROVED:`);
the brief says "Nothing pending. Carried forward", so import and build without a second ask. `CARRY_CHECK:` means
one reviewer from another model family reads the unreviewed delta first (`gstack-autoplan check`). Anything
else prints `CARRY: no (<why>)` and goes to the person as today (`docs/unattended.md#carry-forward`).

If the person answers in words ("split it into two PRs"), map the words to tokens, answer, and confirm in one
line what you recorded ("Recorded: split into two PRs; everything else as recommended"). A plan missing a
section renders "Not ready for approval" with no reply invitation, and exits 1 (`CAPTAIN_BRIEF_INCOMPLETE`):
add the sections, run `gstack-autoplan revise --plan <file>`, and render again. For a decision that is not an
autoplan gate, write the same five parts by hand.

## 4. Merge asks: the shape

Every PR you send READY on, and the READY report itself, has:

1. **What changed.** One to three before/after images, highest-signal first, each with a one-line caption
   (what changed and why) and a collapsed text version under it.
   - UI: screenshots at the base and on the branch, the same size.
   - Skill or prompt: `gstack-pr-shots --path <file> --heading "<section>" --caption "<…>"`.
   - CLI: `gstack-pr-shots --before <capture> --after <capture> --kind terminal --caption "<…>"`, where the
     captures are files inside the repository.
   - Internal: the source section or test output that best shows the change.
   `gstack-pr-shots` reads text only, runs nothing, refuses secret-matching input, and prints `SHOT_PNG:`.
   With no browser that line says `unavailable`: screenshot the printed `shot.html` with your own browser.
   Upload each PNG with Capy's PR asset tool (`tools.pr.uploadAsset`), only for public repositories, and embed
   the URL it returns with the caption as alt text.
2. **Why.** The problem in the person's words first, then the cause and the effect the user will see,
   in two or three sentences.
3. **Blast radius.** What else the change touches and the one fact that makes that safe, with the
   evidence-ladder rung that fact reached.
4. **Approvals.** `gstack-approvals render`.
5. **Evidence.** Checks green at the head, gate or train results, flaky cases.

The READY report attaches the key image (Capy message attachment), so the Captain can show it inline.
/ship does all of this when `GSTACK_CAPY=1` (its `capy-pr` section). Outside Capy, the PR body is unchanged.

A token cap in a brief goes to /ship as `--token-cap <n>`. When /ship stops on it (`STOP:
reason=budget_exhausted`, `status=incomplete`), the lane reports the BUDGET and RECOVER lines and asks the
owner; it never raises the cap itself. The owner's answer runs the RECOVER line with
`--approved-by <who> --words "<their words>"`, and `gstack-approvals add` records the same words.
