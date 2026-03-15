---
name: gstack
version: 2.0.0
description: |
  Headless browser for QA testing and site dogfooding via agent-browser. Navigate any URL, interact
  with elements, verify page state, diff before/after actions, take annotated screenshots, check
  responsive layouts, test forms and uploads, handle dialogs, and assert element states.
  Use when you need to test a feature, verify a deployment, dogfood a user flow, or file a bug
  with evidence.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion

---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# gstack browse: QA Testing & Dogfooding

Persistent headless Chromium via agent-browser. First call auto-starts the daemon, then fast per command.
State persists between calls (cookies, tabs, sessions).

## SETUP (run this check BEFORE any browser command)

```bash
if command -v agent-browser &>/dev/null; then
  echo "READY: $(which agent-browser)"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "agent-browser needs a one-time install (~30 seconds). OK to proceed?" Then STOP and wait.
2. Run: `npm install -g agent-browser && agent-browser install`

## IMPORTANT

- Use `agent-browser <command>` via Bash for all browser interaction.
- NEVER use `mcp__claude-in-chrome__*` tools. They are slow and unreliable.
- Browser persists between calls — cookies, login sessions, and tabs carry over.
- Dialogs (alert/confirm/prompt) can be handled with `agent-browser dialog accept/dismiss`.

## QA Workflows

### Test a user flow (login, signup, checkout, etc.)

```bash
# 1. Go to the page
agent-browser open https://app.example.com/login

# 2. See what's interactive
agent-browser snapshot -i

# 3. Fill the form using refs
agent-browser fill @e3 "test@example.com"
agent-browser fill @e4 "password123"
agent-browser click @e5

# 4. Verify it worked
agent-browser diff snapshot              # diff shows what changed after clicking
agent-browser is visible ".dashboard"    # assert the dashboard appeared
agent-browser screenshot /tmp/after-login.png
```

### Verify a deployment / check prod

```bash
agent-browser open https://yourapp.com
agent-browser get text                        # read the page — does it load?
agent-browser network requests                # any failed requests?
agent-browser eval "document.title"           # correct title?
agent-browser is visible ".hero-section"      # key elements present?
agent-browser screenshot /tmp/prod-check.png
```

### Dogfood a feature end-to-end

```bash
# Navigate to the feature
agent-browser open https://app.example.com/new-feature

# Take annotated screenshot — shows every interactive element with labels
agent-browser snapshot -i
agent-browser screenshot --annotate /tmp/feature-annotated.png

# Walk through the flow
agent-browser snapshot -i          # baseline
agent-browser click @e3            # interact
agent-browser diff snapshot        # what changed? (unified diff)

# Check element states
agent-browser is visible ".success-toast"
agent-browser is enabled "#next-step-btn"
agent-browser is checked "#agree-checkbox"
```

### Test responsive layouts

```bash
# Screenshots at different viewports
agent-browser open https://yourapp.com
agent-browser set viewport 375 812
agent-browser screenshot /tmp/layout-mobile.png
agent-browser set viewport 768 1024
agent-browser screenshot /tmp/layout-tablet.png
agent-browser set viewport 1280 720
agent-browser screenshot /tmp/layout-desktop.png

# Element screenshot (crop to specific element)
agent-browser screenshot "#hero-banner" /tmp/hero.png
agent-browser snapshot -i
agent-browser screenshot @e3 /tmp/button.png
```

### Test file upload

```bash
agent-browser open https://app.example.com/upload
agent-browser snapshot -i
agent-browser upload @e3 /path/to/test-file.pdf
agent-browser is visible ".upload-success"
agent-browser screenshot /tmp/upload-result.png
```

### Test forms with validation

```bash
agent-browser open https://app.example.com/form
agent-browser snapshot -i

# Submit empty — check validation errors appear
agent-browser click @e10                        # submit button
agent-browser diff snapshot                     # diff shows error messages appeared
agent-browser is visible ".error-message"

# Fill and resubmit
agent-browser fill @e3 "valid input"
agent-browser click @e10
agent-browser diff snapshot                     # diff shows errors gone, success state
```

### Test dialogs (delete confirmations, prompts)

```bash
# Set up dialog handling BEFORE triggering
agent-browser dialog accept              # will auto-accept next alert/confirm
agent-browser click "#delete-button"     # triggers confirmation dialog
agent-browser diff snapshot              # verify the item was deleted

# For prompts that need input
agent-browser dialog accept "my answer"  # accept with text
agent-browser click "#rename-button"     # triggers prompt
```

### Compare two pages / environments

```bash
agent-browser diff url https://staging.app.com https://prod.app.com
```

## Quick Assertion Patterns

```bash
# Element exists and is visible
agent-browser is visible ".modal"

# Button is enabled
agent-browser is enabled "#submit-btn"

# Checkbox state
agent-browser is checked "#agree"

# Page contains text
agent-browser eval "document.body.textContent.includes('Success')"

# Element count
agent-browser eval "document.querySelectorAll('.list-item').length"

# Specific attribute value
agent-browser get attr "#logo" "src"

# CSS property
agent-browser get styles ".button"
```

## Snapshot System

The snapshot is your primary tool for understanding and interacting with pages.
`agent-browser snapshot` returns the full accessibility tree of the current page.

### Flags

| Flag | Long | Description |
|------|------|-------------|
| `-i` | `--interactive` | Interactive elements only (buttons, links, inputs) with @e refs |
| `-c` | `--compact` | Compact (no empty structural nodes) |
| `-s <sel>` | `--selector` | Scope to CSS selector |

All flags combine freely: `agent-browser snapshot -i -c` returns only interactive elements, with empty containers removed.

**Flag details:**
- **`-i` (interactive):** Returns only elements that accept user input: buttons, links, textboxes, checkboxes, selects, and other focusable elements. Each gets an @e ref for use in subsequent commands.
- **`-c` (compact):** Removes structural nodes (div, section, nav, etc.) that have no text content and serve only as layout containers. Reduces output noise.
- **`-s <sel>` (selector):** Scopes the tree to a subtree matching the CSS selector or @ref. Example: `snapshot -s "#sidebar"` or `snapshot -s @e5`.

### Related commands

| Command | Description |
|---------|-------------|
| `agent-browser diff snapshot` | Unified diff of current tree vs previous snapshot. Shows +added/-removed lines. Run snapshot → act → diff snapshot. |
| `agent-browser screenshot --annotate [path]` | Screenshot with numbered ref labels overlaid on each interactive element. Default path: /tmp/screenshot.png |

### @e refs

Refs are assigned sequentially (@e1, @e2, ...) in DOM tree order.
After snapshot, use @refs as selectors in any command:

```bash
agent-browser click @e3       agent-browser fill @e4 "value"     agent-browser hover @e1
agent-browser get html @e2    agent-browser get styles @e5
```

**Output format:** indented accessibility tree — role in brackets, text in quotes, attributes in brackets.
```
  @e1 [heading] "Welcome" [level=1]       ← [level=N] = heading level
  @e2 [textbox] "Email"                    ← label text in quotes
  @e3 [button] "Submit"
    @e4 [link] "Learn more" [href=/docs]   ← indentation shows nesting
```

**Important:** Refs are invalidated on navigation — run `snapshot` again after `open` or any action that causes a page load.

## Command Reference

### Navigation
| Command | Description |
|---------|-------------|
| `click <sel>` | Click element |
| `dblclick <sel>` | Double-click element |
| `drag <from> <to>` | Drag element to target |
| `focus <sel>` | Focus element |
| `open <url>` | Navigate to URL |

### Reading
| Command | Description |
|---------|-------------|
| `get attr <sel> <attr>` | Get attribute value of element |
| `get box <sel>` | Get bounding box of element |
| `get count <sel>` | Count matching elements |
| `get html [sel]` | Get innerHTML of element or full page HTML |
| `get styles <sel>` | Get computed CSS styles of element |
| `get text [sel]` | Get text content of page or element |
| `get title` | Get page title |
| `get url` | Get current page URL |
| `get value <sel>` | Get value of input element |

### Interaction
| Command | Description |
|---------|-------------|
| `check <sel>` | Check a checkbox |
| `fill <sel> <val>` | Clear and fill input |
| `hover <sel>` | Hover over element |
| `press <key>` | Press keyboard key. Valid keys: Enter, Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, PageUp, PageDown, Space, F1-F12. Supports modifiers: Control+a, Shift+Enter, Meta+c |
| `scroll [direction] [amount]` | Scroll page. Direction: up, down, left, right. Amount: pixels (default 300). Examples: `scroll down 500`, `scroll up` |
| `scrollintoview <sel>` | Scroll element into view |
| `select <sel> <val>` | Select dropdown option |
| `type <sel> <text>` | Type text into focused element (appends) |
| `uncheck <sel>` | Uncheck a checkbox |
| `upload <sel> <file>` | Upload file to file input |
| `wait <sel|ms> [--text <text>|--url <pat>|--load|--fn <expr>|--state <state>]` | Wait for condition (max 10s). Modes: `wait <sel>` element exists, `wait <ms>` timeout, `wait --text <text>` page contains text, `wait --url <pattern>` URL matches, `wait --load` page load complete, `wait --fn <expr>` JS expression truthy, `wait --state <state>` element state (visible/hidden/enabled/disabled) |

### Inspection
| Command | Description |
|---------|-------------|
| `eval <expr>` | Run JavaScript expression and return result |
| `is checked <sel>` | Check if checkbox/radio is checked |
| `is enabled <sel>` | Check if element is enabled |
| `is visible <sel>` | Check if element is visible |

### Storage
| Command | Description |
|---------|-------------|
| `cookies clear` | Clear all cookies |
| `cookies get` | Get all cookies as JSON |
| `cookies set <name>=<value> [domain]` | Set a cookie. Domain defaults to current page domain |
| `storage local clear` | Clear localStorage |
| `storage local get [key]` | Get localStorage value |
| `storage local set <key> <value>` | Set localStorage value |
| `storage session clear` | Clear sessionStorage |
| `storage session get [key]` | Get sessionStorage value |
| `storage session set <key> <value>` | Set sessionStorage value |

### Network
| Command | Description |
|---------|-------------|
| `network requests` | List captured network requests |
| `network route <pattern> [response-json]` | Intercept and mock network requests. Pattern is a URL glob (e.g., `**/api/users`). Response is JSON: `{"status":200,"body":"...","headers":{}}` |
| `network unroute <pattern>` | Remove network interception |

### Config
| Command | Description |
|---------|-------------|
| `set credentials <user> <pass>` | Set HTTP auth credentials |
| `set device <name>` | Emulate device (e.g., iPhone 14) |
| `set geo <lat> <lng>` | Set geolocation |
| `set headers <name>:<value>` | Set custom request headers |
| `set media <feature> <value>` | Set CSS media feature. Features: prefers-color-scheme (light/dark), prefers-reduced-motion (reduce/no-preference), forced-colors (active/none) |
| `set offline [true|false]` | Toggle offline mode |
| `set viewport <width> <height>` | Set viewport size |

### Dialog
| Command | Description |
|---------|-------------|
| `dialog accept [text]` | Accept next alert/confirm/prompt |
| `dialog dismiss` | Dismiss next dialog |

### Visual
| Command | Description |
|---------|-------------|
| `diff screenshot` | Visual pixel diff between current screenshot and previous. Highlights changed regions |
| `diff snapshot` | Unified diff of current accessibility tree vs previous snapshot. Shows added/removed/changed elements. Run snapshot first, then act, then diff snapshot |
| `diff url <url1> <url2>` | Diff text content between two URLs |
| `pdf [path]` | Save page as PDF |
| `screenshot [--annotate] [--full] [sel] [path]` | Save screenshot. --annotate overlays ref labels on interactive elements. --full captures entire scrollable page. Provide sel/@ref to crop to one element. Path defaults to /tmp/screenshot.png |

### Snapshot
| Command | Description |
|---------|-------------|
| `snapshot [-i] [-c] [-s <sel>]` | Full accessibility tree with @e refs for element selection. Without flags: returns complete DOM tree. Flags: -i (interactive elements only — buttons, links, inputs), -c (compact — omit empty structural nodes), -s <sel> (scope to CSS selector or @ref) |

### Find
| Command | Description |
|---------|-------------|
| `find alt <text> [action]` | Find element by alt text. Action: click, fill, hover, or omit to locate |
| `find label <label> [action]` | Find element by associated label text. Action: click, fill, hover, or omit to locate |
| `find placeholder <text> [action]` | Find element by placeholder text. Action: click, fill, hover, or omit to locate |
| `find role <role> [action]` | Find element by ARIA role (e.g., button, link, textbox, heading). Action: click, fill, hover, or omit to just locate |
| `find testid <id> [action]` | Find element by data-testid. Action: click, fill, hover, or omit to locate |
| `find text <text> [action]` | Find element by visible text content. Action: click, fill, hover, or omit to locate |
| `find title <text> [action]` | Find element by title attribute. Action: click, fill, hover, or omit to locate |

### Tabs
| Command | Description |
|---------|-------------|
| `tab` | List open tabs |
| `tab close [id]` | Close tab |
| `tab new [url]` | Open new tab |
| `tab switch <id>` | Switch to tab |
| `window new` | Open new browser window |

### Frames
| Command | Description |
|---------|-------------|
| `frame <sel>` | Switch to iframe |
| `frame main` | Switch back to main frame |

### Lifecycle
| Command | Description |
|---------|-------------|
| `close` | Close browser session |
| `connect <url>` | Connect to remote browser |

## Tips

1. **Navigate once, query many times.** `open` loads the page; then `get text`, `eval`, `screenshot` all hit the loaded page instantly.
2. **Use `snapshot -i` first.** See all interactive elements, then click/fill by ref. No CSS selector guessing.
3. **Use `diff snapshot` to verify.** Baseline → action → diff. See exactly what changed.
4. **Use `is` for assertions.** `is visible .modal` is faster and more reliable than parsing page text.
5. **Use `screenshot --annotate` for evidence.** Annotated screenshots are great for bug reports.
