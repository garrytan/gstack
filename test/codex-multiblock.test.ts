/**
 * Free replays for the live Codex multi-block oracles (E6): synthetic
 * `codex exec --json` events in the shape codex-cli 0.160 writes (see
 * test/fixtures/codex-sandbox/exec-json-healthy.jsonl) and a
 * `codex debug prompt-input` skills block.
 */
import { describe, test, expect } from 'bun:test';
import { MULTIBLOCK_SENTINEL_KEY, multiblockProblems, routerPathFromPromptInput } from './helpers/codex-multiblock';

const PRELUDE = '[ -d "${GSTACK_ROOT:-/-}/bin" ]&&[ -d "$GSTACK_ROOT/lib" ]||{ _r=$(git rev-parse --show-toplevel 2>/dev/null)/.agents/skills/gstack;'
  + '[ -d "$_r/bin" ]||_r=${CODEX_HOME:-~/.codex}/skills/gstack;[ -d "$_r/bin" ]||{ echo "gstack: no install found (tried $_r). Fix: ./setup --host codex from your gstack checkout; ./setup --status shows it.">&2;exit 1;};GSTACK_ROOT=$_r;}';
const SHOW_RECENT = `${PRELUDE}\nSLUG=$($GSTACK_ROOT/bin/gstack-slug --get SLUG 2>/dev/null)\n$GSTACK_ROOT/bin/gstack-learnings-search --limit 20 2>/dev/null || echo "No learnings yet."`;
const LISTING = `LEARNINGS: 1 loaded (1 pitfall)\n\n## Pitfalls\n- [${MULTIBLOCK_SENTINEL_KEY}] (confidence: 9/10, user-stated, 2026-10-04)\n  Seeded by the E6 live Codex check\n`;

const command = (cmd: string, output: string, exitCode: number) => JSON.stringify({ type: 'item.completed',
  item: { id: 'item_2', type: 'command_execution', command: `/bin/bash -lc ${JSON.stringify(cmd)}`, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? 'completed' : 'failed' } });
const run = (...lines: string[]) => ['{"type":"thread.started","thread_id":"t"}', ...lines, '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'];
const preamble = command(`${PRELUDE}\nGSTACK_BIN=$GSTACK_ROOT/bin\n"$GSTACK_BIN/gstack-skill-start" --skill "learn"`, 'BRANCH: main\n', 0);

describe('multiblockProblems', () => {
  test('a later block rooted by its own prelude that prints the seeded learning passes', () => {
    expect(multiblockProblems(run(preamble, command(SHOW_RECENT, LISTING, 0)))).toEqual([]);
  });

  test('a block that cannot find the install fails, even when another block succeeded', () => {
    const missing = command(SHOW_RECENT, 'gstack: no install found (tried /root/.codex/skills/gstack). Fix: ./setup --host codex', 1);
    const problems = multiblockProblems(run(preamble, missing, command(SHOW_RECENT, LISTING, 0)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith('a block could not find the install');
  });

  test('a block that reads a SKILL.md quoting the prelude is not a missing install (live run 2026-10-04)', () => {
    const read = command("sed -n '1,120p' \"$CODEX_HOME/skills/gstack-learn/SKILL.md\"", `---\nname: learn\n---\n\n\`\`\`bash\n${PRELUDE}\n\`\`\`\n`, 0);
    expect(multiblockProblems(run(preamble, read, command(SHOW_RECENT, LISTING, 0)))).toEqual([]);
  });

  test('the pre-prelude symptom (an empty root, /bin/gstack-slug) fails', () => {
    const problems = multiblockProblems(run(command('SLUG=$($GSTACK_ROOT/bin/gstack-slug --get SLUG)\n$GSTACK_ROOT/bin/gstack-learnings-search',
      'bash: line 1: /bin/gstack-slug: No such file or directory\nbash: line 2: /bin/gstack-learnings-search: No such file or directory\n', 127)));
    expect(problems.some(p => p.startsWith('a gstack helper path did not resolve: /bin/gstack-slug: No such file or directory'))).toBe(true);
    expect(problems.some(p => p.startsWith('no learnings-search block rooted by its own prelude printed the seeded learning'))).toBe(true);
  });

  test('a preamble-only run, a run without the seeded learning, or a hand-set root does not count', () => {
    expect(multiblockProblems(run(preamble))).toEqual(['no block ran gstack-learnings-search (the skill\'s "Show recent" block)']);
    expect(multiblockProblems(run(preamble, command(SHOW_RECENT, 'No learnings yet.\n', 0)))[0]).toContain('exit 0, sentinel absent');
    const handSet = command('GSTACK_ROOT=/home/u/.codex/skills/gstack\n$GSTACK_ROOT/bin/gstack-learnings-search --limit 20', LISTING, 0);
    expect(multiblockProblems(run(preamble, handSet))[0]).toContain('GSTACK_ROOT set by hand');
  });
});

describe('routerPathFromPromptInput', () => {
  const promptInput = (entries: string[]) => JSON.stringify([{ type: 'message', role: 'developer', content: [{ type: 'input_text',
    text: ['<skills_instructions>', '## Skills', '### Skill roots', '- `r0` = `/h/.codex/skills`', '- `r1` = `/h/.codex/skills/.system`',
      '### Available skills', '- skill-creator: Create or update a Codex skill. (file: r1/skill-creator/SKILL.md)', ...entries].join('\n') }] }], null, 2);

  test('names the router file through the skill roots table', () => {
    const listed = promptInput(['- gstack: Route a task to the right gstack skill. (gstack) (file: r0/gstack/SKILL.md)',
      '- learn: Manage project learnings. (gstack) (file: r0/gstack-learn/SKILL.md)']);
    expect(routerPathFromPromptInput(`WARNING: proceeding without PATH aliases\n${listed}`)).toBe('/h/.codex/skills/gstack/SKILL.md');
  });

  test('is null when Codex lists gstack skills but not the router', () => {
    expect(routerPathFromPromptInput(promptInput(['- learn: Manage project learnings. (gstack) (file: r0/gstack-learn/SKILL.md)']))).toBeNull();
  });
});
