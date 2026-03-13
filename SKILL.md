---
name: gstack
version: 1.1.0
description: |
  Fast headless browser for QA testing and site dogfooding. Navigate any URL, interact with
  elements, verify page state, diff before/after actions, take annotated screenshots, check
  responsive layouts, test forms and uploads, handle dialogs, and assert element states.
  ~100ms per command. Use when you need to test a feature, verify a deployment, dogfood a
  user flow, or file a bug with evidence.
allowed-tools:
  - Bash
  - Read

---

# gstack browse: QA Testing & Dogfooding

Persistent headless Chromium. First call auto-starts (~3s), then ~100-200ms per command.
Auto-shuts down after 30 min idle. State persists between calls (cookies, tabs, sessions).

## SETUP (run this check BEFORE any browse command)

```bash
B=$(browse/bin/find-browse 2>/dev/null || ~/.claude/skills/gstack/browse/bin/find-browse 2>/dev/null)
if [ -n "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

## IMPORTANT

- Use the compiled binary via Bash: `$B <command>`
- NEVER use `mcp__claude-in-chrome__*` tools. They are slow and unreliable.
- Browser persists between calls — cookies, login sessions, and tabs carry over.
- Dialogs (alert/confirm/prompt) are auto-accepted by default — no browser lockup.

## QA Workflows

### Test a user flow (login, signup, checkout, etc.)

```bash
B=~/.claude/skills/gstack/browse/dist/browse

# 1. Go to the page
$B goto https://app.example.com/login

# 2. See what's interactive
$B snapshot -i

# 3. Fill the form using refs
$B fill @e3 "test@example.com"
$B fill @e4 "password123"
$B click @e5

# 4. Verify it worked
$B snapshot -D              # diff shows what changed after clicking
$B is visible ".dashboard"  # assert the dashboard appeared
$B screenshot /tmp/after-login.png
```

### Verify a deployment / check prod

```bash
$B goto https://yourapp.com
$B text                          # read the page — does it load?
$B console                       # any JS errors?
$B network                       # any failed requests?
$B js "document.title"           # correct title?
$B is visible ".hero-section"    # key elements present?
$B screenshot /tmp/prod-check.png
```

### Dogfood a feature end-to-end

```bash
# Navigate to the feature
$B goto https://app.example.com/new-feature

# Take annotated screenshot — shows every interactive element with labels
$B snapshot -i -a -o /tmp/feature-annotated.png

# Find ALL clickable things (including divs with cursor:pointer)
$B snapshot -C

# Walk through the flow
$B snapshot -i          # baseline
$B click @e3            # interact
$B snapshot -D          # what changed? (unified diff)

# Check element states
$B is visible ".success-toast"
$B is enabled "#next-step-btn"
$B is checked "#agree-checkbox"

# Check console for errors after interactions
$B console
```

### Test responsive layouts

```bash
# Quick: 3 screenshots at mobile/tablet/desktop
$B goto https://yourapp.com
$B responsive /tmp/layout

# Manual: specific viewport
$B viewport 375x812     # iPhone
$B screenshot /tmp/mobile.png
$B viewport 1440x900    # Desktop
$B screenshot /tmp/desktop.png
```

### Test file upload

```bash
$B goto https://app.example.com/upload
$B snapshot -i
$B upload @e3 /path/to/test-file.pdf
$B is visible ".upload-success"
$B screenshot /tmp/upload-result.png
```

### Test forms with validation

```bash
$B goto https://app.example.com/form
$B snapshot -i

# Submit empty — check validation errors appear
$B click @e10                        # submit button
$B snapshot -D                       # diff shows error messages appeared
$B is visible ".error-message"

# Fill and resubmit
$B fill @e3 "valid input"
$B click @e10
$B snapshot -D                       # diff shows errors gone, success state
```

### Test dialogs (delete confirmations, prompts)

```bash
# Set up dialog handling BEFORE triggering
$B dialog-accept              # will auto-accept next alert/confirm
$B click "#delete-button"     # triggers confirmation dialog
$B dialog                     # see what dialog appeared
$B snapshot -D                # verify the item was deleted

# For prompts that need input
$B dialog-accept "my answer"  # accept with text
$B click "#rename-button"     # triggers prompt
```

### Test authenticated pages (import real browser cookies)

```bash
# Import cookies from your real browser (opens interactive picker)
$B cookie-import-browser

# Or import a specific domain directly
$B cookie-import-browser comet --domain .github.com

# Now test authenticated pages
$B goto https://github.com/settings/profile
$B snapshot -i
$B screenshot /tmp/github-profile.png
```

### Compare two pages / environments

```bash
$B diff https://staging.app.com https://prod.app.com
```

### Multi-step chain (efficient for long flows)

```bash
echo '[
  ["goto","https://app.example.com"],
  ["snapshot","-i"],
  ["fill","@e3","test@test.com"],
  ["fill","@e4","password"],
  ["click","@e5"],
  ["snapshot","-D"],
  ["screenshot","/tmp/result.png"]
]' | $B chain
```

## Quick Assertion Patterns

```bash
# Element exists and is visible
$B is visible ".modal"

# Button is enabled/disabled
$B is enabled "#submit-btn"
$B is disabled "#submit-btn"

# Checkbox state
$B is checked "#agree"

# Input is editable
$B is editable "#name-field"

# Element has focus
$B is focused "#search-input"

# Page contains text
$B js "document.body.textContent.includes('Success')"

# Element count
$B js "document.querySelectorAll('.list-item').length"

# Specific attribute value
$B attrs "#logo"    # returns all attributes as JSON

# CSS property
$B css ".button" "background-color"
```

## Snapshot System

The snapshot is your primary tool for understanding and interacting with pages.

```bash
$B snapshot -i           # Interactive elements only (buttons, links, inputs) with @e refs
$B snapshot -c           # Compact (no empty structural elements)
$B snapshot -d 3         # Limit depth to 3 levels
$B snapshot -s "main"    # Scope to CSS selector
$B snapshot -D           # Diff against previous snapshot (what changed?)
$B snapshot -a           # Annotated screenshot with ref labels
$B snapshot -o /tmp/x.png  # Output path for annotated screenshot
$B snapshot -C           # Cursor-interactive elements (@c refs — divs with pointer, onclick)
```

Combine flags: `$B snapshot -i -a -C -o /tmp/annotated.png`

After snapshot, use @refs everywhere:
```bash
$B click @e3       $B fill @e4 "value"     $B hover @e1
$B html @e2        $B css @e5 "color"      $B attrs @e6
$B click @c1       # cursor-interactive ref (from -C)
```

Refs are invalidated on navigation — run `snapshot` again after `goto`.

## Command Reference

### Navigation
| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL |
| `back` / `forward` | History navigation |
| `reload` | Reload page |
| `url` | Print current URL |

### Reading
| Command | Description |
|---------|-------------|
| `text` | Cleaned page text |
| `html [selector]` | innerHTML |
| `links` | All links as "text -> href" |
| `forms` | Forms + fields as JSON |
| `accessibility` | Full ARIA tree |

### Interaction
| Command | Description |
|---------|-------------|
| `click <sel>` | Click element |
| `fill <sel> <val>` | Fill input |
| `select <sel> <val>` | Select dropdown |
| `hover <sel>` | Hover element |
| `type <text>` | Type into focused element |
| `press <key>` | Press key (Enter, Tab, Escape) |
| `scroll [sel]` | Scroll element into view |
| `wait <sel>` | Wait for element (max 10s) |
| `wait --networkidle` | Wait for network to be idle |
| `wait --load` | Wait for page load event |
| `upload <sel> <file...>` | Upload file(s) |
| `cookie-import <json>` | Import cookies from JSON file |
| `cookie-import-browser [browser] [--domain <d>]` | Import cookies from real browser (opens picker UI, or direct import with --domain) |
| `dialog-accept [text]` | Auto-accept dialogs |
| `dialog-dismiss` | Auto-dismiss dialogs |
| `viewport <WxH>` | Set viewport size |

### Inspection
| Command | Description |
|---------|-------------|
| `js <expr>` | Run JavaScript |
| `eval <file>` | Run JS file |
| `css <sel> <prop>` | Computed CSS |
| `attrs <sel>` | Element attributes |
| `is <prop> <sel>` | State check (visible/hidden/enabled/disabled/checked/editable/focused) |
| `console [--clear\|--errors]` | Console messages (--errors filters to error/warning) |
| `network [--clear]` | Network requests |
| `dialog [--clear]` | Dialog messages |
| `cookies` | All cookies |
| `storage` | localStorage + sessionStorage |
| `perf` | Page load timings |

### Visual
| Command | Description |
|---------|-------------|
| `screenshot [path]` | Screenshot |
| `pdf [path]` | Save as PDF |
| `responsive [prefix]` | Mobile/tablet/desktop screenshots |
| `diff <url1> <url2>` | Text diff between pages |

### Tabs
| Command | Description |
|---------|-------------|
| `tabs` | List tabs |
| `tab <id>` | Switch tab |
| `newtab [url]` | Open tab |
| `closetab [id]` | Close tab |

### Server
| Command | Description |
|---------|-------------|
| `status` | Health check |
| `stop` | Shutdown |
| `restart` | Restart |

## Tips

1. **Navigate once, query many times.** `goto` loads the page; then `text`, `js`, `screenshot` all hit the loaded page instantly.
2. **Use `snapshot -i` first.** See all interactive elements, then click/fill by ref. No CSS selector guessing.
3. **Use `snapshot -D` to verify.** Baseline → action → diff. See exactly what changed.
4. **Use `is` for assertions.** `is visible .modal` is faster and more reliable than parsing page text.
5. **Use `snapshot -a` for evidence.** Annotated screenshots are great for bug reports.
6. **Use `snapshot -C` for tricky UIs.** Finds clickable divs that the accessibility tree misses.
7. **Check `console` after actions.** Catch JS errors that don't surface visually.
8. **Use `chain` for long flows.** Single command, no per-step CLI overhead.
