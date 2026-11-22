---
important: security
---
- **/autoplan's lean review no longer sends secret files or keys from your draft code to the reviewing model.** Files named like secrets (the whole `.env` family including `.envrc`, `*.pem`, `*.key`, `*.p12`, SSH private keys, `.netrc`, `.npmrc`, `.pgpass`, `*credentials*`, `*secret*`) are now left out whether they are tracked or untracked, under both names when git sees them renamed or copied, and inside a changed submodule even when your git config inlines submodule diffs. Every other file's patch goes through the redact engine, so a key in an ordinary file reaches the reviewer as `<REDACTED-…>`, and a patch it can't redact safely is left out with a note.
