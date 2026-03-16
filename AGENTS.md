# gstack for Codex

This repo now has two layers:

- Portable core: `browse/`, the shared build/setup scripts, QA/review assets, and the workflow reference docs under `references/workflows/`.
- Host glue: `CLAUDE.md` plus top-level `*/SKILL.md` for Claude, and `.codex/skills/*` for Codex.

## Codex rules

- If the user says `/browse`, `/qa`, `/review`, `/ship`, `/plan-ceo-review`, `/plan-eng-review`, `/setup-browser-cookies`, or `/retro`, map that to the corresponding Codex skill:
  - `/browse` → `gstack-browse`
  - `/qa` → `gstack-qa`
  - `/review` → `gstack-review`
  - `/ship` → `gstack-ship`
  - `/plan-ceo-review` → `gstack-plan-ceo-review`
  - `/plan-eng-review` → `gstack-plan-eng-review`
  - `/setup-browser-cookies` → `gstack-browser-cookies`
  - `/retro` → `gstack-retro`
- Prefer the gstack browser binary first for browser automation and QA. Do not reach for host-native browser tooling when `browse/dist/browse` can do the job.
- If the browser binary is missing, run `./setup --host codex` from the gstack root before doing browser work.
- Codex skills live under `.codex/skills/`. Their detailed workflow contracts live under `references/workflows/`.
- Claude-only assets stay in `CLAUDE.md` and the top-level workflow directories. Do not rewrite those when a Codex-only change will solve the problem.

## Editing guidance

- Keep the browser runtime host-neutral. Path resolution and installation may branch by host, but the CLI/server behavior should stay shared.
- When workflow behavior changes, update the shared workflow reference in `references/workflows/` first, then touch Codex skills and Claude templates only where host-specific wording differs.
- Do not add Claude-only tool names or `.claude/skills` paths to `.codex/skills/*`.
