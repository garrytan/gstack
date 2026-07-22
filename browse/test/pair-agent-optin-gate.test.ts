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

function tmpHomeWith(config: unknown | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pair-'));
  tmpHomes.push(dir);
  if (config !== null) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
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
  test('OFF when config.json is missing', () => {
    tmpHomeWith(null);
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('OFF when config has no pair_agent key', () => {
    tmpHomeWith({ telemetry: 'off' });
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('OFF when pair_agent is explicitly "off"', () => {
    tmpHomeWith({ pair_agent: 'off' });
    expect(isPairAgentEnabled()).toBe(false);
  });

  test('ON only when pair_agent is exactly "on"', () => {
    tmpHomeWith({ pair_agent: 'on' });
    expect(isPairAgentEnabled()).toBe(true);
  });

  test('OFF when config.json is malformed (fail-closed)', () => {
    const dir = tmpHomeWith(null);
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
