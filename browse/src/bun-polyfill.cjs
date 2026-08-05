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
const { spawnSync: nodeSpawnSync, spawn: nodeSpawn } = require('child_process');
// Node's spawn on Windows without shell:true only matches an EXACT
// executable name -- no PATHEXT resolution the way a real shell (or
// Bun.spawn, which this file exists to polyfill) does. A bare command
// name like 'bun' (no .exe/.cmd) then fails ENOENT even though `bun`
// works fine typed at a prompt (confirmed live: this is what produced
// "[browse] FATAL uncaught exception: spawn bun ENOENT" from
// terminal-agent-control.ts's respawn path, once daemon output was
// actually being captured to a file instead of silently discarded).
//
// Two things this is NOT fixed with, both tried and rejected here:
//
// 1. shell:true + array args. This file is also reached (via server.ts ->
//    write-commands.ts/meta-commands.ts -> cookie-import-browser.ts/
//    browser-skill-commands.ts) by calls that pass genuinely variable
//    content -- browser-skill-commands.ts:266 spreads `...opts.skillArgs`,
//    sourced from `$B skill run <name> --arg k=v`'s passthrough CLI args,
//    into the spawned argv. shell:true on Windows routes through cmd.exe,
//    and Node's own array-arg handling for that combination does NOT
//    neutralize cmd.exe metacharacters (& | ^ % < >) -- confirmed by
//    directly spawning a resolved .cmd path with an arg containing
//    `& echo INJECTED > proof.txt`: the file was created. Hand-rolled
//    double-quote-only escaping (an earlier version of this fix) doesn't
//    close that either -- it only handles embedded quotes.
//
// 2. Resolve the .exe/.cmd path ourselves and spawn it with NO shell.
//    Works for .exe targets, but Node flat-out refuses (EINVAL) to spawn
//    a .cmd/.bat file without shell:true -- deliberately, as part of
//    Node's own CVE-2024-27980 fix for implicit unsafe .cmd execution.
//    bun's own Windows install (npm global) is exactly a .cmd shim, so
//    this path is not optional to support.
//
// cross-spawn (already resolved in node_modules -- a transitive dep of
// @modelcontextprotocol/sdk, added here as a direct dependency) is the
// established, battle-tested library for precisely this problem: it does
// PATHEXT resolution AND correct Windows/cmd.exe argument escaping
// together. Verified against the same injection payload above: the
// malicious arg reached the child as a single literal argument, no file
// was created, and normal resolution (`bun --version`) still worked.
const crossSpawn = require('cross-spawn');

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
    const spawnFn = process.platform === 'win32' ? crossSpawn.sync : nodeSpawnSync;
    const result = spawnFn(command, args, {
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
    const spawnFn = process.platform === 'win32' ? crossSpawn : nodeSpawn;
    const stdio = options.stdio || ['pipe', 'pipe', 'pipe'];
    const proc = spawnFn(command, args, {
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
