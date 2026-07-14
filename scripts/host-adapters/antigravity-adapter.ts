/**
 * Google Antigravity host adapter — post-processing content transformer.
 *
 * Runs AFTER generic frontmatter/path/tool rewrites from the config system.
 * Handles semantic transformations that string-replace can't cover cleanly:
 *
 * 1. AskUserQuestion → request_user_input with headless-mode safety guard
 * 2. Agent/subagent spawning → Antigravity subagent task patterns
 * 3. Browse binary patterns ($B → antigravity exec pattern)
 * 4. Preamble binary path references → map or strip
 *
 * Headless-mode semantics:
 *   Antigravity frequently runs skills in background Git worktrees via Desktop
 *   subagents or Python SDK cron jobs. Skills that call AskUserQuestion will
 *   deadlock in a non-TTY context. The adapter wraps every AskUserQuestion
 *   reference with a conditional: if ANTIGRAVITY_HEADLESS=1, write a structured
 *   note to TODOS.md instead of blocking on stdin.
 *
 * Interface: transform(content, config) → transformed content
 */

import type { HostConfig } from '../host-config';

/** Headless-mode fallback instruction injected alongside every interactive prompt reference. */
const HEADLESS_GUARD_PROSE =
  '(If running headlessly — `ANTIGRAVITY_HEADLESS=1` or non-TTY — write a structured note ' +
  'to `TODOS.md` with the question and context instead of blocking on stdin.)';

/**
 * Transform generated SKILL.md content for Antigravity compatibility.
 * Called after all generic rewrites (paths, tools, frontmatter) have been applied.
 */
export function transform(content: string, _config: HostConfig): string {
  let result = content;

  // 1. ── AskUserQuestion → request_user_input with headless guard ──────────
  //
  // Match only the tool-call instruction patterns (capitalized function-name style),
  // not conversational prose like "you may ask the user a question". This prevents
  // mutating normal explanatory text.
  //
  // Patterns targeted:
  //   "Use AskUserQuestion to …"
  //   "use AskUserQuestion to …"
  //   "call AskUserQuestion"
  //   bare "AskUserQuestion" inside a code fence or instruction block
  //
  // We append the headless guard note only once per replacement to avoid repetition.
  result = result.replaceAll(
    'Use AskUserQuestion',
    `Use request_user_input ${HEADLESS_GUARD_PROSE}`
  );
  result = result.replaceAll(
    'use AskUserQuestion',
    `use request_user_input ${HEADLESS_GUARD_PROSE}`
  );
  result = result.replaceAll(
    'call AskUserQuestion',
    `call request_user_input ${HEADLESS_GUARD_PROSE}`
  );
  // Bare noun reference fallback (after above patterns are consumed)
  result = result.replaceAll('AskUserQuestion', 'request_user_input');

  // 2. ── Agent/subagent spawning → Antigravity patterns ───────────────────
  //
  // "the Agent tool" was already handled by toolRewrites ("use the Agent tool" →
  // "spawn a subagent task"), but bare noun patterns need direct replacement here.
  result = result.replaceAll('the Agent tool', 'the subagent task system');
  result = result.replaceAll('Agent tool',     'subagent task system');
  // Codex-style parameter naming that leaks into skill prose
  result = result.replaceAll('subagent_type',  'task type');

  // 3. ── Browse binary patterns ────────────────────────────────────────────
  //
  // $B is the gstack browse binary shorthand. In Antigravity, wrap in exec call.
  // Only rewrite inside code fences to avoid mangling prose.
  result = result.replace(/`\$B /g, '`exec $B ');

  // 4. ── Preamble binary path references ──────────────────────────────────
  //
  // Global bin paths like ~/.antigravity/skills/gstack/bin/gstack-X are already
  // rewritten by pathRewrites. Keep them as-is (the exec model works the same).
  // Nothing to strip or remap here.

  // 5. ── TODOS.md headless fallback instruction (structured note format) ───
  //
  // When a skill explicitly instructs writing to a file on headless runs, ensure
  // the instruction references a valid, linting-compliant markdown format:
  //
  //   ## TODO: [Skill Name] — [ISO timestamp]
  //   **Question:** <question text>
  //   **Context:** <context>
  //   **Expected response:** <what the skill is waiting for>
  //
  // This is injected as a comment in the section that mentions TODOS.md if the
  // pattern doesn't already exist in the content (idempotency guard).
  const TODOS_FORMAT_HINT =
    '<!-- Antigravity headless format:\n' +
    '  ## TODO: [Skill] — [ISO timestamp]\n' +
    '  **Question:** <text>\n' +
    '  **Context:** <context>\n' +
    '  **Expected response:** <what to provide when unblocking>\n' +
    '-->';
  if (result.includes('TODOS.md') && !result.includes('Antigravity headless format')) {
    result = result.replace('TODOS.md', `TODOS.md\n${TODOS_FORMAT_HINT}`);
  }

  return result;
}
