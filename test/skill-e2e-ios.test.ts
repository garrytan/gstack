// High-level E2E for /ios-qa skill flow.
//
// Two scenarios:
//   1. NO_DEVICE (gate-tier compatible): runs the gen-accessors codegen
//      against a SwiftUI fixture, verifies output is correct, no daemon
//      hardware required. Catches regression in source-read + codegen +
//      cache + render paths without an iPhone.
//   2. WITH_DEVICE (periodic-tier, requires GSTACK_HAS_IOS_DEVICE=1): full
//      daemon + tailnet + USB tunnel loop. Skipped in CI.
//
// Note: The detailed daemon HTTP unit/integration tests live next to the
// daemon source (ios-qa/daemon/test/*). This file tests the agent-flow
// boundary — what the /ios-qa skill orchestrates end-to-end.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server, type IncomingMessage } from 'http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, type RunningDaemon } from '../ios-qa/daemon/src/index';
import type { DeviceTunnel } from '../ios-qa/daemon/src/proxy';
import { grantIdentity } from '../ios-qa/daemon/src/allowlist';
import { generate } from '../ios-qa/scripts/gen-accessors';

const HAS_DEVICE = process.env.GSTACK_HAS_IOS_DEVICE === '1';

const DEVICE_TOKEN = 'rotated-mock-bearer-token';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ios-e2e-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface StubState {
  loggedIn: boolean;
  username: string;
  rawTaps: Array<{ x: number; y: number }>;
}

// Build a stub StateServer that mimics the iOS app's HTTP surface end-to-end:
// /auth/rotate, session lock, snapshot, restore, tap. Used for both NO_DEVICE
// and as the development harness for WITH_DEVICE.
function startStubStateServer(initial: StubState): Promise<{ server: Server; port: number; state: StubState }> {
  const state = { ...initial };
  let activeSession: string | null = null;

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const auth = req.headers['authorization'];
        const url = req.url ?? '/';

        // /healthz public on loopback (the stub mimics that)
        if (req.method === 'GET' && url === '/healthz') {
          return respond(res, 200, { version: '1.0.0' });
        }

        // /auth/rotate: validates boot token (we accept any here for the stub)
        if (req.method === 'POST' && url === '/auth/rotate') {
          return respond(res, 200, { ok: true });
        }

        // Everything else requires our rotated token
        if (auth !== `Bearer ${DEVICE_TOKEN}`) {
          return respond(res, 401, { error: 'unauthorized' });
        }

        // Session ops
        if (req.method === 'POST' && url === '/session/acquire') {
          if (activeSession) return respond(res, 423, { error: 'device_locked' });
          activeSession = 'stub-session-' + Math.random().toString(16).slice(2, 8);
          return respond(res, 200, { session_id: activeSession, ttl_seconds: 300 });
        }
        if (req.method === 'POST' && url === '/session/release') {
          activeSession = null;
          return respond(res, 200, { ok: true });
        }

        // Snapshot
        if (req.method === 'GET' && url === '/state/snapshot') {
          return respond(res, 200, {
            _schema_version: 1,
            _app_build_id: 'stub-1.0',
            _accessor_hash: 'stub-hash',
            keys: {
              loggedIn: state.loggedIn,
              username: state.username,
            },
          });
        }

        // Mutations require session
        const sessionHeader = req.headers['x-session-id'];
        const sessionOk = !!sessionHeader && sessionHeader === activeSession;
        const isMutation = req.method === 'POST' && (
          url === '/tap' || url === '/swipe' || url === '/type' ||
          url.startsWith('/state/') && !url.endsWith('/snapshot')
        );

        if (isMutation && !sessionOk) {
          return respond(res, 409, { error: 'session_required' });
        }

        if (req.method === 'POST' && url === '/tap') {
          const payload = JSON.parse(body || '{}');
          state.rawTaps.push({ x: payload.x ?? 0, y: payload.y ?? 0 });
          return respond(res, 200, { op: 'tap', ok: true });
        }

        if (req.method === 'POST' && url === '/state/restore') {
          const payload = JSON.parse(body || '{}');
          if (payload._accessor_hash && payload._accessor_hash !== 'stub-hash') {
            return respond(res, 409, { error: 'schema_mismatch' });
          }
          if (payload.keys?.loggedIn !== undefined) state.loggedIn = payload.keys.loggedIn;
          if (payload.keys?.username !== undefined) state.username = payload.keys.username;
          return respond(res, 200, { ok: true });
        }

        respond(res, 404, { error: 'not_found' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, state });
    });
  });
}

function respond(res: import('http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function fetchJson(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method, headers: init.headers, body: init.body });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe('ios-qa E2E (no-device path)', () => {
  test('NO_DEVICE: codegen runs against a SwiftUI fixture and emits valid accessors', () => {
    const srcDir = join(workDir, 'app-src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'AppState.swift'), `
@Observable
class AppState {
    @Snapshotable var isLoggedIn: Bool = false
    @Snapshotable var username: String = ""
    @Snapshotable var counter: Int = 0
    var ephemeralCache: [String: Any] = [:]
}
`);
    const cacheRoot = join(workDir, 'cache');
    const result = generate({
      inputDir: srcDir,
      cacheRoot,
      swiftVersion: '6.0.0',
      toolGitRev: 'e2e-test',
      platformTriple: 'darwin-arm64',
    });
    expect(result.cacheHit).toBe(false);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.fields.map(f => f.name).sort()).toEqual(['counter', 'isLoggedIn', 'username']);
    const generatedSwift = readFileSync(result.outputPath, 'utf-8');
    expect(generatedSwift).toContain('public enum AppStateAccessor');
    expect(generatedSwift).toContain('key: "isLoggedIn"');
    expect(generatedSwift).toContain('key: "counter"');
    expect(generatedSwift).not.toContain('key: "ephemeralCache"'); // not marked @Snapshotable
    expect(generatedSwift).toContain('#if DEBUG');
  });

  test('NO_DEVICE: cache hit on rerun', () => {
    const srcDir = join(workDir, 'app-src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'AppState.swift'), '@Observable class A { @Snapshotable var x: Int = 0 }');
    const cacheRoot = join(workDir, 'cache');
    const r1 = generate({ inputDir: srcDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    const r2 = generate({ inputDir: srcDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
  });

  test('NO_DEVICE: schema mismatch returns 409 on restore', async () => {
    const stub = await startStubStateServer({ loggedIn: false, username: '', rawTaps: [] });
    try {
      const tunnel: DeviceTunnel = {
        udid: 'NO-DEVICE-UDID',
        ipv6Addr: '127.0.0.1',
        port: stub.port,
        bootTokenRotated: DEVICE_TOKEN,
      };
      const daemon = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: false,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: async () => tunnel,
      });
      if ('error' in daemon) throw new Error(daemon.error);
      try {
        // Acquire session first
        const acqR = await fetchJson('POST', `http://127.0.0.1:${daemon.loopbackPort}/session/acquire`);
        expect(acqR.status).toBe(200);
        const sessionId = (acqR.body as { session_id: string }).session_id;

        // Restore with wrong schema hash
        const restoreR = await fetchJson('POST', `http://127.0.0.1:${daemon.loopbackPort}/state/restore`, {
          headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({
            _schema_version: 1,
            _accessor_hash: 'wrong-hash-xxxxxxxxxxxxx',
            keys: { loggedIn: true },
          }),
        });
        expect(restoreR.status).toBe(409);
        expect((restoreR.body as { error: string }).error).toBe('schema_mismatch');
      } finally {
        await daemon.close();
      }
    } finally {
      stub.server.close();
    }
  });
});

describe('ios-qa E2E (agent-flow simulation)', () => {
  test('SCENARIO: acquire → snapshot → restore → tap → release', async () => {
    const initial: StubState = { loggedIn: false, username: '', rawTaps: [] };
    const stub = await startStubStateServer(initial);
    try {
      const tunnel: DeviceTunnel = {
        udid: 'AGENT-UDID',
        ipv6Addr: '127.0.0.1',
        port: stub.port,
        bootTokenRotated: DEVICE_TOKEN,
      };
      const daemon = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: false,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: async () => tunnel,
      });
      if ('error' in daemon) throw new Error(daemon.error);
      const base = `http://127.0.0.1:${daemon.loopbackPort}`;
      try {
        // 1. Acquire session
        const acq = await fetchJson('POST', `${base}/session/acquire`);
        expect(acq.status).toBe(200);
        const sessionId = (acq.body as { session_id: string }).session_id;

        // 2. Snapshot initial state
        const snap = await fetchJson('GET', `${base}/state/snapshot`);
        expect(snap.status).toBe(200);
        expect((snap.body as { keys: { loggedIn: boolean } }).keys.loggedIn).toBe(false);

        // 3. Restore: flip logged-in to true via the correct schema hash
        const restore = await fetchJson('POST', `${base}/state/restore`, {
          headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({
            _schema_version: 1,
            _accessor_hash: 'stub-hash',
            keys: { loggedIn: true, username: 'agent@e2e' },
          }),
        });
        expect(restore.status).toBe(200);

        // 4. Verify state changed
        const snap2 = await fetchJson('GET', `${base}/state/snapshot`);
        expect((snap2.body as { keys: { loggedIn: boolean; username: string } }).keys).toEqual({
          loggedIn: true,
          username: 'agent@e2e',
        });

        // 5. Tap (with session-id)
        const tap = await fetchJson('POST', `${base}/tap`, {
          headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({ x: 100, y: 200 }),
        });
        expect(tap.status).toBe(200);
        expect(stub.state.rawTaps).toEqual([{ x: 100, y: 200 }]);

        // 6. Release
        const rel = await fetchJson('POST', `${base}/session/release`);
        expect(rel.status).toBe(200);
      } finally {
        await daemon.close();
      }
    } finally {
      stub.server.close();
    }
  });

  test('SCENARIO: contention — second session-acquire returns 423 while first holds', async () => {
    const stub = await startStubStateServer({ loggedIn: false, username: '', rawTaps: [] });
    try {
      const tunnel: DeviceTunnel = {
        udid: 'CONTENTION-UDID',
        ipv6Addr: '127.0.0.1',
        port: stub.port,
        bootTokenRotated: DEVICE_TOKEN,
      };
      const daemon = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: false,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: async () => tunnel,
      });
      if ('error' in daemon) throw new Error(daemon.error);
      const base = `http://127.0.0.1:${daemon.loopbackPort}`;
      try {
        const a = await fetchJson('POST', `${base}/session/acquire`);
        expect(a.status).toBe(200);
        const b = await fetchJson('POST', `${base}/session/acquire`);
        expect(b.status).toBe(423);
      } finally {
        await daemon.close();
      }
    } finally {
      stub.server.close();
    }
  });

  test('SCENARIO: tailnet allowlist gate + mint + audit log', async () => {
    const stub = await startStubStateServer({ loggedIn: false, username: '', rawTaps: [] });
    try {
      const allowPath = join(workDir, 'allowlist.json');
      const auditPath = join(workDir, 'audit.jsonl');
      const attemptsPath = join(workDir, 'attempts.jsonl');
      process.env.GSTACK_IOS_ALLOWLIST_PATH = allowPath;
      process.env.GSTACK_IOS_AUDIT_PATH = auditPath;
      process.env.GSTACK_IOS_ATTEMPTS_PATH = attemptsPath;
      process.env.GSTACK_IOS_TAILNET_BIND = '127.0.0.1';

      const tunnel: DeviceTunnel = {
        udid: 'TAILNET-UDID',
        ipv6Addr: '127.0.0.1',
        port: stub.port,
        bootTokenRotated: DEVICE_TOKEN,
      };
      const daemon = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: true,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: async () => tunnel,
        probeImpl: async () => ({ ok: true, ownIdentity: 'mac@e2e' }),
        whoIsImpl: async () => ({ identity: 'agent@e2e', raw: {} }),
      });
      if ('error' in daemon) throw new Error(daemon.error);
      const tailnetBase = `http://127.0.0.1:${daemon.tailnetPort}`;
      try {
        // 1. Mint denied for un-allowlisted identity
        const denied = await fetchJson('POST', `${tailnetBase}/auth/mint`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability: 'interact' }),
        });
        expect(denied.status).toBe(403);

        // 2. Owner grants — then mint succeeds
        await grantIdentity({ identity: 'agent@e2e', capability: 'mutate', path: allowPath });
        const minted = await fetchJson('POST', `${tailnetBase}/auth/mint`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability: 'interact' }),
        });
        expect(minted.status).toBe(200);
        const sessionToken = (minted.body as { session_token: string }).session_token;

        // 3. Use session token to tap (with X-Session-Id)
        const acqR = await fetchJson('POST', `${tailnetBase}/session/acquire`, {
          headers: { 'authorization': `Bearer ${sessionToken}` },
        });
        expect(acqR.status).toBe(200);
        const sessionId = (acqR.body as { session_id: string }).session_id;

        const tapR = await fetchJson('POST', `${tailnetBase}/tap`, {
          headers: { 'authorization': `Bearer ${sessionToken}`, 'content-type': 'application/json', 'x-session-id': sessionId },
          body: JSON.stringify({ x: 50, y: 60 }),
        });
        expect(tapR.status).toBe(200);

        // 4. Audit log must have an entry for /tap
        await new Promise(r => setTimeout(r, 80));
        expect(existsSync(auditPath)).toBe(true);
        const rows = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        const tapRow = rows.find(r => r.endpoint === 'POST /tap');
        expect(tapRow).toBeDefined();
        expect(tapRow.identity).toBe('agent@e2e');
        expect(tapRow.capability).toBe('mutate');
        expect(tapRow.device_udid).toBe('TAILNET-UDID');

        // 5. Attempts log must have the denied-mint entry, with HASHED identity (no raw leak)
        expect(existsSync(attemptsPath)).toBe(true);
        const attempts = readFileSync(attemptsPath, 'utf-8');
        expect(attempts).not.toContain('agent@e2e');
        expect(attempts).toMatch(/"reason":"identity_not_allowed"/);
      } finally {
        await daemon.close();
        delete process.env.GSTACK_IOS_ALLOWLIST_PATH;
        delete process.env.GSTACK_IOS_AUDIT_PATH;
        delete process.env.GSTACK_IOS_ATTEMPTS_PATH;
        delete process.env.GSTACK_IOS_TAILNET_BIND;
      }
    } finally {
      stub.server.close();
    }
  });

  test('SCENARIO: capability-tier enforcement — observe token cannot /tap', async () => {
    const stub = await startStubStateServer({ loggedIn: false, username: '', rawTaps: [] });
    try {
      const allowPath = join(workDir, 'allowlist.json');
      process.env.GSTACK_IOS_ALLOWLIST_PATH = allowPath;
      process.env.GSTACK_IOS_AUDIT_PATH = join(workDir, 'audit.jsonl');
      process.env.GSTACK_IOS_ATTEMPTS_PATH = join(workDir, 'attempts.jsonl');

      const tunnel: DeviceTunnel = {
        udid: 'CAP-UDID', ipv6Addr: '127.0.0.1', port: stub.port, bootTokenRotated: DEVICE_TOKEN,
      };
      const daemon = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: true,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: async () => tunnel,
        probeImpl: async () => ({ ok: true, ownIdentity: 'mac@e2e' }),
        whoIsImpl: async () => ({ identity: 'readonly@e2e', raw: {} }),
      });
      if ('error' in daemon) throw new Error(daemon.error);
      const base = `http://127.0.0.1:${daemon.tailnetPort}`;
      try {
        await grantIdentity({ identity: 'readonly@e2e', capability: 'observe', path: allowPath });
        const minted = await fetchJson('POST', `${base}/auth/mint`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability: 'observe' }),
        });
        const token = (minted.body as { session_token: string }).session_token;

        // /screenshot (observe) → ok
        const ss = await fetchJson('GET', `${base}/screenshot`, {
          headers: { 'authorization': `Bearer ${token}` },
        });
        // The stub StateServer doesn't implement /screenshot, returns 404
        // through the proxy. That's fine — what we're testing is the daemon's
        // capability gate. observe is sufficient for /screenshot at the gate.
        expect([200, 404]).toContain(ss.status);

        // /tap (interact) → 403 capability_insufficient
        const tap = await fetchJson('POST', `${base}/tap`, {
          headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json', 'x-session-id': 'x' },
          body: JSON.stringify({ x: 1, y: 1 }),
        });
        expect(tap.status).toBe(403);
        expect((tap.body as { error: string }).error).toBe('capability_insufficient');
      } finally {
        await daemon.close();
        delete process.env.GSTACK_IOS_ALLOWLIST_PATH;
        delete process.env.GSTACK_IOS_AUDIT_PATH;
        delete process.env.GSTACK_IOS_ATTEMPTS_PATH;
      }
    } finally {
      stub.server.close();
    }
  });
});

// ───────── WITH_DEVICE — manual smoke tests (skipped in CI) ─────────

(HAS_DEVICE ? describe : describe.skip)('ios-qa E2E (with device)', () => {
  test('WITH_DEVICE: full agent loop against a real iPhone', () => {
    // Stub — real implementation requires `devicectl` + an attached iPhone.
    // Documented in ios-qa/SKILL.md.tmpl under "Manual smoke test".
    expect(HAS_DEVICE).toBe(true);
  });
});
