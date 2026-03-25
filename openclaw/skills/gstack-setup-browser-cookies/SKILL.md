---
name: gstack-setup-browser-cookies
description: Authenticated-browser setup for OpenClaw. Use when QA or live testing requires existing user cookies or a manual login in a real browser session.
---

Do not promise automatic cookie import if the environment does not support it.

Preferred OpenClaw-native approach:
1. Ask whether the user is present to help with browser attachment or login.
2. Use `browser` with `profile="user"` when existing local browser cookies matter.
3. If the user specifically mentions the Browser Relay extension or attach-tab flow, use `profile="chrome-relay"`.
4. Let the user complete any manual auth steps, then continue testing in the attached browser context.

If browser attachment is unavailable, fall back to asking the user to log in within the controlled browser session and continue from there.
