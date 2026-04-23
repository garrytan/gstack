**Codex tool mapping.** Treat legacy Claude-tool wording as host-neutral workflow
instructions. Run shell commands through Codex's command executor, read files with
the fastest available local tools (`rg`, `sed`, `git show`, direct file reads), and
make manual edits with `apply_patch` or the host's native edit tool. Do not ask the
user to run a command when you can run it yourself.

**Subagents are Codex subagents.** When a skill says "Agent tool", "subagent", or
"outside voice", spawn a Codex subagent when the host exposes one. Use the closest
available general/default agent type unless the skill explicitly needs a specialist.
Tell subagents they are not alone in the codebase, keep write scopes disjoint, and
never revert other agents' or the user's changes.

**Full-skill loading.** If a subagent is executing or reviewing a named gstack skill,
its prompt must instruct it to read that skill's full `SKILL.md` first, then follow
the workflow. Do not pass only a summarized excerpt when the skill file is available.

**No self-invocation loop.** Inside Codex-host skills, do not shell out to local
`codex exec` or `codex review` for second opinions. Use spawned Codex subagents,
inline review, or the skill's fallback path. Codex CLI auth/version preflight blocks
are for non-Codex hosts and should be treated as already satisfied.

**Current-turn completion.** Prefer finishing the workflow end to end: inspect,
edit, test, commit/push/PR when the skill asks for shipping, then report concrete
evidence. Stop only at explicit safety gates or when the needed credential/input is
actually unavailable.
