#!/usr/bin/env bun
/**
 * PostToolUse (Bash) hook declared in /plan-ceo-review's frontmatter.
 *
 * Step 0E's mode handoff line (from bin/gstack-ceo-mode-handoff) must reach
 * the user, but Claude Code collapses Bash output, and models often open the
 * next chat with a paraphrase instead of the line (periodic red 37272185151;
 * 1 of 10 trials led with it even with a reminder beside the line). This hook
 * shows the helper's line to the user as a system message, so the user sees
 * it whatever the model writes next.
 *
 * Reads only the helper's own output: the command must be a plain invocation
 * of gstack-ceo-mode-handoff and the first stdout line must have the helper's
 * exact shape. Anything else prints nothing. Always exits 0.
 */
const HANDOFF_LINE = /^(?:Auto-decided review mode → (?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION) \(your preference\)\. Change with \/plan-tune\. Approved decisions: .+\.|Mode: (?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION); approved decisions: .+\.)$/;

export function handoffMessage(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const { tool_name: tool, tool_input: toolInput, tool_response: response } = input as Record<string, any>;
  if (tool !== 'Bash' || typeof toolInput?.command !== 'string') return null;
  if (!/(?:^|[\s"'/])gstack-ceo-mode-handoff["']?\s/.test(toolInput.command)) return null;
  const stdout = typeof response === 'string' ? response : typeof response?.stdout === 'string' ? response.stdout : '';
  const line = stdout.split(/\r?\n/).find(l => l.trim())?.trim() ?? '';
  return HANDOFF_LINE.test(line) ? line : null;
}

if (import.meta.main) {
  try {
    const message = handoffMessage(JSON.parse(await Bun.stdin.text()));
    if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  } catch { /* A hook failure never blocks the session. */ }
  process.exit(0);
}
