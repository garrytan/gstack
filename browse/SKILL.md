---
name: browse
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
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# browse: QA Testing & Dogfooding

Persistent headless Chromium. First call auto-starts (~3s), then ~100ms per command.
State persists between calls (cookies, tabs, login sessions).

## Core QA Patterns

### 1. Verify a page loads correctly
```bash
$B goto https://yourapp.com
$B text                          # content loads?
$B console                       # JS errors?
$B network                       # failed requests?
$B is visible ".main-content"    # key elements present?
```

### 2. Test a user flow
```bash
$B goto https://app.com/login
$B snapshot -i                   # see all interactive elements
$B fill @e3 "user@test.com"
$B fill @e4 "password"
$B click @e5                     # submit
$B snapshot -D                   # diff: what changed after submit?
$B is visible ".dashboard"       # success state present?
```

### 3. Verify an action worked
```bash
$B snapshot                      # baseline
$B click @e3                     # do something
$B snapshot -D                   # unified diff shows exactly what changed
```

### 4. Visual evidence for bug reports
```bash
$B snapshot -i -a -o /tmp/annotated.png   # labeled screenshot
$B screenshot /tmp/bug.png                # plain screenshot
$B console                                # error log
```

### 5. Find all clickable elements (including non-ARIA)
```bash
$B snapshot -C                   # finds divs with cursor:pointer, onclick, tabindex
$B click @c1                     # interact with them
```

### 6. Assert element states
```bash
$B is visible ".modal"
$B is enabled "#submit-btn"
$B is disabled "#submit-btn"
$B is checked "#agree-checkbox"
$B is editable "#name-field"
$B is focused "#search-input"
$B js "document.body.textContent.includes('Success')"
```

### 7. Test responsive layouts
```bash
$B responsive /tmp/layout        # mobile + tablet + desktop screenshots
$B viewport 375x812              # or set specific viewport
$B screenshot /tmp/mobile.png
```

### 8. Test file uploads
```bash
$B upload "#file-input" /path/to/file.pdf
$B is visible ".upload-success"
```

### 9. Test dialogs
```bash
$B dialog-accept "yes"           # set up handler
$B click "#delete-button"        # trigger dialog
$B dialog                        # see what appeared
$B snapshot -D                   # verify deletion happened
```

### 10. Compare environments
```bash
$B diff https://staging.app.com https://prod.app.com
```

## Snapshot Flags

The snapshot is your primary tool for understanding and interacting with pages.

```
-i        Interactive elements only (buttons, links, inputs) with @e refs
-c        Compact (no empty structural nodes)
-d <N>    Limit depth
-s <sel>  Scope to CSS selector
-D        Diff against previous snapshot (what changed?)
-a        Annotated screenshot with ref labels
-o <path> Output path for screenshot
-C        Cursor-interactive elements (@c refs — divs with pointer, onclick)
```

Combine flags: `$B snapshot -i -a -C -o /tmp/annotated.png`

After snapshot, use @refs everywhere:
```bash
$B click @e3       $B fill @e4 "value"     $B hover @e1
$B html @e2        $B css @e5 "color"      $B attrs @e6
$B click @c1       # cursor-interactive ref (from -C)
```

Refs are invalidated on navigation — run `snapshot` again after `goto`.

## Full Command List

### Navigation
| Command | Description |
|---------|-------------|
| `back` | History back |
| `forward` | History forward |
| `goto <url>` | Navigate to URL |
| `reload` | Reload page |
| `url` | Print current URL |

### Reading
| Command | Description |
|---------|-------------|
| `accessibility` | Full ARIA tree |
| `forms` | Form fields as JSON |
| `html [selector]` | innerHTML |
| `links` | All links as "text → href" |
| `text` | Cleaned page text |

### Interaction
| Command | Description |
|---------|-------------|
| `click <sel>` | Click element |
| `cookie` | Set cookie |
| `cookie-import <json>` | Import cookies from JSON file |
| `cookie-import-browser [browser] [--domain d]` | Import cookies from real browser (opens picker UI, or direct with --domain) |
| `dialog-accept [text]` | Auto-accept next alert/confirm/prompt |
| `dialog-dismiss` | Auto-dismiss next dialog |
| `fill <sel> <val>` | Fill input |
| `header <name> <value>` | Set custom request header |
| `hover <sel>` | Hover element |
| `press <key>` | Press key (Enter, Tab, Escape, etc.) |
| `scroll [sel]` | Scroll element into view |
| `select <sel> <val>` | Select dropdown option |
| `type <text>` | Type into focused element |
| `upload <sel> <file...>` | Upload file(s) |
| `useragent <string>` | Set user agent |
| `viewport <WxH>` | Set viewport size |
| `wait <sel|--networkidle|--load>` | Wait for element/condition |

### Inspection
| Command | Description |
|---------|-------------|
| `attrs <sel|@ref>` | Element attributes as JSON |
| `console [--clear|--errors]` | Console messages (--errors filters to error/warning) |
| `cookies` | All cookies as JSON |
| `css <sel> <prop>` | Computed CSS value |
| `dialog [--clear]` | Dialog messages |
| `eval <file>` | Run JS file |
| `is <prop> <sel>` | State check (visible/hidden/enabled/disabled/checked/editable/focused) |
| `js <expr>` | Run JavaScript |
| `network [--clear]` | Network requests |
| `perf` | Page load timings |
| `storage [set k v]` | localStorage + sessionStorage |

### Visual
| Command | Description |
|---------|-------------|
| `diff <url1> <url2>` | Text diff between pages |
| `pdf [path]` | Save as PDF |
| `responsive [prefix]` | Mobile/tablet/desktop screenshots |
| `screenshot [path]` | Save screenshot |

### Snapshot
| Command | Description |
|---------|-------------|
| `snapshot [flags]` | Accessibility tree with @refs |

### Meta
| Command | Description |
|---------|-------------|
| `chain` | Multi-command from JSON stdin |

### Tabs
| Command | Description |
|---------|-------------|
| `closetab [id]` | Close tab |
| `newtab [url]` | Open new tab |
| `tab <id>` | Switch to tab |
| `tabs` | List open tabs |

### Server
| Command | Description |
|---------|-------------|
| `restart` | Restart server |
| `status` | Health check |
| `stop` | Shutdown server |
