/**
 * End-to-end feedback round-trip test.
 *
 * This is THE test that proves "changes on the website propagate to the agent."
 * Tests the full pipeline:
 *
 *   Board click → JS fetch() → HTTP POST → server writes file → agent polls file
 *
 * The Kitsune bug: agent backgrounded $D serve, couldn't read stdout, user
 * clicked Regenerate, board showed spinner, agent never saw the feedback.
 * Fix: server writes feedback-pending.json to disk. Agent polls for it.
 *
 * Two layers:
 *   1. Always: spawn the REAL legacy `$D serve --no-daemon` process
 *      (design/src/serve.ts) and perform the exact fetch() POST the board's
 *      JS performs (design/src/compare.ts `postFeedback`). No browser needed.
 *      `open` is shimmed out of PATH so the test never opens the user's
 *      browser.
 *   2. Aside-gated: open the board in the Aside AI browser, click the real
 *      Regenerate and Submit buttons, and assert the files land and the DOM
 *      reaches its post-click state. Self-skips where Aside is absent (CI)
 *      or GSTACK_SKIP_ASIDE=1.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateCompareHtml } from '../src/compare';
import { asideAvailable } from '../../test/helpers/aside-available';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const CLI = path.join(ROOT, 'design', 'src', 'cli.ts');

let baseUrl: string;
let proc: ChildProcess;
let tmpDir: string;
let shimDir: string;

function createTestPng(filePath: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(filePath, png);
}

/** Three variant PNGs + the compare board in `dir`. Returns the board path. */
function writeBoard(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const pngs = ['A', 'B', 'C'].map((v) => path.join(dir, `variant-${v}.png`));
  for (const p of pngs) createTestPng(p);
  const boardHtmlPath = path.join(dir, 'design-board.html');
  fs.writeFileSync(boardHtmlPath, generateCompareHtml(pngs));
  return boardHtmlPath;
}

/** The board's `collectFeedback()` shape, exactly as compare.ts builds it. */
function boardFeedback(overrides: Record<string, unknown>) {
  return {
    preferred: null,
    ratings: { A: 0, B: 0, C: 0 },
    comments: {},
    overall: null,
    ...overrides,
  };
}

/** The board's `postFeedback()`: same endpoint, headers, and body encoding. */
async function postFeedback(feedback: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback),
  });
  return r.json() as Promise<{ received?: boolean; action?: string; error?: string }>;
}

async function waitForFile(p: string, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(p);
}

/** Spawn the real `$D serve --no-daemon` for `html`; resolves once it prints its port. */
function startServe(html: string): Promise<{ proc: ChildProcess; port: number }> {
  const child = spawn('bun', ['run', CLI, 'serve', '--no-daemon', '--html', html, '--timeout', '120'], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve did not print SERVE_STARTED within 15s\n${log}`));
    }, 15_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const m = log.match(/SERVE_STARTED: port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc: child, port: parseInt(m[1]!, 10) });
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited early (${code})\n${log}`)); });
  });
}

/** The child's exit code, or null if it is still alive after `ms`. */
function exitCodeWithin(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-roundtrip-'));
  // serve.ts auto-opens the board in the default browser via `open`. Shim it
  // to a no-op so the test never touches the user's browser.
  shimDir = path.join(tmpDir, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(shimDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const started = await startServe(writeBoard(tmpDir));
  proc = started.proc;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterAll(() => {
  try { proc?.kill('SIGKILL'); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── The critical chain: the board's POST → file on disk ─────────────

describe('Regenerate: board POST → feedback-pending.json on disk', () => {
  test('the served board is in HTTP mode, so postFeedback() will actually fetch', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The board decides between fetch() and the DOM-only path on
    // location.protocol; served over http it posts to ./api/feedback.
    expect(body).toContain("fetch('./api/feedback'");
    expect(body).toContain('id="regen-btn"');
    expect(body).toContain('id="submit-btn"');
  });

  test('"Totally different" regenerate writes feedback-pending.json that the agent can poll for', async () => {
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);

    // Exactly what submitRegenerate('different') sends.
    const result = await postFeedback(boardFeedback({ regenerated: true, regenerateAction: 'different' }));
    expect(result).toEqual({ received: true, action: 'regenerate' });

    // THE CRITICAL ASSERTION: feedback-pending.json exists on disk, next to the board HTML.
    expect(await waitForFile(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerated).toBe(true);
    expect(pending.regenerateAction).toBe('different');

    // Progress endpoint reflects the state the board polls for its spinner.
    const progress = await (await fetch(`${baseUrl}/api/progress`)).json();
    expect(progress).toEqual({ status: 'regenerating' });

    // Agent deletes it and acts on it.
    fs.unlinkSync(pendingPath);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  test('"More like this" on variant B writes feedback-pending.json with the variant reference', async () => {
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);

    const result = await postFeedback(boardFeedback({ regenerated: true, regenerateAction: 'more_like_B' }));
    expect(result.received).toBe(true);

    expect(await waitForFile(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerateAction).toBe('more_like_B');
    fs.unlinkSync(pendingPath);
  });

  test('malformed body is rejected and writes nothing', async () => {
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    const r = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(r.status).toBe(400);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });
});

describe('Full regeneration round-trip: regen → reload → submit', () => {
  test('agent reloads the board after regeneration, user submits on round 2, feedback.json lands', async () => {
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    const feedbackPath = path.join(tmpDir, 'feedback.json');
    for (const p of [pendingPath, feedbackPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

    // Step 1: user clicks Regenerate ("match").
    await postFeedback(boardFeedback({ regenerated: true, regenerateAction: 'match' }));
    expect(await waitForFile(pendingPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pendingPath, 'utf-8')).regenerateAction).toBe('match');
    fs.unlinkSync(pendingPath);

    // Step 2: agent generates new variants and a new board.
    const newBoardPath = path.join(tmpDir, 'design-board-v2.html');
    fs.writeFileSync(newBoardPath, generateCompareHtml(['A', 'B', 'C'].map((v) => path.join(tmpDir, `variant-${v}.png`))));

    // Step 3: agent POSTs /api/reload to swap the board in place.
    const reload = await (await fetch(`${baseUrl}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: newBoardPath }),
    })).json();
    expect(reload).toEqual({ reloaded: true });
    expect(await (await fetch(`${baseUrl}/api/progress`)).json()).toEqual({ status: 'serving' });

    // Step 4: user picks variant C, rates it 5 stars, submits. Submit is the
    // last message: serve.ts exits 0 shortly after answering.
    const result = await postFeedback(boardFeedback({
      preferred: 'C', ratings: { A: 0, B: 0, C: 5 }, overall: 'Ship variant C', regenerated: false,
    }));
    expect(result).toEqual({ received: true, action: 'submitted' });

    expect(await waitForFile(feedbackPath)).toBe(true);
    const final = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    expect(final.preferred).toBe('C');
    expect(final.ratings.C).toBe(5);
    expect(final.overall).toBe('Ship variant C');
    expect(final.regenerated).toBe(false);

    // Submit ends the legacy serve process (exit 0) so the agent's foreground
    // `$D serve` returns.
    expect(await exitCodeWithin(proc, 5000)).toBe(0);
  });
});

// ─── Aside-gated: real clicks in the user's real browser ─────────────

describe.skipIf(!asideAvailable())('Aside click → file on disk', () => {
  let asideDir: string;
  const children: ChildProcess[] = [];

  /** Fresh board + fresh serve per test: Submit ends the serve process. */
  async function serveBoard(name: string) {
    const dir = path.join(asideDir, name);
    const { proc: child, port } = await startServe(writeBoard(dir));
    children.push(child);
    return { dir, url: `http://127.0.0.1:${port}/`, child };
  }

  /** One flow per script: the tab is ours (openTab), local target, closed on exit. */
  function runAside(lines: string[]): string {
    const script = [...lines, 'await closeTab(pg);', 'console.log("GSTACK_STEP_OK");'].join('\n');
    const run = spawnSync('aside', ['repl', script], { encoding: 'utf8', timeout: 90_000 });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out, out).toContain('GSTACK_STEP_OK');
    return out;
  }

  beforeAll(() => {
    asideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-roundtrip-aside-'));
  });

  afterAll(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
    fs.rmSync(asideDir, { recursive: true, force: true });
  });

  test('clicking "Totally different" then Regenerate writes feedback-pending.json', async () => {
    const { dir, url } = await serveBoard('regen');
    const pendingPath = path.join(dir, 'feedback-pending.json');

    const out = runAside([
      `const pg = await openTab(${JSON.stringify(url)});`,
      `await pg.waitForSelector("#regen-btn");`,
      `await pg.locator('.regen-chiclet[data-action="different"]').click();`,
      `await pg.locator("#regen-btn").click();`,
      `await sleep(800);`,
      `console.log("STATUS=" + await pg.evaluate(() => document.getElementById("status").textContent));`,
      `console.log("BODY_HAS_SPINNER=" + await pg.evaluate(() => document.body.textContent.includes("Generating new designs")));`,
    ]);
    expect(out).toContain('STATUS=regenerate');
    expect(out).toContain('BODY_HAS_SPINNER=true');

    // THE CRITICAL ASSERTION, from a real click: the file the agent polls for.
    expect(await waitForFile(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerated).toBe(true);
    expect(pending.regenerateAction).toBe('different');
  });

  test('picking Option B then Submit writes feedback.json, shows success, disables inputs, ends serve', async () => {
    const { dir, url, child } = await serveBoard('submit');
    const feedbackPath = path.join(dir, 'feedback.json');

    const out = runAside([
      `const pg = await openTab(${JSON.stringify(url)});`,
      `await pg.waitForSelector("#submit-btn");`,
      `await pg.locator('input[name="preferred"][value="B"]').click();`,
      `await pg.locator("#submit-btn").click();`,
      `await sleep(800);`,
      `console.log("STATUS=" + await pg.evaluate(() => document.getElementById("status").textContent));`,
      `console.log("SUBMIT_DISPLAY=" + await pg.evaluate(() => document.getElementById("submit-btn").style.display));`,
      `console.log("SUCCESS_DISPLAY=" + await pg.evaluate(() => document.getElementById("success-msg").style.display));`,
      `console.log("SUCCESS_TEXT=" + await pg.evaluate(() => document.getElementById("success-msg").textContent));`,
      `console.log("ALL_DISABLED=" + await pg.evaluate(() => Array.from(document.querySelectorAll("input, button, textarea")).every((el) => el.disabled)));`,
    ]);
    // Post-submit lifecycle (compare.ts showPostSubmitState): status flag set,
    // Submit hidden, success banner shown, every input read-only.
    expect(out).toContain('STATUS=submitted');
    expect(out).toContain('SUBMIT_DISPLAY=none');
    expect(out).toContain('SUCCESS_DISPLAY=block');
    expect(out).toContain('Feedback received! Return to your coding agent.');
    expect(out).toContain('ALL_DISABLED=true');

    // THE CRITICAL ASSERTION, from a real click: feedback.json is the final answer.
    expect(await waitForFile(feedbackPath)).toBe(true);
    const final = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    expect(final.preferred).toBe('B');
    expect(final.regenerated).toBe(false);

    // Submit ends the serve process (exit 0) so the agent's foreground `$D serve` returns.
    expect(await exitCodeWithin(child, 5000)).toBe(0);
  });
});
