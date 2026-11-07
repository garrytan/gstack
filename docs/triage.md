# Issue triage

How gstack issues move between open, parked and closed, and what each state
promises the reporter. The rule exists because a closed issue reads as "fixed"
or "rejected" to the person who filed it. On 2026-10-11 a triage pass closed 75
feature requests into TODOS.md themes with a "not rejected" note, and reporters
still saw a closed issue with no fix. Those were reopened on 2026-10-25 under
the `parked` label, and this page is the rule going forward.

An agent triaging for the maintainer may post every comment this page describes,
tag people, request reviews and leave short notes for outside authors, but only
under its bot identity (`capy-ai[bot]` on Capy), never the maintainer's own
GitHub account. On Capy, comment and tag people only through Capy's PR comment
tool (`tools.pr.comment`), and request reviews only through `tools.pr.edit`;
both act as `capy-ai[bot]`. Never comment, tag or request a review with
`gh pr comment`, `gh issue comment`, `gh api` or `gstack-post` on a Capy
machine: `gh` there runs as the maintainer's own account. Elsewhere, comment through `gh` only
when `gh api user --jq .type` prints `Bot`. A comment no bot-identity tool can
post is a draft for the maintainer instead. GitHub comments are the only way an
agent reaches people for the maintainer: it never sends them email, chat
messages, DMs or social posts, and never reads the maintainer's inbox (Garry,
2026-11-04: "never send emails or messages to human beings on my behalf ever";
amended 2026-11-05: "Oh you can leave comments on GitHub").

## The three states

| State | Meaning | How it looks on GitHub |
|-------|---------|------------------------|
| **Open** | We intend to act on it and nothing is decided yet, or a lane is on it now. | Open, no `parked` label. `next-wave` marks issues accepted for the next fix wave. |
| **Parked** | We intend to fix it later, not now. | Open, labelled `parked`, with one comment that says where it is tracked and what fixes it. |
| **Closed** | Fixed, duplicate, or won't fix. Nothing else. | Closed with the matching reason (below). |

An issue we still intend to fix is never closed. Grouping it into a theme,
folding it into a tracking issue, or deciding it waits for other work are all
"parked", not "closed".

## Parking an issue

1. Add the `parked` label.
2. Post one comment with two facts: **where it is tracked** (the TODOS.md
   theme, by link, or the tracking issue such as #3137, #3138 or #3139) and
   **what fixes it** (the work that, when it ships, closes this issue). One or
   two sentences. No other comment is needed.
3. Add the issue number to the TODOS.md entry so the theme credits the reporter
   when it is picked up.

When the work ships, close the issue as fixed with the version or PR. Whatever
the close reason, remove the `parked` label when the issue closes
(`gh issue edit <n> --remove-label parked`), so a `label:parked` search lists
only open parked issues. GitHub leaves labels alone when a merged PR's
`Closes #<n>` closes the issue, so the lane that ships the fix removes the label
itself. When a lane picks a parked issue up, it removes the label while it works
on it (the issue is open again, with the lane on it); an issue the lane later
drops goes back to parked with an updated comment.

## Closing an issue

Each close names its reason in the closing comment. GitHub's close reason and
the labels match:

| Reason | Comment says | Close reason | Label |
|--------|--------------|--------------|-------|
| **Fixed** | the version, commit or PR that fixed it, and what changed | completed | — |
| **Duplicate** | the issue that tracks it (and that issue is open or parked; if it was already fixed, close this one as fixed too, with the same version) | duplicate (`gh issue close <n> --duplicate-of <m>`) | `duplicate` |
| **Won't fix** | why: out of scope, a different design was chosen, the premise no longer holds | not planned | `wontfix` |

`gh issue close` sets only the close reason; add the `duplicate` or `wontfix`
label separately with `gh issue edit <n> --add-label <label>`.

A duplicate of a parked issue is still a duplicate: close it with the link,
and the parked issue's comment or TODOS.md entry credits both reporters. A
report that no longer reproduces on current main closes as fixed when a commit,
PR or version explains why (cite it as
`already_fixed <commit>`); when nothing does, it closes as won't fix with the
version it was checked against and an invitation to reopen with a repro.

## Labels this page uses

- `parked`: not fixed yet, not rejected; stays open, with a comment saying
  where it is tracked and what fixes it.
- `tracking`: a tracking issue for a theme; stays open until the theme ships.
- `next-wave`: accepted for the next fix wave.
- `duplicate`, `wontfix`: the two non-fix close reasons.
- `needs Windows verification`: a merged fix awaiting confirmation on real
  Windows hardware; the issue stays open until then.

## Where the themes live

Parked feature requests are grouped in TODOS.md under "feature themes from the
Wave 9 triage": new hosts (#3137), provider pluralism (#3138), install
footprint and layout (#3139), new skills, ship/review/safety, planning reviews,
state root and project identity, browser and mobile QA, prompt cost and skill
shape, customization and localization, retro, and CI supply chain. Parked bugs
sit under "parked in Wave 9" in the same file. Pick a theme up as a whole and
credit every linked reporter in the CHANGELOG entry.

Community pull requests follow the wave process in
[CONTRIBUTING.md](../CONTRIBUTING.md#community-pr-triage-wave-process); a
closed PR gets the same courtesy as a closed issue: a comment saying why and
what supersedes it.
