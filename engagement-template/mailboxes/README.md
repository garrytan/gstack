# mailboxes/ — directed agent messages

One file per agent: `agent-a.md`, `agent-b.md`, `agent-qa.md`, `agent-doc.md`.

- Agents read their own mailbox at the START of every session (AGENT_BASE.md step 2), act on each message, then clear it.
- Anyone (agents or human) appends messages; only the OWNER clears their own mailbox.
- Blackboard rule still applies: anything written to a mailbox is also summarized in PROGRESS.md.
- NEVER put secrets in a mailbox.

## Message format

```
## from: <sender> | <ISO timestamp> | re: <task-id or "general">
<precise, actionable message>
```

## Human steering example

Append to `mailboxes/agent-b.md`:

```
## from: tshepo | 2026-06-12T09:00:00Z | re: general
Deprioritize CRON tasks today. Pick SPCH-1-FK first if available.
```

Commit and push — agent-b obeys on its next iteration. Mailbox instructions override task-picking order but never override Hard Rules.
