
# /connect: Connect build-os to External Services

This is a one-time setup skill. Run it once per device. After it completes, every other skill will automatically have Notion, Calendar, and email context.

---

## What this sets up

1. **Notion** — primary data store. All decisions, RFIs, site reports, and budget entries write to Notion. Your whole team sees the same live project state.
2. **Google Calendar** — two-way. build-os writes milestone dates, bid deadlines, and inspection dates. You see upcoming project events at every session start.
3. **Gmail** — one-way read. `/email-scan` scans for decision-worthy contractor emails. The same Google OAuth covers Calendar and Gmail.
4. **Granola → Notion** — you configure this in Granola settings. Every meeting gets exported to Notion automatically, then `/import-notes` imports the structured entries.
5. **Session-start hook** — a shell script that runs every time you open Claude Code in a project folder. Pulls today's calendar events, open Notion items, and flagged emails into `.build-os/daily-context.md`.

---

## Step 1: Notion setup

**1a. Create a Notion integration:**
1. Go to https://www.notion.so/my-integrations
2. Click "New integration"
3. Name it "build-os"
4. Select the workspace where your project databases will live
5. Copy the "Internal Integration Token" (starts with `secret_`)

**1b. Create the five Notion databases:**

build-os expects these databases in your Notion workspace. Create them manually OR let build-os create them for you.

Ask: "Do you want me to create the Notion databases automatically using the Notion MCP, or will you create them manually?"

If automatically: use the Notion MCP tools to create:
- **Projects** — properties: Name (title), Type (select), Location (text), Budget (number), Phase (text), Status (select)
- **Decisions** — properties: Date (date), Phase (text), Decision (title), Rationale (text), Cost Impact (text), Responsible (text), Change Order (checkbox), Project (relation → Projects)
- **Site Reports** — properties: Date (date), Visit# (number), Observations (title), Open Items (text), Project (relation → Projects)
- **RFIs** — properties: Number (number), Date (date), Subject (title), Question (text), Suggested Answer (text), Status (select), Response Due (date), Project (relation → Projects)
- **Budget** — properties: Category (title), Line Item (text), Estimate (number), Actual (number), Variance (formula: actual - estimate), Project (relation → Projects)

**1c. Write the Notion API key:**

```bash
mkdir -p "${HOME}/.build-os"
echo "Notion API key will be stored in ~/.build-os/credentials.yaml"
echo "Do NOT commit this file to git."
```

Store the integration token in `~/.build-os/credentials.yaml`:
```yaml
notion_api_key: "secret_..."
notion_projects_db_id: "..."
notion_decisions_db_id: "..."
notion_site_reports_db_id: "..."
notion_rfis_db_id: "..."
notion_budget_db_id: "..."
```

**1d. Add MCP config to Claude Code settings:**

Add to `.claude/settings.json` in the current project folder:
```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/mcp-server"],
      "env": { "NOTION_API_KEY": "secret_..." }
    }
  }
}
```

Ask the owner to paste their actual Notion API key. Write the config with the real key.

---

## Step 2: Google OAuth (covers Calendar + Gmail)

**2a. Create Google Cloud credentials:**
1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one)
3. Enable: Google Calendar API, Gmail API
4. Create OAuth 2.0 credentials (type: Desktop application)
5. Download the credentials JSON file
6. Note the path where you saved it (e.g., `~/Downloads/credentials.json`)

**2b. Add Calendar and Gmail MCP config:**

Add to `.claude/settings.json`:
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-google-calendar"],
      "env": { "GOOGLE_CREDENTIALS_PATH": "~/path/to/credentials.json" }
    },
    "gmail": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-gmail"],
      "env": { "GMAIL_CREDENTIALS_PATH": "~/path/to/credentials.json" }
    }
  }
}
```

Ask the owner where they saved the credentials file. Write the config with the actual path.

**Note:** First use of the Calendar and Gmail MCP will open a browser to complete OAuth authorization. This is expected.

---

## Step 3: Granola → Notion

Granola records your meetings and can export notes to Notion automatically.

**3a. Enable Granola's Notion export:**
1. Open Granola
2. Go to Settings → Integrations
3. Connect to Notion (authorize with the same workspace)
4. Set the export destination to the Notion workspace used in Step 1

After this is configured, every meeting recorded in Granola will automatically appear as a new page in your Notion workspace. Run `/import-notes` to classify and import those pages into the structured databases.

If you don't use Granola, skip this step. You can still use `/import-notes` with any notes you've manually added to Notion.

---

## Step 4: Install the session-start hook

The session-start hook is a shell script that runs every time Claude Code opens in a project folder. It populates `.build-os/daily-context.md` with today's calendar events, open Notion items, and flagged emails.

```bash
mkdir -p .build-os/hooks

cat > .build-os/hooks/session-start.sh << 'HOOKEOF'
#!/usr/bin/env bash
# build-os session-start hook
# Runs automatically when Claude Code opens in this project folder.
# Writes .build-os/daily-context.md with today's project context.
set -euo pipefail

PROJECT_NAME=$(grep "^name:" .build-os/config.yaml 2>/dev/null | sed 's/^name: *//' | tr -d '"'"'"' || echo "Unknown")
SLUG=$(echo "${PROJECT_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\|-$//g')
CREDENTIALS="${HOME}/.build-os/credentials.yaml"
CONTEXT_FILE=".build-os/daily-context.md"
TODAY=$(date +%Y-%m-%d)

echo "# build-os Daily Context — ${TODAY}" > "${CONTEXT_FILE}"
echo "**Project:** ${PROJECT_NAME} | **Generated:** $(date +%H:%M)" >> "${CONTEXT_FILE}"
echo "" >> "${CONTEXT_FILE}"

# Placeholder sections — filled in by Claude using MCP tools when /daily-brief runs
echo "## Today's Events" >> "${CONTEXT_FILE}"
echo "_Run /daily-brief to load calendar events_" >> "${CONTEXT_FILE}"
echo "" >> "${CONTEXT_FILE}"
echo "## Open Items from Notion" >> "${CONTEXT_FILE}"
echo "_Run /daily-brief to load open items_" >> "${CONTEXT_FILE}"
echo "" >> "${CONTEXT_FILE}"
echo "## Flagged Emails" >> "${CONTEXT_FILE}"
echo "_Run /daily-brief or /email-scan to check for flagged emails_" >> "${CONTEXT_FILE}"

echo "build-os: context file initialized. Run /daily-brief to populate."
HOOKEOF

chmod +x .build-os/hooks/session-start.sh
echo "Hook script written."
```

Register the hook in `.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bash .build-os/hooks/session-start.sh" }]
      }
    ]
  }
}
```

---

## Step 5: Verify the setup

Test each integration:

**Notion:** Use the Notion MCP to query the Projects database. Confirm a connection.
**Calendar:** Use the Google Calendar MCP to list today's events. Confirm OAuth completes.
**Gmail:** Use the Gmail MCP to list recent emails. Confirm access.
**Hook:** Confirm `.build-os/hooks/session-start.sh` is executable and runs without error.

---

## Step 6: Text/SMS gap (optional)

If your contractors communicate primarily via text or iMessage, emails you scan won't catch everything.

**iOS Shortcut workaround (2-minute setup):**
1. In Shortcuts app, create a new shortcut: "Share to build-os"
2. Action: "Send Email" — To: [your project email address], Subject: "[ProjectName] contractor text", Body: Shortcut Input
3. Add to share sheet

After setup, when a contractor sends you an important text: long-press → Share → "Share to build-os" → the text gets forwarded to your project email → `/email-scan` picks it up on the next run.

---

## Closing

Confirm what was set up:
- ✓ Notion API key configured and databases created/located
- ✓ Google Calendar and Gmail OAuth configured
- ✓ Granola → Notion export enabled
- ✓ Session-start hook installed
- ✓ Integrations tested

Next steps:
- Run `/daily-brief` to see today's context with live data
- Run `/import-notes` if there are Granola notes waiting in Notion
- Run `/schedule-sync` to push all project dates to Google Calendar
