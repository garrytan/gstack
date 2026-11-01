**`gstack-ship-receipt write` records the session kind on Windows.** Without `--session-kind` or `GSTACK_SESSION_KIND`, it asks the `gstack-session-kind` bash helper. It used to spawn that helper by path, which never starts on Windows, so every /ship receipt there carried no `session_kind`. It now starts the helper through `lib/script-invocation.ts`, which uses Git Bash on Windows. This is the /ship half of #3541.

### Fixed
- **`bin/gstack-ship-receipt`** starts `gstack-session-kind` with `runScriptSync`.

### Tests
- `test/ship-receipt-session-kind.test.ts` (windows-free-tests too): a receipt written without a session kind records what `gstack-session-kind` prints.
