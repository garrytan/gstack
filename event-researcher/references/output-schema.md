# Event Research Output Schema

Use this schema as the canonical structure for local Markdown output or inline ChatGPT output.

## Directory Layout

```text
<output-root>/
├── event.md
├── links.md
├── sources.md
└── speakers/
    └── <speaker-slug>.md
```

## JSON Shape for `scripts/render_event_markdown.py`

All fields are optional unless marked required. Unknown values should be omitted, `null`, empty arrays, or the string `Unknown`.

```json
{
  "event": {
    "title": "Required event title",
    "event_type": "conference | hackathon | workshop | hands-on | meetup | other",
    "summary": "Short attendee-oriented summary",
    "official_url": "https://lu.ma/example",
    "organizer": "Organizer name",
    "status": "scheduled | cancelled | postponed | completed | unknown",
    "date": "2026-07-05",
    "start_time": "18:00",
    "end_time": "21:00",
    "timezone": "Asia/Tokyo",
    "venue_name": "Venue name",
    "address": "Street address",
    "online_url": "Streaming or meeting URL when public",
    "registration_url": "Registration URL",
    "capacity": "Capacity or application status",
    "deadline": "Registration/application deadline",
    "description": "Long event description",
    "audience": "Intended audience",
    "prerequisites": ["Required knowledge, accounts, software, hardware"],
    "bring_items": ["Laptop", "ID", "Charger"],
    "check_in": ["Check-in rule or reception note"],
    "contact": ["mailto:organizer@example.com"],
    "code_of_conduct": "URL or note",
    "sponsors": ["Sponsor name"],
    "hackathon": {
      "team_rules": "Team formation rules",
      "judging": "Judging criteria",
      "deliverables": "Submission requirements",
      "prizes": "Prize information"
    },
    "workshop": {
      "setup": ["Install step or account creation step"],
      "materials": ["Workshop materials URL or title"]
    }
  },
  "agenda": [
    {
      "start": "18:00",
      "end": "18:20",
      "title": "Session title",
      "speaker_names": ["Speaker Name"],
      "track": "Track or room",
      "description": "Session description",
      "materials": ["https://example.com/slides"]
    }
  ],
  "speakers": [
    {
      "name": "Required speaker name",
      "slug": "optional-custom-slug",
      "role": "Speaker role or session role",
      "headline": "One-line identity, such as 'YC President & CEO and early-stage investor'",
      "affiliation": "Company or community",
      "bio": "Short profile",
      "current_roles": ["Current title, company, board/advisor role, or community role"],
      "education": ["School, degree, field, or program when verified"],
      "career": [
        {
          "period": "2018-2024 or Unknown",
          "organization": "Organization",
          "role": "Role",
          "summary": "What they did there"
        }
      ],
      "technical_focus": ["AI agents", "developer tools", "compilers"],
      "technical_stack": ["Python", "TypeScript", "Rust", "React"],
      "notable_work": [
        {
          "title": "Project, startup, paper, talk, repository, or product",
          "description": "Why it matters",
          "url": "https://example.com"
        }
      ],
      "publications_talks": [
        {
          "title": "Talk, article, podcast, paper, or video",
          "url": "https://example.com",
          "date": "2026-07-05"
        }
      ],
      "communities": ["Community, open-source org, accelerator, university, or meetup"],
      "awards": ["Award, recognition, funding milestone, or competition result"],
      "event_relevance": "Why attendees should care about this speaker for this event",
      "research_notes": ["Ambiguity, conflicts, identity disambiguation notes, or missing facts"],
      "sessions": ["Session title"],
      "links": [
        {
          "label": "GitHub",
          "url": "https://github.com/example",
          "kind": "github"
        }
      ],
      "sources": ["https://example.com/profile"]
    }
  ],
  "links": [
    {
      "label": "Official event page",
      "url": "https://lu.ma/example",
      "kind": "official | speaker | material | recording | repository | social | sponsor | other",
      "note": "Why this link matters"
    }
  ],
  "sources": [
    {
      "title": "Luma event page",
      "url": "https://lu.ma/example",
      "retrieved_at": "2026-07-05",
      "kind": "official | search | profile | material | other",
      "confidence": "high | medium | low",
      "notes": "Access limits, conflicts, or useful context"
    }
  ],
  "unresolved_questions": [
    "Question or missing fact that could not be verified"
  ]
}
```

## Markdown Files

### `event.md`

Use these sections in order:

1. `# <event title>`
2. `## Summary`
3. `## Event Facts`
4. `## Timetable`
5. `## Speakers`
6. `## Attendee Checklist`
7. `## Hackathon Details` when relevant
8. `## Workshop Details` when relevant
9. `## Sponsors`
10. `## Unresolved Questions`
11. `## Source Notes`

### `speakers/<speaker-slug>.md`

Use these sections in order:

1. `# <speaker name>`
2. `## Profile`
3. `## Background`
4. `## Technical Focus`
5. `## Notable Work`
6. `## Event Relevance`
7. `## Sessions`
8. `## Links`
9. `## Sources`

For each speaker, attempt to fill education, career, technical stack, projects, publications/talks, communities, awards, and event relevance. Use `Not found in sources` for important missing categories instead of silently omitting them.

## Parallel Research Guidance

After extracting official event facts, use parallel subagents when the environment supports them:

- One speaker per subagent is the default. Combine only when there are many minor speakers and source volume is low.
- Give each subagent the speaker name, known affiliation, session title, event URL/title, and any official profile links.
- Ask for a JSON fragment matching the `speakers[]` object above, plus source URLs and confidence notes.
- Ask subagents to disambiguate identity. If multiple people share the name, require evidence tying the profile to the event affiliation/session.
- Keep file writing and final synthesis in the main agent to avoid conflicts.

### `links.md`

Group links by `kind`: official, speaker, material, recording, repository, social, sponsor, other.

### `sources.md`

List every source with URL, retrieval date, kind, confidence, and notes. Call out conflicts between official pages and enrichment sources.
