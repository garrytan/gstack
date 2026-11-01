# Postmortem: #<n> <one-line title>

The controller starts one after any revert or S1 fix of a merged crew PR: when that fix's
brief goes out, or at the latest when its READY arrives. The controller or a lane it names
writes it to `reports/postmortem-<n>.md` in the controller's drive and links it from the
fixing PR's body by that path. A revert records what was wrong with the code; this records
why everyone who passed it believed it was right. Write it from the record, not from memory
and not from the diff alone. Split the reading across read-only subagents when it is long,
and keep each section to a table or one short paragraph.

## What broke

<what the merged change did wrong, in two or three sentences, with the smallest input that
shows it, and the merge commit and version that shipped it>

## How it was found

<who or what noticed it, when, and while doing what; whether any gate, check or reviewer
caught it, or a person or a sibling lane found it by chance>

## Impact

<who was exposed and for how long (merge to fix merge, the versions in between); what is
known to have gone wrong; what may have gone wrong and was not checked, said so>

## Timeline

| Time (UTC) | Event | Source |
|---|---|---|
| <time> | <brief, plan, each review pass, READY, merge, discovery, fix, fix merge> | <PR, thread, trail row or run id> |

## Root cause: why did the lane and every reviewer believe it was right?

Read first, and mark any item `not retained` when it no longer exists:

- the PR body and its ship receipt;
- every review pass, fix-check, outside-voice and targeted-reader output (the run
  directory or the lane's subagent transcripts);
- the lane's decision trail and its READY, Unverified line included;
- the controller's brief, approvals and grants;
- earlier PRs, issues or trail rows that met the same problem.

| Believer | What it was asked | What it checked | What it did not check | Why it passed | Source |
|---|---|---|---|---|---|
| the controller's brief | <the request> | <…> | <…> | <…> | <message> |
| the lane | <the brief> | <its proof and tests> | <the direction it never tested> | <the assumption it held> | <trail row> |
| <each review voice, by pass> | <its brief's question> | <…> | <…> | <its words, quoted> | <output> |
| tests, pregate, CI, paid gate | <what selected them> | <…> | <the fixture that did not exist> | <…> | <run id> |

Quote a believer's recorded reason; label anything else `inferred`. A missing record is a
finding in its own right: say what it would have shown.

<then one paragraph: the belief they shared, where it was written down or seen and set
aside, and whether the knowledge that would have caught it already existed somewhere the
lane did not read>

## What caught it and what should have

<what caught it; then the earliest points that should have, cheapest first: a test, a
review question, a required replay, a brief that cites an earlier ruling. Name the test or
eval that now fails if the change comes back, with its link>

## Playbook or skill change

| Change | Home in gstack | Owner | Status | Effectiveness check |
|---|---|---|---|---|
| <the rule or check> | <file, and the gstack PR or issue> | <lane or controller> | <proposed, PR open, merged> | <what fails or shows up next time> |

A change kept only in a crew file is a gap. When no rule would have caught it, write
`none` and why. The postmortem is done when every row is merged or has an owner.

## Links

- Merged PR: #<n> (<merge sha>, <version>)
- Revert or fix: #<n>
- Issues: <ids>
- Threads and trails: <lane thread, fixing thread, decision trail rows>
