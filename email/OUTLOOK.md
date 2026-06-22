Outlook desktop integration

This document describes gstack-email-outlook, a small script that sends email via the Microsoft Outlook desktop app using AppleScript.

Usage

1. Make executable:
   chmod +x ~/.claude/skills/gstack/bin/gstack-email-outlook

2. Send an email:
   ~/.claude/skills/gstack/bin/gstack-email-outlook send --to recipient@example.com --subject "Hi" --body "Hello"

3. Dry-run to preview:
   ~/.claude/skills/gstack/bin/gstack-email-outlook send --to recipient@example.com --subject "Hi" --body "Hello" --dry-run

Notes and permissions

- macOS will prompt for automation permission the first time the script controls Outlook.
- The script uses the logged-in Outlook account to send; the --from flag is informational only (Outlook picks the sending account).
- For richer HTML messages or attachments, extend the script to use Outlook AppleScript APIs or the Outlook Web API.

Security

- The script does not store credentials. AppleScript uses the Outlook process and the signed-in account.
- Respect PII: run gstack-redact on message content if it contains sensitive information before sending.
