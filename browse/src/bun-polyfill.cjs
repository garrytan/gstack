/**
 * Bun API polyfill for Node.js — Windows compatibility layer.
 *
 * On Windows, Bun can't launch or connect to Playwright's Chromium
 * (oven-sh/bun#4253, #9911). The browse server falls back to running
 * under Node.js with this polyfill providing Bun API equivalents.
 *
 * Loaded via --require before the transpiled server bundle.
 */

'use strict';

const http = require('http');
const { spawnSync, spawn } = require('child_process');

globalThis.Bun = {
  serve(options) {
    const { port, hostname = '127.0.0.1', fetch } = options;

    const server = http.createServer(async (nodeReq, nodeRes) => {
      try {
        const url = `http://${hostname}:${port}${nodeReq.url}`;
        const headers = new Headers();
        for (const [key, val] of Object.entries(nodeReq.headers)) {
          if (val) headers.set(key, Array.isArray(val) ? val[0] : val);
        }

        let body = null;
        if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
          body = await new Promise((resolve) => {
            const chunks = [];
            nodeReq.on('data', (chunk) => chunks.push(chunk));
            nodeReq.on('end', () => resolve(Buffer.concat(chunks)));
          });
        }

        const webReq = new Request(url, {
          method: nodeReq.method,
          headers,
          body,
        });

        const webRes = await fetch(webReq);

        nodeRes.statusCode = webRes.status;
        webRes.headers.forEach((val, key) => {
          nodeRes.setHeader(key, val);
        });

        const resBody = await webRes.arrayBuffer();
        nodeRes.end(Buffer.from(resBody));
      } catch (err) {
        nodeRes.statusCode = 500;
        nodeRes.end(JSON.stringify({ error: err.message }));
      }
    });

    server.listen(port, hostname);

    return {
      stop() { server.close(); },
      port,
      hostname,
    };
  },

  spawnSync(cmd, options = {}) {
    const [command, ...args] = cmd;
    const result = spawnSync(command, args, {
      stdio: [
        options.stdin || 'pipe',
        options.stdout === 'pipe' ? 'pipe' : 'ignore',
        options.stderr === 'pipe' ? 'pipe' : 'ignore',
      ],
      timeout: options.timeout,
      env: options.env,
      cwd: options.cwd,
      // Node defaults windowsHide to false; Bun.spawn hides the console
      // window. Without this the shim silently inverts the behavior on the
      // one platform it exists to serve. See the spawn() note below.
      windowsHide: options.windowsHide !== false,
    });

    return {
      exitCode: result.status,
      stdout: result.stdout || Buffer.from(''),
      stderr: result.stderr || Buffer.from(''),
    };
  },

  spawn(cmd, options = {}) {
    const [command, ...args] = cmd;
    const stdio = options.stdio || ['pipe', 'pipe', 'pipe'];
    const proc = spawn(command, args, {
      stdio,
      env: options.env,
      cwd: options.cwd,
      // stdio:'ignore' silences a child's output but does not suppress its
      // console window on Windows. The terminal-agent respawn (server.ts
      // watchdog, 60s ticker) therefore popped a visible bun.exe window on
      // every respawn until this was forwarded.
      windowsHide: options.windowsHide !== false,
    });

    return {
      pid: proc.pid,
      stdout: proc.stdout,
      stderr: proc.stderr,
      stdin: proc.stdin,
      unref() { proc.unref(); },
      kill(signal) { proc.kill(signal); },
    };
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};
