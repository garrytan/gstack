// Loopback listener request checks: only a loopback Host for the bound
// port is served, and a request carrying a cross-origin Origin is refused
// before anything reaches the device.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, type RunningDaemon } from '../src/index';

let workDir: string;
let device: Server;
let daemon: RunningDaemon;
const deviceRequests: string[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ios-qa-loopback-request-'));
  device = createServer((req, res) => {
    deviceRequests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => device.listen(0, '127.0.0.1', () => resolve()));
  const devicePort = (device.address() as { port: number }).port;
  const d = await startDaemon({
    loopbackPort: 0,
    tailnetEnabled: false,
    pidfilePath: join(workDir, 'daemon.pid'),
    tunnelProvider: async () => ({ udid: 'STUB-UDID', ipv6Addr: '127.0.0.1', port: devicePort, bootTokenRotated: 'stub-device-token' }),
  });
  if ('error' in d) throw new Error(d.error);
  daemon = d;
});

afterAll(async () => {
  await daemon?.close();
  device.close();
  rmSync(workDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${daemon.loopbackPort}`;

test('a non-loopback Host is refused before the device is contacted', async () => {
  deviceRequests.length = 0;
  for (const host of [`device.example:${daemon.loopbackPort}`, 'device.example', `127.0.0.1:${daemon.loopbackPort + 1}`, `127.0.0.2:${daemon.loopbackPort}`]) {
    for (const [method, route] of [['GET', '/healthz'], ['GET', '/screenshot'], ['POST', '/type'], ['GET', '/auth/sessions']]) {
      const res = await fetch(base() + route, {
        method,
        headers: { Host: host, 'content-type': 'text/plain' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect({ host, route, status: res.status }).toEqual({ host, route, status: 403 });
    }
  }
  expect(deviceRequests).toEqual([]);
});

test('a cross-origin Origin is refused before the device is contacted', async () => {
  deviceRequests.length = 0;
  for (const origin of ['http://device.example', 'null', `http://localhost:${daemon.loopbackPort + 1}`, `https://127.0.0.1:${daemon.loopbackPort}`]) {
    const res = await fetch(base() + '/session/acquire', {
      method: 'POST',
      headers: { Origin: origin, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
  }
  expect(deviceRequests).toEqual([]);
});

test('local clients naming the loopback address still reach the device', async () => {
  deviceRequests.length = 0;
  for (const host of [`127.0.0.1:${daemon.loopbackPort}`, `localhost:${daemon.loopbackPort}`, `[::1]:${daemon.loopbackPort}`]) {
    const res = await fetch(base() + '/screenshot', { headers: { Host: host } });
    expect({ host, status: res.status }).toEqual({ host, status: 200 });
  }
  const sameOrigin = await fetch(base() + '/healthz', { headers: { Origin: base() } });
  expect(sameOrigin.status).toBe(200);
  expect(deviceRequests).toEqual(['GET /screenshot', 'GET /screenshot', 'GET /screenshot']);
});

test('a cross-site or same-site browser request without an Origin is refused before the device is contacted', async () => {
  deviceRequests.length = 0;
  for (const site of ['cross-site', 'same-site']) {
    for (const route of ['/screenshot', '/healthz']) {
      const res = await fetch(base() + route, { headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' } });
      expect({ site, route, status: res.status }).toEqual({ site, route, status: 403 });
    }
  }
  expect(deviceRequests).toEqual([]);
});
