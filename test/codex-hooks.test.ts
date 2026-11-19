/**
 * gstack's hooks on Codex (GST-3172, plan GSTA-638 A1/B1/C1/D1): the Codex hooks.json format of
 * bin/gstack-settings-hook, the routing and destructive-command hooks with host codex, and setup's and uninstall's
 * wiring. Payloads come from codex-cli 0.170 probes (test/fixtures/codex-hooks). Claude Code's output is pinned
 * unchanged here: the hint text, the routing of a "$" prompt, and the settings.json entries for the three hooks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexDecision, CODEX_ASK_NOTE } from '../hosts/codex/hooks/codex-destructive-guard-hook.ts';
import { ASK_NOTE } from '../hosts/claude/hooks/destructive-guard-hook.ts';
import { hintLine, routePrompt, scanCodexSkills, type RouteCandidate } from '../lib/skill-route';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_BIN = path.join(ROOT, 'bin', 'gstack-settings-hook');
const PAYLOADS = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'codex-hooks', 'codex-0.170-payloads.json'), 'utf8'));

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-hooks-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const hooksFile = () => path.join(dir, 'hooks.json');
const read = () => JSON.parse(fs.readFileSync(hooksFile(), 'utf8'));
const backups = () => fs.readdirSync(dir).filter(f => f.startsWith('hooks.json.bak.'));
function settingsHook(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [HOOK_BIN, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_HOOKS_FORMAT: 'codex', GSTACK_SETTINGS_FILE: hooksFile(), ...env },
    encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const runtime = () => path.join(dir, 'skills', 'gstack');
const ROUTE_CMD = (root = runtime()) => path.join(root, 'hosts', 'codex', 'hooks', 'codex-skill-route-hook');
const GUARD_CMD = (root = runtime()) => path.join(root, 'hosts', 'codex', 'hooks', 'codex-destructive-guard-hook');
const ensureRoute = (root?: string) => settingsHook(['ensure-event', '--event', 'UserPromptSubmit', '--command', ROUTE_CMD(root), '--source', 'gstack-skill-route', '--timeout', '5']);
const ensureGuard = (root?: string) => settingsHook(['ensure-event', '--event', 'PreToolUse', '--command', GUARD_CMD(root), '--source', 'gstack-destructive-guard', '--matcher', 'Bash', '--timeout', '10']);

const USER_FILE = {
  description: 'my hooks',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard', timeout: 3, statusMessage: 'checking' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-prompt-log' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-stop', async: false }] }],
  },
};
const writeUser = (doc: unknown = USER_FILE) => fs.writeFileSync(hooksFile(), JSON.stringify(doc, null, 2) + '\n');

/** The keys Codex 0.170 accepts (codex-rs/config/src/hook_config.rs HooksFile, codex-rs/protocol/src/hooks.rs), written out independently. */
const CODEX_KEYS = {
  top: ['description', 'hooks'],
  group: ['matcher', 'hooks'],
  command: ['type', 'command', 'commandWindows', 'command_windows', 'timeout', 'async', 'statusMessage', 'additionalContextLimit'],
};
function codexKeysOnly(doc: Record<string, any>): void {
  for (const k of Object.keys(doc)) expect(CODEX_KEYS.top).toContain(k);
  for (const groups of Object.values(doc.hooks ?? {}) as any[][]) {
    for (const g of groups) {
      for (const k of Object.keys(g)) expect(CODEX_KEYS.group).toContain(k);
      for (const h of g.hooks) for (const k of Object.keys(h)) expect(CODEX_KEYS.command).toContain(k);
    }
  }
}

describe('gstack-settings-hook: Codex hooks.json format', () => {
  test('merges after the user groups: theirs keep content and position, gstack adds one group per hook with explicit timeouts and no tag keys', () => {
    writeUser();
    expect(ensureRoute().out).toContain('OK: UserPromptSubmit hook registered (source: gstack-skill-route)');
    expect(ensureGuard().out).toContain('OK: PreToolUse hook registered (source: gstack-destructive-guard)');
    const doc = read();
    expect(doc.description).toBe('my hooks');
    expect(doc.hooks.Stop).toEqual(USER_FILE.hooks.Stop);
    expect(doc.hooks.PreToolUse[0]).toEqual(USER_FILE.hooks.PreToolUse[0]);
    expect(doc.hooks.UserPromptSubmit[0]).toEqual(USER_FILE.hooks.UserPromptSubmit[0]);
    expect(doc.hooks.PreToolUse[1]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_CMD(), timeout: 10 }] });
    expect(doc.hooks.UserPromptSubmit[1]).toEqual({ hooks: [{ type: 'command', command: ROUTE_CMD(), timeout: 5 }] });
    expect(JSON.stringify(doc)).not.toContain('_gstack_source');
    codexKeysOnly(doc);
  });

  test('a re-run changes nothing: no write and no new backup; a moved runtime root re-points in place', () => {
    writeUser();
    ensureRoute(); ensureGuard();
    const bytes = fs.readFileSync(hooksFile(), 'utf8');
    const baks = backups().length;
    expect(ensureRoute().out).toContain('unchanged');
    expect(ensureGuard().out).toContain('unchanged');
    expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(bytes);
    expect(backups().length).toBe(baks);
    const moved = path.join(dir, 'other', 'gstack');
    expect(ensureGuard(moved).out).toContain('re-pointed');
    const doc = read();
    expect(doc.hooks.PreToolUse).toHaveLength(2);
    expect(doc.hooks.PreToolUse[1].hooks[0].command).toBe(GUARD_CMD(moved));
  });

  test('refuses a hooks.json that does not parse, or that Codex would skip, and leaves it byte-identical', () => {
    const cases: Array<[string, string]> = [
      ['{ "hooks": ', 'is not valid JSON'],
      [JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', _gstack_source: 'x', hooks: [] }] } }), 'has the key "_gstack_source", which Codex does not know'],
      [JSON.stringify({ hooks: { BeforeTool: [] } }), 'has the key "BeforeTool"'],
      [JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', retries: 2 }] }] } }), 'has the key "retries"'],
      [JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'shell', command: 'x' }] }] } }), '.type is "shell"'],
      [JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 1.5 }] }] } }), 'timeout is not a whole number'],
      [JSON.stringify({ version: 1, hooks: {} }), 'has the key "version"'],
    ];
    for (const [text, why] of cases) {
      fs.writeFileSync(hooksFile(), text);
      const r = ensureRoute();
      expect(r.code).toBe(3);
      expect(r.out).toContain(why);
      expect(r.out).toContain('refusing to mutate');
      expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(text);
    }
    expect(backups()).toEqual([]);
  });

  test('refuses while config.toml declares a gstack hook under [hooks] or does not parse; user hooks and trust state there are fine', () => {
    writeUser();
    const cfg = path.join(dir, 'config.toml');
    fs.writeFileSync(cfg, '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "' + GUARD_CMD() + '"\n');
    let r = ensureRoute();
    expect(r.code).toBe(3);
    expect(r.out).toContain('already declares gstack hook gstack-destructive-guard under [hooks.PreToolUse], and Codex would run it twice');
    fs.writeFileSync(cfg, 'model = [\n');
    r = ensureRoute();
    expect(r.code).toBe(3);
    expect(r.out).toContain('does not parse');
    expect(read()).toEqual(USER_FILE);
    fs.writeFileSync(cfg, 'model = "gpt-6.1-sol"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/usr/local/bin/my-stop"\n[hooks.state."/x/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n');
    expect(ensureRoute().code).toBe(0);
  });

  test('remove-source takes only its hook, prune-stale --all returns the user file exactly, and rollback undoes the last write', () => {
    writeUser();
    ensureRoute(); ensureGuard();
    expect(settingsHook(['remove-source', '--source', 'gstack-skill-route']).out).toContain('removed 1');
    expect(read().hooks.UserPromptSubmit).toEqual(USER_FILE.hooks.UserPromptSubmit);
    expect(read().hooks.PreToolUse).toHaveLength(2);
    const beforeSweep = fs.readFileSync(hooksFile(), 'utf8');
    expect(settingsHook(['prune-stale', '--all']).out).toContain('removed 1 gstack hook entries');
    expect(read()).toEqual(USER_FILE);
    expect(settingsHook(['rollback']).code).toBe(0);
    expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(beforeSweep);
  });

  test('the legacy settings.json verbs are refused in the Codex format', () => {
    for (const verb of ['add', 'remove']) {
      const r = settingsHook([verb, '/x/bin/gstack-session-update']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('legacy settings.json verb');
    }
    expect(fs.existsSync(hooksFile())).toBe(false);
  });

  test('trust-status reads the key Codex writes (<hooks.json>:<event>:<group>:<handler>) and never computes a hash', () => {
    writeUser();
    ensureRoute(); ensureGuard();
    expect(settingsHook(['trust-status'], { CODEX_HOME: dir }).out.trim().split('\n').sort()).toEqual([
      'gstack-destructive-guard\tPreToolUse\tuntrusted', 'gstack-skill-route\tUserPromptSubmit\tuntrusted',
    ]);
    const file = fs.realpathSync(hooksFile());
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      '[hooks.state]', '',
      '[hooks.state."' + file + ':pre_tool_use:0:0"]', 'trusted_hash = "sha256:aa"', '',
      '[hooks.state."' + file + ':pre_tool_use:1:0"]', 'trusted_hash = "sha256:bb"', '',
      '[hooks.state."' + file + ':user_prompt_submit:1:0"]', 'enabled = false', 'trusted_hash = "sha256:cc"', '',
    ].join('\n'));
    expect(settingsHook(['trust-status'], { CODEX_HOME: dir }).out.trim().split('\n').sort()).toEqual([
      'gstack-destructive-guard\tPreToolUse\ttrusted', 'gstack-skill-route\tUserPromptSubmit\tdisabled',
    ]);
    expect(settingsHook(['trust-status'], { GSTACK_HOOKS_FORMAT: '' }).code).toBe(1);
  });

  test('removing a gstack group that one of your groups follows leaves an empty group in its place, so your hooks keep their trust positions', () => {
    writeUser();
    ensureRoute(); ensureGuard();
    const doc = read();
    const late = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-late-guard' }] };
    doc.hooks.PreToolUse.push(late);
    writeUser(doc);
    for (const args of [['remove-source', '--source', 'gstack-destructive-guard'], ['prune-stale', '--all']]) {
      writeUser(doc);
      const r = settingsHook(args);
      expect(r.code).toBe(0);
      expect(read().hooks.PreToolUse).toEqual([USER_FILE.hooks.PreToolUse[0], { hooks: [] }, late]);
      codexKeysOnly(read());
    }
    expect(read().hooks.UserPromptSubmit).toEqual(USER_FILE.hooks.UserPromptSubmit);
    expect(read().hooks.Stop).toEqual(USER_FILE.hooks.Stop);
    expect(ensureGuard().out).toContain('registered');
    expect(read().hooks.PreToolUse.slice(0, 3)).toEqual([USER_FILE.hooks.PreToolUse[0], { hooks: [] }, late]);
  });

  test('when one of your handlers follows the gstack handler inside its group, removal refuses and names only the gstack handler to delete', () => {
    writeUser();
    ensureGuard();
    const doc = read();
    doc.hooks.PreToolUse[1].hooks.push({ type: 'command', command: '/usr/local/bin/my-inner-guard' });
    writeUser(doc);
    const text = fs.readFileSync(hooksFile(), 'utf8');
    for (const args of [['remove-source', '--source', 'gstack-destructive-guard'], ['prune-stale', '--all']]) {
      const r = settingsHook(args);
      expect(r.code).toBe(3);
      expect(r.out).toContain('would move your own PreToolUse hooks');
      expect(r.out).toContain('delete only the gstack handler hooks.PreToolUse[1].hooks[0] (command ' + JSON.stringify(GUARD_CMD()) + ')');
      expect(r.out).toContain('keeping your own handlers and groups as they are, then re-trust your hooks in Codex with /hooks');
      expect(r.out).not.toContain('delete its group');
      expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(text);
    }
  });

  test('a symlinked hooks.json still reads config.toml from the Codex home, not from beside the link target', () => {
    const home = path.join(dir, 'codex');
    const dotfiles = path.join(dir, 'dotfiles');
    fs.mkdirSync(home); fs.mkdirSync(dotfiles);
    fs.writeFileSync(path.join(dotfiles, 'hooks.json'), JSON.stringify(USER_FILE, null, 2) + '\n');
    fs.symlinkSync(path.join(dotfiles, 'hooks.json'), path.join(home, 'hooks.json'));
    const linked = { GSTACK_SETTINGS_FILE: path.join(home, 'hooks.json') };
    const cfg = path.join(home, 'config.toml');
    fs.writeFileSync(cfg, '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "' + ROUTE_CMD() + '"\n');
    const route = ['ensure-event', '--event', 'UserPromptSubmit', '--command', ROUTE_CMD(), '--source', 'gstack-skill-route', '--timeout', '5'];
    const r = settingsHook(route, linked);
    expect(r.code).toBe(3);
    expect(r.out).toContain(cfg + ' already declares gstack hook gstack-skill-route');
    fs.writeFileSync(cfg, '[hooks.state."' + path.join(home, 'hooks.json') + ':user_prompt_submit:1:0"]\ntrusted_hash = "sha256:aa"\n');
    expect(settingsHook(route, linked).code).toBe(0);
    expect(settingsHook(['trust-status'], linked).out.trim()).toBe('gstack-skill-route\tUserPromptSubmit\ttrusted');
  });

  test('the formats stay apart: Codex rows never claim settings.json items, Claude rows never claim hooks.json items', () => {
    const claudeShaped = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: '/x/.claude/skills/gstack/hosts/claude/hooks/destructive-guard-hook', timeout: 10 }] }] } };
    writeUser(claudeShaped);
    expect(settingsHook(['prune-stale', '--all']).out).toContain('removed 0');
    expect(read()).toEqual(claudeShaped);
    const settings = path.join(dir, 'settings.json');
    const codexShaped = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_CMD() }] }] } };
    fs.writeFileSync(settings, JSON.stringify(codexShaped));
    expect(settingsHook(['prune-stale', '--all'], { GSTACK_HOOKS_FORMAT: '', GSTACK_SETTINGS_FILE: settings }).out).toContain('removed 0');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(codexShaped);
  });

  test("Claude Code's settings.json entries for the three hooks are unchanged", () => {
    const settings = path.join(dir, 'settings.json');
    const claude = (args: string[]) => settingsHook(args, { GSTACK_HOOKS_FORMAT: '', GSTACK_SETTINGS_FILE: settings });
    const root = '/home/you/.claude/skills/gstack/hosts/claude/hooks';
    claude(['ensure-event', '--event', 'UserPromptSubmit', '--command', root + '/skill-route-hook', '--source', 'gstack-skill-route', '--timeout', '5']);
    claude(['ensure-event', '--event', 'Stop', '--command', root + '/skill-contract-stop-hook', '--source', 'gstack-skill-contract', '--timeout', '10']);
    claude(['ensure-event', '--event', 'PreToolUse', '--command', root + '/destructive-guard-hook', '--source', 'gstack-destructive-guard', '--timeout', '10', '--matcher', 'Bash|PowerShell']);
    expect(fs.readFileSync(settings, 'utf8')).toBe(JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ _gstack_source: 'gstack-skill-route', hooks: [{ type: 'command', command: root + '/skill-route-hook', timeout: 5 }] }],
        Stop: [{ _gstack_source: 'gstack-skill-contract', hooks: [{ type: 'command', command: root + '/skill-contract-stop-hook', timeout: 10 }] }],
        PreToolUse: [{ _gstack_source: 'gstack-destructive-guard', hooks: [{ type: 'command', command: root + '/destructive-guard-hook', timeout: 10 }], matcher: 'Bash|PowerShell' }],
      },
    }, null, 2) + '\n');
  });
});

describe('gstack-settings-hook: hardening after #4512 and #4522 (GST-3197)', () => {
  const runUnder = (shell: string[], command: string) => spawnSync(shell[0], [...shell.slice(1), command], { input: '{}', encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  const fakeHook = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho RAN_HOOK\n', { mode: 0o755 });
  };

  test('a home path with ( or & gives commands both hosts run: no exit 2, which Codex would read as a block on every prompt and Bash call', () => {
    const root = path.join(dir, 'codex(old)&co', 'skills', 'gstack');
    fakeHook(ROUTE_CMD(root));
    expect(ensureRoute(root).out).toContain('registered');
    const codexCmd = read().hooks.UserPromptSubmit[0].hooks[0].command;
    const settings = path.join(dir, 'settings.json');
    const claudeHook = path.join(root, 'hosts', 'claude', 'hooks', 'skill-route-hook');
    fakeHook(claudeHook);
    expect(settingsHook(['ensure-event', '--event', 'UserPromptSubmit', '--command', claudeHook, '--source', 'gstack-skill-route', '--timeout', '5'], { GSTACK_HOOKS_FORMAT: '', GSTACK_SETTINGS_FILE: settings }).code).toBe(0);
    const claudeCmd = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
    for (const cmd of [codexCmd, claudeCmd]) {
      for (const shell of [['bash', '-lc'], ['sh', '-c']]) {
        const r = runUnder(shell, cmd);
        expect({ shell: shell[0], status: r.status, out: r.stdout.trim() }).toEqual({ shell: shell[0], status: 0, out: 'RAN_HOOK' });
      }
    }
    expect(ensureRoute(root).out).toContain('unchanged');
  });

  test('plain paths keep their unquoted commands, so no install is asked to re-trust its hooks', () => {
    expect(ensureRoute().code).toBe(0);
    expect(read().hooks.UserPromptSubmit[0].hooks[0].command).toBe(ROUTE_CMD());
    const accented = path.join(dir, 'Jos\u00e9', 'skills', 'gstack');
    expect(ensureRoute(accented).out).toContain('re-pointed');
    expect(read().hooks.UserPromptSubmit[0].hooks[0].command).toBe(ROUTE_CMD(accented));
  });

  test('schema parity with Codex 0.170: description null is accepted; a null anywhere in MCP hook input is refused', () => {
    writeUser({ description: null, hooks: {} });
    expect(ensureRoute().code).toBe(0);
    expect(read().description).toBeNull();
    const mcp = (input: unknown) => ({ hooks: { Stop: [{ hooks: [{ type: 'mcp_tool', server: 's', tool: 't', input }] }] } });
    for (const input of [{ optional: null }, { metadata: { optional: null } }, { values: [null] }, { big: 18446744073709551615 }]) {
      const text = JSON.stringify(mcp(input));
      fs.writeFileSync(hooksFile(), text);
      const r = ensureRoute();
      expect(r.code).toBe(3);
      expect(r.out).toContain('input holds a null or an integer too large for TOML, which Codex rejects');
      expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(text);
    }
    writeUser(mcp({ metadata: { depth: 1, tags: ['a', true, -2.5] } }));
    expect(ensureRoute().code).toBe(0);
  });

  test('rollback refuses a backup Codex would skip and leaves the live file as it is', () => {
    writeUser();
    ensureRoute();
    const live = fs.readFileSync(hooksFile(), 'utf8');
    const backup = fs.readFileSync(path.join(dir, 'hooks.json.bak-latest'), 'utf8').trim();
    for (const bad of [JSON.stringify({ hooks: {}, _gstack_source: 'x' }), '{ "hooks": ']) {
      fs.writeFileSync(backup, bad);
      const r = settingsHook(['rollback']);
      expect(r.code).toBe(3);
      expect(r.out).toContain('does not match the Codex hooks.json schema');
      expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(live);
    }
    fs.writeFileSync(backup, JSON.stringify(USER_FILE, null, 2) + '\n');
    expect(settingsHook(['rollback']).code).toBe(0);
    expect(read()).toEqual(USER_FILE);
  });

  test('config.toml declaring the gstack guard under any matcher that selects Bash is a clash; matchers that never select Bash are not', () => {
    writeUser();
    const cfg = path.join(dir, 'config.toml');
    const declare = (matcher: string | null) => fs.writeFileSync(cfg, '[[hooks.PreToolUse]]\n' + (matcher === null ? '' : 'matcher = ' + JSON.stringify(matcher) + '\n') + '[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "' + GUARD_CMD() + '"\n');
    for (const matcher of ['^Bash$', 'Bash|PowerShell', '*', '', null, 'B.sh', '(unclosed']) {
      declare(matcher);
      const r = ensureGuard();
      expect({ matcher, code: r.code }).toEqual({ matcher, code: 3 });
      expect(r.out).toContain('already declares gstack hook gstack-destructive-guard under [hooks.PreToolUse], and Codex would run it twice');
    }
    expect(read()).toEqual(USER_FILE);
    for (const matcher of ['\\ABash\\z', '(?i)^bash$']) {
      declare(matcher);
      expect({ matcher, code: ensureGuard().code }).toEqual({ matcher, code: 3 });
    }
    for (const matcher of ['PowerShell', '^Edit$', 'apply_patch|Write', '(?i)^Edit$', '\\AEdit\\z']) {
      declare(matcher);
      expect({ matcher, code: ensureGuard().code }).toEqual({ matcher, code: 0 });
    }
  });

  test('trust-status keys on the hooks.json in the canonical CODEX_HOME, the way Codex does, even when hooks.json itself is a link', () => {
    const real = path.join(dir, 'real-codex');
    const link = path.join(dir, 'codex-link');
    const dotfiles = path.join(dir, 'dotfiles');
    fs.mkdirSync(real); fs.mkdirSync(dotfiles);
    fs.symlinkSync(real, link);
    fs.writeFileSync(path.join(dotfiles, 'hooks.json'), JSON.stringify(USER_FILE, null, 2) + '\n');
    fs.symlinkSync(path.join(dotfiles, 'hooks.json'), path.join(real, 'hooks.json'));
    const env = { CODEX_HOME: link, GSTACK_SETTINGS_FILE: '' };
    expect(settingsHook(['ensure-event', '--event', 'UserPromptSubmit', '--command', ROUTE_CMD(), '--source', 'gstack-skill-route', '--timeout', '5'], env).code).toBe(0);
    const trust = (keyFile: string) => {
      fs.writeFileSync(path.join(real, 'config.toml'), '[hooks.state."' + keyFile + ':user_prompt_submit:1:0"]\ntrusted_hash = "sha256:aa"\n');
      return settingsHook(['trust-status'], env).out.trim();
    };
    expect(trust(path.join(fs.realpathSync(real), 'hooks.json'))).toBe('gstack-skill-route\tUserPromptSubmit\ttrusted');
    expect(trust(path.join(link, 'hooks.json'))).toBe('gstack-skill-route\tUserPromptSubmit\tuntrusted');
    expect(trust(fs.realpathSync(path.join(dotfiles, 'hooks.json')))).toBe('gstack-skill-route\tUserPromptSubmit\tuntrusted');
  });
});

const route = (skill: string, trigger: string): RouteCandidate => ({ skill, score: 1, matched: 3, trigger, file: '/x/SKILL.md', gstack: true });

describe('skill routing on Codex', () => {
  function codexSkills(): string {
    const skills = path.join(dir, 'codex-skills');
    for (const [entry, name] of [['gstack-review', 'review'], ['gstack-ship', 'ship'], ['gstack-qa', 'qa']]) {
      fs.mkdirSync(path.join(skills, entry), { recursive: true });
      fs.writeFileSync(path.join(skills, entry, 'SKILL.md'), '---\nname: ' + name + '\ndescription: |\n  A Codex render keeps only name and description.\n---\nbody\n');
    }
    fs.mkdirSync(path.join(skills, 'my-notes'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'my-notes', 'SKILL.md'), '---\nname: my-notes\ndescription: notes\n---\n');
    return skills;
  }

  test("gstack's Codex skills take Codex's names and the triggers of the same skill in this checkout", () => {
    const { skills } = scanCodexSkills(codexSkills());
    const review = skills.find(s => s.name === 'review');
    expect(review?.gstack).toBe(true);
    expect(review?.triggers).toContain('review my changes');
    expect(skills.find(s => s.name === 'my-notes')?.triggers).toEqual([]);
    const decision = routePrompt(PAYLOADS.UserPromptSubmit.prompt, skills, undefined, 'codex');
    expect(decision.route?.skill).toBe('review');
  });

  test('a Codex skill is named by its SKILL.md name, with or without skill_prefix, and by its folder when that name is unusable', () => {
    const names = (frontmatterName: string | null) => {
      const skills = path.join(dir, 'codex-named');
      fs.rmSync(skills, { recursive: true, force: true });
      fs.mkdirSync(path.join(skills, 'gstack-review'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack-review', 'SKILL.md'), '---\n' + (frontmatterName === null ? '' : 'name: ' + frontmatterName + '\n') + 'description: d\n---\n');
      const scan = scanCodexSkills(skills);
      const decision = routePrompt(PAYLOADS.UserPromptSubmit.prompt, scan.skills, undefined, 'codex');
      return { name: scan.skills[0]?.name, routed: decision.route?.skill, problems: scan.problems };
    };
    expect(names('review')).toEqual({ name: 'review', routed: 'review', problems: [] });
    expect(names('gstack-review')).toEqual({ name: 'gstack-review', routed: 'gstack-review', problems: [] });
    expect(names(null)).toEqual({ name: 'gstack-review', routed: 'gstack-review', problems: [] });
    expect(names('"not a name"')).toEqual({ name: 'gstack-review', routed: 'gstack-review', problems: [] });
  });

  test('a $ skill mention or a / command is never routed on Codex; on Claude Code a $ prompt still routes as before', () => {
    const { skills } = scanCodexSkills(codexSkills());
    expect(routePrompt('$gstack-review review my changes', skills, undefined, 'codex')).toMatchObject({ route: null, reason: 'skill-mention' });
    expect(routePrompt('/review review my changes', skills, undefined, 'codex')).toMatchObject({ route: null, reason: 'slash-command' });
    expect(routePrompt('  $ review my changes', skills).route?.skill).toBe('review');
  });

  test("the Codex line names Codex's skill; Claude Code's line is unchanged", () => {
    expect(hintLine(route('review', 'review my changes'))).toBe('gstack skill routing (UserPromptSubmit hook; matched the installed /review trigger "review my changes"; off: gstack-config set skill_routing off): this request fits /review. Run /review with the Skill tool before you start, and tell the user in one sentence that gstack routed this to /review.');
    expect(hintLine(route('review', 'review my changes'), '', route('qa', 'test the site'))).toBe('gstack skill routing (UserPromptSubmit hook; matched the installed /review trigger "review my changes" and the installed /qa trigger "test the site"; off: gstack-config set skill_routing off): this request fits /review or /qa. Run the one that fits better with the Skill tool before you start (/review if both fit), and tell the user in one sentence which skill gstack routed this to.');
    expect(hintLine(route('gstack-review', 'review my changes'), '', undefined, 'codex')).toBe('gstack skill routing (UserPromptSubmit hook; matched the installed gstack-review trigger "review my changes"; off: gstack-config set skill_routing off): this request fits the gstack-review skill. Read and follow the gstack-review skill before you start, and tell the user in one sentence that gstack routed this to gstack-review.');
    expect(hintLine(route('gstack-review', 'review my changes'), '', route('gstack-qa', 'test the site'), 'codex')).toContain('fits the gstack-review or gstack-qa skill. Read and follow the one that fits better before you start (gstack-review if both fit)');
  });

  test('the Codex shim answers a Codex payload with the Codex line, and prints nothing with skill_routing off', () => {
    const skills = codexSkills();
    const run = (env: Record<string, string> = {}) => spawnSync('bash', [path.join(ROOT, 'hosts', 'codex', 'hooks', 'codex-skill-route-hook')], {
      input: JSON.stringify(PAYLOADS.UserPromptSubmit),
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_STATE_ROOT: path.join(dir, 'state'), GSTACK_INSTALLED_SKILLS_DIR: skills, ...env },
      encoding: 'utf8', timeout: 30_000,
    });
    const r = run();
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe('UserPromptSubmit');
    expect(out.additionalContext).toContain('this request fits the review skill. Read and follow the review skill');
    expect(fs.readFileSync(path.join(dir, 'state', 'hooks', 'skill-route.log'), 'utf8')).toMatch(/event=routed skill=review .*host=codex/);
    expect(run({ GSTACK_SKILL_ROUTING: 'off' }).stdout).toBe('');
  });
});

describe('the destructive-command check on Codex', () => {
  const ask = (reason: string) => ({ decision: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } } });

  test('Codex has no ask: interactive sessions get a deny that tells the model to ask the user, others a warning; a deny stays a deny', () => {
    expect(codexDecision(ask('[careful] Destructive: git reset --hard discards all uncommitted changes.'), 'interactive')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[careful] Destructive: git reset --hard discards all uncommitted changes. ' + CODEX_ASK_NOTE },
    });
    expect(CODEX_ASK_NOTE).toContain('stop and ask the user');
    expect(CODEX_ASK_NOTE).toContain('typing ! followed by the command');
    expect(CODEX_ASK_NOTE).toContain('gstack-config set destructive_guard off');
    expect(codexDecision(ask('[careful] x.'), 'headless')).toEqual({ systemMessage: '[careful] x. ' + ASK_NOTE + ' Allowed without asking: this headless session has nobody to answer.' });
    expect(codexDecision(ask('[careful] x.'), 'unattended')).toHaveProperty('systemMessage');
    const deny = { decision: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[careful][HIGH] no.' } } };
    for (const kind of ['interactive', 'headless']) {
      expect(codexDecision(deny, kind)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[careful][HIGH] no.' } });
    }
  });

  test('any ask category, including ones check-careful.sh adds later, takes the same path; everything else prints nothing', () => {
    const later = codexDecision(ask('[careful] Destructive: a category added after this hook.'), 'interactive') as any;
    expect(later.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(later.hookSpecificOutput.permissionDecisionReason).toStartWith('[careful] Destructive: a category added after this hook. Codex hooks cannot ask');
    expect(codexDecision(null, 'interactive')).toBeNull();
    expect(codexDecision({ raw: 'not json' }, 'interactive')).toBeNull();
    expect(codexDecision({ decision: {} }, 'interactive')).toBeNull();
  });

  const guard = (payload: unknown, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(ROOT, 'hosts', 'codex', 'hooks', 'codex-destructive-guard-hook')], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_STATE_ROOT: path.join(dir, 'state'), ...env },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const withCommand = (command: string) => ({ ...PAYLOADS.PreToolUse, tool_input: { command } });

  test('end to end on Codex payloads: ask maps by session kind, root deletes stay denied, only Codex output keys, off prints nothing', () => {
    const interactive = guard(PAYLOADS.PreToolUse);
    expect(interactive.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(interactive.hookSpecificOutput.permissionDecisionReason).toContain(CODEX_ASK_NOTE);
    expect(Object.keys(interactive)).toEqual(['hookSpecificOutput']);
    expect(Object.keys(interactive.hookSpecificOutput).sort()).toEqual(['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    expect(guard(PAYLOADS.PreToolUse, { CI: '1' })).toEqual({ systemMessage: expect.stringContaining('Allowed without asking: this headless session') });
    expect(guard(withCommand('rm -rf /'), { CI: '1' }).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(guard(PAYLOADS.PreToolUseTui)).toBeNull();
    expect(guard(PAYLOADS.PreToolUse, { GSTACK_DESTRUCTIVE_GUARD: 'off' })).toBeNull();
  });
});
