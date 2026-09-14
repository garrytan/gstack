/**
 * Pair-agent opt-in gate.
 *
 * The remote pair-agent (ngrok tunnel) is OFF by default. All three activation
 * points — CLI auto-start, the /tunnel/start route, and the BROWSE_TUNNEL=1
 * startup path — route through the single `isPairAgentEnabled()` guard. This
 * test pins the guard's behavior (the root cause) plus a source-level tripwire
 * that each call site actually consults it.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPairAgentEnabled } from '../src/config';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');

const savedEnv = { GSTACK_HOME: process.env.GSTACK_HOME, GSTACK_PAIR_AGENT: process.env.GSTACK_PAIR_AGENT };
const tmpHomes: string[] = [];

function tmpHomeWith(config: Record<string, string> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pair-'));
  tmpHomes.push(dir);
  if (config !== null) {
    // Canonical store: flat YAML lines, the shape bin/gstack-config writes.
    const yaml = Object.entries(config).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
  }
  process.env.GSTACK_HOME = dir;
  delete process.env.GSTACK_PAIR_AGENT;
  return dir;
}

afterEach(() => {
  for (const k of ['GSTACK_HOME', 'GSTACK_PAIR_AGENT'] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (tmpHomes.length) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

describe('isPairAgentEnabled — fail-closed default', () => {
  test('OFF when no config store exists', () => {
    tmpHomeWith(null);
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('OFF when config has no pair_agent key', () => {
    tmpHomeWith({ telemetry: 'off' });
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('ON via the config.json fallback shape too', () => {
    const dir = tmpHomeWith(null);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pair_agent: 'on' }));
    expect(isPairAgentEnabled()).toBe(true);
  });

  test('OFF when pair_agent is explicitly "off"', () => {
    tmpHomeWith({ pair_agent: 'off' });
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('ON only when pair_agent is exactly "on"', () => {
    tmpHomeWith({ pair_agent: 'on' });
    expect(isPairAgentEnabled()).toBe(true);
  });

  test('OFF when the store is malformed (fail-closed)', () => {
    const dir = tmpHomeWith(null);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'pair_agent: banana\n');
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('env override wins: GSTACK_PAIR_AGENT=on forces ON even with config off', () => {
    tmpHomeWith({ pair_agent: 'off' });
    process.env.GSTACK_PAIR_AGENT = 'on';
    expect(isPairAgentEnabled()).toBe(true);
  });

  test('env override wins: GSTACK_PAIR_AGENT=off forces OFF even with config on', () => {
    tmpHomeWith({ pair_agent: 'on' });
    process.env.GSTACK_PAIR_AGENT = 'off';
    expect(isPairAgentEnabled()).toBe(false);
  });
});

describe('gate wiring — every tunnel activation point consults the guard', () => {
  test('CLI auto-start is gated (never auto-starts when disabled)', () => {
    // pairEnabled short-circuits the ngrok probe so the tunnel can't auto-start.
    expect(CLI_SRC).toContain('const pairEnabled = isPairAgentEnabled();');
    expect(CLI_SRC).toContain('const ngrokAvailable = pairEnabled && isNgrokAvailable();');
  });

  test('CLI consent-off branch names the real remedy, never ngrok reinstall', () => {
    // When pair_agent is off but ngrok is installed+authed, telling the user
    // to `ngrok config add-authtoken` can never fix it — the gate is consent,
    // not tooling. The consent branch must carry the same remedy wording as
    // the /tunnel/start 403 body, and must not mention ngrok setup.
    const branchAt = CLI_SRC.indexOf('} else if (!pairEnabled) {');
    expect(branchAt).toBeGreaterThan(-1);
    const branchEnd = CLI_SRC.indexOf('} else {', branchAt);
    expect(branchEnd).toBeGreaterThan(branchAt);
    const branch = CLI_SRC.slice(branchAt, branchEnd);
    expect(branch).toContain('gstack-config set pair_agent on');
    expect(branch).toContain('/pair-agent');
    expect(branch).not.toContain('ngrok config add-authtoken');
    expect(branch).not.toContain('install ngrok');
  });

  test('/tunnel/start refuses with the enable hint when disabled', () => {
    const startIdx = SERVER_SRC.indexOf("url.pathname === '/tunnel/start'");
    const block = SERVER_SRC.slice(startIdx, startIdx + 1200);
    expect(block).toContain('if (!isPairAgentEnabled())');
    expect(block).toContain('gstack-config set pair_agent on');
  });

  test('BROWSE_TUNNEL=1 startup skips tunnel bind when disabled', () => {
    expect(SERVER_SRC).toContain("process.env.BROWSE_TUNNEL === '1' && !isPairAgentEnabled()");
  });
});

describe('pair-agent headed switch — #2219 iron-rule consent gate', () => {
  // The behavioral leg (live daemon + no flag → notice, no kill) lives in
  // busy-daemon-iron-rule.test.ts. These source pins cover the wiring the
  // integration test can't exercise cheaply: the explicit-flag path and the
  // capture-before-ensureServer ordering.

  test('headed relaunch of a pre-existing live daemon is gated on explicit --force-restart', () => {
    const gateAt = CLI_SRC.indexOf('if (pairAgentPreexistingDaemonAlive && !globalFlags.forceRestart) {');
    expect(gateAt).toBeGreaterThan(-1);
    // Refusal branch: notice printed, connect never spawned.
    const elseAt = CLI_SRC.indexOf('} else {', gateAt);
    expect(elseAt).toBeGreaterThan(gateAt);
    const refusalBranch = CLI_SRC.slice(gateAt, elseAt);
    expect(refusalBranch).toContain('continuing against it');
    expect(refusalBranch).toContain('--force-restart to relaunch headed');
    expect(refusalBranch).not.toContain('Bun.spawn');
    // Consented branch (no pre-existing daemon OR explicit flag): the spawn
    // of `connect --force-restart` lives here and ONLY here.
    const branchEnd = CLI_SRC.indexOf('await handlePairAgent(state, commandArgs);', gateAt);
    expect(branchEnd).toBeGreaterThan(elseAt);
    const consentedBranch = CLI_SRC.slice(elseAt, branchEnd);
    expect(consentedBranch).toContain("Bun.spawn([browseBin, 'connect', '--force-restart']");
    // No second spawn site outside the gated block.
    expect(CLI_SRC.indexOf("'connect', '--force-restart'")).toBe(CLI_SRC.lastIndexOf("'connect', '--force-restart'"));
  });

  test('pre-existing liveness is captured BEFORE ensureServer can boot a fresh daemon', () => {
    // If the capture ran after ensureServer, a freshly-booted daemon would be
    // indistinguishable from a session the user cares about — the gate would
    // then refuse the headed switch even on a clean machine.
    const captureAt = CLI_SRC.indexOf('pairAgentPreexistingDaemonAlive = Boolean(preState?.pid && isProcessAlive(preState.pid));');
    const ensureAt = CLI_SRC.indexOf('let state = await ensureServer(globalFlags);');
    expect(captureAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeGreaterThan(captureAt);
  });
});
