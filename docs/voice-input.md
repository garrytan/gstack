# Voice input (AquaVoice, Whisper, etc.)

Many gstack skills list speech-to-text aliases (`voice-triggers:` in their
templates): "security check" for `/cso`, "run QA" or "test the app" for `/qa`,
"tech review" for `/plan-eng-review`. Say one of those naturally and the right
skill can be picked without the slash command name. On Claude Code the aliases
are routing lines in the root `/gstack` router; on Codex and the other hosts
they are appended to each skill's description, which is what those hosts match
on.

The separate `triggers:` list in a skill's frontmatter is gstack metadata, not a
matching surface. Claude Code and Codex choose a skill from its name and
description, so a phrase that appears only under `triggers:` does not activate
the skill (Codex output drops the field; the GBrain host keeps it). The four core
skills (/office-hours, /review, /qa, /ship) carry their `triggers:` phrases in
the full description itself. On Claude Code, the one-line catalog entry for most
skills also ends with a short when-to-use clause built from the first few
`triggers:` phrases ("Use for: qa test this, find bugs on site, test the
site."), or from the skill's "Use when" sentence when it has no trigger list;
`--catalog-mode=full` and the other hosts don't get that clause.
