/**
 * browse-client tests — verify the SDK against a mock HTTP server.
 *
 * We don't need a real daemon. We stand up a Bun.serve that mimics POST
 * /command, capture the requests, and assert wire format + auth + error
 * handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowseClient, BrowseClientError, resolveBrowseAuth } from '../src/browse-client';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: any;
}

interface MockServer {
  port: number;
  requests: CapturedRequest[];
  setResponse(status: number, body: string): void;
  stop(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let response: { status: number; body: string } = { status: 200, body: 'OK' };

  const server = Bun.serve({
    port: 0, // random port
    async fetch(req) {
      const body = await req.text();
      let parsed: any = body;
      try { parsed = JSON.parse(body); } catch { /* leave as text */ }
      requests.push({
        method: req.method,
        url: new URL(req.url).pathname,
        authorization: req.headers.get('Authorization'),
        contentType: req.headers.get('Content-Type'),
        body: parsed,
      });
      return new Response(response.body, { status: response.status });
    },
  });

  return {
    port: server.port,
    requests,
    setResponse(status: number, body: string) { response = { status, body }; },
    async stop() { server.stop(true); },
  };
}

describe('browse-client', () => {
  let server: MockServer;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    server = await startMockServer();
    // Snapshot env we mutate so tests are hermetic.
    for (const k of ['GSTACK_PORT', 'GSTACK_SKILL_TOKEN', 'BROWSE_STATE_FILE', 'BROWSE_TAB']) {
      origEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    await server.stop();
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('resolveBrowseAuth', () => {
    it('uses GSTACK_PORT + GSTACK_SKILL_TOKEN env when present', () => {
      process.env.GSTACK_PORT = String(server.port);
      process.env.GSTACK_SKILL_TOKEN = 'scoped-token';
      const auth = resolveBrowseAuth();
      expect(auth.port).toBe(server.port);
      expect(auth.token).toBe('scoped-token');
      expect(auth.source).toBe('env');
    });

    it('falls back to state file when env vars missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-client-test-'));
      const stateFile = path.join(tmpDir, 'browse.json');
      fs.writeFileSync(stateFile, JSON.stringify({ pid: 1, port: server.port, token: 'root-token' }));
      try {
        const auth = resolveBrowseAuth({ stateFile });
        expect(auth.port).toBe(server.port);
        expect(auth.token).toBe('root-token');
        expect(auth.source).toBe('state-file');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws a clear error when neither env nor state file resolves', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-client-test-'));
      try {
        expect(() => resolveBrowseAuth({ stateFile: path.join(tmpDir, 'nonexistent.json') }))
          .toThrow('browse-client: cannot find daemon port + token');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('explicit opts.port + opts.token bypass env and state file', () => {
      const auth = resolveBrowseAuth({ port: 9999, token: 'explicit' });
      expect(auth.port).toBe(9999);
      expect(auth.token).toBe('explicit');
    });
  });

  describe('command()', () => {
    it('emits POST /command with bearer auth and JSON body', async () => {
      const client = new BrowseClient({ port: server.port, token: 'tok-abc' });
      server.setResponse(200, 'navigated');

      const result = await client.command('goto', ['https://example.com']);
      expect(result).toBe('navigated');

      expect(server.requests).toHaveLength(1);
      const req = server.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/command');
      expect(req.authorization).toBe('Bearer tok-abc');
      expect(req.contentType).toBe('application/json');
      expect(req.body).toEqual({ command: 'goto', args: ['https://example.com'] });
    });

    it('omits tabId when not set', async () => {
      const client = new BrowseClient({ port: server.port, token: 't' });
      await client.command('text', []);
      expect(server.requests[0].body).toEqual({ command: 'text', args: [] });
    });

    it('includes tabId when constructor receives one', async () => {
      const client = new BrowseClient({ port: server.port, token: 't', tabId: 5 });
      await client.command('text', []);
      expect(server.requests[0].body).toEqual({ command: 'text', args: [], tabId: 5 });
    });

    it('reads tabId from BROWSE_TAB env when not passed explicitly', async () => {
      process.env.BROWSE_TAB = '7';
      const client = new BrowseClient({ port: server.port, token: 't' });
      await client.command('text', []);
      expect(server.requests[0].body).toEqual({ command: 'text', args: [], tabId: 7 });
    });

    it('throws BrowseClientError with status on non-2xx', async () => {
      const client = new BrowseClient({ port: server.port, token: 't' });
      server.setResponse(403, JSON.stringify({ error: 'Insufficient scope' }));

      let caught: BrowseClientError | null = null;
      try {
        await client.command('eval', ['file.js']);
      } catch (e) {
        caught = e as BrowseClientError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.name).toBe('BrowseClientError');
      expect(caught!.status).toBe(403);
      expect(caught!.message).toContain('Insufficient scope');
    });

    it('wraps connection-refused errors as BrowseClientError', async () => {
      // Pick an unused port to force ECONNREFUSED
      const client = new BrowseClient({ port: 1, token: 't', timeoutMs: 1000 });
      let caught: BrowseClientError | null = null;
      try {
        await client.command('goto', ['x']);
      } catch (e) {
        caught = e as BrowseClientError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.name).toBe('BrowseClientError');
    });
  });

  describe('convenience methods', () => {
    let client: BrowseClient;

    beforeEach(() => {
      client = new BrowseClient({ port: server.port, token: 't' });
      server.setResponse(200, 'OK');
    });

    it('goto sends url as single arg', async () => {
      await client.goto('https://example.com');
      expect(server.requests[0].body).toEqual({ command: 'goto', args: ['https://example.com'] });
    });

    it('text with no selector sends empty args', async () => {
      await client.text();
      expect(server.requests[0].body).toEqual({ command: 'text', args: [] });
    });

    it('text with selector sends [selector]', async () => {
      await client.text('.my-class');
      expect(server.requests[0].body).toEqual({ command: 'text', args: ['.my-class'] });
    });

    it('html with selector sends [selector]', async () => {
      await client.html('article');
      expect(server.requests[0].body).toEqual({ command: 'html', args: ['article'] });
    });

    it('click sends selector', async () => {
      await client.click('button.submit');
      expect(server.requests[0].body).toEqual({ command: 'click', args: ['button.submit'] });
    });

    it('fill sends [selector, value]', async () => {
      await client.fill('#email', 'user@example.com');
      expect(server.requests[0].body).toEqual({ command: 'fill', args: ['#email', 'user@example.com'] });
    });

    it('select sends [selector, value]', async () => {
      await client.select('#country', 'US');
      expect(server.requests[0].body).toEqual({ command: 'select', args: ['#country', 'US'] });
    });

    it('hover sends selector', async () => {
      await client.hover('.menu');
      expect(server.requests[0].body).toEqual({ command: 'hover', args: ['.menu'] });
    });

    it('press sends key', async () => {
      await client.press('Enter');
      expect(server.requests[0].body).toEqual({ command: 'press', args: ['Enter'] });
    });

    it('type sends text', async () => {
      await client.type('hello world');
      expect(server.requests[0].body).toEqual({ command: 'type', args: ['hello world'] });
    });

    it('wait sends arg', async () => {
      await client.wait('--networkidle');
      expect(server.requests[0].body).toEqual({ command: 'wait', args: ['--networkidle'] });
    });

    it('scroll with no selector sends empty args', async () => {
      await client.scroll();
      expect(server.requests[0].body).toEqual({ command: 'scroll', args: [] });
    });

    it('snapshot with flags forwards them', async () => {
      await client.snapshot('-i', '-c');
      expect(server.requests[0].body).toEqual({ command: 'snapshot', args: ['-i', '-c'] });
    });

    it('attrs sends selector', async () => {
      await client.attrs('@e1');
      expect(server.requests[0].body).toEqual({ command: 'attrs', args: ['@e1'] });
    });

    it('links/forms/accessibility take no args', async () => {
      await client.links();
      await client.forms();
      await client.accessibility();
      expect(server.requests).toHaveLength(3);
      expect(server.requests.map(r => r.body.command)).toEqual(['links', 'forms', 'accessibility']);
      for (const r of server.requests) expect(r.body.args).toEqual([]);
    });

    it('media and data forward flag args', async () => {
      await client.media('--images');
      await client.data('--jsonld');
      expect(server.requests[0].body).toEqual({ command: 'media', args: ['--images'] });
      expect(server.requests[1].body).toEqual({ command: 'data', args: ['--jsonld'] });
    });
  });
});
