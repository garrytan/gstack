# QA without a webpage

Use the same commands for browser and non-browser software. Start in a repository
with its documented native command and an isolated local fixture; name the target
and the behavior you want checked. For example:

```text
/qa-only Test this repo's CLI using its documented local fixture. Check valid and invalid input, exit codes, stdout/stderr, and cancellation. Report only; do not change code or tests. For each finding, include the exact command, expected and actual results, and which checks remain untested. Keep requests inside the fixture; ask before contacting an external service.

/qa Test this repo's local webhook and worker fixture. Explore duplicate deliveries and recovery after a partial failure. Keep all effects inside the fixture; preserve reproduced bugs in native regression tests before repairing them.
```

QA first tells you which surface, tools and write permissions it will use. A CLI or
API does not need a browser. Browser targets keep real browser testing; developer
experience audits load only when onboarding, installation or ergonomics are in scope.
If the native tools or safe fixture are unavailable, the report names the blocker
and untested contracts instead of inventing a pass or installing another framework.

Exploration means learning from each result and choosing the next useful challenge,
not running random commands. Before the next discovery probe, QA saves a short
`exploration-NNN.json` evidence note with the previous result, the assumption being
tested and the next command. The final report links these notes; they do not require
an extra chat message between probes. A discovered bug must be reproducible, and its new test
must fail for the bug before the repair and pass afterward. Unit tests protect logic;
integration and end-to-end tests protect real boundaries that mocks would hide.
`/qa-only` proposes those tests without writing them.

Normal `/review` and `/gstack-ship` run a bounded version on changed behavior and nearby
risks automatically, including small diffs without a plan or web server. Existing
fix/test approval rules still apply. Missing dependencies, denied actions and time
limits remain visible coverage gaps; a short smoke pass never means exhaustive QA.
Production access and destructive or external effects require specific permission.

Bounded exploration uses an executable deadline guard, not an estimated clock: it
refuses late probes and stops owned foreground work at the limit. Unfinished checks
stay visible in the report. Required plan checks remain outside the review/ship smoke
budget. See [QA deadlines](reference-qa-deadlines.md) for command, platform and
cleanup limits.

Every ship also runs the existing documentation audit, including repeat ships and
existing PR updates. Clear factual corrections join the final checked change; risky
rewrites need approval. A failed audit stops for recovery or explicit acceptance of
the named risk rather than silently dropping its result. Ship owns versioning, Git
and PR publication; the docs helper does not commit or push independently.
