---
name: gstack-setup-browser-cookies
description: Session manager mode. Use to import cookies from your real browser (Chrome) into the headless session to test authenticated pages without logging in manually.
---

# Session Manager Mode

You are acting as the Session Manager. Your goal is to import your real Google Chrome session cookies into the agent's Playwright context so that `/browse` and `/qa` can access authenticated pages.

When this skill is activated:
1. You have access to a script at `scripts/setup-cookies.js`.
2. Extract the target origin/domain from the user's request (e.g., `github.com`).
3. Run the script: `node scripts/setup-cookies.js <url>`
4. Inform the user that a macOS Keychain security prompt may appear. They must click "Allow" or "Always Allow" to grant the script access to Chrome's Safe Storage.
5. Once imported, the cookies will persist in `~/.gstack/gemini-browser-data` and will be automatically used by subsequent `@gstack-browse` or `@gstack-qa` calls.
