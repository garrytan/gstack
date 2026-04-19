/**
 * Tool compatibility map across provider CLIs.
 *
 * Not all provider CLIs expose equivalent tools. A benchmark that uses Edit, Glob,
 * or Grep won't run cleanly on CLIs that don't have those. The map answers:
 * "which tools does each provider's CLI expose by default?"
 *
 * When a benchmark is scoped to a tool a provider lacks, the harness records
 * `unsupported_tool` in the result and continues with the other providers.
 *
 * Source-of-truth references:
 *   - Claude Code: https://code.claude.com/docs/en/tools
 *   - Codex CLI: `codex exec --help` tool listing
 *   - Gemini CLI: `gemini --help` (limited tool surface as of 2026-04)
 */

export type ToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Agent'
  | 'Glob'
  | 'Grep'
  | 'AskUserQuestion'
  | 'WebSearch'
  | 'WebFetch';

export const TOOL_COMPATIBILITY: Record<'claude' | 'gpt' | 'gemini', Record<ToolName, boolean>> = {
  claude: {
    Read: true,
    Write: true,
    Edit: true,
    Bash: true,
    Agent: true,
    Glob: true,
    Grep: true,
    AskUserQuestion: true,
    WebSearch: true,
    WebFetch: true,
  },
  gpt: {
    // Codex CLI has a narrower tool surface: it uses shell + apply_patch.
    // Read/Glob/Grep-style operations happen via shell pipelines.
    Read: true,
    Write: false,       // apply_patch handles writes; no standalone Write tool
    Edit: false,        // apply_patch handles edits; no standalone Edit tool
    Bash: true,
    Agent: false,
    Glob: false,
    Grep: false,
    AskUserQuestion: false,
    WebSearch: true,    // --enable web_search_cached
    WebFetch: false,
  },
  gemini: {
    // Gemini CLI (as of 2026-04) has a limited tool surface in --yolo mode.
    // Shell access depends on flags; most agentic tools are not exposed.
    Read: true,
    Write: false,
    Edit: false,
    Bash: false,
    Agent: false,
    Glob: false,
    Grep: false,
    AskUserQuestion: false,
    WebSearch: true,
    WebFetch: false,
  },
};

/**
 * Determine which tools from a required-set are missing for a given provider.
 * Empty array means full compatibility.
 */
export function missingTools(
  provider: 'claude' | 'gpt' | 'gemini',
  requiredTools: ToolName[]
): ToolName[] {
  const map = TOOL_COMPATIBILITY[provider];
  return requiredTools.filter(t => !map[t]);
}
