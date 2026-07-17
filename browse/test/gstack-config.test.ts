/**
 * Behavioral tests for the Node compatibility adapter in bin/gstack-config.
 *
 * config.json is the sole writable authority. A legacy config.yaml remains
 * read-only migration input, and every mutation must first claim GSTACK_HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-config');
const NODE = Bun.which('node') ?? 'node';

let stateDir: string;

function environment(home = stateDir) {
  return {
    ...process.env,
    GSTACK_HOME: home,
    GSTACK_STATE_ROOT: home,
    GSTACK_STATE_DIR: home,
  };
}

function run(args: string[] = [], home = stateDir) {
  const result = Bun.spawnSync([NODE, SCRIPT, ...args], {
    env: environment(home),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function readConfig(home = stateDir) {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-config-test-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('gstack-config', () => {
  describe('defaults, get, and list', () => {
    test('defaults prints the compatibility defaults without claiming the home', () => {
      const { exitCode, stdout, stderr } = run(['defaults']);

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('auto_upgrade: false');
      expect(stdout).toContain('codex_reviews: enabled');
      expect(stdout).toContain('proactive: true');
      expect(stdout).toContain('routing_declined: false');
      expect(readdirSync(stateDir)).toEqual([]);
    });

    test('get returns a documented default and an empty unknown value', () => {
      expect(run(['get', 'auto_upgrade'])).toMatchObject({
        exitCode: 0,
        stdout: 'false',
        stderr: '',
      });
      expect(run(['get', 'some_unknown_key'])).toMatchObject({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      expect(readdirSync(stateDir)).toEqual([]);
    });

    test('list merges and flattens stored JSON over compatibility defaults', () => {
      expect(run(['set', 'telemetry', 'community']).exitCode).toBe(0);

      const { exitCode, stdout, stderr } = run(['list']);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('network.mode: off');
      expect(stdout).toContain('proactive: true');
      expect(stdout).toContain('telemetry: community');
    });
  });

  describe('legacy YAML migration input', () => {
    test('get falls back to YAML and returns the last matching value', () => {
      writeFileSync(
        join(stateDir, 'config.yaml'),
        'telemetry: off\ntelemetry: "community" # latest choice\n',
      );

      expect(run(['get', 'telemetry'])).toMatchObject({
        exitCode: 0,
        stdout: 'community',
      });
      expect(existsSync(join(stateDir, 'config.json'))).toBe(false);
    });

    test('list reads legacy values without mutating the YAML-only home', () => {
      const yaml = 'auto_upgrade: true\nupdate_check: false\n';
      writeFileSync(join(stateDir, 'config.yaml'), yaml);

      const { exitCode, stdout } = run(['list']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('auto_upgrade: true');
      expect(stdout).toContain('update_check: false');
      expect(readFileSync(join(stateDir, 'config.yaml'), 'utf8')).toBe(yaml);
      expect(existsSync(join(stateDir, 'config.json'))).toBe(false);
    });

    test('set adopts recognized legacy state, preserves YAML, and gives JSON authority', () => {
      const yaml = 'telemetry: community\nproactive: false\n';
      writeFileSync(join(stateDir, 'config.yaml'), yaml);

      expect(run(['set', 'telemetry', 'off']).exitCode).toBe(0);
      expect(readFileSync(join(stateDir, 'config.yaml'), 'utf8')).toBe(yaml);
      expect(readConfig()).toMatchObject({ telemetry: 'off', proactive: false });
      expect(run(['get', 'telemetry']).stdout).toBe('off');
      expect(JSON.parse(readFileSync(join(stateDir, '.gstack-managed-home.json'), 'utf8'))).toMatchObject({
        kind: 'gstack-managed-home',
        home: stateDir,
        adoptedLegacy: true,
        preexistingTopLevel: ['config.yaml'],
      });
    });
  });

  describe('JSON writes and managed-home ownership', () => {
    test('first set claims the home and atomically commits valid config.json', () => {
      expect(run(['set', 'auto_upgrade', 'true'])).toMatchObject({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      expect(readConfig()).toMatchObject({
        schemaVersion: 2,
        auto_upgrade: true,
      });
      expect(JSON.parse(readFileSync(join(stateDir, '.gstack-managed-home.json'), 'utf8'))).toMatchObject({
        kind: 'gstack-managed-home',
        home: stateDir,
      });
      expect(existsSync(join(stateDir, 'secrets.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'config.yaml'))).toBe(false);
      expect(readdirSync(stateDir).some((name) => /\.tmp-|\.replace-/.test(name))).toBe(false);
    });

    test('subsequent sets replace values without losing unrelated JSON state', () => {
      expect(run(['set', 'first_setting', 'first-value']).exitCode).toBe(0);
      expect(run(['set', 'auto_upgrade', 'true']).exitCode).toBe(0);
      expect(run(['set', 'first_setting', 'replacement']).exitCode).toBe(0);

      expect(readConfig()).toMatchObject({
        first_setting: 'replacement',
        auto_upgrade: true,
        network: { mode: 'off', consent: false, selection: null },
      });
      expect(readdirSync(stateDir).some((name) => /\.tmp-|\.replace-/.test(name))).toBe(false);
    });

    test('set creates and claims a nested GSTACK_HOME', () => {
      const nested = join(stateDir, 'nested', 'state');

      expect(run(['set', 'telemetry', 'anonymous'], nested).exitCode).toBe(0);
      expect(readConfig(nested).telemetry).toBe('anonymous');
      expect(JSON.parse(readFileSync(join(nested, '.gstack-managed-home.json'), 'utf8'))).toMatchObject({
        kind: 'gstack-managed-home',
        home: nested,
      });
    });

    test('set refuses to claim an unrelated non-empty directory', () => {
      writeFileSync(join(stateDir, 'user-file.txt'), 'keep me\n');

      const { exitCode, stderr } = run(['set', 'telemetry', 'off']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Refusing to claim a non-empty directory as managed home');
      expect(readFileSync(join(stateDir, 'user-file.txt'), 'utf8')).toBe('keep me\n');
      expect(existsSync(join(stateDir, 'config.json'))).toBe(false);
    });
  });

  describe('key and value validation', () => {
    test('set rejects keys with metacharacters before writing state', () => {
      const { exitCode, stderr } = run(['set', '.*', 'value']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('alphanumeric');
      expect(readdirSync(stateDir)).toEqual([]);
    });

    test('set preserves string values containing former sed metacharacters', () => {
      expect(run(['set', 'test_special', 'a/b&c\\d']).exitCode).toBe(0);
      expect(run(['get', 'test_special']).stdout).toBe('a/b&c\\d');
      expect(readConfig().test_special).toBe('a/b&c\\d');
    });

    test('closed-domain values warn and store their safe fallback', () => {
      const { exitCode, stderr } = run(['set', 'artifacts_sync_mode', 'bogus']);

      expect(exitCode).toBe(0);
      expect(stderr).toContain('not recognized');
      expect(stderr).toContain('Using off');
      expect(run(['get', 'artifacts_sync_mode']).stdout).toBe('off');
    });
  });

  describe('codex_reviews', () => {
    test('defaults to enabled and accepts both supported values', () => {
      expect(run(['get', 'codex_reviews']).stdout).toBe('enabled');
      expect(run(['set', 'codex_reviews', 'disabled']).exitCode).toBe(0);
      expect(run(['get', 'codex_reviews']).stdout).toBe('disabled');
      expect(run(['set', 'codex_reviews', 'enabled']).exitCode).toBe(0);
      expect(run(['get', 'codex_reviews']).stdout).toBe('enabled');
    });

    test('rejects an invalid value and preserves the existing choice', () => {
      expect(run(['set', 'codex_reviews', 'disabled']).exitCode).toBe(0);

      const { exitCode, stderr } = run(['set', 'codex_reviews', 'disabledd']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not recognized');
      expect(run(['get', 'codex_reviews']).stdout).toBe('disabled');
      expect(readConfig().codex_reviews).toBe('disabled');
    });
  });

  describe('routing_declined', () => {
    test('defaults false and round-trips true then false', () => {
      expect(run(['get', 'routing_declined']).stdout).toBe('false');
      expect(run(['set', 'routing_declined', 'true']).exitCode).toBe(0);
      expect(run(['get', 'routing_declined']).stdout).toBe('true');
      expect(run(['set', 'routing_declined', 'false']).exitCode).toBe(0);
      expect(run(['get', 'routing_declined']).stdout).toBe('false');
      expect(readConfig().routing_declined).toBe(false);
    });
  });

  test('usage errors write stderr, not stdout', () => {
    const { exitCode, stdout, stderr } = run([]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage: gstack-config');
  });
});
