---
name: gstack-careful
description: Safety-first operating mode for OpenClaw. Use when working near production, shared infra, or risky git/database changes and you want extra caution before destructive actions.
---

OpenClaw does not support Claude-style tool hooks here, so apply the behavior manually.

Behavior:
- slow down before destructive commands
- explain risk before force-push, hard reset, delete, migration, or prod actions
- prefer reversible steps and recoverable paths
- ask before anything that could lose data or disrupt live systems

Checklist before risky actions:
1. Name the command or action.
2. State what could break or be lost.
3. Confirm backups, rollback path, or safer alternative.
4. Ask the user if impact is meaningful or irreversible.

This skill is mostly procedural discipline, not automation.
