---
name: repo-orient
preamble-tier: 2
version: 1.0.0
description: |
  Repository orientation before planning, reviewing, debugging, or editing.
  Identifies architecture, entry points, dependency hubs, repo-map artifacts,
  risk areas, and files to inspect before making changes. Use when asked to
  "understand this repo", "map this project", "where should I make this change",
  "explain this codebase", or when starting work in an unfamiliar repository.
  Proactively suggest before using review, investigate, qa, or ship on an
  unfamiliar repo. (gstack)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
triggers:
  - understand this repo
  - map this project
  - explain this codebase
  - repo orientation
  - project orientation
  - where should i make this change
  - what files should i inspect
  - codebase overview
---

{{PREAMBLE}}

# Repository Orientation

Use this workflow to understand an unfamiliar repository before planning, reviewing, debugging, or editing code.

The goal is to build a grounded mental model of the repo first. Do not edit code during this workflow unless the user explicitly asks for edits.

## Step 1: Check for repo-map artifacts

Before scanning raw files broadly, check whether any of these files exist:

```bash
ls docs/ARCHITECTURE_REPORT.md docs/PROJECT_MAP.md docs/project_map.json docs/PROJECT_GRAPH.html graphify-out/GRAPH_REPORT.md graphify-out/graph.json AGENTS.md CLAUDE.md 2>/dev/null || true
```

## Step 2: Check root dependency and config markers

Use `find` instead of shell globs so the command is safe in zsh even when no matching config files exist:

```bash
find . -maxdepth 1 \( \
  -name 'package.json' \
  -o -name 'pyproject.toml' \
  -o -name 'requirements.txt' \
  -o -name 'go.mod' \
  -o -name 'Cargo.toml' \
  -o -name 'pom.xml' \
  -o -name 'Dockerfile' \
  -o -name 'docker-compose.yml' \
  -o -name 'vercel.json' \
  -o -name 'vite.config.*' \
  -o -name 'next.config.*' \
  -o -name 'tsconfig.json' \
\) -print 2>/dev/null | sort
```
