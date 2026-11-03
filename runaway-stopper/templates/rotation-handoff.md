# Rotation handoff: <code> (<title>)

Written <date> by <code> for its successor, at <commit or PR head>. Keep it under 150 lines: the successor reads
this file, not the old thread.

## Role
What this thread owns and what "done" looks like for the role (one paragraph).

## Open work
| Item | State | Branch / PR / head | Next step |
|---|---|---|---|

No PR here may be mid-/ship or mid-merge; if one is, the rotation waits. The successor subscribes to every open
PR listed here.

## Subagents still running
None, or one row each that you chose not to stop: path, title, run directory, what it is waiting on.

## Rules and numbers in force
Thresholds, bars, budgets and standing approvals the role works under, each with its source (rule number, file, quote).

## Recipes
Commands the successor will run again (test, gate, eval, deploy), copied exactly, with the paths they need.

## Decisions and why
The few choices a newcomer would otherwise reopen, with a pointer to the evidence.

## Lessons
What cost the most last time and how to avoid it.

## Spend
Thread total, own tokens and credits at handoff (`gstack-runaway scan` line), so the successor starts from a known number.
