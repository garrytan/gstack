/**
 * Oracles for the live Codex multi-block case (E6,
 * test/codex-e2e-multiblock-live.test.ts). Codex runs every shell block in a
 * fresh shell, so a gstack skill works there only when each later block
 * resolves the install on its own (the env-var host prelude). The case
 * installs gstack with `./setup --host codex` into a fresh CODEX_HOME, seeds
 * one learning, and runs /learn's "Show recent" block through `codex exec`.
 * Pure functions: the free test replays synthetic `exec --json` events.
 */

export const MULTIBLOCK_SENTINEL_KEY = 'e6-multiblock-sentinel';

interface CommandEvent { command: string; output: string; exitCode: number | null }

function completedCommands(rawLines: readonly string[]): CommandEvent[] {
  const commands: CommandEvent[] = [];
  for (const line of rawLines) {
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'item.completed' || event.item?.type !== 'command_execution') continue;
      commands.push({ command: String(event.item.command ?? ''), output: String(event.item.aggregated_output ?? ''),
        exitCode: typeof event.item.exit_code === 'number' ? event.item.exit_code : null });
    } catch { /* not an event line */ }
  }
  return commands;
}

/**
 * Problems with a live run: any block that could not find the install, a
 * gstack helper path that did not resolve, or no later block (the skill's
 * learnings-search block, which only the prelude can root) that ran the
 * installed helper and printed the seeded learning.
 */
export function multiblockProblems(rawLines: readonly string[], sentinel = MULTIBLOCK_SENTINEL_KEY): string[] {
  const commands = completedCommands(rawLines);
  const problems: string[] = [];
  for (const { command, output } of commands) {
    // The emitted line names the root it tried; the prelude's source text
    // (a block that reads a SKILL.md) quotes it mid-line with `$_r`.
    const missing = /^gstack: no install found \(tried (?!\$)[^\n]*/m.exec(output);
    if (missing) problems.push(`a block could not find the install: ${missing[0].slice(0, 200)}`);
    const unresolved = /\S*\/bin\/gstack-[\w-]+: (?:No such file or directory|command not found|not found)/.exec(output);
    if (unresolved) problems.push(`a gstack helper path did not resolve: ${unresolved[0]} (in: ${command.slice(0, 120)})`);
  }
  const search = commands.filter(c => c.command.includes('gstack-learnings-search'));
  if (search.length === 0) problems.push('no block ran gstack-learnings-search (the skill\'s "Show recent" block)');
  else if (!search.some(c => c.exitCode === 0 && c.output.includes(sentinel) && !/GSTACK_ROOT=["']?\//.test(c.command))) {
    problems.push(`no learnings-search block rooted by its own prelude printed the seeded learning ${sentinel}: `
      + search.map(c => `exit ${c.exitCode}, ${c.output.includes(sentinel) ? 'sentinel present' : 'sentinel absent'}`
        + `${/GSTACK_ROOT=["']?\//.test(c.command) ? ', GSTACK_ROOT set by hand' : ''}`).join('; '));
  }
  return problems;
}

/**
 * The `gstack` router entry from `codex debug prompt-input` output (a JSON
 * array of input items): the skill path it names, resolved through the skill
 * roots table, or null when Codex does not list the router.
 */
export function routerPathFromPromptInput(promptInput: string): string | null {
  let text = promptInput;
  try {
    const items = JSON.parse(promptInput.slice(promptInput.indexOf('[')));
    text = (Array.isArray(items) ? items : []).flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? [])
      .map(part => part.text ?? '').join('\n');
  } catch { /* scan the raw text */ }
  const entry = /^- gstack: .*\(file: (r\d+)\/gstack\/SKILL\.md\)$/m.exec(text);
  if (!entry) return null;
  const root = new RegExp(`^- \`${entry[1]}\` = \`([^\`]+)\`$`, 'm').exec(text);
  return root ? `${root[1]}/gstack/SKILL.md` : null;
}
