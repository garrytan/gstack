export const type = "opencode";
export const label = "OpenCode (local)";

export const models = [
  { id: "opencode", label: "OpenCode" },
];

export const agentConfigurationDoc = `# OpenCode agent configuration

Adapter: opencode

Use when:
- The agent needs to run OpenCode CLI locally on the host machine
- You want to use OpenCode's interactive TUI or non-interactive mode
- The task requires OpenCode-specific features (e.g. multiple AI providers, session management)

Don't use when:
- You need a simple one-shot script execution (use the "process" adapter instead)
- OpenCode CLI is not installed on the host
- You need to use a different agent runtime (e.g. Claude Code, Codex)

Core fields:
- cwd (string, required): absolute working directory for the OpenCode process
- model (string, optional): OpenCode model to use (default: claude-3.5-sonnet)
- timeoutSec (number, optional): timeout for each OpenCode invocation in seconds (default: 120)
- graceSec (number, optional): grace period for OpenCode to shut down after timeout (default: 15)
- sessionHistoryLimit (number, optional): maximum number of conversation turns to keep in history (default: 10)
`;