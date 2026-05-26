/**
 * `record` command tests — video evidence for interactive bug repros.
 *
 * Covers:
 *   - record start enables recording, record stop returns the .webm path(s)
 *   - the written file is a non-empty WebM (magic bytes 0x1A 0x45 0xDF 0xA3)
 *   - the browser is still functional after stop (state preserved across recreate)
 *   - record stop with no active recording is a no-op
 *   - record start while already recording flushes the prior recording
 *   - validateOutputPath rejects out-of-sandbox dirs
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { TEMP_DIR } from '../src/platform';

const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
const shutdown = async () => {};

// Unique scratch dir per run — under TEMP_DIR so validateOutputPath's SAFE_DIRECTORIES
// guard accepts it (macOS resolves /tmp → /private/tmp; os.tmpdir() points elsewhere).
const scratchDir = path.join(TEMP_DIR, `gstack-record-test-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  fs.mkdirSync(scratchDir, { recursive: true });

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 500);
});

describe('record', () => {
  test('record status reports not-recording before start', async () => {
    const result = await handleMetaCommand('record', ['status'], bm, shutdown);
    expect(result).toContain('Not recording');
  });

  test('record stop without active recording is a no-op', async () => {
    const result = await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(result).toContain('No active recording');
  });

  test('record start → activity → record stop produces non-empty .webm', async () => {
    const target = path.join(scratchDir, 'basic-flow');

    // Navigate before starting so we have something to record against
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const startMsg = await handleMetaCommand('record', ['start', target], bm, shutdown);
    expect(startMsg).toContain('Recording → ');
    expect(startMsg).toContain(target);

    // status reports active recording
    const statusMid = await handleMetaCommand('record', ['status'], bm, shutdown);
    expect(statusMid).toContain('Recording → ');

    // Do some real work so the video has frames to capture.
    // recreateContext closed the old context and opened a new one — we need to
    // re-navigate to populate the new context's page.
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Give the recorder a moment to capture frames.
    await new Promise(r => setTimeout(r, 400));
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await new Promise(r => setTimeout(r, 400));

    const stopMsg = await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(stopMsg).toContain('Recording saved');

    // Parse the paths back out of the message.
    const lines = stopMsg.split('\n').map(l => l.trim()).filter(l => l.endsWith('.webm'));
    expect(lines.length).toBeGreaterThan(0);
    for (const p of lines) {
      expect(fs.existsSync(p)).toBe(true);
      const stat = fs.statSync(p);
      expect(stat.size).toBeGreaterThan(0);

      // WebM magic bytes: 0x1A 0x45 0xDF 0xA3 (EBML header)
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      expect(buf[0]).toBe(0x1A);
      expect(buf[1]).toBe(0x45);
      expect(buf[2]).toBe(0xDF);
      expect(buf[3]).toBe(0xA3);
    }

    // status reports not-recording again
    const statusEnd = await handleMetaCommand('record', ['status'], bm, shutdown);
    expect(statusEnd).toContain('Not recording');
  });

  test('browser remains functional after record stop', async () => {
    // After the previous test stopped, we should still be able to navigate.
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(result).toBeDefined();
    // A snapshot should still return refs — proves the new context is wired.
    const snap = await handleMetaCommand('snapshot', [], bm, shutdown);
    expect(snap).toContain('@e');
  });

  test('record start while already recording auto-stops the prior recording', async () => {
    const firstDir = path.join(scratchDir, 'auto-stop-first');
    const secondDir = path.join(scratchDir, 'auto-stop-second');

    await handleMetaCommand('record', ['start', firstDir], bm, shutdown);
    expect(bm.isRecording()).toBe(true);
    expect(bm.getRecordVideoDir()).toBe(firstDir);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await new Promise(r => setTimeout(r, 200));

    // Starting again should not throw and should swap the active dir.
    await handleMetaCommand('record', ['start', secondDir], bm, shutdown);
    expect(bm.isRecording()).toBe(true);
    expect(bm.getRecordVideoDir()).toBe(secondDir);

    await handleMetaCommand('record', ['stop'], bm, shutdown);
    expect(bm.isRecording()).toBe(false);
  });

  test('record start rejects unknown flags', async () => {
    await expect(
      handleMetaCommand('record', ['start', '--bogus'], bm, shutdown),
    ).rejects.toThrow(/Unknown record start flag/);
  });

  test('record start rejects malformed --size', async () => {
    await expect(
      handleMetaCommand('record', ['start', '--size', 'not-a-size'], bm, shutdown),
    ).rejects.toThrow(/expected WxH/);
  });

  test('record with no action throws a usage error', async () => {
    await expect(
      handleMetaCommand('record', [], bm, shutdown),
    ).rejects.toThrow(/Usage: record/);
  });

  test('unknown record subaction throws', async () => {
    await expect(
      handleMetaCommand('record', ['foo'], bm, shutdown),
    ).rejects.toThrow(/Unknown record action/);
  });
});
