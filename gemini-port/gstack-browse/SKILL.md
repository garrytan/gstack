---
name: gstack-browse
description: QA Engineer Mode (Browsing). Use when asked to test a UI, navigate a site, verify rendering, fill forms, or perform automated browser tasks. Gives the agent "eyes" and hands to interact with live applications.
---

# QA Engineer Mode (Browsing)

You are acting as a QA Engineer with a live Playwright browser. Your goal is to interact with web applications, verify UI state, document bugs, and catch regressions.

The browser uses a **persistent Chromium profile** at `~/.gstack/gemini-browser-data` — cookies, login sessions, and storage persist across runs. SSL certificate errors are ignored by default (supports local/staging servers).

**All commands run in the same browser context** — chain them in a single `run_shell_command` call to preserve state (DOM, cookies, navigation history).

---

## Setup

Before using any browse command, ensure Node.js and the Playwright dependency are installed:

```bash
cd <skill_dir>/gstack-browse && node -e "require('playwright')" 2>/dev/null || npm install
```

Then run commands via:
```bash
node <skill_dir>/gstack-browse/scripts/browse.js <command1> [args...] <command2> [args...]
```

For brevity in this document, `$B` means `node <skill_dir>/gstack-browse/scripts/browse.js`.

---

## Core QA Patterns

### 1. Verify a page loads correctly
```bash
$B goto https://yourapp.com
$B text                          # content loads?
$B console --errors              # JS errors?
$B network --errors              # failed requests?
$B is visible ".main-content"   # key elements present?
```

### 2. Test a login flow
```bash
$B goto https://app.com/login
$B snapshot -i                   # see all interactive elements → get @eN refs
$B fill @e2 "user@test.com"
$B fill @e3 "password"
$B click @e4                     # submit
$B snapshot -D                   # diff: what changed after submit?
$B is visible ".dashboard"       # success state?
```

### 3. Verify an action worked
```bash
$B snapshot                      # baseline DOM snapshot
$B click @e3                     # do something
$B snapshot -D                   # unified diff — shows exactly what changed
```

### 4. Visual evidence for bug reports
```bash
$B snapshot -i -a -o /tmp/annotated.png    # annotated screenshot with @eN labels
$B screenshot /tmp/bug.png                  # plain full-page screenshot
$B console --errors                         # error log
```

### 5. Find all clickable elements (including non-ARIA divs)
```bash
$B snapshot -C                   # includes cursor:pointer, onclick elements
$B click @c1
```

### 6. Assert element states
```bash
$B is visible ".modal"
$B is enabled "#submit-btn"
$B is disabled "#submit-btn"
$B is checked "#agree-checkbox"
$B is editable "#name-field"
```

### 7. Test responsive layouts
```bash
$B viewport 375x812
$B screenshot /tmp/mobile.png
$B viewport 1280x720
```

### 8. Fill forms and select dropdowns
```bash
$B fill "#username" "alice"
$B select "#country" "United States"
$B press Tab
$B press Enter
```

### 9. Test page with authentication (cookies already imported)
```bash
$B goto https://app.com/dashboard    # session cookies loaded from persistent profile
$B snapshot -i -a -o /tmp/dash.png
```

---

## Available Commands

### Navigation
| Command | Args | Description |
|---------|------|-------------|
| `goto` | `<url>` | Navigate to a URL. Waits for network idle. |
| `wait` | `<selector\|Nms>` | Wait for CSS selector to appear, or pause N milliseconds. |
| `scroll` | `<top\|bottom\|up\|down\|selector>` | Scroll page or bring element into view. |
| `viewport` | `<WxH>` | Set browser viewport. Example: `375x812`, `1280x720`. |

### Interaction
| Command | Args | Description |
|---------|------|-------------|
| `click` | `<selector>` | Click an element. Accepts CSS selectors or `@eN` refs. |
| `fill` | `<selector> <text>` | Fill an input field. Wrap multi-word text in quotes. |
| `hover` | `<selector>` | Mouse over an element (reveals tooltips, dropdowns). |
| `press` | `<key>` | Keyboard press. Examples: `Enter`, `Tab`, `Escape`, `ArrowDown`. |
| `select` | `<selector> <value>` | Choose an option in a `<select>` dropdown by label or value. |

### Observation
| Command | Args | Description |
|---------|------|-------------|
| `text` | — | Output page visible text. |
| `html` | — | Output full page HTML. |
| `links` | — | List all links (`href` + text). |
| `console` | `[--errors]` | Show browser console messages. `--errors` filters to errors/warnings only. |
| `network` | `[--errors]` | Show network requests. `--errors` shows only 4xx/5xx/failed. |
| `count` | `<selector>` | Count elements matching a CSS selector. |
| `is` | `<state> <selector>` | Assert element state. Exits non-zero on failure. |
| `js` | `<code>` | Execute JavaScript; print result as JSON. |

### Screenshots & Snapshots
| Command | Flags | Description |
|---------|-------|-------------|
| `screenshot` | `<path>` | Full-page screenshot saved to path. |
| `snapshot` | — | Full accessibility tree as text. |
| `snapshot` | `-i` | Interactive elements only (inputs, buttons, links, selects). |
| `snapshot` | `-C` | Like `-i` plus non-ARIA clickables (cursor:pointer, onclick). |
| `snapshot` | `-D` | Diff mode: show changes since last snapshot call. |
| `snapshot` | `-a -o <path>` | Annotated screenshot with `@eN` labels saved to path. |
| `snapshot` | `-i -a -o <path>` | Annotated screenshot of interactive elements only. |

### Session & Cookies
| Command | Args | Description |
|---------|------|-------------|
| `cookie-import` | `<path>` | Import cookies from a JSON file (Playwright cookie format). |

---

## @eN Selectors

`snapshot -i` outputs an element table like:

```
3 interactive elements:
@e1   input       text      "Email"   #email
@e2   input       password  "Password"  #password
@e3   button                "Sign In"  .btn-primary
```

These `@eN` refs can be used directly as selectors in `click`, `fill`, `hover`, `is`, and `scroll`. They resolve to the underlying CSS selector. The refs are valid for the current page — they reset when you navigate.

---

## `is` States

| State | Assertion |
|-------|-----------|
| `visible` | Element exists and is visible |
| `hidden` | Element is absent or not visible |
| `enabled` | Element is not disabled |
| `disabled` | Element has disabled attribute |
| `checked` | Checkbox/radio is checked |
| `editable` | Input/textarea is editable (not readonly) |

---

## Important Notes

- **Chaining is how state is preserved.** All commands in a single `node browse.js ...` call share the same page and session.
- **`@eN` refs are per-snapshot.** Re-run `snapshot -i` after navigation to get fresh refs.
- **Session data persists at `~/.gstack/gemini-browser-data`** across separate `node browse.js` invocations. Cookies from `gstack-setup-browser-cookies` are stored there.
- **`snapshot -D`** compares to the last snapshot call in any previous run (stored in `/tmp/gstack-snapshot-state.json`).
- **On SSL errors:** Ignored by default — fine for localhost and staging. Do not test production credential flows on untrusted cert sites.
