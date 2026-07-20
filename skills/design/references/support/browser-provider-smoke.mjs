#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const HOST = "127.0.0.1";

export function createReadinessServer(options = {}) {
  const token = options.token ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{32,128}$/.test(token)) throw new TypeError("Readiness token must be 32-128 lowercase hex characters");
  let completed = false;
  let baseUrl = null;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl ?? `http://${HOST}`);
    const supplied = url.searchParams.get("token");
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };

    if (url.pathname === "/" && request.method === "GET") {
      response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
      response.end(renderPage(token));
      return;
    }
    if (url.pathname === "/proof") {
      if (request.method !== "POST") {
        response.writeHead(405, { ...headers, Allow: "POST" });
        response.end();
        return;
      }
      if (supplied !== token) {
        response.writeHead(403, headers);
        response.end();
        return;
      }
      completed = true;
      response.writeHead(200, { ...headers, "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "READY" }));
      return;
    }
    if (url.pathname === "/status" && request.method === "GET") {
      if (supplied !== token) {
        response.writeHead(403, headers);
        response.end();
        return;
      }
      response.writeHead(200, { ...headers, "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, completed }));
      return;
    }
    response.writeHead(404, headers);
    response.end();
  });

  return {
    server,
    token,
    get completed() { return completed; },
    async start() {
      if (baseUrl) return { url: `${baseUrl}/?token=${token}`, baseUrl, token };
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, HOST, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Readiness fixture did not acquire a TCP port");
      baseUrl = `http://${HOST}:${address.port}`;
      return { url: `${baseUrl}/?token=${token}`, baseUrl, token };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function renderPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GStack browser readiness</title>
  <style>body{font:16px system-ui;max-width:44rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.7rem 1rem}#gstack-readiness-status{font-weight:700}</style>
</head>
<body>
  <main>
    <h1>GStack browser readiness</h1>
    <p>This local page verifies navigation, reading, interaction, console, and network access.</p>
    <button id="gstack-readiness-action" type="button">Complete readiness check</button>
    <p id="gstack-readiness-status" role="status">WAITING</p>
  </main>
  <script>
    document.querySelector('#gstack-readiness-action').addEventListener('click', async () => {
      const response = await fetch('/proof?token=${token}', { method: 'POST' });
      const result = await response.json();
      document.querySelector('#gstack-readiness-status').textContent = result.status;
      console.log('gstack-browser-readiness:ready');
    });
  </script>
</body>
</html>`;
}

async function main() {
  const fixture = createReadinessServer();
  const started = await fixture.start();
  process.stdout.write(`${JSON.stringify({ ...started, pid: process.pid })}\n`);
  const stop = async () => {
    await fixture.stop();
    process.exitCode = fixture.completed ? 0 : 2;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`gstack browser readiness: ${error.message}\n`);
    process.exitCode = 1;
  });
}
