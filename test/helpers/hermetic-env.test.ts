/**
 * Unit tests for the hermetic child-env builder. Free tier — no API calls.
 *
 * Pins three contracts:
 * 1. Allowlist semantics: contamination vars dropped, basics/auth/network
 *    kept, overrides merge last, EVALS_HERMETIC=0 is byte-identical legacy.
 * 2. Seed-config shape: 20-char key suffix, trusted dirs, undefined-key safe.
 * 3. Dir lifecycle: /.claude suffix (extractPlanFilePath contract —
 *    claude-pty-runner.ts:191), sync singleton reuse, pid-aware GC.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildHermeticEnv,
  buildSeedConfig,
  isHermeticEnabled,
  getHermeticDirs,
  gcStaleHermeticDirs,
  hermeticChildEnv,
} from './hermetic-env';

const CONTAMINATED: NodeJS.ProcessEnv = {
  PATH: '/usr/bin', HOME: '/Users/op', TMPDIR: '/tmp', TERM: 'xterm',
  ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdefghijklmn',
  ANTHROPIC_BASE_URL: 'https://proxy.example/api',
  ANTHROPIC_MODEL: 'sneaky-model-override',
  EVALS_MODEL: 'claude-sonnet-4-6',
  GITHUB_ACTIONS: 'true',
  HTTPS_PROXY: 'http://corp:3128',
  NODE_EXTRA_CA_CERTS: '/etc/corp.pem',
  CONDUCTOR_WORKSPACE_PATH: '/Users/op/conductor/ws',
  CONDUCTOR_SESSION: '1',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CONFIG_DIR: '/Users/op/.claude',
  GSTACK_HOME: '/Users/op/.gstack',
  GSTACK_HEADLESS_DEFAULT: 'x',
  MCP_TIMEOUT: '5000',
  GBRAIN_ENDPOINT: 'http://localhost:1234',
  OPENAI_API_KEY: 'sk-openai-secret',
  VOYAGE_API_KEY: 'vg-secret',
  GH_TOKEN: 'gho_secret',
  SSH_AUTH_SOCK: '/tmp/ssh.sock',
  GIT_AUTHOR_NAME: 'Op',
};

const HERMETIC_VARS = { CLAUDE_CONFIG_DIR: '/x/.claude', GSTACK_HOME: '/x/gstack-home' };

describe('buildHermeticEnv allowlist', () => {
  const env = buildHermeticEnv(CONTAMINATED, HERMETIC_VARS);

  test('keeps process basics, network, CI, and eval knobs', () => {
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/op');
    expect(env.EVALS_MODEL).toBe('claude-sonnet-4-6');
    expect(env.GITHUB_ACTIONS).toBe('true');
    expect(env.HTTPS_PROXY).toBe('http://corp:3128');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/corp.pem');
  });

  test('keeps named auth vars but not the broad ANTHROPIC_ prefix', () => {
    expect(env.ANTHROPIC_API_KEY).toBe(CONTAMINATED.ANTHROPIC_API_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe(CONTAMINATED.ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_MODEL).toBeUndefined(); // behavior knob, not auth
  });

  test('drops session-context and operator-credential vars', () => {
    for (const k of [
      'CONDUCTOR_WORKSPACE_PATH', 'CONDUCTOR_SESSION', 'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT', 'GSTACK_HEADLESS_DEFAULT', 'MCP_TIMEOUT',
      'GBRAIN_ENDPOINT', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GH_TOKEN',
      'SSH_AUTH_SOCK', 'GIT_AUTHOR_NAME',
    ]) {
      expect(env[k]).toBeUndefined();
    }
  });

  test('redirects CLAUDE_CONFIG_DIR and GSTACK_HOME to hermetic values', () => {
    expect(env.CLAUDE_CONFIG_DIR).toBe('/x/.claude');
    expect(env.GSTACK_HOME).toBe('/x/gstack-home');
  });

  test('overrides merge last — per-test re-contamination is deliberate', () => {
    const e = buildHermeticEnv(CONTAMINATED, HERMETIC_VARS, {
      CONDUCTOR_WORKSPACE_PATH: '/tmp/test-ws',
      GSTACK_HOME: '/tmp/test-home',
      GSTACK_HEADLESS: '',
    });
    expect(e.CONDUCTOR_WORKSPACE_PATH).toBe('/tmp/test-ws');
    expect(e.GSTACK_HOME).toBe('/tmp/test-home');
    expect(e.GSTACK_HEADLESS).toBe('');
  });

  test('promotes GSTACK_ANTHROPIC_API_KEY when canonical absent (shared shim fn)', () => {
    const base = { ...CONTAMINATED } as NodeJS.ProcessEnv;
    delete base.ANTHROPIC_API_KEY;
    base.GSTACK_ANTHROPIC_API_KEY = 'sk-ant-promoted-9876543210';
    const e = buildHermeticEnv(base, HERMETIC_VARS);
    expect(e.ANTHROPIC_API_KEY).toBe('sk-ant-promoted-9876543210');
    expect(e.GSTACK_ANTHROPIC_API_KEY).toBeUndefined(); // GSTACK_* still dropped
  });

  test('extraAllow re-admits exact names and prefixes per runner', () => {
    const e = buildHermeticEnv(CONTAMINATED, HERMETIC_VARS, undefined, {
      extraAllow: ['OPENAI_API_KEY', 'GIT_*'],
    });
    expect(e.OPENAI_API_KEY).toBe('sk-openai-secret');
    expect(e.GIT_AUTHOR_NAME).toBe('Op');
    expect(e.GH_TOKEN).toBeUndefined(); // not in extraAllow
  });

  test('TERM falls back when base omits it', () => {
    const base = { ...CONTAMINATED } as NodeJS.ProcessEnv;
    delete base.TERM;
    expect(buildHermeticEnv(base, HERMETIC_VARS).TERM).toBe('xterm-256color');
  });
});

describe('EVALS_HERMETIC=0 escape hatch', () => {
  test('returns byte-identical legacy env, overrides still last', () => {
    const base = { ...CONTAMINATED, EVALS_HERMETIC: '0' } as NodeJS.ProcessEnv;
    const e = buildHermeticEnv(base, HERMETIC_VARS, { GSTACK_HEADLESS: '1' });
    // Legacy spread: every base var survives, hermeticVars NOT applied.
    expect(e.CONDUCTOR_WORKSPACE_PATH).toBe(CONTAMINATED.CONDUCTOR_WORKSPACE_PATH);
    expect(e.CLAUDE_CONFIG_DIR).toBe('/Users/op/.claude');
    expect(e.GSTACK_HOME).toBe('/Users/op/.gstack');
    expect(e.GSTACK_HEADLESS).toBe('1');
    expect(e).toEqual({ ...(base as Record<string, string>), GSTACK_HEADLESS: '1' });
  });

  test('isHermeticEnabled reads at call time (ESM-hoist safety)', () => {
    const prev = process.env.EVALS_HERMETIC;
    try {
      process.env.EVALS_HERMETIC = '0';
      expect(isHermeticEnabled()).toBe(false);
      process.env.EVALS_HERMETIC = '1';
      expect(isHermeticEnabled()).toBe(true);
      delete process.env.EVALS_HERMETIC;
      expect(isHermeticEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EVALS_HERMETIC;
      else process.env.EVALS_HERMETIC = prev;
    }
  });
});

describe('buildSeedConfig', () => {
  test('stores only the 20-char key suffix and trusts the given dirs', () => {
    const seed = buildSeedConfig({
      apiKey: 'sk-ant-0123456789abcdefghijklmn',
      trustedDirs: ['/repo/root'],
    }) as any;
    expect(seed.hasCompletedOnboarding).toBe(true);
    const approved = seed.customApiKeyResponses.approved;
    expect(approved).toHaveLength(1);
    expect(approved[0]).toHaveLength(20);
    expect('sk-ant-0123456789abcdefghijklmn'.endsWith(approved[0])).toBe(true);
    expect(seed.projects['/repo/root'].hasTrustDialogAccepted).toBe(true);
    expect(seed.projects['/repo/root'].hasCompletedProjectOnboarding).toBe(true);
  });

  test('apiKey undefined → omits customApiKeyResponses, does not throw', () => {
    const seed = buildSeedConfig({ apiKey: undefined, trustedDirs: [] }) as any;
    expect(seed.customApiKeyResponses).toBeUndefined();
    expect(seed.hasCompletedOnboarding).toBe(true);
  });

  test('no full key material anywhere in the seed', () => {
    const key = 'sk-ant-0123456789abcdefghijklmn';
    const json = JSON.stringify(buildSeedConfig({ apiKey: key, trustedDirs: [] }));
    expect(json.includes(key)).toBe(false);
  });
});

describe('getHermeticDirs lifecycle', () => {
  test('configDir ends in /.claude — extractPlanFilePath contract', () => {
    // claude-pty-runner.ts:191 anchors plan paths on `.claude/plans/` under
    // /var|/tmp prefixes; the dir-name suffix is what keeps PTY plan-mode
    // tests extracting hermetic plan files with zero extractor changes.
    const dirs = getHermeticDirs();
    expect(dirs.configDir.endsWith(`${path.sep}.claude`)).toBe(true);
    expect(dirs.configDir.startsWith(os.tmpdir())).toBe(true);
  });

  test('sync singleton: repeat calls return the same dirs', () => {
    expect(getHermeticDirs()).toBe(getHermeticDirs());
  });

  test('seeds .claude.json in the config dir', () => {
    const dirs = getHermeticDirs();
    const seed = JSON.parse(fs.readFileSync(path.join(dirs.configDir, '.claude.json'), 'utf-8'));
    expect(seed.hasCompletedOnboarding).toBe(true);
    const root = path.resolve(__dirname, '..', '..');
    expect(seed.projects[root].hasTrustDialogAccepted).toBe(true);
  });
});

describe('gcStaleHermeticDirs', () => {
  test('removes dead-pid dirs, keeps live-pid and foreign dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-gc-test-'));
    // Find a pid that is definitely dead: spawn-and-reap is overkill; use a
    // huge pid beyond pid_max on macOS/Linux defaults.
    const deadPid = 99999999;
    const dead = path.join(tmp, `gstack-hermetic-${deadPid}-abc`);
    const live = path.join(tmp, `gstack-hermetic-${process.pid}-abc`);
    const foreign = path.join(tmp, 'unrelated-dir');
    const malformed = path.join(tmp, 'gstack-hermetic-notapid-abc');
    for (const d of [dead, live, foreign, malformed]) fs.mkdirSync(d);
    // GC only reclaims dirs older than its 1h age floor (PID-reuse guard);
    // backdate the dead-pid dir's mtime so it qualifies.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dead, old, old);

    gcStaleHermeticDirs(tmp);

    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true); // never guess on malformed names
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('keeps a fresh dead-pid dir (PID-reuse grace window)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-gc-fresh-'));
    // Dead pid but just created — must survive GC, else PID reuse could delete
    // a dir whose original pid exited and got recycled to a live process.
    const freshDead = path.join(tmp, 'gstack-hermetic-99999999-xyz');
    fs.mkdirSync(freshDead);
    gcStaleHermeticDirs(tmp);
    expect(fs.existsSync(freshDead)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('hermeticChildEnv composition', () => {
  test('hermetic by default: redirects config dirs, drops contamination', () => {
    // process.env in a real test run may carry CONDUCTOR_*/CLAUDECODE — the
    // composition must scrub them and point at the singleton dirs.
    const e = hermeticChildEnv({ GSTACK_HEADLESS: '1' });
    const dirs = getHermeticDirs();
    expect(e.CLAUDE_CONFIG_DIR).toBe(dirs.configDir);
    expect(e.GSTACK_HOME).toBe(dirs.gstackHome);
    expect(e.GSTACK_HEADLESS).toBe('1');
    expect(e.CLAUDECODE).toBeUndefined();
    expect(e.CONDUCTOR_WORKSPACE_PATH).toBeUndefined();
  });

  test('EVALS_HERMETIC=0: legacy passthrough of live process.env', () => {
    const prev = process.env.EVALS_HERMETIC;
    try {
      process.env.EVALS_HERMETIC = '0';
      const e = hermeticChildEnv({ EXTRA: 'x' });
      expect(e.PATH).toBe(process.env.PATH as string);
      expect(e.EXTRA).toBe('x');
      // No hermetic redirection in legacy mode.
      expect(e.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR as any);
    } finally {
      if (prev === undefined) delete process.env.EVALS_HERMETIC;
      else process.env.EVALS_HERMETIC = prev;
    }
  });
});

afterAll(() => {
  // The singleton's own exit hook handles runRoot; nothing else to clean.
});
