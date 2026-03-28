# Chrome Sidebar + Conductor: What We Need

## What we're building

Right now when Claude is working in a Conductor workspace — editing files, running tests, browsing your app — you can only watch from Conductor's chat window. If Claude is doing QA on your website, you see tool calls scrolling by but you can't actually *see* the browser.

We built a Chrome sidebar that fixes this. When you run `$B connect`, Chrome opens with a side panel that shows everything Claude is doing in real time. You can type messages in the sidebar and Claude acts on them — "click the signup button", "go to the settings page", "summarize what you see."

The problem: the sidebar currently runs its own separate Claude instance. It can't see what the main Conductor session is doing, and the main session can't see what the sidebar is doing. They're two separate agents that don't talk to each other.

The fix is simple: make the sidebar a *window into* the Conductor session, not a separate thing.

## What we need from Conductor (3 things)

### 1. Let us watch what the agent is doing

We need a way to subscribe to the active session's events. Something like an SSE stream or WebSocket that sends us events as they happen:

- "Claude is editing `src/App.tsx`"
- "Claude is running `npm test`"
- "Claude says: I'll fix the CSS issue..."

The sidebar already knows how to render these events — tool calls show as compact badges, text shows as chat bubbles. We just need a pipe from Conductor's session to our extension.

### 2. Let us send messages into the session

When the user types "click the other button" in the Chrome sidebar, that message should appear in the Conductor session as if the user typed it in the workspace chat. The agent picks it up on its next turn and acts on it.

This is the magic moment: user is watching Chrome, sees something wrong, types a correction in the sidebar, and Claude responds — without the user ever switching windows.

### 3. Let us create a workspace from a directory

When `$B connect` launches, it creates a git worktree for file isolation. We want to register that worktree as a Conductor workspace so the user can see the sidebar agent's file changes in Conductor's file tree. This also sets up the foundation for multiple browser sessions, each with their own workspace.

## Why this matters

Today, `/qa` and `/design-review` feel like a black box. Claude says "I found 3 issues" but you can't see what it's looking at. With the sidebar connected to Conductor:

- **You watch Claude test your app** in real time — every click, every navigation, every screenshot appears in Chrome while you watch
- **You can interrupt** — "no, test the mobile view" or "skip that page" — without switching windows
- **One agent, two views** — the same Claude that's editing your code is also controlling the browser. No context duplication, no stale state

## What's already built (gstack side)

Everything on our side is done and shipping:

- Chrome extension that auto-loads when you run `$B connect`
- Side panel that auto-opens (zero setup for the user)
- Streaming event renderer (tool calls, text, results)
- Chat input with message queuing
- Reconnect logic with status banners
- Session management with persistent chat history
- Agent lifecycle (spawn, stop, kill, timeout detection)

The only change on our side: swap the data source from "local `claude -p` subprocess" to "Conductor session stream." The extension code stays the same.

**Estimated effort:** 2-3 days Conductor engineering, 1 day gstack integration.
