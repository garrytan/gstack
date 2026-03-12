---
name: browse
version: 1.0.0
model: sonnet
description: |
  Fast web browsing for Claude Code via persistent headless Chromium daemon. Navigate to any URL,
  read page content, click elements, fill forms, run JavaScript, take screenshots,
  inspect CSS/DOM, capture console/network logs, and more. ~100ms per command after
  first call. Use when you need to check a website, verify a deployment, read docs,
  or interact with any web page. No MCP, no Chrome extension — just fast CLI.
allowed-tools:
  - Bash
  - Read

---

# gstack: Persistent Browser for Claude Code

Persistent headless Chromium daemon. First call auto-starts the server (~3s).
Every subsequent call: ~100-200ms. Auto-shuts down after 30 min idle.

## SETUP (run this check BEFORE any browse command)

Before using any browse command, find the skill and check if the binary exists:

```bash
# Check project-level first, then user-level
if test -x .claude/skills/gstack/browse/dist/browse; then
  echo "READY_PROJECT"
elif test -x ~/.claude/skills/gstack/browse/dist/browse; then
  echo "READY_USER"
else
  echo "NEEDS_SETUP"
fi
```

Set `B` to whichever path is READY and use it for all commands. Prefer project-level if both exist.

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait for their response.
2. If they approve, determine the skill directory (project-level `.claude/skills/gstack` or user-level `~/.claude/skills/gstack`) and run:
```bash
cd <SKILL_DIR> && ./setup
```
3. If `bun` is not installed, tell the user to install it: `curl -fsSL https://bun.sh/install | bash`
4. Verify the `.gitignore` in the skill directory contains `browse/dist/` and `node_modules/`. If either line is missing, add it.

Once setup is done, it never needs to run again (the compiled binary persists).

## IMPORTANT

- Use the compiled binary via Bash: `.claude/skills/gstack/browse/dist/browse` (project) or `~/.claude/skills/gstack/browse/dist/browse` (user).
- NEVER use `mcp__claude-in-chrome__*` tools. They are slow and unreliable.
- The browser persists between calls — cookies, tabs, and state carry over.
- The server auto-starts on first command. No setup needed.

## Quick Reference

```bash
B=~/.claude/skills/gstack/browse/dist/browse

# Navigate to a page
$B goto https://example.com

# Read cleaned page text
$B text

# Take a screenshot (then Read the image)
$B screenshot /tmp/page.png

# Snapshot: accessibility tree with refs
$B snapshot -i

# Click by ref (after snapshot)
$B click @e3

# Fill by ref
$B fill @e4 "test@test.com"

# Run JavaScript
$B js "document.title"

# Get all links
$B links

# Click by CSS selector
$B click "button.submit"

# Fill a form by CSS selector
$B fill "#email" "test@test.com"
$B fill "#password" "abc123"
$B click "button[type=submit]"

# Get HTML of an element
$B html "main"

# Get computed CSS
$B css "body" "font-family"

# Get element attributes
$B attrs "nav"

# Wait for element to appear
$B wait ".loaded"

# Accessibility tree
$B accessibility

# Set viewport
$B viewport 375x812

# Set cookies / headers
$B cookie "session=abc123"
$B header "Authorization:Bearer token123"
```

## Command Reference

### Navigation
```
browse goto <url>         Navigate current tab
browse back               Go back
browse forward            Go forward
browse reload             Reload page
browse url                Print current URL
```

### Content extraction
```
browse text               Cleaned page text (no scripts/styles)
browse html [selector]    innerHTML of element, or full page HTML
browse links              All links as "text → href"
browse forms              All forms + fields as JSON
browse accessibility      Accessibility tree snapshot (ARIA)
```

### Snapshot (ref-based element selection)
```
browse snapshot           Full accessibility tree with @refs
browse snapshot -i        Interactive elements only (buttons, links, inputs)
browse snapshot -c        Compact (no empty structural elements)
browse snapshot -d <N>    Limit depth to N levels
browse snapshot -s <sel>  Scope to CSS selector
```

After snapshot, use @refs as selectors in any command:
```
browse click @e3          Click the element assigned ref @e3
browse fill @e4 "value"   Fill the input assigned ref @e4
browse hover @e1          Hover the element assigned ref @e1
browse html @e2           Get innerHTML of ref @e2
browse css @e5 "color"    Get computed CSS of ref @e5
browse attrs @e6          Get attributes of ref @e6
```

Refs are invalidated on navigation — run `snapshot` again after `goto`.

### Interaction
```
browse click <selector>        Click element (CSS selector or @ref)
browse fill <selector> <value> Fill input field
browse select <selector> <val> Select dropdown value
browse hover <selector>        Hover over element
browse type <text>             Type into focused element
browse press <key>             Press key (Enter, Tab, Escape, etc.)
browse scroll [selector]       Scroll element into view, or page bottom
browse wait <selector>         Wait for element to appear (max 10s)
browse viewport <WxH>          Set viewport size (e.g. 375x812)
```

### Inspection
```
browse js <expression>         Run JS, print result
browse eval <js-file>          Run JS file against page
browse css <selector> <prop>   Get computed CSS property
browse attrs <selector>        Get element attributes as JSON
browse console                 Dump captured console messages
browse console --clear         Clear console buffer
browse network                 Dump captured network requests
browse network --clear         Clear network buffer
browse cookies                 Dump all cookies as JSON
browse storage                 localStorage + sessionStorage as JSON
browse storage set <key> <val> Set localStorage value
browse perf                    Page load performance timings
```

### Visual
```
browse screenshot [path]       Screenshot (default: /tmp/browse-screenshot.png)
browse pdf [path]              Save as PDF
browse responsive [prefix]     Screenshots at mobile/tablet/desktop
```

### Compare
```
browse diff <url1> <url2>      Text diff between two pages
```

### Multi-step (chain)
```
echo '[["goto","https://example.com"],["snapshot","-i"],["click","@e1"],["screenshot","/tmp/result.png"]]' | browse chain
```

### Tabs
```
browse tabs                    List tabs (id, url, title)
browse tab <id>                Switch to tab
browse newtab [url]            Open new tab
browse closetab [id]           Close tab
```

### Server management
```
browse status                  Server health, uptime, tab count
browse stop                    Shutdown server
browse restart                 Kill + restart server
```

## Speed Rules

1. **Navigate once, query many times.** `goto` loads the page; then `text`, `js`, `css`, `screenshot` all run against the loaded page instantly.
2. **Use `snapshot -i` for interaction.** Get refs for all interactive elements, then click/fill by ref. No need to guess CSS selectors.
3. **Use `js` for precision.** `js "document.querySelector('.price').textContent"` is faster than parsing full page text.
4. **Use `links` to survey.** Faster than `text` when you just need navigation structure.
5. **Use `chain` for multi-step flows.** Avoids CLI overhead per step.
6. **Use `responsive` for layout checks.** One command = 3 viewport screenshots.

## When to Use What

| Task | Commands |
|------|----------|
| Read a page | `goto <url>` then `text` |
| Interact with elements | `snapshot -i` then `click @e3` |
| Check if element exists | `js "!!document.querySelector('.thing')"` |
| Extract specific data | `js "document.querySelector('.price').textContent"` |
| Visual check | `screenshot /tmp/x.png` then Read the image |
| Fill and submit form | `snapshot -i` → `fill @e4 "val"` → `click @e5` → `screenshot` |
| Check CSS | `css "selector" "property"` or `css @e3 "property"` |
| Inspect DOM | `html "selector"` or `attrs @e3` |
| Debug console errors | `console` |
| Check network requests | `network` |
| Check local dev | `goto http://127.0.0.1:3000` |
| Compare two pages | `diff <url1> <url2>` |
| Mobile layout check | `responsive /tmp/prefix` |
| Multi-step flow | `echo '[...]' \| browse chain` |

## Architecture

- Persistent Chromium daemon on localhost (port 9400-9410)
- Bearer token auth per session
- State file: `/tmp/browse-server.json`
- Console log: `/tmp/browse-console.log`
- Network log: `/tmp/browse-network.log`
- Auto-shutdown after 30 min idle
- Chromium crash → server exits → auto-restarts on next command
