# Spike: Codex session storage format for plan-tune cathedral

**Status:** complete (2026-05-27)
**Surfaces:** D5 (Codex import parses structured files, not regex)
**Downstream consumers:** T9 (gstack-codex-session-import)

## Question this spike answers

What's the actual on-disk format of Codex sessions, and how do we recover
AskUserQuestion-shaped events from it for `gstack-codex-session-import`?

## Storage layout

```
~/.codex/
├── auth.json                     # Codex auth (do not touch)
├── config.toml                   # User config
├── goals_1.sqlite                # ~24KB, internal goals DB (not relevant)
├── logs_2.sqlite                 # ~16MB, structured logs (target=*, see schema)
├── history.jsonl                 # ~9KB, command history
└── sessions/
    └── 2026/05/27/
        └── rollout-<iso8601>-<uuid>.jsonl   # per-session transcript
```

Session files: one JSONL per `codex exec` or interactive session. Cwd path
embedded in the `session_meta` event. CLI version recorded.

## Session JSONL event types (measured on Garry's machine, 2026-05-27)

| type           | count | meaning |
|----------------|------:|---------|
| `response_item`|   382 | model's response stream (~76%) |
| `event_msg`    |    97 | high-level session events (~19%) |
| `turn_context` |     6 | per-turn context snapshot |
| `session_meta` |     6 | session header (one per session) |

### response_item subtypes

| subtype                  | count | meaning |
|--------------------------|------:|---------|
| `function_call`          | 148   | model invoked a tool |
| `function_call_output`   | 148   | tool result returned to model |
| `reasoning`              |  44   | reasoning summary |
| `message`                |  40   | text message (input_text or output_text) |
| `web_search_call`        |   2   | web search tool call |

### event_msg subtypes

| subtype           | count | meaning |
|-------------------|------:|---------|
| `token_count`     | 55    | per-step token accounting |
| `agent_message`   | 22    | agent's prose output |
| `user_message`    |  6    | user's prose input |
| `task_started`    |  6    | task start (one per top-level task) |
| `task_complete`   |  6    | task complete |
| `web_search_end`  |  2    | web search completion |

## Critical finding: Codex has no `AskUserQuestion` tool

Codex doesn't surface AskUserQuestion as a tool call in `response_item`
stream. Gstack skills running on Codex emit AskUserQuestion-shaped
Decision Briefs as plain prose inside `agent_message` events (the
`AskUserQuestion Format` from preamble). The user's answer comes back in
the next `user_message`.

This means importing AUQ events from Codex sessions is structurally
different from importing them from Claude Code (where they ARE
tool calls):

- **Claude Code:** hook captures structured `tool_input`/`tool_output`
  for `AskUserQuestion`. Question + options + answer all separated.
- **Codex:** parser must extract from `agent_message.text` body, detect
  the D-numbered Decision Brief pattern, then match against the
  subsequent `user_message` for the answer.

## Recovery strategy for `gstack-codex-session-import`

**Two-tier extraction:**

1. **Marker-first (D18 mechanism).** Search `agent_message` text for the
   `<gstack-qid:foo-bar>` marker. If present, we have an exact question_id
   and can reliably recover. (Will work once T14 adds markers to the top
   10 registry questions and Codex starts emitting them via the
   host-aware preamble path.)

2. **Pattern fallback.** When no marker, parse for:
   - `D<N> — <title>` line (D-number from AskUserQuestion Format)
   - `Recommendation: ...` line
   - Option block `A) ...`, `B) ...`, etc.
   - Next `user_message` event for the chosen option label

   Use this only to populate hash-based question_id (the same
   `hook-<sha1(skill+text+sorted_options)[:10]>` shape Layer 1 uses on
   Claude). Tagged `source: "codex-pattern-fallback"`, never used as
   preference key (per D18 hash drift guidance).

## Schema we'll write to question-log.jsonl from Codex import

Per existing `bin/gstack-question-log` schema, augmented with:
- `source: "codex-import-marker"` (when qid marker found)
- `source: "codex-import-pattern"` (when fallback regex used)
- `codex_session_id` (UUID from session_meta)
- `codex_cwd` (working dir from session_meta — disambiguates project)
- `codex_ts` (timestamp from event)

## Sqlite logs_2.sqlite schema

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL,
  target TEXT NOT NULL,
  feedback_log_body TEXT,
  module_path TEXT,
  file TEXT,
  line INTEGER,
  thread_id TEXT,
  process_uuid TEXT,
  estimated_bytes INTEGER NOT NULL DEFAULT 0
);
```

`logs_2.sqlite` is internal telemetry, not session content. **Don't use
for AUQ extraction.** Sessions JSONL is authoritative.

## Project-slug derivation

From `session_meta.payload.cwd` — derive via the existing
`bin/gstack-slug` logic on the cwd path. Conductor worktrees have their
own slug naming convention encoded in cwd; the bin already handles this.

## Versioning safety

`session_meta.payload.cli_version` records the Codex CLI version (e.g.
`0.130.0`). When the importer encounters an unknown version, log a
warning to stderr but continue — schema additions are typically
backwards-compatible in JSONL.

If `type` or `payload.type` values change in a future version, we'll see
them as `unknown` in the importer's audit log. Add a guarded
`KNOWN_VERSIONS = ["0.130.x", "0.131.x", ...]` constant in the importer
and bump explicitly when re-testing.

## Open questions for implementation

1. **Where does Codex store the "user's answer" exactly?** Need to test
   with a real `codex exec` run that triggers a Decision Brief and inspect
   the next event. Likely `event_msg` of subtype `user_message` or a
   `response_item` of subtype `message` with `role: "user"`. Confirm
   during T9 implementation.

2. **Free-text extraction for "Other".** The Decision Brief prose
   doesn't structurally separate "Other" responses from named options.
   Pattern fallback will need to detect "Other: <text>" wording in the
   answer. T10 (dream cycle distill) only fires on this when source is
   `codex-import-marker` so we can trust the data.

3. **Conductor cwd handling.** Conductor worktrees share project state
   but have distinct cwds. The import should bucket events by the
   project slug, not the cwd directly, so events from sibling worktrees
   accumulate into the same project view.

## References

- Live inspection of `~/.codex/sessions/2026/05/*/`
- `sqlite3 ~/.codex/logs_2.sqlite ".schema"` (2026-05-27)
- Codex CLI 0.130.0 (current at spike time)
- See also: D5 cross-model tension decision in plan file.
