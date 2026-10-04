import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const SERVER_NODE = path.join(DIST_DIR, 'server-node.mjs');

describe('build: server-node.mjs', () => {
  test('passes node --check if present', () => {
    if (!fs.existsSync(SERVER_NODE)) {
      // browse/dist is gitignored; no build has run in this checkout.
      // Skip rather than fail so plain `bun test` without a prior build passes.
      return;
    }
    expect(() => execSync(`node --check ${SERVER_NODE}`, { stdio: 'pipe', timeout: 30_000 })).not.toThrow();
  });

  test('does not inline @ngrok/ngrok (must be external)', () => {
    if (!fs.existsSync(SERVER_NODE)) return;
    const bundle = fs.readFileSync(SERVER_NODE, 'utf-8');
    // Dynamic imports of externalized packages show up as string literals in the bundle,
    // not as inlined module code. The heuristic: ngrok's native binding loader would
    // reference its own internals. If any ngrok internal identifier appears, the module
    // got inlined despite the --external flag.
    expect(bundle).not.toMatch(/ngrok_napi|ngrokNapi|@ngrok\/ngrok-darwin|@ngrok\/ngrok-linux|@ngrok\/ngrok-win32/);
  });
});

describe('build: node server bundle externals (#2260)', () => {
  test('sharp and socks stay external, so their native and runtime-resolved code is loaded from node_modules', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'build-node-server.sh'), 'utf-8');
    const externals = [...script.matchAll(/--external\s+"?([^"\s\\]+)"?/g)].map((m) => m[1]);
    expect(externals).toEqual(expect.arrayContaining(['sharp', 'socks']));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-node-bundle-'));
    try {
      const outfile = path.join(out, 'server-node.mjs');
      const r = Bun.spawnSync([process.execPath, 'build', path.resolve(__dirname, '..', 'src', 'server.ts'), '--target=node', '--outfile', outfile, ...externals.flatMap((e) => ['--external', e])], { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      const bundle = fs.readFileSync(outfile, 'utf-8');
      expect(bundle).not.toContain('node_modules/sharp/');
      expect(bundle).not.toContain('node_modules/socks/');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 150_000);
});
