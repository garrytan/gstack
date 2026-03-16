# OpenCode / OpenRouter Compatibility Guide

gstack skills are Markdown system prompts. They work with any runtime that discovers SKILL.md files. This guide covers what works out of the box, what needs adaptation, and known limitations when using gstack with [OpenCode](https://github.com/opencode-ai/opencode), [OpenRouter](https://openrouter.ai/), or local models.

## What works out of the box

These skills are pure prompt-based workflows. They ask the model to read files, run git commands, and produce structured output. No Claude-specific tool APIs required.

- **`/plan-ceo-review`** - Reads a plan document and produces a structured review. Uses `Read`, `Grep`, `Glob`, `Bash`, and `AskUserQuestion` tools.
- **`/plan-eng-review`** - Same tool set as plan-ceo-review. Produces architecture review with diagrams.
- **`/retro`** - Analyzes git history via `Bash` and `Read`. Produces a retrospective report.
- **`/browse` commands** - The headless browser is a compiled Bun binary. Once built, it runs as a standalone CLI via Bash. Any runtime that can execute shell commands can use it.

## What needs adaptation

### `AskUserQuestion` tool

All gstack skills use `AskUserQuestion` to interact with the user (scope mode selection, confirmation prompts, etc.). OpenCode may use a different tool name for user interaction. Check your runtime's documentation for the equivalent.

If your runtime does not support interactive questions, you can still use the skills non-interactively by providing defaults in your prompt (e.g., "Choose HOLD SCOPE mode" for plan-ceo-review).

### `$B` browse binary path

The SKILL.md setup block discovers the browse binary at:
1. `$PROJECT_ROOT/.claude/skills/gstack/browse/dist/browse` (project install)
2. `~/.claude/skills/gstack/browse/dist/browse` (global install)

If your runtime stores skills in a different directory, set the `B` variable manually:

```bash
B="/path/to/your/gstack/browse/dist/browse"
```

### Skill discovery path

Claude Code discovers skills from `~/.claude/skills/` and `.claude/skills/`. OpenCode and other runtimes may use different paths. Clone or symlink the gstack directory into whatever path your runtime searches.

### `/ship` workflow

`/ship` depends on specific tool execution ordering (merge main, run tests, review diff, bump version, commit, push, create PR). The workflow assumes the model can run Bash commands sequentially and use `Edit`/`Write` tools. Most runtimes support this, but verify your runtime handles multi-step tool chains reliably.

### `/review` with Greptile

`/review` optionally integrates with Greptile for codebase-aware review comments. This requires:
- A GitHub PR to exist
- `gh` CLI installed and authenticated
- Greptile configured on the repo

Without Greptile, `/review` still works - it just skips the Greptile triage step and reviews the raw diff.

## Known limitations

### E2E test infrastructure

The test suite (`test/skill-e2e.test.ts`) spawns `claude -p` as a subprocess. This is specific to Claude Code and does not work with other runtimes. The tests themselves are not needed to use the skills - they exist to validate skill quality during development.

### LLM-as-judge evals

`test/skill-llm-eval.test.ts` uses `@anthropic-ai/sdk` directly to call Claude as a judge. This requires an Anthropic API key and is not portable to other providers.

### Build tooling

The browse binary is built with `bun build --compile`. You need [Bun](https://bun.sh/) installed to build from source. Pre-built binaries are not distributed.

## Model selection notes

gstack skills were designed for and tested with Claude Sonnet and Opus. When using OpenRouter or other providers:

- **Review and plan skills** benefit from stronger reasoning models. Smaller models may miss subtle issues or produce shallow reviews.
- **Browse commands** are model-independent - they are CLI tools, not LLM calls.
- **Token limits** may differ between providers. Skills like `/plan-ceo-review` and `/review` can produce long outputs. Verify your provider supports sufficient output token limits.
- **Tool use support** is required. All skills rely on the model calling tools (Bash, Read, Write, etc.). Verify your model supports function calling.

## Community resources

- [gstack-on-opencode](https://github.com/mayurjobanputra/gstack-on-opencode) - Community fork for OpenCode (untested, linked from issue #16)
