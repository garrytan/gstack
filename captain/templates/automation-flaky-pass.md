# Automation: the daily flaky-fix pass

Schedule: once a day, early in the owner's quiet hours (for example 02:00 in the owner's
timezone), as a scheduled automation that starts one new lane. Run it as a thread in the
crew so its report lands with the others.

Prompt:

```text
You are today's flaky-fix lane for <REPO>. Read the crew rules file and the flaky ledger
(<path>) first. Your sources, for the window since the last pass named at the top of the
ledger's Open section:

1. Every gate, screen, train and bisect run of <gate workflow> on <REPO> in the window:
   download each run's flake-records artifact and add one ledger line per case the
   in-run rerun turned green (date, case, tier, PR and head, failing attempt, passing
   attempt, one-line symptom from the failure log).
2. The free suites' retried cases in the same window, from the runners' retry output.
3. For repositories that run `gstack-flaky`: download the window's `flaky-junit-ledger-*`
   artifacts (`gh run download <run-id> --pattern 'flaky-junit-ledger-*' --dir ledgers/<run-id>`)
   and run `gstack-flaky quarantine report --ledger ledgers`. Fix its expired and EXPIRING
   entries first: fix the test, or renew once with new evidence and the owner named, never
   a second time. Release each READY_TO_RELEASE entry with
   `gstack-flaky quarantine release <id> --reason <why> --pr <url>` in a PR of its own.
   A hard-break line is a real red, not a flake: fix it like any failing test.

Never add a case that failed twice (that is a real failure, not a flake), and never a
harness, infra or incomplete red. Then group the Open section by case, worst repeat
first, and fix the top cause: reproduce it (a forced probe or a regression test that is
red on <BASE> and green with the fix), fix the cause, and open one PR per cause through
the host's PR tool with the ledger lines it closes in the body. Weakened assertions,
raised thresholds, added trials or samples, changed case kinds, skipped cases and longer
timeouts are not fixes; if a case needs one of those, write it up under Needs with the
owner's decision and leave the entry Open. Move fixed entries to Fixed with the PR, and
entries you decided against to Won't fix with the reason. Update the "Last fix pass" line.

Run /ship on each PR and send the controller a READY block; never merge. Finish with
reports/<your code>.md (Outcome, PR, Needs, Cost, Lesson, Approvals), including the
spend of every paid run you made.
```

What it reads: the ledger, the gate runs' flake-records artifacts, the free suites'
retry output, the `gstack-flaky` ledgers and quarantine report, the crew rules file. What it starts: one fix PR per cause, each READY'd to
the controller. What it never does: rerun a gate, change a threshold, or merge.
