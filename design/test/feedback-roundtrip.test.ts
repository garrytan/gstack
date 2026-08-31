/**
 * End-to-end feedback round-trip test.
 *
 * This is THE test that proves "changes on the website propagate to the agent."
 * Tests the full pipeline:
 *
 *   Browser click → JS fetch() → HTTP POST → server writes file → agent polls file
 *
 * The Kitsune bug: agent backgrounded $D serve, couldn't read stdout, user
 * clicked Regenerate, board showed spinner, agent never saw the feedback.
 * Fix: server writes feedback-pending.json to disk. Agent polls for it.
 *
 * This test verifies every link in the chain.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../../browse/src/browser-manager';
import { handleReadCommand } from '../../browse/src/read-commands';
import { handleWriteCommand } from '../../browse/src/write-commands';
import { generateCompareHtml } from '../src/compare';
import * as fs from 'fs';
import * as path from 'path';

let bm: BrowserManager;

// The command handlers take (command, args, session: TabSession, bm) — mirror
// the real call sites (browse/src/cli.ts, browse/test/commands.test.ts) by
// resolving the active TabSession from the manager on every call. Passing the
// manager itself where a session is expected breaks as soon as a handler uses
// a session method the manager doesn't delegate (e.g. clearLoadedHtml).
const writeCmd = (cmd: string, args: string[]) =>
  handleWriteCommand(cmd, args, bm.getActiveSession(), bm);
const readCmd = (cmd: string, args: string[]) =>
  handleReadCommand(cmd, args, bm.getActiveSession(), bm);
let baseUrl: string;
let server: ReturnType<typeof Bun.serve>;
let tmpDir: string;
let boardHtmlPath: string;
let serverState: string;

function createTestPng(filePath: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(filePath, png);
}

beforeAll(async () => {
  tmpDir = '/tmp/feedback-roundtrip-' + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });

  createTestPng(path.join(tmpDir, 'variant-A.png'));
  createTestPng(path.join(tmpDir, 'variant-B.png'));
  createTestPng(path.join(tmpDir, 'variant-C.png'));

  const html = generateCompareHtml([
    path.join(tmpDir, 'variant-A.png'),
    path.join(tmpDir, 'variant-B.png'),
    path.join(tmpDir, 'variant-C.png'),
  ]);
  boardHtmlPath = path.join(tmpDir, 'design-board.html');
  fs.writeFileSync(boardHtmlPath, html);

  serverState = 'serving';

  // This server mirrors the real serve.ts behavior:
  // - Serves board HTML at / (board JS uses relative URLs)
  // - Handles POST /api/feedback with file writes
  // - Handles GET /api/progress for regeneration polling
  // - Handles POST /api/reload for board swapping
  let currentHtml = html;

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(currentHtml, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/progress') {
        return Response.json({ status: serverState });
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        return (async () => {
          let body: any;
          try { body = await req.json(); } catch {
            return Response.json({ error: 'Invalid JSON' }, { status: 400 });
          }
          if (typeof body !== 'object' || body === null) {
            return Response.json({ error: 'Expected JSON object' }, { status: 400 });
          }

          const isSubmit = body.regenerated === false;
          const feedbackFile = isSubmit ? 'feedback.json' : 'feedback-pending.json';
          fs.writeFileSync(path.join(tmpDir, feedbackFile), JSON.stringify(body, null, 2));

          if (isSubmit) {
            serverState = 'done';
            return Response.json({ received: true, action: 'submitted' });
          }
          serverState = 'regenerating';
          return Response.json({ received: true, action: 'regenerate' });
        })();
      }

      if (req.method === 'POST' && url.pathname === '/api/reload') {
        return (async () => {
          const body = await req.json();
          if (body.html && fs.existsSync(body.html)) {
            currentHtml = fs.readFileSync(body.html, 'utf-8');
            serverState = 'serving';
            return Response.json({ reloaded: true });
          }
          return Response.json({ error: 'Not found' }, { status: 400 });
        })();
      }

      return new Response('Not found', { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { server.stop(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Close only this file's own browser — never process.exit(): bun test runs
  // all files in one process, so a delayed exit kills the whole suite
  // (see test/no-suicide-exit.test.ts). close() can hang when the browser
  // already died, and its internal 5s timeout ties bun's 5s hook timeout —
  // so race it at 3s and abandon; the child is reaped at process exit.
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
});

// ─── The critical test: browser click → file on disk ─────────────

describe('Submit: browser click → feedback.json on disk', () => {
  test('clicking Submit writes feedback.json that the agent can poll for', async () => {
    // Clean up any prior files
    const feedbackPath = path.join(tmpDir, 'feedback.json');
    if (fs.existsSync(feedbackPath)) fs.unlinkSync(feedbackPath);
    serverState = 'serving';

    // Navigate to the board (board JS uses relative URLs + location.protocol detect)
    await writeCmd('goto', [baseUrl]);

    // Verify the board detects HTTP mode (so postFeedback will actually fetch
    // instead of falling into the file:// DOM-only path)
    const httpDetected = await readCmd('js', [
      "location.protocol === 'http:' || location.protocol === 'https:'"
    ]);
    expect(httpDetected).toBe('true');

    // User picks variant A, rates it 5 stars
    await readCmd('js', [
      'document.querySelectorAll("input[name=\\"preferred\\"]")[0].click()'
    ]);
    await readCmd('js', [
      'document.querySelectorAll(".stars")[0].querySelectorAll(".star")[4].click()'
    ]);

    // User adds overall feedback
    await readCmd('js', [
      'document.getElementById("overall-feedback").value = "Ship variant A"'
    ]);

    // User clicks Submit
    await readCmd('js', [
      'document.getElementById("submit-btn").click()'
    ]);

    // Wait a beat for the async POST to complete
    await new Promise(r => setTimeout(r, 300));

    // THE CRITICAL ASSERTION: feedback.json exists on disk
    expect(fs.existsSync(feedbackPath)).toBe(true);

    // Agent reads it (simulating the polling loop)
    const feedback = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    expect(feedback.preferred).toBe('A');
    expect(feedback.ratings.A).toBe(5);
    expect(feedback.overall).toBe('Ship variant A');
    expect(feedback.regenerated).toBe(false);
  });

  test('post-submit: inputs disabled, success message shown', async () => {
    // Wait for the async .then() callback to update the DOM
    // (the file write is instant but the fetch().then() in the browser is async)
    await new Promise(r => setTimeout(r, 500));

    // After submit, the page should be read-only
    const submitBtnExists = await readCmd('js', [
      'document.getElementById("submit-btn").style.display'
    ]);
    // submit button is hidden after post-submit lifecycle
    expect(submitBtnExists).toBe('none');

    const successVisible = await readCmd('js', [
      'document.getElementById("success-msg").style.display'
    ]);
    expect(successVisible).toBe('block');

    // Success message should mention /design-shotgun
    const successText = await readCmd('js', [
      'document.getElementById("success-msg").textContent'
    ]);
    expect(successText).toContain('design-shotgun');
  });
});

describe('Regenerate: browser click → feedback-pending.json on disk', () => {
  test('clicking Regenerate writes feedback-pending.json that the agent can poll for', async () => {
    // Clean up
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    serverState = 'serving';

    // Fresh page
    await writeCmd('goto', [baseUrl]);

    // User clicks "Totally different" chiclet
    await readCmd('js', [
      'document.querySelector(".regen-chiclet[data-action=\\"different\\"]").click()'
    ]);

    // User clicks Regenerate
    await readCmd('js', [
      'document.getElementById("regen-btn").click()'
    ]);

    // Wait for async POST
    await new Promise(r => setTimeout(r, 300));

    // THE CRITICAL ASSERTION: feedback-pending.json exists on disk
    expect(fs.existsSync(pendingPath)).toBe(true);

    // Agent reads it
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerated).toBe(true);
    expect(pending.regenerateAction).toBe('different');

    // Agent would delete it and act on it
    fs.unlinkSync(pendingPath);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  test('"More like this" writes feedback-pending.json with variant reference', async () => {
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    serverState = 'serving';

    await writeCmd('goto', [baseUrl]);

    // Click "More like this" on variant B (index 1)
    await readCmd('js', [
      'document.querySelectorAll(".more-like-this")[1].click()'
    ]);

    await new Promise(r => setTimeout(r, 300));

    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerated).toBe(true);
    expect(pending.regenerateAction).toBe('more_like_B');

    fs.unlinkSync(pendingPath);
  });

  test('board shows spinner after regenerate (user stays on same tab)', async () => {
    serverState = 'serving';
    await writeCmd('goto', [baseUrl]);

    await readCmd('js', [
      'document.querySelector(".regen-chiclet[data-action=\\"different\\"]").click()'
    ]);
    await readCmd('js', [
      'document.getElementById("regen-btn").click()'
    ]);

    await new Promise(r => setTimeout(r, 300));

    // Board should show "Generating new designs..." text
    const bodyText = await readCmd('js', [
      'document.body.textContent'
    ]);
    expect(bodyText).toContain('Generating new designs');
  });
});

describe('Full regeneration round-trip: regen → reload → submit', () => {
  test('agent can reload board after regeneration, user submits on round 2', async () => {
    // Clean start
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    const feedbackPath = path.join(tmpDir, 'feedback.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(feedbackPath)) fs.unlinkSync(feedbackPath);
    serverState = 'serving';

    await writeCmd('goto', [baseUrl]);

    // Step 1: User clicks Regenerate
    await readCmd('js', [
      'document.querySelector(".regen-chiclet[data-action=\\"match\\"]").click()'
    ]);
    await readCmd('js', [
      'document.getElementById("regen-btn").click()'
    ]);

    await new Promise(r => setTimeout(r, 300));

    // Agent polls and finds feedback-pending.json
    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerateAction).toBe('match');
    fs.unlinkSync(pendingPath);

    // Step 2: Agent generates new variants and creates a new board
    const newBoardPath = path.join(tmpDir, 'design-board-v2.html');
    const newHtml = generateCompareHtml([
      path.join(tmpDir, 'variant-A.png'),
      path.join(tmpDir, 'variant-B.png'),
      path.join(tmpDir, 'variant-C.png'),
    ]);
    fs.writeFileSync(newBoardPath, newHtml);

    // Step 3: Agent POSTs /api/reload to swap the board
    const reloadRes = await fetch(`${baseUrl}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: newBoardPath }),
    });
    const reloadData = await reloadRes.json();
    expect(reloadData.reloaded).toBe(true);
    expect(serverState).toBe('serving');

    // Step 4: Board auto-refreshes (simulated by navigating again)
    await writeCmd('goto', [baseUrl]);

    // Verify the board is fresh (no prior picks)
    const status = await readCmd('js', [
      'document.getElementById("status").textContent'
    ]);
    expect(status).toBe('');

    // Step 5: User picks variant C on round 2 and submits
    await readCmd('js', [
      'document.querySelectorAll("input[name=\\"preferred\\"]")[2].click()'
    ]);
    await readCmd('js', [
      'document.getElementById("submit-btn").click()'
    ]);

    await new Promise(r => setTimeout(r, 300));

    // Agent polls and finds feedback.json (submit = final)
    expect(fs.existsSync(feedbackPath)).toBe(true);
    const final = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    expect(final.preferred).toBe('C');
    expect(final.regenerated).toBe(false);
  });
});
