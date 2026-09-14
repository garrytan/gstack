/**
 * Tiny Bun.serve for test fixtures
 * Serves HTML files from test/fixtures/ on a random available port
 */

import * as path from 'path';
import * as fs from 'fs';

const FIXTURES_DIR = path.resolve(import.meta.dir, 'fixtures');

export function startTestServer(port: number = 0): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);

      // Echo endpoint — returns request headers as JSON
      if (url.pathname === '/echo') {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => { headers[key] = value; });
        return new Response(JSON.stringify(headers, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let filePath = url.pathname === '/' ? '/basic.html' : url.pathname;

      // Remove leading slash
      filePath = filePath.replace(/^\//, '');
      const fullPath = path.join(FIXTURES_DIR, filePath);

      if (!fs.existsSync(fullPath)) {
        return new Response('Not Found', { status: 404 });
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const ext = path.extname(fullPath);
      const contentType = ext === '.html' ? 'text/html' : 'text/plain';

      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return { server, url };
}

// If run directly, start and print URL
if (import.meta.main) {
  const { server, url } = startTestServer(9450);
  console.log(`Test server running at ${url}`);
  console.log(`Fixtures: ${FIXTURES_DIR}`);
  console.log('Press Ctrl+C to stop');
}
