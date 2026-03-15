# Browser — agent-browser

gstack uses [agent-browser](https://github.com/vercel-labs/agent-browser) by Vercel for all browser automation. It's a Rust-based CLI that talks to a persistent Chromium daemon via CDP.

## Install

```bash
npm install -g agent-browser
agent-browser install
```

Or run `./setup` which handles this automatically.

## Quick reference

| Category | Commands | What for |
|----------|----------|----------|
| Navigate | `open`, `back`, `forward`, `reload`, `url` | Get to a page |
| Read | `get text`, `get html`, `get attr`, `get styles` | Extract content |
| Snapshot | `snapshot [-i] [-c] [-s sel]`, `diff snapshot` | Get refs, diff changes |
| Interact | `click`, `fill`, `select`, `hover`, `type`, `press`, `scroll`, `scrollintoview`, `wait` | Use the page |
| Inspect | `eval`, `is visible`, `is enabled`, `is checked`, `network requests`, `cookies get` | Debug and verify |
| Visual | `screenshot`, `screenshot --annotate`, `pdf` | See what the agent sees |
| Compare | `diff url <url1> <url2>` | Spot differences between environments |
| Dialogs | `dialog accept [text]`, `dialog dismiss` | Control alert/confirm/prompt handling |
| Tabs | `tab`, `tab switch`, `tab new`, `tab close` | Multi-page workflows |
| Config | `set viewport W H`, `set headers`, `cookies set`, `cookies clear` | Configure the session |
| Find | `find text`, `find all` | Search page content |
| Frames | `frame list`, `frame switch` | Navigate iframes |

All selector arguments accept CSS selectors or `@e` refs from `snapshot`. 50+ commands total.

## The ref system

Refs (`@e1`, `@e2`, etc.) are how the agent addresses page elements:

```bash
agent-browser snapshot -i          # Get accessibility tree with @e refs
agent-browser click @e3            # Click element @e3
agent-browser fill @e4 "value"     # Fill input @e4
```

No DOM mutation. No injected scripts. The accessibility tree is the source of truth.

## Snapshot flags

| Flag | Description |
|------|-------------|
| `-i` | Interactive elements only (buttons, inputs, links) |
| `-c` | Compact output (less whitespace) |
| `-s <sel>` | Scope to CSS selector |

Related commands:
- `diff snapshot` — compare current page to previous snapshot
- `screenshot --annotate <path>` — screenshot with ref labels overlaid

## Performance

| Metric | Value |
|--------|-------|
| First call | ~3s (daemon startup) |
| Subsequent calls | sub-second |
| Context overhead | 0 tokens (plain text stdout) |

## Why CLI over MCP?

MCP (Model Context Protocol) works well for remote services, but for local browser automation it adds pure overhead:

- **Context bloat**: every MCP call includes full JSON schemas and protocol framing
- **Connection fragility**: persistent WebSocket/stdio connections drop and fail to reconnect
- **Unnecessary abstraction**: Claude Code already has a Bash tool. A CLI that prints to stdout is the simplest possible interface

agent-browser skips all of this. Plain text in, plain text out. No protocol. No schema. No connection management.
