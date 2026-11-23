# Write it up before you shelve it

When we try something and it doesn't work out, we write down what happened before we
put it away. That covers any attempt closed as failed, shelved, cut, null or not now: an
experiment, an eval arm, a prototype, a PR we drop, a tool we stop using. The write-up
is short, it exists before the close, and the close (the issue, the PR, the report, the
eval verdict) links to it.

Garry Tan, 2026-11-23: "when we try things and fail we must document it before we shelve.
Remember this. Make it a gstack directive that is our default thing we do."

Why: a failed attempt is paid-for knowledge. Without a write-up the next person retries
the same thing, or never learns which part worked. A page of notes costs minutes; a
repeated experiment costs days.

Where it goes: beside the project's other findings (an eval's results file, a research
findings folder, or `docs/` in the repo), with one line in that folder's index when it
has one. An eval's results file already is the write-up when it carries these sections.

## Template

Keep each section to a few lines. Lead with what helps the reader, put mechanics last,
and never round a number in our favor.

```markdown
# <What we tried>: <one-line outcome>. Shelved.

status: <failed | shelved | cut | null | not now> on <date>, by <who decided>

## Takeaways
<two or three lines: "We learned X. You should do Y.">

## What we tried, and why
<the question, the setup and the versions every number below was measured on>

## What worked
<parts worth keeping, each with its number>

## What didn't
<each failure with its number and how far it was checked (one run, a full pass, a guess)>

## Why it's shelved
<the deciding reason, and the verdict if a rule asked for one (KEEP, FIX-METHOD, CUT-CANDIDATE)>

## What would reopen it
<concrete conditions, each checkable>

## Where the data and scripts are
<paths or links to results, scripts, datasets and checkpoints, and anything still left running>

## Not done, and unverified
<steps skipped and claims nobody checked>

## What went wrong on our side
<mistakes, wasted spend, wrong turns; "none" if none>

## Cost
<paid spend and meter spend, by provider>
```

## The close

The issue, PR or report that closes the attempt links the write-up in its close reason
(`Shelved: <link>`). Before a Captain archives a crew thread, `gstack-archive-check thread`
prints a `NOTE:` line for each of its PRs that closed without merging, as a reminder to
link the write-up when that close was a shelve.
