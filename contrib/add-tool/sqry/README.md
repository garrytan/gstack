# sqry Integration for gstack

[sqry](https://github.com/verivus-oss/sqry) provides AST-based semantic code
search via 34 MCP tools. This integration adds structural code analysis to
gstack skills: callers/callees tracing, cycle detection, complexity metrics,
structural call-path tracing, and more.

## Install

    bash contrib/add-tool/sqry/install.sh [claude|codex|gemini|all]

## What it does

When sqry is installed and configured as an MCP server, gstack skills gain a
"Structural Code Analysis" section with contextual tool recommendations:

- `/investigate` gets caller/callee tracing, cycle detection, blast radius analysis
- `/cso` gets structural call-path tracing from input handlers to sinks, dead code detection
- `/review` gets complexity regression checks, cycle detection, semantic diff
- `/retro` gets structural trend analysis and codebase health metrics
- `/plan-eng-review` gets dependency visualization and architecture boundary validation
- `/ship` gets pre-ship structural verification (cycles, dead code, complexity)

See `tools.json` for the complete routing table.

## Architecture: contextual routing with static guidance

gstack owns WHEN: `tools.json` defines which sqry tools to use at which
skill phase (e.g., `trace_path` during `/cso` security analysis). This is
gstack's value-add, contextual routing that sqry doesn't know about.

Parameter guidance is static: `tools.json` contains a `parameter_guidance`
string that the resolver emits as inline markdown. No external content enters
the LLM's instruction stream at runtime.

When sqry's parameter defaults change, update the `parameter_guidance` field in
`tools.json`. It's a one-line change.

<!--
  Design history: this integration originally used sqry v8's "resource
  delegation" model, where parameter guidance was served live by the sqry
  MCP server via sqry://docs/capability-map and sqry://docs/tool-guide.
  The benefit was real: no version coupling, automatic updates when sqry
  ships new defaults.

  We moved to static guidance because MCP resource content enters the LLM's
  instruction stream in-band with skill instructions. There is no programmatic
  boundary between "read this for reference" and "follow these instructions."
  A compromised sqry-mcp binary could inject arbitrary instructions into an
  LLM with shell access. The staleness cost of static guidance is low
  (parameter defaults change infrequently). The injection risk of live
  resource reads is high (persistent attack surface on every session).

  See contrib/add-tool/README.md "Security" section for the full rationale
  and guidance for future add-ins.
-->

## Relationship to existing sqry skills

The `sqry-claude`, `sqry-codex`, and `sqry-gemini` skills (shipped with sqry)
teach agents how to *set up and use* sqry. This gstack integration is
different. It wires sqry tools into gstack's *existing workflow skills* so
they're used automatically at the right moment during debugging, review,
security audits, etc.

| sqry skills (setup) | gstack add-in (workflow) |
|---------------------|------------------------|
| Teach tool usage | Wire tools into skill phases |
| Manual invocation | Automatic contextual use |
| Generic patterns | Skill-phase routing |
| No index management | Auto-rebuild when stale |
| Parameter guidance inline | Parameter guidance inline (static in tools.json) |

## Uninstall

    bash contrib/add-tool/sqry/uninstall.sh

This removes the gstack integration. sqry itself remains installed.
