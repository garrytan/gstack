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

/**
 * Safe wrapper for spawnSync — command and args are validated before reaching here:
 *   - cmd must be a non-empty array
 *   - command (cmd[0]) must be a non-empty string
 * shell is explicitly disabled to prevent shell-metacharacter injection.
 * nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
 */
function _safeSpawnSync(command, args, spawnOptions) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  return spawnSync(command, args, { ...spawnOptions, shell: false });
}

/**
 * Safe wrapper for spawn — command and args are validated before reaching here:
 *   - cmd must be a non-empty array
 *   - command (cmd[0]) must be a non-empty string
 * shell is explicitly disabled to prevent shell-metacharacter injection.
 * nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
 */
function _safeSpawn(command, args, spawnOptions) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  return spawn(command, args, { ...spawnOptions, shell: false });
}

globalThis.Bun = {
  serve(options) {
    const { port, hostname = '127.0.0.1', fetch } = options;

    // This server only listens on localhost (127.0.0.1) as a Bun API polyfill;
    // TLS is not required for loopback-only internal communication.
    const server = http.createServer(async (nodeReq, nodeRes) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
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
    if (!Array.isArray(cmd) || cmd.length === 0) {
      throw new TypeError('cmd must be a non-empty array');
    }
    const [command, ...args] = cmd;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('cmd[0] must be a non-empty string');
    }
    const result = _safeSpawnSync(command, args, {
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
    if (!Array.isArray(cmd) || cmd.length === 0) {
      throw new TypeError('cmd must be a non-empty array');
    }
    const [command, ...args] = cmd;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('cmd[0] must be a non-empty string');
    }
    const stdio = options.stdio || ['pipe', 'pipe', 'pipe'];
    const proc = _safeSpawn(command, args, {
      stdio,
      env: options.env,
      cwd: options.cwd,
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
