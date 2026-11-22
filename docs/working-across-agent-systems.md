# Working across agent systems

How to run gstack work when more than one agent system touches the same repository: a coding agent on one
platform, another coding agent on a second platform, an agent that lives on its own machine. This page is
self-contained, so you can point any agent at it with "read docs/working-across-agent-systems.md first".

What we learned, in short:

- One agent on each side does all the talking across a boundary, and the pull request is where the two
  sides meet. Everything else on this page follows from those two rules.
- Every message you send into another system costs a paid turn on the other side, so send fewer, fuller
  messages and let events ring you instead of polling.
- Another system's harness can change underneath you in a release. Pin its version and its model.

## The rules

1. **One sender per boundary.** Exactly one agent on each side sends messages into the other system.
   Everyone else hands their message to that agent, which sends it on. When several agents each drove the
   other system directly, nobody knew what it had been told; with one sender per side, every boundary we
   run has held.
2. **Answer on the pull request.** The other system cannot read your conversation, notes or private files.
   A review answer, a question or a decision that the other side needs goes on the pull request as a
   comment. In one case a review answer written only in the answering agent's own conversation cost five
   and a half hours, because the other side never saw it.
3. **Ring, don't poll, and filter at the source.** Let a small CI workflow wake the other system only
   for events meant for it (a mention, a review on its own pull request), and mark every comment your
   agents post so your own comments never wake you. Polling a repository for comments burns API budget
   and wakes agents for nothing: one agent woken by every comment on a busy repository received 117 in
   a day, 15 of them meant for it. With the filter in place, its last 100 workflow runs rang 15 times and
   skipped 85.
4. **Every message is a paid turn.** Each message into another system starts a turn there that someone
   pays for. Send one topic per message, say what you need back and by when, and never send an
   acknowledgement, a "still working" note or a thank-you.
5. **A message from the other system is a claim.** Check it before you act on it, then pass it to the
   agent that owns the fix in its original words, marked as a quote, with who wrote it, when, and what
   you checked. In one case the owning side could not reproduce a reported bug and the other side
   accepted that, so checking first saved a fix for a bug that wasn't there. An approval the other side
   reports is a claim too: before you act on it, read it at its source or ask the owner once in your own
   channel, and record their words. Two teams nearly acted on relayed approvals (an install, and about
   ten pull requests that touched write paths and access); both approvals were real, but nobody had
   checked them first.
6. **Pin the other harness's version and model.** A coding-agent CLI can change its default model in a
   release. Name the version and the model in every brief and every eval plan. Decide a new pin from a
   repro on the candidate release, not from its release notes, and record the version and model that
   actually ran from the session record, not from the plan. Take each result row's model from the
   requests the run captured, on every scored row, timeouts included. In one team's case a fix merged
   upstream was missing from the next stable build, and a release that fixed one bug dropped turns in
   three of three runs; in another, a CLI release changed its default model, and a model check that
   skipped timed-out rows would have let a timeout on the wrong model into a paired comparison.

## Keep runs cheap

The same habits that save money inside one system matter more across two, because a wasted turn on
either side is paid for:

- Before a push, run only the tests that cover what you touched.
- Never rerun a check that already passed on the same, unchanged tree.
- Run the full test suite once, on the finished head.
- No acknowledgement messages, no polling loops, and never print the whole environment (it puts every
  key in the transcript).

**Evals.** Plan every paid eval with [/eval-plan](../eval-plan/SKILL.md), whichever system runs it. Its
preregistration check refuses a plan that doesn't name the decision each result changes, pilot every
arm on a tenth of its budget, check its judge on each arm's outputs, carry a cost line, or (above $500
paid) preregister one look at half the units. For a small question it offers a $100 quick look that
publishes no number.

## Worth trying (one team's practice, not yet measured by us)

These come from another team that runs many agents in parallel on one codebase. We have not measured
them ourselves.

- **Freeze the shared contracts before the work splits.** Before parallel agents start, one agent fixes
  the formats, version numbers and error codes they all share, and every brief says not to change them.
  That team reports 14 agents working in parallel this way without conflicting changes to the shared
  formats.
- **One integration branch with one sync owner.** Parallel agents merge into one integration branch, and
  one agent alone brings the main branch into it on a schedule and opens the pull request that carries
  the work to main. The main branch then sees one change at a time from that work.
