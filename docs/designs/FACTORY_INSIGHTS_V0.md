# Design: Factory Insights — the factory's read-only meta loop

Drafted via /grill-with-docs on 2026-10-25 (deep research pass: AIE Talks "Software
Factories" pack, Anthropic harness papers, Codex skills docs, OpenCode agent docs,
pi design retrospective)
Repo: gstack
Status: IMPLEMENTED as ticket 01 + ticket 02 (core report; sparse-data
widening and /learn suggestions). Implementation gated on approval of v1 of
this doc.

## Problem Statement

gstack collects per-project feedback signals but nothing reads them back into a
decision. Every Clarification the user had to answer, every Routing correction,
every Feedback Loop event is appended to the project's question log and then
silently ignored. The same friction pattern — a skill that keeps forcing the user
to clarify, or a workflow that gets corrected over and over — repeats indefinitely
because no step ever aggregates the signals and says "this skill's description
overpromises; fix it."

Meanwhile the user collects `observable` learnings one at a time via /learn, by
hand, after noticing friction. The noticing step is the bottleneck.

## Research grounding (why this slice)

- Knox/Harness Engineering: a factory has three loops; the **meta loop** "studies
  agent logs, PRs, issues, and user feedback, then sends lessons back" — and it's
  the loop teams most often leave unbuilt. He measures factories by *manual
  takeovers and human comments per PR* — exactly what the question log records.
- Gupta/Warp: an outer-loop agent inspects an inner-loop agent's friction and
  proposes skill updates **through human review** — the update loop is real, but
  it starts as inspection.
- Palmie/Factory: start with a narrow, verifiable, low-authority task where
  humans check the diagnosis before granting more authority.
- Horthy/HumanLayer: factories fail when automation *generates more code* without
  comprehension. A read-only signal-correlator generates none.
- Zakariasson/Cursor: "find every place where people copy information between
  systems" — today the copy step is human: question log → user memory → /learn.

## What we're building

A read-only skill, `/factory-insights`, that the user (or `/retro`-adjacent
review) invokes at will. It reads the project's existing runtime signal files,
attributes each friction Signal to nearby skill activations, and prints a short
**Insight Report** to the chat — v0 has no write paths at all.

North star for v0: one invocation yields **at least one insight the user would
act on** (e.g. "the X skill produced the most clarification questions this
window — its description promises more than it delivers").

## Constraints (agreed in grilling; non-negotiable for v0)

| Constraint | Rule |
|---|---|
| Read-only | Zero writes: no file edits, no learnings appended, **nothing may ever mutate state** without a separate future decision |
| Reuse-only | No new runtime writers, no new dependencies; reads only state files that already exist today |
| Shape | Pure-prose skill (same shape as /retro): `SKILL.md.tmpl` + generated `SKILL.md`, no dedicated bin script |
| Output | Chat-only in v0; no persisted report file |
| Boundaries | Never extends or edits /retro or any other skill's template |

## Signals and friction definition

**v0 reads exactly two JSONL signal files** (resolved through the state-root
prelude, per project slug):

1. `projects/$SLUG/question-log.jsonl` — user decisions recorded by skills.
2. `analytics/skill-usage.jsonl` — skill activations and hook fires.

**Friction = the categories `clarification`, `routing`, and `feedback-loop`.**
`approval` and `cherry-pick` are throughput (the flow worked), not friction, and
are excluded in v0.

**Attribution rule:** each friction Signal is attributed to skill activations
whose timestamps fall within a 30-minute window ending at the Signal's
timestamp. A Signal attributed to more than one skill counts once per skill.
Activations and hook fires are never conflated (hook fires are labeled in the
usage log and are excluded from attribution).

## Window rules

- Default window: the last 14 days, filtered by each record's `ts`.
- If fewer than 3 friction Signals fall in that window, widen to 30 days, and
  the report **must state that it widened** ("signals were sparse; widened the
  window to 30 days").
- If still fewer than 3 Signals, say exactly that and stop — no forced
  insights. Zero Signals counts as fewer than 3: the wider window is checked
  before any honest stop; the stop never precedes the widening.

## Report shape (v0)

1. **Header** — window used, widened or not, total Signals seen, records counted.
2. **Top friction table** — up to 3 skills ranked by attributed friction Signals:
   skill name, Signal count, breakdown by category.
3. **One worked example per top skill** — the user's question text from one
   representative Signal (verbatim, trimmed), so the user can judge the pattern
   rather than trust the aggregate.
4. **Suggested /learn entries** — at most one per top skill, phrased as
   *suggestions with the exact /learn invocation shown*, never executed.
5. **Closure line** — what this report did not look at (it is a read-only
   correlation of two files, not a full retro).

## Skill shape and repo gates

- Skill directory contains only the template and its generated output (the
  smallest shape used by existing skills), with frontmatter: `name`,
  `description`, version, read-only tool allowlist, and `{{PREAMBLE}}` for the
  state-root prelude from the shared runtime resolver.
- The prose resolves state paths through the shared prelude and existing
  path-resolution conventions only — never hand-rolled chains (a repo-wide
  ratchet test rejects those).
- Expected repo gates when implemented: docs regeneration freshness
  (`gen:skill-docs` dry-run), skill validation, skill size budgets, and the
  parity suite; plus the fixture harness e2e described in the spec.

## What the meta loop is NOT in v0

- No auto-updating of any skill template (Warp's outer loop writes a PR — that is
  a later, explicitly separate decision).
- No persistence of the report, no metrics dashboard (signal-to-production time,
  cost per PR etc. — deferred; partly because `/triage` does not exist yet).
- Does not read `learnings.jsonl` or gate-outcome codes (v1 candidates).
- Does not become `/triage` (bug report → diagnosis front door — parked as the
  next follow-on piece if this one proves its slice).

## Success bar

A single manual invocation on a real project produces a report the user agrees
contains an insight they'd act on. If two consecutive runs produce nothing
actionable, the piece has failed its v0 bar and we revisit the Signal scope.
