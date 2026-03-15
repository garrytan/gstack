---
name: setup-browser-cookies
version: 2.0.0
description: |
  Import cookies into the agent-browser session. Use before QA testing authenticated
  pages. Supports importing from a JSON cookie file or setting individual cookies.
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

# Setup Browser Cookies

Import cookies into the agent-browser session for testing authenticated pages.

## How it works

1. Check that agent-browser is installed
2. Import cookies from a JSON file or set them individually
3. Navigate to the target site to verify authentication

## Steps

### 1. Find agent-browser

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

### 2. Import cookies from JSON file

If the user has a cookie JSON file (e.g., exported from a browser extension):

```bash
agent-browser cookies set <name>=<value>
```

For bulk import, read the JSON file and set each cookie.

### 3. Import cookies by domain

If the user specifies a domain directly (e.g., `/setup-browser-cookies github.com`):

Ask the user to export their cookies for that domain using a browser extension (e.g., "EditThisCookie", "Cookie-Editor") and save as JSON.

### 4. Verify

After importing cookies:

```bash
agent-browser cookies get
```

Show the user a summary of imported cookies (domain counts).

Then navigate to the target authenticated page to verify:

```bash
agent-browser open <target-url>
agent-browser snapshot -i
agent-browser screenshot /tmp/auth-verify.png
```

## Notes

- The agent-browser session persists cookies between commands, so imported cookies work immediately
- Cookies persist until the session ends or they are explicitly cleared with `agent-browser cookies clear`
