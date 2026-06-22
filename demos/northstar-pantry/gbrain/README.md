# gbrain for this demo

This folder is the memory contract for the hypothetical business.

## Purpose

The demo uses local JSONL notes to stand in for a real gbrain backend. That
makes the workflow visible without needing any external service.

## Memory types in this demo

- `decision` — a choice the agent made
- `learning` — a reusable lesson
- `customer` — recurring customer context
- `ops` — operations and supply-chain context
- `growth` — marketing and revenue context

## How the script uses it

`run_demo.py` searches this file with simple keyword matching. In a real
integration, this folder would map to gbrain pages or queries instead.

## Sample query ideas

- `supplier` — why the oat bar order is delayed
- `enterprise` — what to do about the pilot lead
- `refund` — support and policy issues
- `cac` — paid growth guardrails
