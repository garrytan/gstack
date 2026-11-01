**Native cookie import now waits for its browser to actually exit before it reports cleanup, and four more flaky tests from the 2026-11-01 flaky pass are repaired.** Windows drops a Job's process count to zero while terminated Edge processes are still shutting down and still hold the profile's files, so cleanup that trusted the count returned early and the next profile reset failed with a sharing violation.

### Fixed
- **`browse/src/cookie-import-native-job.ts`, `browse/src/cookie-import-native-worker.ts`, `browse/src/cookie-import-native.ts`**: the supervisor holds a handle to every process it sees in the import's Job and counts a process as active until that handle signals exit, not only until the Job's counter drops. The cleanup budget is now 20 s (was 5 s), because terminated Edge took up to 17.8 s to exit on a loaded Windows runner and 2 to 57 ms idle; an idle import returns as soon as its processes are gone. Cleanup that still cannot confirm the exit reports `native_cleanup_failed`, as before.
- **`test/skill-e2e-autoplan-guard-pty.test.ts`**: the live actor is Sonnet 5.5 instead of Haiku 4.5. Haiku rewrote the 64-character content hash when it retyped the Phase 2 dispatch prompt, so the publication guard correctly refused a prompt the actor had changed. The guard, the case kind and its single trial are unchanged.
- **`.gstack/pregate.json`**: the local pregate lane runs `bun test --timeout=30000 {files}`, the 30 s per-test timeout CI and the remote pregate already use, so a case that takes 5 s on a busy machine no longer fails only locally.
- **`test/gstack-ship-receipt.test.ts`**: the full `write` case, about 62 git calls, gets a 15 s timeout instead of bun's 5 s default.

### Changed
- `test/helpers/docsync-contract.ts` names the missing `documentation_section` when a document-release completion fails the contract, so the next paid red says which field was absent.
