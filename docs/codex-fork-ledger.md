# Codex Fork Ledger

This ledger records the intentional ways `gstack-codex` diverges from upstream
`gstack` so we can stay Codex-first without making future rebases chaotic.

## Why this file exists

- Keep operational docs and prompts aligned with Codex's real `exec --json` model.
- Make intentional divergences explicit instead of rediscovering them during every rebase.
- Separate "must stay different" changes from routine upstream sync work.

## Intentional Codex-first divergences

### Runtime and harness

- Codex CLI automation lives in `test:exec`, `test:e2e`, and `test:llm-eval`, all of which drive `codex exec --json` rather than Claude CLI flows.
- `test:smoke` stays a free local suite for migration/freshness/validation checks; it is intentionally separate from Codex-authenticated runs.
- Codex JSONL parsing treats `item.completed` as the canonical completed item event.
- Final assistant output is taken from completed `agent_message` items and preserved across `turn.completed`.

### Prompt and skill surface

- Repo instructions live in `AGENTS.md`, not `CLAUDE.md`.
- Skills ship `agents/openai.yaml` metadata for Codex discovery.
- Generated skill docs use the shared `User Decision Format` language for plain-text user decisions.

### Install and bundle layout

- User install root: `~/.codex/skills/gstack-codex`
- Vendored install root: `.codex/skills/gstack-codex`
- Nested skills are loaded directly from the bundle root; no per-skill symlink fanout is required.
- `setup` prints and validates both supported layouts and initializes Codex-first local state under `~/.gstack`.
- `bin/dev-setup` activates repo-local development by symlinking `.codex/skills/gstack-codex` to the repo root, then running setup through that vendored path.
- `bin/dev-teardown` removes only the repo-local dev symlink and returns control to the global `~/.codex/skills/gstack-codex` install.
- `browse/bin/find-browse` resolves the compiled browse binary from the vendored bundle first, then the user install, with a fallback error message that points at the Codex bundle layout.

### Scripts and auth contract

- `package.json` is intentionally Codex-first: script names, eval entrypoints, and the local `@openai/codex` dev dependency all reflect the fork's Codex runtime.
- `.env.example` documents the fork's local auth contract: Codex-backed evals rely on existing Codex CLI auth, not a separate API key, with `CODEX_JUDGE_MODEL` as the supported override.

## Rebase guidance

When rebasing from upstream:

1. Re-review any upstream changes touching the E2E harness, skill generation, or docs.
2. Preserve Codex-specific command examples, event semantics, and metadata generation.
3. Prefer porting upstream intent into Codex-native wording rather than restoring Claude-only terminology.
4. Re-run:
   - `bun test`
   - `bun run test:smoke`
   - `bun run build`
   - `bun run skill:check`
5. Update this ledger if a divergence is added, removed, or no longer needs to exist.

## Files and subsystems most likely to diverge

- `test/helpers/session-runner.ts`
- `test/helpers/llm-judge.ts`
- `scripts/gen-skill-docs.ts`
- `scripts/gen-skill-metadata.ts`
- `package.json`
- `.env.example`
- `setup`
- `bin/dev-setup`
- `bin/dev-teardown`
- `browse/bin/find-browse`
- contributor-facing docs in `README.md`, `CONTRIBUTING.md`, and `ARCHITECTURE.md`

## Decision rule

If upstream wording or behavior conflicts with Codex's actual CLI, event model, or
skill discovery rules, keep the Codex-first behavior here and note the difference
in this ledger.
