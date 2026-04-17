# gstack -> OpenClaw tool mapping

- `Read` -> `read`
- `Write` -> `write`
- `Edit` -> `edit`
- `Bash` -> `exec`
- `WebSearch` -> `web_search`
- browser helpers / `$B ...` -> `browser`
- `AskUserQuestion` -> ask directly in the chat reply
- agent handoffs -> `sessions_spawn` or `subagents`

Porting rules:
1. Remove Claude-specific preambles, hooks, telemetry, and shell wrappers.
2. Keep the role, diagnostic posture, and workflow sequence.
3. Prefer first-class OpenClaw tools over custom scripts.
4. When a skill depends on multi-agent review, instruct the agent to spawn subagents only when the task is materially complex.
