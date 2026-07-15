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

    // Drain stdout/stderr eagerly into in-memory buffers. Bun's spawn buffers
    // these for the consumer; Node's Readables are pull-based, so if the caller
    // awaits `proc.exited` before reading, anything past the OS pipe buffer
    // (~16-64 KB) back-pressures the child until it blocks in write() and
    // `exit` never fires. Eager draining keeps the pipes flowing regardless
    // of read order; replay below is via fresh Web ReadableStreams.
    //
    // Cap the buffer so a runaway child can't OOM the server. 16 MB is
    // generous: DPAPI outputs are tiny, tasklist is <1 KB, and the
    // browser-skill consumer has its own 1 MB readCapped. Once the cap is
    // reached we keep draining the pipe (so the child never blocks) but
    // discard further bytes. Override via GSTACK_SPAWN_MAX_BUFFER (bytes).
    const MAX_BUFFER = Math.max(
      0,
      parseInt(process.env.GSTACK_SPAWN_MAX_BUFFER || '', 10) || 16 * 1024 * 1024,
    );
    const drain = (stream) => {
      if (!stream) return { done: Promise.resolve(), chunks: [], truncated: false };
      const state = { chunks: [], bytes: 0, truncated: false };
      const done = new Promise((resolve) => {
        stream.on('data', (chunk) => {
          if (state.bytes >= MAX_BUFFER) { state.truncated = true; return; }
          if (state.bytes + chunk.length <= MAX_BUFFER) {
            state.chunks.push(chunk);
            state.bytes += chunk.length;
          } else {
            const remaining = MAX_BUFFER - state.bytes;
            state.chunks.push(chunk.subarray(0, remaining));
            state.bytes = MAX_BUFFER;
            state.truncated = true;
          }
        });
        // Any terminal event resolves: 'end' on normal close, 'error' on a
        // stream-level error, 'close' as the belt-and-suspenders for spawn
        // failures where Node fires 'close' but neither 'end' nor 'error'.
        stream.once('end', resolve);
        stream.once('error', resolve);
        stream.once('close', resolve);
      });
      return { done, chunks: state.chunks };
    };
    const stdoutDrain = drain(proc.stdout);
    const stderrDrain = drain(proc.stderr);

    // Bun's spawn exposes `proc.exited` as a Promise resolving to the exit
    // code; several call sites — DPAPI decryption, isBrowserRunning,
    // browser-skill-commands — `await proc.exited` directly or via
    // Promise.race with a timeout. Without this, those awaits resolve to
    // `undefined` immediately and the operation looks like a silent failure.
    // Resolve only after both pipes have finished draining so consumers that
    // read stdout AFTER awaiting exit see the full output, not a partial buffer.
    const exited = new Promise((resolveExited) => {
      let exitStatus;
      proc.once('exit', (code, signal) => {
        // Match Bun: exit code on normal exit; 128 + signal number on signal;
        // 0 if neither was reported.
        if (code !== null) exitStatus = code;
        else if (signal) exitStatus = 128 + (require('os').constants.signals[signal] || 0);
        else exitStatus = 0;
      });
      proc.once('error', () => {
        if (exitStatus === undefined) exitStatus = 1;
      });
      // Wait for either 'exit' (normal child lifecycle) or 'error' (spawn
      // failure — Node fires error without exit when the binary is missing).
      // Either path resolves the lifecycle promise; without listening to both
      // a spawn error hangs `await proc.exited` until the consumer's own
      // timeout fires.
      const lifecycle = new Promise((r) => {
        proc.once('exit', r);
        proc.once('error', r);
      });
      Promise.all([lifecycle, stdoutDrain.done, stderrDrain.done])
        .then(() => resolveExited(exitStatus !== undefined ? exitStatus : 0));
    });

    // Replay buffered output as a fresh Web ReadableStream. `start()` awaits
    // the drain before enqueueing so `new Response(proc.stdout).text()` yields
    // the complete output regardless of whether the consumer reads before or
    // after awaiting `proc.exited`. Stream is single-shot (locked after one
    // read), matching Bun's behavior.
    const replay = (d) => new ReadableStream({
      async start(controller) {
        await d.done;
        for (const chunk of d.chunks) {
          controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
        controller.close();
      },
    });

    return {
      pid: proc.pid,
      stdout: replay(stdoutDrain),
      stderr: replay(stderrDrain),
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
