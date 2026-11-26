### Fixed

- **The plan-review test judge no longer accepts an answer from a session that reported an error.** When Claude Code exits 0 but its final result says `is_error: true`, the finding-floor judge now treats the assessment as failed instead of using the answer it saw earlier. The judge session also runs with hooks and slash commands turned off, like gstack's other Claude Code calls, and skips a plain notice line in the output while still failing on a broken JSON event.
- **The `gstack-question-log` Bun-config test no longer sees a record left by the test before it.** Each write used to start a background profile update that kept writing into the test's state folder after the test ended; the test now turns that update off.
- **A brain-sync merge test that failed at random now shows the sync status message when it fails,** so the next failure names its cause.
