#!/usr/bin/env python3
"""
gstack -> Hermes port translator.

Reads a gstack SKILL.md from STDIN, writes a Hermes-native SKILL.md to STDOUT.
Uses the rewrites Garry already defined in hosts/hermes.ts as the canonical
mapping, plus additional rewrites for gstack-specific runtime references
(binaries, Conductor, gbrain, AskUserQuestion Format) that have no Hermes
equivalent.

Usage:
    python port.py < gstack-repo/<skill>/SKILL.md > hermes/<skill>/SKILL.md
"""
import re
import sys
from pathlib import Path

# Tool rewrites from hosts/hermes.ts (canonical, Garry-defined)
TOOL_REWRITES = {
    r"\buse the Bash tool\b": "use the terminal tool",
    r"\buse the Write tool\b": "use the write_file tool",
    r"\buse the Read tool\b": "use the read_file tool",
    r"\buse the Edit tool\b": "use the patch tool",
    r"\buse the Agent tool\b": "use delegate_task",
    r"\buse the Grep tool\b": "use search_files",
    r"\buse the Glob tool\b": "use search_files",
    r"\bthe Bash tool\b": "the terminal tool",
    r"\bthe Read tool\b": "the read_file tool",
    r"\bthe Write tool\b": "the write_file tool",
    r"\bthe Edit tool\b": "the patch tool",
    r"\bthe Agent tool\b": "delegate_task",
    r"\buse Grep\b": "use search_files",
    r"\buse Glob\b": "use search_files",
    r"\buse Bash\b": "use terminal",
    r"\buse Read\b": "use read_file",
    r"\buse Write\b": "use write_file",
    r"\buse Edit\b": "use patch",
}

# Path / config rewrites
PATH_REWRITES = {
    r"~/.claude/skills/gstack": "~/.hermes/skills/gstack",
    r"\.claude/skills/gstack": ".hermes/skills/gstack",
    r"\.claude/skills": ".hermes/skills",
    r"\bCLAUDE\.md\b": "AGENTS.md",
    r"~/.gstack/": "~/.hermes/gstack/",
    r"~/.claude/": "~/.hermes/",
    r"\$GSTACK_HOME": "$HERMES_HOME",
}

# Sections / features that have NO Hermes equivalent
# These are stripped (with a small inline note pointing to the closest Hermes feature)
NO_HERMES_SECTIONS = [
    # gstack preamble runtime — Claude-only, shells out to gstack-skill-start
    (r"## Preamble \(run first\)\s*\n```bash[\s\S]*?```\s*\n", "## Preamble\n\n_Replaces the gstack `gstack-skill-start` preamble. In Hermes, the equivalent is to call `session_search` to recover prior context, then proceed._\n\n"),
    # gstack skill-end telemetry
    (r"## Telemetry \(run last\)[\s\S]*?(?=## |\Z)",
     "## Telemetry\n\n_Replaces `gstack-skill-end`. In Hermes, log durable facts to memory and continue. The Hermes gateway handles cross-session metrics._\n\n"),
    # gbrain blocks
    (r"## GBrain Context Load[\s\S]*?(?=## |\Z)",
     "## Context Recovery\n\n_Replaces `gbrain`. Use `session_search` to recover prior context._\n\n"),
    (r"## GBrain Save Results[\s\S]*?(?=## |\Z)",
     "## Session Save\n\n_Replaces gbrain save. Use `session_search` to make current session discoverable later._\n\n"),
    # AskUserQuestion Format — the 100+ line Claude Code decision-brief spec
    (r"## AskUserQuestion Format\s*\n[\s\S]*?(?=\n## |\Z)",
     "## Decision-Brief Format\n\n_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._\n\n"),
    # Plan Mode specifics — Hermes has no plan mode
    (r"## Plan Mode Safe Operations[\s\S]*?(?=\n## |\Z)", ""),
    (r"## Skill Invocation During Plan Mode[\s\S]*?(?=\n## |\Z)", ""),
    # Conductor references
    (r"\*\*`CONDUCTOR_SESSION: true`\*\*[\s\S]*?(?=\n\n|\Z)", ""),
    # Question tuning (Claude-Code-only runtime)
    (r"## Question Tuning[\s\S]*?(?=## |\Z)", ""),
    # Operational self-improvement with gstack-learnings-log binary
    (r"## Operational Self-Improvement[\s\S]*?(?=## |\Z)",
     "## Operational Self-Improvement\n\n_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._\n\n"),
    # Continuous checkpoint mode
    (r"## Continuous Checkpoint Mode[\s\S]*?(?=## |\Z)", ""),
    # Context Health (soft directive)
    (r"## Context Health \(soft directive\)[\s\S]*?(?=## |\Z)", ""),
    # Confusion Protocol duplicates, but useful — keep
    # Repo Ownership — keep
    # Search Before Building — keep
    # Completion Status Protocol — keep
    # Voice section — keep but trim
    # Writing Style — keep
    # Completeness Principle — keep
    # Third-Party Web Actions — keep but note Hermes uses browser tools
    # SETUP section — strip (references the gstack browse binary)
    (r"## SETUP \(run this check BEFORE any browse command\)[\s\S]*?(?=## |\Z)", ""),
    # Plan Status Footer — strip
    (r"## Plan Status Footer[\s\S]*?(?=## |\Z)", ""),
    # Auto-generated from .tmpl comment
    (r"<!-- AUTO-GENERATED from SKILL\.md\.tmpl[\s\S]*?-->\s*\n", ""),
]

# Section header rewrites (gstack → Hermes)
HEADER_REWRITES = {
    "When to invoke this skill": "When to Use",
    "## When to Use": "## When to Use",  # no-op, kept for clarity
}

# Frontmatter rewrites
def rewrite_frontmatter(text: str) -> str:
    """Convert gstack frontmatter to Hermes frontmatter.

    - Drop preamble-tier (Hermes has no tier system)
    - Drop allowed-tools (Hermes skills don't gate tools)
    - Drop triggers (Hermes uses the description as the trigger)
    - Drop gbrain section (no Hermes equivalent)
    - Drop hooks (Hermes has no PreToolUse hook system)
    - Add Hermes-required fields: version, author, license, metadata.hermes
    """
    # Split frontmatter
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        return text

    fm = m.group(1)
    body = text[m.end():]

    # Parse and filter
    lines = fm.split("\n")
    keep = []
    skip_section = False
    for line in lines:
        if line.startswith("name:") or line.startswith("description:") or line.startswith("version:"):
            keep.append(line)
            skip_section = False
        elif line.startswith(("preamble-tier:", "allowed-tools:", "triggers:", "gbrain:", "hooks:", "model-overlays:")):
            skip_section = True
        elif skip_section:
            if line.startswith("  -") or line.startswith("    -") or line.strip() == "":
                continue
            elif not line.startswith(" "):
                skip_section = False
                keep.append(line)
            else:
                continue
        else:
            keep.append(line)

    # Add Hermes metadata block
    name_match = re.search(r"^name:\s*(\S+)", fm, re.MULTILINE)
    desc_match = re.search(r"^description:\s*(.*?)(?=\n[a-z]+:|\Z)", fm, re.MULTILINE | re.DOTALL)
    name = name_match.group(1) if name_match else "unnamed-skill"
    desc = desc_match.group(1).strip().strip("\"") if desc_match else ""

    # Truncate description to 1024 chars (Hermes limit)
    if len(desc) > 1024:
        desc = desc[:1020] + "..."

    # Rewrite description: prefix with "Use when ... <one-line>"
    if not desc.startswith("Use when"):
        # Heuristic: take first sentence of desc, add Use when
        first_sentence = re.split(r"[.\n]", desc)[0]
        if first_sentence:
            new_desc = f"Use when {first_sentence.lower()}. (Ported from gstack to Hermes)"
        else:
            new_desc = f"Use when invoking the {name} skill. (Ported from gstack to Hermes)"
    else:
        new_desc = f"{desc} (Ported from gstack to Hermes)" if "Ported" not in desc else desc

    if len(new_desc) > 1024:
        new_desc = new_desc[:1020] + "..."

    new_fm_lines = [
        f"name: {name}",
        f"description: {new_desc}",
        "version: 1.0.0",
        "author: gstack (port: Hermes Agent)",
        "license: MIT",
        "metadata:",
        "  hermes:",
        "    tags: [gstack, ported, workflow]",
        f"    related_skills: [hermes-agent, hermes-agent-skill-authoring]",
        f"    upstream: https://github.com/garrytan/gstack/blob/main/{name}/SKILL.md",
    ]

    return "---\n" + "\n".join(new_fm_lines) + "\n---\n" + body


def rewrite_body(text: str) -> str:
    """Apply all body-level rewrites."""
    for pattern, replacement in NO_HERMES_SECTIONS:
        text = re.sub(pattern, replacement, text, flags=re.MULTILINE)

    for pattern, replacement in TOOL_REWRITES.items():
        text = re.sub(pattern, replacement, text)

    for pattern, replacement in PATH_REWRITES.items():
        text = re.sub(pattern, replacement, text)

    return text


def port_skill(text: str) -> str:
    text = rewrite_frontmatter(text)
    text = rewrite_body(text)
    return text


def main():
    if len(sys.argv) > 1:
        in_path = Path(sys.argv[1])
        text = in_path.read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()

    print(port_skill(text), end="")


if __name__ == "__main__":
    main()
