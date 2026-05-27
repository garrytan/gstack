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
const { Readable } = require('stream');

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
    });

    // Bun's spawn exposes `proc.exited` as a Promise resolving to the exit
    // code; several call sites — DPAPI decryption, isBrowserRunning,
    // browser-skill-commands — `await proc.exited` directly or via
    // Promise.race with a timeout. Without this, those awaits resolve to
    // `undefined` immediately and the operation looks like a silent failure.
    const exited = new Promise((resolveExited) => {
      proc.once('exit', (code, signal) => {
        // Match Bun: exit code on normal exit; 128 + signal number on signal;
        // 0 if neither was reported.
        if (code !== null) resolveExited(code);
        else if (signal) resolveExited(128 + (require('os').constants.signals[signal] || 0));
        else resolveExited(0);
      });
      proc.once('error', () => resolveExited(1));
    });

    // Bun gives consumers a Web ReadableStream so `new Response(proc.stdout)`
    // works regardless of read order. With Node's Readable, the stream auto-
    // drains once the child exits, so `await proc.exited` followed by
    // `new Response(proc.stdout).text()` throws "body disturbed or locked".
    // Readable.toWeb hands the consumer a fresh ReadableStream that buffers
    // until it's read. Falls back to the raw Node stream on Node < 18.
    const toWeb = (s) => (s && typeof Readable.toWeb === 'function' ? Readable.toWeb(s) : s);

    return {
      pid: proc.pid,
      stdout: toWeb(proc.stdout),
      stderr: toWeb(proc.stderr),
      stdin: proc.stdin,
      exited,
      unref() { proc.unref(); },
      kill(signal) { proc.kill(signal); },
    };
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};
