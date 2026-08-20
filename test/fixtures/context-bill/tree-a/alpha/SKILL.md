---
name: alpha
description: Fixture dispatcher with a mode table and forced-read references.
triggers: a-key-the-upstream-router-DOES-read
x-dead-key: a-key-no-router-reads
---

# Alpha

## Dispatch protocol

1. Infer the mode from the request.
2. Read `references/CORE.md` and `references/POLICY.md` for every invocation. Read `references/OPTIONAL.md` before public-web work.
3. When the target is a repository, read `references/CORE.md` once before specialist work; it is already billed eagerly.

## Top-level modes

| Mode | Infer when | Candidate internal specialists |
|---|---|---|
| `Discovery` | The idea is fluid. | `references/legacy/office.md` |
| `Full chain` | Everything at once. | `references/legacy/auto.md` |
