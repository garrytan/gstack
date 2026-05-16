import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { artifactDirFor, parseArgs, resolveModelPath, startCadCoderServer, type CadCoderServer } from './server';

const servers: CadCoderServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()!.close();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to resolve free port')));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

describe('cad-coder server helpers', () => {
  test('resolves relative model paths from the project root', () => {
    const root = '/tmp/cad-project';
    expect(resolveModelPath('cad/out/model.glb', root)).toBe('/tmp/cad-project/cad/out/model.glb');
  });

  test('parses direct model argument and explicit options', () => {
    const options = parseArgs(['part.glb', '--port', '0', '--project-root', '/tmp/project']);
    expect(options.model).toBe('/tmp/project/part.glb');
    expect(options.port).toBe(0);
  });

  test('artifact dirs are stable per model path', () => {
    expect(artifactDirFor('/state', '/repo/cad/out/model.glb')).toBe(artifactDirFor('/state', '/repo/cad/out/model.glb'));
    expect(artifactDirFor('/state', '/repo/cad/out/model.glb')).not.toBe(artifactDirFor('/state', '/repo/cad/out/other.glb'));
  });
});

describe('cad-coder HTTP server', () => {
  test('serves watched GLB output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-server-'));
    const model = join(dir, 'model.glb');
    writeFileSync(model, 'fake-glb');

    const server = await startCadCoderServer({
      model,
      port: await freePort(),
      projectRoot: dir,
      stateRoot: join(dir, 'state'),
      watch: false,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/model.glb`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fake-glb');
  });

  test('publishes SSE model events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-server-'));
    const model = join(dir, 'model.glb');
    writeFileSync(model, 'fake-glb');

    const server = await startCadCoderServer({
      model,
      port: await freePort(),
      projectRoot: dir,
      stateRoot: join(dir, 'state'),
      watch: false,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/events`);
    const reader = response.body!.getReader();
    await reader.read();
    const next = reader.read();
    server.refreshModel('test');
    const chunk = await next;
    await reader.cancel();
    expect(new TextDecoder().decode(chunk.value)).toContain('ready');
  });

  test('surfaces missing model errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-server-'));
    const model = join(dir, 'missing.glb');

    const server = await startCadCoderServer({
      model,
      port: await freePort(),
      projectRoot: dir,
      stateRoot: join(dir, 'state'),
      watch: false,
    });
    servers.push(server);

    expect(server.current.status).toBe('error');
    expect(server.current.kind).toBe('missing-model');
    expect(server.current.message).toContain('GLB model file not found');
  });
});
