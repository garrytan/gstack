/**
 * Bun API polyfills for running the browse server under Node/tsx on Windows.
 *
 * Bun's IPC pipe and WebSocket transports are broken on Windows, so the server
 * must run under Node for Playwright to work. This file polyfills the Bun globals
 * that the server uses: Bun.serve, Bun.write, Bun.file, Bun.sleep, Bun.spawn,
 * Bun.spawnSync.
 *
 * Usage: import this file before anything else in the server entry point.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as childProcess from 'child_process';

// Only polyfill if Bun globals are missing (i.e., running under Node)
if (typeof globalThis.Bun === 'undefined') {
  const Bun: any = {};

  // Bun.serve — minimal HTTP server compatible with the browse server's usage
  Bun.serve = (options: {
    port: number;
    hostname?: string;
    fetch: (req: Request) => Promise<Response> | Response;
  }) => {
    const server = http.createServer(async (req, res) => {
      try {
        // Build a Web API Request from Node's IncomingMessage
        const url = `http://${options.hostname || '127.0.0.1'}:${options.port}${req.url}`;
        const headers = new Headers();
        for (const [key, val] of Object.entries(req.headers)) {
          if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
        }

        let body: string | null = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString()));
            req.on('error', reject);
          });
        }

        const webReq = new Request(url, {
          method: req.method,
          headers,
          body,
        });

        const webRes = await options.fetch(webReq);
        const resBody = await webRes.text();

        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        res.end(resBody);
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message);
      }
    });

    server.listen(options.port, options.hostname || '127.0.0.1');

    return {
      port: options.port,
      stop: () => { server.close(); },
      hostname: options.hostname || '127.0.0.1',
      _nodeServer: server,
    };
  };

  // Bun.write — write string/buffer to a file path
  Bun.write = async (path: string, content: string | Buffer) => {
    fs.writeFileSync(path, content);
  };

  // Bun.file — returns an object with .text() method
  Bun.file = (path: string) => ({
    text: async () => fs.readFileSync(path, 'utf-8'),
  });

  // Bun.sleep — returns a promise that resolves after ms
  Bun.sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Bun.spawn — async child process
  Bun.spawn = (cmd: string[], options: any = {}) => {
    const proc = childProcess.spawn(cmd[0], cmd.slice(1), {
      stdio: options.stdio || 'pipe',
      env: options.env,
      detached: options.detached,
    });
    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      unref: () => proc.unref(),
      kill: (sig?: string) => proc.kill(sig as any),
      exited: new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
      }),
    };
  };

  // Bun.spawnSync — synchronous child process
  Bun.spawnSync = (cmd: string[], options: any = {}) => {
    const result = childProcess.spawnSync(cmd[0], cmd.slice(1), {
      stdio: options.stdio || 'pipe',
      env: options.env,
      timeout: options.timeout,
    });
    return {
      stdout: result.stdout || Buffer.from(''),
      stderr: result.stderr || Buffer.from(''),
      exitCode: result.status,
      success: result.status === 0,
    };
  };

  // Bun.stdin — for reading from stdin
  Bun.stdin = {
    text: async () => {
      return new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (c: Buffer) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
    },
  };

  globalThis.Bun = Bun;
}
