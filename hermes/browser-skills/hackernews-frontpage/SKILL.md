---
name: hackernews-frontpage
description: Use when scrape the hacker news front page (titles, points, comment counts). (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/hackernews-frontpage/SKILL.md
---

# Hacker News front-page scraper

Scrapes the Hacker News (`news.ycombinator.com`) front page and returns the
top 30 stories as JSON. Each story has its rank, title, link URL, point count,
and comment count.

## Usage

```
$ terminal skill run hackernews-frontpage
{
  "stories": [
    { "rank": 1, "title": "...", "url": "...", "points": 412, "comments": 87 },
    ...
  ],
  "count": 30
}
```

## How it works

1. Navigates to `https://news.ycombinator.com` via the daemon.
2. Reads the page HTML.
3. Parses each story row (HN's stable `tr.athing` structure) into a typed
   `Story` record.
4. Emits a single JSON document on stdout.

## Why this is the reference skill

`hackernews-frontpage` is the smallest interesting browser-skill: no auth,
stable HTML, deterministic output, file-fixture-friendly. Every Phase 1
component (SDK, scoped tokens, three-tier lookup, spawn lifecycle) is
exercised by `terminal skill run hackernews-frontpage` and the bundled
`script.test.ts`.

When the HN HTML rotates and our selectors break, the test fails against the
captured fixture before users notice. That's the point.
