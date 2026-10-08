---
name: Bug report
about: A gstack skill, helper or setup step broke or did something unexpected
labels: bug
---

## What happened

<!-- The skill or command you ran, what it printed, and what you expected instead. -->

## Steps to reproduce

1.
2.

## Readiness report

Paste the complete output of gstack's doctor. It starts no skill, makes no paid
call and prints no secrets or file contents. Run the line for your install:

```bash
# Claude Code
~/.claude/skills/gstack/bin/gstack-doctor

# Any other host: from your gstack checkout, ./setup --status ends with the
# absolute path of the doctor ("Readiness check: ..."). Run that path.
./setup --status

# The state root (where installs.tsv lists every install) for the same checkout:
./bin/gstack-paths --get GSTACK_STATE_ROOT
```

```text
(doctor output here)
```

## Environment

- Host (Claude Code, Codex, Cursor, ...) and its version:
- OS:
