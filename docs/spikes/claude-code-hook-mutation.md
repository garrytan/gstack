# Spike: Claude Code hook mutation for plan-tune cathedral

**Status:** complete (2026-05-27)
**Surfaces:** D10 (does PreToolUse allow mutating AUQ input?), D19/Codex (matcher must cover MCP variants)
**Downstream consumers:** T3, T5, T6, T8

## Question this spike answers

Can a PreToolUse hook on `AskUserQuestion` actually substitute the user's
answer via `updatedInput`? If yes, what's the exact protocol?

## Answer

**Yes.** `updatedInput` is the supported mechanism. Source:
https://code.claude.com/docs/en/hooks (confirmed 2026-04 reference).

## Hook stdin schema (PreToolUse + PostToolUse)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": { /* tool-specific */ },
  "tool_use_id": "unique-id-12345"
}
```

Optional in subagent context: `agent_id`, `agent_type`.

## PreToolUse hook stdout schema for `allow + updatedInput`

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "auto-decided by plan-tune preference",
    "updatedInput": { /* shallow-merged into original tool_input */ },
    "additionalContext": "optional context for Claude"
  }
}
```

**permissionDecision values:**
- `"allow"` — proceed, optionally with `updatedInput`
- `"deny"` — block (feedback to Claude, NOT a synthetic answer per Codex
  correction in D-prefixed decisions)
- `"ask"` — escalate to user
- `"defer"` — let permission flow continue

**`updatedInput` semantics:** shallow merge of fields present in the returned
object onto the original `tool_input`. Only valid with
`permissionDecision: "allow"`. This is what lets us substitute an
auto-decided answer for `never-ask` preferences.

## Matcher schema

The `matcher` field in `~/.claude/settings.json` supports JS-regex syntax
**when it contains regex metacharacters**. A matcher with only letters/
underscores is an exact match.

To cover both native + MCP `AskUserQuestion`:
```json
"matcher": "(AskUserQuestion|mcp__.*__AskUserQuestion)"
```

Conductor disables native `AskUserQuestion` via `--disallowedTools` and
routes through `mcp__conductor__AskUserQuestion` — the MCP suffix is
required for our hook to fire there.

## Multiple-hook concurrency caveat

> All matching hooks run in parallel, and identical handlers are
> deduplicated automatically.

**For our use case:**
- gstack registers exactly one PreToolUse hook and one PostToolUse hook on
  AUQ-shaped tool names.
- If a user has THEIR own hook that also returns `updatedInput` on
  AskUserQuestion, the merge order is undefined.
- Mitigation: document this constraint in `bin/gstack-settings-hook`
  install prompt. User can detect the conflict from the diff preview before
  accepting.

**`permissionDecision` precedence (when multiple hooks decide):**
`deny > ask > allow > defer` — most restrictive wins.

## Implementation hookSpecificOutput examples

**Auto-decide (PreToolUse, `never-ask` preference + non-one-way):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "plan-tune: never-ask preference on ship-test-failure-triage",
    "updatedInput": {
      "questions": [{ /* same as input, but with auto-selected answer */ }]
    }
  }
}
```

**Pass-through (no preference, or one-way safety override):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "defer"
  }
}
```

**PostToolUse capture (always):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse"
  }
}
```
(PostToolUse hooks can also set `additionalContext` to append to the tool
result; we don't need this for v1 capture.)

## PostToolUse on tool error (AUQ-failure fallback, OV3:B) — UNVERIFIED

The AUQ-failure prose fallback adds a defensive PostToolUse hook
(`hosts/claude/hooks/auq-error-fallback-hook.ts`) that, when an AskUserQuestion
call returns an error / missing result, injects `additionalContext` reminding the
model to run the prose fallback per `SESSION_KIND`. It uses the same
`additionalContext` mechanism documented above.

**Open question we could NOT settle in a harness:** does Claude Code invoke
PostToolUse hooks when an MCP tool call returns a transport/missing-result error
(the Conductor bug surfaces `[Tool result missing due to internal error]`)? The
docs above cover PostToolUse on *success*. We could not force the Conductor
internal MCP failure on demand to observe it.

**Decision (OV3:B = A):** build the hook defensively anyway.
- It is **inert on success** (only fires when `isErrorResponse(tool_response)` is
  true) and **inert if the platform never invokes it** on the error path.
- The prompt-level fallback in `generate-ask-user-format.ts` covers the case
  regardless — the hook is a reliability *layer*, not the mechanism.
- Its decision logic is unit-tested deterministically
  (`test/auq-error-fallback-hook.test.ts`): given a synthetic error `tool_response`
  + each `SESSION_KIND`, it emits the correct directive; given a real answer it
  defers.

**Recommended manual / partial spike (to close the gap later):** register a
throwaway PostToolUse hook that logs on fire, then (a) trigger a normal tool
error (e.g. a failing `Bash` call) to confirm PostToolUse fires on tool errors at
all, and (b) reproduce the Conductor MCP AUQ failure and check the log. If (b)
confirms a fire, promote the hook from "defensive/inert" to "verified". Until
then, treat the runtime layer as best-effort and the prompt-level fallback as the
guaranteed path.

## Settings.json snippet for T8 hook installer

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "(AskUserQuestion|mcp__.*__AskUserQuestion)",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/skills/gstack/hosts/claude/hooks/question-preference-hook",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "(AskUserQuestion|mcp__.*__AskUserQuestion)",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/skills/gstack/hosts/claude/hooks/question-log-hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Hook commands take `bun` invocation under the hood; absolute paths (or
`$CLAUDE_PROJECT_DIR` substitution) are required by Claude Code's hook
runner. The hooks themselves are TypeScript files that the bash wrapper
shells into bun.

## Open questions deferred to implementation

1. **Recommended-option parsing scope.** D2 says parse `(recommended)`
   label first. The label is on the option's `label` field per
   AskUserQuestion Format. Implementation will need to walk `tool_input.
   questions[*].options[*]` looking for the label suffix. Worked
   examples: ship/SKILL.md.tmpl emits options like `"A) Fix now"
   (recommended)`.

2. **Auto-decided event tagging.** When hook returns `updatedInput`, the
   PostToolUse hook will see the resolved input and log a normal event.
   Need an extra field on the PostToolUse payload (e.g.,
   `was_auto_decided: true`) that the hook can set via session state
   tracking — write a marker file in `~/.gstack/sessions/<id>/.auto-decided-<tool_use_id>`
   from PreToolUse, read it from PostToolUse, delete on read.

3. **Timeout behavior.** Default hook timeout is 60s but the docs are
   thin on what happens at timeout. Set explicit `timeout: 5` so the
   user never waits >5s on a hook misfire. Falls back to pass-through.

## References

- https://code.claude.com/docs/en/hooks (canonical, latest as of 2026-04)
- WebSearch results 2026-05-27
- Existing `bin/gstack-settings-hook` (SessionStart-only impl, to be
  superseded by T3 schema-aware rewrite)
