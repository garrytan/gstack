---
paths:
  - "**/*.tmpl"
  - "**/SKILL.md"
  - "**/SKILL.md.tmpl"
  - "**/skills/**"
---

# Skill Engineering Standards

These rules apply when creating, editing, or generating skill files. They are derived
from Anthropic's official "Complete Guide to Building Skills for Claude" (PDF),
the Claude Code documentation (code.claude.com/docs/en/skills), and the reference
implementation at github.com/anthropics/skills/tree/main/skills/skill-creator.

## The Three-Level Progressive Disclosure System

Skills use a three-level loading system to minimize token usage:

1. **Metadata (frontmatter)** — Always in Claude's context (~100 words). Just enough
   for Claude to know WHEN to load the skill. Never put instructions here.
2. **SKILL.md body** — Loaded when skill triggers. Core instructions, workflow steps,
   behavior rules. Target: under 500 lines.
3. **Supporting files (references/, scripts/, agents/, assets/)** — Loaded on demand.
   Detailed reference docs, executable scripts, subagent instructions, templates.
   Claude reads these via file tools when SKILL.md links to them.

This is the most important principle. Everything else follows from it.

## Size Limits

- **SKILL.md: under 500 lines.** This is the hard target. Anthropic's own skill-creator
  is 486 lines with 3,000+ lines in supporting files.
- If approaching 500 lines, move content to `references/` and link to it.
- For large reference files (>300 lines), include a table of contents at the top.
- Description: under 1024 characters.
- Aggregate description budget across all loaded skills: ~16,000 characters (2% of
  context window). This is model-dependent.

## Skill Directory Structure

```
skill-name/
├── SKILL.md              # Required — core instructions (<500 lines)
├── references/           # Detailed docs, loaded on demand
│   ├── api-guide.md
│   └── examples.md
├── scripts/              # Executable code for deterministic tasks
│   ├── validate.py
│   └── deploy.sh
├── agents/               # Subagent instructions (grader, reviewer, etc.)
│   └── grader.md
└── assets/               # Templates, fonts, icons used in output
    └── report-template.html
```

When a skill has content that belongs in supporting files, reference them clearly:
```markdown
For the full push toolkit, see [references/push-toolkit.md](references/push-toolkit.md)
```

Use `${CLAUDE_SKILL_DIR}` for portable file references in bash commands:
```bash
python ${CLAUDE_SKILL_DIR}/scripts/validate.py
```

## Frontmatter Requirements

```yaml
---
name: skill-name
description: What it does + when to use it + trigger phrases
---
```

**name (required):**
- Kebab-case only (lowercase letters, numbers, hyphens)
- No spaces, underscores, or capitals
- Should match the folder name
- Max 64 characters

**description (required):**
- Must include BOTH what the skill does AND when to use it
- Include specific trigger phrases users would say
- Under 1024 characters
- No XML angle brackets (< >) — security restriction
- Make descriptions slightly "pushy" — Claude tends to undertrigger skills.
  Instead of just "Manages projects", write "Manages projects including task
  creation, sprint planning, and status tracking. Use when user mentions
  sprints, tasks, project planning, or asks to create tickets."

**disable-model-invocation: true** — Use for task workflows with side effects
(file creation, git operations, deployment, state management). Prevents Claude
from auto-triggering the skill.

**Other optional fields:** allowed-tools, model, effort, context, agent, hooks,
argument-hint, user-invocable, compatibility, metadata (author, version).

## Forbidden

- XML angle brackets (< >) in frontmatter
- Skills named with "claude" or "anthropic" prefix (reserved)
- README.md inside the skill folder (all docs go in SKILL.md or references/)

## Writing Effective Skills

### Structure the SKILL.md

1. **Critical instructions at the top.** Behavioral precedence, decision boundaries,
   and rules that must never be violated go first.
2. **Core workflow in the middle.** Step-by-step instructions, phases, stages.
3. **Reference links at the bottom.** Point to supporting files for details.

### Writing Style

- **Explain why, not just what.** Claude has good theory of mind. When you explain
  the reasoning, Claude can generalize beyond the specific instruction.
- **Avoid heavy-handed MUSTs.** If you find yourself writing ALWAYS or NEVER in
  all caps, reframe — explain the reasoning so Claude understands why it matters.
  That's more effective than rigid rules.
- **Be specific and actionable.** "Run `python scripts/validate.py --input {file}`"
  is better than "Validate the data."
- **Use imperative form.** "Check the output" not "You should check the output."
- **Include examples.** Show input/output pairs for non-obvious behaviors.
- **Include error handling.** What to do when things fail, with specific actions.

### What Goes in SKILL.md vs Supporting Files

| Content type | Location | Why |
|---|---|---|
| Core workflow steps | SKILL.md | Needed every invocation |
| Decision boundaries | SKILL.md | Critical behavioral rules |
| Behavior rules | SKILL.md | Always relevant |
| Detailed tables/toolkits | references/ | Only needed in specific phases |
| JSON schemas/templates | references/ | Loaded when generating output |
| State management templates | references/ | Only needed during state writes |
| Subagent instructions | agents/ | Only loaded when spawning agent |
| Validation/deployment scripts | scripts/ | Executed, not loaded into context |
| Complex bash operations | scripts/ | Keeps SKILL.md clean |
| HTML templates | assets/ | Used in output generation |

### Anti-Patterns

- **Monolith SKILL.md** — Everything in one file. Split into SKILL.md + references/.
- **Inline bash blocks** for complex operations — Extract to scripts/.
- **Duplicated instructions** across skills — Extract shared content to references/.
- **Missing description triggers** — Description that says what but not when.
- **Verbose state templates** inline — Move JSON/state templates to references/.
- **Instructions too verbose** — Top cause of "Claude doesn't follow instructions."
  Keep concise; move detail to references/.
- **Instructions buried** — Critical rules at line 1400 will be missed. Put them
  at the top or in a clearly marked ## Critical section.

## gstack Template System

gstack generates SKILL.md from `.tmpl` templates via `gen-skill-docs`. When writing
templates:

- Use `<!-- ref:filename.md -->` ... `<!-- /ref -->` markers to indicate content
  that should be extracted into `references/filename.md` during generation.
- The pipeline replaces the marked block with a markdown link to the reference file.
- Markers must be at line start (not inside code blocks).
- No nesting of ref markers.
- Missing `<!-- /ref -->` closing tag is an error.

## Validation Checklist

Before shipping a skill:
- [ ] SKILL.md under 500 lines
- [ ] Folder named in kebab-case
- [ ] YAML frontmatter has `---` delimiters
- [ ] name field: kebab-case, matches folder
- [ ] description includes WHAT and WHEN
- [ ] description under 1024 characters
- [ ] No XML angle brackets in frontmatter
- [ ] Instructions are specific and actionable
- [ ] Error handling included
- [ ] Supporting files referenced clearly from SKILL.md
- [ ] Critical instructions near the top
- [ ] No README.md in the skill folder
