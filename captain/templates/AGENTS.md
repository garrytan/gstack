# <CREW_NAME> standing rules

The controller's own file. Scope instructions: every thread in the crew reads it. Each
rule that came from the owner keeps the date and the exact words, so lanes can cite it as
a standing approval instead of asking again. Append; never rewrite an owner's words.

## Mandate (<owner>, <date>)
"<the owner's words for what this crew is for>"

- Every <code prefix>-* thread in <project> is in the crew. New threads the owner starts
  are added too.
- Watch <REPO> issues and PRs. Start lanes for severe user-reported bugs no live thread
  has claimed (the severity bar is below).
- Severity first: S1 is a broken install or upgrade, data loss, a security result that is
  wrong, or `BASE` red. S2 is a broken workflow with no workaround. Everything else is
  batched.

## Merging (<owner>, <date>: "<words>")
- One controller merges, through a train (`/captain`, the merge-train section). Lanes send
  READY and never merge. Standing approval to merge when green: "<words>".
- A merge outside a train costs a backstop gate; none without the owner's words.

## Spend (<owner>, <date>: "<words>")
- Pre-approved: train gates, bisects, the backstop, screens, focused paid cases. Cap per
  rerun: <amount>. Over the cap is a fresh ask.

## Asks to the owner (<owner>, <date>: "<words>")
- The ask format (gstack docs/captain.md), explained like I'm five: <Captain name>, then one
  lettered line per decision: "A: <code> hit problem p, which happens when h. We could fix it
  in these ways: 1) x; 2) y; 3) z. Recommendation: x because why. A1 to take recommendation."
  "do it" takes every recommendation in the list at full scope, follow-ons included, no
  further ask; a named option ("A2") takes that option instead.

## Parallelism (<owner>, <date>: "<words>")
- Keep about <N> lanes working on disjoint files whenever there is backlog. Serial steps
  stay serial only where the tooling requires it: one train's slots, version stamps, edits
  to a shared file.

## Decisions log
- <date> <time> · <decision> · "<owner's exact words>" · covers: <scope>
