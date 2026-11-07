/**
 * Fixtures for the skill routing and contract tests (GST-1088, lane A): fixture
 * skills with contract blocks (never the real skill templates, which lane B
 * owns), a Claude Code transcript builder, and hook runners with an isolated
 * state root and a scrubbed session-kind environment.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../../lib/bun-isolation';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const ROUTE_HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'skill-route-hook.ts');
export const CONTRACT_HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'skill-contract-stop-hook.ts');

export const SKILLS: Record<string, string> = {
  verify: `---
name: verify
description: Fixture copy for the contract tests. (gstack)
triggers:
  - debug this
  - fix this bug
  - this test fails
contract:
  version: 1
  items:
    - id: debug-report
      kind: report_labels
      heading: DEBUG REPORT
      labels: [Symptom, Root cause, Fix, Evidence]
    - id: repro-after-fix
      kind: check_after_last_edit
---
# /verify (fixture)

## How to work

Reproduce the failure before you change code, then fix it and prove the fix.
`,
  review: `---
name: review
description: Fixture copy for the contract tests. (gstack)
triggers:
  - review this pr
  - check my diff
contract: { version: 1, items: [ { id: specialists, kind: selected_specialists_dispatched, marker: "Dispatching N specialists:" }, { id: adversarial, kind: agent_dispatch, match: "Think like an attacker and a chaos engineer" }, { id: report, kind: report_labels, heading: Pre-Landing Review, labels: [Gate edits] } ] }
---
# /review (fixture)
`,
  qa: `---
name: qa
description: Fixture skill with triggers and no contract. (gstack)
triggers:
  - qa test this
  - find bugs on site
---
# /qa (fixture)
`,
  broken: `---
name: broken
description: Fixture skill whose triggers are not a block list. (gstack)
triggers: debug this, fix this bug
---
`,
};

/** A fresh skills dir with the fixture skills (all of them unless named). */
export function skillsDir(names: string[] = Object.keys(SKILLS), extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skills-'));
  for (const [name, body] of Object.entries({ ...Object.fromEntries(names.map(n => [n, SKILLS[n]])), ...extra })) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), body);
  }
  return dir;
}

const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'sess-1', isSidechain: false, cwd: '/repo', timestamp: '2026-11-02T00:00:00.000Z', ...o });
export const user = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
export const meta = (text: string) => line({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
export const say = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const tool = (id: string, name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
export const result = (id: string, text: string, isError = false) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
export const slash = (name: string, args = '') => user(`<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`);

export const DEBUG_REPORT = [
  'DEBUG REPORT',
  '════════════',
  'Symptom:         login returns 500 for users without a session',
  'Root cause:      auth.ts dereferences session.user before the null check',
  'Fix:             moved the null check above the dereference (src/auth.ts:42)',
  'Evidence:        bun test test/auth.test.ts passes, 12 of 12',
  'Status:          DONE',
].join('\n');

/** Load /verify through the Skill tool, edit, answer with no status line: must be blocked (gate rev 2, J1). */
export const J1_TRANSCRIPT = [
  user('the login test fails, fix it'),
  tool('t1', 'Skill', { skill: 'verify' }),
  result('t1', 'Launching skill: verify'),
  meta('# /verify ...skill body...'),
  tool('t2', 'Edit', { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' }),
  result('t2', 'The file src/auth.ts has been updated.'),
  say('Fixed: the null check was missing in src/auth.ts.'),
];

/** An interactive /verify across three turns; each turn's prefix is a Stop point that must not block. */
export const INTERACTIVE_TURNS: string[][] = [
  [slash('verify', 'login fails'), meta('# /verify ...skill body...'), say('I will look into it. Can you paste the error you see?')],
  [user('TypeError: cannot read properties of undefined (reading user)'),
    tool('r1', 'Read', { file_path: 'src/auth.ts' }), result('r1', 'export function login() {}'),
    tool('e1', 'Edit', { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' }), result('e1', 'updated'),
    say('I moved the null check in src/auth.ts.\n\nShould I also add a regression test for the missing session?')],
  [user('yes please'),
    tool('e2', 'Write', { file_path: 'test/auth.test.ts', content: 'test()' }), result('e2', 'created'),
    tool('b1', 'Bash', { command: 'bun test test/auth.test.ts' }), result('b1', '12 pass, 0 fail'),
    say(DEBUG_REPORT)],
];

export const SCRUBBED_ENV_KEYS = ['CI', 'GITHUB_ACTIONS', 'GSTACK_HEADLESS', 'GSTACK_SESSION_KIND', 'OPENCLAW_SESSION', 'CONDUCTOR_WORKSPACE_PATH',
  'CONDUCTOR_PORT', 'GSTACK_SKILL_ROUTING', 'GSTACK_SKILL_CONTRACTS', 'GSTACK_SKILL_ROUTE_HINT', 'GSTACK_HOME', 'GSTACK_STATE_DIR', 'CLAUDE_PLUGIN_DATA'];

/** process.env without session-kind or switch markers, as an interactive Claude Code session (CLAUDE_CODE_ENTRYPOINT=cli). */
export function hookEnv(stateRoot: string, skills: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUBBED_ENV_KEYS.includes(k)) env[k] = v;
  return { ...env, CLAUDE_CODE_ENTRYPOINT: 'cli', GSTACK_STATE_ROOT: stateRoot, GSTACK_INSTALLED_SKILLS_DIR: skills, ...extra };
}

export interface HookRun { code: number | null; stdout: string; stderr: string }

export function runHook(hook: string, input: string, env: Record<string, string>): HookRun {
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), hook], { input, env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
