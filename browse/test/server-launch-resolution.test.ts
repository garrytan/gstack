/**
 * E4 (#2439): the CLI resolves its server script only when it starts a
 * server. A Windows minimal runtime ships browse.exe + server-node.mjs and no
 * browse/src/server.ts, which used to make every command fail at import.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveServerLaunch } from '../src/cli';

function withRuntime<T>(files: string[], fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-runtime-'));
  try {
    for (const f of files) fs.writeFileSync(path.join(dir, f), '// stub\n');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const COMPILED_META = path.join(os.tmpdir(), '$bunfs', 'root');

describe('resolveServerLaunch', () => {
  test('Windows minimal runtime starts the adjacent Node bundle without server.ts', () => {
    withRuntime(['server-node.mjs'], (dir) => {
      expect(resolveServerLaunch('win32', {}, COMPILED_META, path.join(dir, 'browse.exe')))
        .toEqual({ runtime: 'node', script: path.join(dir, 'server-node.mjs') });
    });
  });

  test('Windows without the Node bundle names the build fix', () => {
    withRuntime([], (dir) => {
      expect(() => resolveServerLaunch('win32', {}, COMPILED_META, path.join(dir, 'browse.exe')))
        .toThrow('server-node.mjs not found. Run `bun run build`');
    });
  });

  test('macOS/Linux start server.ts with Bun, honoring BROWSE_SERVER_SCRIPT', () => {
    expect(resolveServerLaunch('linux', { BROWSE_SERVER_SCRIPT: 'custom-server.ts' }, COMPILED_META, ''))
      .toEqual({ runtime: 'bun', script: 'custom-server.ts' });
  });

  test('importing the CLI resolves nothing: a missing server is reported only when one is started', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf-8');
    expect(src).not.toMatch(/^const \w+ = resolve(Server|NodeServer)\w*\(/m);
    expect(src).toMatch(/async function startServer\([^)]*\)[^{]*\{\n\s*const server = resolveServerLaunch\(\);/);
  });
});
