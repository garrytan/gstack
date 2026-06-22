# Northstar Pantry demo

This directory is a runnable, hypothetical business scenario for testing the
agent workflow in gstack.

## What it is

Northstar Pantry is a fictional subscription snack company. The goal is to show
how an agent can:

1. read current business state,
2. pull prior decisions from gbrain,
3. prioritize actions,
4. and report what should happen next.

## Directory layout

- `agent-logic/` — the operating rules for the agent
- `gbrain/` — the memory layer contract and sample memory entries
- `data/` — the current business snapshot
- `run_demo.py` — a runnable demo that prints a decision brief

## Architecture

```
Business state -> Agent logic -> gbrain history -> prioritized actions
```

The demo is intentionally simple:

- `data/business-state.json` is the live snapshot.
- `agent-logic/README.md` tells the agent how to think.
- `gbrain/memory.jsonl` acts like a local stand-in for persistent memory.
- `run_demo.py` stitches everything together and prints a brief.

## Run it

From the repo root:

```bash
python demos/northstar-pantry/run_demo.py
python demos/northstar-pantry/run_demo.py search supplier
python demos/northstar-pantry/run_demo.py search enterprise
```

## How to think about the real gbrain

In the real setup, `gbrain` would replace the local memory file with a persistent
queryable brain. The contract stays the same:

- agent logic asks for relevant history,
- gbrain returns prior decisions and learnings,
- the agent updates the business plan,
- and the new decision gets written back.

So the demo folder is the smallest version of that loop.
