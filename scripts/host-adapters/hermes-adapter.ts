/**
 * Hermes host adapter — post-processing content transformer.
 *
 * Runs AFTER generic frontmatter/path/tool rewrites from the config system.
 * Handles semantic transformations that string-replace can't cover:
 *
 * 1. AskUserQuestion → clarify tool (Hermes uses clarify, not AskUserQuestion)
 * 2. Agent/sessions_spawn → delegate_task
 * 3. Browse binary patterns ($B → Hermes browser tool calls)
 * 4. Preamble binary references → strip or note as exec-based
 * 5. Bash tool references in reasoning contexts → terminal tool
 *
 * Interface: transform(content, config) → transformed content
 */

import type { HostConfig } from '../host-config';

/**
 * Transform generated SKILL.md content for Hermes compatibility.
 * Called after all generic rewrites (paths, tools, frontmatter) have been applied.
 */
export function transform(content: string, _config: HostConfig): string {
  let result = content;

  // 1. AskUserQuestion → clarify tool
  result = result.replaceAll('AskUserQuestion', 'clarify');
  result = result.replaceAll('Use AskUserQuestion', 'Use clarify');
  result = result.replaceAll('use AskUserQuestion', 'use clarify');
  result = result.replaceAll('ask the user directly in chat', 'use the clarify tool');
  result = result.replaceAll('Ask the user directly', 'Use clarify');

  // 2. Agent tool / sessions_spawn → delegate_task
  result = result.replaceAll('sessions_spawn', 'delegate_task');
  result = result.replaceAll('the Agent tool', 'delegate_task');
  result = result.replaceAll('Agent tool', 'delegate_task');
  result = result.replaceAll('subagent_type', 'role parameter');

  // 3. Add Hermes browser note to any skill that references $B commands
  // (must run BEFORE $B replacements)
  if (result.includes('$B ')) {
    result = result.replace(
      '## Preamble (run first)',
      '## Hermes Browser Note\n\nWhen this skill references `$B` browse commands, use the Hermes browser tools: `browser_navigate`, `browser_click`, `browser_snapshot`, `browser_scroll`, `browser_press`, `browser_type`, `browser_console`, `browser_vision`. For full page content, use `browser_snapshot` with `full=true`.\n\n## Preamble (run first)'
    );
  }

  // 4. Browse binary ($B) → Hermes browser tools
  // Note: $B commands are complex to fully rewrite since Hermes has individual
  // browser tools (browser_navigate, browser_click, etc.). We add a note
  // and rewrite the most common patterns.
  result = result.replaceAll('$B goto', 'use browser_navigate to open');
  result = result.replaceAll('$B click', 'use browser_click on');
  result = result.replaceAll('$B text', 'use browser_snapshot to read text from');
  result = result.replaceAll('$B html', 'use browser_snapshot with full=true to get HTML from');
  result = result.replaceAll('$B links', 'use browser_snapshot and extract links from');
  result = result.replaceAll('$B forms', 'use browser_snapshot and extract forms from');
  result = result.replaceAll('$B accessibility', 'use browser_snapshot to get accessibility tree of');
  result = result.replaceAll('$B screenshot', 'use browser_vision to take a screenshot of');
  result = result.replaceAll('$B scroll', 'use browser_scroll');
  result = result.replaceAll('$B press', 'use browser_press');
  result = result.replaceAll('$B type', 'use browser_type');
  result = result.replaceAll('$B eval', 'use browser_console with expression');
  result = result.replaceAll('$B wait', 'wait briefly then use browser_snapshot');
  result = result.replaceAll('$B ', 'use browser tools to ');

  // 5. Rewrite Claude/Hermes-specific paths to Hermes profile-aware paths
  // Hermes uses per-profile skill directories under ~/.hermes/profiles/<name>/skills.
  // $HERMES_HOME is set by the Hermes runtime and makes skills portable across profiles.
  // These rules catch both pre-generic-rewrite (~/.claude/...) and post-generic-rewrite
  // (~/.hermes/...) forms since the adapter runs after generic path rewrites.
  result = result.replaceAll('~/.claude/skills/gstack', '$HERMES_HOME/skills/gstack');
  result = result.replaceAll('$HOME/.claude/skills/gstack', '$HERMES_HOME/skills/gstack');
  result = result.replaceAll('.claude/skills/gstack', '.hermes/skills/gstack');
  result = result.replaceAll('~/.hermes/skills/gstack', '$HERMES_HOME/skills/gstack');
  result = result.replaceAll('$HOME/.hermes/skills/gstack', '$HERMES_HOME/skills/gstack');

  return result;
}
