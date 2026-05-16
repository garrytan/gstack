import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { artifactDirFor, changeRequestQueuePath, parseArgs, resolveModelPath, startCadCoderServer, type CadCoderServer } from './server';

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

function sampleNote(text = 'Make this longer') {
  return {
    text,
    anchor: {
      kind: 'model-point',
      world: [1, 2, 3],
      screen: { x: 120, y: 88 },
      objectName: 'whistle body',
      nodePath: 'Scene / whistle / whistle body',
      meshName: 'whistle body',
      materialName: 'body plastic',
      faceIndex: 42,
      normal: [0, 0, 1],
    },
    camera: {
      position: [6, 7, 8],
      target: [0, 0, 0],
    },
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < 5; i += 1) {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 500);
    });
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
    if (text.includes(pattern)) return text;
  }
  return text;
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

  test('persists note CRUD under artifact dir', async () => {
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

    const create = await fetch(`${server.url}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleNote()),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as any;
    expect(created.note.text).toBe('Make this longer');
    expect(existsSync(server.notesPath)).toBe(true);

    const update = await fetch(`${server.url}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Round the mouthpiece' }),
    });
    expect(update.status).toBe(200);
    const updated = await update.json() as any;
    expect(updated.note.text).toBe('Round the mouthpiece');

    const remove = await fetch(`${server.url}/api/notes/${created.note.id}`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    const after = await fetch(`${server.url}/api/notes`);
    const notes = await after.json() as any;
    expect(notes.notes).toHaveLength(0);
  });

  test('rejects invalid note payloads', async () => {
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

    const response = await fetch(`${server.url}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(response.status).toBe(400);
  });

  test('writes pending change request artifacts and marks notes submitted', async () => {
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

    await fetch(`${server.url}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleNote('Move this slot forward')),
    });

    const response = await fetch(`${server.url}/api/change-request`, { method: 'POST' });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.changeRequest.title).toBe('Apply these user CAD notes');
    expect(result.changeRequest.schemaVersion).toBe('gstack.cad-coder.change-request.v1');
    expect(result.changeRequest.skill).toBe('cad-coder');
    expect(result.notes[0].status).toBe('submitted');
    expect(existsSync(server.changeRequestJsonPath)).toBe(true);
    expect(existsSync(server.changeRequestMarkdownPath)).toBe(true);
    expect(readFileSync(server.changeRequestMarkdownPath, 'utf8')).toContain('Move this slot forward');
    expect(readFileSync(server.changeRequestMarkdownPath, 'utf8')).toContain('Face index: 42');
    expect(readFileSync(changeRequestQueuePath(join(dir, 'state')), 'utf8')).toContain(result.changeRequest.id);
  });

  test('publishes SSE note and change-request events', async () => {
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

    await fetch(`${server.url}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleNote('Make the loop taller')),
    });
    const notesFrame = await readUntil(reader, 'event: notes');
    expect(notesFrame).toContain('Make the loop taller');

    await fetch(`${server.url}/api/change-request`, { method: 'POST' });
    const requestFrame = await readUntil(reader, 'event: change-request');
    await reader.cancel();
    expect(requestFrame).toContain('Apply these user CAD notes');
  });
});
