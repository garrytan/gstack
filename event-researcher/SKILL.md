---
name: event-researcher
description: Research technical event information from a Luma event URL or event name, then produce structured Markdown notes. Use when Codex or ChatGPT needs to investigate conferences, hackathons, workshops, hands-on sessions, meetups, or similar events; extract official details, enrich speakers and links with web research, cite sources, and save local Markdown files when filesystem access is available.
---

# Event Researcher

## Overview

Research a technical event from a Luma URL or event name and produce structured Markdown that an attendee can use before, during, and after the event.

Prefer official sources for facts, use external search for enrichment, and mark uncertainty instead of filling gaps with guesses.

## Workflow

1. Resolve the canonical event page.
   - If the user gives a URL, use it as the primary source.
   - If the user gives only an event name, web-search for the canonical Luma page and organizer page before researching secondary sources.
   - Record retrieval date, source URL, and confidence for every source used.

2. Choose the best access method.
   - If an interactive browser or Chrome-extension browser surface is available, read the relevant browser skill first and use it to inspect the rendered page, hidden tabs, expanded sections, registration states, and linked pages.
   - Otherwise fetch the event page and parse available HTML, JSON-LD, Open Graph metadata, embedded app data, linked resources, and visible text.
   - If access is blocked, use public search snippets and cached/indexed official pages only as fallback evidence, and label the limitation.

3. Extract official event facts.
   - Title, event type, organizer, official URL, date, time, timezone, venue, address, online stream or access URL, registration/capacity/deadline status, contact links, code of conduct, sponsors, and event description.
   - Agenda or timetable with start/end times, session titles, speakers, rooms/tracks, breaks, judging/demo periods, and social events.
   - Attendee-critical details: prerequisites, target audience, bring items, check-in rules, required accounts/tools, workshop setup, hackathon team rules, judging criteria, deliverables, prizes, and post-event resources.

4. Parallelize enrichment when possible.
   - After the event page is extracted once, make a compact research brief with event title, URL, speaker names, known affiliations, session titles, organizer names, and listed links.
   - If subagent or multi-agent tools are available, spawn independent research tasks in parallel for each speaker and for any large independent group such as organizers, sponsors, repositories, slides/materials, or recordings. Do not wait for one speaker search before starting the next.
   - Give each subagent only the relevant brief and ask for sourced JSON fields that match `references/output-schema.md`. Tell subagents not to edit shared files; the main agent performs the final merge and writes output.
   - If subagents are unavailable, batch web searches by speaker/entity and keep each search focused. Avoid repeatedly re-fetching the event page.

5. Enrich cautiously.
   - Research listed speakers, organizers, sponsor links, GitHub repositories, slide decks, recordings, blog posts, and related project pages.
   - For speakers, go beyond a short bio: capture current roles, affiliation history, education, career timeline, technical focus, technologies used, notable projects, publications/talks, communities, awards, social links, and why the person matters for this event.
   - Prefer speaker-owned profiles and organization pages over third-party summaries.
   - Keep enrichment separate from official event facts when the source is not the event page.

6. Produce output.
   - If local filesystem access is available, create an output directory and save Markdown files using the structure in `references/output-schema.md`.
   - If local files cannot be written, output the same Markdown sections inline.
   - In Coding Agent environments, optionally use `scripts/render_event_markdown.py` after drafting a JSON payload matching the schema.

## Output Requirements

Read `references/output-schema.md` before producing final Markdown or using the renderer script.

At minimum include:

- `event.md` with summary, official facts, timetable, attendee checklist, and unresolved questions.
- `speakers/<speaker-slug>.md` for each identified speaker, including profile facts, background, technical focus, notable work, and event relevance.
- `links.md` grouped by official event links, speaker links, materials, recordings, repositories, social links, and other references.
- `sources.md` with source URLs, retrieval dates, confidence, and notes on conflicts or access limitations.

Use concise Markdown. Make missing information visible with `Unknown` or `Not found in sources`; never invent exact times, URLs, credentials, profiles, or speaker affiliations.

## Quality Bar

- Treat official event pages as primary sources and web search as enrichment.
- Preserve timezone exactly as sourced; if converting timezones, keep the original too.
- Distinguish venue address from venue name and online access links from registration links.
- Do not publish private attendee-only links unless they are visible in public sources or explicitly provided by the user.
- Include practical next actions for attendees, especially setup steps for workshops and team/deadline details for hackathons.
- Use parallel subagents for independent enrichment in Coding Agent environments when available; the speedup is worth the coordination overhead once there are multiple speakers or external entities.
