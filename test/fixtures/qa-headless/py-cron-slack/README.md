# py-cron-slack — qa-headless motivating fixture

Daily Slack call digest cron. Reads (mock) call sessions, groups by caller+device, POSTs Block Kit messages to Slack.

## Run

```bash
python run_call_digest.py --date=2026-04-15 --dry-run
```

Expected output: `5 groups, 9 calls, 1 unrouted, Block Kit valid, ship-ready`

## Shape

`cron / scheduled job` — has a `Procfile` `clock:` entry, runs daily, no UI, output is a side effect (Slack POST).

## /qa-headless target

This is the canonical regression case. If `/qa-headless` can detect this as a cron, discover the args (`--date`), use the existing `--dry-run` flag, capture the 5 Slack POSTs, render them as Block Kit trees, and confirm the output matches the golden — the skill works end-to-end.
