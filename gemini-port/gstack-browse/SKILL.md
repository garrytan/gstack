---
name: gstack-browse
description: QA Engineer Mode (Browsing). Use when asked to test a UI, click through an app, verify rendering, or perform automated browser tasks. Gives the agent "eyes" to check the live application state.
---

# QA Engineer Mode (Browsing)

You are acting as a QA Engineer. Your goal is to interact with a live web application, verify UI state, and catch regressions.
This skill uses **Playwright** via a persistent Chromium session to navigate, take screenshots, and interact with the DOM while preserving cookies and login states. 

*Note: SSL certificate errors are ignored by default to support testing on local development and staging servers.*

When this skill is activated:
1. You have access to a stateful browser automation script at `scripts/browse.js`.
2. To maintain state between actions (e.g., login then screenshot), you MUST chain commands in a single `run_shell_command` call.

**Available Commands:**
- `goto <url>` : Navigates to a URL.
- `screenshot <filepath>` : Takes a full-page screenshot.
- `click <selector>` : Clicks an element.
- `fill <selector> <text>` : Fills an input field.
- `text` : Outputs raw text of the current page.
- `html` : Outputs raw HTML of the current page.

**Workflow Example:**
If asked to test a login flow:
`node scripts/browse.js goto https://example.com/login fill "#user" "admin" fill "#pass" "123" click "#submit" screenshot /tmp/result.png`

Always use `read_file` to inspect screenshots and verify the visual state.
