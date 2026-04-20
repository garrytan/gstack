"""Async notifier using httpx.AsyncClient — tests respx-based capture.

Common in FastAPI codebases. /qa-headless must capture this with respx,
not responses (which only handles sync requests).
"""
from __future__ import annotations
import asyncio
import os

import httpx

SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/X")


async def send_async_notification(message: str):
    async with httpx.AsyncClient(timeout=5) as client:
        return await client.post(SLACK_WEBHOOK, json={"text": message})


async def main():
    await send_async_notification("Hello from async land")


if __name__ == "__main__":
    asyncio.run(main())
