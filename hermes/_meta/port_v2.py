#!/usr/bin/env python3
"""
gstack -> Hermes port translator v2.

More robust section stripping using proper boundary detection.
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
    r"\$B\b": "terminal",  # gstack's browse alias
    r"\b\$D\b": "terminal",  # gstack's dogfood alias
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
    r"\$HERMES_HOME": "$HERMES_HOME",  # keep
    r"bin/gstack-skill-start": "# skill_manage(action='create') or skill_view",
    r"bin/gstack-skill-end": "# session_search or memory",
    r"bin/gstack-question-preference": "# clarify tool",
    r"bin/gstack-decision-log": "# memory tool",
    r"bin/gstack-decision-search": "# session_search tool",
    r"bin/gstack-learnings-log": "# memory tool",
    r"bin/gstack-slug": "# session_search tool",
    r"bin/gstack-question-log": "# memory tool",
    r"bin/gstack-brain-restore": "# memory tool / session_search",
    r"gstack-brain-sync": "# memory tool / session_search",
    r"gstack-relink": "# hermes skills config",
    r"gstack-config gbrain-refresh": "# hermes skills config",
    r"bin/gstack-paths": "# hermes config path",
    r"bin/gstack-ios-qa-daemon": "# (iOS QA not available on Hermes)",
    r"gstack-ios-qa-mint": "# (iOS QA not available on Hermes)",
    r"gstack-ios-qa-regen": "# (iOS QA not available on Hermes)",
    r"\$B\s+": "terminal ",  # browse commands
}

# Sections to COMPLETELY REMOVE (with their content until next top-level ##)
FULL_REMOVE_SECTIONS = [
    "## Plan Mode Safe Operations",
    "## Skill Invocation During Plan Mode",
    "## Question Tuning",
    "## Continuous Checkpoint Mode",
    "## Context Health \\(soft directive\\)",
    "## SETUP \\(run this check BEFORE any browse command\\)",
    "## Plan Status Footer",
    "## Third-Party Web Actions",  # Keep but note
]

# Sections to REPLACE with Hermes note
REPLACE_SECTIONS = {
    "## Preamble \\(run first\\)": "## Preamble\n\n_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._\n",
    "## Telemetry \\(run last\\)": "## Telemetry\n\n_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._\n",
    "## GBrain Context Load": "## Context Recovery\n\n_Replaces `gbrain` context loading. Use `session_search` to recover prior context._\n",
    "## GBrain Save Results": "## Session Save\n\n_Replaces gbrain save. Use `session_search` to make current session discoverable later._\n",
    "## AskUserQuestion Format": "## Decision-Brief Format\n\n_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._\n",
    "## Operational Self-Improvement": "## Operational Self-Improvement\n\n_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._\n",
    "## Artifacts Sync \\(skill start\\)": "## Artifacts Sync\n\n_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._\n",
}

# Model-specific section - keep but note it's for Claude
# Writing Style - keep but trim
# Voice - keep

# Section header rewrites
HEADER_REWRITES = {
    "When to invoke this skill": "When to Use",
}


def rewrite_frontmatter(text: str) -> str:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        return text

    fm = m.group(1)
    body = text[m.end():]

    lines = fm.split("\n")
    keep = []
    skip = False
    for line in lines:
        if line.startswith(("name:", "description:", "version:")):
            keep.append(line)
            skip = False
        elif line.startswith(("preamble-tier:", "allowed-tools:", "triggers:", "gbrain:", "hooks:", "model-overlays:")):
            skip = True
        elif skip:
            if line.startswith("  -") or line.startswith("    -") or line.strip() == "":
                continue
            elif not line.startswith(" "):
                skip = False
                keep.append(line)
            else:
                continue
        else:
            keep.append(line)

    name_match = re.search(r"^name:\s*(\S+)", fm, re.MULTILINE)
    desc_match = re.search(r"^description:\s*(.*?)(?=\n[a-z]+:|\Z)", fm, re.MULTILINE | re.DOTALL)
    name = name_match.group(1) if name_match else "unnamed-skill"
    desc = desc_match.group(1).strip().strip("\"") if desc_match else ""

    if len(desc) > 1024:
        desc = desc[:1020] + "..."

    if not desc.startswith("Use when"):
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


def strip_sections(text: str) -> str:
    """Strip or replace full sections using proper boundary detection."""
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        matched = False
        
        # Check for full-remove sections
        for pattern in FULL_REMOVE_SECTIONS:
            if re.match(pattern, line.strip()):
                # Skip until next top-level ## or EOF
                i += 1
                while i < len(lines) and not lines[i].startswith("## "):
                    i += 1
                matched = True
                break
        
        # Check for replace sections
        if not matched:
            for pattern, replacement in REPLACE_SECTIONS.items():
                if re.match(pattern, line.strip()):
                    out.append(replacement)
                    i += 1
                    while i < len(lines) and not lines[i].startswith("## "):
                        i += 1
                    matched = True
                    break
        
        if not matched:
            out.append(line)
            i += 1
    
    return "\n".join(out)


def rewrite_inline(text: str) -> str:
    """Apply inline rewrites (tools, paths, etc.)"""
    for pattern, replacement in TOOL_REWRITES.items():
        text = re.sub(pattern, replacement, text)
    for pattern, replacement in PATH_REWRITES.items():
        text = re.sub(pattern, replacement, text)
    # Strip auto-generated comment
    text = re.sub(r"<!-- AUTO-GENERATED from SKILL\.md\.tmpl[\s\S]*?-->\s*\n", "", text)
    # Strip Regenerate comment
    text = re.sub(r"<!-- Regenerate: bun run gen:skill-docs -->\s*\n", "", text)
    # Fix header
    for old, new in HEADER_REWRITES.items():
        text = text.replace(old, new)
    return text


def port_skill(text: str) -> str:
    text = rewrite_frontmatter(text)
    text = strip_sections(text)
    text = rewrite_inline(text)
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