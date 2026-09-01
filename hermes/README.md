# gstack Skills Ported to Hermes

This directory contains **53 gstack skills** ported from [garrytan/gstack](https://github.com/garrytan/gstack) to run natively on **Hermes Agent** (Nous Research).

## What Was Ported

All 53 skills with `SKILL.md` files from the gstack main branch have been mechanically translated to Hermes-native format, plus this meta-directory.

| Original Skill | Port Status | Notes |
|---|---|---|
| office-hours | ✅ Ported | Replaces gstack preamble/telemetry with `session_search` |
| autoplan | ✅ Ported | Runs plan-* reviews sequentially |
| benchmark | ✅ Ported | Performance regression detection |
| benchmark-models | ✅ Ported | Cross-model benchmark |
| browse | ✅ Ported | Maps `$B` → `terminal` (Hermes has `computer-use`) |
| browser-skills/hackernews-frontpage | ✅ Ported | Example browser skill |
| canary | ✅ Ported | Post-deploy monitoring |
| careful | ✅ Ported | Safety guardrails via Hermes approvals |
| codex | ⚠️ Ported | References OpenAI Codex CLI — works if `codex` in PATH |
| context-restore | ✅ Ported | Maps to `session_search` + `memory` |
| context-save | ✅ Ported | Maps to `memory` tool |
| cso | ✅ Ported | OWASP Top 10 + STRIDE audit |
| design-consultation | ✅ Ported | Design system builder |
| design-html | ✅ Ported | Pretext-native HTML/CSS |
| design-review | ✅ Ported | Visual audit + fix loop |
| design-shotgun | ✅ Ported | Multi-variant design iteration |
| devex-review | ✅ Ported | TTHW developer experience audit |
| diagram | ✅ Ported | Mermaid/Excalidraw diagrams |
| document-generate | ✅ Ported | Diataxis docs from code |
| document-release | ✅ Ported | Update docs to match shipped code |
| freeze | ✅ Ported | Directory edit restrictions |
| guard | ✅ Ported | careful + freeze combined |
| health | ✅ Ported | Code quality dashboard |
| investigate | ✅ Ported | Systematic root-cause debugging (4 phases) |
| ios-clean | ⚠️ Ported | iOS build cleanup — requires Mac + iOS toolchain |
| ios-design-review | ⚠️ Ported | iOS HIG audit — requires iPhone |
| ios-fix | ⚠️ Ported | Autonomous iOS bug fixer — requires iPhone |
| ios-qa | ⚠️ Ported | Live iOS QA — requires USB iPhone + Mac |
| land-and-deploy | ✅ Ported | PR merge → CI → deploy verification |
| landing-report | ✅ Ported | Ship queue dashboard |
| learn | ✅ Ported | Project learnings via `memory` |
| make-pdf | ✅ Ported | Markdown → PDF via `nano-pdf` |
| open-gstack-browser | ⚠️ Ported | Requires gstack browse binary |
| pair-agent | ⚠️ Ported | Browser sharing — needs gstack browse |
| plan-ceo-review | ✅ Ported | CEO/founder plan review (4 modes) |
| plan-design-review | ✅ Ported | Design rubric review |
| plan-devex-review | ✅ Ported | DX/TTHW review |
| plan-eng-review | ✅ Ported | Architecture/edge-case review |
| plan-tune | ✅ Ported | Question sensitivity tuning |
| qa | ⚠️ Ported | Web QA — maps to Hermes `dogfood` skill |
| qa-only | ⚠️ Ported | QA report-only mode |
| retro | ✅ Ported | Weekly team retro |
| review | ✅ Ported | Pre-landing PR review (5 steps) |
| scrape | ✅ Ported | Web scrape + codify to skill |
| setup-browser-cookies | ⚠️ Ported | Browser auth — needs gstack browse |
| setup-deploy | ✅ Ported | Deploy platform detection |
| setup-gbrain | ⚠️ Ported | gbrain setup — notes Hermes has native memory |
| ship | ✅ Ported | Test → review → push → PR workflow |
| skillify | ✅ Ported | Codify scrape flow to skill |
| spec | ✅ Ported | Vague intent → executable spec (5 phases) |
| sync-gbrain | ⚠️ Ported | gbrain sync — notes Hermes has native memory |
| unfreeze | ✅ Ported | Remove directory restrictions |

**Total: 53 skills ported**

## What Was Changed (Translation Rules)

1. **Frontmatter** → Hermes-required fields: `name`, `description` (≤1024 chars, prefixed with "Use when..."), `version`, `author`, `license`, `metadata.hermes` (tags, related_skills, upstream URL).

2. **Tool Rewrites** (from gstack's `hosts/hermes.ts`):
   - `Bash` → `terminal`
   - `Read` → `read_file`
   - `Write` → `write_file`
   - `Edit` → `patch`
   - `Agent` → `delegate_task`
   - `Grep`/`Glob` → `search_files`
   - `$B` → `terminal` (browse alias)
   - `$D` → `terminal` (dogfood alias)

3. **Path Rewrites**:
   - `~/.claude/skills/gstack` → `~/.hermes/skills/gstack`
   - `~/.gstack/` → `~/.hermes/gstack/`
   - `CLAUDE.md` → `AGENTS.md`
   - `bin/gstack-*` binaries → Hermes tool equivalents

4. **Sections Stripped** (no Hermes equivalent):
   - Plan Mode sections
   - Conductor session references
   - Question Tuning
   - Continuous Checkpoint Mode
   - SETUP (browse binary)
   - Plan Status Footer

5. **Sections Replaced**:
   - `Preamble` → note about `session_search`
   - `Telemetry` → note about `memory`
   - `AskUserQuestion Format` → note about `clarify` tool
   - `GBrain` sections → `session_search`/`memory`
   - `Artifacts Sync` → `session_search`
   - `Operational Self-Improvement` → `memory` + `skill_manage`

## How to Use on Hermes

```bash
# 1. Copy a skill to your Hermes skills directory
mkdir -p ~/.hermes/skills/gstack
cp -r gstack/hermes/investigate ~/.hermes/skills/gstack/

# 2. Load the skill in a Hermes session
# In Hermes chat:
/skill investigate

# Or load explicitly at startup:
hermes -s gstack/investigate chat

# 3. Use the skill by invoking its trigger
# e.g., "debug this", "fix this bug" → triggers investigate
```

Or install all at once:
```bash
cp -r gstack/hermes/* ~/.hermes/skills/
# Then in Hermes:
/skill gstack/investigate
```

## Skills Requiring External Infrastructure

The following ported skills reference infrastructure that may not exist on your machine:

| Skill | Required | Hermes Alternative |
|---|---|---|
| ios-qa, ios-fix, ios-design-review, ios-clean, ios-sync | Mac + iPhone via USB | Use Hermes `computer-use` for desktop |
| browse, open-gstack-browser, pair-agent, setup-browser-cookies | gstack browse binary (Bun + Chromium) | Use Hermes `computer-use` |
| setup-gbrain, sync-gbrain | gbrain (PGLite/Supabase) | Hermes has native `memory` + `session_search` |
| codex | OpenAI Codex CLI in PATH | Hermes has `autonomous-ai-agents/codex` skill |

These skills are ported for completeness but will need the above installed to function fully.

## Contributing Back to gstack

This port was generated by a mechanical translator (`hermes/_meta/port_v2.py`) with minimal hand-editing. The goal is to give gstack users on Hermes immediate access to the skill library, while keeping upstream reference links so future gstack improvements can be re-ported.

If you're a gstack maintainer reviewing this PR:
- All skills preserve their original workflow logic
- Only tool names, paths, and runtime references were rewritten
- Each skill has an `upstream` URL in `metadata.hermes` pointing to the source
- The translator script is at `hermes/_meta/port_v2.py` for re-running

## License

Same as gstack (MIT). Original authors: Garry Tan + gstack contributors. Port: Hermes Agent.

---

*Generated by `hermes/_meta/port_v2.py` from gstack commit 394db32 (v1.71.0.0)*