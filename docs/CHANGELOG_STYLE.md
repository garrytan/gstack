# CHANGELOG entry format

Moved verbatim from CLAUDE.md (token-load reduction). Read this BEFORE
writing any `## [X.Y.Z]` CHANGELOG entry.

### Release-summary format (every `## [X.Y.Z]` entry)

Every version entry in `CHANGELOG.md` MUST start with a release-summary section in
the GStack/Garry voice, one viewport's worth of prose + tables that lands like a
verdict, not marketing. The itemized changelog (subsections, bullets, files) goes
BELOW that summary, separated by a `### Itemized changes` header.

The release-summary section gets read by humans, by the auto-update agent, and by
anyone deciding whether to upgrade. The itemized list is for agents that need to
know exactly what changed.

Structure for the top of every `## [X.Y.Z]` entry:

1. **Two-line bold headline** (10-14 words total). Should land like a verdict, not
   marketing. Sound like someone who shipped today and cares whether it works.
2. **Lead paragraph** (3-5 sentences). What shipped, what changed for the user.
   Specific, concrete, no AI vocabulary, no em dashes, no hype.
3. **A "The X numbers that matter" section** with:
   - One short setup paragraph naming the source of the numbers (real production
     deployment OR a reproducible benchmark, name the file/command to run).
   - A table of 3-6 key metrics with BEFORE / AFTER / Δ columns.
   - A second optional table for per-category breakdown if relevant.
   - 1-2 sentences interpreting the most striking number in concrete user terms.
4. **A "What this means for [audience]" closing paragraph** (2-4 sentences) tying
   the metrics to a real workflow shift. End with what to do.

Voice rules for the release summary:
- No em dashes (use commas, periods, "...").
- No AI vocabulary (delve, robust, comprehensive, nuanced, fundamental, etc.) or
  banned phrases ("here's the kicker", "the bottom line", etc.).
- Real numbers, real file names, real commands. Not "fast" but "~30s on 30K pages."
- Short paragraphs, mix one-sentence punches with 2-3 sentence runs.
- Connect to user outcomes: "the agent does ~3x less reading" beats "improved precision."
- Be direct about quality. "Well-designed" or "this is a mess." No dancing.

Source material:
- CHANGELOG previous entry for prior context.
- Benchmark files or `/retro` output for headline numbers.
- Recent commits (`git log <prev-version>..HEAD --oneline`) for what shipped.
- Don't make up numbers. If a metric isn't in a benchmark or production data,
  don't include it. Say "no measurement yet" if asked.

Target length: ~250-350 words for the summary. Should render as one viewport.

### Itemized changes (below the release summary)

Write `### Itemized changes` and continue with the detailed subsections (Added,
Changed, Fixed, For contributors). Same rules as the user-facing voice guidance
above, plus:

- **Always credit community contributions.** When an entry includes work from a
  community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.
