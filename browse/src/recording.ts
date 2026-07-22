/**
 * Frontend evidence recording for the active gstack browser tab.
 *
 * Chrome's Page.startScreencast streams changed frames from the existing tab,
 * preserving the current browser profile, cookies, viewport, and navigation.
 * Frames are finalized to a review-friendly H.264 MP4 with ffmpeg on stop.
 */

import type { Page } from 'playwright';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserManager } from './browser-manager';
import { openCdpSession } from './cdp-bridge';
import { validateOutputPath } from './path-security';
import { TEMP_DIR } from './platform';

interface RecordedFrame {
  file: string;
  elapsedMs: number;
}

interface RecordingMarker {
  elapsedMs: number;
  label: string;
}

interface RecordingState {
  page: Page;
  tabId: number;
  outputPath: string;
  tempDir: string;
  startedAt: number;
  startedUrl: string;
  viewport: { width: number; height: number };
  frames: RecordedFrame[];
  markers: RecordingMarker[];
  cdp: any;
  detach: () => Promise<void>;
  frameHandler: (event: any) => void;
  stopping: boolean;
}

const recordings = new WeakMap<BrowserManager, RecordingState>();

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function defaultOutputPath(): string {
  return path.join(TEMP_DIR, `visual-proof-${timestampSlug()}.mp4`);
}

function safeEvidenceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function writeFrame(state: RecordingState, data: Buffer, elapsedMs = Date.now() - state.startedAt): void {
  const file = path.join(state.tempDir, `frame-${String(state.frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, data);
  state.frames.push({ file, elapsedMs: Math.max(0, elapsedMs) });
}

function concatEscape(file: string): string {
  return file.replace(/'/g, `'\\''`);
}

function runFfmpeg(state: RecordingState, durationMs: number): void {
  const concatPath = path.join(state.tempDir, 'frames.txt');
  const lines: string[] = [];
  for (let i = 0; i < state.frames.length; i++) {
    const current = state.frames[i];
    const nextElapsed = state.frames[i + 1]?.elapsedMs ?? durationMs;
    const frameDuration = Math.max(1 / 30, (nextElapsed - current.elapsedMs) / 1000);
    lines.push(`file '${concatEscape(current.file)}'`);
    lines.push(`duration ${frameDuration.toFixed(6)}`);
  }
  // concat demuxer ignores the final duration unless the last frame is repeated.
  const last = state.frames[state.frames.length - 1];
  lines.push(`file '${concatEscape(last.file)}'`);
  fs.writeFileSync(concatPath, `${lines.join('\n')}\n`, 'utf8');

  const ffmpeg = process.env.GSTACK_FFMPEG_PATH || 'ffmpeg';
  const result = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-vf', 'fps=30,scale=in_range=pc:out_range=tv,format=yuv420p',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-movflags', '+faststart',
    state.outputPath,
  ], { encoding: 'utf8' });

  if (result.error) {
    throw new Error(
      `Could not run ffmpeg (${ffmpeg}): ${result.error.message}. Install ffmpeg or set GSTACK_FFMPEG_PATH. ` +
      `Captured frames were kept at ${state.tempDir}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${(result.stderr || result.stdout || 'unknown error').trim()}. Captured frames were kept at ${state.tempDir}`);
  }
}

function probeDurationMs(outputPath: string, fallbackMs: number): number {
  const ffprobe = process.env.GSTACK_FFPROBE_PATH || 'ffprobe';
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', outputPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) return fallbackMs;
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallbackMs;
}

function safeInteractionLabel(command: string, args: string[]): string | null {
  switch (command) {
    // Never echo selectors: they can contain customer IDs, email addresses,
    // tokens, or literal text matchers. Explicit `record mark` labels carry
    // reviewer-friendly intent and are authored under the skill's data rules.
    case 'click': return 'Click control';
    case 'fill': return 'Fill field';
    case 'select': return 'Choose option';
    case 'hover': return 'Hover element';
    case 'type': return 'Type text';
    case 'press': return `Press ${args[0] || 'key'}`;
    case 'scroll': return 'Scroll page';
    case 'goto': return 'Navigate';
    case 'back': return 'Go back';
    case 'forward': return 'Go forward';
    case 'reload': return 'Reload';
    default: return null;
  }
}

async function addMarker(state: RecordingState, label: string, pauseMs = 0): Promise<void> {
  const cleanLabel = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  if (!cleanLabel) return;
  state.markers.push({ elapsedMs: Date.now() - state.startedAt, label: cleanLabel });
  if (state.page.isClosed()) return;
  await state.page.evaluate((text: string) => {
    const id = '__gstack_recording_marker__';
    document.getElementById(id)?.remove();
    const marker = document.createElement('div');
    marker.id = id;
    marker.textContent = text;
    marker.setAttribute('aria-hidden', 'true');
    Object.assign(marker.style, {
      position: 'fixed', left: '20px', bottom: '20px', zIndex: '999999',
      padding: '9px 13px', borderRadius: '9px', background: 'rgba(15, 23, 42, .9)',
      color: '#fff', font: '600 14px/1.2 -apple-system, BlinkMacSystemFont, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.24)', pointerEvents: 'none',
    });
    document.documentElement.appendChild(marker);
    window.setTimeout(() => marker.remove(), 900);
  }, cleanLabel).catch(() => undefined);
  if (pauseMs > 0 && !state.page.isClosed()) {
    await state.page.waitForTimeout(pauseMs).catch(() => undefined);
  }
}

/** Add a non-sensitive automatic marker for visible browser interactions. */
export async function markRecordedInteraction(bm: BrowserManager, command: string, args: string[]): Promise<void> {
  const state = recordings.get(bm);
  if (!state || state.stopping) return;
  const label = safeInteractionLabel(command, args);
  // Browser agents normally move faster than a human reviewer can follow.
  // Recording-only pacing makes each intent label and intermediate state legible.
  if (label) await addMarker(state, label, 300);
}

export async function handleRecordCommand(args: string[], bm: BrowserManager): Promise<string> {
  const action = args[0];
  if (!action || !['start', 'mark', 'status', 'stop'].includes(action)) {
    throw new Error('Usage: browse record start [output.mp4] | mark <label> | status | stop');
  }

  if (action === 'start') {
    if (recordings.has(bm)) throw new Error('A browser recording is already active. Run `browse record status` or `browse record stop`.');
    if (args.length > 2) throw new Error('Usage: browse record start [output.mp4]');
    const outputPath = path.resolve(args[1] || defaultOutputPath());
    if (path.extname(outputPath).toLowerCase() !== '.mp4') throw new Error('Recording output must use the .mp4 extension.');
    validateOutputPath(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const page = bm.getPage();
    const viewport = page.viewportSize() || bm.getCurrentViewport();
    const tempDir = fs.mkdtempSync(path.join(TEMP_DIR || os.tmpdir(), 'gstack-record-'));
    const { session: cdp, detach } = await openCdpSession(page);
    const state: RecordingState = {
      page, tabId: bm.getActiveTabId(), outputPath, tempDir,
      startedAt: Date.now(), startedUrl: safeEvidenceUrl(page.url()), viewport,
      frames: [], markers: [], cdp, detach, stopping: false,
      frameHandler: () => {},
    };

    // Always seed the movie with the exact initial viewport, even on a static page.
    const initial = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
    writeFrame(state, Buffer.from(initial), 0);

    state.frameHandler = (event: any) => {
      // ACK first so disk IO never applies backpressure to Chrome's compositor.
      cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      if (state.stopping || typeof event.data !== 'string') return;
      writeFrame(state, Buffer.from(event.data, 'base64'));
    };
    cdp.on('Page.screencastFrame', state.frameHandler);
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 85,
        maxWidth: viewport.width, maxHeight: viewport.height,
        everyNthFrame: 1,
      });
    } catch (error) {
      cdp.off?.('Page.screencastFrame', state.frameHandler);
      await detach();
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    recordings.set(bm, state);
    return `Recording started: ${outputPath}\nTab: ${state.tabId}\nViewport: ${viewport.width}x${viewport.height}`;
  }

  const state = recordings.get(bm);
  if (!state) throw new Error('No browser recording is active. Run `browse record start [output.mp4]`.');

  if (action === 'status') {
    return JSON.stringify({
      active: true,
      outputPath: state.outputPath,
      tabId: state.tabId,
      elapsedMs: Date.now() - state.startedAt,
      frames: state.frames.length,
      markers: state.markers.length,
      viewport: state.viewport,
    }, null, 2);
  }

  if (action === 'mark') {
    const label = args.slice(1).join(' ').trim();
    if (!label) throw new Error('Usage: browse record mark <label>');
    await addMarker(state, label, 600);
    return `Recording marker added: ${label.slice(0, 100)}`;
  }

  state.stopping = true;
  const durationMs = Math.max(500, Date.now() - state.startedAt);
  try {
    await state.cdp.send('Page.stopScreencast').catch(() => undefined);
    state.cdp.off?.('Page.screencastFrame', state.frameHandler);
    if (!state.page.isClosed()) {
      const finalFrame = await state.page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
      writeFrame(state, Buffer.from(finalFrame), durationMs);
    }
  } finally {
    await state.detach();
  }

  recordings.delete(bm);
  const targetDurationMs = durationMs + 500;
  runFfmpeg(state, targetDurationMs);
  const encodedDurationMs = probeDurationMs(state.outputPath, targetDurationMs);
  const sidecarPath = state.outputPath.replace(/\.mp4$/i, '.json');
  const metadata = {
    version: 1,
    kind: 'gstack-frontend-visual-proof',
    video: state.outputPath,
    startedAt: new Date(state.startedAt).toISOString(),
    durationMs: encodedDurationMs,
    tabId: state.tabId,
    viewport: state.viewport,
    startedUrl: state.startedUrl,
    endedUrl: state.page.isClosed() ? null : safeEvidenceUrl(state.page.url()),
    frames: state.frames.length,
    markers: state.markers,
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  fs.rmSync(state.tempDir, { recursive: true, force: true });
  const bytes = fs.statSync(state.outputPath).size;
  return `Recording saved: ${state.outputPath}\nTimeline: ${sidecarPath}\nDuration: ${(encodedDurationMs / 1000).toFixed(1)}s\nFrames: ${state.frames.length}\nSize: ${bytes} bytes`;
}
