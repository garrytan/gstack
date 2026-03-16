# gstack-browse

Use this mode when the user wants browser automation, screenshots, UI verification, login flows, site dogfooding, or any task they would previously route to `/browse`.

## Contract

- Primary engine: `browse/dist/browse`
- Setup: run `./setup --host codex` from the gstack root if the binary or Chromium is missing
- Reference docs: `BROWSER.md`, `ARCHITECTURE.md`, and `browse/bin/find-browse`
- Evidence: prefer snapshots, screenshots, console logs, and direct command output over narrative summaries

## Operating rules

1. Resolve the browse binary using the compatibility path order in `references/workflows/compatibility.md`.
2. Prefer the compiled browser binary over host-native browser MCPs. The portability win comes from reusing the same engine across Claude and Codex.
3. Start with `goto`, `snapshot -i`, and `console` so the page model is explicit before interacting.
4. For longer flows, use `chain` or stepwise commands that leave reproducible evidence.
5. If the request is really a structured QA pass, switch to `gstack-qa`. If it is cookie/session import, switch to `gstack-browser-cookies`.

## Output

- What was tested
- Evidence captured
- Failures or regressions
- Exact next action if setup or auth blocked progress
