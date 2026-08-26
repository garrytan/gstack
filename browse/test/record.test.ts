/**
 * Tests for the record command — video capture of browser activity.
 *
 * Integration tests drive a real Playwright browser against the local test
 * server and assert on the bytes that land on disk, because the failure this
 * command has to avoid is reporting a video that was never flushed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { META_COMMANDS, COMMAND_DESCRIPTIONS } from '../src/commands';
import { SCOPE_CONTROL, SCOPE_READ, SCOPE_WRITE, checkScope } from '../src/token-registry';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR } from '../src/platform';

const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

const shutdown = async () => {};

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
const tempDirs: string[] = [];

/** A recording directory inside the browse temp root, cleaned up in afterAll. */
function recordingDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(TEMP_DIR, `browse-record-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function webmsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name.endsWith('.webm'));
}

/**
 * Read PixelWidth (EBML id 0xB0) and PixelHeight (0xBA) out of a WebM header.
 * Both are short unsigned ints, so the 1- and 2-byte length forms cover every
 * viewport we can ask for. Avoids depending on ffprobe being installed in CI.
 */
function videoDimensions(file: string): { width: number; height: number } {
  const head = fs.readFileSync(file).subarray(0, 4096);
  const read = (id: number): number => {
    for (let i = 0; i < head.length - 4; i++) {
      if (head[i] !== id) continue;
      if (head[i + 1] === 0x81) return head[i + 2];
      if (head[i + 1] === 0x82) return (head[i + 2] << 8) | head[i + 3];
    }
    return 0;
  };
  return { width: read(0xb0), height: read(0xba) };
}

/** Give a page long enough to paint that Playwright is certain to emit a video. */
async function settle(ms = 400): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

// Close the browser rather than forcing the process down: a process.exit here
// truncates whatever else the runner still had queued. close() races Chromium's
// shutdown against its own 5s cap, so the hook needs more than bun's 5s default.
afterAll(async () => {
  await bm.close().catch(() => {});
  try { testServer.server.stop(); } catch {}
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

// ─── Registration ───────────────────────────────────────────────

describe('record registration', () => {
  test('is a known meta command with usage text', () => {
    expect(META_COMMANDS.has('record')).toBe(true);
    expect(COMMAND_DESCRIPTIONS['record']?.usage).toContain('record start');
  });

  test('is control-scoped — it rebuilds the context and writes screen content to disk', () => {
    expect(SCOPE_CONTROL.has('record')).toBe(true);
    expect(SCOPE_READ.has('record')).toBe(false);
    expect(SCOPE_WRITE.has('record')).toBe(false);
  });

  test('a read-only token cannot record, a control token can', () => {
    const readOnly = { token: 't', clientId: 'agent', type: 'session' as const, scopes: ['read' as const] };
    const control = { token: 't', clientId: 'agent', type: 'session' as const, scopes: ['control' as const] };
    expect(checkScope(readOnly, 'record')).toBe(false);
    expect(checkScope(control, 'record')).toBe(true);
  });
});

// ─── Argument handling ──────────────────────────────────────────

describe('record argument handling', () => {
  test('status reports not-recording before any start', async () => {
    const result = await handleMetaCommand('record', ['status'], bm, shutdown);
    expect(result).toBe('Not recording.');
  });

  test('stop without an active recording is a no-op, not an error', async () => {
    const result = await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(result).toContain('Not recording');
  });

  test('missing action, unknown action, and unknown flag all explain the usage', async () => {
    expect(handleMetaCommand('record', [], bm, shutdown)).rejects.toThrow(/Usage: record start/);
    expect(handleMetaCommand('record', ['bogus'], bm, shutdown)).rejects.toThrow(/unknown action/);
    expect(handleMetaCommand('record', ['start', '--bogus'], bm, shutdown)).rejects.toThrow(/unknown flag/);
  });

  test('malformed --size is rejected before a context is rebuilt', async () => {
    expect(handleMetaCommand('record', ['start', '--size'], bm, shutdown)).rejects.toThrow(/missing value/);
    expect(handleMetaCommand('record', ['start', '--size', '1280'], bm, shutdown)).rejects.toThrow(/expected WxH/);
    expect(handleMetaCommand('record', ['start', '--size', '0x720'], bm, shutdown)).rejects.toThrow(/must be positive/);
    expect(await handleMetaCommand('record', ['status'], bm, shutdown)).toBe('Not recording.');
  });
});

// ─── Recording ──────────────────────────────────────────────────

describe('record capture', () => {
  test('start → activity → stop writes a playable webm and reports its path', async () => {
    const dir = recordingDir('basic');
    const started = await handleMetaCommand('record', ['start', dir], bm, shutdown);
    expect(started).toContain(dir);
    expect(await handleMetaCommand('record', ['status'], bm, shutdown)).toContain(dir);

    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);

    const stopped = await handleMetaCommand('record', ['stop'], bm, shutdown);
    const videos = webmsIn(dir);
    expect(videos.length).toBeGreaterThan(0);
    expect(stopped).toContain(videos[0]);

    // EBML magic bytes — a real Matroska/WebM container, not an empty file.
    const bytes = fs.readFileSync(path.join(dir, videos[0]));
    expect(bytes.length).toBeGreaterThan(0);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    expect(await handleMetaCommand('record', ['status'], bm, shutdown)).toBe('Not recording.');
  }, 30000);

  test('the browser still works after a recording stops', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const url = await handleMetaCommand('url', [], bm, shutdown);
    expect(url).toContain('/snapshot.html');
  }, 15000);

  test('a tab closed mid-recording still has its video reported', async () => {
    const dir = recordingDir('closed-tab');
    await handleMetaCommand('record', ['start', dir], bm, shutdown);

    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();
    await handleMetaCommand('newtab', [baseUrl + '/forms.html'], bm, shutdown);
    // A tab has to actually paint before Playwright emits a video for it; a tab
    // opened and closed inside the same few milliseconds produces nothing.
    await settle();
    await handleMetaCommand('closetab', [], bm, shutdown);

    const stopped = await handleMetaCommand('record', ['stop'], bm, shutdown);
    const videos = webmsIn(dir);

    // Enumerating live pages at stop time would report one video here. Every
    // file the recording produced has to be listed, or the caller is told they
    // have less evidence than they do.
    expect(videos.length).toBeGreaterThanOrEqual(2);
    for (const name of videos) {
      expect(stopped).toContain(path.join(dir, name));
    }
  }, 45000);

  test('cookies survive the context rebuild that start and stop perform', async () => {
    const dir = recordingDir('state');
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await bm.getActiveSession().page.context().addCookies([
      { name: 'record_state_probe', value: 'kept', url: baseUrl },
    ]);

    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    const during = await bm.getActiveSession().page.context().cookies();
    expect(during.some(c => c.name === 'record_state_probe')).toBe(true);

    await handleMetaCommand('record', ['stop'], bm, shutdown);
    const after = await bm.getActiveSession().page.context().cookies();
    expect(after.some(c => c.name === 'record_state_probe')).toBe(true);
  }, 30000);

  test('starting while already recording reports the take it superseded', async () => {
    const first = recordingDir('first');
    const second = recordingDir('second');

    await handleMetaCommand('record', ['start', first], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();
    const restarted = await handleMetaCommand('record', ['start', second], bm, shutdown);

    // The first take is on disk. Telling the caller only about the new
    // recording would strand it somewhere they were never given the path to.
    const firstVideos = webmsIn(first);
    expect(firstVideos.length).toBeGreaterThan(0);
    for (const name of firstVideos) {
      expect(restarted).toContain(path.join(first, name));
    }
    expect(restarted).toContain(second);
    expect(await handleMetaCommand('record', ['status'], bm, shutdown)).toContain(second);

    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await settle();
    await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(webmsIn(second).length).toBeGreaterThan(0);
  }, 60000);

  test('--size sets the recorded frame size', async () => {
    const dir = recordingDir('size');
    await handleMetaCommand('record', ['start', dir, '--size', '640x480'], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();
    await handleMetaCommand('record', ['stop'], bm, shutdown);

    const videos = webmsIn(dir);
    expect(videos.length).toBeGreaterThan(0);
    expect(videoDimensions(path.join(dir, videos[0]))).toEqual({ width: 640, height: 480 });
  }, 30000);

  test('a reused directory does not re-report the earlier take', async () => {
    const dir = recordingDir('reused');

    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();
    const firstStop = await handleMetaCommand('record', ['stop'], bm, shutdown);
    const afterFirst = webmsIn(dir);
    expect(afterFirst.length).toBeGreaterThan(0);

    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await settle();
    const secondStop = await handleMetaCommand('record', ['stop'], bm, shutdown);

    // Both takes live in the same directory, so the second report must name
    // only what the second take produced.
    const listed = (report: string) =>
      report.split('\n').map(l => l.trim()).filter(l => l.endsWith('.webm'));
    expect(webmsIn(dir).length).toBeGreaterThan(afterFirst.length);
    expect(listed(firstStop).length).toBeGreaterThan(0);
    expect(listed(secondStop).length).toBeGreaterThan(0);
    for (const earlier of listed(firstStop)) {
      expect(listed(secondStop)).not.toContain(earlier);
    }
  }, 60000);
});

// ─── Failure reporting ──────────────────────────────────────────

describe('record failure reporting', () => {
  test('a degraded flush is surfaced, not swallowed', async () => {
    const dir = recordingDir('degraded');
    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();

    // The rebuild IS the flush, so recreateContext reporting a degraded rebuild
    // means the flush degraded. Silently dropping it tells the caller their
    // evidence is fine when their tabs were just reset.
    const real = (bm as any).recreateContext.bind(bm);
    (bm as any).recreateContext = async () => 'Context recreation failed: simulated. Browser reset to blank tab.';
    try {
      const stopped = await handleMetaCommand('record', ['stop'], bm, shutdown);
      expect(stopped).toContain('Context recreation failed');
    } finally {
      (bm as any).recreateContext = real;
    }
  }, 30000);

  test('an unreadable recording directory is reported as a failure', async () => {
    const dir = recordingDir('vanished');
    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();
    fs.rmSync(dir, { recursive: true, force: true });

    const stopped = await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(stopped).toMatch(/could not be read/i);
  }, 30000);

  test('stop after a switch to headed mode still hands back the videos', async () => {
    const dir = recordingDir('headed');
    await handleMetaCommand('record', ['start', dir], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await settle();

    // handoff/connect close the recording context (flushing as they go) and
    // leave the manager headed, where recreateContext() throws. The videos are
    // already on disk, so stop has to hand them back rather than raise.
    await (bm as any).context.close().catch(() => {});
    (bm as any).connectionMode = 'headed';
    try {
      const result = await bm.stopRecording();
      expect(result.videos.length).toBeGreaterThan(0);
      expect(bm.getRecordingDir()).toBeNull();
    } finally {
      (bm as any).connectionMode = 'launched';
      await (bm as any).recreateContext();
    }
  }, 30000);
});

// ─── Path policy ────────────────────────────────────────────────

describe('record path policy', () => {
  test('a directory outside the safe roots is refused', async () => {
    expect(
      handleMetaCommand('record', ['start', '/etc/browse-record-should-not-exist'], bm, shutdown),
    ).rejects.toThrow(/must be within/i);
    expect(fs.existsSync('/etc/browse-record-should-not-exist')).toBe(false);
  });

  test('a rejected start leaves no directory behind', async () => {
    const dir = path.join(TEMP_DIR, `browse-record-rejected-${Date.now()}`);
    expect(
      handleMetaCommand('record', ['start', dir, '--size', 'nonsense'], bm, shutdown),
    ).rejects.toThrow(/expected WxH/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('no directory argument records under the temp dir', async () => {
    const started = await handleMetaCommand('record', ['start'], bm, shutdown);
    const match = /Recording → (\S+)/.exec(started);
    expect(match).not.toBeNull();
    const dir = match![1];
    tempDirs.push(dir);
    expect(dir).toContain('browse-record-');
    await handleMetaCommand('record', ['stop'], bm, shutdown);
  }, 30000);
});
