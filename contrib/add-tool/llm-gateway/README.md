# llm-cli-gateway Integration for gstack

[llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) provides
unified multi-LLM orchestration via 23 MCP tools. This integration adds Gemini
as a third review voice, async parallel orchestration, and session continuity
to gstack skills.

## Install

    bash contrib/add-tool/llm-gateway/install.sh [claude|codex|all]

## What it does

When llm-cli-gateway is installed and configured as an MCP server, gstack
skills gain a "Multi-LLM Orchestration" section with contextual tool
recommendations. For example:

- `/review` gets async parallel Gemini + Codex reviews with cross-model synthesis
- `/investigate` gets Gemini hypothesis validation alongside Codex second opinion
- `/plan-eng-review` gets multi-model architecture feedback
- `/ship` gets parallel pre-ship reviews from all available models

See `tools.json` for the complete routing table.

## Relationship to existing multi-LLM

gstack already invokes Codex via shell subprocess (`codex exec`). This
integration does NOT replace that — it adds complementary capabilities:

| Existing | Gateway adds |
|----------|-------------|
| Codex via `codex exec` (Bash) | Codex via `mcp__llm-cli-gw__codex_request` (MCP, structured) |
| Claude subagent (Agent tool) | Gemini as third voice (new) |
| Sequential blocking calls | Async parallel orchestration (new) |
| Stateless invocations | Session continuity (new) |

## Uninstall

    bash contrib/add-tool/llm-gateway/uninstall.sh

This removes the gstack integration. llm-cli-gateway itself remains installed.
