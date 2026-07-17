/**
 * HTTP regression for the terminal-first sidepanel architecture.
 *
 * The legacy one-shot sidebar-agent/chat queue was removed in v1.44. These
 * routes must stay unavailable: silently reviving one would recreate a second
 * agent lifecycle and its retired prompt/security surface. Current terminal,
 * activity, and browser routes have their own focused integration suites.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let serverPort = 0;
let authToken = '';
let tmpDir = '';
let stateFile = '';
let retiredQueueFile = '';

async function api(pathname: string, opts: RequestInit & { noAuth?: boolean } = {}): Promise<Response> {
  const { noAuth, ...fetchOpts } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOpts.headers as Record<string, string> || {}),
  };
  if (!noAuth && !headers.Authorization && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...fetchOpts, headers });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-retired-routes-'));
  stateFile = path.join(tmpDir, 'browse.json');
  retiredQueueFile = path.join(tmpDir, 'sidebar-queue.jsonl');

  const serverScript = path.resolve(import.meta.dir, '..', 'src', 'server.ts');
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: '0',
      SIDEBAR_QUEUE_PATH: retiredQueueFile,
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.port && state.token) {
          serverPort = state.port;
          authToken = state.token;
          break;
        }
      } catch {}
    }
    await Bun.sleep(100);
  }
  if (!serverPort) throw new Error('Server did not start in time');
}, 20_000);

afterAll(() => {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const RETIRED_ROUTES: Array<[string, string]> = [
  ['POST', '/sidebar-command'],
  ['POST', '/sidebar-agent/event'],
  ['POST', '/sidebar-agent/kill'],
  ['GET', '/sidebar-session'],
  ['POST', '/sidebar-session/new'],
  ['GET', '/sidebar-chat?after=0'],
  ['POST', '/sidebar-chat/clear'],
];

describe('retired sidebar-agent HTTP surface', () => {
  test('still applies authentication before disclosing route availability', async () => {
    const response = await api('/sidebar-command', {
      method: 'POST',
      noAuth: true,
      body: JSON.stringify({ message: 'test' }),
    });
    expect(response.status).toBe(401);
  });

  test('every retired route is absent for an authenticated caller', async () => {
    for (const [method, route] of RETIRED_ROUTES) {
      const response = await api(route, {
        method,
        body: method === 'GET' ? undefined : JSON.stringify({ message: 'test', type: 'text' }),
      });
      expect(response.status).toBe(404);
    }
  });

  test('probing retired routes never creates the old queue file', async () => {
    expect(fs.existsSync(retiredQueueFile)).toBe(false);
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'must not queue' }),
    });
    expect(fs.existsSync(retiredQueueFile)).toBe(false);
  });

  test('the current authenticated health surface remains available', async () => {
    const response = await api('/health');
    expect(response.status).toBe(200);
    const payload = await response.json() as { status?: string };
    expect(['healthy', 'unhealthy']).toContain(payload.status);
  });
});
