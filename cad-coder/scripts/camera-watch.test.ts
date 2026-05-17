import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';

import {
  createWatcher,
  formatEvent,
  parseArgs,
  readFsState,
  type CameraWatchOptions,
  type WatcherOutput,
} from './camera-watch';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'camera-watch-'));
}

function defaults(overrides: Partial<CameraWatchOptions> = {}): CameraWatchOptions {
  return {
    session: 'TEST',
    dir: tempDir(),
    serverUrl: null,
    intervalMs: 100,
    timeoutS: 0,
    json: false,
    once: false,
    sinceMtime: 0,
    longPollSeconds: 5,
    ...overrides,
  };
}

function writeJpegAt(dir: string, session: string, body: string, mtime?: number): string {
  const path = join(dir, `${session}.jpg`);
  writeFileSync(path, body);
  if (mtime !== undefined) {
    utimesSync(path, mtime, mtime);
  }
  return path;
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('no free port')));
        return;
      }
      const port = addr.port;
      server.close(() => resolvePromise(port));
    });
  });
}

describe('parseArgs', () => {
  test('defaults round-trip session', () => {
    const opts = parseArgs(['--session', 'abc123']);
    expect(opts.session).toBe('ABC123');
    expect(opts.timeoutS).toBe(0);
    expect(opts.once).toBe(false);
  });

  test('--no-http disables HTTP mode', () => {
    const opts = parseArgs(['--no-http']);
    expect(opts.serverUrl).toBeNull();
  });

  test('rejects invalid session codes', () => {
    expect(() => parseArgs(['--session', 'bad code!'])).toThrow();
    expect(() => parseArgs(['--session', ''])).toThrow();
    expect(() => parseArgs(['--session', 'A'.repeat(17)])).toThrow();
  });

  test('rejects insane intervals and timeouts', () => {
    expect(() => parseArgs(['--interval-ms', '10'])).toThrow();
    expect(() => parseArgs(['--timeout-s', '-1'])).toThrow();
    expect(() => parseArgs(['--long-poll-s', '0'])).toThrow();
    expect(() => parseArgs(['--long-poll-s', '601'])).toThrow();
  });
});

describe('formatEvent', () => {
  test('text format for image_received', () => {
    const evt: WatcherOutput = {
      event: 'image_received',
      session: 'TEST',
      path: '/tmp/cad-reference/TEST.jpg',
      size: 1234,
      receivedAt: '2026-05-16T12:00:00.000Z',
      receivedAtUnix: 1779278400,
    };
    expect(formatEvent(evt, false)).toBe(
      'IMAGE_RECEIVED session=TEST path=/tmp/cad-reference/TEST.jpg size=1234 received_at=2026-05-16T12:00:00.000Z',
    );
  });

  test('json format is parseable', () => {
    const evt: WatcherOutput = {
      event: 'image_received',
      session: 'TEST',
      path: '/x.jpg',
      size: 1,
      receivedAt: '2026-05-16T12:00:00.000Z',
      receivedAtUnix: 1779278400,
    };
    const parsed = JSON.parse(formatEvent(evt, true));
    expect(parsed.event).toBe('image_received');
    expect(parsed.session).toBe('TEST');
  });

  test('timeout formatting', () => {
    const evt: WatcherOutput = { event: 'timeout', session: 'TEST', waitedSeconds: 5.3 };
    expect(formatEvent(evt, false)).toBe('IMAGE_TIMEOUT session=TEST waited_s=5.3');
    expect(JSON.parse(formatEvent(evt, true)).event).toBe('timeout');
  });
});

describe('readFsState', () => {
  test('returns null when no image present', () => {
    const dir = tempDir();
    expect(readFsState(dir, 'TEST')).toBeNull();
  });

  test('reads size + mtime for an existing image', () => {
    const dir = tempDir();
    writeJpegAt(dir, 'TEST', 'binary-data', 1779000000);
    const state = readFsState(dir, 'TEST');
    expect(state).not.toBeNull();
    expect(state!.size).toBe('binary-data'.length);
    expect(state!.mtime).toBeCloseTo(1779000000, 0);
  });

  test('matches case-insensitive session prefix', () => {
    const dir = tempDir();
    writeJpegAt(dir, 'TEST', 'data');
    expect(readFsState(dir, 'test')).not.toBeNull();
  });
});

describe('createWatcher FS mode', () => {
  test('returns the existing file on first next() if newer than sinceMtime', async () => {
    const opts = defaults();
    writeJpegAt(opts.dir, 'TEST', 'jpeg-bytes', 1779000000);
    const watcher = createWatcher(opts);
    const evt = await watcher.next();
    expect(evt).not.toBeNull();
    expect(evt!.event).toBe('image_received');
    if (evt!.event === 'image_received') {
      expect(evt.session).toBe('TEST');
      expect(evt.size).toBe('jpeg-bytes'.length);
    }
  });

  test('skips a stale image when sinceMtime is in the future', async () => {
    const opts = defaults({ sinceMtime: 1779999999, timeoutS: 0.4 });
    writeJpegAt(opts.dir, 'TEST', 'stale', 1779000000);
    const watcher = createWatcher(opts);
    const evt = await watcher.next();
    expect(evt!.event).toBe('timeout');
  });

  test('de-duplicates back-to-back identical state', async () => {
    const opts = defaults({ timeoutS: 0.3 });
    writeJpegAt(opts.dir, 'TEST', 'jpeg', 1779000000);
    const watcher = createWatcher(opts);
    const first = await watcher.next();
    expect(first!.event).toBe('image_received');
    // Same file, no mtime change → next event should be timeout, not a re-fire.
    const second = await watcher.next();
    expect(second!.event).toBe('timeout');
  });

  test('detects a re-upload (new mtime, same path)', async () => {
    const opts = defaults();
    writeJpegAt(opts.dir, 'TEST', 'first', 1779000000);
    const watcher = createWatcher(opts);
    const first = await watcher.next();
    expect(first!.event).toBe('image_received');

    // Re-upload: rewrite with later mtime.
    writeJpegAt(opts.dir, 'TEST', 'second', 1779000100);
    const second = await watcher.next();
    expect(second!.event).toBe('image_received');
    if (second!.event === 'image_received') {
      expect(second.receivedAtUnix).toBe(1779000100);
    }
  });

  test('timeout fires when no image arrives within budget', async () => {
    const opts = defaults({ timeoutS: 0.25, intervalMs: 100 });
    const watcher = createWatcher(opts);
    const start = Date.now();
    const evt = await watcher.next();
    const elapsed = Date.now() - start;
    expect(evt!.event).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });

  test('abort signal stops a waiting watcher', async () => {
    const opts = defaults({ timeoutS: 0, intervalMs: 500 });
    const controller = new AbortController();
    const watcher = createWatcher(opts, controller.signal);
    const promise = watcher.next();
    setTimeout(() => controller.abort(), 80);
    const evt = await promise;
    expect(evt).toBeNull();
  });
});

describe('createWatcher HTTP mode', () => {
  test('long-poll returns image_received from /camera/wait', async () => {
    const port = await freePort();
    const dir = tempDir();
    // Server that returns image_received once, then never again
    let firstHit = true;
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname !== '/camera/wait') return new Response('not found', { status: 404 });
        if (firstHit) {
          firstHit = false;
          return Response.json({
            status: 'image_received',
            session: 'TEST',
            path: '/tmp/cad-reference/TEST.jpg',
            size_bytes: 4242,
            received_at: 1779999999,
            image_url: '/camera/latest?session=TEST',
          });
        }
        return Response.json({ status: 'timeout', session: 'TEST', since: 1779999999 });
      },
    });

    try {
      const opts = defaults({
        dir,
        serverUrl: `http://127.0.0.1:${port}`,
        longPollSeconds: 1,
      });
      const watcher = createWatcher(opts);
      const evt = await watcher.next();
      expect(evt!.event).toBe('image_received');
      if (evt!.event === 'image_received') {
        expect(evt.size).toBe(4242);
        expect(evt.receivedAtUnix).toBe(1779999999);
      }
    } finally {
      server.stop(true);
    }
  });

  test('falls back to FS polling when server is unreachable', async () => {
    const dir = tempDir();
    const opts = defaults({
      dir,
      serverUrl: 'http://127.0.0.1:1', // port 1 is reliably closed
      longPollSeconds: 1,
      timeoutS: 1,
      intervalMs: 100,
    });
    // Drop a file so the FS path returns the event.
    writeJpegAt(dir, 'TEST', 'jpeg', 1779000000);
    const watcher = createWatcher(opts);
    const evt = await watcher.next();
    expect(evt!.event).toBe('image_received');
  });

  test('http timeout loops without exhausting overall budget', async () => {
    const port = await freePort();
    const dir = tempDir();
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json({ status: 'timeout', session: 'TEST', since: 0 }),
    });

    try {
      const opts = defaults({
        dir,
        serverUrl: `http://127.0.0.1:${port}`,
        longPollSeconds: 1,
        timeoutS: 0.4,
        intervalMs: 100,
      });
      const watcher = createWatcher(opts);
      const evt = await watcher.next();
      expect(evt!.event).toBe('timeout');
    } finally {
      server.stop(true);
    }
  });
});
