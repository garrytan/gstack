---
important: regression
---
**`/codex challenge` and `/codex consult` no longer stop for a /careful delete warning at the end of every run.** Their cleanup deleted the prompt file through a variable the safety check could not resolve, so it asked every time; the cleanup now uses a guarded variable the check accepts. Thanks @dmfrede (#4841).

- **The Codex second-model review in `/plan-eng-review` and `/plan-ceo-review` works in Claude Code plan mode again.** The prompt file was created under `$TMPDIR`, where plan mode refuses Write, so Codex never started. It is now created in the project's `.gstack/tmp/`, which keeps itself out of git, and deleted with a plain `rm` of that one path. Thanks @mcp10 (#4842).
