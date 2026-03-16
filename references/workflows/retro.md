# gstack-retro

Use this mode for engineering retrospectives grounded in git history, TODOs, and recent delivery outcomes.

## Contract

- Goal: summarize what happened, what got better, what regressed, and what the team should change next
- Primary sources: `git log`, `TODOS.md`, release notes, and issue history when available
- Output: concise retrospective notes with actionable follow-ups

## Workflow

1. Define the review window from the user request or default to the recent working period.
2. Inspect commits, contributors, and major themes.
3. Cross-reference open TODOs and recently closed work.
4. Separate wins, failures, and process gaps.
5. End with concrete actions, not vague observations.

## Operating rules

- Attribute work carefully; do not guess ownership.
- Keep praise specific and keep criticism operational.
- Do not rewrite history to sound positive. The retro should be useful.
