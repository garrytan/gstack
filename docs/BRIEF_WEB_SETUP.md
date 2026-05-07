# /brief on Claude Code on the web — setup

The `/brief` skill works two ways:

| Where | How it gets data |
|-------|------------------|
| **Mac** (Claude Code in terminal or desktop app) | Live `gcalcli` + Granola MCP |
| **Web** (Claude Code on the web) | Reads `.brief-data/snapshot.json` pushed from Mac |

The web sandbox is ephemeral and can't reach your local calendar or Granola
cache. The bridge is a snapshot file: a small JSON your Mac generates and
pushes to this private repo, which the web's SessionStart hook pulls on every
session start.

## One-time setup on your Mac

### 1. Clone the repo locally with push access

```bash
mkdir -p ~/code
git clone [email protected]:RobertFeng22/gstack_robertf.git ~/code/gstack_robertf
cd ~/code/gstack_robertf
git checkout claude/implement-report-guide-KJKRR  # or main once merged
```

If you don't have SSH set up, use `https://` and have a credential helper
configured so push doesn't prompt every time.

### 2. Confirm prerequisites

You should have these working from earlier setup:

```bash
claude --version              # Claude Code installed
gcalcli list                  # auths and lists your calendars
claude mcp list | grep granola  # granola MCP registered, status = healthy
```

### 3. Test the snapshot script manually

```bash
cd ~/code/gstack_robertf
./bin/brief-snapshot
```

You should see:

```
[brief-snapshot] generating .../snapshot.json...
snapshot written
  meetings: N, attendee history entries: M
[brief-snapshot] committed; pushing...
[brief-snapshot] done. open Claude Code on the web and run /brief
```

The script:
1. Spawns headless Claude Code on your Mac
2. Has it call `gcalcli` + Granola MCP to assemble the data
3. Writes JSON to `.brief-data/snapshot.json`
4. Validates the JSON shape
5. Commits and pushes

If the script errors, check the failure mode it reports — most issues are
"gcalcli not authed" or "granola MCP not running."

### 4. Try `/brief` on the web

Open Claude Code on the web. Wait for the SessionStart hook to finish
(prints `gstack ready: 47 slash skills installed`). Then:

```
/brief
```

Expected: a prep brief rendered from the snapshot, with a "snapshot generated
X minutes ago on Mac" tag in the header.

## Auto-refresh (optional, recommended)

Manually running `./bin/brief-snapshot` every morning is a chore. Set up
launchd to run it automatically at 7am every weekday:

Create `~/Library/LaunchAgents/dev.local.brief-snapshot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.local.brief-snapshot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/code/gstack_robertf/bin/brief-snapshot</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key><integer>7</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>1</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>7</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>2</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>7</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>3</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>7</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>4</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>7</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>5</integer>
        </dict>
    </array>
    <key>StandardOutPath</key>
    <string>/tmp/brief-snapshot.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/brief-snapshot.err</string>
</dict>
</plist>
```

Replace `YOUR_USERNAME` with your Mac username (`whoami`). Then load it:

```bash
launchctl load ~/Library/LaunchAgents/dev.local.brief-snapshot.plist
```

To verify it's loaded:

```bash
launchctl list | grep brief-snapshot
```

To trigger it manually for testing:

```bash
launchctl start dev.local.brief-snapshot
tail -f /tmp/brief-snapshot.log
```

To remove it:

```bash
launchctl unload ~/Library/LaunchAgents/dev.local.brief-snapshot.plist
```

## How the freshness check works

The skill tags the brief with the snapshot's age, so you always know what
you're looking at:

```
Today, Wednesday May 7  (snapshot generated 4 minutes ago on Mac)
```

If the snapshot is older than 24 hours, the skill warns and falls back to
live tools when available. On the web (no live tools), it prints the
snapshot age and uses what it has anyway, so you can still get a brief
even if you forgot to refresh.

If you want to force-refresh from the web, message me to re-run the snapshot
script — the web sandbox can't trigger your Mac's launchd from inside.
You'd run `./bin/brief-snapshot` manually on the Mac.

## Privacy note

`.brief-data/snapshot.json` lives in this private GitHub repo. It contains:

- Today's meeting titles + attendee emails
- Last few Granola note summaries per attendee

If your gstack_robertf repo ever changes from private to public, **stop using
this** — the snapshot would expose meeting data. Move the snapshot to a
separate private repo (or use git-crypt) before flipping visibility.
