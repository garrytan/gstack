/**
 * setup, gstack-uninstall and gstack-doctor for gstack's Codex hooks (GST-3172). setup's _skill_hook_gate and
 * _codex_hook_gate are lifted out and run against the real gstack-config and gstack-settings-hook with a temp state
 * root, a temp hooks.json and no Claude install, so one switch drives both hosts (plan D1). The Codex version
 * floor and the doctor row are lifted the same way; uninstall runs whole against a mock home.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const between = (from: string, to: string) => {
  const a = setupSrc.indexOf(from);
  const b = setupSrc.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('setup no longer has ' + from + ' ... ' + to);
  return setupSrc.slice(a, b);
};
const fnBody = (name: string) => {
  const a = setupSrc.indexOf(name + '() {');
  return setupSrc.slice(a, setupSrc.indexOf('\n}\n', a) + 3);
};

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-setup-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const hooksFile = () => path.join(dir, 'codex', 'hooks.json');
const hooks = () => (fs.existsSync(hooksFile()) ? JSON.parse(fs.readFileSync(hooksFile(), 'utf8')).hooks ?? {} : {});
const run = (script: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_STATE_ROOT: path.join(dir, 'state'), ...env },
    encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

describe('setup: Codex hook registration', () => {
  test('both Codex hooks resolve through _hook_command_path against the Codex runtime root, which links hosts/codex/hooks', () => {
    expect(setupSrc).toContain('CODEX_ROUTE_HOOK="$(_hook_command_path hosts/codex/hooks/codex-skill-route-hook "$CODEX_GSTACK" || true)"');
    expect(setupSrc).toContain('CODEX_GUARD_HOOK="$(_hook_command_path hosts/codex/hooks/codex-destructive-guard-hook "$CODEX_GSTACK" || true)"');
    expect(setupSrc).toContain('CODEX_CONTRACT_HOOK="$(_hook_command_path hosts/codex/hooks/codex-skill-contract-stop-hook "$CODEX_GSTACK" || true)"');
    expect(fnBody('create_codex_runtime_root')).toContain('_link_or_copy "$gstack_dir/hosts/codex/hooks" "$codex_gstack/hosts/codex/hooks"');
    expect(fnBody('_skill_hook_gate')).toContain('if [ -n "${CODEX_HOOKS_FILE:-}" ]; then _codex_hook_gate "$key" "$decision" "$src"; fi');
    for (const f of ['codex-skill-route-hook', 'codex-destructive-guard-hook', 'codex-skill-contract-stop-hook']) {
      expect(fs.statSync(path.join(ROOT, 'hosts', 'codex', 'hooks', f)).mode & 0o111).toBeTruthy();
    }
  });

  test('a Windows install copies the Claude hooks the Codex shims import, so the copied shims run under bash instead of failing open', () => {
    const root = path.join(dir, 'codex', 'skills', 'gstack');
    const script = ['set -e', 'IS_WINDOWS=1', '_CODEX_RENDER_ROOT="' + ROOT + '"', ...['_link_or_copy', '_copy_skill_md', '_link_runtime_dists', '_link_codex_skill_refs', 'create_codex_runtime_root'].map(fnBody),
      'create_codex_runtime_root "' + ROOT + '" "' + root + '"'].join('\n');
    const made = run(script);
    expect(made.code).toBe(0);
    expect(fs.lstatSync(path.join(root, 'hosts', 'claude', 'hooks')).isSymbolicLink()).toBe(false);
    const payloads = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'codex-hooks', 'codex-0.170-payloads.json'), 'utf8'));
    const shim = (name: string, payload: unknown) => spawnSync('bash', [path.join(root, 'hosts', 'codex', 'hooks', name)], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_STATE_ROOT: path.join(dir, 'state') },
    });
    const guard = shim('codex-destructive-guard-hook', payloads.PreToolUse);
    expect(guard.status).toBe(0);
    expect(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    for (const [name, payload] of [['codex-skill-route-hook', payloads.UserPromptSubmit], ['codex-skill-contract-stop-hook', { hook_event_name: 'Stop', stop_hook_active: false }]] as const) {
      const r = shim(name, payload);
      expect({ name, status: r.status, stderr: r.stderr }).toEqual({ name, status: 0, stderr: expect.not.stringMatching(/Cannot find|ResolveMessage|error:/i) });
    }
  });

  /** One gate run with Codex selected and Claude not: SETTINGS_HOOK is empty, as setup leaves it for --host codex. */
  function gate(key: 'skill_routing' | 'destructive_guard' | 'skill_contracts', mode: string, env: Record<string, string> = {}, noTeam = 0) {
    const runtimeRoot = path.join(dir, 'codex', 'skills', 'gstack');
    const script = [
      'set -e',
      'log() { printf "%s\\n" "$*"; }',
      'GSTACK_CONFIG="' + ROOT + '/bin/gstack-config"',
      'SETTINGS_HOOK=""',
      'SKILL_ROUTE_BIN="' + ROOT + '/bin/gstack-skill-route"',
      'IS_WINDOWS=0; NO_TEAM_MODE=' + noTeam,
      'CODEX_HOOKS_FILE="' + hooksFile() + '"; CODEX_HOOKS_READY=1; _CODEX_HOOKS_CHANGED=0',
      'CODEX_SETTINGS_HOOK="' + ROOT + '/bin/gstack-settings-hook"; CODEX_GSTACK="' + runtimeRoot + '"',
      'CODEX_ROUTE_HOOK="' + runtimeRoot + '/hosts/codex/hooks/codex-skill-route-hook"',
      'CODEX_GUARD_HOOK="' + runtimeRoot + '/hosts/codex/hooks/codex-destructive-guard-hook"',
      'CODEX_CONTRACT_HOOK="' + runtimeRoot + '/hosts/codex/hooks/codex-skill-contract-stop-hook"',
      fnBody('_codex_hook_gate'),
      fnBody('_skill_hook_gate'),
      '_skill_hook_gate ' + key + ' "$1" GSTACK_X Event "" source 5 "what"',
    ].join('\n');
    fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
    const r = spawnSync('bash', ['-c', script, 'gate', mode], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_STATE_ROOT: path.join(dir, 'state'), ...env }, encoding: 'utf8', timeout: 60_000,
    });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  }

  test('on registers each hook in its own group with its timeout and says how to turn it off; a re-run is quiet', () => {
    const routing = gate('skill_routing', 'on');
    expect(routing.code).toBe(0);
    expect(routing.out).toContain('registered Codex UserPromptSubmit hook in ' + hooksFile() + ' (on via flag; turn off: gstack-config set skill_routing off, or ./setup --no-skill-routing)');
    expect(gate('destructive_guard', 'on').out).toContain('registered Codex PreToolUse hook');
    expect(hooks().UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: expect.stringMatching(/hosts\/codex\/hooks\/codex-skill-route-hook$/), timeout: 5 }] }]);
    expect(hooks().PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: expect.stringMatching(/hosts\/codex\/hooks\/codex-destructive-guard-hook$/), timeout: 10 }] }]);
    expect(gate('skill_routing', '')).toEqual({ code: 0, out: '' });
    expect(gate('skill_contracts', 'on').out).toContain('registered Codex Stop hook in ' + hooksFile() + ' (on via flag; turn off: gstack-config set skill_contracts off, or ./setup --no-skill-contracts)');
    expect(hooks().Stop).toEqual([{ hooks: [{ type: 'command', command: expect.stringMatching(/hosts\/codex\/hooks\/codex-skill-contract-stop-hook$/), timeout: 10 }] }]);
    expect(Object.keys(hooks()).sort()).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit']);
  });

  test("off, a saved off and --no-team remove only gstack's Codex group", () => {
    gate('skill_routing', 'on');
    gate('destructive_guard', 'on');
    gate('skill_routing', 'off');
    expect(hooks().UserPromptSubmit).toBeUndefined();
    expect(hooks().PreToolUse).toHaveLength(1);
    gate('skill_routing', '');
    expect(hooks().UserPromptSubmit).toBeUndefined();
    gate('skill_contracts', 'on');
    gate('skill_contracts', 'off');
    expect(hooks().Stop).toBeUndefined();
    gate('destructive_guard', '', {}, 1);
    expect(hooks()).toEqual({});
  });

  test('the version floor: no codex, or one older than 0.170, registers nothing and says why', () => {
    const block = between('CODEX_HOOKS_FILE=""\n', 'CODEX_ROUTE_HOOK=');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const withCodex = (version: string | null) => {
      fs.rmSync(path.join(bin, 'codex'), { force: true });
      if (version) fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli ' + version + '"\n', { mode: 0o755 });
      const script = ['log() { printf "%s\\n" "$*"; }', 'INSTALL_CODEX=1; CODEX_REPO_LOCAL=0', 'SOURCE_GSTACK_DIR="' + ROOT + '"',
        'CODEX_SKILLS="' + path.join(dir, 'codex', 'skills') + '"', block, 'echo "READY=$CODEX_HOOKS_READY FILE=$CODEX_HOOKS_FILE"'].join('\n');
      return run(script, { PATH: bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin' }).out;
    };
    expect(withCodex(null)).toContain("Codex hooks not registered: no codex on PATH to check (gstack's hooks need Codex 0.170.0 or newer)");
    expect(withCodex(null)).toContain('READY=0');
    expect(withCodex('0.169.9')).toContain('Codex 0.169.9 is older than 0.170.0');
    for (const v of ['0.170.0', '0.171.2', '0.1700.0', '1.0.0']) expect(withCodex(v)).toContain('READY=1 FILE=' + path.join(dir, 'codex', 'hooks.json'));
  });
});

describe('gstack-uninstall and gstack-doctor with Codex hooks', () => {
  function seed(): { user: unknown } {
    const codex = path.join(dir, 'home', '.codex');
    fs.mkdirSync(codex, { recursive: true });
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard', timeout: 3 }] };
    const ours = { matcher: 'Bash', hooks: [{ type: 'command', command: codex + '/skills/gstack/hosts/codex/hooks/codex-destructive-guard-hook', timeout: 10 }] };
    const route = { hooks: [{ type: 'command', command: codex + '/skills/gstack/hosts/codex/hooks/codex-skill-route-hook', timeout: 5 }] };
    const contract = { hooks: [{ type: 'command', command: codex + '/skills/gstack/hosts/codex/hooks/codex-skill-contract-stop-hook', timeout: 10 }] };
    fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [user, ours], UserPromptSubmit: [route], Stop: [contract] } }, null, 2));
    return { user };
  }

  test("uninstall removes gstack's Codex groups and keeps the user's", () => {
    const { user } = seed();
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'repo'));
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-uninstall'), '--force', '--keep-state'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: path.join(home, '.codex'), GSTACK_STATE_DIR: path.join(home, '.gstack') },
      cwd: path.join(dir, 'repo'), encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("gstack's Codex hooks in " + path.join(home, '.codex', 'hooks.json'));
    expect(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'))).toEqual({ hooks: { PreToolUse: [user] } });
  });

  test("uninstall run from a global install removes gstack's Codex groups before deleting its own helper", () => {
    const { user } = seed();
    const home = path.join(dir, 'home');
    const bin = path.join(home, '.claude', 'skills', 'gstack', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const f of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-lock.sh', 'gstack-state-root.sh', 'gstack-skill-name.sh']) fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(bin, f));
    fs.mkdirSync(path.join(dir, 'repo'));
    const r = spawnSync('bash', [path.join(bin, 'gstack-uninstall'), '--force', '--keep-state'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: path.join(home, '.codex'), GSTACK_STATE_DIR: path.join(home, '.gstack') },
      cwd: path.join(dir, 'repo'), encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(bin)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'))).toEqual({ hooks: { PreToolUse: [user] } });
  });

  const uninstall = () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-uninstall'), '--force', '--keep-state'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: path.join(home, '.codex'), GSTACK_STATE_DIR: path.join(home, '.gstack') },
      cwd: path.join(dir, 'repo'), encoding: 'utf8', timeout: 60_000,
    });
    return { ...r, file: path.join(home, '.codex', 'hooks.json') };
  };

  test("uninstall with your own group after gstack's removes gstack's handler and leaves an empty group, so your hook keeps its trust position", () => {
    const { user } = seed();
    const file = path.join(dir, 'home', '.codex', 'hooks.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.hooks.PreToolUse.reverse();
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const r = uninstall();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("gstack's Codex hooks in " + r.file);
    expect(r.stderr).not.toContain('WARNING');
    expect(JSON.parse(fs.readFileSync(r.file, 'utf8'))).toEqual({ hooks: { PreToolUse: [{ hooks: [] }, user] } });
  });

  test("uninstall says so, naming the one handler to delete, when your handler sits inside gstack's group", () => {
    seed();
    const file = path.join(dir, 'home', '.codex', 'hooks.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.hooks.PreToolUse[1].hooks.push({ type: 'command', command: '/usr/local/bin/my-inner-guard' });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const r = uninstall();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARNING: gstack's Codex hooks are still in " + r.file + ' and will fail once gstack is removed.');
    expect(r.stderr).toContain('delete only the gstack handlers hooks.PreToolUse[1].hooks[0] (command ');
    expect(r.stderr).not.toContain('delete its group');
    expect(JSON.parse(fs.readFileSync(r.file, 'utf8'))).toEqual(doc);
  });

  test('the doctor row says whether each hook has a trust entry, and prints nothing without gstack hooks', () => {
    seed();
    const doctor = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-doctor'), 'utf8');
    const a = doctor.indexOf('check_codex_hooks() {');
    const fn = doctor.slice(a, doctor.indexOf('\n}\n', a) + 3);
    const script = [
      'row() { printf "%s|%s|%s|%s\\n" "$1" "$2" "$3" "${4:-}"; }',
      "clamp() { local LC_ALL=C line pat=\"[^$1]\"; IFS= read -r line; line=${line//$pat/}; printf '%s' \"${line:0:$2}\"; }",
      'BIN="' + ROOT + '/bin"; SRC="' + ROOT + '"', fn, 'check_codex_hooks',
    ].join('\n');
    const codexHome = path.join(dir, 'home', '.codex');
    expect(run(script, { CODEX_HOME: codexHome }).out).toBe('warn|codex hooks|destructive-guard no trust entry, skill-route no trust entry, skill-contract no trust entry (Codex skips a hook until it is trusted)|open Codex and trust them at its startup prompt or in /hooks\n');
    const file = fs.realpathSync(path.join(codexHome, 'hooks.json'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[hooks.state."' + file + ':pre_tool_use:1:0"]\ntrusted_hash = "sha256:a"\n[hooks.state."' + file + ':user_prompt_submit:0:0"]\ntrusted_hash = "sha256:b"\n[hooks.state."' + file + ':stop:0:0"]\ntrusted_hash = "sha256:c"\n');
    expect(run(script, { CODEX_HOME: codexHome }).out).toBe('ok|codex hooks|destructive-guard trusted, skill-route trusted, skill-contract trusted (trust entry found; hash not checked)|\n');
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: {} }));
    expect(run(script, { CODEX_HOME: codexHome }).out).toBe('');
  });
});
