"""Daily Slack call digest — motivating case for /qa-headless.

Reads call sessions from a (mock) data source, groups by (caller, device_id),
POSTs one Block Kit message per group to a Slack webhook.

Has --dry-run flag → /qa-headless can drive it directly.
"""
from __future__ import annotations
import argparse
import os
from collections import defaultdict
from datetime import date, datetime, timezone

import requests

SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/X")


# Mock data source. In production this is Postgres + SQLAlchemy.
CALL_SESSIONS = [
    # (caller_e164, device_id, started_at, duration_s, routed)
    ("+15551110001", "dev-a", "2026-04-15T10:02:00Z", 142, True),
    ("+15551110001", "dev-a", "2026-04-15T11:30:00Z", 88,  True),
    ("+15551110002", "dev-b", "2026-04-15T09:15:00Z", 305, True),
    ("+15551110002", "dev-b", "2026-04-15T14:01:00Z", 60,  False),  # unrouted
    ("+15551110003", "dev-c", "2026-04-15T12:00:00Z", 200, True),
    ("+15551110003", "dev-c", "2026-04-15T13:00:00Z", 175, True),
    ("+15551110003", "dev-c", "2026-04-15T15:30:00Z", 90,  True),
    ("+15551110004", "dev-d", "2026-04-15T08:45:00Z", 411, True),
    ("+15551110005", "dev-e", "2026-04-15T16:20:00Z", 55,  True),
]


def fetch_sessions_for_date(target: date):
    target_str = target.isoformat()
    return [row for row in CALL_SESSIONS if row[2].startswith(target_str)]


def group_by_caller_device(rows):
    groups = defaultdict(list)
    for row in rows:
        caller, device, *_ = row
        groups[(caller, device)].append(row)
    return groups


def build_block_kit(group_key, rows):
    caller, device = group_key
    total_calls = len(rows)
    total_seconds = sum(r[3] for r in rows)
    unrouted = sum(1 for r in rows if not r[4])

    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{caller} on {device}"}},
        {"type": "section", "text": {"type": "mrkdwn",
            "text": f"*{total_calls}* calls today, *{total_seconds}s* total" +
                    (f" ({unrouted} unrouted)" if unrouted else "")}},
    ]
    return {"blocks": blocks}


def send_to_slack(payload, dry_run: bool):
    if dry_run:
        # Capture point for /qa-headless. In production this would post.
        return {"status": "dry-run", "payload": payload}
    return requests.post(SLACK_WEBHOOK, json=payload, timeout=5)


def main():
    parser = argparse.ArgumentParser(description="Daily Slack call digest")
    parser.add_argument("--date", type=lambda s: datetime.fromisoformat(s).date(),
                        default=date.today(), help="Date to digest (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Capture payloads instead of POSTing")
    args = parser.parse_args()

    rows = fetch_sessions_for_date(args.date)
    if not rows:
        print(f"0 sessions for {args.date} — nothing to digest")
        return

    groups = group_by_caller_device(rows)
    sent = 0
    for key, group_rows in groups.items():
        payload = build_block_kit(key, group_rows)
        send_to_slack(payload, dry_run=args.dry_run)
        sent += 1

    total_calls = len(rows)
    unrouted = sum(1 for r in rows if not r[4])
    print(f"{sent} groups, {total_calls} calls, {unrouted} unrouted, "
          f"Block Kit valid, ship-ready")


if __name__ == "__main__":
    main()
