import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand as dispatchWrite } from '../src/write-commands';
import { startTestServer } from './test-server';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffprobeAvailable = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe('browser tab recording', () => {
  let server: ReturnType<typeof startTestServer>;
  let bm: BrowserManager;

  const write = (command: string, args: string[] = []) =>
    dispatchWrite(command, args, bm.getActiveSession(), bm);

  beforeAll(async () => {
    server = startTestServer(0);
    bm = new BrowserManager();
    await bm.launch();
  });

  afterAll(async () => {
    try { server.server.stop(); } catch {}
    // BrowserManager has its own 5s defensive close timeout; keep this hook
    // below Bun's 5s default so a slow Chromium teardown cannot fail the suite.
    await Promise.race([bm.close(), new Promise(resolve => setTimeout(resolve, 4_000))]);
  });

  test('status requires an active recording', async () => {
    await expect(write('record', ['status'])).rejects.toThrow(/No browser recording is active/);
  });

  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)('captures an interactive flow as a playable MP4 and safe timeline', async () => {
    const output = path.join('/tmp', `gstack-recording-test-${process.pid}.mp4`);
    const sidecar = output.replace(/\.mp4$/, '.json');
    fs.rmSync(output, { force: true });
    fs.rmSync(sidecar, { force: true });

    await write('viewport', ['800x600']);
    await write('goto', [`${server.url}/forms.html?token=do-not-leak-url`]);
    const started = await write('record', ['start', output]);
    expect(started).toContain('Recording started');

    await write('fill', ['#email', 'reviewer@example.com']);
    await write('fill', ['#password', 'do-not-leak-this']);
    await write('record', ['mark', 'Submit the form']);
    await write('click', ['#login-btn']);
    await new Promise(resolve => setTimeout(resolve, 1100));

    const status = JSON.parse(await write('record', ['status']));
    expect(status.active).toBe(true);
    expect(status.markers).toBeGreaterThanOrEqual(4);

    const stopped = await write('record', ['stop']);
    expect(stopped).toContain('Recording saved');
    expect(fs.statSync(output).size).toBeGreaterThan(1_000);
    expect(fs.existsSync(sidecar)).toBe(true);

    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt:format=duration',
      '-of', 'json', output,
    ], { encoding: 'utf8' });
    expect(probe.status).toBe(0);
    const media = JSON.parse(probe.stdout);
    expect(media.streams[0].codec_name).toBe('h264');
    expect(media.streams[0].width).toBe(800);
    expect(media.streams[0].height).toBe(600);
    expect(media.streams[0].pix_fmt).toBe('yuv420p');
    expect(Number(media.format.duration)).toBeGreaterThan(1);

    const timelineText = fs.readFileSync(sidecar, 'utf8');
    expect(timelineText).toContain('Fill field');
    expect(timelineText).toContain('Submit the form');
    expect(timelineText).not.toContain('do-not-leak-this');
    expect(timelineText).not.toContain('do-not-leak-url');
    const timeline = JSON.parse(timelineText);
    expect(Math.abs(timeline.durationMs - Number(media.format.duration) * 1000)).toBeLessThan(100);

    fs.rmSync(output, { force: true });
    fs.rmSync(sidecar, { force: true });
  }, 30_000);
});
