/**
 * The agent role (lib/agent-model.ts, gstack-models resolve --role agent): a
 * user's model preference for gstack's working agents. Pins the value grammar
 * shared with bin/gstack-config, the precedence (request, this machine's
 * config.yaml, the preferences file, host), that a bad agent_model never stops
 * the other roles, the preferences file's parse rules, and the Capy wiring:
 * the session derives the file beside the Drive skill (any wrapper that exports
 * GSTACK_CAPY_WRAPPER_PATH, wrapper 3 included) and --check copies nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentModelError, MODEL_FAMILIES, parseAgentModel, readPreferencesFile, renderAgentModel, resolveAgentModel } from '../lib/agent-model';
import { MODEL_CATALOG } from '../lib/model-catalog';
import { modelsMain } from '../lib/model-policy-cli';

const REPO = path.resolve(import.meta.dir, '..');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });
function tmp(): string {
  const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-')));
  bases.push(b);
  return b;
}
function env(base: string, extra: Record<string, string> = {}): Record<string, string> {
  const root = path.join(base, 'state');
  fs.mkdirSync(root, { recursive: true });
  return { HOME: base, GSTACK_STATE_ROOT: root, ...extra };
}
const setConfig = (e: Record<string, string>, text: string) => fs.writeFileSync(path.join(e.GSTACK_STATE_ROOT, 'config.yaml'), text);
const config = (e: Record<string, string>, args: string[]) => spawnSync(path.join(REPO, 'bin/gstack-config'), args, { encoding: 'utf8', env: { ...process.env, ...e }, timeout: 30_000 });

describe('value grammar', () => {
  test('host, a family and <provider>/<model> parse; anything else is refused', () => {
    expect(parseAgentModel('host')).toEqual({ kind: 'host' });
    expect(parseAgentModel(' opus ')).toEqual({ kind: 'model', provider: 'anthropic', model: 'claude-opus-5-5', family: 'opus' });
    expect(parseAgentModel('OPUS')).toMatchObject({ family: 'opus' });
    expect(parseAgentModel('Host')).toEqual({ kind: 'host' });
    expect(parseAgentModel('openai/gpt-6.1-sol')).toEqual({ kind: 'model', provider: 'openai', model: 'gpt-6.1-sol', family: null });
    for (const bad of ['', 'opux', 'claude-opus-5-5', 'Anthropic/x', 'anthropic/', '/x', 'anthropic/a b', 'anthropic/x\u001b[31m']) expect(parseAgentModel(bad)).toBeNull();
  });

  test('every family the tier catalog also lists names the catalog model, so a catalog bump moves the family too', () => {
    for (const entry of MODEL_CATALOG) {
      const family = MODEL_FAMILIES.find(f => f.provider === entry.provider && entry.model.includes(f.family));
      expect(family?.model, entry.model).toBe(entry.model);
    }
  });

  test('bin/gstack-config accepts and refuses exactly what the resolver does', () => {
    const e = env(tmp());
    for (const value of ['host', 'Host', 'opus', 'OPUS', 'Sol', 'sonnet', 'terra', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol', 'opux', 'claude-opus-5-5', 'Anthropic/x', 'anthropic/a b', 'anthropic/']) {
      const r = config(e, ['set', 'agent_model', value]);
      expect(r.status === 0, value + r.stderr).toBe(parseAgentModel(value) !== null);
    }
  });
});

describe('precedence and sources', () => {
  test('host when nothing is set; the preferences file, then config.yaml, then a one-job request win in turn', () => {
    const base = tmp();
    const prefs = path.join(base, 'skill', 'preferences.yaml');
    const e = env(base, { GSTACK_PREFERENCES_FILE: prefs });
    expect(resolveAgentModel({ env: e })).toMatchObject({ status: 'host', id: null, source: { kind: 'default' } });
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    fs.writeFileSync(prefs, '# my picks\nagent_model: opus\n');
    expect(resolveAgentModel({ env: e })).toMatchObject({ status: 'selected', id: 'anthropic/claude-opus-5-5', family: 'opus', source: { kind: 'preferences', path: prefs } });
    setConfig(e, 'agent_model: openai/gpt-6.1-sol\n');
    expect(resolveAgentModel({ env: e })).toMatchObject({ id: 'openai/gpt-6.1-sol', source: { kind: 'config' }, sources: { config: 'openai/gpt-6.1-sol', preferences: 'opus' } });
    expect(resolveAgentModel({ env: e, request: 'fable' })).toMatchObject({ id: 'anthropic/claude-fable-5-1', source: { kind: 'request', path: null } });
    expect(resolveAgentModel({ env: e, request: 'host' })).toMatchObject({ status: 'host', source: { kind: 'request' } });
  });

  test('a one-job request is never saved, and a local unset falls back to the preferences file', () => {
    const base = tmp();
    const prefs = path.join(base, 'preferences.yaml');
    fs.writeFileSync(prefs, 'agent_model: opus\n');
    const e = env(base, { GSTACK_PREFERENCES_FILE: prefs });
    const r = modelsMain(['resolve', '--role', 'agent', '--request', 'sol'], e);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^agent: openai\/gpt-6\.1-sol \(sol\) - requested for this job, not saved$/m);
    expect(fs.existsSync(path.join(e.GSTACK_STATE_ROOT, 'config.yaml'))).toBe(false);
    expect(fs.readFileSync(prefs, 'utf8')).toBe('agent_model: opus\n');
    expect(config(e, ['set', 'agent_model', 'host']).status).toBe(0);
    expect(resolveAgentModel({ env: e })).toMatchObject({ status: 'host', source: { kind: 'config' } });
    expect(config(e, ['unset', 'agent_model']).status).toBe(0);
    expect(resolveAgentModel({ env: e })).toMatchObject({ id: 'anthropic/claude-opus-5-5', source: { kind: 'preferences' } });
  });

  test('a broken preferences file never blocks a request or this machine\'s config.yaml, and its raw value is never echoed', () => {
    const base = tmp();
    const prefs = path.join(base, 'preferences.yaml');
    fs.writeFileSync(prefs, 'agent_model: opus\nagent_model: sol\n');
    const e = env(base, { GSTACK_PREFERENCES_FILE: prefs });
    expect(() => resolveAgentModel({ env: e })).toThrow(/sets agent_model twice/);
    const requested = resolveAgentModel({ env: e, request: 'sonnet' });
    expect(requested).toMatchObject({ family: 'sonnet', source: { kind: 'request' } });
    expect(requested.warnings.join('\n')).toContain('sets agent_model twice');
    setConfig(e, 'agent_model: opus\n');
    expect(resolveAgentModel({ env: e })).toMatchObject({ family: 'opus', source: { kind: 'config' } });
    fs.writeFileSync(prefs, 'agent_model: x\u001b]0;title\u0007\u009b31m\u202e\n');
    const shown = renderAgentModel(resolveAgentModel({ env: e })).join('\n');
    expect(shown).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });

  test('an invalid value at the winning source is an error naming the source and the fix, never a silent fallback', () => {
    const e = env(tmp());
    setConfig(e, 'agent_model: opux\n');
    expect(() => resolveAgentModel({ env: e })).toThrow(AgentModelError);
    const r = modelsMain(['resolve', '--role', 'agent', '--json'], e);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, agent: null });
    expect(doc.errors[0]).toMatchObject({ reason: 'invalid_agent_model', key: 'agent_model' });
    expect(doc.errors[0].problem).toContain(path.join(e.GSTACK_STATE_ROOT, 'config.yaml'));
  });
});

describe('a bad agent_model never stops the other roles', () => {
  test('plan-review, implementation and eval-arms resolve, and list reports the agent error without failing', () => {
    const base = tmp();
    const e = env(base);
    setConfig(e, 'agent_model: opux\n');
    for (const args of [['resolve', '--role', 'plan-review', '--provider', 'openai'], ['resolve', '--role', 'implementation'], ['resolve', '--role', 'eval-arms']]) {
      const r = modelsMain(args, e, 'linux', base);
      expect(r.code, args.join(' ') + r.stderr).toBe(0);
    }
    const list = modelsMain(['list'], e, 'linux', base);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^agent: agent_model 'opux' in .* is not a model gstack can use$/m);
    const json = JSON.parse(modelsMain(['list', '--json'], e, 'linux', base).stdout);
    expect(json.ok).toBe(true);
    expect(json.agent.error.reason).toBe('invalid_agent_model');
    expect(json.selections.every((s: { role: string }) => s.role !== 'agent')).toBe(true);
  });

  test('list --json adds a top-level agent block and leaves selections as they were', () => {
    const base = tmp();
    const e = env(base);
    const before = JSON.parse(modelsMain(['list', '--json'], e, 'linux', base).stdout);
    setConfig(e, 'agent_model: opus\n');
    const after = JSON.parse(modelsMain(['list', '--json'], e, 'linux', base).stdout);
    expect(after.selections).toEqual(before.selections);
    expect(after.agent).toMatchObject({ role: 'agent', id: 'anthropic/claude-opus-5-5' });
    expect(after.agent.exemptions.join(' ')).toMatch(/plan-review.*eval-arms/);
  });

  test('usage: --request belongs to the agent role only, and the agent role takes no --provider', () => {
    const e = env(tmp());
    expect(modelsMain(['resolve', '--role', 'implementation', '--request', 'opus'], e).code).toBe(2);
    expect(modelsMain(['resolve', '--role', 'agent', '--provider', 'openai'], e).code).toBe(2);
    expect(modelsMain(['resolve', '--role', 'agent', '--request', 'opux'], e).code).toBe(1);
  });
});

describe('the preferences file', () => {
  test('comments, blanks and quotes are fine; unknown keys and stray lines warn; a second agent_model is an error', () => {
    const f = path.join(tmp(), 'preferences.yaml');
    fs.writeFileSync(f, '# owner preferences\n\nagent_model: "opus"\ntelemetry: on\nnot a pair\n');
    const read = readPreferencesFile(f);
    expect(read.value).toBe('opus');
    expect(read.warnings).toHaveLength(2);
    expect(read.warnings[0]).toContain(":4 sets 'telemetry', which gstack does not read from preferences; ignored");
    expect(read.warnings[1]).toContain(":5 is not a 'key: value' line; ignored");
    fs.writeFileSync(f, 'agent_model: opus\nagent_model: sol\n');
    expect(() => readPreferencesFile(f)).toThrow(/sets agent_model twice/);
  });

  test('CRLF line endings, a byte-order mark and a trailing comment still read the value', () => {
    const f = path.join(tmp(), 'preferences.yaml');
    fs.writeFileSync(f, '\ufeff# owner preferences\r\nagent_model: opus   # my pick\r\n');
    expect(readPreferencesFile(f)).toEqual({ value: 'opus', warnings: [] });
  });

  test('a missing file is silent; an oversized file or a directory is ignored with a warning', () => {
    const base = tmp();
    expect(readPreferencesFile(path.join(base, 'absent.yaml'))).toEqual({ value: null, warnings: [] });
    const big = path.join(base, 'big.yaml');
    fs.writeFileSync(big, 'agent_model: opus\n' + '#'.repeat(5000));
    const read = readPreferencesFile(big);
    expect(read.value).toBeNull();
    expect(read.warnings[0]).toContain('over 4096 bytes');
    expect(readPreferencesFile(base).warnings[0]).toContain('is not a file');
  });
});

describe('Capy wiring', () => {
  test('the session derives preferences.yaml beside the Drive skill from the wrapper path, in --check too, and copies nothing', () => {
    const base = tmp();
    const root = path.join(base, 'gstack');
    for (const rel of ['bin/gstack-capy-session', 'bin/gstack-install-verdict.sh']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    fs.writeFileSync(path.join(root, 'bin/gstack-capy-install'), '#!/usr/bin/env bash\necho "PREFS=${GSTACK_PREFERENCES_FILE:-unset}"\necho "gstack: ok 1.0.0 for=none"\n', { mode: 0o755 });
    const skill = path.join(base, 'drive', 'skills', 'gstack');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'preferences.yaml'), 'agent_model: opus\n');
    const before = fs.readdirSync(skill).sort();
    const run = (extra: Record<string, string>) => spawnSync('bash', [path.join(root, 'bin/gstack-capy-session'), '--check', '--root', root, '--for', 'review'],
      { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: base, ...extra } });
    const r = run({ GSTACK_CAPY_WRAPPER_REV: '3', GSTACK_CAPY_WRAPPER_PATH: path.join(skill, 'scripts', 'install.sh') });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('PREFS=' + path.join(skill, 'preferences.yaml'));
    expect(fs.readdirSync(skill).sort()).toEqual(before);
    expect(run({}).stdout).toContain('PREFS=unset');
    const inCheckout = run({ GSTACK_CAPY_WRAPPER_REV: '3', GSTACK_CAPY_WRAPPER_PATH: path.join(root, 'capy', 'skill', 'gstack', 'scripts', 'install.sh') });
    expect(inCheckout.stdout).toContain('PREFS=unset');
  });
});
