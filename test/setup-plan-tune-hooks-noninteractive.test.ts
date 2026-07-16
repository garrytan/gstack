import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// Regression guard for the conductor/workspace setup hang:
// `./setup` used a blocking `read -r` to ask "Install both hooks now? [y/N]".
// When setup runs under a forwarded/automated TTY (conductor workspace setup,
// CI with a pty) the read blocked forever. The fix moves the decision into
// flags + env + saved config with a non-blocking, time-bounded prompt fallback.
//
// These are static + binary-level assertions (free, <1s) — they lock in the
// contract without running the full (environment-mutating) setup script.

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = path.join(ROOT, 'setup');
const GSTACK_CONFIG = path.join(ROOT, 'bin', 'gstack-config');

const setupSrc = fs.readFileSync(SETUP, 'utf-8');

describe('setup: plan-tune hooks are non-interactive-safe', () => {
  test('exposes --plan-tune-hooks / --no-plan-tune-hooks / =value flags', () => {
    expect(setupSrc).toContain('--plan-tune-hooks)');
    expect(setupSrc).toContain('--no-plan-tune-hooks)');
    expect(setupSrc).toContain('--plan-tune-hooks=*)');
  });

  test('resolution falls through env then saved config', () => {
    expect(setupSrc).toContain('GSTACK_PLAN_TUNE_HOOKS');
    expect(setupSrc).toContain('get plan_tune_hooks');
  });

  test('explicit yes/no decisions never reach a prompt', () => {
    // The yes/no branches must short-circuit before the interactive branch.
    const yesIdx = setupSrc.indexOf('PT_DECISION" = "yes"');
    const noIdx = setupSrc.indexOf('PT_DECISION" = "no"');
    const promptIdx = setupSrc.indexOf('Install both hooks now?');
    expect(yesIdx).toBeGreaterThan(-1);
    expect(noIdx).toBeGreaterThan(-1);
    expect(yesIdx).toBeLessThan(promptIdx);
    expect(noIdx).toBeLessThan(promptIdx);
  });

  test('the interactive prompt is time-bounded (cannot hang)', () => {
    // No bare blocking read for the plan-tune reply.
    expect(setupSrc).not.toMatch(/read -r PLAN_TUNE_INSTALL_REPLY\b/);
    // It must use a timed read from the controlling tty with an empty fallback.
    // The timeout may be a literal or a named variable (e.g. "$_PT_PROMPT_TIMEOUT").
    expect(setupSrc).toMatch(/read -t (?:\d+|"?\$\{?\w+\}?"?) -r PLAN_TUNE_INSTALL_REPLY <\/dev\/tty/);
  });

  test('interactive prompt is gated on a real TTY and non-quiet', () => {
    // The prompt branch requires both stdin+stdout TTYs and not --quiet.
    expect(setupSrc).toMatch(/\[ "\$QUIET" -ne 1 \] && \[ -t 0 \] && \[ -t 1 \]/);
  });

  test('decision input is normalized (lowercase + whitespace-stripped)', () => {
    // "YES" / " yes" from a flag/env must not silently downgrade to skip.
    expect(setupSrc).toMatch(/tr '\[:upper:\]' '\[:lower:\]'/);
    expect(setupSrc).toMatch(/PT_DECISION=\$\(printf .* tr/);
  });
});

describe('dev-setup: never silently mutates global settings.json', () => {
  const DEV_SETUP = path.join(ROOT, 'bin', 'dev-setup');
  const devSetupSrc = fs.readFileSync(DEV_SETUP, 'utf-8');

  test('runs setup with stdin detached AND --plan-tune-hooks=prompt pin', () => {
    // stdin alone only suppresses the prompt branch; the flag (highest
    // precedence) is what stops a saved `plan_tune_hooks: yes` / env opt-in
    // from rewriting global hooks to the ephemeral worktree path.
    expect(devSetupSrc).toMatch(/setup" --plan-tune-hooks=prompt <\/dev\/null/);
  });
});

describe('gstack-config: plan_tune_hooks key', () => {
  // Isolate state: gstack-config reads $GSTACK_HOME/config.yaml. Point it at a
  // fresh temp dir so `get` returns the built-in default rather than whatever
  // the host machine has in ~/.gstack/config.yaml (which would make the
  // default-value assertion non-deterministic).
  let tmpHome: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-test-'));
    env = { ...process.env, GSTACK_HOME: tmpHome };
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('default is "prompt"', () => {
    const out = execSync(`${GSTACK_CONFIG} get plan_tune_hooks`, {
      encoding: 'utf-8',
      env,
    }).trim();
    expect(out).toBe('prompt');
  });

  test('appears in defaults and list output', () => {
    const defaults = execSync(`${GSTACK_CONFIG} defaults`, { encoding: 'utf-8', env });
    expect(defaults).toContain('plan_tune_hooks');
    const list = execSync(`${GSTACK_CONFIG} list`, { encoding: 'utf-8', env });
    expect(list).toContain('plan_tune_hooks');
  });

  test('accepts valid values (round-trips yes/no/prompt)', () => {
    for (const v of ['yes', 'no', 'prompt']) {
      execSync(`${GSTACK_CONFIG} set plan_tune_hooks ${v}`, { encoding: 'utf-8', env });
      const got = execSync(`${GSTACK_CONFIG} get plan_tune_hooks`, { encoding: 'utf-8', env }).trim();
      expect(got).toBe(v);
    }
  });

  test('rejects out-of-domain values (warns + falls back to prompt)', () => {
    const res = execSync(`${GSTACK_CONFIG} set plan_tune_hooks maybe 2>&1`, { encoding: 'utf-8', env });
    expect(res.toLowerCase()).toContain('not recognized');
    const got = execSync(`${GSTACK_CONFIG} get plan_tune_hooks`, { encoding: 'utf-8', env }).trim();
    expect(got).toBe('prompt');
  });
});
