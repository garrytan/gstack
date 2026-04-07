# Sidebar Message Flow

How the GStack Browser sidebar actually works. Read this before touching
sidepanel.js, background.js, content.js, server.ts sidebar endpoints,
or sidebar-agent.ts.

## Components

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│  sidepanel.js   │────▶│ background.js│────▶│  server.ts   │────▶│sidebar-agent.ts│
│  (Chrome panel) │     │ (svc worker) │     │  (Bun HTTP)  │     │  (Bun process) │
└─────────────────┘     └──────────────┘     └─────────────┘     └────────────────┘
        ▲                                           │                      │
        │           polls /sidebar-chat             │    polls queue file   │
        └───────────────────────────────────────────┘                      │
                                                    ◀──────────────────────┘
                                                    POST /sidebar-agent/event
```

## Startup Timeline

```
T+0ms     CLI runs `$B connect`
            ├── Server starts on port 34567
            ├── Writes state to .gstack/browse.json (pid, port, token)
            ├── Launches headed Chromium with extension
            └── Clears sidebar-agent-queue.jsonl

T+500ms   sidebar-agent.ts spawned by CLI
            ├── Reads auth token from .gstack/browse.json
            ├── Creates queue file if missing
            ├── Sets lastLine = current line count
            └── Starts polling every 200ms

T+1-3s    Extension loads in Chromium
            ├── background.js: health poll every 1s (fast startup)
            │     └── GET /health → gets auth token
            ├── content.js: injects on welcome page
            │     └── Does NOT fire gstack-extension-ready (waits for sidebar)
            └── Side panel: may auto-open via chrome.sidePanel.open()

T+2-10s   Side panel connects
            ├── tryConnect() → asks background for port/token
            ├── Fallback: direct GET /health for token
            ├── updateConnection(url, token)
            │     ├── Starts chat polling (1s interval)
            │     ├── Starts tab polling (2s interval)
            │     ├── Connects SSE activity stream
            │     └── Sends { type: 'sidebarOpened' } to background
            └── background relays to content script → hides welcome arrow

T+10s+    Ready for messages
```

## Message Flow: User Types → Claude Responds

```
1. User types "go to hn" in sidebar, hits Enter

2. sidepanel.js sendMessage()
   ├── Renders user bubble immediately (optimistic)
   ├── Renders thinking dots immediately
   ├── Switches to fast poll (300ms)
   └── chrome.runtime.sendMessage({ type: 'sidebar-command', message, tabId })

3. background.js
   ├── Gets active Chrome tab URL
   └── POST /sidebar-command { message, activeTabUrl }
       with Authorization: Bearer ${authToken}

4. server.ts /sidebar-command handler
   ├── validateAuth(req)
   ├── syncActiveTabByUrl(extensionUrl) — syncs Playwright tab to Chrome tab
   ├── pickSidebarModel(message) — 'sonnet' for actions, 'opus' for analysis
   ├── Adds user message to chat buffer
   ├── Builds system prompt + args
   └── Appends JSON to ~/.gstack/sidebar-agent-queue.jsonl

5. sidebar-agent.ts poll() (within 200ms)
   ├── Reads new line from queue file
   ├── Parses JSON entry
   ├── Checks processingTabs — skips if tab already has agent running
   └── askClaude(entry) — fire and forget

6. sidebar-agent.ts askClaude()
   ├── spawn('claude', ['-p', prompt, '--model', model, ...])
   ├── Streams stdout line-by-line (stream-json format)
   ├── For each event: POST /sidebar-agent/event { type, tool, text, tabId }
   └── On close: POST /sidebar-agent/event { type: 'agent_done' }

7. server.ts processAgentEvent()
   ├── Adds entry to chat buffer (in-memory + disk)
   ├── On agent_done: sets tab status to 'idle'
   └── On agent_done: processes next queued message for that tab

8. sidepanel.js pollChat() (every 300ms during fast poll)
   ├── GET /sidebar-chat?after=${chatLineCount}&tabId=${tabId}
   ├── Renders new entries (text, tool_use, agent_done)
   └── On agent idle: removes thinking dots, stops fast poll
```

## Arrow Hint Hide Flow (4-step signal chain)

The welcome page shows a right-pointing arrow until the sidebar opens.

```
1. sidepanel.js updateConnection()
   └── chrome.runtime.sendMessage({ type: 'sidebarOpened' })

2. background.js
   └── chrome.tabs.sendMessage(activeTabId, { type: 'sidebarOpened' })

3. content.js onMessage handler
   └── document.dispatchEvent(new CustomEvent('gstack-extension-ready'))

4. welcome.html script
   └── addEventListener('gstack-extension-ready', () => arrow.classList.add('hidden'))
```

The arrow does NOT hide when the extension loads. Only when the sidebar connects.

## Auth Token Flow

```
Server starts → AUTH_TOKEN = crypto.randomUUID()
    │
    ├── GET /health (no auth) → returns { token: AUTH_TOKEN }
    │
    ├── background.js checkHealth() → authToken = data.token
    │     └── Refreshes on EVERY health poll (fixes stale token on restart)
    │
    ├── sidepanel.js tryConnect() → serverToken from background or /health
    │     └── Used for chat polling: Authorization: Bearer ${serverToken}
    │
    └── sidebar-agent.ts refreshToken() → reads from .gstack/browse.json
          └── Used for event relay: Authorization: Bearer ${authToken}
```

If the server restarts, all three components get fresh tokens within 10s
(background health poll interval).

## Model Routing

`pickSidebarModel(message)` in server.ts classifies messages:

| Pattern | Model | Why |
|---------|-------|-----|
| "click @e24", "go to hn", "screenshot" | sonnet | Deterministic tool calls, no thinking needed |
| "what does this page say?", "summarize" | opus | Needs comprehension |
| "find bugs", "check for broken links" | opus | Analysis task |
| "navigate to X and fill the form" | sonnet | Action-oriented, no analysis words |

Analysis words (`what`, `why`, `how`, `summarize`, `describe`, `analyze`, `read X and Y`)
always override action verbs and force opus.

## Known Failure Modes

| Failure | Symptom | Root Cause | Fix |
|---------|---------|------------|-----|
| Stale auth token | "Unauthorized" in input | Server restarted, background had old token | background.js refreshes token on every health poll |
| Tab ID mismatch | Message sent, no response visible | Server assigned tabId 1, sidebar polling tabId 0 | switchChatTab preserves optimistic UI during switch |
| Sidebar agent not running | Messages queue forever | Agent process failed to spawn or crashed | Check `ps aux | grep sidebar-agent` |
| Agent stale token | Agent runs but no events appear in sidebar | sidebar-agent has old token from .gstack/browse.json | Agent re-reads token before each event POST |
| Queue file missing | spawnClaude fails | Race between server start and agent start | Both sides create file if missing |
| Optimistic UI blown away | User bubble + dots vanish | switchChatTab replaced DOM with welcome screen | Preserved DOM when lastOptimisticMsg is set |

## Per-Tab Concurrency

Each browser tab can run its own agent simultaneously:

- Server: `tabAgents: Map<number, TabAgentState>` with per-tab queue (max 5)
- sidebar-agent: `processingTabs: Set<number>` prevents duplicate spawns
- Two messages on same tab: queued sequentially, processed in order
- Two messages on different tabs: run concurrently

## File Locations

| Component | File | Runs in |
|-----------|------|---------|
| Sidebar UI | `extension/sidepanel.js` | Chrome side panel |
| Service worker | `extension/background.js` | Chrome background |
| Content script | `extension/content.js` | Page context |
| Welcome page | `browse/src/welcome.html` | Page context |
| HTTP server | `browse/src/server.ts` | Bun (compiled binary) |
| Agent process | `browse/src/sidebar-agent.ts` | Bun (non-compiled, can spawn) |
| CLI entry | `browse/src/cli.ts` | Bun (compiled binary) |
| Queue file | `~/.gstack/sidebar-agent-queue.jsonl` | Filesystem |
| State file | `.gstack/browse.json` | Filesystem |
| Chat log | `~/.gstack/sessions/<id>/chat.jsonl` | Filesystem |
