# Claude.ai Consumer Export Ingestion

`scripts/consumer-session-claude-ai-import.ts` normalizes sanitized Claude.ai consumer account exports into the MAT-14 `ConsumerSession` JSON contract.

Default paths:

- Input: `~/.gstack/consumer-sessions/raw/claude-ai`
- Output: `~/.gstack/consumer-sessions/normalized/claude-ai`

Use an explicit source with:

```bash
bun run scripts/consumer-session-claude-ai-import.ts --input /path/to/export --dry-run
bun run scripts/consumer-session-claude-ai-import.ts --input /path/to/export --output ~/.gstack/consumer-sessions/normalized/claude-ai
```

The provider id is always `claude-ai`.

## Supported Shape

The parser supports JSON files in one of these sanitized shapes:

- A bundle object with `conversations: [...]`.
- A top-level array where every item is a conversation.
- A single conversation object.

Each conversation must have `uuid`, `id`, or `conversation_id`, plus `chat_messages` or `messages`. Message text can be `text`, `message`, `body`, string `content`, `{ "content": { "text": "..." } }`, or a `content` array of text/markdown blocks.

Mapped fields:

- Conversation id, title, created/updated timestamps when present.
- Ordered turns in export order.
- Role mapping: `human`/`user`, `assistant`/`claude`, `system`, `tool`; unknown roles become `other` with the original role in turn metadata.
- Project metadata from `project`, `project_id`, `project_uuid`, or `project_name`.
- Artifact metadata from conversation/message `artifacts`.
- Attachment metadata from `attachments` and `files`: id, name, MIME type, byte size, source kind, provider attachment id, SHA-256.
- Receipt metadata: raw path, provider export kind, source content hash.
- Account hash from account/user/email identifiers, never the raw account value.
- Host and platform.
- Completeness flags from `complete`, `partial`, `truncated`, and optional reason fields.

Unavailable fields:

- Attachment file contents are not read or embedded.
- Browser storage, IndexedDB, cookies, and Claude desktop cache formats are not parsed.
- Unknown content block types are rejected rather than partially indexed.
- If no account identifier exists, the account hash falls back to a stable `unknown-account` hash.

Unsupported schemas fail closed with diagnostics and no normalized files are written.
