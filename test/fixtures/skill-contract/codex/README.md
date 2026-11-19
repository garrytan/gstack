# Codex rollouts for the /review contract (GST-3173)

Real Codex CLI 0.170.0 rollout files, the JSONL a Codex hook payload's
`transcript_path` names. `test/skill-contract-codex.test.ts` reads them.

Captured on 2026-11-19 with `gpt-5.4-mini` at low effort, a fresh
`CODEX_HOME` holding gstack's Codex skills, and a two-commit Python repo
(`main` plus a `feature` branch that adds `avg()`). Strings over 1,200
characters are trimmed (the start and end are kept), home and checkout paths
are renamed under `/home/dev`, and token and timing records are dropped.
Nothing else was edited.

| File | How it ran | What it shows |
|---|---|---|
| `exec-read-met.jsonl` | `codex exec`, told to read the gstack-review SKILL.md with a shell command, with gstack's contract Stop hook on (`--dangerously-bypass-hook-trust`) | a load by `cat`, an adversarial `spawn_agent` and a full report: met |
| `exec-read-blocked.jsonl` | the same, told not to start subagents | the hook blocked once (the `<hook_prompt>` message), then the model ran the pass and fixed the report: met after the block |
| `exec-read-failed-spawn.jsonl` | `codex exec`, no gstack hook | a `spawn_agent` that failed (no `agent_id`) before one that started; a report without Gate edits |
| `app-server-injected-early-exit.jsonl` | `codex app-server`, the skill sent as a `skill` input | Codex injects the SKILL.md as a `<skill>` user message; the run ends "Nothing to review" |
| `exec-mention-not-loaded.jsonl` | `codex exec '$gstack-review ...'`, with a probe Stop hook that blocked once | `codex exec` passes a typed `$gstack-review` as plain text, so nothing loads |
| `exec-subagent.jsonl` | the subagent rollout from the failed-spawn run | `session_meta.source` names the parent thread |
| `exec-sol-spawn-met.jsonl` | `codex exec -m gpt-6.1-sol` against a local stub Responses endpoint (no key, GEVA-562), skill injected, gstack's contract Stop hook on | Codex serves `spawn_agent` in its `collaboration` namespace with a required `task_name`, and the started agent's result is `{"task_name":"/root/adversarial"}` with no `agent_id`; before this reader knew that shape the hook blocked a met review once |

`stop-payloads.json` holds the three Stop payloads Codex sent gstack's hook in
the first two runs, and what the hook printed.
