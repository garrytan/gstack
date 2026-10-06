/**
 * /plan-ceo-review's PostToolUse hook shows Step 0E's mode handoff line to the
 * user as a system message. Claude Code collapses Bash output and models
 * often paraphrase the line in chat (periodic red 37272185151), so the line's
 * visibility must not depend on the model copying it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handoffMessage } from '../plan-ceo-review/bin/mode-handoff-hook.ts';

const ROOT = path.resolve(import.meta.dir, '..');
const LINE = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune. Approved decisions: none.';
const CMD = '~/.claude/skills/gstack/bin/gstack-ceo-mode-handoff "HOLD SCOPE" --decisions "none" --auto 2>&1; echo "EXIT: $?"';
const input = (command: string, stdout: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, tool_response: { stdout, stderr: '' } });

describe('plan-ceo-review mode handoff hook', () => {
  test('a helper run shows its line as a system message, through the real shim', () => {
    expect(handoffMessage(input(CMD, `${LINE}\nEXIT: 0\n`))).toBe(LINE);
    expect(handoffMessage(input('"$HOME/.claude/skills/gstack/bin/gstack-ceo-mode-handoff" SCOPE_EXPANSION --decisions "D1 (A)"', 'Mode: SCOPE EXPANSION; approved decisions: D1 (A).\n')))
      .toBe('Mode: SCOPE EXPANSION; approved decisions: D1 (A).');
    const r = spawnSync('bash', [path.join(ROOT, 'plan-ceo-review/bin/mode-handoff-hook')], { input: JSON.stringify(input(CMD, `${LINE}\n`)), encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: LINE });
  });

  test('anything that is not the helper and its exact line prints nothing', () => {
    expect(handoffMessage(input(`echo "${LINE}"`, `${LINE}\n`))).toBeNull();
    expect(handoffMessage(input(CMD, 'Auto-decided review mode → BIG SCOPE (your preference).\n'))).toBeNull();
    expect(handoffMessage(input(CMD, `${LINE}\n`, 'Read'))).toBeNull();
    expect(handoffMessage(input(CMD, ''))).toBeNull();
    expect(handoffMessage(null)).toBeNull();
    const r = spawnSync('bash', [path.join(ROOT, 'plan-ceo-review/bin/mode-handoff-hook')], { input: 'not json', encoding: 'utf8', timeout: 10_000 });
    expect([r.status, r.stdout]).toEqual([0, '']);
  });

  test('the Claude render declares the hook in frontmatter; other hosts do not', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'plan-ceo-review/SKILL.md'), 'utf8');
    const frontmatter = claude.slice(0, claude.indexOf('\n---', 4));
    expect(frontmatter).toContain('PostToolUse:');
    expect(frontmatter).toContain('matcher: "Bash"');
    expect(frontmatter).toContain('/plan-ceo-review/bin/mode-handoff-hook');
    const tmpl = fs.readFileSync(path.join(ROOT, 'plan-ceo-review/SKILL.md.tmpl'), 'utf8');
    expect(tmpl).toContain('{{CEO_MODE_HANDOFF_HOOK}}');
  });
});
