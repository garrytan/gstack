---
paths:
  - "extension/sidepanel*.js"
  - "extension/background.js"
  - "extension/content.js"
  - "extension/sidepanel-terminal.js"
---

# Sidebar architecture

Before modifying `sidepanel.js`, `background.js`, `content.js`, `terminal-agent.ts`,
or sidebar-related server endpoints, read `docs/designs/SIDEBAR_MESSAGE_FLOW.md`.
The sidebar has one primary surface — the **Terminal** pane (interactive `claude`
PTY) — with Activity / Refs / Inspector as debug overlays behind the footer's
`debug` toggle. The chat queue path was ripped once the PTY proved out;
`sidebar-agent.ts` and the `/sidebar-command` / `/sidebar-chat` /
`/sidebar-agent/event` endpoints are gone. The doc covers the WS auth flow,
dual-token model, and threat-model boundary — silent failures here usually trace
to not understanding the cross-component flow.

**Cross-pane PTY injection.** The toolbar's Cleanup button and the Inspector's
"Send to Code" action both pipe text into the live claude PTY via
`window.gstackInjectToTerminal(text)`, exposed by `sidepanel-terminal.js`. No
`/sidebar-command` POST — the live REPL is the only execution surface in the
sidebar now.
