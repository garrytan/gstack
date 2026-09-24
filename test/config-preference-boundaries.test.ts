import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '..');
let fixture: string;
let home: string;
let state: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'gstack-boundaries-'));
  home = join(fixture, 'home');
  state = join(fixture, 'state with spaces');
  cwd = join(fixture, 'checkout');
  for (const dir of [home, state, cwd]) mkdirSync(dir, { recursive: true });
  env = {
    PATH: process.env.PATH, HOME: home, GSTACK_HOME: state,
    GSTACK_DIR: ROOT, GSTACK_TELEMETRY_SOURCE: 'test',
    GSTACK_QUESTION_LOG_NO_DERIVE: '1',
  };
  writeFileSync(join(fixture, 'VERSION'), readFileSync(join(ROOT, 'VERSION')));
  env.GSTACK_REMOTE_URL = `file://${join(fixture, 'VERSION')}`;
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function run(cmd: string[], input?: string) {
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd, env, input, encoding: 'utf-8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

function bin(name: string, ...args: string[]) {
  return run([join(ROOT, 'bin', name), ...args]);
}

function config(text: string, dir = state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), text);
}

function tsRead(key: string) {
  return JSON.parse(run(['bun', '-e', `import { readGstackConfigYamlKey } from ${JSON.stringify(join(ROOT, 'browse/src/config.ts'))}; console.log(JSON.stringify(readGstackConfigYamlKey(${JSON.stringify(key)})));`]));
}

describe('flat config native reader parity', () => {
  for (const [value, expected] of [
    ['false # offline review', 'false'],
    ['"a # quoted hash" # comment', 'a # quoted hash'],
    ["'a # quoted hash' # comment", 'a # quoted hash'],
    ['"single\'quote"', "single'quote"],
    ["'double\"quote'", 'double"quote'],
    ['true', 'true'],
    ['"false"', 'false'],
    ['"unterminated', ''],
    ['"on\'', ''],
    ['"on" trailing junk', ''],
  ]) {
    test(`scalar ${JSON.stringify(value)} agrees`, () => {
      config(`scalar: ${value}\n`);
      expect(bin('gstack-config', 'get', 'scalar')).toBe(expected);
      expect(tsRead('scalar')).toBe(expected);
    });
  }

  test('last duplicate wins, including a malformed safety setting', () => {
    config('pair_agent: on\npair_agent: "off\n');
    writeFileSync(join(state, 'config.json'), '{"pair_agent":"on"}');
    expect(bin('gstack-config', 'get', 'pair_agent')).toBe('');
    expect(tsRead('pair_agent')).toBe('');
    expect(run(['bun', '-e', `import { isPairAgentEnabled } from ${JSON.stringify(join(ROOT, 'browse/src/config.ts'))}; console.log(isPairAgentEnabled());`]).trim()).toBe('false');
    config('scalar: first\n  scalar : "last # value" # comment\n');
    expect(bin('gstack-config', 'get', 'scalar')).toBe('last # value');
    expect(tsRead('scalar')).toBe('last # value');
  });

  test('commented false and malformed values disable the actual update checker', () => {
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf-8').trim();
    env.GSTACK_STATE_DIR = state;
    writeFileSync(join(state, 'last-update-check'), `UPGRADE_AVAILABLE ${version} 99.0.0\n`);
    for (const value of ['false # offline review', '"false" # disabled', '"false', 'invalid']) {
      config(`update_check: ${value}\n`);
      expect(bin('gstack-update-check')).toBe('');
    }
    config('update_check: true\n');
    expect(bin('gstack-update-check')).toContain('UPGRADE_AVAILABLE');
  });

  test('malformed telemetry never enables the update checker ping', async () => {
    const fakeBin = join(fixture, 'fake-bin');
    mkdirSync(fakeBin);
    env.PATH = `${fakeBin}:${env.PATH}`;
    env.GSTACK_SUPABASE_URL = 'https://fixture.invalid';
    env.GSTACK_SUPABASE_ANON_KEY = 'fixture-anon-key';
    env.FIXTURE_PING = join(fixture, 'ping');
    env.FIXTURE_VERSION = join(fixture, 'VERSION');
    writeFileSync(join(fakeBin, 'curl'), `#!/usr/bin/env bash
if [[ "$*" == *functions/v1/update-check* ]]; then
  printf ping > "$FIXTURE_PING"
else
  cat "$FIXTURE_VERSION"
fi
`, { mode: 0o755 });
    for (const tier of ['off # no consent', 'unknown', '"community']) {
      rmSync(join(state, 'last-update-check'), { force: true });
      config(`update_check: true\ntelemetry: ${tier}\n`);
      bin('gstack-update-check');
      await Bun.sleep(150);
      expect(existsSync(env.FIXTURE_PING!)).toBe(false);
    }
    rmSync(join(state, 'last-update-check'), { force: true });
    config('update_check: true\ntelemetry: community\n');
    bin('gstack-update-check');
    for (let i = 0; i < 100 && !existsSync(env.FIXTURE_PING!); i++) await Bun.sleep(20);
    expect(readFileSync(env.FIXTURE_PING!, 'utf-8')).toBe('ping');
  });
});

describe('canonical preference writer and native hook', () => {
  function initRepo() {
    run(['git', 'init', '-q']);
    run(['git', 'commit', '--allow-empty', '-m', 'fixture seed']);
    run(['git', 'remote', 'add', 'origin', 'https://example.invalid/owner/actual-project.git']);
  }

  function writePreference(pref = 'never-ask') {
    bin('gstack-question-preference', '--write', JSON.stringify({ question_id: 'test-q', preference: pref, source: 'plan-tune' }));
  }

  function hook(question = '<gstack-qid:test-q> Choose a formatter?', options = ['A) Format (recommended)', 'B) Skip']) {
    return run(['bun', join(ROOT, 'hosts/claude/hooks/question-preference-hook.ts')], JSON.stringify({
      session_id: 'fixture-session', tool_use_id: 'fixture-tool', tool_name: 'AskUserQuestion', cwd,
      tool_input: { questions: [{ question, options }] },
    }));
  }

  function expectAcknowledgement() {
    const output = JSON.parse(hook());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('A) Format');
    expect(existsSync(join(state, 'sessions/fixture-session/.auto-decided-fixture-tool'))).toBe(true);
  }

  test('remote identity survives cache hits, misses, subdirs and renamed checkout', () => {
    initRepo();
    writePreference();
    expect(existsSync(join(state, 'projects/owner-actual-project/question-preferences.json'))).toBe(true);
    expectAcknowledgement();
    rmSync(join(state, 'slug-cache'), { recursive: true, force: true });
    expectAcknowledgement();
    const original = cwd;
    cwd = join(cwd, 'nested');
    mkdirSync(cwd);
    expectAcknowledgement();
    cwd = join(fixture, 'renamed');
    renameSync(original, cwd);
    expectAcknowledgement();
  });

  test('override and sticky cache use the same bucket as the writer', () => {
    initRepo();
    env.GSTACK_PROJECT_SLUG = 'chosen-project';
    writePreference();
    expectAcknowledgement();
    delete env.GSTACK_PROJECT_SLUG;
    mkdirSync(join(state, 'slug-cache'), { recursive: true });
    writeFileSync(join(state, 'slug-cache', cwd.replace(/\//g, '_')), 'pre-remote-identity');
    writePreference();
    expectAcknowledgement();
  });

  test('canonical local preferences retain abstention and safety overrides', () => {
    initRepo();
    expect(hook()).toBe('');
    writePreference('always-ask');
    expect(hook()).toBe('');
    writePreference();
    expect(hook('<gstack-qid:test-q> Delete the production database?')).toBe('');
    expect(hook('<gstack-qid:test-q> Choose a formatter?', ['A) One (recommended)', 'B) Two (recommended)'])).toBe('');
    expect(hook('No marker')).toBe('');
  });

  test('malformed preferences abstain instead of auto-deciding', () => {
    initRepo();
    writePreference();
    writeFileSync(join(state, 'projects/owner-actual-project/question-preferences.json'), '{"test-q":"not-a-preference"}');
    expect(hook()).toBe('');
  });
});

describe('native state-root consumers', () => {
  for (const mode of ['home', 'explicit', 'legacy', 'plugin', 'state-root', 'precedence']) {
    test(`${mode}: config, hook writer, update cache, telemetry cleanup and brain cache agree`, () => {
      delete env.GSTACK_HOME;
      if (mode === 'home') state = join(home, '.gstack');
      if (mode === 'explicit' || mode === 'precedence') env.GSTACK_HOME = state;
      if (mode === 'legacy') env.GSTACK_STATE_DIR = state;
      if (mode === 'plugin') Object.assign(env, { CLAUDE_PLUGIN_ROOT: '/plugins/gstack', CLAUDE_PLUGIN_DATA: state });
      if (mode === 'state-root' || mode === 'precedence') env.GSTACK_STATE_ROOT = state;
      if (mode === 'precedence') Object.assign(env, { GSTACK_HOME: join(fixture, 'other-home'), GSTACK_STATE_DIR: join(fixture, 'legacy') });
      config('update_check: true\ntelemetry: off\nscalar: root-value\n');
      expect(bin('gstack-config', 'get', 'scalar')).toBe('root-value');
      expect(tsRead('scalar')).toBe('root-value');
      const version = readFileSync(join(ROOT, 'VERSION'), 'utf-8').trim();
      writeFileSync(join(state, 'last-update-check'), `UPGRADE_AVAILABLE ${version} 99.0.0\n`);
      expect(bin('gstack-update-check')).toContain('UPGRADE_AVAILABLE');
      const analytics = join(state, 'analytics');
      mkdirSync(analytics);
      writeFileSync(join(analytics, '.pending-test'), '{}');
      bin('gstack-telemetry-log', '--session-id', 'test', '--no-sweep');
      expect(existsSync(join(analytics, '.pending-test'))).toBe(false);
      bin('gstack-brain-cache', 'invalidate', 'user-profile');
      expect(existsSync(join(state, 'brain-cache/_meta.json'))).toBe(true);
      env.GSTACK_PROJECT_SLUG = 'root-check';
      bin('gstack-question-preference', '--write', '{"question_id":"test-q","preference":"never-ask","source":"plan-tune"}');
      expect(existsSync(join(state, 'projects/root-check/question-preferences.json'))).toBe(true);
      const hook = JSON.parse(run(['bun', join(ROOT, 'hosts/claude/hooks/question-preference-hook.ts')], JSON.stringify({
        session_id: 'root-session', tool_use_id: 'root-tool', tool_name: 'AskUserQuestion', cwd,
        tool_input: { questions: [{ question: '<gstack-qid:test-q> Choose a formatter?', options: ['Format (recommended)', 'Skip'] }] },
      })));
      expect(hook.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(existsSync(join(state, 'projects/root-check/question-log.jsonl'))).toBe(true);
    });
  }

  test('telemetry honors GSTACK_HOME independently of config lookup', () => {
    config('telemetry: off\n');
    mkdirSync(join(state, 'analytics'));
    const marker = join(state, 'analytics/.pending-root-probe');
    writeFileSync(marker, '{}');
    bin('gstack-telemetry-log', '--session-id', 'root-probe', '--no-sweep');
    expect(existsSync(marker)).toBe(false);
  });

  test('brain cache honors plugin state independently of config lookup', () => {
    delete env.GSTACK_HOME;
    Object.assign(env, { CLAUDE_PLUGIN_ROOT: '/plugins/gstack', CLAUDE_PLUGIN_DATA: state });
    bin('gstack-brain-cache', 'invalidate', 'user-profile');
    expect(existsSync(join(state, 'brain-cache/_meta.json'))).toBe(true);
  });

  test('telemetry passes its resolved root to the actual sync child', () => {
    const install = join(fixture, 'install');
    mkdirSync(join(install, 'bin'), { recursive: true });
    for (const name of ['gstack-config', 'gstack-paths', 'gstack-slug']) {
      copyFileSync(join(ROOT, 'bin', name), join(install, 'bin', name));
    }
    copyFileSync(join(ROOT, 'VERSION'), join(install, 'VERSION'));
    const capture = join(fixture, 'sync-root');
    env.GSTACK_DIR = install;
    env.GSTACK_STATE_DIR = join(fixture, 'wrong-legacy-root');
    env.FIXTURE_CAPTURE = capture;
    writeFileSync(join(install, 'bin/gstack-telemetry-sync'), `#!/usr/bin/env bash
printf '%s' "$GSTACK_STATE_DIR" > "$FIXTURE_CAPTURE"
`, { mode: 0o755 });
    config('telemetry: anonymous\n');
    bin('gstack-telemetry-log', '--skill', 'qa', '--session-id', 'root-test', '--no-sweep');
    expect(existsSync(join(state, 'analytics/skill-usage.jsonl'))).toBe(true);
    expect(readFileSync(capture, 'utf-8')).toBe(state);
  });
});
