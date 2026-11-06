# Brief

Sent by the controller when a lane starts, and again when a lane takes on scope its brief
did not name. The lane reads the rules file first, then this. Everything in angle brackets
is filled by the controller; `Plan:` says whether the lane plans first
(`docs/captain.md`, Plan before build).

```text
Lane: <thread code> · Controller: <CONTROLLER> · Rules: <drive>/CREW.md · Base: <BASE>
Owns: <the files and directories this lane may edit; everything else is routed through the controller>
Do not touch: <files other live lanes own, each with its lane>
Plan: required | approved: <autoplan run dir, or its checkpoint dir> | exempt: <reason from the exemption list>
Spend cap: <focused paid runs per PR, from SPEND>
Read: <the files and sections this lane needs, by path; the brief names them, never pastes them>
Context: after the install check, read the gstack skill's lane-card.md (the checkout's
   capy/skill/gstack/lane-card.md when the skill copy lacks it), not its whole SKILL.md.
   Batch independent reads in one parallel program; return 4k characters or less per call and
   send long output to files under ~/.capy/work. A wait under about 30 minutes checks in every
   240 s (wait on the operation with duration_seconds 240, then a silent re-wait, for about 30
   minutes at most); longer waits sleep on their operations, and so does the lane while /ship runs. Past twice the median lane spend, write handoffs/<code>/next.md and
   tell me in one line (docs/captain.md, Lane context).

1. Plan (when Plan: required). After the session-start install check, install for autoplan
   and follow autoplan/DRIVER.md "On Capy" (launch file sourced, GSTACK_AUTOPLAN_CHECKPOINT_DIR
   set, run dir under ~/.capy/work). Write the plan with its ## ELI5, ## Before → after,
   ## Why it matters, ## What caused this work, ## Big decisions and ## Implementation plan
   sections, then run gstack-autoplan next --out <run dir> --plan <plan.md> <scope flags>
   sized to this brief (a feature: --kind feature, the lean run with one reviewer over
   the plan and the draft code; a bug fix needs no plan run: Plan: exempt: bug fix (R65)).
   At the gate send me the output of
   gstack-owner-brief render --captain --out <run dir> whole, as a needs-you report.
   Build nothing yet.
2. Build after the word. I bring the owner's exact words back. Answer them into the run
   (gstack-autoplan answer --out <run dir> --gate-rev <n> --reply <tokens> --rec-hash <h>
   --by agent:<your thread> --owner-reply "<their words>"), incorporate every accepted plan
   change (revise), finish every reopened phase, and start product edits only when the run
   reports APPROVED (a later gate that asks nothing new prints CARRIED: and needs no second
   ask). Then gstack-approvals import --autoplan <run dir> --by "<owner>" (--stack b1,b2 for a stack).
   New scope you take on part-way goes back to step 1 with its own plan.
3. Ship. CHANGELOG entry under [Unreleased]; GUARD_CHECKS, pregate and /ship at the final
   head; one unstamped READY block (captain/templates/READY.md) to me; the PR body carries
   gstack-approvals render. Never merge; stamp only on my slot call.
   After dispatching /ship, end your turn; wake only on /ship's completion, holding no PR
   watch meanwhile (cancel one you hold; a red check during /ship waits for it to finish).
   /ship owns the receipt and the PREGATE line. On that wake you subscribe to the PR, read
   its checks and comments once, stop the /ship subagent, run gstack-ship-queue ready
   --pr <n> --pregate <pregate.json> --screen|--no-screen at the pin (its notes on origin),
   audit your decision trail, write Attention and send READY; after READY, handle PR events
   as usual (docs/captain.md, the lane's /ship sequence).

Done when: the READY block is sent at a frozen head, reports/<thread code>.md is written,
and its Approvals table carries the plan approval row (the owner's words, the date) or the
Plan: exempt reason.
```

A lane whose brief says `approved: <dir>` starts at step 2 with that run (restore it with
`gstack-autoplan resume --out <new dir> --from <its checkpoint dir>` when it lives on another machine); a
lane whose brief says `exempt:` starts at step 3. A brief with no `Plan:` line reads as
`Plan: required`.
