# OpenClaw compatibility

This subtree contains OpenClaw-native adaptations of selected gstack workflows.

Goals:
- preserve the role/workflow value of gstack
- avoid Claude-specific tools and hooks
- map browser and orchestration guidance to OpenClaw primitives

Non-goals:
- full Claude Code runtime parity
- automatic conversion of every generated skill/template
- preserving gstack telemetry or repo-mode shell wrappers

Suggested mapping:
- Claude/Codex browser helpers -> OpenClaw `browser`
- sub-agent review flows -> OpenClaw `sessions_spawn` / `subagents`
- file operations -> OpenClaw `read`, `write`, `edit`
- shell commands -> OpenClaw `exec`
- user follow-ups -> normal chat replies or `message`

Ported skill set currently includes review, investigation, office-hours/product planning, QA, design review/consultation, ship + deploy flows, post-ship docs, canary checks, safety modes, security review, retrospective, authenticated browser setup, and delegated coding-agent consultation.

See `openclaw/references/gstack-port-notes.md` for the main runtime translation choices and limitations.
