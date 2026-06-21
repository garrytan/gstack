# Gemini Takeout consumer-session import

`scripts/consumer-session-gemini-takeout-import.ts` normalizes sanitized Google
Gemini Apps Takeout exports into MAT-14 `ConsumerSession` JSON.

Default paths:

```bash
bun run scripts/consumer-session-gemini-takeout-import.ts
```

- Input: `~/.gstack/consumer-sessions/raw/gemini`
- Output: `~/.gstack/consumer-sessions/normalized/gemini`

Explicit extracted folders or archives are supported:

```bash
bun run scripts/consumer-session-gemini-takeout-import.ts --input /path/to/Takeout --dry-run
bun run scripts/consumer-session-gemini-takeout-import.ts --input /path/to/takeout.zip
bun run scripts/consumer-session-gemini-takeout-import.ts --input /path/to/takeout.tgz
```

Archive support shells out to system `unzip` or `tar`; no package dependency is
added.

## Supported shapes

The importer only emits sessions from JSON records with actual conversation
turn arrays. Supported synthetic shapes are:

- `Gemini Apps/**.json` files containing `{ conversations: [...] }`,
  `{ sessions: [...] }`, or an array of conversation objects.
- Conversation objects with `turns` or `messages` arrays. Turn text is read from
  `content`, `text`, `prompt`, `response`, `query`, `answer`, or text-bearing
  `parts`.
- `My Activity/Gemini Apps/MyActivity.json` entries are parsed for metadata.
  Activity entries only become sessions when they contain an embedded
  `conversation`, `turns`, or `messages` shape.
- Gems files are metadata-only unless they contain the same explicit
  conversation-turn shape.
- Turn-level uploads and generated media are copied as attachment metadata only:
  id, name, mime type, size, source kind, provider id, and sha256 where present.
  Binary payload keys such as `data`, `base64`, `bytes`, `blob`, and
  `inlineData` are not copied.

Each normalized session includes:

- `provider: "gemini"`
- `source_receipt.provider_export_kind: "google-takeout"`
- `source_receipt.raw_path`
- `account_hash`
- `host`
- `completeness`

Recurring exports are merged by stable `conversation_id`; duplicate turns are
deduped by provider turn id, falling back to a deterministic hash of role, time,
content, and attachment metadata.

## Fail-closed behavior

Unsupported JSON, activity-only entries, and Gems-only metadata do not create
synthetic chats. They are counted in the import result and skipped. Invalid JSON
is treated as unsupported. Missing optional activity fields such as title or time
do not fail import; missing turn content marks the normalized session partial
when any usable turn or attachment remains.

`--dry-run` prints counts and planned output paths only. It does not print turn
content, account identifiers, or conversation titles.
