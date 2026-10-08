/**
 * Required team mode registers its PreToolUse hook as a command string that
 * the hook runner hands to whatever shell it uses: sh on macOS and Linux,
 * cmd.exe or PowerShell on Windows and under Copilot CLI. The old
 * `"$CLAUDE_PROJECT_DIR/.claude/hooks/check-gstack.sh"` only worked in a POSIX
 * shell, so on Windows an intended allow or deny became a hook error (#2217).
 *
 * This reads the hook source and the registered command straight out of
 * bin/gstack-team-init (no bash needed) and runs the command through the
 * platform's default shell (`shell: true`: /bin/sh here, cmd.exe on Windows),
 * plus PowerShell when one is installed, from a project path with a space.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEAM_INIT = fs.readFileSync(new URL('../bin/gstack-team-init', import.meta.url), 'utf-8');

const HOOK_START = 'cat > "$HOOKS_DIR/check-gstack.cjs" << \'HOOK_EOF\'\n';
const hookSource = TEAM_INIT.slice(TEAM_INIT.indexOf(HOOK_START) + HOOK_START.length, TEAM_INIT.indexOf('\nHOOK_EOF\n'));
const commandLiteral = TEAM_INIT.match(/^\s*HOOK_COMMAND="((?:[^"\\]|\\.)*)"$/m)?.[1] ?? '';
const command = commandLiteral.replace(/\\(["\\$`])/g, '$1');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'team-hook-neutral-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const project = path.join(base, 'my project');
fs.mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(project, '.claude', 'hooks', 'check-gstack.cjs'), hookSource);
const elsewhere = path.join(base, 'elsewhere');
fs.mkdirSync(elsewhere);

function hookEnv(home: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project, ...home };
  delete env.GSTACK_ROOT;
  if (!('HOME' in home)) delete env.HOME;
  return env;
}

type Runner = (env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
const viaDefaultShell: Runner = (env) => spawnSync(command, { shell: true, cwd: elsewhere, env, encoding: 'utf-8', timeout: 20_000 });
const powershell = process.platform === 'win32' ? 'powershell' : Bun.which('pwsh');
const viaPowerShell: Runner = (env) =>
  spawnSync(powershell!, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: elsewhere, env, encoding: 'utf-8', timeout: 30_000 });

describe('required team hook: shell-neutral registration', () => {
  test('the extracted command is a node launcher with no shell variable syntax', () => {
    expect(hookSource).toContain("'use strict';");
    expect(command).toStartWith('node -e "');
    expect(command).toContain('process.env.CLAUDE_PROJECT_DIR');
    expect(commandLiteral).not.toContain('$');
    expect(command).not.toContain('%');
  });

  // `powershell -Command` reports a failing native command as exit 1, so only
  // the default shell sees the hook's own exit 2; the deny JSON is the same.
  for (const [name, runner, enabled, denyStatus] of [
    ['the default shell', viaDefaultShell, true, 2],
    ['PowerShell', viaPowerShell, Boolean(powershell), 1],
  ] as const) {
    test.skipIf(!enabled)(`through ${name}: deny with exit 2 when no install resolves, {} when one does`, () => {
      const home = path.join(base, `home-${name.replace(/\W+/g, '-')}`);
      fs.mkdirSync(home, { recursive: true });

      const denied = runner(hookEnv({ HOME: home, USERPROFILE: home }));
      expect(denied.status).toBe(denyStatus);
      expect(JSON.parse(denied.stdout.trim()).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(denied.stderr).toContain('BLOCKED: gstack is not installed globally.');

      fs.mkdirSync(path.join(home, '.claude/skills/gstack/bin'), { recursive: true });
      const allowed = runner(hookEnv({ HOME: home, USERPROFILE: home }));
      expect(allowed.stderr).toBe('');
      expect(allowed.stdout.trim()).toBe('{}');
      expect(allowed.status).toBe(0);

      const viaProfile = runner(hookEnv({ USERPROFILE: home }));
      expect(viaProfile.stdout.trim()).toBe('{}');
      expect(viaProfile.status).toBe(0);
    });
  }
});
