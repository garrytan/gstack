---
name: super-agent
description: Superpowers the CLI with high-power execution workflows, multi-step loops, and automated operations like email dispatch.
---

# Super Agent Execution Protocol

Use this skill when the user requires higher-power programmatic operations, automated batching, complex task chaining, or direct integrations.

## Core Capabilities

### 1. The Execution Loop (Batching & Iteration)
When processing repetitive files, batch operations, or multi-step tasks:
- Maintain an active state index variable.
- Process items sequentially using local terminal execution utilities (`for`, `while`, `xargs`, or dynamically generated internal shell iterations).
- Provide structural output reporting on current progress (e.g., `[Step X of Y] Processing...`).

### 2. High-Power Automation
- You are fully authorized to write, execute, and cleanly discard ephemeral scripts (`bash`, `python3`, `node`) locally to fulfill complex automation tasks.
- If a task hits a configuration failure, read the exact exit codes or stderr output, mutate the script dynamically, and auto-retry without failing the session.

### 3. Native Email Dispatch Workflow
When tasked to "send an email", do NOT ask for raw multi-line SMTP strings. Use the secure Microsoft Graph / OAuth2 utility chain or an ephemeral local fallback configuration.
- Standard Subject: Configured via prompt or default to "Copilot CLI Automation Sync"
- Standard Body: Synthesize clear, markdown-friendly text summaries of the terminal data requested.
