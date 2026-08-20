/**
 * #2314: the terminal-agent must allocate its port from the SAME fixed
 * 10000-49151 scan range the main server uses (port-allocator.ts,
 * decision 8) — never `port: 0`. Binding 0 drew from the OS ephemeral range
 * (49152-65535 on macOS), where the weeks-lived agent squatted ports that
 * short-lived `app.listen(0)` test servers expected to receive, absorbing
 * their traffic as phantom 404s across every Node test suite on the machine.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  findAvailablePort,
  RANDOM_PORT_MIN,
  RANDOM_PORT_MAX,
} from '../src/port-allocator';

const AGENT_TS = path.resolve(import.meta.dir, '..', 'src', 'terminal-agent.ts');
const SERVER_TS = path.resolve(import.meta.dir, '..', 'src', 'server.ts');

describe('shared port allocator (#2314)', () => {
  test('allocates inside the fixed scan range, never the ephemeral range', async () => {
    for (let i = 0; i < 5; i++) {
      const port = await findAvailablePort();
      expect(port).toBeGreaterThanOrEqual(RANDOM_PORT_MIN);
      expect(port).toBeLessThan(RANDOM_PORT_MAX);
      // The load-bearing property: the WHOLE range sits below the ephemeral
      // floor (49152). The original 60000 cap left ~22% of picks inside the
      // pool this allocator exists to avoid.
      expect(RANDOM_PORT_MAX).toBeLessThan(49152);
      expect(RANDOM_PORT_MIN).toBeGreaterThanOrEqual(1024);
    }
  });

  test('explicit free port is honored', async () => {
    // Find a free port by binding 0, then ask the allocator for exactly it.
    const free = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    expect(await findAvailablePort(free)).toBe(free);
  });

  test('explicit occupied port throws an actionable error', async () => {
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    const occupied = (srv.address() as net.AddressInfo).port;
    try {
      await expect(findAvailablePort(occupied)).rejects.toThrow(/in use/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('terminal-agent uses the shared allocator (static tripwire)', () => {
  test('terminal-agent.ts never binds port: 0', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // Strip comments so the explanatory history above the bind doesn't trip.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/port:\s*0\b/);
    expect(src).toContain("from './port-allocator'");
    expect(src).toContain('findAvailablePort');
  });

  test('server.ts routes findPort through the same allocator', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toContain("from './port-allocator'");
    expect(src).toMatch(/findAvailablePort\(BROWSE_PORT\)/);
  });
});
