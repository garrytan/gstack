**Security: the lean /autoplan reviewer no longer gets `.envrc`, `.env-production` or a key pasted into an ordinary file (GST-1164, #3914).** Since v1.93.36.0 (#3897), the lean run puts the branch's draft code into a prompt that goes to an outside model provider. It left out only some secret-named untracked files: `.env` and `.env.*`, but not `.envrc` or `.env-production`. It applied no name rule to tracked files and no content check at all. So a direnv `.envrc`, a `.env-production`, a committed or edited secret file, or a key sitting in any source file could reach the provider.

### Fixed
- **`lib/autoplan-lean.ts` `captureDraft`:** the secret-name rule now covers the whole `.env*` family, `.envrc` included, every `*credentials*` name, `_netrc`, `.pgpass`, `*.jks` and `id_*_sk` keys. Matching files are never diffed, tracked or untracked, and the draft names each one it left out. Every other file's patch goes through gstack's redact engine (`redactFindingSpans`), so a key in an ordinary file reaches the reviewer as `<REDACTED-…>`. A patch the engine can't redact safely, including one over 1 MiB, is left out with a note.

### Tests
- `test/autoplan-lean.test.ts`: an untracked `.envrc`, `.env-production` and six other secret files stay out of `draft.diff` and the prompt; a committed and edited `.envrc` stays out of the tracked diff; a fake key in an untracked file and in a working-tree edit to a tracked file comes out redacted. All three fail on main at b42ad1e.

Thanks to the /ship pre-landing review of #3901, which filed the finding.
