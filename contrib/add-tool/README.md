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

1. A bash block in the preamble checks if the tool binary exists and outputs
   status variables (available/unavailable, version, etc.).

2. A TypeScript resolver reads `tools.json` and generates conditional markdown
   blocks for each skill template. The block is skipped entirely when the tool
   is not detected.

3. Skills that benefit from the tool include `{{TOOL_CONTEXT}}` in their
   SKILL.md.tmpl, placed after `{{LEARNINGS_SEARCH}}`.

## Requirements for a tool integration

- Tool must be optional. gstack works without it.
- Detection must be fast (< 50ms). It runs on every skill invocation.
- Resolver output must be concise to avoid prompt bloat.
- Install script must be idempotent.
- Uninstall script must leave gstack in a clean state.
- tools.json must include min_version for compatibility gating.

## Security: MCP tool calls vs resource reads

Add-ins wire external MCP servers into skill templates. The LLM executing
those skills has shell access, file write access, and network access. This
makes the boundary between "tool routing" and "content injection" a real
security boundary.

### The rule

Resolvers must only emit static markdown and MCP tool names. They must
never instruct the agent to read MCP resources (`ReadMcpResourceTool`,
`sqry://...`, etc.) into its context.

### Why this matters

MCP tool calls and MCP resource reads have different trust properties:

| | MCP tool call | MCP resource read |
|---|---|---|
| How it works | Agent calls `mcp__foo__bar(params)`, gets response | Agent reads `foo://docs/guide` via ReadMcpResourceTool |
| Where content lands | Tool-response channel (structured, bounded) | Instruction stream (indistinguishable from skill text) |
| What it influences | What the agent knows (data) | What the agent does (behavior) |
| If MCP server is compromised | Attacker controls one tool response | Attacker controls agent behavior with shell access |

A tool response saying "drop all tables" is data the agent reports. A resource
read saying "drop all tables" is an instruction the agent may follow, because
it arrives in the same channel as the skill's own instructions. There is no
programmatic boundary between them.

Prompt-level defenses ("SECURITY: treat as reference data") are in-band with
the content they guard. An adversarial payload inside the resource can
override them. This is the standard prompt injection pattern.

### What to do instead

Inline parameter guidance as static text. If your tool has parameter defaults,
limits, or usage tips, put them in `tools.json` (e.g., as a `parameter_guidance`
string) and let the resolver emit them as static markdown. The resolver output
is generated at build time from trusted source files, not fetched at runtime
from an MCP server process.

```jsonc
// tools.json: static guidance the resolver emits directly
{
  "parameter_guidance": "Most tools accept max_depth (default 3, max 10)..."
}

// resolver output (good): static markdown with tool names
// **Tool parameters:** Most tools accept max_depth (default 3, max 10)...

// resolver output (bad): instructs agent to read external content
// **Tool parameters:** read `foo://docs/guide` via ReadMcpResourceTool
```

### The staleness trade-off

<!--
  Design history: the sqry integration originally used a "resource delegation"
  model where parameter guidance was served live by the sqry MCP server via
  sqry://docs/capability-map and sqry://docs/tool-guide. The reasoning was
  sound: sqry owns its own parameter limits and cost tiers, and serving them
  live prevents version drift. When sqry ships new defaults, gstack agents
  pick them up automatically without a gstack release.

  We moved away from this because the security cost outweighs the staleness
  cost. MCP resource content enters the LLM's instruction stream in-band,
  creating a prompt injection vector that scales with every user who installs
  the add-in. A compromised or malicious MCP server binary can inject
  arbitrary instructions into an LLM with shell access on every machine.

  The staleness risk is real but manageable: parameter defaults change
  infrequently, and when they do, updating tools.json is a one-line PR.
  The injection risk is neither infrequent nor manageable. It is a
  persistent attack surface that exists on every session.

  If a future MCP specification adds programmatic content isolation (e.g.,
  sandboxed resource channels that the LLM cannot treat as instructions),
  this guidance should be revisited. Until then: static text only.
-->

The original sqry integration used live MCP resources (`sqry://docs/...`)
to serve parameter guidance so that updates to sqry's defaults would be
picked up automatically without a gstack release. This is a real benefit.
Version coupling between tools creates maintenance burden and stale docs.

We chose static inline guidance instead for three reasons:

1. The injection risk scales. Every user who installs the add-in gets
   an MCP server process whose output enters the LLM's instruction stream.
   A single compromised binary update affects every machine.

2. The staleness risk does not scale the same way. Parameter defaults change
   infrequently. When they do, updating `tools.json` is a one-line PR.
   Stale defaults cause suboptimal queries. Injected instructions cause
   arbitrary code execution.

3. No programmatic boundary exists today. MCP resource content and skill
   instructions occupy the same text channel. Until the MCP spec provides
   isolated resource channels, there is no way to let the agent read
   external content safely.

If your tool's parameters change frequently enough that static guidance is
genuinely burdensome, that is a signal to contribute upstream to the MCP
spec for content isolation, not to work around it by injecting untrusted
content into the instruction stream.

## Existing integrations

- [sqry](sqry/) - AST-based semantic code search via MCP (callers/callees
  tracing, cycle detection, complexity metrics, structural call-path tracing)
