# Antigravity Context for gstack-fork

This repository is a fork of [garrytan/gstack](https://github.com/garrytan/gstack) built with compatibility for **Antigravity** workflows in mind. 
It preserves all core gstack paradigms while exposing `gstack` functionalities seamlessly to the Antigravity agent context.

## Core Directives for Agents

1. **Isolation of Modifications**: 
   - Antigravity should avoid directly modifying core `gstack` infrastructure files (such as `package.json`, `.github/workflows/`, and `scripts/`) to maintain an easy upgrade path. 
   - Any agentic modifications for Antigravity compatibility belong strictly within the `.agents/` directory.
   
2. **Workflows**: 
   - All automations to synchronize the local fork with upstream reside in `.agents/workflows/`. Use the `// turbo-all` annotations when running workflows defined in this repo so they seamlessly rebase code securely.
   - For execution, prioritize running bash commands over generic JS logic when scripting setup/deploy. 

3. **Rebase Protocol**:
   - The primary strategy for syncing `upstream/main` is **rebase atop**. Never create merge commits unless resolving a deep conflict manually prompts it. The `sync-upstream.md` workflow outlines this process.

4. **Skill Execution (Claude Code Emulation)**:
   - When a user explicitly calls a `gstack` slash command (e.g., `/qa`, `/autoplan`, `/ship`), you **MUST** act as the `gstack` runtime. 
   - Do NOT simply summarize the text of the `SKILL.md` file or treat it as passive context.
   - You MUST read the skill file and execute its step-by-step pipeline exactly as written.
   - You MUST actively execute the bash scripts contained in the markdown blocks using the `run_command` tool.
   - You MUST pause to solicit user feedback strictly using the defined `AskUserQuestion` format rules instead of conversational questions.
