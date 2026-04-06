# Adding an External Tool to gstack

This directory contains integrations for external development tools that
enhance gstack's workflow skills with specialized capabilities.

## Structure

Each tool integration lives in its own directory:

    contrib/add-tool/<tool-name>/
    ├── README.md         # What the tool does and how the integration works
    ├── tools.json        # Routing contract: which gstack skills use which tools
    ├── detection.sh      # Bash fragment appended to preamble for detection
    ├── install.sh        # Idempotent install script
    └── uninstall.sh      # Clean removal script

## How it works

1. **Detection**: A bash block in the preamble checks if the tool binary
   exists and outputs status variables (available/unavailable, version, etc.)

2. **Resolver**: A TypeScript resolver reads `tools.json` and generates
   conditional markdown blocks for each skill template. The block is skipped
   entirely when the tool is not detected.

3. **Template**: Skills that benefit from the tool include `{{TOOL_CONTEXT}}`
   in their SKILL.md.tmpl, placed after `{{LLM_GATEWAY_CONTEXT}}` where present;
   otherwise after `{{LEARNINGS_SEARCH}}`.

## Requirements for a tool integration

- Tool MUST be optional — gstack works without it
- Detection MUST be fast (< 50ms) — it runs on every skill invocation
- Resolver output MUST be concise — avoid prompt bloat
- Install script MUST be idempotent
- Uninstall script MUST leave gstack in a clean state
- tools.json MUST include min_version for compatibility gating

## Existing integrations

- [llm-gateway](llm-gateway/) — Multi-LLM orchestration via MCP (Gemini + Codex + Claude,
  async parallel reviews, session continuity)
- [sqry](sqry/) — AST-based semantic code search via MCP (callers/callees tracing,
  cycle detection, complexity metrics, structural call-path tracing)
