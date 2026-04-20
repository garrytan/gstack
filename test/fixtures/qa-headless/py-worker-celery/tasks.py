"""Celery worker fixture — sends notifications via task.

Used to test sync invocation (.apply()) without booting a broker.
"""
from celery import Celery, shared_task
import requests
import os

app = Celery("notifier", broker="redis://localhost:6379/0")

SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/X")


@shared_task
def send_user_notification(user_id: int, message: str, dry_run: bool = False):
    """Send a Slack notification for a user. Triggered by upstream events."""
    payload = {
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*User {user_id}*: {message}"}}
        ]
    }
    if dry_run:
        return {"status": "dry-run", "payload": payload, "user_id": user_id}
    return requests.post(SLACK_WEBHOOK, json=payload, timeout=5).status_code
