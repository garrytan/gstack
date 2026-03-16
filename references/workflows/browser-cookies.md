# gstack-browser-cookies

Use this mode when the user wants to import real browser cookies into the gstack browser session for authenticated testing.

## Contract

- Primary engine: `browse/dist/browse`
- Primary command: `cookie-import-browser`
- Platform caveat: this flow is currently macOS-centric because it reads browser profiles and Keychain-backed cookies

## Workflow

1. Resolve the gstack browse binary.
2. Confirm the target browser and domain if the user provided them.
3. Run the import using the compiled browser CLI.
4. Verify the imported session by visiting an authenticated page.

## Operating rules

- Do not echo raw cookie values into the transcript.
- If the platform or browser is unsupported, say so quickly and fall back to manual login guidance.
- If the task becomes full QA after import, switch to `gstack-qa`.
