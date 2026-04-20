"""FastAPI webhook handler fixture — receives webhook, writes DB row + POSTs to Slack.

Output is a side effect, not the response. Tests webhook shape detection
and direct route invocation (without booting uvicorn).
"""
from __future__ import annotations
import os
import sqlite3

import requests
from fastapi import FastAPI, Request

app = FastAPI()
SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/X")
DB_PATH = os.environ.get("DB_PATH", "events.sqlite")


def record_event(event_type: str, payload_json: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS events (type TEXT, payload TEXT)")
    conn.execute("INSERT INTO events (type, payload) VALUES (?, ?)", (event_type, payload_json))
    conn.commit()
    conn.close()


@app.post("/webhooks/stripe")
async def stripe_webhook(req: Request):
    body = await req.json()
    event_type = body.get("type", "unknown")
    record_event(event_type, str(body))
    requests.post(SLACK_WEBHOOK, json={"text": f"Stripe: {event_type}"}, timeout=5)
    return {"status": "ok"}
