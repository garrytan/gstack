import { describe, expect, test, spyOn, mock } from 'bun:test';
import { EventEmitter } from 'events';
import * as http from 'http';
import type { ClientRequest, IncomingMessage } from 'http';
import { createServer, type Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { proxyToDevice, type DeviceTunnel } from '../src/proxy';
import { startDaemon, type RunningDaemon } from '../src/index';

const ATTEMPT_MS = 100;
const SCHEDULING_TOLERANCE_MS = 1_000;

async function within<T>(promise: Promise<T>, ms = SCHEDULING_TOLERANCE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function startUpstream(handle: (socket: Socket, request: string) => void) {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let received = '';
    const onData = (chunk: Buffer) => {
      received += chunk.toString();
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(received.slice(0, headerEnd).match(/^content-length: (\d+)/im)?.[1] ?? 0);
      if (Buffer.byteLength(received.slice(headerEnd + 4)) < length) return;
      socket.off('data', onData);
      requests.push(received);
      handle(socket, received);
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    sockets,
    async idle() {
      await within(Promise.all([...sockets].map(socket => new Promise<void>(resolve => socket.once('close', resolve)))));
      expect(sockets.size).toBe(0);
    },
    async close() {
      const closed = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', resolve)));
      for (const socket of sockets) socket.destroy();
      await within(Promise.all([
        ...closed,
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      ]));
      expect(server.listening).toBe(false);
      expect(sockets.size).toBe(0);
    },
  };
}

function reply(socket: Socket, status = '200 OK', body = '{"ok":true}') {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function partial(socket: Socket) {
  socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n');
}

function tunnel(port: number): DeviceTunnel {
  return { udid: 'fixture', ipv6Addr: '127.0.0.1', port, bootTokenRotated: 'fixture-rotated' };
}

function attempt(port: number, timeoutMs: number | undefined = ATTEMPT_MS, overrides: Partial<Parameters<typeof proxyToDevice>[0]> = {}) {
  return proxyToDevice({
    inbound: { method: 'GET', url: '/screenshot', headers: {} } as IncomingMessage,
    body: Buffer.alloc(0),
    tunnel: tunnel(port),
    sessionId: null,
    timeoutMs,
    ...overrides,
  });
}

describe('proxy transport deadline', () => {
  for (const mode of ['silent', 'stalled', 'dribbling'] as const) {
    test(`${mode} upstream settles at the wall-clock deadline and closes its socket`, async () => {
      let chunks = 0;
      const upstream = await startUpstream((socket) => {
        if (mode === 'silent') return;
        partial(socket);
        if (mode === 'stalled') return;
        const timer = setInterval(() => { chunks++; socket.write('1\r\n \r\n'); }, 10);
        socket.once('close', () => clearInterval(timer));
      });
      try {
        const started = performance.now();
        const result = await within(attempt(upstream.port));
        const elapsed = performance.now() - started;
        expect(result.status).toBe(504);
        expect(JSON.parse(result.body.toString())).toEqual({ error: 'upstream_timeout' });
        expect(elapsed).toBeGreaterThanOrEqual(ATTEMPT_MS - 10);
        expect(elapsed).toBeLessThan(ATTEMPT_MS + SCHEDULING_TOLERANCE_MS);
        if (mode === 'dribbling') expect(chunks).toBeGreaterThan(1);
        await upstream.idle();
      } finally {
        await upstream.close();
      }
    });
  }

  test('success returns the complete body and preserves forwarding headers', async () => {
    const upstream = await startUpstream(socket => reply(socket, '201 Created', '{"complete":true}'));
    try {
      const result = await within(attempt(upstream.port, ATTEMPT_MS, {
        inbound: { method: 'POST', url: '/tap', headers: { 'content-type': 'application/custom' } } as IncomingMessage,
        body: Buffer.from('{"x":1}'),
        sessionId: 'fixture-session',
        agentIdentity: 'fixture-agent',
      }));
      expect(result.status).toBe(201);
      expect(result.body.toString()).toBe('{"complete":true}');
      expect(result.headers['content-type']).toBe('application/json');
      expect(upstream.requests).toHaveLength(1);
      const request = upstream.requests[0].toLowerCase();
      expect(request).toContain('post /tap http/1.1');
      expect(request).toContain('authorization: bearer fixture-rotated');
      expect(request).toContain('content-type: application/custom');
      expect(request).toContain('x-session-id: fixture-session');
      expect(request).toContain('x-agent-identity: fixture-agent');
      expect(request).toEndWith('{"x":1}');
      await upstream.idle();
    } finally {
      await upstream.close();
    }
  });

  test('a response completed before the deadline survives a later deadline window', async () => {
    const upstream = await startUpstream((socket) => {
      partial(socket);
      const timer = setTimeout(() => socket.end('1\r\n}\r\n0\r\n\r\n'), ATTEMPT_MS / 2);
      socket.once('close', () => clearTimeout(timer));
    });
    try {
      const result = await within(attempt(upstream.port));
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe('{}');
      await new Promise(resolve => setTimeout(resolve, ATTEMPT_MS));
      expect(result.status).toBe(200);
      await upstream.idle();
    } finally {
      await upstream.close();
    }
  });

  for (const mode of ['before headers', 'during body'] as const) {
    test(`disconnect ${mode} rejects with a recoverable socket error`, async () => {
      const upstream = await startUpstream((socket) => {
        if (mode === 'during body') partial(socket);
        socket.end();
      });
      try {
        await expect(within(attempt(upstream.port))).rejects.toMatchObject({ code: 'ECONNRESET' });
        await upstream.idle();
      } finally {
        await upstream.close();
      }
    });
  }

  test('connection refusal retains the device_disconnected response', async () => {
    const upstream = await startUpstream(socket => reply(socket));
    await upstream.close();
    const result = await within(attempt(upstream.port));
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body.toString())).toEqual({ error: 'device_disconnected' });
  });

  test('oversized ingress is refused before connecting', async () => {
    const upstream = await startUpstream(socket => reply(socket));
    try {
      const result = await attempt(upstream.port, ATTEMPT_MS, { body: Buffer.alloc(1_048_577) });
      expect(result.status).toBe(413);
      expect(upstream.requests).toHaveLength(0);
      expect(upstream.sockets.size).toBe(0);
    } finally {
      await upstream.close();
    }
  });

  test('default 30-second deadline bounds silent, stalled and trickling responses', async () => {
    const upstream = await startUpstream((socket, request) => {
      if (request.startsWith('GET /silent ')) return;
      partial(socket);
      if (request.startsWith('GET /stalled ')) return;
      const timer = setInterval(() => socket.write('1\r\n \r\n'), 50);
      socket.once('close', () => clearInterval(timer));
    });
    try {
      await Promise.all(['silent', 'stalled', 'dribbling'].map(async mode => {
        const started = performance.now();
        const result = await within(attempt(upstream.port, undefined, {
          inbound: { method: 'GET', url: `/${mode}`, headers: {} } as IncomingMessage,
          timeoutMs: undefined,
        }), 30_000 + SCHEDULING_TOLERANCE_MS);
        expect(result.status).toBe(504);
        expect(JSON.parse(result.body.toString())).toEqual({ error: 'upstream_timeout' });
        expect(performance.now() - started).toBeGreaterThanOrEqual(29_900);
        expect(performance.now() - started).toBeLessThan(30_000 + SCHEDULING_TOLERANCE_MS);
      }));
      expect(upstream.requests).toHaveLength(3);
      await upstream.idle();
    } finally {
      await upstream.close();
    }
  }, 35_000);
});

describe('proxy terminal event ordering', () => {
  for (const first of ['end', 'deadline', 'request-error', 'response-error', 'aborted', 'response-close', 'request-close', 'late-response'] as const) {
    test(`${first} settles once and removes timers and terminal listeners on close`, async () => {
      const request = Object.assign(new EventEmitter(), { write: mock(), end: mock(), destroy: mock() });
      const response = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200, destroy: mock() });
      const error = Object.assign(new Error('fixture transport failure'), { code: 'EPIPE' });
      let onResponse!: (res: IncomingMessage) => void;
      let deadline!: () => void;
      const nativeSetTimeout = globalThis.setTimeout;
      const requestSpy = spyOn(http, 'request').mockImplementation((url, options, callback) => {
        onResponse = callback!;
        return request as unknown as ClientRequest;
      });
      const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
        deadline = callback as () => void;
        return nativeSetTimeout(callback, ms, ...args);
      });
      const clearSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const pending = attempt(1).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        await Promise.resolve();
        expect(timerSpy).toHaveBeenCalledTimes(1);
        expect(timerSpy.mock.calls[0][1]).toBe(ATTEMPT_MS);
        if (first !== 'request-close' && first !== 'late-response') {
          onResponse(response as unknown as IncomingMessage);
          response.emit('data', Buffer.from('{}'));
        }
        if (first === 'end') response.emit('end');
        else if (first === 'deadline' || first === 'late-response') deadline();
        else if (first === 'request-error') request.emit('error', error);
        else if (first === 'response-error') response.emit('error', error);
        else if (first === 'aborted') response.emit('aborted');
        else if (first === 'response-close') response.emit('close');
        else request.emit('close');

        if (first === 'late-response') onResponse(response as unknown as IncomingMessage);
        if (first !== 'request-close') expect(() => request.emit('error', error)).not.toThrow();
        if (first !== 'request-close' && first !== 'response-close') expect(() => response.emit('error', error)).not.toThrow();
        response.emit('end');
        deadline();
        const result = await pending;
        if (first === 'end') {
          expect(result.value?.body.toString()).toBe('{}');
          expect(result.value?.status).toBe(200);
        } else if (first === 'deadline' || first === 'late-response') {
          expect(result.value?.status).toBe(504);
        } else if (first === 'request-error' || first === 'response-error') {
          expect(result.error).toBe(error);
        } else {
          expect(result.error).toMatchObject({ code: 'ECONNRESET' });
        }
        expect(request.destroy).toHaveBeenCalledTimes(first === 'end' ? 0 : 1);
        expect(response.destroy).toHaveBeenCalledTimes(first === 'late-response' ? 1 : 0);
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(response.listenerCount('data')).toBe(0);
        expect(response.listenerCount('end')).toBe(0);
        expect(response.listenerCount('aborted')).toBe(0);
        request.emit('close');
        response.emit('close');
        expect(request.listenerCount('error')).toBe(0);
        expect(request.listenerCount('close')).toBe(0);
        expect(response.listenerCount('error')).toBe(0);
        expect(response.listenerCount('close')).toBe(0);
      } finally {
        request.emit('close');
        response.emit('close');
        requestSpy.mockRestore();
        timerSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });
  }
});

describe('daemon transport recovery', () => {
  for (const listener of ['loopback', 'tailnet'] as const) {
    for (const failure of ['timeout', 'abort', 'unauthorized'] as const) {
      for (const method of ['GET', 'POST'] as const) {
        test(`${listener} ${method} after ${failure} preserves refresh and replay policy`, async () => {
          const root = mkdtempSync(join(tmpdir(), 'ios-proxy-recovery-'));
          const failing = await startUpstream((socket) => {
            if (failure === 'unauthorized') reply(socket, '401 Unauthorized', '{"error":"unauthorized"}');
            else {
              partial(socket);
              if (failure === 'abort') socket.end();
            }
          });
          const healthy = await startUpstream(socket => reply(socket));
          let daemon: RunningDaemon | undefined;
          let bootstraps = 0;
          try {
            const started = await startDaemon({
              loopbackPort: 0,
              tailnetEnabled: listener === 'tailnet',
              pidfilePath: join(root, 'daemon.pid'),
              auditPath: join(root, 'audit.jsonl'),
              attemptsPath: join(root, 'attempts.jsonl'),
              allowlistPath: join(root, 'allowlist.json'),
              probeImpl: async () => ({ ok: true }),
              proxyTimeoutMs: ATTEMPT_MS,
              tunnelProvider: async () => tunnel(++bootstraps === 1 ? failing.port : healthy.port),
            });
            if ('error' in started) throw new Error(started.error);
            daemon = started;
            const minted = daemon.tokenStore.mint({ identity: 'fixture-agent', capability: 'interact', origin: 'owner_granted' });
            if ('error' in minted) throw new Error(minted.error);
            const port = listener === 'loopback' ? daemon.loopbackPort : daemon.tailnetPort;
            const url = `http://127.0.0.1:${port}/${method === 'GET' ? 'screenshot' : 'tap'}`;
            const request = () => fetch(url, {
              method,
              headers: { authorization: `Bearer ${minted.token}`, 'x-session-id': 'fixture-session', connection: 'close' },
              body: method === 'POST' ? '{"x":1}' : undefined,
              signal: AbortSignal.timeout(SCHEDULING_TOLERANCE_MS),
            });
            const result = await request();
            const replaySafe = method === 'GET' || failure === 'unauthorized';
            expect(result.status).toBe(replaySafe ? 200 : failure === 'timeout' ? 504 : 503);
            expect(await result.json()).toEqual(replaySafe ? { ok: true } : { error: failure === 'timeout' ? 'upstream_timeout' : 'device_disconnected' });
            expect(bootstraps).toBe(2);
            expect(failing.requests).toHaveLength(1);
            expect(healthy.requests).toHaveLength(replaySafe ? 1 : 0);
            if (method === 'POST') expect(failing.requests[0]).toEndWith('{"x":1}');
            const explicitNextRequest = await request();
            expect(explicitNextRequest.status).toBe(200);
            expect(await explicitNextRequest.json()).toEqual({ ok: true });
            expect(healthy.requests).toHaveLength(replaySafe ? 2 : 1);
            expect(bootstraps).toBe(2);
            await failing.idle();
            await healthy.idle();
          } finally {
            await within(daemon?.close() ?? Promise.resolve());
            await failing.close();
            await healthy.close();
            rmSync(root, { recursive: true, force: true });
          }
        });
      }
    }
  }

  for (const method of ['HEAD', 'OPTIONS']) {
    test(`${method} remains replayable after a timed-out attempt`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'ios-proxy-readonly-'));
      const failing = await startUpstream(() => {});
      const healthy = await startUpstream(socket => reply(socket, '200 OK', method === 'HEAD' ? '' : '{"ok":true}'));
      let daemon: RunningDaemon | undefined;
      let bootstraps = 0;
      try {
        const started = await startDaemon({
          loopbackPort: 0,
          tailnetEnabled: false,
          pidfilePath: join(root, 'daemon.pid'),
          proxyTimeoutMs: ATTEMPT_MS,
          tunnelProvider: async () => tunnel(++bootstraps === 1 ? failing.port : healthy.port),
        });
        if ('error' in started) throw new Error(started.error);
        daemon = started;
        const result = await fetch(`http://127.0.0.1:${daemon.loopbackPort}/screenshot`, {
          method,
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(SCHEDULING_TOLERANCE_MS),
        });
        expect(result.status).toBe(200);
        await result.text();
        expect(bootstraps).toBe(2);
        expect(failing.requests).toHaveLength(1);
        expect(healthy.requests).toHaveLength(1);
        await failing.idle();
        await healthy.idle();
      } finally {
        await within(daemon?.close() ?? Promise.resolve());
        await failing.close();
        await healthy.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const method of ['GET', 'POST']) {
    test(`${method} preserves the failure when rebootstrap finds no device`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'ios-proxy-no-device-'));
      const failing = await startUpstream(socket => partial(socket));
      let daemon: RunningDaemon | undefined;
      let bootstraps = 0;
      try {
        const started = await startDaemon({
          loopbackPort: 0,
          tailnetEnabled: false,
          pidfilePath: join(root, 'daemon.pid'),
          proxyTimeoutMs: ATTEMPT_MS,
          tunnelProvider: async () => ++bootstraps === 1 ? tunnel(failing.port) : null,
        });
        if ('error' in started) throw new Error(started.error);
        daemon = started;
        const result = await fetch(`http://127.0.0.1:${daemon.loopbackPort}/${method === 'GET' ? 'screenshot' : 'tap'}`, {
          method,
          body: method === 'POST' ? '{}' : undefined,
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(SCHEDULING_TOLERANCE_MS),
        });
        expect(result.status).toBe(method === 'GET' ? 503 : 504);
        expect(await result.json()).toEqual({ error: method === 'GET' ? 'device_not_connected' : 'upstream_timeout' });
        expect(bootstraps).toBe(2);
        expect(failing.requests).toHaveLength(1);
        await failing.idle();
      } finally {
        await within(daemon?.close() ?? Promise.resolve());
        await failing.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('a timed-out replacement gets only one retry and is not cached for the next request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-proxy-retry-'));
    const failing = await startUpstream(socket => partial(socket));
    const healthy = await startUpstream(socket => reply(socket));
    let daemon: RunningDaemon | undefined;
    let bootstraps = 0;
    try {
      const started = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: false,
        pidfilePath: join(root, 'daemon.pid'),
        proxyTimeoutMs: ATTEMPT_MS,
        tunnelProvider: async () => tunnel(++bootstraps <= 2 ? failing.port : healthy.port),
      });
      if ('error' in started) throw new Error(started.error);
      daemon = started;
      const url = `http://127.0.0.1:${daemon.loopbackPort}/screenshot`;
      const first = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(SCHEDULING_TOLERANCE_MS) });
      expect(first.status).toBe(504);
      expect(await first.json()).toEqual({ error: 'upstream_timeout' });
      expect(bootstraps).toBe(2);
      expect(failing.requests).toHaveLength(2);
      await failing.idle();
      const next = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(SCHEDULING_TOLERANCE_MS) });
      expect(next.status).toBe(200);
      expect(await next.json()).toEqual({ ok: true });
      expect(bootstraps).toBe(3);
      expect(healthy.requests).toHaveLength(1);
      await healthy.idle();
    } finally {
      await within(daemon?.close() ?? Promise.resolve());
      await failing.close();
      await healthy.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
