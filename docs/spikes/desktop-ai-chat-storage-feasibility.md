# Spike: macOS local AI chat storage feasibility without private content reads

**Status:** complete (2026-06-21)
**Issue:** Linear MAT-19
**Surfaces:** desktop AI chat storage discovery, privacy-safe ingestion planning
**Downstream consumers:** follow-up ingestion issues must use synthetic fixtures or user-approved export/cache samples

## Question This Spike Answers

Can gstack detect installed macOS desktop AI chat apps and assess local storage
parser feasibility without printing or logging private chat content?

## Privacy Boundary

Discovery is metadata-only. The detector reports paths, file/directory types,
sizes, mtimes, bundle identifiers, storage technologies, and parser feasibility.
It must not emit:

- raw chat text
- auth tokens, cookies, localStorage values, or IndexedDB keys/values
- screenshots or cached attachment names
- database rows or LevelDB records
- header bytes or string-scan excerpts from private files

The added detector follows that boundary:

```bash
bun run scripts/desktop-ai-chat-storage-discovery.ts --existing-only --format markdown
```

The script uses `stat` metadata, app `Info.plist` bundle identifiers, shallow
known-path discovery, and magic-byte/header classification for ChatGPT `.data`
files. It does not dump bytes or parse private records.

## Local Discovery Snapshot

Measured on Matt's macOS machine on 2026-06-21 with the metadata-only detector.

| Provider | Installed | Decision | Evidence |
|---|---:|---|---|
| ChatGPT Desktop | yes | promising but brittle | `/Applications/ChatGPT.app` bundle `com.openai.chat`; `~/Library/Application Support/com.openai.chat`; `.data` files under `conversations-v3-*`, `drafts-v2-*`, model/gizmo/helper caches |
| Claude Desktop | yes | metadata-only | `/Applications/Claude.app` bundle `com.anthropic.claudefordesktop`; `~/Library/Application Support/Claude`; Chromium-style `IndexedDB`, `Local Storage`, `Session Storage`, `Cookies`, `Service Worker` paths |
| Gemini | no | not feasible | no dedicated `/Applications/Gemini.app` detected; browser/PWA cache inspection is out of scope |
| Grok | no | not feasible | no dedicated `/Applications/Grok.app` or local Grok/xAI app container detected |
| Perplexity | yes | promising but brittle | `/Applications/Perplexity.app` bundle `ai.perplexity.macv3`; `~/Library/Containers/ai.perplexity.mac`; `~/Library/Application Support/Perplexity`; Perplexity group containers |
| Comet | yes | promising but brittle | `/Applications/Comet.app` bundle `ai.perplexity.comet`; `~/Library/Application Support/Comet`; Chromium-style `Default/IndexedDB` and `Default/Local Storage`; Perplexity group containers |

## Provider Findings

### ChatGPT Desktop

Detected:

| Path | Type/technology | Parser feasibility |
|---|---|---|
| `/Applications/ChatGPT.app` | macOS app bundle, `com.openai.chat` | installed app detection is reliable |
| `~/Library/Application Support/com.openai.chat` | Application Support root | structural discovery is reliable |
| `~/Library/Application Support/com.openai.chat/conversations-v3-*/<id>.data` | `.data` files, mixed protobuf-like/msgpack-like/custom-binary guesses by header only | promising but brittle |
| `~/Library/Application Support/com.openai.chat/drafts-v2-*/NewThreadDraft.data` | `.data` file, protobuf-like by header only | drafts likely recoverable only with approved fixtures |
| `~/Library/Group Containers/group.com.openai.chat` | macOS group container | metadata-only |

Header-only classification found `.data` files that are not SQLite and not
plain gzip/lz4/zstd. Some look Apple-binary-plist, msgpack-like, protobuf-like,
or custom/encrypted binary. The classifier intentionally does not print header
bytes or run string scans.

**Decision:** promising but brittle. There are clear local conversation-shaped
files, but record extraction needs synthetic fixtures or user-approved samples
to avoid reading private values.

### Claude Desktop

Detected:

| Path | Type/technology | Parser feasibility |
|---|---|---|
| `/Applications/Claude.app` | macOS app bundle, `com.anthropic.claudefordesktop` | installed app detection is reliable |
| `~/Library/Application Support/Claude/IndexedDB` | Chromium IndexedDB, usually LevelDB-backed | metadata-only |
| `~/Library/Application Support/Claude/Local Storage/leveldb` | Chromium Local Storage LevelDB | not an ingestion source; sensitive values skipped |
| `~/Library/Application Support/Claude/Session Storage` | Chromium Session Storage | not an ingestion source; sensitive values skipped |
| `~/Library/Application Support/Claude/Cookies` | cookie store path | not inspected |

The safe evidence proves Claude Desktop uses Chromium/Electron storage shapes.
It does not prove whether IndexedDB contains complete conversation records,
drafts, cache, or metadata. Proving complete recoverability would require
reading LevelDB keys/values or equivalent private payloads, so this spike stops
there.

**Decision:** metadata-only. Follow-up work needs synthetic Claude Desktop
fixtures or explicitly user-approved cache/export samples.

### Gemini

No dedicated Gemini macOS app bundle was detected. The detector reports Gemini
as not installed unless a local `/Applications/Gemini.app`-style target exists.
Browser profile or PWA cache inspection is intentionally out of scope.

**Decision:** not feasible.

### Grok

No dedicated Grok macOS app bundle or local Grok/xAI container was detected.
The detector reports Grok as not installed/no dedicated macOS target unless a
local app or container exists.

**Decision:** not feasible.

### Perplexity

Detected:

| Path | Type/technology | Parser feasibility |
|---|---|---|
| `/Applications/Perplexity.app` | macOS app bundle, `ai.perplexity.macv3` | installed app detection is reliable |
| `~/Library/Containers/ai.perplexity.mac` | macOS sandbox container | metadata-only |
| `~/Library/Application Support/Perplexity` | Application Support root | structural discovery is reliable |
| `~/Library/Group Containers/7S8W4W365S.ai.perplexity.macv3.shared` | macOS group container | metadata-only |
| `~/Library/Group Containers/group.ai.perplexity.app` | macOS group container | metadata-only |
| `~/Library/Group Containers/group.ai.perplexity.mac` | macOS group container | metadata-only |

**Decision:** promising but brittle. App/container detection is straightforward,
but ingestion requires documented provider formats, synthetic fixtures, or
user-approved exports/cache samples.

### Comet

Detected:

| Path | Type/technology | Parser feasibility |
|---|---|---|
| `/Applications/Comet.app` | macOS app bundle, `ai.perplexity.comet` | installed app detection is reliable |
| `~/Library/Application Support/Comet` | Application Support root | structural discovery is reliable |
| `~/Library/Application Support/Comet/Default/IndexedDB` | Chromium IndexedDB, usually LevelDB-backed | metadata-only unless fixture-backed |
| `~/Library/Application Support/Comet/Default/Local Storage` | Chromium Local Storage | not an ingestion source; sensitive values skipped |

**Decision:** promising but brittle. Comet appears Chromium-like; app detection
is clean, but chat ingestion from browser-style storage is brittle without
fixture-backed provider-specific parsing.

## Implementation Asset

Added `scripts/desktop-ai-chat-storage-discovery.ts`:

- provider-aware candidates for ChatGPT, Claude, Gemini, Grok, Perplexity, and
  Comet
- exact Perplexity/Comet paths requested in MAT-19/MAT-24 comments
- app bundle ID extraction from `Info.plist`
- metadata-only structural storage detection
- ChatGPT `.data` classification by header/magic-byte categories only
- JSON and Markdown output modes
- test hooks for synthetic home/application roots

## Test Coverage

Added `test/desktop-ai-chat-storage-discovery.test.ts`:

- verifies synthetic ChatGPT app/storage metadata detection
- verifies synthetic private-looking chat text is not present in JSON or
  Markdown output
- verifies Gemini remains `not feasible` without a dedicated app bundle
- verifies `.data` header classification for SQLite, gzip, and unknown binary

Focused test command:

```bash
bun test test/desktop-ai-chat-storage-discovery.test.ts
```

## Follow-Up Guardrail

Any ingestion issue after this spike must require one of:

- synthetic fixtures created specifically for parser development
- user-approved exports
- user-approved cache samples with explicit scope and redaction expectations

Do not build parsers by scanning private LevelDB/SQLite/blob values from a real
user profile.
