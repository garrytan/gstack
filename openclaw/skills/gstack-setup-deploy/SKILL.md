---
name: gstack-setup-deploy
description: Deployment-setup helper for OpenClaw. Use when figuring out how a repo deploys, documenting the deploy path, and capturing enough operational context for future land-and-deploy runs.
---

The goal is reusable deploy context, not magic.

Workflow:
1. Detect likely deploy platform from repo files, CI config, and docs.
2. Find production URLs, health checks, and relevant commands.
3. Record how to deploy, verify, and troubleshoot in repo docs.
4. Note any secrets, manual approval steps, or browser-based gaps that still require a human.

Prefer writing to the compatibility subtree or existing operational docs rather than inventing hidden state.
A good result is a concise deploy note another agent could follow without guesswork.
