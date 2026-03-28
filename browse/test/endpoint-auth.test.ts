/**
 * Verifies that /refs, /activity/stream, and /activity/history require bearer auth
 * and no longer send Access-Control-Allow-Origin: * headers.
 *
 * Uses the same subprocess server pattern as sidebar-integration.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let serverPort: number = 0;
let authToken: string = '';
let tmpDir: string = '';
let stateFile: string = '';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-auth-'));
  stateFile = path.join(tmpDir, 'browse.json');

  const serverScript = path.resolve(__dirname, '..', 'src', 'server.ts');
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: '0',
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for state file with port + token
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (state.port && state.token) {
          serverPort = state.port;
          authToken = state.token;
          break;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!serverPort) throw new Error('Server did not start in time');
}, 20000);

afterAll(() => {
  if (serverProc) { try { serverProc.kill(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function url(pathname: string): string {
  return `http://127.0.0.1:${serverPort}${pathname}`;
}

// ─── /refs ────────────────────────────────────────────────────────

describe('/refs auth', () => {
  test('rejects request without auth token', async () => {
    const resp = await fetch(url('/refs'));
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe('Unauthorized');
  });

  test('rejects request with wrong token', async () => {
    const resp = await fetch(url('/refs'), {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(resp.status).toBe(401);
  });

  test('accepts request with valid bearer token', async () => {
    const resp = await fetch(url('/refs'), {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('refs');
  });

  test('accepts token as query parameter', async () => {
    const resp = await fetch(url(`/refs?token=${authToken}`));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('refs');
  });

  test('does not include Access-Control-Allow-Origin header', async () => {
    const resp = await fetch(url('/refs'), {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ─── /activity/stream ─────────────────────────────────────────────

describe('/activity/stream auth', () => {
  test('rejects request without auth token', async () => {
    const resp = await fetch(url('/activity/stream?after=0'));
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe('Unauthorized');
  });

  test('accepts request with valid bearer token', async () => {
    const controller = new AbortController();
    // SSE streams never complete — abort after checking headers
    setTimeout(() => controller.abort(), 500);
    try {
      const resp = await fetch(url('/activity/stream?after=0'), {
        headers: { 'Authorization': `Bearer ${authToken}` },
        signal: controller.signal,
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('text/event-stream');
      expect(resp.headers.get('access-control-allow-origin')).toBeNull();
    } catch (e: any) {
      // AbortError is expected if the abort fires before headers arrive
      if (e.name !== 'AbortError') throw e;
    }
  });

  test('accepts token as query parameter (EventSource compat)', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    try {
      const resp = await fetch(url(`/activity/stream?after=0&token=${authToken}`), {
        signal: controller.signal,
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('text/event-stream');
    } catch (e: any) {
      if (e.name !== 'AbortError') throw e;
    }
  });
});

// ─── /activity/history ────────────────────────────────────────────

describe('/activity/history auth', () => {
  test('rejects request without auth token', async () => {
    const resp = await fetch(url('/activity/history'));
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe('Unauthorized');
  });

  test('rejects request with wrong token', async () => {
    const resp = await fetch(url('/activity/history'), {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(resp.status).toBe(401);
  });

  test('accepts request with valid bearer token', async () => {
    const resp = await fetch(url('/activity/history'), {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('entries');
  });

  test('does not include Access-Control-Allow-Origin header', async () => {
    const resp = await fetch(url('/activity/history'), {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
  });
});
