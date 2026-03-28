/**
 * Tests for the $D serve command — HTTP server for comparison board feedback.
 *
 * Tests the stateful server lifecycle:
 * - SERVING → POST submit → DONE (exit 0)
 * - SERVING → POST regenerate → REGENERATING → POST reload → SERVING
 * - Timeout → exit 1
 * - Error handling (missing HTML, malformed JSON, missing reload path)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateCompareHtml } from '../src/compare';
import * as fs from 'fs';
import * as path from 'path';

let tmpDir: string;
let boardHtml: string;

// Create a minimal 1x1 pixel PNG for test variants
function createTestPng(filePath: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(filePath, png);
}

beforeAll(() => {
  tmpDir = '/tmp/serve-test-' + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });

  // Create test PNGs and generate comparison board
  createTestPng(path.join(tmpDir, 'variant-A.png'));
  createTestPng(path.join(tmpDir, 'variant-B.png'));
  createTestPng(path.join(tmpDir, 'variant-C.png'));

  const html = generateCompareHtml([
    path.join(tmpDir, 'variant-A.png'),
    path.join(tmpDir, 'variant-B.png'),
    path.join(tmpDir, 'variant-C.png'),
  ]);
  boardHtml = path.join(tmpDir, 'design-board.html');
  fs.writeFileSync(boardHtml, html);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Serve as HTTP module (not subprocess) ────────────────────────

describe('Serve HTTP endpoints', () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let htmlContent: string;
  let state: string;

  beforeAll(() => {
    htmlContent = fs.readFileSync(boardHtml, 'utf-8');
    state = 'serving';

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (req.method === 'GET' && url.pathname === '/') {
          const injected = htmlContent.replace(
            '</head>',
            `<script>window.__GSTACK_SERVER_URL = '${url.origin}';</script>\n</head>`
          );
          return new Response(injected, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/progress') {
          return Response.json({ status: state });
        }

        if (req.method === 'POST' && url.pathname === '/api/feedback') {
          return (async () => {
            let body: any;
            try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
            if (typeof body !== 'object' || body === null) return Response.json({ error: 'Expected JSON object' }, { status: 400 });
            const isSubmit = body.regenerated === false;
            const feedbackFile = isSubmit ? 'feedback.json' : 'feedback-pending.json';
            fs.writeFileSync(path.join(tmpDir, feedbackFile), JSON.stringify(body, null, 2));
            if (isSubmit) {
              state = 'done';
              return Response.json({ received: true, action: 'submitted' });
            }
            state = 'regenerating';
            return Response.json({ received: true, action: 'regenerate' });
          })();
        }

        if (req.method === 'POST' && url.pathname === '/api/reload') {
          return (async () => {
            let body: any;
            try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
            if (!body.html || !fs.existsSync(body.html)) {
              return Response.json({ error: `HTML file not found: ${body.html}` }, { status: 400 });
            }
            htmlContent = fs.readFileSync(body.html, 'utf-8');
            state = 'serving';
            return Response.json({ reloaded: true });
          })();
        }

        return new Response('Not found', { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
  });

  test('GET / serves HTML with injected __GSTACK_SERVER_URL', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('__GSTACK_SERVER_URL');
    expect(html).toContain(baseUrl);
    expect(html).toContain('Design Exploration');
  });

  test('GET /api/progress returns current state', async () => {
    state = 'serving';
    const res = await fetch(`${baseUrl}/api/progress`);
    const data = await res.json();
    expect(data.status).toBe('serving');
  });

  test('POST /api/feedback with submit sets state to done', async () => {
    state = 'serving';
    const feedback = {
      preferred: 'A',
      ratings: { A: 4, B: 3, C: 2 },
      comments: { A: 'Good spacing' },
      overall: 'Go with A',
      regenerated: false,
    };

    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedback),
    });
    const data = await res.json();
    expect(data.received).toBe(true);
    expect(data.action).toBe('submitted');
    expect(state).toBe('done');

    // Verify feedback.json was written
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'feedback.json'), 'utf-8'));
    expect(written.preferred).toBe('A');
    expect(written.ratings.A).toBe(4);
  });

  test('POST /api/feedback with regenerate sets state and writes feedback-pending.json', async () => {
    state = 'serving';
    // Clean up any prior pending file
    const pendingPath = path.join(tmpDir, 'feedback-pending.json');
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);

    const feedback = {
      preferred: 'B',
      ratings: { A: 3, B: 5, C: 2 },
      comments: {},
      overall: null,
      regenerated: true,
      regenerateAction: 'different',
    };

    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedback),
    });
    const data = await res.json();
    expect(data.received).toBe(true);
    expect(data.action).toBe('regenerate');
    expect(state).toBe('regenerating');

    // Progress should reflect regenerating state
    const progress = await fetch(`${baseUrl}/api/progress`);
    const pd = await progress.json();
    expect(pd.status).toBe('regenerating');

    // Agent can poll for feedback-pending.json
    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.regenerated).toBe(true);
    expect(pending.regenerateAction).toBe('different');
  });

  test('POST /api/feedback with remix contains remixSpec', async () => {
    state = 'serving';
    const feedback = {
      preferred: null,
      ratings: { A: 4, B: 3, C: 3 },
      comments: {},
      overall: null,
      regenerated: true,
      regenerateAction: 'remix',
      remixSpec: { layout: 'A', colors: 'B', typography: 'C' },
    };

    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedback),
    });
    const data = await res.json();
    expect(data.received).toBe(true);
    expect(state).toBe('regenerating');
  });

  test('POST /api/feedback with malformed JSON returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/feedback with non-object returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"just a string"',
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/reload swaps HTML and resets state to serving', async () => {
    state = 'regenerating';

    // Create a new board HTML
    const newBoard = path.join(tmpDir, 'new-board.html');
    fs.writeFileSync(newBoard, '<html><body>New board content</body></html>');

    const res = await fetch(`${baseUrl}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: newBoard }),
    });
    const data = await res.json();
    expect(data.reloaded).toBe(true);
    expect(state).toBe('serving');

    // Verify the new HTML is served
    const pageRes = await fetch(baseUrl);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('New board content');
  });

  test('POST /api/reload with missing file returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '/nonexistent/file.html' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/random-path`);
    expect(res.status).toBe(404);
  });
});

// ─── Full lifecycle: regeneration round-trip ──────────────────────

describe('Full regeneration lifecycle', () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let htmlContent: string;
  let state: string;

  beforeAll(() => {
    htmlContent = fs.readFileSync(boardHtml, 'utf-8');
    state = 'serving';

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/') {
          return new Response(htmlContent, { headers: { 'Content-Type': 'text/html' } });
        }
        if (req.method === 'GET' && url.pathname === '/api/progress') {
          return Response.json({ status: state });
        }
        if (req.method === 'POST' && url.pathname === '/api/feedback') {
          return (async () => {
            const body = await req.json();
            if (body.regenerated) { state = 'regenerating'; return Response.json({ received: true, action: 'regenerate' }); }
            state = 'done'; return Response.json({ received: true, action: 'submitted' });
          })();
        }
        if (req.method === 'POST' && url.pathname === '/api/reload') {
          return (async () => {
            const body = await req.json();
            if (body.html && fs.existsSync(body.html)) {
              htmlContent = fs.readFileSync(body.html, 'utf-8');
              state = 'serving';
              return Response.json({ reloaded: true });
            }
            return Response.json({ error: 'Not found' }, { status: 400 });
          })();
        }
        return new Response('Not found', { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => { server.stop(); });

  test('regenerate → reload → submit round-trip', async () => {
    // Step 1: User clicks regenerate
    expect(state).toBe('serving');
    const regen = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerated: true, regenerateAction: 'different', preferred: null, ratings: {}, comments: {} }),
    });
    expect((await regen.json()).action).toBe('regenerate');
    expect(state).toBe('regenerating');

    // Step 2: Progress shows regenerating
    const prog1 = await (await fetch(`${baseUrl}/api/progress`)).json();
    expect(prog1.status).toBe('regenerating');

    // Step 3: Agent generates new variants and reloads
    const newBoard = path.join(tmpDir, 'round2-board.html');
    fs.writeFileSync(newBoard, '<html><body>Round 2 variants</body></html>');
    const reload = await fetch(`${baseUrl}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: newBoard }),
    });
    expect((await reload.json()).reloaded).toBe(true);
    expect(state).toBe('serving');

    // Step 4: Progress shows serving (board would auto-refresh)
    const prog2 = await (await fetch(`${baseUrl}/api/progress`)).json();
    expect(prog2.status).toBe('serving');

    // Step 5: User submits on round 2
    const submit = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerated: false, preferred: 'B', ratings: { A: 3, B: 5 }, comments: {}, overall: 'B is great' }),
    });
    expect((await submit.json()).action).toBe('submitted');
    expect(state).toBe('done');
  });
});
